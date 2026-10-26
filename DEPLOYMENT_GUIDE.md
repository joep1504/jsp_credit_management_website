# Deploying the protected contact form

The English and Chinese homepages use a shared contact form. Telephone numbers
and public email links have been removed. GitHub Pages serves only static files;
it cannot send messages or safely store credentials. A Cloudflare Worker verifies
submissions and uses Resend to send them to a private recipient.

**Deployment is not complete until the Worker, Turnstile and email delivery are
configured and a real test message arrives.** Until public configuration is
provided, the form stays disabled and displays an unavailable message. Deploy the
backend before publishing the updated pages to avoid a gap in contact access.

## 1. Create the service accounts

- Create a Cloudflare account and a **Managed Turnstile** widget. Allow only
  `www.jspcreditmanagement.co.uk` and `jspcreditmanagement.co.uk` (no wildcard).
  Record its public site key and private secret key.
- Create a Resend account, verify a sending domain with the required DNS records
  (including SPF/DKIM), and create a sending-only API key scoped to that domain.
  Use an approved sender on that domain, not a visitor's address.
- Review both providers' data-processing terms, update your privacy information
  for enquiry processing, and set appropriate email retention/access controls.

## 2. Configure and deploy the Worker

Install Node.js, then run from the repository root:

```sh
cd contact-worker
npx wrangler login
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put CONTACT_FROM
npx wrangler secret put CONTACT_RECIPIENT
npx wrangler deploy
```

Enter each value interactively. `CONTACT_FROM` is your verified sender (optionally
`JSP Website <sender@your-verified-domain>`). Set `CONTACT_RECIPIENT` to the help
mailbox confirmed for this task. Do not put that address or secrets in HTML,
JavaScript, Wrangler variables, source control or build logs. GitHub Pages may
publish source files, so only Cloudflare secrets should contain these values.

Review `contact-worker/wrangler.jsonc`: `ALLOWED_ORIGINS` must list exact website
origins, and `TURNSTILE_HOSTNAMES` must list exact widget hostnames. No development
origins or Turnstile test keys should be left in production. The rate limiter
namespace must be unique to this application within your Cloudflare account.

## 3. Connect the website

In `contact-config.js`, set:

```js
window.CONTACT_CONFIG = Object.freeze({
    endpoint: "https://jsp-contact.YOUR-SUBDOMAIN.workers.dev/contact",
    turnstileSiteKey: "YOUR_PUBLIC_TURNSTILE_SITE_KEY"
});
```

These two values are public, not secrets. No recipient address is returned by the
API. Visitors' addresses are set as the email Reply-To, never as the sender.

Publish the website files to the branch configured in GitHub Pages and wait for
the Pages deployment to finish. Preserve `CNAME`.

`_headers` includes Turnstile script/frame permissions and Worker connections for
hosts that support that file. **GitHub Pages does not apply `_headers`.** If a CDN
or proxy sets a Content Security Policy, update it there as well; narrow
`https://*.workers.dev` to the deployed Worker's exact origin. A custom API domain
also needs its origin added to `connect-src`.

## 4. Verify before considering the deployment complete

- Check both homepages on desktop and mobile, including keyboard navigation.
- Submit a real enquiry from each language page, complete Turnstile, and confirm
  arrival at the private help mailbox. Confirm Reply-To addresses the visitor.
- Confirm the phone number and business email addresses are absent from rendered
  pages, HTML and public configuration.
- Verify failed/expired challenges cannot send messages, and retry works after
  an error. Block the API and check the page does not claim success.
- Check that a fourth request from the same IP within a minute is rejected with
  HTTP 429. Shared office networks can share this allowance.
- Verify the Worker rejects requests without an allowed Origin, invalid input,
  filled honeypots and oversized bodies, and that secrets are not returned.

Local automated checks (no real submissions or credentials):

```sh
node --test contact-worker/worker.test.mjs
```

For local browser testing, serve the repository over HTTP and inject a mocked
Turnstile/API, or configure a separate development Worker/widget. Never disable
server-side verification on the production Worker.

## Protections and limitations

The server requires a valid, single-use Turnstile token with the expected action
and hostname. It also checks exact allowed origins, validates field types and
lengths, rejects header injection, limits the streamed request body, checks a
honeypot and a minimum three-second completion time, and rate-limits each IP to
three attempts per minute. The timing and honeypot checks are supplemental, not
security boundaries. Origin checks are not authentication; non-browser clients
can forge them.

Cloudflare rate limits are approximate and per location, not a global abuse or
spending cap. Monitor Cloudflare and Resend usage, configure account alerts and
review spam reports. No public form can eliminate all bots. Turnstile requires
JavaScript and access to Cloudflare; unavailable checks fail closed.

The Worker uses plain-text email, keeps the recipient in server-side secrets,
does not log enquiry contents, and reports delivery/provider failures rather
than pretending success. Resend acceptance confirms queuing, not inbox arrival:
monitor bounces/delivery events in Resend. An idempotency key prevents duplicate
provider sends for identical retries within Resend's retention window.

This change does not alter the separate debt-instruction page or its existing
submission behaviour.
