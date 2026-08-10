import { auth, defineMcp } from "@lovable.dev/mcp-js";
import { mcpTools } from "./tools";

/**
 * MCP server definition. The Vite plugin (`mcpPlugin()`) generates the HTTP
 * route and the OAuth metadata route from this file — do not hand-write them.
 *
 * Auth: Supabase OAuth 2.1. Each MCP client connects as a real app user, so
 * every tool runs under that user's RLS policies and workspace membership.
 */

// The issuer must be the direct Supabase host: on publish `SUPABASE_URL` is
// rewritten to a proxy that fails the RFC 8414 issuer check. The project ref is
// inlined at build time by Vite.
const projectRef = import.meta.env['VITE_SUPABASE_PROJECT_ID'] ?? "project-ref-unset";

export default defineMcp({
  name: "client-compass",
  title: "Client Compass",
  version: "0.1.0",
  instructions:
    "Memoria operativa por cliente. Usa las herramientas de lectura para conocer el estado (clientes, temas, compromisos, atención, búsqueda) antes de escribir. Las escrituras registran auditoría y respetan los permisos del usuario conectado.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: mcpTools as never,
});
