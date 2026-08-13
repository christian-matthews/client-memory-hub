import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, Plus, Search } from "lucide-react";
import { AppShell, SectionTitle } from "@/components/app-shell";
import { AttentionChips, HealthDot, RelativeTime } from "@/components/memory-bits";
import { NewClientDialog } from "@/components/new-client-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchDashboard } from "@/lib/read.functions";
import { unwrap, useActiveWorkspace } from "@/lib/use-workspace";

const FILTERS = [
  { value: "all", label: "Todos" },
  { value: "needs_attention", label: "Requiere atención" },
  { value: "pending_us", label: "Nos toca" },
  { value: "waiting_client", label: "Esperando cliente" },
  { value: "stale", label: "Sin movimiento" },
] as const;


type Filter = (typeof FILTERS)[number]["value"];

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [
      { title: "Tablero de atención — Client Memory" },
      {
        name: "description",
        content: "Qué clientes requieren atención hoy y por qué, con reglas explícitas y auditables.",
      },
      { property: "og:title", content: "Tablero de atención — Client Memory" },
      { property: "og:description", content: "Qué clientes requieren atención hoy y por qué." },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  const { workspaceId, isLoading: loadingWorkspace } = useActiveWorkspace();
  const call = useServerFn(fetchDashboard);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");

  const query = useQuery({
    queryKey: ["dashboard", workspaceId, filter],
    enabled: Boolean(workspaceId),
    queryFn: async () => unwrap(await call({ data: { workspaceId: workspaceId!, filter } })),
  });

  const items = useMemo(() => {
    const list = query.data?.items ?? [];
    const term = search.trim().toLowerCase();
    return term ? list.filter((i) => i.client.name.toLowerCase().includes(term)) : list;
  }, [query.data, search]);

  const loading = loadingWorkspace || query.isPending;

  return (
    <AppShell>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">Atención de hoy</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Clientes ordenados por lo que está detenido, vencido o sin siguiente paso.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar cliente"
              className="h-9 w-44 pl-8"
            />
          </div>
          {workspaceId && (
            <NewClientDialog
              workspaceId={workspaceId}
              trigger={
                <Button size="sm">
                  <Plus className="size-4" /> Cliente
                </Button>
              }
            />
          )}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={`rounded-full border px-3 py-1 text-xs transition-colors ${
              filter === f.value
                ? "border-primary bg-primary/15 text-primary"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28 w-full rounded-lg" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState workspaceId={workspaceId} filter={filter} />
      ) : (
        <div className="grid gap-3">
          {items.map((item) => (
            <Link
              key={item.client.id}
              to="/clients/$clientId"
              params={{ clientId: item.client.id }}
              className="panel block p-4 transition-colors hover:border-ring/60"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <HealthDot health={item.computedHealth} />
                    <h3 className="truncate font-display text-base font-semibold">
                      {item.client.name}
                    </h3>
                    {item.attention.length > 0 && (
                      <span className="flex items-center gap-1 rounded-full bg-signal-high/15 px-2 py-0.5 text-[11px] font-medium text-signal-high">
                        <AlertTriangle className="size-3" />
                        {item.attention.length}
                      </span>
                    )}
                  </div>
                  <p className="mt-1.5 line-clamp-2 text-sm text-muted-foreground">
                    {item.client.current_summary ??
                      (item.summary.nearestNextStep
                        ? `Siguiente paso: ${item.summary.nearestNextStep.nextStep}`
                        : "Sin resumen todavía.")}
                  </p>
                </div>
                <ArrowRight className="mt-1 size-4 shrink-0 text-muted-foreground" />
              </div>

              <AttentionChips reasons={item.attention} className="mt-3" />

              <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
                <Stat label="Temas abiertos" value={item.summary.openTopics} />
                <Stat label="Nos toca" value={item.summary.pendingUsTopics} />
                <Stat label="Compromisos nuestros" value={item.summary.ourOpenCommitments} />
                <div>
                  <dt className="inline label-caps">Último movimiento</dt>{" "}
                  <dd className="inline text-foreground">
                    <RelativeTime value={item.summary.lastRelevantChangeAt} />
                  </dd>
                </div>
              </dl>
            </Link>
          ))}
        </div>
      )}
    </AppShell>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="inline label-caps">{label}</dt>{" "}
      <dd className="inline font-mono text-foreground">{value}</dd>
    </div>
  );
}

function EmptyState({
  workspaceId,
  filter,
}: {
  workspaceId: string | undefined;
  filter: Filter;
}) {
  return (
    <div className="panel flex flex-col items-center px-6 py-14 text-center">
      <h3 className="font-display text-base font-semibold">
        {filter === "needs_attention" ? "Nada requiere atención" : "Sin clientes todavía"}
      </h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        {filter === "needs_attention"
          ? "Ningún tema abierto está bloqueado, vencido ni sin siguiente paso."
          : "Crea tu primer cliente y empieza a registrar temas, decisiones y compromisos."}
      </p>
      {workspaceId && (
        <NewClientDialog
          workspaceId={workspaceId}
          trigger={
            <Button className="mt-4" size="sm">
              <Plus className="size-4" /> Nuevo cliente
            </Button>
          }
        />
      )}
    </div>
  );
}
