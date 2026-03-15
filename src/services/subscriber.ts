import { eq, and } from "drizzle-orm";
import { type Db, schema } from "../db";
import { generateToken } from "../compliance";
import { logEvent } from "./events";

export function createSubscriber(
  db: Db,
  email: string,
  name: string | null,
  listSlugs: string[],
) {
  const normalized = email.toLowerCase().trim();

  let subscriber = db.select().from(schema.subscribers).where(eq(schema.subscribers.email, normalized)).get();

  if (!subscriber) {
    subscriber = db
      .insert(schema.subscribers)
      .values({
        email: normalized,
        name,
        unsubscribeToken: generateToken(),
      })
      .returning()
      .get();

    logEvent(db, {
      type: "subscriber.created",
      detail: `Subscriber ${normalized} created`,
      subscriberId: subscriber.id,
    });
  }

  for (const slug of listSlugs) {
    const list = db.select().from(schema.lists).where(eq(schema.lists.slug, slug)).get();
    if (!list) continue;

    const existing = db.select().from(schema.subscriberLists).where(and(
      eq(schema.subscriberLists.subscriberId, subscriber.id),
      eq(schema.subscriberLists.listId, list.id),
    )).get();
    if (existing) continue;

    db.insert(schema.subscriberLists)
      .values({
        subscriberId: subscriber.id,
        listId: list.id,
        status: "unconfirmed",
      })
      .run();
  }

  return subscriber;
}

export function confirmSubscriber(db: Db, token: string): boolean {
  const subscriber = db.select().from(schema.subscribers).where(eq(schema.subscribers.unsubscribeToken, token)).get();
  if (!subscriber) return false;

  db.update(schema.subscribers)
    .set({ confirmedAt: new Date().toISOString() })
    .where(eq(schema.subscribers.id, subscriber.id))
    .run();

  db.update(schema.subscriberLists)
    .set({ status: "confirmed" })
    .where(
      and(
        eq(schema.subscriberLists.subscriberId, subscriber.id),
        eq(schema.subscriberLists.status, "unconfirmed"),
      ),
    )
    .run();

  logEvent(db, {
    type: "subscriber.confirmed",
    detail: `Subscriber ${subscriber.email} confirmed`,
    subscriberId: subscriber.id,
  });

  return true;
}

export function unsubscribeAll(db: Db, token: string): boolean {
  const subscriber = db.select().from(schema.subscribers).where(eq(schema.subscribers.unsubscribeToken, token)).get();
  if (!subscriber) return false;

  db.update(schema.subscribers)
    .set({ status: "unsubscribed" })
    .where(eq(schema.subscribers.id, subscriber.id))
    .run();

  db.update(schema.subscriberLists)
    .set({ status: "unsubscribed" })
    .where(eq(schema.subscriberLists.subscriberId, subscriber.id))
    .run();

  logEvent(db, {
    type: "subscriber.unsubscribed",
    detail: `Subscriber ${subscriber.email} unsubscribed from all lists`,
    subscriberId: subscriber.id,
  });

  return true;
}

export function getSubscriberPreferences(db: Db, token: string) {
  const subscriber = db.select().from(schema.subscribers).where(eq(schema.subscribers.unsubscribeToken, token)).get();
  if (!subscriber) return null;

  const allLists = db.select().from(schema.lists).all();

  const subscriptions = db.select().from(schema.subscriberLists).where(eq(schema.subscriberLists.subscriberId, subscriber.id)).all();

  const subsByListId = new Map(subscriptions.map((s) => [s.listId, s]));

  const listsWithStatus = allLists.map((list) => {
    const sub = subsByListId.get(list.id);
    return {
      ...list,
      subscriptionStatus: sub ? sub.status : ("none" as const),
    };
  });

  return { subscriber, lists: listsWithStatus };
}

export function updatePreferences(
  db: Db,
  token: string,
  subscribedListIds: number[],
): boolean {
  const subscriber = db.select().from(schema.subscribers).where(eq(schema.subscribers.unsubscribeToken, token)).get();
  if (!subscriber) return false;

  const allLists = db.select().from(schema.lists).all();
  const wantedIds = new Set(subscribedListIds);

  for (const list of allLists) {
    const existing = db.select().from(schema.subscriberLists).where(and(
      eq(schema.subscriberLists.subscriberId, subscriber.id),
      eq(schema.subscriberLists.listId, list.id),
    )).get();

    if (wantedIds.has(list.id)) {
      if (!existing) {
        db.insert(schema.subscriberLists)
          .values({
            subscriberId: subscriber.id,
            listId: list.id,
            status: "confirmed",
          })
          .run();
      } else if (existing.status !== "confirmed") {
        db.update(schema.subscriberLists)
          .set({ status: "confirmed" })
          .where(
            and(
              eq(schema.subscriberLists.subscriberId, subscriber.id),
              eq(schema.subscriberLists.listId, list.id),
            ),
          )
          .run();
      }
    } else {
      if (existing && existing.status !== "unsubscribed") {
        db.update(schema.subscriberLists)
          .set({ status: "unsubscribed" })
          .where(
            and(
              eq(schema.subscriberLists.subscriberId, subscriber.id),
              eq(schema.subscriberLists.listId, list.id),
            ),
          )
          .run();
      }
    }
  }

  logEvent(db, {
    type: "subscriber.preferences_updated",
    detail: `Subscriber ${subscriber.email} updated preferences`,
    meta: { subscribedListIds },
    subscriberId: subscriber.id,
  });

  return true;
}

export function getConfirmedSubscribers(db: Db, listId: number) {
  return db
    .select({
      id: schema.subscribers.id,
      email: schema.subscribers.email,
      name: schema.subscribers.name,
      unsubscribeToken: schema.subscribers.unsubscribeToken,
    })
    .from(schema.subscribers)
    .innerJoin(
      schema.subscriberLists,
      eq(schema.subscribers.id, schema.subscriberLists.subscriberId),
    )
    .where(
      and(
        eq(schema.subscriberLists.listId, listId),
        eq(schema.subscriberLists.status, "confirmed"),
        eq(schema.subscribers.status, "active"),
      ),
    )
    .all();
}
