import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import { eq, desc, and } from "drizzle-orm";
import type { Config } from "../config";
import type { Db } from "../db";
import { schema } from "../db";
import { logEvent } from "./events";

type SQSPayload = {
  messageId: string;
  rfc822MessageId?: string;
  inReplyTo?: string;
  references?: string[];
  timestamp: string;
  source: string;
  from: string[];
  to: string[];
  subject: string;
  spamVerdict: string;
  virusVerdict: string;
  spfVerdict: string;
  dkimVerdict: string;
  dmarcVerdict: string;
  s3Key?: string;
  action: {
    type: string;
    bucketName: string;
    objectKeyPrefix: string;
    objectKey: string;
  };
};

export async function startPoller(db: Db, config: Config) {
  const sqs = new SQSClient({ region: config.awsRegion });
  const queueUrl = config.sqsQueueUrl;

  console.log(`Polling SQS queue: ${queueUrl}`);

  while (true) {
    try {
      const resp = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 20,
        }),
      );

      if (!resp.Messages) continue;

      for (const msg of resp.Messages) {
        try {
          const payload: SQSPayload = JSON.parse(msg.Body!);
          const s3Key =
            payload.s3Key ||
            payload.action.objectKey ||
            payload.action.objectKeyPrefix + payload.messageId;

          // try to match inbound to a campaign via reply-to address
          // campaign sends use Reply-To: {list.slug}@reply.{domain}
          let campaignId: number | null = null;
          for (const toAddr of payload.to) {
            const match = toAddr.match(/^([^@]+)@reply\./);
            if (!match) continue;
            const slug = match[1];
            const list = db
              .select()
              .from(schema.lists)
              .where(eq(schema.lists.slug, slug!))
              .get();
            if (!list) continue;
            // find the most recent sent campaign for this list
            const campaign = db
              .select()
              .from(schema.campaigns)
              .where(
                and(
                  eq(schema.campaigns.listId, list.id),
                  eq(schema.campaigns.status, "sent"),
                ),
              )
              .orderBy(desc(schema.campaigns.sentAt))
              .get();
            if (campaign) {
              campaignId = campaign.id;
              break;
            }
          }

          // thread linking: check if this is a reply to one of our sent replies
          let parentMessageId: number | null = null;
          const inReplyTo = payload.inReplyTo;
          if (inReplyTo) {
            // strip angle brackets for matching: <abc@ses> -> abc@ses
            const cleanId = inReplyTo.replace(/^<|>$/g, "");
            // check if inReplyTo matches any of our sent replies' SES message ID
            const parentReply = db
              .select({ inboundMessageId: schema.replies.inboundMessageId })
              .from(schema.replies)
              .where(eq(schema.replies.sesMessageId, cleanId))
              .get();
            if (parentReply) {
              parentMessageId = parentReply.inboundMessageId;
            }
          }
          // fallback: check References array
          if (!parentMessageId && payload.references) {
            for (const ref of payload.references) {
              const cleanRef = ref.replace(/^<|>$/g, "");
              const parentReply = db
                .select({ inboundMessageId: schema.replies.inboundMessageId })
                .from(schema.replies)
                .where(eq(schema.replies.sesMessageId, cleanRef))
                .get();
              if (parentReply) {
                parentMessageId = parentReply.inboundMessageId;
                break;
              }
            }
          }

          db.insert(schema.inboundMessages)
            .values({
              messageId: payload.messageId,
              rfc822MessageId: payload.rfc822MessageId ?? null,
              inReplyTo: inReplyTo ?? null,
              parentMessageId,
              timestamp: payload.timestamp,
              source: payload.source,
              fromAddrs: JSON.stringify(payload.from),
              toAddrs: JSON.stringify(payload.to),
              subject: payload.subject,
              spamVerdict: payload.spamVerdict,
              virusVerdict: payload.virusVerdict,
              spfVerdict: payload.spfVerdict,
              dkimVerdict: payload.dkimVerdict,
              dmarcVerdict: payload.dmarcVerdict,
              s3Key,
              campaignId,
            })
            .onConflictDoNothing({
              target: schema.inboundMessages.messageId,
            })
            .run();

          const inserted = db.select().from(schema.inboundMessages).where(eq(schema.inboundMessages.messageId, payload.messageId)).get();

          if (inserted) {
            logEvent(db, {
              type: "inbound.received",
              detail: `Inbound from ${payload.source}: ${payload.subject}`,
              inboundMessageId: inserted.id,
              campaignId: campaignId ?? undefined,
            });
          }

          console.log(
            `Stored inbound message ${payload.messageId} from ${payload.source} (${payload.subject})${campaignId ? ` [campaign ${campaignId}]` : ""}`,
          );

          await sqs.send(
            new DeleteMessageCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: msg.ReceiptHandle,
            }),
          );
        } catch (err) {
          console.error(`Error processing message ${msg.MessageId}:`, err);
        }
      }
    } catch (err) {
      console.error("Error receiving messages from SQS:", err);
      await Bun.sleep(5000);
    }
  }
}
