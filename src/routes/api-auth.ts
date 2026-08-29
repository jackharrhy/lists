import { Elysia } from "elysia";
import type { Db } from "../db";
import { authenticateBearer } from "../services/request-auth";

type BearerAuthOptions = {
  unauthorizedBody?: Record<string, unknown>;
  resourceMetadata?: string;
  expectedAudience?: string;
};

export function bearerAuth(db: Db, options: BearerAuthOptions = {}) {
  return new Elysia({ name: "bearer-auth" }).macro({
    authenticated: {
      resolve({ request, set, status }) {
        const principal = authenticateBearer(db, request, options.expectedAudience);
        if (!principal) {
          if (options.resourceMetadata) {
            set.headers["www-authenticate"] = `Bearer resource_metadata="${options.resourceMetadata}"`;
          }
          return status(401, options.unauthorizedBody ?? { error: "Unauthorized" });
        }
        return { principal };
      },
    },
  });
}
