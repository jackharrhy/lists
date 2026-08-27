import { Html } from "@elysia/html";
import type { App } from "../../http";
import { eq, desc, sql, and, inArray } from "drizzle-orm";
import type { Db } from "../../db";
import { schema } from "../../db";
import type { Config } from "../../config";
import { getAccessibleListIds } from "../../auth";
import { AdminLayout, fmtDate, CampaignBadge, type User } from "./layout";
import { Table, Th, Td, PageHeader } from "./ui";

export function mountDashboardRoutes(app: App, db: Db, config: Config) {
  app.get("/", (c) => {
    const user = c.user as User;
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
        <PageHeader title="Dashboard">
          <span class="hidden sm:inline text-sm text-gray-500">Your mailing operation at a glance</span>
        </PageHeader>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-9">
          <div class="stat-card flex flex-col">
            <span class="text-3xl font-bold tracking-tight text-gray-950">{activeCount}</span>
            <span class="text-[0.68rem] font-bold text-gray-500 uppercase tracking-[0.12em] mt-1">Subscribers</span>
          </div>
          <div class="stat-card flex flex-col">
            <span class="text-3xl font-bold tracking-tight text-gray-950">{listCount}</span>
            <span class="text-[0.68rem] font-bold text-gray-500 uppercase tracking-[0.12em] mt-1">Lists</span>
          </div>
          <div class="stat-card flex flex-col">
            <span class="text-3xl font-bold tracking-tight text-gray-950">{campaignCount}</span>
            <span class="text-[0.68rem] font-bold text-gray-500 uppercase tracking-[0.12em] mt-1">Campaigns</span>
          </div>
        </div>

        <div class="flex items-end justify-between mb-3"><div><p class="text-[0.68rem] font-bold uppercase tracking-[0.14em] text-gray-400 mb-1">Latest work</p><h2 class="text-xl font-bold tracking-tight m-0">Recent campaigns</h2></div><a href="/admin/campaigns" class="text-sm font-semibold text-blue-600 no-underline hover:text-blue-800">View all →</a></div>
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
