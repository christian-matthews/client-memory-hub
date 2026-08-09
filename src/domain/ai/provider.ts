import { z } from "zod";
import type { DomainContext } from "../shared/context";
import { DomainError } from "../shared/errors";

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
  return data.id;
}

export const reviewProposalInput = z.object({
  proposalId: z.string().uuid(),
  decision: z.enum(["approved", "rejected"]),
});

/**
 * Human review of an AI proposal. Approval records the decision; applying the
 * change still goes through the normal domain actions so validation, RLS and
 * audit are identical to a human edit. AI never overwrites human state silently.
 */
export async function reviewAiProposal(ctx: DomainContext, raw: unknown) {
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
    .select("id, status, proposal_type")
    .single();
  if (error) throw new DomainError("internal", error.message);
  return { proposal: data };
}

export function aiProviderStatus(): { configured: boolean; provider: string } {
  const provider = getAiProvider();
  return { configured: provider.isConfigured(), provider: provider.name };
}
