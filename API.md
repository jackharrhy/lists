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

Personal access tokens work directly. OAuth clients discover authorization metadata at:

- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-authorization-server`

Register public OAuth clients from `/admin/tokens`. Anonymous dynamic client registration is disabled
by default; it can be enabled deliberately with `OAUTH_DYNAMIC_REGISTRATION_ENABLED=true`.

The OAuth flow supports authorization code with PKCE (`S256`), one-hour access tokens, and refresh
tokens. Authorization uses the existing Lists login and account roles; OAuth does not create a
parallel user system.
