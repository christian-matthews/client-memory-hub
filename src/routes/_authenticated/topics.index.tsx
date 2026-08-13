import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { AppShell, SectionTitle } from "@/components/app-shell";
import { TopicCard } from "@/components/topic-card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fetchTopicsRadar } from "@/lib/read.functions";
import { unwrap, useActiveWorkspace } from "@/lib/use-workspace";
import type { RadarTopic } from "@/domain/queries/read";
import {
  PARTY_LABEL,
  PRIORITY_LABEL,
  TOPIC_STATUS_LABEL,
  type Party,
  type TopicStatus,
} from "@/domain/shared/vocabulary";

export const Route = createFileRoute("/_authenticated/topics/")({
  head: () => ({
    meta: [
      { title: "Radar de temas — Client Memory" },
      {
        name: "description",
        content:
          "Todos los temas vivos del espacio: qué necesita acción tuya, qué espera al cliente, qué está bloqueado y qué no se mueve.",
      },
      { property: "og:title", content: "Radar de temas — Client Memory" },
      {
        property: "og:description",
        content: "Vista global de temas vivos por estado, responsable y movimiento real.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: TopicsRadar,
});

const ANY = "any";

type Block = { key: string; title: string; hint: string; items: RadarTopic[] };

function TopicsRadar() {
  const { workspaceId } = useActiveWorkspace();
  const call = useServerFn(fetchTopicsRadar);

  const [clientId, setClientId] = useState<string>(ANY);
  const [status, setStatus] = useState<string>(ANY);
  const [priority, setPriority] = useState<string>(ANY);
  const [owner, setOwner] = useState<string>(ANY);
  const [minDays, setMinDays] = useState<string>(ANY);

  const query = useQuery({
    queryKey: ["topics-radar", workspaceId, clientId, status, priority, owner, minDays],
    enabled: Boolean(workspaceId),
    queryFn: async () =>
      unwrap(
        await call({
          data: {
            workspaceId,
            ...(clientId !== ANY ? { clientId } : {}),
            ...(status !== ANY ? { status } : {}),
            ...(priority !== ANY ? { priority } : {}),
            ...(owner !== ANY ? { nextStepOwner: owner } : {}),
            ...(minDays !== ANY ? { minDaysWithoutMovement: Number(minDays) } : {}),
          },
        }),
      ),
  });

  const blocks = useMemo<Block[]>(() => {
    const topics = query.data?.topics ?? [];
    const used = new Set<string>();
    const take = (predicate: (t: RadarTopic) => boolean) => {
      const list = topics.filter((t) => !used.has(t.topic.id) && predicate(t));
      for (const t of list) used.add(t.topic.id);
      return list;
    };

    const blocked = take((t) => t.topic.status === "blocked" || t.health === "red");
    const mine = take(
      (t) =>
        t.topic.status === "pending_us" ||
        t.topic.next_step_owner === "us" ||
        t.ourOpenCommitments > 0,
    );
    const waiting = take(
      (t) => t.topic.status === "waiting_client" || t.health === "blue",
    );
    const stale = take((t) => t.daysWithoutMovement >= 7);
    const active = take((t) => t.recentActivity >= 3);
    const rest = take(() => true);

    return [
      {
        key: "blocked",
        title: "Bloqueados",
        hint: "Algo impide avanzar o hay algo vencido.",
        items: blocked,
      },
      {
        key: "mine",
        title: "Necesitan acción mía",
        hint: "La pelota está de nuestro lado.",
        items: mine,
      },
      {
        key: "waiting",
        title: "Esperando cliente o terceros",
        hint: "No dependen de nosotros hoy.",
        items: waiting,
      },
      {
        key: "stale",
        title: "Sin movimiento reciente",
        hint: "Más de 7 días sin avance material.",
        items: stale,
      },
      {
        key: "active",
        title: "Con mucha actividad",
        hint: "Tres o más actualizaciones en los últimos 30 días.",
        items: active,
      },
      { key: "rest", title: "Resto", hint: "Temas vivos sin señal especial.", items: rest },
    ].filter((b) => b.items.length > 0);
  }, [query.data]);

  const total = query.data?.topics.length ?? 0;

  return (
    <AppShell>
      <div className="mb-5">
        <h1 className="font-display text-2xl font-semibold tracking-tight">Radar de temas</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {total} tema(s) vivo(s) agrupados por lo que exigen hoy, no por cliente.
        </p>
      </div>

      <div className="mb-5 flex flex-wrap gap-2">
        <Filter label="Cliente" value={clientId} onChange={setClientId}>
          {(query.data?.clients ?? []).map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.name}
            </SelectItem>
          ))}
        </Filter>
        <Filter label="Estado" value={status} onChange={setStatus}>
          {(Object.keys(TOPIC_STATUS_LABEL) as TopicStatus[]).map((s) => (
            <SelectItem key={s} value={s}>
              {TOPIC_STATUS_LABEL[s]}
            </SelectItem>
          ))}
        </Filter>
        <Filter label="Prioridad" value={priority} onChange={setPriority}>
          {(Object.keys(PRIORITY_LABEL) as Array<keyof typeof PRIORITY_LABEL>).map((p) => (
            <SelectItem key={p} value={p}>
              {PRIORITY_LABEL[p]}
            </SelectItem>
          ))}
        </Filter>
        <Filter label="Responsable" value={owner} onChange={setOwner}>
          {(Object.keys(PARTY_LABEL) as Party[]).map((p) => (
            <SelectItem key={p} value={p}>
              {PARTY_LABEL[p]}
            </SelectItem>
          ))}
        </Filter>
        <Filter label="Antigüedad" value={minDays} onChange={setMinDays}>
          <SelectItem value="3">3+ días sin avance</SelectItem>
          <SelectItem value="7">7+ días sin avance</SelectItem>
          <SelectItem value="14">14+ días sin avance</SelectItem>
          <SelectItem value="30">30+ días sin avance</SelectItem>
        </Filter>
      </div>

      {query.isPending ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
      ) : query.isError ? (
        <p className="panel px-4 py-10 text-center text-sm text-signal-high">
          No se pudieron cargar los temas.
        </p>
      ) : blocks.length === 0 ? (
        <p className="panel px-4 py-14 text-center text-sm text-muted-foreground">
          No hay temas que cumplan estos filtros.
        </p>
      ) : (
        <div className="space-y-6">
          {blocks.map((block) => (
            <section key={block.key}>
              <SectionTitle
                title={`${block.title} · ${block.items.length}`}
                hint={block.hint}
              />
              <div className="grid gap-2 lg:grid-cols-2">
                {block.items.map((item) => (
                  <TopicCard key={item.topic.id} item={item} showClient />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </AppShell>
  );
}

function Filter({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-9 w-auto min-w-36 gap-2 text-xs">
        <span className="label-caps">{label}</span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY}>Todos</SelectItem>
        {children}
      </SelectContent>
    </Select>
  );
}
