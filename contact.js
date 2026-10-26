(() => {
    "use strict";

    const form = document.getElementById("contact-form");
    if (!form) return;
    const chinese = form.dataset.language === "zh";
    const text = chinese ? {
        ready: "请填写所有项目并完成人机验证。",
        verify: "请完成人机验证。如无法加载，请刷新页面或检查浏览器设置。",
        sending: "正在发送留言……",
        sent: "您的留言已发送。我们会通过电子邮件回复您。",
        failed: "留言未能确认送达。请稍后重试。",
        limited: "提交过于频繁，请稍后再试。",
        invalid: "请检查所填资料并重新完成人机验证。"
    } : {
        ready: "Please complete all fields and the security check.",
        verify: "Please complete the security check. If it cannot load, refresh the page or check your browser settings.",
        sending: "Sending your message...",
        sent: "Your message has been sent. We will reply by email.",
        failed: "We could not confirm delivery of your message. Please try again later.",
        limited: "Too many attempts. Please wait a minute before trying again.",
        invalid: "Please check your details and complete the security check again."
    };
    const config = window.CONTACT_CONFIG;
    const status = document.getElementById("contact-status");
    const fieldset = form.querySelector("fieldset");
    const button = form.querySelector("button");
    if (!config?.endpoint || !config.turnstileSiteKey) return;
    try {
        if (new URL(config.endpoint).protocol !== "https:") return;
    } catch {
        return;
    }

    let token = "";
    let widget;
    let submitting = false;
    let startedAt = Date.now();
    let requestId = crypto.randomUUID();
    const clearToken = () => {
        token = "";
        button.disabled = true;
        if (!submitting) status.textContent = text.verify;
    };

    window.contactTurnstileReady = () => {
        fieldset.disabled = false;
        status.textContent = text.ready;
        widget = window.turnstile.render("#contact-challenge", {
            sitekey: config.turnstileSiteKey,
            action: "contact",
            language: chinese ? "zh-cn" : "en",
            size: fieldset.clientWidth < 300 ? "compact" : "flexible",
            callback: (value) => {
                token = value;
                button.disabled = submitting;
                if (!submitting && status.textContent === text.verify) status.textContent = text.ready;
            },
            "expired-callback": clearToken,
            "error-callback": clearToken
        });
    };

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (submitting || !form.reportValidity()) return;
        if (!token) {
            status.textContent = text.verify;
            return;
        }
        const values = new FormData(form);
        submitting = true;
        button.disabled = true;
        fieldset.disabled = true;
        form.setAttribute("aria-busy", "true");
        status.textContent = text.sending;
        try {
            const response = await fetch(config.endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "omit",
                signal: AbortSignal.timeout(20000),
                body: JSON.stringify({
                    name: values.get("name"),
                    email: values.get("email"),
                    subject: values.get("subject"),
                    message: values.get("message"),
                    website: values.get("website"),
                    token,
                    startedAt,
                    requestId
                })
            });
            const result = await response.json();
            if (response.ok && result.ok === true) {
                form.reset();
                startedAt = Date.now();
                requestId = crypto.randomUUID();
                status.textContent = text.sent;
            } else {
                status.textContent = response.status === 429 ? text.limited
                    : response.status === 400 ? text.invalid : text.failed;
            }
        } catch {
            status.textContent = text.failed;
        } finally {
            token = "";
            window.turnstile.reset(widget);
            submitting = false;
            fieldset.disabled = false;
            button.disabled = true;
            form.removeAttribute("aria-busy");
        }
    });

    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=contactTurnstileReady&render=explicit";
    script.async = true;
    script.onerror = () => { status.textContent = text.verify; };
    document.head.appendChild(script);
})();
