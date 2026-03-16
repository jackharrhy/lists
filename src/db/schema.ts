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
  name: text("name"),
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
  listId: integer("list_id")
    .references(() => lists.id),
  subject: text("subject").notNull(),
  bodyMarkdown: text("body_markdown").notNull(),
  templateSlug: text("template_slug").notNull().default("newsletter"),
  fromAddress: text("from_address").notNull(),
  audience: text("audience"),
  status: text("status", {
    enum: ["draft", "sending", "sent", "failed"],
  })
    .notNull()
    .default("draft"),
  lastError: text("last_error"),
  sentAt: text("sent_at"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const campaignSends = sqliteTable("campaign_sends", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  campaignId: integer("campaign_id")
    .notNull()
    .references(() => campaigns.id),
  subscriberId: integer("subscriber_id")
    .notNull()
    .references(() => subscribers.id),
  sesMessageId: text("ses_message_id"),
  status: text("status", {
    enum: ["pending", "sent", "bounced"],
  })
    .notNull()
    .default("pending"),
  sentAt: text("sent_at"),
});

export const inboundMessages = sqliteTable("inbound_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  messageId: text("message_id").unique().notNull(),
  timestamp: text("timestamp").notNull(),
  source: text("source").notNull(),
  fromAddrs: text("from_addrs").notNull(),
  toAddrs: text("to_addrs").notNull(),
  subject: text("subject").notNull(),
  spamVerdict: text("spam_verdict"),
  virusVerdict: text("virus_verdict"),
  spfVerdict: text("spf_verdict"),
  dkimVerdict: text("dkim_verdict"),
  dmarcVerdict: text("dmarc_verdict"),
  s3Key: text("s3_key"),
  campaignId: integer("campaign_id").references(() => campaigns.id),
  readAt: text("read_at"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const replies = sqliteTable("replies", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  inboundMessageId: integer("inbound_message_id")
    .notNull()
    .references(() => inboundMessages.id),
  fromAddr: text("from_addr").notNull(),
  toAddr: text("to_addr").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  sesMessageId: text("ses_message_id"),
  inReplyTo: text("in_reply_to"),
  sentAt: text("sent_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(),
  detail: text("detail").notNull().default(""),
  meta: text("meta"), // JSON blob for structured data
  userId: integer("user_id").references(() => users.id),
  subscriberId: integer("subscriber_id").references(() => subscribers.id),
  campaignId: integer("campaign_id").references(() => campaigns.id),
  inboundMessageId: integer("inbound_message_id").references(() => inboundMessages.id),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});
