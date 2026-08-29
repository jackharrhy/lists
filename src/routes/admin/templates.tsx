import { Html } from "@elysia/html";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { App } from "../../http";
import type { Db } from "../../db";
import { schema } from "../../db";
import type { Config } from "../../config";
import { ensureBuiltInTemplate, renderTemplateVersion, type TemplateSection } from "../../services/email-templates";
import { AdminLayout, fmtDateTime, getFlash, type User } from "./layout";
import { Card, PageHeader, Table, Td, Th } from "./ui";

const slugParams = z.object({ slug: z.string().min(1) });
const previewQuery = z.object({
  version: z.coerce.number().int().positive().optional(),
  remote: z.enum(["0", "1"]).default("0"),
});

export function mountTemplateRoutes(app: App, db: Db, config: Config) {
  app.get("/templates", (c) => {
    const user = c.user as User;
    ensureBuiltInTemplate(db);
    const templates = db.select().from(schema.emailTemplates).orderBy(schema.emailTemplates.name).all();
    return c.html(<AdminLayout title="Email Templates" user={user} flash={getFlash(c)}>
      <PageHeader title="Email Templates" />
      <p class="text-sm text-gray-600 mb-5">Templates are authored through the API or MCP. This area previews immutable versions used by campaigns.</p>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        {templates.map((template) => <Card>
          <div class="flex justify-between gap-3 items-start">
            <div><a class="font-semibold text-blue-700" href={`/admin/templates/${template.slug}`}>{template.name}</a><p class="text-sm text-gray-500 mt-1">{template.description ?? "No description"}</p></div>
            <span class="text-xs text-gray-500">{template.status}</span>
          </div>
          <p class="text-xs text-gray-400 mb-0">{template.slug}{template.builtIn ? " · built in" : ""}</p>
        </Card>)}
      </div>
    </AdminLayout>);
  });

  app.get("/templates/:slug", (c) => {
    const user = c.user as User;
    ensureBuiltInTemplate(db);
    const template = db.select().from(schema.emailTemplates).where(eq(schema.emailTemplates.slug, c.params.slug)).get();
    if (!template) return c.notFound();
    const versions = db.select().from(schema.emailTemplateVersions).where(eq(schema.emailTemplateVersions.templateId, template.id))
      .orderBy(desc(schema.emailTemplateVersions.version)).all();
    const selected = c.query.version ? versions.find((version) => version.version === Number(c.query.version)) : versions.find((version) => version.id === template.currentVersionId) ?? versions[0];
    if (!selected) return c.notFound();
    const sections = JSON.parse(selected.sections) as TemplateSection[];
    const partials = JSON.parse(selected.partials) as Record<string, string>;
    const previewPath = `/admin/templates/${template.slug}/preview?version=${selected.version}`;
    return c.html(<AdminLayout title={template.name} user={user} flash={getFlash(c)}>
      <PageHeader title={template.name} />
      <p class="text-sm text-gray-600">{template.description ?? "No description"}</p>
      <div class="flex gap-2 mb-4 flex-wrap">{versions.map((version) => <a href={`/admin/templates/${template.slug}?version=${version.version}`} class={`text-sm px-2 py-1 border rounded no-underline ${version.id === selected.id ? "bg-gray-900 text-white" : "bg-white text-gray-700"}`}>v{version.version}</a>)}</div>
      <div class="flex gap-2 mb-3"><a href={previewPath} target="_blank" class="text-sm text-blue-700">Open isolated preview</a><span class="text-gray-300">·</span><a href={`${previewPath}&remote=1`} target="_blank" class="text-sm text-amber-700">Preview with remote assets</a></div>
      <iframe sandbox="" src={previewPath} class="w-full bg-white border border-gray-200 rounded mb-6" style="min-height:600px" />
      <h2 class="text-lg font-semibold">Sections</h2>
      <Table><thead><tr><Th>Key</Th><Th>Name</Th><Th>Format</Th><Th>Required</Th></tr></thead><tbody>{sections.map((section) => <tr><Td><code>{section.key}</code></Td><Td>{section.name}</Td><Td>{section.format}</Td><Td>{section.required ? "yes" : "no"}</Td></tr>)}</tbody></Table>
      <h2 class="text-lg font-semibold">Source</h2>
      <p class="text-xs text-gray-500">{selected.sourceFormat.toUpperCase()} · created {fmtDateTime(selected.createdAt)}</p>
      <pre class="text-xs overflow-auto bg-gray-950 text-gray-100 p-4 rounded whitespace-pre-wrap">{selected.htmlSource ?? "(text only)"}</pre>
      <h2 class="text-lg font-semibold">Text source</h2><pre class="text-xs overflow-auto bg-gray-950 text-gray-100 p-4 rounded whitespace-pre-wrap">{selected.textSource}</pre>
      {Object.keys(partials).length > 0 && <><h2 class="text-lg font-semibold">Partials</h2>{Object.entries(partials).map(([name, source]) => <div><h3 class="text-sm"><code>{name}</code></h3><pre class="text-xs overflow-auto bg-gray-950 text-gray-100 p-4 rounded whitespace-pre-wrap">{source}</pre></div>)}</>}
    </AdminLayout>);
  }, { params: slugParams, query: z.object({ version: z.coerce.number().int().positive().optional() }) });

  app.get("/templates/:slug/preview", async (c) => {
    ensureBuiltInTemplate(db);
    const template = db.select().from(schema.emailTemplates).where(eq(schema.emailTemplates.slug, c.params.slug)).get();
    if (!template) return c.notFound();
    const versions = db.select().from(schema.emailTemplateVersions).where(eq(schema.emailTemplateVersions.templateId, template.id)).all();
    const version = c.query.version ? versions.find((row) => row.version === c.query.version) : versions.find((row) => row.id === template.currentVersionId);
    if (!version) return c.notFound();
    const definitions = JSON.parse(version.sections) as TemplateSection[];
    const sectionSources = Object.fromEntries(definitions.map((section) => [section.key, section.format === "html" ? `<h1>${section.name}</h1><p>A representative HTML section.</p>` : `# ${section.name}\n\nA representative section rendered with **sample content**.`]));
    const rendered = await renderTemplateVersion(version, {
      subscriber: { email: "reader@example.com", firstName: "Jane", lastName: "Doe" }, campaign: { subject: "Template preview" },
      list: { name: "Example Newsletter", slug: "example" }, links: { unsubscribe: "#unsubscribe", preferences: "#preferences" }, sectionSources,
    });
    if (!rendered.html) return new Response(`<pre>${rendered.text.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</pre>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" } });
    const assets = c.query.remote === "1"
      ? "style-src 'unsafe-inline' https:; img-src https: data: cid:; font-src https: data:;"
      : "style-src 'unsafe-inline'; img-src data: cid:; font-src data:;";
    return new Response(rendered.html, { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": `default-src 'none'; ${assets}` } });
  }, { params: slugParams, query: previewQuery });
}
