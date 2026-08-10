import { describe, expect, it, vi } from "vitest";
import { createLovableGatewayProvider } from "./gateway";
import { EXTRACTION_SCHEMA } from "./meeting-processor";

/**
 * The gateway must never contact the provider with an empty user turn: an empty
 * prompt is a caller bug, not something to paper over with invented content.
 */
const baseRequest = {
  purpose: "meeting_extraction",
  systemInstructions: "instrucciones",
  structuredInput: {},
  sourceIds: [],
  expectedSchema: EXTRACTION_SCHEMA as unknown as Record<string, unknown>,
  modelConfig: { model: "openai/gpt-5.6-sol", promptVersion: "v-test" },
  workspaceContext: { workspaceId: "11111111-1111-1111-1111-111111111111", clientId: undefined },
};

describe("gateway de IA", () => {
  it("rechaza una petición sin contenido de usuario antes de llamar al proveedor", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const provider = createLovableGatewayProvider("clave-de-prueba");
    await expect(provider.run({ ...baseRequest, userContent: "   " })).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("exige el campo userContent en el contrato", async () => {
    const provider = createLovableGatewayProvider("clave-de-prueba");
    await expect(provider.run(baseRequest as never)).rejects.toThrow();
  });
});
