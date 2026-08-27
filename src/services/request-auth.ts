import type { Db } from "../db";
import { type Principal } from "./access";
import { authenticateApiToken } from "./api-tokens";

export function authenticateBearer(db: Db, request: Request): Principal | null {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice(7);
  return authenticateApiToken(db, token);
}
