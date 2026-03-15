import { getCookie } from "hono/cookie";
import { bearerAuth } from "hono/bearer-auth";
import { createMiddleware } from "hono/factory";
import { eq, and } from "drizzle-orm";
import type { Db } from "./db";
import { schema } from "./db";

type SessionData = { userId: number; expiry: number };

const sessions = new Map<string, SessionData>();

export function createSession(userId: number): string {
  const token = crypto.randomUUID();
  sessions.set(token, { userId, expiry: Date.now() + 24 * 60 * 60 * 1000 });
  return token;
}

export function destroySession(token: string) {
  sessions.delete(token);
}

function getValidSession(token: string): SessionData | null {
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiry) {
    sessions.delete(token);
    return null;
  }
  return session;
}

export function adminAuth(db: Db) {
  return createMiddleware(async (c, next) => {
    const token = getCookie(c, "session");
    if (!token) return c.redirect("/admin/login");

    const session = getValidSession(token);
    if (!session) return c.redirect("/admin/login");

    const user = db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, session.userId))
      .get();

    if (!user) return c.redirect("/admin/login");

    c.set("user", user);
    return next();
  });
}

export function requireRole(...roles: string[]) {
  return createMiddleware(async (c, next) => {
    const user = c.get("user") as { role: string } | undefined;
    if (!user || !roles.includes(user.role)) {
      return c.text("Forbidden", 403);
    }
    return next();
  });
}

export function requireListAccess(
  db: Db,
  getListId: (c: any) => number,
) {
  return createMiddleware(async (c, next) => {
    const user = c.get("user") as { id: number; role: string } | undefined;
    if (!user) return c.text("Forbidden", 403);

    if (user.role === "owner" || user.role === "admin") return next();

    const listId = getListId(c);
    const access = db
      .select()
      .from(schema.userLists)
      .where(
        and(
          eq(schema.userLists.userId, user.id),
          eq(schema.userLists.listId, listId),
        ),
      )
      .get();

    if (!access) return c.text("Forbidden", 403);
    return next();
  });
}

export function getAccessibleListIds(
  db: Db,
  user: { id: number; role: string },
): "all" | number[] {
  if (user.role === "owner" || user.role === "admin") return "all";

  const rows = db
    .select({ listId: schema.userLists.listId })
    .from(schema.userLists)
    .where(eq(schema.userLists.userId, user.id))
    .all();

  return rows.map((r) => r.listId);
}

export function apiAuth(token: string) {
  return bearerAuth({ token });
}
