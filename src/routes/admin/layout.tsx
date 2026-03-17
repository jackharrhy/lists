import { schema } from "../../db";

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
        <style>{`tr:last-child td { border-bottom: none; }`}</style>
      </head>
      <body class="font-sans text-gray-900 bg-gray-50 m-0 p-0 leading-relaxed">
        <nav class="bg-gray-900 py-3 mb-6">
          <div class="max-w-5xl mx-auto px-6 flex items-center gap-4">
            <a href="/admin/" class="text-white font-bold text-base no-underline">
              Lists
            </a>

            {/* Main nav */}
            <div class="flex items-center gap-3 ml-4">
              <a href="/admin/" class="text-gray-400 text-sm no-underline hover:text-white">Dashboard</a>
              <a href="/admin/subscribers" class="text-gray-400 text-sm no-underline hover:text-white">Subscribers</a>
              <a href="/admin/lists" class="text-gray-400 text-sm no-underline hover:text-white">Lists</a>
              <a href="/admin/campaigns" class="text-gray-400 text-sm no-underline hover:text-white">Campaigns</a>
              <a href="/admin/inbound" class="text-gray-400 text-sm no-underline hover:text-white">Inbound</a>
            </div>

            <span class="text-gray-700">|</span>

            {/* Tools */}
            <div class="flex items-center gap-3">
              <a href="/admin/activity" class="text-gray-500 text-xs no-underline hover:text-white">Activity</a>
              <a href="/admin/tags" class="text-gray-500 text-xs no-underline hover:text-white">Tags</a>
              <a href="/admin/import" class="text-gray-500 text-xs no-underline hover:text-white">Import</a>
              {isAdmin && (
                <a href="/admin/users" class="text-gray-500 text-xs no-underline hover:text-white">Users</a>
              )}
            </div>

            {/* User */}
            <div class="flex items-center gap-3 ml-auto">
              <span class="text-gray-500 text-xs">{user?.name ?? user?.email ?? ""}</span>
              <form method="post" action="/admin/logout" class="m-0">
                <button
                  type="submit"
                  class="bg-transparent text-gray-500 border-none cursor-pointer text-xs p-0 hover:text-white"
                >
                  Logout
                </button>
              </form>
            </div>
          </div>
        </nav>
        <div class="max-w-5xl mx-auto px-6 py-4">
          {flash && <div class="bg-green-100 border border-green-300 text-green-800 px-4 py-3 rounded-md mb-4 text-sm">{flash}</div>}
          {children}
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
  return match ? match[1] : addr.trim();
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
