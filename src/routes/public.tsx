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
        <style>{`
          *, *::before, *::after { box-sizing: border-box; }
          body {
            font-family: system-ui, -apple-system, sans-serif;
            max-width: 480px;
            margin: 40px auto;
            padding: 0 16px;
            color: #1a1a1a;
            line-height: 1.5;
          }
          h1 { font-size: 1.4rem; margin: 0 0 16px; }
          label { display: block; margin: 8px 0; }
          input[type="text"],
          input[type="email"] {
            width: 100%;
            padding: 8px 10px;
            border: 1px solid #ccc;
            border-radius: 4px;
            font-size: 14px;
            margin-top: 4px;
          }
          input[type="checkbox"] {
            margin-right: 6px;
            vertical-align: middle;
          }
          button {
            margin-top: 16px;
            padding: 10px 20px;
            background: #1a1a1a;
            color: #fff;
            border: none;
            border-radius: 4px;
            font-size: 14px;
            cursor: pointer;
          }
          button:hover { background: #333; }
          .field { margin-bottom: 12px; }
          .checkboxes { margin: 12px 0; }
          .checkboxes label { display: flex; align-items: center; }
          p { margin: 8px 0; }
        `}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}

export function publicRoutes(db: Db, config: Config) {
  const app = new Hono();

  // GET /subscribe - show subscribe form
  app.get("/subscribe", (c) => {
    const allLists = db.select().from(schema.lists).all();

    return c.html(
      <Layout>
        <h1>Subscribe</h1>
        <form method="post" action="/subscribe">
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
          <div class="checkboxes">
            <p>Lists:</p>
            {allLists.map((list) => (
              <label>
                <input type="checkbox" name="lists" value={list.slug} />
                {list.name}
                {list.description ? ` — ${list.description}` : ""}
              </label>
            ))}
          </div>
          <button type="submit">Subscribe</button>
        </form>
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
          <h1>Subscribe</h1>
          <p>Please provide an email and select at least one list.</p>
          <a href="/subscribe">Back</a>
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
        <h1>Check your email</h1>
        <p>
          We sent a confirmation link to <strong>{email}</strong>. Click the link
          to confirm your subscription.
        </p>
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
          <h1>Confirmed</h1>
          <p>Your subscription has been confirmed.</p>
        </Layout>,
      );
    }

    return c.html(
      <Layout>
        <h1>Invalid link</h1>
        <p>This confirmation link is invalid or has expired.</p>
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
          <h1>Unsubscribed</h1>
          <p>You have been unsubscribed from all lists.</p>
        </Layout>,
      );
    }

    return c.html(
      <Layout>
        <h1>Invalid link</h1>
        <p>This unsubscribe link is invalid.</p>
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
          <h1>Invalid link</h1>
          <p>This preferences link is invalid.</p>
        </Layout>,
        400,
      );
    }

    return c.html(
      <Layout>
        <h1>Preferences</h1>
        <p>
          Manage subscriptions for <strong>{prefs.subscriber.email}</strong>
        </p>
        <form method="post" action={`/preferences/${token}`}>
          <div class="checkboxes">
            {prefs.lists.map((list) => (
              <label>
                <input
                  type="checkbox"
                  name="listIds"
                  value={String(list.id)}
                  checked={list.subscriptionStatus === "confirmed"}
                />
                {list.name}
                {list.description ? ` — ${list.description}` : ""}
              </label>
            ))}
          </div>
          <button type="submit">Save preferences</button>
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
