import { z } from "zod";
import { defineTool, ToolError, type ToolContext } from "@lovable.dev/mcp-js";
import { MCP_TOOLS, type McpTool } from "@/mcp/tools";
import { createDomainContext, type Db } from "@/domain/shared/context";
import { normalizeError } from "@/domain/shared/errors";
import { supabaseForUser } from "./supabase";

/**
 * Bridges the existing domain tool catalogue (`src/mcp/tools.ts`) to
 * `@lovable.dev/mcp-js`. There is no MCP-specific business logic: each tool
 * runs the same domain action the web app uses, as the signed-in user, so RLS
 * and auditing behave identically.
 */

/** Extracts the raw zod shape mcp-js expects from our `z.object(...)` schemas. */
function rawShape(schema: z.ZodTypeAny): z.ZodRawShape {
  let current: z.ZodTypeAny = schema;
  // Unwrap optional/nullable/default wrappers.
  while (
    current instanceof z.ZodOptional ||
    current instanceof z.ZodNullable ||
    current instanceof z.ZodDefault
  ) {
    current = (current as unknown as { unwrap: () => z.ZodTypeAny }).unwrap();
  }
  if (current instanceof z.ZodObject) return current.shape as z.ZodRawShape;
  return {};
}

async function runDomainTool(tool: McpTool, ctx: ToolContext, input: unknown) {
  if (!ctx.isAuthenticated()) throw new ToolError("No autenticado");
  const db = supabaseForUser(ctx) as unknown as Db;
  const email = ctx.getUserEmail();
  const domainCtx = await createDomainContext({
    db,
    actor: {
      type: "user",
      userId: ctx.getUserId() ?? null,
      name: email ?? null,
      channel: "mcp",
    },
  });
  return tool.run(domainCtx, input);
}

function toMcpTool(tool: McpTool) {
  return defineTool({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: rawShape(tool.inputSchema),
    annotations:
      tool.scope === "read"
        ? { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
        : { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: async (input: unknown, ctx: ToolContext) => {
      try {
        const data = await runDomainTool(tool, ctx, input ?? {});
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data) }],
        };
      } catch (error) {
        if (error instanceof ToolError) throw error;
        const normalized = normalizeError(error);
        return {
          content: [{ type: "text" as const, text: normalized.message }],
          isError: true,
        };
      }
    },
  });
}

export const mcpTools = MCP_TOOLS.map(toMcpTool);
