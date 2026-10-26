import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import worker from "./worker.mjs";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function environment() {
    return {
        ALLOWED_ORIGINS: "https://www.example.com",
        TURNSTILE_HOSTNAMES: "www.example.com",
        TURNSTILE_SECRET_KEY: "test-secret",
        RESEND_API_KEY: "test-key",
        CONTACT_FROM: "Website <sender@example.com>",
        CONTACT_RECIPIENT: "private@example.com",
        CONTACT_RATE_LIMITER: { limit: async () => ({ success: true }) }
    };
}

function payload(overrides = {}) {
    return {
        name: "Example Customer",
        email: "customer@example.com",
        subject: "An enquiry",
        message: "Please help with this enquiry.",
        website: "",
        token: "test-token",
        startedAt: Date.now() - 5000,
        requestId: "c95067a8-6e01-4134-9c98-58e61a1a9067",
        ...overrides
    };
}

function request(body = payload(), options = {}) {
    return new Request("https://api.example.com/contact", {
        method: "POST",
        headers: {
            Origin: "https://www.example.com",
            "CF-Connecting-IP": "192.0.2.1",
            "Content-Type": "application/json",
            ...options.headers
        },
        body: typeof body === "string" ? body : JSON.stringify(body)
    });
}

function providers({ verification = {}, verifyStatus = 200, emailStatus = 200, emailBody = { id: "email-id" } } = {}) {
    const calls = [];
    globalThis.fetch = async (url, options) => {
        const body = JSON.parse(options.body);
        calls.push({ url, body, headers: options.headers });
        if (url.includes("siteverify")) {
            return Response.json({
                success: true, hostname: "www.example.com", action: "contact", ...verification
            }, { status: verifyStatus });
        }
        assert.equal(url, "https://api.resend.com/emails");
        return Response.json(emailBody, { status: emailStatus });
    };
    return calls;
}

test("valid enquiry sends private plain-text email and exposes no addresses or keys", async () => {
    const calls = providers();
    const response = await worker.fetch(request(), environment());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://www.example.com");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].body.to, ["private@example.com"]);
    assert.equal(calls[1].body.reply_to, "customer@example.com");
    assert.equal(calls[1].body.from, "Website <sender@example.com>");
    assert.equal(calls[1].body.html, undefined);
    assert.match(calls[1].body.text, /Please help/);
    assert.equal(calls[0].body.remoteip, "192.0.2.1");
});

test("Chinese names and messages are accepted", async () => {
    const calls = providers();
    const response = await worker.fetch(request(payload({
        name: "客户", subject: "咨询", message: "您好，请帮助我们处理此项咨询。"
    })), environment());
    assert.equal(response.status, 200);
    assert.match(calls[1].body.text, /客户/);
});

test("preflight is allowed only for configured origins", async () => {
    const calls = providers();
    for (const [origin, status] of [["https://www.example.com", 204], ["https://evil.example", 403]]) {
        const response = await worker.fetch(new Request("https://api.example.com/contact", {
            method: "OPTIONS", headers: { Origin: origin }
        }), environment());
        assert.equal(response.status, status);
    }
    assert.equal(calls.length, 0);
});

test("missing and forged website origins are rejected without provider calls", async () => {
    const calls = providers();
    for (const origin of ["", "https://www.example.com.evil.example"]) {
        const response = await worker.fetch(request(payload(), { headers: { Origin: origin } }), environment());
        assert.equal(response.status, 403);
        assert.equal(response.headers.has("Access-Control-Allow-Origin"), false);
    }
    assert.equal(calls.length, 0);
});

test("route and HTTP method are restricted", async () => {
    const env = environment();
    assert.equal((await worker.fetch(new Request("https://api.example.com/"), env)).status, 404);
    const response = await worker.fetch(new Request("https://api.example.com/contact", {
        headers: { Origin: "https://www.example.com" }
    }), env);
    assert.equal(response.status, 405);
});

test("missing configuration fails closed", async () => {
    const calls = providers();
    for (const key of ["TURNSTILE_SECRET_KEY", "RESEND_API_KEY", "CONTACT_FROM",
        "CONTACT_RECIPIENT", "CONTACT_RATE_LIMITER", "TURNSTILE_HOSTNAMES"]) {
        const env = environment();
        delete env[key];
        assert.equal((await worker.fetch(request(), env)).status, 503, key);
    }
    assert.equal(calls.length, 0);
});

test("unidentified clients and rate-limited requests cannot call providers", async () => {
    const calls = providers();
    const env = environment();
    const noIp = request();
    noIp.headers.delete("CF-Connecting-IP");
    assert.equal((await worker.fetch(noIp, env)).status, 403);
    env.CONTACT_RATE_LIMITER.limit = async ({ key }) => {
        assert.equal(key, "192.0.2.1");
        return { success: false };
    };
    const response = await worker.fetch(request(), env);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Retry-After"), "60");
    assert.equal(calls.length, 0);
});

test("rate limiter errors fail closed", async () => {
    const calls = providers();
    const env = environment();
    env.CONTACT_RATE_LIMITER.limit = async () => { throw new Error("Unavailable"); };
    assert.equal((await worker.fetch(request(), env)).status, 503);
    assert.equal(calls.length, 0);
});

test("bad JSON, content types and oversized bodies are rejected", async () => {
    const calls = providers();
    for (const [req, expected] of [
        [request("{"), 400],
        [request("null"), 400],
        [request("[]"), 400],
        [request(payload(), { headers: { "Content-Type": "text/plain" } }), 415],
        [request(" ".repeat(24001)), 413],
        [request(payload(), { headers: { "Content-Length": "24001" } }), 413]
    ]) assert.equal((await worker.fetch(req, environment())).status, expected);
    assert.equal(calls.length, 0);
});

test("invalid fields, honeypots, timing and header injection cannot send", async () => {
    const calls = providers();
    const invalid = [
        { name: " " }, { name: {} }, { name: "x".repeat(101) },
        { subject: "x".repeat(151) }, { message: "x".repeat(5001) },
        { email: "x".repeat(255) }, { email: "not-an-address" },
        { email: "a@example.com\r\nBcc: evil@example.com" },
        { subject: "Hello\r\nBcc: evil@example.com" }, { name: "Hello\nWorld" },
        { message: "short" }, { message: "invalid\0message" }, { website: "https://spam.example" },
        { website: null }, { token: "" }, { token: "x".repeat(2049) },
        { startedAt: Date.now() }, { startedAt: Date.now() + 100000 },
        { startedAt: Date.now() - 86400001 }, { startedAt: "0" }, { startedAt: null },
        { requestId: "../invalid" }
    ];
    for (const override of invalid) {
        assert.equal((await worker.fetch(request(payload(override)), environment())).status, 400,
            JSON.stringify(override).slice(0, 100));
    }
    assert.equal(calls.length, 0);
});

test("failed, replayed, wrong-host and wrong-action challenges cannot send", async () => {
    for (const verification of [
        { success: false, "error-codes": ["timeout-or-duplicate"] },
        { hostname: "evil.example" },
        { action: "different-form" }
    ]) {
        const calls = providers({ verification });
        assert.equal((await worker.fetch(request(), environment())).status, 400);
        assert.equal(calls.length, 1);
    }
});

test("verification provider errors never trigger email", async () => {
    const calls = providers({ verifyStatus: 500 });
    assert.equal((await worker.fetch(request(), environment())).status, 503);
    assert.equal(calls.length, 1);
    globalThis.fetch = async () => { throw new Error("Network timeout"); };
    assert.equal((await worker.fetch(request(), environment())).status, 503);
});

test("email rejection and missing acknowledgement are explicit failures", async () => {
    for (const options of [{ emailStatus: 429 }, { emailStatus: 500 }, { emailBody: {} }]) {
        providers(options);
        const response = await worker.fetch(request(), environment());
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { ok: false, error: "delivery_failed" });
    }
});

test("identical retries share an idempotency key, changed content does not", async () => {
    const calls = providers();
    const data = payload();
    for (const body of [data, { ...data, token: "new-token" }, { ...data, subject: "Changed enquiry" }]) {
        assert.equal((await worker.fetch(request(body), environment())).status, 200);
    }
    const keys = calls.filter((call) => call.url.includes("resend")).map((call) => call.headers["Idempotency-Key"]);
    assert.match(keys[0], /^contact-[a-f0-9]{64}$/);
    assert.equal(keys[0], keys[1]);
    assert.notEqual(keys[1], keys[2]);
});
