import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { bearerAuth } from "hono/bearer-auth";
import { createMiddleware } from "hono/factory";

const sessions = new Map<string, number>(); // token -> expiry timestamp

export function createSession(): string {
  const token = crypto.randomUUID();
  sessions.set(token, Date.now() + 24 * 60 * 60 * 1000); // 24h
  return token;
}

export function destroySession(token: string) {
  sessions.delete(token);
}

function isValidSession(token: string): boolean {
  const expiry = sessions.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function adminAuth(password: string) {
  return createMiddleware(async (c, next) => {
    const session = getCookie(c, "session");
    if (session && isValidSession(session)) {
      return next();
    }
    return c.redirect("/admin/login");
  });
}

export function apiAuth(token: string) {
  return bearerAuth({ token });
}
