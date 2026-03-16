import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { type Db, schema } from "../db";
import type { Config } from "../config";
import {
  createSubscriber,
  confirmSubscriber,
  confirmSubscriberDomain,
  unsubscribeAll,
  unsubscribeFromList,
  getSubscriberPreferences,
  updatePreferences,
} from "../services/subscriber";
import { buildConfirmUrl } from "../compliance";
import { renderConfirmation } from "../../emails/render";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

function Layout({ children }: { children: any }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>lists</title>
        <link rel="stylesheet" href="/static/styles.css" />
      </head>
      <body class="font-sans text-gray-900 bg-gray-50 m-0 p-0">
        <div class="max-w-lg mx-auto px-6 py-12">{children}</div>
      </body>
    </html>
  );
}

export function publicRoutes(db: Db, config: Config) {
  const app = new Hono();

  // GET /subscribe - landing page with subscribe form
  app.get("/subscribe", (c) => {
    const allLists = db.select().from(schema.lists).all();

    // group lists by fromDomain
    const byDomain = new Map<string, typeof allLists>();
    for (const list of allLists) {
      const domain = list.fromDomain;
      if (!byDomain.has(domain)) byDomain.set(domain, []);
      byDomain.get(domain)!.push(list);
    }
    const domains = [...byDomain.entries()];
    const multipleDomains = domains.length > 1;

    return c.html(
      <Layout>
        <h1 class="text-2xl font-bold mb-2">Lists</h1>
        <p class="text-gray-600 mb-8">
          Email lists affiliated with{" "}
          <a href="https://jackharrhy.dev" class="text-blue-600 hover:text-blue-800">Jack Harrhy</a>.
          Subscribe to hear about things being worked on, written about, or found interesting.
        </p>

        {domains.length > 0 ? (
          <>
          <details class="mb-6">
            <summary class="cursor-pointer text-sm font-medium text-blue-600 hover:text-blue-800 select-none">
              Subscribe to a list
            </summary>
            <form method="post" action="/subscribe" class="mt-4 space-y-4">
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">
                  Email
                  <input
                    type="email"
                    name="email"
                    required
                    class="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </label>
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">
                  Name (optional)
                  <input
                    type="text"
                    name="name"
                    class="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </label>
              </div>

              {domains.map(([domain, lists]) => (
                <div class="space-y-2">
                  {multipleDomains && (
                    <p class="text-xs font-medium text-gray-400 uppercase tracking-wide">{domain}</p>
                  )}
                  {lists.map((list) => (
                    <label class="flex items-start gap-2 text-sm text-gray-800">
                      <input type="checkbox" name="lists" value={list.slug} data-domain={list.fromDomain} class="rounded mt-0.5" />
                      <span>
                        <span class="font-medium">{list.name}</span>
                        {list.description ? <span class="text-gray-500"> - {list.description}</span> : ""}
                      </span>
                    </label>
                  ))}
                </div>
              ))}

              {multipleDomains && (
                <p id="multi-domain-hint" class="text-xs text-gray-400 hidden">
                  Selecting lists from different domains will send a separate confirmation email for each.
                </p>
              )}

              <button
                type="submit"
                class="w-full px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 cursor-pointer border-none"
              >
                Subscribe
              </button>
            </form>
          </details>
          {multipleDomains && (
            <script dangerouslySetInnerHTML={{ __html: `
              document.querySelectorAll('input[name="lists"]').forEach(function(cb) {
                cb.addEventListener('change', function() {
                  var checked = document.querySelectorAll('input[name="lists"]:checked');
                  var domains = new Set();
                  checked.forEach(function(el) { domains.add(el.dataset.domain); });
                  var hint = document.getElementById('multi-domain-hint');
                  if (hint) hint.classList.toggle('hidden', domains.size < 2);
                });
              });
            `}} />
          )}
        </>
        ) : (
          <p class="text-gray-400 text-sm">No lists yet.</p>
        )}
      </Layout>,
    );
  });

  // POST /subscribe - process subscription
  app.post("/subscribe", async (c) => {
    const body = await c.req.parseBody({ all: true });
    const email = String(body["email"] ?? "").trim();
    const name = body["name"] ? String(body["name"]).trim() : null;

    let listSlugs: string[] = [];
    const raw = body["lists"];
    if (Array.isArray(raw)) {
      listSlugs = raw.map(String);
    } else if (typeof raw === "string") {
      listSlugs = [raw];
    }

    if (!email || listSlugs.length === 0) {
      return c.html(
        <Layout>
          <h1 class="text-2xl font-bold mb-6">Subscribe</h1>
          <p class="text-sm text-gray-700 mb-4">
            Please provide an email and select at least one list.
          </p>
          <a href="/subscribe" class="text-blue-600 hover:text-blue-800">
            Back
          </a>
        </Layout>,
        400,
      );
    }

    const subscriber = createSubscriber(db, email, name, listSlugs);

    // Look up selected lists and group by domain
    const allLists = db.select().from(schema.lists).all();
    const selectedLists = allLists.filter((l) => listSlugs.includes(l.slug));

    const byDomain = new Map<string, typeof selectedLists>();
    for (const list of selectedLists) {
      if (!byDomain.has(list.fromDomain)) byDomain.set(list.fromDomain, []);
      byDomain.get(list.fromDomain)!.push(list);
    }

    // Send one confirmation per domain
    const ses = new SESv2Client({ region: config.awsRegion });
    const domainsSent: string[] = [];

    for (const [domain, lists] of byDomain) {
      const listNames = lists.map((l) => l.name);
      const confirmUrl = buildConfirmUrl(config.baseUrl, subscriber.unsubscribeToken, domain);
      const { html } = await renderConfirmation({ confirmUrl, listNames });

      await ses.send(
        new SendEmailCommand({
          FromEmailAddress: `noreply@${domain}`,
          Destination: { ToAddresses: [email] },
          Content: {
            Simple: {
              Subject: { Data: "Confirm your subscription" },
              Body: { Html: { Data: html } },
            },
          },
          ConfigurationSetName: config.sesConfigSet || undefined,
        }),
      );
      domainsSent.push(domain);
    }

    const multipleConfirms = domainsSent.length > 1;

    return c.html(
      <Layout>
        <h1 class="text-2xl font-bold mb-6">Check your email</h1>
        <div class="bg-white rounded-lg border border-gray-200 p-6">
          <p class="text-sm text-gray-700">
            We sent {multipleConfirms ? `${domainsSent.length} confirmation emails` : "a confirmation link"} to <strong>{email}</strong>.
            {multipleConfirms
              ? " You'll need to confirm each one separately."
              : " Click the link to confirm your subscription."}
          </p>
          {multipleConfirms && (
            <ul class="mt-3 text-sm text-gray-500 list-disc list-inside">
              {domainsSent.map((d) => <li>From {d}</li>)}
            </ul>
          )}
        </div>
      </Layout>,
    );
  });

  // GET /confirm/:token/:domain - per-domain confirm
  app.get("/confirm/:token/:domain", (c) => {
    const token = c.req.param("token");
    const domain = c.req.param("domain");
    const ok = confirmSubscriberDomain(db, token, domain);

    if (ok) {
      return c.html(
        <Layout>
          <h1 class="text-2xl font-bold mb-6">Confirmed</h1>
          <div class="bg-white rounded-lg border border-gray-200 p-6">
            <p class="text-sm text-gray-700">
              Your <strong>{domain}</strong> subscriptions have been confirmed.
            </p>
          </div>
        </Layout>,
      );
    }

    return c.html(
      <Layout>
        <h1 class="text-2xl font-bold mb-6">Invalid link</h1>
        <div class="bg-white rounded-lg border border-gray-200 p-6">
          <p class="text-sm text-gray-700">
            This confirmation link is invalid or has expired.
          </p>
        </div>
      </Layout>,
      400,
    );
  });

  // GET /confirm/:token - legacy fallback (confirms all)
  app.get("/confirm/:token", (c) => {
    const token = c.req.param("token");
    const ok = confirmSubscriber(db, token);

    if (ok) {
      return c.html(
        <Layout>
          <h1 class="text-2xl font-bold mb-6">Confirmed</h1>
          <div class="bg-white rounded-lg border border-gray-200 p-6">
            <p class="text-sm text-gray-700">
              Your subscription has been confirmed.
            </p>
          </div>
        </Layout>,
      );
    }

    return c.html(
      <Layout>
        <h1 class="text-2xl font-bold mb-6">Invalid link</h1>
        <div class="bg-white rounded-lg border border-gray-200 p-6">
          <p class="text-sm text-gray-700">
            This confirmation link is invalid or has expired.
          </p>
        </div>
      </Layout>,
      400,
    );
  });

  // GET /unsubscribe/:token/:listId - per-list unsubscribe
  app.get("/unsubscribe/:token/:listId", (c) => {
    const token = c.req.param("token");
    const listId = Number(c.req.param("listId"));
    const list = db.select().from(schema.lists).where(eq(schema.lists.id, listId)).get();
    const ok = unsubscribeFromList(db, token, listId);

    if (ok) {
      const prefs = getSubscriberPreferences(db, token);
      const otherActive = prefs?.lists.filter((l) => l.status === "confirmed") ?? [];

      return c.html(
        <Layout>
          <h1 class="text-2xl font-bold mb-6">Unsubscribed</h1>
          <div class="bg-white rounded-lg border border-gray-200 p-6">
            <p class="text-sm text-gray-700 mb-4">
              You have been unsubscribed from <strong>{list?.name ?? "this list"}</strong>.
            </p>
            {otherActive.length > 0 && (
              <p class="text-sm text-gray-500 mb-4">
                You are still subscribed to {otherActive.length} other {otherActive.length === 1 ? "list" : "lists"}.
              </p>
            )}
            <a href={`/preferences/${token}`} class="text-blue-600 hover:text-blue-800 text-sm">
              Manage all your subscriptions
            </a>
          </div>
        </Layout>,
      );
    }

    return c.html(
      <Layout>
        <h1 class="text-2xl font-bold mb-6">Invalid link</h1>
        <div class="bg-white rounded-lg border border-gray-200 p-6">
          <p class="text-sm text-gray-700">This unsubscribe link is invalid.</p>
        </div>
      </Layout>,
      400,
    );
  });

  // POST /unsubscribe/:token/:listId - RFC 8058 one-click per-list
  app.post("/unsubscribe/:token/:listId", (c) => {
    const token = c.req.param("token");
    const listId = Number(c.req.param("listId"));
    unsubscribeFromList(db, token, listId);
    return c.text("Unsubscribed", 200);
  });

  // GET /unsubscribe/:token - legacy, unsubscribe from all
  app.get("/unsubscribe/:token", (c) => {
    const token = c.req.param("token");
    const ok = unsubscribeAll(db, token);

    if (ok) {
      return c.html(
        <Layout>
          <h1 class="text-2xl font-bold mb-6">Unsubscribed</h1>
          <div class="bg-white rounded-lg border border-gray-200 p-6">
            <p class="text-sm text-gray-700 mb-4">
              You have been unsubscribed from all lists.
            </p>
            <a href={`/preferences/${token}`} class="text-blue-600 hover:text-blue-800 text-sm">
              Changed your mind? Manage your subscriptions
            </a>
          </div>
        </Layout>,
      );
    }

    return c.html(
      <Layout>
        <h1 class="text-2xl font-bold mb-6">Invalid link</h1>
        <div class="bg-white rounded-lg border border-gray-200 p-6">
          <p class="text-sm text-gray-700">This unsubscribe link is invalid.</p>
        </div>
      </Layout>,
      400,
    );
  });

  // POST /unsubscribe/:token - RFC 8058 one-click, legacy all
  app.post("/unsubscribe/:token", (c) => {
    const token = c.req.param("token");
    unsubscribeAll(db, token);
    return c.text("Unsubscribed", 200);
  });

  // GET /preferences/:token
  app.get("/preferences/:token", (c) => {
    const token = c.req.param("token");
    const prefs = getSubscriberPreferences(db, token);

    if (!prefs) {
      return c.html(
        <Layout>
          <h1 class="text-2xl font-bold mb-6">Invalid link</h1>
          <div class="bg-white rounded-lg border border-gray-200 p-6">
            <p class="text-sm text-gray-700">
              This preferences link is invalid.
            </p>
          </div>
        </Layout>,
        400,
      );
    }

    return c.html(
      <Layout>
        <h1 class="text-2xl font-bold mb-6">Preferences</h1>
        <p class="text-sm text-gray-700 mb-4">
          Manage subscriptions for <strong>{prefs.subscriber.email}</strong>
        </p>
        <form method="post" action={`/preferences/${token}`} class="space-y-4">
          <div class="space-y-2">
            {prefs.lists.map((list) => (
              <label class="flex items-center gap-2 text-sm text-gray-800">
                <input
                  type="checkbox"
                  name="listIds"
                  value={String(list.id)}
                  checked={list.subscriptionStatus === "confirmed"}
                  class="rounded"
                />
                <span>
                  {list.name}
                  {list.description ? ` — ${list.description}` : ""}
                </span>
              </label>
            ))}
          </div>
          <button
            type="submit"
            class="w-full px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 cursor-pointer border-none"
          >
            Save preferences
          </button>
        </form>
      </Layout>,
    );
  });

  // POST /preferences/:token
  app.post("/preferences/:token", async (c) => {
    const token = c.req.param("token");
    const body = await c.req.parseBody({ all: true });

    let listIds: number[] = [];
    const raw = body["listIds"];
    if (Array.isArray(raw)) {
      listIds = raw.map(Number);
    } else if (typeof raw === "string") {
      listIds = [Number(raw)];
    }

    updatePreferences(db, token, listIds);

    return c.redirect(`/preferences/${token}`);
  });

  return app;
}
