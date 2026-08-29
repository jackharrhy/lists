/** @jsxRuntime automatic */
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
        <Link href={preferencesUrl} style={link}>
          Manage preferences
        </Link>
        {"\u00a0\u00a0\u00a0"}
        <Link href={unsubscribeUrl} style={link}>
          Unsubscribe
        </Link>
      </Text>
    </>
  );
}

const hr = {
  borderColor: "#dedede",
  margin: "40px 0 18px",
};

const footerText = {
  color: "#737373",
  fontSize: "13px",
  lineHeight: "20px",
  margin: 0,
};

const link = {
  color: "#5c5c5c",
  textDecoration: "underline",
};
