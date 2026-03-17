import { Hono } from "hono";
import { eq, desc, and, inArray } from "drizzle-orm";
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
import { AdminLayout, fmtDate, fmtDateTime, CampaignBadge, describeAudience, type User } from "./layout";

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

  app.post("/campaigns/preview", async (c) => {
    const { bodyMarkdown, subject, listName } = await c.req.json();
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

  // Campaigns
  app.get("/campaigns", (c) => {
    const user = c.get("user") as User;
    const listAccess = getAccessibleListIds(db, user);

    let allCampaigns: (typeof schema.campaigns.$inferSelect)[];
    if (listAccess === "all") {
      allCampaigns = db
        .select()
        .from(schema.campaigns)
        .orderBy(desc(schema.campaigns.createdAt))
        .all();
    } else if (listAccess.length === 0) {
      allCampaigns = [];
    } else {
      allCampaigns = db
        .select()
        .from(schema.campaigns)
        .where(and(eq(schema.campaigns.audienceType, "list"), inArray(schema.campaigns.audienceId, listAccess)))
        .orderBy(desc(schema.campaigns.createdAt))
        .all();
    }

    // Build lookup maps for list and tag names
    const allLists = db.select().from(schema.lists).all();
    const listNameMap = new Map(allLists.map((l) => [l.id, l.name]));
    const allTags = db.select().from(schema.tags).all();
    const tagNameMap = new Map(allTags.map((t) => [t.id, t.name]));

    return c.html(
      <AdminLayout title="Campaigns" user={user}>
        <h1 class="text-2xl font-bold mt-0 mb-4">Campaigns</h1>
        <p>
          <a href="/admin/campaigns/new" class="inline-block px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 cursor-pointer border-none no-underline">
            New Campaign
          </a>
        </p>
        <table class="w-full bg-white rounded-lg overflow-hidden mb-6 text-sm">
          <thead>
            <tr>
              <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Subject</th>
              <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Audience</th>
              <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">From</th>
              <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Status</th>
              <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Created</th>
            </tr>
          </thead>
          <tbody>
            {allCampaigns.map((cam) => (
              <tr>
                <td class="px-4 py-3 border-b border-gray-100">
                  <a href={`/admin/campaigns/${cam.id}`} class="text-blue-600 hover:text-blue-800">{cam.subject}</a>
                </td>
                <td class="px-4 py-3 border-b border-gray-100">{describeAudience(cam, listNameMap, tagNameMap)}</td>
                <td class="px-4 py-3 border-b border-gray-100">{cam.fromAddress}</td>
                <td class="px-4 py-3 border-b border-gray-100">
                  <CampaignBadge status={cam.status} />
                </td>
                <td class="px-4 py-3 border-b border-gray-100">{fmtDate(cam.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </AdminLayout>,
    );
  });

  app.get("/campaigns/new", (c) => {
    const user = c.get("user") as User;
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
      <AdminLayout title="New Campaign" user={user}>
        <h1 class="text-2xl font-bold mt-0 mb-4">New Campaign</h1>
        <div class="grid grid-cols-2 gap-6">
          <div>
            <div class="bg-white border border-gray-200 rounded-lg p-5 mb-6">
              <form method="post" action="/admin/campaigns/new">
                <div class="mb-4">
                  <label for="audienceMode" class="block text-sm font-medium text-gray-700 mb-1">Audience</label>
                  <select id="audienceMode" name="audienceMode" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
                    <option value="list">A list</option>
                    <option value="all">All subscribers</option>
                    <option value="tag">A tag</option>
                    <option value="specific">Specific people</option>
                  </select>
                </div>

                <div data-audience="list" class="mb-4">
                  <label for="listId" class="block text-sm font-medium text-gray-700 mb-1">List</label>
                  <select id="listId" name="listId" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
                    <option value="">Select a list...</option>
                    {allLists.map((list) => (
                      <option value={String(list.id)} data-from-address={list.fromAddress}>
                        {list.name} ({list.slug})
                      </option>
                    ))}
                  </select>
                </div>

                <div data-audience="tag" class="mb-4 hidden">
                  <label for="tagId" class="block text-sm font-medium text-gray-700 mb-1">Tag</label>
                  <select id="tagId" name="tagId" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
                    <option value="">Select a tag...</option>
                    {allTags.map((tag) => (
                      <option value={String(tag.id)}>{tag.name}</option>
                    ))}
                  </select>
                </div>

                <div data-audience="specific" class="mb-4 hidden">
                  <label class="block text-sm font-medium text-gray-700 mb-1">Subscribers</label>
                  <input type="text" id="subscriberSearch" placeholder="Search by email or name..." class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                  <div id="searchResults" class="border border-gray-200 rounded-md max-h-40 overflow-y-auto hidden"></div>
                  <div id="selectedSubscribers" class="flex flex-wrap gap-2 mt-2"></div>
                  <input type="hidden" name="subscriberIds" id="subscriberIds" />
                </div>

                <div class="mb-4">
                  <label for="fromAddress" class="block text-sm font-medium text-gray-700 mb-1">From Address</label>
                  <input
                    type="email"
                    id="fromAddress"
                    name="fromAddress"
                    required
                    placeholder={`newsletter@${config.fromDomain}`}
                    class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div class="mb-4">
                  <label for="subject" class="block text-sm font-medium text-gray-700 mb-1">Subject</label>
                  <input type="text" id="subject" name="subject" required placeholder="Campaign subject" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                </div>
                <div class="mb-4">
                  <label for="bodyMarkdown" class="block text-sm font-medium text-gray-700 mb-1">Body (Markdown)</label>
                  <textarea id="bodyMarkdown" name="bodyMarkdown" required placeholder="Write your email in markdown…" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 min-h-[200px] resize-y focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                  <p class="text-xs text-gray-400 mt-1">{"Available variables: {{firstName}}, {{lastName}}, {{email}}, {{unsubscribeUrl}}, {{preferencesUrl}}"}</p>
                </div>
                <button type="submit" class="inline-block px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 cursor-pointer border-none no-underline">Create Draft</button>
              </form>
            </div>
          </div>
          <div>
            <div class="bg-white border border-gray-200 rounded-lg p-5 mb-6">
              <h2 class="text-lg font-semibold mt-0 mb-3">Preview</h2>
              <iframe id="previewFrame" class="w-full border-0" style="min-height: 500px;" srcdoc="<p style='color:#999;font-family:system-ui;padding:2rem'>Start writing to see a preview</p>" />
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

            // From address auto-fill: only for list mode
            var lastDefault = '';
            var listSelect = document.getElementById('listId');
            if (listSelect) {
              listSelect.addEventListener('change', function() {
                var opt = this.options[this.selectedIndex];
                var addr = opt.dataset.fromAddress || '';
                var input = document.getElementById('fromAddress');
                if (!input.value || input.value === lastDefault) input.value = addr;
                lastDefault = addr;
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

            // Preview
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
      </AdminLayout>,
    );
  });

  app.post("/campaigns/new", async (c) => {
    const user = c.get("user") as User;
    const body = await c.req.parseBody();
    const fromAddress = String(body["fromAddress"] ?? "").trim();
    const subject = String(body["subject"] ?? "").trim();
    const bodyMarkdown = String(body["bodyMarkdown"] ?? "");

    const audienceMode = String(body["audienceMode"] ?? "list");
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

    const result = db
      .insert(schema.campaigns)
      .values({ audienceType, audienceId, audienceData, fromAddress, subject, bodyMarkdown })
      .returning({ id: schema.campaigns.id })
      .get();

    logEvent(db, {
      type: "admin.campaign_created",
      detail: subject,
      campaignId: result.id,
      userId: user.id,
    });

    return c.redirect(`/admin/campaigns/${result.id}`);
  });

  app.get("/campaigns/:id", async (c) => {
    const user = c.get("user") as User;
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
      <AdminLayout title={campaign.subject} user={user}>
        <h1 class="text-2xl font-bold mt-0 mb-4">{campaign.subject}</h1>
        <div class="flex gap-4 items-center mb-4">
          <CampaignBadge status={campaign.status} />
          <span class="text-sm text-gray-500">
            Audience: {audienceDesc} &middot; From: {campaign.fromAddress}
          </span>
        </div>

        {campaign.lastError && (
          <div class="bg-red-50 border border-red-200 rounded-lg p-4 mb-6 font-mono text-sm whitespace-pre-wrap break-all text-red-800">
            <strong>Error:</strong>{"\n"}{campaign.lastError}
          </div>
        )}

        {(campaign.status === "draft" || campaign.status === "failed") && (
          <div class="flex gap-2 mb-6">
            <a href={`/admin/campaigns/${id}/edit`} class="inline-block px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 cursor-pointer border-none no-underline">
              Edit Campaign
            </a>
          </div>
        )}

        {campaign.status === "draft" && (
          <form method="post" action={`/admin/campaigns/${id}/send`} class="mb-6">
            <button type="submit" class="inline-block px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-md hover:bg-red-700 cursor-pointer border-none no-underline">
              Send Campaign
            </button>
          </form>
        )}

        {campaign.status === "failed" && (
          <div class="flex gap-2 mb-6">
            <form method="post" action={`/admin/campaigns/${id}/retry`}>
              <button type="submit" class="inline-block px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 cursor-pointer border-none no-underline">
                Retry (skip already sent)
              </button>
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
            <table class="w-full bg-white rounded-lg overflow-hidden mb-6 text-sm">
              <thead>
                <tr>
                  <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Subscriber ID</th>
                  <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Status</th>
                  <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Sent At</th>
                  <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">SES Message ID</th>
                </tr>
              </thead>
              <tbody>
                {sends.map((send) => (
                  <tr>
                    <td class="px-4 py-3 border-b border-gray-100">{send.subscriberId}</td>
                    <td class="px-4 py-3 border-b border-gray-100">{send.status}</td>
                    <td class="px-4 py-3 border-b border-gray-100">{fmtDateTime(send.sentAt)}</td>
                    <td class="px-4 py-3 border-b border-gray-100 text-xs">{send.sesMessageId ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
            <table class="w-full bg-white rounded-lg overflow-hidden mb-6 text-sm">
              <thead>
                <tr>
                  <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">From</th>
                  <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Subject</th>
                  <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">Received</th>
                  <th class="bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200"></th>
                </tr>
              </thead>
              <tbody>
                {inboundReplies.map((r) => (
                  <tr>
                    <td class="px-4 py-3 border-b border-gray-100">{r.fromAddr}</td>
                    <td class="px-4 py-3 border-b border-gray-100">{r.subject}</td>
                    <td class="px-4 py-3 border-b border-gray-100">{fmtDateTime(r.createdAt)}</td>
                    <td class="px-4 py-3 border-b border-gray-100"><a href={`/admin/inbound/${r.id}`} class="text-blue-600 hover:text-blue-800">View</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        <hr class="my-8" />
        <form method="post" action={`/admin/campaigns/${id}/delete`} onsubmit="return confirm('Delete this campaign and all its send records? This cannot be undone.')">
          <button type="submit" class="inline-block px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-md hover:bg-red-700 cursor-pointer border-none no-underline">
            Delete Campaign
          </button>
        </form>
      </AdminLayout>,
    );
  });

  app.get("/campaigns/:id/edit", (c) => {
    const user = c.get("user") as User;
    const id = Number(c.req.param("id"));
    const campaign = db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id)).get();
    if (!campaign) return c.notFound();
    if (campaign.status !== "draft" && campaign.status !== "failed") {
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
      <AdminLayout title={`Edit: ${campaign.subject}`} user={user}>
        <h1 class="text-2xl font-bold mt-0 mb-4">Edit Campaign</h1>
        <div class="grid grid-cols-2 gap-6">
          <div>
            <div class="bg-white border border-gray-200 rounded-lg p-5 mb-6">
              <form method="post" action={`/admin/campaigns/${id}/edit`}>
                <div class="mb-4">
                  <label for="audienceMode" class="block text-sm font-medium text-gray-700 mb-1">Audience</label>
                  <select id="audienceMode" name="audienceMode" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
                    <option value="list" selected={currentAudienceMode === "list"}>A list</option>
                    <option value="all" selected={currentAudienceMode === "all"}>All subscribers</option>
                    <option value="tag" selected={currentAudienceMode === "tag"}>A tag</option>
                    <option value="specific" selected={currentAudienceMode === "specific"}>Specific people</option>
                  </select>
                </div>

                <div data-audience="list" class={`mb-4${currentAudienceMode !== "list" ? " hidden" : ""}`}>
                  <label for="listId" class="block text-sm font-medium text-gray-700 mb-1">List</label>
                  <select id="listId" name="listId" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
                    <option value="">Select a list...</option>
                    {allLists.map((list) => (
                      <option value={String(list.id)} data-from-address={list.fromAddress} selected={currentListId === list.id}>
                        {list.name} ({list.slug})
                      </option>
                    ))}
                  </select>
                </div>

                <div data-audience="tag" class={`mb-4${currentAudienceMode !== "tag" ? " hidden" : ""}`}>
                  <label for="tagId" class="block text-sm font-medium text-gray-700 mb-1">Tag</label>
                  <select id="tagId" name="tagId" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
                    <option value="">Select a tag...</option>
                    {allTags.map((tag) => (
                      <option value={String(tag.id)} selected={currentTagId === tag.id}>{tag.name}</option>
                    ))}
                  </select>
                </div>

                <div data-audience="specific" class={`mb-4${currentAudienceMode !== "specific" ? " hidden" : ""}`}>
                  <label class="block text-sm font-medium text-gray-700 mb-1">Subscribers</label>
                  <input type="text" id="subscriberSearch" placeholder="Search by email or name..." class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                  <div id="searchResults" class="border border-gray-200 rounded-md max-h-40 overflow-y-auto hidden"></div>
                  <div id="selectedSubscribers" class="flex flex-wrap gap-2 mt-2"></div>
                  <input type="hidden" name="subscriberIds" id="subscriberIds" value={currentSubscriberIds.join(",")} />
                </div>

                <div class="mb-4">
                  <label for="fromAddress" class="block text-sm font-medium text-gray-700 mb-1">From Address</label>
                  <input
                    type="email"
                    id="fromAddress"
                    name="fromAddress"
                    required
                    value={campaign.fromAddress}
                    placeholder={`newsletter@${config.fromDomain}`}
                    class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div class="mb-4">
                  <label for="subject" class="block text-sm font-medium text-gray-700 mb-1">Subject</label>
                  <input type="text" id="subject" name="subject" required value={campaign.subject} placeholder="Campaign subject" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                </div>
                <div class="mb-4">
                  <label for="bodyMarkdown" class="block text-sm font-medium text-gray-700 mb-1">Body (Markdown)</label>
                  <textarea id="bodyMarkdown" name="bodyMarkdown" required placeholder="Write your email in markdown…" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-[inherit] mb-3 min-h-[200px] resize-y focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500">{campaign.bodyMarkdown}</textarea>
                  <p class="text-xs text-gray-400 mt-1">{"Available variables: {{firstName}}, {{lastName}}, {{email}}, {{unsubscribeUrl}}, {{preferencesUrl}}"}</p>
                </div>
                <button type="submit" class="inline-block px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 cursor-pointer border-none no-underline">Save Changes</button>
              </form>
            </div>
          </div>
          <div>
            <div class="bg-white border border-gray-200 rounded-lg p-5 mb-6">
              <h2 class="text-lg font-semibold mt-0 mb-3">Preview</h2>
              <iframe id="previewFrame" class="w-full border-0" style="min-height: 500px;" src={`/admin/campaigns/${id}/preview`} />
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

            // Preview
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
    const subject = String(body["subject"] ?? "").trim();
    const bodyMarkdown = String(body["bodyMarkdown"] ?? "");

    const audienceMode = String(body["audienceMode"] ?? "list");
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

    db.update(schema.campaigns)
      .set({ audienceType, audienceId, audienceData, fromAddress, subject, bodyMarkdown })
      .where(eq(schema.campaigns.id, id))
      .run();

    logEvent(db, {
      type: "admin.campaign_edited",
      detail: subject,
      campaignId: id,
      userId: user.id,
    });

    return c.redirect(`/admin/campaigns/${id}`);
  });

  app.post("/campaigns/:id/send", async (c) => {
    const id = Number(c.req.param("id"));
    try {
      await sendCampaign(db, config, id);
    } catch (err) {
      // error is recorded in campaign.lastError by sender
    }
    return c.redirect(`/admin/campaigns/${id}`);
  });

  app.post("/campaigns/:id/retry", async (c) => {
    const id = Number(c.req.param("id"));
    try {
      await sendCampaign(db, config, id);
    } catch (err) {
      // error is recorded in campaign.lastError by sender
    }
    return c.redirect(`/admin/campaigns/${id}`);
  });

  app.post("/campaigns/:id/reset", (c) => {
    const id = Number(c.req.param("id"));
    db.update(schema.campaigns)
      .set({ status: "draft", lastError: null })
      .where(eq(schema.campaigns.id, id))
      .run();
    return c.redirect(`/admin/campaigns/${id}`);
  });

  app.post("/campaigns/:id/delete", (c) => {
    const user = c.get("user") as User;
    const id = Number(c.req.param("id"));
    const campaign = db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id)).get();

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
    return c.redirect("/admin/campaigns");
  });
}
