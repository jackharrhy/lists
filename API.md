# Lists API and MCP

The REST API and MCP server are transports over the same operations and authorization policy.
Credentials belong to an existing Lists user, inherit that user's role and list assignments, and
are further restricted by scopes.

## Personal access tokens

Sign in to `/admin/tokens` to mint or revoke a token. A token is shown once; only its SHA-256 hash
is stored. Send it as `Authorization: Bearer lst_...`.

Scopes:

- `lists:read`
- `subscribers:read`, `subscribers:write`
- `campaigns:read`, `campaigns:write`, `campaigns:send`
- `templates:read`, `templates:write`
- `deliverability:read`
- `dmarc:read`

## REST API

The versioned base path is `/api/v1`.

| Method | Path | Scope |
| --- | --- | --- |
| GET | `/lists` | `lists:read` |
| GET, POST | `/subscribers` | `subscribers:read` / `subscribers:write` |
| GET, DELETE | `/subscribers/:id` | `subscribers:read` / `subscribers:write` |
| GET, POST | `/campaigns` | `campaigns:read` / `campaigns:write` |
| GET | `/campaigns/:id` | `campaigns:read` |
| POST | `/campaigns/:id/send` | `campaigns:send` |
| GET | `/deliverability` | `deliverability:read` |
| GET | `/dmarc` | `dmarc:read` |
| GET, POST | `/email-templates` | `templates:read` / `templates:write` |
| GET, PUT, DELETE | `/email-templates/:slug` | `templates:read` / `templates:write` |
| POST | `/email-templates/:slug/preview` | `templates:read` |
| POST | `/email-templates/:slug/activate` | `templates:write` |

Destructive actions and sending require explicit confirmation. Campaign send bodies must contain
`{"confirm":true}`; subscriber deletion requires `?confirm=true`.

## MCP

The stateless Streamable HTTP endpoint is `/mcp/`. It supports `initialize`, `tools/list`, and
`tools/call`, and returns both text and structured tool results. The available tools mirror the
REST operations:

- `lists_list`
- `subscribers_list`, `subscriber_get`, `subscriber_delete`
- `campaigns_list`, `campaign_get`, `campaign_create_draft`, `campaign_send`
- `deliverability_summary`, `dmarc_summary`
- `email_templates_list`, `email_template_get`, `email_template_create`, `email_template_update`
- `email_template_validate`, `email_template_preview`, `email_template_duplicate`
- `email_template_activate`, `email_template_archive`

## Email template authoring

Templates support complete HTML, MJML, or text-only source. HTML and text alternatives are authored
independently with Handlebars variables, named campaign sections, and template-local partials. MJML is
compiled when an immutable version is created; campaigns pin a version rather than following later
edits. Creating or updating a version does not activate it.

Marketing templates must render every required section and an unsubscribe link in each available
alternative. Scripts, event-handler attributes, embedded browsing contexts, dangerous URL schemes,
and non-HTTPS remote assets are rejected. The admin UI at `/admin/templates` is read-only and renders
previews in sandboxed frames; remote assets are blocked unless explicitly enabled for that preview.

Personal access tokens work directly. OAuth clients discover authorization metadata at:

- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-authorization-server`

Register public OAuth clients from `/admin/tokens`. Anonymous dynamic client registration is disabled
by default; it can be enabled deliberately with `OAUTH_DYNAMIC_REGISTRATION_ENABLED=true`.

The OAuth flow supports authorization code with PKCE (`S256`), one-hour access tokens, and refresh
tokens. Authorization uses the existing Lists login and account roles; OAuth does not create a
parallel user system.
