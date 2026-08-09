import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  assignMeetingClientFn,
  discardMeetingFn,
  processMeetingFn,
  reviewProposalFn,
  applyProposalFn,
  editProposalFn,
} from "@/lib/mutations.functions";
import { fetchMeetingDetail } from "@/lib/read.functions";
import { unwrap, useDomainMutation } from "@/lib/use-workspace";
import {
  AI_PROPOSAL_STATUS_LABEL,
  INGESTION_ERROR_LABEL,
  INGESTION_STATUS_LABEL,
  PROPOSAL_TYPE_LABEL,
  type IngestionStatus,
  type ProposalType,
} from "@/domain/shared/vocabulary";

export interface MeetingItem {
  id: string;
  source_id: string | null;
  client_id: string | null;
  status: IngestionStatus;
  title: string | null;
  occurred_at: string | null;
  duration_seconds: number | null;
  participants: string[];
  ai_run_id: string | null;
  proposal_count: number;
  error_code: string | null;
  created_at: string;
}

export interface ProposalItem {
  id: string;
  ai_run_id: string;
  client_id: string | null;
  topic_id: string | null;
  proposal_type: string;
  proposed_changes: unknown;
  explanation: string;
  confidence: number | null;
  status: string;
  evidence?: unknown;
  edited_at?: string | null;
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString("es", { dateStyle: "medium", timeStyle: "short" });
}

function formatDuration(seconds: number | null) {
  if (!seconds) return null;
  return `${Math.round(seconds / 60)} min`;
}

function proposalSummary(changes: unknown): string {
  const c = (changes ?? {}) as Record<string, unknown>;
  const text = c["content"] ?? c["description"] ?? c["title"] ?? c["nextStep"];
  return typeof text === "string" ? text : "—";
}

function evidenceQuote(evidence: unknown): { quote: string; speaker: string | null } | null {
  if (!evidence || typeof evidence !== "object") return null;
  const e = evidence as Record<string, unknown>;
  const quote = typeof e["quote"] === "string" ? e["quote"] : "";
  if (!quote.trim()) return null;
  const speaker = typeof e["speaker_label"] === "string" ? e["speaker_label"] : null;
  return { quote, speaker };
}

const DISCARD_REASON_LABEL: Record<string, string> = {
  evidence_missing: "sin cita textual",
  evidence_not_in_transcript: "la cita no está en la transcripción",
  not_actionable_or_ambiguous: "responsable o tema ambiguo",
  invalid_item_shape: "formato inválido",
};

/** Read-only detail: verbatim transcript + AI derivatives for one meeting. */
function MeetingDetail({ itemId, workspaceId }: { itemId: string; workspaceId?: string }) {
  const call = useServerFn(fetchMeetingDetail);
  const [showTranscript, setShowTranscript] = useState(false);
  const query = useQuery({
    queryKey: ["meeting-detail", workspaceId, itemId],
    queryFn: async () => unwrap(await call({ data: { workspaceId, itemId } })),
  });

  if (query.isPending) return <Skeleton className="h-24 w-full rounded-md" />;
  if (query.error) {
    return <p className="text-xs text-destructive">No se pudo cargar la evidencia.</p>;
  }

  const detail = query.data;
  const transcript = detail?.source?.content_text ?? "";
  const derivative = detail?.derivatives?.[0];
  const meta = (derivative?.metadata ?? {}) as Record<string, unknown>;
  const discarded = Array.isArray(meta["discarded"])
    ? (meta["discarded"] as { reason: string; kind?: string }[])
    : [];

  return (
    <div className="grid gap-3">
      <div className="rounded-md border border-border/60 bg-surface-muted/40 p-3">
        <p className="label-caps">Calidad de la fuente</p>
        <ul className="mt-1 grid gap-0.5 text-xs text-muted-foreground">
          <li>Texto plano enviado por MacWhisper: sin audio ni marcas de tiempo.</li>
          <li>Las etiquetas de hablante no verifican identidades.</li>
          {derivative && (
            <li>
              Resumen generado con {derivative.model} · {derivative.prompt_version} ·{" "}
              {formatDate(derivative.created_at)}
            </li>
          )}
        </ul>
      </div>

      {derivative ? (
        <div className="rounded-md border border-border/60 p-3">
          <p className="label-caps">Resumen de IA (derivado, no reemplaza la evidencia)</p>
          <pre className="mt-1.5 whitespace-pre-wrap font-sans text-xs leading-relaxed">
            {derivative.content_text}
          </pre>
          {discarded.length > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              Descartado por falta de respaldo:{" "}
              {discarded
                .map((d) => DISCARD_REASON_LABEL[d.reason] ?? d.reason)
                .join(", ")}
              .
            </p>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Todavía no hay resumen de IA para esta reunión.
        </p>
      )}

      <div className="rounded-md border border-border/60 p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="label-caps">Transcripción original ({transcript.length} caracteres)</p>
          <Button size="sm" variant="ghost" onClick={() => setShowTranscript((v) => !v)}>
            {showTranscript ? "Ocultar" : "Ver completa"}
          </Button>
        </div>
        {showTranscript && (
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap font-sans text-xs leading-relaxed text-muted-foreground">
            {transcript || "—"}
          </pre>
        )}
      </div>
    </div>
  );
}

export function MeetingInbox({
  items,
  proposals,
  clients,
  topicTitles,
  workspaceId,
  canManage,
}: {
  items: MeetingItem[];
  proposals: ProposalItem[];
  clients: { id: string; name: string }[];
  topicTitles: Record<string, string>;
  workspaceId?: string | undefined;
  canManage: boolean;
}) {
  const invalidate = [["meetings"], ["meeting-detail"], ["dashboard"], ["client"], ["topic"]];
  const assign = useDomainMutation<{ itemId: string; clientId: string }>(
    assignMeetingClientFn as never,
    { workspaceId, successMessage: "Cliente asignado", invalidate },
  );
  const discard = useDomainMutation<{ itemId: string }>(discardMeetingFn as never, {
    workspaceId,
    successMessage: "Reunión descartada",
    invalidate,
  });
  const process = useDomainMutation<{ itemId: string }>(processMeetingFn as never, {
    workspaceId,
    successMessage: "Análisis completado: revisa las propuestas",
    invalidate,
  });
  const review = useDomainMutation<{ proposalId: string; decision: "approved" | "rejected" }>(
    reviewProposalFn as never,
    { workspaceId, successMessage: "Propuesta revisada", invalidate },
  );
  const apply = useDomainMutation<{ proposalId: string }>(applyProposalFn as never, {
    workspaceId,
    successMessage: "Propuesta aplicada a la memoria del cliente",
    invalidate,
  });
  const edit = useDomainMutation<{ proposalId: string; proposedChanges: Record<string, unknown> }>(
    editProposalFn as never,
    { workspaceId, successMessage: "Propuesta corregida", invalidate },
  );

  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  if (items.length === 0) {
    return (
      <p className="panel p-6 text-sm text-muted-foreground">
        Todavía no llegó ninguna transcripción. Crea una conexión y configura el webhook en la app de
        macOS.
      </p>
    );
  }

  return (
    <ul className="grid gap-3">
      {items.map((item) => {
        const itemProposals = item.ai_run_id
          ? proposals.filter((p) => p.ai_run_id === item.ai_run_id)
          : [];
        const pending = itemProposals.filter((p) => p.status === "pending").length;
        const isOpen = expanded === item.id;
        const isProcessing = item.status === "processing";
        const analysed = item.status === "processed" || item.status === "needs_review";
        const canAnalyse = canManage && !isProcessing && Boolean(item.client_id);

        return (
          <li key={item.id} className="panel p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="truncate font-display text-sm font-semibold">
                  {item.title ?? "Reunión sin título"}
                </h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {formatDate(item.occurred_at ?? item.created_at)}
                  {formatDuration(item.duration_seconds)
                    ? ` · ${formatDuration(item.duration_seconds)}`
                    : ""}
                  {item.participants.length > 0 ? ` · ${item.participants.join(", ")}` : ""}
                </p>
                {!item.client_id && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Asigna un cliente para poder analizarla: nada se adivina por ti.
                  </p>
                )}
                {item.error_code && (
                  <p className="mt-1 text-xs text-destructive">
                    {INGESTION_ERROR_LABEL[item.error_code] ??
                      "El análisis falló. Puedes reintentarlo."}
                  </p>
                )}
              </div>
              <span className="label-caps shrink-0">{INGESTION_STATUS_LABEL[item.status]}</span>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select
                value={item.client_id ?? ""}
                disabled={!canManage || analysed || isProcessing || assign.isPending}
                onChange={(event) => {
                  if (!event.target.value) return;
                  assign.mutate({ itemId: item.id, clientId: event.target.value });
                }}
                className="h-8 rounded-md border border-input bg-surface px-2 text-xs"
                aria-label="Cliente de la reunión"
              >
                <option value="">Sin cliente asignado</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>

              {canAnalyse && (
                <Button
                  size="sm"
                  disabled={process.isPending}
                  onClick={() => process.mutate({ itemId: item.id })}
                >
                  {process.isPending
                    ? "Analizando…"
                    : analysed || item.status === "failed"
                      ? "Reanalizar"
                      : "Analizar con IA"}
                </Button>
              )}

              <Button
                size="sm"
                variant="secondary"
                onClick={() => setExpanded(isOpen ? null : item.id)}
              >
                {isOpen
                  ? "Ocultar detalle"
                  : `Ver evidencia${itemProposals.length ? ` y propuestas (${itemProposals.length})` : ""}`}
                {pending > 0 ? ` · ${pending} pendientes` : ""}
              </Button>

              {item.client_id && (
                <Link
                  to="/clients/$clientId"
                  params={{ clientId: item.client_id }}
                  className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                >
                  Ver cliente
                </Link>
              )}

              {canManage && !isProcessing && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={discard.isPending}
                  onClick={() => discard.mutate({ itemId: item.id })}
                >
                  Descartar
                </Button>
              )}
            </div>

            {isOpen && (
              <div className="mt-3 grid gap-3 border-t border-border/60 pt-3">
                <MeetingDetail itemId={item.id} {...(workspaceId ? { workspaceId } : {})} />

                {itemProposals.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Sin propuestas: la IA no encontró elementos respaldados por la transcripción.
                  </p>
                ) : (
                  <ul className="grid gap-2">
                    {itemProposals.map((proposal) => {
                      const evidence = evidenceQuote(proposal.evidence);
                      const isEditing = editing === proposal.id;
                      return (
                        <li key={proposal.id} className="rounded-md border border-border/60 p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="label-caps">
                              {PROPOSAL_TYPE_LABEL[proposal.proposal_type as ProposalType] ??
                                proposal.proposal_type}
                              {proposal.topic_id
                                ? ` · ${topicTitles[proposal.topic_id] ?? "tema"}`
                                : " · tema nuevo"}
                            </span>
                            <span className="text-[11px] text-muted-foreground">
                              {AI_PROPOSAL_STATUS_LABEL[proposal.status] ?? proposal.status}
                              {proposal.confidence !== null
                                ? ` · confianza ${Math.round(proposal.confidence * 100)}%`
                                : ""}
                              {proposal.edited_at ? " · editada" : ""}
                            </span>
                          </div>
                          <p className="mt-1.5 text-sm">
                            {proposalSummary(proposal.proposed_changes)}
                          </p>
                          {evidence ? (
                            <p className="mt-1 text-xs italic text-muted-foreground">
                              “{evidence.quote}”
                              {evidence.speaker ? ` — ${evidence.speaker} (etiqueta sin verificar)` : ""}
                            </p>
                          ) : (
                            <p className="mt-1 text-xs italic text-muted-foreground">
                              {proposal.explanation}
                            </p>
                          )}

                          {isEditing && (
                            <div className="mt-2 grid gap-2">
                              <Textarea
                                value={draft}
                                rows={6}
                                spellCheck={false}
                                onChange={(event) => setDraft(event.target.value)}
                                aria-label="Cambios propuestos"
                                className="font-mono text-xs"
                              />
                              <div className="flex gap-2">
                                <Button
                                  size="sm"
                                  disabled={edit.isPending}
                                  onClick={() => {
                                    try {
                                      const parsed = JSON.parse(draft) as Record<string, unknown>;
                                      edit.mutate({
                                        proposalId: proposal.id,
                                        proposedChanges: parsed,
                                      });
                                      setEditing(null);
                                    } catch {
                                      setDraft(draft);
                                    }
                                  }}
                                >
                                  Guardar corrección
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => setEditing(null)}
                                >
                                  Cancelar
                                </Button>
                              </div>
                            </div>
                          )}

                          {canManage && !isEditing && (
                            <div className="mt-2 flex flex-wrap gap-2">
                              {proposal.status === "pending" && (
                                <>
                                  <Button
                                    size="sm"
                                    disabled={review.isPending}
                                    onClick={() =>
                                      review.mutate({
                                        proposalId: proposal.id,
                                        decision: "approved",
                                      })
                                    }
                                  >
                                    Aprobar
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="secondary"
                                    onClick={() => {
                                      setEditing(proposal.id);
                                      setDraft(
                                        JSON.stringify(proposal.proposed_changes ?? {}, null, 2),
                                      );
                                    }}
                                  >
                                    Corregir
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={review.isPending}
                                    onClick={() =>
                                      review.mutate({
                                        proposalId: proposal.id,
                                        decision: "rejected",
                                      })
                                    }
                                  >
                                    Rechazar
                                  </Button>
                                </>
                              )}
                              {proposal.status === "approved" && (
                                <Button
                                  size="sm"
                                  disabled={apply.isPending}
                                  onClick={() => apply.mutate({ proposalId: proposal.id })}
                                >
                                  Aplicar a la memoria
                                </Button>
                              )}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
