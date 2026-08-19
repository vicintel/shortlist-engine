import nodemailer from "nodemailer";

/**
 * Pluggable delivery. Gmail SMTP is the default because it needs no third-party
 * service and no sending domain — the digest goes from his own account to his own
 * inbox. Resend stays available for anyone who prefers it.
 */

function gmailTransport(env) {
  const user = env.GMAIL_USER;
  const pass = (env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, ""); // Google prints it in groups of four
  if (!user || !pass) return null;

  return {
    name: "gmail",
    from: env.DIGEST_FROM || `Shortlist <${user}>`,
    to: env.DIGEST_TO || user,

    transporter: nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user, pass },
    }),

    async verify() {
      await this.transporter.verify();
      return `${user} → ${this.to}`;
    },

    async send({ subject, html, text }) {
      const info = await this.transporter.sendMail({ from: this.from, to: this.to, subject, html, text });
      return { id: info.messageId, accepted: info.accepted };
    },
  };
}

function resendTransport(env) {
  if (!env.RESEND_API_KEY) return null;
  return {
    name: "resend",
    from: env.DIGEST_FROM || "Shortlist <onboarding@resend.dev>",
    to: env.DIGEST_TO,

    async verify() {
      if (!this.to) throw new Error("DIGEST_TO is not set");
      return `${this.from} → ${this.to}`;
    },

    async send({ subject, html, text }) {
      const { Resend } = await import("resend");
      const { data, error } = await new Resend(env.RESEND_API_KEY).emails.send({
        from: this.from, to: this.to, subject, html, text,
      });
      if (error) throw new Error(error.message || JSON.stringify(error));
      return { id: data?.id };
    },
  };
}

/** Explicit MAIL_TRANSPORT wins; otherwise whichever is configured, Gmail first. */
export function createMailer(env = process.env) {
  const want = (env.MAIL_TRANSPORT || "").trim().toLowerCase();
  const builders = { gmail: gmailTransport, resend: resendTransport };

  if (want) {
    const t = builders[want]?.(env);
    if (!t) throw new Error(`MAIL_TRANSPORT=${want} but its credentials are not set`);
    return t;
  }
  return gmailTransport(env) || resendTransport(env) || null;
}

/** Turn Gmail's error codes into something that says what to actually do. */
export function explainMailError(err) {
  const m = String(err.message || err);
  if (/Invalid login|Username and Password not accepted|BadCredentials/i.test(m)) {
    return "Gmail rejected the login. An app password is required — your normal Google password will not work, and 2-Step Verification must be on. Generate one at https://myaccount.google.com/apppasswords";
  }
  if (/Application-specific password required/i.test(m)) {
    return "This account has 2-Step Verification on and needs an app password: https://myaccount.google.com/apppasswords";
  }
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED/i.test(m)) {
    return "Could not reach smtp.gmail.com — check the network, or whether port 465 is blocked.";
  }
  return m;
}
