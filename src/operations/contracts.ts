import { z } from "zod";

export const emptyInput = z.object({}).strict();
export const idInput = z.object({ id: z.coerce.number().int().positive() }).strict();
export const paginationInput = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
}).strict();

export const subscriberListInput = paginationInput.extend({
  status: z.enum(["active", "blocklisted"]).optional(),
});

export const subscriberCreateInput = z.object({
  email: z.email(),
  firstName: z.string().max(255).optional(),
  lastName: z.string().max(255).optional(),
  name: z.string().max(255).optional(),
  lists: z.array(z.string().min(1)).min(1),
}).strict();

export const subscriberDeleteInput = idInput.extend({ confirm: z.literal(true) });

const campaignBaseInput = z.object({
  subject: z.string().min(1),
  bodyMarkdown: z.string().min(1),
  fromAddress: z.email(),
  fromName: z.string().optional().nullable(),
});

export const campaignCreateInput = z.discriminatedUnion("audienceType", [
  campaignBaseInput.extend({
    audienceType: z.literal("list"),
    audienceId: z.coerce.number().int().positive(),
  }).strict(),
  campaignBaseInput.extend({
    audienceType: z.literal("tag"),
    audienceId: z.coerce.number().int().positive(),
  }).strict(),
  campaignBaseInput.extend({
    audienceType: z.literal("all"),
    audienceId: z.null().optional(),
  }).strict(),
  campaignBaseInput.extend({
    audienceType: z.literal("subscribers"),
    audienceId: z.null().optional(),
    audienceData: z.array(z.coerce.number().int().positive()).min(1),
  }).strict(),
]);

export const campaignSendInput = idInput.extend({ confirm: z.literal(true) });

export const listOutput = z.object({
  id: z.number(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  fromDomain: z.string(),
  fromAddress: z.string(),
});

export const subscriberSummaryOutput = z.object({
  id: z.number(),
  email: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  status: z.enum(["active", "blocklisted"]),
  createdAt: z.string(),
});

export const subscriberOutput = subscriberSummaryOutput.extend({
  memberships: z.array(z.object({
    listId: z.number(),
    listSlug: z.string(),
    listName: z.string(),
    status: z.enum(["unconfirmed", "confirmed", "unsubscribed"]),
    subscribedAt: z.string(),
  })),
});

export const subscriberCreatedOutput = z.object({ id: z.number(), email: z.string() });
export const subscriberDeletedOutput = z.object({ id: z.number(), deleted: z.literal(true) });

export const campaignOutput = z.object({
  id: z.number(),
  subject: z.string(),
  bodyMarkdown: z.string(),
  templateSlug: z.string(),
  fromAddress: z.string(),
  fromName: z.string().nullable(),
  audienceType: z.enum(["list", "tag", "all", "subscribers"]),
  audienceId: z.number().nullable(),
  audienceData: z.string().nullable(),
  status: z.enum(["draft", "scheduled", "sending", "sent", "failed"]),
  scheduledAt: z.string().nullable(),
  batchSize: z.number().nullable(),
  batchInterval: z.number().nullable(),
  lastError: z.string().nullable(),
  sentAt: z.string().nullable(),
  createdAt: z.string(),
});

export const campaignDetailOutput = campaignOutput.extend({
  deliveryCounts: z.record(z.string(), z.number()),
});

export const deliverabilityOutput = z.object({
  sends: z.record(z.string(), z.number()),
  events: z.record(z.string(), z.number()),
});

export const dmarcOutput = z.array(z.object({
  domain: z.string(),
  reports: z.number(),
  messages: z.number(),
  latest: z.string().nullable(),
}));

export const apiErrorOutput = z.object({ error: z.string() });
export const dataOutput = <S extends z.ZodType>(schema: S) => z.object({ data: schema });

export type CreateSubscriberInput = z.output<typeof subscriberCreateInput>;
export type CreateCampaignDraftInput = z.output<typeof campaignCreateInput>;
