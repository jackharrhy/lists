import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { type Db, schema } from "../db";
import type { Config } from "../config";
import { apiAuth } from "../auth";
import { createSubscriber } from "../services/subscriber";
import { sendCampaign } from "../services/sender";

export function apiRoutes(db: Db, config: Config) {
  const app = new Hono();

  app.use("/*", apiAuth(config.apiToken));

  app.post("/subscribers", async (c) => {
    const body = await c.req.json();
    const { email, name, lists } = body;

    if (!email || !lists || !Array.isArray(lists) || lists.length === 0) {
      return c.json({ error: "email and lists are required" }, 400);
    }

    const subscriber = createSubscriber(db, email, name ?? null, lists);
    return c.json({ id: subscriber.id, email: subscriber.email }, 201);
  });

  app.get("/subscribers", (c) => {
    const subscribers = db.select().from(schema.subscribers).all();
    return c.json(subscribers);
  });

  app.delete("/subscribers/:id", (c) => {
    const id = Number(c.req.param("id"));
    db.delete(schema.subscribers).where(eq(schema.subscribers.id, id)).run();
    return c.json({ ok: true });
  });

  app.post("/campaigns/:id/send", async (c) => {
    const id = Number(c.req.param("id"));
    try {
      await sendCampaign(db, config, id);
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return c.json({ error: message }, 400);
    }
  });

  return app;
}
