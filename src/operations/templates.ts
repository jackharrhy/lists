import { desc, eq, max } from "drizzle-orm";
import { schema } from "../db";
import { assertScope, AccessDeniedError } from "../services/access";
import { compileTemplate, renderTemplateVersion, type TemplateSource } from "../services/email-templates";
import type { OperationContext } from ".";
import { InvalidOperationError, NotFoundError } from ".";

function versionOutput(version: typeof schema.emailTemplateVersions.$inferSelect) {
  return {
    ...version,
    sections: JSON.parse(version.sections) as TemplateSource["sections"],
    partials: JSON.parse(version.partials) as TemplateSource["partials"],
  };
}

function findTemplate(ctx: OperationContext, slug: string) {
  const template = ctx.db.select().from(schema.emailTemplates).where(eq(schema.emailTemplates.slug, slug)).get();
  if (!template) throw new NotFoundError("Template not found");
  return template;
}

function assertTemplateAuthor(ctx: OperationContext) {
  assertScope(ctx.principal, "templates:write");
  if (ctx.principal.role === "member") throw new AccessDeniedError("Only owners and admins can author templates");
}

export function listTemplates(ctx: OperationContext) {
  assertScope(ctx.principal, "templates:read");
  return ctx.db.select().from(schema.emailTemplates).orderBy(schema.emailTemplates.name).all();
}

export function getTemplate(ctx: OperationContext, slug: string) {
  assertScope(ctx.principal, "templates:read");
  const template = findTemplate(ctx, slug);
  const versions = ctx.db.select().from(schema.emailTemplateVersions)
    .where(eq(schema.emailTemplateVersions.templateId, template.id))
    .orderBy(desc(schema.emailTemplateVersions.version)).all().map(versionOutput);
  return { ...template, versions };
}

function versionValues(ctx: OperationContext, templateId: number, version: number, source: TemplateSource, compiledHtml: string | null) {
  return {
    templateId, version, sourceFormat: source.sourceFormat, subjectSource: source.subjectSource ?? null,
    htmlSource: source.htmlSource ?? null, textSource: source.textSource, compiledHtml,
    sections: JSON.stringify(source.sections), partials: JSON.stringify(source.partials),
    createdBy: ctx.principal.userId,
  };
}

function getTemplateForAuthor(ctx: OperationContext, slug: string) {
  return getTemplate({
    ...ctx,
    principal: { ...ctx.principal, scopes: new Set([...ctx.principal.scopes, "templates:read"]) },
  }, slug);
}

export async function createTemplate(ctx: OperationContext, input: TemplateSource & { slug: string; name: string; description?: string | null }) {
  assertTemplateAuthor(ctx);
  if (ctx.db.select({ id: schema.emailTemplates.id }).from(schema.emailTemplates).where(eq(schema.emailTemplates.slug, input.slug)).get()) {
    throw new InvalidOperationError("Template slug already exists");
  }
  const { slug, name, description, ...source } = input;
  const { compiledHtml } = await compileTemplate(source);
  const now = new Date().toISOString();
  return ctx.db.transaction((tx) => {
    const template = tx.insert(schema.emailTemplates).values({ slug, name, description: description ?? null, createdAt: now, updatedAt: now }).returning().get();
    const version = tx.insert(schema.emailTemplateVersions).values(versionValues(ctx, template.id, 1, source, compiledHtml)).returning().get();
    return { ...template, versions: [versionOutput(version)] };
  });
}

export async function updateTemplate(ctx: OperationContext, input: TemplateSource & { slug: string; name?: string; description?: string | null }) {
  assertTemplateAuthor(ctx);
  const template = findTemplate(ctx, input.slug);
  const { slug: _slug, name, description, ...source } = input;
  const { compiledHtml } = await compileTemplate(source);
  ctx.db.transaction((tx) => {
    const latest = tx.select({ value: max(schema.emailTemplateVersions.version) }).from(schema.emailTemplateVersions)
      .where(eq(schema.emailTemplateVersions.templateId, template.id)).get()?.value ?? 0;
    tx.insert(schema.emailTemplateVersions).values(versionValues(ctx, template.id, latest + 1, source, compiledHtml)).run();
    tx.update(schema.emailTemplates).set({
      ...(name !== undefined ? { name } : {}), ...(description !== undefined ? { description } : {}),
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.emailTemplates.id, template.id)).run();
  });
  return getTemplateForAuthor(ctx, input.slug);
}

export function activateTemplate(ctx: OperationContext, slug: string, versionNumber: number) {
  assertTemplateAuthor(ctx);
  const template = findTemplate(ctx, slug);
  const version = ctx.db.select().from(schema.emailTemplateVersions)
    .where(eq(schema.emailTemplateVersions.templateId, template.id)).all().find((row) => row.version === versionNumber);
  if (!version) throw new NotFoundError("Template version not found");
  ctx.db.update(schema.emailTemplates).set({ status: "active", currentVersionId: version.id, updatedAt: new Date().toISOString() })
    .where(eq(schema.emailTemplates.id, template.id)).run();
  return getTemplateForAuthor(ctx, slug);
}

export function archiveTemplate(ctx: OperationContext, slug: string, confirm: boolean) {
  assertTemplateAuthor(ctx);
  if (!confirm) throw new InvalidOperationError("Archival requires confirm=true");
  const template = findTemplate(ctx, slug);
  if (template.builtIn) throw new InvalidOperationError("Built-in templates cannot be archived");
  const updatedAt = new Date().toISOString();
  ctx.db.update(schema.emailTemplates).set({ status: "archived", updatedAt })
    .where(eq(schema.emailTemplates.id, template.id)).run();
  return { ...template, status: "archived" as const, updatedAt };
}

export async function previewTemplate(ctx: OperationContext, slug: string, versionNumber: number | undefined, sectionSources: Record<string, string>) {
  assertScope(ctx.principal, "templates:read");
  const template = findTemplate(ctx, slug);
  const versions = ctx.db.select().from(schema.emailTemplateVersions).where(eq(schema.emailTemplateVersions.templateId, template.id))
    .orderBy(desc(schema.emailTemplateVersions.version)).all();
  const version = versionNumber ? versions.find((row) => row.version === versionNumber) : versions.find((row) => row.id === template.currentVersionId) ?? versions[0];
  if (!version) throw new NotFoundError("Template version not found");
  const definitions = JSON.parse(version.sections) as TemplateSource["sections"];
  const samples = Object.fromEntries(definitions.map((section) => [section.key, sectionSources[section.key] ?? `Sample ${section.name} content.`]));
  const rendered = await renderTemplateVersion(version, {
    subscriber: { email: "reader@example.com", firstName: "Jane", lastName: "Doe" },
    campaign: { subject: "Template preview" }, list: { name: "Example Newsletter", slug: "example" },
    links: { unsubscribe: "#unsubscribe", preferences: "#preferences" }, sectionSources: samples,
  });
  return { ...rendered, previewUrl: `${ctx.config.baseUrl}/admin/templates/${encodeURIComponent(slug)}/preview?version=${version.version}` };
}

export async function validateTemplateSource(ctx: OperationContext, source: TemplateSource) {
  assertTemplateAuthor(ctx);
  const compiled = await compileTemplate(source);
  return { valid: true as const, compiledHtml: compiled.compiledHtml };
}

export async function duplicateTemplate(ctx: OperationContext, slug: string, newSlug: string, newName?: string) {
  assertTemplateAuthor(ctx);
  const template = findTemplate(ctx, slug);
  const versions = ctx.db.select().from(schema.emailTemplateVersions).where(eq(schema.emailTemplateVersions.templateId, template.id))
    .orderBy(desc(schema.emailTemplateVersions.version)).all();
  const version = versions.find((row) => row.id === template.currentVersionId) ?? versions[0];
  if (!version) throw new NotFoundError("Template version not found");
  return createTemplate(ctx, {
    slug: newSlug, name: newName ?? `${template.name} copy`, description: template.description,
    sourceFormat: version.sourceFormat, subjectSource: version.subjectSource, htmlSource: version.htmlSource,
    textSource: version.textSource, sections: JSON.parse(version.sections), partials: JSON.parse(version.partials),
  });
}
