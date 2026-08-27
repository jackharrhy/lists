import { staticPlugin } from "@elysia/static";
import { createHttpApp } from "./http";
import { loadConfig } from "./config";
import { createDb } from "./db";
import { publicRoutes } from "./routes/public";
import { apiRoutes } from "./routes/api";
import { webhookRoutes } from "./routes/webhooks";
import { adminRoutes } from "./routes/admin/index";
import { mountDesignRoutes } from "./routes/admin/design";
import { startPoller } from "./services/poller";
import { startScheduler } from "./services/scheduler";
import { bootstrapOwner } from "./bootstrap";
import { startDeliveryWorker } from "./services/delivery-worker";
import { mcpRoutes } from "./routes/mcp";
import { oauthRoutes } from "./routes/oauth";

const config = loadConfig();
const db = createDb(config.dbPath);
await bootstrapOwner(db, config);

const app = createHttpApp();
mountDesignRoutes(app);

app
  .use(staticPlugin({ assets: "public", prefix: "/static" }))
  .get("/health", () => ({ ok: true }))
  .get("/", ({ redirect }) => redirect("/subscribe", 302))
  .use(oauthRoutes(db, config))
  .use(publicRoutes(db, config))
  .group("/webhooks", (app) => app.use(webhookRoutes(db)))
  .group("/api", (app) => app.use(apiRoutes(db, config)))
  .group("/mcp", (app) => app.use(mcpRoutes(db, config)))
  .group("/admin", (app) => app.use(adminRoutes(db, config)));

startPoller(db, config).catch((err) => {
  console.error("Poller crashed:", err);
  process.exit(1);
});

startScheduler(db, config).catch((err) => {
  console.error("Scheduler crashed:", err);
  process.exit(1);
});

startDeliveryWorker(db, config).catch((err) => {
  console.error("Delivery worker crashed:", err);
  process.exit(1);
});

console.log("lists running on :8080");
app.listen(8080);

export default app;
