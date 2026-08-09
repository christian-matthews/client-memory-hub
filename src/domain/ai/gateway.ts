import type { AiProvider, AiRequest, AiResponse, AiUsage } from "./provider";
import { aiRequestSchema } from "./provider";
import { DomainError } from "../shared/errors";

/**
 * Real AI provider: Lovable AI Gateway (OpenAI Responses API).
 *
 * The domain never imports this file directly — it talks to the `AiProvider`
 * contract. Nothing here fabricates output: a failed, incomplete or empty
 * generation is surfaced as an error, never as an invented result.
 *
 * Every call streams (`stream: true`). Reasoning models keep the connection
 * alive with events, which is what survives platform request timeouts; a
 * buffered call on a multi-minute generation is severed and billed anyway.
 */

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/responses";

/** Documented fallback, available on Lovable AI Gateway. Override with AI_MODEL. */
export const DEFAULT_AI_MODEL = "openai/gpt-5.6-sol";
const REQUEST_TIMEOUT_MS = 240_000;

/** Server-only configuration; read at call time (env is injected per request). */
export function resolveAiModel(): string {
  const configured = process.env["AI_MODEL"]?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_AI_MODEL;
}

interface SseEvent {
  type?: string;
  delta?: string;
  response?: {
    output_text?: string;
    status?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_cost?: number;
    };
  };
  error?: { message?: string; code?: string };
}

interface StreamResult {
  text: string;
  completed: boolean;
  usage: AiUsage | null;
}

async function readStreamedText(response: Response): Promise<StreamResult> {
  const body = response.body;
  if (!body) throw new DomainError("internal", "La respuesta de IA no trae contenido");

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let terminal = "";
  let completed = false;
  let usage: AiUsage | null = null;

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
        completed = event.response?.status !== "incomplete";
        terminal = event.response?.output_text ?? terminal;
        const raw = event.response?.usage;
        if (raw) {
          usage = {
            ...(typeof raw.input_tokens === "number" ? { inputTokens: raw.input_tokens } : {}),
            ...(typeof raw.output_tokens === "number" ? { outputTokens: raw.output_tokens } : {}),
            ...(typeof raw.total_cost === "number" ? { costUsd: raw.total_cost } : {}),
          };
        }
      } else if (
        event.type === "error" ||
        event.type === "response.failed" ||
        event.type === "response.incomplete"
      ) {
        throw new DomainError(
          "internal",
          event.error?.message ?? "La generación de IA falló en el proveedor",
        );
      }
    }
  }

  return { text: (text || terminal).trim(), completed, usage };
}

export function createLovableGatewayProvider(apiKey: string, model = resolveAiModel()): AiProvider {
  return {
    name: "lovable-ai-gateway",
    isConfigured: () => Boolean(apiKey),
    async run<T>(rawRequest: AiRequest): Promise<AiResponse<T>> {
      const request = aiRequestSchema.parse(rawRequest);
      const { promptVersion } = request.modelConfig;
      const effectiveModel = request.modelConfig.model || model;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(GATEWAY_URL, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            "Lovable-API-Key": apiKey,
            "X-Lovable-AIG-SDK": "fetch",
          },
          body: JSON.stringify({
            model: effectiveModel,
            stream: true,
            store: false,
            instructions: request.systemInstructions,
            input: [
              {
                role: "user",
                content: [
                  { type: "input_text", text: JSON.stringify(request.structuredInput) },
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
      } catch (error) {
        clearTimeout(timeout);
        if (error instanceof Error && error.name === "AbortError") {
          throw new DomainError("conflict", "La generación de IA excedió el tiempo máximo");
        }
        throw new DomainError("internal", "No se pudo contactar al proveedor de IA");
      }

      try {
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
          // Provider detail stays in server logs only.
          console.error("ai_gateway_error", response.status, detail.slice(0, 500));
          throw new DomainError("internal", `El proveedor de IA respondió ${response.status}`);
        }

        const streamed = await readStreamedText(response);
        if (!streamed.completed) {
          throw new DomainError("internal", "La generación de IA quedó incompleta");
        }
        if (!streamed.text) {
          throw new DomainError("internal", "La IA no devolvió contenido utilizable");
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(streamed.text);
        } catch {
          throw new DomainError("internal", "La IA devolvió una respuesta no interpretable");
        }

        return {
          structuredOutput: parsed as T,
          provider: "lovable-ai-gateway",
          model: effectiveModel,
          promptVersion,
          confidence: null,
          usage: streamed.usage,
          error: null,
        };
      } finally {
        clearTimeout(timeout);
      }
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
