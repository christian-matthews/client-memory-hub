import { createFileRoute } from "@tanstack/react-router";
import {
  authenticateIngestionConnection,
  receiveTranscript,
} from "@/domain/ingestion/actions";
import { normalizeError } from "@/domain/shared/errors";
import type { Db, DomainContext } from "@/domain/shared/context";

/**
 * Transcript ingestion endpoint for the macOS capture app (MacWhisper /
 * Whisper Transcription).
 *
 * Lives under /api/public/* because the caller is an external app that cannot
 * hold a user session. The credential is the (connectionId, secret) pair in the
 * URL — the only shape those apps can send — and the workspace is derived from
 * the stored connection, never from the request body.
 *
 * The endpoint ONLY stores evidence + an inbox item. It never mutates client
 * memory and never triggers AI: a person decides that from the meeting inbox.
 */

const MAX_BODY_BYTES = 512 * 1024;
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "X-Frame-Options": "DENY",
};

const buckets = new Map<string, { count: number; resetAt: number }>();

function rateLimited(identity: string): boolean {
  const now = Date.now();
  const bucket = buckets.get(identity);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(identity, { count: 1, resetAt: now + RATE_WINDOW_MS });
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
    }
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT;
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...SECURITY_HEADERS },
  });
}

/** Uniform failure: never reveals whether the id or the secret was wrong. */
function unauthorized() {
  return json({ ok: false, error: "unauthorized" }, 401);
}

export const Route = createFileRoute("/api/public/ingest/macwhisper/$connectionId/$secret")({
  server: {
    handlers: {
      /**
       * Real credential test. Verifies the exact same (connectionId, secret) pair
       * an inbound POST would use, and stores NOTHING: no evidence, no inbox
       * item, no meeting. 204 = this URL would be accepted; 401 = it would not.
       */
      GET: async ({ request, params }) => {
        const ip =
          request.headers.get("cf-connecting-ip") ??
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
          "unknown";
        if (rateLimited(`probe:${params.connectionId}|${ip}`)) {
          return json({ ok: false, error: "rate_limited" }, 429);
        }
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const auth = await authenticateIngestionConnection(
          supabaseAdmin as unknown as Db,
          params.connectionId,
          params.secret,
        );
        if (!auth.ok) return unauthorized();
        return new Response(null, { status: 204, headers: SECURITY_HEADERS });
      },
      POST: async ({ request, params }) => {
        const ip =
          request.headers.get("cf-connecting-ip") ??
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
          "unknown";
        if (rateLimited(`ingest:${params.connectionId}|${ip}`)) {
          return json({ ok: false, error: "rate_limited" }, 429);
        }

        const contentLength = Number(request.headers.get("content-length") ?? "0");
        if (contentLength > MAX_BODY_BYTES) {
          return json({ ok: false, error: "payload_too_large" }, 413);
        }

        // Single contract: JSON only, exactly { transcript, title? }.
        const contentType = request.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().includes("application/json")) {
          return json({ ok: false, error: "unsupported_media_type" }, 415);
        }

        const rawBody = await request.text();
        if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
          return json({ ok: false, error: "payload_too_large" }, 413);
        }

        let payload: unknown;
        try {
          payload = JSON.parse(rawBody);
        } catch {
          return json({ ok: false, error: "invalid_json" }, 400);
        }


        // Service role: the caller has no session. The lookup is by id + hash
        // only, and everything after this point is scoped to that workspace.
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const auth = await authenticateIngestionConnection(
          supabaseAdmin as unknown as Db,
          params.connectionId,
          params.secret,
        );
        if (!auth.ok) return unauthorized();

        const ctx: DomainContext = {
          db: supabaseAdmin as unknown as Db,
          workspaceId: auth.connection.workspaceId,
          role: "member",
          actor: {
            type: "integration",
            userId: null,
            name: auth.connection.name,
            channel: "macwhisper",
          },
          correlationId: crypto.randomUUID(),
          writeEnabled: true,
        };

        try {
          const result = await receiveTranscript(ctx, auth.connection, payload);
          // 202 = evidence accepted, nothing analysed yet. 200 = known replay.
          return json({ ok: true, replayed: result.replayed }, result.replayed ? 200 : 202);
        } catch (error) {
          const normalized = normalizeError(error);
          if (normalized.code === "internal") console.error(error);
          if (normalized.code === "forbidden") return unauthorized();
          // Public responses never leak database or provider messages.
          const status = normalized.code === "invalid_input" ? 400 : 500;
          return json(
            { ok: false, error: status === 400 ? "invalid_payload" : "internal_error" },
            status,
          );
        }

      },
    },
  },
});
