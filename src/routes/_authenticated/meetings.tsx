import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AppShell, SectionTitle } from "@/components/app-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { IngestionConnections } from "@/components/ingestion-connections";
import { ManualTranscriptPaste } from "@/components/manual-transcript-paste";
import { MeetingInbox, type MeetingItem, type ProposalItem } from "@/components/meeting-inbox";
import { fetchMeetings } from "@/lib/read.functions";
import { unwrap, useActiveWorkspace } from "@/lib/use-workspace";

export const Route = createFileRoute("/_authenticated/meetings")({
  head: () => ({
    meta: [
      { title: "Bandeja de reuniones — Client Memory" },
      {
        name: "description",
        content:
          "Transcripciones recibidas desde macOS, analizadas con IA y convertidas en propuestas revisables.",
      },
      { property: "og:title", content: "Bandeja de reuniones — Client Memory" },
      {
        property: "og:description",
        content: "Transcripciones como evidencia y propuestas de IA que un humano aprueba.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: MeetingsPage,
});

function MeetingsPage() {
  const { workspaceId } = useActiveWorkspace();
  const call = useServerFn(fetchMeetings);
  const query = useQuery({
    queryKey: ["meetings", workspaceId],
    enabled: Boolean(workspaceId),
    queryFn: async () => unwrap(await call({ data: { workspaceId } })),
  });

  if (query.isPending || !query.data) {
    return (
      <AppShell>
        <Skeleton className="h-40 w-full rounded-lg" />
      </AppShell>
    );
  }

  const data = query.data;
  const canManage = data.role === "owner" || data.role === "admin";

  return (
    <AppShell>
      <SectionTitle
        title="Bandeja de reuniones"
        hint="La transcripción es evidencia inmutable. La IA solo propone: nada entra a la memoria del cliente sin tu aprobación explícita."
      />
      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <MeetingInbox
          items={data.items as MeetingItem[]}
          proposals={data.proposals as ProposalItem[]}
          clients={data.clients}
          topicTitles={data.topicTitles}
          workspaceId={workspaceId}
          canManage={canManage}
        />
        <IngestionConnections
          connections={data.connections}
          clients={data.clients}
          workspaceId={workspaceId}
          canManage={canManage}
        />
      </div>
    </AppShell>
  );
}
