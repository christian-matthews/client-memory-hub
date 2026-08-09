import { z } from "zod";
import { assertAdmin, type DomainContext, type Db } from "../shared/context";
import { DomainError, notFound } from "../shared/errors";
import { recordActivity } from "../shared/audit";
import { uuidSchema } from "../shared/vocabulary";

/**
 * MCP integration credentials.
 *
 * The plaintext token exists only in the response of `createIntegration`. The
 * database stores a SHA-256 hash plus a public prefix used for lookup and for
 * display in the UI. Tokens are never logged.
 */

export const MCP_SCOPES = ["read", "write"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

export const integrationRowFields =
  "id, workspace_id, name, scopes, write_enabled, token_prefix, created_by, last_used_at, expires_at, revoked_at, created_at, updated_at";

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const createIntegrationInput = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(MCP_SCOPES)).min(1),
  writeEnabled: z.boolean().default(false),
  expiresInDays: z.number().int().min(1).max(365).optional().nullable(),
});

export async function createIntegration(ctx: DomainContext, raw: unknown) {
  assertAdmin(ctx);
  const input = createIntegrationInput.parse(raw);
  const writeEnabled = input.writeEnabled && input.scopes.includes("write");

  const secret = randomToken();
  const prefix = `cm_${secret.slice(0, 8)}`;
  const token = `${prefix}_${secret.slice(8)}`;
  const tokenHash = await sha256Hex(token);

  const expiresAt = input.expiresInDays
    ? new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString()
    : null;

  const { data, error } = await ctx.db
    .from("mcp_integrations")
    .insert({
      workspace_id: ctx.workspaceId,
      name: input.name,
      scopes: input.scopes,
      write_enabled: writeEnabled,
      token_hash: tokenHash,
      token_prefix: prefix,
      created_by: ctx.actor.userId ?? null,
      expires_at: expiresAt,
    })
    .select(integrationRowFields)
    .single();
  if (error) throw new DomainError("internal", error.message);

  await recordActivity(ctx, {
    eventType: "mcp_integration.created",
    entityType: "mcp_integration",
    entityId: data.id,
    description: `Integración MCP creada: ${input.name} (${input.scopes.join("+")})`,
    inputSummary: prefix,
    metadata: { scopes: input.scopes, writeEnabled },
  });

  // `token` is returned exactly once and never persisted in plaintext.
  return { integration: data, token };
}

export async function revokeIntegration(ctx: DomainContext, raw: unknown) {
  assertAdmin(ctx);
  const { integrationId } = z.object({ integrationId: uuidSchema }).parse(raw);

  const { data, error } = await ctx.db
    .from("mcp_integrations")
    .update({ revoked_at: new Date().toISOString(), write_enabled: false })
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", integrationId)
    .is("revoked_at", null)
    .select(integrationRowFields)
    .maybeSingle();
  if (error) throw new DomainError("internal", error.message);
  if (!data) throw notFound("Integración no encontrada o ya revocada");

  await recordActivity(ctx, {
    eventType: "mcp_integration.revoked",
    entityType: "mcp_integration",
    entityId: data.id,
    description: `Integración MCP revocada: ${data.name}`,
  });
  return { integration: data };
}

export interface AuthenticatedIntegration {
  id: string;
  workspaceId: string;
  name: string;
  scopes: McpScope[];
  writeEnabled: boolean;
}

export type IntegrationAuthFailure =
  | "missing_token"
  | "invalid_token"
  | "revoked_token"
  | "expired_token";

/**
 * Resolves a bearer token to an integration. The workspace comes from this row
 * — never from an argument supplied by the calling agent.
 *
 * Requires a privileged client because the caller has no user session; the
 * lookup is by token hash only and the result is scoped to one workspace.
 */
export async function authenticateIntegration(
  db: Db,
  bearer: string | null | undefined,
): Promise<{ ok: true; integration: AuthenticatedIntegration } | { ok: false; reason: IntegrationAuthFailure }> {
  const token = bearer?.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { ok: false, reason: "missing_token" };

  const tokenHash = await sha256Hex(token);
  const { data, error } = await db
    .from("mcp_integrations")
    .select("id, workspace_id, name, scopes, write_enabled, revoked_at, expires_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (error || !data) return { ok: false, reason: "invalid_token" };
  if (data.revoked_at) return { ok: false, reason: "revoked_token" };
  if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) {
    return { ok: false, reason: "expired_token" };
  }

  await db
    .from("mcp_integrations")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id);

  return {
    ok: true,
    integration: {
      id: data.id,
      workspaceId: data.workspace_id,
      name: data.name,
      scopes: (data.scopes ?? []).filter((s): s is McpScope =>
        (MCP_SCOPES as readonly string[]).includes(s),
      ),
      writeEnabled: data.write_enabled,
    },
  };
}
