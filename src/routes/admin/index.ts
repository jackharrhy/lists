import { Hono } from "hono";
import type { Db } from "../../db";
import type { Config } from "../../config";
import { adminAuth } from "../../auth";
import { mountAuthRoutes } from "./auth";
import { mountDashboardRoutes } from "./dashboard";
import { mountSubscriberRoutes } from "./subscribers";
import { mountListRoutes } from "./lists";
import { mountCampaignRoutes } from "./campaigns";
import { mountMessageRoutes } from "./messages";
import { mountActivityRoutes } from "./activity";
import { mountTagRoutes } from "./tags";
import { mountImportRoutes } from "./import";
import { mountUserRoutes } from "./users";

export function adminRoutes(db: Db, config: Config) {
  const app = new Hono();

  mountAuthRoutes(app, db, config);

  // Protected routes
  app.use("/*", adminAuth(db));

  mountCampaignRoutes(app, db, config);
  mountDashboardRoutes(app, db, config);
  mountSubscriberRoutes(app, db, config);
  mountListRoutes(app, db, config);
  mountMessageRoutes(app, db, config);
  mountActivityRoutes(app, db, config);
  mountTagRoutes(app, db, config);
  mountImportRoutes(app, db, config);
  mountUserRoutes(app, db, config);

  return app;
}
