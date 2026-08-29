/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { Body, Container, Head, Html, Preview, Text } from "@react-email/components";
import { Footer } from "../components/footer";

export interface NewsletterProps {
  subject: string;
  contentHtml: string;
  listName: string;
  unsubscribeUrl: string;
  preferencesUrl: string;
}

export function Newsletter({ subject, contentHtml, listName, unsubscribeUrl, preferencesUrl }: NewsletterProps) {
  return (
    <Html>
      <Head />
      <Preview>{subject}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Text style={listNameText}>{listName}</Text>
          <div dangerouslySetInnerHTML={{ __html: contentHtml }} style={content} />
          <Footer unsubscribeUrl={unsubscribeUrl} preferencesUrl={preferencesUrl} />
        </Container>
      </Body>
    </Html>
  );
}

export default Newsletter;

const body = {
  backgroundColor: "#ffffff",
  fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  margin: 0,
};

const container = {
  margin: "0 auto",
  padding: "40px 24px 32px",
  maxWidth: "580px",
};

const listNameText = {
  fontSize: "16px",
  fontWeight: 600 as const,
  lineHeight: "22px",
  color: "#202020",
  margin: "0 0 32px",
  paddingBottom: "16px",
  borderBottom: "1px solid #dedede",
};

const content = {
  fontSize: "16px",
  lineHeight: "1.65",
  color: "#202020",
};
