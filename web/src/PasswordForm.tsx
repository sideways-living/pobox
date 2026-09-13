import { useState } from "react";
import { KeyRound } from "lucide-react";

export function PasswordForm({ mode, token, email: initialEmail = "" }: { mode: "forgot" | "reset" | "change"; token?: string; email?: string }) {
  const [email, setEmail] = useState(initialEmail);
  const [currentPassword, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError("");
    if (mode !== "forgot" && password !== confirmation) { setError("Passwords do not match."); return; }
    setBusy(true);
    try {
      const response = await fetch(`${import.meta.env.VITE_API_BASE_URL ?? window.location.origin}/api/v1/auth/password/${mode}`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "forgot" ? { email } : mode === "reset" ? { token, password } : { currentPassword, password })
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error || "Unable to update password.");
      setDone(true); setPassword(""); setConfirmation(""); setCurrent("");
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to update password."); }
    finally { setBusy(false); }
  }
  if (done) return <div role="status"><p>{mode === "forgot" ? "If this email has an active account, a reset link will arrive shortly. Check your spam folder too." : "Password updated. Your sessions have been signed out. Sign in again with your passkey and authenticator."}</p>{mode !== "forgot" && <a href="/">Return to sign in</a>}</div>;
  return <form className="form-grid password-form" onSubmit={submit}>
    {mode === "forgot" ? <label>Email<input type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required /></label> : <>
      {mode === "change" && <label>Current password<input type="password" autoComplete="current-password" value={currentPassword} onChange={e => setCurrent(e.target.value)} maxLength={200} required /></label>}
      <label>New password<input type="password" autoComplete="new-password" minLength={12} maxLength={200} value={password} onChange={e => setPassword(e.target.value)} required /></label>
      <label>Confirm new password<input type="password" autoComplete="new-password" minLength={12} maxLength={200} value={confirmation} onChange={e => setConfirmation(e.target.value)} required /></label>
      <p className="small">Use at least 12 characters. Passkeys and two-factor authentication stay enabled.</p>
    </>}
    {error && <p role="alert">{error}</p>}
    <button className="primary" disabled={busy}><KeyRound size={17} />{busy ? "Please wait..." : mode === "forgot" ? "Send Reset Link" : "Update Password"}</button>
  </form>;
}
