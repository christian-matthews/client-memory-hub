import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { domainCtx, run } from "./domain-context";
import type { DomainContext } from "@/domain/shared/context";
import {
  createClient as createClientAction,
  updateClient as updateClientAction,
  archiveClient as archiveClientAction,
  addClientContact as addClientContactAction,
} from "@/domain/clients/actions";
import {
  createTopic as createTopicAction,
  updateTopicState as updateTopicStateAction,
  setTopicNextStep as setTopicNextStepAction,
  addTopicUpdate as addTopicUpdateAction,
  recordDecision as recordDecisionAction,
} from "@/domain/topics/actions";
import {
  createCommitment as createCommitmentAction,
  completeCommitment as completeCommitmentAction,
  cancelCommitment as cancelCommitmentAction,
} from "@/domain/commitments/actions";
import { createSource as createSourceAction, linkSourceToTopic } from "@/domain/sources/actions";
import { reviewAiProposal } from "@/domain/ai/provider";

/**
 * Every mutation goes through the same shape: verified bearer token -> domain
 * context (workspace membership + role) -> pure domain action -> audit trail.
 */
function mutation(action: (ctx: DomainContext, raw: unknown) => Promise<unknown>) {
  return createServerFn({ method: "POST" })
    .middleware([requireSupabaseAuth])
    .inputValidator((input: unknown) =>
      z
        .object({ workspaceId: z.string().uuid().optional(), payload: z.unknown() })
        .parse(input),
    )
    .handler(async ({ context, data }) =>
      run(async () => {
        const ctx = await domainCtx(context, data.workspaceId);
        return action(ctx, data.payload);
      }),
    );
}

export const createClientFn = mutation(createClientAction);
export const updateClientFn = mutation(updateClientAction);
export const archiveClientFn = mutation(archiveClientAction);
export const addClientContactFn = mutation(addClientContactAction);

export const createTopicFn = mutation(createTopicAction);
export const updateTopicStateFn = mutation(updateTopicStateAction);
export const setTopicNextStepFn = mutation(setTopicNextStepAction);
export const addTopicUpdateFn = mutation(addTopicUpdateAction);
export const recordDecisionFn = mutation(recordDecisionAction);

export const createCommitmentFn = mutation(createCommitmentAction);
export const completeCommitmentFn = mutation(completeCommitmentAction);
export const cancelCommitmentFn = mutation(cancelCommitmentAction);

export const createSourceFn = mutation(createSourceAction);
export const linkSourceFn = mutation(linkSourceToTopic);

export const reviewProposalFn = mutation(reviewAiProposal);
