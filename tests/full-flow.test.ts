import { test, expect, describe, beforeEach } from "bun:test";
import { mockClient } from "aws-sdk-client-mock";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { eq, and } from "drizzle-orm";
import { Hono } from "hono";

import { createTestDb, seedList, type TestDb } from "./helpers";
import { publicRoutes } from "../src/routes/public";
import { adminRoutes } from "../src/routes/admin";
import * as schema from "../src/db/schema";
import type { Config } from "../src/config";
import {
  createSubscriber,
  confirmSubscriber,
} from "../src/services/subscriber";

const sesMock = mockClient(SESv2Client);

const testConfig: Config = {
  awsRegion: "us-east-1",
  sqsQueueUrl: "https://sqs.us-east-1.amazonaws.com/123/test-queue",
  s3Bucket: "test-bucket",
  apiToken: "test-token",
  dbPath: ":memory:",
  fromDomain: "example.com",
  baseUrl: "http://localhost:8080",
  sesConfigSet: "test-config-set",
  ownerEmail: "",
  ownerPassword: "",
};

beforeEach(() => {
  sesMock.reset();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createApp(db: TestDb, config: Config = testConfig) {
  const app = new Hono();
  app.route("/", publicRoutes(db, config));
  app.route("/admin", adminRoutes(db, config));
  return app;
}

async function seedOwner(db: TestDb) {
  const passwordHash = await Bun.password.hash("password");
  return db
    .insert(schema.users)
    .values({
      email: "owner@example.com",
      name: "Owner",
      passwordHash,
      role: "owner",
    })
    .returning()
    .get();
}

async function login(app: Hono, email = "owner@example.com", password = "password") {
  const res = await app.request("/admin/login", {
    method: "POST",
    body: new URLSearchParams({ email, password }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
  return cookie;
}

async function authPost(
  app: Hono,
  path: string,
  cookie: string,
  formData: Record<string, string>,
) {
  return app.request(path, {
    method: "POST",
    body: new URLSearchParams(formData),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookie,
    },
  });
}

async function authGet(app: Hono, path: string, cookie: string) {
  return app.request(path, {
    method: "GET",
    headers: { Cookie: cookie },
  });
}

// ---------------------------------------------------------------------------
// Test 1: Full campaign create → send flow (list audience)
// ---------------------------------------------------------------------------
describe("Full HTTP flow: campaign create+send (list audience)", () => {
  test("POST /admin/campaigns/new with audienceMode=list creates correct DB row and sends", async () => {
    const db = createTestDb();
    await seedOwner(db);
    const list = seedList(db, { slug: "newsletter", name: "Newsletter", fromDomain: "example.com" });

    // Create a confirmed subscriber
    const sub = createSubscriber(db, "reader@example.com", "Reader", "One", ["newsletter"]);
    confirmSubscriber(db, sub.unsubscribeToken);

    const app = createApp(db);
    const cookie = await login(app);

    // POST campaign creation via the admin form handler
    const createRes = await authPost(app, "/admin/campaigns/new", cookie, {
      audienceMode: "list",
      listId: String(list.id),
      fromAddress: "test@example.com",
      subject: "Test List Campaign",
      bodyMarkdown: "Hello {{firstName}}",
    });

    // Should redirect to campaign detail page
    expect(createRes.status).toBe(302);

    // Verify campaign in DB
    const campaign = db.select().from(schema.campaigns).get();
    expect(campaign).toBeDefined();
    expect(campaign!.audienceType).toBe("list");
    expect(campaign!.audienceId).toBe(list.id);
    expect(campaign!.audienceData).toBeNull();
    expect(campaign!.status).toBe("draft");

    // Mock SES and send
    sesMock.on(SendEmailCommand).resolves({ MessageId: "list-msg-id" });

    const sendRes = await authPost(app, `/admin/campaigns/${campaign!.id}/send`, cookie, {});
    expect(sendRes.status).toBe(302);

    // Verify campaign is now "sent"
    const updated = db
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaign!.id))
      .get();
    expect(updated!.status).toBe("sent");
    expect(updated!.sentAt).not.toBeNull();

    // Verify SES called once
    const sesCalls = sesMock.commandCalls(SendEmailCommand);
    expect(sesCalls).toHaveLength(1);

    // Verify campaignSends record
    const sends = db
      .select()
      .from(schema.campaignSends)
      .where(eq(schema.campaignSends.campaignId, campaign!.id))
      .all();
    expect(sends).toHaveLength(1);
    expect(sends[0].subscriberId).toBe(sub.id);
    expect(sends[0].status).toBe("sent");
  });
});

// ---------------------------------------------------------------------------
// Test 2: Full campaign create → send flow (specific subscribers)
// ---------------------------------------------------------------------------
describe("Full HTTP flow: campaign create+send (specific subscribers)", () => {
  test("POST with audienceMode=specific stores flat array in audienceData and sends to correct subscribers", async () => {
    const db = createTestDb();
    await seedOwner(db);
    seedList(db, { slug: "newsletter", name: "Newsletter", fromDomain: "example.com" });

    const sub1 = createSubscriber(db, "pick1@example.com", "Pick", "One", ["newsletter"]);
    confirmSubscriber(db, sub1.unsubscribeToken);
    const sub2 = createSubscriber(db, "skip@example.com", "Skip", "Me", ["newsletter"]);
    confirmSubscriber(db, sub2.unsubscribeToken);
    const sub3 = createSubscriber(db, "pick3@example.com", "Pick", "Three", ["newsletter"]);
    confirmSubscriber(db, sub3.unsubscribeToken);

    const app = createApp(db);
    const cookie = await login(app);

    // POST with subscriberIds as comma-separated string (as the form does)
    const createRes = await authPost(app, "/admin/campaigns/new", cookie, {
      audienceMode: "specific",
      subscriberIds: `${sub1.id},${sub3.id}`,
      fromAddress: "test@example.com",
      subject: "Specific Subs",
      bodyMarkdown: "Hello {{firstName}}",
    });
    expect(createRes.status).toBe(302);

    // Verify DB
    const campaign = db.select().from(schema.campaigns).get();
    expect(campaign).toBeDefined();
    expect(campaign!.audienceType).toBe("subscribers");
    expect(campaign!.audienceId).toBeNull();

    // Critical: audienceData must be a flat JSON array [id1, id3], NOT wrapped in an object
    const parsedData = JSON.parse(campaign!.audienceData!);
    expect(Array.isArray(parsedData)).toBe(true);
    expect(parsedData).toEqual([sub1.id, sub3.id]);

    // Mock SES and send
    sesMock.on(SendEmailCommand).resolves({ MessageId: "specific-msg-id" });

    await authPost(app, `/admin/campaigns/${campaign!.id}/send`, cookie, {});

    // Verify SES called exactly 2 times (not 3)
    const sesCalls = sesMock.commandCalls(SendEmailCommand);
    expect(sesCalls).toHaveLength(2);

    // Verify sends
    const sends = db
      .select()
      .from(schema.campaignSends)
      .where(eq(schema.campaignSends.campaignId, campaign!.id))
      .all();
    expect(sends).toHaveLength(2);
    const sentIds = sends.map((s) => s.subscriberId).sort();
    expect(sentIds).toEqual([sub1.id, sub3.id].sort());
  });
});

// ---------------------------------------------------------------------------
// Test 3: Full campaign create → send flow (tag audience)
// ---------------------------------------------------------------------------
describe("Full HTTP flow: campaign create+send (tag audience)", () => {
  test("POST with audienceMode=tag creates correct DB row and sends only to tagged subscribers", async () => {
    const db = createTestDb();
    await seedOwner(db);
    seedList(db, { slug: "newsletter", name: "Newsletter", fromDomain: "example.com" });

    const sub1 = createSubscriber(db, "tagged1@example.com", "Tagged", "One", ["newsletter"]);
    confirmSubscriber(db, sub1.unsubscribeToken);
    const sub2 = createSubscriber(db, "tagged2@example.com", "Tagged", "Two", ["newsletter"]);
    confirmSubscriber(db, sub2.unsubscribeToken);
    const sub3 = createSubscriber(db, "untagged@example.com", "Untagged", null, ["newsletter"]);
    confirmSubscriber(db, sub3.unsubscribeToken);

    // Create tag and apply to sub1 and sub2
    const tag = db.insert(schema.tags).values({ name: "vip" }).returning().get();
    db.insert(schema.subscriberTags).values({ subscriberId: sub1.id, tagId: tag.id }).run();
    db.insert(schema.subscriberTags).values({ subscriberId: sub2.id, tagId: tag.id }).run();

    const app = createApp(db);
    const cookie = await login(app);

    const createRes = await authPost(app, "/admin/campaigns/new", cookie, {
      audienceMode: "tag",
      tagId: String(tag.id),
      fromAddress: "test@example.com",
      subject: "VIP Only",
      bodyMarkdown: "# VIP content",
    });
    expect(createRes.status).toBe(302);

    // Verify DB
    const campaign = db.select().from(schema.campaigns).get();
    expect(campaign).toBeDefined();
    expect(campaign!.audienceType).toBe("tag");
    expect(campaign!.audienceId).toBe(tag.id);

    // Mock SES and send
    sesMock.on(SendEmailCommand).resolves({ MessageId: "tag-msg-id" });

    await authPost(app, `/admin/campaigns/${campaign!.id}/send`, cookie, {});

    // Verify SES called exactly 2 times
    const sesCalls = sesMock.commandCalls(SendEmailCommand);
    expect(sesCalls).toHaveLength(2);

    // Verify sends target sub1 and sub2
    const sends = db
      .select()
      .from(schema.campaignSends)
      .where(eq(schema.campaignSends.campaignId, campaign!.id))
      .all();
    expect(sends).toHaveLength(2);
    const sentIds = sends.map((s) => s.subscriberId).sort();
    expect(sentIds).toEqual([sub1.id, sub2.id].sort());
  });
});

// ---------------------------------------------------------------------------
// Test 4: Full campaign create → send flow (all subscribers)
// ---------------------------------------------------------------------------
describe("Full HTTP flow: campaign create+send (all subscribers)", () => {
  test("POST with audienceMode=all creates correct DB row and sends to all unique confirmed subscribers", async () => {
    const db = createTestDb();
    await seedOwner(db);
    const listA = seedList(db, { slug: "list-a", name: "List A", fromDomain: "example.com" });
    const listB = seedList(db, { slug: "list-b", name: "List B", fromDomain: "example.com" });

    // sub1: on list-a only
    const sub1 = createSubscriber(db, "sub1@example.com", "Sub", "One", ["list-a"]);
    confirmSubscriber(db, sub1.unsubscribeToken);
    // sub2: on list-b only
    const sub2 = createSubscriber(db, "sub2@example.com", "Sub", "Two", ["list-b"]);
    confirmSubscriber(db, sub2.unsubscribeToken);
    // sub3: on BOTH lists (should only get 1 email)
    const sub3 = createSubscriber(db, "sub3@example.com", "Sub", "Three", ["list-a", "list-b"]);
    confirmSubscriber(db, sub3.unsubscribeToken);

    const app = createApp(db);
    const cookie = await login(app);

    const createRes = await authPost(app, "/admin/campaigns/new", cookie, {
      audienceMode: "all",
      fromAddress: "broadcast@example.com",
      subject: "All Subscribers",
      bodyMarkdown: "Hello everyone",
    });
    expect(createRes.status).toBe(302);

    // Verify DB
    const campaign = db.select().from(schema.campaigns).get();
    expect(campaign).toBeDefined();
    expect(campaign!.audienceType).toBe("all");
    expect(campaign!.audienceId).toBeNull();

    // Mock SES and send
    sesMock.on(SendEmailCommand).resolves({ MessageId: "all-msg-id" });

    await authPost(app, `/admin/campaigns/${campaign!.id}/send`, cookie, {});

    // Should be exactly 3 calls (3 unique subscribers, not 4 from list memberships)
    const sesCalls = sesMock.commandCalls(SendEmailCommand);
    expect(sesCalls).toHaveLength(3);

    const sends = db
      .select()
      .from(schema.campaignSends)
      .where(eq(schema.campaignSends.campaignId, campaign!.id))
      .all();
    expect(sends).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Test 5: Full subscribe → confirm → receive campaign flow
// ---------------------------------------------------------------------------
describe("Full HTTP flow: subscribe → confirm → receive campaign", () => {
  test("public subscribe, confirm via link, then receive campaign via admin send", async () => {
    const db = createTestDb();
    await seedOwner(db);
    seedList(db, { slug: "newsletter", name: "Newsletter", fromDomain: "example.com" });

    const app = createApp(db);

    // Mock SES for confirmation email
    sesMock.on(SendEmailCommand).resolves({ MessageId: "confirm-msg-id" });

    // 1. POST /subscribe
    const subscribeRes = await app.request("/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email: "newuser@example.com",
        firstName: "New",
        lastName: "User",
        lists: "newsletter",
      }).toString(),
    });
    expect(subscribeRes.status).toBe(200);

    // Verify subscriber created
    const subscriber = db
      .select()
      .from(schema.subscribers)
      .where(eq(schema.subscribers.email, "newuser@example.com"))
      .get();
    expect(subscriber).toBeDefined();

    // Verify subscriberList is "unconfirmed"
    const subLists = db
      .select()
      .from(schema.subscriberLists)
      .where(eq(schema.subscriberLists.subscriberId, subscriber!.id))
      .all();
    expect(subLists).toHaveLength(1);
    expect(subLists[0].status).toBe("unconfirmed");

    // SES was called for confirmation email
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(1);

    // 2. GET /confirm/:token/:domain
    const confirmRes = await app.request(
      `/confirm/${subscriber!.unsubscribeToken}/example.com`,
      { method: "GET" },
    );
    expect(confirmRes.status).toBe(200);
    const confirmHtml = await confirmRes.text();
    expect(confirmHtml).toContain("Confirmed");

    // Verify subscriberList is now "confirmed"
    const confirmedLists = db
      .select()
      .from(schema.subscriberLists)
      .where(eq(schema.subscriberLists.subscriberId, subscriber!.id))
      .all();
    expect(confirmedLists).toHaveLength(1);
    expect(confirmedLists[0].status).toBe("confirmed");

    // 3. Create and send campaign via admin
    sesMock.reset();
    sesMock.on(SendEmailCommand).resolves({ MessageId: "campaign-msg-id" });

    const cookie = await login(app);
    const list = db
      .select()
      .from(schema.lists)
      .where(eq(schema.lists.slug, "newsletter"))
      .get();

    await authPost(app, "/admin/campaigns/new", cookie, {
      audienceMode: "list",
      listId: String(list!.id),
      fromAddress: "news@example.com",
      subject: "Welcome Email",
      bodyMarkdown: "Hello {{firstName}} {{lastName}}!",
    });

    const campaign = db.select().from(schema.campaigns).get();
    await authPost(app, `/admin/campaigns/${campaign!.id}/send`, cookie, {});

    // Verify subscriber received the campaign
    const sesCalls = sesMock.commandCalls(SendEmailCommand);
    expect(sesCalls).toHaveLength(1);

    const sends = db
      .select()
      .from(schema.campaignSends)
      .where(eq(schema.campaignSends.campaignId, campaign!.id))
      .all();
    expect(sends).toHaveLength(1);
    expect(sends[0].subscriberId).toBe(subscriber!.id);
    expect(sends[0].status).toBe("sent");
  });
});

// ---------------------------------------------------------------------------
// Test 6: Reply flow via HTTP
// ---------------------------------------------------------------------------
describe("Full HTTP flow: reply to inbound message", () => {
  test("POST /admin/inbound/:id/reply creates outbound message with threading", async () => {
    const db = createTestDb();
    await seedOwner(db);
    seedList(db, { slug: "newsletter", fromDomain: "example.com" });

    // Insert an inbound message (simulating the poller having received it)
    const inbound = db
      .insert(schema.messages)
      .values({
        threadId: 0,
        direction: "inbound",
        sesMessageId: "inbound-reply-test-001",
        rfc822MessageId: "<original@gmail.com>",
        fromAddr: "sender@gmail.com",
        toAddr: "newsletter@reply.example.com",
        subject: "Question about newsletter",
        spamVerdict: "PASS",
        virusVerdict: "PASS",
        spfVerdict: "PASS",
        dkimVerdict: "PASS",
        dmarcVerdict: "PASS",
        s3Key: "inbound/inbound-reply-test-001",
      })
      .returning()
      .get();

    // Update threadId to own id (simulating the poller setting it)
    db.update(schema.messages)
      .set({ threadId: inbound.id })
      .where(eq(schema.messages.id, inbound.id))
      .run();

    sesMock.on(SendEmailCommand).resolves({ MessageId: "ses-reply-id" });

    const app = createApp(db);
    const cookie = await login(app);

    // POST reply
    const replyRes = await authPost(app, `/admin/inbound/${inbound.id}/reply`, cookie, {
      fromAddr: "admin@example.com",
      toAddr: "sender@gmail.com",
      subject: "Re: Question about newsletter",
      body: "Thanks for reaching out!",
    });

    // Should redirect
    expect(replyRes.status).toBe(302);

    // Verify SES called
    const sesCalls = sesMock.commandCalls(SendEmailCommand);
    expect(sesCalls).toHaveLength(1);

    // Verify raw email contains threading headers
    const rawData = sesCalls[0].args[0].input.Content?.Raw?.Data;
    expect(rawData).toBeDefined();
    const rawEmail = new TextDecoder().decode(rawData as Uint8Array);
    expect(rawEmail).toContain("In-Reply-To: <original@gmail.com>");
    expect(rawEmail).toContain("References: <original@gmail.com>");

    // Verify outbound message created in DB
    const outbound = db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.direction, "outbound"))
      .get();
    expect(outbound).toBeDefined();
    expect(outbound!.threadId).toBe(inbound.id);
    expect(outbound!.parentId).toBe(inbound.id);
    expect(outbound!.fromAddr).toBe("admin@example.com");
    expect(outbound!.toAddr).toBe("sender@gmail.com");
    expect(outbound!.subject).toBe("Re: Question about newsletter");
    expect(outbound!.bodyText).toBe("Thanks for reaching out!");
    expect(outbound!.inReplyTo).toBe("<original@gmail.com>");
  });
});

// ---------------------------------------------------------------------------
// Test 7: Campaign edit via HTTP
// ---------------------------------------------------------------------------
describe("Full HTTP flow: campaign edit then send", () => {
  test("POST /admin/campaigns/:id/edit updates campaign, and send uses new content", async () => {
    const db = createTestDb();
    await seedOwner(db);
    const list = seedList(db, { slug: "newsletter", name: "Newsletter", fromDomain: "example.com" });

    const sub = createSubscriber(db, "reader@example.com", "Reader", null, ["newsletter"]);
    confirmSubscriber(db, sub.unsubscribeToken);

    const app = createApp(db);
    const cookie = await login(app);

    // Create draft campaign
    await authPost(app, "/admin/campaigns/new", cookie, {
      audienceMode: "list",
      listId: String(list.id),
      fromAddress: "test@example.com",
      subject: "Original Subject",
      bodyMarkdown: "Original body",
    });

    const campaign = db.select().from(schema.campaigns).get();
    expect(campaign).toBeDefined();
    expect(campaign!.subject).toBe("Original Subject");
    expect(campaign!.bodyMarkdown).toBe("Original body");

    // Edit the campaign
    const editRes = await authPost(app, `/admin/campaigns/${campaign!.id}/edit`, cookie, {
      audienceMode: "list",
      listId: String(list.id),
      fromAddress: "test@example.com",
      subject: "Updated Subject",
      bodyMarkdown: "Updated body with {{firstName}}",
    });
    expect(editRes.status).toBe(302);

    // Verify updated in DB
    const updated = db
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaign!.id))
      .get();
    expect(updated!.subject).toBe("Updated Subject");
    expect(updated!.bodyMarkdown).toBe("Updated body with {{firstName}}");

    // Send it and verify the NEW content was used
    sesMock.on(SendEmailCommand).resolves({ MessageId: "edit-msg-id" });

    await authPost(app, `/admin/campaigns/${campaign!.id}/send`, cookie, {});

    const sesCalls = sesMock.commandCalls(SendEmailCommand);
    expect(sesCalls).toHaveLength(1);

    // Decode the raw email and check it contains the updated content
    const rawData = sesCalls[0].args[0].input.Content?.Raw?.Data;
    const rawEmail = new TextDecoder().decode(rawData as Uint8Array);
    expect(rawEmail).toContain("Updated Subject");
    expect(rawEmail).toContain("Updated body with Reader");

    // Campaign should be sent
    const final = db
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaign!.id))
      .get();
    expect(final!.status).toBe("sent");
  });
});
