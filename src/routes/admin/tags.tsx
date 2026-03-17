import { Hono } from "hono";
import { eq, desc, sql } from "drizzle-orm";
import type { Db } from "../../db";
import { schema } from "../../db";
import type { Config } from "../../config";
import { logEvent } from "../../services/events";
import { AdminLayout, displayName, fmtDate, type User } from "./layout";

export function mountTagRoutes(app: Hono, db: Db, config: Config) {
  app.get("/tags", (c) => {
    const user = c.get("user") as User;
    const allTags = db.select().from(schema.tags).orderBy(desc(schema.tags.createdAt)).all();

    const tagCounts = new Map<number, number>();
    for (const tag of allTags) {
      const count = db
        .select({ count: sql<number>`count(*)` })
        .from(schema.subscriberTags)
        .where(eq(schema.subscriberTags.tagId, tag.id))
        .get()!.count;
      tagCounts.set(tag.id, count);
    }

    return c.html(
      <AdminLayout title="Tags" user={user}>
        <h1 class="text-2xl font-bold mt-0 mb-4">Tags</h1>
        <p class="mb-6">
          <a href="/admin/tags/new" class="inline-block px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 cursor-pointer border-none no-underline">
            New Tag
          </a>
        </p>
        <table class="w-full bg-white rounded-lg overflow-hidden mb-6 text-sm">
          <thead>
            <tr>
              <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Name</th>
              <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Subscribers</th>
              <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Created</th>
            </tr>
          </thead>
          <tbody>
            {allTags.map((tag) => (
              <tr>
                <td class="px-4 py-3 border-b border-gray-100"><a href={`/admin/tags/${tag.id}`} class="text-blue-600 hover:text-blue-800">{tag.name}</a></td>
                <td class="px-4 py-3 border-b border-gray-100">{tagCounts.get(tag.id) ?? 0}</td>
                <td class="px-4 py-3 border-b border-gray-100">{fmtDate(tag.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </AdminLayout>,
    );
  });

  app.get("/tags/new", (c) => {
    const user = c.get("user") as User;
    return c.html(
      <AdminLayout title="New Tag" user={user}>
        <h1 class="text-2xl font-bold mt-0 mb-4">New Tag</h1>
        <div class="bg-white border border-gray-200 rounded-lg p-5 mb-6">
          <form method="post" action="/admin/tags/new">
            <div class="mb-4">
              <label for="name" class="block text-sm font-medium text-gray-700 mb-1">Name</label>
              <input type="text" id="name" name="name" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
            </div>
            <button type="submit" class="inline-block px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 cursor-pointer border-none no-underline">Create Tag</button>
          </form>
        </div>
      </AdminLayout>,
    );
  });

  app.post("/tags/new", async (c) => {
    const user = c.get("user") as User;
    const body = await c.req.parseBody();
    const name = String(body["name"] ?? "").trim();

    if (!name) {
      return c.redirect("/admin/tags/new");
    }

    db.insert(schema.tags).values({ name }).run();

    logEvent(db, { type: "admin.tag_created", detail: name, userId: user.id });

    return c.redirect("/admin/tags");
  });

  app.get("/tags/:id", (c) => {
    const user = c.get("user") as User;
    const id = Number(c.req.param("id"));
    const tag = db.select().from(schema.tags).where(eq(schema.tags.id, id)).get();
    if (!tag) return c.notFound();

    const subscriberCount = db
      .select({ count: sql<number>`count(*)` })
      .from(schema.subscriberTags)
      .where(eq(schema.subscriberTags.tagId, id))
      .get()!.count;

    const taggedSubscribers = db
      .select({
        id: schema.subscribers.id,
        email: schema.subscribers.email,
        firstName: schema.subscribers.firstName,
        lastName: schema.subscribers.lastName,
        status: schema.subscribers.status,
      })
      .from(schema.subscriberTags)
      .innerJoin(schema.subscribers, eq(schema.subscriberTags.subscriberId, schema.subscribers.id))
      .where(eq(schema.subscriberTags.tagId, id))
      .all();

    return c.html(
      <AdminLayout title={tag.name} user={user}>
        <h1 class="text-2xl font-bold mt-0 mb-4">{tag.name}</h1>
        <dl class="mb-6">
          <dt class="font-semibold text-xs uppercase text-gray-500">Created</dt>
          <dd class="mt-1 ml-0">{fmtDate(tag.createdAt)}</dd>
          <dt class="font-semibold text-xs uppercase text-gray-500 mt-3">Subscribers</dt>
          <dd class="mt-1 ml-0">{subscriberCount}</dd>
        </dl>

        {taggedSubscribers.length > 0 && (
          <table class="w-full bg-white rounded-lg overflow-hidden mb-6 text-sm">
            <thead>
              <tr>
                <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Email</th>
                <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Name</th>
                <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Status</th>
              </tr>
            </thead>
            <tbody>
              {taggedSubscribers.map((s) => (
                <tr>
                  <td class="px-4 py-3 border-b border-gray-100"><a href={`/admin/subscribers/${s.id}`} class="text-blue-600 hover:text-blue-800">{s.email}</a></td>
                  <td class="px-4 py-3 border-b border-gray-100">{displayName(s)}</td>
                  <td class="px-4 py-3 border-b border-gray-100">{s.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <hr class="my-8" />
        <form method="post" action={`/admin/tags/${id}/delete`} onsubmit="return confirm('Delete this tag? It will be removed from all subscribers.')">
          <button type="submit" class="inline-block px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-md hover:bg-red-700 cursor-pointer border-none no-underline">
            Delete Tag
          </button>
        </form>
      </AdminLayout>,
    );
  });

  app.post("/tags/:id/delete", (c) => {
    const user = c.get("user") as User;
    const id = Number(c.req.param("id"));
    const tag = db.select().from(schema.tags).where(eq(schema.tags.id, id)).get();

    logEvent(db, { type: "admin.tag_deleted", detail: tag?.name ?? `id=${id}`, userId: user.id });

    // delete all subscriber_tags for this tag
    db.delete(schema.subscriberTags)
      .where(eq(schema.subscriberTags.tagId, id))
      .run();
    // delete the tag
    db.delete(schema.tags)
      .where(eq(schema.tags.id, id))
      .run();

    return c.redirect("/admin/tags");
  });
}
