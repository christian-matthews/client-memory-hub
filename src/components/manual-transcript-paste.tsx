import { useState } from "react";
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
import { createManualIngestionFn } from "@/lib/mutations.functions";
import { useDomainMutation } from "@/lib/use-workspace";

interface ManualTranscriptPasteProps {
  clients: { id: string; name: string }[];
  workspaceId?: string | undefined;
  canManage: boolean;
}

export function ManualTranscriptPaste({ clients, workspaceId, canManage }: ManualTranscriptPasteProps) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [transcript, setTranscript] = useState("");
  const [clientId, setClientId] = useState("");

  const create = useDomainMutation<{ title: string | undefined; transcript: string; clientId: string | undefined }>(
    createManualIngestionFn as never,
    {
      workspaceId,
      successMessage: "Transcripción guardada en la bandeja",
      invalidate: [["meetings"], ["meeting-detail"], ["dashboard"], ["client"], ["topic"]],
    },
  );

  if (!canManage) return null;

  const chars = transcript.length;
  const MAX_CHARS = 200000;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm">
          Pegar transcripción
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Pegar transcripción manualmente</DialogTitle>
          <DialogDescription>
            Crea evidencia inmutable en la bandeja. Funciona igual que el webhook de MacWhisper, pero
            sin depender de la app de macOS.
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-4 py-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!transcript.trim()) return;
            create.mutate(
              {
                title: title.trim() || undefined,
                transcript: transcript.trim(),
                clientId: clientId || undefined,
              },
              {
                onSuccess: () => {
                  setOpen(false);
                  setTitle("");
                  setTranscript("");
                  setClientId("");
                },
              },
            );
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="manual-title" className="text-xs">
              Título de la reunión (opcional)
            </Label>
            <Input
              id="manual-title"
              value={title}
              maxLength={300}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Reunión semanal FACTORIT"
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="manual-client" className="text-xs">
              Cliente (opcional)
            </Label>
            <select
              id="manual-client"
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
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

          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="manual-transcript" className="text-xs">
                Texto de la transcripción
              </Label>
              <span className="text-[11px] text-muted-foreground">
                {chars.toLocaleString("es")} / {MAX_CHARS.toLocaleString("es")}
              </span>
            </div>
            <Textarea
              id="manual-transcript"
              value={transcript}
              onChange={(event) => setTranscript(event.target.value)}
              rows={12}
              spellCheck={false}
              placeholder="Pega aquí el texto completo de la transcripción..."
              className="font-mono text-xs"
              aria-label="Texto de la transcripción"
            />
            <p className="text-[11px] text-muted-foreground">
              Si pegas el mismo texto dos vez en el mismo espacio de trabajo, la segunda se detecta
              como duplicado y no se crea una nueva reunión.
            </p>
          </div>

          <DialogFooter>
            <Button
              type="submit"
              disabled={create.isPending || !transcript.trim() || chars > MAX_CHARS}
            >
              {create.isPending ? "Guardando…" : "Guardar en bandeja"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
