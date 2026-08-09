/**
 * Idempotency helpers.
 *
 * The reservation itself is NOT done from TypeScript anymore: it happens inside
 * the same PostgreSQL transaction as the mutation and the audit event, through
 * `domain_write` / `domain_write_as_integration` (see ./write.ts). The RPCs
 * `idempotency_reserve` / `idempotency_finish` are internal to the database and
 * are no longer granted to `authenticated`.
 *
 * What remains here is the deterministic request hashing used to detect
 * "same key, different payload" conflicts.
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

/** Drops undefined keys so RPC arg objects satisfy exactOptionalPropertyTypes. */
export function compact<T extends Record<string, unknown>>(
  obj: T,
): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as { [K in keyof T]: Exclude<T[K], undefined> };
}
