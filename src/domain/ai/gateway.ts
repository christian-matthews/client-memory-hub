import type { AiProvider, AiRequest, AiResponse } from "./provider";
import { aiRequestSchema } from "./provider";
import { DomainError } from "../shared/errors";

/**
 * Real AI provider: Lovable AI Gateway (OpenAI Responses API).
 *
 * The domain never imports this file directly — it talks to the `AiProvider`
 * contract. Nothing here fabricates output: a failed or empty generation is
 * surfaced as an error, never as an invented result.
 *
 * Every call streams (`stream: true`). Reasoning models keep the connection
 * alive with events, which is what survives platform request timeouts; a
 * buffered call on a multi-minute generation is severed and billed anyway.
 */

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/responses";

interface SseEvent {
  type?: string;
  delta?: string;
  response?: { output_text?: string; status?: string };
  error?: { message?: string; code?: string };
}

async function readStreamedText(response: Response): Promise<string> {
  const body = response.body;
  if (!body) throw new DomainError("internal", "La respuesta de IA no trae contenido");

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let terminal = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let event: SseEvent;
      try {
        event = JSON.parse(payload) as SseEvent;
      } catch {
        continue;
      }
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
        text += event.delta;
      } else if (event.type === "response.completed") {
        terminal = event.response?.output_text ?? terminal;
      } else if (event.type === "error" || event.type === "response.failed") {
        throw new DomainError(
          "internal",
          event.error?.message ?? "La generación de IA falló en el proveedor",
        );
      }
    }
  }

  return (text || terminal).trim();
}

export function createLovableGatewayProvider(apiKey: string): AiProvider {
  return {
    name: "lovable-ai-gateway",
    isConfigured: () => Boolean(apiKey),
    async run<T>(rawRequest: AiRequest): Promise<AiResponse<T>> {
      const request = aiRequestSchema.parse(rawRequest);
      const { model, promptVersion } = request.modelConfig;

      const response = await fetch(GATEWAY_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Lovable-API-Key": apiKey,
          "X-Lovable-AIG-SDK": "fetch",
        },
        body: JSON.stringify({
          model,
          stream: true,
          store: false,
          instructions: request.systemInstructions,
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: JSON.stringify(request.structuredInput),
                },
              ],
            },
          ],
          text: {
            format: {
              type: "json_schema",
              name: "structured_output",
              strict: true,
              schema: request.expectedSchema,
            },
          },
        }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        if (response.status === 429) {
          throw new DomainError(
            "conflict",
            "Límite de uso de IA alcanzado. Inténtalo de nuevo en unos minutos.",
          );
        }
        if (response.status === 402) {
          throw new DomainError(
            "forbidden",
            "Sin créditos de IA disponibles en el espacio de trabajo.",
          );
        }
        throw new DomainError(
          "internal",
          `El proveedor de IA respondió ${response.status}: ${detail.slice(0, 400)}`,
        );
      }

      const text = await readStreamedText(response);
      if (!text) {
        throw new DomainError("internal", "La IA no devolvió contenido utilizable");
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new DomainError("internal", "La IA devolvió una respuesta no interpretable");
      }

      return {
        structuredOutput: parsed as T,
        provider: "lovable-ai-gateway",
        model,
        promptVersion,
        confidence: null,
        usage: null,
        error: null,
      };
    },
  };
}

/** Reads the key at call time (env is injected per request on the server). */
export function resolveAiProvider(): AiProvider {
  const apiKey = process.env["LOVABLE_API_KEY"];
  if (!apiKey) {
    throw new DomainError(
      "invalid_input",
      "La IA no está configurada en este entorno (falta la clave del gateway).",
    );
  }
  return createLovableGatewayProvider(apiKey);
}
