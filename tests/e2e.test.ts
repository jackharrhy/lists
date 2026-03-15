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
import * as schema from "../src/db/schema";
import type { Config } from "../src/config";
import {
  createSubscriber,
  confirmSubscriber,
  unsubscribeFromList,
} from "../src/services/subscriber";

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

    // subscriber should now be confirmed
    const confirmedSub = db
      .select()
      .from(schema.subscribers)
      .where(eq(schema.subscribers.id, subscriber!.id))
      .get();
    expect(confirmedSub!.confirmedAt).not.toBeNull();

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
