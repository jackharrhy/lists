import { z } from "zod";
import type { OperationContext } from ".";
import {
  createCampaignDraft,
  createSubscriberOperation,
  deleteSubscriber,
  getCampaign,
  getDeliverabilitySummary,
  getDmarcSummary,
  getSubscriber,
  listCampaigns,
  listLists,
  listSubscribers,
  sendCampaignOperation,
} from ".";
import {
  campaignCreateInput,
  campaignSendInput,
  emptyInput,
  idInput,
  paginationInput,
  subscriberCreateInput,
  subscriberDeleteInput,
  subscriberListInput,
} from "./contracts";

type OperationDefinition<S extends z.ZodType, R> = {
  mcpName: string;
  description: string;
  input: S;
  execute: (ctx: OperationContext, input: unknown) => Promise<R>;
};

function defineOperation<S extends z.ZodType, R>(definition: {
  mcpName: string;
  description: string;
  input: S;
  run: (ctx: OperationContext, input: z.output<S>) => R | Promise<R>;
}): OperationDefinition<S, R> {
  return {
    mcpName: definition.mcpName,
    description: definition.description,
    input: definition.input,
    execute: async (ctx, input) => definition.run(ctx, definition.input.parse(input)),
  };
}

export const operationCatalog = {
  listsList: defineOperation({
    mcpName: "lists_list",
    description: "List mailing lists visible to the authenticated user.",
    input: emptyInput,
    run: (ctx) => listLists(ctx),
  }),
  subscribersList: defineOperation({
    mcpName: "subscribers_list",
    description: "List subscribers without exposing unsubscribe tokens.",
    input: subscriberListInput,
    run: (ctx, input) => listSubscribers(ctx, input),
  }),
  subscriberGet: defineOperation({
    mcpName: "subscriber_get",
    description: "Get a subscriber and visible list memberships.",
    input: idInput,
    run: (ctx, input) => getSubscriber(ctx, input.id),
  }),
  subscriberCreate: defineOperation({
    mcpName: "subscriber_create",
    description: "Create or resubscribe a subscriber to one or more lists. Memberships start unconfirmed.",
    input: subscriberCreateInput,
    run: createSubscriberOperation,
  }),
  subscriberDelete: defineOperation({
    mcpName: "subscriber_delete",
    description: "Delete one subscriber and dependent records. Requires confirm=true.",
    input: subscriberDeleteInput,
    run: (ctx, input) => deleteSubscriber(ctx, input.id, input.confirm),
  }),
  campaignsList: defineOperation({
    mcpName: "campaigns_list",
    description: "List visible campaigns.",
    input: paginationInput,
    run: (ctx, input) => listCampaigns(ctx, input),
  }),
  campaignGet: defineOperation({
    mcpName: "campaign_get",
    description: "Get a campaign and its delivery counts.",
    input: idInput,
    run: (ctx, input) => getCampaign(ctx, input.id),
  }),
  campaignCreateDraft: defineOperation({
    mcpName: "campaign_create_draft",
    description: "Create a campaign draft. This never sends mail.",
    input: campaignCreateInput,
    run: createCampaignDraft,
  }),
  campaignSend: defineOperation({
    mcpName: "campaign_send",
    description: "Send a campaign. Requires confirm=true.",
    input: campaignSendInput,
    run: (ctx, input) => sendCampaignOperation(ctx, input.id, input.confirm),
  }),
  deliverabilitySummary: defineOperation({
    mcpName: "deliverability_summary",
    description: "Summarize delivery lifecycle states and provider events.",
    input: emptyInput,
    run: (ctx) => getDeliverabilitySummary(ctx),
  }),
  dmarcSummary: defineOperation({
    mcpName: "dmarc_summary",
    description: "Summarize DMARC reports for visible sending domains.",
    input: emptyInput,
    run: (ctx) => getDmarcSummary(ctx),
  }),
} as const;

export const mcpOperations = new Map(
  Object.values(operationCatalog).map((operation) => [operation.mcpName, operation]),
);

export const mcpTools = Object.values(operationCatalog).map((operation) => ({
  name: operation.mcpName,
  description: operation.description,
  inputSchema: z.toJSONSchema(operation.input, { target: "draft-7" }),
}));
