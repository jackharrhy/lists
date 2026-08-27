import { Html } from "@elysia/html";
import { schema } from "../../db";

// ---------------------------------------------------------------------------
// Flash helpers
// ---------------------------------------------------------------------------

export function setFlash(c: any, message: string) {
  c.cookie.flash.set({
    value: encodeURIComponent(message),
    path: "/",
    httpOnly: true,
    maxAge: 10,
    sameSite: "lax",
  });
}

export function getFlash(c: any): string | undefined {
  const val = c.cookie.flash.value;
  if (typeof val === "string") {
    c.cookie.flash.remove();
    return decodeURIComponent(val);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Layout & components
// ---------------------------------------------------------------------------

export type User = typeof schema.users.$inferSelect;

export function AdminLayout({
  title,
  children,
  flash,
  user,
}: {
  title: string;
  children: any;
  flash?: string;
  user?: User;
}) {
  const isAdmin = user?.role === "owner" || user?.role === "admin";
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title} - Lists Admin</title>
        <link rel="stylesheet" href="/static/styles.css" />
        <script src="/static/app.js" defer></script>
      </head>
      <body
        class="font-sans text-gray-900 m-0 p-0 leading-relaxed"
        hx-boost="true"
        hx-target="#app-shell"
        hx-select="#app-shell"
        hx-swap="outerHTML transition:true"
        hx-push-url="true"
        hx-indicator="#global-progress"
      >
        <div id="global-progress" class="htmx-indicator" role="progressbar" aria-label="Loading"></div>
        <div id="app-shell">
          <nav class="sticky top-0 z-40 border-b border-gray-200/80 bg-white/80 backdrop-blur-xl">
            <div class="max-w-7xl mx-auto px-4 sm:px-6 min-h-16 flex items-center gap-3 flex-wrap py-2">
              <a href="/admin/" class="group flex items-center gap-2.5 text-gray-950 font-bold text-base no-underline mr-2">
                <span class="grid place-items-center size-9 rounded-xl bg-gray-950 text-white shadow-sm group-hover:bg-blue-600">L</span>
                <span>lists</span>
              </a>
              <div class="flex items-center gap-0.5 flex-wrap">
                <a href="/admin/" class="nav-link">Overview</a>
                <a href="/admin/subscribers" class="nav-link">Subscribers</a>
                <a href="/admin/lists" class="nav-link">Lists</a>
                <a href="/admin/campaigns" class="nav-link">Campaigns</a>
                <a href="/admin/inbound" class="nav-link">Inbox</a>
              </div>
              <details class="relative ml-auto group">
                <summary class="list-none flex items-center gap-2 cursor-pointer rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-gray-700 hover:border-gray-300 hover:shadow-sm">
                  <span class="grid place-items-center size-6 rounded-full bg-blue-100 text-blue-700">{(user?.name ?? user?.email ?? "U").slice(0, 1).toUpperCase()}</span>
                  <span class="hidden sm:inline max-w-32 truncate">{user?.name ?? user?.email ?? "Account"}</span>
                  <span class="text-gray-400">⌄</span>
                </summary>
                <div class="absolute right-0 mt-2 w-48 rounded-xl border border-gray-200 bg-white p-2 shadow-lift z-50">
                  <a href="/admin/activity" class="nav-link w-full">Activity</a>
                  <a href="/admin/tags" class="nav-link w-full">Tags</a>
                  <a href="/admin/import" class="nav-link w-full">Import</a>
                  {isAdmin && <a href="/admin/users" class="nav-link w-full">Users</a>}
                  <a href="/design" class="nav-link w-full">Design system</a>
                  <div class="border-t border-gray-100 mt-1 pt-1">
                    <form method="post" action="/admin/logout" class="m-0">
                      <button type="submit" class="nav-link w-full border-none bg-transparent cursor-pointer text-left">Sign out</button>
                    </form>
                  </div>
                </div>
              </details>
            </div>
          </nav>
          <main class="max-w-7xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
            {flash && (
              <div id="flash-msg" class="app-surface border-green-100 text-green-800 px-4 py-3 rounded-xl mb-6 text-sm font-medium flex items-center justify-between" role="status">
                <span class="flex items-center gap-2"><span class="size-2 rounded-full bg-green-600"></span>{flash}</span>
                <button onclick="this.closest('#flash-msg').remove()" type="button" class="bg-transparent text-green-700 border-none cursor-pointer text-lg leading-none p-1 ml-2" aria-label="Dismiss">&times;</button>
              </div>
            )}
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}

export function displayName(sub: { firstName?: string | null; lastName?: string | null }): string {
  return [sub.firstName, sub.lastName].filter(Boolean).join(" ") || "\u2014";
}

export function extractEmail(addr: string): string {
  const match = addr.match(/<([^>]+)>/);
  return match?.[1] ?? addr.trim();
}

export function VerdictChips({ spf, dkim, dmarc }: { spf?: string | null; dkim?: string | null; dmarc?: string | null }) {
  const chip = (label: string, value?: string | null) => {
    if (!value) return null;
    const pass = value === "PASS";
    return (
      <span class={`text-[10px] font-medium ${pass ? "text-green-600" : "text-red-600"}`}>
        {label}{pass ? "\u2713" : "\u2717"}
      </span>
    );
  };
  return (
    <span class="flex items-center gap-1.5">
      {chip("SPF", spf)}
      {chip("DKIM", dkim)}
      {chip("DMARC", dmarc)}
    </span>
  );
}

export function CampaignBadge({ status }: { status: string }) {
  const base = "inline-block px-2.5 py-0.5 rounded-full text-xs font-medium";
  const cls =
    status === "draft"
      ? `${base} bg-amber-100 text-amber-800`
      : status === "sending"
        ? `${base} bg-blue-100 text-blue-800`
        : status === "failed"
          ? `${base} bg-red-100 text-red-800`
          : status === "scheduled"
            ? `${base} bg-purple-100 text-purple-800`
            : `${base} bg-green-100 text-green-800`;
  return <span class={cls}>{status}</span>;
}

export function fmtDate(d: string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-CA");
}

export function fmtDateTime(d: string | null): string {
  if (!d) return "—";
  const dt = new Date(d);
  return `${dt.toLocaleDateString("en-CA")} ${dt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

export function describeAudience(campaign: { audienceType: string; audienceId: number | null; audienceData: string | null }, lists: Map<number, string>, tags: Map<number, string>): string {
  if (campaign.audienceType === "list") return lists.get(campaign.audienceId!) ?? "Unknown list";
  if (campaign.audienceType === "all") return "All subscribers";
  if (campaign.audienceType === "tag") return `Tag: ${tags.get(campaign.audienceId!) ?? "Unknown"}`;
  if (campaign.audienceType === "subscribers") {
    const ids = campaign.audienceData ? JSON.parse(campaign.audienceData) as number[] : [];
    return `${ids.length} specific`;
  }
  return "Unknown";
}
