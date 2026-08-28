import { z } from "zod";
import { createHttpApp } from "../http";
import type { Db } from "../db";
import type { Config } from "../config";
import { authenticateBearer } from "../services/request-auth";
import { mcpOperations, mcpTools } from "../operations/catalog";

const RpcRequest = z.object({
  jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(), params: z.record(z.string(), z.unknown()).optional(),
});

function result(id: unknown, value: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result: value };
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function unauthorized(config: Config) {
  return new Response(JSON.stringify(rpcError(null, -32001, "Unauthorized")), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": `Bearer resource_metadata="${config.baseUrl}/.well-known/oauth-protected-resource"`,
    },
  });
}

export function mcpRoutes(db: Db, config: Config) {
  const app = createHttpApp();
  app.post("/", async (c) => {
    const principal = authenticateBearer(db, c.request);
    if (!principal) return unauthorized(config);
    const parsed = RpcRequest.safeParse(c.body);
    if (!parsed.success) return c.json(rpcError(null, -32600, "Invalid Request"), 400);
    const request = parsed.data;
    if (request.method === "initialize") return c.json(result(request.id, {
      protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "lists", version: "1.0.0" },
    }));
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (request.method === "tools/list") return c.json(result(request.id, { tools: mcpTools }));
    if (request.method === "tools/call") {
      const params = request.params ?? {};
      try {
        const operation = mcpOperations.get(String(params.name ?? ""));
        if (!operation) throw Object.assign(new Error(`Unknown tool: ${String(params.name ?? "")}`), { status: 404 });
        const value = await operation.execute({ db, config, principal }, params.arguments ?? {});
        return c.json(result(request.id, {
          content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
          structuredContent: value,
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Tool failed";
        return c.json(result(request.id, { content: [{ type: "text", text: message }], isError: true }));
      }
    }
    return c.json(rpcError(request.id, -32601, "Method not found"), 404);
  });
  app.get("/", (c) => authenticateBearer(db, c.request)
    ? new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } })
    : unauthorized(config));
  return app;
}
