import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import { eq } from "drizzle-orm";
import type { Config } from "../config";
import type { Db } from "../db";
import { schema } from "../db";

type SQSPayload = {
  messageId: string;
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
            payload.action.objectKey ||
            payload.action.objectKeyPrefix + payload.messageId;

          await db
            .insert(schema.inboundMessages)
            .values({
              messageId: payload.messageId,
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
            })
            .onConflictDoNothing({
              target: schema.inboundMessages.messageId,
            });

          console.log(
            `Stored inbound message ${payload.messageId} from ${payload.source} (${payload.subject})`,
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
