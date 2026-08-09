import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import {
  assignMeetingClientFn,
  discardMeetingFn,
  processMeetingFn,
  reviewProposalFn,
  applyProposalFn,
} from "@/lib/mutations.functions";
import { useDomainMutation } from "@/lib/use-workspace";
import {
  AI_PROPOSAL_STATUS_LABEL,
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
  error_message: string | null;
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
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString("es", { dateStyle: "medium", timeStyle: "short" });
}

function formatDuration(seconds: number | null) {
  if (!seconds) return null;
  const minutes = Math.round(seconds / 60);
  return `${minutes} min`;
}

function proposalSummary(changes: unknown): string {
  const c = (changes ?? {}) as Record<string, unknown>;
  const text = c["content"] ?? c["description"] ?? c["title"] ?? c["nextStep"];
  return typeof text === "string" ? text : "—";
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
  const invalidate = [["meetings"], ["dashboard"], ["client"], ["topic"]];
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

  const [expanded, setExpanded] = useState<string | null>(null);

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
                {item.error_message && (
                  <p className="mt-1 text-xs text-destructive">{item.error_message}</p>
                )}
              </div>
              <span className="label-caps shrink-0">{INGESTION_STATUS_LABEL[item.status]}</span>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select
                value={item.client_id ?? ""}
                disabled={!canManage || item.status === "processed" || assign.isPending}
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

              {canManage && item.status !== "processed" && (
                <Button
                  size="sm"
                  disabled={process.isPending || !item.client_id}
                  onClick={() => process.mutate({ itemId: item.id })}
                >
                  {process.isPending ? "Analizando…" : "Analizar con IA"}
                </Button>
              )}

              {itemProposals.length > 0 && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setExpanded(isOpen ? null : item.id)}
                >
                  {isOpen ? "Ocultar propuestas" : `Propuestas (${itemProposals.length})`}
                  {pending > 0 ? ` · ${pending} pendientes` : ""}
                </Button>
              )}

              {item.client_id && (
                <Link
                  to="/clients/$clientId"
                  params={{ clientId: item.client_id }}
                  className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                >
                  Ver cliente
                </Link>
              )}

              {canManage && item.status !== "processing" && (
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
              <ul className="mt-3 grid gap-2 border-t border-border/60 pt-3">
                {itemProposals.map((proposal) => (
                  <li key={proposal.id} className="rounded-md border border-border/60 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="label-caps">
                        {PROPOSAL_TYPE_LABEL[proposal.proposal_type as ProposalType] ??
                          proposal.proposal_type}
                        {proposal.topic_id ? ` · ${topicTitles[proposal.topic_id] ?? "tema"}` : ""}
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        {AI_PROPOSAL_STATUS_LABEL[proposal.status] ?? proposal.status}
                        {proposal.confidence !== null
                          ? ` · confianza ${Math.round(proposal.confidence * 100)}%`
                          : ""}
                      </span>
                    </div>
                    <p className="mt-1.5 text-sm">{proposalSummary(proposal.proposed_changes)}</p>
                    <p className="mt-1 text-xs italic text-muted-foreground">
                      {proposal.explanation}
                    </p>

                    {canManage && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {proposal.status === "pending" && (
                          <>
                            <Button
                              size="sm"
                              disabled={review.isPending}
                              onClick={() =>
                                review.mutate({ proposalId: proposal.id, decision: "approved" })
                              }
                            >
                              Aprobar
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={review.isPending}
                              onClick={() =>
                                review.mutate({ proposalId: proposal.id, decision: "rejected" })
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
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}
