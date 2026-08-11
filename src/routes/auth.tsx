import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Brain } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/auth")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Entrar a Client Memory" },
      {
        name: "description",
        content: "Accede a tu memoria operativa por cliente: temas, decisiones y compromisos.",
      },
      { property: "og:title", content: "Entrar a Client Memory" },
      { property: "og:description", content: "Accede a tu memoria operativa por cliente." },
    ],
  }),
  validateSearch: (s: Record<string, unknown>): { next?: string } => {
    const next = s['next'];
    // Only same-origin relative paths are preserved through sign-in.
    return typeof next === "string" && next.startsWith("/") ? { next } : {};
  },
  beforeLoad: async ({ search }) => {
    const { data } = await supabase.auth.getUser();
    if (data.user) throw redirect({ href: search.next ?? "/dashboard" });
  },
  component: AuthPage,
});

// Registro público desactivado temporalmente desde el front.
const SIGNUP_ENABLED = false;

function AuthPage() {
  const { next } = Route.useSearch();
  // Preserved destination (e.g. an OAuth consent URL) must survive every path.
  const destination = next ?? "/dashboard";
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [sentConfirmation, setSentConfirmation] = useState(false);

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN" && session) window.location.assign(destination);
    });
    return () => data.subscription.unsubscribe();
  }, [destination]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    try {
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}${destination}` },
        });
        if (error) throw error;
        if (!data.session) {
          setSentConfirmation(true);
          toast.success("Revisa tu correo para confirmar la cuenta.");
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo completar la operación");
    } finally {
      setPending(false);
    }
  }

  async function google() {
    const result = await lovable.auth.signInWithOAuth("google", {
      redirect_uri: `${window.location.origin}${destination}`,
    });
    if (result.error) {
      toast.error("No se pudo iniciar sesión con Google");
      return;
    }
    if (result.redirected) return;
    window.location.assign(destination);
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <span className="mb-3 flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Brain className="size-5" />
          </span>
          <h1 className="font-display text-2xl font-semibold tracking-tight">Client Memory</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Memoria operativa por cliente. Sin ruido, sin pipeline.
          </p>
        </div>

        <div className="panel p-5">
          {sentConfirmation ? (
            <div className="space-y-3 text-sm">
              <p className="text-foreground">Te enviamos un correo de confirmación a {email}.</p>
              <p className="text-muted-foreground">
                Confirma tu cuenta y vuelve aquí para entrar.
              </p>
              <Button variant="secondary" className="w-full" onClick={() => setSentConfirmation(false)}>
                Volver
              </Button>
            </div>
          ) : (
            <>
              <form onSubmit={submit} className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="email">Correo</Label>
                  <Input
                    id="email"
                    type="email"
                    required
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="password">Contraseña</Label>
                  <Input
                    id="password"
                    type="password"
                    required
                    minLength={8}
                    autoComplete={mode === "signup" ? "new-password" : "current-password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
                <Button type="submit" className="w-full" disabled={pending}>
                  {mode === "signup" ? "Crear cuenta" : "Entrar"}
                </Button>
              </form>

              <div className="my-4 flex items-center gap-3">
                <span className="h-px flex-1 bg-border" />
                <span className="label-caps">o</span>
                <span className="h-px flex-1 bg-border" />
              </div>

              <Button variant="secondary" className="w-full" onClick={google}>
                Continuar con Google
              </Button>

              <button
                type="button"
                className="mt-4 w-full text-center text-xs text-muted-foreground underline-offset-4 hover:underline"
                onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
              >
                {mode === "signin" ? "No tengo cuenta" : "Ya tengo cuenta"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
