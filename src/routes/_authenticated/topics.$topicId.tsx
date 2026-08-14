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
  TopicHealthDot,
  TopicStatusBadge,
  formatDate,
} from "@/components/memory-bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchTopicPage } from "@/lib/read.functions";
import {
  addTopicUpdateFn,
  completeCommitmentFn,
  mergeTopicsFn,
  updateTopicStateFn,
} from "@/lib/mutations.functions";

import { unwrap, useActiveWorkspace, useDomainMutation } from "@/lib/use-workspace";
import {
  PARTY_LABEL,
  PRIORITY_LABEL,
  SOURCE_TYPE_LABEL,
  TOPIC_HEALTH_LABEL,
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
        content:
          "Estado vivo del tema: dónde está hoy, decisiones, pendientes de cada lado, bloqueos e historia con su fuente.",
      },
      { property: "og:title", content: "Tema — Client Memory" },
      { property: "og:description", content: "Estado vivo y auditable de un tema del cliente." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
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
  const updateState = useServerFn(updateTopicStateFn);

  const query = useQuery({
    queryKey: ["topic", workspaceId, topicId],
    enabled: Boolean(workspaceId),
    queryFn: async () => unwrap(await call({ data: { workspaceId, topicId } })),
  });

  const invalidate = [["topic"], ["client"], ["dashboard"], ["topics-radar"]];
  const updateMutation = useDomainMutation<Record<string, unknown>>(addUpdate, {
    workspaceId,
    successMessage: "Actualización registrada",
    invalidate,
  });
  const completeMutation = useDomainMutation<{ commitmentId: string }>(complete, {
    workspaceId,
    successMessage: "Compromiso cumplido",
    invalidate,
  });
  const metaMutation = useDomainMutation<Record<string, unknown>>(updateState, {
    workspaceId,
    successMessage: "Tema actualizado",
    invalidate,
  });

  const [content, setContent] = useState("");
  const [status, setStatus] = useState<TopicStatus | "keep">("keep");
  const [nextStep, setNextStep] = useState("");
  const [owner, setOwner] = useState<Party>("us");
  const [dueAt, setDueAt] = useState("");
  const [sourceId, setSourceId] = useState<string>("none");
  const [isMaterial, setIsMaterial] = useState(true);

  if (query.isPending || !query.data) {
    return (
      <AppShell>
        <Skeleton className="h-40 w-full rounded-lg" />
      </AppShell>
    );
  }

  const { topic, client, history, lastMaterial, health, decisions, commitments, sources, clientSources } =
    query.data;

  const openCommitments = commitments.filter((c) => c.status === "open" || c.status === "overdue");
  const ourPending = openCommitments.filter((c) => c.responsible_party === "us");
  const theirPending = openCommitments.filter((c) => c.responsible_party !== "us");

  async function submitUpdate(event: React.FormEvent) {
    event.preventDefault();
    await updateMutation.mutateAsync({
      topicId,
      content: content.trim(),
      updateType: "note",
      isRelevant: isMaterial,
      ...(status !== "keep" ? { status } : {}),
      ...(nextStep.trim() ? { nextStep: nextStep.trim(), nextStepOwner: owner } : {}),
      ...(dueAt ? { nextStepDueAt: new Date(`${dueAt}T12:00:00Z`).toISOString() } : {}),
      ...(sourceId !== "none" ? { sourceId } : {}),
    });
    setContent("");
    setNextStep("");
    setDueAt("");
    setStatus("keep");
    setSourceId("none");
    setIsMaterial(true);
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

      {/* Executive header: answers "¿en qué va este tema?" in one glance. */}
      <header className="panel mb-5 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <TopicHealthDot health={health} />
          <h1 className="font-display text-xl font-semibold tracking-tight">{topic.title}</h1>
          <TopicStatusBadge status={topic.status} />
          <span className="rounded-md border border-border bg-secondary px-2 py-0.5 text-[11px] text-secondary-foreground">
            Prioridad {PRIORITY_LABEL[topic.priority]}
          </span>
          <span className="ml-auto text-xs text-muted-foreground">{TOPIC_HEALTH_LABEL[health]}</span>
        </div>

        <p className="mt-3 text-sm text-foreground">
          {topic.current_state || "Sin resumen de estado actual todavía."}
        </p>

        <dl className="mt-4 grid gap-3 sm:grid-cols-3">
          <Field label="Responsable interno" value={topic.owner_name ?? "Sin asignar"} />
          <Field label="Contraparte cliente" value={topic.client_owner_name ?? "Sin asignar"} />
          <div className="rounded-md border border-border bg-surface p-3">
            <dt className="label-caps">Próximo paso</dt>
            <dd className="mt-1 flex flex-wrap items-center gap-2 text-sm">
              <span>{topic.next_step ?? "Sin definir"}</span>
              <PartyBadge party={topic.next_step_owner} />
              <DueDate value={topic.next_step_due_at} />
            </dd>
          </div>
        </dl>

        <div className="mt-3 rounded-md border border-primary/30 bg-primary/10 p-3 text-sm">
          <span className="label-caps">Último movimiento material</span>
          <p className="mt-1">{lastMaterial?.text ?? "Todavía no hay un avance material."}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {lastMaterial ? (
              <>
                {formatDate(lastMaterial.at)} · <RelativeTime value={lastMaterial.at} />
                {lastMaterial.source ? ` · ${lastMaterial.source.title ?? "fuente vinculada"}` : ""}
              </>
            ) : (
              <>Los mensajes tipo “gracias” o “recibido” no cuentan como avance.</>
            )}
          </p>
        </div>
      </header>

      {/* Four short blocks: what each side owes, what was decided, what blocks. */}
      <div className="mb-6 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Block title={`Pendientes míos · ${ourPending.length}`}>
          {ourPending.length === 0 && <Muted>Nada pendiente de nuestro lado.</Muted>}
          {ourPending.map((c) => (
            <div key={c.id} className="text-sm">
              <p>{c.description}</p>
              <div className="mt-1 flex items-center gap-2 text-xs">
                <DueDate value={c.due_at} />
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-xs"
                  disabled={completeMutation.isPending}
                  onClick={() => completeMutation.mutate({ commitmentId: c.id })}
                >
                  Marcar cumplido
                </Button>
              </div>
            </div>
          ))}
        </Block>

        <Block title={`Pendientes cliente / terceros · ${theirPending.length}`}>
          {theirPending.length === 0 && <Muted>Nada pendiente del otro lado.</Muted>}
          {theirPending.map((c) => (
            <div key={c.id} className="text-sm">
              <p>{c.description}</p>
              <div className="mt-1 flex items-center gap-2 text-xs">
                <PartyBadge party={c.responsible_party} />
                <DueDate value={c.due_at} />
              </div>
            </div>
          ))}
        </Block>

        <Block title={`Decisiones · ${decisions.length}`}>
          {decisions.length === 0 && <Muted>Sin decisiones registradas.</Muted>}
          {decisions.map((d) => (
            <div key={d.id} className="text-sm">
              <p>{d.description}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{formatDate(d.decided_at)}</p>
            </div>
          ))}
        </Block>

        <Block title="Bloqueos / riesgos">
          {topic.blockers ? (
            <p className="text-sm text-signal-high">{topic.blockers}</p>
          ) : (
            <Muted>Sin bloqueos declarados.</Muted>
          )}
        </Block>
      </div>

      <Tabs defaultValue="history">
        <TabsList>
          <TabsTrigger value="history">Historia</TabsTrigger>
          <TabsTrigger value="evidence">Evidencia</TabsTrigger>
          <TabsTrigger value="update">Registrar actualización</TabsTrigger>
          <TabsTrigger value="settings">Datos del tema</TabsTrigger>
        </TabsList>

        <TabsContent value="history" className="mt-4">
          <SectionTitle
            title="Historia"
            hint="Fecha → fuente → qué cambió. Nunca se borra nada; solo se agrega."
          />
          <ol className="grid gap-2">
            {history.length === 0 && <Muted>Sin historia todavía.</Muted>}
            {history.map((entry) => (
              <li key={`${entry.kind}-${entry.id}`} className="panel p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-mono text-foreground">{formatDate(entry.at)}</span>
                  <span className="text-muted-foreground">
                    {entry.source
                      ? `${SOURCE_TYPE_LABEL[entry.source.source_type as keyof typeof SOURCE_TYPE_LABEL] ?? "Fuente"}: ${entry.source.title ?? "sin título"}`
                      : "Registro manual"}
                  </span>
                  <span className="label-caps ml-auto">
                    {UPDATE_TYPE_LABEL[entry.updateType as keyof typeof UPDATE_TYPE_LABEL] ??
                      "Nota"}
                  </span>
                  {!entry.isMaterial && (
                    <span className="rounded-md border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      sin avance material
                    </span>
                  )}
                </div>
                <p className="mt-1.5">{entry.text}</p>
              </li>
            ))}
          </ol>
        </TabsContent>

        <TabsContent value="evidence" className="mt-4">
          <div className="grid gap-2">
            {sources.length === 0 && <Muted>Sin evidencia vinculada a este tema.</Muted>}
            {sources.map((link) => (
              <div key={link.source_id} className="panel p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="label-caps">
                    {SOURCE_TYPE_LABEL[
                      (link.sources?.source_type ?? "other") as keyof typeof SOURCE_TYPE_LABEL
                    ]}
                  </span>
                  <span className="font-medium">{link.sources?.title ?? "Sin título"}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {formatDate(link.sources?.occurred_at ?? link.created_at)}
                  </span>
                </div>
                {link.sources?.content_text && (
                  <p className="mt-1.5 line-clamp-3 text-muted-foreground">
                    {link.sources.content_text}
                  </p>
                )}
              </div>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="update" className="mt-4">
          <form onSubmit={submitUpdate} className="panel max-w-2xl space-y-3 p-4">
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
                <Label>Fuente</Label>
                <Select value={sourceId} onValueChange={setSourceId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Registro manual</SelectItem>
                    {clientSources.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {(s.title ?? "Sin título").slice(0, 60)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="update-next">Siguiente paso</Label>
                <Input
                  id="update-next"
                  value={nextStep}
                  onChange={(e) => setNextStep(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Responsable</Label>
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
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <Checkbox
                checked={isMaterial}
                onCheckedChange={(v) => setIsMaterial(v === true)}
              />
              Cuenta como avance material (desmarca si es solo un acuse tipo “gracias”).
            </label>
            <Button type="submit" disabled={updateMutation.isPending || !content.trim()}>
              Registrar
            </Button>
          </form>
        </TabsContent>

        <TabsContent value="settings" className="mt-4">
          <TopicMetaForm
            key={`${topic.owner_name}-${topic.client_owner_name}-${topic.blockers}`}
            topicId={topicId}
            ownerName={topic.owner_name ?? ""}
            clientOwnerName={topic.client_owner_name ?? ""}
            blockers={topic.blockers ?? ""}
            currentState={topic.current_state ?? ""}
            pending={metaMutation.isPending}
            onSubmit={(payload) => metaMutation.mutate({ topicId, ...payload })}
          />
        </TabsContent>
      </Tabs>
    </AppShell>
  );
}

function TopicMetaForm({
  ownerName,
  clientOwnerName,
  blockers,
  currentState,
  pending,
  onSubmit,
}: {
  topicId: string;
  ownerName: string;
  clientOwnerName: string;
  blockers: string;
  currentState: string;
  pending: boolean;
  onSubmit: (payload: Record<string, unknown>) => void;
}) {
  const [owner, setOwner] = useState(ownerName);
  const [clientOwner, setClientOwner] = useState(clientOwnerName);
  const [block, setBlock] = useState(blockers);
  const [state, setState] = useState(currentState);

  return (
    <form
      className="panel max-w-2xl space-y-3 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({
          ownerName: owner.trim() || null,
          clientOwnerName: clientOwner.trim() || null,
          blockers: block.trim() || null,
          currentState: state.trim(),
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="owner-name">Responsable interno</Label>
          <Input id="owner-name" value={owner} onChange={(e) => setOwner(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="client-owner">Contraparte en el cliente</Label>
          <Input
            id="client-owner"
            value={clientOwner}
            onChange={(e) => setClientOwner(e.target.value)}
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="current-state">Estado actual (3–6 líneas)</Label>
        <Textarea
          id="current-state"
          rows={4}
          value={state}
          onChange={(e) => setState(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="blockers">Bloqueos / riesgos</Label>
        <Textarea
          id="blockers"
          rows={2}
          value={block}
          onChange={(e) => setBlock(e.target.value)}
          placeholder="Qué impide avanzar hoy."
        />
      </div>
      <Button type="submit" disabled={pending}>
        Guardar
      </Button>
    </form>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-surface p-3">
      <dt className="label-caps">{label}</dt>
      <dd className="mt-1 text-sm text-foreground">{value}</dd>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel space-y-2 p-3.5">
      <h2 className="label-caps">{title}</h2>
      {children}
    </section>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}
