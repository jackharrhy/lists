import { Hono } from "hono";
import { eq, desc, sql, and, inArray } from "drizzle-orm";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { marked } from "marked";
import type { Db } from "../db";
import { schema } from "../db";
import type { Config } from "../config";
import { adminAuth, createSession, destroySession, requireRole, requireListAccess, getAccessibleListIds } from "../auth";
import { sendCampaign } from "../services/sender";
import { renderConfirmation } from "../../emails/render";
import { createSubscriber, confirmSubscriber, confirmSubscriberDomain, getConfirmedSubscribers } from "../services/subscriber";
import { logEvent } from "../services/events";
import { renderNewsletter } from "../../emails/render";
import { buildUnsubscribeUrl, buildPreferencesUrl, buildConfirmUrl } from "../compliance";

// ---------------------------------------------------------------------------
// Layout & components
// ---------------------------------------------------------------------------

type User = typeof schema.users.$inferSelect;

function AdminLayout({
  title,
  children,
  flash,
  user,
}: {
  title: string;
  children: any;
  flash?: string;
  user?: User;
}) {
  const isAdmin = user?.role === "owner" || user?.role === "admin";
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
            <a href="/admin/tags" class="text-gray-400 text-sm no-underline hover:text-white">Tags</a>
            <a href="/admin/import" class="text-gray-400 text-sm no-underline hover:text-white">Import</a>
            {isAdmin && (
              <a href="/admin/users" class="text-gray-400 text-sm no-underline hover:text-white">Users</a>
            )}
            <span class="text-gray-400 text-sm">{user?.name ?? user?.email ?? ""}</span>
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

  function describeAudience(campaign: { listId: number | null; audience: string | null }, lists: Map<number, string>, tags: Map<number, string>): string {
    if (campaign.listId) return lists.get(campaign.listId) ?? "Unknown list";
    if (!campaign.audience) return "All";
    const aud = JSON.parse(campaign.audience);
    if (aud.type === "all") return "All subscribers";
    if (aud.type === "tag") return `Tag: ${tags.get(aud.tagId) ?? "Unknown"}`;
    if (aud.type === "subscribers") return `${aud.subscriberIds.length} specific`;
    return "Unknown";
  }

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
                type="email"
                name="email"
                placeholder="Email"
                required
                autofocus
                class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 box-border"
              />
              <input
                type="password"
                name="password"
                placeholder="Password"
                required
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
    const email = body["email"] as string;
    const password = body["password"] as string;

    const renderError = (message: string) =>
      c.html(
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <title>Login - Lists Admin</title>
            <link rel="stylesheet" href="/static/styles.css" />
          </head>
          <body class="font-sans flex items-center justify-center min-h-screen m-0 bg-gray-50">
            <div class="bg-white p-8 rounded-lg border border-gray-200 w-80">
              <h1 class="m-0 mb-4 text-xl text-center font-bold">Lists Admin</h1>
              <p class="text-red-600 text-sm mb-3 text-center">{message}</p>
              <form method="post" action="/admin/login">
                <input
                  type="email"
                  name="email"
                  placeholder="Email"
                  required
                  autofocus
                  class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 box-border"
                />
                <input
                  type="password"
                  name="password"
                  placeholder="Password"
                  required
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

    if (!email || !password) return renderError("Email and password are required.");

    const user = db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .get();

    if (!user) return renderError("Invalid email or password.");

    const valid = await Bun.password.verify(password, user.passwordHash);
    if (!valid) return renderError("Invalid email or password.");

    const token = createSession(user.id);
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

  app.use("/*", adminAuth(db));

  // ---- Preview endpoints (raw HTML, no AdminLayout) -----------------------

  app.get("/campaigns/:id/preview", async (c) => {
    const id = Number(c.req.param("id"));
    const campaign = db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id)).get();
    if (!campaign) return c.notFound();

    let listName = "Newsletter";
    if (campaign.listId) {
      const list = db.select().from(schema.lists).where(eq(schema.lists.id, campaign.listId)).get();
      if (list) {
        listName = list.name;
      }
    }

    let unsubscribeUrl = "#unsubscribe";
    let preferencesUrl = "#preferences";

    const subscriberId = c.req.query("subscriberId");
    if (subscriberId) {
      const sub = db.select().from(schema.subscribers).where(eq(schema.subscribers.id, Number(subscriberId))).get();
      if (sub) {
        unsubscribeUrl = buildUnsubscribeUrl(config.baseUrl, sub.unsubscribeToken, campaign.listId ?? undefined);
        preferencesUrl = buildPreferencesUrl(config.baseUrl, sub.unsubscribeToken);
      }
    }

    const contentHtml = await marked(campaign.bodyMarkdown);
    const { html } = await renderNewsletter({
      subject: campaign.subject,
      contentHtml,
      listName,
      unsubscribeUrl,
      preferencesUrl,
    });

    return c.html(html);
  });

  app.post("/campaigns/preview", async (c) => {
    const { bodyMarkdown, subject, listName } = await c.req.json();
    const contentHtml = await marked(bodyMarkdown || "");
    const { html } = await renderNewsletter({
      subject: subject || "Preview",
      contentHtml,
      listName: listName || "Newsletter",
      unsubscribeUrl: "#unsubscribe",
      preferencesUrl: "#preferences",
    });

    return c.html(html);
  });

  // Dashboard
  app.get("/", (c) => {
    const user = c.get("user") as User;
    const listAccess = getAccessibleListIds(db, user);
    const isAdmin = user.role === "owner" || user.role === "admin";

    let activeCount: number;
    let listCount: number;
    let campaignCount: number;
    let recentCampaigns: (typeof schema.campaigns.$inferSelect)[];

    if (listAccess === "all") {
      activeCount = db
        .select({ count: sql<number>`count(*)` })
        .from(schema.subscribers)
        .where(eq(schema.subscribers.status, "active"))
        .get()!.count;

      listCount = db
        .select({ count: sql<number>`count(*)` })
        .from(schema.lists)
        .get()!.count;

      campaignCount = db
        .select({ count: sql<number>`count(*)` })
        .from(schema.campaigns)
        .get()!.count;

      recentCampaigns = db
        .select()
        .from(schema.campaigns)
        .orderBy(desc(schema.campaigns.createdAt))
        .limit(5)
        .all();
    } else if (listAccess.length === 0) {
      activeCount = 0;
      listCount = 0;
      campaignCount = 0;
      recentCampaigns = [];
    } else {
      activeCount = db
        .select({ count: sql<number>`count(DISTINCT ${schema.subscribers.id})` })
        .from(schema.subscribers)
        .innerJoin(schema.subscriberLists, eq(schema.subscriberLists.subscriberId, schema.subscribers.id))
        .where(
          and(
            eq(schema.subscribers.status, "active"),
            inArray(schema.subscriberLists.listId, listAccess),
          ),
        )
        .get()!.count;

      listCount = listAccess.length;

      campaignCount = db
        .select({ count: sql<number>`count(*)` })
        .from(schema.campaigns)
        .where(inArray(schema.campaigns.listId, listAccess))
        .get()!.count;

      recentCampaigns = db
        .select()
        .from(schema.campaigns)
        .where(inArray(schema.campaigns.listId, listAccess))
        .orderBy(desc(schema.campaigns.createdAt))
        .limit(5)
        .all();
    }

    return c.html(
      <AdminLayout title="Dashboard" user={user}>
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
          name: schema.subscribers.name,
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
                <td class="px-4 py-3 border-b border-gray-100">{sub.name ?? "—"}</td>
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
              <label for="name" class="block text-sm font-medium text-gray-700 mb-1">Name (optional)</label>
              <input type="text" id="name" name="name" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
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
            <label for="name" class="block text-sm font-medium text-gray-700 mb-1">Name</label>
            <input type="text" id="name" name="name" value={sub.name ?? ""} class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
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
    const name = String(body["name"] ?? "").trim() || null;
    const status = String(body["status"] ?? "active");

    db.update(schema.subscribers)
      .set({ email, name, status })
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

  // Lists
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
    const campaigns = db.select().from(schema.campaigns).where(eq(schema.campaigns.listId, id)).all();
    for (const cam of campaigns) {
      db.delete(schema.campaignSends).where(eq(schema.campaignSends.campaignId, cam.id)).run();
    }
    db.delete(schema.campaigns).where(eq(schema.campaigns.listId, id)).run();
    // delete user_lists references
    db.delete(schema.userLists).where(eq(schema.userLists.listId, id)).run();
    // delete list
    db.delete(schema.lists).where(eq(schema.lists.id, id)).run();

    return c.redirect("/admin/lists");
  });

  // Campaigns
  app.get("/campaigns", (c) => {
    const user = c.get("user") as User;
    const listAccess = getAccessibleListIds(db, user);

    let allCampaigns: (typeof schema.campaigns.$inferSelect)[];
    if (listAccess === "all") {
      allCampaigns = db
        .select()
        .from(schema.campaigns)
        .orderBy(desc(schema.campaigns.createdAt))
        .all();
    } else if (listAccess.length === 0) {
      allCampaigns = [];
    } else {
      allCampaigns = db
        .select()
        .from(schema.campaigns)
        .where(inArray(schema.campaigns.listId, listAccess))
        .orderBy(desc(schema.campaigns.createdAt))
        .all();
    }

    // Build lookup maps for list and tag names
    const allLists = db.select().from(schema.lists).all();
    const listNameMap = new Map(allLists.map((l) => [l.id, l.name]));
    const allTags = db.select().from(schema.tags).all();
    const tagNameMap = new Map(allTags.map((t) => [t.id, t.name]));

    return c.html(
      <AdminLayout title="Campaigns" user={user}>
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
              <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Audience</th>
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
                <td class="px-4 py-3 border-b border-gray-100">{describeAudience(cam, listNameMap, tagNameMap)}</td>
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

    const allTags = db.select().from(schema.tags).all();
    const allSubscribers = db.select().from(schema.subscribers).where(eq(schema.subscribers.status, "active")).all();

    return c.html(
      <AdminLayout title="New Campaign" user={user}>
        <h1 class="text-2xl font-bold mt-0 mb-4">New Campaign</h1>
        <div class="grid grid-cols-2 gap-6">
          <div>
            <div class="bg-white border border-gray-200 rounded-lg p-5 mb-6">
              <form method="post" action="/admin/campaigns/new">
                <div class="mb-4">
                  <label for="audienceMode" class="block text-sm font-medium text-gray-700 mb-1">Audience</label>
                  <select id="audienceMode" name="audienceMode" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
                    <option value="list">A list</option>
                    <option value="all">All subscribers</option>
                    <option value="tag">A tag</option>
                    <option value="specific">Specific people</option>
                  </select>
                </div>

                <div data-audience="list" class="mb-4">
                  <label for="listId" class="block text-sm font-medium text-gray-700 mb-1">List</label>
                  <select id="listId" name="listId" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
                    <option value="">Select a list...</option>
                    {allLists.map((list) => (
                      <option value={String(list.id)} data-from-address={list.fromAddress}>
                        {list.name} ({list.slug})
                      </option>
                    ))}
                  </select>
                </div>

                <div data-audience="tag" class="mb-4 hidden">
                  <label for="tagId" class="block text-sm font-medium text-gray-700 mb-1">Tag</label>
                  <select id="tagId" name="tagId" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
                    <option value="">Select a tag...</option>
                    {allTags.map((tag) => (
                      <option value={String(tag.id)}>{tag.name}</option>
                    ))}
                  </select>
                </div>

                <div data-audience="specific" class="mb-4 hidden">
                  <label class="block text-sm font-medium text-gray-700 mb-1">Subscribers</label>
                  <input type="text" id="subscriberSearch" placeholder="Search by email or name..." class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                  <div id="searchResults" class="border border-gray-200 rounded-md max-h-40 overflow-y-auto hidden"></div>
                  <div id="selectedSubscribers" class="flex flex-wrap gap-2 mt-2"></div>
                  <input type="hidden" name="subscriberIds" id="subscriberIds" />
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
          </div>
          <div>
            <div class="bg-white border border-gray-200 rounded-lg p-5 mb-6">
              <h2 class="text-lg font-semibold mt-0 mb-3">Preview</h2>
              <iframe id="previewFrame" class="w-full border-0" style="min-height: 500px;" srcdoc="<p style='color:#999;font-family:system-ui;padding:2rem'>Start writing to see a preview</p>" />
            </div>
          </div>
        </div>
        <script dangerouslySetInnerHTML={{ __html: `var subscribers = ${JSON.stringify(allSubscribers.map(s => ({ id: s.id, email: s.email, name: s.name })))};` }} />
        <script dangerouslySetInnerHTML={{ __html: `
          (function() {
            // Mode switching
            var mode = document.getElementById('audienceMode');
            mode.addEventListener('change', function() {
              document.querySelectorAll('[data-audience]').forEach(function(el) { el.classList.add('hidden'); });
              var target = document.querySelector('[data-audience="' + this.value + '"]');
              if (target) target.classList.remove('hidden');
            });

            // From address auto-fill: only for list mode
            var lastDefault = '';
            var listSelect = document.getElementById('listId');
            if (listSelect) {
              listSelect.addEventListener('change', function() {
                var opt = this.options[this.selectedIndex];
                var addr = opt.dataset.fromAddress || '';
                var input = document.getElementById('fromAddress');
                if (!input.value || input.value === lastDefault) input.value = addr;
                lastDefault = addr;
              });
            }

            // Subscriber picker
            var selected = new Set();
            var search = document.getElementById('subscriberSearch');
            var results = document.getElementById('searchResults');
            var chips = document.getElementById('selectedSubscribers');
            var hidden = document.getElementById('subscriberIds');

            function render() {
              chips.innerHTML = '';
              selected.forEach(function(id) {
                var sub = subscribers.find(function(s) { return s.id === id; });
                if (!sub) return;
                var chip = document.createElement('span');
                chip.className = 'inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800';
                chip.textContent = sub.email;
                var btn = document.createElement('button');
                btn.type = 'button';
                btn.textContent = '\\u00d7';
                btn.className = 'ml-1 text-blue-600 hover:text-blue-800 cursor-pointer';
                btn.onclick = function() { selected.delete(id); render(); };
                chip.appendChild(btn);
                chips.appendChild(chip);
              });
              hidden.value = Array.from(selected).join(',');
            }

            if (search) {
              search.addEventListener('input', function() {
                var q = this.value.toLowerCase();
                if (!q) { results.classList.add('hidden'); return; }
                var matches = subscribers.filter(function(s) {
                  return !selected.has(s.id) && (s.email.toLowerCase().includes(q) || (s.name || '').toLowerCase().includes(q));
                }).slice(0, 10);
                results.innerHTML = '';
                matches.forEach(function(s) {
                  var div = document.createElement('div');
                  div.className = 'px-3 py-2 cursor-pointer hover:bg-gray-50 text-sm';
                  div.textContent = s.email + (s.name ? ' (' + s.name + ')' : '');
                  div.onclick = function() { selected.add(s.id); search.value = ''; results.classList.add('hidden'); render(); };
                  results.appendChild(div);
                });
                results.classList.toggle('hidden', matches.length === 0);
              });
            }

            // Preview
            var timer;
            var textarea = document.getElementById('bodyMarkdown');
            var subject = document.getElementById('subject');
            var frame = document.getElementById('previewFrame');

            function updatePreview() {
              var body = textarea.value;
              if (!body.trim()) return;
              fetch('/admin/campaigns/preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  bodyMarkdown: body,
                  subject: subject.value || 'Preview',
                  listName: 'Preview'
                })
              })
              .then(function(r) { return r.text(); })
              .then(function(html) { frame.srcdoc = html; });
            }

            textarea.addEventListener('input', function() {
              clearTimeout(timer);
              timer = setTimeout(updatePreview, 500);
            });
            subject.addEventListener('input', function() {
              clearTimeout(timer);
              timer = setTimeout(updatePreview, 500);
            });
          })();
        `}} />
      </AdminLayout>,
    );
  });

  app.post("/campaigns/new", async (c) => {
    const user = c.get("user") as User;
    const body = await c.req.parseBody();
    const fromAddress = String(body["fromAddress"] ?? "").trim();
    const subject = String(body["subject"] ?? "").trim();
    const bodyMarkdown = String(body["bodyMarkdown"] ?? "");

    const audienceMode = String(body["audienceMode"] ?? "list");
    let listId: number | null = null;
    let audience: string | null = null;

    if (audienceMode === "list") {
      const rawListId = body["listId"];
      if (!rawListId) return c.redirect("/admin/campaigns/new");
      listId = Number(rawListId);
    } else if (audienceMode === "all") {
      audience = JSON.stringify({ type: "all" });
    } else if (audienceMode === "tag") {
      const tagId = Number(body["tagId"]);
      if (!tagId) return c.redirect("/admin/campaigns/new");
      audience = JSON.stringify({ type: "tag", tagId });
    } else if (audienceMode === "specific") {
      const ids = String(body["subscriberIds"] ?? "").split(",").map(Number).filter(Boolean);
      if (ids.length === 0) return c.redirect("/admin/campaigns/new");
      audience = JSON.stringify({ type: "subscribers", subscriberIds: ids });
    }

    if (!fromAddress || !subject || !bodyMarkdown) {
      return c.redirect("/admin/campaigns/new");
    }

    // Verify user has access to this list (admins can send to "all")
    if (listId !== null) {
      const listAccess = getAccessibleListIds(db, user);
      if (listAccess !== "all" && !listAccess.includes(listId)) {
        return c.text("Forbidden", 403);
      }
    }

    const result = db
      .insert(schema.campaigns)
      .values({ listId, audience, fromAddress, subject, bodyMarkdown })
      .returning({ id: schema.campaigns.id })
      .get();

    logEvent(db, {
      type: "admin.campaign_created",
      detail: subject,
      campaignId: result.id,
      userId: user.id,
    });

    return c.redirect(`/admin/campaigns/${result.id}`);
  });

  app.get("/campaigns/:id", async (c) => {
    const user = c.get("user") as User;
    const id = Number(c.req.param("id"));
    const campaign = db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id)).get();
    if (!campaign) return c.notFound();

    // Check list access (null listId = "all subscribers", accessible to admins/owners)
    const listAccess = getAccessibleListIds(db, user);
    if (campaign.listId !== null && listAccess !== "all" && !listAccess.includes(campaign.listId)) {
      return c.text("Forbidden", 403);
    }

    const list = campaign.listId
      ? db.select().from(schema.lists).where(eq(schema.lists.id, campaign.listId)).get()
      : null;

    // Build lookup maps for audience description
    const detailLists = db.select().from(schema.lists).all();
    const detailListMap = new Map(detailLists.map((l) => [l.id, l.name]));
    const detailTags = db.select().from(schema.tags).all();
    const detailTagMap = new Map(detailTags.map((t) => [t.id, t.name]));
    const audienceDesc = describeAudience(campaign, detailListMap, detailTagMap);

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

    // Get subscribers for preview picker based on audience
    let previewSubscribers: { id: number; email: string }[];
    if (campaign.listId) {
      previewSubscribers = getConfirmedSubscribers(db, campaign.listId);
    } else if (campaign.audience) {
      const aud = JSON.parse(campaign.audience) as { type: string; tagId?: number; subscriberIds?: number[] };
      if (aud.type === "tag" && aud.tagId) {
        previewSubscribers = db
          .selectDistinct({
            id: schema.subscribers.id,
            email: schema.subscribers.email,
          })
          .from(schema.subscribers)
          .innerJoin(schema.subscriberTags, eq(schema.subscriberTags.subscriberId, schema.subscribers.id))
          .innerJoin(schema.subscriberLists, eq(schema.subscriberLists.subscriberId, schema.subscribers.id))
          .where(
            and(
              eq(schema.subscriberTags.tagId, aud.tagId),
              eq(schema.subscribers.status, "active"),
              eq(schema.subscriberLists.status, "confirmed"),
            ),
          )
          .all();
      } else if (aud.type === "subscribers" && aud.subscriberIds) {
        previewSubscribers = db
          .selectDistinct({
            id: schema.subscribers.id,
            email: schema.subscribers.email,
          })
          .from(schema.subscribers)
          .innerJoin(schema.subscriberLists, eq(schema.subscriberLists.subscriberId, schema.subscribers.id))
          .where(
            and(
              inArray(schema.subscribers.id, aud.subscriberIds),
              eq(schema.subscribers.status, "active"),
              eq(schema.subscriberLists.status, "confirmed"),
            ),
          )
          .all();
      } else {
        // "all" type or unknown — get all active confirmed
        previewSubscribers = db
          .selectDistinct({
            id: schema.subscribers.id,
            email: schema.subscribers.email,
          })
          .from(schema.subscribers)
          .innerJoin(schema.subscriberLists, eq(schema.subscriberLists.subscriberId, schema.subscribers.id))
          .where(
            and(
              eq(schema.subscribers.status, "active"),
              eq(schema.subscriberLists.status, "confirmed"),
            ),
          )
          .all();
      }
    } else {
      previewSubscribers = db
        .selectDistinct({
          id: schema.subscribers.id,
          email: schema.subscribers.email,
        })
        .from(schema.subscribers)
        .innerJoin(schema.subscriberLists, eq(schema.subscriberLists.subscriberId, schema.subscribers.id))
        .where(
          and(
            eq(schema.subscribers.status, "active"),
            eq(schema.subscriberLists.status, "confirmed"),
          ),
        )
        .all();
    }

    return c.html(
      <AdminLayout title={campaign.subject} user={user}>
        <h1 class="text-2xl font-bold mt-0 mb-4">{campaign.subject}</h1>
        <div class="flex gap-4 items-center mb-4">
          <CampaignBadge status={campaign.status} />
          <span class="text-sm text-gray-500">
            Audience: {audienceDesc} &middot; From: {campaign.fromAddress}
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

        <h2 class="text-xl font-semibold mt-6 mb-3">Email Preview</h2>
        <div class="mb-4">
          <select id="previewSubscriber" class="px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
            <option value="">Generic preview</option>
            {previewSubscribers.map((sub) => (
              <option value={String(sub.id)}>{sub.email}</option>
            ))}
          </select>
        </div>
        <iframe
          id="previewFrame"
          src={`/admin/campaigns/${id}/preview`}
          class="w-full border border-gray-200 rounded-lg"
          style="min-height: 600px;"
        />
        <script dangerouslySetInnerHTML={{ __html: `
          document.getElementById('previewSubscriber').addEventListener('change', function() {
            var subId = this.value;
            var src = '/admin/campaigns/${id}/preview';
            if (subId) src += '?subscriberId=' + subId;
            document.getElementById('previewFrame').src = src;
          });
        `}} />

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
    const user = c.get("user") as User;
    const id = Number(c.req.param("id"));
    const campaign = db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id)).get();

    logEvent(db, {
      type: "admin.campaign_deleted",
      detail: campaign?.subject ?? `id=${id}`,
      campaignId: id,
      userId: user.id,
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
    const user = c.get("user") as User;
    const listAccess = getAccessibleListIds(db, user);

    let messages: (typeof schema.inboundMessages.$inferSelect)[];
    if (listAccess === "all") {
      messages = db
        .select()
        .from(schema.inboundMessages)
        .orderBy(desc(schema.inboundMessages.createdAt))
        .limit(100)
        .all();
    } else if (listAccess.length === 0) {
      messages = [];
    } else {
      messages = db
        .select({
          id: schema.inboundMessages.id,
          messageId: schema.inboundMessages.messageId,
          timestamp: schema.inboundMessages.timestamp,
          source: schema.inboundMessages.source,
          fromAddrs: schema.inboundMessages.fromAddrs,
          toAddrs: schema.inboundMessages.toAddrs,
          subject: schema.inboundMessages.subject,
          spamVerdict: schema.inboundMessages.spamVerdict,
          virusVerdict: schema.inboundMessages.virusVerdict,
          spfVerdict: schema.inboundMessages.spfVerdict,
          dkimVerdict: schema.inboundMessages.dkimVerdict,
          dmarcVerdict: schema.inboundMessages.dmarcVerdict,
          s3Key: schema.inboundMessages.s3Key,
          campaignId: schema.inboundMessages.campaignId,
          readAt: schema.inboundMessages.readAt,
          createdAt: schema.inboundMessages.createdAt,
        })
        .from(schema.inboundMessages)
        .innerJoin(schema.campaigns, eq(schema.inboundMessages.campaignId, schema.campaigns.id))
        .where(inArray(schema.campaigns.listId, listAccess))
        .orderBy(desc(schema.inboundMessages.createdAt))
        .limit(100)
        .all();
    }

    return c.html(
      <AdminLayout title="Inbound" user={user}>
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
    const user = c.get("user") as User;
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
      <AdminLayout title={`Inbound: ${msg.subject}`} user={user}>
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
    const user = c.get("user") as User;
    const id = Number(c.req.param("id"));
    const msg = db.select().from(schema.inboundMessages).where(eq(schema.inboundMessages.id, id)).get();

    logEvent(db, {
      type: "admin.inbound_deleted",
      detail: msg?.subject ?? `id=${id}`,
      inboundMessageId: id,
      userId: user.id,
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
    const user = c.get("user") as User;
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
      userId: user.id,
    });

    return c.redirect(`/admin/inbound/${id}`);
  });

  // Activity feed
  app.get("/activity", (c) => {
    const user = c.get("user") as User;
    const listAccess = getAccessibleListIds(db, user);

    // Join events with users to show who did what
    let recentEvents: {
      id: number;
      type: string;
      detail: string;
      meta: string | null;
      userId: number | null;
      subscriberId: number | null;
      campaignId: number | null;
      inboundMessageId: number | null;
      createdAt: string;
      userName: string | null;
    }[];

    if (listAccess === "all") {
      recentEvents = db
        .select({
          id: schema.events.id,
          type: schema.events.type,
          detail: schema.events.detail,
          meta: schema.events.meta,
          userId: schema.events.userId,
          subscriberId: schema.events.subscriberId,
          campaignId: schema.events.campaignId,
          inboundMessageId: schema.events.inboundMessageId,
          createdAt: schema.events.createdAt,
          userName: schema.users.name,
        })
        .from(schema.events)
        .leftJoin(schema.users, eq(schema.events.userId, schema.users.id))
        .orderBy(desc(schema.events.createdAt))
        .limit(200)
        .all();
    } else if (listAccess.length === 0) {
      recentEvents = [];
    } else {
      // For members, show events related to their accessible lists
      // This includes events with campaignId on their lists, subscriberId on their lists, etc.
      // Simplest approach: events linked to campaigns on accessible lists, plus subscriber events
      const campaignEvents = db
        .select({
          id: schema.events.id,
          type: schema.events.type,
          detail: schema.events.detail,
          meta: schema.events.meta,
          userId: schema.events.userId,
          subscriberId: schema.events.subscriberId,
          campaignId: schema.events.campaignId,
          inboundMessageId: schema.events.inboundMessageId,
          createdAt: schema.events.createdAt,
          userName: schema.users.name,
        })
        .from(schema.events)
        .leftJoin(schema.users, eq(schema.events.userId, schema.users.id))
        .innerJoin(schema.campaigns, eq(schema.events.campaignId, schema.campaigns.id))
        .where(inArray(schema.campaigns.listId, listAccess))
        .orderBy(desc(schema.events.createdAt))
        .limit(200)
        .all();

      const subscriberEvents = db
        .select({
          id: schema.events.id,
          type: schema.events.type,
          detail: schema.events.detail,
          meta: schema.events.meta,
          userId: schema.events.userId,
          subscriberId: schema.events.subscriberId,
          campaignId: schema.events.campaignId,
          inboundMessageId: schema.events.inboundMessageId,
          createdAt: schema.events.createdAt,
          userName: schema.users.name,
        })
        .from(schema.events)
        .leftJoin(schema.users, eq(schema.events.userId, schema.users.id))
        .innerJoin(schema.subscribers, eq(schema.events.subscriberId, schema.subscribers.id))
        .innerJoin(schema.subscriberLists, eq(schema.subscribers.id, schema.subscriberLists.subscriberId))
        .where(inArray(schema.subscriberLists.listId, listAccess))
        .orderBy(desc(schema.events.createdAt))
        .limit(200)
        .all();

      // Merge and dedupe by event id, sort by createdAt desc
      const seen = new Set<number>();
      const merged = [];
      for (const e of [...campaignEvents, ...subscriberEvents]) {
        if (!seen.has(e.id)) {
          seen.add(e.id);
          merged.push(e);
        }
      }
      merged.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
      recentEvents = merged.slice(0, 200);
    }

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

    function formatEventType(type: string): string {
      return type.replace(/^(admin|subscriber|campaign|inbound)\./, "").replace(/_/g, " ");
    }

    return c.html(
      <AdminLayout title="Activity" user={user}>
        <h1 class="text-2xl font-bold mt-0 mb-4">Activity</h1>
        <div class="flex flex-col gap-1">
          {recentEvents.map((e) => {
            const link = eventLink(e);
            const who = e.userName ?? "System";
            const action = formatEventType(e.type);
            return (
              <div class="flex items-baseline gap-3 py-2 border-b border-gray-100">
                <span class={`text-[0.6875rem] font-semibold uppercase tracking-wide min-w-[2.5rem] ${eventColor(e.type)}`}>
                  {eventIcon(e.type)}
                </span>
                <span class="text-sm font-medium min-w-[8rem]">
                  {who}
                </span>
                <span class="text-sm text-gray-700 min-w-[10rem]">
                  {action}
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

  // Tags CRUD
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
        name: schema.subscribers.name,
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
                  <td class="px-4 py-3 border-b border-gray-100">{s.name ?? "—"}</td>
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

  // CSV Import
  function parseCSV(text: string): string[][] {
    const rows: string[][] = [];
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    for (const line of lines) {
      const row: string[] = [];
      let current = "";
      let inQuotes = false;
      for (const char of line) {
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === "," && !inQuotes) {
          row.push(current.trim());
          current = "";
        } else {
          current += char;
        }
      }
      row.push(current.trim());
      rows.push(row);
    }
    return rows;
  }

  app.get("/import", (c) => {
    const user = c.get("user") as User;
    return c.html(
      <AdminLayout title="Import Subscribers" user={user}>
        <h1 class="text-2xl font-bold mt-0 mb-4">Import Subscribers</h1>
        <div class="bg-white border border-gray-200 rounded-lg p-5 mb-6">
          <form method="post" action="/admin/import/upload" enctype="multipart/form-data">
            <div class="mb-4">
              <label for="csv" class="block text-sm font-medium text-gray-700 mb-1">CSV File</label>
              <input
                type="file"
                id="csv"
                name="csv"
                accept=".csv"
                required
                class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <button
              type="submit"
              class="inline-block px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 cursor-pointer border-none no-underline"
            >
              Upload CSV
            </button>
          </form>
        </div>
      </AdminLayout>,
    );
  });

  app.post("/import/upload", async (c) => {
    const user = c.get("user") as User;
    const body = await c.req.parseBody();
    const file = body["csv"];

    if (!file || typeof file === "string") {
      return c.redirect("/admin/import");
    }

    const text = await (file as File).text();
    const allRows = parseCSV(text);

    if (allRows.length < 2) {
      return c.html(
        <AdminLayout title="Import Subscribers" user={user}>
          <h1 class="text-2xl font-bold mt-0 mb-4">Import Subscribers</h1>
          <div class="bg-red-100 border border-red-300 text-red-800 px-4 py-3 rounded-md mb-4 text-sm">
            CSV file must contain a header row and at least one data row.
          </div>
          <a href="/admin/import" class="text-blue-600 hover:text-blue-800">Back to Import</a>
        </AdminLayout>,
      );
    }

    const headers = allRows[0]!;
    const dataRows = allRows.slice(1);
    const previewRows = dataRows.slice(0, 5);

    // Auto-detect column mappings
    const autoMappings = headers.map((h) => {
      const lower = h.toLowerCase();
      if (lower.includes("email") || lower.includes("mail")) return "email";
      if (lower.includes("name")) return "name";
      return "ignore";
    });

    // Get accessible lists
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
      <AdminLayout title="Map Columns" user={user}>
        <h1 class="text-2xl font-bold mt-0 mb-4">Map Columns</h1>
        <form method="post" action="/admin/import/process">
          <div class="bg-white border border-gray-200 rounded-lg p-5 mb-6 overflow-x-auto">
            <table class="w-full bg-white rounded-lg overflow-hidden mb-4 text-sm">
              <thead>
                <tr>
                  {headers.map((_, i) => (
                    <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">
                      <select
                        name={`col_${i}`}
                        class="w-full px-2 py-1 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      >
                        <option value="ignore" selected={autoMappings[i] === "ignore"}>Ignore</option>
                        <option value="email" selected={autoMappings[i] === "email"}>Email</option>
                        <option value="name" selected={autoMappings[i] === "name"}>Name</option>
                      </select>
                    </th>
                  ))}
                </tr>
                <tr>
                  {headers.map((h) => (
                    <th class="bg-gray-50 px-4 py-2 text-left text-xs font-medium text-gray-700 border-b border-gray-200">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {previewRows.map((row) => (
                  <tr>
                    {headers.map((_, i) => (
                      <td class="px-4 py-2 border-b border-gray-100 text-sm">{row[i] ?? ""}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {dataRows.length > 5 && (
              <p class="text-sm text-gray-500">Showing 5 of {dataRows.length} rows.</p>
            )}
          </div>

          {allLists.length > 0 && (
            <div class="bg-white border border-gray-200 rounded-lg p-5 mb-6">
              <p class="text-sm font-medium text-gray-700 mb-2">Import to lists</p>
              {allLists.map((list) => (
                <label class="flex items-center gap-2 text-sm text-gray-800 mb-1">
                  <input type="checkbox" name="lists" value={list.slug} />
                  {list.name}
                </label>
              ))}
            </div>
          )}

          <div class="bg-white border border-gray-200 rounded-lg p-5 mb-6">
            <label class="flex items-center gap-2 text-sm font-medium text-gray-700">
              <input type="checkbox" name="preconfirm" value="1" />
              Pre-confirm subscribers (skip double opt-in)
            </label>
          </div>

          <div class="bg-white border border-gray-200 rounded-lg p-5 mb-6">
            <label class="block text-sm font-medium text-gray-700 mb-1">Apply tag to all imported subscribers (optional)</label>
            <input type="text" name="importTag" placeholder="e.g. imported-2026-03" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
          </div>

          <input type="hidden" name="csvData" value={JSON.stringify(dataRows)} />
          <input type="hidden" name="headers" value={JSON.stringify(headers)} />

          <button
            type="submit"
            class="inline-block px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 cursor-pointer border-none no-underline"
          >
            Import {dataRows.length} subscribers
          </button>
        </form>
      </AdminLayout>,
    );
  });

  app.post("/import/process", async (c) => {
    const user = c.get("user") as User;
    const body = await c.req.parseBody({ all: true });

    let dataRows: string[][];
    let headers: string[];
    try {
      dataRows = JSON.parse(body["csvData"] as string);
      headers = JSON.parse(body["headers"] as string);
    } catch {
      return c.redirect("/admin/import");
    }

    // Determine column mappings
    let emailCol = -1;
    let nameCol = -1;
    for (let i = 0; i < headers.length; i++) {
      const mapping = body[`col_${i}`] as string;
      if (mapping === "email") emailCol = i;
      if (mapping === "name") nameCol = i;
    }

    if (emailCol === -1) {
      return c.html(
        <AdminLayout title="Import Error" user={user}>
          <h1 class="text-2xl font-bold mt-0 mb-4">Import Error</h1>
          <div class="bg-red-100 border border-red-300 text-red-800 px-4 py-3 rounded-md mb-4 text-sm">
            No column mapped to "email". Please go back and map at least one column as email.
          </div>
          <a href="/admin/import" class="text-blue-600 hover:text-blue-800">Back to Import</a>
        </AdminLayout>,
      );
    }

    // Get list slugs
    let listSlugs: string[] = [];
    if (body["lists"]) {
      listSlugs = Array.isArray(body["lists"])
        ? (body["lists"] as string[])
        : [body["lists"] as string];
    }

    const preconfirm = body["preconfirm"] === "1";
    const importTag = String(body["importTag"] ?? "").trim();

    // Find or create the tag once before the loop
    let tagId: number | null = null;
    if (importTag) {
      const existing = db.select().from(schema.tags).where(eq(schema.tags.name, importTag)).get();
      if (existing) {
        tagId = existing.id;
      } else {
        const created = db
          .insert(schema.tags)
          .values({ name: importTag })
          .returning({ id: schema.tags.id })
          .get();
        tagId = created.id;
      }
    }

    let imported = 0;
    let skipped = 0;
    let errors = 0;

    for (const row of dataRows) {
      const email = (row[emailCol] ?? "").trim().toLowerCase();
      if (!email || !email.includes("@")) {
        errors++;
        continue;
      }

      const name = nameCol >= 0 ? (row[nameCol] ?? "").trim() || null : null;

      try {
        // Check if subscriber already exists before creating
        const existingBefore = db
          .select()
          .from(schema.subscribers)
          .where(eq(schema.subscribers.email, email))
          .get();

        const subscriber = createSubscriber(db, email, name, listSlugs);

        if (existingBefore) {
          skipped++;
        } else {
          imported++;
        }

        if (preconfirm) {
          confirmSubscriber(db, subscriber.unsubscribeToken);
        }

        if (tagId !== null) {
          db.insert(schema.subscriberTags)
            .values({ subscriberId: subscriber.id, tagId })
            .onConflictDoNothing()
            .run();
        }
      } catch {
        errors++;
      }
    }

    logEvent(db, {
      type: "admin.import_completed",
      detail: `Imported ${imported}, skipped ${skipped}, errors ${errors}`,
      userId: user.id,
    });

    return c.html(
      <AdminLayout title="Import Complete" user={user}>
        <h1 class="text-2xl font-bold mt-0 mb-4">Import Complete</h1>
        <div class="bg-white border border-gray-200 rounded-lg p-5 mb-6">
          <div class="flex gap-4 mb-4">
            <div class="inline-flex flex-col items-center bg-green-50 border border-green-200 rounded-lg px-6 py-4 min-w-[120px] text-center">
              <span class="text-3xl font-bold text-green-600">{imported}</span>
              <span class="text-xs text-gray-500 uppercase tracking-wide">Imported</span>
            </div>
            <div class="inline-flex flex-col items-center bg-amber-50 border border-amber-200 rounded-lg px-6 py-4 min-w-[120px] text-center">
              <span class="text-3xl font-bold text-amber-600">{skipped}</span>
              <span class="text-xs text-gray-500 uppercase tracking-wide">Skipped</span>
            </div>
            <div class="inline-flex flex-col items-center bg-red-50 border border-red-200 rounded-lg px-6 py-4 min-w-[120px] text-center">
              <span class="text-3xl font-bold text-red-600">{errors}</span>
              <span class="text-xs text-gray-500 uppercase tracking-wide">Errors</span>
            </div>
          </div>
          <a href="/admin/subscribers" class="text-blue-600 hover:text-blue-800">View subscribers</a>
        </div>
      </AdminLayout>,
    );
  });

  // Users management (owner/admin only)
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

  return app;
}
