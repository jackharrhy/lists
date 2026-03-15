import { test, expect, describe } from "bun:test";
import { Hono } from "hono";
import { createSession, destroySession, adminAuth } from "../src/auth";

describe("createSession", () => {
  test("returns a string", () => {
    const session = createSession();
    expect(typeof session).toBe("string");
  });

  test("returns unique sessions", () => {
    const a = createSession();
    const b = createSession();
    expect(a).not.toBe(b);
  });
});

describe("destroySession", () => {
  test("invalidates a session", async () => {
    const app = new Hono();
    app.use("/protected/*", adminAuth("password"));
    app.get("/protected/data", (c) => c.text("ok"));

    const token = createSession();

    // Valid session should grant access
    const validRes = await app.fetch(
      new Request("http://localhost/protected/data", {
        headers: { Cookie: `session=${token}` },
      }),
    );
    expect(validRes.status).toBe(200);
    expect(await validRes.text()).toBe("ok");

    // Destroy and verify it now redirects
    destroySession(token);
    const invalidRes = await app.fetch(
      new Request("http://localhost/protected/data", {
        headers: { Cookie: `session=${token}` },
      }),
    );
    expect(invalidRes.status).toBe(302);
    expect(invalidRes.headers.get("Location")).toBe("/admin/login");
  });
});

describe("adminAuth middleware", () => {
  test("redirects when no session cookie is present", async () => {
    const app = new Hono();
    app.use("/protected/*", adminAuth("password"));
    app.get("/protected/data", (c) => c.text("ok"));

    const res = await app.fetch(
      new Request("http://localhost/protected/data"),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/login");
  });

  test("allows access with valid session cookie", async () => {
    const app = new Hono();
    app.use("/protected/*", adminAuth("password"));
    app.get("/protected/data", (c) => c.text("ok"));

    const token = createSession();
    const res = await app.fetch(
      new Request("http://localhost/protected/data", {
        headers: { Cookie: `session=${token}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("redirects with invalid session cookie", async () => {
    const app = new Hono();
    app.use("/protected/*", adminAuth("password"));
    app.get("/protected/data", (c) => c.text("ok"));

    const res = await app.fetch(
      new Request("http://localhost/protected/data", {
        headers: { Cookie: "session=bogus-token" },
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/login");
  });
});
