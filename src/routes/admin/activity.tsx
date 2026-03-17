import { Hono } from "hono";
import { eq, desc, and, inArray, like, sql } from "drizzle-orm";
import type { Db } from "../../db";
import { schema } from "../../db";
import type { Config } from "../../config";
import { getAccessibleListIds } from "../../auth";
import { AdminLayout, fmtDateTime, type User } from "./layout";

const PAGE_SIZE = 50;

const EVENT_GROUPS = [
  { value: "subscriber", label: "Subscribers" },
  { value: "campaign", label: "Campaigns" },
  { value: "inbound", label: "Inbound" },
  { value: "admin", label: "Admin" },
];

export function mountActivityRoutes(app: Hono, db: Db, _config: Config) {
  app.get("/activity", (c) => {
    const user = c.get("user") as User;
    const listAccess = getAccessibleListIds(db, user);

    // Query params
    const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10) || 1);
    const offset = (page - 1) * PAGE_SIZE;
    const filterGroup = c.req.query("group") ?? "";
    const filterSubscriber = c.req.query("subscriber") ?? "";
    const filterCampaign = c.req.query("campaign") ?? "";

    // Base select
    const baseSelect = {
      id: schema.events.id,
      type: schema.events.type,
      detail: schema.events.detail,
      userId: schema.events.userId,
      subscriberId: schema.events.subscriberId,
      campaignId: schema.events.campaignId,
      messageId: schema.events.messageId,
      createdAt: schema.events.createdAt,
      userName: schema.users.name,
    };

    // Build where conditions
    const conditions = [];
    if (filterGroup) {
      conditions.push(like(schema.events.type, `${filterGroup}.%`));
    }
    if (filterSubscriber) {
      const subId = parseInt(filterSubscriber, 10);
      if (!isNaN(subId)) conditions.push(eq(schema.events.subscriberId, subId));
    }
    if (filterCampaign) {
      const camId = parseInt(filterCampaign, 10);
      if (!isNaN(camId)) conditions.push(eq(schema.events.campaignId, camId));
    }

    // Apply member access scoping
    let events: typeof schema.events.$inferSelect[] & { userName: string | null }[];

    if (listAccess === "all") {
      const q = db
        .select(baseSelect)
        .from(schema.events)
        .leftJoin(schema.users, eq(schema.events.userId, schema.users.id))
        .orderBy(desc(schema.events.createdAt));

      events = (conditions.length > 0 ? q.where(and(...conditions)) : q)
        .limit(PAGE_SIZE + 1)
        .offset(offset)
        .all() as any;
    } else if (listAccess.length === 0) {
      events = [];
    } else {
      // Members: filter to campaign + subscriber events on their lists
      const campaignIds = db
        .select({ id: schema.campaigns.id })
        .from(schema.campaigns)
        .where(and(eq(schema.campaigns.audienceType, "list"), inArray(schema.campaigns.audienceId, listAccess)))
        .all()
        .map((r) => r.id);

      const subscriberIds = db
        .selectDistinct({ id: schema.subscribers.id })
        .from(schema.subscribers)
        .innerJoin(schema.subscriberLists, eq(schema.subscribers.id, schema.subscriberLists.subscriberId))
        .where(inArray(schema.subscriberLists.listId, listAccess))
        .all()
        .map((r) => r.id);

      const accessConditions = [];
      if (campaignIds.length > 0) accessConditions.push(inArray(schema.events.campaignId, campaignIds));
      if (subscriberIds.length > 0) accessConditions.push(inArray(schema.events.subscriberId, subscriberIds));
      if (accessConditions.length === 0) { events = []; return; }

      const memberConditions = [...conditions, sql`(${accessConditions.map(() => "?").join(" OR ")})`];
      // simplified: just union
      const q = db
        .select(baseSelect)
        .from(schema.events)
        .leftJoin(schema.users, eq(schema.events.userId, schema.users.id))
        .where(and(
          ...conditions,
          sql`(${schema.events.campaignId} IN ${campaignIds.length ? campaignIds : [-1]} OR ${schema.events.subscriberId} IN ${subscriberIds.length ? subscriberIds : [-1]})`,
        ))
        .orderBy(desc(schema.events.createdAt))
        .limit(PAGE_SIZE + 1)
        .offset(offset);

      events = q.all() as any;
    }

    const hasMore = events.length > PAGE_SIZE;
    if (hasMore) events = events.slice(0, PAGE_SIZE);

    // Get subscriber/campaign lists for filter dropdowns
    const allSubscribers = listAccess === "all"
      ? db.select({ id: schema.subscribers.id, email: schema.subscribers.email, firstName: schema.subscribers.firstName, lastName: schema.subscribers.lastName }).from(schema.subscribers).orderBy(schema.subscribers.email).all()
      : [];
    const allCampaigns = listAccess === "all"
      ? db.select({ id: schema.campaigns.id, subject: schema.campaigns.subject }).from(schema.campaigns).orderBy(desc(schema.campaigns.createdAt)).limit(50).all()
      : [];

    function eventIcon(type: string): string {
      if (type.startsWith("subscriber.")) return "sub";
      if (type.startsWith("campaign.")) return "cam";
      if (type.startsWith("inbound.")) return "in";
      if (type.startsWith("admin.")) return "adm";
      return "?";
    }

    function eventColor(type: string): string {
      if (type.includes("created") || type.includes("added") || type.includes("confirmed")) return "text-green-700";
      if (type.includes("deleted") || type.includes("failed") || type.includes("bounced") || type.includes("complained")) return "text-red-700";
      if (type.includes("unsubscribed")) return "text-amber-700";
      if (type.includes("sending") || type.includes("sent") || type.includes("reply_sent")) return "text-blue-700";
      if (type.includes("received")) return "text-purple-700";
      return "text-gray-600";
    }

    function eventLink(e: (typeof events)[number]): string | null {
      if (e.subscriberId) return `/admin/subscribers/${e.subscriberId}`;
      if (e.campaignId) return `/admin/campaigns/${e.campaignId}`;
      if (e.messageId) return `/admin/inbound/${e.messageId}`;
      return null;
    }

    function formatEventType(type: string): string {
      return type.replace(/^(admin|subscriber|campaign|inbound)\./, "").replace(/_/g, " ");
    }

    function buildUrl(params: Record<string, string | number>) {
      const q = new URLSearchParams({
        ...(filterGroup ? { group: filterGroup } : {}),
        ...(filterSubscriber ? { subscriber: filterSubscriber } : {}),
        ...(filterCampaign ? { campaign: filterCampaign } : {}),
        page: String(page),
        ...params,
      });
      return `/admin/activity?${q.toString()}`;
    }

    return c.html(
      <AdminLayout title="Activity" user={user}>
        <div class="flex items-center justify-between mb-4">
          <h1 class="text-2xl font-bold mt-0 mb-0">Activity</h1>
          <span class="text-xs text-gray-400">Page {page}</span>
        </div>

        {/* Filters */}
        <form method="get" action="/admin/activity" class="flex items-end gap-3 mb-6 flex-wrap">
          <div>
            <label class="block text-xs font-medium text-gray-500 mb-1">Type</label>
            <select name="group" class="px-2 py-1.5 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="" selected={!filterGroup}>All</option>
              {EVENT_GROUPS.map((g) => (
                <option value={g.value} selected={filterGroup === g.value}>{g.label}</option>
              ))}
            </select>
          </div>
          {allSubscribers.length > 0 && (
            <div>
              <label class="block text-xs font-medium text-gray-500 mb-1">Subscriber</label>
              <select name="subscriber" class="px-2 py-1.5 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="" selected={!filterSubscriber}>All</option>
                {allSubscribers.map((s) => (
                  <option value={String(s.id)} selected={filterSubscriber === String(s.id)}>
                    {s.email}
                  </option>
                ))}
              </select>
            </div>
          )}
          {allCampaigns.length > 0 && (
            <div>
              <label class="block text-xs font-medium text-gray-500 mb-1">Campaign</label>
              <select name="campaign" class="px-2 py-1.5 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="" selected={!filterCampaign}>All</option>
                {allCampaigns.map((cam) => (
                  <option value={String(cam.id)} selected={filterCampaign === String(cam.id)}>
                    {cam.subject.slice(0, 40)}
                  </option>
                ))}
              </select>
            </div>
          )}
          <input type="hidden" name="page" value="1" />
          <button type="submit" class="px-3 py-1.5 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700 border-none cursor-pointer">Filter</button>
          {(filterGroup || filterSubscriber || filterCampaign) && (
            <a href="/admin/activity" class="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700 no-underline">Clear</a>
          )}
        </form>

        {/* Event feed */}
        <div class="flex flex-col">
          {events.map((e) => {
            const link = eventLink(e);
            const who = e.userName ?? "System";
            const action = formatEventType(e.type);
            return (
              <div class="flex items-baseline gap-3 py-2 border-b border-gray-100 last:border-0">
                <span class={`text-[0.6875rem] font-semibold uppercase tracking-wide min-w-[2.5rem] ${eventColor(e.type)}`}>
                  {eventIcon(e.type)}
                </span>
                <span class="text-sm font-medium text-gray-700 min-w-[7rem] truncate">
                  {who}
                </span>
                <span class="text-sm text-gray-500 min-w-[9rem]">
                  {action}
                </span>
                <span class="text-sm text-gray-700 flex-1 truncate">
                  {link ? <a href={link} class="text-blue-600 hover:text-blue-800">{e.detail}</a> : e.detail}
                </span>
                <span class="text-xs text-gray-400 whitespace-nowrap">
                  {fmtDateTime(e.createdAt)}
                </span>
              </div>
            );
          })}
          {events.length === 0 && <p class="text-gray-400 text-sm py-4">No events match the current filters.</p>}
        </div>

        {/* Pagination */}
        {(page > 1 || hasMore) && (
          <div class="flex items-center justify-between mt-6 pt-4 border-t border-gray-100">
            <div>
              {page > 1 && (
                <a href={buildUrl({ page: page - 1 })} class="px-3 py-1.5 text-sm text-blue-600 hover:text-blue-800 no-underline border border-blue-200 rounded hover:bg-blue-50">
                  ← Previous
                </a>
              )}
            </div>
            <span class="text-xs text-gray-400">Showing {PAGE_SIZE * (page - 1) + 1}–{PAGE_SIZE * (page - 1) + events.length}</span>
            <div>
              {hasMore && (
                <a href={buildUrl({ page: page + 1 })} class="px-3 py-1.5 text-sm text-blue-600 hover:text-blue-800 no-underline border border-blue-200 rounded hover:bg-blue-50">
                  Next →
                </a>
              )}
            </div>
          </div>
        )}
      </AdminLayout>,
    );
  });
}
