# jsp_credit_management_website
 JSP Credit Management Website

The bilingual contact form uses a Cloudflare Worker, Turnstile and Resend.
See [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) for required private configuration
and deployment steps. Without configuration, the form remains unavailable.

Run the contact API checks with `node --test contact-worker/worker.test.mjs`.
