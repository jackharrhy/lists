import {
  sqliteTable,
  text,
  integer,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").unique().notNull(),
  name: text("name"),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["owner", "admin", "member"] }).notNull().default("member"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const subscribers = sqliteTable("subscribers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").unique().notNull(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  status: text("status", {
    enum: ["active", "blocklisted"],
  })
    .notNull()
    .default("active"),
  unsubscribeToken: text("unsubscribe_token").unique().notNull(),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const lists = sqliteTable("lists", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  slug: text("slug").unique().notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  fromDomain: text("from_domain").notNull().default("jackharrhy.dev"),
  fromAddress: text("from_address").notNull().default(""),
});

export const userLists = sqliteTable("user_lists", {
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  listId: integer("list_id")
    .notNull()
    .references(() => lists.id),
});

export const subscriberLists = sqliteTable("subscriber_lists", {
  subscriberId: integer("subscriber_id")
    .notNull()
    .references(() => subscribers.id),
  listId: integer("list_id")
    .notNull()
    .references(() => lists.id),
  status: text("status", {
    enum: ["unconfirmed", "confirmed", "unsubscribed"],
  })
    .notNull()
    .default("unconfirmed"),
  subscribedAt: text("subscribed_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const tags = sqliteTable("tags", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").unique().notNull(),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const subscriberTags = sqliteTable("subscriber_tags", {
  subscriberId: integer("subscriber_id")
    .notNull()
    .references(() => subscribers.id),
  tagId: integer("tag_id")
    .notNull()
    .references(() => tags.id),
});

export const campaigns = sqliteTable("campaigns", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  subject: text("subject").notNull(),
  bodyMarkdown: text("body_markdown").notNull(),
  templateSlug: text("template_slug").notNull().default("newsletter"),
  fromAddress: text("from_address").notNull(),
  fromName: text("from_name"),
  audienceType: text("audience_type", {
    enum: ["list", "tag", "all", "subscribers"],
  }).notNull(),
  audienceId: integer("audience_id"),
  audienceData: text("audience_data"),
  status: text("status", {
    enum: ["draft", "scheduled", "sending", "sent", "failed"],
  }).notNull().default("draft"),
  scheduledAt: text("scheduled_at"),
  batchSize: integer("batch_size"),
  batchInterval: integer("batch_interval"),
  lastError: text("last_error"),
  sentAt: text("sent_at"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const campaignSends = sqliteTable("campaign_sends", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  campaignId: integer("campaign_id").notNull().references(() => campaigns.id),
  subscriberId: integer("subscriber_id").notNull().references(() => subscribers.id),
  sesMessageId: text("ses_message_id"),
  rfc822MessageId: text("rfc822_message_id"),
  status: text("status", { enum: ["pending", "sent", "bounced"] }).notNull().default("pending"),
  sentAt: text("sent_at"),
});

export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  threadId: integer("thread_id").notNull(),
  parentId: integer("parent_id"),
  direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
  rfc822MessageId: text("rfc822_message_id"),
  inReplyTo: text("in_reply_to"),
  fromAddr: text("from_addr").notNull(),
  toAddr: text("to_addr").notNull(),
  subject: text("subject").notNull(),
  bodyText: text("body_text"),
  bodyHtml: text("body_html"),
  sesMessageId: text("ses_message_id").unique(),
  s3Key: text("s3_key"),
  spamVerdict: text("spam_verdict"),
  virusVerdict: text("virus_verdict"),
  spfVerdict: text("spf_verdict"),
  dkimVerdict: text("dkim_verdict"),
  dmarcVerdict: text("dmarc_verdict"),
  campaignId: integer("campaign_id").references(() => campaigns.id),
  readAt: text("read_at"),
  sentAt: text("sent_at"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(),
  detail: text("detail").notNull().default(""),
  meta: text("meta"),
  userId: integer("user_id").references(() => users.id),
  subscriberId: integer("subscriber_id").references(() => subscribers.id),
  campaignId: integer("campaign_id").references(() => campaigns.id),
  messageId: integer("message_id").references(() => messages.id),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});
