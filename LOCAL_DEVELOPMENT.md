# Local development

The complete application can run without an AWS account. Moto emulates S3 and SQS, while Mailpit captures outgoing messages in a browser-accessible inbox.

```sh
docker compose up --build --wait
```

If the default host ports are occupied, choose alternatives. The container ports and service-to-service
addresses stay the same:

```sh
LISTS_APP_PORT=18080 LISTS_MAILPIT_PORT=18025 \
LISTS_MOTO_PORT=15000 LISTS_SMTP_PORT=11025 \
BASE_URL=http://localhost:18080 \
S3_MEDIA_BASE_URL=http://localhost:15000/lists-media \
docker compose up --build --wait
```

With those overrides, open Lists at http://localhost:18080 and Mailpit at
http://localhost:18025. Set `BASE_URL` to the browser-reachable Lists URL so confirmation and
unsubscribe links in captured email work. `SMTP_URL` points to Mailpit inside Compose, so neither
confirmation nor campaign delivery contacts SES. Moto handles the remaining local AWS APIs.

To open the stack from another machine on a Tailnet or LAN, override its public URLs:

```sh
BASE_URL=http://100.x.y.z:8080 \
S3_MEDIA_BASE_URL=http://100.x.y.z:5000/lists-media \
docker compose up --build --wait
```

- Application: http://localhost:8080
- Admin login: `owner@lists.local` / `local-password`
- Mailpit inbox: http://localhost:8025
- Moto API: http://localhost:5000

The credentials in `compose.yml` are deliberately fake and are used only to satisfy AWS request signing.

Run the full local integration test after the stack is healthy. Running it inside the app container
does not require Bun on the host or host-port-specific test settings:

```sh
docker compose exec -T \
  -e LOCAL_APP_URL=http://localhost:8080 \
  -e LOCAL_MOTO_URL=http://moto:5000 \
  -e LOCAL_MAILPIT_URL=http://mailpit:8025 \
  app bun run test:local
```

The tests create isolated lists, exercise API signup and campaign draft editing, confirm a subscription
through a Mailpit message, and verify that a revised campaign reaches Mailpit with an unsubscribe
header. They also exercise public signup, inbound S3/SQS mail, and DMARC processing.

For a manual integration test, create a list at `/admin/lists/new` with sending domain `lists.local`
and sender `news@lists.local`. Mint a token at `/admin/tokens` with `lists:read`,
`subscribers:write`, `campaigns:read`, and `campaigns:write`. The API is at `/api/v1` and Mailpit
shows all outbound mail. Leave `campaigns:send` off the integration token; use the Lists admin UI
for the deliberate final send.

Stop the stack while retaining the local database and captured messages:

```sh
docker compose down
```

Reset all local data and AWS resources:

```sh
docker compose down --volumes
```

Moto validates the application-owned AWS API flows. A small real-AWS staging smoke test is still needed for SES receipt rules, DNS, SNS signature validation, and deliverability.
