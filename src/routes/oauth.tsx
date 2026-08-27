import { Html } from "@elysia/html";
import { and, eq, isNull } from "drizzle-orm";
import { createHttpApp } from "../http";
import type { Db } from "../db";
import { schema } from "../db";
import type { Config } from "../config";
import { getSessionUser } from "../auth";
import { API_SCOPES, type ApiScope } from "../services/access";
import { hashToken, mintApiToken } from "../services/api-tokens";
import { registerOauthClient } from "../services/oauth-clients";

function base64Url(bytes: ArrayBuffer) {
  return Buffer.from(bytes).toString("base64url");
}
async function pkceChallenge(verifier: string) {
  return base64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}
function randomSecret(prefix: string) {
  return `${prefix}${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
}
function validScopes(raw: string): ApiScope[] {
  return [...new Set(raw.split(/\s+/).filter((scope): scope is ApiScope => API_SCOPES.includes(scope as ApiScope)))];
}

export function oauthRoutes(db: Db, config: Config) {
  const app = createHttpApp();

  app.get("/.well-known/oauth-protected-resource", () => ({
    resource: `${config.baseUrl}/mcp`, authorization_servers: [config.baseUrl],
    scopes_supported: API_SCOPES,
  }));
  app.get("/.well-known/oauth-authorization-server", () => ({
    issuer: config.baseUrl,
    authorization_endpoint: `${config.baseUrl}/oauth/authorize`,
    token_endpoint: `${config.baseUrl}/oauth/token`,
    ...(config.oauthDynamicRegistrationEnabled ? { registration_endpoint: `${config.baseUrl}/oauth/register` } : {}),
    response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: API_SCOPES,
  }));

  app.post("/oauth/register", (c) => {
    if (!config.oauthDynamicRegistrationEnabled) return c.json({ error: "registration_not_supported" }, 403);
    const body = c.body as Record<string, unknown>;
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
    try {
      const client = registerOauthClient(db, String(body.client_name ?? "MCP client"), redirectUris);
      return c.json({ client_id: client.clientId, client_name: client.clientName, redirect_uris: redirectUris, token_endpoint_auth_method: "none" }, 201);
    } catch { return c.json({ error: "invalid_redirect_uri" }, 400); }
  });

  app.get("/oauth/authorize", (c) => {
    const q = c.query as Record<string, string | undefined>;
    const returnTo = `/oauth/authorize?${new URLSearchParams(Object.entries(q).filter((entry): entry is [string, string] => Boolean(entry[1]))).toString()}`;
    const user = getSessionUser(db, typeof c.cookie.session?.value === "string" ? c.cookie.session.value : undefined);
    if (!user) return c.redirect(`/admin/login?returnTo=${encodeURIComponent(returnTo)}`, 302);
    const client = db.select().from(schema.oauthClients).where(eq(schema.oauthClients.clientId, q.client_id ?? "")).get();
    if (!client || !(JSON.parse(client.redirectUris) as string[]).includes(q.redirect_uri ?? "") || q.response_type !== "code" || q.code_challenge_method !== "S256" || !q.code_challenge) {
      return c.text("Invalid OAuth authorization request", 400);
    }
    const scopes = validScopes(q.scope ?? "");
    if (scopes.length === 0) return c.text("At least one supported scope is required", 400);
    return c.html(
      <html><head><title>Authorize {client.clientName}</title></head><body>
        <main style="max-width:36rem;margin:3rem auto;font-family:system-ui">
          <h1>Authorize {client.clientName}</h1><p>Signed in as {user.email}</p>
          <p>This client is requesting:</p><ul>{scopes.map((scope) => <li><code>{scope}</code></li>)}</ul>
          <form method="post" action="/oauth/authorize">
            {Object.entries(q).map(([key, value]) => value ? <input type="hidden" name={key} value={value} /> : null)}
            <button name="decision" value="allow" type="submit">Allow</button>
            <button name="decision" value="deny" type="submit">Deny</button>
          </form>
        </main>
      </body></html>,
    );
  });

  app.post("/oauth/authorize", (c) => {
    const user = getSessionUser(db, typeof c.cookie.session?.value === "string" ? c.cookie.session.value : undefined);
    if (!user) return c.text("Unauthorized", 401);
    const body = c.body as Record<string, unknown>;
    const clientId = String(body.client_id ?? ""), redirectUri = String(body.redirect_uri ?? ""), state = String(body.state ?? "");
    const client = db.select().from(schema.oauthClients).where(eq(schema.oauthClients.clientId, clientId)).get();
    if (!client || !(JSON.parse(client.redirectUris) as string[]).includes(redirectUri)
      || String(body.response_type ?? "") !== "code"
      || String(body.code_challenge_method ?? "") !== "S256"
      || !String(body.code_challenge ?? "")) return c.text("Invalid authorization request", 400);
    const redirect = new URL(redirectUri);
    if (String(body.decision) !== "allow") {
      redirect.searchParams.set("error", "access_denied"); if (state) redirect.searchParams.set("state", state);
      return c.redirect(redirect.toString(), 302);
    }
    const scopes = validScopes(String(body.scope ?? ""));
    if (scopes.length === 0) return c.text("At least one supported scope is required", 400);
    const code = randomSecret("lst_code_");
    db.insert(schema.oauthAuthorizationCodes).values({
      codeHash: hashToken(code), clientId, userId: user.id, redirectUri, scopes: JSON.stringify(scopes),
      codeChallenge: String(body.code_challenge ?? ""), expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    }).run();
    redirect.searchParams.set("code", code); if (state) redirect.searchParams.set("state", state);
    return c.redirect(redirect.toString(), 302);
  });

  app.post("/oauth/token", async (c) => {
    const body = c.body as Record<string, unknown>;
    const grantType = String(body.grant_type ?? "");
    if (grantType === "authorization_code") {
      const code = db.select().from(schema.oauthAuthorizationCodes).where(and(
        eq(schema.oauthAuthorizationCodes.codeHash, hashToken(String(body.code ?? ""))), isNull(schema.oauthAuthorizationCodes.usedAt),
      )).get();
      if (!code || code.expiresAt <= new Date().toISOString() || code.clientId !== String(body.client_id ?? "") || code.redirectUri !== String(body.redirect_uri ?? "") || await pkceChallenge(String(body.code_verifier ?? "")) !== code.codeChallenge) {
        return c.json({ error: "invalid_grant" }, 400);
      }
      db.update(schema.oauthAuthorizationCodes).set({ usedAt: new Date().toISOString() }).where(eq(schema.oauthAuthorizationCodes.id, code.id)).run();
      const scopes = JSON.parse(code.scopes) as ApiScope[];
      const access = mintApiToken(db, code.userId, `OAuth ${code.clientId.slice(0, 16)}`, scopes, new Date(Date.now() + 60 * 60_000).toISOString());
      const refresh = randomSecret("lst_refresh_");
      db.insert(schema.oauthRefreshTokens).values({ tokenHash: hashToken(refresh), clientId: code.clientId, userId: code.userId, scopes: code.scopes, expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString() }).run();
      return c.json({ access_token: access.token, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: scopes.join(" ") });
    }
    if (grantType === "refresh_token") {
      const refresh = db.select().from(schema.oauthRefreshTokens).where(and(
        eq(schema.oauthRefreshTokens.tokenHash, hashToken(String(body.refresh_token ?? ""))), isNull(schema.oauthRefreshTokens.revokedAt),
      )).get();
      if (!refresh || refresh.expiresAt <= new Date().toISOString() || refresh.clientId !== String(body.client_id ?? "")) return c.json({ error: "invalid_grant" }, 400);
      const scopes = JSON.parse(refresh.scopes) as ApiScope[];
      const access = mintApiToken(db, refresh.userId, `OAuth ${refresh.clientId.slice(0, 16)}`, scopes, new Date(Date.now() + 60 * 60_000).toISOString());
      return c.json({ access_token: access.token, token_type: "Bearer", expires_in: 3600, scope: scopes.join(" ") });
    }
    return c.json({ error: "unsupported_grant_type" }, 400);
  });
  return app;
}
