import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema";

export function createDb(dbPath: string) {
  const db = drizzle(dbPath, { schema });
  migrate(db, { migrationsFolder: "./drizzle" });
  return db;
}

export type Db = ReturnType<typeof createDb>;
export { schema };
