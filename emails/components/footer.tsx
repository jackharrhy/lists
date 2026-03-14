/** @jsxImportSource react */
import { Hr, Link, Text } from "@react-email/components";

export interface FooterProps {
  unsubscribeUrl: string;
  preferencesUrl: string;
}

export function Footer({ unsubscribeUrl, preferencesUrl }: FooterProps) {
  return (
    <>
      <Hr style={hr} />
      <Text style={footerText}>
        <Link href={unsubscribeUrl} style={link}>
          Unsubscribe
        </Link>
        {" · "}
        <Link href={preferencesUrl} style={link}>
          Manage preferences
        </Link>
      </Text>
    </>
  );
}

const hr = {
  borderColor: "#e5e5e5",
  margin: "32px 0 24px",
};

const footerText = {
  color: "#999999",
  fontSize: "12px",
  lineHeight: "20px",
  textAlign: "center" as const,
};

const link = {
  color: "#999999",
  textDecoration: "underline",
};
