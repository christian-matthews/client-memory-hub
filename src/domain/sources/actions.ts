import { z } from "zod";
import { assertWritable, type DomainContext } from "../shared/context";
import { DomainError, notFound } from "../shared/errors";
import { recordActivity } from "../shared/audit";
import { idempotencyKeySchema, sourceTypeSchema, uuidSchema } from "../shared/vocabulary";

export const sourceRowFields =
  "id, workspace_id, client_id, source_type, external_provider, external_id, title, content_text, occurred_at, metadata, content_hash, created_by, created_at";

/**
 * Sources are immutable evidence. They are never rewritten to reflect a later
 * interpretation — a synthesis is not a source.
 */
export const createSourceInput = z.object({
  clientId: uuidSchema.optional().nullable(),
  sourceType: sourceTypeSchema.default("manual_note"),
  title: z.string().trim().max(300).optional().nullable(),
  contentText: z.string().trim().min(1).max(20000),
  occurredAt: z.string().datetime({ offset: true }).optional().nullable(),
  externalProvider: z.string().trim().max(60).optional().nullable(),
  externalId: z.string().trim().max(200).optional().nullable(),
  metadata: z.record(z.unknown()).default({}),
  idempotencyKey: idempotencyKeySchema,
});

async function createSourceImpl(ctx: DomainContext, raw: unknown) {
  assertWritable(ctx);
  const input = createSourceInput.parse(raw);

  // Deduplicate external evidence by (workspace, provider, external id).
  if (input.externalProvider && input.externalId) {
    const { data: existing, error } = await ctx.db
      .from("sources")
      .select("id")
      .eq("workspace_id", ctx.workspaceId)
      .eq("external_provider", input.externalProvider)
      .eq("external_id", input.externalId)
      .maybeSingle();
    if (error) throw new DomainError("internal", error.message);
    if (existing) return { sourceId: existing.id, replayed: true };
  }

  const { data, error } = await ctx.db
    .from("sources")
    .insert({
      workspace_id: ctx.workspaceId,
      client_id: input.clientId ?? null,
      source_type: input.sourceType,
      title: input.title ?? null,
      content_text: input.contentText,
      occurred_at: input.occurredAt ?? new Date().toISOString(),
      external_provider: input.externalProvider ?? null,
      external_id: input.externalId ?? null,
      metadata: input.metadata as never,
      content_hash: await hashContent(input.contentText),
      created_by: ctx.actor.userId ?? null,
    })
    .select(sourceRowFields)
    .single();
  if (error) throw new DomainError("internal", error.message);

  await recordActivity(ctx, {
    eventType: "source.created",
    entityType: "source",
    entityId: data.id,
    clientId: input.clientId ?? null,
    description: `Fuente registrada (${input.sourceType})`,
    inputSummary: (input.title ?? input.contentText).slice(0, 200),
    idempotencyKey: input.idempotencyKey ?? null,
  });
  return { source: data, sourceId: data.id, replayed: false };
}

export const linkSourceToTopicInput = z.object({
  topicId: uuidSchema,
  sourceId: uuidSchema,
  relevance: z.string().trim().max(300).optional().nullable(),
});

export async function linkSourceToTopic(ctx: DomainContext, raw: unknown) {
  assertWritable(ctx);
  const input = linkSourceToTopicInput.parse(raw);

  const [{ data: topic }, { data: source }] = await Promise.all([
    ctx.db
      .from("topics")
      .select("id, title, client_id")
      .eq("workspace_id", ctx.workspaceId)
      .eq("id", input.topicId)
      .maybeSingle(),
    ctx.db
      .from("sources")
      .select("id")
      .eq("workspace_id", ctx.workspaceId)
      .eq("id", input.sourceId)
      .maybeSingle(),
  ]);
  if (!topic || !source) throw notFound("Tema o fuente no encontrados en este espacio de trabajo");

  const { error } = await ctx.db.from("topic_sources").upsert(
    {
      workspace_id: ctx.workspaceId,
      topic_id: input.topicId,
      source_id: input.sourceId,
      relevance: input.relevance ?? null,
      linked_by: ctx.actor.userId ?? null,
    },
    { onConflict: "topic_id,source_id" },
  );
  if (error) throw new DomainError("internal", error.message);

  await recordActivity(ctx, {
    eventType: "source.linked",
    entityType: "topic_source",
    entityId: input.sourceId,
    clientId: topic.client_id,
    topicId: input.topicId,
    description: `Fuente vinculada a “${topic.title}”`,
  });
  return { linked: true };
}

async function hashContent(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Not part of the transactional idempotent set: deduplication is intrinsic
 * (content hash + provider/external id), so `idempotencyKey` is recorded in the
 * audit trail as a cross-reference only.
 */
export const createSource = createSourceImpl;
