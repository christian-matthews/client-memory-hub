import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { ArrowLeft, Plus } from "lucide-react";
import { AppShell, SectionTitle } from "@/components/app-shell";
import {
  AttentionChips,
  CommitmentStatusBadge,
  DueDate,
  HealthDot,
  PartyBadge,
  RelativeTime,
  TopicStatusBadge,
  formatDate,
} from "@/components/memory-bits";
import { NewTopicDialog } from "@/components/new-topic-dialog";
import { TopicCard } from "@/components/topic-card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fetchClientPage } from "@/lib/read.functions";
import { unwrap, useActiveWorkspace } from "@/lib/use-workspace";
import { SOURCE_TYPE_LABEL } from "@/domain/shared/vocabulary";

export const Route = createFileRoute("/_authenticated/clients/$clientId")({
  head: () => ({
    meta: [
      { title: "Ficha de cliente — Client Memory" },
      {
        name: "description",
        content: "Estado actual, temas abiertos, decisiones, compromisos y evidencia del cliente.",
      },
      { property: "og:title", content: "Ficha de cliente — Client Memory" },
      { property: "og:description", content: "Memoria completa y auditable de un cliente." },
    ],
  }),
  component: ClientPage,
});

function ClientPage() {
  const { clientId } = Route.useParams();
  const { workspaceId } = useActiveWorkspace();
  const call = useServerFn(fetchClientPage);
  const [showClosed, setShowClosed] = useState(false);

  const query = useQuery({
    queryKey: ["client", workspaceId, clientId],
    enabled: Boolean(workspaceId),
    queryFn: async () => unwrap(await call({ data: { workspaceId, clientId } })),
  });

  if (query.isPending || !query.data) {
    return (
      <AppShell>
        <Skeleton className="h-40 w-full rounded-lg" />
      </AppShell>
    );
  }

  const data = query.data;
  const summary = data.structuredSummary;
  const topics = showClosed ? data.allTopics : data.topics;

  return (
    <AppShell>
      <Link
        to="/dashboard"
        className="mb-4 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" /> Tablero
      </Link>

      <header className="panel mb-5 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <HealthDot health={data.computedHealth} />
              <h1 className="font-display text-2xl font-semibold tracking-tight">
                {data.client.name}
              </h1>
            </div>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              {data.client.current_summary ?? "Aún sin resumen; se construye con las actualizaciones."}
            </p>
          </div>
          {workspaceId && (
            <NewTopicDialog
              workspaceId={workspaceId}
              clientId={clientId}
              trigger={
                <Button size="sm">
                  <Plus className="size-4" /> Tema
                </Button>
              }
            />
          )}
        </div>

        <AttentionChips reasons={data.attention} className="mt-4" limit={8} />

        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric label="Temas abiertos" value={summary.openTopics} />
          <Metric label="Bloqueados" value={summary.blockedTopics} />
          <Metric label="Compromisos nuestros" value={summary.ourOpenCommitments} />
          <Metric label="Vencidos nuestros" value={summary.ourOverdueCommitments} />
        </dl>

        {summary.nearestNextStep && (
          <div className="mt-4 rounded-md border border-primary/30 bg-primary/10 p-3 text-sm">
            <span className="label-caps">Siguiente paso más cercano</span>
            <p className="mt-1 text-foreground">{summary.nearestNextStep.nextStep}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {summary.nearestNextStep.topicTitle} · responsable{" "}
              {summary.nearestNextStep.owner} · vence {formatDate(summary.nearestNextStep.dueAt)}
            </p>
          </div>
        )}
      </header>

      {data.radarTopics.length > 0 && (
        <section className="mb-6">
          <SectionTitle
            title={`Temas activos · ${data.radarTopics.length}`}
            hint="Cada tarjeta se entiende sin abrirla: estado, último avance, pendientes y próximo paso."
          />
          <div className="grid gap-2 lg:grid-cols-2">
            {data.radarTopics.map((item) => (
              <TopicCard key={item.topic.id} item={item} />
            ))}
          </div>
        </section>
      )}

      <Tabs defaultValue="topics">
        <TabsList>
          <TabsTrigger value="topics">Temas</TabsTrigger>
          <TabsTrigger value="commitments">Compromisos</TabsTrigger>
          <TabsTrigger value="decisions">Decisiones</TabsTrigger>
          <TabsTrigger value="sources">Evidencia</TabsTrigger>
          <TabsTrigger value="activity">Bitácora</TabsTrigger>
        </TabsList>

        <TabsContent value="topics" className="mt-4">
          <SectionTitle
            title="Temas"
            hint="Cada tema tiene estado, siguiente paso y responsable explícito."
            action={
              <button
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setShowClosed((v) => !v)}
              >
                {showClosed ? "Ocultar cerrados" : "Ver cerrados"}
              </button>
            }
          />
          <div className="grid gap-2">
            {topics.length === 0 && <Empty text="Sin temas todavía." />}
            {topics.map((topic) => (
              <Link
                key={topic.id}
                to="/topics/$topicId"
                params={{ topicId: topic.id }}
                className="panel block p-3 transition-colors hover:border-ring/60"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <TopicStatusBadge status={topic.status} />
                  <h3 className="font-medium">{topic.title}</h3>
                  <span className="ml-auto text-xs text-muted-foreground">
                    <RelativeTime value={topic.last_relevant_change_at} />
                  </span>
                </div>
                <p className="mt-1.5 line-clamp-2 text-sm text-muted-foreground">
                  {topic.current_state}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <PartyBadge party={topic.next_step_owner} />
                  <span className="text-foreground">{topic.next_step ?? "Sin siguiente paso"}</span>
                  <DueDate value={topic.next_step_due_at} />
                </div>
              </Link>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="commitments" className="mt-4">
          <div className="grid gap-2">
            {data.commitments.length === 0 && <Empty text="Sin compromisos registrados." />}
            {data.commitments.map((c) => (
              <div key={c.id} className="panel flex flex-wrap items-center gap-2 p-3 text-sm">
                <CommitmentStatusBadge status={c.status} />
                <span>{c.description}</span>
                <span className="ml-auto flex items-center gap-2 text-xs">
                  <PartyBadge party={c.responsible_party} />
                  <DueDate value={c.due_at} />
                </span>
              </div>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="decisions" className="mt-4">
          <div className="grid gap-2">
            {data.recentDecisions.length === 0 && <Empty text="Sin decisiones registradas." />}
            {data.recentDecisions.map((d) => (
              <div key={d.id} className="panel p-3 text-sm">
                <p>{d.description}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Decidido el {formatDate(d.decided_at)}
                </p>
              </div>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="sources" className="mt-4">
          <div className="grid gap-2">
            {data.recentSources.length === 0 && <Empty text="Sin evidencia registrada." />}
            {data.recentSources.map((s) => (
              <div key={s.id} className="panel p-3 text-sm">
                <div className="flex items-center gap-2">
                  <span className="label-caps">{SOURCE_TYPE_LABEL[s.source_type]}</span>
                  <span className="font-medium">{s.title ?? "Sin título"}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {formatDate(s.occurred_at)}
                  </span>
                </div>
                {s.content_text && (
                  <p className="mt-1.5 line-clamp-3 text-muted-foreground">{s.content_text}</p>
                )}
              </div>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="activity" className="mt-4">
          <ol className="grid gap-1.5">
            {data.activity.length === 0 && <Empty text="Sin actividad registrada." />}
            {data.activity.map((event) => (
              <li key={event.id} className="panel flex flex-wrap items-center gap-2 p-2.5 text-xs">
                <span className="label-caps">{event.actor_type}</span>
                <span className="text-foreground">{event.description}</span>
                <span className="ml-auto text-muted-foreground">
                  <RelativeTime value={event.created_at} />
                </span>
              </li>
            ))}
          </ol>
        </TabsContent>
      </Tabs>
    </AppShell>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border bg-surface p-3">
      <dt className="label-caps">{label}</dt>
      <dd className="mt-1 font-mono text-xl text-foreground">{value}</dd>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="panel px-4 py-8 text-center text-sm text-muted-foreground">{text}</p>;
}
