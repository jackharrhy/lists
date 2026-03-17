import { Hono } from "hono";
import { eq, desc, sql, and, inArray } from "drizzle-orm";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import type { Db } from "../../db";
import { schema } from "../../db";
import type { Config } from "../../config";
import { getAccessibleListIds } from "../../auth";
import { logEvent } from "../../services/events";
import { AdminLayout, extractEmail, fmtDateTime, VerdictChips, type User } from "./layout";
import { Button, Input, Textarea, Label, FormGroup, Table, Th, Td } from "./ui";

export function mountMessageRoutes(app: Hono, db: Db, config: Config) {
  app.get("/inbound", (c) => {
    const user = c.get("user") as User;
    const listAccess = getAccessibleListIds(db, user);

    let inboundMessages: (typeof schema.messages.$inferSelect)[];
    if (listAccess === "all") {
      inboundMessages = db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.direction, "inbound"))
        .orderBy(desc(schema.messages.createdAt))
        .limit(100)
        .all();
    } else if (listAccess.length === 0) {
      inboundMessages = [];
    } else {
      inboundMessages = db
        .select({
          id: schema.messages.id,
          threadId: schema.messages.threadId,
          parentId: schema.messages.parentId,
          direction: schema.messages.direction,
          rfc822MessageId: schema.messages.rfc822MessageId,
          inReplyTo: schema.messages.inReplyTo,
          fromAddr: schema.messages.fromAddr,
          toAddr: schema.messages.toAddr,
          subject: schema.messages.subject,
          bodyText: schema.messages.bodyText,
          bodyHtml: schema.messages.bodyHtml,
          sesMessageId: schema.messages.sesMessageId,
          s3Key: schema.messages.s3Key,
          spamVerdict: schema.messages.spamVerdict,
          virusVerdict: schema.messages.virusVerdict,
          spfVerdict: schema.messages.spfVerdict,
          dkimVerdict: schema.messages.dkimVerdict,
          dmarcVerdict: schema.messages.dmarcVerdict,
          campaignId: schema.messages.campaignId,
          readAt: schema.messages.readAt,
          sentAt: schema.messages.sentAt,
          createdAt: schema.messages.createdAt,
        })
        .from(schema.messages)
        .innerJoin(schema.campaigns, eq(schema.messages.campaignId, schema.campaigns.id))
        .where(and(eq(schema.messages.direction, "inbound"), eq(schema.campaigns.audienceType, "list"), inArray(schema.campaigns.audienceId, listAccess)))
        .orderBy(desc(schema.messages.createdAt))
        .limit(100)
        .all();
    }

    // Group by thread: pick the earliest inbound message per thread as the representative
    const threadMap = new Map<number, typeof inboundMessages[number]>();
    for (const msg of inboundMessages) {
      const existing = threadMap.get(msg.threadId);
      if (!existing || msg.createdAt < existing.createdAt) {
        threadMap.set(msg.threadId, msg);
      }
    }
    const threads = [...threadMap.values()].sort((a, b) => {
      // Sort by most recent activity in thread (check all inbound messages)
      const latestA = inboundMessages.filter((m) => m.threadId === a.threadId).reduce((max, m) => m.createdAt > max ? m.createdAt : max, a.createdAt);
      const latestB = inboundMessages.filter((m) => m.threadId === b.threadId).reduce((max, m) => m.createdAt > max ? m.createdAt : max, b.createdAt);
      return latestB.localeCompare(latestA);
    });

    // Count total messages (inbound + outbound) per thread minus 1 (the root)
    const replyCounts = new Map<number, number>();
    if (threads.length > 0) {
      const threadIds = threads.map((t) => t.threadId);
      const counts = db
        .select({
          threadId: schema.messages.threadId,
          count: sql<number>`count(*)`,
        })
        .from(schema.messages)
        .where(inArray(schema.messages.threadId, threadIds))
        .groupBy(schema.messages.threadId)
        .all();
      for (const row of counts) {
        replyCounts.set(row.threadId, Math.max(0, row.count - 1));
      }
    }

    // Check if any message in a thread is unread
    const threadHasUnread = new Map<number, boolean>();
    for (const msg of inboundMessages) {
      if (!msg.readAt) {
        threadHasUnread.set(msg.threadId, true);
      }
    }

    // Campaign lookup for linked campaigns
    const campaignMap = new Map<number, string>();
    const campaignIds = [...new Set(inboundMessages.filter((m) => m.campaignId).map((m) => m.campaignId!))];
    if (campaignIds.length > 0) {
      const campaigns = db
        .select({ id: schema.campaigns.id, subject: schema.campaigns.subject })
        .from(schema.campaigns)
        .where(inArray(schema.campaigns.id, campaignIds))
        .all();
      for (const cam of campaigns) {
        campaignMap.set(cam.id, cam.subject);
      }
    }
    // Find campaign for each thread (any message in the thread may have it)
    const threadCampaignMap = new Map<number, number>();
    for (const msg of inboundMessages) {
      if (msg.campaignId && !threadCampaignMap.has(msg.threadId)) {
        threadCampaignMap.set(msg.threadId, msg.campaignId);
      }
    }

    return c.html(
      <AdminLayout title="Inbound" user={user}>
        <h1 class="text-2xl font-bold mt-0 mb-4">Inbound Messages</h1>
        <Table>
          <thead>
            <tr>
              <Th>From</Th>
              <Th>Subject</Th>
              <Th>Date</Th>
              <Th>Replies</Th>
              <Th>Campaign</Th>
              <Th>Auth</Th>
            </tr>
          </thead>
          <tbody>
            {threads.map((msg) => (
              <tr class={threadHasUnread.get(msg.threadId) ? "font-semibold" : ""}>
                <Td>{msg.fromAddr}</Td>
                <Td>
                  <a href={`/admin/inbound/${msg.id}`} class="text-blue-600 hover:text-blue-800">{msg.subject}</a>
                </Td>
                <Td>{fmtDateTime(msg.createdAt)}</Td>
                <Td>{replyCounts.get(msg.threadId) ?? 0}</Td>
                <Td>
                  {(() => {
                    const camId = threadCampaignMap.get(msg.threadId) ?? msg.campaignId;
                    return camId && campaignMap.has(camId) ? (
                      <a href={`/admin/campaigns/${camId}`} class="text-blue-600 hover:text-blue-800 text-xs">{campaignMap.get(camId)}</a>
                    ) : (
                      <span class="text-gray-400">{"\u2014"}</span>
                    );
                  })()}
                </Td>
                <Td>
                  <VerdictChips spf={msg.spfVerdict} dkim={msg.dkimVerdict} dmarc={msg.dmarcVerdict} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </AdminLayout>,
    );
  });

  app.get("/inbound/:id", async (c) => {
    const user = c.get("user") as User;
    const id = Number(c.req.param("id"));
    const msg = db.select().from(schema.messages).where(eq(schema.messages.id, id)).get();
    if (!msg) return c.notFound();

    // auto-mark as read
    if (!msg.readAt) {
      db.update(schema.messages)
        .set({ readAt: new Date().toISOString() })
        .where(eq(schema.messages.id, id))
        .run();
    }

    // Get all messages in this thread
    const threadMessages = db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.threadId, msg.threadId))
      .orderBy(schema.messages.createdAt)
      .all();

    // Linked campaign (from any message in thread)
    const campaignId = threadMessages.find((m) => m.campaignId)?.campaignId;
    const campaign = campaignId
      ? db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId)).get()
      : null;

    // Mark all unread inbound messages in thread as read
    for (const m of threadMessages) {
      if (!m.readAt && m.direction === "inbound") {
        db.update(schema.messages)
          .set({ readAt: new Date().toISOString() })
          .where(eq(schema.messages.id, m.id))
          .run();
      }
    }

    return c.html(
      <AdminLayout title={`Inbound: ${msg.subject}`} user={user}>
        <h1 class="text-2xl font-bold mt-0 mb-1">{msg.subject}</h1>
        {campaign && (
          <p class="text-sm text-gray-500 mb-4">
            Campaign: <a href={`/admin/campaigns/${campaign.id}`} class="text-blue-600 hover:text-blue-800">{campaign.subject}</a>
          </p>
        )}

        {/* Action toolbar */}
        <div class="flex gap-2 mb-4">
          <form method="post" action={`/admin/inbound/${id}/toggle-read`}>
            <button type="submit" class="inline-block px-3 py-1.5 bg-gray-100 text-gray-700 text-xs font-medium rounded-md hover:bg-gray-200 cursor-pointer border border-gray-300">
              Mark as {msg.readAt ? "Unread" : "Read"}
            </button>
          </form>
          <form method="post" action={`/admin/inbound/${id}/delete`} onsubmit="return confirm('Delete this message thread? This cannot be undone.')">
            <button type="submit" class="inline-block px-3 py-1.5 bg-red-50 text-red-600 text-xs font-medium rounded-md hover:bg-red-100 cursor-pointer border border-red-200">
              Delete
            </button>
          </form>
        </div>

        {/* Thread */}
        {threadMessages.map((m) => {
          if (m.direction === "inbound") {
            return (
              <div class="bg-white border border-gray-200 rounded-lg p-5 mb-4">
                <div class="flex items-baseline justify-between mb-3">
                  <div>
                    <span class="font-medium text-sm">{m.fromAddr}</span>
                    <span class="text-gray-400 text-xs ml-2">{"\u2192"} {m.toAddr}</span>
                  </div>
                  <div class="flex items-center gap-2">
                    <span class="text-xs text-gray-400">{fmtDateTime(m.createdAt)}</span>
                    <VerdictChips spf={m.spfVerdict} dkim={m.dkimVerdict} dmarc={m.dmarcVerdict} />
                  </div>
                </div>
                {m.bodyHtml ? (
                  <iframe
                    srcdoc={m.bodyHtml}
                    class="w-full border-0 rounded"
                    style="min-height: 200px;"
                    sandbox="allow-same-origin"
                  />
                ) : m.bodyText ? (
                  <pre class="text-sm text-gray-700 whitespace-pre-wrap font-sans leading-relaxed">{m.bodyText}</pre>
                ) : (
                  <p class="text-gray-400 text-sm italic">Email body not available</p>
                )}
                {m.s3Key && (
                  <a href={`/admin/inbound/${m.id}/raw`} class="text-xs text-gray-400 hover:text-gray-600 mt-2 inline-block">Download raw .eml</a>
                )}
              </div>
            );
          } else {
            return (
              <div class="bg-blue-50 border border-blue-200 rounded-lg p-5 mb-4">
                <div class="flex items-baseline justify-between mb-3">
                  <div>
                    <span class="font-medium text-sm text-blue-800">{m.fromAddr}</span>
                    <span class="text-blue-400 text-xs ml-1">(You)</span>
                    <span class="text-blue-400 text-xs ml-2">{"\u2192"} {m.toAddr}</span>
                  </div>
                  <span class="text-xs text-gray-400">{fmtDateTime(m.sentAt ?? m.createdAt)}</span>
                </div>
                <pre class="text-sm text-gray-700 whitespace-pre-wrap font-sans leading-relaxed">{m.bodyText ?? ""}</pre>
              </div>
            );
          }
        })}

        {/* Reply form */}
        <div class="bg-gray-50 border border-gray-200 rounded-lg p-5 mt-2">
          <h3 class="text-sm font-semibold text-gray-700 mt-0 mb-3">Reply</h3>
          <form method="post" action={`/admin/inbound/${id}/reply`}>
            <FormGroup>
              <Label for="fromAddr">From</Label>
              <Input
                type="email"
                id="fromAddr"
                name="fromAddr"
                required
                value={extractEmail(msg.toAddr)}
              />
            </FormGroup>
            <FormGroup>
              <Label for="toAddr">To</Label>
              <Input
                type="email"
                id="toAddr"
                name="toAddr"
                required
                value={extractEmail(msg.fromAddr)}
              />
            </FormGroup>
            <FormGroup>
              <Label for="replySubject">Subject</Label>
              <Input
                type="text"
                id="replySubject"
                name="subject"
                required
                value={msg.subject.startsWith("Re:") ? msg.subject : `Re: ${msg.subject}`}
              />
            </FormGroup>
            <FormGroup>
              <Label for="replyBody">Body (plain text)</Label>
              <Textarea id="replyBody" name="body" required placeholder="Your reply…" />
            </FormGroup>
            <Button type="submit">Send Reply</Button>
          </form>
        </div>
      </AdminLayout>,
    );
  });

  app.post("/inbound/:id/toggle-read", (c) => {
    const id = Number(c.req.param("id"));
    const msg = db.select().from(schema.messages).where(eq(schema.messages.id, id)).get();
    if (!msg) return c.notFound();
    db.update(schema.messages)
      .set({ readAt: msg.readAt ? null : new Date().toISOString() })
      .where(eq(schema.messages.id, id))
      .run();
    return c.redirect(`/admin/inbound/${id}`);
  });

  app.post("/inbound/:id/delete", (c) => {
    const user = c.get("user") as User;
    const id = Number(c.req.param("id"));
    const msg = db.select().from(schema.messages).where(eq(schema.messages.id, id)).get();

    logEvent(db, {
      type: "admin.inbound_deleted",
      detail: msg?.subject ?? `id=${id}`,
      messageId: id,
      userId: user.id,
    });

    // delete all messages in the thread
    if (msg) {
      db.delete(schema.messages)
        .where(eq(schema.messages.threadId, msg.threadId))
        .run();
    }
    return c.redirect("/admin/inbound");
  });

  app.get("/inbound/:id/raw", async (c) => {
    const id = Number(c.req.param("id"));
    const msg = db.select().from(schema.messages).where(eq(schema.messages.id, id)).get();
    if (!msg || !msg.s3Key) return c.notFound();

    const s3 = new S3Client({ region: config.awsRegion });
    const command = new GetObjectCommand({
      Bucket: config.s3Bucket,
      Key: msg.s3Key,
    });
    const url = await getSignedUrl(s3, command, { expiresIn: 300 });
    return c.redirect(url);
  });

  app.post("/inbound/:id/reply", async (c) => {
    const user = c.get("user") as User;
    const id = Number(c.req.param("id"));
    const msg = db.select().from(schema.messages).where(eq(schema.messages.id, id)).get();
    if (!msg) return c.notFound();

    const body = await c.req.parseBody();
    const fromAddr = String(body["fromAddr"] ?? "").trim();
    const toAddr = String(body["toAddr"] ?? "").trim();
    const subject = String(body["subject"] ?? "").trim();
    const replyBody = String(body["body"] ?? "").trim();

    if (!fromAddr || !toAddr || !subject || !replyBody) {
      return c.redirect(`/admin/inbound/${id}`);
    }

    const inReplyToId = msg.rfc822MessageId;
    const fromDomain = fromAddr.split("@")[1] ?? config.fromDomain;
    const rfc822MessageId = `<${crypto.randomUUID()}@${fromDomain}>`;
    const rawLines = [
      `From: ${fromAddr}`,
      `To: ${toAddr}`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Message-ID: ${rfc822MessageId}`,
      `Date: ${new Date().toUTCString()}`,
      ...(inReplyToId ? [`In-Reply-To: ${inReplyToId}`, `References: ${inReplyToId}`] : []),
      `Content-Type: text/plain; charset=UTF-8`,
      `Content-Transfer-Encoding: 7bit`,
      ``,
      replyBody,
    ];
    const rawEmail = rawLines.join("\r\n");

    const ses = new SESv2Client({ region: config.awsRegion });
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

    db.insert(schema.messages)
      .values({
        direction: "outbound",
        threadId: msg.threadId,
        parentId: id,
        fromAddr,
        toAddr,
        subject,
        bodyText: replyBody,
        rfc822MessageId,
        sesMessageId: result.MessageId ?? null,
        inReplyTo: inReplyToId,
        sentAt: new Date().toISOString(),
      })
      .run();

    logEvent(db, {
      type: "admin.reply_sent",
      detail: toAddr,
      messageId: id,
      userId: user.id,
    });

    return c.redirect(`/admin/inbound/${id}`);
  });
}
