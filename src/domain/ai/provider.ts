import { z } from "zod";
import { assertAdmin, assertWritable, type DomainContext } from "../shared/context";
import { DomainError, notFound } from "../shared/errors";
import { recordActivity } from "../shared/audit";

/**
 * Provider-agnostic AI contract. The domain never talks to a vendor SDK; it
 * talks to this interface. Swapping providers must not touch domain logic.
 *
 * v1 status: contracts, persistence of runs/proposals and the human review flow
 * are implemented. No provider is wired yet and NOTHING fabricates AI output.
 */

export const aiRequestSchema = z.object({
  purpose: z.string().min(1),
  systemInstructions: z.string().min(1),
  structuredInput: z.record(z.unknown()),
  sourceIds: z.array(z.string().uuid()).default([]),
  /** JSON Schema (or Zod-derived) description of the expected output. */
  expectedSchema: z.record(z.unknown()),
  modelConfig: z.object({
    model: z.string().min(1),
    temperature: z.number().min(0).max(2).optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    promptVersion: z.string().min(1),
  }),
  workspaceContext: z.object({
    workspaceId: z.string().uuid(),
    clientId: z.string().uuid().optional(),
    topicId: z.string().uuid().optional(),
  }),
});
export type AiRequest = z.infer<typeof aiRequestSchema>;

export interface AiUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface AiResponse<T = unknown> {
  structuredOutput: T;
  provider: string;
  model: string;
  promptVersion: string;
  confidence: number | null;
  usage: AiUsage | null;
  error: { code: string; message: string } | null;
}

export interface AiProvider {
  readonly name: string;
  isConfigured(): boolean;
  run<T = unknown>(request: AiRequest): Promise<AiResponse<T>>;
}

/**
 * Explicit "no provider" implementation. It never invents results; it fails
 * loudly so the product keeps working manually without pretending to have AI.
 */
export const unconfiguredAiProvider: AiProvider = {
  name: "none",
  isConfigured: () => false,
  run: async () => {
    throw new DomainError(
      "invalid_input",
      "No hay proveedor de IA configurado. Las funciones de IA están deshabilitadas.",
    );
  },
};

let activeProvider: AiProvider = unconfiguredAiProvider;

export function registerAiProvider(provider: AiProvider): void {
  activeProvider = provider;
}
export function getAiProvider(): AiProvider {
  return activeProvider;
}

/** Persists a run row before any provider call, so every attempt is traceable. */
export async function startAiRun(
  ctx: DomainContext,
  params: { purpose: string; provider: string; model: string; promptVersion: string; sourceIds?: string[] },
) {
  const { data, error } = await ctx.db
    .from("ai_runs")
    .insert({
      workspace_id: ctx.workspaceId,
      initiated_by_user_id: ctx.actor.userId ?? null,
      purpose: params.purpose,
      provider: params.provider,
      model: params.model,
      prompt_version: params.promptVersion,
      status: "running",
      input_source_ids: params.sourceIds ?? [],
    })
    .select("id")
    .single();
  if (error) throw new DomainError("internal", error.message);

  const sourceIds = params.sourceIds ?? [];
  if (sourceIds.length > 0) {
    // Sources must belong to the same workspace; the composite FK on
    // ai_run_sources enforces it, this check reports it cleanly.
    const { data: valid, error: sourceError } = await ctx.db
      .from("sources")
      .select("id")
      .eq("workspace_id", ctx.workspaceId)
      .in("id", sourceIds);
    if (sourceError) throw new DomainError("internal", sourceError.message);
    if ((valid ?? []).length !== sourceIds.length) {
      throw new DomainError("invalid_input", "Alguna fuente no pertenece a este espacio de trabajo");
    }
    const { error: linkError } = await ctx.db.from("ai_run_sources").insert(
      sourceIds.map((sourceId) => ({
        workspace_id: ctx.workspaceId,
        ai_run_id: data.id,
        source_id: sourceId,
      })),
    );
    if (linkError) throw new DomainError("internal", linkError.message);
  }
  return data.id;
}

export const reviewProposalInput = z.object({
  proposalId: z.string().uuid(),
  decision: z.enum(["approved", "rejected"]),
});

/**
 * Human review of an AI proposal.
 *
 * Roles: only `owner` and `admin` may approve or reject. Read-only
 * integrations (writeEnabled = false) may never review.
 *
 * Approving does NOT apply anything: `approved` and `applied` are distinct
 * states. Applying is a separate, explicit step that goes through the normal
 * domain actions, so validation, RLS and audit are identical to a human edit.
 */
export async function reviewAiProposal(ctx: DomainContext, raw: unknown) {
  assertWritable(ctx);
  assertAdmin(ctx);
  const input = reviewProposalInput.parse(raw);

  const { data, error } = await ctx.db
    .from("ai_proposals")
    .update({
      status: input.decision,
      reviewed_by: ctx.actor.userId ?? null,
      reviewed_at: new Date().toISOString(),
    })
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", input.proposalId)
    .eq("status", "pending")
    .select("id, status, proposal_type, client_id, topic_id")
    .maybeSingle();
  if (error) throw new DomainError("internal", error.message);
  if (!data) throw notFound("Propuesta no encontrada, ya revisada o de otro espacio de trabajo");

  await recordActivity(ctx, {
    eventType: `ai_proposal.${input.decision}`,
    entityType: "ai_proposal",
    entityId: data.id,
    clientId: data.client_id,
    topicId: data.topic_id,
    description: `Propuesta de IA ${input.decision === "approved" ? "aprobada" : "rechazada"} (${data.proposal_type})`,
  });
  return { proposal: data, applied: false };
}

export const applyProposalInput = z.object({ proposalId: z.string().uuid() });

/**
 * Applies an already-approved proposal through domain actions. Never called
 * implicitly by approval. `proposal_type` decides which domain action runs;
 * unknown types are rejected instead of being guessed.
 */
export async function applyAiProposal(
  ctx: DomainContext,
  raw: unknown,
  actions: {
    addTopicUpdate: (ctx: DomainContext, payload: unknown) => Promise<unknown>;
    setTopicNextStep: (ctx: DomainContext, payload: unknown) => Promise<unknown>;
  },
) {
  assertWritable(ctx);
  assertAdmin(ctx);
  const input = applyProposalInput.parse(raw);

  const { data: proposal, error } = await ctx.db
    .from("ai_proposals")
    .select("id, status, proposal_type, proposed_changes, client_id, topic_id")
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", input.proposalId)
    .maybeSingle();
  if (error) throw new DomainError("internal", error.message);
  if (!proposal) throw notFound("Propuesta no encontrada en este espacio de trabajo");
  if (proposal.status !== "approved") {
    throw new DomainError("invalid_input", "Solo una propuesta aprobada puede aplicarse");
  }

  const changes = (proposal.proposed_changes ?? {}) as Record<string, unknown>;
  let outcome: unknown;
  switch (proposal.proposal_type) {
    case "topic_update":
      outcome = await actions.addTopicUpdate(ctx, changes);
      break;
    case "topic_next_step":
      outcome = await actions.setTopicNextStep(ctx, changes);
      break;
    default:
      throw new DomainError(
        "invalid_input",
        `Tipo de propuesta no soportado para aplicación automática: ${proposal.proposal_type}`,
      );
  }

  const { error: markError } = await ctx.db
    .from("ai_proposals")
    .update({ status: "applied", applied_at: new Date().toISOString() })
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", proposal.id)
    .eq("status", "approved");
  if (markError) throw new DomainError("internal", markError.message);

  await recordActivity(ctx, {
    eventType: "ai_proposal.applied",
    entityType: "ai_proposal",
    entityId: proposal.id,
    clientId: proposal.client_id,
    topicId: proposal.topic_id,
    description: `Propuesta de IA aplicada mediante acciones del dominio (${proposal.proposal_type})`,
    metadata: { proposalType: proposal.proposal_type },
  });
  return { proposalId: proposal.id, status: "applied" as const, outcome };
}

export function aiProviderStatus(): { configured: boolean; provider: string } {
  const provider = getAiProvider();
  return { configured: provider.isConfigured(), provider: provider.name };
}
