import { and, eq, lte } from "drizzle-orm";
import type { Config } from "../config";
import type { Db } from "../db";
import { schema } from "../db";
import { sendCampaign } from "./sender";

export async function processDueDeliveries(db: Db, config: Config) {
  const due = db.selectDistinct({ campaignId: schema.campaignSends.campaignId })
    .from(schema.campaignSends)
    .where(and(
      eq(schema.campaignSends.status, "deferred"),
      lte(schema.campaignSends.nextAttemptAt, new Date().toISOString()),
    )).all();

  for (const { campaignId } of due) {
    try {
      await sendCampaign(db, config, campaignId);
    } catch (error) {
      console.error(`Delivery retry failed for campaign ${campaignId}:`, error);
    }
  }
}

export async function startDeliveryWorker(db: Db, config: Config) {
  console.log("Delivery worker running (checking every 15s)");
  while (true) {
    await processDueDeliveries(db, config);
    await Bun.sleep(15_000);
  }
}
