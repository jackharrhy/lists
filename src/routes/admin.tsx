import { Hono } from "hono";
import { eq, desc, sql, and } from "drizzle-orm";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { marked } from "marked";
import type { Db } from "../db";
import { schema } from "../db";
import type { Config } from "../config";
import { adminAuth, createSession, destroySession } from "../auth";
import { sendCampaign } from "../services/sender";
import { createSubscriber, confirmSubscriber } from "../services/subscriber";
import { logEvent } from "../services/events";

// ---------------------------------------------------------------------------
// Layout & components
// ---------------------------------------------------------------------------

function AdminLayout({
  title,
  children,
  flash,
}: {
  title: string;
  children: any;
  flash?: string;
}) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title} - Lists Admin</title>
        <link rel="stylesheet" href="/static/styles.css" />
        <style>{`tr:last-child td { border-bottom: none; }`}</style>
      </head>
      <body class="font-sans text-gray-900 bg-gray-50 m-0 p-0 leading-relaxed">
        <nav class="bg-gray-900 py-3 mb-6">
          <div class="max-w-5xl mx-auto px-6 flex items-center gap-6">
            <a href="/admin/" class="text-white font-bold text-base mr-auto no-underline">
              Lists
            </a>
            <a href="/admin/" class="text-gray-400 text-sm no-underline hover:text-white">Dashboard</a>
            <a href="/admin/subscribers" class="text-gray-400 text-sm no-underline hover:text-white">Subscribers</a>
            <a href="/admin/lists" class="text-gray-400 text-sm no-underline hover:text-white">Lists</a>
            <a href="/admin/campaigns" class="text-gray-400 text-sm no-underline hover:text-white">Campaigns</a>
            <a href="/admin/inbound" class="text-gray-400 text-sm no-underline hover:text-white">Inbound</a>
            <a href="/admin/activity" class="text-gray-400 text-sm no-underline hover:text-white">Activity</a>
            <form method="post" action="/admin/logout" class="m-0">
              <button
                type="submit"
                class="bg-transparent text-gray-400 border-none cursor-pointer text-sm p-0 hover:text-white"
              >
                Logout
              </button>
            </form>
          </div>
        </nav>
        <div class="max-w-5xl mx-auto px-6 py-4">
          {flash && <div class="bg-green-100 border border-green-300 text-green-800 px-4 py-3 rounded-md mb-4 text-sm">{flash}</div>}
          {children}
        </div>
      </body>
    </html>
  );
}

function Verdict({ value }: { value: string | null }) {
  if (!value) return <span class="text-red-600 font-semibold text-xs">—</span>;
  const pass = value.toUpperCase() === "PASS";
  return (
    <span class={pass ? "text-green-600 font-semibold text-xs" : "text-red-600 font-semibold text-xs"}>
      {value.toUpperCase()}
    </span>
  );
}

function CampaignBadge({ status }: { status: string }) {
  const base = "inline-block px-2.5 py-0.5 rounded-full text-xs font-medium";
  const cls =
    status === "draft"
      ? `${base} bg-amber-100 text-amber-800`
      : status === "sending"
        ? `${base} bg-blue-100 text-blue-800`
        : status === "failed"
          ? `${base} bg-red-100 text-red-800`
          : `${base} bg-green-100 text-green-800`;
  return <span class={cls}>{status}</span>;
}

function fmtDate(d: string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-CA");
}

function fmtDateTime(d: string | null): string {
  if (!d) return "—";
  const dt = new Date(d);
  return `${dt.toLocaleDateString("en-CA")} ${dt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function adminRoutes(db: Db, config: Config) {
  const app = new Hono();

  // ---- Unprotected -------------------------------------------------------

  app.get("/login", (c) => {
    return c.html(
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Login - Lists Admin</title>
          <link rel="stylesheet" href="/static/styles.css" />
        </head>
        <body class="font-sans flex items-center justify-center min-h-screen m-0 bg-gray-50">
          <div class="bg-white p-8 rounded-lg border border-gray-200 w-80">
            <h1 class="m-0 mb-4 text-xl text-center font-bold">Lists Admin</h1>
            <form method="post" action="/admin/login">
              <input
                type="password"
                name="password"
                placeholder="Password"
                required
                autofocus
                class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 box-border"
              />
              <button type="submit" class="w-full px-3 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 cursor-pointer border-none">
                Log in
              </button>
            </form>
          </div>
        </body>
      </html>,
    );
  });

  app.post("/login", async (c) => {
    const body = await c.req.parseBody();
    const password = body["password"];
    if (password !== config.authPassword) {
      return c.html(
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <title>Login - Lists Admin</title>
            <link rel="stylesheet" href="/static/styles.css" />
          </head>
          <body class="font-sans flex items-center justify-center min-h-screen m-0 bg-gray-50">
            <div class="bg-white p-8 rounded-lg border border-gray-200 w-80">
              <h1 class="m-0 mb-4 text-xl text-center font-bold">Lists Admin</h1>
              <p class="text-red-600 text-sm mb-3 text-center">Invalid password.</p>
              <form method="post" action="/admin/login">
                <input
                  type="password"
                  name="password"
                  placeholder="Password"
                  required
                  autofocus
                  class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 box-border"
                />
                <button type="submit" class="w-full px-3 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 cursor-pointer border-none">
                  Log in
                </button>
              </form>
            </div>
          </body>
        </html>,
        401,
      );
    }

    const token = createSession();
    setCookie(c, "session", token, {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      maxAge: 86400,
    });
    return c.redirect("/admin/");
  });

  app.post("/logout", (c) => {
    const token = getCookie(c, "session");
    if (token) {
      destroySession(token);
    }
    deleteCookie(c, "session", { path: "/" });
    return c.redirect("/admin/login");
  });

  // ---- Protected ---------------------------------------------------------

  app.use("/*", adminAuth(config.authPassword));

  // Dashboard
  app.get("/", (c) => {
    const activeCount = db
      .select({ count: sql<number>`count(*)` })
      .from(schema.subscribers)
      .where(eq(schema.subscribers.status, "active"))
      .get()!.count;

    const listCount = db
      .select({ count: sql<number>`count(*)` })
      .from(schema.lists)
      .get()!.count;

    const campaignCount = db
      .select({ count: sql<number>`count(*)` })
      .from(schema.campaigns)
      .get()!.count;

    const recentCampaigns = db
      .select()
      .from(schema.campaigns)
      .orderBy(desc(schema.campaigns.createdAt))
      .limit(5)
      .all();

    return c.html(
      <AdminLayout title="Dashboard">
        <h1 class="text-2xl font-bold mt-0 mb-4">Dashboard</h1>
        <div class="flex gap-4 mb-6">
          <div class="inline-flex flex-col items-center bg-white border border-gray-200 rounded-lg px-6 py-4 min-w-[120px] text-center">
            <span class="text-3xl font-bold text-blue-600">{activeCount}</span>
            <span class="text-xs text-gray-500 uppercase tracking-wide">Subscribers</span>
          </div>
          <div class="inline-flex flex-col items-center bg-white border border-gray-200 rounded-lg px-6 py-4 min-w-[120px] text-center">
            <span class="text-3xl font-bold text-blue-600">{listCount}</span>
            <span class="text-xs text-gray-500 uppercase tracking-wide">Lists</span>
          </div>
          <div class="inline-flex flex-col items-center bg-white border border-gray-200 rounded-lg px-6 py-4 min-w-[120px] text-center">
            <span class="text-3xl font-bold text-blue-600">{campaignCount}</span>
            <span class="text-xs text-gray-500 uppercase tracking-wide">Campaigns</span>
          </div>
        </div>

        <h2 class="text-xl font-semibold mt-6 mb-3">Recent Campaigns</h2>
        {recentCampaigns.length === 0 ? (
          <p>No campaigns yet.</p>
        ) : (
          <table class="w-full bg-white rounded-lg overflow-hidden mb-6 text-sm">
            <thead>
              <tr>
                <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Subject</th>
                <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Status</th>
                <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Created</th>
              </tr>
            </thead>
            <tbody>
              {recentCampaigns.map((cam) => (
                <tr>
                  <td class="px-4 py-3 border-b border-gray-100">
                    <a href={`/admin/campaigns/${cam.id}`} class="text-blue-600 hover:text-blue-800">{cam.subject}</a>
                  </td>
                  <td class="px-4 py-3 border-b border-gray-100">
                    <CampaignBadge status={cam.status} />
                  </td>
                  <td class="px-4 py-3 border-b border-gray-100">{fmtDate(cam.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </AdminLayout>,
    );
  });

  // Subscribers
   app.get("/subscribers", (c) => {
    const allSubscribers = db
      .select()
      .from(schema.subscribers)
      .orderBy(desc(schema.subscribers.createdAt))
      .all();

    const allLists = db.select().from(schema.lists).all();

    return c.html(
      <AdminLayout title="Subscribers">
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
              <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Confirmed</th>
              <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Created</th>
              <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200"></th>
            </tr>
          </thead>
          <tbody>
            {allSubscribers.map((sub) => (
              <tr>
                <td class="px-4 py-3 border-b border-gray-100"><a href={`/admin/subscribers/${sub.id}`} class="text-blue-600 hover:text-blue-800">{sub.email}</a></td>
                <td class="px-4 py-3 border-b border-gray-100">{sub.name ?? "—"}</td>
                <td class="px-4 py-3 border-b border-gray-100">{sub.status}</td>
                <td class="px-4 py-3 border-b border-gray-100">{sub.confirmedAt ? "Yes" : "No"}</td>
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
    const allLists = db.select().from(schema.lists).all();

    return c.html(
      <AdminLayout title="Add Subscriber">
        <h1 class="text-2xl font-bold mt-0 mb-4">Add Subscriber</h1>
        <div class="bg-white border border-gray-200 rounded-lg p-5 mb-6">
          <form method="post" action="/admin/subscribers/new">
            <div class="mb-4">
              <label for="email" class="block text-sm font-medium text-gray-700 mb-1">Email</label>
              <input type="email" id="email" name="email" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
            </div>
            <div class="mb-4">
              <label for="name" class="block text-sm font-medium text-gray-700 mb-1">Name (optional)</label>
              <input type="text" id="name" name="name" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
            </div>
            <div class="mb-4">
              <label class="flex items-center gap-2 text-sm font-medium text-gray-700">
                <input type="checkbox" name="skip_confirm" value="1" />
                Pre-confirm (skip double opt-in)
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
    const body = await c.req.parseBody({ all: true });
    const email = body["email"] as string;
    const name = (body["name"] as string) || null;
    const skipConfirm = body["skip_confirm"] === "1";
    let listSlugs: string[] = [];
    if (body["lists"]) {
      listSlugs = Array.isArray(body["lists"])
        ? (body["lists"] as string[])
        : [body["lists"] as string];
    }

    const subscriber = createSubscriber(db, email, name, listSlugs);

    if (skipConfirm) {
      confirmSubscriber(db, subscriber.unsubscribeToken);
    }

    logEvent(db, {
      type: "admin.subscriber_added",
      detail: email,
      subscriberId: subscriber.id,
    });

    return c.redirect("/admin/subscribers");
  });

  app.get("/subscribers/:id", (c) => {
    const id = Number(c.req.param("id"));
    const sub = db.select().from(schema.subscribers).where(eq(schema.subscribers.id, id)).get();
    if (!sub) return c.notFound();

    const allLists = db.select().from(schema.lists).all();
    const subLists = db
      .select()
      .from(schema.subscriberLists)
      .where(eq(schema.subscriberLists.subscriberId, id))
      .all();
    const subListMap = new Map(subLists.map((sl) => [sl.listId, sl.status]));

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

    return c.html(
      <AdminLayout title={sub.email}>
        <h1 class="text-2xl font-bold mt-0 mb-4">{sub.email}</h1>

        <form method="post" action={`/admin/subscribers/${id}/edit`}>
          <div class="mb-4">
            <label for="email" class="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input type="email" id="email" name="email" required value={sub.email} class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
          </div>
          <div class="mb-4">
            <label for="name" class="block text-sm font-medium text-gray-700 mb-1">Name</label>
            <input type="text" id="name" name="name" value={sub.name ?? ""} class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
          </div>
          <div class="mb-4">
            <label for="status" class="block text-sm font-medium text-gray-700 mb-1">Status</label>
            <select id="status" name="status" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
              <option value="active" selected={sub.status === "active"}>active</option>
              <option value="unsubscribed" selected={sub.status === "unsubscribed"}>unsubscribed</option>
              <option value="blocklisted" selected={sub.status === "blocklisted"}>blocklisted</option>
            </select>
          </div>

          {allLists.length > 0 && (
            <div class="mb-4">
              <p class="m-0 mb-1 font-medium">List subscriptions</p>
              {allLists.map((list) => {
                const status = subListMap.get(list.id);
                return (
                  <label class="block">
                    <input
                      type="checkbox"
                      name="lists"
                      value={String(list.id)}
                      checked={status === "confirmed" || status === "unconfirmed"}
                    />
                    {" "}{list.name}
                    {status && <span class="text-xs text-gray-500"> ({status})</span>}
                  </label>
                );
              })}
            </div>
          )}

          <button type="submit" class="inline-block px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 cursor-pointer border-none no-underline">Save changes</button>
        </form>

        <dl class="mt-6">
          <dt class="font-semibold text-xs uppercase text-gray-500 first:mt-0">Confirmed</dt>
          <dd class="mt-1 ml-0">{sub.confirmedAt ? fmtDateTime(sub.confirmedAt) : "No"}</dd>
          <dt class="font-semibold text-xs uppercase text-gray-500 mt-3">Created</dt>
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
    const id = Number(c.req.param("id"));
    const body = await c.req.parseBody({ all: true });
    const email = String(body["email"] ?? "").trim().toLowerCase();
    const name = String(body["name"] ?? "").trim() || null;
    const status = String(body["status"] ?? "active");

    db.update(schema.subscribers)
      .set({ email, name, status })
      .where(eq(schema.subscribers.id, id))
      .run();

    // update list subscriptions
    let selectedListIds: number[] = [];
    if (body["lists"]) {
      selectedListIds = (Array.isArray(body["lists"])
        ? (body["lists"] as string[])
        : [body["lists"] as string]
      ).map(Number);
    }

    const allLists = db.select().from(schema.lists).all();
    for (const list of allLists) {
      const existing = db
        .select()
        .from(schema.subscriberLists)
        .where(
          and(
            eq(schema.subscriberLists.subscriberId, id),
            eq(schema.subscriberLists.listId, list.id),
          ),
        )
        .get();

      if (selectedListIds.includes(list.id)) {
        if (!existing) {
          db.insert(schema.subscriberLists)
            .values({ subscriberId: id, listId: list.id, status: "confirmed" })
            .run();
        } else if (existing.status === "unsubscribed") {
          db.update(schema.subscriberLists)
            .set({ status: "confirmed" })
            .where(
              and(
                eq(schema.subscriberLists.subscriberId, id),
                eq(schema.subscriberLists.listId, list.id),
              ),
            )
            .run();
        }
      } else if (existing && existing.status !== "unsubscribed") {
        db.update(schema.subscriberLists)
          .set({ status: "unsubscribed" })
          .where(
            and(
              eq(schema.subscriberLists.subscriberId, id),
              eq(schema.subscriberLists.listId, list.id),
            ),
          )
          .run();
      }
    }

    logEvent(db, {
      type: "admin.subscriber_edited",
      detail: email,
      subscriberId: id,
    });

    return c.redirect(`/admin/subscribers/${id}`);
  });

  app.post("/subscribers/:id/delete", (c) => {
    const id = Number(c.req.param("id"));
    const sub = db.select().from(schema.subscribers).where(eq(schema.subscribers.id, id)).get();

    logEvent(db, {
      type: "admin.subscriber_deleted",
      detail: sub?.email ?? `id=${id}`,
      subscriberId: id,
    });

    // delete list subscriptions
    db.delete(schema.subscriberLists)
      .where(eq(schema.subscriberLists.subscriberId, id))
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

  // Lists
  app.get("/lists", (c) => {
    const allLists = db.select().from(schema.lists).all();

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
      <AdminLayout title="Lists">
        <h1 class="text-2xl font-bold mt-0 mb-4">Lists</h1>
        <p class="mb-6">
          <a href="/admin/lists/new" class="inline-block px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 cursor-pointer border-none no-underline">
            New List
          </a>
        </p>
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

  app.get("/lists/new", (c) => {
    return c.html(
      <AdminLayout title="New List">
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

    if (!slug || !name) {
      return c.redirect("/admin/lists/new");
    }

    db.insert(schema.lists)
      .values({ slug, name, description, fromDomain })
      .run();

    logEvent(db, { type: "admin.list_created", detail: `${name} (${slug})` });

    return c.redirect("/admin/lists");
  });

  app.get("/lists/:id", (c) => {
    const id = Number(c.req.param("id"));
    const list = db.select().from(schema.lists).where(eq(schema.lists.id, id)).get();
    if (!list) return c.notFound();

    const confirmedSubs = db
      .select({
        id: schema.subscribers.id,
        email: schema.subscribers.email,
        name: schema.subscribers.name,
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
        name: schema.subscribers.name,
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
      .where(eq(schema.campaigns.listId, id))
      .orderBy(desc(schema.campaigns.createdAt))
      .all();

    return c.html(
      <AdminLayout title={list.name}>
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
                  <td class="px-4 py-3 border-b border-gray-100">{s.name ?? "—"}</td>
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
                    <td class="px-4 py-3 border-b border-gray-100">{s.name ?? "—"}</td>
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

        <hr class="my-8" />
        <form method="post" action={`/admin/lists/${id}/delete`} onsubmit="return confirm('Delete this list? Subscribers will be unlinked but not deleted. Campaigns on this list will also be deleted.')">
          <button type="submit" class="inline-block px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-md hover:bg-red-700 cursor-pointer border-none no-underline">
            Delete List
          </button>
        </form>
      </AdminLayout>,
    );
  });

  app.post("/lists/:id/edit", async (c) => {
    const id = Number(c.req.param("id"));
    const body = await c.req.parseBody();
    const slug = String(body["slug"] ?? "").trim();
    const name = String(body["name"] ?? "").trim();
    const description = String(body["description"] ?? "").trim();
    const fromDomain = String(body["fromDomain"] ?? config.fromDomain).trim();

    if (!slug || !name) return c.redirect(`/admin/lists/${id}`);

    db.update(schema.lists)
      .set({ slug, name, description, fromDomain })
      .where(eq(schema.lists.id, id))
      .run();

    logEvent(db, { type: "admin.list_edited", detail: `${name} (${slug})` });

    return c.redirect(`/admin/lists/${id}`);
  });

  app.post("/lists/:id/delete", (c) => {
    const id = Number(c.req.param("id"));
    const list = db.select().from(schema.lists).where(eq(schema.lists.id, id)).get();

    logEvent(db, { type: "admin.list_deleted", detail: list?.name ?? `id=${id}` });

    // unlink subscriber_lists
    db.delete(schema.subscriberLists)
      .where(eq(schema.subscriberLists.listId, id))
      .run();
    // delete campaigns and their sends
    const campaigns = db.select().from(schema.campaigns).where(eq(schema.campaigns.listId, id)).all();
    for (const cam of campaigns) {
      db.delete(schema.campaignSends).where(eq(schema.campaignSends.campaignId, cam.id)).run();
    }
    db.delete(schema.campaigns).where(eq(schema.campaigns.listId, id)).run();
    // delete list
    db.delete(schema.lists).where(eq(schema.lists.id, id)).run();

    return c.redirect("/admin/lists");
  });

  // Campaigns
  app.get("/campaigns", (c) => {
    const allCampaigns = db
      .select()
      .from(schema.campaigns)
      .orderBy(desc(schema.campaigns.createdAt))
      .all();

    return c.html(
      <AdminLayout title="Campaigns">
        <h1 class="text-2xl font-bold mt-0 mb-4">Campaigns</h1>
        <p>
          <a href="/admin/campaigns/new" class="inline-block px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 cursor-pointer border-none no-underline">
            New Campaign
          </a>
        </p>
        <table class="w-full bg-white rounded-lg overflow-hidden mb-6 text-sm">
          <thead>
            <tr>
              <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Subject</th>
              <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">From</th>
              <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Status</th>
              <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Created</th>
            </tr>
          </thead>
          <tbody>
            {allCampaigns.map((cam) => (
              <tr>
                <td class="px-4 py-3 border-b border-gray-100">
                  <a href={`/admin/campaigns/${cam.id}`} class="text-blue-600 hover:text-blue-800">{cam.subject}</a>
                </td>
                <td class="px-4 py-3 border-b border-gray-100">{cam.fromAddress}</td>
                <td class="px-4 py-3 border-b border-gray-100">
                  <CampaignBadge status={cam.status} />
                </td>
                <td class="px-4 py-3 border-b border-gray-100">{fmtDate(cam.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </AdminLayout>,
    );
  });

  app.get("/campaigns/new", (c) => {
    const allLists = db.select().from(schema.lists).all();

    return c.html(
      <AdminLayout title="New Campaign">
        <h1 class="text-2xl font-bold mt-0 mb-4">New Campaign</h1>
        <div class="bg-white border border-gray-200 rounded-lg p-5 mb-6">
          <form method="post" action="/admin/campaigns/new">
            <div class="mb-4">
              <label for="listId" class="block text-sm font-medium text-gray-700 mb-1">List</label>
              <select id="listId" name="listId" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
                <option value="">Select a list…</option>
                {allLists.map((list) => (
                  <option value={String(list.id)}>
                    {list.name} ({list.slug})
                  </option>
                ))}
              </select>
            </div>
            <div class="mb-4">
              <label for="fromAddress" class="block text-sm font-medium text-gray-700 mb-1">From Address</label>
              <input
                type="email"
                id="fromAddress"
                name="fromAddress"
                required
                placeholder={`newsletter@${config.fromDomain}`}
                class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <div class="mb-4">
              <label for="subject" class="block text-sm font-medium text-gray-700 mb-1">Subject</label>
              <input type="text" id="subject" name="subject" required placeholder="Campaign subject" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
            </div>
            <div class="mb-4">
              <label for="bodyMarkdown" class="block text-sm font-medium text-gray-700 mb-1">Body (Markdown)</label>
              <textarea id="bodyMarkdown" name="bodyMarkdown" required placeholder="Write your email in markdown…" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 min-h-[200px] resize-y focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
            </div>
            <button type="submit" class="inline-block px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 cursor-pointer border-none no-underline">Create Draft</button>
          </form>
        </div>
      </AdminLayout>,
    );
  });

  app.post("/campaigns/new", async (c) => {
    const body = await c.req.parseBody();
    const listId = Number(body["listId"]);
    const fromAddress = String(body["fromAddress"] ?? "").trim();
    const subject = String(body["subject"] ?? "").trim();
    const bodyMarkdown = String(body["bodyMarkdown"] ?? "");

    if (!listId || !fromAddress || !subject || !bodyMarkdown) {
      return c.redirect("/admin/campaigns/new");
    }

    const result = db
      .insert(schema.campaigns)
      .values({ listId, fromAddress, subject, bodyMarkdown })
      .returning({ id: schema.campaigns.id })
      .get();

    logEvent(db, {
      type: "admin.campaign_created",
      detail: subject,
      campaignId: result.id,
    });

    return c.redirect(`/admin/campaigns/${result.id}`);
  });

  app.get("/campaigns/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const campaign = db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id)).get();
    if (!campaign) return c.notFound();

    const list = db.select().from(schema.lists).where(eq(schema.lists.id, campaign.listId)).get();

    const sends = db
      .select()
      .from(schema.campaignSends)
      .where(eq(schema.campaignSends.campaignId, id))
      .all();

    const inboundReplies = db
      .select()
      .from(schema.inboundMessages)
      .where(eq(schema.inboundMessages.campaignId, id))
      .orderBy(desc(schema.inboundMessages.createdAt))
      .all();

    const htmlContent = await marked(campaign.bodyMarkdown);

    return c.html(
      <AdminLayout title={campaign.subject}>
        <h1 class="text-2xl font-bold mt-0 mb-4">{campaign.subject}</h1>
        <div class="flex gap-4 items-center mb-4">
          <CampaignBadge status={campaign.status} />
          <span class="text-sm text-gray-500">
            List: {list?.name ?? "Unknown"} &middot; From: {campaign.fromAddress}
          </span>
        </div>

        {campaign.lastError && (
          <div class="bg-red-50 border border-red-200 rounded-lg p-4 mb-6 font-mono text-sm whitespace-pre-wrap break-all text-red-800">
            <strong>Error:</strong>{"\n"}{campaign.lastError}
          </div>
        )}

        {campaign.status === "draft" && (
          <form method="post" action={`/admin/campaigns/${id}/send`} class="mb-6">
            <button type="submit" class="inline-block px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-md hover:bg-red-700 cursor-pointer border-none no-underline">
              Send Campaign
            </button>
          </form>
        )}

        {campaign.status === "failed" && (
          <div class="flex gap-2 mb-6">
            <form method="post" action={`/admin/campaigns/${id}/retry`}>
              <button type="submit" class="inline-block px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 cursor-pointer border-none no-underline">
                Retry (skip already sent)
              </button>
            </form>
            <form method="post" action={`/admin/campaigns/${id}/reset`}>
              <button type="submit" class="inline-block px-4 py-2 bg-gray-500 text-white text-sm font-medium rounded-md hover:bg-gray-600 cursor-pointer border-none no-underline">
                Reset to Draft
              </button>
            </form>
          </div>
        )}

        {campaign.status === "sending" && (
          <div class="flex gap-2 mb-6">
            <form method="post" action={`/admin/campaigns/${id}/reset`}>
              <button type="submit" class="inline-block px-4 py-2 bg-gray-500 text-white text-sm font-medium rounded-md hover:bg-gray-600 cursor-pointer border-none no-underline">
                Force Reset to Draft (stuck?)
              </button>
            </form>
          </div>
        )}

        <h2 class="text-xl font-semibold mt-6 mb-3">Preview</h2>
        <div class="p-4 bg-white border border-gray-200 rounded-md" dangerouslySetInnerHTML={{ __html: htmlContent }} />

        {sends.length > 0 && (
          <>
            <h2 class="text-xl font-semibold mt-6 mb-3">Sends ({sends.length})</h2>
            <table class="w-full bg-white rounded-lg overflow-hidden mb-6 text-sm">
              <thead>
                <tr>
                  <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Subscriber ID</th>
                  <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Status</th>
                  <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Sent At</th>
                  <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">SES Message ID</th>
                </tr>
              </thead>
              <tbody>
                {sends.map((send) => (
                  <tr>
                    <td class="px-4 py-3 border-b border-gray-100">{send.subscriberId}</td>
                    <td class="px-4 py-3 border-b border-gray-100">{send.status}</td>
                    <td class="px-4 py-3 border-b border-gray-100">{fmtDateTime(send.sentAt)}</td>
                    <td class="px-4 py-3 border-b border-gray-100 text-xs">{send.sesMessageId ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {inboundReplies.length > 0 && (
          <>
            <h2 class="text-xl font-semibold mt-6 mb-3">Replies ({inboundReplies.length})</h2>
            <table class="w-full bg-white rounded-lg overflow-hidden mb-6 text-sm">
              <thead>
                <tr>
                  <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">From</th>
                  <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Subject</th>
                  <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Received</th>
                  <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200"></th>
                </tr>
              </thead>
              <tbody>
                {inboundReplies.map((r) => (
                  <tr>
                    <td class="px-4 py-3 border-b border-gray-100">{r.source}</td>
                    <td class="px-4 py-3 border-b border-gray-100">{r.subject}</td>
                    <td class="px-4 py-3 border-b border-gray-100">{fmtDateTime(r.createdAt)}</td>
                    <td class="px-4 py-3 border-b border-gray-100"><a href={`/admin/inbound/${r.id}`} class="text-blue-600 hover:text-blue-800">View</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        <hr class="my-8" />
        <form method="post" action={`/admin/campaigns/${id}/delete`} onsubmit="return confirm('Delete this campaign and all its send records? This cannot be undone.')">
          <button type="submit" class="inline-block px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-md hover:bg-red-700 cursor-pointer border-none no-underline">
            Delete Campaign
          </button>
        </form>
      </AdminLayout>,
    );
  });

  app.post("/campaigns/:id/send", async (c) => {
    const id = Number(c.req.param("id"));
    try {
      await sendCampaign(db, config, id);
    } catch (err) {
      // error is recorded in campaign.lastError by sender
    }
    return c.redirect(`/admin/campaigns/${id}`);
  });

  app.post("/campaigns/:id/retry", async (c) => {
    const id = Number(c.req.param("id"));
    try {
      await sendCampaign(db, config, id);
    } catch (err) {
      // error is recorded in campaign.lastError by sender
    }
    return c.redirect(`/admin/campaigns/${id}`);
  });

  app.post("/campaigns/:id/reset", (c) => {
    const id = Number(c.req.param("id"));
    db.update(schema.campaigns)
      .set({ status: "draft", lastError: null })
      .where(eq(schema.campaigns.id, id))
      .run();
    return c.redirect(`/admin/campaigns/${id}`);
  });

  app.post("/campaigns/:id/delete", (c) => {
    const id = Number(c.req.param("id"));
    const campaign = db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id)).get();

    logEvent(db, {
      type: "admin.campaign_deleted",
      detail: campaign?.subject ?? `id=${id}`,
      campaignId: id,
    });

    // clear linked inbound messages (unlink, don't delete)
    db.update(schema.inboundMessages)
      .set({ campaignId: null })
      .where(eq(schema.inboundMessages.campaignId, id))
      .run();
    // delete sends
    db.delete(schema.campaignSends)
      .where(eq(schema.campaignSends.campaignId, id))
      .run();
    // delete campaign
    db.delete(schema.campaigns)
      .where(eq(schema.campaigns.id, id))
      .run();
    return c.redirect("/admin/campaigns");
  });

  // Inbound
  app.get("/inbound", (c) => {
    const messages = db
      .select()
      .from(schema.inboundMessages)
      .orderBy(desc(schema.inboundMessages.createdAt))
      .limit(100)
      .all();

    return c.html(
      <AdminLayout title="Inbound">
        <h1 class="text-2xl font-bold mt-0 mb-4">Inbound Messages</h1>
        <table class="w-full bg-white rounded-lg overflow-hidden mb-6 text-sm">
          <thead>
            <tr>
              <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">From</th>
              <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Subject</th>
              <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Date</th>
              <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">SPF</th>
              <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">DKIM</th>
              <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">DMARC</th>
            </tr>
          </thead>
          <tbody>
            {messages.map((msg) => (
              <tr class={msg.readAt ? "" : "font-semibold"}>
                <td class="px-4 py-3 border-b border-gray-100">{msg.source}</td>
                <td class="px-4 py-3 border-b border-gray-100">
                  <a href={`/admin/inbound/${msg.id}`} class="text-blue-600 hover:text-blue-800">{msg.subject}</a>
                </td>
                <td class="px-4 py-3 border-b border-gray-100">{fmtDateTime(msg.timestamp)}</td>
                <td class="px-4 py-3 border-b border-gray-100">
                  <Verdict value={msg.spfVerdict} />
                </td>
                <td class="px-4 py-3 border-b border-gray-100">
                  <Verdict value={msg.dkimVerdict} />
                </td>
                <td class="px-4 py-3 border-b border-gray-100">
                  <Verdict value={msg.dmarcVerdict} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </AdminLayout>,
    );
  });

  app.get("/inbound/:id", (c) => {
    const id = Number(c.req.param("id"));
    const msg = db.select().from(schema.inboundMessages).where(eq(schema.inboundMessages.id, id)).get();
    if (!msg) return c.notFound();

    // auto-mark as read
    if (!msg.readAt) {
      db.update(schema.inboundMessages)
        .set({ readAt: new Date().toISOString() })
        .where(eq(schema.inboundMessages.id, id))
        .run();
    }

    const msgReplies = db
      .select()
      .from(schema.replies)
      .where(eq(schema.replies.inboundMessageId, id))
      .orderBy(desc(schema.replies.sentAt))
      .all();

    return c.html(
      <AdminLayout title={`Inbound: ${msg.subject}`}>
        <h1 class="text-2xl font-bold mt-0 mb-4">{msg.subject}</h1>
        <div class="bg-white border border-gray-200 rounded-lg p-5 mb-6">
          <dl>
            <dt class="font-semibold text-xs uppercase text-gray-500 first:mt-0">From</dt>
            <dd class="mt-1 ml-0">{msg.fromAddrs}</dd>
            <dt class="font-semibold text-xs uppercase text-gray-500 mt-3">To</dt>
            <dd class="mt-1 ml-0">{msg.toAddrs}</dd>
            <dt class="font-semibold text-xs uppercase text-gray-500 mt-3">Subject</dt>
            <dd class="mt-1 ml-0">{msg.subject}</dd>
            <dt class="font-semibold text-xs uppercase text-gray-500 mt-3">Date</dt>
            <dd class="mt-1 ml-0">{fmtDateTime(msg.timestamp)}</dd>
            <dt class="font-semibold text-xs uppercase text-gray-500 mt-3">Verdicts</dt>
            <dd class="mt-1 ml-0">
              SPF: <Verdict value={msg.spfVerdict} /> &nbsp;
              DKIM: <Verdict value={msg.dkimVerdict} /> &nbsp;
              DMARC: <Verdict value={msg.dmarcVerdict} />
            </dd>
          </dl>
          {msg.s3Key && (
            <p class="mt-4">
              <a href={`/admin/inbound/${id}/raw`} class="inline-block px-4 py-2 bg-gray-500 text-white text-sm font-medium rounded-md hover:bg-gray-600 cursor-pointer border-none no-underline">
                Download Raw .eml
              </a>
            </p>
          )}
        </div>

        <h2 class="text-xl font-semibold mt-6 mb-3">Replies</h2>
        {msgReplies.length > 0 ? (
          <table class="w-full bg-white rounded-lg overflow-hidden mb-6 text-sm">
            <thead>
              <tr>
                <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">From</th>
                <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">To</th>
                <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Subject</th>
                <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Sent At</th>
              </tr>
            </thead>
            <tbody>
              {msgReplies.map((r) => (
                <tr>
                  <td class="px-4 py-3 border-b border-gray-100">{r.fromAddr}</td>
                  <td class="px-4 py-3 border-b border-gray-100">{r.toAddr}</td>
                  <td class="px-4 py-3 border-b border-gray-100">{r.subject}</td>
                  <td class="px-4 py-3 border-b border-gray-100">{fmtDateTime(r.sentAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>No replies yet.</p>
        )}

        <div class="bg-white border border-gray-200 rounded-lg p-5 mb-6">
          <h2 class="text-xl font-semibold mt-0 mb-3">Send Reply</h2>
          <form method="post" action={`/admin/inbound/${id}/reply`}>
            <div class="mb-4">
              <label for="fromAddr" class="block text-sm font-medium text-gray-700 mb-1">From</label>
              <input
                type="email"
                id="fromAddr"
                name="fromAddr"
                required
                value={msg.toAddrs.includes(",") ? msg.toAddrs.split(",")[0]!.trim() : msg.toAddrs}
                class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <div class="mb-4">
              <label for="toAddr" class="block text-sm font-medium text-gray-700 mb-1">To</label>
              <input
                type="email"
                id="toAddr"
                name="toAddr"
                required
                value={msg.source}
                class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <div class="mb-4">
              <label for="replySubject" class="block text-sm font-medium text-gray-700 mb-1">Subject</label>
              <input
                type="text"
                id="replySubject"
                name="subject"
                required
                value={msg.subject.startsWith("Re:") ? msg.subject : `Re: ${msg.subject}`}
                class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <div class="mb-4">
              <label for="replyBody" class="block text-sm font-medium text-gray-700 mb-1">Body (plain text)</label>
              <textarea id="replyBody" name="body" required placeholder="Your reply…" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 min-h-[200px] resize-y focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
            </div>
            <button type="submit" class="inline-block px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 cursor-pointer border-none no-underline">Send Reply</button>
          </form>
        </div>

        <hr class="my-8" />
        <div class="flex gap-2">
          <form method="post" action={`/admin/inbound/${id}/toggle-read`}>
            <button type="submit" class="inline-block px-4 py-2 bg-gray-500 text-white text-sm font-medium rounded-md hover:bg-gray-600 cursor-pointer border-none no-underline">
              Mark as {msg.readAt ? "Unread" : "Read"}
            </button>
          </form>
          <form method="post" action={`/admin/inbound/${id}/delete`} onsubmit="return confirm('Delete this inbound message and its replies? This cannot be undone.')">
            <button type="submit" class="inline-block px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-md hover:bg-red-700 cursor-pointer border-none no-underline">
              Delete
            </button>
          </form>
        </div>
      </AdminLayout>,
    );
  });

  app.post("/inbound/:id/toggle-read", (c) => {
    const id = Number(c.req.param("id"));
    const msg = db.select().from(schema.inboundMessages).where(eq(schema.inboundMessages.id, id)).get();
    if (!msg) return c.notFound();
    db.update(schema.inboundMessages)
      .set({ readAt: msg.readAt ? null : new Date().toISOString() })
      .where(eq(schema.inboundMessages.id, id))
      .run();
    return c.redirect(`/admin/inbound/${id}`);
  });

  app.post("/inbound/:id/delete", (c) => {
    const id = Number(c.req.param("id"));
    const msg = db.select().from(schema.inboundMessages).where(eq(schema.inboundMessages.id, id)).get();

    logEvent(db, {
      type: "admin.inbound_deleted",
      detail: msg?.subject ?? `id=${id}`,
      inboundMessageId: id,
    });

    // delete replies first (FK)
    db.delete(schema.replies)
      .where(eq(schema.replies.inboundMessageId, id))
      .run();
    db.delete(schema.inboundMessages)
      .where(eq(schema.inboundMessages.id, id))
      .run();
    return c.redirect("/admin/inbound");
  });

  app.get("/inbound/:id/raw", async (c) => {
    const id = Number(c.req.param("id"));
    const msg = db.select().from(schema.inboundMessages).where(eq(schema.inboundMessages.id, id)).get();
    if (!msg || !msg.s3Key) return c.notFound();

    const s3 = new S3Client({ region: config.awsRegion });
    const command = new GetObjectCommand({
      Bucket: config.s3Bucket,
      Key: msg.s3Key,
    });
    const url = await getSignedUrl(s3, command, { expiresIn: 300 });
    return c.redirect(url);
  });

  app.post("/inbound/:id/reply", async (c) => {
    const id = Number(c.req.param("id"));
    const msg = db.select().from(schema.inboundMessages).where(eq(schema.inboundMessages.id, id)).get();
    if (!msg) return c.notFound();

    const body = await c.req.parseBody();
    const fromAddr = String(body["fromAddr"] ?? "").trim();
    const toAddr = String(body["toAddr"] ?? "").trim();
    const subject = String(body["subject"] ?? "").trim();
    const replyBody = String(body["body"] ?? "").trim();

    if (!fromAddr || !toAddr || !subject || !replyBody) {
      return c.redirect(`/admin/inbound/${id}`);
    }

    const inReplyTo = msg.messageId;
    const fromDomain = fromAddr.split("@")[1] ?? config.fromDomain;
    const messageId = `<${crypto.randomUUID()}@${fromDomain}>`;
    const rawLines = [
      `From: ${fromAddr}`,
      `To: ${toAddr}`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Message-ID: ${messageId}`,
      `Date: ${new Date().toUTCString()}`,
      `In-Reply-To: <${inReplyTo}>`,
      `References: <${inReplyTo}>`,
      `Content-Type: text/plain; charset=UTF-8`,
      `Content-Transfer-Encoding: 7bit`,
      ``,
      replyBody,
    ];
    const rawEmail = rawLines.join("\r\n");

    const ses = new SESv2Client({ region: config.awsRegion });
    const result = await ses.send(
      new SendEmailCommand({
        Content: {
          Raw: {
            Data: new TextEncoder().encode(rawEmail),
          },
        },
        ConfigurationSetName: config.sesConfigSet || undefined,
      }),
    );

    db.insert(schema.replies)
      .values({
        inboundMessageId: id,
        fromAddr,
        toAddr,
        subject,
        body: replyBody,
        sesMessageId: result.MessageId ?? null,
        inReplyTo,
      })
      .run();

    logEvent(db, {
      type: "admin.reply_sent",
      detail: toAddr,
      inboundMessageId: id,
    });

    return c.redirect(`/admin/inbound/${id}`);
  });

  // Activity feed
  app.get("/activity", (c) => {
    const recentEvents = db
      .select()
      .from(schema.events)
      .orderBy(desc(schema.events.createdAt))
      .limit(200)
      .all();

    function eventIcon(type: string): string {
      if (type.startsWith("subscriber.")) return "sub";
      if (type.startsWith("campaign.")) return "cam";
      if (type.startsWith("inbound.")) return "in";
      if (type.startsWith("admin.")) return "adm";
      return "?";
    }

    function eventColor(type: string): string {
      if (type.includes("created") || type.includes("added") || type.includes("confirmed")) return "text-green-800";
      if (type.includes("deleted") || type.includes("failed")) return "text-red-800";
      if (type.includes("unsubscribed")) return "text-amber-800";
      if (type.includes("sending") || type.includes("sent") || type.includes("reply_sent")) return "text-blue-800";
      if (type.includes("received")) return "text-purple-800";
      return "text-gray-700";
    }

    function eventLink(e: typeof recentEvents[number]): string | null {
      if (e.subscriberId) return `/admin/subscribers/${e.subscriberId}`;
      if (e.campaignId) return `/admin/campaigns/${e.campaignId}`;
      if (e.inboundMessageId) return `/admin/inbound/${e.inboundMessageId}`;
      return null;
    }

    return c.html(
      <AdminLayout title="Activity">
        <h1 class="text-2xl font-bold mt-0 mb-4">Activity</h1>
        <div class="flex flex-col gap-1">
          {recentEvents.map((e) => {
            const link = eventLink(e);
            return (
              <div class="flex items-baseline gap-3 py-2 border-b border-gray-100">
                <span class={`text-[0.6875rem] font-semibold uppercase tracking-wide min-w-[2.5rem] ${eventColor(e.type)}`}>
                  {eventIcon(e.type)}
                </span>
                <span class="text-sm font-medium min-w-[12rem]">
                  {e.type}
                </span>
                <span class="text-sm text-gray-600 flex-1">
                  {link ? <a href={link} class="text-blue-600 hover:text-blue-800">{e.detail}</a> : e.detail}
                </span>
                <span class="text-xs text-gray-400 whitespace-nowrap">
                  {fmtDateTime(e.createdAt)}
                </span>
              </div>
            );
          })}
          {recentEvents.length === 0 && <p class="text-gray-400">No events yet.</p>}
        </div>
      </AdminLayout>,
    );
  });

  return app;
}
