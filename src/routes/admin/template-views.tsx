import { Html } from "@elysia/html";
import type { schema } from "../../db";
import type { TemplateSection } from "../../services/email-templates";
import { AdminLayout, fmtDateTime, type User } from "./layout";

type Template = typeof schema.emailTemplates.$inferSelect;

function StatusBadge({ status }: { status: Template["status"] }) {
  const color = status === "active" ? "bg-green-50 text-green-700 border-green-200" : "bg-gray-100 text-gray-500 border-gray-200";
  return <span class={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${color}`}>{status}</span>;
}

function FormatBadge({ format }: { format: Template["sourceFormat"] }) {
  return <span class="inline-flex rounded border border-gray-200 bg-white px-1.5 py-0.5 font-mono text-[10px] uppercase text-gray-500">{format}</span>;
}

export function TemplateGalleryPage({ user, templates }: { user: User; templates: Template[] }) {
  const active = templates.filter((template) => template.status === "active").length;
  return <AdminLayout title="Email Templates" user={user}>
    <div class="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div><p class="mb-1 text-xs font-medium uppercase tracking-[0.16em] text-gray-400">Email design</p><h1 class="m-0 text-3xl font-semibold tracking-tight">Templates</h1><p class="mb-0 mt-2 max-w-2xl text-sm text-gray-600">Inspect the HTML and text layouts available to campaigns. Templates are authored through MCP or the API.</p></div>
      <div class="flex gap-5 text-right text-xs text-gray-500"><div><strong class="block text-2xl font-semibold text-gray-900">{templates.length}</strong>total</div><div><strong class="block text-2xl font-semibold text-gray-900">{active}</strong>active</div></div>
    </div>
    <div class="grid grid-cols-1 gap-5 lg:grid-cols-2">
      {templates.map((template) => {
        const sections = JSON.parse(template.sections) as TemplateSection[];
        return <a href={`/admin/templates/${template.slug}`} class="group overflow-hidden rounded-xl border border-gray-200 bg-white text-inherit no-underline shadow-sm transition hover:border-gray-300 hover:shadow-md">
          <div class="relative h-64 overflow-hidden border-b border-gray-100 bg-gray-100 p-3"><iframe title={`${template.name} preview`} sandbox="" tabindex="-1" src={`/admin/templates/${template.slug}/preview`} class="pointer-events-none h-[520px] w-full origin-top scale-[0.48] rounded bg-white shadow-sm" style="width:208%;" /><div class="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-gray-100 to-transparent"></div></div>
          <div class="p-5"><div class="flex items-start justify-between gap-3"><div><h2 class="m-0 text-lg font-semibold group-hover:text-blue-700">{template.name}</h2><code class="text-xs text-gray-400">{template.slug}</code></div><div class="flex items-center gap-2"><StatusBadge status={template.status} /><FormatBadge format={template.sourceFormat} /></div></div><p class="mb-4 mt-3 min-h-10 text-sm leading-5 text-gray-600">{template.description ?? "No description provided."}</p><div class="flex items-center gap-3 border-t border-gray-100 pt-3 text-xs text-gray-400"><span>{sections.length} section{sections.length === 1 ? "" : "s"}</span>{template.builtIn && <><span>·</span><span>built in</span></>}<span class="ml-auto text-blue-600 opacity-0 transition group-hover:opacity-100">Inspect →</span></div></div>
        </a>;
      })}
    </div>
  </AdminLayout>;
}

export function TemplateWorkspacePage({ user, template }: { user: User; template: Template }) {
  const sections = JSON.parse(template.sections) as TemplateSection[];
  const partials = JSON.parse(template.partials) as Record<string, string>;
  const previewPath = `/admin/templates/${template.slug}/preview`;
  return <AdminLayout title={template.name} user={user}>
    <a href="/admin/templates" class="text-xs text-gray-500 no-underline hover:text-gray-900">← All templates</a>
    <div class="mb-6 mt-3 flex flex-wrap items-start justify-between gap-4"><div><div class="mb-2 flex items-center gap-2"><StatusBadge status={template.status} /><FormatBadge format={template.sourceFormat} />{template.builtIn && <span class="text-xs text-gray-400">built in</span>}</div><h1 class="m-0 text-3xl font-semibold tracking-tight">{template.name}</h1><p class="mb-0 mt-2 text-sm text-gray-600">{template.description ?? "No description provided."}</p></div><div class="text-right"><code class="block text-sm text-gray-500">{template.slug}</code><span class="text-xs text-gray-400">Updated {fmtDateTime(template.updatedAt)}</span></div></div>
    <section data-template-preview-workspace data-preview-base={previewPath} class="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm"><div class="flex flex-wrap items-center gap-2 border-b border-gray-200 px-4 py-3"><strong class="mr-2 text-sm">Preview</strong><button type="button" data-preview-mode="html" class="rounded bg-gray-900 px-2.5 py-1 text-xs text-white">HTML</button><button type="button" data-preview-mode="text" class="rounded px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-100">Text</button><span class="mx-1 h-4 border-l border-gray-200"></span>{[375, 600, 800].map((width) => <button type="button" data-preview-width={String(width)} class="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100">{width}</button>)}<button type="button" data-preview-width="full" class="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100">full</button><label class="ml-auto flex cursor-pointer items-center gap-2 text-xs text-gray-500"><input type="checkbox" data-preview-remote /> Load remote assets</label></div><div class="flex min-h-[680px] justify-center overflow-auto bg-gray-100 p-5"><iframe title={`${template.name} preview`} sandbox="" data-template-preview-frame src={previewPath} class="min-h-[640px] w-full border-0 bg-white shadow-sm transition-[width]" /></div></section>
    <section class="mt-6 rounded-xl border border-gray-200 bg-white p-5"><h2 class="mt-0 text-lg font-semibold">Content contract</h2><p class="text-sm text-gray-500">Campaigns using this template provide these named sections.</p><div class="overflow-x-auto"><table class="w-full text-sm"><thead><tr class="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-400"><th class="py-2">Section</th><th>Format</th><th>Required</th></tr></thead><tbody>{sections.map((section) => <tr class="border-b border-gray-100"><td class="py-3"><code>{section.key}</code><span class="ml-2 text-gray-500">{section.name}</span></td><td>{section.format}</td><td>{section.required ? "yes" : "no"}</td></tr>)}</tbody></table></div></section>
    <section class="mt-6 space-y-3"><details class="rounded-xl border border-gray-200 bg-white" open><summary class="cursor-pointer px-5 py-4 text-sm font-semibold">{template.sourceFormat.toUpperCase()} source</summary><pre safe class="m-0 max-h-[600px] overflow-auto border-t border-gray-100 bg-gray-950 p-5 text-xs leading-5 text-gray-100">{template.htmlSource ?? "(text only)"}</pre></details><details class="rounded-xl border border-gray-200 bg-white"><summary class="cursor-pointer px-5 py-4 text-sm font-semibold">Plain-text source</summary><pre safe class="m-0 max-h-[600px] overflow-auto border-t border-gray-100 bg-gray-950 p-5 text-xs leading-5 text-gray-100">{template.textSource}</pre></details>{Object.entries(partials).map(([name, source]) => <details class="rounded-xl border border-gray-200 bg-white"><summary class="cursor-pointer px-5 py-4 text-sm font-semibold">Partial: <code>{name}</code></summary><pre safe class="m-0 max-h-[600px] overflow-auto border-t border-gray-100 bg-gray-950 p-5 text-xs leading-5 text-gray-100">{source}</pre></details>)}</section>
  </AdminLayout>;
}
