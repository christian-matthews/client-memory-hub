import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { createIntegrationFn, revokeIntegrationFn } from "@/lib/mutations.functions";
import { useDomainMutation } from "@/lib/use-workspace";

interface IntegrationRow {
  id: string;
  name: string;
  scopes: string[];
  write_enabled: boolean;
  token_prefix?: string | null;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

function isExpired(expiresAt: string | null) {
  return !!expiresAt && new Date(expiresAt).getTime() < Date.now();
}

function expiryLabel(expiresAt: string | null) {
  if (!expiresAt) return "sin vencimiento";
  const days = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return "expirada";
  if (days === 0) return "expira hoy";
  return `expira en ${days} d`;
}

export function McpIntegrations({
  integrations,
  workspaceId,
  canManage,
}: {
  integrations: IntegrationRow[];
  workspaceId?: string | undefined;
  canManage: boolean;
}) {
  const [name, setName] = useState("");
  const [writeEnabled, setWriteEnabled] = useState(false);
  const [expiresInDays, setExpiresInDays] = useState("90");
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const create = useDomainMutation<{
    name: string;
    scopes: string[];
    writeEnabled: boolean;
    expiresInDays: number | null;
  }>(
    createIntegrationFn as never,
    { workspaceId, successMessage: "Integración creada", invalidate: [["settings"]] },
  );
  const revoke = useDomainMutation<{ integrationId: string }>(revokeIntegrationFn as never, {
    workspaceId,
    successMessage: "Integración revocada",
    invalidate: [["settings"]],
  });

  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const endpoint = `${origin}/api/public/mcp`;
  const isPreviewOrigin = origin.includes("id-preview--");

  return (
    <section className="panel p-4">
      <h3 className="font-display text-sm font-semibold">Integraciones de agentes (MCP)</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Los agentes leen y escriben con las mismas reglas y auditoría que una persona. El token define
        el espacio de trabajo y los permisos.
      </p>

      <div className="mt-3 rounded-md border border-border/60 bg-muted/30 p-3">
        <p className="label-caps">Endpoint MCP</p>
        <div className="mt-1 flex items-start justify-between gap-2">
          <code className="min-w-0 break-all font-mono text-[11px] text-foreground">{endpoint}</code>
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0"
            onClick={() => {
              void navigator.clipboard.writeText(endpoint);
              toast.success("Endpoint copiado");
            }}
          >
            Copiar
          </Button>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Transporte: HTTP (JSON-RPC 2.0, método POST). Autenticación: cabecera{" "}
          <code className="font-mono">Authorization: Bearer cm_…</code> con el token de una
          integración de esta lista.
        </p>
        {isPreviewOrigin && (
          <p className="mt-2 text-[11px] text-destructive">
            Estás en la URL de vista previa, que exige iniciar sesión en Lovable y no sirve para
            clientes MCP. Usa el dominio publicado de la app (por ejemplo{" "}
            <code className="font-mono">https://tu-app.lovable.app/api/public/mcp</code>).
          </p>
        )}
      </div>


      <ul className="mt-3 grid gap-2 text-sm">
        {integrations.length === 0 && (
          <li className="text-muted-foreground">Sin integraciones registradas.</li>
        )}
        {integrations.map((i) => (
          <li key={i.id} className="flex items-center justify-between gap-2 border-t border-border/60 pt-2">
            <span className="min-w-0">
              <span className="block truncate">{i.name}</span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {i.token_prefix ?? "—"}
                {i.last_used_at ? ` · usado ${new Date(i.last_used_at).toLocaleDateString("es")}` : " · sin uso"}
                {" · "}
                {expiryLabel(i.expires_at)}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <span className="label-caps">
                {i.revoked_at
                  ? "revocada"
                  : isExpired(i.expires_at)
                    ? "expirada"
                    : i.write_enabled
                      ? "lectura+escritura"
                      : "lectura"}
              </span>
              {canManage && !i.revoked_at && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate({ integrationId: i.id })}
                >
                  Revocar
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>

      {canManage && (
        <form
          className="mt-4 grid gap-3 border-t border-border/60 pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            create.mutate(
              {
                name: name.trim(),
                scopes: writeEnabled ? ["read", "write"] : ["read"],
                writeEnabled,
                expiresInDays: expiresInDays === "never" ? null : Number(expiresInDays),
              },
              {
                onSuccess: (data) => {
                  setToken((data as { token?: string }).token ?? null);
                  setName("");
                  setWriteEnabled(false);
                  setCopied(false);
                },
              },
            );
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="mcp-name" className="label-caps">
              Nueva integración
            </Label>
            <Input
              id="mcp-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Claude Desktop"
              maxLength={80}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mcp-expiry" className="label-caps">
              Vencimiento
            </Label>
            <select
              id="mcp-expiry"
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="30">30 días</option>
              <option value="90">90 días</option>
              <option value="365">1 año</option>
              <option value="never">Sin vencimiento</option>
            </select>
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="mcp-write" className="text-sm font-normal">
              Permitir escritura
            </Label>
            <Switch id="mcp-write" checked={writeEnabled} onCheckedChange={setWriteEnabled} />
          </div>
          <Button type="submit" size="sm" disabled={create.isPending || !name.trim()}>
            Generar token
          </Button>
        </form>
      )}

      {token && (
        <div className="mt-4 rounded-md border border-border bg-muted/40 p-3">
          <p className="label-caps">Token — se muestra una sola vez</p>
          <p className="mt-1 break-all font-mono text-xs">{token}</p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => {
              void (async () => {
                try {
                  await navigator.clipboard.writeText(token);
                  setCopied(true);
                  toast.success("Token copiado al portapapeles");
                  setToken(null);
                } catch {
                  toast.error("No se pudo copiar: copia el token manualmente antes de cerrar");
                }
              })();
            }}
          >
            {copied ? "Copiado" : "Copiar y ocultar"}
          </Button>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Guárdalo ahora: no se puede volver a mostrar. Si lo pierdes, revoca la integración y crea
            otra.
          </p>
        </div>
      )}
    </section>
  );
}
