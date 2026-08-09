import { DomainError, notFound } from "./errors";
import type { DomainContext } from "./context";
import { assertWritable } from "./context";
import { hashPayload } from "./idempotency";

/**
 * Transactional write dispatcher.
 *
 * Every idempotent write goes through a single PostgreSQL function call, which
 * means a single transaction that performs: idempotency reservation + hash and
 * identity validation + mutation + audit + result storage + key finalisation.
 * A crash at any point rolls all of it back; a crash after commit leaves the
 * stored result, so a retry with the same key replays it instead of repeating
 * the effect.
 *
 * The actor is NEVER taken from the caller:
 *  - `domain_write` derives it from `auth.uid()` and forces `actor_type = user`.
 *  - `domain_write_as_integration` derives workspace, name and scopes from the
 *    validated MCP credential and is granted to `service_role` only.
 */
export type DomainOperation =
  | "create_client"
  | "create_topic"
  | "add_topic_update"
  | "set_topic_next_step"
  | "create_commitment"
  | "complete_commitment";

const ERROR_MAP: Record<string, [code: "conflict" | "not_found" | "forbidden", message: string]> = {
  idempotency_conflict: ["conflict", "La clave de idempotencia ya se usó con otra operación o contenido"],
  client_not_found: ["not_found", "Cliente no encontrado en este espacio de trabajo"],
  topic_not_found: ["not_found", "Tema no encontrado en este espacio de trabajo"],
  commitment_not_found: ["not_found", "Compromiso no encontrado en este espacio de trabajo"],
  forbidden_workspace: ["forbidden", "Sin acceso a este espacio de trabajo"],
  forbidden_actor: ["forbidden", "El actor no puede ser elegido por el llamante"],
  read_only_integration: ["forbidden", "La integración es de solo lectura"],
  invalid_credential: ["forbidden", "Credencial de integración inválida"],
  not_authenticated: ["forbidden", "Sesión no autenticada"],
};

export async function domainWrite<T extends Record<string, unknown>>(
  ctx: DomainContext,
  operation: DomainOperation,
  payload: Record<string, unknown>,
  idempotencyKey?: string | null,
): Promise<T & { replayed: boolean }> {
  assertWritable(ctx);
  const requestHash = await hashPayload({ operation, payload });
  const key = idempotencyKey ?? null;
  const cleanPayload = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;

  const { data, error } =
    ctx.actor.type === "integration" && ctx.integrationId
      ? await ctx.db.rpc("domain_write_as_integration", {
          p_integration_id: ctx.integrationId,
          p_operation: operation,
          p_payload: cleanPayload as never,
          p_request_hash: requestHash,
          p_idempotency_key: key ?? undefined,
          p_correlation_id: ctx.correlationId,
        })
      : await ctx.db.rpc("domain_write", {
          p_workspace_id: ctx.workspaceId,
          p_operation: operation,
          p_payload: cleanPayload as never,
          p_request_hash: requestHash,
          p_idempotency_key: key ?? undefined,
          p_correlation_id: ctx.correlationId,
        });

  if (error) {
    const raw = error.message ?? "";
    for (const [token, [code, message]] of Object.entries(ERROR_MAP)) {
      if (raw.includes(token)) {
        if (code === "not_found") throw notFound(message);
        throw new DomainError(code, message);
      }
    }
    throw new DomainError("internal", raw);
  }

  const result = (data ?? {}) as Record<string, unknown>;
  return { ...result, replayed: result['replayed'] === true } as T & { replayed: boolean };
}
