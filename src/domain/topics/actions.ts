import { z } from "zod";
import { assertWritable, type DomainContext } from "../shared/context";
import { DomainError, notFound } from "../shared/errors";
import { recordActivity } from "../shared/audit";
import { domainWrite } from "../shared/write";
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
  "id, workspace_id, client_id, title, description, status, priority, owner_user_id, owner_name, client_owner_name, blockers, ball_with, current_state, next_step, next_step_owner, next_step_due_at, last_relevant_change_at, created_at, updated_at, resolved_at, archived_at, normalized_title, merged_into_id, merged_at";

/**
 * Same normalization the database generated column applies: lowercase, accents
 * folded, punctuation collapsed to single spaces. Used to detect duplicates
 * BEFORE inserting, so the AI and the UI converge on one live topic per asunto.
 */
export function normalizeTopicTitle(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}


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

/** Single transaction: idempotency + client validation + insert + audit. */
export async function createTopic(ctx: DomainContext, raw: unknown) {
  const input = createTopicInput.parse(raw);
  const { topicId, replayed } = await domainWrite<{ topicId: string }>(
    ctx,
    "create_topic",
    {
      clientId: input.clientId,
      title: input.title,
      description: input.description ?? null,
      status: input.status,
      priority: input.priority,
      ballWith: input.ballWith,
      currentState: input.currentState,
      nextStep: input.nextStep ?? null,
      nextStepOwner: input.nextStepOwner,
      nextStepDueAt: input.nextStepDueAt ?? null,
    },
    input.idempotencyKey ?? null,
  );
  return { topic: await fetchTopic(ctx, topicId), replayed };
}

export const updateTopicStateInput = z.object({
  topicId: uuidSchema,
  status: topicStatusSchema.optional(),
  ballWith: partySchema.optional(),
  currentState: z.string().trim().max(2000).optional(),
  priority: prioritySchema.optional(),
  ownerName: z.string().trim().max(160).nullable().optional(),
  clientOwnerName: z.string().trim().max(160).nullable().optional(),
  blockers: z.string().trim().max(2000).nullable().optional(),
});

export async function updateTopicState(ctx: DomainContext, raw: unknown) {
  assertWritable(ctx);
  const input = updateTopicStateInput.parse(raw);
  const topic = await fetchTopic(ctx, input.topicId);

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { last_relevant_change_at: now };
  const changes: string[] = [];
  if (input.status && input.status !== topic.status) {
    patch["status"] = input.status;
    changes.push(`estado → ${TOPIC_STATUS_LABEL[input.status]}`);
    if (input.status === "resolved") patch["resolved_at"] = now;
    if (input.status === "archived") patch["archived_at"] = now;
  }
  if (input.ballWith && input.ballWith !== topic.ball_with) {
    patch["ball_with"] = input.ballWith;
    changes.push(`pelota → ${PARTY_LABEL[input.ballWith]}`);
  }
  if (input.currentState !== undefined && input.currentState !== topic.current_state) {
    patch["current_state"] = input.currentState;
    changes.push("estado actual actualizado");
  }
  if (input.priority && input.priority !== topic.priority) {
    patch["priority"] = input.priority;
    changes.push(`prioridad → ${input.priority}`);
  }
  if (input.ownerName !== undefined && input.ownerName !== topic.owner_name) {
    patch["owner_name"] = input.ownerName;
    changes.push("responsable interno actualizado");
  }
  if (input.clientOwnerName !== undefined && input.clientOwnerName !== topic.client_owner_name) {
    patch["client_owner_name"] = input.clientOwnerName;
    changes.push("contraparte del cliente actualizada");
  }
  if (input.blockers !== undefined && input.blockers !== topic.blockers) {
    patch["blockers"] = input.blockers;
    changes.push(input.blockers ? "bloqueos actualizados" : "bloqueos despejados");
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
  const input = setTopicNextStepInput.parse(raw);
  const { topicId, replayed } = await domainWrite<{ topicId: string }>(
    ctx,
    "set_topic_next_step",
    {
      topicId: input.topicId,
      nextStep: input.nextStep,
      nextStepOwner: input.nextStepOwner,
      nextStepDueAt: input.nextStepDueAt ?? null,
    },
    input.idempotencyKey ?? null,
  );
  return { topic: await fetchTopic(ctx, topicId), replayed };
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
  const input = addTopicUpdateInput.parse(raw);

  // Single PostgreSQL transaction: idempotency reservation + update + topic
  // patch + decision + commitment + source link + client activity + audit.
  const result = await domainWrite<{
    updateId: string;
    effects?: string[];
    decisionId?: string | null;
    commitmentId?: string | null;
  }>(
    ctx,
    "add_topic_update",
    {
      topicId: input.topicId,
      content: input.content,
      updateType: input.updateType,
      isRelevant: input.isRelevant,
      status: input.status ?? null,
      ballWith: input.ballWith ?? null,
      currentState: input.currentState ?? null,
      ...(input.nextStep !== undefined ? { nextStep: input.nextStep } : {}),
      nextStepOwner: input.nextStepOwner ?? null,
      nextStepDueAt: input.nextStepDueAt ?? null,
      decision: input.decision ?? null,
      commitment: input.commitment ?? null,
      sourceId: input.sourceId ?? null,
    },
    input.idempotencyKey ?? null,
  );

  return {
    updateId: result.updateId,
    topic: await fetchTopic(ctx, input.topicId),
    effects: result.effects ?? [],
    decisionId: result.decisionId ?? null,
    commitmentId: result.commitmentId ?? null,
    replayed: result.replayed,
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
