import { DomainError } from "./errors";
import type { DomainContext } from "./context";
import { compact } from "./idempotency";

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
 * Append-only audit trail.
 *
 * The browser has NO insert privilege on `activity_events`; every event is
 * written through `record_activity_v1`, a SECURITY DEFINER function that:
 *  - for a signed-in caller forces `actor_type = 'user'` and
 *    `actor_user_id = auth.uid()`, ignoring anything the caller sends, and
 *    verifies workspace membership;
 *  - only accepts `ai` / `integration` / `system` actors from privileged
 *    (service_role) callers, i.e. the MCP endpoint and server jobs.
 *
 * Writes that belong to a domain transaction are audited inside that same
 * transaction by `domain_write` (see ./write.ts) and never reach this helper.
 */
export async function recordActivity(ctx: DomainContext, event: AuditEvent): Promise<void> {
  const { error } = await ctx.db.rpc(
    "record_activity_v1",
    compact({
      p_workspace_id: ctx.workspaceId,
      p_event: {
        eventType: event.eventType,
        entityType: event.entityType,
        entityId: event.entityId ?? null,
        description: event.description,
        clientId: event.clientId ?? null,
        topicId: event.topicId ?? null,
        inputSummary: event.inputSummary ?? null,
        metadata: event.metadata ?? {},
        idempotencyKey: event.idempotencyKey ?? null,
      } as never,
      // Ignored for human callers; used by privileged server/MCP paths.
      p_actor_type: ctx.actor.type,
      p_actor_name: ctx.actor.name ?? undefined,
      p_correlation_id: ctx.correlationId,
    }),
  );
  if (error) {
    const message = error.message ?? "";
    if (message.includes("forbidden_workspace") || message.includes("forbidden_actor")) {
      throw new DomainError(
        "forbidden",
        "Auditoría rechazada: actor o espacio de trabajo inválido",
      );
    }
    throw new DomainError("internal", `No se pudo registrar la auditoría: ${message}`);
  }
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
