import { z } from "zod";

/**
 * Domain vocabulary. These mirror the database enums exactly and are the single
 * source of truth for validation across web, MCP and future HTTP interfaces.
 */

export const workspaceRoleSchema = z.enum(["owner", "admin", "member"]);
export const relationshipStatusSchema = z.enum(["active", "paused", "archived"]);
export const clientHealthSchema = z.enum(["good", "attention", "risk", "unknown"]);
export const topicStatusSchema = z.enum([
  "active",
  "waiting_client",
  "pending_us",
  "blocked",
  "monitoring",
  "resolved",
  "archived",
]);
export const prioritySchema = z.enum(["high", "medium", "low"]);
export const partySchema = z.enum(["us", "client", "third_party", "nobody"]);
export const responsiblePartySchema = z.enum(["us", "client", "third_party"]);
export const commitmentStatusSchema = z.enum(["open", "completed", "cancelled", "overdue"]);
export const updateTypeSchema = z.enum(["note", "fact", "decision", "status_change", "milestone"]);
export const sourceTypeSchema = z.enum([
  "manual_note",
  "email",
  "meeting",
  "document",
  "api",
  "other",
]);
export const actorTypeSchema = z.enum(["user", "ai", "system", "integration"]);

export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;
export type TopicStatus = z.infer<typeof topicStatusSchema>;
export type Party = z.infer<typeof partySchema>;
export type ResponsibleParty = z.infer<typeof responsiblePartySchema>;
export type CommitmentStatus = z.infer<typeof commitmentStatusSchema>;
export type ClientHealth = z.infer<typeof clientHealthSchema>;
export type ActorType = z.infer<typeof actorTypeSchema>;

export const uuidSchema = z.string().uuid();
export const idempotencyKeySchema = z.string().min(8).max(200).optional();
export const isoDateSchema = z.string().datetime({ offset: true });

/** Topic statuses that count as "open" memory. */
export const OPEN_TOPIC_STATUSES: readonly TopicStatus[] = [
  "active",
  "waiting_client",
  "pending_us",
  "blocked",
  "monitoring",
];

export const CLOSED_TOPIC_STATUSES: readonly TopicStatus[] = ["resolved", "archived"];

export function isOpenTopicStatus(status: TopicStatus): boolean {
  return OPEN_TOPIC_STATUSES.includes(status);
}

/** Spanish labels used by every UI surface. */
export const TOPIC_STATUS_LABEL: Record<TopicStatus, string> = {
  active: "Activo",
  waiting_client: "Esperando al cliente",
  pending_us: "Pendiente nuestro",
  blocked: "Bloqueado",
  monitoring: "En observación",
  resolved: "Resuelto",
  archived: "Archivado",
};

export const PARTY_LABEL: Record<Party, string> = {
  us: "Nosotros",
  client: "Cliente",
  third_party: "Tercero",
  nobody: "Nadie",
};

export const HEALTH_LABEL: Record<ClientHealth, string> = {
  good: "Sana",
  attention: "Atención",
  risk: "Riesgo",
  unknown: "Sin datos",
};

export const PRIORITY_LABEL: Record<z.infer<typeof prioritySchema>, string> = {
  high: "Alta",
  medium: "Media",
  low: "Baja",
};

export const UPDATE_TYPE_LABEL: Record<z.infer<typeof updateTypeSchema>, string> = {
  note: "Nota",
  fact: "Hecho",
  decision: "Decisión",
  status_change: "Cambio de estado",
  milestone: "Hito",
};

export const SOURCE_TYPE_LABEL: Record<z.infer<typeof sourceTypeSchema>, string> = {
  manual_note: "Nota manual",
  email: "Correo",
  meeting: "Reunión",
  document: "Documento",
  api: "API",
  other: "Otra",
};

export const COMMITMENT_STATUS_LABEL: Record<CommitmentStatus, string> = {
  open: "Abierto",
  completed: "Cumplido",
  cancelled: "Cancelado",
  overdue: "Vencido",
};

/**
 * Ingestion pipeline (transcripts arriving from external capture apps).
 * The flow is explicit: received → needs_client → ready → processing →
 * needs_review → processed, with `failed` and `discarded` as terminal states.
 */
export const ingestionStatusSchema = z.enum([
  "received",
  "needs_client",
  "ready",
  "processing",
  "needs_review",
  "processed",
  "failed",
  "discarded",
]);
export type IngestionStatus = z.infer<typeof ingestionStatusSchema>;

export const INGESTION_STATUS_LABEL: Record<IngestionStatus, string> = {
  received: "Recibida",
  needs_client: "Falta cliente",
  ready: "Lista para analizar",
  processing: "Procesando",
  needs_review: "Propuestas por revisar",
  processed: "Procesada",
  failed: "Falló",
  discarded: "Descartada",
};

/** Safe, non-leaking explanations for the persisted failure codes. */
export const INGESTION_ERROR_LABEL: Record<string, string> = {
  ai_run_failed: "El análisis de IA no se completó. Puedes reintentarlo.",
  conflict: "El proveedor de IA está saturado o alcanzó su límite. Reinténtalo en unos minutos.",
  invalid_input: "La reunión no cumple los requisitos para analizarse.",
  forbidden: "Sin créditos o permisos de IA disponibles.",
  not_found: "Falta información asociada a la reunión.",
};


/** Proposal kinds the review flow knows how to apply through domain actions. */
export const proposalTypeSchema = z.enum([
  "topic_update",
  "topic_next_step",
  "new_topic",
  "commitment",
  "decision",
]);
export type ProposalType = z.infer<typeof proposalTypeSchema>;

export const PROPOSAL_TYPE_LABEL: Record<ProposalType, string> = {
  topic_update: "Actualización de tema",
  topic_next_step: "Próximo paso",
  new_topic: "Tema nuevo",
  commitment: "Compromiso",
  decision: "Decisión",
};

export const AI_PROPOSAL_STATUS_LABEL: Record<string, string> = {
  pending: "Pendiente",
  approved: "Aprobada",
  rejected: "Rechazada",
  applied: "Aplicada",
  expired: "Expirada",
};
