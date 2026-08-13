import { cn } from "@/lib/utils";
import type { AttentionReason } from "@/domain/attention/rules";
import {
  COMMITMENT_STATUS_LABEL,
  HEALTH_LABEL,
  PARTY_LABEL,
  TOPIC_STATUS_LABEL,
  UPDATE_TYPE_LABEL,
  type ClientHealth,
  type CommitmentStatus,
  type Party,
  type TopicStatus,
  TOPIC_HEALTH_LABEL,
  type TopicHealth,
} from "@/domain/shared/vocabulary";

const HEALTH_COLOR: Record<ClientHealth, string> = {
  good: "bg-signal-ok",
  attention: "bg-signal-medium",
  risk: "bg-signal-high",
  unknown: "bg-muted-foreground",
};

export function HealthDot({ health }: { health: ClientHealth }) {
  return (
    <span
      className={cn("inline-block size-2 shrink-0 rounded-full", HEALTH_COLOR[health])}
      title={HEALTH_LABEL[health]}
      aria-label={HEALTH_LABEL[health]}
    />
  );
}

const TOPIC_HEALTH_COLOR: Record<TopicHealth, string> = {
  green: "bg-signal-ok",
  yellow: "bg-signal-medium",
  red: "bg-signal-high",
  blue: "bg-signal-low",
};

export function TopicHealthDot({ health }: { health: TopicHealth }) {
  return (
    <span
      className={cn("inline-block size-2.5 shrink-0 rounded-full", TOPIC_HEALTH_COLOR[health])}
      title={TOPIC_HEALTH_LABEL[health]}
      aria-label={TOPIC_HEALTH_LABEL[health]}
    />
  );
}

export function AttentionChips({
  reasons,
  className,
  limit = 4,
}: {
  reasons: AttentionReason[];
  className?: string;
  limit?: number;
}) {
  if (reasons.length === 0) return null;
  const shown = reasons.slice(0, limit);
  return (
    <ul className={cn("flex flex-wrap gap-1.5", className)}>
      {shown.map((reason, index) => (
        <li
          key={`${reason.code}-${index}`}
          className={cn(
            "rounded-md border px-2 py-0.5 text-[11px] leading-5",
            reason.severity === "high"
              ? "border-signal-high/40 bg-signal-high/10 text-signal-high"
              : "border-signal-medium/40 bg-signal-medium/10 text-signal-medium",
          )}
        >
          {reason.message}
        </li>
      ))}
      {reasons.length > shown.length && (
        <li className="rounded-md border border-border px-2 py-0.5 text-[11px] leading-5 text-muted-foreground">
          +{reasons.length - shown.length} más
        </li>
      )}
    </ul>
  );
}

const STATUS_TONE: Record<TopicStatus, string> = {
  pending_us: "border-signal-medium/40 bg-signal-medium/10 text-signal-medium",
  waiting_client: "border-signal-low/40 bg-signal-low/10 text-signal-low",
  active: "border-accent/40 bg-accent/10 text-accent",
  monitoring: "border-border bg-secondary text-secondary-foreground",
  paused: "border-border bg-muted text-muted-foreground",
  blocked: "border-signal-high/40 bg-signal-high/10 text-signal-high",
  resolved: "border-signal-ok/40 bg-signal-ok/10 text-signal-ok",
  archived: "border-border bg-muted text-muted-foreground",
};


export function TopicStatusBadge({ status }: { status: TopicStatus }) {
  return (
    <span className={cn("rounded-md border px-2 py-0.5 text-[11px] font-medium", STATUS_TONE[status])}>
      {TOPIC_STATUS_LABEL[status]}
    </span>
  );
}

export function CommitmentStatusBadge({ status }: { status: CommitmentStatus }) {
  const tone =
    status === "overdue"
      ? "border-signal-high/40 bg-signal-high/10 text-signal-high"
      : status === "completed"
        ? "border-signal-ok/40 bg-signal-ok/10 text-signal-ok"
        : status === "cancelled"
          ? "border-border bg-muted text-muted-foreground"
          : "border-signal-medium/40 bg-signal-medium/10 text-signal-medium";
  return (
    <span className={cn("rounded-md border px-2 py-0.5 text-[11px] font-medium", tone)}>
      {COMMITMENT_STATUS_LABEL[status]}
    </span>
  );
}

export function PartyBadge({ party }: { party: Party }) {
  return (
    <span className="rounded-md border border-border bg-secondary px-2 py-0.5 text-[11px] text-secondary-foreground">
      {PARTY_LABEL[party]}
    </span>
  );
}

export function UpdateTypeBadge({ type }: { type: keyof typeof UPDATE_TYPE_LABEL }) {
  return <span className="label-caps">{UPDATE_TYPE_LABEL[type]}</span>;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("es", { day: "2-digit", month: "short", year: "numeric" });
}

export function RelativeTime({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-muted-foreground">sin registro</span>;
  const diffDays = Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000);
  const text =
    diffDays <= 0 ? "hoy" : diffDays === 1 ? "ayer" : `hace ${diffDays} días`;
  return (
    <time dateTime={value} title={formatDate(value)}>
      {text}
    </time>
  );
}

export function DueDate({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-muted-foreground">sin fecha</span>;
  const overdue = new Date(value).getTime() < Date.now();
  return (
    <time
      dateTime={value}
      className={overdue ? "text-signal-high" : "text-foreground"}
      title={overdue ? "Vencido" : "Pendiente"}
    >
      {formatDate(value)}
    </time>
  );
}

export function AiBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-ai/40 bg-ai/10 px-2 py-0.5 text-[11px] font-medium text-ai">
      {children}
    </span>
  );
}
