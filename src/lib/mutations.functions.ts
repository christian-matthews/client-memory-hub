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
import { reviewAiProposal, applyAiProposal, editAiProposal } from "@/domain/ai/provider";
import { createIntegration, revokeIntegration } from "@/domain/integrations/actions";
import {
  createIngestionConnection as createIngestionConnectionAction,
  revokeIngestionConnection as revokeIngestionConnectionAction,
  rotateIngestionConnectionSecret,
  checkIngestionConnection,
  assignIngestionItemClient,
  discardIngestionItem,
  createManualIngestionItem,
} from "@/domain/ingestion/actions";
import { processIngestionItem } from "@/domain/ai/meeting-processor";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const mutationInput = z.object({
  workspaceId: z.union([z.string().uuid(), z.undefined()]),
  payload: z.unknown(),
});

/**
 * Every mutation goes through the same shape: verified bearer token -> domain
 * context (workspace membership + role) -> pure domain action -> audit trail.
 *
 * NOTE: each `createServerFn` below is declared at module scope on purpose.
 * Wrapping the declaration in a factory prevents the build from extracting the
 * handler, and it would then execute in the browser without a server context.
 */
function runMutation(
  action: (ctx: DomainContext, raw: unknown) => Promise<unknown>,
  context: { supabase: unknown; userId: string; claims?: Record<string, unknown> },
  data: { workspaceId?: string | undefined; payload?: unknown },
) {
  return run(async () => {
    const ctx = await domainCtx(context, data.workspaceId);
    return (await action(ctx, data.payload)) as Json;
  });
}

export const createClientFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => mutationInput.parse(input))
  .handler(async ({ context, data }) => runMutation(createClientAction, context, data));

export const updateClientFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => mutationInput.parse(input))
  .handler(async ({ context, data }) => runMutation(updateClientAction, context, data));

export const archiveClientFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => mutationInput.parse(input))
  .handler(async ({ context, data }) => runMutation(archiveClientAction, context, data));

export const addClientContactFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => mutationInput.parse(input))
  .handler(async ({ context, data }) => runMutation(addClientContactAction, context, data));

export const createTopicFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => mutationInput.parse(input))
  .handler(async ({ context, data }) => runMutation(createTopicAction, context, data));

export const updateTopicStateFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => mutationInput.parse(input))
  .handler(async ({ context, data }) => runMutation(updateTopicStateAction, context, data));

export const setTopicNextStepFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => mutationInput.parse(input))
  .handler(async ({ context, data }) => runMutation(setTopicNextStepAction, context, data));

export const addTopicUpdateFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => mutationInput.parse(input))
  .handler(async ({ context, data }) => runMutation(addTopicUpdateAction, context, data));

export const recordDecisionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => mutationInput.parse(input))
  .handler(async ({ context, data }) => runMutation(recordDecisionAction, context, data));

export const createCommitmentFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => mutationInput.parse(input))
  .handler(async ({ context, data }) => runMutation(createCommitmentAction, context, data));

export const completeCommitmentFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => mutationInput.parse(input))
  .handler(async ({ context, data }) => runMutation(completeCommitmentAction, context, data));

export const cancelCommitmentFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => mutationInput.parse(input))
  .handler(async ({ context, data }) => runMutation(cancelCommitmentAction, context, data));

export const createSourceFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => mutationInput.parse(input))
  .handler(async ({ context, data }) => runMutation(createSourceAction, context, data));

export const linkSourceFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => mutationInput.parse(input))
  .handler(async ({ context, data }) => runMutation(linkSourceToTopic, context, data));

export const reviewProposalFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => mutationInput.parse(input))
  .handler(async ({ context, data }) => runMutation(reviewAiProposal, context, data));

export const applyProposalFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => mutationInput.parse(input))
  .handler(async ({ context, data }) =>
    runMutation(
      (ctx, raw) =>
        applyAiProposal(ctx, raw, {
          addTopicUpdate: addTopicUpdateAction,
          setTopicNextStep: setTopicNextStepAction,
          createTopic: createTopicAction,
          createCommitment: createCommitmentAction,
          recordDecision: recordDecisionAction,
        }),
      context,
      data,
    ),
  );

export const createIntegrationFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => mutationInput.parse(input))
  .handler(async ({ context, data }) => runMutation(createIntegration, context, data));

export const revokeIntegrationFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => mutationInput.parse(input))
  .handler(async ({ context, data }) => runMutation(revokeIntegration, context, data));

export const createIngestionConnectionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => mutationInput.parse(input))
  .handler(async ({ context, data }) => runMutation(createIngestionConnectionAction, context, data));

export const revokeIngestionConnectionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => mutationInput.parse(input))
  .handler(async ({ context, data }) => runMutation(revokeIngestionConnectionAction, context, data));

export const assignMeetingClientFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => mutationInput.parse(input))
  .handler(async ({ context, data }) => runMutation(assignIngestionItemClient, context, data));

export const discardMeetingFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => mutationInput.parse(input))
  .handler(async ({ context, data }) => runMutation(discardIngestionItem, context, data));

export const processMeetingFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => mutationInput.parse(input))
  .handler(async ({ context, data }) =>
    runMutation(async (ctx, raw) => {
      // The caller is already authenticated and checked as workspace admin by the
      // domain action. The privileged client is loaded here, inside the handler,
      // and used ONLY for the server-only claim/commit SQL functions.
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      return processIngestionItem(ctx, raw, {
        privilegedDb: supabaseAdmin as unknown as Parameters<typeof processIngestionItem>[0]["db"],
      });
    }, context, data),
  );


export const rotateIngestionConnectionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => mutationInput.parse(input))
  .handler(async ({ context, data }) => runMutation(rotateIngestionConnectionSecret, context, data));

export const checkIngestionConnectionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => mutationInput.parse(input))
  .handler(async ({ context, data }) => runMutation(checkIngestionConnection, context, data));

export const createManualIngestionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => mutationInput.parse(input))
  .handler(async ({ context, data }) => runMutation(createManualIngestionItem, context, data));

export const editProposalFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => mutationInput.parse(input))
  .handler(async ({ context, data }) => runMutation(editAiProposal, context, data));
