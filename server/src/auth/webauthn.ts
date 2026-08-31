export function webAuthnConfig() {
  const origin = process.env.WEBAUTHN_ORIGIN || process.env.APP_BASE_URL || "http://localhost:5173";
  const parsedOrigin = new URL(origin);
  return {
    rpID: process.env.WEBAUTHN_RP_ID || parsedOrigin.hostname,
    rpName: process.env.WEBAUTHN_RP_NAME || "pobox.watch",
    origin: parsedOrigin.origin
  };
}

export function challengeFromClientData(clientDataJSON: string) {
  const decoded = JSON.parse(Buffer.from(clientDataJSON, "base64url").toString("utf8")) as { challenge?: unknown };
  if (typeof decoded.challenge !== "string") throw new Error("WebAuthn response did not include a challenge.");
  return decoded.challenge;
}
