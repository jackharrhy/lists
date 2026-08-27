import { Elysia } from "elysia";
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

export function getSessionUser(db: Db, token: string | undefined) {
  const session = token ? getValidSession(token) : null;
  return session ? db.select().from(schema.users).where(eq(schema.users.id, session.userId)).get() ?? null : null;
}

export function adminAuth(db: Db) {
  return new Elysia({ name: "admin-auth" })
    .resolve(({ cookie }) => {
      const token = cookie.session?.value;
      const session = typeof token === "string" ? getValidSession(token) : null;
      const user = session
        ? db.select().from(schema.users).where(eq(schema.users.id, session.userId)).get()
        : null;
      return { user };
    })
    .onBeforeHandle(({ user, redirect }) => {
      if (!user) return redirect("/admin/login", 302);
    })
    .as("scoped");
}

export function requireRole(...roles: string[]) {
  return ({ user, status }: { user?: { role: string }; status: (code: number, body?: string) => unknown }) => {
    if (!user || !roles.includes(user.role)) {
      return status(403, "Forbidden");
    }
  };
}

export function requireListAccess(
  db: Db,
  getListId: (c: any) => number,
) {
  return (c: any) => {
    const user = c.user as { id: number; role: string } | undefined;
    if (!user) return c.status(403, "Forbidden");

    if (user.role === "owner" || user.role === "admin") return;

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

    if (!access) return c.status(403, "Forbidden");
  };
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
  return ({ request, status }: { request: Request; status: (code: number, body?: string) => unknown }) => {
    if (request.headers.get("authorization") !== `Bearer ${token}`) {
      return status(401, "Unauthorized");
    }
  };
}
