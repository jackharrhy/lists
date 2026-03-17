import { lte, eq, and } from "drizzle-orm";
import type { Db } from "../db";
import { schema } from "../db";
import type { Config } from "../config";
import { sendCampaign } from "./sender";

export async function startScheduler(db: Db, config: Config) {
  console.log("Scheduler running (checking every 60s)");
  while (true) {
    try {
      const now = new Date().toISOString();
      const dueCampaigns = db
        .select()
        .from(schema.campaigns)
        .where(
          and(
            eq(schema.campaigns.status, "scheduled"),
            lte(schema.campaigns.scheduledAt, now),
          ),
        )
        .all();

      for (const campaign of dueCampaigns) {
        console.log(`Scheduler: firing campaign ${campaign.id} "${campaign.subject}"`);
        try {
          await sendCampaign(db, config, campaign.id);
        } catch (err) {
          console.error(`Scheduler: campaign ${campaign.id} failed:`, err);
        }
      }
    } catch (err) {
      console.error("Scheduler error:", err);
    }
    await Bun.sleep(60_000);
  }
}
