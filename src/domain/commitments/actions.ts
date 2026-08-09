import { z } from "zod";
import { assertWritable, type DomainContext } from "../shared/context";
import { DomainError, notFound } from "../shared/errors";
import { findReplay, recordActivity } from "../shared/audit";
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
  assertWritable(ctx);
  const input = createCommitmentInput.parse(raw);
  const topic = await fetchTopic(ctx, input.topicId);

  const replay = await findReplay(ctx, input.idempotencyKey);
  if (replay?.entityId) {
    return { commitment: await fetchCommitment(ctx, replay.entityId), replayed: true };
  }

  const { data, error } = await ctx.db
    .from("commitments")
    .insert({
      workspace_id: ctx.workspaceId,
      client_id: topic.client_id,
      topic_id: topic.id,
      description: input.description,
      responsible_party: input.responsibleParty,
      responsible_name: input.responsibleName ?? null,
      due_at: input.dueAt ?? null,
    })
    .select(commitmentRowFields)
    .single();
  if (error) throw new DomainError("internal", error.message);

  await touchClientActivity(ctx, topic.client_id, new Date().toISOString());
  await recordActivity(ctx, {
    eventType: "commitment.created",
    entityType: "commitment",
    entityId: data.id,
    clientId: topic.client_id,
    topicId: topic.id,
    description: `Compromiso creado (${input.responsibleParty}) en “${topic.title}”`,
    inputSummary: input.description.slice(0, 200),
    idempotencyKey: input.idempotencyKey ?? null,
  });
  return { commitment: data, replayed: false };
}

export const completeCommitmentInput = z.object({
  commitmentId: uuidSchema,
  idempotencyKey: idempotencyKeySchema,
});

export async function completeCommitment(ctx: DomainContext, raw: unknown) {
  assertWritable(ctx);
  const input = completeCommitmentInput.parse(raw);
  const existing = await fetchCommitment(ctx, input.commitmentId);

  if (existing.status === "completed") {
    return { commitment: existing, replayed: true };
  }
  const replay = await findReplay(ctx, input.idempotencyKey);
  if (replay) return { commitment: existing, replayed: true };

  const now = new Date().toISOString();
  const { data, error } = await ctx.db
    .from("commitments")
    .update({ status: "completed", completed_at: now })
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", input.commitmentId)
    .select(commitmentRowFields)
    .single();
  if (error) throw new DomainError("internal", error.message);

  await touchClientActivity(ctx, existing.client_id, now);
  await recordActivity(ctx, {
    eventType: "commitment.completed",
    entityType: "commitment",
    entityId: data.id,
    clientId: data.client_id,
    topicId: data.topic_id,
    description: `Compromiso cumplido: ${data.description.slice(0, 120)}`,
    idempotencyKey: input.idempotencyKey ?? null,
  });
  return { commitment: data, replayed: false };
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
