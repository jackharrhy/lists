import { render } from "@react-email/render";
import { Newsletter, type NewsletterProps } from "./templates/newsletter";
import { Confirm, type ConfirmProps } from "./templates/confirm";

export async function renderNewsletter(
  props: NewsletterProps,
): Promise<{ html: string; text: string }> {
  const html = await render(Newsletter(props));
  const text = await render(Newsletter(props), { plainText: true });
  return { html, text };
}

export async function renderConfirmation(
  props: ConfirmProps,
): Promise<{ html: string }> {
  const html = await render(Confirm(props));
  return { html };
}
