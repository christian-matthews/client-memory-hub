import { describe, expect, it } from "vitest";
import { macwhisperPayloadSchema, PLAIN_TEXT_CAPABILITIES } from "./actions";

/**
 * The webhook contract is the security boundary: the external caller may only
 * send a transcript and an optional title. Everything else — client, workspace,
 * dates, participants, capabilities — is decided by the server.
 */
describe("contrato del webhook MacWhisper", () => {
  it("acepta el cuerpo mínimo", () => {
    const parsed = macwhisperPayloadSchema.parse({ transcript: "Hola equipo" });
    expect(parsed.transcript).toBe("Hola equipo");
  });

  it("acepta un título opcional", () => {
    expect(
      macwhisperPayloadSchema.parse({ title: "Revisión semanal", transcript: "texto" }).title,
    ).toBe("Revisión semanal");
  });

  it("rechaza un cuerpo con campos no permitidos", () => {
    for (const extra of [
      { clientId: "11111111-1111-1111-1111-111111111111" },
      { workspaceId: "11111111-1111-1111-1111-111111111111" },
      { participants: ["Christian"] },
      { occurredAt: "2026-01-01T00:00:00Z" },
      { durationSeconds: 1800 },
      { externalId: "abc" },
      { metadata: { hasAudio: true } },
    ]) {
      expect(() => macwhisperPayloadSchema.parse({ transcript: "texto", ...extra })).toThrow();
    }
  });

  it("rechaza una transcripción vacía o solo espacios", () => {
    expect(() => macwhisperPayloadSchema.parse({ transcript: "" })).toThrow();
    expect(() => macwhisperPayloadSchema.parse({ transcript: "   \n " })).toThrow();
  });

  it("rechaza una transcripción que excede el límite de evidencia", () => {
    expect(() => macwhisperPayloadSchema.parse({ transcript: "a".repeat(200001) })).toThrow();
  });

  it("no preserva texto plano como si tuviera audio o hablantes verificados", () => {
    expect(PLAIN_TEXT_CAPABILITIES).toMatchObject({
      has_audio: false,
      has_timestamps: false,
      speaker_identity_reliable: false,
    });
  });
});
