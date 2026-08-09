/**
 * Structured domain errors. Every interface (web, MCP, future HTTP API) maps
 * these to its own transport representation without leaking internals.
 */
export type DomainErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "invalid_input"
  | "conflict"
  | "internal";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details?: unknown;

  constructor(code: DomainErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export const forbidden = (msg = "No autorizado para este espacio de trabajo") =>
  new DomainError("forbidden", msg);
export const notFound = (msg = "Recurso no encontrado") => new DomainError("not_found", msg);
export const invalidInput = (msg: string, details?: unknown) =>
  new DomainError("invalid_input", msg, details);
export const conflict = (msg: string) => new DomainError("conflict", msg);

/** Normalizes any thrown value into a serializable error payload. */
export function normalizeError(error: unknown): {
  code: DomainErrorCode;
  message: string;
} {
  if (error instanceof DomainError) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: "internal", message: error.message };
  return { code: "internal", message: "Error inesperado" };
}
