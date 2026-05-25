---
name: Twilio webhook signature format
description: Exact payload concatenation rules for computing the HMAC-SHA1 signature Twilio sends in X-Twilio-Signature, and how to smoke-test signed webhooks locally.
---

The signed payload is: PUBLIC_URL + concat(key + value for each form param, sorted alphabetically by key). NO `=`, NO `&`, NO URL-encoding of values inside the signed string. URL-encode only the body of the actual POST request.

**Why:** First smoke test computed `Body=<v>From=<v>` (with `=` separators), got `403 Forbidden`. Twilio's spec is `<key><value>` concatenation with zero separators.

**How to apply:** When testing locally, the URL used for signing must be the public proxy URL (e.g. `https://<repl>.replit.app/api/webhook/twilio`), even when POSTing to `localhost:80`. The server reconstructs the URL from the `Host` header / proxy config — it must match what you signed against, or `verifyTwilioSignature` returns 403 with no body details. Reference smoke-test recipe is in this repo's session history; the key formula is `printf "%s" "${url}${k1}${v1}${k2}${v2}…" | openssl dgst -sha1 -hmac "$TWILIO_AUTH_TOKEN" -binary | base64`.
