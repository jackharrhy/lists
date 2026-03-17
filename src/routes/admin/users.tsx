import { Hono } from "hono";
import { eq, desc } from "drizzle-orm";
import type { Db } from "../../db";
import { schema } from "../../db";
import type { Config } from "../../config";
import { requireRole } from "../../auth";
import { logEvent } from "../../services/events";
import { AdminLayout, fmtDate, fmtDateTime, type User } from "./layout";

export function mountUserRoutes(app: Hono, db: Db, config: Config) {
  app.get("/users/new", requireRole("owner", "admin"), (c) => {
    const user = c.get("user") as User;
    const allLists = db.select().from(schema.lists).all();

    return c.html(
      <AdminLayout title="Invite User" user={user}>
        <h1 class="text-2xl font-bold mt-0 mb-4">Invite User</h1>
        <div class="bg-white border border-gray-200 rounded-lg p-5 mb-6">
          <form method="post" action="/admin/users/new">
            <div class="mb-4">
              <label for="email" class="block text-sm font-medium text-gray-700 mb-1">Email</label>
              <input type="email" id="email" name="email" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
            </div>
            <div class="mb-4">
              <label for="name" class="block text-sm font-medium text-gray-700 mb-1">Name</label>
              <input type="text" id="name" name="name" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
            </div>
            <div class="mb-4">
              <label for="password" class="block text-sm font-medium text-gray-700 mb-1">Password</label>
              <input type="password" id="password" name="password" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
            </div>
            <div class="mb-4">
              <label for="role" class="block text-sm font-medium text-gray-700 mb-1">Role</label>
              <select id="role" name="role" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" onchange="document.getElementById('listSection').style.display = this.value === 'member' ? 'block' : 'none'">
                <option value="admin">Admin</option>
                <option value="member" selected>Member</option>
              </select>
            </div>
            <div id="listSection" class="mb-4">
              <p class="text-sm font-medium text-gray-700 mb-2">List access (for members)</p>
              {allLists.map((list) => (
                <label class="flex items-center gap-2 text-sm text-gray-800 mb-1">
                  <input type="checkbox" name="lists" value={String(list.id)} />
                  {list.name}
                </label>
              ))}
            </div>
            <button type="submit" class="inline-block px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 cursor-pointer border-none no-underline">Create User</button>
          </form>
        </div>
      </AdminLayout>,
    );
  });

  app.post("/users/new", requireRole("owner", "admin"), async (c) => {
    const user = c.get("user") as User;
    const body = await c.req.parseBody({ all: true });
    const email = String(body["email"] ?? "").trim().toLowerCase();
    const name = String(body["name"] ?? "").trim() || null;
    const password = String(body["password"] ?? "");
    const role = String(body["role"] ?? "member");

    if (!email || !password) {
      return c.redirect("/admin/users/new");
    }

    const passwordHash = await Bun.password.hash(password);

    const newUser = db
      .insert(schema.users)
      .values({ email, name, passwordHash, role })
      .returning({ id: schema.users.id })
      .get();

    // Insert user_lists for members
    if (role === "member" && body["lists"]) {
      const listIds = (Array.isArray(body["lists"])
        ? (body["lists"] as string[])
        : [body["lists"] as string]
      ).map(Number);
      for (const listId of listIds) {
        db.insert(schema.userLists).values({ userId: newUser.id, listId }).run();
      }
    }

    logEvent(db, {
      type: "admin.user_created",
      detail: email,
      userId: user.id,
    });

    return c.redirect("/admin/users");
  });

  app.get("/users/:id", requireRole("owner", "admin"), (c) => {
    const currentUser = c.get("user") as User;
    const id = Number(c.req.param("id"));
    const targetUser = db.select().from(schema.users).where(eq(schema.users.id, id)).get();
    if (!targetUser) return c.notFound();

    const allLists = db.select().from(schema.lists).all();
    const assignedLists = db
      .select()
      .from(schema.userLists)
      .where(eq(schema.userLists.userId, id))
      .all();
    const assignedListIds = new Set(assignedLists.map((ul) => ul.listId));

    return c.html(
      <AdminLayout title={targetUser.email} user={currentUser}>
        <h1 class="text-2xl font-bold mt-0 mb-4">{targetUser.name ?? targetUser.email}</h1>
        <div class="bg-white border border-gray-200 rounded-lg p-5 mb-6">
          <form method="post" action={`/admin/users/${id}/edit`}>
            <div class="mb-4">
              <label for="name" class="block text-sm font-medium text-gray-700 mb-1">Name</label>
              <input type="text" id="name" name="name" value={targetUser.name ?? ""} class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
            </div>
            <div class="mb-4">
              <label for="role" class="block text-sm font-medium text-gray-700 mb-1">Role</label>
              <select id="role" name="role" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" onchange="document.getElementById('editListSection').style.display = this.value === 'member' ? 'block' : 'none'">
                <option value="owner" selected={targetUser.role === "owner"}>Owner</option>
                <option value="admin" selected={targetUser.role === "admin"}>Admin</option>
                <option value="member" selected={targetUser.role === "member"}>Member</option>
              </select>
            </div>
            <div id="editListSection" class="mb-4" style={targetUser.role === "member" ? "" : "display:none"}>
              <p class="text-sm font-medium text-gray-700 mb-2">List access (for members)</p>
              {allLists.map((list) => (
                <label class="flex items-center gap-2 text-sm text-gray-800 mb-1">
                  <input type="checkbox" name="lists" value={String(list.id)} checked={assignedListIds.has(list.id)} />
                  {list.name}
                </label>
              ))}
            </div>
            <div class="mb-4">
              <label for="password" class="block text-sm font-medium text-gray-700 mb-1">New password (leave blank to keep current)</label>
              <input type="password" id="password" name="password" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
            </div>
            <button type="submit" class="inline-block px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 cursor-pointer border-none no-underline">Save changes</button>
          </form>
        </div>

        <dl class="mt-4">
          <dt class="font-semibold text-xs uppercase text-gray-500">Email</dt>
          <dd class="mt-1 ml-0">{targetUser.email}</dd>
          <dt class="font-semibold text-xs uppercase text-gray-500 mt-3">Created</dt>
          <dd class="mt-1 ml-0">{fmtDateTime(targetUser.createdAt)}</dd>
        </dl>

        {currentUser.id !== id && (
          <>
            <hr class="my-8" />
            <form method="post" action={`/admin/users/${id}/delete`} onsubmit="return confirm('Delete this user? This cannot be undone.')">
              <button type="submit" class="inline-block px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-md hover:bg-red-700 cursor-pointer border-none no-underline">
                Delete User
              </button>
            </form>
          </>
        )}
      </AdminLayout>,
    );
  });

  app.post("/users/:id/edit", requireRole("owner", "admin"), async (c) => {
    const currentUser = c.get("user") as User;
    const id = Number(c.req.param("id"));
    const body = await c.req.parseBody({ all: true });
    const name = String(body["name"] ?? "").trim() || null;
    const role = String(body["role"] ?? "member");
    const password = String(body["password"] ?? "").trim();

    const updates: Record<string, any> = { name, role };
    if (password) {
      updates.passwordHash = await Bun.password.hash(password);
    }

    db.update(schema.users)
      .set(updates)
      .where(eq(schema.users.id, id))
      .run();

    // Sync user_lists: delete all, re-insert selected
    db.delete(schema.userLists).where(eq(schema.userLists.userId, id)).run();
    if (role === "member" && body["lists"]) {
      const listIds = (Array.isArray(body["lists"])
        ? (body["lists"] as string[])
        : [body["lists"] as string]
      ).map(Number);
      for (const listId of listIds) {
        db.insert(schema.userLists).values({ userId: id, listId }).run();
      }
    }

    logEvent(db, {
      type: "admin.user_edited",
      detail: `user #${id}`,
      userId: currentUser.id,
    });

    return c.redirect(`/admin/users/${id}`);
  });

  app.post("/users/:id/delete", requireRole("owner", "admin"), (c) => {
    const currentUser = c.get("user") as User;
    const id = Number(c.req.param("id"));

    // Can't delete yourself
    if (currentUser.id === id) {
      return c.text("Cannot delete yourself", 400);
    }

    const targetUser = db.select().from(schema.users).where(eq(schema.users.id, id)).get();

    logEvent(db, {
      type: "admin.user_deleted",
      detail: targetUser?.email ?? `id=${id}`,
      userId: currentUser.id,
    });

    // Delete user_lists
    db.delete(schema.userLists).where(eq(schema.userLists.userId, id)).run();
    // Set events.userId to null
    db.update(schema.events).set({ userId: null }).where(eq(schema.events.userId, id)).run();
    // Delete user
    db.delete(schema.users).where(eq(schema.users.id, id)).run();

    return c.redirect("/admin/users");
  });

  app.get("/users", requireRole("owner", "admin"), (c) => {
    const user = c.get("user") as User;
    const allUsers = db
      .select()
      .from(schema.users)
      .orderBy(desc(schema.users.createdAt))
      .all();

    return c.html(
      <AdminLayout title="Users" user={user}>
        <h1 class="text-2xl font-bold mt-0 mb-4">Users</h1>
        <p class="mb-6">
          <a href="/admin/users/new" class="inline-block px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 cursor-pointer border-none no-underline">
            Invite User
          </a>
        </p>
        <table class="w-full bg-white rounded-lg overflow-hidden mb-6 text-sm">
          <thead>
            <tr>
              <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Email</th>
              <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Name</th>
              <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Role</th>
              <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Created</th>
            </tr>
          </thead>
          <tbody>
            {allUsers.map((u) => (
              <tr>
                <td class="px-4 py-3 border-b border-gray-100">
                  <a href={`/admin/users/${u.id}`} class="text-blue-600 hover:text-blue-800">{u.email}</a>
                </td>
                <td class="px-4 py-3 border-b border-gray-100">{u.name ?? "—"}</td>
                <td class="px-4 py-3 border-b border-gray-100">{u.role}</td>
                <td class="px-4 py-3 border-b border-gray-100">{fmtDate(u.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </AdminLayout>,
    );
  });
}
