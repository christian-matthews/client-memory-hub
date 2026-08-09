import { createFileRoute } from "@tanstack/react-router";
import { handleMcpBody } from "@/mcp/handler";

/**
 * MCP endpoint (Streamable HTTP, JSON responses).
 *
 * Lives under /api/public/* because MCP clients are external callers and must
 * not hit the site auth gate. Authentication is enforced here per request with
 * an integration bearer token; the workspace is derived from that credential.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };

export const Route = createFileRoute("/api/public/mcp")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      GET: async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Use POST con JSON-RPC 2.0 (Streamable HTTP)." },
            id: null,
          }),
          { status: 405, headers: JSON_HEADERS },
        ),
      POST: async ({ request }) => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "JSON inválido" }, id: null }),
            { status: 400, headers: JSON_HEADERS },
          );
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const result = await handleMcpBody(body, request.headers.get("authorization"), {
          db: supabaseAdmin as never,
        });

        if (result === null) return new Response(null, { status: 202, headers: CORS });
        return new Response(JSON.stringify(result), { status: 200, headers: JSON_HEADERS });
      },
    },
  },
});
