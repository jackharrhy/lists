import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createHttpApp } from "../src/http";
import { apiRoutes } from "../src/routes/api";
import { mcpRoutes } from "../src/routes/mcp";
import { oauthRoutes } from "../src/routes/oauth";
import { createSession } from "../src/auth";
import { mintApiToken as mintScopedToken } from "../src/services/api-tokens";
import { operationCatalog } from "../src/operations/catalog";
import { apiOpenApi } from "../src/openapi";
import { createTestDb, seedList } from "./helpers";
import * as schema from "../src/db/schema";
import type { Config } from "../src/config";

const config: Config = {
  awsRegion: "us-east-1", sqsQueueUrl: "queue", s3Bucket: "bucket",
  dbPath: ":memory:", fromDomain: "example.com", baseUrl: "http://localhost",
  sesConfigSet: "config", s3MediaBucket: "", s3MediaBaseUrl: "", ownerEmail: "", ownerPassword: "",
  oauthDynamicRegistrationEnabled: true,
};

function mintApiToken(db: ReturnType<typeof createTestDb>, userId: number, name: string, scopes: Parameters<typeof mintScopedToken>[3], expiresAt: string | null = null) {
  return mintScopedToken(db, userId, name, scopes, expiresAt, "http://localhost/mcp");
}

function setup() {
  const db = createTestDb();
  const user = db.insert(schema.users).values({ email: "owner@example.com", passwordHash: "hash", role: "owner" }).returning().get();
  seedList(db, { slug: "news", name: "News" });
  const app = createHttpApp();
  app.use(apiOpenApi());
  app.use(oauthRoutes(db, config));
  app.group("/api", (group) => group.use(apiRoutes(db, config)));
  app.group("/mcp", (group) => group.use(mcpRoutes(db, config)));
  return { app, db, user };
}

function bearer(token: string) { return { Authorization: `Bearer ${token}` }; }

async function mcpCall(app: ReturnType<typeof createHttpApp>, token: string, name: string, args: unknown) {
  const response = await app.request("/mcp/", {
    method: "POST",
    headers: { ...bearer(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  return response.json() as Promise<any>;
}

describe("scoped API and MCP", () => {
  test("advertises OAuth metadata for an unauthenticated MCP GET probe", async () => {
    const { app } = setup();
    const response = await app.request("/mcp/");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="http://localhost/.well-known/oauth-protected-resource"',
    );
  });

  test("only exposes the versioned REST contract", async () => {
    const { app, db, user } = setup();
    const { token } = mintApiToken(db, user.id, "reader", ["subscribers:read"]);
    expect((await app.request("/api/subscribers", { headers: bearer(token) })).status).toBe(404);
    expect((await app.request("/api/v1/subscribers", { headers: bearer(token) })).status).toBe(200);
  });

  test("publishes the typed REST contract as OpenAPI", async () => {
    const { app } = setup();
    const response = await app.request("/openapi/json");
    expect(response.status).toBe(200);
    const document = await response.json() as any;
    const createSubscriber = document.paths["/api/v1/subscribers"].post;
    expect(createSubscriber.security).toEqual([{ bearerAuth: [] }]);
    expect(createSubscriber.requestBody.content["application/json"].schema.required).toEqual(["email", "lists"]);
    expect(createSubscriber.responses[201].content["application/json"].schema.properties.data).toBeDefined();
    expect(document.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
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

  test("advertises every canonical operation as an MCP tool", async () => {
    const { app, db, user } = setup();
    const { token } = mintApiToken(db, user.id, "agent", ["lists:read"]);
    const response = await app.request("/mcp/", {
      method: "POST", headers: { ...bearer(token), "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const body = await response.json() as any;
    expect(body.result.tools.map((tool: any) => tool.name).sort()).toEqual(
      Object.values(operationCatalog).map((operation) => operation.mcpName).sort(),
    );
    const create = body.result.tools.find((tool: any) => tool.name === "subscriber_create");
    expect(create.inputSchema.required).toEqual(["email", "lists"]);
    expect(create.inputSchema.properties.email.format).toBe("email");
    expect(body.result.tools.some((tool: any) => tool.name === "email_template_activate")).toBe(false);
    expect(create.outputSchema.required).toEqual(["id", "email"]);
  });

  test("uses Elysia validation for malformed JSON-RPC requests", async () => {
    const { app, db, user } = setup();
    const { token } = mintApiToken(db, user.id, "agent", ["lists:read"]);
    const response = await app.request("/mcp/", {
      method: "POST", headers: { ...bearer(token), "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "1.0", method: "tools/list" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" },
    });
  });

  test("creates subscribers through the same contract in REST and MCP", async () => {
    const { app, db, user } = setup();
    const { token } = mintApiToken(db, user.id, "writer", ["subscribers:write"]);
    const rest = await app.request("/api/v1/subscribers", {
      method: "POST", headers: { ...bearer(token), "Content-Type": "application/json" },
      body: JSON.stringify({ email: "rest@example.com", firstName: "Rest", lists: ["news"] }),
    });
    expect(rest.status).toBe(201);
    expect((await rest.json() as any).data.email).toBe("rest@example.com");

    const mcp = await mcpCall(app, token, "subscriber_create", {
      email: "mcp@example.com", firstName: "MCP", lists: ["news"],
    });
    expect(mcp.result.isError).toBeUndefined();
    expect(mcp.result.structuredContent.email).toBe("mcp@example.com");
    expect(db.select().from(schema.subscriberLists).all().map((row) => row.status)).toEqual([
      "unconfirmed", "unconfirmed",
    ]);
  });

  test("rejects invalid subscriber input consistently without writing data", async () => {
    const { app, db, user } = setup();
    const { token } = mintApiToken(db, user.id, "writer", ["subscribers:write"]);
    const input = { email: "not-an-email", lists: ["news"] };
    const rest = await app.request("/api/v1/subscribers", {
      method: "POST", headers: { ...bearer(token), "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(rest.status).toBe(400);
    const mcp = await mcpCall(app, token, "subscriber_create", input);
    expect(mcp.result.isError).toBe(true);
    expect(db.select().from(schema.subscribers).all()).toEqual([]);
  });

  test("enforces member list access for subscriber creation in both transports", async () => {
    const { app, db } = setup();
    const hidden = seedList(db, { slug: "hidden", name: "Hidden" });
    const member = db.insert(schema.users).values({
      email: "member@example.com", passwordHash: "hash", role: "member",
    }).returning().get();
    const visible = db.select().from(schema.lists).where(eq(schema.lists.slug, "news")).get()!;
    db.insert(schema.userLists).values({ userId: member.id, listId: visible.id }).run();
    const { token } = mintApiToken(db, member.id, "member writer", ["subscribers:write"]);
    const input = { email: "blocked@example.com", lists: [hidden.slug] };

    const rest = await app.request("/api/v1/subscribers", {
      method: "POST", headers: { ...bearer(token), "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(rest.status).toBe(403);
    const mcp = await mcpCall(app, token, "subscriber_create", input);
    expect(mcp.result.isError).toBe(true);
    expect(db.select().from(schema.subscribers).all()).toEqual([]);
  });

  test("rejects malformed campaign audiences consistently without writing data", async () => {
    const { app, db, user } = setup();
    const { token } = mintApiToken(db, user.id, "campaign writer", ["campaigns:write"]);
    const input = {
      subject: "Bad audience", bodyMarkdown: "Body", fromAddress: "sender@example.com",
      audienceType: "subscribers", audienceData: { ids: [1, 2] },
    };
    const rest = await app.request("/api/v1/campaigns", {
      method: "POST", headers: { ...bearer(token), "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(rest.status).toBe(400);
    const mcp = await mcpCall(app, token, "campaign_create_draft", input);
    expect(mcp.result.isError).toBe(true);
    expect(db.select().from(schema.campaigns).all()).toEqual([]);
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
    const mcp = await mcpCall(app, token, "subscriber_delete", { id: subscriber.id, confirm: false });
    expect(mcp.result.isError).toBe(true);
    expect(db.select().from(schema.subscribers).all()).toHaveLength(1);
    expect((await app.request(`/api/v1/subscribers/${subscriber.id}?confirm=true`, { method: "DELETE", headers: bearer(token) })).status).toBe(200);
    expect(db.select().from(schema.subscribers).all()).toHaveLength(0);
  });

  test("MCP initializes and advertises tools", async () => {
    const { app, db, user } = setup();
    const { token } = mintApiToken(db, user.id, "agent", ["lists:read"]);
    const response = await app.request("/mcp", {
      method: "POST", headers: { ...bearer(token), "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } }),
    });
    expect(response.status).toBe(200);
    const initialized = await response.json() as any;
    expect(initialized.result.serverInfo.name).toBe("lists");
    expect(initialized.result.protocolVersion).toBe("2025-11-25");

    const unknown = await app.request("/mcp/", {
      method: "POST", headers: { ...bearer(token), "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "unknown/method", params: {} }),
    });
    expect(unknown.status).toBe(200);
    expect((await unknown.json() as any).error.code).toBe(-32601);
  });

  test("rejects bearer tokens that were not issued for the MCP resource", async () => {
    const { app, db, user } = setup();
    const unbound = mintScopedToken(db, user.id, "REST only", ["lists:read"]);
    expect((await app.request("/api/v1/lists", { headers: bearer(unbound.token) })).status).toBe(200);
    const mcp = await app.request("/mcp/", {
      method: "POST", headers: { ...bearer(unbound.token), "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(mcp.status).toBe(401);
  });

  test("authors, previews, and replaces full HTML templates through shared MCP operations", async () => {
    const { app, db, user } = setup();
    const { token } = mintApiToken(db, user.id, "template author", ["templates:read", "templates:write"]);
    const source = {
      slug: "personal-letter", name: "Personal Letter", description: "Agent-authored HTML",
      sourceFormat: "html", subjectSource: "A note for {{subscriber.firstName}}",
      htmlSource: "<!doctype html><html><body>{{> header}}<main>{{{sections.letter.html}}}</main><a href=\"{{links.unsubscribe}}\">Leave</a></body></html>",
      textSource: "{{> text_header}}\n{{sections.letter.text}}\nLeave: {{links.unsubscribe}}",
      sections: [{ key: "letter", name: "Letter", format: "markdown", required: true }],
      partials: { header: "<header>Hello {{subscriber.firstName}}</header>", text_header: "Hello {{subscriber.firstName}}" },
    };
    const created = await mcpCall(app, token, "email_template_create", source);
    expect(created.result.isError).toBeUndefined();
    expect(created.result.structuredContent.status).toBe("active");
    expect(created.result.structuredContent.sourceFormat).toBe("html");
    const validated = await mcpCall(app, token, "email_template_validate", (({ slug, name, description, ...templateSource }) => templateSource)(source));
    expect(validated.result.structuredContent.valid).toBe(true);

    const preview = await mcpCall(app, token, "email_template_preview", {
      slug: source.slug, sectionSources: { letter: "# Complete control\n\nHello **world**." },
    });
    expect(preview.result.structuredContent.html).toContain("<h1>Complete control</h1>");
    expect(preview.result.structuredContent.html).toContain("Hello Jane");
    expect(preview.result.structuredContent.text).toContain("Hello world");

    const updated = await mcpCall(app, token, "email_template_update", { ...source, name: "Personal Letter Updated" });
    expect(updated.result.structuredContent.name).toBe("Personal Letter Updated");
    expect(updated.result.structuredContent.status).toBe("active");

    const rest = await app.request(`/api/v1/email-templates/${source.slug}`, { headers: bearer(token) });
    expect(rest.status).toBe(200);
    expect((await rest.json() as any).data.name).toBe("Personal Letter Updated");
    const duplicate = await mcpCall(app, token, "email_template_duplicate", { slug: source.slug, newSlug: "personal-letter-copy" });
    expect(duplicate.result.structuredContent.slug).toBe("personal-letter-copy");
    expect(duplicate.result.structuredContent.status).toBe("active");
  });

  test("requires templates:write and rejects executable HTML before persistence", async () => {
    const { app, db, user } = setup();
    const reader = mintApiToken(db, user.id, "template reader", ["templates:read"]);
    const input = {
      slug: "unsafe", name: "Unsafe", sourceFormat: "html",
      htmlSource: "<html><body><script>alert(1)</script>{{{sections.content.html}}}<a href=\"{{links.unsubscribe}}\">Leave</a></body></html>",
      textSource: "{{sections.content.text}} {{links.unsubscribe}}",
      sections: [{ key: "content", name: "Content", format: "markdown", required: true }], partials: {},
    };
    expect((await mcpCall(app, reader.token, "email_template_create", input)).result.isError).toBe(true);
    const writer = mintApiToken(db, user.id, "template writer", ["templates:write"]);
    const rejected = await mcpCall(app, writer.token, "email_template_create", input);
    expect(rejected.result.isError).toBe(true);
    expect(rejected.result.content[0].text).toContain("forbidden <script>");
    expect(db.select().from(schema.emailTemplates).where(eq(schema.emailTemplates.slug, "unsafe")).all()).toEqual([]);
  });

  test("rejects malformed and recursive sources without partial template writes", async () => {
    const { app, db, user } = setup();
    const { token } = mintApiToken(db, user.id, "template writer", ["templates:read", "templates:write"]);
    const source = {
      slug: "atomic", name: "Atomic", sourceFormat: "html",
      htmlSource: "<html><body>{{{sections.content.html}}}<a href=\"{{links.unsubscribe}}\">Leave</a></body></html>",
      textSource: "{{sections.content.text}} {{links.unsubscribe}}",
      sections: [{ key: "content", name: "Content", format: "markdown", required: true }], partials: {},
    };
    expect((await mcpCall(app, token, "email_template_create", source)).result.isError).toBeUndefined();

    const malformed = await mcpCall(app, token, "email_template_update", {
      ...source, name: "Must not persist", htmlSource: `${source.htmlSource} {{#if`,
    });
    expect(malformed.result.isError).toBe(true);
    const stored = await app.request("/api/v1/email-templates/atomic", { headers: bearer(token) });
    const detail = (await stored.json() as any).data;
    expect(detail.name).toBe("Atomic");
    expect(detail.htmlSource).toBe(source.htmlSource);

    const recursive = await mcpCall(app, token, "email_template_create", {
      ...source, slug: "recursive", name: "Recursive",
      htmlSource: "<html><body>{{> loop}}{{{sections.content.html}}}<a href=\"{{links.unsubscribe}}\">Leave</a></body></html>",
      partials: { loop: "{{> loop}}" },
    });
    expect(recursive.result.isError).toBe(true);
    expect(recursive.result.content[0].text).toContain("Recursive partial chain");
    expect(db.select().from(schema.emailTemplates).where(eq(schema.emailTemplates.slug, "recursive")).all()).toEqual([]);
  });

  test("compiles MJML templates while preserving Handlebars sections", async () => {
    const { app, db, user } = setup();
    const { token } = mintApiToken(db, user.id, "mjml author", ["templates:read", "templates:write"]);
    const created = await mcpCall(app, token, "email_template_create", {
      slug: "responsive", name: "Responsive", sourceFormat: "mjml",
      htmlSource: "<mjml><mj-body><mj-section><mj-column><mj-text>{{{sections.content.html}}}</mj-text><mj-text><a href=\"{{links.unsubscribe}}\">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>",
      textSource: "{{sections.content.text}}\n{{links.unsubscribe}}",
      sections: [{ key: "content", name: "Content", format: "markdown", required: true }], partials: {},
    });
    expect(created.result.isError).toBeUndefined();
    expect(created.result.structuredContent.compiledHtml).toContain("role=\"article\"");
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
    expect(registered.headers.get("cache-control")).toBe("no-store");
    expect(registered.headers.get("pragma")).toBe("no-cache");
    const client = await registered.json() as any;
    const verifier = "a".repeat(64);
    const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
    const session = createSession(db, user.id);
    const authorizationParams = new URLSearchParams({
      client_id: client.client_id, redirect_uri: "http://localhost/callback", response_type: "code",
      scope: "lists:read dmarc:read", code_challenge: challenge, code_challenge_method: "S256", state: "abc",
      resource: "http://localhost/mcp",
    });
    const approval = await app.request(`/oauth/authorize?${authorizationParams}`, {
      headers: { Cookie: `session=${session}` },
    });
    expect(approval.status).toBe(200);
    expect(await approval.text()).toContain('name="resource"');
    const authorize = await app.request("/oauth/authorize", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: `session=${session}` },
      body: new URLSearchParams({
        decision: "allow", client_id: client.client_id, redirect_uri: "http://localhost/callback",
        response_type: "code", scope: "lists:read dmarc:read", code_challenge: challenge, code_challenge_method: "S256", state: "abc",
        resource: "http://localhost/mcp",
      }),
    });
    expect(authorize.status).toBe(302);
    const redirect = new URL(authorize.headers.get("location")!);
    expect(redirect.searchParams.get("state")).toBe("abc");

    const tokenFields = {
      grant_type: "authorization_code", code: redirect.searchParams.get("code")!, client_id: client.client_id,
      redirect_uri: "http://localhost/callback", code_verifier: verifier,
    };
    const wrongAudience = await app.request("/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(tokenFields),
    });
    expect(wrongAudience.status).toBe(400);
    expect(await wrongAudience.json()).toEqual({ error: "invalid_target" });

    const exchanged = await app.request("/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...tokenFields, resource: "http://localhost/mcp",
      }),
    });
    expect(exchanged.status).toBe(200);
    expect(exchanged.headers.get("cache-control")).toBe("no-store");
    const tokens = await exchanged.json() as any;
    expect(tokens.access_token).toStartWith("lst_");
    expect(tokens.refresh_token).toStartWith("lst_refresh_");
    expect((await app.request("/api/v1/lists", { headers: bearer(tokens.access_token) })).status).toBe(200);
    const mcp = await app.request("/mcp/", {
      method: "POST", headers: { ...bearer(tokens.access_token), "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(mcp.status).toBe(200);

    const refreshBody = new URLSearchParams({
      grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id,
      resource: "http://localhost/mcp", scope: "lists:read",
    });
    const refreshed = await app.request("/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: refreshBody,
    });
    expect(refreshed.status).toBe(200);
    const rotated = await refreshed.json() as any;
    expect(rotated.refresh_token).toStartWith("lst_refresh_");
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
    expect(rotated.scope).toBe("lists:read");
    const replay = await app.request("/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: refreshBody,
    });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: "invalid_grant" });
  });

  test("accepts standard dynamic-registration metadata sent by MCP clients", async () => {
    const { app } = setup();
    const response = await app.request("/oauth/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Codex",
        redirect_uris: ["http://127.0.0.1:1455/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: "lists:read templates:read",
        software_id: "codex-cli",
      }),
    });
    expect(response.status).toBe(201);
    const metadata = await response.json() as any;
    expect(metadata.token_endpoint_auth_method).toBe("none");
    expect(metadata.scope).toBe("lists:read templates:read");
  });

  test("escapes self-asserted client metadata on the approval page", async () => {
    const { app, db, user } = setup();
    const registered = await app.request("/oauth/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "<img src=x onerror=alert(1)>", redirect_uris: ["http://127.0.0.1/callback"] }),
    });
    const client = await registered.json() as any;
    const query = new URLSearchParams({
      client_id: client.client_id, redirect_uri: "http://127.0.0.1/callback", response_type: "code",
      scope: "lists:read", code_challenge: "a".repeat(43), code_challenge_method: "S256",
      resource: "http://localhost/mcp",
    });
    const approval = await app.request(`/oauth/authorize?${query}`, {
      headers: { Cookie: `session=${createSession(db, user.id)}` },
    });
    const html = await approval.text();
    expect(approval.status).toBe(200);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
  });

  test("rejects insecure redirects, unsupported clients, and incorrect resource targets", async () => {
    const { app } = setup();
    for (const redirect_uri of ["http://example.com/callback", "https://example.com/callback#fragment", "https://user:pass@example.com/callback"]) {
      const response = await app.request("/oauth/register", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: [redirect_uri] }),
      });
      expect(response.status).toBe(400);
    }
    const confidential = await app.request("/oauth/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://127.0.0.1/callback"], token_endpoint_auth_method: "client_secret_basic" }),
    });
    expect(confidential.status).toBe(400);
    expect((await confidential.json() as any).error).toBe("invalid_client_metadata");
    const unknownScope = await app.request("/oauth/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://127.0.0.1/callback"], scope: "lists:read root:everything" }),
    });
    expect(unknownScope.status).toBe(400);
    expect((await unknownScope.json() as any).error).toBe("invalid_client_metadata");
  });

  test("rejects malformed protocol inputs before credential logic", async () => {
    const { app, db } = setup();
    const registration = await app.request("/oauth/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Broken", redirect_uris: ["not-a-url"] }),
    });
    expect(registration.status).toBe(400);
    expect(db.select().from(schema.oauthClients).all()).toEqual([]);

    const token = await app.request("/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: "missing-fields" }),
    });
    expect(token.status).toBe(400);
    expect(await token.json()).toEqual({ error: "invalid_request" });
  });
});
