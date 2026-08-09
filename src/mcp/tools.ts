import { z } from "zod";
import type { DomainContext } from "@/domain/shared/context";
import {
  getAttentionItems,
  getClientBrief,
  getTopicTimeline,
  listClients,
  listClientTopics,
  listOpenCommitments,
  searchClientMemory,
} from "@/domain/queries/read";
import { createClient } from "@/domain/clients/actions";
import { addTopicUpdate, createTopic, setTopicNextStep } from "@/domain/topics/actions";
import { completeCommitment, createCommitment } from "@/domain/commitments/actions";

/**
 * MCP tool catalogue. Every tool reuses the shared domain layer — there is no
 * MCP-specific business logic and no generic SQL access.
 */

export type McpToolScope = "read" | "write";

export interface McpTool {
  name: string;
  title: string;
  description: string;
  scope: McpToolScope;
  inputSchema: z.ZodTypeAny;
  /** JSON Schema advertised to MCP clients. */
  jsonSchema: Record<string, unknown>;
  run: (ctx: DomainContext, input: unknown) => Promise<unknown>;
}

const idempotencyKey = { type: "string", description: "Clave de idempotencia opcional" };

function obj(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

const uuid = { type: "string", format: "uuid" };

export const MCP_TOOLS: McpTool[] = [
  {
    name: "list_clients",
    title: "Listar clientes",
    description: "Lista los clientes activos del espacio de trabajo de la integración.",
    scope: "read",
    inputSchema: z.object({}).optional(),
    jsonSchema: obj({}),
    run: (ctx) => listClients(ctx),
  },
  {
    name: "get_client_brief",
    title: "Resumen de cliente",
    description: "Estado actual de un cliente: temas abiertos, bloqueados y compromisos pendientes.",
    scope: "read",
    inputSchema: z.object({ clientId: z.string().uuid() }),
    jsonSchema: obj({ clientId: uuid }, ["clientId"]),
    run: (ctx, input) => getClientBrief(ctx, input),
  },
  {
    name: "list_client_topics",
    title: "Listar temas de un cliente",
    description: "Temas de un cliente, opcionalmente incluyendo resueltos y archivados.",
    scope: "read",
    inputSchema: z.object({ clientId: z.string().uuid(), includeClosed: z.boolean().optional() }),
    jsonSchema: obj({ clientId: uuid, includeClosed: { type: "boolean" } }, ["clientId"]),
    run: (ctx, input) => listClientTopics(ctx, input),
  },
  {
    name: "get_topic_timeline",
    title: "Cronología de un tema",
    description: "Actualizaciones, decisiones, compromisos y fuentes de un tema.",
    scope: "read",
    inputSchema: z.object({ topicId: z.string().uuid() }),
    jsonSchema: obj({ topicId: uuid }, ["topicId"]),
    run: (ctx, input) => getTopicTimeline(ctx, input),
  },
  {
    name: "list_open_commitments",
    title: "Compromisos abiertos",
    description: "Compromisos pendientes del espacio de trabajo, con vencidos primero.",
    scope: "read",
    inputSchema: z.object({}).optional(),
    jsonSchema: obj({}),
    run: (ctx) => listOpenCommitments(ctx, {}),
  },
  {
    name: "get_attention_items",
    title: "Qué requiere atención",
    description: "Clientes y temas que requieren atención, con las razones concretas.",
    scope: "read",
    inputSchema: z.object({
      filter: z.enum(["all", "needs_attention", "waiting_client", "pending_us", "stale"]).optional(),
    }),
    jsonSchema: obj({
      filter: { type: "string", enum: ["all", "needs_attention", "waiting_client", "pending_us", "stale"] },
    }),
    run: (ctx, input) => getAttentionItems(ctx, { filter: "all", ...(input as object) }),
  },
  {
    name: "search_client_memory",
    title: "Buscar en la memoria",
    description: "Busca texto en temas, actualizaciones, decisiones y fuentes.",
    scope: "read",
    inputSchema: z.object({ query: z.string().trim().min(2).max(200) }),
    jsonSchema: obj({ query: { type: "string", minLength: 2 } }, ["query"]),
    run: (ctx, input) => searchClientMemory(ctx, input),
  },
  {
    name: "create_client",
    title: "Crear cliente",
    description: "Crea un cliente en el espacio de trabajo de la integración.",
    scope: "write",
    inputSchema: z.object({
      name: z.string().trim().min(1).max(160),
      description: z.string().trim().max(2000).optional(),
      currentSummary: z.string().trim().max(4000).optional(),
      idempotencyKey: z.string().min(8).max(200).optional(),
    }),
    jsonSchema: obj(
      {
        name: { type: "string" },
        description: { type: "string" },
        currentSummary: { type: "string" },
        idempotencyKey,
      },
      ["name"],
    ),
    run: (ctx, input) => createClient(ctx, input),
  },
  {
    name: "create_topic",
    title: "Crear tema",
    description: "Crea un tema para un cliente.",
    scope: "write",
    inputSchema: z.object({
      clientId: z.string().uuid(),
      title: z.string().trim().min(1).max(200),
      currentState: z.string().trim().max(2000).optional(),
      nextStep: z.string().trim().max(500).optional(),
      idempotencyKey: z.string().min(8).max(200).optional(),
    }),
    jsonSchema: obj(
      {
        clientId: uuid,
        title: { type: "string" },
        currentState: { type: "string" },
        nextStep: { type: "string" },
        idempotencyKey,
      },
      ["clientId", "title"],
    ),
    run: (ctx, input) => createTopic(ctx, input),
  },
  {
    name: "add_topic_update",
    title: "Agregar actualización a un tema",
    description:
      "Operación transaccional: registra la actualización y opcionalmente cambia estado, pelota, próximo paso, decisión, compromiso y fuente.",
    scope: "write",
    inputSchema: z.object({
      topicId: z.string().uuid(),
      content: z.string().trim().min(1).max(5000),
      updateType: z.enum(["note", "fact", "decision", "status_change", "milestone"]).optional(),
      isRelevant: z.boolean().optional(),
      status: z
        .enum(["active", "waiting_client", "pending_us", "blocked", "monitoring", "resolved", "archived"])
        .optional(),
      ballWith: z.enum(["us", "client", "third_party", "nobody"]).optional(),
      currentState: z.string().trim().max(2000).optional(),
      decision: z.string().trim().max(1000).optional(),
      commitment: z
        .object({
          description: z.string().trim().min(1).max(500),
          responsibleParty: z.enum(["us", "client", "third_party"]),
          responsibleName: z.string().trim().max(160).optional(),
          dueAt: z.string().datetime({ offset: true }).optional(),
        })
        .optional(),
      idempotencyKey: z.string().min(8).max(200).optional(),
    }),
    jsonSchema: obj(
      {
        topicId: uuid,
        content: { type: "string" },
        updateType: { type: "string", enum: ["note", "fact", "decision", "status_change", "milestone"] },
        isRelevant: { type: "boolean" },
        status: {
          type: "string",
          enum: ["active", "waiting_client", "pending_us", "blocked", "monitoring", "resolved", "archived"],
        },
        ballWith: { type: "string", enum: ["us", "client", "third_party", "nobody"] },
        currentState: { type: "string" },
        decision: { type: "string" },
        commitment: obj(
          {
            description: { type: "string" },
            responsibleParty: { type: "string", enum: ["us", "client", "third_party"] },
            responsibleName: { type: "string" },
            dueAt: { type: "string", format: "date-time" },
          },
          ["description", "responsibleParty"],
        ),
        idempotencyKey,
      },
      ["topicId", "content"],
    ),
    run: (ctx, input) => addTopicUpdate(ctx, input),
  },
  {
    name: "set_topic_next_step",
    title: "Definir próximo paso",
    description: "Define el próximo paso de un tema, su responsable y su vencimiento.",
    scope: "write",
    inputSchema: z.object({
      topicId: z.string().uuid(),
      nextStep: z.string().trim().max(500).nullable(),
      nextStepOwner: z.enum(["us", "client", "third_party", "nobody"]).optional(),
      nextStepDueAt: z.string().datetime({ offset: true }).nullable().optional(),
      idempotencyKey: z.string().min(8).max(200).optional(),
    }),
    jsonSchema: obj(
      {
        topicId: uuid,
        nextStep: { type: ["string", "null"] },
        nextStepOwner: { type: "string", enum: ["us", "client", "third_party", "nobody"] },
        nextStepDueAt: { type: ["string", "null"], format: "date-time" },
        idempotencyKey,
      },
      ["topicId", "nextStep"],
    ),
    run: (ctx, input) => setTopicNextStep(ctx, input),
  },
  {
    name: "create_commitment",
    title: "Crear compromiso",
    description: "Crea un compromiso dentro de un tema.",
    scope: "write",
    inputSchema: z.object({
      topicId: z.string().uuid(),
      description: z.string().trim().min(1).max(500),
      responsibleParty: z.enum(["us", "client", "third_party"]),
      responsibleName: z.string().trim().max(160).optional(),
      dueAt: z.string().datetime({ offset: true }).optional(),
      idempotencyKey: z.string().min(8).max(200).optional(),
    }),
    jsonSchema: obj(
      {
        topicId: uuid,
        description: { type: "string" },
        responsibleParty: { type: "string", enum: ["us", "client", "third_party"] },
        responsibleName: { type: "string" },
        dueAt: { type: "string", format: "date-time" },
        idempotencyKey,
      },
      ["topicId", "description", "responsibleParty"],
    ),
    run: (ctx, input) => createCommitment(ctx, input),
  },
  {
    name: "complete_commitment",
    title: "Completar compromiso",
    description: "Marca un compromiso como cumplido.",
    scope: "write",
    inputSchema: z.object({
      commitmentId: z.string().uuid(),
      idempotencyKey: z.string().min(8).max(200).optional(),
    }),
    jsonSchema: obj({ commitmentId: uuid, idempotencyKey }, ["commitmentId"]),
    run: (ctx, input) => completeCommitment(ctx, input),
  },
];

export function findTool(name: string): McpTool | undefined {
  return MCP_TOOLS.find((t) => t.name === name);
}
