import { z } from "zod";
import type { DomainContext } from "../shared/context";
import { DomainError, notFound } from "../shared/errors";
import {
  evaluateAttention,
  derivedHealth,
  daysWithoutRelevantMovement,
  type AttentionReason,
  type AttentionTopicInput,
  type AttentionCommitmentInput,
} from "../attention/rules";
import {
  OPEN_TOPIC_STATUSES,
  uuidSchema,
  topicStatusSchema,
  prioritySchema,
  partySchema,
  type ClientHealth,
  type TopicHealth,
} from "../shared/vocabulary";
import { topicHealth } from "../attention/rules";
import { topicRowFields } from "../topics/actions";
import { commitmentRowFields } from "../commitments/actions";
import { clientRowFields } from "../clients/actions";

/** Structured, deterministic client summary — no AI involved in v1. */
export interface StructuredSummary {
  openTopics: number;
  blockedTopics: number;
  pendingUsTopics: number;
  waitingClientTopics: number;
  ourOpenCommitments: number;
  clientOpenCommitments: number;
  ourOverdueCommitments: number;
  lastRelevantChangeAt: string | null;
  nearestNextStep: {
    topicId: string;
    topicTitle: string;
    nextStep: string;
    owner: string;
    dueAt: string | null;
  } | null;
  daysWithoutMovement: number | null;
}

/** Full topic row as returned by topicRowFields. */
export interface TopicRow extends AttentionTopicInput {
  client_id: string;
  current_state: string;
}

export interface ClientBrief {
  client: Awaited<ReturnType<typeof selectClient>>;
  topics: TopicRow[];
  commitments: AttentionCommitmentInput[];
  attention: AttentionReason[];
  requiresAttention: boolean;
  computedHealth: ClientHealth;
  structuredSummary: StructuredSummary;
}

async function selectClient(ctx: DomainContext, clientId: string) {
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

export async function getClientBrief(ctx: DomainContext, raw: unknown): Promise<ClientBrief> {
  const { clientId } = z.object({ clientId: uuidSchema }).parse(raw);
  const client = await selectClient(ctx, clientId);

  const [topicsRes, commitmentsRes] = await Promise.all([
    ctx.db
      .from("topics")
      .select(topicRowFields)
      .eq("workspace_id", ctx.workspaceId)
      .eq("client_id", clientId)
      .order("created_at", { ascending: false }),
    ctx.db
      .from("commitments")
      .select(commitmentRowFields)
      .eq("workspace_id", ctx.workspaceId)
      .eq("client_id", clientId)
      .order("due_at", { ascending: true, nullsFirst: false }),
  ]);
  if (topicsRes.error) throw new DomainError("internal", topicsRes.error.message);
  if (commitmentsRes.error) throw new DomainError("internal", commitmentsRes.error.message);

  const topics = (topicsRes.data ?? []) as unknown as TopicRow[];
  const commitments = (commitmentsRes.data ?? []) as unknown as AttentionCommitmentInput[];

  const attention = evaluateAttention({ topics, commitments });
  return {
    client,
    topics,
    commitments,
    attention,
    requiresAttention: attention.length > 0,
    computedHealth: derivedHealth(attention),
    structuredSummary: buildStructuredSummary(topics, commitments),
  };
}

export function buildStructuredSummary(
  topics: AttentionTopicInput[],
  commitments: AttentionCommitmentInput[],
  now: Date = new Date(),
): StructuredSummary {
  const open = topics.filter((t) => OPEN_TOPIC_STATUSES.includes(t.status));
  const openCommitments = commitments.filter(
    (c) => c.status === "open" || c.status === "overdue",
  );

  const candidates = open
    .filter((t) => t.next_step && t.next_step.trim() !== "")
    .sort((a, b) => {
      const av = a.next_step_due_at ? new Date(a.next_step_due_at).getTime() : Number.MAX_SAFE_INTEGER;
      const bv = b.next_step_due_at ? new Date(b.next_step_due_at).getTime() : Number.MAX_SAFE_INTEGER;
      return av - bv;
    });
  const nearest = candidates[0];

  const lastChanges = open
    .map((t) => t.last_relevant_change_at)
    .filter((v): v is string => Boolean(v))
    .sort()
    .reverse();

  return {
    openTopics: open.length,
    blockedTopics: open.filter((t) => t.status === "blocked").length,
    pendingUsTopics: open.filter((t) => t.status === "pending_us").length,
    waitingClientTopics: open.filter((t) => t.status === "waiting_client").length,
    ourOpenCommitments: openCommitments.filter((c) => c.responsible_party === "us").length,
    clientOpenCommitments: openCommitments.filter((c) => c.responsible_party === "client").length,
    ourOverdueCommitments: openCommitments.filter(
      (c) => c.responsible_party === "us" && c.due_at && new Date(c.due_at) < now,
    ).length,
    lastRelevantChangeAt: lastChanges[0] ?? null,
    nearestNextStep: nearest
      ? {
          topicId: nearest.id,
          topicTitle: nearest.title,
          nextStep: nearest.next_step as string,
          owner: nearest.next_step_owner,
          dueAt: nearest.next_step_due_at,
        }
      : null,
    daysWithoutMovement:
      open.length === 0
        ? null
        : Math.min(...open.map((t) => daysWithoutRelevantMovement(t, now))),
  };
}

export type AttentionFilter =
  | "all"
  | "needs_attention"
  | "waiting_client"
  | "pending_us"
  | "stale";

/** Powers the main dashboard. One query pass, then deterministic rules. */
export async function getAttentionItems(
  ctx: DomainContext,
  raw?: unknown,
): Promise<{
  items: Array<{
    client: Awaited<ReturnType<typeof selectClient>>;
    attention: AttentionReason[];
    summary: StructuredSummary;
    computedHealth: ClientHealth;
  }>;
}> {
  const { filter } = z
    .object({
      filter: z
        .enum(["all", "needs_attention", "waiting_client", "pending_us", "stale"])
        .default("all"),
    })
    .parse(raw ?? {});

  const [clientsRes, topicsRes, commitmentsRes] = await Promise.all([
    ctx.db
      .from("clients")
      .select(clientRowFields)
      .eq("workspace_id", ctx.workspaceId)
      .neq("relationship_status", "archived")
      .order("name"),
    ctx.db.from("topics").select(topicRowFields).eq("workspace_id", ctx.workspaceId),
    ctx.db.from("commitments").select(commitmentRowFields).eq("workspace_id", ctx.workspaceId),
  ]);
  if (clientsRes.error) throw new DomainError("internal", clientsRes.error.message);
  if (topicsRes.error) throw new DomainError("internal", topicsRes.error.message);
  if (commitmentsRes.error) throw new DomainError("internal", commitmentsRes.error.message);

  const allTopics = (topicsRes.data ?? []) as unknown as TopicRow[];
  const allCommitments = (commitmentsRes.data ?? []) as unknown as Array<
    AttentionCommitmentInput & { client_id: string }
  >;

  const items = (clientsRes.data ?? []).map((client) => {
    const topics = allTopics.filter((t) => t.client_id === client.id);
    const commitments = allCommitments.filter((c) => c.client_id === client.id);
    const attention = evaluateAttention({ topics, commitments });
    return {
      client,
      attention,
      summary: buildStructuredSummary(topics, commitments),
      computedHealth: derivedHealth(attention),
    };
  });

  const filtered = items.filter((item) => {
    switch (filter) {
      case "needs_attention":
        return item.attention.length > 0;
      case "waiting_client":
        return item.summary.waitingClientTopics > 0;
      case "pending_us":
        return item.summary.pendingUsTopics > 0 || item.summary.ourOpenCommitments > 0;
      case "stale":
        return item.attention.some((r) => r.code === "topic_stale");
      default:
        return true;
    }
  });

  // Attention first, then most severe, then least recent movement.
  filtered.sort((a, b) => {
    if (a.attention.length > 0 !== b.attention.length > 0) return a.attention.length > 0 ? -1 : 1;
    const sev = (x: typeof a) => (x.attention.some((r) => r.severity === "high") ? 0 : 1);
    if (sev(a) !== sev(b)) return sev(a) - sev(b);
    return (b.summary.daysWithoutMovement ?? -1) - (a.summary.daysWithoutMovement ?? -1);
  });

  return { items: filtered };
}

export async function getTopicTimeline(ctx: DomainContext, raw: unknown) {
  const { topicId } = z.object({ topicId: uuidSchema }).parse(raw);

  const { data: topic, error: topicError } = await ctx.db
    .from("topics")
    .select(topicRowFields)
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", topicId)
    .maybeSingle();
  if (topicError) throw new DomainError("internal", topicError.message);
  if (!topic) throw notFound("Tema no encontrado en este espacio de trabajo");

  const [updates, decisions, commitments, sourceLinks, proposals] = await Promise.all([
    ctx.db
      .from("topic_updates")
      .select("id, update_type, content, is_relevant, created_by, created_at, source_id")
      .eq("workspace_id", ctx.workspaceId)
      .eq("topic_id", topicId)
      .order("created_at", { ascending: false }),
    ctx.db
      .from("decisions")
      .select("id, description, decided_at, status, source_id")
      .eq("workspace_id", ctx.workspaceId)
      .eq("topic_id", topicId)
      .order("decided_at", { ascending: false }),
    ctx.db
      .from("commitments")
      .select(commitmentRowFields)
      .eq("workspace_id", ctx.workspaceId)
      .eq("topic_id", topicId)
      .order("created_at", { ascending: false }),
    ctx.db
      .from("topic_sources")
      .select(
        "source_id, relevance, created_at, sources!topic_sources_source_id_fkey(id, source_type, title, content_text, occurred_at)",
      )
      .eq("workspace_id", ctx.workspaceId)
      .eq("topic_id", topicId),
    ctx.db
      .from("ai_proposals")
      .select("id, proposal_type, explanation, confidence, status, proposed_changes, created_at")
      .eq("workspace_id", ctx.workspaceId)
      .eq("topic_id", topicId)
      .eq("status", "pending"),
  ]);

  const firstError = [updates, decisions, commitments, sourceLinks, proposals].find((r) => r.error);
  if (firstError?.error) throw new DomainError("internal", firstError.error.message);

  const { data: client } = await ctx.db
    .from("clients")
    .select("id, name")
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", topic.client_id)
    .maybeSingle();

  const updateRows = (updates.data ?? []) as Array<{
    id: string;
    update_type: string;
    content: string;
    is_relevant: boolean;
    created_at: string;
    source_id: string | null;
  }>;
  const decisionRows = (decisions.data ?? []) as Array<{
    id: string;
    description: string;
    decided_at: string;
    source_id: string | null;
  }>;

  // Resolve the origin of every entry so the history reads
  // "date → source → what changed" without extra round trips per row.
  const sourceIds = [
    ...new Set(
      [...updateRows, ...decisionRows]
        .map((r) => r.source_id)
        .filter((v): v is string => Boolean(v)),
    ),
  ];
  const sourceIndex = new Map<string, { id: string; source_type: string; title: string | null }>();
  if (sourceIds.length > 0) {
    const { data: srcs } = await ctx.db
      .from("sources")
      .select("id, source_type, title")
      .eq("workspace_id", ctx.workspaceId)
      .in("id", sourceIds);
    for (const src of srcs ?? []) sourceIndex.set(src.id, src as never);
  }

  const history: TopicHistoryEntry[] = [
    ...updateRows.map((u) => ({
      id: u.id,
      at: u.created_at,
      kind: (u.update_type === "decision" ? "decision" : "update") as TopicHistoryEntry["kind"],
      isMaterial: u.is_relevant,
      text: u.content,
      updateType: u.update_type,
      source: u.source_id ? (sourceIndex.get(u.source_id) ?? null) : null,
    })),
    ...decisionRows.map((d) => ({
      id: d.id,
      at: d.decided_at,
      kind: "decision" as const,
      isMaterial: true,
      text: d.description,
      updateType: "decision",
      source: d.source_id ? (sourceIndex.get(d.source_id) ?? null) : null,
    })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1));

  const lastMaterial = history.find((h) => h.isMaterial) ?? null;

  return {
    topic,
    client,
    history,
    lastMaterial,
    health: topicHealth(
      topic as unknown as AttentionTopicInput,
      (commitments.data ?? []) as unknown as AttentionCommitmentInput[],
    ),
    updates: updates.data ?? [],
    decisions: decisions.data ?? [],
    commitments: commitments.data ?? [],
    sources: sourceLinks.data ?? [],
    pendingProposals: proposals.data ?? [],
  };
}

export async function listOpenCommitments(ctx: DomainContext, raw?: unknown) {
  const { clientId, responsibleParty } = z
    .object({
      clientId: uuidSchema.optional(),
      responsibleParty: z.enum(["us", "client", "third_party"]).optional(),
    })
    .parse(raw ?? {});

  let query = ctx.db
    .from("commitments")
    .select(
      `${commitmentRowFields}, topics!commitments_topic_id_fkey(title), clients!commitments_client_id_fkey(name)`,
    )
    .eq("workspace_id", ctx.workspaceId)
    .in("status", ["open", "overdue"])
    .order("due_at", { ascending: true, nullsFirst: false });
  if (clientId) query = query.eq("client_id", clientId);
  if (responsibleParty) query = query.eq("responsible_party", responsibleParty);

  const { data, error } = await query;
  if (error) throw new DomainError("internal", error.message);
  return { commitments: data ?? [] };
}

/** Text search across the workspace memory: topics, updates, decisions, sources. */
export async function searchClientMemory(ctx: DomainContext, raw: unknown) {
  const { query, clientId, limit } = z
    .object({
      query: z.string().trim().min(2).max(200),
      clientId: uuidSchema.optional(),
      limit: z.number().int().min(1).max(50).default(20),
    })
    .parse(raw);

  const pattern = `%${query.replace(/[%_]/g, "")}%`;
  const scope = <T extends { eq: (k: string, v: string) => T }>(q: T) =>
    clientId ? q.eq("client_id", clientId) : q;

  const [topics, updates, decisions, sources] = await Promise.all([
    scope(
      ctx.db
        .from("topics")
        .select("id, client_id, title, current_state, status, created_at")
        .eq("workspace_id", ctx.workspaceId),
    )
      .or(`title.ilike.${pattern},current_state.ilike.${pattern},description.ilike.${pattern}`)
      .limit(limit),
    scope(
      ctx.db
        .from("topic_updates")
        .select("id, client_id, topic_id, content, update_type, created_at")
        .eq("workspace_id", ctx.workspaceId),
    )
      .ilike("content", pattern)
      .limit(limit),
    scope(
      ctx.db
        .from("decisions")
        .select("id, client_id, topic_id, description, decided_at")
        .eq("workspace_id", ctx.workspaceId),
    )
      .ilike("description", pattern)
      .limit(limit),
    scope(
      ctx.db
        .from("sources")
        .select("id, client_id, source_type, title, content_text, occurred_at")
        .eq("workspace_id", ctx.workspaceId),
    )
      .or(`title.ilike.${pattern},content_text.ilike.${pattern}`)
      .limit(limit),
  ]);

  return {
    query,
    topics: topics.data ?? [],
    updates: updates.data ?? [],
    decisions: decisions.data ?? [],
    sources: sources.data ?? [],
  };
}

export async function getClientActivity(ctx: DomainContext, raw: unknown) {
  const { clientId, limit } = z
    .object({ clientId: uuidSchema.optional(), limit: z.number().int().min(1).max(200).default(50) })
    .parse(raw ?? {});

  let query = ctx.db
    .from("activity_events")
    .select(
      "id, actor_type, actor_name, event_type, entity_type, description, created_at, correlation_id",
    )
    .eq("workspace_id", ctx.workspaceId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (clientId) query = query.eq("client_id", clientId);

  const { data, error } = await query;
  if (error) throw new DomainError("internal", error.message);
  return { events: data ?? [] };
}

export async function listClients(ctx: DomainContext) {
  const { data, error } = await ctx.db
    .from("clients")
    .select("id, name, relationship_status, health, current_summary, last_relevant_activity_at")
    .eq("workspace_id", ctx.workspaceId)
    .order("name");
  if (error) throw new DomainError("internal", error.message);
  return { clients: data ?? [] };
}

export async function listClientTopics(ctx: DomainContext, raw: unknown) {
  const { clientId, includeClosed } = z
    .object({ clientId: uuidSchema, includeClosed: z.boolean().default(false) })
    .parse(raw);

  let query = ctx.db
    .from("topics")
    .select(topicRowFields)
    .eq("workspace_id", ctx.workspaceId)
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });
  if (!includeClosed) query = query.in("status", [...OPEN_TOPIC_STATUSES]);

  const { data, error } = await query;
  if (error) throw new DomainError("internal", error.message);
  return { topics: data ?? [] };
}

export async function listClientContacts(ctx: DomainContext, raw: unknown) {
  const { clientId } = z.object({ clientId: uuidSchema }).parse(raw);
  const { data, error } = await ctx.db
    .from("client_contacts")
    .select("id, name, email, role, is_primary, created_at")
    .eq("workspace_id", ctx.workspaceId)
    .eq("client_id", clientId)
    .is("archived_at", null)
    .order("is_primary", { ascending: false });
  if (error) throw new DomainError("internal", error.message);
  return { contacts: data ?? [] };
}

export async function listClientSources(ctx: DomainContext, raw: unknown) {
  const { clientId, limit } = z
    .object({ clientId: uuidSchema, limit: z.number().int().min(1).max(50).default(10) })
    .parse(raw);
  const { data, error } = await ctx.db
    .from("sources")
    .select("id, source_type, title, content_text, occurred_at, created_at")
    .eq("workspace_id", ctx.workspaceId)
    .eq("client_id", clientId)
    .order("occurred_at", { ascending: false })
    .limit(limit);
  if (error) throw new DomainError("internal", error.message);
  return { sources: data ?? [] };
}

export async function listClientDecisions(ctx: DomainContext, raw: unknown) {
  const { clientId, limit } = z
    .object({ clientId: uuidSchema, limit: z.number().int().min(1).max(50).default(10) })
    .parse(raw);
  const { data, error } = await ctx.db
    .from("decisions")
    .select("id, topic_id, description, decided_at, status")
    .eq("workspace_id", ctx.workspaceId)
    .eq("client_id", clientId)
    .order("decided_at", { ascending: false })
    .limit(limit);
  if (error) throw new DomainError("internal", error.message);
  return { decisions: data ?? [] };
}


export interface TopicHistoryEntry {
  id: string;
  at: string;
  kind: "update" | "decision";
  isMaterial: boolean;
  text: string;
  updateType: string;
  source: { id: string; source_type: string; title: string | null } | null;
}

export interface RadarTopic {
  topic: TopicRow & {
    priority: string;
    owner_name: string | null;
    client_owner_name: string | null;
    blockers: string | null;
  };
  clientId: string;
  clientName: string;
  health: TopicHealth;
  daysWithoutMovement: number;
  ourOpenCommitments: number;
  clientOpenCommitments: number;
  lastMaterial: { text: string; at: string } | null;
  recentActivity: number;
}

export const listWorkspaceTopicsInput = z.object({
  clientId: uuidSchema.optional(),
  status: topicStatusSchema.optional(),
  priority: prioritySchema.optional(),
  nextStepOwner: partySchema.optional(),
  includeClosed: z.boolean().default(false),
  minDaysWithoutMovement: z.number().int().min(0).max(365).optional(),
});

/**
 * Radar: every live topic in the workspace with its derived health and the
 * minimum context needed to understand it without opening it.
 */
export async function listWorkspaceTopics(ctx: DomainContext, raw?: unknown) {
  const input = listWorkspaceTopicsInput.parse(raw ?? {});
  const now = new Date();

  let topicsQuery = ctx.db
    .from("topics")
    .select(topicRowFields)
    .eq("workspace_id", ctx.workspaceId);
  if (!input.includeClosed) topicsQuery = topicsQuery.in("status", [...OPEN_TOPIC_STATUSES]);
  if (input.clientId) topicsQuery = topicsQuery.eq("client_id", input.clientId);
  if (input.status) topicsQuery = topicsQuery.eq("status", input.status);
  if (input.priority) topicsQuery = topicsQuery.eq("priority", input.priority);
  if (input.nextStepOwner) topicsQuery = topicsQuery.eq("next_step_owner", input.nextStepOwner);

  const [topicsRes, clientsRes, commitmentsRes, updatesRes] = await Promise.all([
    topicsQuery.order("last_relevant_change_at", { ascending: true, nullsFirst: true }),
    ctx.db.from("clients").select("id, name").eq("workspace_id", ctx.workspaceId),
    ctx.db
      .from("commitments")
      .select("id, topic_id, description, responsible_party, status, due_at")
      .eq("workspace_id", ctx.workspaceId)
      .in("status", ["open", "overdue"]),
    ctx.db
      .from("topic_updates")
      .select("topic_id, content, created_at, is_relevant")
      .eq("workspace_id", ctx.workspaceId)
      .order("created_at", { ascending: false })
      .limit(1000),
  ]);

  const firstError = [topicsRes, clientsRes, commitmentsRes, updatesRes].find((r) => r.error);
  if (firstError?.error) throw new DomainError("internal", firstError.error.message);

  const clientNames = new Map((clientsRes.data ?? []).map((c) => [c.id, c.name]));
  const commitments = (commitmentsRes.data ?? []) as Array<
    AttentionCommitmentInput & { topic_id: string }
  >;
  const updates = (updatesRes.data ?? []) as Array<{
    topic_id: string;
    content: string;
    created_at: string;
    is_relevant: boolean;
  }>;
  const monthAgo = now.getTime() - 30 * 86_400_000;

  const items: RadarTopic[] = ((topicsRes.data ?? []) as unknown as RadarTopic["topic"][]).map(
    (topic) => {
      const topicCommitments = commitments.filter((c) => c.topic_id === topic.id);
      const topicUpdates = updates.filter((u) => u.topic_id === topic.id);
      const material = topicUpdates.find((u) => u.is_relevant);
      return {
        topic,
        clientId: topic.client_id,
        clientName: clientNames.get(topic.client_id) ?? "Cliente",
        health: topicHealth(topic as unknown as AttentionTopicInput, topicCommitments, now),
        daysWithoutMovement: daysWithoutRelevantMovement(
          topic as unknown as AttentionTopicInput,
          now,
        ),
        ourOpenCommitments: topicCommitments.filter((c) => c.responsible_party === "us").length,
        clientOpenCommitments: topicCommitments.filter((c) => c.responsible_party !== "us").length,
        lastMaterial: material ? { text: material.content, at: material.created_at } : null,
        recentActivity: topicUpdates.filter((u) => new Date(u.created_at).getTime() >= monthAgo)
          .length,
      };
    },
  );

  const filtered =
    input.minDaysWithoutMovement === undefined
      ? items
      : items.filter((i) => i.daysWithoutMovement >= input.minDaysWithoutMovement!);

  return { topics: filtered };
}
