import { marked } from "marked";
import { renderNewsletter } from "../../emails/render";
import type { Db } from "../db";
import type { schema } from "../db";
import { getTemplateVersion, renderTemplateVersion } from "./email-templates";

type CampaignRenderModel = Pick<typeof schema.campaigns.$inferSelect,
  "subject" | "bodyMarkdown" | "templateVersionId" | "templateSections">;
type SubscriberRenderModel = {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
};

export type CampaignRenderInput = {
  campaign: CampaignRenderModel;
  subscriber: SubscriberRenderModel;
  list: { name: string; slug?: string };
  links: { unsubscribe: string; preferences: string };
};

export function substituteLegacyVariables(
  source: string,
  subscriber: SubscriberRenderModel,
  links: CampaignRenderInput["links"],
) {
  return source
    .replace(/\{\{firstName\}\}/g, subscriber.firstName || "")
    .replace(/\{\{lastName\}\}/g, subscriber.lastName || "")
    .replace(/\{\{email\}\}/g, subscriber.email)
    .replace(/\{\{unsubscribeUrl\}\}/g, links.unsubscribe)
    .replace(/\{\{preferencesUrl\}\}/g, links.preferences);
}

export async function renderCampaignMessage(db: Db, input: CampaignRenderInput) {
  const { campaign, subscriber, list, links } = input;
  const version = campaign.templateVersionId ? getTemplateVersion(db, campaign.templateVersionId) : null;
  if (version) {
    return renderTemplateVersion(version, {
      subscriber,
      campaign: { subject: campaign.subject },
      list,
      links,
      sectionSources: {
        ...(JSON.parse(campaign.templateSections) as Record<string, string>),
        content: campaign.bodyMarkdown,
      },
    });
  }

  const markdown = substituteLegacyVariables(campaign.bodyMarkdown, subscriber, links);
  const rendered = await renderNewsletter({
    subject: campaign.subject,
    contentHtml: await marked(markdown),
    listName: list.name,
    unsubscribeUrl: links.unsubscribe,
    preferencesUrl: links.preferences,
  });
  return { ...rendered, subject: campaign.subject };
}
