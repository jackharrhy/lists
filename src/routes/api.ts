import { z } from "zod";
import { createHttpApp } from "../http";
import { type Db } from "../db";
import type { Config } from "../config";
import { type Principal } from "../services/access";
import { authenticateBearer } from "../services/request-auth";
import { createSubscriber } from "../services/subscriber";
import {
  createCampaignDraft, deleteSubscriber, getCampaign, getDeliverabilitySummary, getDmarcSummary,
  getSubscriber, listCampaigns, listLists, listSubscribers, sendCampaignOperation,
} from "../operations";

const CreateSubscriberSchema = z.object({
  email: z.string().email(), firstName: z.string().max(255).optional(),
  lastName: z.string().max(255).optional(), name: z.string().max(255).optional(),
  lists: z.array(z.string()).min(1),
});

const CreateCampaignSchema = z.object({
  subject: z.string().min(1), bodyMarkdown: z.string().min(1), fromAddress: z.string().email(),
  fromName: z.string().optional().nullable(), audienceType: z.enum(["list", "tag", "all", "subscribers"]),
  audienceId: z.number().int().positive().optional().nullable(), audienceData: z.unknown().optional(),
});

function errorResponse(c: any, error: unknown) {
  const status = typeof error === "object" && error && "status" in error
    ? Number((error as { status: number }).status) : 500;
  const message = error instanceof Error ? error.message : "Internal server error";
  if (status >= 500) console.error(error);
  return c.json({ error: message }, status);
}

export function apiRoutes(db: Db, config: Config) {
  const app = createHttpApp()
    .derive(({ request }) => ({ principal: authenticateBearer(db, request) }))
    .onBeforeHandle(({ principal, status }) => {
      if (!principal) return status(401, "Unauthorized");
    });
  const context = (principal: Principal) => ({ db, config, principal });

  app.get("/v1/lists", (c) => {
    try { return c.json({ data: listLists(context(c.principal!)) }); }
    catch (error) { return errorResponse(c, error); }
  });
  app.get("/v1/subscribers", (c) => {
    try {
      const q = c.query as Record<string, string | undefined>;
      return c.json({ data: listSubscribers(context(c.principal!), {
        limit: q.limit ? Number(q.limit) : undefined, offset: q.offset ? Number(q.offset) : undefined, status: q.status,
      }) });
    } catch (error) { return errorResponse(c, error); }
  });
  app.get("/v1/subscribers/:id", (c) => {
    try { return c.json({ data: getSubscriber(context(c.principal!), Number(c.params.id)) }); }
    catch (error) { return errorResponse(c, error); }
  });
  app.post("/v1/subscribers", (c) => {
    try {
      if (!c.principal!.scopes.has("subscribers:write")) return c.json({ error: "Missing scope: subscribers:write" }, 403);
      const parsed = CreateSubscriberSchema.parse(c.body);
      const subscriber = createSubscriber(db, parsed.email, parsed.firstName ?? parsed.name ?? null, parsed.lastName ?? null, parsed.lists);
      return c.json({ data: { id: subscriber.id, email: subscriber.email } }, 201);
    } catch (error) { return errorResponse(c, error); }
  });
  app.delete("/v1/subscribers/:id", (c) => {
    try { return c.json({ data: deleteSubscriber(context(c.principal!), Number(c.params.id), c.query.confirm === "true") }); }
    catch (error) { return errorResponse(c, error); }
  });
  app.get("/v1/campaigns", (c) => {
    try {
      const q = c.query as Record<string, string | undefined>;
      return c.json({ data: listCampaigns(context(c.principal!), {
        limit: q.limit ? Number(q.limit) : undefined, offset: q.offset ? Number(q.offset) : undefined,
      }) });
    } catch (error) { return errorResponse(c, error); }
  });
  app.get("/v1/campaigns/:id", (c) => {
    try { return c.json({ data: getCampaign(context(c.principal!), Number(c.params.id)) }); }
    catch (error) { return errorResponse(c, error); }
  });
  app.post("/v1/campaigns", (c) => {
    try { return c.json({ data: createCampaignDraft(context(c.principal!), CreateCampaignSchema.parse(c.body)) }, 201); }
    catch (error) { return errorResponse(c, error); }
  });
  app.post("/v1/campaigns/:id/send", async (c) => {
    try {
      z.object({ confirm: z.literal(true) }).parse(c.body);
      return c.json({ data: await sendCampaignOperation(context(c.principal!), Number(c.params.id), true) });
    } catch (error) { return errorResponse(c, error); }
  });
  app.get("/v1/deliverability", (c) => {
    try { return c.json({ data: getDeliverabilitySummary(context(c.principal!)) }); }
    catch (error) { return errorResponse(c, error); }
  });
  app.get("/v1/dmarc", (c) => {
    try { return c.json({ data: getDmarcSummary(context(c.principal!)) }); }
    catch (error) { return errorResponse(c, error); }
  });

  return app;
}
