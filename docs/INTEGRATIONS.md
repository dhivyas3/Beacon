# Integrations

How to start Beacon checks from other systems and hear back when they finish. This page covers
the API side that exists today: starting checks, callbacks and email. Ready-made n8n and
monday.com workflows, including the pattern where n8n owns the schedule, arrive in phase 9.

## Starting a check

Create an API key in Settings (an admin does this) and send it as a bearer token.

```bash
# Check a registered website, as an n8n workflow would
curl -X POST https://beacon.example.com/api/v1/websites/web_a1B2c3D4e5F6/check-now \
  -H "Authorization: Bearer $BEACON_KEY" -H 'content-type: application/json' \
  -d '{"source":"n8n","callbackUrl":"https://n8n.example.com/webhook/beacon","metadata":{"mondayItemId":"1234567890"}}'

# A one-off scan of any allowed site, optionally against a website's configuration
curl -X POST https://beacon.example.com/api/v1/scans \
  -H "Authorization: Bearer $BEACON_KEY" -H 'content-type: application/json' \
  -H 'Idempotency-Key: monday-1234567890' \
  -d '{"url":"https://www.example-estates.co.uk","callbackUrl":"https://n8n.example.com/webhook/beacon"}'
```

Both answer `202` with the scan's id and links. `source` (`n8n` or `monday`) is shown in the
dashboard so a check can be traced to where it came from. `metadata` is returned to you untouched
in the callback. A hostname can only have one active scan, and a second request gets `409` with
the running scan in `error.details.scan`.

## Callbacks

When a scan completes, fails or is cancelled, Beacon POSTs JSON to its `callbackUrl`.

```
POST /webhook/beacon
Content-Type: application/json
User-Agent: BeaconBot/1.0 (website health monitor)
X-Beacon-Event: scan.completed
X-Beacon-Delivery: whd_Ab12Cd34Ef56
X-Beacon-Attempt: 1
X-Beacon-Signature: sha256=3f5b...
```

```json
{
  "event": "scan.completed",
  "deliveryId": "whd_Ab12Cd34Ef56",
  "sentAt": "2026-09-18T10:47:02.000Z",
  "scan": {
    "id": "scn_a1B2c3D4e5F6",
    "url": "https://www.example-estates.co.uk/",
    "hostname": "www.example-estates.co.uk",
    "runNumber": 7,
    "status": "completed",
    "checks": ["images", "links", "seo"],
    "triggeredByType": "n8n",
    "pageSelectionMode": "random_sample",
    "website": { "id": "web_a1B2c3D4e5F6", "name": "Example Estates" },
    "metadata": { "mondayItemId": "1234567890" },
    "summary": { "healthScore": 94, "scoreChange": 4, "pages": 8, "critical": 0, "warnings": 3, "passed": 5 },
    "errorMessage": null,
    "createdAt": "2026-09-18T10:42:40.000Z",
    "startedAt": "2026-09-18T10:42:49.000Z",
    "finishedAt": "2026-09-18T10:47:01.000Z",
    "statusUrl": "https://beacon.example.com/api/v1/scans/scn_a1B2c3D4e5F6",
    "reportUrl": "https://beacon.example.com/scans/scn_a1B2c3D4e5F6"
  }
}
```

A failed scan has `"status": "failed"`, a null `healthScore` and the reason in `errorMessage`. The
full schema is `CallbackPayload` in the OpenAPI document at `/api/docs`.

### Verify the signature

The signature is the HMAC-SHA256 of the **raw request body**, keyed with the webhook secret shown
in Settings, as lowercase hex, prefixed `sha256=`. Compute it over the bytes you received, before
parsing, and compare in constant time. Reject the request if it does not match.

```js
// Node
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(rawBody, header, secret) {
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  return header?.length === expected.length && timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}
```

```python
# Python
import hmac, hashlib

def verify(raw_body: bytes, header: str, secret: str) -> bool:
    expected = "sha256=" + hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header or "")
```

In an n8n Webhook node, enable **Raw Body** so the body is available unparsed, then verify in a
Code node before continuing.

### Delivery and retries

- Any `2xx` answer is delivery. Answer quickly and do the work afterwards: Beacon waits 15 seconds.
- A `5xx`, `408`, `425`, `429`, a timeout or a network error is retried, up to six attempts in
  all, waiting 30 seconds, 2 minutes, 10 minutes, 1 hour, then 6 hours.
- Any other answer is final, including `404` (for example an n8n workflow that is not active) and
  any redirect. Redirects are never followed, so the body only goes where you pointed it.
- `X-Beacon-Delivery` and `deliveryId` are the same on every attempt. Remember them if your
  receiver must not process a scan twice. The body's `sentAt` changes per attempt.
- The address must be a public one. Private and loopback addresses are refused unless the server
  runs with `ALLOW_LOCAL_TARGETS=true`, which is for development only.

## Email reports

A registered website emails its recipients after every completed check. Set the provider with the
`EMAIL_*` variables in `.env` (see `.env.example`). With none set, emails are written to
`data/outbox` as HTML, so nothing is sent while you build a workflow.

| What | Where |
| --- | --- |
| Turn emails off for a website, keeping its recipients | `PATCH /websites/:id` with `"emailEnabled": false` |
| Add, pause or change a recipient | `POST` and `PATCH /websites/:id/recipients` (`isActive`, `notify`) |
| See what was sent, and why something was not | `GET /websites/:id/email-deliveries` |
| Preview the design | `pnpm email:preview` |

`notify` is `every_check` or `new_issues_only`. Recipients change this themselves from the link in
each email, which also lets them unsubscribe.
