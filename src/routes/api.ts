import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { type Db, schema } from "../db";
import type { Config } from "../config";
import { apiAuth } from "../auth";
import { createSubscriber } from "../services/subscriber";
import { sendCampaign } from "../services/sender";

const CreateSubscriberSchema = z.object({
  email: z.string().email(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  name: z.string().optional(), // legacy compat
  lists: z.array(z.string()).min(1),
});

export function apiRoutes(db: Db, config: Config) {
  const app = new Hono();

  app.use("/*", apiAuth(config.apiToken));

  app.post("/subscribers", async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = CreateSubscriberSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400);
    }
    const { email, firstName, lastName, name, lists } = parsed.data;
    const fn = firstName ?? name ?? null;
    const ln = lastName ?? null;
    const subscriber = createSubscriber(db, email, fn, ln, lists);
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
