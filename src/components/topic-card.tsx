import { Link } from "@tanstack/react-router";
import { DueDate, PartyBadge, RelativeTime, TopicHealthDot, TopicStatusBadge } from "@/components/memory-bits";
import { cn } from "@/lib/utils";
import type { RadarTopic } from "@/domain/queries/read";

/**
 * Compact topic card. The contract is strict: state, last material movement,
 * who owes what and next step must be readable without opening the topic.
 */
export function TopicCard({
  item,
  showClient = false,
  className,
}: {
  item: RadarTopic;
  showClient?: boolean;
  className?: string;
}) {
  const topic = item.topic;
  return (
    <Link
      to="/topics/$topicId"
      params={{ topicId: topic.id }}
      className={cn("panel block p-3.5 transition-colors hover:border-ring/60", className)}
    >
      <div className="flex flex-wrap items-center gap-2">
        <TopicHealthDot health={item.health} />
        <h3 className="min-w-0 truncate font-medium">{topic.title}</h3>
        <TopicStatusBadge status={topic.status} />
        {showClient && (
          <span className="rounded-md border border-border bg-secondary px-2 py-0.5 text-[11px] text-secondary-foreground">
            {item.clientName}
          </span>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          <RelativeTime value={topic.last_relevant_change_at} />
        </span>
      </div>

      <dl className="mt-2 space-y-1 text-xs">
        <Row label="Último avance" value={item.lastMaterial?.text ?? topic.current_state ?? "—"} />
        <Row
          label="Pendiente"
          value={
            item.ourOpenCommitments + item.clientOpenCommitments === 0
              ? "Sin compromisos abiertos"
              : `${item.ourOpenCommitments} nuestro(s) · ${item.clientOpenCommitments} cliente/terceros`
          }
        />
        <div className="flex flex-wrap items-center gap-2">
          <dt className="label-caps">Próximo paso</dt>
          <dd className="flex flex-wrap items-center gap-2 text-foreground">
            <span className="line-clamp-1">{topic.next_step ?? "Sin definir"}</span>
            <PartyBadge party={topic.next_step_owner} />
            <DueDate value={topic.next_step_due_at} />
          </dd>
        </div>
      </dl>

      {topic.blockers && (
        <p className="mt-2 rounded-md border border-signal-high/30 bg-signal-high/10 px-2 py-1 text-xs text-signal-high">
          {topic.blockers}
        </p>
      )}
    </Link>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      <dt className="label-caps shrink-0">{label}</dt>
      <dd className="line-clamp-1 min-w-0 text-foreground">{value}</dd>
    </div>
  );
}
