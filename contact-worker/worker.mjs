const MAX_BODY_BYTES = 24000;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function entries(value) {
    return (value || "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

async function readBody(request) {
    const reader = request.body?.getReader();
    if (!reader) throw new Error("Missing body");
    const chunks = [];
    let length = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > MAX_BODY_BYTES) {
                await reader.cancel();
                throw new RangeError("Body too large");
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

async function post(url, body, headers = {}) {
    return fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000)
    });
}

export default {
    async fetch(request, env) {
        const origin = request.headers.get("Origin");
        const allowed = entries(env.ALLOWED_ORIGINS).includes(origin);
        const headers = {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Vary": "Origin"
        };
        if (allowed) headers["Access-Control-Allow-Origin"] = origin;
        const reply = (status, error, extra = {}) => new Response(
            JSON.stringify(error ? { ok: false, error } : { ok: true }),
            { status, headers: { ...headers, ...extra } }
        );
        if (new URL(request.url).pathname !== "/contact") return reply(404, "not_found");
        if (!allowed) return reply(403, "origin_not_allowed");
        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: {
                    ...headers,
                    "Access-Control-Allow-Methods": "POST",
                    "Access-Control-Allow-Headers": "Content-Type",
                    "Access-Control-Max-Age": "600"
                }
            });
        }
        if (request.method !== "POST") return reply(405, "method_not_allowed", { Allow: "POST, OPTIONS" });
        if (!env.TURNSTILE_SECRET_KEY || !env.RESEND_API_KEY || !env.CONTACT_FROM
            || !EMAIL.test(env.CONTACT_RECIPIENT || "") || !env.CONTACT_RATE_LIMITER
            || !entries(env.TURNSTILE_HOSTNAMES).length) {
            console.error("Contact service configuration is incomplete");
            return reply(503, "service_unavailable");
        }
        const ip = request.headers.get("CF-Connecting-IP");
        if (!ip) return reply(403, "client_not_identified");
        try {
            const limit = await env.CONTACT_RATE_LIMITER.limit({ key: ip });
            if (!limit.success) return reply(429, "too_many_requests", { "Retry-After": "60" });
        } catch {
            console.error("Contact rate limiter unavailable");
            return reply(503, "service_unavailable");
        }
        if (request.headers.get("Content-Type")?.split(";")[0].trim() !== "application/json") {
            return reply(415, "unsupported_content_type");
        }
        if (Number(request.headers.get("Content-Length")) > MAX_BODY_BYTES) {
            return reply(413, "body_too_large");
        }
        let data;
        try {
            data = await readBody(request);
        } catch (error) {
            return reply(error instanceof RangeError ? 413 : 400, "invalid_body");
        }
        if (!data || typeof data !== "object" || Array.isArray(data)) return reply(400, "invalid_fields");
        const fields = {};
        for (const [name, max] of Object.entries({ name: 100, email: 254, subject: 150, message: 5000 })) {
            if (typeof data[name] !== "string") return reply(400, "invalid_fields");
            fields[name] = data[name].trim();
            if (!fields[name] || fields[name].length > max || fields[name].includes("\0")) {
                return reply(400, "invalid_fields");
            }
        }
        const age = Date.now() - data.startedAt;
        if (!EMAIL.test(fields.email) || /[\r\n]/.test(fields.email + fields.name + fields.subject)
            || fields.message.length < 10 || data.website !== ""
            || typeof data.token !== "string" || !data.token || data.token.length > 2048
            || typeof data.startedAt !== "number" || !Number.isFinite(age) || age < 3000 || age > 86400000
            || typeof data.requestId !== "string" || !UUID.test(data.requestId)) {
            return reply(400, "invalid_fields");
        }

        let verification;
        try {
            const response = await post("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
                secret: env.TURNSTILE_SECRET_KEY,
                response: data.token,
                remoteip: ip
            });
            if (!response.ok) throw new Error("Verification service failed");
            verification = await response.json();
        } catch {
            console.error("Contact bot verification unavailable");
            return reply(503, "verification_unavailable");
        }
        if (verification.success !== true || verification.action !== "contact"
            || !entries(env.TURNSTILE_HOSTNAMES).includes(verification.hostname)) {
            return reply(400, "verification_failed");
        }

        try {
            const digest = await crypto.subtle.digest("SHA-256",
                new TextEncoder().encode(JSON.stringify([data.requestId, fields])));
            const key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
            const response = await post("https://api.resend.com/emails", {
                from: env.CONTACT_FROM,
                to: [env.CONTACT_RECIPIENT],
                reply_to: fields.email,
                subject: `Website enquiry: ${fields.subject}`,
                text: `Name: ${fields.name}\nEmail: ${fields.email}\nSubject: ${fields.subject}\n\n${fields.message}`
            }, {
                Authorization: `Bearer ${env.RESEND_API_KEY}`,
                "Idempotency-Key": `contact-${key}`
            });
            if (!response.ok) throw new Error("Delivery service rejected request");
            const delivery = await response.json();
            if (typeof delivery.id !== "string" || !delivery.id) throw new Error("Delivery not acknowledged");
        } catch {
            console.error("Contact email delivery failed");
            return reply(503, "delivery_failed");
        }
        return reply(200);
    }
};
