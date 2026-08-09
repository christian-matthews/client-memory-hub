import { describe, expect, it } from "vitest";
import {
  daysWithoutRelevantMovement,
  derivedHealth,
  evaluateAttention,
  requiresAttention,
  STALE_DAYS,
  type AttentionCommitmentInput,
  type AttentionTopicInput,
} from "./rules";

const NOW = new Date("2026-03-10T12:00:00.000Z");

function topic(overrides: Partial<AttentionTopicInput> = {}): AttentionTopicInput {
  return {
    id: "t1",
    title: "Migración de facturación",
    status: "active",
    next_step: "Enviar propuesta",
    next_step_owner: "us",
    next_step_due_at: null,
    last_relevant_change_at: "2026-03-09T12:00:00.000Z",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function commitment(overrides: Partial<AttentionCommitmentInput> = {}): AttentionCommitmentInput {
  return {
    id: "c1",
    description: "Entregar documento de alcance",
    responsible_party: "us",
    status: "open",
    due_at: null,
    ...overrides,
  };
}

describe("evaluateAttention", () => {
  it("no marca atención cuando el tema está sano y al día", () => {
    const reasons = evaluateAttention({ topics: [topic()], commitments: [commitment()], now: NOW });
    expect(reasons).toEqual([]);
    expect(requiresAttention(reasons)).toBe(false);
    expect(derivedHealth(reasons)).toBe("good");
  });

  it("ignora temas cerrados", () => {
    const reasons = evaluateAttention({
      topics: [
        topic({ status: "resolved", next_step: null, last_relevant_change_at: "2025-01-01T00:00:00.000Z" }),
        topic({ id: "t2", status: "archived", next_step: null }),
      ],
      commitments: [],
      now: NOW,
    });
    expect(reasons).toEqual([]);
  });

  it("marca tema pendiente nuestro", () => {
    const reasons = evaluateAttention({ topics: [topic({ status: "pending_us" })], commitments: [], now: NOW });
    expect(reasons.map((r) => r.code)).toEqual(["topic_pending_us"]);
    expect(derivedHealth(reasons)).toBe("attention");
  });

  it("marca tema bloqueado como riesgo alto", () => {
    const reasons = evaluateAttention({ topics: [topic({ status: "blocked" })], commitments: [], now: NOW });
    expect(reasons[0]?.code).toBe("topic_blocked");
    expect(reasons[0]?.severity).toBe("high");
    expect(derivedHealth(reasons)).toBe("risk");
  });

  it("marca tema sin próximo paso, incluso si es cadena vacía", () => {
    for (const value of [null, "", "   "]) {
      const reasons = evaluateAttention({
        topics: [topic({ next_step: value })],
        commitments: [],
        now: NOW,
      });
      expect(reasons.map((r) => r.code)).toContain("topic_without_next_step");
    }
  });

  it("marca próximo paso nuestro vencido pero no el del cliente", () => {
    const overdue = { next_step_due_at: "2026-03-01T00:00:00.000Z" };
    const ours = evaluateAttention({
      topics: [topic({ ...overdue, next_step_owner: "us" })],
      commitments: [],
      now: NOW,
    });
    expect(ours.map((r) => r.code)).toContain("our_next_step_overdue");

    const theirs = evaluateAttention({
      topics: [topic({ ...overdue, next_step_owner: "client" })],
      commitments: [],
      now: NOW,
    });
    expect(theirs.map((r) => r.code)).not.toContain("our_next_step_overdue");
  });

  it("marca estancamiento exactamente en el umbral y no antes", () => {
    const atThreshold = new Date(NOW.getTime() - STALE_DAYS * 86_400_000).toISOString();
    const justBefore = new Date(NOW.getTime() - (STALE_DAYS - 1) * 86_400_000).toISOString();

    expect(
      evaluateAttention({
        topics: [topic({ last_relevant_change_at: atThreshold })],
        commitments: [],
        now: NOW,
      }).map((r) => r.code),
    ).toContain("topic_stale");

    expect(
      evaluateAttention({
        topics: [topic({ last_relevant_change_at: justBefore })],
        commitments: [],
        now: NOW,
      }).map((r) => r.code),
    ).not.toContain("topic_stale");
  });

  it("usa created_at cuando no hay movimiento relevante registrado", () => {
    expect(
      daysWithoutRelevantMovement({ last_relevant_change_at: null, created_at: "2026-03-01T12:00:00.000Z" }, NOW),
    ).toBe(9);
  });

  it("marca solo compromisos nuestros, abiertos y vencidos", () => {
    const past = "2026-03-01T00:00:00.000Z";
    const future = "2026-04-01T00:00:00.000Z";
    const cases: Array<[AttentionCommitmentInput, boolean]> = [
      [commitment({ due_at: past }), true],
      [commitment({ due_at: past, status: "overdue" }), true],
      [commitment({ due_at: future }), false],
      [commitment({ due_at: null }), false],
      [commitment({ due_at: past, status: "completed" }), false],
      [commitment({ due_at: past, status: "cancelled" }), false],
      [commitment({ due_at: past, responsible_party: "client" }), false],
      [commitment({ due_at: past, responsible_party: "third_party" }), false],
    ];
    for (const [input, expected] of cases) {
      const reasons = evaluateAttention({ topics: [], commitments: [input], now: NOW });
      expect(reasons.some((r) => r.code === "our_commitment_overdue")).toBe(expected);
    }
  });

  it("ordena las razones de mayor a menor severidad", () => {
    const reasons = evaluateAttention({
      topics: [topic({ status: "pending_us", next_step: null }), topic({ id: "t2", status: "blocked" })],
      commitments: [commitment({ due_at: "2026-03-01T00:00:00.000Z" })],
      now: NOW,
    });
    const severities = reasons.map((r) => r.severity);
    expect(severities.indexOf("medium")).toBeGreaterThan(severities.lastIndexOf("high"));
  });

  it("incluye siempre un mensaje concreto y la entidad afectada", () => {
    const reasons = evaluateAttention({
      topics: [topic({ status: "blocked" })],
      commitments: [commitment({ due_at: "2026-03-01T00:00:00.000Z" })],
      now: NOW,
    });
    for (const r of reasons) {
      expect(r.message.length).toBeGreaterThan(10);
      expect(r.topicId ?? r.commitmentId).toBeTruthy();
    }
  });
});
