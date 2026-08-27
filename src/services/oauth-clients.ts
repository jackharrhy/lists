import type { Db } from "../db";
import { schema } from "../db";

export function validateRedirectUris(redirectUris: string[]) {
  return redirectUris.length > 0 && redirectUris.every((uri) => {
    try {
      const url = new URL(uri);
      return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname));
    } catch { return false; }
  });
}

export function registerOauthClient(db: Db, clientName: string, redirectUris: string[]) {
  if (!validateRedirectUris(redirectUris)) throw Object.assign(new Error("Invalid redirect URI"), { status: 400 });
  const clientId = `lst_client_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
  const row = db.insert(schema.oauthClients).values({
    clientId, clientName: clientName.trim().slice(0, 200) || "MCP client", redirectUris: JSON.stringify(redirectUris),
  }).returning().get();
  return row;
}
