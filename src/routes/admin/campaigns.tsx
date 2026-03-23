import { Hono } from "hono";
import { z } from "zod";
import { eq, desc, and, inArray, like, sql } from "drizzle-orm";
import { marked } from "marked";
import type { Db } from "../../db";
import { schema } from "../../db";
import type { Config } from "../../config";
import { getAccessibleListIds } from "../../auth";
import { sendCampaign, substituteVariables } from "../../services/sender";
import { renderNewsletter } from "../../../emails/render";
import { buildUnsubscribeUrl, buildPreferencesUrl } from "../../compliance";
import { logEvent } from "../../services/events";
import { getConfirmedSubscribers } from "../../services/subscriber";
import { processImage, processPendingS3Images, deleteCampaignS3Images } from "../../services/images";
import { AdminLayout, fmtDate, fmtDateTime, CampaignBadge, describeAudience, setFlash, getFlash, type User } from "./layout";
import { Button, LinkButton, Input, Select, Textarea, Label, FormGroup, Table, Th, Td, Card, PageHeader } from "./ui";

const CAMPAIGNS_PAGE_SIZE = 25;

export function mountCampaignRoutes(app: Hono, db: Db, config: Config) {
  // ---- Preview endpoints (raw HTML, no AdminLayout) -----------------------

  app.get("/campaigns/:id/preview", async (c) => {
    const id = Number(c.req.param("id"));
    const campaign = db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id)).get();
    if (!campaign) return c.notFound();

    let listName = "Newsletter";
    if (campaign.audienceType === "list" && campaign.audienceId) {
      const list = db.select().from(schema.lists).where(eq(schema.lists.id, campaign.audienceId)).get();
      if (list) {
        listName = list.name;
      }
    }

    let unsubscribeUrl = "#unsubscribe";
    let preferencesUrl = "#preferences";
    let subData: { firstName?: string | null; lastName?: string | null; email: string } = {
      firstName: "Jane",
      lastName: "Doe",
      email: "subscriber@example.com",
    };

    const subscriberId = c.req.query("subscriberId");
    if (subscriberId) {
      const sub = db.select().from(schema.subscribers).where(eq(schema.subscribers.id, Number(subscriberId))).get();
      if (sub) {
        unsubscribeUrl = buildUnsubscribeUrl(config.baseUrl, sub.unsubscribeToken, (campaign.audienceType === "list" ? campaign.audienceId : undefined) ?? undefined);
        preferencesUrl = buildPreferencesUrl(config.baseUrl, sub.unsubscribeToken);
        subData = { firstName: sub.firstName, lastName: sub.lastName, email: sub.email };
      }
    }

    const substitutedMarkdown = substituteVariables(
      campaign.bodyMarkdown,
      subData,
      { unsubscribeUrl, preferencesUrl },
    );
    const contentHtml = await marked(substitutedMarkdown);
    const { html } = await renderNewsletter({
      subject: campaign.subject,
      contentHtml,
      listName,
      unsubscribeUrl,
      preferencesUrl,
    });

    return c.html(html);
  });

  const CampaignPreviewSchema = z.object({
    bodyMarkdown: z.string().default(""),
    subject: z.string().default("Preview"),
    listName: z.string().default("Newsletter"),
  });

  app.post("/campaigns/preview", async (c) => {
    const raw = await c.req.json().catch(() => ({}));
    const parsed = CampaignPreviewSchema.safeParse(raw);
    if (!parsed.success) return c.text("Bad Request", 400);
    const { bodyMarkdown, subject, listName } = parsed.data;
    const substitutedMarkdown = substituteVariables(
      bodyMarkdown || "",
      { firstName: "Jane", lastName: "Doe", email: "subscriber@example.com" },
      { unsubscribeUrl: "#unsubscribe", preferencesUrl: "#preferences" },
    );
    const contentHtml = await marked(substitutedMarkdown);
    const { html } = await renderNewsletter({
      subject: subject || "Preview",
      contentHtml,
      listName: listName || "Newsletter",
      unsubscribeUrl: "#unsubscribe",
      preferencesUrl: "#preferences",
    });

    return c.html(html);
  });

  app.post("/campaigns/upload-image", async (c) => {
    const body = await c.req.parseBody();
    const file = body["image"];
    if (!file || typeof file === "string") {
      return c.json({ error: "No image provided" }, 400);
    }

    const originalSize = file.size;
    const buf = await file.arrayBuffer();

    try {
      const processed = await processImage(buf);
      return c.json({
        dataUri: processed.dataUri,
        sizeBytes: processed.sizeBytes,
        originalSizeBytes: originalSize,
        width: processed.width,
        height: processed.height,
        mimeType: processed.mimeType,
      });
    } catch (err) {
      return c.json({ error: "Failed to process image" }, 400);
    }
  });

  // Campaigns
  app.get("/campaigns", (c) => {
    const user = c.get("user") as User;
    const flash = getFlash(c);
    const listAccess = getAccessibleListIds(db, user);

    // Query params
    const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10) || 1);
    const offset = (page - 1) * CAMPAIGNS_PAGE_SIZE;
    const filterStatus = c.req.query("status") ?? "";
    const filterSearch = c.req.query("search") ?? "";

    // Build where conditions
    const filterConditions = [];
    if (filterStatus && ["draft", "sending", "sent", "failed", "scheduled"].includes(filterStatus)) {
      filterConditions.push(eq(schema.campaigns.status, filterStatus as any));
    }
    if (filterSearch) {
      filterConditions.push(like(schema.campaigns.subject, `%${filterSearch}%`));
    }

    let campaigns: (typeof schema.campaigns.$inferSelect)[];
    let total = 0;

    if (listAccess === "all") {
      const conditions = filterConditions.length > 0 ? and(...filterConditions) : undefined;
      const countRow = db
        .select({ count: sql<number>`count(*)` })
        .from(schema.campaigns)
        .where(conditions)
        .get()!;
      total = countRow.count;

      const q = db.select().from(schema.campaigns).orderBy(desc(schema.campaigns.createdAt));
      campaigns = (conditions ? q.where(conditions) : q)
        .limit(CAMPAIGNS_PAGE_SIZE)
        .offset(offset)
        .all();
    } else if (listAccess.length === 0) {
      campaigns = [];
      total = 0;
    } else {
      const accessCond = and(eq(schema.campaigns.audienceType, "list"), inArray(schema.campaigns.audienceId, listAccess));
      const conditions = filterConditions.length > 0 ? and(accessCond, ...filterConditions) : accessCond;
      const countRow = db
        .select({ count: sql<number>`count(*)` })
        .from(schema.campaigns)
        .where(conditions)
        .get()!;
      total = countRow.count;

      campaigns = db
        .select()
        .from(schema.campaigns)
        .where(conditions)
        .orderBy(desc(schema.campaigns.createdAt))
        .limit(CAMPAIGNS_PAGE_SIZE)
        .offset(offset)
        .all();
    }

    const totalPages = Math.max(1, Math.ceil(total / CAMPAIGNS_PAGE_SIZE));

    // Build lookup maps for list and tag names
    const allLists = db.select().from(schema.lists).all();
    const listNameMap = new Map(allLists.map((l) => [l.id, l.name]));
    const allTags = db.select().from(schema.tags).all();
    const tagNameMap = new Map(allTags.map((t) => [t.id, t.name]));

    function buildUrl(params: Record<string, string | number>) {
      const q = new URLSearchParams({
        ...(filterStatus ? { status: filterStatus } : {}),
        ...(filterSearch ? { search: filterSearch } : {}),
        page: String(page),
        ...params,
      });
      return `/admin/campaigns?${q.toString()}`;
    }

    const CAMPAIGN_STATUSES = [
      { value: "", label: "All" },
      { value: "draft", label: "Draft" },
      { value: "scheduled", label: "Scheduled" },
      { value: "sending", label: "Sending" },
      { value: "sent", label: "Sent" },
      { value: "failed", label: "Failed" },
    ];

    return c.html(
      <AdminLayout title="Campaigns" user={user} flash={flash}>
        <PageHeader title="Campaigns">
          <LinkButton href="/admin/campaigns/new">New Campaign</LinkButton>
        </PageHeader>

        {/* Filters */}
        <form method="get" action="/admin/campaigns" class="flex items-end gap-3 mb-6 flex-wrap">
          <div>
            <label class="block text-xs font-medium text-gray-500 mb-1">Status</label>
            <Select name="status" size="sm">
              {CAMPAIGN_STATUSES.map((s) => (
                <option value={s.value} selected={filterStatus === s.value}>{s.label}</option>
              ))}
            </Select>
          </div>
          <div>
            <label class="block text-xs font-medium text-gray-500 mb-1">Search</label>
            <Input type="text" name="search" size="sm" value={filterSearch} placeholder="Subject…" class="w-48" />
          </div>
          <input type="hidden" name="page" value="1" />
          <Button type="submit" size="filter">Filter</Button>
          {(filterStatus || filterSearch) && (
            <a href="/admin/campaigns" class="text-sm text-gray-500 hover:text-gray-700 no-underline">Clear</a>
          )}
        </form>

        <Table>
          <thead>
            <tr>
              <Th>Subject</Th>
              <Th>Audience</Th>
              <Th>From</Th>
              <Th>Status</Th>
              <Th>Created</Th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map((cam) => (
              <tr>
                <Td>
                  <a href={`/admin/campaigns/${cam.id}`} class="text-blue-600 hover:text-blue-800">{cam.subject}</a>
                </Td>
                <Td>{describeAudience(cam, listNameMap, tagNameMap)}</Td>
                <Td>{cam.fromAddress}</Td>
                 <Td>
                   <CampaignBadge status={cam.status} />
                   {cam.status === "scheduled" && cam.scheduledAt && (
                     <span class="ml-2 text-xs text-gray-500">{fmtDateTime(cam.scheduledAt)}</span>
                   )}
                 </Td>
                <Td>{fmtDate(cam.createdAt)}</Td>
              </tr>
            ))}
            {campaigns.length === 0 && (
              <tr>
                <Td class="text-gray-400" colspan="5">No campaigns found.</Td>
              </tr>
            )}
          </tbody>
        </Table>

        {/* Pagination */}
        {(page > 1 || total > CAMPAIGNS_PAGE_SIZE) && (
          <div class="flex items-center justify-between mt-2 pt-4 border-t border-gray-100">
            <div>
              {page > 1
                ? <LinkButton href={buildUrl({ page: page - 1 })} variant="secondary" size="sm">← Previous</LinkButton>
                : <span />
              }
            </div>
            <span class="text-xs text-gray-400">
              {total} campaign{total !== 1 ? "s" : ""} &middot; page {page} of {totalPages}
            </span>
            <div>
              {page < totalPages && <LinkButton href={buildUrl({ page: page + 1 })} variant="secondary" size="sm">Next →</LinkButton>}
            </div>
          </div>
        )}
      </AdminLayout>,
    );
  });

  app.get("/campaigns/new", (c) => {
    const user = c.get("user") as User;
    const flash = getFlash(c);
    const listAccess = getAccessibleListIds(db, user);

    let allLists: (typeof schema.lists.$inferSelect)[];
    if (listAccess === "all") {
      allLists = db.select().from(schema.lists).all();
    } else if (listAccess.length === 0) {
      allLists = [];
    } else {
      allLists = db.select().from(schema.lists).where(inArray(schema.lists.id, listAccess)).all();
    }

    const allTags = db.select().from(schema.tags).all();
    const allSubscribers = db.select().from(schema.subscribers).where(eq(schema.subscribers.status, "active")).all();

    return c.html(
      <AdminLayout title="New Campaign" user={user} flash={flash}>
        <h1 class="text-2xl font-bold mt-0 mb-4">New Campaign</h1>
        <div class="grid grid-cols-2 gap-6">
          <div>
            <Card>
              <form method="post" action="/admin/campaigns/new">
                <FormGroup>
                  <Label for="audienceMode">Audience</Label>
                  <Select id="audienceMode" name="audienceMode" required>
                    <option value="list">A list</option>
                    <option value="all">All subscribers</option>
                    <option value="tag">A tag</option>
                    <option value="specific">Specific people</option>
                  </Select>
                </FormGroup>

                <div data-audience="list" class="mb-4">
                  <Label for="listId">List</Label>
                  <Select id="listId" name="listId">
                    <option value="">Select a list...</option>
                    {allLists.map((list) => (
                      <option value={String(list.id)} data-from-address={list.fromAddress}>
                        {list.name} ({list.slug})
                      </option>
                    ))}
                  </Select>
                </div>

                <div data-audience="tag" class="mb-4 hidden">
                  <Label for="tagId">Tag</Label>
                  <Select id="tagId" name="tagId">
                    <option value="">Select a tag...</option>
                    {allTags.map((tag) => (
                      <option value={String(tag.id)}>{tag.name}</option>
                    ))}
                  </Select>
                </div>

                <div data-audience="specific" class="mb-4 hidden">
                  <Label>Subscribers</Label>
                  <input type="text" id="subscriberSearch" placeholder="Search by email or name..." class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                  <div id="searchResults" class="border border-gray-200 rounded-md max-h-40 overflow-y-auto hidden"></div>
                  <div id="selectedSubscribers" class="flex flex-wrap gap-2 mt-2"></div>
                  <input type="hidden" name="subscriberIds" id="subscriberIds" />
                </div>

                <FormGroup>
                  <Label for="fromPersona">From</Label>
                  <Select id="fromPersona" name="fromPersona">
                    <option value="">Custom…</option>
                    {allLists.map((list) => (
                      <option
                        value={String(list.id)}
                        data-from-address={list.fromAddress || ""}
                        data-from-name={list.name}
                        data-from-domain={list.fromDomain}
                        data-slug={list.slug}
                      >
                        {list.name} ({list.fromDomain})
                      </option>
                    ))}
                  </Select>
                </FormGroup>
                <div id="fromCustomFields">
                  <FormGroup>
                    <Label for="fromAddress">From Address</Label>
                    <Input
                      type="email"
                      id="fromAddress"
                      name="fromAddress"
                      required
                      placeholder={`newsletter@${config.fromDomain}`}
                    />
                  </FormGroup>
                  <FormGroup>
                    <Label for="fromName">From Name (optional)</Label>
                    <Input
                      type="text"
                      id="fromName"
                      name="fromName"
                      placeholder="e.g. Silicon Harbour"
                    />
                  </FormGroup>
                </div>
                <FormGroup>
                  <Label for="subject">Subject</Label>
                  <Input type="text" id="subject" name="subject" required placeholder="Campaign subject" />
                </FormGroup>
                <FormGroup>
                  <Label for="bodyMarkdown">Body (Markdown)</Label>
                  <Textarea id="bodyMarkdown" name="bodyMarkdown" required placeholder="Write your email in markdown…" />
                  <p class="text-xs text-gray-400 mt-1">{"Available variables: {{firstName}}, {{lastName}}, {{email}}, {{unsubscribeUrl}}, {{preferencesUrl}}"}</p>
                  <div id="imageDropZone" class="border-2 border-dashed border-gray-200 rounded-md p-3 mt-1 text-center text-xs text-gray-400 hover:border-blue-300 transition-colors cursor-pointer">
                    Drop an image here or <span class="text-blue-500">click to upload</span>
                    <input type="file" id="imageFileInput" accept="image/*" class="hidden" />
                  </div>
                  <input type="hidden" id="pendingImagesJson" name="pendingImagesJson" value="{}" />
                </FormGroup>

                <h3 class="text-sm font-semibold text-gray-700 mt-6 mb-3">Sending options</h3>

                <FormGroup>
                  <Label for="scheduledAtLocal">Schedule for (optional, your local time)</Label>
                  <Input type="datetime-local" id="scheduledAtLocal" />
                  <input type="hidden" id="scheduledAt" name="scheduledAt" />
                  <p class="text-xs text-gray-400 mt-1" id="scheduledAtUtc"></p>
                </FormGroup>

                <div id="batchOptions">
                  <div class="flex gap-4">
                    <FormGroup>
                      <Label for="batchSize">Batch size (emails per batch)</Label>
                      <Input type="number" id="batchSize" name="batchSize" min="1" placeholder="e.g. 20 (leave empty to send all at once)" />
                    </FormGroup>
                    <FormGroup>
                      <Label for="batchInterval">Minutes between batches</Label>
                      <Input type="number" id="batchInterval" name="batchInterval" min="1" placeholder="e.g. 10" />
                    </FormGroup>
                  </div>
                </div>

                <Button type="submit">Create Draft</Button>
              </form>
            </Card>
          </div>
          <div>
            <Card>
              <div class="flex items-center justify-between mt-0 mb-3">
                <h2 class="text-lg font-semibold m-0">Preview</h2>
                <div class="flex items-center gap-1">
                  <button type="button" onclick="setPreviewWidth(375)" class="px-2 py-0.5 text-xs border border-gray-200 rounded hover:bg-gray-100 cursor-pointer bg-white text-gray-500">375</button>
                  <button type="button" onclick="setPreviewWidth(600)" class="px-2 py-0.5 text-xs border border-gray-200 rounded hover:bg-gray-100 cursor-pointer bg-white text-gray-500">600</button>
                  <button type="button" onclick="setPreviewWidth(768)" class="px-2 py-0.5 text-xs border border-gray-200 rounded hover:bg-gray-100 cursor-pointer bg-white text-gray-500">768</button>
                  <button type="button" onclick="setPreviewWidth(null)" class="px-2 py-0.5 text-xs border border-gray-200 rounded hover:bg-gray-100 cursor-pointer bg-white text-gray-500">full</button>
                </div>
              </div>
              <div id="previewContainer" class="relative overflow-hidden flex justify-center bg-gray-50 rounded" style="min-height: 520px;">
                <iframe id="previewFrame" style="min-height: 500px; width: 100%; border: 0; transition: width 0.15s;" srcdoc="<p style='color:#999;font-family:system-ui;padding:2rem'>Start writing to see a preview</p>" />
                <div id="previewResizeHandle" style="position:absolute;right:0;top:0;bottom:0;width:6px;cursor:col-resize;background:transparent;" class="hover:bg-blue-200 transition-colors" title="Drag to resize" />
              </div>
              <p id="previewWidthLabel" class="text-xs text-gray-400 text-right mt-1"></p>
            </Card>
          </div>
        </div>

        {/* Image upload modal */}
        <div id="imageModal" class="hidden fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
          <div class="bg-white rounded-lg p-6 max-w-sm w-full mx-4 shadow-xl">
            <h3 class="font-semibold text-gray-800 mb-1" id="imageModalName"></h3>
            <p class="text-xs text-gray-500 mb-4" id="imageModalSize"></p>
            <div class="flex flex-col gap-2">
              <button type="button" id="imageEmbedBtn" class="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 border-none cursor-pointer">
                Embed in email (inline attachment, always displays)
              </button>
              <button type="button" id="imageS3Btn" class="px-4 py-2 bg-white text-gray-700 text-sm font-medium rounded-md hover:bg-gray-50 border border-gray-300 cursor-pointer">
                Host on S3 (smaller email size)
              </button>
              <button type="button" id="imageModalClose" class="px-4 py-2 text-gray-500 text-sm hover:text-gray-700 border-none cursor-pointer bg-transparent">Cancel</button>
            </div>
          </div>
        </div>

        <script dangerouslySetInnerHTML={{ __html: `var subscribers = ${JSON.stringify(allSubscribers.map(s => ({ id: s.id, email: s.email, firstName: s.firstName, lastName: s.lastName })))};` }} />
        <script dangerouslySetInnerHTML={{ __html: `
          (function() {
            // Mode switching
            var mode = document.getElementById('audienceMode');
            mode.addEventListener('change', function() {
              document.querySelectorAll('[data-audience]').forEach(function(el) { el.classList.add('hidden'); });
              var target = document.querySelector('[data-audience="' + this.value + '"]');
              if (target) target.classList.remove('hidden');
            });

            // From address auto-fill + fromName auto-fill
            var lastDefault = '';
            var listSelect = document.getElementById('listId');
            if (listSelect) {
              listSelect.addEventListener('change', function() {
                var opt = this.options[this.selectedIndex];
                var addr = opt.dataset.fromAddress || '';
                var input = document.getElementById('fromAddress');
                if (!input.value || input.value === lastDefault) input.value = addr;
                lastDefault = addr;
                // auto-fill fromName from local part if empty
                var nameInput = document.getElementById('fromName');
                if (nameInput && !nameInput.value && addr) {
                  nameInput.value = addr.split('@')[0] || '';
                }
              });
            }

            // fromName auto-fill from fromAddress local part when typed
            var fromAddrInput = document.getElementById('fromAddress');
            if (fromAddrInput) {
              fromAddrInput.addEventListener('blur', function() {
                var nameInput = document.getElementById('fromName');
                if (nameInput && !nameInput.value && this.value) {
                  nameInput.value = this.value.split('@')[0] || '';
                }
              });
            }

            // Timezone-aware schedule input
            var localInput = document.getElementById('scheduledAtLocal');
            var utcHidden = document.getElementById('scheduledAt');
            var utcLabel = document.getElementById('scheduledAtUtc');
            if (localInput) {
              localInput.addEventListener('change', function() {
                if (this.value) {
                  var utc = new Date(this.value).toISOString();
                  utcHidden.value = utc;
                  utcLabel.textContent = 'UTC: ' + new Date(utc).toUTCString();
                } else {
                  utcHidden.value = '';
                  utcLabel.textContent = '';
                }
              });
            }

            // From persona selector
            var fromPersona = document.getElementById('fromPersona');
            var fromCustom = document.getElementById('fromCustomFields');
            if (fromPersona) {
              fromPersona.addEventListener('change', function() {
                var opt = this.options[this.selectedIndex];
                if (!opt.value) {
                  // Custom -- show fields, clear required attr handled by visibility
                  fromCustom.style.display = '';
                  document.getElementById('fromAddress').required = true;
                } else {
                  // Fill from list persona data
                  document.getElementById('fromAddress').value = opt.dataset.fromAddress || (opt.dataset.slug + '@' + opt.dataset.fromDomain);
                  document.getElementById('fromAddress').required = false;
                  document.getElementById('fromName').value = opt.dataset.fromName || '';
                  fromCustom.style.display = 'none';
                }
              });
            }

            // Subscriber picker
            var selected = new Set();
            var search = document.getElementById('subscriberSearch');
            var results = document.getElementById('searchResults');
            var chips = document.getElementById('selectedSubscribers');
            var hidden = document.getElementById('subscriberIds');

            function render() {
              chips.innerHTML = '';
              selected.forEach(function(id) {
                var sub = subscribers.find(function(s) { return s.id === id; });
                if (!sub) return;
                var chip = document.createElement('span');
                chip.className = 'inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800';
                chip.textContent = sub.email;
                var btn = document.createElement('button');
                btn.type = 'button';
                btn.textContent = '\\u00d7';
                btn.className = 'ml-1 text-blue-600 hover:text-blue-800 cursor-pointer';
                btn.onclick = function() { selected.delete(id); render(); };
                chip.appendChild(btn);
                chips.appendChild(chip);
              });
              hidden.value = Array.from(selected).join(',');
            }

            if (search) {
              search.addEventListener('input', function() {
                var q = this.value.toLowerCase();
                if (!q) { results.classList.add('hidden'); return; }
                var matches = subscribers.filter(function(s) {
                  var name = [s.firstName || '', s.lastName || ''].join(' ').trim();
                  return !selected.has(s.id) && (s.email.toLowerCase().includes(q) || name.toLowerCase().includes(q));
                }).slice(0, 10);
                results.innerHTML = '';
                matches.forEach(function(s) {
                  var div = document.createElement('div');
                  div.className = 'px-3 py-2 cursor-pointer hover:bg-gray-50 text-sm';
                  var name = [s.firstName || '', s.lastName || ''].join(' ').trim();
                  div.textContent = s.email + (name ? ' (' + name + ')' : '');
                  div.onclick = function() { selected.add(s.id); search.value = ''; results.classList.add('hidden'); render(); };
                  results.appendChild(div);
                });
                results.classList.toggle('hidden', matches.length === 0);
              });
            }

            // Preview resize + live update (create form)
            window.setPreviewWidth = function(w) {
              var f = document.getElementById('previewFrame');
              var lbl = document.getElementById('previewWidthLabel');
              if (w === null) { f.style.width = '100%'; lbl.textContent = ''; }
              else { f.style.width = w + 'px'; lbl.textContent = w + 'px'; }
            };
            (function() {
              var handle = document.getElementById('previewResizeHandle');
              var f = document.getElementById('previewFrame');
              var lbl = document.getElementById('previewWidthLabel');
              var drag = false, sx = 0, sw = 0;
              handle.addEventListener('mousedown', function(e) {
                drag = true; sx = e.clientX; sw = f.offsetWidth;
                document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; e.preventDefault();
              });
              document.addEventListener('mousemove', function(e) {
                if (!drag) return;
                var w = Math.max(280, sw + e.clientX - sx);
                f.style.width = w + 'px'; lbl.textContent = Math.round(w) + 'px';
              });
              document.addEventListener('mouseup', function() {
                if (!drag) return; drag = false; document.body.style.cursor = ''; document.body.style.userSelect = '';
              });
            })();

            var timer;
            var textarea = document.getElementById('bodyMarkdown');
            var subject = document.getElementById('subject');
            var frame = document.getElementById('previewFrame');

            function updatePreview() {
              var body = textarea.value;
              if (!body.trim()) return;
              fetch('/admin/campaigns/preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  bodyMarkdown: body,
                  subject: subject.value || 'Preview',
                  listName: 'Preview'
                })
              })
              .then(function(r) { return r.text(); })
              .then(function(html) { frame.srcdoc = html; });
            }

            textarea.addEventListener('input', function() {
              clearTimeout(timer);
              timer = setTimeout(updatePreview, 500);
            });
            subject.addEventListener('input', function() {
              clearTimeout(timer);
              timer = setTimeout(updatePreview, 500);
            });
          })();
        `}} />
        <script dangerouslySetInnerHTML={{ __html: `
          (function() {
            var dropZone = document.getElementById('imageDropZone');
            var fileInput = document.getElementById('imageFileInput');
            var modal = document.getElementById('imageModal');
            var modalName = document.getElementById('imageModalName');
            var modalSize = document.getElementById('imageModalSize');
            var embedBtn = document.getElementById('imageEmbedBtn');
            var s3Btn = document.getElementById('imageS3Btn');
            var closeBtn = document.getElementById('imageModalClose');
            var pendingField = document.getElementById('pendingImagesJson');
            var pendingMap = {}; // uuid -> dataUri (kept in memory, not in textarea)
            var currentFile = null;
            var processedData = null;

            function formatBytes(b) {
              if (b < 1024) return b + ' B';
              if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
              return (b / 1024 / 1024).toFixed(1) + ' MB';
            }

            function insertAtCursor(text) {
              var ta = document.getElementById('bodyMarkdown');
              var start = ta.selectionStart, end = ta.selectionEnd;
              ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
              ta.selectionStart = ta.selectionEnd = start + text.length;
              ta.dispatchEvent(new Event('input'));
            }

            function handleFile(file) {
              if (!file || !file.type.startsWith('image/')) return;
              currentFile = file;
              var formData = new FormData();
              formData.append('image', file);
              fetch('/admin/campaigns/upload-image', { method: 'POST', body: formData })
                .then(function(r) { return r.json(); })
                .then(function(data) {
                  processedData = data;
                  modalName.textContent = file.name;
                  modalSize.textContent = 'Original: ' + formatBytes(data.originalSizeBytes) + ' \\u2192 ' + formatBytes(data.sizeBytes) + ' WebP (' + data.width + '\\u00d7' + data.height + ')';
                  embedBtn.textContent = 'Embed in email (' + formatBytes(data.sizeBytes) + ' inline, always displays)';
                  s3Btn.textContent = 'Host on S3 (tiny email, uploads on save)';
                  modal.classList.remove('hidden');
                })
                .catch(function() { alert('Failed to process image'); });
            }

            dropZone.addEventListener('click', function() { fileInput.click(); });
            fileInput.addEventListener('change', function() { if (this.files[0]) handleFile(this.files[0]); });
            dropZone.addEventListener('dragover', function(e) { e.preventDefault(); this.classList.add('border-blue-400', 'bg-blue-50'); });
            dropZone.addEventListener('dragleave', function() { this.classList.remove('border-blue-400', 'bg-blue-50'); });
            dropZone.addEventListener('drop', function(e) {
              e.preventDefault();
              this.classList.remove('border-blue-400', 'bg-blue-50');
              if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
            });

            embedBtn.addEventListener('click', function() {
              if (processedData) {
                insertAtCursor('\\n![image](' + processedData.dataUri + ')\\n');
                modal.classList.add('hidden');
              }
            });

            s3Btn.addEventListener('click', function() {
              if (processedData) {
                var uuid = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
                // Store data URI in memory map, only put short token in textarea
                pendingMap[uuid] = processedData.dataUri;
                pendingField.value = JSON.stringify(pendingMap);
                // Insert short clean token - no base64 in the textarea!
                insertAtCursor('\\n<!-- s3-pending:' + uuid + ' -->\\n');
                modal.classList.add('hidden');
              }
            });

            closeBtn.addEventListener('click', function() { modal.classList.add('hidden'); });
            modal.addEventListener('click', function(e) { if (e.target === modal) modal.classList.add('hidden'); });
          })();
        `}} />
      </AdminLayout>,
    );
  });

  app.post("/campaigns/new", async (c) => {
    const user = c.get("user") as User;
    const body = await c.req.parseBody();
    const fromAddress = String(body["fromAddress"] ?? "").trim();
    const fromName = String(body["fromName"] ?? "").trim() || null;
    const subject = String(body["subject"] ?? "").trim();
    const bodyMarkdown = String(body["bodyMarkdown"] ?? "");

    const validModes = ["list", "all", "tag", "specific"] as const;
    let audienceMode = validModes.includes(body["audienceMode"] as any) ? body["audienceMode"] as string : "list";

    if (audienceMode === "all" && !["owner", "admin"].includes(user.role)) {
      audienceMode = "list"; // fallback
    }

    let audienceType: string = audienceMode === "specific" ? "subscribers" : audienceMode;
    let audienceId: number | null = null;
    let audienceData: string | null = null;

    if (audienceMode === "list") {
      const rawListId = body["listId"];
      if (!rawListId) return c.redirect("/admin/campaigns/new");
      audienceId = Number(rawListId);
    } else if (audienceMode === "tag") {
      const tagId = Number(body["tagId"]);
      if (!tagId) return c.redirect("/admin/campaigns/new");
      audienceId = tagId;
    } else if (audienceMode === "specific") {
      const ids = String(body["subscriberIds"] ?? "").split(",").map(Number).filter(Boolean);
      if (ids.length === 0) return c.redirect("/admin/campaigns/new");
      audienceData = JSON.stringify(ids);
    }

    if (!fromAddress || !subject || !bodyMarkdown) {
      return c.redirect("/admin/campaigns/new");
    }

    // Verify user has access to this list (admins can send to "all")
    if (audienceType === "list" && audienceId !== null) {
      const listAccess = getAccessibleListIds(db, user);
      if (listAccess !== "all" && !listAccess.includes(audienceId)) {
        return c.text("Forbidden", 403);
      }
    }

    const scheduledAt = body["scheduledAt"] ? new Date(String(body["scheduledAt"])).toISOString() : null;
    const batchSize = body["batchSize"] ? parseInt(String(body["batchSize"]), 10) || null : null;
    const batchInterval = body["batchInterval"] ? parseInt(String(body["batchInterval"]), 10) || null : null;
    const status = scheduledAt ? "scheduled" : "draft";
    let pendingMap: Record<string, string> = {};
    try { pendingMap = JSON.parse(String(body["pendingImagesJson"] ?? "{}")); } catch {}

    const result = db
      .insert(schema.campaigns)
      .values({ audienceType, audienceId, audienceData, fromAddress, fromName, subject, bodyMarkdown, scheduledAt, batchSize, batchInterval, status })
      .returning({ id: schema.campaigns.id })
      .get();

    const campaignId = result.id;
    if (config.s3MediaBucket && Object.keys(pendingMap).length > 0) {
      const processedMarkdown = await processPendingS3Images(bodyMarkdown, campaignId, pendingMap, config);
      if (processedMarkdown !== bodyMarkdown) {
        db.update(schema.campaigns)
          .set({ bodyMarkdown: processedMarkdown })
          .where(eq(schema.campaigns.id, campaignId))
          .run();
      }
    }

    logEvent(db, {
      type: "admin.campaign_created",
      detail: subject,
      campaignId: result.id,
      userId: user.id,
    });

    setFlash(c, "Campaign created.");
    return c.redirect(`/admin/campaigns/${result.id}`);
  });

  app.get("/campaigns/:id", async (c) => {
    const user = c.get("user") as User;
    const flash = getFlash(c);
    const id = Number(c.req.param("id"));
    const campaign = db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id)).get();
    if (!campaign) return c.notFound();

    // Check list access (non-list audienceType = accessible to admins/owners)
    const listAccess = getAccessibleListIds(db, user);
    if (campaign.audienceType === "list" && campaign.audienceId !== null && listAccess !== "all" && !listAccess.includes(campaign.audienceId)) {
      return c.text("Forbidden", 403);
    }

    const list = (campaign.audienceType === "list" && campaign.audienceId)
      ? db.select().from(schema.lists).where(eq(schema.lists.id, campaign.audienceId)).get()
      : null;

    // Build lookup maps for audience description
    const detailLists = db.select().from(schema.lists).all();
    const detailListMap = new Map(detailLists.map((l) => [l.id, l.name]));
    const detailTags = db.select().from(schema.tags).all();
    const detailTagMap = new Map(detailTags.map((t) => [t.id, t.name]));
    const audienceDesc = describeAudience(campaign, detailListMap, detailTagMap);

    const sends = db
      .select()
      .from(schema.campaignSends)
      .where(eq(schema.campaignSends.campaignId, id))
      .all();

    const inboundReplies = db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.campaignId, id), eq(schema.messages.direction, "inbound")))
      .orderBy(desc(schema.messages.createdAt))
      .all();

    // Get subscribers for preview picker based on audience
    let previewSubscribers: { id: number; email: string }[];
    if (campaign.audienceType === "list" && campaign.audienceId) {
      previewSubscribers = getConfirmedSubscribers(db, campaign.audienceId);
    } else if (campaign.audienceType === "tag" && campaign.audienceId) {
      previewSubscribers = db
        .selectDistinct({
          id: schema.subscribers.id,
          email: schema.subscribers.email,
        })
        .from(schema.subscribers)
        .innerJoin(schema.subscriberTags, eq(schema.subscriberTags.subscriberId, schema.subscribers.id))
        .innerJoin(schema.subscriberLists, eq(schema.subscriberLists.subscriberId, schema.subscribers.id))
        .where(
          and(
            eq(schema.subscriberTags.tagId, campaign.audienceId),
            eq(schema.subscribers.status, "active"),
            eq(schema.subscriberLists.status, "confirmed"),
          ),
        )
        .all();
    } else if (campaign.audienceType === "subscribers" && campaign.audienceData) {
      const ids = JSON.parse(campaign.audienceData) as number[];
      previewSubscribers = ids.length
        ? db
            .selectDistinct({
              id: schema.subscribers.id,
              email: schema.subscribers.email,
            })
            .from(schema.subscribers)
            .innerJoin(schema.subscriberLists, eq(schema.subscriberLists.subscriberId, schema.subscribers.id))
            .where(
              and(
                inArray(schema.subscribers.id, ids),
                eq(schema.subscribers.status, "active"),
                eq(schema.subscriberLists.status, "confirmed"),
              ),
            )
            .all()
        : [];
    } else {
      // "all" type or unknown — get all active confirmed
      previewSubscribers = db
        .selectDistinct({
          id: schema.subscribers.id,
          email: schema.subscribers.email,
        })
        .from(schema.subscribers)
        .innerJoin(schema.subscriberLists, eq(schema.subscriberLists.subscriberId, schema.subscribers.id))
        .where(
          and(
            eq(schema.subscribers.status, "active"),
            eq(schema.subscriberLists.status, "confirmed"),
          ),
        )
        .all();
    }

    return c.html(
      <AdminLayout title={campaign.subject} user={user} flash={flash}>
        <h1 class="text-2xl font-bold mt-0 mb-4">{campaign.subject}</h1>
        <div class="flex gap-4 items-center mb-4">
          <CampaignBadge status={campaign.status} />
          <span class="text-sm text-gray-500">
            Audience: {audienceDesc} &middot; From: {campaign.fromAddress}
          </span>
        </div>

        {campaign.scheduledAt && (
          <div class="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4 text-sm text-blue-800">
            Scheduled for: {fmtDateTime(campaign.scheduledAt)}
            {campaign.batchSize && (
              <span class="ml-4">Batch: {campaign.batchSize} emails every {campaign.batchInterval ?? 10} minutes</span>
            )}
          </div>
        )}

        {campaign.lastError && (
          <div class="bg-red-50 border border-red-200 rounded-lg p-4 mb-6 font-mono text-sm whitespace-pre-wrap break-all text-red-800">
            <strong>Error:</strong>{"\n"}{campaign.lastError}
          </div>
        )}

        {(campaign.status === "draft" || campaign.status === "failed" || campaign.status === "scheduled") && (
          <div class="flex gap-2 mb-6">
            <LinkButton href={`/admin/campaigns/${id}/edit`}>Edit Campaign</LinkButton>
          </div>
        )}

        {campaign.status === "draft" && (
          <form method="post" action={`/admin/campaigns/${id}/send`} class="mb-6">
            <Button type="submit" variant="danger">Send Campaign</Button>
          </form>
        )}

        {campaign.status === "scheduled" && (
          <div class="flex gap-2 mb-6">
            <form method="post" action={`/admin/campaigns/${id}/unschedule`}>
              <Button type="submit" variant="secondary">Unschedule (revert to draft)</Button>
            </form>
          </div>
        )}

        {campaign.status === "failed" && (
          <div class="flex gap-2 mb-6">
            <form method="post" action={`/admin/campaigns/${id}/retry`}>
              <Button type="submit">Retry (skip already sent)</Button>
            </form>
            <form method="post" action={`/admin/campaigns/${id}/reset`}>
              <button type="submit" class="inline-block px-4 py-2 bg-gray-500 text-white text-sm font-medium rounded-md hover:bg-gray-600 cursor-pointer border-none no-underline">
                Reset to Draft
              </button>
            </form>
          </div>
        )}

        {campaign.status === "sending" && (
          <div class="flex gap-2 mb-6">
            <form method="post" action={`/admin/campaigns/${id}/reset`}>
              <button type="submit" class="inline-block px-4 py-2 bg-gray-500 text-white text-sm font-medium rounded-md hover:bg-gray-600 cursor-pointer border-none no-underline">
                Force Reset to Draft (stuck?)
              </button>
            </form>
          </div>
        )}

        {sends.length > 0 && (
          <>
            <h2 class="text-xl font-semibold mt-6 mb-3">Sends ({sends.length})</h2>
            <Table>
              <thead>
                <tr>
                  <Th>Subscriber ID</Th>
                  <Th>Status</Th>
                  <Th>Sent At</Th>
                  <Th>SES Message ID</Th>
                </tr>
              </thead>
              <tbody>
                {sends.map((send) => (
                  <tr>
                    <Td>{send.subscriberId}</Td>
                    <Td>{send.status}</Td>
                    <Td>{fmtDateTime(send.sentAt)}</Td>
                    <Td class="text-xs">{send.sesMessageId ?? "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </>
        )}

        <h2 class="text-xl font-semibold mt-6 mb-3">Email Preview</h2>
        <div class="mb-4">
          <select id="previewSubscriber" class="px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
            <option value="">Generic preview</option>
            {previewSubscribers.map((sub) => (
              <option value={String(sub.id)}>{sub.email}</option>
            ))}
          </select>
        </div>
        <iframe
          id="previewFrame"
          src={`/admin/campaigns/${id}/preview`}
          class="w-full border border-gray-200 rounded-lg"
          style="min-height: 600px;"
        />
        <script dangerouslySetInnerHTML={{ __html: `
          document.getElementById('previewSubscriber').addEventListener('change', function() {
            var subId = this.value;
            var src = '/admin/campaigns/${id}/preview';
            if (subId) src += '?subscriberId=' + subId;
            document.getElementById('previewFrame').src = src;
          });
        `}} />

        {inboundReplies.length > 0 && (
          <>
            <h2 class="text-xl font-semibold mt-6 mb-3">Replies ({inboundReplies.length})</h2>
            <Table>
              <thead>
                <tr>
                  <Th>From</Th>
                  <Th>Subject</Th>
                  <Th>Received</Th>
                  <Th></Th>
                </tr>
              </thead>
              <tbody>
                {inboundReplies.map((r) => (
                  <tr>
                    <Td>{r.fromAddr}</Td>
                    <Td>{r.subject}</Td>
                    <Td>{fmtDateTime(r.createdAt)}</Td>
                    <Td><a href={`/admin/inbound/${r.id}`} class="text-blue-600 hover:text-blue-800">View</a></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </>
        )}

        <hr class="my-8" />
        <form method="post" action={`/admin/campaigns/${id}/delete`} onsubmit="return confirm('Delete this campaign and all its send records? This cannot be undone.')">
          <Button type="submit" variant="danger">Delete Campaign</Button>
        </form>
      </AdminLayout>,
    );
  });

  app.get("/campaigns/:id/edit", (c) => {
    const user = c.get("user") as User;
    const flash = getFlash(c);
    const id = Number(c.req.param("id"));
    const campaign = db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id)).get();
    if (!campaign) return c.notFound();
    if (campaign.status !== "draft" && campaign.status !== "failed" && campaign.status !== "scheduled") {
      return c.redirect(`/admin/campaigns/${id}`);
    }

    const listAccess = getAccessibleListIds(db, user);
    let allLists: (typeof schema.lists.$inferSelect)[];
    if (listAccess === "all") {
      allLists = db.select().from(schema.lists).all();
    } else if (listAccess.length === 0) {
      allLists = [];
    } else {
      allLists = db.select().from(schema.lists).where(inArray(schema.lists.id, listAccess)).all();
    }

    const allTags = db.select().from(schema.tags).all();
    const allSubscribers = db.select().from(schema.subscribers).where(eq(schema.subscribers.status, "active")).all();

    // Determine current audience mode and values
    let currentAudienceMode = campaign.audienceType === "subscribers" ? "specific" : campaign.audienceType;
    let currentListId = campaign.audienceType === "list" ? campaign.audienceId : null;
    let currentTagId = campaign.audienceType === "tag" ? campaign.audienceId : null;
    let currentSubscriberIds: number[] = [];
    if (campaign.audienceType === "subscribers" && campaign.audienceData) {
      currentSubscriberIds = JSON.parse(campaign.audienceData) as number[];
    }

    return c.html(
      <AdminLayout title={`Edit: ${campaign.subject}`} user={user} flash={flash}>
        <h1 class="text-2xl font-bold mt-0 mb-4">Edit Campaign</h1>
        <div class="grid grid-cols-2 gap-6">
          <div>
            <Card>
              <form method="post" action={`/admin/campaigns/${id}/edit`}>
                <FormGroup>
                  <Label for="audienceMode">Audience</Label>
                  <Select id="audienceMode" name="audienceMode" required>
                    <option value="list" selected={currentAudienceMode === "list"}>A list</option>
                    <option value="all" selected={currentAudienceMode === "all"}>All subscribers</option>
                    <option value="tag" selected={currentAudienceMode === "tag"}>A tag</option>
                    <option value="specific" selected={currentAudienceMode === "specific"}>Specific people</option>
                  </Select>
                </FormGroup>

                <div data-audience="list" class={`mb-4${currentAudienceMode !== "list" ? " hidden" : ""}`}>
                  <Label for="listId">List</Label>
                  <Select id="listId" name="listId">
                    <option value="">Select a list...</option>
                    {allLists.map((list) => (
                      <option value={String(list.id)} data-from-address={list.fromAddress} selected={currentListId === list.id}>
                        {list.name} ({list.slug})
                      </option>
                    ))}
                  </Select>
                </div>

                <div data-audience="tag" class={`mb-4${currentAudienceMode !== "tag" ? " hidden" : ""}`}>
                  <Label for="tagId">Tag</Label>
                  <Select id="tagId" name="tagId">
                    <option value="">Select a tag...</option>
                    {allTags.map((tag) => (
                      <option value={String(tag.id)} selected={currentTagId === tag.id}>{tag.name}</option>
                    ))}
                  </Select>
                </div>

                <div data-audience="specific" class={`mb-4${currentAudienceMode !== "specific" ? " hidden" : ""}`}>
                  <Label>Subscribers</Label>
                  <input type="text" id="subscriberSearch" placeholder="Search by email or name..." class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                  <div id="searchResults" class="border border-gray-200 rounded-md max-h-40 overflow-y-auto hidden"></div>
                  <div id="selectedSubscribers" class="flex flex-wrap gap-2 mt-2"></div>
                  <input type="hidden" name="subscriberIds" id="subscriberIds" value={currentSubscriberIds.join(",")} />
                </div>

                <FormGroup>
                  <Label for="fromPersona">From</Label>
                  <Select id="fromPersona" name="fromPersona">
                    <option value="">Custom…</option>
                    {allLists.map((list) => (
                      <option
                        value={String(list.id)}
                        data-from-address={list.fromAddress || ""}
                        data-from-name={list.name}
                        data-from-domain={list.fromDomain}
                        data-slug={list.slug}
                      >
                        {list.name} ({list.fromDomain})
                      </option>
                    ))}
                  </Select>
                </FormGroup>
                <div id="fromCustomFields">
                  <FormGroup>
                    <Label for="fromAddress">From Address</Label>
                    <Input
                      type="email"
                      id="fromAddress"
                      name="fromAddress"
                      required
                      value={campaign.fromAddress}
                      placeholder={`newsletter@${config.fromDomain}`}
                    />
                  </FormGroup>
                  <FormGroup>
                    <Label for="fromName">From Name (optional)</Label>
                    <Input
                      type="text"
                      id="fromName"
                      name="fromName"
                      value={campaign.fromName ?? ""}
                      placeholder="e.g. Silicon Harbour"
                    />
                  </FormGroup>
                </div>
                <FormGroup>
                  <Label for="subject">Subject</Label>
                  <Input type="text" id="subject" name="subject" required value={campaign.subject} placeholder="Campaign subject" />
                </FormGroup>
                <FormGroup>
                  <Label for="bodyMarkdown">Body (Markdown)</Label>
                  <textarea id="bodyMarkdown" name="bodyMarkdown" required placeholder="Write your email in markdown…" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 min-h-[200px] resize-y focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500">{campaign.bodyMarkdown}</textarea>
                  <p class="text-xs text-gray-400 mt-1">{"Available variables: {{firstName}}, {{lastName}}, {{email}}, {{unsubscribeUrl}}, {{preferencesUrl}}"}</p>
                  <div id="imageDropZone" class="border-2 border-dashed border-gray-200 rounded-md p-3 mt-1 text-center text-xs text-gray-400 hover:border-blue-300 transition-colors cursor-pointer">
                    Drop an image here or <span class="text-blue-500">click to upload</span>
                    <input type="file" id="imageFileInput" accept="image/*" class="hidden" />
                  </div>
                  <input type="hidden" id="pendingImagesJson" name="pendingImagesJson" value="{}" />
                </FormGroup>

                <h3 class="text-sm font-semibold text-gray-700 mt-6 mb-3">Sending options</h3>

                <FormGroup>
                  <Label for="scheduledAtLocal">Schedule for (optional, your local time)</Label>
                  <Input
                    type="datetime-local"
                    id="scheduledAtLocal"
                    value={campaign.scheduledAt
                      ? new Date(new Date(campaign.scheduledAt).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)
                      : undefined}
                  />
                  <input type="hidden" id="scheduledAt" name="scheduledAt" value={campaign.scheduledAt ?? ""} />
                  <p class="text-xs text-gray-400 mt-1" id="scheduledAtUtc">
                    {campaign.scheduledAt ? `UTC: ${new Date(campaign.scheduledAt).toUTCString()}` : ""}
                   </p>
                </FormGroup>

                <div id="batchOptions">
                  <div class="flex gap-4">
                    <FormGroup>
                      <Label for="batchSize">Batch size (emails per batch)</Label>
                      <Input type="number" id="batchSize" name="batchSize" min="1" placeholder="e.g. 20 (leave empty to send all at once)" value={campaign.batchSize ?? undefined} />
                    </FormGroup>
                    <FormGroup>
                      <Label for="batchInterval">Minutes between batches</Label>
                      <Input type="number" id="batchInterval" name="batchInterval" min="1" placeholder="e.g. 10" value={campaign.batchInterval ?? undefined} />
                    </FormGroup>
                  </div>
                </div>

                <Button type="submit">Save Changes</Button>
              </form>
            </Card>
          </div>
          <div>
            <Card>
              <div class="flex items-center justify-between mt-0 mb-3">
                <h2 class="text-lg font-semibold m-0">Preview</h2>
                <div class="flex items-center gap-1">
                  <button type="button" onclick="setPreviewWidth(375)" class="px-2 py-0.5 text-xs border border-gray-200 rounded hover:bg-gray-100 cursor-pointer bg-white text-gray-500">375</button>
                  <button type="button" onclick="setPreviewWidth(600)" class="px-2 py-0.5 text-xs border border-gray-200 rounded hover:bg-gray-100 cursor-pointer bg-white text-gray-500">600</button>
                  <button type="button" onclick="setPreviewWidth(768)" class="px-2 py-0.5 text-xs border border-gray-200 rounded hover:bg-gray-100 cursor-pointer bg-white text-gray-500">768</button>
                  <button type="button" onclick="setPreviewWidth(null)" class="px-2 py-0.5 text-xs border border-gray-200 rounded hover:bg-gray-100 cursor-pointer bg-white text-gray-500">full</button>
                </div>
              </div>
              <div id="previewContainer" class="relative overflow-hidden flex justify-center bg-gray-50 rounded" style="min-height: 520px;">
                <iframe id="previewFrame" style="min-height: 500px; width: 100%; border: 0; transition: width 0.15s;" src={`/admin/campaigns/${id}/preview`} />
                <div id="previewResizeHandle" style="position:absolute;right:0;top:0;bottom:0;width:6px;cursor:col-resize;background:transparent;" class="hover:bg-blue-200 transition-colors" title="Drag to resize" />
              </div>
              <p id="previewWidthLabel" class="text-xs text-gray-400 text-right mt-1"></p>
            </Card>
          </div>
        </div>
        <script dangerouslySetInnerHTML={{ __html: `var subscribers = ${JSON.stringify(allSubscribers.map(s => ({ id: s.id, email: s.email, firstName: s.firstName, lastName: s.lastName })))};` }} />
        <script dangerouslySetInnerHTML={{ __html: `
          (function() {
            // Mode switching
            var mode = document.getElementById('audienceMode');
            mode.addEventListener('change', function() {
              document.querySelectorAll('[data-audience]').forEach(function(el) { el.classList.add('hidden'); });
              var target = document.querySelector('[data-audience="' + this.value + '"]');
              if (target) target.classList.remove('hidden');
            });

            // Timezone-aware schedule input (edit form)
            var localInput = document.getElementById('scheduledAtLocal');
            var utcHidden = document.getElementById('scheduledAt');
            var utcLabel = document.getElementById('scheduledAtUtc');
            if (localInput) {
              localInput.addEventListener('change', function() {
                if (this.value) {
                  var utc = new Date(this.value).toISOString();
                  utcHidden.value = utc;
                  utcLabel.textContent = 'UTC: ' + new Date(utc).toUTCString();
                } else {
                  utcHidden.value = '';
                  utcLabel.textContent = '';
                }
              });
            }

             // From persona selector (edit form)
            var fromPersona = document.getElementById('fromPersona');
            var fromCustom = document.getElementById('fromCustomFields');
            if (fromPersona) {
              fromPersona.addEventListener('change', function() {
                var opt = this.options[this.selectedIndex];
                if (!opt.value) {
                  fromCustom.style.display = '';
                  document.getElementById('fromAddress').required = true;
                } else {
                  document.getElementById('fromAddress').value = opt.dataset.fromAddress || (opt.dataset.slug + '@' + opt.dataset.fromDomain);
                  document.getElementById('fromAddress').required = false;
                  document.getElementById('fromName').value = opt.dataset.fromName || '';
                  fromCustom.style.display = 'none';
                }
              });
            }

            // fromName auto-fill from fromAddress local part
            var fromAddrInput = document.getElementById('fromAddress');
            if (fromAddrInput) {
              fromAddrInput.addEventListener('blur', function() {
                var nameInput = document.getElementById('fromName');
                if (nameInput && !nameInput.value && this.value) {
                  nameInput.value = this.value.split('@')[0] || '';
                }
              });
            }

            // Subscriber picker
            var selected = new Set(${JSON.stringify(currentSubscriberIds)});
            var search = document.getElementById('subscriberSearch');
            var results = document.getElementById('searchResults');
            var chips = document.getElementById('selectedSubscribers');
            var hidden = document.getElementById('subscriberIds');

            function render() {
              chips.innerHTML = '';
              selected.forEach(function(id) {
                var sub = subscribers.find(function(s) { return s.id === id; });
                if (!sub) return;
                var chip = document.createElement('span');
                chip.className = 'inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800';
                chip.textContent = sub.email;
                var btn = document.createElement('button');
                btn.type = 'button';
                btn.textContent = '\\u00d7';
                btn.className = 'ml-1 text-blue-600 hover:text-blue-800 cursor-pointer';
                btn.onclick = function() { selected.delete(id); render(); };
                chip.appendChild(btn);
                chips.appendChild(chip);
              });
              hidden.value = Array.from(selected).join(',');
            }
            render();

            if (search) {
              search.addEventListener('input', function() {
                var q = this.value.toLowerCase();
                if (!q) { results.classList.add('hidden'); return; }
                var matches = subscribers.filter(function(s) {
                  var name = [s.firstName || '', s.lastName || ''].join(' ').trim();
                  return !selected.has(s.id) && (s.email.toLowerCase().includes(q) || name.toLowerCase().includes(q));
                }).slice(0, 10);
                results.innerHTML = '';
                matches.forEach(function(s) {
                  var div = document.createElement('div');
                  div.className = 'px-3 py-2 cursor-pointer hover:bg-gray-50 text-sm';
                  var name = [s.firstName || '', s.lastName || ''].join(' ').trim();
                  div.textContent = s.email + (name ? ' (' + name + ')' : '');
                  div.onclick = function() { selected.add(s.id); search.value = ''; results.classList.add('hidden'); render(); };
                  results.appendChild(div);
                });
                results.classList.toggle('hidden', matches.length === 0);
              });
            }

            // Preview resize + live update (edit form)
            window.setPreviewWidth = function(w) {
              var f = document.getElementById('previewFrame');
              var lbl = document.getElementById('previewWidthLabel');
              if (w === null) { f.style.width = '100%'; lbl.textContent = ''; }
              else { f.style.width = w + 'px'; lbl.textContent = w + 'px'; }
            };
            (function() {
              var handle = document.getElementById('previewResizeHandle');
              var f = document.getElementById('previewFrame');
              var lbl = document.getElementById('previewWidthLabel');
              var drag = false, sx = 0, sw = 0;
              handle.addEventListener('mousedown', function(e) {
                drag = true; sx = e.clientX; sw = f.offsetWidth;
                document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; e.preventDefault();
              });
              document.addEventListener('mousemove', function(e) {
                if (!drag) return;
                var w = Math.max(280, sw + e.clientX - sx);
                f.style.width = w + 'px'; lbl.textContent = Math.round(w) + 'px';
              });
              document.addEventListener('mouseup', function() {
                if (!drag) return; drag = false; document.body.style.cursor = ''; document.body.style.userSelect = '';
              });
            })();

            var timer;
            var textarea = document.getElementById('bodyMarkdown');
            var subject = document.getElementById('subject');
            var frame = document.getElementById('previewFrame');

            function updatePreview() {
              var body = textarea.value;
              if (!body.trim()) return;
              fetch('/admin/campaigns/preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  bodyMarkdown: body,
                  subject: subject.value || 'Preview',
                  listName: 'Preview'
                })
              })
              .then(function(r) { return r.text(); })
              .then(function(html) { frame.srcdoc = html; });
            }

            textarea.addEventListener('input', function() {
              clearTimeout(timer);
              timer = setTimeout(updatePreview, 500);
            });
            subject.addEventListener('input', function() {
              clearTimeout(timer);
              timer = setTimeout(updatePreview, 500);
            });
          })();
        `}} />

        {/* Image upload modal */}
        <div id="imageModal" class="hidden fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
          <div class="bg-white rounded-lg p-6 max-w-sm w-full mx-4 shadow-xl">
            <h3 class="font-semibold text-gray-800 mb-1" id="imageModalName"></h3>
            <p class="text-xs text-gray-500 mb-4" id="imageModalSize"></p>
            <div class="flex flex-col gap-2">
              <button type="button" id="imageEmbedBtn" class="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 border-none cursor-pointer">
                Embed in email (inline attachment, always displays)
              </button>
              <button type="button" id="imageS3Btn" class="px-4 py-2 bg-white text-gray-700 text-sm font-medium rounded-md hover:bg-gray-50 border border-gray-300 cursor-pointer">
                Host on S3 (smaller email size)
              </button>
              <button type="button" id="imageModalClose" class="px-4 py-2 text-gray-500 text-sm hover:text-gray-700 border-none cursor-pointer bg-transparent">Cancel</button>
            </div>
          </div>
        </div>

        <script dangerouslySetInnerHTML={{ __html: `
          (function() {
            var dropZone = document.getElementById('imageDropZone');
            var fileInput = document.getElementById('imageFileInput');
            var modal = document.getElementById('imageModal');
            var modalName = document.getElementById('imageModalName');
            var modalSize = document.getElementById('imageModalSize');
            var embedBtn = document.getElementById('imageEmbedBtn');
            var s3Btn = document.getElementById('imageS3Btn');
            var closeBtn = document.getElementById('imageModalClose');
            var pendingField = document.getElementById('pendingImagesJson');
            var pendingMap = {};
            var currentFile = null;
            var processedData = null;

            function formatBytes(b) {
              if (b < 1024) return b + ' B';
              if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
              return (b / 1024 / 1024).toFixed(1) + ' MB';
            }

            function insertAtCursor(text) {
              var ta = document.getElementById('bodyMarkdown');
              var start = ta.selectionStart, end = ta.selectionEnd;
              ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
              ta.selectionStart = ta.selectionEnd = start + text.length;
              ta.dispatchEvent(new Event('input'));
            }

            function handleFile(file) {
              if (!file || !file.type.startsWith('image/')) return;
              currentFile = file;
              var formData = new FormData();
              formData.append('image', file);
              fetch('/admin/campaigns/upload-image', { method: 'POST', body: formData })
                .then(function(r) { return r.json(); })
                .then(function(data) {
                  processedData = data;
                  modalName.textContent = file.name;
                  modalSize.textContent = 'Original: ' + formatBytes(data.originalSizeBytes) + ' \\u2192 ' + formatBytes(data.sizeBytes) + ' WebP (' + data.width + '\\u00d7' + data.height + ')';
                  embedBtn.textContent = 'Embed in email (' + formatBytes(data.sizeBytes) + ' inline, always displays)';
                  s3Btn.textContent = 'Host on S3 (tiny email, uploads on save)';
                  modal.classList.remove('hidden');
                })
                .catch(function() { alert('Failed to process image'); });
            }

            dropZone.addEventListener('click', function() { fileInput.click(); });
            fileInput.addEventListener('change', function() { if (this.files[0]) handleFile(this.files[0]); });
            dropZone.addEventListener('dragover', function(e) { e.preventDefault(); this.classList.add('border-blue-400', 'bg-blue-50'); });
            dropZone.addEventListener('dragleave', function() { this.classList.remove('border-blue-400', 'bg-blue-50'); });
            dropZone.addEventListener('drop', function(e) {
              e.preventDefault();
              this.classList.remove('border-blue-400', 'bg-blue-50');
              if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
            });

            embedBtn.addEventListener('click', function() {
              if (processedData) {
                insertAtCursor('\\n![image](' + processedData.dataUri + ')\\n');
                modal.classList.add('hidden');
              }
            });

            s3Btn.addEventListener('click', function() {
              if (processedData) {
                var uuid = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
                pendingMap[uuid] = processedData.dataUri;
                pendingField.value = JSON.stringify(pendingMap);
                insertAtCursor('\\n<!-- s3-pending:' + uuid + ' -->\\n');
                modal.classList.add('hidden');
              }
            });

            closeBtn.addEventListener('click', function() { modal.classList.add('hidden'); });
            modal.addEventListener('click', function(e) { if (e.target === modal) modal.classList.add('hidden'); });
          })();
        `}} />
      </AdminLayout>,
    );
  });

  app.post("/campaigns/:id/edit", async (c) => {
    const user = c.get("user") as User;
    const id = Number(c.req.param("id"));
    const campaign = db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id)).get();
    if (!campaign) return c.notFound();
    if (campaign.status !== "draft" && campaign.status !== "failed") {
      return c.redirect(`/admin/campaigns/${id}`);
    }

    const body = await c.req.parseBody();
    const fromAddress = String(body["fromAddress"] ?? "").trim();
    const fromName = String(body["fromName"] ?? "").trim() || null;
    const subject = String(body["subject"] ?? "").trim();
    const bodyMarkdown = String(body["bodyMarkdown"] ?? "");

    const validModes = ["list", "all", "tag", "specific"] as const;
    let audienceMode = validModes.includes(body["audienceMode"] as any) ? body["audienceMode"] as string : "list";

    if (audienceMode === "all" && !["owner", "admin"].includes(user.role)) {
      audienceMode = "list"; // fallback
    }

    let audienceType: string = audienceMode === "specific" ? "subscribers" : audienceMode;
    let audienceId: number | null = null;
    let audienceData: string | null = null;

    if (audienceMode === "list") {
      const rawListId = body["listId"];
      if (rawListId) audienceId = Number(rawListId);
    } else if (audienceMode === "tag") {
      const tagId = Number(body["tagId"]);
      if (tagId) audienceId = tagId;
    } else if (audienceMode === "specific") {
      const ids = String(body["subscriberIds"] ?? "").split(",").map(Number).filter(Boolean);
      if (ids.length > 0) audienceData = JSON.stringify(ids);
    }

    if (!fromAddress || !subject || !bodyMarkdown) {
      return c.redirect(`/admin/campaigns/${id}/edit`);
    }

    const scheduledAt = body["scheduledAt"] ? new Date(String(body["scheduledAt"])).toISOString() : null;
    const batchSize = body["batchSize"] ? parseInt(String(body["batchSize"]), 10) || null : null;
    const batchInterval = body["batchInterval"] ? parseInt(String(body["batchInterval"]), 10) || null : null;
    const status = scheduledAt ? "scheduled" : "draft";
    let pendingMap: Record<string, string> = {};
    try { pendingMap = JSON.parse(String(body["pendingImagesJson"] ?? "{}")); } catch {}

    const processedMarkdown = (config.s3MediaBucket && Object.keys(pendingMap).length > 0)
      ? await processPendingS3Images(bodyMarkdown, id, pendingMap, config)
      : bodyMarkdown;

    db.update(schema.campaigns)
      .set({ audienceType, audienceId, audienceData, fromAddress, fromName, subject, bodyMarkdown: processedMarkdown, scheduledAt, batchSize, batchInterval, status })
      .where(eq(schema.campaigns.id, id))
      .run();

    logEvent(db, {
      type: "admin.campaign_edited",
      detail: subject,
      campaignId: id,
      userId: user.id,
    });

    setFlash(c, "Campaign saved.");
    return c.redirect(`/admin/campaigns/${id}`);
  });

  app.post("/campaigns/:id/send", async (c) => {
    const id = Number(c.req.param("id"));
    try {
      await sendCampaign(db, config, id);
    } catch (err) {
      // error is recorded in campaign.lastError by sender
    }
    setFlash(c, "Campaign is sending.");
    return c.redirect(`/admin/campaigns/${id}`);
  });

  app.post("/campaigns/:id/retry", async (c) => {
    const id = Number(c.req.param("id"));
    try {
      await sendCampaign(db, config, id);
    } catch (err) {
      // error is recorded in campaign.lastError by sender
    }
    setFlash(c, "Campaign retrying.");
    return c.redirect(`/admin/campaigns/${id}`);
  });

  app.post("/campaigns/:id/reset", (c) => {
    const id = Number(c.req.param("id"));
    db.update(schema.campaigns)
      .set({ status: "draft", lastError: null })
      .where(eq(schema.campaigns.id, id))
      .run();
    setFlash(c, "Campaign reset to draft.");
    return c.redirect(`/admin/campaigns/${id}`);
  });

  app.post("/campaigns/:id/unschedule", (c) => {
    const id = Number(c.req.param("id"));
    db.update(schema.campaigns)
      .set({ status: "draft", scheduledAt: null })
      .where(eq(schema.campaigns.id, id))
      .run();
    setFlash(c, "Campaign unscheduled.");
    return c.redirect(`/admin/campaigns/${id}`);
  });

  app.post("/campaigns/:id/delete", async (c) => {
    const user = c.get("user") as User;
    const id = Number(c.req.param("id"));
    const campaign = db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id)).get();

    await deleteCampaignS3Images(id, config);

    logEvent(db, {
      type: "admin.campaign_deleted",
      detail: campaign?.subject ?? `id=${id}`,
      campaignId: id,
      userId: user.id,
    });

    // clear linked messages (unlink, don't delete)
    db.update(schema.messages)
      .set({ campaignId: null })
      .where(eq(schema.messages.campaignId, id))
      .run();
    // delete sends
    db.delete(schema.campaignSends)
      .where(eq(schema.campaignSends.campaignId, id))
      .run();
    // delete campaign
    db.delete(schema.campaigns)
      .where(eq(schema.campaigns.id, id))
      .run();
    setFlash(c, "Campaign deleted.");
    return c.redirect("/admin/campaigns");
  });
}
