import { z } from "zod";
import { assertWritable, type DomainContext } from "../shared/context";
import { DomainError, notFound } from "../shared/errors";
import { findReplay, recordActivity } from "../shared/audit";
import {
  idempotencyKeySchema,
  partySchema,
  prioritySchema,
  responsiblePartySchema,
  topicStatusSchema,
  updateTypeSchema,
  uuidSchema,
  TOPIC_STATUS_LABEL,
  PARTY_LABEL,
} from "../shared/vocabulary";

export const topicRowFields =
  "id, workspace_id, client_id, title, description, status, priority, owner_user_id, ball_with, current_state, next_step, next_step_owner, next_step_due_at, last_relevant_change_at, created_at, updated_at, resolved_at, archived_at";

export async function fetchTopic(ctx: DomainContext, topicId: string) {
  const { data, error } = await ctx.db
    .from("topics")
    .select(topicRowFields)
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", topicId)
    .maybeSingle();
  if (error) throw new DomainError("internal", error.message);
  if (!data) throw notFound("Tema no encontrado en este espacio de trabajo");
  return data;
}

export const createTopicInput = z.object({
  clientId: uuidSchema,
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).optional().nullable(),
  status: topicStatusSchema.default("active"),
  priority: prioritySchema.default("medium"),
  ballWith: partySchema.default("us"),
  currentState: z.string().trim().max(2000).default(""),
  nextStep: z.string().trim().max(500).optional().nullable(),
  nextStepOwner: partySchema.default("nobody"),
  nextStepDueAt: z.string().datetime({ offset: true }).optional().nullable(),
  idempotencyKey: idempotencyKeySchema,
});

export async function createTopic(ctx: DomainContext, raw: unknown) {
  assertWritable(ctx);
  const input = createTopicInput.parse(raw);

  const replay = await findReplay(ctx, input.idempotencyKey);
  if (replay?.entityId) return { topic: await fetchTopic(ctx, replay.entityId), replayed: true };

  const { data: client, error: clientError } = await ctx.db
    .from("clients")
    .select("id, name")
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", input.clientId)
    .maybeSingle();
  if (clientError) throw new DomainError("internal", clientError.message);
  if (!client) throw notFound("Cliente no encontrado en este espacio de trabajo");

  const now = new Date().toISOString();
  const { data, error } = await ctx.db
    .from("topics")
    .insert({
      workspace_id: ctx.workspaceId,
      client_id: input.clientId,
      title: input.title,
      description: input.description ?? null,
      status: input.status,
      priority: input.priority,
      owner_user_id: ctx.actor.userId ?? null,
      ball_with: input.ballWith,
      current_state: input.currentState,
      next_step: input.nextStep ?? null,
      next_step_owner: input.nextStepOwner,
      next_step_due_at: input.nextStepDueAt ?? null,
      last_relevant_change_at: now,
    })
    .select(topicRowFields)
    .single();
  if (error) throw new DomainError("internal", error.message);

  await touchClientActivity(ctx, input.clientId, now);
  await recordActivity(ctx, {
    eventType: "topic.created",
    entityType: "topic",
    entityId: data.id,
    clientId: input.clientId,
    topicId: data.id,
    description: `Tema creado para ${client.name}: ${data.title}`,
    inputSummary: input.title,
    idempotencyKey: input.idempotencyKey ?? null,
  });
  return { topic: data, replayed: false };
}

export const updateTopicStateInput = z.object({
  topicId: uuidSchema,
  status: topicStatusSchema.optional(),
  ballWith: partySchema.optional(),
  currentState: z.string().trim().max(2000).optional(),
  priority: prioritySchema.optional(),
});

export async function updateTopicState(ctx: DomainContext, raw: unknown) {
  assertWritable(ctx);
  const input = updateTopicStateInput.parse(raw);
  const topic = await fetchTopic(ctx, input.topicId);

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { last_relevant_change_at: now };
  const changes: string[] = [];
  if (input.status && input.status !== topic.status) {
    patch['status'] = input.status;
    changes.push(`estado → ${TOPIC_STATUS_LABEL[input.status]}`);
    if (input.status === "resolved") patch['resolved_at'] = now;
    if (input.status === "archived") patch['archived_at'] = now;
  }
  if (input.ballWith && input.ballWith !== topic.ball_with) {
    patch['ball_with'] = input.ballWith;
    changes.push(`pelota → ${PARTY_LABEL[input.ballWith]}`);
  }
  if (input.currentState !== undefined && input.currentState !== topic.current_state) {
    patch['current_state'] = input.currentState;
    changes.push("estado actual actualizado");
  }
  if (input.priority && input.priority !== topic.priority) {
    patch['priority'] = input.priority;
    changes.push(`prioridad → ${input.priority}`);
  }
  if (changes.length === 0) return { topic };

  const { data, error } = await ctx.db
    .from("topics")
    .update(patch as never)
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", input.topicId)
    .select(topicRowFields)
    .single();
  if (error) throw new DomainError("internal", error.message);

  await touchClientActivity(ctx, topic.client_id, now);
  await recordActivity(ctx, {
    eventType: "topic.state_changed",
    entityType: "topic",
    entityId: topic.id,
    clientId: topic.client_id,
    topicId: topic.id,
    description: `Tema “${topic.title}”: ${changes.join(", ")}`,
    inputSummary: changes.join(", "),
  });
  return { topic: data, changes };
}

export const setTopicNextStepInput = z.object({
  topicId: uuidSchema,
  nextStep: z.string().trim().max(500).nullable(),
  nextStepOwner: partySchema.default("nobody"),
  nextStepDueAt: z.string().datetime({ offset: true }).nullable().optional(),
  idempotencyKey: idempotencyKeySchema,
});

export async function setTopicNextStep(ctx: DomainContext, raw: unknown) {
  assertWritable(ctx);
  const input = setTopicNextStepInput.parse(raw);
  const topic = await fetchTopic(ctx, input.topicId);

  const replay = await findReplay(ctx, input.idempotencyKey);
  if (replay) return { topic: await fetchTopic(ctx, input.topicId), replayed: true };

  const now = new Date().toISOString();
  const { data, error } = await ctx.db
    .from("topics")
    .update({
      next_step: input.nextStep,
      next_step_owner: input.nextStepOwner,
      next_step_due_at: input.nextStepDueAt ?? null,
      last_relevant_change_at: now,
    })
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", input.topicId)
    .select(topicRowFields)
    .single();
  if (error) throw new DomainError("internal", error.message);

  await touchClientActivity(ctx, topic.client_id, now);
  await recordActivity(ctx, {
    eventType: "topic.next_step_set",
    entityType: "topic",
    entityId: topic.id,
    clientId: topic.client_id,
    topicId: topic.id,
    description: `Próximo paso de “${topic.title}”: ${input.nextStep ?? "sin definir"}`,
    inputSummary: input.nextStep ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
  });
  return { topic: data, replayed: false };
}

/**
 * Composite, audited operation: an update may simultaneously change state,
 * ball, next step, register a decision and create a commitment. This is the
 * single entry point so the web UI and MCP never diverge.
 */
export const addTopicUpdateInput = z.object({
  topicId: uuidSchema,
  content: z.string().trim().min(1).max(5000),
  updateType: updateTypeSchema.default("note"),
  isRelevant: z.boolean().default(true),
  status: topicStatusSchema.optional(),
  ballWith: partySchema.optional(),
  currentState: z.string().trim().max(2000).optional(),
  nextStep: z.string().trim().max(500).nullable().optional(),
  nextStepOwner: partySchema.optional(),
  nextStepDueAt: z.string().datetime({ offset: true }).nullable().optional(),
  decision: z.string().trim().min(1).max(1000).optional(),
  commitment: z
    .object({
      description: z.string().trim().min(1).max(500),
      responsibleParty: responsiblePartySchema,
      responsibleName: z.string().trim().max(160).optional().nullable(),
      dueAt: z.string().datetime({ offset: true }).optional().nullable(),
    })
    .optional(),
  sourceId: uuidSchema.optional().nullable(),
  idempotencyKey: idempotencyKeySchema,
});

export async function addTopicUpdate(ctx: DomainContext, raw: unknown) {
  assertWritable(ctx);
  const input = addTopicUpdateInput.parse(raw);
  const topic = await fetchTopic(ctx, input.topicId);

  const replay = await findReplay(ctx, input.idempotencyKey);
  if (replay?.entityId) {
    return { updateId: replay.entityId, topic, replayed: true, effects: ["replay"] };
  }

  const now = new Date().toISOString();
  const effects: string[] = [];

  const { data: update, error: updateError } = await ctx.db
    .from("topic_updates")
    .insert({
      workspace_id: ctx.workspaceId,
      client_id: topic.client_id,
      topic_id: topic.id,
      update_type: input.updateType,
      content: input.content,
      is_relevant: input.isRelevant,
      created_by: ctx.actor.userId ?? null,
    })
    .select("id, created_at")
    .single();
  if (updateError) throw new DomainError("internal", updateError.message);
  effects.push("actualización registrada");

  const topicPatch: Record<string, unknown> = {};
  if (input.isRelevant) topicPatch['last_relevant_change_at'] = now;
  if (input.status && input.status !== topic.status) {
    topicPatch['status'] = input.status;
    if (input.status === "resolved") topicPatch['resolved_at'] = now;
    if (input.status === "archived") topicPatch['archived_at'] = now;
    effects.push(`estado → ${TOPIC_STATUS_LABEL[input.status]}`);
  }
  if (input.ballWith && input.ballWith !== topic.ball_with) {
    topicPatch['ball_with'] = input.ballWith;
    effects.push(`pelota → ${PARTY_LABEL[input.ballWith]}`);
  }
  if (input.currentState !== undefined) {
    topicPatch['current_state'] = input.currentState;
    effects.push("estado actual actualizado");
  }
  if (input.nextStep !== undefined) {
    topicPatch['next_step'] = input.nextStep;
    topicPatch['next_step_owner'] = input.nextStepOwner ?? "nobody";
    topicPatch['next_step_due_at'] = input.nextStepDueAt ?? null;
    effects.push("próximo paso actualizado");
  }

  if (Object.keys(topicPatch).length > 0) {
    const { error } = await ctx.db
      .from("topics")
      .update(topicPatch as never)
      .eq("workspace_id", ctx.workspaceId)
      .eq("id", topic.id);
    if (error) throw new DomainError("internal", error.message);
  }

  if (input.decision) {
    const { error } = await ctx.db.from("decisions").insert({
      workspace_id: ctx.workspaceId,
      client_id: topic.client_id,
      topic_id: topic.id,
      description: input.decision,
      source_id: input.sourceId ?? null,
      created_by: ctx.actor.userId ?? null,
    });
    if (error) throw new DomainError("internal", error.message);
    effects.push("decisión registrada");
  }

  if (input.commitment) {
    const { error } = await ctx.db.from("commitments").insert({
      workspace_id: ctx.workspaceId,
      client_id: topic.client_id,
      topic_id: topic.id,
      description: input.commitment.description,
      responsible_party: input.commitment.responsibleParty,
      responsible_name: input.commitment.responsibleName ?? null,
      due_at: input.commitment.dueAt ?? null,
    });
    if (error) throw new DomainError("internal", error.message);
    effects.push("compromiso creado");
  }

  if (input.sourceId) {
    const { error } = await ctx.db.from("topic_sources").upsert(
      {
        workspace_id: ctx.workspaceId,
        topic_id: topic.id,
        source_id: input.sourceId,
        linked_by: ctx.actor.userId ?? null,
      },
      { onConflict: "topic_id,source_id", ignoreDuplicates: true },
    );
    if (error) throw new DomainError("internal", error.message);
    effects.push("fuente vinculada");
  }

  if (input.isRelevant) await touchClientActivity(ctx, topic.client_id, now);

  await recordActivity(ctx, {
    eventType: "topic.update_added",
    entityType: "topic_update",
    entityId: update.id,
    clientId: topic.client_id,
    topicId: topic.id,
    description: `Actualización en “${topic.title}”: ${effects.join(", ")}`,
    inputSummary: input.content.slice(0, 200),
    metadata: { effects },
    idempotencyKey: input.idempotencyKey ?? null,
  });

  return {
    updateId: update.id,
    topic: await fetchTopic(ctx, topic.id),
    effects,
    replayed: false,
  };
}

export const recordDecisionInput = z.object({
  topicId: uuidSchema,
  description: z.string().trim().min(1).max(1000),
  decidedAt: z.string().datetime({ offset: true }).optional(),
  sourceId: uuidSchema.optional().nullable(),
  idempotencyKey: idempotencyKeySchema,
});

export async function recordDecision(ctx: DomainContext, raw: unknown) {
  assertWritable(ctx);
  const input = recordDecisionInput.parse(raw);
  const topic = await fetchTopic(ctx, input.topicId);

  const replay = await findReplay(ctx, input.idempotencyKey);
  if (replay?.entityId) return { decisionId: replay.entityId, replayed: true };

  const { data, error } = await ctx.db
    .from("decisions")
    .insert({
      workspace_id: ctx.workspaceId,
      client_id: topic.client_id,
      topic_id: topic.id,
      description: input.description,
      decided_at: input.decidedAt ?? new Date().toISOString(),
      source_id: input.sourceId ?? null,
      created_by: ctx.actor.userId ?? null,
    })
    .select("id, description, decided_at, status")
    .single();
  if (error) throw new DomainError("internal", error.message);

  await recordActivity(ctx, {
    eventType: "decision.recorded",
    entityType: "decision",
    entityId: data.id,
    clientId: topic.client_id,
    topicId: topic.id,
    description: `Decisión registrada en “${topic.title}”`,
    inputSummary: input.description.slice(0, 200),
    idempotencyKey: input.idempotencyKey ?? null,
  });
  return { decision: data, decisionId: data.id, replayed: false };
}

export async function touchClientActivity(
  ctx: DomainContext,
  clientId: string,
  at: string,
): Promise<void> {
  const { error } = await ctx.db
    .from("clients")
    .update({ last_relevant_activity_at: at })
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", clientId);
  if (error) throw new DomainError("internal", error.message);
}
