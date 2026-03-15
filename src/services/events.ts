import type { Db } from "../db";
import { schema } from "../db";

type LogEventOpts = {
  type: string;
  detail: string;
  meta?: Record<string, unknown>;
  subscriberId?: number;
  campaignId?: number;
  inboundMessageId?: number;
};

export function logEvent(db: Db, opts: LogEventOpts) {
  db.insert(schema.events)
    .values({
      type: opts.type,
      detail: opts.detail,
      meta: opts.meta ? JSON.stringify(opts.meta) : null,
      subscriberId: opts.subscriberId ?? null,
      campaignId: opts.campaignId ?? null,
      inboundMessageId: opts.inboundMessageId ?? null,
    })
    .run();
}
