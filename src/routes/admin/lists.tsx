import { Hono } from "hono";
import { eq, desc, sql, and, inArray } from "drizzle-orm";
import type { Db } from "../../db";
import { schema } from "../../db";
import type { Config } from "../../config";
import { requireRole, requireListAccess, getAccessibleListIds } from "../../auth";
import { logEvent } from "../../services/events";
import { AdminLayout, displayName, fmtDate, fmtDateTime, CampaignBadge, type User } from "./layout";

export function mountListRoutes(app: Hono, db: Db, config: Config) {
  app.get("/lists", (c) => {
    const user = c.get("user") as User;
    const listAccess = getAccessibleListIds(db, user);
    const isAdmin = user.role === "owner" || user.role === "admin";

    let allLists: (typeof schema.lists.$inferSelect)[];
    if (listAccess === "all") {
      allLists = db.select().from(schema.lists).all();
    } else if (listAccess.length === 0) {
      allLists = [];
    } else {
      allLists = db.select().from(schema.lists).where(inArray(schema.lists.id, listAccess)).all();
    }

    // get subscriber counts per list
    const listCounts = new Map<number, number>();
    for (const list of allLists) {
      const count = db
        .select({ count: sql<number>`count(*)` })
        .from(schema.subscriberLists)
        .where(
          and(
            eq(schema.subscriberLists.listId, list.id),
            eq(schema.subscriberLists.status, "confirmed"),
          ),
        )
        .get()!.count;
      listCounts.set(list.id, count);
    }

    return c.html(
      <AdminLayout title="Lists" user={user}>
        <h1 class="text-2xl font-bold mt-0 mb-4">Lists</h1>
        {isAdmin && (
          <p class="mb-6">
            <a href="/admin/lists/new" class="inline-block px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 cursor-pointer border-none no-underline">
              New List
            </a>
          </p>
        )}
        <table class="w-full bg-white rounded-lg overflow-hidden mb-6 text-sm">
          <thead>
            <tr>
              <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Slug</th>
              <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Name</th>
              <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Domain</th>
              <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Subscribers</th>
            </tr>
          </thead>
          <tbody>
            {allLists.map((list) => (
              <tr>
                <td class="px-4 py-3 border-b border-gray-100"><a href={`/admin/lists/${list.id}`} class="text-blue-600 hover:text-blue-800">{list.slug}</a></td>
                <td class="px-4 py-3 border-b border-gray-100">{list.name}</td>
                <td class="px-4 py-3 border-b border-gray-100 text-gray-500">{list.fromDomain}</td>
                <td class="px-4 py-3 border-b border-gray-100">{listCounts.get(list.id) ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </AdminLayout>,
    );
  });

  app.get("/lists/new", requireRole("owner", "admin"), (c) => {
    const user = c.get("user") as User;
    return c.html(
      <AdminLayout title="New List" user={user}>
        <h1 class="text-2xl font-bold mt-0 mb-4">New List</h1>
        <div class="bg-white border border-gray-200 rounded-lg p-5 mb-6">
          <form method="post" action="/admin/lists/new">
            <div class="grid grid-cols-2 gap-4">
              <div class="mb-4">
                <label for="slug" class="block text-sm font-medium text-gray-700 mb-1">Slug</label>
                <input type="text" id="slug" name="slug" required placeholder="weekly-digest" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
              </div>
              <div class="mb-4">
                <label for="name" class="block text-sm font-medium text-gray-700 mb-1">Name</label>
                <input type="text" id="name" name="name" required placeholder="Weekly Digest" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
              </div>
            </div>
            <div class="mb-4">
              <label for="description" class="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <input type="text" id="description" name="description" placeholder="Optional description" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
            </div>
            <div class="mb-4">
              <label for="fromDomain" class="block text-sm font-medium text-gray-700 mb-1">Sending domain</label>
              <input type="text" id="fromDomain" name="fromDomain" required placeholder="siliconharbour.dev" value={config.fromDomain} class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
            </div>
            <div class="mb-4">
              <label for="fromAddress" class="block text-sm font-medium text-gray-700 mb-1">Default from address</label>
              <input type="email" id="fromAddress" name="fromAddress" placeholder="newsletter@siliconharbour.dev" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
            </div>
            <button type="submit" class="inline-block px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 cursor-pointer border-none no-underline">Create List</button>
          </form>
        </div>
      </AdminLayout>,
    );
  });

  app.post("/lists/new", async (c) => {
    const body = await c.req.parseBody();
    const slug = String(body["slug"] ?? "").trim();
    const name = String(body["name"] ?? "").trim();
    const description = String(body["description"] ?? "").trim();
    const fromDomain = String(body["fromDomain"] ?? config.fromDomain).trim();
    const fromAddress = String(body["fromAddress"] ?? "").trim();

    if (!slug || !name) {
      return c.redirect("/admin/lists/new");
    }

    db.insert(schema.lists)
      .values({ slug, name, description, fromDomain, fromAddress })
      .run();

    logEvent(db, { type: "admin.list_created", detail: `${name} (${slug})`, userId: user.id });

    return c.redirect("/admin/lists");
  });

  app.get("/lists/:id", requireListAccess(db, (c) => Number(c.req.param("id"))), (c) => {
    const user = c.get("user") as User;
    const id = Number(c.req.param("id"));
    const list = db.select().from(schema.lists).where(eq(schema.lists.id, id)).get();
    if (!list) return c.notFound();
    const isAdmin = user.role === "owner" || user.role === "admin";

    const confirmedSubs = db
      .select({
        id: schema.subscribers.id,
        email: schema.subscribers.email,
        firstName: schema.subscribers.firstName,
        lastName: schema.subscribers.lastName,
        subscribedAt: schema.subscriberLists.subscribedAt,
      })
      .from(schema.subscriberLists)
      .innerJoin(schema.subscribers, eq(schema.subscriberLists.subscriberId, schema.subscribers.id))
      .where(
        and(
          eq(schema.subscriberLists.listId, id),
          eq(schema.subscriberLists.status, "confirmed"),
        ),
      )
      .all();

    const unconfirmedSubs = db
      .select({
        id: schema.subscribers.id,
        email: schema.subscribers.email,
        firstName: schema.subscribers.firstName,
        lastName: schema.subscribers.lastName,
        subscribedAt: schema.subscriberLists.subscribedAt,
      })
      .from(schema.subscriberLists)
      .innerJoin(schema.subscribers, eq(schema.subscriberLists.subscriberId, schema.subscribers.id))
      .where(
        and(
          eq(schema.subscriberLists.listId, id),
          eq(schema.subscriberLists.status, "unconfirmed"),
        ),
      )
      .all();

    const listCampaigns = db
      .select()
      .from(schema.campaigns)
      .where(and(eq(schema.campaigns.audienceType, "list"), eq(schema.campaigns.audienceId, id)))
      .orderBy(desc(schema.campaigns.createdAt))
      .all();

    return c.html(
      <AdminLayout title={list.name} user={user}>
        <h1 class="text-2xl font-bold mt-0 mb-4">{list.name}</h1>

        <form method="post" action={`/admin/lists/${id}/edit`}>
          <div class="mb-4">
            <label for="slug" class="block text-sm font-medium text-gray-700 mb-1">Slug</label>
            <input type="text" id="slug" name="slug" required value={list.slug} class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
          </div>
          <div class="mb-4">
            <label for="name" class="block text-sm font-medium text-gray-700 mb-1">Name</label>
            <input type="text" id="name" name="name" required value={list.name} class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
          </div>
          <div class="mb-4">
            <label for="description" class="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <input type="text" id="description" name="description" value={list.description} class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
          </div>
          <div class="mb-4">
            <label for="fromDomain" class="block text-sm font-medium text-gray-700 mb-1">Sending domain</label>
            <input type="text" id="fromDomain" name="fromDomain" required value={list.fromDomain} class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
          </div>
          <div class="mb-4">
            <label for="fromAddress" class="block text-sm font-medium text-gray-700 mb-1">Default from address</label>
            <input type="email" id="fromAddress" name="fromAddress" value={list.fromAddress} placeholder={`newsletter@${list.fromDomain}`} class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
          </div>
          <button type="submit" class="inline-block px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 cursor-pointer border-none no-underline">Save changes</button>
        </form>

        <h2 class="text-xl font-semibold mt-6 mb-3">Confirmed subscribers ({confirmedSubs.length})</h2>
        {confirmedSubs.length > 0 ? (
          <table class="w-full bg-white rounded-lg overflow-hidden mb-6 text-sm">
            <thead>
              <tr>
                <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Email</th>
                <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Name</th>
                <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Subscribed</th>
              </tr>
            </thead>
            <tbody>
              {confirmedSubs.map((s) => (
                <tr>
                  <td class="px-4 py-3 border-b border-gray-100"><a href={`/admin/subscribers/${s.id}`} class="text-blue-600 hover:text-blue-800">{s.email}</a></td>
                  <td class="px-4 py-3 border-b border-gray-100">{displayName(s)}</td>
                  <td class="px-4 py-3 border-b border-gray-100">{fmtDate(s.subscribedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p class="text-gray-400">No confirmed subscribers.</p>
        )}

        {unconfirmedSubs.length > 0 && (
          <>
            <h2 class="text-xl font-semibold mt-6 mb-3">Pending confirmation ({unconfirmedSubs.length})</h2>
            <table class="w-full bg-white rounded-lg overflow-hidden mb-6 text-sm">
              <thead>
                <tr>
                  <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Email</th>
                  <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Name</th>
                  <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Subscribed</th>
                </tr>
              </thead>
              <tbody>
                {unconfirmedSubs.map((s) => (
                  <tr>
                    <td class="px-4 py-3 border-b border-gray-100"><a href={`/admin/subscribers/${s.id}`} class="text-blue-600 hover:text-blue-800">{s.email}</a></td>
                    <td class="px-4 py-3 border-b border-gray-100">{displayName(s)}</td>
                    <td class="px-4 py-3 border-b border-gray-100">{fmtDate(s.subscribedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {listCampaigns.length > 0 && (
          <>
            <h2 class="text-xl font-semibold mt-6 mb-3">Campaigns ({listCampaigns.length})</h2>
            <table class="w-full bg-white rounded-lg overflow-hidden mb-6 text-sm">
              <thead>
                <tr>
                  <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Subject</th>
                  <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Status</th>
                  <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Sent</th>
                </tr>
              </thead>
              <tbody>
                {listCampaigns.map((cam) => (
                  <tr>
                    <td class="px-4 py-3 border-b border-gray-100"><a href={`/admin/campaigns/${cam.id}`} class="text-blue-600 hover:text-blue-800">{cam.subject}</a></td>
                    <td class="px-4 py-3 border-b border-gray-100"><CampaignBadge status={cam.status} /></td>
                    <td class="px-4 py-3 border-b border-gray-100">{fmtDateTime(cam.sentAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {isAdmin && (
          <>
            <hr class="my-8" />
            <form method="post" action={`/admin/lists/${id}/delete`} onsubmit="return confirm('Delete this list? Subscribers will be unlinked but not deleted. Campaigns on this list will also be deleted.')">
              <button type="submit" class="inline-block px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-md hover:bg-red-700 cursor-pointer border-none no-underline">
                Delete List
              </button>
            </form>
          </>
        )}
      </AdminLayout>,
    );
  });

  app.post("/lists/:id/edit", requireListAccess(db, (c) => Number(c.req.param("id"))), async (c) => {
    const user = c.get("user") as User;
    const id = Number(c.req.param("id"));
    const body = await c.req.parseBody();
    const slug = String(body["slug"] ?? "").trim();
    const name = String(body["name"] ?? "").trim();
    const description = String(body["description"] ?? "").trim();
    const fromDomain = String(body["fromDomain"] ?? config.fromDomain).trim();
    const fromAddress = String(body["fromAddress"] ?? "").trim();

    if (!slug || !name) return c.redirect(`/admin/lists/${id}`);

    db.update(schema.lists)
      .set({ slug, name, description, fromDomain, fromAddress })
      .where(eq(schema.lists.id, id))
      .run();

    logEvent(db, { type: "admin.list_edited", detail: `${name} (${slug})`, userId: user.id });

    return c.redirect(`/admin/lists/${id}`);
  });

  app.post("/lists/:id/delete", requireRole("owner", "admin"), (c) => {
    const user = c.get("user") as User;
    const id = Number(c.req.param("id"));
    const list = db.select().from(schema.lists).where(eq(schema.lists.id, id)).get();

    logEvent(db, { type: "admin.list_deleted", detail: list?.name ?? `id=${id}`, userId: user.id });

    // unlink subscriber_lists
    db.delete(schema.subscriberLists)
      .where(eq(schema.subscriberLists.listId, id))
      .run();
    // delete campaigns and their sends
    const campaigns = db.select().from(schema.campaigns).where(and(eq(schema.campaigns.audienceType, "list"), eq(schema.campaigns.audienceId, id))).all();
    for (const cam of campaigns) {
      db.delete(schema.campaignSends).where(eq(schema.campaignSends.campaignId, cam.id)).run();
    }
    db.delete(schema.campaigns).where(and(eq(schema.campaigns.audienceType, "list"), eq(schema.campaigns.audienceId, id))).run();
    // delete user_lists references
    db.delete(schema.userLists).where(eq(schema.userLists.listId, id)).run();
    // delete list
    db.delete(schema.lists).where(eq(schema.lists.id, id)).run();

    return c.redirect("/admin/lists");
  });
}
