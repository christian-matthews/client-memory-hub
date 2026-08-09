import { z } from "zod";
import { assertWritable, type DomainContext } from "../shared/context";
import { DomainError, notFound } from "../shared/errors";
import { recordActivity } from "../shared/audit";
import { domainWrite } from "../shared/write";
import { idempotencyKeySchema, responsiblePartySchema, uuidSchema } from "../shared/vocabulary";
import { fetchTopic, touchClientActivity } from "../topics/actions";

export const commitmentRowFields =
  "id, workspace_id, client_id, topic_id, description, responsible_party, responsible_name, status, due_at, completed_at, created_at, updated_at";

async function fetchCommitment(ctx: DomainContext, commitmentId: string) {
  const { data, error } = await ctx.db
    .from("commitments")
    .select(commitmentRowFields)
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", commitmentId)
    .maybeSingle();
  if (error) throw new DomainError("internal", error.message);
  if (!data) throw notFound("Compromiso no encontrado en este espacio de trabajo");
  return data;
}

export const createCommitmentInput = z.object({
  topicId: uuidSchema,
  description: z.string().trim().min(1).max(500),
  responsibleParty: responsiblePartySchema,
  responsibleName: z.string().trim().max(160).optional().nullable(),
  dueAt: z.string().datetime({ offset: true }).optional().nullable(),
  idempotencyKey: idempotencyKeySchema,
});

export async function createCommitment(ctx: DomainContext, raw: unknown) {
  const input = createCommitmentInput.parse(raw);
  const { commitmentId, replayed } = await domainWrite<{ commitmentId: string }>(
    ctx,
    "create_commitment",
    {
      topicId: input.topicId,
      description: input.description,
      responsibleParty: input.responsibleParty,
      responsibleName: input.responsibleName ?? null,
      dueAt: input.dueAt ?? null,
    },
    input.idempotencyKey ?? null,
  );
  return { commitment: await fetchCommitment(ctx, commitmentId), replayed };
}

export const completeCommitmentInput = z.object({
  commitmentId: uuidSchema,
  idempotencyKey: idempotencyKeySchema,
});

export async function completeCommitment(ctx: DomainContext, raw: unknown) {
  const input = completeCommitmentInput.parse(raw);
  const { commitmentId, replayed } = await domainWrite<{ commitmentId: string }>(
    ctx,
    "complete_commitment",
    { commitmentId: input.commitmentId },
    input.idempotencyKey ?? null,
  );
  return { commitment: await fetchCommitment(ctx, commitmentId), replayed };
}

export async function cancelCommitment(ctx: DomainContext, raw: unknown) {
  assertWritable(ctx);
  const { commitmentId } = z.object({ commitmentId: uuidSchema }).parse(raw);
  const existing = await fetchCommitment(ctx, commitmentId);

  const { data, error } = await ctx.db
    .from("commitments")
    .update({ status: "cancelled" })
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", commitmentId)
    .select(commitmentRowFields)
    .single();
  if (error) throw new DomainError("internal", error.message);

  await recordActivity(ctx, {
    eventType: "commitment.cancelled",
    entityType: "commitment",
    entityId: commitmentId,
    clientId: existing.client_id,
    topicId: existing.topic_id,
    description: `Compromiso cancelado: ${existing.description.slice(0, 120)}`,
  });
  return { commitment: data };
}

