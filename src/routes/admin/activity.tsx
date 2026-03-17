import { Hono } from "hono";
import { eq, desc, and, inArray } from "drizzle-orm";
import type { Db } from "../../db";
import { schema } from "../../db";
import type { Config } from "../../config";
import { getAccessibleListIds } from "../../auth";
import { AdminLayout, fmtDateTime, type User } from "./layout";

export function mountActivityRoutes(app: Hono, db: Db, config: Config) {
  app.get("/activity", (c) => {
    const user = c.get("user") as User;
    const listAccess = getAccessibleListIds(db, user);

    // Join events with users to show who did what
    let recentEvents: {
      id: number;
      type: string;
      detail: string;
      meta: string | null;
      userId: number | null;
      subscriberId: number | null;
      campaignId: number | null;
      messageId: number | null;
      createdAt: string;
      userName: string | null;
    }[];

    if (listAccess === "all") {
      recentEvents = db
        .select({
          id: schema.events.id,
          type: schema.events.type,
          detail: schema.events.detail,
          meta: schema.events.meta,
          userId: schema.events.userId,
          subscriberId: schema.events.subscriberId,
          campaignId: schema.events.campaignId,
          messageId: schema.events.messageId,
          createdAt: schema.events.createdAt,
          userName: schema.users.name,
        })
        .from(schema.events)
        .leftJoin(schema.users, eq(schema.events.userId, schema.users.id))
        .orderBy(desc(schema.events.createdAt))
        .limit(200)
        .all();
    } else if (listAccess.length === 0) {
      recentEvents = [];
    } else {
      // For members, show events related to their accessible lists
      // This includes events with campaignId on their lists, subscriberId on their lists, etc.
      // Simplest approach: events linked to campaigns on accessible lists, plus subscriber events
      const campaignEvents = db
        .select({
          id: schema.events.id,
          type: schema.events.type,
          detail: schema.events.detail,
          meta: schema.events.meta,
          userId: schema.events.userId,
          subscriberId: schema.events.subscriberId,
          campaignId: schema.events.campaignId,
          messageId: schema.events.messageId,
          createdAt: schema.events.createdAt,
          userName: schema.users.name,
        })
        .from(schema.events)
        .leftJoin(schema.users, eq(schema.events.userId, schema.users.id))
        .innerJoin(schema.campaigns, eq(schema.events.campaignId, schema.campaigns.id))
        .where(and(eq(schema.campaigns.audienceType, "list"), inArray(schema.campaigns.audienceId, listAccess)))
        .orderBy(desc(schema.events.createdAt))
        .limit(200)
        .all();

      const subscriberEvents = db
        .select({
          id: schema.events.id,
          type: schema.events.type,
          detail: schema.events.detail,
          meta: schema.events.meta,
          userId: schema.events.userId,
          subscriberId: schema.events.subscriberId,
          campaignId: schema.events.campaignId,
          messageId: schema.events.messageId,
          createdAt: schema.events.createdAt,
          userName: schema.users.name,
        })
        .from(schema.events)
        .leftJoin(schema.users, eq(schema.events.userId, schema.users.id))
        .innerJoin(schema.subscribers, eq(schema.events.subscriberId, schema.subscribers.id))
        .innerJoin(schema.subscriberLists, eq(schema.subscribers.id, schema.subscriberLists.subscriberId))
        .where(inArray(schema.subscriberLists.listId, listAccess))
        .orderBy(desc(schema.events.createdAt))
        .limit(200)
        .all();

      // Merge and dedupe by event id, sort by createdAt desc
      const seen = new Set<number>();
      const merged = [];
      for (const e of [...campaignEvents, ...subscriberEvents]) {
        if (!seen.has(e.id)) {
          seen.add(e.id);
          merged.push(e);
        }
      }
      merged.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
      recentEvents = merged.slice(0, 200);
    }

    function eventIcon(type: string): string {
      if (type.startsWith("subscriber.")) return "sub";
      if (type.startsWith("campaign.")) return "cam";
      if (type.startsWith("inbound.")) return "in";
      if (type.startsWith("admin.")) return "adm";
      return "?";
    }

    function eventColor(type: string): string {
      if (type.includes("created") || type.includes("added") || type.includes("confirmed")) return "text-green-800";
      if (type.includes("deleted") || type.includes("failed")) return "text-red-800";
      if (type.includes("unsubscribed")) return "text-amber-800";
      if (type.includes("sending") || type.includes("sent") || type.includes("reply_sent")) return "text-blue-800";
      if (type.includes("received")) return "text-purple-800";
      return "text-gray-700";
    }

    function eventLink(e: typeof recentEvents[number]): string | null {
      if (e.subscriberId) return `/admin/subscribers/${e.subscriberId}`;
      if (e.campaignId) return `/admin/campaigns/${e.campaignId}`;
      if (e.messageId) return `/admin/inbound/${e.messageId}`;
      return null;
    }

    function formatEventType(type: string): string {
      return type.replace(/^(admin|subscriber|campaign|inbound)\./, "").replace(/_/g, " ");
    }

    return c.html(
      <AdminLayout title="Activity" user={user}>
        <h1 class="text-2xl font-bold mt-0 mb-4">Activity</h1>
        <div class="flex flex-col gap-1">
          {recentEvents.map((e) => {
            const link = eventLink(e);
            const who = e.userName ?? "System";
            const action = formatEventType(e.type);
            return (
              <div class="flex items-baseline gap-3 py-2 border-b border-gray-100">
                <span class={`text-[0.6875rem] font-semibold uppercase tracking-wide min-w-[2.5rem] ${eventColor(e.type)}`}>
                  {eventIcon(e.type)}
                </span>
                <span class="text-sm font-medium min-w-[8rem]">
                  {who}
                </span>
                <span class="text-sm text-gray-700 min-w-[10rem]">
                  {action}
                </span>
                <span class="text-sm text-gray-600 flex-1">
                  {link ? <a href={link} class="text-blue-600 hover:text-blue-800">{e.detail}</a> : e.detail}
                </span>
                <span class="text-xs text-gray-400 whitespace-nowrap">
                  {fmtDateTime(e.createdAt)}
                </span>
              </div>
            );
          })}
          {recentEvents.length === 0 && <p class="text-gray-400">No events yet.</p>}
        </div>
      </AdminLayout>,
    );
  });
}
