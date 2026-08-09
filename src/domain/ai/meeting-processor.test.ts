import { describe, expect, it } from "vitest";
import {
  buildProposal,
  evidenceExists,
  normalizeForComparison,
  renderMeetingSummary,
  type ExtractionItem,
} from "./meeting-processor";

const CLIENT = "11111111-1111-1111-1111-111111111111";
const SOURCE = "22222222-2222-2222-2222-222222222222";
const TOPIC = "33333333-3333-3333-3333-333333333333";

const TRANSCRIPT = `Speaker 1: Necesitamos el informe antes del viernes.
Speaker 2: Te envío el borrador el jueves.`;

const base: ExtractionItem = {
  kind: "topic_update",
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
  evidence: { quote: "Necesitamos el informe antes del viernes.", speakerLabel: "Speaker 1" },
};
const ctx = { clientId: CLIENT, sourceId: SOURCE, validTopicIds: new Set([TOPIC]) };

describe("evidencia", () => {
  it("acepta una cita literal aunque cambie el espaciado", () => {
    expect(evidenceExists("Necesitamos   el informe\nantes del viernes.", TRANSCRIPT)).toBe(true);
  });

  it("rechaza una cita que no está en la transcripción", () => {
    expect(evidenceExists("El cliente aprobó el presupuesto", TRANSCRIPT)).toBe(false);
  });

  it("rechaza citas triviales que harían pasar cualquier cosa", () => {
    expect(evidenceExists("el", TRANSCRIPT)).toBe(false);
  });

  it("normaliza solo espacios y mayúsculas", () => {
    expect(normalizeForComparison(" Hola   MUNDO \n")).toBe("hola mundo");
  });
});

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
    expect(proposal?.evidence.quote).toBe(base.evidence.quote);
    expect(proposal?.evidence.start_seconds).toBeNull();
  });

  it("no inventa responsables: sin dueño no propone siguiente paso", () => {
    const proposal = buildProposal({ ...base, nextStep: "Enviar informe" }, ctx);
    expect(proposal?.proposedChanges["nextStep"]).toBeUndefined();
    expect(proposal?.proposedChanges["nextStepOwner"]).toBeUndefined();
  });

  it("no asume que la pelota es nuestra", () => {
    const proposal = buildProposal(base, ctx);
    expect(proposal?.proposedChanges["ballWith"]).toBeUndefined();
    const nuevo = buildProposal({ ...base, kind: "new_topic", topicId: null }, ctx);
    expect(nuevo?.proposedChanges["ballWith"]).toBe("nobody");
    expect(nuevo?.proposedChanges["nextStepOwner"]).toBe("nobody");
  });

  it("descarta un compromiso sin parte responsable explícita", () => {
    expect(
      buildProposal({ ...base, kind: "commitment", content: "Enviar borrador" }, ctx),
    ).toBeNull();
  });

  it("descarta un topicId que no pertenece a los temas abiertos del cliente", () => {
    expect(buildProposal({ ...base, topicId: CLIENT }, ctx)).toBeNull();
  });

  it("no inventa fechas: una fecha no interpretable queda en null", () => {
    const proposal = buildProposal(
      {
        ...base,
        kind: "commitment",
        content: "Enviar borrador",
        responsibleParty: "us",
        dueAt: "el jueves",
      },
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

describe("renderMeetingSummary", () => {
  it("incluye la advertencia de calidad de la fuente y los temas relacionados", () => {
    const text = renderMeetingSummary(
      {
        executive: "Revisión semanal",
        decisions: [],
        ourCommitments: ["Enviar borrador"],
        clientCommitments: [],
        nextSteps: [],
        risks: [],
        openQuestions: [],
        relatedTopicIds: [TOPIC, "desconocido"],
        proposedNewTopics: [],
      },
      { [TOPIC]: "Informe mensual" },
    );
    expect(text).toContain("Resumen ejecutivo");
    expect(text).toContain("Informe mensual");
    expect(text).not.toContain("desconocido");
    expect(text).toContain("Hablantes no verificados");
  });
});
