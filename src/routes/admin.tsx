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
        <style>{`
          *, *::before, *::after { box-sizing: border-box; }
          body {
            font-family: system-ui, -apple-system, sans-serif;
            line-height: 1.5;
            color: #1a1a1a;
            background: #f5f5f5;
            margin: 0;
            padding: 0;
          }
          .container { max-width: 960px; margin: 0 auto; padding: 1rem; }
          nav {
            background: #1a1a1a;
            padding: 0.75rem 0;
            margin-bottom: 1.5rem;
          }
          nav .container {
            display: flex;
            align-items: center;
            gap: 1.5rem;
          }
          nav a {
            color: #ccc;
            text-decoration: none;
            font-size: 0.875rem;
          }
          nav a:hover { color: #fff; }
          nav .brand {
            color: #fff;
            font-weight: 700;
            font-size: 1rem;
            margin-right: auto;
          }
          h1 { margin-top: 0; font-size: 1.5rem; }
          h2 { font-size: 1.25rem; }
          table {
            width: 100%;
            border-collapse: collapse;
            background: #fff;
            border-radius: 4px;
            overflow: hidden;
            margin-bottom: 1.5rem;
          }
          th, td {
            padding: 0.5rem 0.75rem;
            text-align: left;
            border-bottom: 1px solid #e5e5e5;
            font-size: 0.875rem;
          }
          th {
            background: #fafafa;
            font-weight: 600;
            font-size: 0.75rem;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            color: #666;
          }
          tr:last-child td { border-bottom: none; }
          form { margin: 0; }
          label {
            display: block;
            font-size: 0.875rem;
            font-weight: 500;
            margin-bottom: 0.25rem;
          }
          input[type="text"],
          input[type="password"],
          input[type="email"],
          select,
          textarea {
            width: 100%;
            padding: 0.5rem;
            border: 1px solid #ccc;
            border-radius: 4px;
            font-size: 0.875rem;
            font-family: inherit;
            margin-bottom: 0.75rem;
          }
          textarea { min-height: 200px; resize: vertical; }
          .form-group { margin-bottom: 0.75rem; }
          .form-row {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 1rem;
          }
          button, .btn {
            display: inline-block;
            padding: 0.5rem 1rem;
            border: none;
            border-radius: 4px;
            font-size: 0.875rem;
            font-family: inherit;
            cursor: pointer;
            text-decoration: none;
            background: #2563eb;
            color: #fff;
          }
          button:hover, .btn:hover { background: #1d4ed8; }
          .btn-danger { background: #dc2626; }
          .btn-danger:hover { background: #b91c1c; }
          .btn-secondary { background: #6b7280; }
          .btn-secondary:hover { background: #4b5563; }
          .verdict-pass {
            color: #16a34a;
            font-weight: 600;
            font-size: 0.75rem;
          }
          .verdict-fail {
            color: #dc2626;
            font-weight: 600;
            font-size: 0.75rem;
          }
          .stat-badge {
            display: inline-block;
            background: #fff;
            border: 1px solid #e5e5e5;
            border-radius: 6px;
            padding: 1rem 1.5rem;
            text-align: center;
            min-width: 120px;
          }
          .stat-badge .number {
            display: block;
            font-size: 1.75rem;
            font-weight: 700;
            color: #2563eb;
          }
          .stat-badge .label {
            display: block;
            font-size: 0.75rem;
            color: #666;
            text-transform: uppercase;
            letter-spacing: 0.05em;
          }
          .stats-row {
            display: flex;
            gap: 1rem;
            margin-bottom: 1.5rem;
          }
          .flash {
            background: #dcfce7;
            border: 1px solid #86efac;
            color: #166534;
            padding: 0.75rem 1rem;
            border-radius: 4px;
            margin-bottom: 1rem;
            font-size: 0.875rem;
          }
          .flash-error {
            background: #fef2f2;
            border: 1px solid #fca5a5;
            color: #991b1b;
          }
          .card {
            background: #fff;
            border: 1px solid #e5e5e5;
            border-radius: 6px;
            padding: 1.25rem;
            margin-bottom: 1.5rem;
          }
          .preview { padding: 1rem; background: #fff; border: 1px solid #e5e5e5; border-radius: 4px; }
          .badge {
            display: inline-block;
            padding: 0.125rem 0.5rem;
            border-radius: 9999px;
            font-size: 0.75rem;
            font-weight: 500;
          }
          .badge-draft { background: #fef3c7; color: #92400e; }
          .badge-sending { background: #dbeafe; color: #1e40af; }
          .badge-sent { background: #dcfce7; color: #166534; }
          .badge-failed { background: #fee2e2; color: #991b1b; }
          .error-box { background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; padding: 1rem; margin-bottom: 1.5rem; font-family: monospace; font-size: 0.8125rem; white-space: pre-wrap; word-break: break-all; color: #991b1b; }
          a { color: #2563eb; }
          dl { margin: 0; }
          dt { font-weight: 600; font-size: 0.75rem; text-transform: uppercase; color: #666; margin-top: 0.75rem; }
          dt:first-child { margin-top: 0; }
          dd { margin: 0.25rem 0 0 0; }
        `}</style>
      </head>
      <body>
        <nav>
          <div class="container">
            <a href="/admin/" class="brand">
              Lists
            </a>
            <a href="/admin/">Dashboard</a>
            <a href="/admin/subscribers">Subscribers</a>
            <a href="/admin/lists">Lists</a>
            <a href="/admin/campaigns">Campaigns</a>
            <a href="/admin/inbound">Inbound</a>
            <a href="/admin/activity">Activity</a>
            <form method="post" action="/admin/logout" style="margin:0">
              <button
                type="submit"
                style="background:none;color:#ccc;border:none;cursor:pointer;font-size:0.875rem;padding:0"
              >
                Logout
              </button>
            </form>
          </div>
        </nav>
        <div class="container">
          {flash && <div class="flash">{flash}</div>}
          {children}
        </div>
      </body>
    </html>
  );
}

function Verdict({ value }: { value: string | null }) {
  if (!value) return <span class="verdict-fail">—</span>;
  const pass = value.toUpperCase() === "PASS";
  return (
    <span class={pass ? "verdict-pass" : "verdict-fail"}>
      {value.toUpperCase()}
    </span>
  );
}

function CampaignBadge({ status }: { status: string }) {
  const cls =
    status === "draft"
      ? "badge badge-draft"
      : status === "sending"
        ? "badge badge-sending"
        : status === "failed"
          ? "badge badge-failed"
          : "badge badge-sent";
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
          <style>{`
            body {
              font-family: system-ui, -apple-system, sans-serif;
              display: flex; align-items: center; justify-content: center;
              min-height: 100vh; margin: 0; background: #f5f5f5;
            }
            .login-box {
              background: #fff; padding: 2rem; border-radius: 8px;
              border: 1px solid #e5e5e5; width: 320px;
            }
            h1 { margin: 0 0 1rem; font-size: 1.25rem; text-align: center; }
            input {
              width: 100%; padding: 0.5rem; border: 1px solid #ccc;
              border-radius: 4px; font-size: 0.875rem; margin-bottom: 1rem;
              box-sizing: border-box;
            }
            button {
              width: 100%; padding: 0.5rem; background: #2563eb; color: #fff;
              border: none; border-radius: 4px; font-size: 0.875rem;
              cursor: pointer;
            }
            button:hover { background: #1d4ed8; }
          `}</style>
        </head>
        <body>
          <div class="login-box">
            <h1>Lists Admin</h1>
            <form method="post" action="/admin/login">
              <input
                type="password"
                name="password"
                placeholder="Password"
                required
                autofocus
              />
              <button type="submit">Log in</button>
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
            <style>{`
              body {
                font-family: system-ui, -apple-system, sans-serif;
                display: flex; align-items: center; justify-content: center;
                min-height: 100vh; margin: 0; background: #f5f5f5;
              }
              .login-box {
                background: #fff; padding: 2rem; border-radius: 8px;
                border: 1px solid #e5e5e5; width: 320px;
              }
              h1 { margin: 0 0 1rem; font-size: 1.25rem; text-align: center; }
              input {
                width: 100%; padding: 0.5rem; border: 1px solid #ccc;
                border-radius: 4px; font-size: 0.875rem; margin-bottom: 1rem;
                box-sizing: border-box;
              }
              button {
                width: 100%; padding: 0.5rem; background: #2563eb; color: #fff;
                border: none; border-radius: 4px; font-size: 0.875rem;
                cursor: pointer;
              }
              button:hover { background: #1d4ed8; }
              .error { color: #dc2626; font-size: 0.875rem; margin-bottom: 0.75rem; text-align: center; }
            `}</style>
          </head>
          <body>
            <div class="login-box">
              <h1>Lists Admin</h1>
              <p class="error">Invalid password.</p>
              <form method="post" action="/admin/login">
                <input
                  type="password"
                  name="password"
                  placeholder="Password"
                  required
                  autofocus
                />
                <button type="submit">Log in</button>
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
        <h1>Dashboard</h1>
        <div class="stats-row">
          <div class="stat-badge">
            <span class="number">{activeCount}</span>
            <span class="label">Subscribers</span>
          </div>
          <div class="stat-badge">
            <span class="number">{listCount}</span>
            <span class="label">Lists</span>
          </div>
          <div class="stat-badge">
            <span class="number">{campaignCount}</span>
            <span class="label">Campaigns</span>
          </div>
        </div>

        <h2>Recent Campaigns</h2>
        {recentCampaigns.length === 0 ? (
          <p>No campaigns yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Subject</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {recentCampaigns.map((cam) => (
                <tr>
                  <td>
                    <a href={`/admin/campaigns/${cam.id}`}>{cam.subject}</a>
                  </td>
                  <td>
                    <CampaignBadge status={cam.status} />
                  </td>
                  <td>{fmtDate(cam.createdAt)}</td>
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
        <h1>Subscribers</h1>

        <h2>Add subscriber</h2>
        <form method="post" action="/admin/subscribers/new">
          <div class="field">
            <label>
              Email
              <input type="email" name="email" required />
            </label>
          </div>
          <div class="field">
            <label>
              Name (optional)
              <input type="text" name="name" />
            </label>
          </div>
          <div class="field">
            <label>
              <input type="checkbox" name="skip_confirm" value="1" />
              {" "}Pre-confirm (skip double opt-in)
            </label>
          </div>
          {allLists.length > 0 && (
            <div class="field">
              <p style="margin: 0 0 0.25rem; font-weight: 500;">Lists</p>
              {allLists.map((list) => (
                <label style="display: block;">
                  <input type="checkbox" name="lists" value={list.slug} />
                  {" "}{list.name}
                </label>
              ))}
            </div>
          )}
          <button type="submit">Add subscriber</button>
        </form>

        <h2>All subscribers ({allSubscribers.length})</h2>
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Name</th>
              <th>Status</th>
              <th>Confirmed</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {allSubscribers.map((sub) => (
              <tr>
                <td><a href={`/admin/subscribers/${sub.id}`}>{sub.email}</a></td>
                <td>{sub.name ?? "—"}</td>
                <td>{sub.status}</td>
                <td>{sub.confirmedAt ? "Yes" : "No"}</td>
                <td>{fmtDate(sub.createdAt)}</td>
                <td>
                  <form method="post" action={`/admin/subscribers/${sub.id}/delete`} style="margin:0" onsubmit={`return confirm('Delete ${sub.email}?')`}>
                    <button type="submit" style="background:none;border:none;color:#dc2626;cursor:pointer;font-size:0.8125rem;padding:0">delete</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
        <h1>{sub.email}</h1>

        <form method="post" action={`/admin/subscribers/${id}/edit`}>
          <div class="form-group">
            <label for="email">Email</label>
            <input type="email" id="email" name="email" required value={sub.email} />
          </div>
          <div class="form-group">
            <label for="name">Name</label>
            <input type="text" id="name" name="name" value={sub.name ?? ""} />
          </div>
          <div class="form-group">
            <label for="status">Status</label>
            <select id="status" name="status">
              <option value="active" selected={sub.status === "active"}>active</option>
              <option value="unsubscribed" selected={sub.status === "unsubscribed"}>unsubscribed</option>
              <option value="blocklisted" selected={sub.status === "blocklisted"}>blocklisted</option>
            </select>
          </div>

          {allLists.length > 0 && (
            <div class="form-group">
              <p style="margin:0 0 0.25rem;font-weight:500">List subscriptions</p>
              {allLists.map((list) => {
                const status = subListMap.get(list.id);
                return (
                  <label style="display:block">
                    <input
                      type="checkbox"
                      name="lists"
                      value={String(list.id)}
                      checked={status === "confirmed" || status === "unconfirmed"}
                    />
                    {" "}{list.name}
                    {status && <span style="font-size:0.75rem;color:#666"> ({status})</span>}
                  </label>
                );
              })}
            </div>
          )}

          <button type="submit">Save changes</button>
        </form>

        <dl style="margin-top:1.5rem">
          <dt>Confirmed</dt>
          <dd>{sub.confirmedAt ? fmtDateTime(sub.confirmedAt) : "No"}</dd>
          <dt>Created</dt>
          <dd>{fmtDateTime(sub.createdAt)}</dd>
          <dt>Unsubscribe token</dt>
          <dd style="font-size:0.75rem;font-family:monospace">{sub.unsubscribeToken}</dd>
        </dl>

        {subSends.length > 0 && (
          <>
            <h2>Campaigns received ({subSends.length})</h2>
            <table>
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Status</th>
                  <th>Sent</th>
                </tr>
              </thead>
              <tbody>
                {subSends.map((s) => (
                  <tr>
                    <td><a href={`/admin/campaigns/${s.campaignId}`}>{s.subject ?? `Campaign ${s.campaignId}`}</a></td>
                    <td>{s.status}</td>
                    <td>{fmtDateTime(s.sentAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {subEvents.length > 0 && (
          <>
            <h2>Activity</h2>
            <div style="display:flex;flex-direction:column;gap:0.125rem">
              {subEvents.map((e) => (
                <div style="display:flex;gap:0.75rem;padding:0.375rem 0;border-bottom:1px solid #f5f5f5;font-size:0.8125rem">
                  <span style="font-weight:500;min-width:12rem">{e.type}</span>
                  <span style="color:#555;flex:1">{e.detail}</span>
                  <span style="color:#999;white-space:nowrap">{fmtDateTime(e.createdAt)}</span>
                </div>
              ))}
            </div>
          </>
        )}

        <hr style="margin:2rem 0" />
        <form method="post" action={`/admin/subscribers/${id}/delete`} onsubmit="return confirm('Delete this subscriber and all their list subscriptions? This cannot be undone.')">
          <button type="submit" class="btn-danger" style="padding:0.5rem 1rem;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:0.8125rem">
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

    return c.html(
      <AdminLayout title="Lists">
        <h1>Lists</h1>
        <table>
          <thead>
            <tr>
              <th>Slug</th>
              <th>Name</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {allLists.map((list) => (
              <tr>
                <td>{list.slug}</td>
                <td>{list.name}</td>
                <td>{list.description}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div class="card">
          <h2 style="margin-top:0">Create List</h2>
          <form method="post" action="/admin/lists/new">
            <div class="form-row">
              <div class="form-group">
                <label for="slug">Slug</label>
                <input type="text" id="slug" name="slug" required placeholder="weekly-digest" />
              </div>
              <div class="form-group">
                <label for="name">Name</label>
                <input type="text" id="name" name="name" required placeholder="Weekly Digest" />
              </div>
            </div>
            <div class="form-group">
              <label for="description">Description</label>
              <input type="text" id="description" name="description" placeholder="Optional description" />
            </div>
            <button type="submit">Create List</button>
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

    if (!slug || !name) {
      return c.redirect("/admin/lists");
    }

    db.insert(schema.lists)
      .values({ slug, name, description })
      .run();

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
        <h1>Campaigns</h1>
        <p>
          <a href="/admin/campaigns/new" class="btn">
            New Campaign
          </a>
        </p>
        <table>
          <thead>
            <tr>
              <th>Subject</th>
              <th>From</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {allCampaigns.map((cam) => (
              <tr>
                <td>
                  <a href={`/admin/campaigns/${cam.id}`}>{cam.subject}</a>
                </td>
                <td>{cam.fromAddress}</td>
                <td>
                  <CampaignBadge status={cam.status} />
                </td>
                <td>{fmtDate(cam.createdAt)}</td>
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
        <h1>New Campaign</h1>
        <div class="card">
          <form method="post" action="/admin/campaigns/new">
            <div class="form-group">
              <label for="listId">List</label>
              <select id="listId" name="listId" required>
                <option value="">Select a list…</option>
                {allLists.map((list) => (
                  <option value={String(list.id)}>
                    {list.name} ({list.slug})
                  </option>
                ))}
              </select>
            </div>
            <div class="form-group">
              <label for="fromAddress">From Address</label>
              <input
                type="email"
                id="fromAddress"
                name="fromAddress"
                required
                placeholder={`newsletter@${config.fromDomain}`}
              />
            </div>
            <div class="form-group">
              <label for="subject">Subject</label>
              <input type="text" id="subject" name="subject" required placeholder="Campaign subject" />
            </div>
            <div class="form-group">
              <label for="bodyMarkdown">Body (Markdown)</label>
              <textarea id="bodyMarkdown" name="bodyMarkdown" required placeholder="Write your email in markdown…" />
            </div>
            <button type="submit">Create Draft</button>
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
        <h1>{campaign.subject}</h1>
        <div style="display:flex;gap:1rem;align-items:center;margin-bottom:1rem">
          <CampaignBadge status={campaign.status} />
          <span style="font-size:0.875rem;color:#666">
            List: {list?.name ?? "Unknown"} &middot; From: {campaign.fromAddress}
          </span>
        </div>

        {campaign.lastError && (
          <div class="error-box">
            <strong>Error:</strong>{"\n"}{campaign.lastError}
          </div>
        )}

        {campaign.status === "draft" && (
          <form method="post" action={`/admin/campaigns/${id}/send`} style="margin-bottom:1.5rem">
            <button type="submit" class="btn-danger" style="padding:0.5rem 1rem;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:0.875rem">
              Send Campaign
            </button>
          </form>
        )}

        {campaign.status === "failed" && (
          <div style="display:flex;gap:0.5rem;margin-bottom:1.5rem">
            <form method="post" action={`/admin/campaigns/${id}/retry`}>
              <button type="submit" style="padding:0.5rem 1rem;background:#2563eb;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:0.875rem">
                Retry (skip already sent)
              </button>
            </form>
            <form method="post" action={`/admin/campaigns/${id}/reset`}>
              <button type="submit" class="btn-secondary" style="padding:0.5rem 1rem;border:1px solid #ccc;border-radius:4px;cursor:pointer;font-size:0.875rem">
                Reset to Draft
              </button>
            </form>
          </div>
        )}

        {campaign.status === "sending" && (
          <div style="display:flex;gap:0.5rem;margin-bottom:1.5rem">
            <form method="post" action={`/admin/campaigns/${id}/reset`}>
              <button type="submit" class="btn-secondary" style="padding:0.5rem 1rem;border:1px solid #ccc;border-radius:4px;cursor:pointer;font-size:0.875rem">
                Force Reset to Draft (stuck?)
              </button>
            </form>
          </div>
        )}

        <h2>Preview</h2>
        <div class="preview" dangerouslySetInnerHTML={{ __html: htmlContent }} />

        {sends.length > 0 && (
          <>
            <h2>Sends ({sends.length})</h2>
            <table>
              <thead>
                <tr>
                  <th>Subscriber ID</th>
                  <th>Status</th>
                  <th>Sent At</th>
                  <th>SES Message ID</th>
                </tr>
              </thead>
              <tbody>
                {sends.map((send) => (
                  <tr>
                    <td>{send.subscriberId}</td>
                    <td>{send.status}</td>
                    <td>{fmtDateTime(send.sentAt)}</td>
                    <td style="font-size:0.75rem">{send.sesMessageId ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {inboundReplies.length > 0 && (
          <>
            <h2>Replies ({inboundReplies.length})</h2>
            <table>
              <thead>
                <tr>
                  <th>From</th>
                  <th>Subject</th>
                  <th>Received</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {inboundReplies.map((r) => (
                  <tr>
                    <td>{r.source}</td>
                    <td>{r.subject}</td>
                    <td>{fmtDateTime(r.createdAt)}</td>
                    <td><a href={`/admin/inbound/${r.id}`}>View</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        <hr style="margin:2rem 0" />
        <form method="post" action={`/admin/campaigns/${id}/delete`} onsubmit="return confirm('Delete this campaign and all its send records? This cannot be undone.')">
          <button type="submit" class="btn-danger" style="padding:0.5rem 1rem;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:0.8125rem">
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
        <h1>Inbound Messages</h1>
        <table>
          <thead>
            <tr>
              <th>From</th>
              <th>Subject</th>
              <th>Date</th>
              <th>SPF</th>
              <th>DKIM</th>
              <th>DMARC</th>
            </tr>
          </thead>
          <tbody>
            {messages.map((msg) => (
              <tr style={msg.readAt ? "" : "font-weight:600"}>
                <td>{msg.source}</td>
                <td>
                  <a href={`/admin/inbound/${msg.id}`}>{msg.subject}</a>
                </td>
                <td>{fmtDateTime(msg.timestamp)}</td>
                <td>
                  <Verdict value={msg.spfVerdict} />
                </td>
                <td>
                  <Verdict value={msg.dkimVerdict} />
                </td>
                <td>
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
        <h1>{msg.subject}</h1>
        <div class="card">
          <dl>
            <dt>From</dt>
            <dd>{msg.fromAddrs}</dd>
            <dt>To</dt>
            <dd>{msg.toAddrs}</dd>
            <dt>Subject</dt>
            <dd>{msg.subject}</dd>
            <dt>Date</dt>
            <dd>{fmtDateTime(msg.timestamp)}</dd>
            <dt>Verdicts</dt>
            <dd>
              SPF: <Verdict value={msg.spfVerdict} /> &nbsp;
              DKIM: <Verdict value={msg.dkimVerdict} /> &nbsp;
              DMARC: <Verdict value={msg.dmarcVerdict} />
            </dd>
          </dl>
          {msg.s3Key && (
            <p style="margin-top:1rem">
              <a href={`/admin/inbound/${id}/raw`} class="btn btn-secondary">
                Download Raw .eml
              </a>
            </p>
          )}
        </div>

        <h2>Replies</h2>
        {msgReplies.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>From</th>
                <th>To</th>
                <th>Subject</th>
                <th>Sent At</th>
              </tr>
            </thead>
            <tbody>
              {msgReplies.map((r) => (
                <tr>
                  <td>{r.fromAddr}</td>
                  <td>{r.toAddr}</td>
                  <td>{r.subject}</td>
                  <td>{fmtDateTime(r.sentAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>No replies yet.</p>
        )}

        <div class="card">
          <h2 style="margin-top:0">Send Reply</h2>
          <form method="post" action={`/admin/inbound/${id}/reply`}>
            <div class="form-group">
              <label for="fromAddr">From</label>
              <input
                type="email"
                id="fromAddr"
                name="fromAddr"
                required
                value={msg.toAddrs.includes(",") ? msg.toAddrs.split(",")[0]!.trim() : msg.toAddrs}
              />
            </div>
            <div class="form-group">
              <label for="toAddr">To</label>
              <input
                type="email"
                id="toAddr"
                name="toAddr"
                required
                value={msg.source}
              />
            </div>
            <div class="form-group">
              <label for="replySubject">Subject</label>
              <input
                type="text"
                id="replySubject"
                name="subject"
                required
                value={msg.subject.startsWith("Re:") ? msg.subject : `Re: ${msg.subject}`}
              />
            </div>
            <div class="form-group">
              <label for="replyBody">Body (plain text)</label>
              <textarea id="replyBody" name="body" required placeholder="Your reply…" />
            </div>
            <button type="submit">Send Reply</button>
          </form>
        </div>

        <hr style="margin:2rem 0" />
        <div style="display:flex;gap:0.5rem">
          <form method="post" action={`/admin/inbound/${id}/toggle-read`}>
            <button type="submit" class="btn-secondary" style="padding:0.5rem 1rem;border:1px solid #ccc;border-radius:4px;cursor:pointer;font-size:0.8125rem">
              Mark as {msg.readAt ? "Unread" : "Read"}
            </button>
          </form>
          <form method="post" action={`/admin/inbound/${id}/delete`} onsubmit="return confirm('Delete this inbound message and its replies? This cannot be undone.')">
            <button type="submit" class="btn-danger" style="padding:0.5rem 1rem;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:0.8125rem">
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
      if (type.includes("created") || type.includes("added") || type.includes("confirmed")) return "#166534";
      if (type.includes("deleted") || type.includes("failed")) return "#991b1b";
      if (type.includes("unsubscribed")) return "#92400e";
      if (type.includes("sending") || type.includes("sent") || type.includes("reply_sent")) return "#1e40af";
      if (type.includes("received")) return "#6d28d9";
      return "#374151";
    }

    function eventLink(e: typeof recentEvents[number]): string | null {
      if (e.subscriberId) return `/admin/subscribers/${e.subscriberId}`;
      if (e.campaignId) return `/admin/campaigns/${e.campaignId}`;
      if (e.inboundMessageId) return `/admin/inbound/${e.inboundMessageId}`;
      return null;
    }

    return c.html(
      <AdminLayout title="Activity">
        <h1>Activity</h1>
        <div style="display:flex;flex-direction:column;gap:0.25rem">
          {recentEvents.map((e) => {
            const link = eventLink(e);
            return (
              <div style="display:flex;align-items:baseline;gap:0.75rem;padding:0.5rem 0;border-bottom:1px solid #f0f0f0">
                <span style={`font-size:0.6875rem;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:${eventColor(e.type)};min-width:2.5rem`}>
                  {eventIcon(e.type)}
                </span>
                <span style="font-size:0.8125rem;font-weight:500;min-width:12rem">
                  {e.type}
                </span>
                <span style="font-size:0.8125rem;color:#555;flex:1">
                  {link ? <a href={link}>{e.detail}</a> : e.detail}
                </span>
                <span style="font-size:0.75rem;color:#999;white-space:nowrap">
                  {fmtDateTime(e.createdAt)}
                </span>
              </div>
            );
          })}
          {recentEvents.length === 0 && <p style="color:#999">No events yet.</p>}
        </div>
      </AdminLayout>,
    );
  });

  return app;
}
