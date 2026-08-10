import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";

/**
 * OAuth 2.1 consent screen. Supabase Auth (the authorization server) redirects
 * the user here so they can approve or deny an MCP client (Claude, ChatGPT,
 * Cursor…) before it receives a user-scoped access token.
 */

export const Route = createFileRoute("/.lovable/oauth/consent")({
  // Browser-only: the session lives in localStorage, absent during SSR.
  ssr: false,
  validateSearch: (s: Record<string, unknown>) => ({
    authorization_id: typeof s['authorization_id'] === "string" ? s['authorization_id'] : "",
  }),
  beforeLoad: async ({ search, location }) => {
    if (!search.authorization_id) throw new Error("Falta authorization_id");
    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      throw redirect({
        to: "/auth",
        search: { next: location.pathname + location.searchStr },
      });
    }
  },
  loader: async ({ location }) => {
    const authorizationId = new URLSearchParams(location.search).get("authorization_id")!;
    const oauth = (supabase.auth as unknown as OAuthNamespace).oauth;
    const { data, error } = await oauth.getAuthorizationDetails(authorizationId);
    if (error) throw error;
    const immediate = data?.redirect_url ?? data?.redirect_to;
    if (immediate && !data?.client) throw redirect({ href: immediate });
    return data ?? null;
  },
  component: Consent,
  errorComponent: ({ error }) => (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="panel max-w-sm p-5 text-sm">
        <h1 className="font-display text-base font-semibold">No se pudo cargar la autorización</h1>
        <p className="mt-2 text-muted-foreground">
          {String((error as Error)?.message ?? error)}
        </p>
      </div>
    </main>
  ),
});

interface AuthorizationDetails {
  client?: { name?: string | null; client_id?: string | null } | null;
  redirect_url?: string | null;
  redirect_to?: string | null;
  scope?: string | null;
}

interface OAuthNamespace {
  oauth: {
    getAuthorizationDetails: (
      id: string,
    ) => Promise<{ data: AuthorizationDetails | null; error: Error | null }>;
    approveAuthorization: (
      id: string,
    ) => Promise<{ data: AuthorizationDetails | null; error: Error | null }>;
    denyAuthorization: (
      id: string,
    ) => Promise<{ data: AuthorizationDetails | null; error: Error | null }>;
  };
}

function Consent() {
  const details = Route.useLoaderData();
  const { authorization_id } = Route.useSearch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clientName = details?.client?.name ?? "esta aplicación";

  async function decide(approve: boolean) {
    setBusy(true);
    setError(null);
    const oauth = (supabase.auth as unknown as OAuthNamespace).oauth;
    const { data, error: err } = approve
      ? await oauth.approveAuthorization(authorization_id)
      : await oauth.denyAuthorization(authorization_id);
    if (err) {
      setBusy(false);
      setError(err.message);
      return;
    }
    const target = data?.redirect_url ?? data?.redirect_to;
    if (!target) {
      setBusy(false);
      setError("El servidor de autorización no devolvió una URL de retorno.");
      return;
    }
    window.location.href = target;
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="panel w-full max-w-sm p-5">
        <h1 className="font-display text-lg font-semibold tracking-tight">
          Conectar {clientName} a tu cuenta
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {clientName} podrá usar las herramientas de Client Memory actuando como tú: leer clientes,
          temas y compromisos, y registrar actualizaciones.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Esto no salta los permisos de la aplicación: tus reglas de acceso y la auditoría siguen
          aplicando.
        </p>
        {details?.scope && (
          <p className="mt-2 font-mono text-[11px] text-muted-foreground">{details.scope}</p>
        )}
        {error && (
          <p role="alert" className="mt-3 text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="mt-5 grid gap-2">
          <Button disabled={busy} onClick={() => void decide(true)}>
            Aprobar
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => void decide(false)}>
            Cancelar conexión
          </Button>
        </div>
      </div>
    </main>
  );
}
