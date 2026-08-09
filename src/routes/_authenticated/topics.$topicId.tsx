import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { AppShell, SectionTitle } from "@/components/app-shell";
import {
  CommitmentStatusBadge,
  DueDate,
  PartyBadge,
  RelativeTime,
  TopicStatusBadge,
  formatDate,
} from "@/components/memory-bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchTopicPage } from "@/lib/read.functions";
import { addTopicUpdateFn, completeCommitmentFn } from "@/lib/mutations.functions";
import { unwrap, useActiveWorkspace, useDomainMutation } from "@/lib/use-workspace";
import {
  PARTY_LABEL,
  TOPIC_STATUS_LABEL,
  UPDATE_TYPE_LABEL,
  type Party,
  type TopicStatus,
} from "@/domain/shared/vocabulary";

export const Route = createFileRoute("/_authenticated/topics/$topicId")({
  head: () => ({
    meta: [
      { title: "Tema — Client Memory" },
      {
        name: "description",
        content: "Cronología del tema: actualizaciones, decisiones, compromisos y evidencia.",
      },
      { property: "og:title", content: "Tema — Client Memory" },
      { property: "og:description", content: "Cronología auditable de un tema del cliente." },
    ],
  }),
  component: TopicPage,
});

function TopicPage() {
  const { topicId } = Route.useParams();
  const { workspaceId } = useActiveWorkspace();
  const call = useServerFn(fetchTopicPage);
  const addUpdate = useServerFn(addTopicUpdateFn);
  const complete = useServerFn(completeCommitmentFn);

  const query = useQuery({
    queryKey: ["topic", workspaceId, topicId],
    enabled: Boolean(workspaceId),
    queryFn: async () => unwrap(await call({ data: { workspaceId, topicId } })),
  });

  const updateMutation = useDomainMutation<Record<string, unknown>>(addUpdate, {
    workspaceId,
    successMessage: "Actualización registrada",
    invalidate: [["topic"], ["client"], ["dashboard"]],
  });
  const completeMutation = useDomainMutation<{ commitmentId: string }>(complete, {
    workspaceId,
    successMessage: "Compromiso cumplido",
    invalidate: [["topic"], ["client"], ["dashboard"]],
  });

  const [content, setContent] = useState("");
  const [status, setStatus] = useState<TopicStatus | "keep">("keep");
  const [nextStep, setNextStep] = useState("");
  const [owner, setOwner] = useState<Party>("us");
  const [dueAt, setDueAt] = useState("");

  if (query.isPending || !query.data) {
    return (
      <AppShell>
        <Skeleton className="h-40 w-full rounded-lg" />
      </AppShell>
    );
  }

  const { topic, client, updates, decisions, commitments } = query.data;

  async function submitUpdate(event: React.FormEvent) {
    event.preventDefault();
    await updateMutation.mutateAsync({
      topicId,
      content: content.trim(),
      updateType: "note",
      ...(status !== "keep" ? { newStatus: status } : {}),
      ...(nextStep.trim() ? { nextStep: nextStep.trim(), nextStepOwner: owner } : {}),
      ...(dueAt ? { nextStepDueAt: new Date(`${dueAt}T12:00:00Z`).toISOString() } : {}),
    });
    setContent("");
    setNextStep("");
    setDueAt("");
    setStatus("keep");
  }

  return (
    <AppShell>
      {client && (
        <Link
          to="/clients/$clientId"
          params={{ clientId: topic.client_id }}
          className="mb-4 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> {client.name}
        </Link>
      )}

      <header className="panel mb-5 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <TopicStatusBadge status={topic.status} />
          <h1 className="font-display text-xl font-semibold tracking-tight">{topic.title}</h1>
          <span className="ml-auto text-xs text-muted-foreground">
            Último movimiento <RelativeTime value={topic.last_relevant_change_at} />
          </span>
        </div>
        <p className="mt-3 text-sm text-foreground">{topic.current_state}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <PartyBadge party={topic.next_step_owner} />
          <span className="text-foreground">{topic.next_step ?? "Sin siguiente paso"}</span>
          <DueDate value={topic.next_step_due_at} />
        </div>
      </header>

      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <section>
          <SectionTitle title="Registrar actualización" hint="Actualiza estado y siguiente paso en un solo paso." />
          <form onSubmit={submitUpdate} className="panel space-y-3 p-4">
            <div className="space-y-1.5">
              <Label htmlFor="update-content">Qué pasó</Label>
              <Textarea
                id="update-content"
                required
                rows={3}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Hecho concreto, sin interpretación."
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Nuevo estado</Label>
                <Select value={status} onValueChange={(v) => setStatus(v as TopicStatus | "keep")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="keep">Mantener estado</SelectItem>
                    {(Object.keys(TOPIC_STATUS_LABEL) as TopicStatus[]).map((s) => (
                      <SelectItem key={s} value={s}>
                        {TOPIC_STATUS_LABEL[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Responsable del siguiente paso</Label>
                <Select value={owner} onValueChange={(v) => setOwner(v as Party)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(PARTY_LABEL) as Party[]).map((party) => (
                      <SelectItem key={party} value={party}>
                        {PARTY_LABEL[party]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="update-next">Siguiente paso</Label>
                <Input
                  id="update-next"
                  value={nextStep}
                  onChange={(e) => setNextStep(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="update-due">Vence</Label>
                <Input
                  id="update-due"
                  type="date"
                  value={dueAt}
                  onChange={(e) => setDueAt(e.target.value)}
                />
              </div>
            </div>
            <Button type="submit" disabled={updateMutation.isPending || !content.trim()}>
              Registrar
            </Button>
          </form>

          <SectionTitle className="mt-6" title="Cronología" hint="Orden cronológico inverso." />
          <ol className="grid gap-2">
            {updates.length === 0 && (
              <li className="panel px-4 py-8 text-center text-sm text-muted-foreground">
                Sin actualizaciones todavía.
              </li>
            )}
            {updates.map((update) => (
              <li key={update.id} className="panel p-3 text-sm">
                <div className="flex items-center gap-2">
                  <span className="label-caps">{UPDATE_TYPE_LABEL[update.update_type]}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {formatDate(update.created_at)}
                  </span>
                </div>
                <p className="mt-1.5">{update.content}</p>
              </li>
            ))}
          </ol>
        </section>

        <aside className="space-y-5">
          <div>
            <SectionTitle title="Compromisos" />
            <div className="grid gap-2">
              {commitments.length === 0 && (
                <p className="panel px-4 py-6 text-center text-sm text-muted-foreground">
                  Sin compromisos.
                </p>
              )}
              {commitments.map((c) => (
                <div key={c.id} className="panel p-3 text-sm">
                  <div className="flex items-center gap-2">
                    <CommitmentStatusBadge status={c.status} />
                    <PartyBadge party={c.responsible_party} />
                    <span className="ml-auto text-xs">
                      <DueDate value={c.due_at} />
                    </span>
                  </div>
                  <p className="mt-1.5">{c.description}</p>
                  {(c.status === "open" || c.status === "overdue") && (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="mt-2"
                      disabled={completeMutation.isPending}
                      onClick={() => completeMutation.mutate({ commitmentId: c.id })}
                    >
                      Marcar cumplido
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div>
            <SectionTitle title="Decisiones" />
            <div className="grid gap-2">
              {decisions.length === 0 && (
                <p className="panel px-4 py-6 text-center text-sm text-muted-foreground">
                  Sin decisiones.
                </p>
              )}
              {decisions.map((d) => (
                <div key={d.id} className="panel p-3 text-sm">
                  <p>{d.description}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{formatDate(d.decided_at)}</p>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </AppShell>
  );
}
