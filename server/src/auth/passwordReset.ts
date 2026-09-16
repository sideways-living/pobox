import { createHash, randomBytes } from "node:crypto";
import nodemailer from "nodemailer";

export const resetDigest = (token: string) => createHash("sha256").update(token).digest("hex");
export const resetToken = () => randomBytes(32).toString("base64url");

function enabled(name: string, fallback: boolean) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

function smtpCredentials() {
  const user = process.env.SMTP_USER?.trim() || process.env.SMTP_USERNAME?.trim();
  const pass = process.env.SMTP_PASSWORD?.trim();
  return user && pass ? { user, pass } : undefined;
}

export const resetEmailConfigured = () => {
  const user = process.env.SMTP_USER?.trim() || process.env.SMTP_USERNAME?.trim();
  const pass = process.env.SMTP_PASSWORD?.trim();
  const credentialsComplete = Boolean(user) === Boolean(pass);
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM && process.env.APP_BASE_URL && credentialsComplete);
};

export async function sendPasswordReset(email: string, token: string) {
  const url = new URL(process.env.APP_BASE_URL!);
  // Fragments are not sent to the web server or included in request logs.
  url.hash = `reset-password=${token}`;
  const port = Number(process.env.SMTP_PORT || "587");
  const host = process.env.SMTP_HOST!;
  const localRelay = ["127.0.0.1", "localhost", "::1"].includes(host.trim().toLowerCase());
  const secure = enabled("SMTP_SECURE", port === 465);
  const ignoreTLS = enabled("SMTP_IGNORE_TLS", localRelay && port === 25);
  const transport = nodemailer.createTransport({
    host, port, secure, ignoreTLS,
    requireTLS: !ignoreTLS && enabled("SMTP_REQUIRE_TLS", !secure),
    auth: smtpCredentials(),
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000
  });
  await transport.sendMail({ from: process.env.SMTP_FROM, to: email,
    subject: "Reset your pobox.watch password",
    text: `Reset your password using this link within 30 minutes:\n\n${url}\n\nThe link works once. Your passkey and authenticator remain required. If you did not request this, ignore this email.` });
}
