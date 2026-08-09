import { useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createClientFn } from "@/lib/mutations.functions";
import { useDomainMutation } from "@/lib/use-workspace";
import { useServerFn } from "@tanstack/react-start";

export function NewClientDialog({
  workspaceId,
  trigger,
}: {
  workspaceId: string;
  trigger: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [context, setContext] = useState("");
  const navigate = useNavigate();
  const call = useServerFn(createClientFn);

  const mutation = useDomainMutation<{ name: string; contextNotes?: string }>(call, {
    workspaceId,
    successMessage: "Cliente creado",
    invalidate: [["dashboard"]],
  });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const result = (await mutation.mutateAsync({
      name: name.trim(),
      ...(context.trim() ? { contextNotes: context.trim() } : {}),
    })) as { client?: { id: string } };
    setOpen(false);
    setName("");
    setContext("");
    if (result?.client?.id) {
      navigate({ to: "/clients/$clientId", params: { clientId: result.client.id } });
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nuevo cliente</DialogTitle>
          <DialogDescription>
            Un cliente agrupa temas, decisiones, compromisos y evidencia.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="client-name">Nombre</Label>
            <Input
              id="client-name"
              required
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ej. Grupo Andina"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="client-context">Contexto estable (opcional)</Label>
            <Textarea
              id="client-context"
              rows={3}
              maxLength={2000}
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder="Qué hace, quién decide, cómo se trabaja con ellos."
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={mutation.isPending || name.trim().length === 0}>
              Crear cliente
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
