import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AppShell, SectionTitle } from "@/components/app-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchWorkspaceSettings } from "@/lib/read.functions";
import { unwrap, useActiveWorkspace } from "@/lib/use-workspace";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({
    meta: [
      { title: "Espacio de trabajo — Client Memory" },
      {
        name: "description",
        content: "Miembros, roles e integraciones de agentes del espacio de trabajo.",
      },
      { property: "og:title", content: "Espacio de trabajo — Client Memory" },
      { property: "og:description", content: "Miembros, roles e integraciones de agentes." },
    ],
  }),
  component: SettingsPage,
});

function SettingsPage() {
  const { workspaceId } = useActiveWorkspace();
  const call = useServerFn(fetchWorkspaceSettings);
  const query = useQuery({
    queryKey: ["settings", workspaceId],
    enabled: Boolean(workspaceId),
    queryFn: async () => unwrap(await call({ data: { workspaceId } })),
  });

  if (query.isPending || !query.data) {
    return (
      <AppShell>
        <Skeleton className="h-32 w-full rounded-lg" />
      </AppShell>
    );
  }

  const data = query.data;

  return (
    <AppShell>
      <SectionTitle
        title={data.workspace?.name ?? "Espacio de trabajo"}
        hint={`Tu rol: ${data.role}. Todo el acceso está aislado por espacio de trabajo.`}
      />
      <div className="grid gap-5 lg:grid-cols-2">
        <section className="panel p-4">
          <h3 className="font-display text-sm font-semibold">Miembros</h3>
          <ul className="mt-3 grid gap-1.5 text-sm">
            {data.members.map((m) => (
              <li key={m.user_id} className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs text-muted-foreground">
                  {m.user_id === data.currentUserId ? "tú" : m.user_id.slice(0, 8)}
                </span>
                <span className="label-caps">{m.role}</span>
              </li>
            ))}
          </ul>
        </section>

        <McpIntegrations
          integrations={data.integrations}
          workspaceId={workspaceId}
          canManage={data.role === "owner" || data.role === "admin"}
        />

      </div>
    </AppShell>
  );
}
