import { test, expect, describe } from "bun:test";
import { createTestDb, seedList, seedSubscriber } from "./helpers";
import {
  createSubscriber,
  confirmSubscriber,
  unsubscribeAll,
  getSubscriberPreferences,
  updatePreferences,
  getConfirmedSubscribers,
} from "../src/services/subscriber";
import { eq, and } from "drizzle-orm";
import * as schema from "../src/db/schema";

describe("createSubscriber", () => {
  test("creates a new subscriber with normalized email (lowercase, trimmed)", () => {
    const db = createTestDb();
    seedList(db, { slug: "news" });

    const subscriber = createSubscriber(db, "  Alice@Example.COM  ", "Alice", [
      "news",
    ]);

    expect(subscriber.email).toBe("alice@example.com");
    expect(subscriber.name).toBe("Alice");
  });

  test("generates an unsubscribeToken", () => {
    const db = createTestDb();
    seedList(db, { slug: "news" });

    const subscriber = createSubscriber(db, "bob@example.com", "Bob", [
      "news",
    ]);

    expect(subscriber.unsubscribeToken).toBeDefined();
    expect(subscriber.unsubscribeToken.length).toBeGreaterThan(0);
  });

  test("subscribes to requested lists by slug as unconfirmed", () => {
    const db = createTestDb();
    const list = seedList(db, { slug: "news", name: "News" });

    const subscriber = createSubscriber(db, "bob@example.com", "Bob", [
      "news",
    ]);

    const subList = db
      .select()
      .from(schema.subscriberLists)
      .where(
        and(
          eq(schema.subscriberLists.subscriberId, subscriber.id),
          eq(schema.subscriberLists.listId, list.id),
        ),
      )
      .get();

    expect(subList).toBeDefined();
    expect(subList!.status).toBe("unconfirmed");
  });

  test("returns existing subscriber if email already exists", () => {
    const db = createTestDb();
    seedList(db, { slug: "news" });

    const first = createSubscriber(db, "bob@example.com", "Bob", ["news"]);
    const second = createSubscriber(db, "bob@example.com", "Bob", ["news"]);

    expect(second.id).toBe(first.id);

    const allSubscribers = db.select().from(schema.subscribers).all();
    expect(allSubscribers).toHaveLength(1);
  });

  test("handles subscribing to multiple lists", () => {
    const db = createTestDb();
    const list1 = seedList(db, { slug: "news", name: "News" });
    const list2 = seedList(db, {
      slug: "updates",
      name: "Updates",
    });

    const subscriber = createSubscriber(db, "bob@example.com", "Bob", [
      "news",
      "updates",
    ]);

    const subLists = db
      .select()
      .from(schema.subscriberLists)
      .where(eq(schema.subscriberLists.subscriberId, subscriber.id))
      .all();

    expect(subLists).toHaveLength(2);
    expect(subLists.every((sl) => sl.status === "unconfirmed")).toBe(true);
  });
});

describe("confirmSubscriber", () => {
  test("sets confirmedAt on the subscriber", () => {
    const db = createTestDb();
    seedList(db, { slug: "news" });

    const subscriber = createSubscriber(db, "bob@example.com", "Bob", [
      "news",
    ]);
    confirmSubscriber(db, subscriber.unsubscribeToken);

    const updated = db
      .select()
      .from(schema.subscribers)
      .where(eq(schema.subscribers.id, subscriber.id))
      .get();

    expect(updated!.confirmedAt).toBeDefined();
    expect(updated!.confirmedAt).not.toBeNull();
  });

  test("updates all unconfirmed subscriberLists to confirmed", () => {
    const db = createTestDb();
    seedList(db, { slug: "news", name: "News" });
    seedList(db, { slug: "updates", name: "Updates" });

    const subscriber = createSubscriber(db, "bob@example.com", "Bob", [
      "news",
      "updates",
    ]);
    confirmSubscriber(db, subscriber.unsubscribeToken);

    const subLists = db
      .select()
      .from(schema.subscriberLists)
      .where(eq(schema.subscriberLists.subscriberId, subscriber.id))
      .all();

    expect(subLists).toHaveLength(2);
    expect(subLists.every((sl) => sl.status === "confirmed")).toBe(true);
  });

  test("returns true on success", () => {
    const db = createTestDb();
    seedList(db, { slug: "news" });

    const subscriber = createSubscriber(db, "bob@example.com", "Bob", [
      "news",
    ]);
    const result = confirmSubscriber(db, subscriber.unsubscribeToken);

    expect(result).toBe(true);
  });

  test("returns false for invalid token", () => {
    const db = createTestDb();
    const result = confirmSubscriber(db, "invalid-token-xyz");

    expect(result).toBe(false);
  });
});

describe("unsubscribeAll", () => {
  test("sets subscriber status to unsubscribed", () => {
    const db = createTestDb();
    seedList(db, { slug: "news" });

    const subscriber = createSubscriber(db, "bob@example.com", "Bob", [
      "news",
    ]);
    unsubscribeAll(db, subscriber.unsubscribeToken);

    const updated = db
      .select()
      .from(schema.subscribers)
      .where(eq(schema.subscribers.id, subscriber.id))
      .get();

    expect(updated!.status).toBe("unsubscribed");
  });

  test("updates all subscriberLists to unsubscribed", () => {
    const db = createTestDb();
    seedList(db, { slug: "news", name: "News" });
    seedList(db, { slug: "updates", name: "Updates" });

    const subscriber = createSubscriber(db, "bob@example.com", "Bob", [
      "news",
      "updates",
    ]);
    unsubscribeAll(db, subscriber.unsubscribeToken);

    const subLists = db
      .select()
      .from(schema.subscriberLists)
      .where(eq(schema.subscriberLists.subscriberId, subscriber.id))
      .all();

    expect(subLists).toHaveLength(2);
    expect(subLists.every((sl) => sl.status === "unsubscribed")).toBe(true);
  });

  test("returns true on success", () => {
    const db = createTestDb();
    seedList(db, { slug: "news" });

    const subscriber = createSubscriber(db, "bob@example.com", "Bob", [
      "news",
    ]);
    const result = unsubscribeAll(db, subscriber.unsubscribeToken);

    expect(result).toBe(true);
  });

  test("returns false for invalid token", () => {
    const db = createTestDb();
    const result = unsubscribeAll(db, "invalid-token-xyz");

    expect(result).toBe(false);
  });
});

describe("getSubscriberPreferences", () => {
  test("returns subscriber and list subscription status", () => {
    const db = createTestDb();
    const list = seedList(db, { slug: "news", name: "News" });

    const subscriber = createSubscriber(db, "bob@example.com", "Bob", [
      "news",
    ]);
    const prefs = getSubscriberPreferences(db, subscriber.unsubscribeToken);

    expect(prefs).not.toBeNull();
    expect(prefs!.subscriber.id).toBe(subscriber.id);
    expect(prefs!.lists).toHaveLength(1);
    expect(prefs!.lists[0].slug).toBe("news");
    expect(prefs!.lists[0].subscriptionStatus).toBe("unconfirmed");
  });

  test("returns null for invalid token", () => {
    const db = createTestDb();
    const result = getSubscriberPreferences(db, "invalid-token-xyz");

    expect(result).toBeNull();
  });
});

describe("updatePreferences", () => {
  test("subscribes to new lists", () => {
    const db = createTestDb();
    const list1 = seedList(db, { slug: "news", name: "News" });
    const list2 = seedList(db, { slug: "updates", name: "Updates" });

    const subscriber = createSubscriber(db, "bob@example.com", "Bob", [
      "news",
    ]);

    updatePreferences(db, subscriber.unsubscribeToken, [list1.id, list2.id]);

    const subLists = db
      .select()
      .from(schema.subscriberLists)
      .where(eq(schema.subscriberLists.subscriberId, subscriber.id))
      .all();

    expect(subLists).toHaveLength(2);
    // The original "news" subscription gets set to confirmed, and "updates" is newly inserted as confirmed
    const updatesEntry = subLists.find((sl) => sl.listId === list2.id);
    expect(updatesEntry).toBeDefined();
    expect(updatesEntry!.status).toBe("confirmed");
  });

  test("unsubscribes from unchecked lists", () => {
    const db = createTestDb();
    const list1 = seedList(db, { slug: "news", name: "News" });
    const list2 = seedList(db, { slug: "updates", name: "Updates" });

    const subscriber = createSubscriber(db, "bob@example.com", "Bob", [
      "news",
      "updates",
    ]);
    confirmSubscriber(db, subscriber.unsubscribeToken);

    // Only keep list1, drop list2
    updatePreferences(db, subscriber.unsubscribeToken, [list1.id]);

    const updatesEntry = db
      .select()
      .from(schema.subscriberLists)
      .where(
        and(
          eq(schema.subscriberLists.subscriberId, subscriber.id),
          eq(schema.subscriberLists.listId, list2.id),
        ),
      )
      .get();

    expect(updatesEntry!.status).toBe("unsubscribed");
  });

  test("re-subscribes to previously unsubscribed lists", () => {
    const db = createTestDb();
    const list = seedList(db, { slug: "news", name: "News" });

    const subscriber = createSubscriber(db, "bob@example.com", "Bob", [
      "news",
    ]);
    confirmSubscriber(db, subscriber.unsubscribeToken);

    // Unsubscribe from list
    updatePreferences(db, subscriber.unsubscribeToken, []);

    const unsubbed = db
      .select()
      .from(schema.subscriberLists)
      .where(
        and(
          eq(schema.subscriberLists.subscriberId, subscriber.id),
          eq(schema.subscriberLists.listId, list.id),
        ),
      )
      .get();
    expect(unsubbed!.status).toBe("unsubscribed");

    // Re-subscribe
    updatePreferences(db, subscriber.unsubscribeToken, [list.id]);

    const resubbed = db
      .select()
      .from(schema.subscriberLists)
      .where(
        and(
          eq(schema.subscriberLists.subscriberId, subscriber.id),
          eq(schema.subscriberLists.listId, list.id),
        ),
      )
      .get();
    expect(resubbed!.status).toBe("confirmed");
  });
});

describe("getConfirmedSubscribers", () => {
  test("returns only active + confirmed subscribers for a list", () => {
    const db = createTestDb();
    const list = seedList(db, { slug: "news", name: "News" });

    const sub1 = createSubscriber(db, "confirmed@example.com", "Confirmed", [
      "news",
    ]);
    confirmSubscriber(db, sub1.unsubscribeToken);

    // sub2 is unconfirmed — should not appear
    createSubscriber(db, "unconfirmed@example.com", "Unconfirmed", ["news"]);

    const confirmed = getConfirmedSubscribers(db, list.id);

    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].email).toBe("confirmed@example.com");
  });

  test("excludes unsubscribed subscribers", () => {
    const db = createTestDb();
    const list = seedList(db, { slug: "news", name: "News" });

    const sub1 = createSubscriber(db, "active@example.com", "Active", [
      "news",
    ]);
    confirmSubscriber(db, sub1.unsubscribeToken);

    const sub2 = createSubscriber(db, "unsub@example.com", "Unsub", ["news"]);
    confirmSubscriber(db, sub2.unsubscribeToken);
    unsubscribeAll(db, sub2.unsubscribeToken);

    const confirmed = getConfirmedSubscribers(db, list.id);

    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].email).toBe("active@example.com");
  });
});
