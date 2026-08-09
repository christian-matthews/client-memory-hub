import { z } from "zod";
import { assertAdmin, assertWritable, type DomainContext } from "../shared/context";
import { DomainError, notFound } from "../shared/errors";
import { recordActivity } from "../shared/audit";
import { uuidSchema } from "../shared/vocabulary";
import { startAiRun, type AiProvider } from "./provider";
import { resolveAiProvider } from "./gateway";
import { ingestionItemFields } from "../ingestion/actions";

/**
 * Meeting extraction.
 *
 * The transcript is evidence; the model's reading of it is a PROPOSAL. Nothing
 * here writes client memory: every extracted item becomes a pending
 * `ai_proposals` row that a human must approve and then explicitly apply
 * through the ordinary domain actions (same validation, RLS and audit as a
 * manual edit). If the model fails, the run is marked failed and the item keeps
 * its transcript — nothing is invented.
 */

export const AI_MODEL = "openai/gpt-5.6-sol";
export const PROMPT_VERSION = "meeting-extraction-v1";

const SYSTEM_INSTRUCTIONS = `Eres un analista de memoria operativa de clientes. Recibes la transcripción de una reunión y el estado actual de los temas abiertos de un cliente.

Tu tarea es extraer SOLO lo que la transcripción respalda de forma explícita:
- actualizaciones relevantes de temas existentes (usa su topicId exacto),
- temas nuevos que claramente no encajan en ninguno existente,
- compromisos concretos (quién hace qué y para cuándo),
- decisiones tomadas.

Reglas estrictas:
- Nunca inventes hechos, fechas, nombres ni cifras que no estén en la transcripción.
- Si algo es ambiguo, no lo propongas o baja su confianza.
- Ignora conversación irrelevante (saludos, temas personales, ruido).
- Cada elemento debe incluir una cita textual breve de la transcripción como evidencia.
- Las fechas van en formato ISO 8601 completo con zona (o null si no se menciona).
- Responde en español.`;

/** Strict-compatible JSON Schema: every property required, optionals nullable. */
const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "language", "items"],
  properties: {
    summary: { type: "string" },
    language: { type: "string" },
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
          evidence: { type: "string" },
        },
      },
    },
  },
} as const;

const extractionItemSchema = z.object({
  kind: z.enum(["topic_update", "new_topic", "commitment", "decision"]),
  topicId: z.string().nullable(),
  title: z.string().default(""),
  content: z.string().default(""),
  suggestedStatus: z
    .enum(["active", "waiting_client", "pending_us", "blocked", "monitoring", "resolved"])
    .nullable(),
  ballWith: z.enum(["us", "client", "third_party", "nobody"]).nullable(),
  nextStep: z.string().nullable(),
  nextStepOwner: z.enum(["us", "client", "third_party", "nobody"]).nullable(),
  dueAt: z.string().nullable(),
  responsibleParty: z.enum(["us", "client", "third_party"]).nullable(),
  responsibleName: z.string().nullable(),
  confidence: z.number().min(0).max(1).catch(0.5),
  evidence: z.string().default(""),
});

const extractionSchema = z.object({
  summary: z.string().default(""),
  language: z.string().default("es"),
  items: z.array(extractionItemSchema).default([]),
});
export type MeetingExtraction = z.infer<typeof extractionSchema>;

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

export const processIngestionItemInput = z.object({
  itemId: uuidSchema,
  clientId: uuidSchema.optional().nullable(),
});

export async function processIngestionItem(
  ctx: DomainContext,
  raw: unknown,
  injectedProvider?: AiProvider,
) {
  assertWritable(ctx);
  assertAdmin(ctx);
  const input = processIngestionItemInput.parse(raw);

  const { data: item, error: itemError } = await ctx.db
    .from("ingestion_items")
    .select(ingestionItemFields)
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", input.itemId)
    .maybeSingle();
  if (itemError) throw new DomainError("internal", itemError.message);
  if (!item) throw notFound("Reunión no encontrada en este espacio de trabajo");
  if (item.status === "processing") {
    throw new DomainError("conflict", "Esta reunión ya se está procesando");
  }
  if (item.status === "discarded") {
    throw new DomainError("invalid_input", "La reunión fue descartada");
  }

  const clientId = input.clientId ?? item.client_id;
  if (!clientId) {
    throw new DomainError(
      "invalid_input",
      "Asigna un cliente a la reunión antes de procesarla con IA",
    );
  }
  if (!item.source_id) {
    throw new DomainError("invalid_input", "La reunión no tiene evidencia asociada");
  }

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
      .eq("id", item.source_id)
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
  if (!source?.content_text) throw notFound("Transcripción no encontrada");

  const provider = injectedProvider ?? resolveAiProvider();
  const openTopics = topics ?? [];

  await ctx.db
    .from("ingestion_items")
    .update({ status: "processing", client_id: clientId, error_message: null })
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", item.id);

  const runId = await startAiRun(ctx, {
    purpose: "meeting_extraction",
    provider: provider.name,
    model: AI_MODEL,
    promptVersion: PROMPT_VERSION,
    sourceIds: [source.id],
  });

  try {
    const response = await provider.run<unknown>({
      purpose: "meeting_extraction",
      systemInstructions: SYSTEM_INSTRUCTIONS,
      structuredInput: {
        client: { name: client.name, summary: client.current_summary ?? null },
        meeting: {
          title: item.title,
          occurredAt: item.occurred_at ?? source.occurred_at,
          participants: item.participants,
          transcript: source.content_text.slice(0, 120000),
        },
        openTopics: openTopics.map((t) => ({
          topicId: t.id,
          title: t.title,
          status: t.status,
          ballWith: t.ball_with,
          currentState: t.current_state,
          nextStep: t.next_step,
        })),
      },
      sourceIds: [source.id],
      expectedSchema: EXTRACTION_SCHEMA as unknown as Record<string, unknown>,
      modelConfig: { model: AI_MODEL, promptVersion: PROMPT_VERSION },
      workspaceContext: { workspaceId: ctx.workspaceId, clientId },
    });

    const extraction = extractionSchema.parse(response.structuredOutput);
    const validTopicIds = new Set(openTopics.map((t) => t.id));

    const proposals = extraction.items
      .map((entry) => buildProposal(entry, { clientId, sourceId: source.id, validTopicIds }))
      .filter((p): p is ProposalRow => p !== null)
      .map((p) => ({
        workspace_id: ctx.workspaceId,
        ai_run_id: runId,
        client_id: clientId,
        topic_id: p.topicId,
        proposal_type: p.proposalType,
        proposed_changes: p.proposedChanges as never,
        explanation: p.explanation,
        confidence: p.confidence,
        status: "pending" as const,
      }));

    if (proposals.length > 0) {
      const { error: proposalError } = await ctx.db.from("ai_proposals").insert(proposals);
      if (proposalError) throw new DomainError("internal", proposalError.message);
    }

    await ctx.db
      .from("ai_runs")
      .update({
        status: "completed",
        structured_output: extraction as never,
        completed_at: new Date().toISOString(),
      })
      .eq("workspace_id", ctx.workspaceId)
      .eq("id", runId);

    await ctx.db
      .from("ingestion_items")
      .update({
        status: "processed",
        client_id: clientId,
        ai_run_id: runId,
        proposal_count: proposals.length,
        processed_at: new Date().toISOString(),
        error_message: null,
      })
      .eq("workspace_id", ctx.workspaceId)
      .eq("id", item.id);

    await recordActivity(ctx, {
      eventType: "ingestion_item.processed",
      entityType: "ingestion_item",
      entityId: item.id,
      clientId,
      description: `Reunión analizada con IA: ${proposals.length} propuesta(s) para revisar`,
      inputSummary: clampText(extraction.summary, 200),
      metadata: { aiRunId: runId, model: AI_MODEL, promptVersion: PROMPT_VERSION },
    });

    return {
      itemId: item.id,
      aiRunId: runId,
      proposalCount: proposals.length,
      summary: extraction.summary,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error de IA desconocido";
    await ctx.db
      .from("ai_runs")
      .update({ status: "failed", error_message: message.slice(0, 1000), completed_at: new Date().toISOString() })
      .eq("workspace_id", ctx.workspaceId)
      .eq("id", runId);
    await ctx.db
      .from("ingestion_items")
      .update({ status: "failed", ai_run_id: runId, error_message: message.slice(0, 1000) })
      .eq("workspace_id", ctx.workspaceId)
      .eq("id", item.id);
    throw error;
  }
}

interface ProposalRow {
  proposalType: string;
  topicId: string | null;
  proposedChanges: Record<string, unknown>;
  explanation: string;
  confidence: number;
}

/**
 * Maps one extracted item to a proposal whose `proposed_changes` is EXACTLY the
 * payload of an existing domain action. Applying a proposal therefore runs the
 * same validated path as a human edit — no separate write path exists.
 */
function buildProposal(
  entry: z.infer<typeof extractionItemSchema>,
  ctx: { clientId: string; sourceId: string; validTopicIds: Set<string> },
): ProposalRow | null {
  const content = clampText(entry.content, 5000);
  const title = clampText(entry.title, 200);
  const evidence = clampText(entry.evidence, 500);
  const dueAt = safeIso(entry.dueAt);
  const topicId = entry.topicId && ctx.validTopicIds.has(entry.topicId) ? entry.topicId : null;
  const explanation = evidence ? `Evidencia: “${evidence}”` : "Sin cita textual asociada";

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
          ...(entry.nextStep
            ? {
                nextStep: clampText(entry.nextStep, 500),
                nextStepOwner: entry.nextStepOwner ?? "us",
                nextStepDueAt: dueAt,
              }
            : {}),
          sourceId: ctx.sourceId,
        },
        explanation,
        confidence: entry.confidence,
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
          ballWith: entry.ballWith ?? "us",
          currentState: clampText(content, 2000),
          nextStep: entry.nextStep ? clampText(entry.nextStep, 500) : null,
          nextStepOwner: entry.nextStepOwner ?? "nobody",
          nextStepDueAt: dueAt,
        },
        explanation,
        confidence: entry.confidence,
      };
    }
    case "commitment": {
      if (!topicId || !content) return null;
      return {
        proposalType: "commitment",
        topicId,
        proposedChanges: {
          topicId,
          description: clampText(content, 500),
          responsibleParty: entry.responsibleParty ?? "us",
          responsibleName: entry.responsibleName ? clampText(entry.responsibleName, 160) : null,
          dueAt,
        },
        explanation,
        confidence: entry.confidence,
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
      };
    }
    default:
      return null;
  }
}
