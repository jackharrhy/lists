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

export type CreateSubscriberInput = z.output<typeof subscriberCreateInput>;
export type CreateCampaignDraftInput = z.output<typeof campaignCreateInput>;
