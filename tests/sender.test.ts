import { test, expect, describe } from "bun:test";
import { buildRawEmail } from "../src/services/sender";

const defaultArgs = {
  from: '"My Newsletter" <news@example.com>',
  to: "reader@gmail.com",
  subject: "Issue #42",
  text: "Hello plain world",
  html: "<h1>Hello HTML world</h1>",
  fromDomain: "example.com",
  headers: {
    "List-Unsubscribe": "<https://example.com/unsub/abc>",
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    "Reply-To": "mylist@reply.example.com",
  },
};

describe("buildRawEmail", () => {
  test("contains From header", () => {
    const raw = buildRawEmail(defaultArgs);
    expect(raw).toContain("From: \"My Newsletter\" <news@example.com>");
  });

  test("contains To header", () => {
    const raw = buildRawEmail(defaultArgs);
    expect(raw).toContain("To: reader@gmail.com");
  });

  test("contains Subject header", () => {
    const raw = buildRawEmail(defaultArgs);
    expect(raw).toContain("Subject: Issue #42");
  });

  test("contains Message-ID with correct domain", () => {
    const raw = buildRawEmail(defaultArgs);
    const match = raw.match(/Message-ID: <([^>]+)>/);
    expect(match).not.toBeNull();
    expect(match![1]).toEndWith("@example.com");
  });

  test("contains Date header", () => {
    const raw = buildRawEmail(defaultArgs);
    expect(raw).toMatch(/Date: .+/);
  });

  test("contains List-Unsubscribe header", () => {
    const raw = buildRawEmail(defaultArgs);
    expect(raw).toContain("List-Unsubscribe: <https://example.com/unsub/abc>");
  });

  test("contains List-Unsubscribe-Post header", () => {
    const raw = buildRawEmail(defaultArgs);
    expect(raw).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
  });

  test("contains Reply-To header", () => {
    const raw = buildRawEmail(defaultArgs);
    expect(raw).toContain("Reply-To: mylist@reply.example.com");
  });

  test("contains multipart/alternative boundary", () => {
    const raw = buildRawEmail(defaultArgs);
    expect(raw).toMatch(/Content-Type: multipart\/alternative; boundary="[^"]+"/);
  });

  test("contains text/plain part before text/html part", () => {
    const raw = buildRawEmail(defaultArgs);
    const plainIndex = raw.indexOf("Content-Type: text/plain");
    const htmlIndex = raw.indexOf("Content-Type: text/html");
    expect(plainIndex).toBeGreaterThan(-1);
    expect(htmlIndex).toBeGreaterThan(-1);
    expect(plainIndex).toBeLessThan(htmlIndex);
  });

  test("contains the provided text content", () => {
    const raw = buildRawEmail(defaultArgs);
    expect(raw).toContain("Hello plain world");
  });

  test("contains the provided html content", () => {
    const raw = buildRawEmail(defaultArgs);
    expect(raw).toContain("<h1>Hello HTML world</h1>");
  });

  test("contains MIME-Version header", () => {
    const raw = buildRawEmail(defaultArgs);
    expect(raw).toContain("MIME-Version: 1.0");
  });
});
