import { z } from "zod";
import { createHttpApp } from "../http";
import { type Db } from "../db";
import type { Config } from "../config";
import { type Principal } from "../services/access";
import { authenticateBearer } from "../services/request-auth";
import { operationCatalog } from "../operations/catalog";

function errorResponse(c: any, error: unknown) {
  const status = error instanceof z.ZodError ? 400
    : typeof error === "object" && error && "status" in error
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

  app.get("/v1/lists", async (c) => {
    try { return c.json({ data: await operationCatalog.listsList.execute(context(c.principal!), {}) }); }
    catch (error) { return errorResponse(c, error); }
  });
  app.get("/v1/subscribers", async (c) => {
    try {
      const q = c.query as Record<string, string | undefined>;
      return c.json({ data: await operationCatalog.subscribersList.execute(context(c.principal!), q) });
    } catch (error) { return errorResponse(c, error); }
  });
  app.get("/v1/subscribers/:id", async (c) => {
    try { return c.json({ data: await operationCatalog.subscriberGet.execute(context(c.principal!), { id: c.params.id }) }); }
    catch (error) { return errorResponse(c, error); }
  });
  app.post("/v1/subscribers", async (c) => {
    try {
      return c.json({ data: await operationCatalog.subscriberCreate.execute(context(c.principal!), c.body) }, 201);
    } catch (error) { return errorResponse(c, error); }
  });
  app.delete("/v1/subscribers/:id", async (c) => {
    try {
      return c.json({ data: await operationCatalog.subscriberDelete.execute(context(c.principal!), {
        id: c.params.id, confirm: c.query.confirm === "true",
      }) });
    }
    catch (error) { return errorResponse(c, error); }
  });
  app.get("/v1/campaigns", async (c) => {
    try {
      const q = c.query as Record<string, string | undefined>;
      return c.json({ data: await operationCatalog.campaignsList.execute(context(c.principal!), q) });
    } catch (error) { return errorResponse(c, error); }
  });
  app.get("/v1/campaigns/:id", async (c) => {
    try { return c.json({ data: await operationCatalog.campaignGet.execute(context(c.principal!), { id: c.params.id }) }); }
    catch (error) { return errorResponse(c, error); }
  });
  app.post("/v1/campaigns", async (c) => {
    try { return c.json({ data: await operationCatalog.campaignCreateDraft.execute(context(c.principal!), c.body) }, 201); }
    catch (error) { return errorResponse(c, error); }
  });
  app.post("/v1/campaigns/:id/send", async (c) => {
    try {
      const body = c.body as Record<string, unknown>;
      return c.json({ data: await operationCatalog.campaignSend.execute(context(c.principal!), {
        id: c.params.id, confirm: body.confirm,
      }) });
    } catch (error) { return errorResponse(c, error); }
  });
  app.get("/v1/deliverability", async (c) => {
    try { return c.json({ data: await operationCatalog.deliverabilitySummary.execute(context(c.principal!), {}) }); }
    catch (error) { return errorResponse(c, error); }
  });
  app.get("/v1/dmarc", async (c) => {
    try { return c.json({ data: await operationCatalog.dmarcSummary.execute(context(c.principal!), {}) }); }
    catch (error) { return errorResponse(c, error); }
  });

  return app;
}
