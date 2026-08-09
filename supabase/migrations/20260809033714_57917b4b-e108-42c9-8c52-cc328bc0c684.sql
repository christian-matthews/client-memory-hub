CREATE POLICY "source_derivatives_insert_members"
ON public.source_derivatives
FOR INSERT
TO authenticated
WITH CHECK (public.is_workspace_member(workspace_id));