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

function buildRawEmail({
  from,
  to,
  subject,
  html,
  headers,
}: {
  from: string;
  to: string;
  subject: string;
  html: string;
  headers: Record<string, string>;
}): string {
  const boundary = `----=_Part_${Date.now().toString(36)}`;

  const headerLines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
  ];

  for (const [key, value] of Object.entries(headers)) {
    headerLines.push(`${key}: ${value}`);
  }

  headerLines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);

  const body = [
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
  const campaign = db.select().from(schema.campaigns).where(and(
    eq(schema.campaigns.id, campaignId),
    eq(schema.campaigns.status, "draft"),
  )).get();
  if (!campaign) throw new Error(`Campaign ${campaignId} not found or not draft`);

  const list = db.select().from(schema.lists).where(eq(schema.lists.id, campaign.listId)).get();
  if (!list) throw new Error(`List ${campaign.listId} not found`);

  db.update(schema.campaigns)
    .set({ status: "sending" })
    .where(eq(schema.campaigns.id, campaignId))
    .run();

  const subscribers = getConfirmedSubscribers(db, list.id);

  const contentHtml = await marked(campaign.bodyMarkdown);

  const ses = new SESv2Client({ region: config.awsRegion });

  for (const subscriber of subscribers) {
    const unsubscribeUrl = buildUnsubscribeUrl(
      config.baseUrl,
      subscriber.unsubscribeToken,
    );
    const preferencesUrl = buildPreferencesUrl(
      config.baseUrl,
      subscriber.unsubscribeToken,
    );
    const listUnsubHeaders = buildListUnsubscribeHeader(unsubscribeUrl);

    const { html } = await renderNewsletter({
      subject: campaign.subject,
      contentHtml,
      listName: list.name,
      unsubscribeUrl,
      preferencesUrl,
    });

    const replyTo = `${list.slug}@reply.${config.fromDomain}`;

    const rawEmail = buildRawEmail({
      from: campaign.fromAddress,
      to: subscriber.email,
      subject: campaign.subject,
      html,
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
      db.insert(schema.campaignSends)
        .values({
          campaignId,
          subscriberId: subscriber.id,
          status: "bounced",
          sentAt: new Date().toISOString(),
        })
        .run();
    }
  }

  db.update(schema.campaigns)
    .set({ status: "sent", sentAt: new Date().toISOString() })
    .where(eq(schema.campaigns.id, campaignId))
    .run();
}
