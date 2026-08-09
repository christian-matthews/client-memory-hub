import { isOpenTopicStatus, type TopicStatus, type ResponsibleParty, type Party } from "../shared/vocabulary";

/**
 * Deterministic attention rules. No AI, no heuristics, no hidden state.
 * Pure functions so they are unit-testable and identical for web + MCP.
 */

export const STALE_DAYS = 7;

export interface AttentionTopicInput {
  id: string;
  title: string;
  status: TopicStatus;
  next_step: string | null;
  next_step_owner: Party;
  next_step_due_at: string | null;
  last_relevant_change_at: string | null;
  created_at: string;
}

export interface AttentionCommitmentInput {
  id: string;
  description: string;
  responsible_party: ResponsibleParty;
  status: "open" | "completed" | "cancelled" | "overdue";
  due_at: string | null;
}

export type AttentionReasonCode =
  | "topic_pending_us"
  | "topic_blocked"
  | "our_commitment_overdue"
  | "our_next_step_overdue"
  | "topic_without_next_step"
  | "topic_stale";

export interface AttentionReason {
  code: AttentionReasonCode;
  /** Human, concrete reason in Spanish — never just a colour. */
  message: string;
  topicId?: string;
  commitmentId?: string;
  severity: "high" | "medium";
}

const REASON_SEVERITY: Record<AttentionReasonCode, "high" | "medium"> = {
  topic_pending_us: "medium",
  topic_blocked: "high",
  our_commitment_overdue: "high",
  our_next_step_overdue: "high",
  topic_without_next_step: "medium",
  topic_stale: "medium",
};

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

export function daysWithoutRelevantMovement(
  topic: Pick<AttentionTopicInput, "last_relevant_change_at" | "created_at">,
  now: Date,
): number {
  const reference = topic.last_relevant_change_at ?? topic.created_at;
  return daysBetween(new Date(reference), now);
}

/**
 * A client requires attention when at least one deterministic rule fires.
 * Reasons are ordered by severity so the UI can show the most urgent first.
 */
export function evaluateAttention(input: {
  topics: AttentionTopicInput[];
  commitments: AttentionCommitmentInput[];
  now?: Date;
}): AttentionReason[] {
  const now = input.now ?? new Date();
  const reasons: AttentionReason[] = [];

  for (const topic of input.topics) {
    if (!isOpenTopicStatus(topic.status)) continue;

    if (topic.status === "pending_us") {
      reasons.push(reason("topic_pending_us", `Tema pendiente nuestro: “${topic.title}”`, topic.id));
    }
    if (topic.status === "blocked") {
      reasons.push(reason("topic_blocked", `Tema bloqueado: “${topic.title}”`, topic.id));
    }
    if (!topic.next_step || topic.next_step.trim() === "") {
      reasons.push(
        reason("topic_without_next_step", `Sin próximo paso definido: “${topic.title}”`, topic.id),
      );
    }
    if (
      topic.next_step_owner === "us" &&
      topic.next_step_due_at &&
      new Date(topic.next_step_due_at).getTime() < now.getTime()
    ) {
      reasons.push(
        reason("our_next_step_overdue", `Próximo paso nuestro vencido: “${topic.title}”`, topic.id),
      );
    }
    const stale = daysWithoutRelevantMovement(topic, now);
    if (stale >= STALE_DAYS) {
      reasons.push(
        reason("topic_stale", `Sin movimiento relevante hace ${stale} días: “${topic.title}”`, topic.id),
      );
    }
  }

  for (const commitment of input.commitments) {
    if (commitment.status !== "open" && commitment.status !== "overdue") continue;
    if (commitment.responsible_party !== "us") continue;
    if (!commitment.due_at) continue;
    if (new Date(commitment.due_at).getTime() < now.getTime()) {
      reasons.push({
        code: "our_commitment_overdue",
        message: `Compromiso nuestro vencido: “${commitment.description}”`,
        commitmentId: commitment.id,
        severity: REASON_SEVERITY.our_commitment_overdue,
      });
    }
  }

  return reasons.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "high" ? -1 : 1));
}

function reason(code: AttentionReasonCode, message: string, topicId: string): AttentionReason {
  return { code, message, topicId, severity: REASON_SEVERITY[code] };
}

export function requiresAttention(reasons: AttentionReason[]): boolean {
  return reasons.length > 0;
}

/** Derived (never AI-generated) health, used only when no human override exists. */
export function derivedHealth(reasons: AttentionReason[]): "good" | "attention" | "risk" {
  if (reasons.some((r) => r.severity === "high")) return "risk";
  if (reasons.length > 0) return "attention";
  return "good";
}
