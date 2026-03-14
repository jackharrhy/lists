/** @jsxImportSource react */
import {
  Body,
  Container,
  Head,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import { Footer } from "../components/footer";

export interface NewsletterProps {
  subject: string;
  contentHtml: string;
  listName: string;
  unsubscribeUrl: string;
  preferencesUrl: string;
}

export function Newsletter({
  subject,
  contentHtml,
  listName,
  unsubscribeUrl,
  preferencesUrl,
}: NewsletterProps) {
  return (
    <Html>
      <Head />
      <Preview>{subject}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Text style={listNameText}>{listName}</Text>
          <Section
            dangerouslySetInnerHTML={{ __html: contentHtml }}
            style={content}
          />
          <Footer
            unsubscribeUrl={unsubscribeUrl}
            preferencesUrl={preferencesUrl}
          />
        </Container>
      </Body>
    </Html>
  );
}

export default Newsletter;

const body = {
  backgroundColor: "#ffffff",
  fontFamily:
    "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
};

const container = {
  margin: "0 auto",
  padding: "32px 24px",
  maxWidth: "600px",
};

const listNameText = {
  fontSize: "13px",
  fontWeight: 600 as const,
  color: "#666666",
  textTransform: "uppercase" as const,
  letterSpacing: "0.5px",
  margin: "0 0 24px",
};

const content = {
  fontSize: "16px",
  lineHeight: "26px",
  color: "#1a1a1a",
};
