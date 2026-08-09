import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createIngestionConnectionFn,
  revokeIngestionConnectionFn,
  rotateIngestionConnectionFn,
  checkIngestionConnectionFn,
} from "@/lib/mutations.functions";
import { useDomainMutation } from "@/lib/use-workspace";

interface ConnectionRow {
  id: string;
  name: string;
  provider: string;
  secret_prefix: string;
  default_client_id: string | null;
  enabled: boolean;
  last_used_at: string | null;
  revoked_at: string | null;
}

export function IngestionConnections({
  connections,
  clients,
  workspaceId,
  canManage,
}: {
  connections: ConnectionRow[];
  clients: { id: string; name: string }[];
  workspaceId?: string | undefined;
  canManage: boolean;
}) {
  const [name, setName] = useState("");
  const [defaultClientId, setDefaultClientId] = useState("");
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const create = useDomainMutation<{ name: string; defaultClientId: string | null }>(
    createIngestionConnectionFn as never,
    { workspaceId, successMessage: "Conexión creada", invalidate: [["meetings"]] },
  );
  const revoke = useDomainMutation<{ connectionId: string }>(
    revokeIngestionConnectionFn as never,
    { workspaceId, successMessage: "Conexión revocada", invalidate: [["meetings"]] },
  );
  const rotate = useDomainMutation<{ connectionId: string }>(
    rotateIngestionConnectionFn as never,
    { workspaceId, successMessage: "Secreto rotado: la URL anterior dejó de servir", invalidate: [["meetings"]] },
  );
  const check = useDomainMutation<{ connectionId: string }>(checkIngestionConnectionFn as never, {
    workspaceId,
    successMessage: "Conexión verificada",
    invalidate: [["meetings"]],
  });

  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const clientName = (id: string | null) =>
    id ? (clients.find((c) => c.id === id)?.name ?? "—") : "sin cliente por defecto";

  return (
    <section className="panel p-4">
      <h3 className="font-display text-sm font-semibold">Conexiones de ingesta (macOS)</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Cada conexión genera una URL con secreto para que MacWhisper / Whisper Transcription envíe la
        transcripción por webhook. La URL completa se muestra una sola vez; el secreto se guarda solo
        como hash y define el espacio de trabajo.
      </p>

      <ul className="mt-3 grid gap-2 text-sm">
        {connections.length === 0 && (
          <li className="text-muted-foreground">Sin conexiones registradas.</li>
        )}
        {connections.map((c) => (
          <li
            key={c.id}
            className="flex items-center justify-between gap-2 border-t border-border/60 pt-2"
          >
            <span className="min-w-0">
              <span className="block truncate">{c.name}</span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {c.secret_prefix}… · {clientName(c.default_client_id)}
                {c.last_used_at
                  ? ` · usada ${new Date(c.last_used_at).toLocaleDateString("es")}`
                  : " · sin uso"}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <span className="label-caps">{c.revoked_at ? "revocada" : "activa"}</span>
              {canManage && !c.revoked_at && (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={check.isPending}
                    onClick={() =>
                      check.mutate(
                        { connectionId: c.id },
                        {
                          onSuccess: (result) => {
                            const r = result as {
                              accepting?: boolean;
                              receivedCount?: number;
                              lastUsedAt?: string | null;
                            };
                            toast.info(
                              r.accepting
                                ? `Acepta envíos · ${r.receivedCount ?? 0} recibidas${
                                    r.lastUsedAt
                                      ? ` · último ${new Date(r.lastUsedAt).toLocaleString("es")}`
                                      : " · sin uso todavía"
                                  }`
                                : "No acepta envíos: revocada o deshabilitada",
                            );
                          },
                        },
                      )
                    }
                  >
                    Probar
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={rotate.isPending}
                    onClick={() =>
                      rotate.mutate(
                        { connectionId: c.id },
                        {
                          onSuccess: (result) => {
                            const path = (result as { path?: string }).path;
                            if (path) setUrl(`${origin}${path}`);
                            setCopied(false);
                          },
                        },
                      )
                    }
                  >
                    Rotar secreto
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate({ connectionId: c.id })}
                  >
                    Revocar
                  </Button>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>

      {canManage && (
        <form
          className="mt-4 grid gap-3 border-t border-border/60 pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim()) return;
            create.mutate(
              { name: name.trim(), defaultClientId: defaultClientId || null },
              {
                onSuccess: (result) => {
                  const path = (result as { path?: string }).path;
                  if (path) setUrl(`${origin}${path}`);
                  setName("");
                  setCopied(false);
                },
              },
            );
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="ingest-name" className="text-xs">
              Nombre de la conexión
            </Label>
            <Input
              id="ingest-name"
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              placeholder="MacBook de Christian"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ingest-client" className="text-xs">
              Cliente por defecto (opcional)
            </Label>
            <select
              id="ingest-client"
              value={defaultClientId}
              onChange={(event) => setDefaultClientId(event.target.value)}
              className="h-9 rounded-md border border-input bg-surface px-2 text-sm"
            >
              <option value="">Sin cliente (se asigna al revisar)</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" size="sm" disabled={create.isPending || !name.trim()}>
            Crear conexión
          </Button>
        </form>
      )}

      {url && (
        <div className="mt-4 rounded-md border border-primary/40 bg-primary/5 p-3">
          <p className="text-xs font-medium">
            Copia esta URL ahora: no volverá a mostrarse. Pégala como webhook (POST) en la app de
            macOS.
          </p>
          <p className="mt-2 break-all font-mono text-[11px]">{url}</p>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={async () => {
                await navigator.clipboard.writeText(url);
                setCopied(true);
                toast.success("URL copiada");
              }}
            >
              {copied ? "Copiada" : "Copiar"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setUrl(null)}>
              Ocultar
            </Button>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Contrato aceptado: POST con JSON <code>{"{ transcript, title? }"}</code> — nada más. La
            fecha, el cliente y la conexión los determina el servidor. Respuestas:{" "}
            <code>202</code> recibida, <code>200</code> duplicada, <code>401</code> credencial
            inválida.
          </p>
        </div>
      )}
    </section>
  );
}
