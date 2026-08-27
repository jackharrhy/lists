import { Html } from "@elysia/html";
import type { App } from "../../http";
import { eq } from "drizzle-orm";
import type { Db } from "../../db";
import { schema } from "../../db";
import type { Config } from "../../config";
import { createSession, destroySession } from "../../auth";
import { setFlash, getFlash } from "./layout";

export function mountAuthRoutes(app: App, db: Db, config: Config) {
  app.get("/login", (c) => {
    const flash = getFlash(c);
    return c.html(
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Login - Lists Admin</title>
          <link rel="stylesheet" href="/static/styles.css" />
          <script src="/static/app.js" defer></script>
        </head>
        <body class="font-sans flex items-center justify-center min-h-screen m-0 p-5">
          <div class="app-surface p-8 rounded-2xl w-full max-w-sm">
            <div class="mx-auto mb-5 grid place-items-center size-11 rounded-xl bg-gray-950 text-white font-bold shadow-sm">L</div>
            <h1 class="m-0 mb-1 text-2xl tracking-tight text-center font-bold">Welcome back</h1>
            <p class="mt-0 mb-6 text-sm text-gray-500 text-center">Sign in to your mailing workspace.</p>
            {flash && (
              <div class="bg-green-100 border border-green-300 text-green-800 px-3 py-2 rounded-md mb-4 text-sm text-center">{flash}</div>
            )}
            <form method="post" action="/admin/login">
              <input
                type="email"
                name="email"
                placeholder="Email"
                required
                autofocus
                class="w-full px-3.5 py-3 border border-gray-200 rounded-xl text-sm font-[inherit] mb-4 shadow-sm focus:outline-none focus:ring-4 focus:ring-blue-100 focus:border-blue-500 box-border"
              />
              <input
                type="password"
                name="password"
                placeholder="Password"
                required
                class="w-full px-3.5 py-3 border border-gray-200 rounded-xl text-sm font-[inherit] mb-5 shadow-sm focus:outline-none focus:ring-4 focus:ring-blue-100 focus:border-blue-500 box-border"
              />
              <button type="submit" class="w-full px-3 py-3 bg-gray-950 text-white text-sm font-semibold rounded-xl hover:bg-blue-600 cursor-pointer border-none shadow-sm">
                Log in
              </button>
            </form>
          </div>
        </body>
      </html>,
    );
  });

  app.post("/login", async (c) => {
    const body = c.body as Record<string, any>;
    const email = body["email"] as string;
    const password = body["password"] as string;

    const renderError = (message: string) =>
      c.html(
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <title>Login - Lists Admin</title>
            <link rel="stylesheet" href="/static/styles.css" />
            <script src="/static/app.js" defer></script>
          </head>
          <body class="font-sans flex items-center justify-center min-h-screen m-0 p-5">
            <div class="app-surface p-8 rounded-2xl w-full max-w-sm">
              <div class="mx-auto mb-5 grid place-items-center size-11 rounded-xl bg-gray-950 text-white font-bold shadow-sm">L</div>
              <h1 class="m-0 mb-4 text-2xl tracking-tight text-center font-bold">Try that again</h1>
              <p class="text-red-600 text-sm mb-3 text-center">{message}</p>
              <form method="post" action="/admin/login">
                <input
                  type="email"
                  name="email"
                  placeholder="Email"
                  required
                  autofocus
                  class="w-full px-3.5 py-3 border border-gray-200 rounded-xl text-sm font-[inherit] mb-4 shadow-sm focus:outline-none focus:ring-4 focus:ring-blue-100 focus:border-blue-500 box-border"
                />
                <input
                  type="password"
                  name="password"
                  placeholder="Password"
                  required
                  class="w-full px-3.5 py-3 border border-gray-200 rounded-xl text-sm font-[inherit] mb-5 shadow-sm focus:outline-none focus:ring-4 focus:ring-blue-100 focus:border-blue-500 box-border"
                />
                <button type="submit" class="w-full px-3 py-3 bg-gray-950 text-white text-sm font-semibold rounded-xl hover:bg-blue-600 cursor-pointer border-none shadow-sm">
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
    c.cookie.session!.set({
      value: token,
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      maxAge: 86400,
    });
    return c.redirect("/admin/");
  });

  app.post("/logout", (c) => {
    const token = c.cookie.session!.value;
    if (typeof token === "string") {
      destroySession(token);
    }
    c.cookie.session!.remove();
    setFlash(c, "Signed out.");
    return c.redirect("/admin/login");
  });
}
