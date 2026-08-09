import { describe, expect, it } from "vitest";
import { buildProposal } from "./meeting-processor";

const CLIENT = "11111111-1111-1111-1111-111111111111";
const SOURCE = "22222222-2222-2222-2222-222222222222";
const TOPIC = "33333333-3333-3333-3333-333333333333";
const base = {
  kind: "topic_update" as const,
  topicId: TOPIC,
  title: "Informe",
  content: "El cliente pide adelantar el informe",
  suggestedStatus: null,
  ballWith: null,
  nextStep: null,
  nextStepOwner: null,
  dueAt: null,
  responsibleParty: null,
  responsibleName: null,
  confidence: 0.9,
  evidence: "cita textual",
};
const ctx = { clientId: CLIENT, sourceId: SOURCE, validTopicIds: new Set([TOPIC]) };

describe("buildProposal", () => {
  it("mapea una actualización a la carga exacta de addTopicUpdate", () => {
    const proposal = buildProposal(base, ctx);
    expect(proposal?.proposalType).toBe("topic_update");
    expect(proposal?.proposedChanges).toMatchObject({
      topicId: TOPIC,
      content: base.content,
      updateType: "note",
      sourceId: SOURCE,
    });
  });

  it("descarta un topicId que no pertenece a los temas abiertos del cliente", () => {
    expect(buildProposal({ ...base, topicId: CLIENT }, ctx)).toBeNull();
  });

  it("no inventa fechas: una fecha no interpretable queda en null", () => {
    const proposal = buildProposal(
      { ...base, kind: "commitment", content: "Enviar borrador", dueAt: "el jueves" },
      ctx,
    );
    expect(proposal?.proposedChanges["dueAt"]).toBeNull();
  });

  it("un tema nuevo no requiere topicId y conserva el cliente", () => {
    const proposal = buildProposal({ ...base, kind: "new_topic", topicId: null }, ctx);
    expect(proposal?.proposalType).toBe("new_topic");
    expect(proposal?.proposedChanges["clientId"]).toBe(CLIENT);
  });

  it("ignora elementos sin contenido en lugar de proponer vacío", () => {
    expect(buildProposal({ ...base, content: "  " }, ctx)).toBeNull();
  });

  it("una decisión referencia la evidencia de origen", () => {
    const proposal = buildProposal({ ...base, kind: "decision" }, ctx);
    expect(proposal?.proposalType).toBe("decision");
    expect(proposal?.proposedChanges["sourceId"]).toBe(SOURCE);
  });
});
