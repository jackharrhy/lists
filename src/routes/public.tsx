import { Html } from "@elysia/html";
import { createHttpApp } from "../http";
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
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { sendEmail } from "../services/mailer";

function Layout({ children }: { children: any }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>lists</title>
        <link rel="stylesheet" href="/static/styles.css" />
        <script src="/static/app.js" defer></script>
      </head>
      <body class="font-sans text-gray-900 m-0 p-0" hx-boost="true" hx-target="#app-shell" hx-select="#app-shell" hx-swap="outerHTML transition:true" hx-push-url="true" hx-indicator="#global-progress">
        <div id="global-progress" class="htmx-indicator" role="progressbar" aria-label="Loading"></div>
        <div id="app-shell">
          <header class="max-w-3xl mx-auto px-5 sm:px-8 pt-7 flex items-center justify-between">
            <a href="/subscribe" class="flex items-center gap-2.5 text-gray-950 font-bold no-underline"><span class="grid place-items-center size-9 rounded-xl bg-gray-950 text-white shadow-sm">L</span>lists</a>
            <span class="text-xs font-semibold text-gray-400">Thoughtful email, occasionally.</span>
          </header>
          <main class="max-w-3xl mx-auto px-5 sm:px-8 py-12 sm:py-20">
            {children}
          </main>
          <footer class="max-w-3xl mx-auto px-5 sm:px-8 pb-10 text-xs text-gray-400">Built with care on the open web.</footer>
        </div>
      </body>
    </html>
  );
}

export function publicRoutes(db: Db, config: Config) {
  const app = createHttpApp();

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
        <div class="mb-9">
          <span class="inline-flex items-center gap-2 rounded-full border border-blue-100 bg-blue-50 px-3 py-1 text-[0.7rem] font-bold uppercase tracking-[0.12em] text-blue-700 mb-5"><span class="size-1.5 rounded-full bg-blue-500"></span>Independent mailing lists</span>
          <h1 class="text-4xl sm:text-6xl font-bold tracking-[-0.04em] leading-[0.98] text-gray-950 mb-5">Notes worth<br/><span class="text-blue-600">opening.</span></h1>
          <p class="text-base sm:text-lg text-gray-600 leading-relaxed max-w-xl mb-0">
          Email lists affiliated with{" "}
          <a href="https://jackharrhy.dev" class="text-blue-600 font-semibold hover:text-blue-800">Jack Harrhy</a>.
          Subscribe to hear about things being worked on, written about, or found interesting.
          </p>
        </div>

        {domains.length > 0 ? (
          <>
          <details class="app-surface rounded-2xl p-5 sm:p-7 mb-6" open>
            <summary class="cursor-pointer text-lg font-bold text-gray-950 select-none marker:text-blue-500">
              Choose what lands in your inbox
            </summary>
            <form method="post" action="/subscribe" class="mt-6 space-y-5" hx-disabled-elt="find button">
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">
                  Email
                  <input
                    type="email"
                    name="email"
                    required
                    class="mt-2 w-full px-3.5 py-3 border border-gray-200 bg-white rounded-xl text-sm shadow-sm focus:outline-none focus:ring-4 focus:ring-blue-100 focus:border-blue-500"
                  />
                </label>
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">
                  First name (optional)
                  <input
                    type="text"
                    name="firstName"
                    class="mt-2 w-full px-3.5 py-3 border border-gray-200 bg-white rounded-xl text-sm shadow-sm focus:outline-none focus:ring-4 focus:ring-blue-100 focus:border-blue-500"
                  />
                </label>
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">
                  Last name (optional)
                  <input
                    type="text"
                    name="lastName"
                    class="mt-2 w-full px-3.5 py-3 border border-gray-200 bg-white rounded-xl text-sm shadow-sm focus:outline-none focus:ring-4 focus:ring-blue-100 focus:border-blue-500"
                  />
                </label>
              </div>

              {domains.map(([domain, lists]) => (
                <div class="space-y-2.5">
                  {multipleDomains && (
                    <p class="text-xs font-medium text-gray-400 uppercase tracking-wide">{domain}</p>
                  )}
                  {lists.map((list) => (
                    <label class="flex items-start gap-3 text-sm text-gray-800 border border-gray-200 bg-white/70 rounded-xl p-3.5 cursor-pointer hover:border-blue-200 hover:bg-blue-50/40">
                      <input type="checkbox" name="lists" value={list.slug} data-domain={list.fromDomain} class="rounded mt-0.5 size-4" />
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
                class="w-full px-4 py-3 bg-gray-950 text-white text-sm font-semibold rounded-xl hover:bg-blue-600 cursor-pointer border-none shadow-sm disabled:opacity-60"
              >
                Subscribe
              </button>
            </form>
          </details>
          {multipleDomains && (
            <script>{`
              document.querySelectorAll('input[name="lists"]').forEach(function(cb) {
                cb.addEventListener('change', function() {
                  var checked = document.querySelectorAll('input[name="lists"]:checked');
                  var domains = new Set();
                  checked.forEach(function(el) { domains.add(el.dataset.domain); });
                  var hint = document.getElementById('multi-domain-hint');
                  if (hint) hint.classList.toggle('hidden', domains.size < 2);
                });
              });
            `}</script>
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
    const body = c.body as Record<string, any>;
    const email = String(body["email"] ?? "").trim();
    const firstName = String(body["firstName"] ?? "").trim().slice(0, 255) || null;
    const lastName = String(body["lastName"] ?? "").trim().slice(0, 255) || null;

    let listSlugs: string[] = [];
    const raw = body["lists"];
    if (Array.isArray(raw)) {
      listSlugs = raw.map(String);
    } else if (typeof raw === "string") {
      listSlugs = [raw];
    }

    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRe.test(email)) {
      return c.html(<Layout><h1>Invalid email</h1><p>Please enter a valid email address.</p></Layout>, 400);
    }

    if (listSlugs.length === 0) {
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

    const subscriber = createSubscriber(db, email, firstName, lastName, listSlugs);

    // Look up selected lists and group by domain
    const allLists = db.select().from(schema.lists).all();
    const selectedLists = allLists.filter((l) => listSlugs.includes(l.slug));

    const byDomain = new Map<string, typeof selectedLists>();
    for (const list of selectedLists) {
      if (!byDomain.has(list.fromDomain)) byDomain.set(list.fromDomain, []);
      byDomain.get(list.fromDomain)!.push(list);
    }

    // Send one confirmation per domain
    const domainsSent: string[] = [];

    for (const [domain, lists] of byDomain) {
      const listNames = lists.map((l) => l.name);
      const confirmUrl = buildConfirmUrl(config.baseUrl, subscriber.unsubscribeToken, domain);
      const { html } = await renderConfirmation({ confirmUrl, listNames });

      await sendEmail(config,
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
        }).input,
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
    const token = c.params.token;
    const domain = c.params.domain;
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
    const token = c.params.token;
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
    const token = c.params.token;
    const listId = parseInt(c.params.listId, 10);
    if (isNaN(listId)) return c.text("Bad Request", 400);
    const list = db.select().from(schema.lists).where(eq(schema.lists.id, listId)).get();
    const ok = unsubscribeFromList(db, token, listId);

    if (ok) {
      const prefs = getSubscriberPreferences(db, token);
      const otherActive = prefs?.lists.filter((l) => l.subscriptionStatus === "confirmed") ?? [];

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
    const token = c.params.token;
    const listId = parseInt(c.params.listId, 10);
    if (isNaN(listId)) return c.text("Bad Request", 400);
    unsubscribeFromList(db, token, listId);
    return c.text("Unsubscribed", 200);
  });

  // GET /unsubscribe/:token - legacy, unsubscribe from all
  app.get("/unsubscribe/:token", (c) => {
    const token = c.params.token;
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
    const token = c.params.token;
    unsubscribeAll(db, token);
    return c.text("Unsubscribed", 200);
  });

  // GET /preferences/:token
  app.get("/preferences/:token", (c) => {
    const token = c.params.token;
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
    const token = c.params.token;
    const body = c.body as Record<string, any>;

    const rawIds = Array.isArray(body["listIds"]) ? body["listIds"] : [body["listIds"]].filter(Boolean);
    const listIds = rawIds.map(Number).filter(n => Number.isInteger(n) && n > 0);

    updatePreferences(db, token, listIds);

    return c.redirect(`/preferences/${token}`);
  });

  return app;
}
