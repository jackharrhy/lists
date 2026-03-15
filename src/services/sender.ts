import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { eq, and } from "drizzle-orm";
import { marked } from "marked";
import type { Config } from "../config";
import { type Db, schema } from "../db";
import { getConfirmedSubscribers } from "./subscriber";
import {
  buildUnsubscribeUrl,
  buildPreferencesUrl,
  buildListUnsubscribeHeader,
} from "../compliance";
import { renderNewsletter } from "../../emails/render";
import { logEvent } from "./events";

function buildRawEmail({
  from,
  to,
  subject,
  html,
  text,
  fromDomain,
  headers,
}: {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  fromDomain: string;
  headers: Record<string, string>;
}): string {
  const boundary = `----=_Part_${Date.now().toString(36)}`;
  const messageId = `<${crypto.randomUUID()}@${fromDomain}>`;

  const headerLines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Message-ID: ${messageId}`,
    `Date: ${new Date().toUTCString()}`,
  ];

  for (const [key, value] of Object.entries(headers)) {
    headerLines.push(`${key}: ${value}`);
  }

  headerLines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);

  const body = [
    `--${boundary}`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    text,
    `--${boundary}`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    html,
    `--${boundary}--`,
  ].join("\r\n");

  return headerLines.join("\r\n") + "\r\n\r\n" + body;
}

export async function sendCampaign(
  db: Db,
  config: Config,
  campaignId: number,
) {
  const campaign = db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId)).get();
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);
  if (campaign.status !== "draft" && campaign.status !== "failed") {
    throw new Error(`Campaign ${campaignId} is ${campaign.status}, must be draft or failed to send`);
  }

  const list = db.select().from(schema.lists).where(eq(schema.lists.id, campaign.listId)).get();
  if (!list) throw new Error(`List ${campaign.listId} not found`);

  db.update(schema.campaigns)
    .set({ status: "sending", lastError: null })
    .where(eq(schema.campaigns.id, campaignId))
    .run();

  logEvent(db, {
    type: "campaign.sending",
    detail: `Campaign "${campaign.subject}" started sending`,
    campaignId,
  });

  try {
    const subscribers = getConfirmedSubscribers(db, list.id);
    const contentHtml = await marked(campaign.bodyMarkdown);
    const ses = new SESv2Client({ region: config.awsRegion });

    // figure out which subscribers already got this (for retries)
    const alreadySent = new Set(
      db.select({ subscriberId: schema.campaignSends.subscriberId })
        .from(schema.campaignSends)
        .where(and(
          eq(schema.campaignSends.campaignId, campaignId),
          eq(schema.campaignSends.status, "sent"),
        ))
        .all()
        .map((r) => r.subscriberId),
    );

    for (const subscriber of subscribers) {
      if (alreadySent.has(subscriber.id)) continue;

      const unsubscribeUrl = buildUnsubscribeUrl(
        config.baseUrl,
        subscriber.unsubscribeToken,
      );
      const preferencesUrl = buildPreferencesUrl(
        config.baseUrl,
        subscriber.unsubscribeToken,
      );
      const listUnsubHeaders = buildListUnsubscribeHeader(unsubscribeUrl);

      const { html, text } = await renderNewsletter({
        subject: campaign.subject,
        contentHtml,
        listName: list.name,
        unsubscribeUrl,
        preferencesUrl,
      });

      const replyTo = `${list.slug}@reply.${list.fromDomain}`;
      const fromWithName = `"${list.name}" <${campaign.fromAddress}>`;

      const rawEmail = buildRawEmail({
        from: fromWithName,
        to: subscriber.email,
        subject: campaign.subject,
        html,
        text,
        fromDomain: config.fromDomain,
        headers: {
          ...listUnsubHeaders,
          "Reply-To": replyTo,
        },
      });

      try {
        const result = await ses.send(
          new SendEmailCommand({
            Content: {
              Raw: {
                Data: new TextEncoder().encode(rawEmail),
              },
            },
            ConfigurationSetName: config.sesConfigSet || undefined,
          }),
        );

        db.insert(schema.campaignSends)
          .values({
            campaignId,
            subscriberId: subscriber.id,
            sesMessageId: result.MessageId ?? null,
            status: "sent",
            sentAt: new Date().toISOString(),
          })
          .run();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        db.insert(schema.campaignSends)
          .values({
            campaignId,
            subscriberId: subscriber.id,
            status: "bounced",
            sentAt: new Date().toISOString(),
          })
          .run();
        console.error(`Failed to send to ${subscriber.email}: ${msg}`);
      }
    }

    db.update(schema.campaigns)
      .set({ status: "sent", sentAt: new Date().toISOString() })
      .where(eq(schema.campaigns.id, campaignId))
      .run();

    logEvent(db, {
      type: "campaign.sent",
      detail: `Campaign "${campaign.subject}" sent`,
      meta: { subscriberCount: subscribers.length },
      campaignId,
    });
  } catch (err) {
    const msg = err instanceof Error
      ? `${err.message}\n${err.stack ?? ""}`
      : String(err);
    console.error(`Campaign ${campaignId} failed: ${msg}`);
    db.update(schema.campaigns)
      .set({ status: "failed", lastError: msg })
      .where(eq(schema.campaigns.id, campaignId))
      .run();

    logEvent(db, {
      type: "campaign.failed",
      detail: `Campaign "${campaign.subject}" failed: ${msg}`,
      campaignId,
    });

    throw err;
  }
}
