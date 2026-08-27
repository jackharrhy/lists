# Local development

The complete application can run without an AWS account. Moto emulates S3 and SQS, while Mailpit captures outgoing messages in a browser-accessible inbox.

```sh
docker compose up --build --wait
```

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

Run the full local integration test after the stack is healthy:

```sh
bun run test:local
```

The test creates an isolated list, submits a real subscription through HTTP, checks the resulting confirmation in Mailpit, uploads a raw email to Moto S3, sends its receipt through Moto SQS, and waits for the running application to display the inbound message.

Stop the stack while retaining the local database and captured messages:

```sh
docker compose down
```

Reset all local data and AWS resources:

```sh
docker compose down --volumes
```

Moto validates the application-owned AWS API flows. A small real-AWS staging smoke test is still needed for SES receipt rules, DNS, SNS signature validation, and deliverability.
