import { Hono } from "hono";
import { eq, desc, and, inArray } from "drizzle-orm";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import type { Db } from "../../db";
import { schema } from "../../db";
import type { Config } from "../../config";
import { getAccessibleListIds } from "../../auth";
import { createSubscriber, confirmSubscriber } from "../../services/subscriber";
import { renderConfirmation } from "../../../emails/render";
import { buildConfirmUrl } from "../../compliance";
import { logEvent } from "../../services/events";
import { AdminLayout, displayName, fmtDate, fmtDateTime, type User } from "./layout";

export function mountSubscriberRoutes(app: Hono, db: Db, config: Config) {
   app.get("/subscribers", (c) => {
    const user = c.get("user") as User;
    const listAccess = getAccessibleListIds(db, user);

    let allSubscribers: (typeof schema.subscribers.$inferSelect)[];
    if (listAccess === "all") {
      allSubscribers = db
        .select()
        .from(schema.subscribers)
        .orderBy(desc(schema.subscribers.createdAt))
        .all();
    } else if (listAccess.length === 0) {
      allSubscribers = [];
    } else {
      allSubscribers = db
        .selectDistinct({
          id: schema.subscribers.id,
          email: schema.subscribers.email,
          firstName: schema.subscribers.firstName,
          lastName: schema.subscribers.lastName,
          status: schema.subscribers.status,
          unsubscribeToken: schema.subscribers.unsubscribeToken,
          createdAt: schema.subscribers.createdAt,
        })
        .from(schema.subscribers)
        .innerJoin(schema.subscriberLists, eq(schema.subscriberLists.subscriberId, schema.subscribers.id))
        .where(inArray(schema.subscriberLists.listId, listAccess))
        .orderBy(desc(schema.subscribers.createdAt))
        .all();
    }

    return c.html(
      <AdminLayout title="Subscribers" user={user}>
        <h1 class="text-2xl font-bold mt-0 mb-4">Subscribers</h1>
        <p class="mb-6">
          <a href="/admin/subscribers/new" class="inline-block px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 cursor-pointer border-none no-underline">
            Add Subscriber
          </a>
        </p>
        <table class="w-full bg-white rounded-lg overflow-hidden mb-6 text-sm">
          <thead>
            <tr>
              <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Email</th>
              <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Name</th>
              <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Status</th>
              <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Created</th>
              <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200"></th>
            </tr>
          </thead>
          <tbody>
            {allSubscribers.map((sub) => (
              <tr>
                <td class="px-4 py-3 border-b border-gray-100"><a href={`/admin/subscribers/${sub.id}`} class="text-blue-600 hover:text-blue-800">{sub.email}</a></td>
                <td class="px-4 py-3 border-b border-gray-100">{displayName(sub)}</td>
                <td class="px-4 py-3 border-b border-gray-100">{sub.status}</td>
                <td class="px-4 py-3 border-b border-gray-100">{fmtDate(sub.createdAt)}</td>
                <td class="px-4 py-3 border-b border-gray-100">
                  <form method="post" action={`/admin/subscribers/${sub.id}/delete`} class="m-0" onsubmit={`return confirm('Delete ${sub.email}?')`}>
                    <button type="submit" class="bg-transparent border-none text-red-600 cursor-pointer text-sm p-0">delete</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </AdminLayout>,
    );
  });

  app.get("/subscribers/new", (c) => {
    const user = c.get("user") as User;
    const listAccess = getAccessibleListIds(db, user);

    let allLists: (typeof schema.lists.$inferSelect)[];
    if (listAccess === "all") {
      allLists = db.select().from(schema.lists).all();
    } else if (listAccess.length === 0) {
      allLists = [];
    } else {
      allLists = db.select().from(schema.lists).where(inArray(schema.lists.id, listAccess)).all();
    }

    return c.html(
      <AdminLayout title="Add Subscriber" user={user}>
        <h1 class="text-2xl font-bold mt-0 mb-4">Add Subscriber</h1>
        <div class="bg-white border border-gray-200 rounded-lg p-5 mb-6">
          <form method="post" action="/admin/subscribers/new">
            <div class="mb-4">
              <label for="email" class="block text-sm font-medium text-gray-700 mb-1">Email</label>
              <input type="email" id="email" name="email" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
            </div>
            <div class="mb-4">
              <label for="firstName" class="block text-sm font-medium text-gray-700 mb-1">First name (optional)</label>
              <input type="text" id="firstName" name="firstName" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
            </div>
            <div class="mb-4">
              <label for="lastName" class="block text-sm font-medium text-gray-700 mb-1">Last name (optional)</label>
              <input type="text" id="lastName" name="lastName" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
            </div>
            <div class="mb-4">
              <label class="flex items-center gap-2 text-sm font-medium text-gray-700">
                <input type="checkbox" name="skip_confirm" value="1" />
                Pre-confirm list subscriptions (skip double opt-in)
              </label>
            </div>
            {allLists.length > 0 && (
              <div class="mb-4">
                <p class="text-sm font-medium text-gray-700 mb-2">Lists</p>
                {allLists.map((list) => (
                  <label class="flex items-center gap-2 text-sm text-gray-800 mb-1">
                    <input type="checkbox" name="lists" value={list.slug} />
                    {list.name}
                  </label>
                ))}
              </div>
            )}
            <button type="submit" class="inline-block px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 cursor-pointer border-none no-underline">Add Subscriber</button>
          </form>
        </div>
      </AdminLayout>,
    );
  });

  app.post("/subscribers/new", async (c) => {
    const user = c.get("user") as User;
    const body = await c.req.parseBody({ all: true });
    const email = body["email"] as string;
    const firstName = (body["firstName"] as string) || null;
    const lastName = (body["lastName"] as string) || null;
    const skipConfirm = body["skip_confirm"] === "1";
    let listSlugs: string[] = [];
    if (body["lists"]) {
      listSlugs = Array.isArray(body["lists"])
        ? (body["lists"] as string[])
        : [body["lists"] as string];
    }

    const subscriber = createSubscriber(db, email, firstName, lastName, listSlugs);

    if (skipConfirm) {
      confirmSubscriber(db, subscriber.unsubscribeToken);
    }

    logEvent(db, {
      type: "admin.subscriber_added",
      detail: email,
      subscriberId: subscriber.id,
      userId: user.id,
    });

    return c.redirect("/admin/subscribers");
  });

  app.get("/subscribers/:id", (c) => {
    const user = c.get("user") as User;
    const id = Number(c.req.param("id"));
    const sub = db.select().from(schema.subscribers).where(eq(schema.subscribers.id, id)).get();
    if (!sub) return c.notFound();

    const listAccess = getAccessibleListIds(db, user);
    let allLists: (typeof schema.lists.$inferSelect)[];
    if (listAccess === "all") {
      allLists = db.select().from(schema.lists).all();
    } else if (listAccess.length === 0) {
      allLists = [];
    } else {
      allLists = db.select().from(schema.lists).where(inArray(schema.lists.id, listAccess)).all();
    }

    const subLists = db
      .select()
      .from(schema.subscriberLists)
      .where(eq(schema.subscriberLists.subscriberId, id))
      .all();
    const subListMap = new Map(subLists.map((sl) => [sl.listId, sl.status]));

    // For members, verify this subscriber is on one of their accessible lists
    if (listAccess !== "all") {
      const onAccessibleList = subLists.some((sl) => (listAccess as number[]).includes(sl.listId));
      if (!onAccessibleList) return c.text("Forbidden", 403);
    }

    const subEvents = db
      .select()
      .from(schema.events)
      .where(eq(schema.events.subscriberId, id))
      .orderBy(desc(schema.events.createdAt))
      .limit(50)
      .all();

    const subSends = db
      .select({
        campaignId: schema.campaignSends.campaignId,
        status: schema.campaignSends.status,
        sentAt: schema.campaignSends.sentAt,
        subject: schema.campaigns.subject,
      })
      .from(schema.campaignSends)
      .leftJoin(schema.campaigns, eq(schema.campaignSends.campaignId, schema.campaigns.id))
      .where(eq(schema.campaignSends.subscriberId, id))
      .orderBy(desc(schema.campaignSends.sentAt))
      .all();

    // Tags
    const subTagRows = db
      .select({ id: schema.tags.id, name: schema.tags.name })
      .from(schema.subscriberTags)
      .innerJoin(schema.tags, eq(schema.subscriberTags.tagId, schema.tags.id))
      .where(eq(schema.subscriberTags.subscriberId, id))
      .all();
    const subTagIds = new Set(subTagRows.map((t) => t.id));
    const allTags = db.select().from(schema.tags).all();
    const availableTags = allTags.filter((t) => !subTagIds.has(t.id));

    return c.html(
      <AdminLayout title={sub.email} user={user}>
        <h1 class="text-2xl font-bold mt-0 mb-4">{sub.email}</h1>

        <form method="post" action={`/admin/subscribers/${id}/edit`}>
          <div class="mb-4">
            <label for="email" class="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input type="email" id="email" name="email" required value={sub.email} class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
          </div>
          <div class="mb-4">
            <label for="firstName" class="block text-sm font-medium text-gray-700 mb-1">First name</label>
            <input type="text" id="firstName" name="firstName" value={sub.firstName ?? ""} class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
          </div>
          <div class="mb-4">
            <label for="lastName" class="block text-sm font-medium text-gray-700 mb-1">Last name</label>
            <input type="text" id="lastName" name="lastName" value={sub.lastName ?? ""} class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
          </div>
          <div class="mb-4">
            <label for="status" class="block text-sm font-medium text-gray-700 mb-1">Status</label>
            <select id="status" name="status" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
              <option value="active" selected={sub.status === "active"}>active</option>
              <option value="blocklisted" selected={sub.status === "blocklisted"}>blocklisted</option>
            </select>
          </div>

          <button type="submit" class="inline-block px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 cursor-pointer border-none no-underline">Save changes</button>
        </form>

        <h2 class="text-xl font-semibold mt-6 mb-3">List subscriptions</h2>

        {(() => {
          const subscribedLists = allLists.filter((l) => subListMap.has(l.id));
          const unsubscribedLists = allLists.filter((l) => !subListMap.has(l.id));

          return (
            <>
              {subscribedLists.length > 0 ? (
                <div class="space-y-3 mb-6">
                  {subscribedLists.map((list) => {
                    const listStatus = subListMap.get(list.id)!;
                    return (
                      <div class="flex items-center justify-between bg-white border border-gray-200 rounded-lg px-4 py-3">
                        <div>
                          <span class="font-medium text-sm">{list.name}</span>
                          <span class="text-xs text-gray-400 ml-2">{list.fromDomain}</span>
                        </div>
                        <div class="flex items-center gap-2">
                          <form method="post" action={`/admin/subscribers/${sub.id}/list/${list.id}/status`} class="flex items-center gap-2 m-0">
                            <select name="listStatus" class="px-2 py-1 border border-gray-300 rounded text-xs focus:outline-none focus:ring-2 focus:ring-blue-500">
                              <option value="unconfirmed" selected={listStatus === "unconfirmed"}>unconfirmed</option>
                              <option value="confirmed" selected={listStatus === "confirmed"}>confirmed</option>
                              <option value="unsubscribed" selected={listStatus === "unsubscribed"}>unsubscribed</option>
                            </select>
                            <button type="submit" class="px-2 py-1 bg-gray-100 text-gray-700 text-xs rounded hover:bg-gray-200 cursor-pointer border border-gray-300">Set</button>
                          </form>
                          <form method="post" action={`/admin/subscribers/${sub.id}/list/${list.id}/remove`} class="m-0" onsubmit={`return confirm('Remove from ${list.name}?')`}>
                            <button type="submit" class="px-2 py-1 bg-red-50 text-red-600 text-xs rounded hover:bg-red-100 cursor-pointer border border-red-200">Remove</button>
                          </form>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p class="text-gray-400 text-sm mb-4">Not subscribed to any lists.</p>
              )}

              {(() => {
                // Group unconfirmed subscriberLists by domain for per-domain send-confirm
                const unconfirmedByDomain = new Map<string, { domain: string; count: number }>();
                for (const list of subscribedLists) {
                  if (subListMap.get(list.id) === "unconfirmed") {
                    const entry = unconfirmedByDomain.get(list.fromDomain);
                    if (entry) {
                      entry.count++;
                    } else {
                      unconfirmedByDomain.set(list.fromDomain, { domain: list.fromDomain, count: 1 });
                    }
                  }
                }
                const domains = [...unconfirmedByDomain.values()];
                if (domains.length === 0) return null;
                return (
                  <div class="mb-6 space-y-2">
                    <p class="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">Send confirmation email</p>
                    {domains.map(({ domain, count }) => (
                      <div class="flex items-center justify-between bg-white border border-gray-200 rounded-lg px-4 py-2">
                        <span class="text-sm text-gray-700">{domain}: {count} unconfirmed {count === 1 ? "list" : "lists"}</span>
                        <form method="post" action={`/admin/subscribers/${sub.id}/send-confirm`} class="m-0">
                          <input type="hidden" name="domain" value={domain} />
                          <button type="submit" class="px-2 py-1 bg-blue-600 text-white text-xs rounded hover:bg-blue-700 cursor-pointer border-none">Send confirmation</button>
                        </form>
                      </div>
                    ))}
                  </div>
                );
              })()}

              {unsubscribedLists.length > 0 && (
                <div class="mb-6">
                  <p class="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">Add to list</p>
                  <div class="space-y-2">
                    {unsubscribedLists.map((list) => (
                      <div class="flex items-center justify-between bg-gray-50 rounded-lg px-4 py-2">
                        <div>
                          <span class="text-sm text-gray-600">{list.name}</span>
                          <span class="text-xs text-gray-400 ml-2">{list.fromDomain}</span>
                        </div>
                        <div class="flex items-center gap-2">
                          <form method="post" action={`/admin/subscribers/${sub.id}/list/${list.id}/add`} class="m-0">
                            <input type="hidden" name="listStatus" value="unconfirmed" />
                            <button type="submit" class="px-2 py-1 bg-white text-gray-700 text-xs rounded hover:bg-gray-100 cursor-pointer border border-gray-300">Add (unconfirmed)</button>
                          </form>
                          <form method="post" action={`/admin/subscribers/${sub.id}/list/${list.id}/add`} class="m-0">
                            <input type="hidden" name="listStatus" value="confirmed" />
                            <button type="submit" class="px-2 py-1 bg-blue-600 text-white text-xs rounded hover:bg-blue-700 cursor-pointer border-none">Add (confirmed)</button>
                          </form>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          );
        })()}

        <h2 class="text-xl font-semibold mt-6 mb-3">Tags</h2>
        <div class="mb-4">
          <div class="flex flex-wrap gap-2 mb-3">
            {subTagRows.map((tag) => (
              <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700">
                {tag.name}
                <form method="post" action={`/admin/subscribers/${id}/tags/${tag.id}/remove`} class="m-0 inline">
                  <button type="submit" class="bg-transparent border-none cursor-pointer text-gray-400 hover:text-red-600 p-0 text-xs leading-none">&times;</button>
                </form>
              </span>
            ))}
            {subTagRows.length === 0 && <span class="text-gray-400 text-sm">No tags</span>}
          </div>
          {availableTags.length > 0 && (
            <form method="post" action={`/admin/subscribers/${id}/tags/add`} class="flex items-center gap-2">
              <select name="tagId" class="px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
                {availableTags.map((tag) => (
                  <option value={String(tag.id)}>{tag.name}</option>
                ))}
              </select>
              <button type="submit" class="inline-block px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-md hover:bg-blue-700 cursor-pointer border-none no-underline">Add</button>
            </form>
          )}
        </div>

        <dl class="mt-6">
          <dt class="font-semibold text-xs uppercase text-gray-500 first:mt-0">Created</dt>
          <dd class="mt-1 ml-0">{fmtDateTime(sub.createdAt)}</dd>
          <dt class="font-semibold text-xs uppercase text-gray-500 mt-3">Unsubscribe token</dt>
          <dd class="mt-1 ml-0 text-xs font-mono">{sub.unsubscribeToken}</dd>
        </dl>

        {subSends.length > 0 && (
          <>
            <h2 class="text-xl font-semibold mt-6 mb-3">Campaigns received ({subSends.length})</h2>
            <table class="w-full bg-white rounded-lg overflow-hidden mb-6 text-sm">
              <thead>
                <tr>
                  <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Campaign</th>
                  <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Status</th>
                  <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Sent</th>
                </tr>
              </thead>
              <tbody>
                {subSends.map((s) => (
                  <tr>
                    <td class="px-4 py-3 border-b border-gray-100"><a href={`/admin/campaigns/${s.campaignId}`} class="text-blue-600 hover:text-blue-800">{s.subject ?? `Campaign ${s.campaignId}`}</a></td>
                    <td class="px-4 py-3 border-b border-gray-100">{s.status}</td>
                    <td class="px-4 py-3 border-b border-gray-100">{fmtDateTime(s.sentAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {subEvents.length > 0 && (
          <>
            <h2 class="text-xl font-semibold mt-6 mb-3">Activity</h2>
            <div class="flex flex-col gap-0.5">
              {subEvents.map((e) => (
                <div class="flex gap-3 py-1.5 border-b border-gray-100 text-sm">
                  <span class="font-medium min-w-[12rem]">{e.type}</span>
                  <span class="text-gray-600 flex-1">{e.detail}</span>
                  <span class="text-gray-400 whitespace-nowrap">{fmtDateTime(e.createdAt)}</span>
                </div>
              ))}
            </div>
          </>
        )}

        <hr class="my-8" />
        <form method="post" action={`/admin/subscribers/${id}/delete`} onsubmit="return confirm('Delete this subscriber and all their list subscriptions? This cannot be undone.')">
          <button type="submit" class="inline-block px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-md hover:bg-red-700 cursor-pointer border-none no-underline">
            Delete Subscriber
          </button>
        </form>
      </AdminLayout>,
    );
  });

  app.post("/subscribers/:id/edit", async (c) => {
    const user = c.get("user") as User;
    const id = Number(c.req.param("id"));
    const body = await c.req.parseBody({ all: true });
    const email = String(body["email"] ?? "").trim().toLowerCase();
    const firstName = String(body["firstName"] ?? "").trim() || null;
    const lastName = String(body["lastName"] ?? "").trim() || null;
    const status = String(body["status"] ?? "active");

    db.update(schema.subscribers)
      .set({ email, firstName, lastName, status })
      .where(eq(schema.subscribers.id, id))
      .run();

    logEvent(db, {
      type: "admin.subscriber_edited",
      detail: email,
      subscriberId: id,
      userId: user.id,
    });

    return c.redirect(`/admin/subscribers/${id}`);
  });

  app.post("/subscribers/:id/delete", (c) => {
    const user = c.get("user") as User;
    const id = Number(c.req.param("id"));
    const sub = db.select().from(schema.subscribers).where(eq(schema.subscribers.id, id)).get();

    logEvent(db, {
      type: "admin.subscriber_deleted",
      detail: sub?.email ?? `id=${id}`,
      subscriberId: id,
      userId: user.id,
    });

    // delete list subscriptions
    db.delete(schema.subscriberLists)
      .where(eq(schema.subscriberLists.subscriberId, id))
      .run();
    // delete subscriber tags
    db.delete(schema.subscriberTags)
      .where(eq(schema.subscriberTags.subscriberId, id))
      .run();
    // delete campaign sends
    db.delete(schema.campaignSends)
      .where(eq(schema.campaignSends.subscriberId, id))
      .run();
    // delete subscriber
    db.delete(schema.subscribers)
      .where(eq(schema.subscribers.id, id))
      .run();
    return c.redirect("/admin/subscribers");
  });

  app.post("/subscribers/:id/send-confirm", async (c) => {
    const user = c.get("user") as User;
    const id = Number(c.req.param("id"));
    const sub = db.select().from(schema.subscribers).where(eq(schema.subscribers.id, id)).get();
    if (!sub) return c.notFound();

    const body = await c.req.parseBody();
    const domain = body["domain"] ? String(body["domain"]).trim() : null;

    // find unconfirmed lists for this subscriber, filtered by domain if provided
    const unconfirmedSubLists = db
      .select({ listId: schema.subscriberLists.listId, fromDomain: schema.lists.fromDomain })
      .from(schema.subscriberLists)
      .innerJoin(schema.lists, eq(schema.subscriberLists.listId, schema.lists.id))
      .where(
        and(
          eq(schema.subscriberLists.subscriberId, id),
          eq(schema.subscriberLists.status, "unconfirmed"),
          ...(domain ? [eq(schema.lists.fromDomain, domain)] : []),
        ),
      )
      .all();

    // nothing to confirm
    if (unconfirmedSubLists.length === 0) return c.redirect(`/admin/subscribers/${id}`);

    const sendingDomain = domain ?? unconfirmedSubLists[0]!.fromDomain ?? config.fromDomain;

    const listNames = unconfirmedSubLists
      .map((sl) => db.select().from(schema.lists).where(eq(schema.lists.id, sl.listId)).get()?.name)
      .filter(Boolean) as string[];

    const confirmUrl = buildConfirmUrl(config.baseUrl, sub.unsubscribeToken, sendingDomain);
    const { html } = await renderConfirmation({ confirmUrl, listNames });

    const ses = new SESv2Client({ region: config.awsRegion });
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: `noreply@${sendingDomain}`,
        Destination: { ToAddresses: [sub.email] },
        Content: {
          Simple: {
            Subject: { Data: "Confirm your subscription" },
            Body: { Html: { Data: html } },
          },
        },
        ConfigurationSetName: config.sesConfigSet || undefined,
      }),
    );

    logEvent(db, {
      type: "admin.confirmation_sent",
      detail: `Confirmation email sent to ${sub.email} for ${sendingDomain}`,
      subscriberId: id,
      userId: user.id,
    });

    return c.redirect(`/admin/subscribers/${id}`);
  });

  app.post("/subscribers/:id/list/:listId/add", async (c) => {
    const subId = Number(c.req.param("id"));
    const listId = Number(c.req.param("listId"));
    const body = await c.req.parseBody();
    const listStatus = String(body["listStatus"] ?? "unconfirmed");
    db.insert(schema.subscriberLists)
      .values({ subscriberId: subId, listId, status: listStatus })
      .onConflictDoNothing()
      .run();
    return c.redirect(`/admin/subscribers/${subId}`);
  });

  app.post("/subscribers/:id/list/:listId/status", async (c) => {
    const subId = Number(c.req.param("id"));
    const listId = Number(c.req.param("listId"));
    const body = await c.req.parseBody();
    const listStatus = String(body["listStatus"] ?? "unconfirmed");
    db.update(schema.subscriberLists)
      .set({ status: listStatus })
      .where(
        and(
          eq(schema.subscriberLists.subscriberId, subId),
          eq(schema.subscriberLists.listId, listId),
        ),
      )
      .run();
    return c.redirect(`/admin/subscribers/${subId}`);
  });

  app.post("/subscribers/:id/list/:listId/remove", (c) => {
    const subId = Number(c.req.param("id"));
    const listId = Number(c.req.param("listId"));
    db.delete(schema.subscriberLists)
      .where(
        and(
          eq(schema.subscriberLists.subscriberId, subId),
          eq(schema.subscriberLists.listId, listId),
        ),
      )
      .run();
    return c.redirect(`/admin/subscribers/${subId}`);
  });

  app.post("/subscribers/:id/tags/add", async (c) => {
    const id = Number(c.req.param("id"));
    const body = await c.req.parseBody();
    const tagId = Number(body["tagId"]);

    if (tagId) {
      db.insert(schema.subscriberTags)
        .values({ subscriberId: id, tagId })
        .onConflictDoNothing()
        .run();
    }

    return c.redirect(`/admin/subscribers/${id}`);
  });

  app.post("/subscribers/:id/tags/:tagId/remove", (c) => {
    const id = Number(c.req.param("id"));
    const tagId = Number(c.req.param("tagId"));

    db.delete(schema.subscriberTags)
      .where(
        and(
          eq(schema.subscriberTags.subscriberId, id),
          eq(schema.subscriberTags.tagId, tagId),
        ),
      )
      .run();

    return c.redirect(`/admin/subscribers/${id}`);
  });
}
