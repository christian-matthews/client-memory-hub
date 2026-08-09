import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { domainCtx, run } from "./domain-context";
import {
  getAttentionItems,
  getClientBrief,
  getTopicTimeline,
  listClientContacts,
  listClientDecisions,
  listClientSources,
  listClientTopics,
  listOpenCommitments,
  getClientActivity,
  searchClientMemory,
} from "@/domain/queries/read";

const withWorkspace = z.object({
  workspaceId: z.union([z.string().uuid(), z.undefined()]),
});

export const fetchWorkspaces = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) =>
    run(async () => {
      // Idempotent, race-safe bootstrap of the user's first workspace.
      await context.supabase.rpc("ensure_default_workspace");
      const { data, error } = await context.supabase
        .from("workspace_members")
        .select("workspace_id, role, workspaces(id, name, slug)")
        .order("created_at", { ascending: true });
      if (error) throw error;
      return {
        userId: context.userId,
        email: (context.claims as { email?: string }).email ?? null,
        workspaces: (data ?? []).map((row) => ({
          id: row.workspace_id,
          role: row.role,
          name: row.workspaces?.name ?? "Espacio",
          slug: row.workspaces?.slug ?? "",
        })),
      };
    }),
  );

export const fetchDashboard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    withWorkspace
      .extend({
        filter: z
          .enum(["all", "needs_attention", "waiting_client", "pending_us", "stale"])
          .default("all"),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) =>
    run(async () => {
      const ctx = await domainCtx(context, data.workspaceId);
      const result = await getAttentionItems(ctx, { filter: data.filter });
      return { workspaceId: ctx.workspaceId, role: ctx.role, ...result };
    }),
  );

export const fetchClientPage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    withWorkspace.extend({ clientId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ context, data }) =>
    run(async () => {
      const ctx = await domainCtx(context, data.workspaceId);
      const [brief, contacts, sources, decisions, activity, closed] = await Promise.all([
        getClientBrief(ctx, { clientId: data.clientId }),
        listClientContacts(ctx, { clientId: data.clientId }),
        listClientSources(ctx, { clientId: data.clientId, limit: 8 }),
        listClientDecisions(ctx, { clientId: data.clientId, limit: 8 }),
        getClientActivity(ctx, { clientId: data.clientId, limit: 30 }),
        listClientTopics(ctx, { clientId: data.clientId, includeClosed: true }),
      ]);
      return {
        workspaceId: ctx.workspaceId,
        ...brief,
        contacts: contacts.contacts,
        recentSources: sources.sources,
        recentDecisions: decisions.decisions,
        activity: activity.events,
        allTopics: closed.topics,
      };
    }),
  );

export const fetchTopicPage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    withWorkspace.extend({ topicId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ context, data }) =>
    run(async () => {
      const ctx = await domainCtx(context, data.workspaceId);
      const timeline = await getTopicTimeline(ctx, { topicId: data.topicId });
      const sources = await listClientSources(ctx, {
        clientId: timeline.topic.client_id,
        limit: 20,
      });
      return { workspaceId: ctx.workspaceId, ...timeline, clientSources: sources.sources };
    }),
  );

export const fetchOpenCommitments = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => withWorkspace.parse(input ?? {}))
  .handler(async ({ context, data }) =>
    run(async () => {
      const ctx = await domainCtx(context, data.workspaceId);
      return listOpenCommitments(ctx, {});
    }),
  );

export const searchMemory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    withWorkspace.extend({ query: z.string().trim().min(2).max(200) }).parse(input),
  )
  .handler(async ({ context, data }) =>
    run(async () => {
      const ctx = await domainCtx(context, data.workspaceId);
      return searchClientMemory(ctx, { query: data.query });
    }),
  );

export const fetchWorkspaceSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => withWorkspace.parse(input ?? {}))
  .handler(async ({ context, data }) =>
    run(async () => {
      const ctx = await domainCtx(context, data.workspaceId);
      const [members, integrations, workspace] = await Promise.all([
        ctx.db
          .from("workspace_members")
          .select("user_id, role, created_at")
          .eq("workspace_id", ctx.workspaceId),
        ctx.db
          .from("mcp_integrations")
          .select("id, name, scopes, write_enabled, token_prefix, last_used_at, expires_at, revoked_at, created_at")
          .eq("workspace_id", ctx.workspaceId)
          .order("created_at", { ascending: false }),
        ctx.db.from("workspaces").select("id, name, slug").eq("id", ctx.workspaceId).maybeSingle(),
      ]);
      return {
        workspace: workspace.data,
        role: ctx.role,
        currentUserId: ctx.actor.userId,
        members: members.data ?? [],
        integrations: integrations.data ?? [],
      };
    }),
  );

export const fetchMeetings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => withWorkspace.parse(input ?? {}))
  .handler(async ({ context, data }) =>
    run(async () => {
      const ctx = await domainCtx(context, data.workspaceId);
      const [items, connections, clients, proposals] = await Promise.all([
        ctx.db
          .from("ingestion_items")
          .select(
            "id, connection_id, source_id, client_id, status, title, occurred_at, duration_seconds, participants, language, ai_run_id, proposal_count, error_message, processed_at, created_at",
          )
          .eq("workspace_id", ctx.workspaceId)
          .neq("status", "discarded")
          .order("created_at", { ascending: false })
          .limit(60),
        ctx.db
          .from("ingestion_connections")
          .select(
            "id, name, provider, secret_prefix, default_client_id, enabled, last_used_at, revoked_at, created_at",
          )
          .eq("workspace_id", ctx.workspaceId)
          .order("created_at", { ascending: false }),
        ctx.db
          .from("clients")
          .select("id, name")
          .eq("workspace_id", ctx.workspaceId)
          .is("archived_at", null)
          .order("name", { ascending: true }),
        ctx.db
          .from("ai_proposals")
          .select(
            "id, ai_run_id, client_id, topic_id, proposal_type, proposed_changes, explanation, confidence, status, created_at",
          )
          .eq("workspace_id", ctx.workspaceId)
          .order("created_at", { ascending: false })
          .limit(300),
      ]);

      const topicIds = [
        ...new Set((proposals.data ?? []).map((p) => p.topic_id).filter((v): v is string => !!v)),
      ];
      const topics = topicIds.length
        ? await ctx.db
            .from("topics")
            .select("id, title")
            .eq("workspace_id", ctx.workspaceId)
            .in("id", topicIds)
        : { data: [] as { id: string; title: string }[] };

      return {
        workspaceId: ctx.workspaceId,
        role: ctx.role,
        items: items.data ?? [],
        connections: connections.data ?? [],
        clients: clients.data ?? [],
        proposals: proposals.data ?? [],
        topicTitles: Object.fromEntries((topics.data ?? []).map((t) => [t.id, t.title])),
      };
    }),
  );
