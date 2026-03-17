import { Hono } from "hono";
import { trimTrailingSlash } from "hono/trailing-slash";
import { serveStatic } from "hono/bun";
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

const config = loadConfig();
const db = createDb(config.dbPath);
await bootstrapOwner(db, config);

const app = new Hono();

app.use(trimTrailingSlash());
app.use("/static/*", serveStatic({ root: "./public", rewriteRequestPath: (p) => p.replace("/static", "") }));

app.get("/", (c) => c.redirect("/subscribe"));
app.route("/", publicRoutes(db, config));
app.route("/webhooks", webhookRoutes(db));
app.route("/api", apiRoutes(db, config));
app.route("/admin", adminRoutes(db, config));
mountDesignRoutes(app);

startPoller(db, config).catch((err) => {
  console.error("Poller crashed:", err);
  process.exit(1);
});

startScheduler(db, config).catch((err) => {
  console.error("Scheduler crashed:", err);
  process.exit(1);
});

console.log("lists running on :8080");

export default {
  port: 8080,
  fetch: app.fetch,
};
