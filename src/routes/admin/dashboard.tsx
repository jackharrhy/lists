import { Hono } from "hono";
import { eq, desc, sql, and, inArray } from "drizzle-orm";
import type { Db } from "../../db";
import { schema } from "../../db";
import type { Config } from "../../config";
import { getAccessibleListIds } from "../../auth";
import { AdminLayout, fmtDate, CampaignBadge, type User } from "./layout";
import { Table, Th, Td } from "./ui";

export function mountDashboardRoutes(app: Hono, db: Db, config: Config) {
  app.get("/", (c) => {
    const user = c.get("user") as User;
    const listAccess = getAccessibleListIds(db, user);
    const isAdmin = user.role === "owner" || user.role === "admin";

    let activeCount: number;
    let listCount: number;
    let campaignCount: number;
    let recentCampaigns: (typeof schema.campaigns.$inferSelect)[];

    if (listAccess === "all") {
      activeCount = db
        .select({ count: sql<number>`count(*)` })
        .from(schema.subscribers)
        .where(eq(schema.subscribers.status, "active"))
        .get()!.count;

      listCount = db
        .select({ count: sql<number>`count(*)` })
        .from(schema.lists)
        .get()!.count;

      campaignCount = db
        .select({ count: sql<number>`count(*)` })
        .from(schema.campaigns)
        .get()!.count;

      recentCampaigns = db
        .select()
        .from(schema.campaigns)
        .orderBy(desc(schema.campaigns.createdAt))
        .limit(5)
        .all();
    } else if (listAccess.length === 0) {
      activeCount = 0;
      listCount = 0;
      campaignCount = 0;
      recentCampaigns = [];
    } else {
      activeCount = db
        .select({ count: sql<number>`count(DISTINCT ${schema.subscribers.id})` })
        .from(schema.subscribers)
        .innerJoin(schema.subscriberLists, eq(schema.subscriberLists.subscriberId, schema.subscribers.id))
        .where(
          and(
            eq(schema.subscribers.status, "active"),
            inArray(schema.subscriberLists.listId, listAccess),
          ),
        )
        .get()!.count;

      listCount = listAccess.length;

      campaignCount = db
        .select({ count: sql<number>`count(*)` })
        .from(schema.campaigns)
        .where(and(eq(schema.campaigns.audienceType, "list"), inArray(schema.campaigns.audienceId, listAccess)))
        .get()!.count;

      recentCampaigns = db
        .select()
        .from(schema.campaigns)
        .where(and(eq(schema.campaigns.audienceType, "list"), inArray(schema.campaigns.audienceId, listAccess)))
        .orderBy(desc(schema.campaigns.createdAt))
        .limit(5)
        .all();
    }

    return c.html(
      <AdminLayout title="Dashboard" user={user}>
        <h1 class="text-2xl font-bold mt-0 mb-4">Dashboard</h1>
        <div class="flex gap-4 mb-6">
          <div class="inline-flex flex-col items-center bg-white border border-gray-200 rounded-lg px-6 py-4 min-w-[120px] text-center">
            <span class="text-3xl font-bold text-blue-600">{activeCount}</span>
            <span class="text-xs text-gray-500 uppercase tracking-wide">Subscribers</span>
          </div>
          <div class="inline-flex flex-col items-center bg-white border border-gray-200 rounded-lg px-6 py-4 min-w-[120px] text-center">
            <span class="text-3xl font-bold text-blue-600">{listCount}</span>
            <span class="text-xs text-gray-500 uppercase tracking-wide">Lists</span>
          </div>
          <div class="inline-flex flex-col items-center bg-white border border-gray-200 rounded-lg px-6 py-4 min-w-[120px] text-center">
            <span class="text-3xl font-bold text-blue-600">{campaignCount}</span>
            <span class="text-xs text-gray-500 uppercase tracking-wide">Campaigns</span>
          </div>
        </div>

        <h2 class="text-xl font-semibold mt-6 mb-3">Recent Campaigns</h2>
        {recentCampaigns.length === 0 ? (
          <p>No campaigns yet.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Subject</Th>
                <Th>Status</Th>
                <Th>Created</Th>
              </tr>
            </thead>
            <tbody>
              {recentCampaigns.map((cam) => (
                <tr>
                  <Td>
                    <a href={`/admin/campaigns/${cam.id}`} class="text-blue-600 hover:text-blue-800">{cam.subject}</a>
                  </Td>
                  <Td>
                    <CampaignBadge status={cam.status} />
                  </Td>
                  <Td>{fmtDate(cam.createdAt)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </AdminLayout>,
    );
  });
}
