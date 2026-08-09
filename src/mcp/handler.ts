import { z } from "zod";
import { createIntegrationContext } from "@/domain/shared/context";
import type { Db } from "@/domain/shared/context";
import { authenticateIntegration } from "@/domain/integrations/actions";
import { recordActivity } from "@/domain/shared/audit";
import { DomainError, normalizeError } from "@/domain/shared/errors";
import { findTool, MCP_TOOLS } from "./tools";

/**
 * Minimal MCP JSON-RPC 2.0 handler over Streamable HTTP.
 *
 * We implement the transport directly instead of using `@lovable.dev/mcp-js`
 * because that package's auth is OAuth 2.1-only: it validates Supabase access
 * tokens of end users. This product needs *per-integration, per-workspace*
 * credentials that an agent can hold long-term, which is what
 * `mcp_integrations` provides. Everything below the transport is the shared
 * domain layer.
 */

const SERVER_INFO = { name: "client-memory", title: "Client Memory", version: "1.0.0" };
const PROTOCOL_VERSION = "2025-06-18";
const INSTRUCTIONS =
  "Memoria operativa por cliente. Usa get_attention_items para saber qué requiere atención, get_client_brief para el estado de un cliente y add_topic_update para registrar avances. Las herramientas de escritura aceptan idempotencyKey.";

export const JSONRPC_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  unauthorized: -32001,
  forbidden: -32002,
} as const;

const requestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}
function fail(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

/** Single, uniform message for every authentication failure. */
const AUTH_MESSAGE = "No autorizado: se requiere un token de integración válido (Authorization: Bearer ...)";

export interface McpHandlerDeps {
  /** Privileged client used ONLY to resolve the credential and run tool queries scoped to its workspace. */
  db: Db;
  /** Per-request correlation id, echoed in logs and in the audit trail. */
  correlationId?: string;
}

/** Per-tool wall clock budget. A stuck tool must not hold the connection open. */
const TOOL_TIMEOUT_MS = 15_000;
/** Hard cap on a single tool result to avoid unbounded responses. */
const MAX_RESULT_BYTES = 256 * 1024;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DomainError("internal", "tool_timeout")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Handles one JSON-RPC message. Returns null for notifications. */
export async function handleMcpMessage(
  raw: unknown,
  bearer: string | null,
  deps: McpHandlerDeps,
): Promise<JsonRpcResponse | null> {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) return fail(null, JSONRPC_ERROR.invalidRequest, "Solicitud JSON-RPC inválida");
  const { method, id = null } = parsed.data;

  // Notifications carry no id and expect no response.
  if (method.startsWith("notifications/")) return null;

  if (method === "initialize") {
    return ok(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS,
    });
  }
  if (method === "ping") return ok(id, {});

  const auth = await authenticateIntegration(deps.db, bearer);
  if (!auth.ok) {
    // Uniform response: an external caller must not be able to tell a
    // non-existent token from a revoked or expired one. The precise reason is
    // logged server-side (never the token itself) and the owner can still see
    // "revocada"/"expirada" in the admin UI.
    console.warn("[mcp] auth_failed", {
      reason: auth.reason,
      correlationId: deps.correlationId ?? null,
    });
    return fail(id, JSONRPC_ERROR.unauthorized, AUTH_MESSAGE);
  }
  const { integration } = auth;
  const canWrite = integration.scopes.includes("write") && integration.writeEnabled;

  if (method === "tools/list") {
    return ok(id, {
      tools: MCP_TOOLS.filter((t) => (t.scope === "write" ? canWrite : integration.scopes.includes("read"))).map(
        (t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.jsonSchema,
          annotations: { readOnlyHint: t.scope === "read" },
        }),
      ),
    });
  }

  if (method !== "tools/call") {
    return fail(id, JSONRPC_ERROR.methodNotFound, `Método no soportado: ${method}`);
  }

  const callParams = z
    .object({ name: z.string(), arguments: z.unknown().optional() })
    .safeParse(parsed.data.params);
  if (!callParams.success) return fail(id, JSONRPC_ERROR.invalidParams, "Parámetros de tools/call inválidos");

  const tool = findTool(callParams.data.name);
  if (!tool) return fail(id, JSONRPC_ERROR.methodNotFound, `Herramienta desconocida: ${callParams.data.name}`);

  if (tool.scope === "read" && !integration.scopes.includes("read")) {
    return fail(id, JSONRPC_ERROR.forbidden, "La integración no tiene scope de lectura");
  }
  if (tool.scope === "write") {
    if (!integration.scopes.includes("write")) {
      return fail(id, JSONRPC_ERROR.forbidden, "La integración no tiene scope de escritura");
    }
    if (!integration.writeEnabled) {
      return fail(id, JSONRPC_ERROR.forbidden, "La integración es de solo lectura (escritura desactivada)");
    }
  }

  const input = tool.inputSchema.safeParse(callParams.data.arguments ?? {});
  if (!input.success) {
    return fail(id, JSONRPC_ERROR.invalidParams, "Argumentos inválidos", {
      issues: input.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  const ctx = createIntegrationContext({
    db: deps.db,
    workspaceId: integration.workspaceId,
    integrationId: integration.id,
    integrationName: integration.name,
    writeEnabled: canWrite,
    ...(deps.correlationId ? { correlationId: deps.correlationId } : {}),
  });

  try {
    const output = await withTimeout(tool.run(ctx, input.data), TOOL_TIMEOUT_MS);
    const text = JSON.stringify(output);
    if (text.length > MAX_RESULT_BYTES) {
      await auditCall(ctx, tool.name, integration.id, "error", "response_too_large");
      return ok(id, {
        content: [
          {
            type: "text",
            text: "bad_request: el resultado excede el tamaño máximo; acota la consulta o usa paginación",
          },
        ],
        isError: true,
      });
    }
    await auditCall(ctx, tool.name, integration.id, "ok", null);
    return ok(id, {
      content: [{ type: "text", text }],
      structuredContent: output as Record<string, unknown>,
      isError: false,
    });
  } catch (error) {
    const normalized = normalizeError(error);
    // Internal failures are logged server-side; the agent gets no internals.
    if (normalized.code === "internal") console.error("[mcp]", tool.name, error);
    const message =
      normalized.code === "internal" ? "Error interno al ejecutar la herramienta" : normalized.message;
    await auditCall(ctx, tool.name, integration.id, "error", normalized.code);
    return ok(id, {
      content: [{ type: "text", text: `${normalized.code}: ${message}` }],
      isError: true,
    });
  }
}

/** Never logs tokens or full payloads — only the tool name and outcome. */
async function auditCall(
  ctx: ReturnType<typeof createIntegrationContext>,
  tool: string,
  integrationId: string,
  outcome: "ok" | "error",
  errorCode: string | null,
) {
  try {
    await recordActivity(ctx, {
      eventType: "mcp.tool_called",
      entityType: "mcp_integration",
      entityId: integrationId,
      description: `MCP ${tool}: ${outcome === "ok" ? "ejecutada" : `error (${errorCode})`}`,
      inputSummary: tool,
      metadata: { tool, outcome, errorCode, transport: "http" },
    });
  } catch {
    // Auditing must never mask the tool result.
  }
}

export async function handleMcpBody(
  body: unknown,
  bearer: string | null,
  deps: McpHandlerDeps,
): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (Array.isArray(body)) {
    const responses = await Promise.all(body.map((msg) => handleMcpMessage(msg, bearer, deps)));
    const filtered = responses.filter((r): r is JsonRpcResponse => r !== null);
    return filtered.length > 0 ? filtered : null;
  }
  return handleMcpMessage(body, bearer, deps);
}
