import { and, eq, inArray, lte } from "drizzle-orm";
import type { Config } from "../config";
import type { Db } from "../db";
import { schema } from "../db";
import { sendCampaign } from "./sender";

const ABANDONED_ATTEMPT_MS = 15 * 60_000;

export function rescheduleInterruptedCampaigns(db: Db, now = new Date()) {
  const interrupted = db
    .select({ id: schema.campaigns.id })
    .from(schema.campaigns)
    .where(eq(schema.campaigns.status, "sending"))
    .all();
  if (interrupted.length === 0) return 0;
  db.update(schema.campaigns)
    .set({
      status: "scheduled",
      scheduledAt: new Date(now.getTime() + ABANDONED_ATTEMPT_MS).toISOString(),
      lastError: "Sending was interrupted by an application restart; queued to resume",
    })
    .where(eq(schema.campaigns.status, "sending"))
    .run();
  return interrupted.length;
}

export function recoverAbandonedDeliveries(db: Db, now = new Date()) {
  const cutoff = new Date(now.getTime() - ABANDONED_ATTEMPT_MS).toISOString();
  const abandoned = db
    .select({ id: schema.campaignSends.id })
    .from(schema.campaignSends)
    .where(
      and(inArray(schema.campaignSends.status, ["pending", "attempting"]), lte(schema.campaignSends.updatedAt, cutoff)),
    )
    .all();
  db.update(schema.campaignSends)
    .set({
      status: "deferred",
      nextAttemptAt: now.toISOString(),
      lastError: "Previous delivery attempt was interrupted; queued for retry",
      updatedAt: now.toISOString(),
    })
    .where(
      and(inArray(schema.campaignSends.status, ["pending", "attempting"]), lte(schema.campaignSends.updatedAt, cutoff)),
    )
    .run();
  return abandoned.length;
}

export async function processDueDeliveries(db: Db, config: Config) {
  const recovered = recoverAbandonedDeliveries(db);
  if (recovered > 0) console.warn(`Recovered ${recovered} interrupted delivery attempt(s)`);

  const due = db
    .selectDistinct({ campaignId: schema.campaignSends.campaignId })
    .from(schema.campaignSends)
    .where(
      and(
        eq(schema.campaignSends.status, "deferred"),
        lte(schema.campaignSends.nextAttemptAt, new Date().toISOString()),
      ),
    )
    .all();

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
