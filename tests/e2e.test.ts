import { test, expect, describe, beforeEach } from "bun:test";
import { mockClient } from "aws-sdk-client-mock";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import { eq, and, desc } from "drizzle-orm";
import { Hono } from "hono";

import { createTestDb, seedList, seedSubscriber, type TestDb } from "./helpers";
import { sendCampaign } from "../src/services/sender";
import { publicRoutes } from "../src/routes/public";
import { adminRoutes } from "../src/routes/admin";
import * as schema from "../src/db/schema";
import type { Config } from "../src/config";
import {
  createSubscriber,
  confirmSubscriber,
  unsubscribeFromList,
} from "../src/services/subscriber";
import { createSession } from "../src/auth";

const sesMock = mockClient(SESv2Client);
const sqsMock = mockClient(SQSClient);

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
  sqsMock.reset();
});

// ---------------------------------------------------------------------------
// 1. Full campaign send flow
// ---------------------------------------------------------------------------
describe("Full campaign send flow", () => {
  test("sends to a confirmed subscriber and records the send", async () => {
    const db = createTestDb();
    const list = seedList(db, { slug: "newsletter", fromDomain: "example.com" });

    // create confirmed subscriber
    const sub = createSubscriber(db, "reader@example.com", "Reader", [
      "newsletter",
    ]);
    confirmSubscriber(db, sub.unsubscribeToken);

    // create draft campaign
    const campaign = db
      .insert(schema.campaigns)
      .values({
        listId: list.id,
        subject: "Hello World",
        bodyMarkdown: "# Welcome\n\nThis is a test campaign.",
        fromAddress: "news@example.com",
        status: "draft",
      })
      .returning()
      .get();

    // mock SES
    sesMock.on(SendEmailCommand).resolves({ MessageId: "test-msg-id" });

    await sendCampaign(db, testConfig, campaign.id);

    // campaign should be "sent"
    const updated = db
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaign.id))
      .get();
    expect(updated!.status).toBe("sent");
    expect(updated!.sentAt).not.toBeNull();

    // campaignSends should have 1 entry with status "sent"
    const sends = db
      .select()
      .from(schema.campaignSends)
      .where(eq(schema.campaignSends.campaignId, campaign.id))
      .all();
    expect(sends).toHaveLength(1);
    expect(sends[0].status).toBe("sent");
    expect(sends[0].sesMessageId).toBe("test-msg-id");

    // SES should have been called exactly once
    const sesCalls = sesMock.commandCalls(SendEmailCommand);
    expect(sesCalls).toHaveLength(1);

    // The call should contain Raw email data
    const input = sesCalls[0].args[0].input;
    expect(input.Content?.Raw?.Data).toBeDefined();
    expect(input.ConfigurationSetName).toBe("test-config-set");
  });
});

// ---------------------------------------------------------------------------
// 2. Campaign send failure flow
// ---------------------------------------------------------------------------
describe("Campaign send failure flow", () => {
  test("records bounced send when SES rejects a single subscriber", async () => {
    const db = createTestDb();
    const list = seedList(db, { slug: "newsletter", fromDomain: "example.com" });

    const sub = createSubscriber(db, "reader@example.com", "Reader", [
      "newsletter",
    ]);
    confirmSubscriber(db, sub.unsubscribeToken);

    const campaign = db
      .insert(schema.campaigns)
      .values({
        listId: list.id,
        subject: "Failing Campaign",
        bodyMarkdown: "# Oops",
        fromAddress: "news@example.com",
        status: "draft",
      })
      .returning()
      .get();

    // mock SES to reject — the per-subscriber error is caught internally;
    // the campaign still completes as "sent" but each individual send is "bounced"
    sesMock
      .on(SendEmailCommand)
      .rejects(new Error("SES rate limit exceeded"));

    await sendCampaign(db, testConfig, campaign.id);

    // campaign completes (per-subscriber errors are caught, not propagated)
    const updated = db
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaign.id))
      .get();
    expect(updated!.status).toBe("sent");

    // campaignSends should have an entry with status "bounced"
    const sends = db
      .select()
      .from(schema.campaignSends)
      .where(eq(schema.campaignSends.campaignId, campaign.id))
      .all();
    expect(sends).toHaveLength(1);
    expect(sends[0].status).toBe("bounced");
    expect(sends[0].sesMessageId).toBeNull();
  });

  test("throws for non-existent campaign", async () => {
    const db = createTestDb();
    expect(sendCampaign(db, testConfig, 9999)).rejects.toThrow(
      "Campaign 9999 not found",
    );
  });

  test("throws for campaign that is already sent", async () => {
    const db = createTestDb();
    const list = seedList(db, { slug: "newsletter", fromDomain: "example.com" });
    const campaign = db
      .insert(schema.campaigns)
      .values({
        listId: list.id,
        subject: "Already Sent",
        bodyMarkdown: "# Done",
        fromAddress: "news@example.com",
        status: "sent",
        sentAt: new Date().toISOString(),
      })
      .returning()
      .get();

    expect(sendCampaign(db, testConfig, campaign.id)).rejects.toThrow(
      "must be draft or failed to send",
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Campaign retry skips already-sent subscribers
// ---------------------------------------------------------------------------
describe("Campaign retry skips already sent", () => {
  test("only sends to subscribers without a successful send record", async () => {
    const db = createTestDb();
    const list = seedList(db, { slug: "newsletter", fromDomain: "example.com" });

    // subscriber 1: already sent
    const sub1 = createSubscriber(db, "already@example.com", "Already", [
      "newsletter",
    ]);
    confirmSubscriber(db, sub1.unsubscribeToken);

    // subscriber 2: not yet sent
    const sub2 = createSubscriber(db, "pending@example.com", "Pending", [
      "newsletter",
    ]);
    confirmSubscriber(db, sub2.unsubscribeToken);

    // create a "failed" campaign (eligible for retry)
    const campaign = db
      .insert(schema.campaigns)
      .values({
        listId: list.id,
        subject: "Retry Campaign",
        bodyMarkdown: "# Retry",
        fromAddress: "news@example.com",
        status: "failed",
      })
      .returning()
      .get();

    // insert an existing "sent" record for sub1
    db.insert(schema.campaignSends)
      .values({
        campaignId: campaign.id,
        subscriberId: sub1.id,
        sesMessageId: "prev-msg-id",
        status: "sent",
        sentAt: new Date().toISOString(),
      })
      .run();

    sesMock.on(SendEmailCommand).resolves({ MessageId: "retry-msg-id" });

    await sendCampaign(db, testConfig, campaign.id);

    // SES should have been called only once (skipped sub1)
    const sesCalls = sesMock.commandCalls(SendEmailCommand);
    expect(sesCalls).toHaveLength(1);

    // should have 2 total sends: 1 pre-existing + 1 new
    const sends = db
      .select()
      .from(schema.campaignSends)
      .where(eq(schema.campaignSends.campaignId, campaign.id))
      .all();
    expect(sends).toHaveLength(2);

    const newSend = sends.find((s) => s.subscriberId === sub2.id);
    expect(newSend).toBeDefined();
    expect(newSend!.status).toBe("sent");
    expect(newSend!.sesMessageId).toBe("retry-msg-id");
  });
});

// ---------------------------------------------------------------------------
// 4. Inbound message processing (simulating poller logic)
// ---------------------------------------------------------------------------
describe("Inbound message processing", () => {
  test("parses SQS payload, matches campaign, and inserts inbound message", () => {
    const db = createTestDb();
    const list = seedList(db, {
      slug: "newsletter",
      fromDomain: "example.com",
    });

    // create a sent campaign to match against
    const campaign = db
      .insert(schema.campaigns)
      .values({
        listId: list.id,
        subject: "Sent Campaign",
        bodyMarkdown: "# Sent",
        fromAddress: "news@example.com",
        status: "sent",
        sentAt: new Date().toISOString(),
      })
      .returning()
      .get();

    // simulate an SQS payload as the poller would parse it
    const payload = {
      messageId: "inbound-msg-001",
      timestamp: new Date().toISOString(),
      source: "replier@gmail.com",
      from: ["replier@gmail.com"],
      to: ["newsletter@reply.example.com"],
      subject: "Re: Sent Campaign",
      spamVerdict: "PASS",
      virusVerdict: "PASS",
      spfVerdict: "PASS",
      dkimVerdict: "PASS",
      dmarcVerdict: "PASS",
      action: {
        type: "S3",
        bucketName: "test-bucket",
        objectKeyPrefix: "inbound/",
        objectKey: "inbound/inbound-msg-001",
      },
    };

    // replicate the poller's campaign-matching logic
    let campaignId: number | null = null;
    for (const toAddr of payload.to) {
      const match = toAddr.match(/^([^@]+)@reply\./);
      if (!match) continue;
      const slug = match[1];
      const matchedList = db
        .select()
        .from(schema.lists)
        .where(eq(schema.lists.slug, slug!))
        .get();
      if (!matchedList) continue;
      const matchedCampaign = db
        .select()
        .from(schema.campaigns)
        .where(
          and(
            eq(schema.campaigns.listId, matchedList.id),
            eq(schema.campaigns.status, "sent"),
          ),
        )
        .orderBy(desc(schema.campaigns.sentAt))
        .get();
      if (matchedCampaign) {
        campaignId = matchedCampaign.id;
        break;
      }
    }

    const s3Key =
      payload.action.objectKey ||
      payload.action.objectKeyPrefix + payload.messageId;

    db.insert(schema.inboundMessages)
      .values({
        messageId: payload.messageId,
        timestamp: payload.timestamp,
        source: payload.source,
        fromAddrs: JSON.stringify(payload.from),
        toAddrs: JSON.stringify(payload.to),
        subject: payload.subject,
        spamVerdict: payload.spamVerdict,
        virusVerdict: payload.virusVerdict,
        spfVerdict: payload.spfVerdict,
        dkimVerdict: payload.dkimVerdict,
        dmarcVerdict: payload.dmarcVerdict,
        s3Key,
        campaignId,
      })
      .onConflictDoNothing({
        target: schema.inboundMessages.messageId,
      })
      .run();

    // verify it was inserted
    const inbound = db
      .select()
      .from(schema.inboundMessages)
      .where(eq(schema.inboundMessages.messageId, "inbound-msg-001"))
      .get();

    expect(inbound).toBeDefined();
    expect(inbound!.source).toBe("replier@gmail.com");
    expect(inbound!.subject).toBe("Re: Sent Campaign");
    expect(inbound!.s3Key).toBe("inbound/inbound-msg-001");
    expect(JSON.parse(inbound!.toAddrs)).toEqual([
      "newsletter@reply.example.com",
    ]);

    // campaignId should be linked correctly
    expect(inbound!.campaignId).toBe(campaign.id);
  });
});

// ---------------------------------------------------------------------------
// 5. Full subscribe -> confirm flow via Hono app
// ---------------------------------------------------------------------------
describe("Subscribe and confirm flow via Hono", () => {
  test("POST /subscribe creates subscriber, sends confirmation, GET /confirm confirms", async () => {
    const db = createTestDb();
    seedList(db, {
      slug: "newsletter",
      name: "Newsletter",
      fromDomain: "example.com",
    });

    sesMock.on(SendEmailCommand).resolves({ MessageId: "confirm-msg-id" });

    const app = new Hono();
    app.route("/", publicRoutes(db, testConfig));

    // POST /subscribe
    const formData = new URLSearchParams();
    formData.set("email", "newuser@example.com");
    formData.set("lists", "newsletter");

    const subscribeRes = await app.request("/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
    });

    expect(subscribeRes.status).toBe(200);

    // subscriber should exist in DB
    const subscriber = db
      .select()
      .from(schema.subscribers)
      .where(eq(schema.subscribers.email, "newuser@example.com"))
      .get();
    expect(subscriber).toBeDefined();

    // subscriberList should be "unconfirmed"
    const subLists = db
      .select()
      .from(schema.subscriberLists)
      .where(eq(schema.subscriberLists.subscriberId, subscriber!.id))
      .all();
    expect(subLists).toHaveLength(1);
    expect(subLists[0].status).toBe("unconfirmed");

    // SES should have been called to send the confirmation email
    const sesCalls = sesMock.commandCalls(SendEmailCommand);
    expect(sesCalls).toHaveLength(1);
    const sesInput = sesCalls[0].args[0].input;
    expect(sesInput.Destination?.ToAddresses).toEqual([
      "newuser@example.com",
    ]);
    expect(sesInput.FromEmailAddress).toBe("noreply@example.com");

    // GET /confirm/:token
    const token = subscriber!.unsubscribeToken;
    const confirmRes = await app.request(`/confirm/${token}`, {
      method: "GET",
    });

    expect(confirmRes.status).toBe(200);
    const confirmHtml = await confirmRes.text();
    expect(confirmHtml).toContain("Confirmed");

    // subscriberLists should all be "confirmed"
    const confirmedLists = db
      .select()
      .from(schema.subscriberLists)
      .where(eq(schema.subscriberLists.subscriberId, subscriber!.id))
      .all();
    expect(confirmedLists).toHaveLength(1);
    expect(confirmedLists[0].status).toBe("confirmed");
  });
});

// ---------------------------------------------------------------------------
// 6. Per-list unsubscribe flow
// ---------------------------------------------------------------------------
describe("Per-list unsubscribe flow via Hono", () => {
  test("GET /unsubscribe/:token/:listId unsubscribes from one list only", async () => {
    const db = createTestDb();
    const listA = seedList(db, {
      slug: "list-a",
      name: "List A",
      fromDomain: "example.com",
    });
    const listB = seedList(db, {
      slug: "list-b",
      name: "List B",
      fromDomain: "example.com",
    });

    const subscriber = createSubscriber(db, "reader@example.com", "Reader", [
      "list-a",
      "list-b",
    ]);
    confirmSubscriber(db, subscriber.unsubscribeToken);

    const app = new Hono();
    app.route("/", publicRoutes(db, testConfig));

    const res = await app.request(
      `/unsubscribe/${subscriber.unsubscribeToken}/${listA.id}`,
      { method: "GET" },
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("List A");
    expect(html).toContain("Manage all your subscriptions");

    // list-a should be unsubscribed
    const subListA = db
      .select()
      .from(schema.subscriberLists)
      .where(
        and(
          eq(schema.subscriberLists.subscriberId, subscriber.id),
          eq(schema.subscriberLists.listId, listA.id),
        ),
      )
      .get();
    expect(subListA!.status).toBe("unsubscribed");

    // list-b should still be confirmed
    const subListB = db
      .select()
      .from(schema.subscriberLists)
      .where(
        and(
          eq(schema.subscriberLists.subscriberId, subscriber.id),
          eq(schema.subscriberLists.listId, listB.id),
        ),
      )
      .get();
    expect(subListB!.status).toBe("confirmed");
  });

  test("POST /unsubscribe/:token/:listId RFC 8058 one-click per-list", async () => {
    const db = createTestDb();
    const listA = seedList(db, {
      slug: "list-a",
      name: "List A",
      fromDomain: "example.com",
    });
    const listB = seedList(db, {
      slug: "list-b",
      name: "List B",
      fromDomain: "example.com",
    });

    const subscriber = createSubscriber(db, "reader@example.com", "Reader", [
      "list-a",
      "list-b",
    ]);
    confirmSubscriber(db, subscriber.unsubscribeToken);

    const app = new Hono();
    app.route("/", publicRoutes(db, testConfig));

    const res = await app.request(
      `/unsubscribe/${subscriber.unsubscribeToken}/${listA.id}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      },
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("Unsubscribed");

    // list-a should be unsubscribed
    const subListA = db
      .select()
      .from(schema.subscriberLists)
      .where(
        and(
          eq(schema.subscriberLists.subscriberId, subscriber.id),
          eq(schema.subscriberLists.listId, listA.id),
        ),
      )
      .get();
    expect(subListA!.status).toBe("unsubscribed");

    // list-b should still be confirmed
    const subListB = db
      .select()
      .from(schema.subscriberLists)
      .where(
        and(
          eq(schema.subscriberLists.subscriberId, subscriber.id),
          eq(schema.subscriberLists.listId, listB.id),
        ),
      )
      .get();
    expect(subListB!.status).toBe("confirmed");
  });
});

// ---------------------------------------------------------------------------
// 7. Campaign with null listId sends to all active confirmed subscribers
// ---------------------------------------------------------------------------
describe("Campaign with null listId (all-subscribers send)", () => {
  test("sends to all unique confirmed subscribers across lists, no duplicates", async () => {
    const db = createTestDb();
    const listA = seedList(db, {
      slug: "list-a",
      name: "List A",
      fromDomain: "example.com",
    });
    const listB = seedList(db, {
      slug: "list-b",
      name: "List B",
      fromDomain: "example.com",
    });

    // subscriber-1: confirmed on list-a only
    const sub1 = createSubscriber(db, "sub1@example.com", "Sub One", [
      "list-a",
    ]);
    confirmSubscriber(db, sub1.unsubscribeToken);

    // subscriber-2: confirmed on list-b only
    const sub2 = createSubscriber(db, "sub2@example.com", "Sub Two", [
      "list-b",
    ]);
    confirmSubscriber(db, sub2.unsubscribeToken);

    // subscriber-3: confirmed on BOTH lists (should only get 1 email)
    const sub3 = createSubscriber(db, "sub3@example.com", "Sub Three", [
      "list-a",
      "list-b",
    ]);
    confirmSubscriber(db, sub3.unsubscribeToken);

    // campaign with null listId
    const campaign = db
      .insert(schema.campaigns)
      .values({
        listId: null,
        subject: "Broadcast to Everyone",
        bodyMarkdown: "# Hello All\n\nThis goes to everyone.",
        fromAddress: "broadcast@example.com",
        status: "draft",
      })
      .returning()
      .get();

    sesMock.on(SendEmailCommand).resolves({ MessageId: "broadcast-msg" });

    await sendCampaign(db, testConfig, campaign.id);

    // campaign should be "sent"
    const updated = db
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaign.id))
      .get();
    expect(updated!.status).toBe("sent");

    // SES should have been called exactly 3 times (not 4)
    const sesCalls = sesMock.commandCalls(SendEmailCommand);
    expect(sesCalls).toHaveLength(3);

    // campaignSends should have 3 entries
    const sends = db
      .select()
      .from(schema.campaignSends)
      .where(eq(schema.campaignSends.campaignId, campaign.id))
      .all();
    expect(sends).toHaveLength(3);
    expect(sends.every((s) => s.status === "sent")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 11. Tag-targeted campaign send
// ---------------------------------------------------------------------------
describe("Tag-targeted campaign send", () => {
  test("sends only to subscribers with the target tag", async () => {
    const db = createTestDb();
    const list = seedList(db, { slug: "newsletter", fromDomain: "example.com" });

    // Create 3 confirmed subscribers
    const sub1 = createSubscriber(db, "tagged1@example.com", "Tagged1", ["newsletter"]);
    confirmSubscriber(db, sub1.unsubscribeToken);
    const sub2 = createSubscriber(db, "tagged2@example.com", "Tagged2", ["newsletter"]);
    confirmSubscriber(db, sub2.unsubscribeToken);
    const sub3 = createSubscriber(db, "untagged@example.com", "Untagged", ["newsletter"]);
    confirmSubscriber(db, sub3.unsubscribeToken);

    // Create a tag and apply it to sub1 and sub2 only
    const tag = db
      .insert(schema.tags)
      .values({ name: "vip" })
      .returning()
      .get();

    db.insert(schema.subscriberTags).values({ subscriberId: sub1.id, tagId: tag.id }).run();
    db.insert(schema.subscriberTags).values({ subscriberId: sub2.id, tagId: tag.id }).run();

    // Campaign with tag audience (no listId)
    const campaign = db
      .insert(schema.campaigns)
      .values({
        listId: null,
        subject: "VIP Only",
        bodyMarkdown: "# VIP content",
        fromAddress: "vip@example.com",
        status: "draft",
        audience: JSON.stringify({ type: "tag", tagId: tag.id }),
      })
      .returning()
      .get();

    sesMock.on(SendEmailCommand).resolves({ MessageId: "tag-msg" });

    await sendCampaign(db, testConfig, campaign.id);

    // SES called exactly 2 times (sub1, sub2)
    const sesCalls = sesMock.commandCalls(SendEmailCommand);
    expect(sesCalls).toHaveLength(2);

    // Campaign status is "sent"
    const updated = db
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaign.id))
      .get();
    expect(updated!.status).toBe("sent");

    // campaignSends should have 2 entries
    const sends = db
      .select()
      .from(schema.campaignSends)
      .where(eq(schema.campaignSends.campaignId, campaign.id))
      .all();
    expect(sends).toHaveLength(2);

    const sentSubscriberIds = sends.map((s) => s.subscriberId).sort();
    expect(sentSubscriberIds).toEqual([sub1.id, sub2.id].sort());
  });
});

// ---------------------------------------------------------------------------
// 12. Specific-subscribers campaign send
// ---------------------------------------------------------------------------
describe("Specific-subscribers campaign send", () => {
  test("sends only to the specified subscriber IDs", async () => {
    const db = createTestDb();
    const list = seedList(db, { slug: "newsletter", fromDomain: "example.com" });

    // Create 3 confirmed subscribers
    const sub1 = createSubscriber(db, "pick1@example.com", "Pick1", ["newsletter"]);
    confirmSubscriber(db, sub1.unsubscribeToken);
    const sub2 = createSubscriber(db, "skip@example.com", "Skip", ["newsletter"]);
    confirmSubscriber(db, sub2.unsubscribeToken);
    const sub3 = createSubscriber(db, "pick3@example.com", "Pick3", ["newsletter"]);
    confirmSubscriber(db, sub3.unsubscribeToken);

    // Campaign targeting sub1 and sub3 only
    const campaign = db
      .insert(schema.campaigns)
      .values({
        listId: null,
        subject: "Selected Subscribers",
        bodyMarkdown: "# Just for you",
        fromAddress: "news@example.com",
        status: "draft",
        audience: JSON.stringify({ type: "subscribers", subscriberIds: [sub1.id, sub3.id] }),
      })
      .returning()
      .get();

    sesMock.on(SendEmailCommand).resolves({ MessageId: "specific-msg" });

    await sendCampaign(db, testConfig, campaign.id);

    // SES called exactly 2 times (sub1, sub3)
    const sesCalls = sesMock.commandCalls(SendEmailCommand);
    expect(sesCalls).toHaveLength(2);

    // Campaign status is "sent"
    const updated = db
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaign.id))
      .get();
    expect(updated!.status).toBe("sent");

    // campaignSends should have 2 entries for the right subscribers
    const sends = db
      .select()
      .from(schema.campaignSends)
      .where(eq(schema.campaignSends.campaignId, campaign.id))
      .all();
    expect(sends).toHaveLength(2);

    const sentSubscriberIds = sends.map((s) => s.subscriberId).sort();
    expect(sentSubscriberIds).toEqual([sub1.id, sub3.id].sort());
  });
});

// ---------------------------------------------------------------------------
// Helper: create owner user + login session for admin tests
// ---------------------------------------------------------------------------
function createOwnerAndSession(db: ReturnType<typeof createTestDb>) {
  const passwordHash = Bun.password.hashSync("testpass123");
  const user = db
    .insert(schema.users)
    .values({
      email: "owner@example.com",
      name: "Owner",
      passwordHash,
      role: "owner",
    })
    .returning()
    .get();
  const sessionToken = createSession(user.id);
  return { user, sessionToken };
}

// ---------------------------------------------------------------------------
// 8. Preview endpoint returns rendered email HTML
// ---------------------------------------------------------------------------
describe("GET /campaigns/:id/preview", () => {
  test("returns rendered email HTML without AdminLayout nav", async () => {
    const db = createTestDb();
    const list = seedList(db, {
      slug: "newsletter",
      name: "Newsletter",
      fromDomain: "example.com",
    });

    const campaign = db
      .insert(schema.campaigns)
      .values({
        listId: list.id,
        subject: "Preview Test Subject",
        bodyMarkdown: "# Big Heading\n\nSome **bold** content here.",
        fromAddress: "news@example.com",
        status: "draft",
      })
      .returning()
      .get();

    const { sessionToken } = createOwnerAndSession(db);

    const app = new Hono();
    app.route("/admin", adminRoutes(db, testConfig));

    const res = await app.request(`/admin/campaigns/${campaign.id}/preview`, {
      headers: { Cookie: `session=${sessionToken}` },
    });

    expect(res.status).toBe(200);
    const html = await res.text();

    // Should contain the campaign subject
    expect(html).toContain("Preview Test Subject");
    // Should contain rendered markdown (h1 tag, not raw "# Big Heading")
    expect(html).toContain("<h1>Big Heading</h1>");
    // Should contain rendered bold text
    expect(html).toContain("<strong>bold</strong>");
    // Should NOT contain AdminLayout nav bar
    expect(html).not.toContain("Dashboard");
    expect(html).not.toContain('class="bg-gray-900');
  });
});

// ---------------------------------------------------------------------------
// 9. Preview endpoint with subscriberId includes real unsubscribe URL
// ---------------------------------------------------------------------------
describe("GET /campaigns/:id/preview?subscriberId=N", () => {
  test("includes real unsubscribe URL with subscriber token", async () => {
    const db = createTestDb();
    const list = seedList(db, {
      slug: "newsletter",
      name: "Newsletter",
      fromDomain: "example.com",
    });

    const sub = createSubscriber(db, "reader@example.com", "Reader", [
      "newsletter",
    ]);
    confirmSubscriber(db, sub.unsubscribeToken);

    const campaign = db
      .insert(schema.campaigns)
      .values({
        listId: list.id,
        subject: "Unsub Preview",
        bodyMarkdown: "# Content",
        fromAddress: "news@example.com",
        status: "draft",
      })
      .returning()
      .get();

    const { sessionToken } = createOwnerAndSession(db);

    const app = new Hono();
    app.route("/admin", adminRoutes(db, testConfig));

    const res = await app.request(
      `/admin/campaigns/${campaign.id}/preview?subscriberId=${sub.id}`,
      { headers: { Cookie: `session=${sessionToken}` } },
    );

    expect(res.status).toBe(200);
    const html = await res.text();

    // Should contain a real unsubscribe URL (not the placeholder)
    expect(html).toContain("/unsubscribe/");
    expect(html).not.toContain("#unsubscribe");
    // Should contain the subscriber's actual token
    expect(html).toContain(sub.unsubscribeToken);
  });
});

// ---------------------------------------------------------------------------
// 10. POST preview endpoint renders markdown
// ---------------------------------------------------------------------------
describe("POST /campaigns/preview", () => {
  test("renders markdown body into HTML", async () => {
    const db = createTestDb();
    const { sessionToken } = createOwnerAndSession(db);

    const app = new Hono();
    app.route("/admin", adminRoutes(db, testConfig));

    const res = await app.request("/admin/campaigns/preview", {
      method: "POST",
      headers: {
        Cookie: `session=${sessionToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        bodyMarkdown: "# Hello\n\nWorld",
        subject: "Test",
        listName: "My List",
      }),
    });

    expect(res.status).toBe(200);
    const html = await res.text();

    // Should contain rendered h1, not raw markdown
    expect(html).toContain("<h1>Hello</h1>");
    // Should contain the paragraph text
    expect(html).toContain("World");
  });
});
