import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Db } from "../../db";
import { schema } from "../../db";
import type { Config } from "../../config";
import { createSession, destroySession } from "../../auth";

export function mountAuthRoutes(app: Hono, db: Db, config: Config) {
  app.get("/login", (c) => {
    return c.html(
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Login - Lists Admin</title>
          <link rel="stylesheet" href="/static/styles.css" />
        </head>
        <body class="font-sans flex items-center justify-center min-h-screen m-0 bg-gray-50">
          <div class="bg-white p-8 rounded-lg border border-gray-200 w-80">
            <h1 class="m-0 mb-4 text-xl text-center font-bold">Lists Admin</h1>
            <form method="post" action="/admin/login">
              <input
                type="email"
                name="email"
                placeholder="Email"
                required
                autofocus
                class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 box-border"
              />
              <input
                type="password"
                name="password"
                placeholder="Password"
                required
                class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 box-border"
              />
              <button type="submit" class="w-full px-3 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 cursor-pointer border-none">
                Log in
              </button>
            </form>
          </div>
        </body>
      </html>,
    );
  });

  app.post("/login", async (c) => {
    const body = await c.req.parseBody();
    const email = body["email"] as string;
    const password = body["password"] as string;

    const renderError = (message: string) =>
      c.html(
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <title>Login - Lists Admin</title>
            <link rel="stylesheet" href="/static/styles.css" />
          </head>
          <body class="font-sans flex items-center justify-center min-h-screen m-0 bg-gray-50">
            <div class="bg-white p-8 rounded-lg border border-gray-200 w-80">
              <h1 class="m-0 mb-4 text-xl text-center font-bold">Lists Admin</h1>
              <p class="text-red-600 text-sm mb-3 text-center">{message}</p>
              <form method="post" action="/admin/login">
                <input
                  type="email"
                  name="email"
                  placeholder="Email"
                  required
                  autofocus
                  class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 box-border"
                />
                <input
                  type="password"
                  name="password"
                  placeholder="Password"
                  required
                  class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 box-border"
                />
                <button type="submit" class="w-full px-3 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 cursor-pointer border-none">
                  Log in
                </button>
              </form>
            </div>
          </body>
        </html>,
        401,
      );

    if (!email || !password) return renderError("Email and password are required.");

    const user = db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .get();

    if (!user) return renderError("Invalid email or password.");

    const valid = await Bun.password.verify(password, user.passwordHash);
    if (!valid) return renderError("Invalid email or password.");

    const token = createSession(user.id);
    setCookie(c, "session", token, {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      maxAge: 86400,
    });
    return c.redirect("/admin/");
  });

  app.post("/logout", (c) => {
    const token = getCookie(c, "session");
    if (token) {
      destroySession(token);
    }
    deleteCookie(c, "session", { path: "/" });
    return c.redirect("/admin/login");
  });
}
