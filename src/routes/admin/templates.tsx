import { desc, eq } from "drizzle-orm";
import { Html } from "@elysia/html";
import { z } from "zod";
import type { App } from "../../http";
import type { Db } from "../../db";
import { schema } from "../../db";
import { renderTemplateVersion, type TemplateSection } from "../../services/email-templates";
import type { User } from "./layout";
import { TemplateGalleryPage, TemplateWorkspacePage, type TemplateCard } from "./template-views";

const slugParams = z.object({ slug: z.string().min(1) });
const detailQuery = z.object({ version: z.coerce.number().int().positive().optional() });
const previewQuery = detailQuery.extend({
  remote: z.enum(["0", "1"]).default("0"),
  mode: z.enum(["html", "text"]).default("html"),
});

function templateCards(db: Db): TemplateCard[] {
  return db.select().from(schema.emailTemplates).orderBy(schema.emailTemplates.name).all().map((template) => {
    const version = template.currentVersionId
      ? db.select().from(schema.emailTemplateVersions).where(eq(schema.emailTemplateVersions.id, template.currentVersionId)).get() ?? null
      : db.select().from(schema.emailTemplateVersions).where(eq(schema.emailTemplateVersions.templateId, template.id))
          .orderBy(desc(schema.emailTemplateVersions.version)).limit(1).get() ?? null;
    return { template, version, sections: version ? JSON.parse(version.sections) as TemplateSection[] : [] };
  });
}

function findTemplateWorkspace(db: Db, slug: string, requestedVersion?: number) {
  const template = db.select().from(schema.emailTemplates).where(eq(schema.emailTemplates.slug, slug)).get();
  if (!template) return null;
  const versions = db.select().from(schema.emailTemplateVersions).where(eq(schema.emailTemplateVersions.templateId, template.id))
    .orderBy(desc(schema.emailTemplateVersions.version)).all();
  const selected = requestedVersion
    ? versions.find((version) => version.version === requestedVersion)
    : versions.find((version) => version.id === template.currentVersionId) ?? versions[0];
  return selected ? { template, versions, selected } : null;
}

function textDocument(text: string) {
  const escaped = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:28px;font:14px/1.6 ui-monospace,monospace;color:#222}pre{white-space:pre-wrap}</style><pre>${escaped}</pre>`;
}

export function mountTemplateRoutes(app: App, db: Db) {
  app.get("/templates", (c) => c.html(
    <TemplateGalleryPage user={c.user as User} cards={templateCards(db)} />,
  ));

  app.get("/templates/:slug", (c) => {
    const workspace = findTemplateWorkspace(db, c.params.slug, c.query.version);
    if (!workspace) return c.notFound();
    return c.html(<TemplateWorkspacePage user={c.user as User} {...workspace} />);
  }, { params: slugParams, query: detailQuery });

  app.get("/templates/:slug/preview", async (c) => {
    const workspace = findTemplateWorkspace(db, c.params.slug, c.query.version);
    if (!workspace) return c.notFound();
    const definitions = JSON.parse(workspace.selected.sections) as TemplateSection[];
    const sectionSources = Object.fromEntries(definitions.map((section) => [
      section.key,
      section.format === "html"
        ? `<h1>${section.name}</h1><p>A representative HTML section with <strong>sample content</strong>.</p>`
        : section.format === "markdown"
          ? `# ${section.name}\n\nA representative section rendered with **sample content**.`
          : `${section.name}\n\nA representative plain-text section.`,
    ]));
    const rendered = await renderTemplateVersion(workspace.selected, {
      subscriber: { email: "reader@example.com", firstName: "Jane", lastName: "Doe" },
      campaign: { subject: "Template preview" },
      list: { name: "Example Newsletter", slug: "example" },
      links: { unsubscribe: "#unsubscribe", preferences: "#preferences" },
      sectionSources,
    });
    const body = c.query.mode === "text" || !rendered.html ? textDocument(rendered.text) : rendered.html;
    const assets = c.query.remote === "1"
      ? "style-src 'unsafe-inline' https:; img-src https: data: cid:; font-src https: data:;"
      : "style-src 'unsafe-inline'; img-src data: cid:; font-src data:;";
    return new Response(body, { headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; ${assets}`,
    } });
  }, { params: slugParams, query: previewQuery });
}
