# Lists repository guide

## What this project is

Lists is a small, single-instance mailing-list service. It runs as one Bun process with a SQLite database and background workers for scheduled delivery, retries, inbound mail, and authentication cleanup. Keep solutions appropriate for that deployment model. Prefer durable database state and simple local code over distributed coordination or extra infrastructure.

Production is `https://lists.jackharrhy.dev`, deployed on the `mug` host from the `main` container image.

## Runtime and application structure

- Use Bun for installs, scripts, tests, builds, and production execution.
- The HTTP framework is Elysia. Do not introduce Hono or framework compatibility layers.
- Compose route modules as Elysia plugins through `createHttpApp()` in `src/http.ts`.
- Define body, query, parameter, cookie, and response schemas on routes. Let Elysia infer handler types instead of casting request data manually.
- Reuse the shared operation contracts for REST and MCP. Do not create transport-specific business logic or duplicate validation rules.
- REST lives under `/api/v1`; MCP is the stateless Streamable HTTP endpoint under `/mcp/`.
- Server-rendered pages use `@elysia/html` and Kita JSX. Dynamic child text is not escaped by default. Use `safe`, `Html.escapeHtml`, or an equivalent deliberate escape at every authored or user-controlled text boundary. Attributes are escaped by the renderer.
- Keep browser JavaScript in `src/client.ts` or a focused client module. Pages must remain usable through normal links and form submissions without JavaScript where practical.

Useful locations:

- `src/index.ts`: process startup, route mounting, workers
- `src/routes/`: public, admin, API, MCP, OAuth, and webhook transports
- `src/operations/`: canonical API and MCP operations
- `src/services/`: email, delivery, templates, inbound processing, and auth services
- `src/db/schema.ts`: current database schema
- `drizzle/`: ordered SQLite migrations
- `tests/helpers.ts`: isolated test database setup

## Admin design system

`src/routes/admin/design.tsx` is the canonical visual reference for the admin interface. Check it before creating or restyling admin UI. Reuse components from `src/routes/admin/ui.tsx` when they fit. If the system needs a new reusable pattern, add it to the design page as part of the same change.

The current language is intentionally plain:

- system sans-serif typography with the existing type scale
- gray-50 page background and white content surfaces
- gray-200 borders instead of decorative shadows
- blue-600 for links and primary actions
- green, red, amber, and blue only for semantic state
- soft, consistent radii on cards, fields, and buttons
- compact tables and restrained spacing
- minimal chrome, no gradients, glass effects, page transitions, or ornamental animation

Preserve the very simple public-page design and its copy unless a task explicitly changes it. Do not apply generic landing-page aesthetics to admin tools.

## HTMX boundaries

The admin layout uses `hx-boost` and swaps the complete `#app-shell`. A boosted destination must render an element with that ID.

- Links from the admin shell to a standalone document must set `hx-boost="false"`.
- `/design`, raw email previews, and other isolated documents are full-page or iframe boundaries, not app-shell fragments.
- After adding a top-level admin navigation target, test both ordinary navigation and boosted navigation.
- Do not add visual page transitions. HTMX is used for navigation and focused partial updates only.

## Email and AWS rules

- Production mail is sent directly through AWS SES v2. SMTP is only the local Mailpit transport selected by `SMTP_URL`.
- AWS failures must remain visible. Do not silently fall back to local storage, another bucket, SMTP, or a best-effort path when required SES, S3, SQS, or SNS work fails.
- Outbound delivery is durable: campaigns, recipient attempts, retries, and SES events are database-backed. Preserve idempotency and restart recovery.
- SES delivery, bounce, and complaint notifications arrive through the verified SNS webhook. Hard bounces and complaints blocklist recipients.
- Inbound replies and DMARC reports arrive through SES receipt rules, S3, and SQS. The poller owns parsing and durable ingestion.
- Campaign media uses the configured S3 media bucket. Raw inbound messages use the inbound S3 bucket. Do not mix their responsibilities.
- Keep SES configuration-set metadata and message identifiers intact. They connect accepted sends to later delivery events.
- Every sent alternative must retain unsubscribe support. Preserve RFC 8058 one-click headers and per-list unsubscribe behavior.
- Email templates may contain validated HTML, MJML, text, Handlebars variables, sections, and partials. Preview HTML stays sandboxed, and remote assets stay disabled unless the operator opts in.

## Persistence and security

- SQLite is the source of truth. Avoid process-memory sessions, tokens, delivery state, or other state that must survive a restart.
- Add schema changes as forward migrations. Test migrations that transform or remove data.
- Owner and admin roles have global access. Member access is restricted by assigned lists. Apply the same authorization in UI, REST, and MCP operations.
- API tokens store hashes, inherit the issuing user's access, and narrow it with scopes. Destructive operations and sends require explicit confirmation.
- OAuth uses authorization code with PKCE. Do not add a parallel account system.
- Treat template content, OAuth client metadata, subscriber data, inbound mail, and query parameters as untrusted.
- Never weaken SNS verification in production. The local bypass is only for an explicitly configured local environment.

## Testing and verification

Use the smallest relevant test while working, then run the full check before handing off a code change:

```sh
bun run check
```

This runs TypeScript checking, the Bun test suite, and both asset builds. Do not hand-edit generated `public/styles.css` or `public/app.js`; use `bun run build:assets`.

Test at the right layer:

- unit tests for parsing, validation, and pure service behavior
- HTTP flow tests for auth, forms, HTMX contracts, escaping, and route behavior
- shared REST/MCP tests for operation parity and scopes
- mocked AWS tests for failure handling and lifecycle transitions
- compose tests for real local S3, SQS, SMTP, inbound mail, and DMARC flows

Expected failure logs in negative-path tests are not test failures. Assert the returned status and durable state.

For the complete local stack:

```sh
docker compose up --build --wait
bun run test:local
```

Moto provides local S3, SQS, and SES-shaped APIs. Mailpit captures SMTP. See `LOCAL_DEVELOPMENT.md` for endpoints and local credentials. No real AWS credentials are required.

## Related repositories and production ownership

The application repository is `https://github.com/jackharrhy/lists`.

The sibling infra repository at `/home/jack/infra` owns production resources and deployment configuration:

- `/home/jack/infra/aws`: Pulumi for SES, SNS, S3, SQS, Lambda, IAM, and the media bucket
- `/home/jack/infra/dns`: octoDNS zones, including SPF, DKIM, DMARC, MAIL FROM, and inbound MX records
- `/home/jack/infra/hosts/mug`: production compose and Traefik routing
- `/home/jack/infra/cli.py`: host, deploy, DNS, and diagram commands

Use the infra repository as the authority for production wiring. Application changes may identify an infra requirement, but do not edit or deploy the infra repository unless the task explicitly includes it. Historical plans under `/home/jack/infra/docs/plans` are useful context, but some describe the old Hono or listmonk design and are not current architecture.

The `main` branch builds and publishes `ghcr.io/jackharrhy/lists:main`. The infra CLI updates the `mug` deployment. AWS Pulumi uses project-local state and the scripts documented in `/home/jack/infra/aws/README.md`.

## Working conventions

- Keep changes focused and preserve unrelated user work in the tree.
- Prefer a small shared abstraction after duplication becomes real. Do not build speculative frameworks.
- Fail loudly at required external-system boundaries and include enough context to diagnose the operation.
- Add a regression test with every bug fix.
- Update `API.md`, `LOCAL_DEVELOPMENT.md`, the admin design page, or this file when their documented contract changes.
