GRANT EXECUTE ON FUNCTION public.is_workspace_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_workspace_admin(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_role_of(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_default_workspace() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_workspace_member(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.is_workspace_admin(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.workspace_role_of(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.ensure_default_workspace() TO service_role;