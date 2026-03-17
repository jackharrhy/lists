import { test, expect } from "bun:test";
import { createTestDb } from "./helpers";
import * as schema from "../src/db/schema";

test("test DB initializes with all tables", () => {
  const db = createTestDb();
  const lists = db.select().from(schema.lists).all();
  expect(lists).toEqual([]);
  const subscribers = db.select().from(schema.subscribers).all();
  expect(subscribers).toEqual([]);
  const campaigns = db.select().from(schema.campaigns).all();
  expect(campaigns).toEqual([]);
  const messages = db.select().from(schema.messages).all();
  expect(messages).toEqual([]);
});
