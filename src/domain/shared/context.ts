import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { forbidden, DomainError } from "./errors";
import type { ActorType, WorkspaceRole } from "./vocabulary";

export type Db = SupabaseClient<Database>;

/** Who is performing an action. Web = user, MCP = user or integration, jobs = system. */
export interface Actor {
  type: ActorType;
  userId?: string | null;
  name?: string | null;
  /** MCP tool name / integration id, for audit only. */
  channel?: string | null;
}

/**
 * Every domain action receives this context. The workspace has already been
 * verified as a workspace the actor belongs to — never trust a client-supplied
 * workspace id without going through `createDomainContext`.
 */
export interface DomainContext {
  db: Db;
  workspaceId: string;
  role: WorkspaceRole;
  actor: Actor;
  correlationId: string;
  /** When false, write actions are rejected (read-only MCP integrations). */
  writeEnabled: boolean;
  /** Set only for MCP integration contexts; binds idempotency keys to the credential. */
  integrationId?: string | null;
}

export function assertWritable(ctx: DomainContext): void {
  if (!ctx.writeEnabled) {
    throw new DomainError("forbidden", "Esta conexión es de solo lectura");
  }
}

export function assertAdmin(ctx: DomainContext): void {
  if (ctx.role !== "owner" && ctx.role !== "admin") {
    throw forbidden("Requiere rol de administrador o propietario");
  }
}

export interface MembershipRow {
  workspace_id: string;
  role: WorkspaceRole;
}

/**
 * Resolves and verifies membership, then builds the context. This is the ONLY
 * sanctioned way to obtain a DomainContext, so the multi-tenant boundary is
 * enforced identically for the web app, MCP and any future API.
 */
export async function createDomainContext(params: {
  db: Db;
  workspaceId?: string | null;
  actor: Actor;
  correlationId?: string;
  writeEnabled?: boolean;
}): Promise<DomainContext> {
  const { db, actor } = params;
  const { data, error } = await db
    .from("workspace_members")
    .select("workspace_id, role")
    .order("created_at", { ascending: true });

  if (error) throw new DomainError("internal", error.message);
  const memberships = (data ?? []) as MembershipRow[];
  if (memberships.length === 0) {
    throw forbidden("El usuario no pertenece a ningún espacio de trabajo");
  }

  const selected = params.workspaceId
    ? memberships.find((m) => m.workspace_id === params.workspaceId)
    : memberships[0];

  if (!selected) throw forbidden();

  return {
    db,
    workspaceId: selected.workspace_id,
    role: selected.role,
    actor,
    correlationId: params.correlationId ?? crypto.randomUUID(),
    writeEnabled: params.writeEnabled ?? true,
  };
}

/**
 * Context for an authenticated MCP integration. The workspace is resolved from
 * the integration credential (never from an agent-supplied argument) and every
 * domain query filters on `ctx.workspaceId`, so a tool can only ever see the
 * workspace its token belongs to.
 */
export function createIntegrationContext(params: {
  db: Db;
  workspaceId: string;
  integrationId: string;
  integrationName: string;
  writeEnabled: boolean;
  correlationId?: string;
}): DomainContext {
  return {
    db: params.db,
    workspaceId: params.workspaceId,
    // Integrations act with member-level authority: no membership or billing
    // administration, no AI proposal review.
    role: "member",
    actor: {
      type: "integration",
      userId: null,
      name: params.integrationName,
      channel: "mcp",
    },
    correlationId: params.correlationId ?? crypto.randomUUID(),
    writeEnabled: params.writeEnabled,
    integrationId: params.integrationId,
  };
}
