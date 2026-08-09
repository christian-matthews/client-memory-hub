import { z } from "zod";
import { assertWritable, type DomainContext } from "../shared/context";
import { DomainError, notFound } from "../shared/errors";
import { recordActivity } from "../shared/audit";
import { domainWrite } from "../shared/write";
import {
  clientHealthSchema,
  relationshipStatusSchema,
  idempotencyKeySchema,
  uuidSchema,
} from "../shared/vocabulary";

export const createClientInput = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).optional().nullable(),
  ownerUserId: uuidSchema.optional().nullable(),
  currentSummary: z.string().trim().max(4000).optional().nullable(),
  idempotencyKey: idempotencyKeySchema,
});
export type CreateClientInput = z.infer<typeof createClientInput>;

export const updateClientInput = z.object({
  clientId: uuidSchema,
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  currentSummary: z.string().trim().max(4000).nullable().optional(),
  health: clientHealthSchema.optional(),
  relationshipStatus: relationshipStatusSchema.optional(),
  ownerUserId: uuidSchema.nullable().optional(),
});

export const clientRowFields =
  "id, workspace_id, name, description, relationship_status, owner_user_id, health, current_summary, last_relevant_activity_at, created_at, updated_at, archived_at";

async function fetchClient(ctx: DomainContext, clientId: string) {
  const { data, error } = await ctx.db
    .from("clients")
    .select(clientRowFields)
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", clientId)
    .maybeSingle();
  if (error) throw new DomainError("internal", error.message);
  if (!data) throw notFound("Cliente no encontrado en este espacio de trabajo");
  return data;
}

/**
 * One PostgreSQL transaction: idempotency reservation + insert + audit.
 * The actor is derived server-side; it can never be supplied by the caller.
 */
export async function createClient(ctx: DomainContext, raw: unknown) {
  const input = createClientInput.parse(raw);
  const { clientId, replayed } = await domainWrite<{ clientId: string }>(
    ctx,
    "create_client",
    {
      name: input.name,
      description: input.description ?? null,
      ownerUserId: input.ownerUserId ?? null,
      currentSummary: input.currentSummary ?? null,
    },
    input.idempotencyKey ?? null,
  );
  return { client: await fetchClient(ctx, clientId), replayed };
}

export async function updateClient(ctx: DomainContext, raw: unknown) {
  assertWritable(ctx);
  const input = updateClientInput.parse(raw);
  await fetchClient(ctx, input.clientId);

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch['name'] = input.name;
  if (input.description !== undefined) patch['description'] = input.description;
  if (input.currentSummary !== undefined) patch['current_summary'] = input.currentSummary;
  if (input.health !== undefined) patch['health'] = input.health;
  if (input.relationshipStatus !== undefined) patch['relationship_status'] = input.relationshipStatus;
  if (input.ownerUserId !== undefined) patch['owner_user_id'] = input.ownerUserId;
  if (Object.keys(patch).length === 0) return { client: await fetchClient(ctx, input.clientId) };

  const { data, error } = await ctx.db
    .from("clients")
    .update(patch as never)
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", input.clientId)
    .select(clientRowFields)
    .single();
  if (error) throw new DomainError("internal", error.message);

  await recordActivity(ctx, {
    eventType: "client.updated",
    entityType: "client",
    entityId: data.id,
    clientId: data.id,
    description: `Cliente actualizado: ${data.name}`,
    inputSummary: Object.keys(patch).join(", "),
  });
  return { client: data };
}

/** Archiving replaces deletion. Permanent deletion is never exposed. */
export async function archiveClient(ctx: DomainContext, raw: unknown) {
  assertWritable(ctx);
  const { clientId } = z.object({ clientId: uuidSchema }).parse(raw);
  const client = await fetchClient(ctx, clientId);

  const { data, error } = await ctx.db
    .from("clients")
    .update({ relationship_status: "archived", archived_at: new Date().toISOString() })
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", clientId)
    .select(clientRowFields)
    .single();
  if (error) throw new DomainError("internal", error.message);

  await recordActivity(ctx, {
    eventType: "client.archived",
    entityType: "client",
    entityId: clientId,
    clientId,
    description: `Cliente archivado: ${client.name}`,
  });
  return { client: data };
}

export const addClientContactInput = z.object({
  clientId: uuidSchema,
  name: z.string().trim().min(1).max(160),
  email: z.string().trim().email().max(255).optional().nullable(),
  role: z.string().trim().max(120).optional().nullable(),
  isPrimary: z.boolean().default(false),
});

export async function addClientContact(ctx: DomainContext, raw: unknown) {
  assertWritable(ctx);
  const input = addClientContactInput.parse(raw);
  const client = await fetchClient(ctx, input.clientId);

  const { data, error } = await ctx.db
    .from("client_contacts")
    .insert({
      workspace_id: ctx.workspaceId,
      client_id: input.clientId,
      name: input.name,
      email: input.email ?? null,
      role: input.role ?? null,
      is_primary: input.isPrimary,
    })
    .select("id, name, email, role, is_primary, created_at")
    .single();
  if (error) throw new DomainError("internal", error.message);

  await recordActivity(ctx, {
    eventType: "client_contact.created",
    entityType: "client_contact",
    entityId: data.id,
    clientId: input.clientId,
    description: `Contacto agregado a ${client.name}: ${data.name}`,
  });
  return { contact: data };
}
