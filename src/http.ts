import { Elysia } from "elysia";

export type HttpUser = {
  id: number;
  email: string;
  name: string | null;
  passwordHash: string;
  role: "owner" | "admin" | "member";
  createdAt: string;
};

export function createHttpApp() {
  const app = new Elysia()
    .onError(({ error }) => {
      console.error(error);
    })
    .derive(() => ({
      user: null as HttpUser | null,
    }))
    .decorate({
      html: (body: unknown, status = 200) => new Response(String(body), {
        status,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      text: (body: string, status = 200) => new Response(body, { status }),
      json: (body: unknown, status = 200) => Response.json(body, { status }),
      notFound: () => new Response("Not Found", { status: 404 }),
    });

  return Object.assign(app, {
    request: (path: string, init?: RequestInit) =>
      app.handle(new Request(new URL(path, "http://localhost"), init)),
  });
}

export type App = ReturnType<typeof createHttpApp>;
