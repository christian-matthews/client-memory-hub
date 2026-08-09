import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { createDomainContext, type DomainContext } from "@/domain/shared/context";
import { normalizeError } from "@/domain/shared/errors";
import type { Db } from "@/domain/shared/context";

export interface AuthedContext {
  supabase: Db;
  userId: string;
  claims: Record<string, unknown> & { email?: string };
}

/** Builds a verified DomainContext from the request's bearer token. */
export async function domainCtx(
  context: { supabase: unknown; userId: string; claims?: Record<string, unknown> },
  workspaceId?: string | null,
): Promise<DomainContext> {
  const claims = context.claims ?? {};
  return createDomainContext({
    db: context.supabase as Db,
    workspaceId: workspaceId ?? null,
    actor: {
      type: "user",
      userId: context.userId,
      name: typeof claims['email'] === "string" ? (claims['email'] as string) : null,
      channel: "web",
    },
  });
}

export type Ok<T> = { ok: true; data: T };
export type Err = { ok: false; error: { code: string; message: string } };
export type Result<T> = Ok<T> | Err;

/** Uniform structured response for every interface. */
export async function run<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    const normalized = normalizeError(error);
    if (normalized.code === "internal") console.error(error);
    return { ok: false, error: normalized };
  }
}

export { createServerFn, requireSupabaseAuth };
