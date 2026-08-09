import { describe, expect, it, vi } from "vitest";
import { handleMcpBody, handleMcpMessage, JSONRPC_ERROR } from "./handler";
import { MCP_TOOLS } from "./tools";

/**
 * Transport + authorization tests. The domain layer is stubbed: what matters
 * here is that no tool ever runs without a valid credential and that scopes
 * are enforced before the domain is touched.
 */

vi.mock("@/domain/shared/audit", () => ({ recordActivity: vi.fn(async () => {}) }));

const auth = vi.hoisted(() => ({ impl: vi.fn() }));
vi.mock("@/domain/integrations/actions", () => ({
  authenticateIntegration: (...args: unknown[]) => auth.impl(...args),
}));

const deps = { db: {} as never };

function readOnly() {
  auth.impl.mockResolvedValue({
    ok: true,
    integration: { id: "i1", workspaceId: "w1", name: "Agente", scopes: ["read"], writeEnabled: false },
  });
}
function readWrite() {
  auth.impl.mockResolvedValue({
    ok: true,
    integration: {
      id: "i1",
      workspaceId: "w1",
      name: "Agente",
      scopes: ["read", "write"],
      writeEnabled: true,
    },
  });
}

function req(method: string, params?: unknown, id: string | number = 1) {
  return { jsonrpc: "2.0" as const, id, method, ...(params === undefined ? {} : { params }) };
}

describe("handshake", () => {
  it("initialize no requiere token", async () => {
    auth.impl.mockResolvedValue({ ok: false, reason: "missing_token" });
    const res = await handleMcpMessage(req("initialize"), null, deps);
    expect(res?.error).toBeUndefined();
    expect((res?.result as { serverInfo: { name: string } }).serverInfo.name).toBe("client-memory");
    expect(auth.impl).not.toHaveBeenCalled();
  });

  it("rechaza mensajes que no son JSON-RPC 2.0", async () => {
    const res = await handleMcpMessage({ method: "initialize" }, null, deps);
    expect(res?.error?.code).toBe(JSONRPC_ERROR.invalidRequest);
  });

  it("las notificaciones no producen respuesta", async () => {
    expect(await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, null, deps)).toBeNull();
  });
});

describe("autenticación", () => {
  for (const reason of ["missing_token", "invalid_token", "revoked_token", "expired_token"] as const) {
    it(`rechaza tools/list con ${reason}`, async () => {
      auth.impl.mockResolvedValue({ ok: false, reason });
      const res = await handleMcpMessage(req("tools/list"), null, deps);
      expect(res?.error?.code).toBe(JSONRPC_ERROR.unauthorized);
      expect((res?.error?.data as { reason: string }).reason).toBe(reason);
    });
  }

  it("no ejecuta ninguna herramienta sin credencial válida", async () => {
    auth.impl.mockResolvedValue({ ok: false, reason: "invalid_token" });
    const spy = vi.spyOn(MCP_TOOLS[0]!, "run");
    const res = await handleMcpMessage(
      req("tools/call", { name: MCP_TOOLS[0]!.name, arguments: {} }),
      "Bearer nope",
      deps,
    );
    expect(res?.error?.code).toBe(JSONRPC_ERROR.unauthorized);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("scopes", () => {
  it("tools/list oculta las herramientas de escritura en integraciones de lectura", async () => {
    readOnly();
    const res = await handleMcpMessage(req("tools/list"), "Bearer x", deps);
    const names = (res?.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(names).toContain("get_attention_items");
    expect(names).not.toContain("add_topic_update");
  });

  it("rechaza una herramienta de escritura sin scope de escritura", async () => {
    readOnly();
    const spy = vi.spyOn(MCP_TOOLS.find((t) => t.name === "create_client")!, "run");
    const res = await handleMcpMessage(
      req("tools/call", { name: "create_client", arguments: { name: "Acme" } }),
      "Bearer x",
      deps,
    );
    expect(res?.error?.code).toBe(JSONRPC_ERROR.forbidden);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("rechaza escritura cuando write_enabled está apagado aunque el scope exista", async () => {
    auth.impl.mockResolvedValue({
      ok: true,
      integration: {
        id: "i1",
        workspaceId: "w1",
        name: "Agente",
        scopes: ["read", "write"],
        writeEnabled: false,
      },
    });
    const res = await handleMcpMessage(
      req("tools/call", { name: "create_client", arguments: { name: "Acme" } }),
      "Bearer x",
      deps,
    );
    expect(res?.error?.code).toBe(JSONRPC_ERROR.forbidden);
  });
});

describe("tools/call", () => {
  it("usa el workspace de la credencial y no el argumento del agente", async () => {
    readWrite();
    const tool = MCP_TOOLS.find((t) => t.name === "list_clients")!;
    const spy = vi.spyOn(tool, "run").mockResolvedValue({ clients: [] });
    await handleMcpMessage(
      req("tools/call", { name: "list_clients", arguments: { workspaceId: "otro" } }),
      "Bearer x",
      deps,
    );
    expect(spy.mock.calls[0]?.[0].workspaceId).toBe("w1");
    expect(spy.mock.calls[0]?.[0].actor.type).toBe("integration");
    spy.mockRestore();
  });

  it("valida argumentos y devuelve invalidParams", async () => {
    readOnly();
    const res = await handleMcpMessage(
      req("tools/call", { name: "get_client_brief", arguments: { clientId: "no-uuid" } }),
      "Bearer x",
      deps,
    );
    expect(res?.error?.code).toBe(JSONRPC_ERROR.invalidParams);
  });

  it("devuelve herramienta desconocida como methodNotFound", async () => {
    readOnly();
    const res = await handleMcpMessage(req("tools/call", { name: "drop_database" }), "Bearer x", deps);
    expect(res?.error?.code).toBe(JSONRPC_ERROR.methodNotFound);
  });

  it("convierte errores de dominio en isError sin filtrar detalles internos", async () => {
    readOnly();
    const tool = MCP_TOOLS.find((t) => t.name === "list_clients")!;
    const spy = vi.spyOn(tool, "run").mockRejectedValue(new Error("boom"));
    const res = await handleMcpMessage(req("tools/call", { name: "list_clients" }), "Bearer x", deps);
    const result = res?.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).not.toContain("boom");
    spy.mockRestore();
  });

  it("devuelve el resultado como texto y structuredContent", async () => {
    readOnly();
    const tool = MCP_TOOLS.find((t) => t.name === "list_clients")!;
    const spy = vi.spyOn(tool, "run").mockResolvedValue({ clients: [{ id: "c1" }] });
    const res = await handleMcpMessage(req("tools/call", { name: "list_clients" }), "Bearer x", deps);
    const result = res?.result as { structuredContent: unknown; content: Array<{ text: string }> };
    expect(result.structuredContent).toEqual({ clients: [{ id: "c1" }] });
    expect(JSON.parse(result.content[0]!.text)).toEqual({ clients: [{ id: "c1" }] });
    spy.mockRestore();
  });
});

describe("lotes", () => {
  it("responde un arreglo y descarta notificaciones", async () => {
    readOnly();
    const res = await handleMcpBody(
      [req("initialize", undefined, 1), { jsonrpc: "2.0", method: "notifications/initialized" }],
      "Bearer x",
      deps,
    );
    expect(Array.isArray(res)).toBe(true);
    expect((res as unknown[]).length).toBe(1);
  });
});

describe("catálogo", () => {
  it("toda herramienta tiene nombre único, título, descripción y esquema", () => {
    const names = MCP_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of MCP_TOOLS) {
      expect(tool.title.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.jsonSchema['type']).toBe("object");
    }
  });

  it("no expone ninguna herramienta de SQL o acceso genérico", () => {
    for (const name of MCP_TOOLS.map((t) => t.name)) {
      expect(name).not.toMatch(/sql|query_raw|execute|admin/i);
    }
  });
});
