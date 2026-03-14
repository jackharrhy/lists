import { Hono } from "hono";
import { loadConfig } from "./config";
import { createDb } from "./db";
import { publicRoutes } from "./routes/public";
import { apiRoutes } from "./routes/api";
import { adminRoutes } from "./routes/admin";
import { startPoller } from "./services/poller";

const config = loadConfig();
const db = createDb(config.dbPath);

const app = new Hono();

app.get("/", (c) => c.redirect("/subscribe"));
app.route("/", publicRoutes(db, config));
app.route("/api", apiRoutes(db, config));
app.route("/admin", adminRoutes(db, config));

startPoller(db, config).catch((err) => {
  console.error("Poller crashed:", err);
  process.exit(1);
});

console.log("lists running on :8080");

export default {
  port: 8080,
  fetch: app.fetch,
};
