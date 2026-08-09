import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { fetchWorkspaces } from "@/lib/read.functions";

const STORAGE_KEY = "client-memory.workspace";

export type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

/** Throws the domain error message so React Query surfaces it consistently. */
export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

export function useActiveWorkspace() {
  const call = useServerFn(fetchWorkspaces);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    setSelected(window.localStorage.getItem(STORAGE_KEY));
  }, []);

  const query = useQuery({
    queryKey: ["workspaces"],
    queryFn: async () => unwrap(await call({ data: {} })),
  });

  const choose = useCallback((id: string) => {
    window.localStorage.setItem(STORAGE_KEY, id);
    setSelected(id);
  }, []);

  const workspaces = query.data?.workspaces ?? [];
  const active =
    workspaces.find((w) => w.id === selected) ?? workspaces[0] ?? null;

  return { ...query, workspaces, activeWorkspace: active, workspaceId: active?.id, choose, email: query.data?.email ?? null };
}

/** Wraps a mutation server fn with toasts + cache invalidation. */
export function useDomainMutation<TInput>(
  fn: (opts: { data: { workspaceId?: string; payload: TInput } }) => Promise<Result<unknown>>,
  options: { workspaceId?: string; successMessage: string; invalidate?: string[][] },
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: TInput) =>
      unwrap(await fn({ data: { workspaceId: options.workspaceId, payload } })),
    onSuccess: () => {
      toast.success(options.successMessage);
      for (const key of options.invalidate ?? [["dashboard"], ["client"], ["topic"]]) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    },
    onError: (error: Error) => toast.error(error.message),
  });
}
