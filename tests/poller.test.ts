import { test, expect, describe } from "bun:test";
import { eq, desc, and } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { createTestDb, seedList } from "./helpers";

describe("poller inbound message storage", () => {
  test("inserting an inbound message with all fields works", () => {
    const db = createTestDb();

    db.insert(schema.inboundMessages)
      .values({
        messageId: "msg-001",
        timestamp: "2025-01-01T00:00:00Z",
        source: "sender@example.com",
        fromAddrs: JSON.stringify(["sender@example.com"]),
        toAddrs: JSON.stringify(["inbox@reply.example.com"]),
        subject: "Hello",
        spamVerdict: "PASS",
        virusVerdict: "PASS",
        spfVerdict: "PASS",
        dkimVerdict: "PASS",
        dmarcVerdict: "PASS",
        s3Key: "emails/msg-001",
        campaignId: null,
      })
      .onConflictDoNothing({
        target: schema.inboundMessages.messageId,
      })
      .run();

    const rows = db.select().from(schema.inboundMessages).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].messageId).toBe("msg-001");
    expect(rows[0].source).toBe("sender@example.com");
    expect(rows[0].subject).toBe("Hello");
    expect(rows[0].spamVerdict).toBe("PASS");
    expect(rows[0].s3Key).toBe("emails/msg-001");
    expect(rows[0].campaignId).toBeNull();
  });

  test("onConflictDoNothing prevents duplicate messageId errors", () => {
    const db = createTestDb();

    const values = {
      messageId: "msg-dup",
      timestamp: "2025-01-01T00:00:00Z",
      source: "dup@example.com",
      fromAddrs: JSON.stringify(["dup@example.com"]),
      toAddrs: JSON.stringify(["inbox@example.com"]),
      subject: "First",
      spamVerdict: "PASS",
      virusVerdict: "PASS",
      spfVerdict: "PASS",
      dkimVerdict: "PASS",
      dmarcVerdict: "PASS",
      s3Key: "emails/msg-dup",
      campaignId: null,
    };

    db.insert(schema.inboundMessages)
      .values(values)
      .onConflictDoNothing({ target: schema.inboundMessages.messageId })
      .run();

    // second insert with same messageId should not throw
    db.insert(schema.inboundMessages)
      .values({ ...values, subject: "Second" })
      .onConflictDoNothing({ target: schema.inboundMessages.messageId })
      .run();

    const rows = db.select().from(schema.inboundMessages).all();
    expect(rows).toHaveLength(1);
    // original row preserved
    expect(rows[0].subject).toBe("First");
  });

  test("campaign matching: to address matching {slug}@reply.{domain} resolves campaignId", () => {
    const db = createTestDb();
    const list = seedList(db, { slug: "weekly", fromDomain: "news.com" });

    // create a sent campaign for this list
    const campaign = db
      .insert(schema.campaigns)
      .values({
        listId: list.id,
        subject: "Weekly #1",
        bodyMarkdown: "Hello world",
        fromAddress: "news@news.com",
        status: "sent",
        sentAt: "2025-06-01T00:00:00Z",
      })
      .returning()
      .get();

    // simulate the poller's campaign matching logic
    const toAddrs = ["weekly@reply.news.com"];
    let campaignId: number | null = null;

    for (const toAddr of toAddrs) {
      const match = toAddr.match(/^([^@]+)@reply\./);
      if (!match) continue;
      const slug = match[1];
      const foundList = db
        .select()
        .from(schema.lists)
        .where(eq(schema.lists.slug, slug!))
        .get();
      if (!foundList) continue;
      const foundCampaign = db
        .select()
        .from(schema.campaigns)
        .where(
          and(
            eq(schema.campaigns.listId, foundList.id),
            eq(schema.campaigns.status, "sent"),
          ),
        )
        .orderBy(desc(schema.campaigns.sentAt))
        .get();
      if (foundCampaign) {
        campaignId = foundCampaign.id;
        break;
      }
    }

    expect(campaignId).toBe(campaign.id);

    // insert the inbound message with the matched campaignId
    db.insert(schema.inboundMessages)
      .values({
        messageId: "msg-reply-001",
        timestamp: "2025-06-02T00:00:00Z",
        source: "reader@gmail.com",
        fromAddrs: JSON.stringify(["reader@gmail.com"]),
        toAddrs: JSON.stringify(toAddrs),
        subject: "Re: Weekly #1",
        s3Key: "emails/msg-reply-001",
        campaignId,
      })
      .run();

    const stored = db
      .select()
      .from(schema.inboundMessages)
      .where(eq(schema.inboundMessages.messageId, "msg-reply-001"))
      .get();
    expect(stored!.campaignId).toBe(campaign.id);
  });

  test("campaign matching: no match when slug does not correspond to a list", () => {
    const db = createTestDb();
    seedList(db, { slug: "weekly" });

    const toAddrs = ["nonexistent@reply.news.com"];
    let campaignId: number | null = null;

    for (const toAddr of toAddrs) {
      const match = toAddr.match(/^([^@]+)@reply\./);
      if (!match) continue;
      const slug = match[1];
      const foundList = db
        .select()
        .from(schema.lists)
        .where(eq(schema.lists.slug, slug!))
        .get();
      if (!foundList) continue;
      const foundCampaign = db
        .select()
        .from(schema.campaigns)
        .where(
          and(
            eq(schema.campaigns.listId, foundList.id),
            eq(schema.campaigns.status, "sent"),
          ),
        )
        .orderBy(desc(schema.campaigns.sentAt))
        .get();
      if (foundCampaign) {
        campaignId = foundCampaign.id;
        break;
      }
    }

    expect(campaignId).toBeNull();
  });

  test("campaign matching: picks most recent sent campaign", () => {
    const db = createTestDb();
    const list = seedList(db, { slug: "digest" });

    // older campaign
    db.insert(schema.campaigns)
      .values({
        listId: list.id,
        subject: "Digest #1",
        bodyMarkdown: "Old",
        fromAddress: "digest@example.com",
        status: "sent",
        sentAt: "2025-01-01T00:00:00Z",
      })
      .run();

    // newer campaign
    const newer = db
      .insert(schema.campaigns)
      .values({
        listId: list.id,
        subject: "Digest #2",
        bodyMarkdown: "New",
        fromAddress: "digest@example.com",
        status: "sent",
        sentAt: "2025-06-01T00:00:00Z",
      })
      .returning()
      .get();

    const toAddrs = ["digest@reply.example.com"];
    let campaignId: number | null = null;

    for (const toAddr of toAddrs) {
      const match = toAddr.match(/^([^@]+)@reply\./);
      if (!match) continue;
      const slug = match[1];
      const foundList = db
        .select()
        .from(schema.lists)
        .where(eq(schema.lists.slug, slug!))
        .get();
      if (!foundList) continue;
      const foundCampaign = db
        .select()
        .from(schema.campaigns)
        .where(
          and(
            eq(schema.campaigns.listId, foundList.id),
            eq(schema.campaigns.status, "sent"),
          ),
        )
        .orderBy(desc(schema.campaigns.sentAt))
        .get();
      if (foundCampaign) {
        campaignId = foundCampaign.id;
        break;
      }
    }

    expect(campaignId).toBe(newer.id);
  });
});
