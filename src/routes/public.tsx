import { Hono } from "hono";
import { type Db, schema } from "../db";
import type { Config } from "../config";
import {
  createSubscriber,
  confirmSubscriber,
  unsubscribeAll,
  getSubscriberPreferences,
  updatePreferences,
} from "../services/subscriber";
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

    return c.html(
      <Layout>
        <h1 class="text-2xl font-bold mb-2">Lists</h1>
        <p class="text-gray-600 mb-8">
          Email lists affiliated with{" "}
          <a href="https://jackharrhy.dev" class="text-blue-600 hover:text-blue-800">Jack Harrhy</a>.
          Subscribe to hear about things being worked on, written about, or found interesting.
        </p>

        <details class="mb-6">
          <summary class="cursor-pointer text-sm font-medium text-blue-600 hover:text-blue-800 select-none">
            Subscribe
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
            {allLists.length > 0 && (
              <div class="space-y-2">
                <p class="text-sm font-medium text-gray-700">Lists</p>
                {allLists.map((list) => (
                  <label class="flex items-start gap-2 text-sm text-gray-800">
                    <input type="checkbox" name="lists" value={list.slug} class="rounded mt-0.5" />
                    <span>
                      <span class="font-medium">{list.name}</span>
                      {list.description ? <span class="text-gray-500"> - {list.description}</span> : ""}
                    </span>
                  </label>
                ))}
              </div>
            )}
            <button
              type="submit"
              class="w-full px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 cursor-pointer border-none"
            >
              Subscribe
            </button>
          </form>
        </details>
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

    // Build confirmation URL
    const confirmUrl = `${config.baseUrl}/confirm/${subscriber.unsubscribeToken}`;

    // Look up selected list names for the email
    const selectedLists = db.select().from(schema.lists).all();
    const listNames = selectedLists
      .filter((l) => listSlugs.includes(l.slug))
      .map((l) => l.name);

    const { html } = await renderConfirmation({ confirmUrl, listNames });

    const ses = new SESv2Client({ region: config.awsRegion });
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: `noreply@${config.fromDomain}`,
        Destination: { ToAddresses: [email] },
        Content: {
          Simple: {
            Subject: { Data: "Confirm your subscription" },
            Body: { Html: { Data: html } },
          },
        },
      }),
    );

    return c.html(
      <Layout>
        <h1 class="text-2xl font-bold mb-6">Check your email</h1>
        <div class="bg-white rounded-lg border border-gray-200 p-6">
          <p class="text-sm text-gray-700">
            We sent a confirmation link to <strong>{email}</strong>. Click the
            link to confirm your subscription.
          </p>
        </div>
      </Layout>,
    );
  });

  // GET /confirm/:token
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

  // GET /unsubscribe/:token
  app.get("/unsubscribe/:token", (c) => {
    const token = c.req.param("token");
    const ok = unsubscribeAll(db, token);

    if (ok) {
      return c.html(
        <Layout>
          <h1 class="text-2xl font-bold mb-6">Unsubscribed</h1>
          <div class="bg-white rounded-lg border border-gray-200 p-6">
            <p class="text-sm text-gray-700">
              You have been unsubscribed from all lists.
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
            This unsubscribe link is invalid.
          </p>
        </div>
      </Layout>,
      400,
    );
  });

  // POST /unsubscribe/:token - RFC 8058 one-click
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
