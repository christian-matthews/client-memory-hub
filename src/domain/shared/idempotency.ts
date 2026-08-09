import { DomainError } from "./errors";
import type { DomainContext } from "./context";

/**
 * Atomic idempotency for every write action reachable from integrations.
 *
 * The audit trail (`activity_events`) is NOT used for this: auditing and
 * idempotency have different lifecycles and different failure semantics. The
 * key is reserved in `public.idempotency_keys` through a transactional RPC
 * before the mutation runs, so two concurrent callers cannot both execute.
 */

/** Deterministic JSON so the same logical payload always hashes the same. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export async function hashPayload(payload: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify(payload));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface ReserveResult {
  state: "skipped" | "reserved" | "completed" | "conflict" | "in_progress";
  result?: unknown;
}

/**
 * Reserve -> run -> store. A failure marks the key `failed`, which allows a
 * controlled retry with the same key instead of locking it forever.
 */
export async function withIdempotency<T>(
  ctx: DomainContext,
  params: { operation: string; key: string | null | undefined; payload: unknown },
  fn: () => Promise<T>,
): Promise<T & { replayed?: boolean }> {
  const key = params.key ?? null;
  if (!key) return fn();

  const requestHash = await hashPayload(params.payload);
  const { data, error } = await ctx.db.rpc("idempotency_reserve", {
    p_workspace_id: ctx.workspaceId,
    p_key: key,
    p_operation: params.operation,
    p_request_hash: requestHash,
    p_actor_type: ctx.actor.type,
  });
  if (error) throw new DomainError("internal", error.message);

  const reserved = (data ?? { state: "reserved" }) as ReserveResult;
  if (reserved.state === "conflict") {
    throw new DomainError(
      "conflict",
      "La clave de idempotencia ya se usó con un contenido diferente",
    );
  }
  if (reserved.state === "in_progress") {
    throw new DomainError("conflict", "Otra solicitud con esta clave está en curso");
  }
  if (reserved.state === "completed") {
    return { ...(reserved.result as T), replayed: true };
  }

  try {
    const result = await fn();
    await ctx.db.rpc("idempotency_finish", {
      p_workspace_id: ctx.workspaceId,
      p_key: key,
      p_ok: true,
      p_result: JSON.parse(JSON.stringify({ ...result, replayed: true })),
      p_error: null,
    });
    return result;
  } catch (err) {
    await ctx.db.rpc("idempotency_finish", {
      p_workspace_id: ctx.workspaceId,
      p_key: key,
      p_ok: false,
      p_result: null,
      p_error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

type Action<T> = (ctx: DomainContext, raw: unknown) => Promise<T>;

/**
 * Wraps a domain action so callers keep the exact same signature while gaining
 * atomic idempotency whenever the payload carries an `idempotencyKey`.
 */
export function idempotent<T extends object>(operation: string, action: Action<T>): Action<T> {
  return async (ctx, raw) => {
    const key =
      raw && typeof raw === "object" && typeof (raw as { idempotencyKey?: unknown }).idempotencyKey === "string"
        ? ((raw as { idempotencyKey: string }).idempotencyKey)
        : null;
    return withIdempotency(ctx, { operation, key, payload: raw }, () => action(ctx, raw)) as Promise<T>;
  };
}
