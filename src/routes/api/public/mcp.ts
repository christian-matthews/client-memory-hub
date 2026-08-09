import { createFileRoute } from "@tanstack/react-router";
import { handleMcpBody } from "@/mcp/handler";

/**
 * MCP endpoint (Streamable HTTP, JSON responses).
 *
 * Lives under /api/public/* because MCP clients are external callers and must
 * not hit the site auth gate. Authentication is enforced here per request with
 * an integration bearer token; the workspace is derived from that credential.
 *
 * Hardening applied per request: body size cap, content-type and accept
 * negotiation, batch size cap, per-token+IP rate limiting, correlation id and
 * conservative security headers. Auth failures are uniform (see handler).
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, content-type, accept, mcp-protocol-version, mcp-session-id",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "600",
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "X-Frame-Options": "DENY",
};

const MAX_BODY_BYTES = 128 * 1024;
const MAX_BATCH = 20;
/** Requests allowed per identity per window. */
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

/**
 * In-memory sliding window. Effective per server instance only — documented as
 * a best-effort limit, not a distributed quota.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

function rateLimited(identity: string): { limited: boolean; retryAfter: number } {
  const now = Date.now();
  const bucket = buckets.get(identity);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(identity, { count: 1, resetAt: now + RATE_WINDOW_MS });
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
    }
    return { limited: false, retryAfter: 0 };
  }
  bucket.count += 1;
  return {
    limited: bucket.count > RATE_LIMIT,
    retryAfter: Math.ceil((bucket.resetAt - now) / 1000),
  };
}

/** Never derived from the token value itself — only from a short digest. */
async function identityOf(request: Request): Promise<string> {
  const ip =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  const token = request.headers.get("authorization") ?? "";
  if (!token) return `ip:${ip}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const short = [...new Uint8Array(digest).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `tok:${short}|ip:${ip}`;
}

function jsonRpcError(code: number, message: string, status: number, correlationId: string) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: {
      ...CORS,
      ...SECURITY_HEADERS,
      "Content-Type": "application/json",
      "X-Correlation-Id": correlationId,
    },
  });
}

export const Route = createFileRoute("/api/public/mcp")({
  server: {
    handlers: {
      OPTIONS: async () =>
        new Response(null, { status: 204, headers: { ...CORS, ...SECURITY_HEADERS } }),
      GET: async () =>
        jsonRpcError(
          -32000,
          "Use POST con JSON-RPC 2.0 (Streamable HTTP, respuestas JSON).",
          405,
          crypto.randomUUID(),
        ),
      POST: async ({ request }) => {
        const correlationId = request.headers.get("x-correlation-id") ?? crypto.randomUUID();

        const contentType = request.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().includes("application/json")) {
          return jsonRpcError(-32600, "Content-Type debe ser application/json", 415, correlationId);
        }
        const accept = (request.headers.get("accept") ?? "*/*").toLowerCase();
        if (
          !accept.includes("application/json") &&
          !accept.includes("*/*") &&
          !accept.includes("text/event-stream")
        ) {
          return jsonRpcError(-32600, "Accept debe incluir application/json", 406, correlationId);
        }

        const declared = Number(request.headers.get("content-length") ?? "0");
        if (declared > MAX_BODY_BYTES) {
          return jsonRpcError(-32600, "Cuerpo demasiado grande", 413, correlationId);
        }

        const raw = await request.text();
        if (raw.length > MAX_BODY_BYTES) {
          return jsonRpcError(-32600, "Cuerpo demasiado grande", 413, correlationId);
        }

        const { limited, retryAfter } = rateLimited(await identityOf(request));
        if (limited) {
          const res = jsonRpcError(-32000, "Demasiadas solicitudes", 429, correlationId);
          res.headers.set("Retry-After", String(retryAfter));
          return res;
        }

        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          return jsonRpcError(-32700, "JSON inválido", 400, correlationId);
        }
        if (Array.isArray(body) && body.length > MAX_BATCH) {
          return jsonRpcError(-32600, `El lote excede ${MAX_BATCH} mensajes`, 413, correlationId);
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const result = await handleMcpBody(body, request.headers.get("authorization"), {
          db: supabaseAdmin as never,
          correlationId,
        });

        const headers = {
          ...CORS,
          ...SECURITY_HEADERS,
          "Content-Type": "application/json",
          "X-Correlation-Id": correlationId,
        };
        if (result === null) return new Response(null, { status: 202, headers });
        return new Response(JSON.stringify(result), { status: 200, headers });
      },
    },
  },
});
