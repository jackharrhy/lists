import { z } from "zod";
import { createHttpApp } from "../http";
import type { Db } from "../db";
import type { Config } from "../config";
import { authenticateBearer } from "../services/request-auth";
import type { Principal } from "../services/access";
import {
  createCampaignDraft, deleteSubscriber, getCampaign, getDeliverabilitySummary, getDmarcSummary,
  getSubscriber, listCampaigns, listLists, listSubscribers, sendCampaignOperation,
} from "../operations";

const tools = [
  { name: "lists_list", description: "List mailing lists visible to the authenticated user.", inputSchema: { type: "object", properties: {} } },
  { name: "subscribers_list", description: "List subscribers without exposing unsubscribe tokens.", inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 200 }, offset: { type: "integer", minimum: 0 }, status: { enum: ["active", "blocklisted"] } } } },
  { name: "subscriber_get", description: "Get a subscriber and visible list memberships.", inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } },
  { name: "subscriber_delete", description: "Delete one subscriber and dependent records. Requires subscribers:write and confirm=true.", inputSchema: { type: "object", properties: { id: { type: "integer" }, confirm: { const: true } }, required: ["id", "confirm"] } },
  { name: "campaigns_list", description: "List visible campaigns.", inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 200 }, offset: { type: "integer", minimum: 0 } } } },
  { name: "campaign_get", description: "Get a campaign and its delivery counts.", inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } },
  { name: "campaign_create_draft", description: "Create a campaign draft. This never sends mail.", inputSchema: { type: "object", properties: { subject: { type: "string" }, bodyMarkdown: { type: "string" }, fromAddress: { type: "string" }, fromName: { type: ["string", "null"] }, audienceType: { enum: ["list", "tag", "all", "subscribers"] }, audienceId: { type: ["integer", "null"] }, audienceData: {} }, required: ["subject", "bodyMarkdown", "fromAddress", "audienceType"] } },
  { name: "campaign_send", description: "Send a campaign. Requires campaigns:send scope and confirm=true.", inputSchema: { type: "object", properties: { id: { type: "integer" }, confirm: { const: true } }, required: ["id", "confirm"] } },
  { name: "deliverability_summary", description: "Summarize delivery lifecycle states and provider events.", inputSchema: { type: "object", properties: {} } },
  { name: "dmarc_summary", description: "Summarize DMARC reports for visible sending domains.", inputSchema: { type: "object", properties: {} } },
] as const;

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

async function callTool(db: Db, config: Config, principal: Principal, name: string, args: any) {
  const ctx = { db, config, principal };
  const value = name === "lists_list" ? listLists(ctx)
    : name === "subscribers_list" ? listSubscribers(ctx, args)
    : name === "subscriber_get" ? getSubscriber(ctx, Number(args.id))
    : name === "subscriber_delete" ? deleteSubscriber(ctx, Number(args.id), args.confirm === true)
    : name === "campaigns_list" ? listCampaigns(ctx, args)
    : name === "campaign_get" ? getCampaign(ctx, Number(args.id))
    : name === "campaign_create_draft" ? createCampaignDraft(ctx, args)
    : name === "campaign_send" ? await sendCampaignOperation(ctx, Number(args.id), args.confirm === true)
    : name === "deliverability_summary" ? getDeliverabilitySummary(ctx)
    : name === "dmarc_summary" ? getDmarcSummary(ctx)
    : undefined;
  if (value === undefined) throw Object.assign(new Error(`Unknown tool: ${name}`), { status: 404 });
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

export function mcpRoutes(db: Db, config: Config) {
  const app = createHttpApp();
  app.post("/", async (c) => {
    const principal = authenticateBearer(db, c.request);
    if (!principal) {
      return new Response(JSON.stringify(rpcError(null, -32001, "Unauthorized")), {
        status: 401, headers: { "content-type": "application/json", "www-authenticate": `Bearer resource_metadata="${config.baseUrl}/.well-known/oauth-protected-resource"` },
      });
    }
    const parsed = RpcRequest.safeParse(c.body);
    if (!parsed.success) return c.json(rpcError(null, -32600, "Invalid Request"), 400);
    const request = parsed.data;
    if (request.method === "initialize") return c.json(result(request.id, {
      protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "lists", version: "1.0.0" },
    }));
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (request.method === "tools/list") return c.json(result(request.id, { tools }));
    if (request.method === "tools/call") {
      const params = request.params ?? {};
      try {
        return c.json(result(request.id, await callTool(db, config, principal, String(params.name ?? ""), params.arguments ?? {})));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Tool failed";
        return c.json(result(request.id, { content: [{ type: "text", text: message }], isError: true }));
      }
    }
    return c.json(rpcError(request.id, -32601, "Method not found"), 404);
  });
  app.get("/", () => new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } }));
  return app;
}
