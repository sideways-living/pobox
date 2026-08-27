import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Bell, Check, KeyRound, LogIn, Mail, MapPin, RefreshCw, Shield, Users } from "lucide-react";
import { collectMailbox, loadDashboard, login, realtimeUrl, simulateMail } from "./api";
import type { DashboardSnapshot, Mailbox } from "./types";
import "./styles.css";

function App() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function refresh() {
    setSnapshot(await loadDashboard());
    setError(null);
  }

  useEffect(() => {
    if (!snapshot) return;
    const socket = new WebSocket(realtimeUrl());
    socket.onopen = () => setConnected(true);
    socket.onclose = () => setConnected(false);
    socket.onerror = () => setConnected(false);
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "dashboard.updated") setSnapshot(message.snapshot);
    };
    return () => socket.close();
  }, [snapshot?.workspace.id]);

  if (!snapshot) {
    return <LoginScreen onLogin={refresh} error={error} setError={setError} />;
  }

  const waitingBoxes = snapshot.postOffices.flatMap((office) => office.mailboxes.filter((box) => box.mailWaiting));

  async function mutate(action: () => Promise<void>, mailboxId?: string) {
    try {
      setBusyId(mailboxId ?? "global");
      await action();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><Mail size={22} />Mailbox</div>
        <nav>
          <a className="active"><Bell size={17} />Overview</a>
          <a><Mail size={17} />Mailboxes</a>
          <a><MapPin size={17} />Map</a>
          <a><RefreshCw size={17} />History</a>
          <a><Users size={17} />Team</a>
          <a><Shield size={17} />Settings</a>
        </nav>
      </aside>
      <section className="content">
        <header className="topbar">
          <div>
            <p className="workspace">{snapshot.workspace.name}</p>
            <h1>{snapshot.outstandingMailboxCount === 0 ? "All Clear" : `${snapshot.outstandingMailboxCount} Mailboxes Need Checking`}</h1>
          </div>
          <div className={connected ? "live is-live" : "live"}>{connected ? "Live" : "Live connection unavailable"}</div>
        </header>

        {error && <div className="alert">{error}</div>}

        <section className="summary-band">
          <div>
            <span className="metric">{snapshot.outstandingMailboxCount}</span>
            <span className="metric-label">Outstanding physical mailboxes</span>
          </div>
          <div className="dev-controls">
            <button onClick={() => mutate(() => simulateMail("1234"))}>Simulate New Mail 1234</button>
            <button onClick={() => mutate(() => simulateMail("5678"))}>Simulate New Mail 5678</button>
            <button onClick={() => mutate(() => simulateMail("1234", true))}>Simulate Duplicate</button>
          </div>
        </section>

        <div className="layout-grid">
          <section className="panel">
            <div className="panel-heading">
              <h2>Overview</h2>
              <span>{new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
            </div>
            <div className="office-list">
              {snapshot.postOffices.map((office) => (
                <article className="office" key={office.id}>
                  <div className="office-title">
                    <div>
                      <h3>{office.name}</h3>
                      <p>{office.address}</p>
                    </div>
                    <a href={`https://www.google.com/maps/search/?api=1&query=${office.latitude},${office.longitude}`}>Directions</a>
                  </div>
                  <div className="mailbox-list">
                    {office.mailboxes.map((box) => (
                      <MailboxRow
                        key={box.id}
                        box={box}
                        busy={busyId === box.id}
                        onCollect={() => mutate(() => collectMailbox(box.id), box.id)}
                      />
                    ))}
                  </div>
                </article>
              ))}
            </div>
          </section>

          <aside className="side-panels">
            <section className="panel map-panel">
              <h2>Map</h2>
              {snapshot.postOffices.map((office) => {
                const waiting = office.mailboxes.filter((box) => box.mailWaiting).length;
                return (
                  <div className="map-location" key={office.id}>
                    <MapPin size={18} />
                    <span>{office.name}</span>
                    <strong>{waiting > 0 ? `${waiting} waiting` : "Clear"}</strong>
                  </div>
                );
              })}
            </section>
            <section className="panel">
              <h2>History</h2>
              <History snapshot={snapshot} />
            </section>
            <section className="panel">
              <h2>Team</h2>
              <p className="small">Signed in as {snapshot.currentUser.displayName} ({snapshot.currentUser.role}). Server authorization still applies to every request.</p>
            </section>
          </aside>
        </div>

        {waitingBoxes.length === 0 && (
          <div className="empty-state"><Check size={22} />No mailboxes currently need checking.</div>
        )}
      </section>
    </main>
  );
}

function LoginScreen({ onLogin, error, setError }: { onLogin: () => Promise<void>; error: string | null; setError: (value: string | null) => void }) {
  const [email, setEmail] = useState("john@example.com");
  const [password, setPassword] = useState("Password123!");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    try {
      setBusy(true);
      await login(email, password);
      await onLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to sign in.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <form className="login-panel" onSubmit={submit}>
        <div className="brand large"><Mail size={26} />Mailbox</div>
        <label>Email<input value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        {error && <div className="alert">{error}</div>}
        <button className="primary" disabled={busy}><LogIn size={18} />Sign In</button>
        <button type="button" className="secondary"><KeyRound size={18} />Sign in with Passkey</button>
        <button type="button" className="link-button">Forgot Password?</button>
      </form>
    </main>
  );
}

function MailboxRow({ box, busy, onCollect }: { box: Mailbox; busy: boolean; onCollect: () => void }) {
  return (
    <div className={box.mailWaiting ? "mailbox waiting" : "mailbox"}>
      <div>
        <strong>{box.name}</strong>
        <span>{box.mailWaiting ? "Red status: Mail Waiting" : "Green status: Clear"}</span>
        {box.latestNotificationAt && <small>Detected {new Date(box.latestNotificationAt).toLocaleString()}</small>}
      </div>
      {box.mailWaiting && <button disabled={busy} onClick={onCollect}>{busy ? "Saving" : "Mark Collected"}</button>}
    </div>
  );
}

function History({ snapshot }: { snapshot: DashboardSnapshot }) {
  const userNames = useMemo(() => new Map([[snapshot.currentUser.id, snapshot.currentUser.displayName]]), [snapshot.currentUser]);
  return (
    <div className="history">
      {snapshot.history.slice(0, 8).map((event) => {
        const isCollection = "collectedAt" in event;
        const when = isCollection ? event.collectedAt : event.processedAt;
        return (
          <div key={event.id}>
            <strong>{isCollection ? `Collected by ${userNames.get(event.collectedBy) ?? event.collectedBy}` : "Mail detected"}</strong>
            <span>{new Date(when).toLocaleString()}</span>
          </div>
        );
      })}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
