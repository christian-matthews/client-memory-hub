import { z } from "zod";
import { assertAdmin, assertWritable, type DomainContext, type Db } from "../shared/context";
import { DomainError, notFound } from "../shared/errors";
import { recordActivity } from "../shared/audit";
import { uuidSchema } from "../shared/vocabulary";

/**
 * Ingestion connections.
 *
 * A capture app (MacWhisper / Whisper Transcription on macOS) can only POST a
 * plain HTTP request to a fixed URL, so the credential lives in the URL path.
 * Consequences, handled explicitly:
 *  - the secret is high entropy (32 random bytes) and stored only as a SHA-256
 *    hash; the plaintext URL is shown exactly once, at creation or rotation;
 *  - the connection binds the workspace and, optionally, a default client, so
 *    the caller can never choose a workspace;
 *  - a connection can be revoked or rotated, which immediately invalidates the
 *    previous URL;
 *  - the endpoint only ever creates evidence. It never mutates client memory
 *    and never triggers AI on its own.
 */

export const ingestionConnectionFields =
  "id, workspace_id, name, provider, secret_prefix, default_client_id, enabled, created_by, last_used_at, revoked_at, created_at, updated_at";

export const ingestionItemFields =
  "id, workspace_id, connection_id, source_id, client_id, status, title, external_id, content_hash, occurred_at, duration_seconds, participants, language, ai_run_id, proposal_count, error_message, error_code, processing_started_at, metadata, processed_at, created_at, updated_at";

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomSecret(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function ingestPath(connectionId: string, secret: string): string {
  return `/api/public/ingest/macwhisper/${connectionId}/${secret}`;
}

export const createIngestionConnectionInput = z.object({
  name: z.string().trim().min(1).max(80),
  defaultClientId: uuidSchema.optional().nullable(),
});

async function assertClientExists(ctx: DomainContext, clientId: string) {
  const { data, error } = await ctx.db
    .from("clients")
    .select("id, name")
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", clientId)
    .maybeSingle();
  if (error) throw new DomainError("internal", error.message);
  if (!data) throw notFound("Cliente no encontrado en este espacio de trabajo");
  return data;
}

export async function createIngestionConnection(ctx: DomainContext, raw: unknown) {
  assertWritable(ctx);
  assertAdmin(ctx);
  const input = createIngestionConnectionInput.parse(raw);
  if (input.defaultClientId) await assertClientExists(ctx, input.defaultClientId);

  const secret = randomSecret();
  const prefix = secret.slice(0, 8);
  const secretHash = await sha256Hex(secret);

  const { data, error } = await ctx.db
    .from("ingestion_connections")
    .insert({
      workspace_id: ctx.workspaceId,
      name: input.name,
      provider: "macwhisper",
      secret_hash: secretHash,
      secret_prefix: prefix,
      default_client_id: input.defaultClientId ?? null,
      created_by: ctx.actor.userId ?? null,
    })
    .select(ingestionConnectionFields)
    .single();
  if (error) throw new DomainError("internal", error.message);

  await recordActivity(ctx, {
    eventType: "ingestion_connection.created",
    entityType: "ingestion_connection",
    entityId: data.id,
    clientId: input.defaultClientId ?? null,
    description: `Conexión de ingesta creada: ${input.name}`,
    inputSummary: prefix,
  });

  // `path` is returned exactly once; the secret is never persisted in plaintext.
  return { connection: data, path: ingestPath(data.id, secret) };
}

/**
 * Rotation: a brand-new secret replaces the old hash in place, so the previous
 * URL stops authenticating immediately. The new URL is shown exactly once and
 * the audit trail records the rotation without ever storing the secret.
 */
export async function rotateIngestionConnectionSecret(ctx: DomainContext, raw: unknown) {
  assertWritable(ctx);
  assertAdmin(ctx);
  const { connectionId } = z.object({ connectionId: uuidSchema }).parse(raw);

  const secret = randomSecret();
  const prefix = secret.slice(0, 8);
  const secretHash = await sha256Hex(secret);

  const { data, error } = await ctx.db
    .from("ingestion_connections")
    .update({ secret_hash: secretHash, secret_prefix: prefix, enabled: true })
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", connectionId)
    .is("revoked_at", null)
    .select(ingestionConnectionFields)
    .maybeSingle();
  if (error) throw new DomainError("internal", error.message);
  if (!data) throw notFound("Conexión no encontrada o revocada");

  await recordActivity(ctx, {
    eventType: "ingestion_connection.rotated",
    entityType: "ingestion_connection",
    entityId: data.id,
    description: `Secreto de ingesta rotado: ${data.name}`,
    inputSummary: prefix,
  });

  return { connection: data, path: ingestPath(data.id, secret) };
}

export async function revokeIngestionConnection(ctx: DomainContext, raw: unknown) {
  assertWritable(ctx);
  assertAdmin(ctx);
  const { connectionId } = z.object({ connectionId: uuidSchema }).parse(raw);

  const { data, error } = await ctx.db
    .from("ingestion_connections")
    .update({ revoked_at: new Date().toISOString(), enabled: false })
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", connectionId)
    .is("revoked_at", null)
    .select(ingestionConnectionFields)
    .maybeSingle();
  if (error) throw new DomainError("internal", error.message);
  if (!data) throw notFound("Conexión no encontrada o ya revocada");

  await recordActivity(ctx, {
    eventType: "ingestion_connection.revoked",
    entityType: "ingestion_connection",
    entityId: data.id,
    description: `Conexión de ingesta revocada: ${data.name}`,
  });
  return { connection: data };
}

/**
 * Controlled connection check. It deliberately does NOT create a meeting: the
 * secret is only stored hashed, so no server-side request can be signed here.
 * It reports the state that decides whether an inbound POST would authenticate.
 */
export async function checkIngestionConnection(ctx: DomainContext, raw: unknown) {
  const { connectionId } = z.object({ connectionId: uuidSchema }).parse(raw);
  const { data, error } = await ctx.db
    .from("ingestion_connections")
    .select("id, name, enabled, revoked_at, last_used_at, default_client_id")
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", connectionId)
    .maybeSingle();
  if (error) throw new DomainError("internal", error.message);
  if (!data) throw notFound("Conexión no encontrada");

  const { count } = await ctx.db
    .from("ingestion_items")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", ctx.workspaceId)
    .eq("connection_id", data.id);

  return {
    connectionId: data.id,
    accepting: Boolean(data.enabled && !data.revoked_at),
    revoked: Boolean(data.revoked_at),
    lastUsedAt: data.last_used_at,
    receivedCount: count ?? 0,
    hasDefaultClient: Boolean(data.default_client_id),
  };
}

export const assignIngestionClientInput = z.object({
  itemId: uuidSchema,
  clientId: uuidSchema,
});

/** Human decision: which client this meeting belongs to. Never guessed silently. */
export async function assignIngestionItemClient(ctx: DomainContext, raw: unknown) {
  assertWritable(ctx);
  assertAdmin(ctx);
  const input = assignIngestionClientInput.parse(raw);
  const client = await assertClientExists(ctx, input.clientId);

  const { data, error } = await ctx.db
    .from("ingestion_items")
    .update({ client_id: input.clientId, status: "ready" })
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", input.itemId)
    .in("status", ["received", "needs_client", "ready", "failed"])
    .select(ingestionItemFields)
    .maybeSingle();
  if (error) throw new DomainError("internal", error.message);
  if (!data) throw notFound("Reunión no encontrada o ya procesada");

  // The evidence follows the same client, so the client page shows it. The
  // transcript itself is never rewritten.
  if (data.source_id) {
    await ctx.db
      .from("sources")
      .update({ client_id: input.clientId })
      .eq("workspace_id", ctx.workspaceId)
      .eq("id", data.source_id);
  }

  await recordActivity(ctx, {
    eventType: "ingestion_item.client_assigned",
    entityType: "ingestion_item",
    entityId: data.id,
    clientId: input.clientId,
    description: `Reunión asignada a ${client.name}`,
    inputSummary: data.title ?? null,
  });
  return { item: data };
}

export async function discardIngestionItem(ctx: DomainContext, raw: unknown) {
  assertWritable(ctx);
  assertAdmin(ctx);
  const { itemId } = z.object({ itemId: uuidSchema }).parse(raw);

  const { data, error } = await ctx.db
    .from("ingestion_items")
    .update({ status: "discarded" })
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", itemId)
    .neq("status", "processing")
    .select(ingestionItemFields)
    .maybeSingle();
  if (error) throw new DomainError("internal", error.message);
  if (!data) throw notFound("Reunión no encontrada o en proceso");

  await recordActivity(ctx, {
    eventType: "ingestion_item.discarded",
    entityType: "ingestion_item",
    entityId: data.id,
    clientId: data.client_id,
    description: "Reunión descartada de la bandeja",
    inputSummary: data.title ?? null,
  });
  return { item: data };
}

/* ------------------------------------------------------------------ */
/* Inbound path (service role only, no user session)                   */
/* ------------------------------------------------------------------ */

export interface ResolvedConnection {
  id: string;
  workspaceId: string;
  name: string;
  secretHash: string;
  defaultClientId: string | null;
}

export type ConnectionAuthFailure = "invalid_credential" | "revoked" | "disabled";

/**
 * Resolves the (connectionId, secret) pair in the URL to a workspace. The
 * lookup is by id + hash; the caller never chooses the workspace. Timing is
 * uniform because the comparison happens on the hashed value in the database.
 */
export async function authenticateIngestionConnection(
  db: Db,
  connectionId: string,
  secret: string,
): Promise<
  { ok: true; connection: ResolvedConnection } | { ok: false; reason: ConnectionAuthFailure }
> {
  if (!/^[0-9a-f]{64}$/i.test(secret)) return { ok: false, reason: "invalid_credential" };
  const secretHash = await sha256Hex(secret);

  const { data, error } = await db
    .from("ingestion_connections")
    .select("id, workspace_id, name, default_client_id, enabled, revoked_at")
    .eq("id", connectionId)
    .eq("secret_hash", secretHash)
    .maybeSingle();
  if (error || !data) return { ok: false, reason: "invalid_credential" };
  if (data.revoked_at) return { ok: false, reason: "revoked" };
  if (!data.enabled) return { ok: false, reason: "disabled" };

  return {
    ok: true,
    connection: {
      id: data.id,
      workspaceId: data.workspace_id,
      name: data.name,
      secretHash,
      defaultClientId: data.default_client_id,
    },
  };
}

/**
 * The ONLY contract the MacWhisper webhook accepts. Anything else — a client
 * id, participants, arbitrary metadata, capability claims — is rejected, so an
 * external caller can never choose a client, a workspace or a capability.
 */
export const macwhisperPayloadSchema = z
  .object({
    title: z.string().trim().max(300).optional().nullable(),
    transcript: z
      .string()
      .min(1)
      .max(200000)
      .refine((value) => value.trim().length > 0, "transcript_required"),
  })
  .strict();
export type MacwhisperPayload = z.infer<typeof macwhisperPayloadSchema>;

/**
 * Server-owned capability metadata. The plain-text webhook cannot prove audio,
 * timings or speaker identity, so those are recorded as absent — never inferred
 * from the text.
 */
export const PLAIN_TEXT_CAPABILITIES = {
  format: "plain_text",
  received_via: "macwhisper_webhook",
  has_audio: false,
  has_structured_speakers: false,
  has_timestamps: false,
  speaker_identity_reliable: false,
} as const;

const RECEIVE_ERRORS: Record<string, [code: "conflict" | "forbidden" | "invalid_input", string]> = {
  invalid_credential: ["forbidden", "Credencial de ingesta inválida"],
  forbidden_actor: ["forbidden", "Esta operación requiere el servidor privilegiado"],
  transcript_required: ["invalid_input", "La transcripción está vacía"],
  bad_request: ["invalid_input", "Solicitud inválida"],
};

/**
 * Stores a transcript as immutable evidence plus an inbox item, in ONE database
 * transaction (`receive_macwhisper_transcript_v1`). AI is NOT run here: the
 * human decides when to process, from the meeting inbox.
 */
export async function receiveTranscript(
  ctx: DomainContext,
  connection: ResolvedConnection,
  raw: unknown,
): Promise<{ replayed: boolean }> {
  const payload = macwhisperPayloadSchema.parse(raw);
  const contentHash = await sha256Hex(payload.transcript);

  const { data, error } = await ctx.db.rpc("receive_macwhisper_transcript_v1", {
    p_connection_id: connection.id,
    p_secret_hash: connection.secretHash,
    p_title: payload.title ?? null,
    p_transcript: payload.transcript,
    p_content_hash: contentHash,
    p_metadata: PLAIN_TEXT_CAPABILITIES as never,
    p_correlation_id: ctx.correlationId,
  });

  if (error) {
    const rawMessage = error.message ?? "";
    for (const [token, [code, message]] of Object.entries(RECEIVE_ERRORS)) {
      if (rawMessage.includes(token)) throw new DomainError(code, message);
    }
    throw new DomainError("internal", rawMessage);
  }

  const result = (data ?? {}) as Record<string, unknown>;
  return { replayed: result["replayed"] === true };
}
