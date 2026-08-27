import { describe, expect, test } from "bun:test";
import { createHttpApp } from "../src/http";
import { apiRoutes } from "../src/routes/api";
import { mcpRoutes } from "../src/routes/mcp";
import { oauthRoutes } from "../src/routes/oauth";
import { createSession } from "../src/auth";
import { mintApiToken } from "../src/services/api-tokens";
import { createTestDb, seedList } from "./helpers";
import * as schema from "../src/db/schema";
import type { Config } from "../src/config";

const config: Config = {
  awsRegion: "us-east-1", sqsQueueUrl: "queue", s3Bucket: "bucket",
  dbPath: ":memory:", fromDomain: "example.com", baseUrl: "http://localhost",
  sesConfigSet: "config", s3MediaBucket: "", s3MediaBaseUrl: "", ownerEmail: "", ownerPassword: "",
  oauthDynamicRegistrationEnabled: true,
};

function setup() {
  const db = createTestDb();
  const user = db.insert(schema.users).values({ email: "owner@example.com", passwordHash: "hash", role: "owner" }).returning().get();
  seedList(db, { slug: "news", name: "News" });
  const app = createHttpApp();
  app.use(oauthRoutes(db, config));
  app.group("/api", (group) => group.use(apiRoutes(db, config)));
  app.group("/mcp", (group) => group.use(mcpRoutes(db, config)));
  return { app, db, user };
}

function bearer(token: string) { return { Authorization: `Bearer ${token}` }; }

describe("scoped API and MCP", () => {
  test("only exposes the versioned REST contract", async () => {
    const { app, db, user } = setup();
    const { token } = mintApiToken(db, user.id, "reader", ["subscribers:read"]);
    expect((await app.request("/api/subscribers", { headers: bearer(token) })).status).toBe(404);
    expect((await app.request("/api/v1/subscribers", { headers: bearer(token) })).status).toBe(200);
  });

  test("REST and MCP call the same list operation with the same token", async () => {
    const { app, db, user } = setup();
    const { token } = mintApiToken(db, user.id, "agent", ["lists:read"]);

    const rest = await app.request("/api/v1/lists", { headers: bearer(token) });
    expect(rest.status).toBe(200);
    const restData = (await rest.json() as any).data;

    const mcp = await app.request("/mcp/", {
      method: "POST", headers: { ...bearer(token), "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lists_list", arguments: {} } }),
    });
    expect(mcp.status).toBe(200);
    const mcpData = await mcp.json() as any;
    expect(mcpData.result.structuredContent).toEqual(restData);

    const forbidden = await app.request("/api/v1/subscribers", { headers: bearer(token) });
    expect(forbidden.status).toBe(403);
    expect(db.select().from(schema.apiTokens).get()!.tokenHash).not.toContain(token);
  });

  test("revoked tokens stop authenticating", async () => {
    const { app, db, user } = setup();
    const minted = mintApiToken(db, user.id, "temporary", ["lists:read"]);
    db.update(schema.apiTokens).set({ revokedAt: new Date().toISOString() }).run();
    expect((await app.request("/api/v1/lists", { headers: bearer(minted.token) })).status).toBe(401);
  });

  test("subscriber deletion is confirmation-gated in both transports", async () => {
    const { app, db, user } = setup();
    const subscriber = db.insert(schema.subscribers).values({ email: "delete@example.com", unsubscribeToken: "delete-token" }).returning().get();
    const { token } = mintApiToken(db, user.id, "writer", ["subscribers:write"]);
    expect((await app.request(`/api/v1/subscribers/${subscriber.id}`, { method: "DELETE", headers: bearer(token) })).status).toBe(400);
    expect(db.select().from(schema.subscribers).all()).toHaveLength(1);
    expect((await app.request(`/api/v1/subscribers/${subscriber.id}?confirm=true`, { method: "DELETE", headers: bearer(token) })).status).toBe(200);
    expect(db.select().from(schema.subscribers).all()).toHaveLength(0);
  });

  test("MCP initializes and advertises tools", async () => {
    const { app, db, user } = setup();
    const { token } = mintApiToken(db, user.id, "agent", ["lists:read"]);
    const response = await app.request("/mcp", {
      method: "POST", headers: { ...bearer(token), "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(response.status).toBe(200);
    expect((await response.json() as any).result.serverInfo.name).toBe("lists");
  });
});

describe("OAuth PKCE", () => {
  test("publishes protected-resource and authorization-server metadata", async () => {
    const { app } = setup();
    const resource = await app.request("/.well-known/oauth-protected-resource");
    const server = await app.request("/.well-known/oauth-authorization-server");
    expect(resource.status).toBe(200);
    expect((await resource.json() as any).resource).toBe("http://localhost/mcp");
    expect((await server.json() as any).code_challenge_methods_supported).toEqual(["S256"]);
  });
  test("registers a client and exchanges a user-approved code", async () => {
    const { app, db, user } = setup();
    const registered = await app.request("/oauth/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Codex", redirect_uris: ["http://localhost/callback"] }),
    });
    expect(registered.status).toBe(201);
    const client = await registered.json() as any;
    const verifier = "a".repeat(64);
    const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
    const session = createSession(db, user.id);
    const authorize = await app.request("/oauth/authorize", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: `session=${session}` },
      body: new URLSearchParams({
        decision: "allow", client_id: client.client_id, redirect_uri: "http://localhost/callback",
        response_type: "code", scope: "lists:read dmarc:read", code_challenge: challenge, code_challenge_method: "S256", state: "abc",
      }),
    });
    expect(authorize.status).toBe(302);
    const redirect = new URL(authorize.headers.get("location")!);
    expect(redirect.searchParams.get("state")).toBe("abc");

    const exchanged = await app.request("/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code: redirect.searchParams.get("code")!, client_id: client.client_id,
        redirect_uri: "http://localhost/callback", code_verifier: verifier,
      }),
    });
    expect(exchanged.status).toBe(200);
    const tokens = await exchanged.json() as any;
    expect(tokens.access_token).toStartWith("lst_");
    expect(tokens.refresh_token).toStartWith("lst_refresh_");
    expect((await app.request("/api/v1/lists", { headers: bearer(tokens.access_token) })).status).toBe(200);
  });
});
