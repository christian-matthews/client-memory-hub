import { useState } from "react";
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
  const [token, setToken] = useState<string | null>(null);

  const create = useDomainMutation<{ name: string; scopes: string[]; writeEnabled: boolean }>(
    createIntegrationFn as never,
    { workspaceId, successMessage: "Integración creada", invalidate: [["settings"]] },
  );
  const revoke = useDomainMutation<{ integrationId: string }>(revokeIntegrationFn as never, {
    workspaceId,
    successMessage: "Integración revocada",
    invalidate: [["settings"]],
  });

  const endpoint =
    typeof window === "undefined" ? "/api/public/mcp" : `${window.location.origin}/api/public/mcp`;

  return (
    <section className="panel p-4">
      <h3 className="font-display text-sm font-semibold">Integraciones de agentes (MCP)</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Los agentes leen y escriben con las mismas reglas y auditoría que una persona. El token define
        el espacio de trabajo y los permisos.
      </p>
      <p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">{endpoint}</p>

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
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <span className="label-caps">
                {i.revoked_at
                  ? "revocada"
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
              },
              {
                onSuccess: (data) => {
                  setToken((data as { token?: string }).token ?? null);
                  setName("");
                  setWriteEnabled(false);
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
              void navigator.clipboard?.writeText(token);
              setToken(null);
            }}
          >
            Copiar y ocultar
          </Button>
        </div>
      )}
    </section>
  );
}
