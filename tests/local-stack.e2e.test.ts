import { expect, test } from "bun:test";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

const localTest = process.env.LOCAL_E2E === "1" ? test : test.skip;
const appUrl = process.env.LOCAL_APP_URL ?? "http://localhost:8080";
const motoUrl = process.env.LOCAL_MOTO_URL ?? "http://localhost:5000";
const mailpitUrl = process.env.LOCAL_MAILPIT_URL ?? "http://localhost:8025";
const credentials = { accessKeyId: "test", secretAccessKey: "test" };

async function eventually<T>(read: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(500);
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms`);
}

async function login() {
  const response = await fetch(`${appUrl}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "owner@lists.local", password: "local-password" }),
  });
  expect(response.status).toBe(302);
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

localTest("compose stack captures outbound mail and processes inbound S3/SQS mail", async () => {
  const run = crypto.randomUUID().slice(0, 8);
  const slug = `e2e-${run}`;
  const recipient = `${slug}@example.test`;
  const cookie = await login();

  const createList = await fetch(`${appUrl}/admin/lists/new`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      slug,
      name: `E2E ${run}`,
      description: "Local stack test list",
      fromDomain: "lists.local",
      fromAddress: "news@lists.local",
    }),
  });
  expect(createList.status).toBe(302);

  const subscribe = await fetch(`${appUrl}/subscribe`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: recipient, firstName: "Local", lists: slug }),
  });
  expect(subscribe.status).toBe(200);

  await eventually(async () => {
    const response = await fetch(`${mailpitUrl}/api/v1/messages`);
    if (!response.ok) return;
    const body = await response.json() as { messages?: Array<{ To?: Array<{ Address?: string }>; Subject?: string }> };
    return body.messages?.some((message) =>
      message.Subject === "Confirm your subscription" &&
      message.To?.some((address) => address.Address === recipient),
    ) ? true : undefined;
  });

  const messageId = `local-${run}`;
  const subject = `Inbound local E2E ${run}`;
  const key = `inbound/${messageId}.eml`;
  const rawEmail = [
    `From: Sender <sender@example.test>`,
    `To: ${slug}@reply.lists.local`,
    `Subject: ${subject}`,
    `Message-ID: <${messageId}@example.test>`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Hello from the local S3 and SQS integration test.",
  ].join("\r\n");

  const s3 = new S3Client({ region: "us-east-1", endpoint: motoUrl, credentials, forcePathStyle: true });
  await s3.send(new PutObjectCommand({ Bucket: "lists-inbound", Key: key, Body: rawEmail }));

  const sqs = new SQSClient({ region: "us-east-1", endpoint: motoUrl, credentials });
  await sqs.send(new SendMessageCommand({
    QueueUrl: `${motoUrl}/123456789012/lists-inbound`,
    MessageBody: JSON.stringify({
      messageId,
      timestamp: new Date().toISOString(),
      source: "sender@example.test",
      from: ["sender@example.test"],
      to: [`${slug}@reply.lists.local`],
      subject,
      spamVerdict: "PASS",
      virusVerdict: "PASS",
      spfVerdict: "PASS",
      dkimVerdict: "PASS",
      dmarcVerdict: "PASS",
      s3Key: key,
      action: { type: "S3", bucketName: "lists-inbound", objectKeyPrefix: "inbound/", objectKey: key },
    }),
  }));

  await eventually(async () => {
    const response = await fetch(`${appUrl}/admin/inbound`, { headers: { cookie } });
    const html = await response.text();
    return response.ok && html.includes(subject) ? true : undefined;
  }, 35_000);
});
