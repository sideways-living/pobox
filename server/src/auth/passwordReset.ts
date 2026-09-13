import { createHash, randomBytes } from "node:crypto";
import nodemailer from "nodemailer";

export const resetDigest = (token: string) => createHash("sha256").update(token).digest("hex");
export const resetToken = () => randomBytes(32).toString("base64url");
export const resetEmailConfigured = () => Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD && process.env.SMTP_FROM && process.env.APP_BASE_URL);

export async function sendPasswordReset(email: string, token: string) {
  const url = new URL(process.env.APP_BASE_URL!);
  // Fragments are not sent to the web server or included in request logs.
  url.hash = `reset-password=${token}`;
  const port = Number(process.env.SMTP_PORT || "587");
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port, secure: port === 465, requireTLS: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000
  });
  await transport.sendMail({ from: process.env.SMTP_FROM, to: email,
    subject: "Reset your pobox.watch password",
    text: `Reset your password using this link within 30 minutes:\n\n${url}\n\nThe link works once. Your passkey and authenticator remain required. If you did not request this, ignore this email.` });
}
