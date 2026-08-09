import { z } from "zod";
import { assertAdmin, assertWritable, type DomainContext, type Db } from "../shared/context";
import { DomainError, notFound } from "../shared/errors";
import { recordActivity } from "../shared/audit";
import { uuidSchema } from "../shared/vocabulary";

/**
 * Ingestion connections.
 *
 * A capture app (MacWhisper / Whisper Transcription on macOS) can only POST a
 * plain HTTP request with a fixed URL, so the credential lives in the URL path.
 * Consequences, handled explicitly:
 *  - the secret is high entropy (32 random bytes) and stored only as a SHA-256
 *    hash; the plaintext URL is shown exactly once, at creation time;
 *  - the connection binds the workspace and, optionally, a default client, so
 *    the caller can never choose a workspace;
 *  - a connection can be revoked, which immediately invalidates the URL;
 *  - the endpoint only ever creates evidence. It never mutates client memory
 *    and never triggers AI on its own.
 */

export const ingestionConnectionFields =
  "id, workspace_id, name, provider, secret_prefix, default_client_id, enabled, created_by, last_used_at, revoked_at, created_at, updated_at";

export const ingestionItemFields =
  "id, workspace_id, connection_id, source_id, client_id, status, title, external_id, content_hash, occurred_at, duration_seconds, participants, language, ai_run_id, proposal_count, error_message, metadata, processed_at, created_at, updated_at";

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomSecret(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const createIngestionConnectionInput = z.object({
  name: z.string().trim().min(1).max(80),
  defaultClientId: uuidSchema.optional().nullable(),
});

export async function createIngestionConnection(ctx: DomainContext, raw: unknown) {
  assertWritable(ctx);
  assertAdmin(ctx);
  const input = createIngestionConnectionInput.parse(raw);

  if (input.defaultClientId) {
    const { data: client, error } = await ctx.db
      .from("clients")
      .select("id")
      .eq("workspace_id", ctx.workspaceId)
      .eq("id", input.defaultClientId)
      .maybeSingle();
    if (error) throw new DomainError("internal", error.message);
    if (!client) throw notFound("Cliente no encontrado en este espacio de trabajo");
  }

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
  return {
    connection: data,
    path: `/api/public/ingest/macwhisper/${data.id}/${secret}`,
  };
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

export const assignIngestionClientInput = z.object({
  itemId: uuidSchema,
  clientId: uuidSchema,
});

/** Human decision: which client this meeting belongs to. Never guessed silently. */
export async function assignIngestionItemClient(ctx: DomainContext, raw: unknown) {
  assertWritable(ctx);
  assertAdmin(ctx);
  const input = assignIngestionClientInput.parse(raw);

  const { data: client, error: clientError } = await ctx.db
    .from("clients")
    .select("id, name")
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", input.clientId)
    .maybeSingle();
  if (clientError) throw new DomainError("internal", clientError.message);
  if (!client) throw notFound("Cliente no encontrado en este espacio de trabajo");

  const { data, error } = await ctx.db
    .from("ingestion_items")
    .update({ client_id: input.clientId })
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", input.itemId)
    .in("status", ["received", "failed"])
    .select(ingestionItemFields)
    .maybeSingle();
  if (error) throw new DomainError("internal", error.message);
  if (!data) throw notFound("Reunión no encontrada o ya procesada");

  // The evidence follows the same client, so the client page shows it.
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
): Promise<{ ok: true; connection: ResolvedConnection } | { ok: false; reason: ConnectionAuthFailure }> {
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
      defaultClientId: data.default_client_id,
    },
  };
}

export const macwhisperPayloadSchema = z.object({
  title: z.string().trim().max(300).optional().nullable(),
  transcript: z.string().trim().min(1).max(200000),
  externalId: z.string().trim().max(200).optional().nullable(),
  occurredAt: z.string().datetime({ offset: true }).optional().nullable(),
  durationSeconds: z.number().int().min(0).max(86400).optional().nullable(),
  participants: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  language: z.string().trim().max(20).optional().nullable(),
  clientId: uuidSchema.optional().nullable(),
  metadata: z.record(z.unknown()).default({}),
});
export type MacwhisperPayload = z.infer<typeof macwhisperPayloadSchema>;

/**
 * Stores a transcript as immutable evidence plus an inbox item. AI is NOT run
 * here: the human decides when to process, from the meeting inbox.
 */
export async function receiveTranscript(
  ctx: DomainContext,
  connection: ResolvedConnection,
  raw: unknown,
) {
  const payload = macwhisperPayloadSchema.parse(raw);
  const contentHash = await sha256Hex(payload.transcript);

  const clientId = payload.clientId ?? connection.defaultClientId ?? null;
  if (clientId) {
    const { data: client } = await ctx.db
      .from("clients")
      .select("id")
      .eq("workspace_id", ctx.workspaceId)
      .eq("id", clientId)
      .maybeSingle();
    if (!client) throw notFound("Cliente no encontrado en este espacio de trabajo");
  }

  // Same transcript resent by the macOS app is a no-op replay.
  const { data: existing } = await ctx.db
    .from("ingestion_items")
    .select("id, status, source_id")
    .eq("workspace_id", ctx.workspaceId)
    .eq("content_hash", contentHash)
    .maybeSingle();
  if (existing) {
    return { itemId: existing.id, sourceId: existing.source_id, replayed: true };
  }

  const occurredAt = payload.occurredAt ?? new Date().toISOString();
  const title = payload.title ?? `Reunión ${new Date(occurredAt).toLocaleString("es")}`;

  const { data: source, error: sourceError } = await ctx.db
    .from("sources")
    .insert({
      workspace_id: ctx.workspaceId,
      client_id: clientId,
      source_type: "meeting",
      title,
      content_text: payload.transcript,
      occurred_at: occurredAt,
      external_provider: "macwhisper",
      external_id: payload.externalId ?? null,
      content_hash: contentHash,
      metadata: {
        ...payload.metadata,
        connectionId: connection.id,
        connectionName: connection.name,
        participants: payload.participants,
        durationSeconds: payload.durationSeconds ?? null,
        language: payload.language ?? null,
      } as never,
      created_by: null,
    })
    .select("id")
    .single();
  if (sourceError) throw new DomainError("internal", sourceError.message);

  const { data: item, error: itemError } = await ctx.db
    .from("ingestion_items")
    .insert({
      workspace_id: ctx.workspaceId,
      connection_id: connection.id,
      source_id: source.id,
      client_id: clientId,
      status: "received",
      title,
      external_id: payload.externalId ?? null,
      content_hash: contentHash,
      occurred_at: occurredAt,
      duration_seconds: payload.durationSeconds ?? null,
      participants: payload.participants,
      language: payload.language ?? null,
      metadata: payload.metadata as never,
    })
    .select("id")
    .single();
  if (itemError) throw new DomainError("internal", itemError.message);

  await ctx.db
    .from("ingestion_connections")
    .update({ last_used_at: new Date().toISOString() })
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", connection.id);

  await recordActivity(ctx, {
    eventType: "ingestion_item.received",
    entityType: "ingestion_item",
    entityId: item.id,
    clientId,
    description: `Transcripción recibida desde ${connection.name}`,
    inputSummary: title.slice(0, 200),
    metadata: { characters: payload.transcript.length, provider: "macwhisper" },
  });

  return { itemId: item.id, sourceId: source.id, replayed: false };
}
