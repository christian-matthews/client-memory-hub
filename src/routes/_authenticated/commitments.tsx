import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AppShell, SectionTitle } from "@/components/app-shell";
import { CommitmentStatusBadge, DueDate, PartyBadge } from "@/components/memory-bits";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchOpenCommitments } from "@/lib/read.functions";
import { unwrap, useActiveWorkspace } from "@/lib/use-workspace";

export const Route = createFileRoute("/_authenticated/commitments")({
  head: () => ({
    meta: [
      { title: "Compromisos abiertos — Client Memory" },
      {
        name: "description",
        content: "Todos los compromisos abiertos del espacio, con responsable y fecha explícitos.",
      },
      { property: "og:title", content: "Compromisos abiertos — Client Memory" },
      { property: "og:description", content: "Quién debe qué y para cuándo, en todo el espacio." },
    ],
  }),
  component: CommitmentsPage,
});

function CommitmentsPage() {
  const { workspaceId } = useActiveWorkspace();
  const call = useServerFn(fetchOpenCommitments);
  const query = useQuery({
    queryKey: ["commitments", workspaceId],
    enabled: Boolean(workspaceId),
    queryFn: async () => unwrap(await call({ data: { workspaceId } })),
  });

  return (
    <AppShell>
      <SectionTitle
        title="Compromisos abiertos"
        hint="Ordenados por fecha de vencimiento. Los nuestros vencidos elevan la atención del cliente."
      />
      {query.isPending && !query.isError ? (
        <Skeleton className="h-32 w-full rounded-lg" />
      ) : query.isError ? (
        <p className="panel px-4 py-10 text-center text-sm text-destructive">
          No se pudieron cargar los compromisos: {(query.error as Error).message}
        </p>
      ) : (query.data?.commitments ?? []).length === 0 ? (
        <p className="panel px-4 py-10 text-center text-sm text-muted-foreground">
          No hay compromisos abiertos.
        </p>
      ) : (
        <ul className="grid gap-2">
          {(query.data?.commitments ?? []).map((c) => (
            <li key={c.id} className="panel flex flex-wrap items-center gap-2 p-3 text-sm">
              <CommitmentStatusBadge status={c.status} />
              <span>{c.description}</span>
              <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                <PartyBadge party={c.responsible_party} />
                <DueDate value={c.due_at} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </AppShell>
  );
}
