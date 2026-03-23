import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { eq, and, inArray } from "drizzle-orm";
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

/** Get all active, confirmed subscribers (deduplicated by email) for campaigns with no specific list. */
function getAllActiveConfirmedSubscribers(db: Db) {
  return db
    .selectDistinct({
      id: schema.subscribers.id,
      email: schema.subscribers.email,
      firstName: schema.subscribers.firstName,
      lastName: schema.subscribers.lastName,
      unsubscribeToken: schema.subscribers.unsubscribeToken,
    })
    .from(schema.subscribers)
    .innerJoin(schema.subscriberLists, eq(schema.subscriberLists.subscriberId, schema.subscribers.id))
    .where(
      and(
        eq(schema.subscribers.status, "active"),
        eq(schema.subscriberLists.status, "confirmed"),
      ),
    )
    .all();
}

function getSubscribersByTag(db: Db, tagId: number) {
  return db
    .selectDistinct({
      id: schema.subscribers.id,
      email: schema.subscribers.email,
      firstName: schema.subscribers.firstName,
      lastName: schema.subscribers.lastName,
      unsubscribeToken: schema.subscribers.unsubscribeToken,
    })
    .from(schema.subscribers)
    .innerJoin(schema.subscriberTags, eq(schema.subscriberTags.subscriberId, schema.subscribers.id))
    .innerJoin(schema.subscriberLists, eq(schema.subscriberLists.subscriberId, schema.subscribers.id))
    .where(
      and(
        eq(schema.subscriberTags.tagId, tagId),
        eq(schema.subscribers.status, "active"),
        eq(schema.subscriberLists.status, "confirmed"),
      ),
    )
    .all();
}

function getSubscribersByIds(db: Db, ids: number[]) {
  return db
    .selectDistinct({
      id: schema.subscribers.id,
      email: schema.subscribers.email,
      firstName: schema.subscribers.firstName,
      lastName: schema.subscribers.lastName,
      unsubscribeToken: schema.subscribers.unsubscribeToken,
    })
    .from(schema.subscribers)
    .innerJoin(schema.subscriberLists, eq(schema.subscriberLists.subscriberId, schema.subscribers.id))
    .where(
      and(
        inArray(schema.subscribers.id, ids),
        eq(schema.subscribers.status, "active"),
        eq(schema.subscriberLists.status, "confirmed"),
      ),
    )
    .all();
}

export function substituteVariables(
  template: string,
  subscriber: { firstName?: string | null; lastName?: string | null; email: string },
  urls: { unsubscribeUrl: string; preferencesUrl: string },
): string {
  return template
    .replace(/\{\{firstName\}\}/g, subscriber.firstName || "")
    .replace(/\{\{lastName\}\}/g, subscriber.lastName || "")
    .replace(/\{\{email\}\}/g, subscriber.email)
    .replace(/\{\{unsubscribeUrl\}\}/g, urls.unsubscribeUrl)
    .replace(/\{\{preferencesUrl\}\}/g, urls.preferencesUrl);
}

type InlineAttachment = {
  cid: string;
  contentType: string;
  base64Data: string;
};

/** Extract data:image URIs from HTML, replace with cid: references, return attachments */
export function extractInlineImages(html: string): { html: string; attachments: InlineAttachment[] } {
  const attachments: InlineAttachment[] = [];
  const processed = html.replace(/src="data:(image\/[^;]+);base64,([^"]+)"/g, (_match, mimeType, base64Data) => {
    const cid = `img-${crypto.randomUUID().replace(/-/g, "")}@lists`;
    attachments.push({ cid, contentType: mimeType, base64Data });
    return `src="cid:${cid}"`;
  });
  return { html: processed, attachments };
}

export function buildRawEmail({
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
}): { raw: string; messageId: string } {
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

  // Extract any embedded data: URIs and convert to CID attachments
  const { html: processedHtml, attachments } = extractInlineImages(html);
  const hasAttachments = attachments.length > 0;

  if (!hasAttachments) {
    // Simple multipart/alternative (plain text + html)
    const boundary = `----=_Part_${Date.now().toString(36)}`;
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
      processedHtml,
      `--${boundary}--`,
    ].join("\r\n");
    return { raw: headerLines.join("\r\n") + "\r\n\r\n" + body, messageId };
  }

  // multipart/related wrapping multipart/alternative + inline image attachments
  const outerBoundary = `----=_Outer_${Date.now().toString(36)}`;
  const innerBoundary = `----=_Inner_${Date.now().toString(36)}`;

  headerLines.push(`Content-Type: multipart/related; boundary="${outerBoundary}"; type="multipart/alternative"`);

  const parts: string[] = [];

  // Inner multipart/alternative (plain + html)
  parts.push(
    `--${outerBoundary}`,
    `Content-Type: multipart/alternative; boundary="${innerBoundary}"`,
    ``,
    `--${innerBoundary}`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    text,
    `--${innerBoundary}`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    processedHtml,
    `--${innerBoundary}--`,
  );

  // Inline image attachments
  for (const att of attachments) {
    parts.push(
      `--${outerBoundary}`,
      `Content-Type: ${att.contentType}`,
      `Content-Transfer-Encoding: base64`,
      `Content-ID: <${att.cid}>`,
      `Content-Disposition: inline`,
      ``,
      // Wrap base64 at 76 chars per RFC 2045
      att.base64Data.match(/.{1,76}/g)!.join("\r\n"),
    );
  }

  parts.push(`--${outerBoundary}--`);

  return {
    raw: headerLines.join("\r\n") + "\r\n\r\n" + parts.join("\r\n"),
    messageId,
  };
}

export async function sendCampaign(
  db: Db,
  config: Config,
  campaignId: number,
) {
  const campaign = db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId)).get();
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);
  if (!["draft", "failed", "scheduled"].includes(campaign.status)) {
    throw new Error(`Campaign ${campaignId} is ${campaign.status}, must be draft, failed, or scheduled`);
  }

  // Resolve list when audienceType is "list"
  const list = campaign.audienceType === "list" && campaign.audienceId
    ? db.select().from(schema.lists).where(eq(schema.lists.id, campaign.audienceId)).get()
    : null;
  if (campaign.audienceType === "list" && !list) {
    throw new Error(`List ${campaign.audienceId} not found for campaign ${campaignId}`);
  }

  db.update(schema.campaigns)
    .set({ status: "sending", lastError: null })
    .where(eq(schema.campaigns.id, campaignId))
    .run();

  logEvent(db, {
    type: "campaign.sending",
    detail: `Campaign "${campaign.subject}" started sending`,
    campaignId,
  });

  const isBatched = !!campaign.batchSize;

  try {
    let subscribers: { id: number; email: string; firstName: string | null; lastName: string | null; unsubscribeToken: string }[];

    switch (campaign.audienceType) {
      case "list":
        subscribers = getConfirmedSubscribers(db, campaign.audienceId!);
        break;
      case "tag":
        if (!campaign.audienceId) throw new Error("Tag audience requires audienceId");
        subscribers = getSubscribersByTag(db, campaign.audienceId);
        break;
      case "subscribers": {
        if (!campaign.audienceData) throw new Error("Subscribers audience requires audienceData");
        const ids = JSON.parse(campaign.audienceData) as number[];
        subscribers = getSubscribersByIds(db, ids);
        break;
      }
      case "all":
        subscribers = getAllActiveConfirmedSubscribers(db);
        break;
      default:
        throw new Error(`Unknown audience type: ${campaign.audienceType}`);
    }

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

    // For batched campaigns, limit to the next N unsent subscribers
    if (isBatched && campaign.batchSize) {
      subscribers = subscribers.filter((s) => !alreadySent.has(s.id)).slice(0, campaign.batchSize);
    }

    // Derive per-campaign values depending on whether there's a list
    const emailFromDomain = list
      ? list.fromDomain
      : (campaign.fromAddress.split("@")[1] ?? config.fromDomain);
    const fromLocalPart = campaign.fromAddress.split("@")[0] ?? "noreply";
    const listName = list ? list.name : (campaign.fromName ?? fromLocalPart);
    const replyTo = list
      ? `${list.slug}@reply.${list.fromDomain}`
      : `${fromLocalPart}@reply.${emailFromDomain}`;
    // Display name: explicit fromName > list name > local part of fromAddress
    const displayName = campaign.fromName ?? list?.name ?? fromLocalPart;
    const fromWithName = `"${displayName}" <${campaign.fromAddress}>`;

    for (const subscriber of subscribers) {
      if (alreadySent.has(subscriber.id)) continue;

      const unsubscribeUrl = list
        ? buildUnsubscribeUrl(config.baseUrl, subscriber.unsubscribeToken, list.id)
        : buildUnsubscribeUrl(config.baseUrl, subscriber.unsubscribeToken);
      const preferencesUrl = buildPreferencesUrl(
        config.baseUrl,
        subscriber.unsubscribeToken,
      );
      const listUnsubHeaders = buildListUnsubscribeHeader(unsubscribeUrl);

      const substitutedMarkdown = substituteVariables(
        campaign.bodyMarkdown,
        subscriber,
        { unsubscribeUrl, preferencesUrl },
      );
      const contentHtml = await marked(substitutedMarkdown);

      const { html, text } = await renderNewsletter({
        subject: campaign.subject,
        contentHtml,
        listName,
        unsubscribeUrl,
        preferencesUrl,
      });

      const { raw: rawEmail, messageId: rfc822MessageId } = buildRawEmail({
        from: fromWithName,
        to: subscriber.email,
        subject: campaign.subject,
        html,
        text,
        fromDomain: emailFromDomain,
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
            rfc822MessageId,
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
            rfc822MessageId,
            status: "bounced",
            sentAt: new Date().toISOString(),
          })
          .run();
        console.error(`Failed to send to ${subscriber.email}: ${msg}`);
      }
    }

    // For batched campaigns, check if there are more unsent subscribers remaining
    if (isBatched) {
      const sentSoFar = new Set(
        db.select({ subscriberId: schema.campaignSends.subscriberId })
          .from(schema.campaignSends)
          .where(and(
            eq(schema.campaignSends.campaignId, campaignId),
            eq(schema.campaignSends.status, "sent"),
          ))
          .all()
          .map((r) => r.subscriberId),
      );

      // Re-resolve audience to check for remaining unsent
      let allAudienceIds: number[];
      switch (campaign.audienceType) {
        case "list":
          allAudienceIds = getConfirmedSubscribers(db, campaign.audienceId!).map((s) => s.id);
          break;
        case "tag":
          allAudienceIds = getSubscribersByTag(db, campaign.audienceId!).map((s) => s.id);
          break;
        case "subscribers": {
          const ids = JSON.parse(campaign.audienceData!) as number[];
          allAudienceIds = getSubscribersByIds(db, ids).map((s) => s.id);
          break;
        }
        case "all":
          allAudienceIds = getAllActiveConfirmedSubscribers(db).map((s) => s.id);
          break;
        default:
          allAudienceIds = [];
      }

      const remainingCount = allAudienceIds.filter((id) => !sentSoFar.has(id)).length;

      if (remainingCount > 0) {
        const nextAt = new Date(Date.now() + (campaign.batchInterval ?? 10) * 60 * 1000).toISOString();
        db.update(schema.campaigns)
          .set({ status: "scheduled", scheduledAt: nextAt })
          .where(eq(schema.campaigns.id, campaignId))
          .run();
        console.log(`Campaign ${campaignId}: sent batch, ${remainingCount} remaining, next at ${nextAt}`);
        return; // don't fall through to mark as "sent"
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
