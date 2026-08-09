import { useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createTopicFn } from "@/lib/mutations.functions";
import { useDomainMutation } from "@/lib/use-workspace";
import { PARTY_LABEL, PRIORITY_LABEL, type Party } from "@/domain/shared/vocabulary";

interface NewTopicPayload {
  clientId: string;
  title: string;
  currentState: string;
  nextStep?: string;
  nextStepOwner: Party;
  nextStepDueAt?: string;
  priority: "high" | "medium" | "low";
}

export function NewTopicDialog({
  workspaceId,
  clientId,
  trigger,
}: {
  workspaceId: string;
  clientId: string;
  trigger: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [currentState, setCurrentState] = useState("");
  const [nextStep, setNextStep] = useState("");
  const [owner, setOwner] = useState<Party>("us");
  const [dueAt, setDueAt] = useState("");
  const [priority, setPriority] = useState<"high" | "medium" | "low">("medium");
  const navigate = useNavigate();
  const call = useServerFn(createTopicFn);

  const mutation = useDomainMutation<NewTopicPayload>(call, {
    workspaceId,
    successMessage: "Tema creado",
    invalidate: [["client"], ["dashboard"]],
  });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const result = (await mutation.mutateAsync({
      clientId,
      title: title.trim(),
      currentState: currentState.trim(),
      nextStepOwner: owner,
      priority,
      ...(nextStep.trim() ? { nextStep: nextStep.trim() } : {}),
      ...(dueAt ? { nextStepDueAt: new Date(`${dueAt}T12:00:00Z`).toISOString() } : {}),
    })) as { topic?: { id: string } };
    setOpen(false);
    setTitle("");
    setCurrentState("");
    setNextStep("");
    setDueAt("");
    if (result?.topic?.id) {
      navigate({ to: "/topics/$topicId", params: { topicId: result.topic.id } });
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Nuevo tema</DialogTitle>
          <DialogDescription>
            Un tema siempre declara su estado actual, el siguiente paso y quién lo debe.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="topic-title">Título</Label>
            <Input
              id="topic-title"
              required
              maxLength={160}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Ej. Migración de facturación"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="topic-state">Estado actual</Label>
            <Textarea
              id="topic-state"
              required
              rows={3}
              maxLength={2000}
              value={currentState}
              onChange={(e) => setCurrentState(e.target.value)}
              placeholder="Dónde está el tema hoy, en una frase clara."
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="topic-next">Siguiente paso</Label>
            <Input
              id="topic-next"
              maxLength={300}
              value={nextStep}
              onChange={(e) => setNextStep(e.target.value)}
              placeholder="Qué debe pasar para avanzar"
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label>Responsable</Label>
              <Select value={owner} onValueChange={(v) => setOwner(v as Party)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(PARTY_LABEL) as Party[]).map((party) => (
                    <SelectItem key={party} value={party}>
                      {PARTY_LABEL[party]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Prioridad</Label>
              <Select
                value={priority}
                onValueChange={(v) => setPriority(v as "high" | "medium" | "low")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["high", "medium", "low"] as const).map((p) => (
                    <SelectItem key={p} value={p}>
                      {PRIORITY_LABEL[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="topic-due">Vence</Label>
              <Input
                id="topic-due"
                type="date"
                value={dueAt}
                onChange={(e) => setDueAt(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="submit"
              disabled={mutation.isPending || !title.trim() || !currentState.trim()}
            >
              Crear tema
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
