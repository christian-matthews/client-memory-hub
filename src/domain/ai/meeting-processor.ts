import { z } from "zod";
import { assertAdmin, assertWritable, type DomainContext } from "../shared/context";
import { DomainError, notFound } from "../shared/errors";
import { recordActivity } from "../shared/audit";
import { uuidSchema } from "../shared/vocabulary";
import { startAiRun, type AiProvider } from "./provider";
import { resolveAiProvider, resolveAiModel } from "./gateway";

/**
 * Meeting extraction.
 *
 * The transcript is evidence; the model's reading of it is a PROPOSAL. Nothing
 * here writes client memory: every extracted item becomes a pending
 * `ai_proposals` row that a human must approve and then explicitly apply
 * through the ordinary domain actions (same validation, RLS and audit as a
 * manual edit). If the model fails, the run is marked failed with a safe code
 * and the item keeps its transcript — nothing is invented.
 *
 * Two guarantees are enforced here, not left to the model:
 *  - an item whose evidence quote is not literally present in the transcript is
 *    DISCARDED (and the reason recorded in the run metadata);
 *  - ambiguity is never converted into responsibility: a missing owner or
 *    responsible party means "no proposal" or `nobody`, never `us`.
 */

export const PROMPT_VERSION = "meeting-extraction-v2";

const SYSTEM_INSTRUCTIONS = `Eres un analista de memoria operativa de clientes. Recibes la transcripción de una reunión (texto plano, sin audio ni marcas de tiempo fiables) y el estado actual de los temas abiertos de un cliente.

Devuelves dos cosas:
1) un resumen estructurado de la reunión,
2) elementos accionables que la transcripción respalde de forma EXPLÍCITA.

Reglas estrictas:
- Nunca inventes hechos, fechas, nombres ni cifras que no estén en la transcripción.
- Cada elemento debe incluir en "evidence.quote" una cita LITERAL copiada de la transcripción (sin reescribirla).
- Si no está claro quién es responsable de un compromiso, deja responsibleParty en null.
- Si no está claro quién debe dar el siguiente paso, deja nextStepOwner en null y nextStep en null.
- Si no está claro de quién es la pelota, usa "nobody" o null. NUNCA asumas que es nuestro.
- Una pregunta abierta NO es un compromiso.
- Etiquetas como "Speaker 1" no identifican personas: no les atribuyas nombres ni cargos.
- Las fechas van en formato ISO 8601 completo con zona, o null si no se mencionan.
- Ignora conversación irrelevante.
- Responde en español.`;

const SUMMARY_PROPERTIES = {
  executive: { type: "string" },
  decisions: { type: "array", items: { type: "string" } },
  ourCommitments: { type: "array", items: { type: "string" } },
  clientCommitments: { type: "array", items: { type: "string" } },
  nextSteps: { type: "array", items: { type: "string" } },
  risks: { type: "array", items: { type: "string" } },
  openQuestions: { type: "array", items: { type: "string" } },
  relatedTopicIds: { type: "array", items: { type: "string" } },
  proposedNewTopics: { type: "array", items: { type: "string" } },
} as const;

/** Strict-compatible JSON Schema: every property required, optionals nullable. */
export const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "language", "items"],
  properties: {
    language: { type: "string" },
    summary: {
      type: "object",
      additionalProperties: false,
      required: Object.keys(SUMMARY_PROPERTIES),
      properties: SUMMARY_PROPERTIES,
    },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "kind",
          "topicId",
          "title",
          "content",
          "suggestedStatus",
          "ballWith",
          "nextStep",
          "nextStepOwner",
          "dueAt",
          "responsibleParty",
          "responsibleName",
          "confidence",
          "evidence",
        ],
        properties: {
          kind: { type: "string", enum: ["topic_update", "new_topic", "commitment", "decision"] },
          topicId: { type: ["string", "null"] },
          title: { type: "string" },
          content: { type: "string" },
          suggestedStatus: {
            type: ["string", "null"],
            enum: [
              "active",
              "waiting_client",
              "pending_us",
              "blocked",
              "monitoring",
              "resolved",
              null,
            ],
          },
          ballWith: {
            type: ["string", "null"],
            enum: ["us", "client", "third_party", "nobody", null],
          },
          nextStep: { type: ["string", "null"] },
          nextStepOwner: {
            type: ["string", "null"],
            enum: ["us", "client", "third_party", "nobody", null],
          },
          dueAt: { type: ["string", "null"] },
          responsibleParty: {
            type: ["string", "null"],
            enum: ["us", "client", "third_party", null],
          },
          responsibleName: { type: ["string", "null"] },
          confidence: { type: "number" },
          evidence: {
            type: "object",
            additionalProperties: false,
            required: ["quote", "speakerLabel"],
            properties: {
              quote: { type: "string" },
              speakerLabel: { type: ["string", "null"] },
            },
          },
        },
      },
    },
  },
} as const;

const extractionItemSchema = z.object({
  kind: z.enum(["topic_update", "new_topic", "commitment", "decision"]),
  topicId: z.string().nullable(),
  title: z.string(),
  content: z.string(),
  suggestedStatus: z
    .enum(["active", "waiting_client", "pending_us", "blocked", "monitoring", "resolved"])
    .nullable(),
  ballWith: z.enum(["us", "client", "third_party", "nobody"]).nullable(),
  nextStep: z.string().nullable(),
  nextStepOwner: z.enum(["us", "client", "third_party", "nobody"]).nullable(),
  dueAt: z.string().nullable(),
  responsibleParty: z.enum(["us", "client", "third_party"]).nullable(),
  responsibleName: z.string().nullable(),
  // No `.catch()`: an invalid confidence is an invalid item, not a guess.
  confidence: z.number().min(0).max(1),
  evidence: z.object({ quote: z.string(), speakerLabel: z.string().nullable() }),
});
export type ExtractionItem = z.infer<typeof extractionItemSchema>;

const summarySchema = z.object({
  executive: z.string(),
  decisions: z.array(z.string()),
  ourCommitments: z.array(z.string()),
  clientCommitments: z.array(z.string()),
  nextSteps: z.array(z.string()),
  risks: z.array(z.string()),
  openQuestions: z.array(z.string()),
  relatedTopicIds: z.array(z.string()),
  proposedNewTopics: z.array(z.string()),
});

const extractionSchema = z.object({
  language: z.string(),
  summary: summarySchema,
  items: z.array(z.unknown()),
});
export type MeetingSummary = z.infer<typeof summarySchema>;

/** Only ISO timestamps survive; anything else becomes null instead of guessing. */
function safeIso(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function clampText(value: string, max: number): string {
  return value.trim().slice(0, max);
}

/** Whitespace-only normalisation: the transcript itself is never modified. */
export function normalizeForComparison(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/** A quote must exist literally (modulo whitespace) in the transcript. */
export function evidenceExists(quote: string, transcript: string): boolean {
  const needle = normalizeForComparison(quote);
  if (needle.length < 8) return false;
  return normalizeForComparison(transcript).includes(needle);
}

export interface ProposalEvidence {
  quote: string;
  speaker_label: string | null;
  start_seconds: number | null;
  end_seconds: number | null;
}

const WARNING_LINES = [
  "Fuente: texto plano enviado por MacWhisper.",
  "Sin audio, sin marcas de tiempo estructuradas.",
  "Hablantes no verificados: las etiquetas del texto no certifican identidades.",
];

/** Human-readable derivative persisted next to the original evidence. */
export function renderMeetingSummary(
  summary: MeetingSummary,
  topicTitles: Record<string, string>,
): string {
  const list = (label: string, values: string[]) =>
    values.length > 0 ? `## ${label}\n${values.map((v) => `- ${v}`).join("\n")}` : `## ${label}\n- —`;

  const related = summary.relatedTopicIds
    .map((id) => topicTitles[id])
    .filter((title): title is string => Boolean(title));

  return [
    `## Resumen ejecutivo\n${summary.executive.trim() || "—"}`,
    list("Decisiones", summary.decisions),
    list("Compromisos nuestros", summary.ourCommitments),
    list("Compromisos del cliente", summary.clientCommitments),
    list("Próximos pasos", summary.nextSteps),
    list("Riesgos", summary.risks),
    list("Preguntas abiertas", summary.openQuestions),
    list("Temas existentes relacionados", related),
    list("Temas nuevos propuestos", summary.proposedNewTopics),
    `## Advertencia sobre la calidad de la fuente\n${WARNING_LINES.map((l) => `- ${l}`).join("\n")}`,
  ].join("\n\n");
}

export interface MeetingPromptInput {
  client: { name: string; summary: string | null };
  meeting: { title: string | null; occurredAt: string | null };
  openTopics: {
    topicId: string;
    title: string;
    status: string;
    ballWith: string;
    currentState: string;
    nextStep: string | null;
  }[];
  transcript: string;
}

/**
 * Builds the literal user turn sent to the model. The transcript travels as
 * plain readable text (never as an escaped JSON blob), delimited so the model
 * cannot confuse instructions with content, and is always the last block.
 */
export function buildUserContent(input: MeetingPromptInput): string {
  const transcript = input.transcript.trim();
  if (!transcript) {
    throw new DomainError("invalid_input", "La transcripción está vacía");
  }
  const topics =
    input.openTopics.length > 0
      ? input.openTopics
          .map(
            (t) =>
              `- topicId: ${t.topicId}\n  título: ${t.title}\n  estado: ${t.status}\n  pelota: ${t.ballWith}\n  situación: ${t.currentState}\n  siguiente paso: ${t.nextStep ?? "(sin definir)"}`,
          )
          .join("\n")
      : "(el cliente no tiene temas abiertos)";

  return [
    `# Cliente\nNombre: ${input.client.name}\nResumen actual: ${input.client.summary ?? "(sin resumen)"}`,
    `# Reunión\nTítulo: ${input.meeting.title ?? "(sin título)"}\nFecha: ${input.meeting.occurredAt ?? "(desconocida)"}\nCalidad de la fuente: texto plano, sin audio, sin marcas de tiempo, identidad de hablantes no verificada.`,
    `# Temas abiertos del cliente (usa estos topicId exactos para actualizaciones)\n${topics}`,
    `# Tarea\nDevuelve el resumen estructurado y solo los elementos accionables respaldados por una cita literal de la transcripción.`,
    `# Transcripción (evidencia literal, delimitada)\n<<<TRANSCRIPCION\n${transcript}\nTRANSCRIPCION>>>`,
  ].join("\n\n");
}

export const processIngestionItemInput = z.object({
  itemId: uuidSchema,
  clientId: uuidSchema.optional().nullable(),
});

const CLAIM_ERRORS: Record<string, [code: "conflict" | "not_found" | "invalid_input", string]> = {
  item_not_found: ["not_found", "Reunión no encontrada en este espacio de trabajo"],
  item_discarded: ["invalid_input", "La reunión fue descartada"],
  item_already_processing: ["conflict", "Esta reunión ya se está procesando"],
  item_without_evidence: ["invalid_input", "La reunión no tiene evidencia asociada"],
  client_required: ["invalid_input", "Asigna un cliente antes de analizar la reunión"],
  client_not_found: ["not_found", "Cliente no encontrado en este espacio de trabajo"],
  forbidden_workspace: ["invalid_input", "Sin acceso a este espacio de trabajo"],
};

export interface ProcessIngestionOptions {
  /** Injected in tests; production resolves the Lovable AI Gateway provider. */
  provider?: AiProvider;
  /**
   * Privileged (service_role) client. Required: the atomic claim, the derivative
   * write and the transactional commit are server-only operations that a signed
   * -in user must never be able to call directly. Authorization still happens
   * above with the caller's own session (`assertAdmin` + workspace scoping).
   */
  privilegedDb?: DomainContext["db"];
}

export async function processIngestionItem(
  ctx: DomainContext,
  raw: unknown,
  options: ProcessIngestionOptions | AiProvider = {},
) {
  assertWritable(ctx);
  assertAdmin(ctx);
  const input = processIngestionItemInput.parse(raw);
  const opts: ProcessIngestionOptions =
    typeof (options as AiProvider).run === "function"
      ? { provider: options as AiProvider }
      : (options as ProcessIngestionOptions);
  const privileged = opts.privilegedDb;
  if (!privileged) {
    throw new DomainError("internal", "El análisis de reuniones requiere el contexto del servidor");
  }

  // Atomic transition to `processing`: two concurrent runs are impossible and a
  // discarded item can never be processed. Executed with the privileged client
  // because the SQL function is service_role-only.
  const { data: claimData, error: claimError } = await privileged.rpc("claim_ingestion_item_v1", {
    p_workspace_id: ctx.workspaceId,
    p_item_id: input.itemId,
    ...(input.clientId ? { p_client_id: input.clientId } : {}),
  });
  if (claimError) {
    const rawMessage = claimError.message ?? "";
    for (const [token, [code, message]] of Object.entries(CLAIM_ERRORS)) {
      if (rawMessage.includes(token)) {
        if (code === "not_found") throw notFound(message);
        throw new DomainError(code, message);
      }
    }
    console.error("claim_ingestion_item_failed", rawMessage);
    throw new DomainError("internal", "No se pudo iniciar el análisis de la reunión");
  }
  const claim = (claimData ?? {}) as {
    item_id: string;
    source_id: string;
    client_id: string;
    title: string | null;
    occurred_at: string | null;
  };

  const itemId = claim.item_id;
  const clientId = claim.client_id;
  const model = resolveAiModel();
  let runId: string | null = null;

  try {
    const [{ data: client }, { data: source }, { data: topics }] = await Promise.all([
      ctx.db
        .from("clients")
        .select("id, name, current_summary")
        .eq("workspace_id", ctx.workspaceId)
        .eq("id", clientId)
        .maybeSingle(),
      ctx.db
        .from("sources")
        .select("id, content_text, occurred_at, title")
        .eq("workspace_id", ctx.workspaceId)
        .eq("id", claim.source_id)
        .maybeSingle(),
      ctx.db
        .from("topics")
        .select("id, title, status, priority, ball_with, current_state, next_step")
        .eq("workspace_id", ctx.workspaceId)
        .eq("client_id", clientId)
        .in("status", ["active", "waiting_client", "pending_us", "blocked", "monitoring"])
        .order("last_relevant_change_at", { ascending: false })
        .limit(60),
    ]);
    if (!client) throw notFound("Cliente no encontrado en este espacio de trabajo");
    if (!source?.content_text?.trim()) throw notFound("Transcripción no encontrada");

    const provider = opts.provider ?? resolveAiProvider();
    const openTopics = topics ?? [];
    const transcript = source.content_text;

    const promptInput: MeetingPromptInput = {
      client: { name: client.name, summary: client.current_summary ?? null },
      meeting: { title: claim.title, occurredAt: claim.occurred_at ?? source.occurred_at },
      openTopics: openTopics.map((t) => ({
        topicId: t.id,
        title: t.title,
        status: t.status,
        ballWith: t.ball_with,
        currentState: t.current_state,
        nextStep: t.next_step,
      })),
      transcript: transcript.slice(0, 120000),
    };
    const userContent = buildUserContent(promptInput);

    runId = await startAiRun(ctx, {
      purpose: "meeting_extraction",
      provider: provider.name,
      model,
      promptVersion: PROMPT_VERSION,
      sourceIds: [source.id],
    });

    const response = await provider.run<unknown>({
      purpose: "meeting_extraction",
      systemInstructions: SYSTEM_INSTRUCTIONS,
      userContent,
      structuredInput: {
        client: promptInput.client,
        meeting: {
          title: promptInput.meeting.title,
          occurredAt: promptInput.meeting.occurredAt,
          sourceQuality: {
            format: "plain_text",
            hasAudio: false,
            hasTimestamps: false,
            speakerIdentityReliable: false,
          },
          transcriptChars: promptInput.transcript.length,
        },
        openTopics: promptInput.openTopics,
      },
      sourceIds: [source.id],
      expectedSchema: EXTRACTION_SCHEMA as unknown as Record<string, unknown>,
      modelConfig: { model, promptVersion: PROMPT_VERSION },
      workspaceContext: { workspaceId: ctx.workspaceId, clientId },
    });

    const extraction = extractionSchema.parse(response.structuredOutput);
    const validTopicIds = new Set(openTopics.map((t) => t.id));
    const topicTitles = Object.fromEntries(openTopics.map((t) => [t.id, t.title]));

    const discarded: { reason: string; kind?: string }[] = [];
    const rows: ProposalRow[] = [];

    for (const candidate of extraction.items) {
      const parsedItem = extractionItemSchema.safeParse(candidate);
      if (!parsedItem.success) {
        discarded.push({ reason: "invalid_item_shape" });
        continue;
      }
      const entry = parsedItem.data;
      const quote = entry.evidence.quote.trim();
      if (!quote) {
        discarded.push({ reason: "evidence_missing", kind: entry.kind });
        continue;
      }
      if (!evidenceExists(quote, transcript)) {
        discarded.push({ reason: "evidence_not_in_transcript", kind: entry.kind });
        continue;
      }
      const row = buildProposal(entry, { clientId, sourceId: source.id, validTopicIds });
      if (!row) {
        discarded.push({ reason: "not_actionable_or_ambiguous", kind: entry.kind });
        continue;
      }
      rows.push(row);
    }

    const summaryText = renderMeetingSummary(extraction.summary, topicTitles);
    const language = extraction.language.slice(0, 20);
    const sourceQuality = {
      format: "plain_text",
      hasAudio: false,
      hasTimestamps: false,
      speakerIdentityReliable: false,
    };

    // ONE transaction: proposals + immutable derivative + run completion + item
    // state. A failure at any point leaves nothing half-written.
    const { data: finishData, error: finishError } = await privileged.rpc(
      "finish_meeting_extraction_v1",
      {
        p_workspace_id: ctx.workspaceId,
        p_item_id: itemId,
        p_ai_run_id: runId,
        p_source_id: source.id,
        p_client_id: clientId,
        p_language: language,
        p_summary_text: summaryText,
        p_provider: provider.name,
        p_model: model,
        p_prompt_version: PROMPT_VERSION,
        p_derivative_metadata: {
          proposalCount: rows.length,
          discarded,
          sourceQuality,
        } as never,
        p_structured_output: {
          summary: extraction.summary,
          language: extraction.language,
          proposalCount: rows.length,
          discarded,
          usage: response.usage ?? null,
        } as never,
        p_proposals: rows.map((p) => ({
          topic_id: p.topicId,
          proposal_type: p.proposalType,
          proposed_changes: p.proposedChanges,
          explanation: p.explanation,
          confidence: p.confidence,
          evidence: p.evidence,
        })) as never,
      },
    );
    if (finishError) {
      console.error("finish_meeting_extraction_failed", finishError.message);
      throw new DomainError("internal", "No se pudo guardar el resultado del análisis");
    }
    const finish = (finishData ?? {}) as { proposal_count?: number };
    const proposalCount = finish.proposal_count ?? rows.length;

    await recordActivity(ctx, {
      eventType: "ingestion_item.processed",
      entityType: "ingestion_item",
      entityId: itemId,
      clientId,
      description: `Reunión analizada con IA: ${proposalCount} propuesta(s) para revisar`,
      inputSummary: clampText(extraction.summary.executive, 200),
      metadata: {
        aiRunId: runId,
        model,
        promptVersion: PROMPT_VERSION,
        discardedCount: discarded.length,
      },
    });

    return {
      itemId,
      aiRunId: runId,
      proposalCount,
      discardedCount: discarded.length,
      summary: summaryText,
    };
  } catch (error) {
    // Only a safe code is persisted; the provider/database detail stays in logs.
    const code =
      error instanceof DomainError && error.code !== "internal" ? error.code : "ai_run_failed";
    console.error("meeting_extraction_failed", { itemId, runId, error });
    // Recovery is transactional too: the item never stays stuck in `processing`
    // and no orphan pending proposals survive a failed run.
    const { error: failError } = await privileged.rpc("fail_meeting_extraction_v1", {
      p_workspace_id: ctx.workspaceId,
      p_item_id: itemId,
      // A failure before the run row exists still clears the item's `processing`.
      p_ai_run_id: runId as unknown as string,

      p_error_code: code,
    });
    if (failError) console.error("fail_meeting_extraction_failed", failError.message);
    throw error;
  }
}


export interface ProposalRow {
  proposalType: string;
  topicId: string | null;
  proposedChanges: Record<string, unknown>;
  explanation: string;
  confidence: number;
  evidence: ProposalEvidence;
}

/**
 * Maps one extracted item to a proposal whose `proposed_changes` is EXACTLY the
 * payload of an existing domain action. Applying a proposal therefore runs the
 * same validated path as a human edit — no separate write path exists.
 *
 * Ambiguity never becomes responsibility: there is no `?? "us"` anywhere here.
 */
export function buildProposal(
  entry: ExtractionItem,
  ctx: { clientId: string; sourceId: string; validTopicIds: Set<string> },
): ProposalRow | null {
  const content = clampText(entry.content, 5000);
  const title = clampText(entry.title, 200);
  const quote = clampText(entry.evidence.quote, 500);
  if (!quote) return null;
  const dueAt = safeIso(entry.dueAt);
  const topicId = entry.topicId && ctx.validTopicIds.has(entry.topicId) ? entry.topicId : null;
  const evidence: ProposalEvidence = {
    quote,
    // Plain-text speaker labels are not verified identities.
    speaker_label: entry.evidence.speakerLabel ? clampText(entry.evidence.speakerLabel, 80) : null,
    start_seconds: null,
    end_seconds: null,
  };
  const explanation = `Evidencia: “${quote}”`;
  // A next step is only proposed when the transcript names its owner.
  const hasOwnedNextStep = Boolean(entry.nextStep?.trim()) && entry.nextStepOwner !== null;

  switch (entry.kind) {
    case "topic_update": {
      if (!topicId || !content) return null;
      return {
        proposalType: "topic_update",
        topicId,
        proposedChanges: {
          topicId,
          content,
          updateType: "note",
          isRelevant: true,
          ...(entry.suggestedStatus ? { status: entry.suggestedStatus } : {}),
          ...(entry.ballWith ? { ballWith: entry.ballWith } : {}),
          ...(hasOwnedNextStep
            ? {
                nextStep: clampText(entry.nextStep as string, 500),
                nextStepOwner: entry.nextStepOwner,
                nextStepDueAt: dueAt,
              }
            : {}),
          sourceId: ctx.sourceId,
        },
        explanation,
        confidence: entry.confidence,
        evidence,
      };
    }
    case "new_topic": {
      if (!title) return null;
      return {
        proposalType: "new_topic",
        topicId: null,
        proposedChanges: {
          clientId: ctx.clientId,
          title,
          description: content || null,
          status: entry.suggestedStatus ?? "active",
          priority: "medium",
          // Unknown ball ownership stays with nobody.
          ballWith: entry.ballWith ?? "nobody",
          currentState: clampText(content, 2000),
          ...(hasOwnedNextStep
            ? {
                nextStep: clampText(entry.nextStep as string, 500),
                nextStepOwner: entry.nextStepOwner,
                nextStepDueAt: dueAt,
              }
            : { nextStep: null, nextStepOwner: "nobody", nextStepDueAt: null }),
        },
        explanation,
        confidence: entry.confidence,
        evidence,
      };
    }
    case "commitment": {
      // No explicit responsible party means no commitment proposal at all.
      if (!topicId || !content || entry.responsibleParty === null) return null;
      return {
        proposalType: "commitment",
        topicId,
        proposedChanges: {
          topicId,
          description: clampText(content, 500),
          responsibleParty: entry.responsibleParty,
          responsibleName: entry.responsibleName ? clampText(entry.responsibleName, 160) : null,
          dueAt,
        },
        explanation,
        confidence: entry.confidence,
        evidence,
      };
    }
    case "decision": {
      if (!topicId || !content) return null;
      return {
        proposalType: "decision",
        topicId,
        proposedChanges: {
          topicId,
          description: clampText(content, 1000),
          sourceId: ctx.sourceId,
        },
        explanation,
        confidence: entry.confidence,
        evidence,
      };
    }
    default:
      return null;
  }
}
