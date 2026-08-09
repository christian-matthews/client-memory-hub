import { DomainError } from "./errors";
import type { DomainContext } from "./context";

export interface AuditEvent {
  eventType: string;
  entityType: string;
  entityId?: string | null;
  description: string;
  clientId?: string | null;
  topicId?: string | null;
  inputSummary?: string | null;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string | null;
}

/**
 * Append-only audit trail. Called by every write action, human or automated.
 * Never receives secrets: callers pass summarized inputs only.
 */
export async function recordActivity(ctx: DomainContext, event: AuditEvent): Promise<void> {
  const { error } = await ctx.db.from("activity_events").insert({
    workspace_id: ctx.workspaceId,
    client_id: event.clientId ?? null,
    topic_id: event.topicId ?? null,
    actor_type: ctx.actor.type,
    actor_user_id: ctx.actor.userId ?? null,
    actor_name: ctx.actor.name ?? null,
    event_type: event.eventType,
    entity_type: event.entityType,
    entity_id: event.entityId ?? null,
    description: event.description,
    input_summary: event.inputSummary ?? null,
    metadata: (event.metadata ?? {}) as never,
    correlation_id: ctx.correlationId,
    idempotency_key: event.idempotencyKey ?? null,
  });
  if (error) {
    // Unique violation on (workspace_id, idempotency_key) => replay.
    if (error.code === "23505") throw new DomainError("conflict", "duplicate_idempotency_key");
    throw new DomainError("internal", `No se pudo registrar la auditoría: ${error.message}`);
  }
}

/**
 * Idempotency guard for actions reachable from integrations. If the key was
 * already used in this workspace, the previous audit row is returned so the
 * caller can respond with the original effect instead of duplicating work.
 */
export async function findReplay(
  ctx: DomainContext,
  idempotencyKey: string | undefined | null,
): Promise<{ entityId: string | null; eventType: string } | null> {
  if (!idempotencyKey) return null;
  const { data, error } = await ctx.db
    .from("activity_events")
    .select("entity_id, event_type")
    .eq("workspace_id", ctx.workspaceId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (error) throw new DomainError("internal", error.message);
  if (!data) return null;
  return { entityId: data.entity_id, eventType: data.event_type };
}

export function actorLabel(ctx: DomainContext): string {
  if (ctx.actor.name) return ctx.actor.name;
  switch (ctx.actor.type) {
    case "ai":
      return "Asistente de IA";
    case "integration":
      return ctx.actor.channel ?? "Integración";
    case "system":
      return "Sistema";
    default:
      return "Usuario";
  }
}
