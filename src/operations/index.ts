import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db";
import { schema } from "../db";
import type { Config } from "../config";
import { sendCampaign } from "../services/sender";
import { createSubscriber } from "../services/subscriber";
import {
  assertListAccess,
  assertScope,
  canAccessSubscriber,
  AccessDeniedError,
  type Principal,
} from "../services/access";
import type { CreateCampaignDraftInput, CreateSubscriberInput } from "./contracts";

export class NotFoundError extends Error { status = 404; }
export class InvalidOperationError extends Error { status = 400; }

export type OperationContext = { db: Db; config: Config; principal: Principal };

function visibleListIds(ctx: OperationContext): number[] | null {
  return ctx.principal.listIds === "all" ? null : [...ctx.principal.listIds];
}

export function listLists(ctx: OperationContext) {
  assertScope(ctx.principal, "lists:read");
  const ids = visibleListIds(ctx);
  if (ids?.length === 0) return [];
  return ids
    ? ctx.db.select().from(schema.lists).where(inArray(schema.lists.id, ids)).all()
    : ctx.db.select().from(schema.lists).all();
}

export function listSubscribers(ctx: OperationContext, input: { limit?: number; offset?: number; status?: string } = {}) {
  assertScope(ctx.principal, "subscribers:read");
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const offset = Math.max(input.offset ?? 0, 0);
  const ids = visibleListIds(ctx);
  if (ids?.length === 0) return [];

  const conditions = [];
  if (input.status === "active" || input.status === "blocklisted") {
    conditions.push(eq(schema.subscribers.status, input.status));
  }
  if (ids) conditions.push(inArray(schema.subscriberLists.listId, ids));

  const rows = ctx.db.select({
    id: schema.subscribers.id,
    email: schema.subscribers.email,
    firstName: schema.subscribers.firstName,
    lastName: schema.subscribers.lastName,
    status: schema.subscribers.status,
    createdAt: schema.subscribers.createdAt,
  }).from(schema.subscribers)
    .leftJoin(schema.subscriberLists, eq(schema.subscriberLists.subscriberId, schema.subscribers.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .groupBy(schema.subscribers.id)
    .orderBy(desc(schema.subscribers.createdAt))
    .limit(limit).offset(offset).all();
  return rows;
}

export function getSubscriber(ctx: OperationContext, id: number) {
  assertScope(ctx.principal, "subscribers:read");
  if (!canAccessSubscriber(ctx.db, ctx.principal, id)) throw new AccessDeniedError("Subscriber access denied");
  const subscriber = ctx.db.select({
    id: schema.subscribers.id,
    email: schema.subscribers.email,
    firstName: schema.subscribers.firstName,
    lastName: schema.subscribers.lastName,
    status: schema.subscribers.status,
    createdAt: schema.subscribers.createdAt,
  }).from(schema.subscribers).where(eq(schema.subscribers.id, id)).get();
  if (!subscriber) throw new NotFoundError("Subscriber not found");
  const memberships = ctx.db.select({
    listId: schema.lists.id,
    listSlug: schema.lists.slug,
    listName: schema.lists.name,
    status: schema.subscriberLists.status,
    subscribedAt: schema.subscriberLists.subscribedAt,
  }).from(schema.subscriberLists)
    .innerJoin(schema.lists, eq(schema.lists.id, schema.subscriberLists.listId))
    .where(eq(schema.subscriberLists.subscriberId, id)).all()
    .filter((row) => ctx.principal.listIds === "all" || ctx.principal.listIds.has(row.listId));
  return { ...subscriber, memberships };
}

export function createSubscriberOperation(ctx: OperationContext, input: CreateSubscriberInput) {
  assertScope(ctx.principal, "subscribers:write");
  const listSlugs = [...new Set(input.lists)];
  for (const slug of listSlugs) {
    const list = ctx.db.select({ id: schema.lists.id }).from(schema.lists)
      .where(eq(schema.lists.slug, slug)).get();
    if (!list) throw new InvalidOperationError(`Unknown list slug: ${slug}`);
    assertListAccess(ctx.principal, list.id);
  }
  const subscriber = createSubscriber(
    ctx.db,
    input.email,
    input.firstName ?? input.name ?? null,
    input.lastName ?? null,
    listSlugs,
  );
  return { id: subscriber.id, email: subscriber.email };
}

export function deleteSubscriber(ctx: OperationContext, id: number, confirm: boolean) {
  assertScope(ctx.principal, "subscribers:write");
  if (!confirm) throw new InvalidOperationError("Deletion requires confirm=true");
  if (!canAccessSubscriber(ctx.db, ctx.principal, id)) throw new AccessDeniedError("Subscriber access denied");
  const subscriber = ctx.db.select({ id: schema.subscribers.id, email: schema.subscribers.email })
    .from(schema.subscribers).where(eq(schema.subscribers.id, id)).get();
  if (!subscriber) throw new NotFoundError("Subscriber not found");
  ctx.db.transaction((tx) => {
    tx.delete(schema.subscriberTags).where(eq(schema.subscriberTags.subscriberId, id)).run();
    tx.delete(schema.subscriberLists).where(eq(schema.subscriberLists.subscriberId, id)).run();
    tx.delete(schema.campaignSends).where(eq(schema.campaignSends.subscriberId, id)).run();
    tx.delete(schema.events).where(eq(schema.events.subscriberId, id)).run();
    tx.delete(schema.subscribers).where(eq(schema.subscribers.id, id)).run();
  });
  return { id: subscriber.id, deleted: true };
}

export function listCampaigns(ctx: OperationContext, input: { limit?: number; offset?: number } = {}) {
  assertScope(ctx.principal, "campaigns:read");
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const offset = Math.max(input.offset ?? 0, 0);
  const ids = visibleListIds(ctx);
  if (ids?.length === 0) return [];
  return ctx.db.select().from(schema.campaigns)
    .where(ids ? and(eq(schema.campaigns.audienceType, "list"), inArray(schema.campaigns.audienceId, ids)) : undefined)
    .orderBy(desc(schema.campaigns.createdAt)).limit(limit).offset(offset).all();
}

export function getCampaign(ctx: OperationContext, id: number) {
  assertScope(ctx.principal, "campaigns:read");
  const campaign = ctx.db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id)).get();
  if (!campaign) throw new NotFoundError("Campaign not found");
  if (campaign.audienceType === "list" && campaign.audienceId) assertListAccess(ctx.principal, campaign.audienceId);
  if (ctx.principal.listIds !== "all" && campaign.audienceType !== "list") throw new AccessDeniedError("Campaign access denied");
  const counts = ctx.db.select({ status: schema.campaignSends.status, count: sql<number>`count(*)` })
    .from(schema.campaignSends).where(eq(schema.campaignSends.campaignId, id))
    .groupBy(schema.campaignSends.status).all();
  return { ...campaign, deliveryCounts: Object.fromEntries(counts.map((row) => [row.status, row.count])) };
}

export function createCampaignDraft(ctx: OperationContext, input: CreateCampaignDraftInput) {
  assertScope(ctx.principal, "campaigns:write");
  if (!input.subject.trim() || !input.bodyMarkdown.trim() || !input.fromAddress.trim()) {
    throw new InvalidOperationError("subject, bodyMarkdown, and fromAddress are required");
  }
  if (input.audienceType === "list") {
    if (!input.audienceId) throw new InvalidOperationError("audienceId is required for list campaigns");
    assertListAccess(ctx.principal, input.audienceId);
  } else if (ctx.principal.listIds !== "all") {
    throw new AccessDeniedError("Only admins can use non-list audiences");
  }
  return ctx.db.insert(schema.campaigns).values({
    subject: input.subject.trim(), bodyMarkdown: input.bodyMarkdown,
    fromAddress: input.fromAddress.trim(), fromName: input.fromName?.trim() || null,
    audienceType: input.audienceType, audienceId: input.audienceId ?? null,
    audienceData: input.audienceType === "subscribers" ? JSON.stringify(input.audienceData) : null,
    status: "draft",
  }).returning().get();
}

export async function sendCampaignOperation(ctx: OperationContext, id: number, confirm: boolean) {
  assertScope(ctx.principal, "campaigns:send");
  const campaign = getCampaign({ ...ctx, principal: { ...ctx.principal, scopes: new Set([...ctx.principal.scopes, "campaigns:read"]) } }, id);
  if (!confirm) throw new InvalidOperationError("Sending requires confirm=true");
  if (campaign.status !== "draft" && campaign.status !== "scheduled" && campaign.status !== "failed") {
    throw new InvalidOperationError(`Campaign cannot be sent from status ${campaign.status}`);
  }
  await sendCampaign(ctx.db, ctx.config, id);
  return getCampaign({ ...ctx, principal: { ...ctx.principal, scopes: new Set([...ctx.principal.scopes, "campaigns:read"]) } }, id);
}

export function getDeliverabilitySummary(ctx: OperationContext) {
  assertScope(ctx.principal, "deliverability:read");
  const ids = visibleListIds(ctx);
  if (ids?.length === 0) return { sends: {}, events: {} };
  const campaignFilter = ids
    ? and(eq(schema.campaigns.audienceType, "list"), inArray(schema.campaigns.audienceId, ids))
    : undefined;
  const rows = ctx.db.select({ status: schema.campaignSends.status, count: sql<number>`count(*)` })
    .from(schema.campaignSends)
    .innerJoin(schema.campaigns, eq(schema.campaigns.id, schema.campaignSends.campaignId))
    .where(campaignFilter).groupBy(schema.campaignSends.status).all();
  const recentEvents = ctx.db.select({ eventType: schema.deliveryEvents.eventType, count: sql<number>`count(*)` })
    .from(schema.deliveryEvents)
    .innerJoin(schema.campaignSends, eq(schema.campaignSends.sesMessageId, schema.deliveryEvents.sesMessageId))
    .innerJoin(schema.campaigns, eq(schema.campaigns.id, schema.campaignSends.campaignId))
    .where(campaignFilter).groupBy(schema.deliveryEvents.eventType).all();
  return {
    sends: Object.fromEntries(rows.map((row) => [row.status, row.count])),
    events: Object.fromEntries(recentEvents.map((row) => [row.eventType, row.count])),
  };
}

export function getDmarcSummary(ctx: OperationContext) {
  assertScope(ctx.principal, "dmarc:read");
  const allowedDomains = new Set(listLists({ ...ctx, principal: { ...ctx.principal, scopes: new Set([...ctx.principal.scopes, "lists:read"]) } }).map((list) => list.fromDomain));
  const reports = ctx.db.select({
    domain: schema.dmarcReports.domain,
    reports: sql<number>`count(*)`,
    messages: sql<number>`coalesce(sum(${schema.dmarcReports.messageCount}), 0)`,
    latest: sql<string | null>`max(${schema.dmarcReports.dateEnd})`,
  }).from(schema.dmarcReports).groupBy(schema.dmarcReports.domain).all()
    .filter((row) => allowedDomains.has(row.domain));
  return reports;
}
