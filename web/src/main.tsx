import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { AlertTriangle, Bell, Check, Clock, Edit2, ExternalLink, KeyRound, LogIn, LogOut, Mail, MapPin, Plus, RefreshCw, Route, Save, Shield, Trash2, Users, X } from "lucide-react";
import {
  authenticatePasskey,
  beginPasskeyAuthentication,
  beginPasskeyRegistration,
  beginTotpSetup,
  collectMailbox,
  confirmTotpSetup,
  createMailbox,
  createPostOffice,
  createUser,
  deleteMailbox,
  deletePostOffice,
  deleteUser,
  dismissReviewItem,
  loadAppChanges,
  loadDashboard,
  loadMembers,
  loadPostOfficeDirectoryStatus,
  loadReviewItems,
  loadSecurityStatus,
  login,
  logout,
  registerPasskey,
  realtimeUrl,
  resolveReviewItem,
  searchPostOfficeLocations,
  simulateMail,
  syncPostOfficeDirectory,
  updateMailbox,
  updatePostOffice,
  updateUser,
  verifySecondFactor
} from "./api";
import type { AppChangesResponse, CollectionHistoryEvent, DashboardSnapshot, Mailbox, MailHistoryEvent, PostOffice, PostOfficeDirectoryStatus, PostOfficeLocationResult, ReviewItem, SecurityStatus, TeamMember, TotpSetup } from "./types";
import "./styles.css";

type Section = "Overview" | "Mailboxes" | "Map" | "History" | "Needs Review" | "Team" | "Settings";
type MailboxFilter = "all" | "waiting" | "clear";

function App() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [section, setSection] = useState<Section>("Overview");
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([]);
  const [changeNotice, setChangeNotice] = useState<AppChangesResponse | null>(null);
  const [securityGate, setSecurityGate] = useState<{ previousLoginAt?: string } | null>(null);

  async function refresh() {
    const nextSnapshot = await loadDashboard();
    setSnapshot(nextSnapshot);
    if (nextSnapshot.currentUser.role === "ADMIN") {
      setMembers(await loadMembers());
    }
    setReviewItems(await loadReviewItems());
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

  async function finishLogin(previousLoginAt?: string) {
    await refresh();
    try {
      const changes = await loadAppChanges(previousLoginAt);
      if (changes.changes.length > 0) setChangeNotice(changes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load app changes.");
    }
  }

  async function handleLogin(previousLoginAt?: string) {
    const status = await loadSecurityStatus();
    if (!securityComplete(status)) {
      setSecurityGate({ previousLoginAt });
      setError(null);
      return;
    }
    await finishLogin(previousLoginAt);
  }

  async function handleLogout() {
    try {
      await logout();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to log out.");
      return;
    }
    setSnapshot(null);
    setMembers([]);
    setReviewItems([]);
    setChangeNotice(null);
    setConnected(false);
    setBusyId(null);
    setSection("Overview");
    setSecurityGate(null);
    setError(null);
  }

  if (securityGate) {
    return (
      <MandatorySecuritySetup
        previousLoginAt={securityGate.previousLoginAt}
        onComplete={async () => {
          setSecurityGate(null);
          await finishLogin(securityGate.previousLoginAt);
        }}
        onLogout={handleLogout}
        error={error}
        setError={setError}
      />
    );
  }

  if (!snapshot) {
    return <LoginScreen onLogin={handleLogin} error={error} setError={setError} />;
  }

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
        <div className="brand"><Mail size={22} />pobox.watch</div>
        <nav>
          <NavItem icon={<Bell size={17} />} label="Overview" active={section === "Overview"} onClick={() => setSection("Overview")} />
          <NavItem icon={<Mail size={17} />} label="Post Offices" active={section === "Mailboxes"} onClick={() => setSection("Mailboxes")} />
          <NavItem icon={<MapPin size={17} />} label="Map" active={section === "Map"} onClick={() => setSection("Map")} />
          <NavItem icon={<RefreshCw size={17} />} label="History" active={section === "History"} onClick={() => setSection("History")} />
          <NavItem icon={<AlertTriangle size={17} />} label="Needs Review" active={section === "Needs Review"} onClick={() => setSection("Needs Review")} />
          <NavItem icon={<Users size={17} />} label="Team" active={section === "Team"} onClick={() => setSection("Team")} />
          <NavItem icon={<Shield size={17} />} label="Settings" active={section === "Settings"} onClick={() => setSection("Settings")} />
        </nav>
      </aside>
      <section className="content">
        <header className="topbar">
          <div>
            <p className="workspace">{snapshot.workspace.name}</p>
            <h1>{snapshot.outstandingMailboxCount === 0 ? "All Clear" : `${snapshot.outstandingMailboxCount} Boxes Need Checking`}</h1>
          </div>
          <div className="topbar-actions">
            <div className={connected ? "live is-live" : "live"}>{connected ? "Live" : "Live connection unavailable"}</div>
            <div className="account-menu" aria-label="Signed-in account">
              <span>
                <strong>{snapshot.currentUser.displayName}</strong>
                <small>{snapshot.currentUser.email}</small>
              </span>
              <button type="button" className="secondary logout-button" onClick={handleLogout}>
                <LogOut size={17} />Log Out
              </button>
            </div>
          </div>
        </header>

        {error && <div className="alert">{error}</div>}

        <section className="summary-band">
          <MetricCard value={snapshot.outstandingMailboxCount} label="Boxes needing collection" />
          <MetricCard value={snapshot.postOffices.length} label="Tracked post offices" />
          <MetricCard value={snapshot.postOffices.length} label="Post offices" />
          <MetricCard value={reviewItems.length} label="Needs review" />
          <MetricCard value={snapshot.currentUser.role} label="Access level" />
          <div className="dev-controls">
            <button onClick={() => mutate(() => simulateMail("1234"))}>Simulate New Mail 1234</button>
            <button onClick={() => mutate(() => simulateMail("5678"))}>Simulate New Mail 5678</button>
            <button onClick={() => mutate(() => simulateMail("1234", true))}>Simulate Duplicate</button>
          </div>
        </section>

        <SectionView
          section={section}
          snapshot={snapshot}
          members={members}
          reviewItems={reviewItems}
          busyId={busyId}
          mutate={mutate}
          refresh={refresh}
          setError={setError}
        />
        {changeNotice && <ChangeNoticeModal notice={changeNotice} onClose={() => setChangeNotice(null)} />}
      </section>
    </main>
  );
}

function NavItem({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return <button className={active ? "nav-item active" : "nav-item"} onClick={onClick}>{icon}{label}</button>;
}

function MetricCard({ value, label }: { value: React.ReactNode; label: string }) {
  return (
    <div className="metric-card">
      <span className="metric">{value}</span>
      <span className="metric-label">{label}</span>
    </div>
  );
}

function SectionView({
  section,
  snapshot,
  members,
  reviewItems,
  busyId,
  mutate,
  refresh,
  setError
}: {
  section: Section;
  snapshot: DashboardSnapshot;
  members: TeamMember[];
  reviewItems: ReviewItem[];
  busyId: string | null;
  mutate: (action: () => Promise<void>, mailboxId?: string) => Promise<void>;
  refresh: () => Promise<void>;
  setError: (value: string | null) => void;
}) {
  if (section === "Team") return <TeamSection snapshot={snapshot} members={members} refresh={refresh} setError={setError} />;
  if (section === "Settings") return <SettingsSection snapshot={snapshot} refresh={refresh} setError={setError} />;
  if (section === "Map") return <MapSection snapshot={snapshot} />;
  if (section === "History") return <HistorySection snapshot={snapshot} />;
  if (section === "Needs Review") return <NeedsReviewSection snapshot={snapshot} reviewItems={reviewItems} mutate={mutate} refresh={refresh} />;
  if (section === "Mailboxes") return <MailboxSection snapshot={snapshot} busyId={busyId} mutate={mutate} setError={setError} refresh={refresh} />;
  return <OverviewSection snapshot={snapshot} busyId={busyId} mutate={mutate} />;
}

function LoginScreen({ onLogin, error, setError }: { onLogin: (previousLoginAt?: string) => Promise<void>; error: string | null; setError: (value: string | null) => void }) {
  const [email, setEmail] = useState("john@example.com");
  const [password, setPassword] = useState("Password123!");
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [passwordMode, setPasswordMode] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!passwordMode && !challengeId) {
      await signInWithPasskey();
      return;
    }
    try {
      setBusy(true);
      const result = challengeId ? await verifySecondFactor(challengeId, twoFactorCode) : await login(email, password);
      if (!result.ok && result.twoFactorRequired) {
        setChallengeId(result.challengeId);
        setTwoFactorCode("");
        setError(null);
        return;
      }
      if (result.ok) await onLogin(result.previousLoginAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to sign in.");
    } finally {
      setBusy(false);
    }
  }

  async function signInWithPasskey() {
    try {
      setBusy(true);
      const options = await beginPasskeyAuthentication(email.includes("@") ? email : undefined);
      const response = await startAuthentication({ optionsJSON: options.options });
      const result = await authenticatePasskey(response);
      if (!result.ok && result.twoFactorRequired) {
        setChallengeId(result.challengeId);
        setTwoFactorCode("");
        setError(null);
        return;
      }
      if (result.ok) await onLogin(result.previousLoginAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to sign in with passkey.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <form className="login-panel" onSubmit={submit}>
        <div className="brand large"><Mail size={26} />pobox.watch</div>
        <div className="login-copy">
          <h1>Sign in with your passkey</h1>
          <p>pobox.watch requires a passkey and authenticator 2FA for every account.</p>
        </div>
        {!challengeId && <label>Email<input value={email} autoComplete="username webauthn" onChange={(event) => setEmail(event.target.value)} /></label>}
        {!challengeId && passwordMode && <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>}
        {challengeId && (
          <label>
            Authenticator or recovery code
            <input inputMode="numeric" autoComplete="one-time-code" value={twoFactorCode} onChange={(event) => setTwoFactorCode(event.target.value)} autoFocus />
          </label>
        )}
        {error && <div className="alert">{error}</div>}
        <button className="primary" disabled={busy}>
          {challengeId ? <Shield size={18} /> : passwordMode ? <LogIn size={18} /> : <KeyRound size={18} />}
          {challengeId ? "Verify Code" : passwordMode ? "Continue with Password" : "Continue with Passkey"}
        </button>
        {challengeId && <button type="button" className="secondary" onClick={() => setChallengeId(null)}>Use Password Instead</button>}
        {!challengeId && !passwordMode && <button type="button" className="secondary" disabled={busy} onClick={() => setPasswordMode(true)}>Use Password to Set Up Security</button>}
        {!challengeId && passwordMode && <button type="button" className="secondary" disabled={busy} onClick={() => setPasswordMode(false)}><KeyRound size={18} />Back to Passkey</button>}
        <button type="button" className="link-button">Forgot Password?</button>
      </form>
    </main>
  );
}

function MandatorySecuritySetup({
  previousLoginAt,
  onComplete,
  onLogout,
  error,
  setError
}: {
  previousLoginAt?: string;
  onComplete: () => Promise<void>;
  onLogout: () => Promise<void>;
  error: string | null;
  setError: (value: string | null) => void;
}) {
  const [status, setStatus] = useState<SecurityStatus | null>(null);
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function refreshSecurity() {
    const nextStatus = await loadSecurityStatus();
    setStatus(nextStatus);
    return nextStatus;
  }

  useEffect(() => {
    refreshSecurity().catch((err) => setError(err instanceof Error ? err.message : "Unable to load security setup."));
  }, []);

  async function addPasskey() {
    try {
      setBusy(true);
      const options = await beginPasskeyRegistration();
      const response = await startRegistration({ optionsJSON: options.options });
      setStatus(await registerPasskey(response, "Passkey"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to add passkey.");
    } finally {
      setBusy(false);
    }
  }

  async function startTotpSetup() {
    try {
      setBusy(true);
      setRecoveryCodes([]);
      setSetup(await beginTotpSetup());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to start 2FA setup.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmSetup(event: React.FormEvent) {
    event.preventDefault();
    try {
      setBusy(true);
      const result = await confirmTotpSetup(code);
      setRecoveryCodes(result.recoveryCodes);
      setSetup(null);
      setCode("");
      await refreshSecurity();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to confirm 2FA setup.");
    } finally {
      setBusy(false);
    }
  }

  async function continueToApp() {
    const nextStatus = await refreshSecurity();
    if (!securityComplete(nextStatus)) {
      setError("Add a passkey and turn on authenticator 2FA before continuing.");
      return;
    }
    await onComplete();
  }

  const passkeyDone = (status?.passkeyCount ?? 0) > 0;
  const totpDone = Boolean(status?.totpEnabled);
  const canContinue = passkeyDone && totpDone;

  return (
    <main className="login-shell">
      <section className="login-panel setup-panel">
        <div className="brand large"><Mail size={26} />pobox.watch</div>
        <div className="login-copy">
          <p className="workspace">Security setup required</p>
          <h1>Finish securing your account</h1>
          <p>Before you can use pobox.watch, add a passkey and turn on authenticator 2FA.</p>
          {previousLoginAt && <p className="small">After setup, your change notice will include updates since {new Date(previousLoginAt).toLocaleString()}.</p>}
        </div>

        {error && <div className="alert">{error}</div>}

        <div className="setup-checklist">
          <div className={passkeyDone ? "setup-step complete" : "setup-step"}>
            <div><KeyRound size={20} /><strong>Passkey</strong></div>
            <StatusPill tone={passkeyDone ? "ok" : "warning"}>{passkeyDone ? "Done" : "Required"}</StatusPill>
            {!passkeyDone && <button className="primary" disabled={busy || !status?.passkeysAvailable} onClick={addPasskey}>Add Passkey</button>}
            {!passkeyDone && status && !status.passkeysAvailable && <p className="small">This browser or server configuration cannot create a passkey. Use Safari, Chrome, Edge, or another WebAuthn-compatible browser on the pobox.watch domain.</p>}
          </div>

          <div className={totpDone ? "setup-step complete" : "setup-step"}>
            <div><Shield size={20} /><strong>Authenticator 2FA</strong></div>
            <StatusPill tone={totpDone ? "ok" : "warning"}>{totpDone ? "Done" : "Required"}</StatusPill>
            {!totpDone && !setup && <button className="primary" disabled={busy} onClick={startTotpSetup}>Set Up Authenticator App</button>}
            {setup && (
              <form className="form-grid security-setup" onSubmit={confirmSetup}>
                <p className="small">Add this account to an authenticator app, then enter the six-digit code it shows.</p>
                <label>Manual setup key<input value={setup.secret} readOnly /></label>
                <a href={setup.otpauthUrl}>Open Authenticator Setup</a>
                <label>Six-digit code<input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} required /></label>
                <button className="primary" disabled={busy}>Confirm 2FA</button>
              </form>
            )}
          </div>
        </div>

        {recoveryCodes.length > 0 && (
          <div className="recovery-codes">
            <strong>Recovery codes</strong>
            <p className="small">Keep these somewhere safe. Each code can be used once if you lose access to your authenticator app.</p>
            <code>{recoveryCodes.join("\n")}</code>
          </div>
        )}

        <button className="primary" disabled={busy || !canContinue} onClick={continueToApp}>Continue to pobox.watch</button>
        <button className="secondary" disabled={busy} onClick={onLogout}><LogOut size={17} />Log Out</button>
      </section>
    </main>
  );
}

function OverviewSection({ snapshot, busyId, mutate }: { snapshot: DashboardSnapshot; busyId: string | null; mutate: (action: () => Promise<void>, mailboxId?: string) => Promise<void> }) {
  const waitingBoxes = snapshot.postOffices.flatMap((office) => office.mailboxes.filter((box) => box.mailWaiting));
  const nextOffice = snapshot.postOffices.find((office) => office.mailboxes.some((box) => box.mailWaiting));
  return (
    <div className="page-grid">
      <section className="page-main">
        <Panel title="Collection Queue" aside={waitingBoxes.length > 0 ? `${waitingBoxes.length} active` : "Clear"}>
          {waitingBoxes.length > 0 ? (
            <div className="queue-list">
              {snapshot.postOffices.map((office) => {
                const waiting = office.mailboxes.filter((box) => box.mailWaiting);
                if (waiting.length === 0) return null;
                return (
                  <article className="queue-office" key={office.id}>
                    <div className="office-title">
                      <div>
                        <h3>{office.name}</h3>
                        <p>{office.address}</p>
                      </div>
                      <a className="text-link" href={appleMapsUrl(office)} target="_blank" rel="noreferrer"><Route size={16} />Directions</a>
                    </div>
                    <div className="mailbox-list">
                      {waiting.map((box) => (
                        <MailboxRow key={box.id} box={box} busy={busyId === box.id} onCollect={() => mutate(() => collectMailbox(box.id), box.id)} />
                      ))}
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="empty-state"><Check size={22} />No boxes currently need checking.</div>
          )}
        </Panel>
        <Panel title="Recent Activity"><History snapshot={snapshot} limit={6} /></Panel>
      </section>
      <aside className="side-panels">
        <Panel title="Next Collection">
          {nextOffice ? <OfficeMapCard office={nextOffice} /> : <p className="small">All post offices are currently clear.</p>}
        </Panel>
        <MapSummary snapshot={snapshot} />
        <Panel title="Session">
          <div className="detail-list">
            <DetailRow label="Signed in" value={snapshot.currentUser.displayName} />
            <DetailRow label="Role" value={snapshot.currentUser.role} />
            <DetailRow label="Live updates" value="Enabled while connected" />
          </div>
        </Panel>
      </aside>
    </div>
  );
}

function MailboxSection({
  snapshot,
  busyId,
  mutate,
  refresh,
  setError,
  compact = false
}: {
  snapshot: DashboardSnapshot;
  busyId: string | null;
  compact?: boolean;
  mutate: (action: () => Promise<void>, mailboxId?: string) => Promise<void>;
  refresh?: () => Promise<void>;
  setError?: (value: string | null) => void;
}) {
  const [filter, setFilter] = useState<MailboxFilter>(compact ? "waiting" : "all");
  const waitingCount = snapshot.outstandingMailboxCount;
  const clearCount = totalMailboxes(snapshot) - waitingCount;
  const canManage = !compact && snapshot.currentUser.role === "ADMIN" && Boolean(refresh && setError);

  async function saveOffice(officeId: string, input: { name: string; address: string; phone?: string; latitude: number; longitude: number; geofenceRadius: number }) {
    if (!refresh || !setError) return;
    try {
      await updatePostOffice(officeId, input);
      await refresh();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update post office.");
    }
  }

  async function removeOffice(office: PostOffice) {
    if (!refresh || !setError) return;
    if (!window.confirm(`Delete ${office.name}? This will also remove its boxes from the active app.`)) return;
    try {
      await deletePostOffice(office.id);
      await refresh();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete post office.");
    }
  }

  async function saveMailbox(mailboxId: string, input: { postOfficeId: string; boxNumber: string }) {
    if (!refresh || !setError) return;
    try {
      await updateMailbox(mailboxId, input);
      await refresh();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update PO box.");
    }
  }

  async function removeMailbox(mailbox: Mailbox) {
    if (!refresh || !setError) return;
    if (!window.confirm(`Delete PO Box ${mailbox.boxNumber}? This will remove it from the active app.`)) return;
    try {
      await deleteMailbox(mailbox.id);
      await refresh();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete PO box.");
    }
  }

  return (
    <Panel title={compact ? "Post Office Snapshot" : "Post Offices"} aside={`Updated ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}>
      {!compact && (
        <div className="filter-bar" role="group" aria-label="Post office filter">
          <button className={filter === "all" ? "filter active" : "filter"} onClick={() => setFilter("all")}>All offices {snapshot.postOffices.length}</button>
          <button className={filter === "waiting" ? "filter active" : "filter"} onClick={() => setFilter("waiting")}>Waiting {waitingCount}</button>
          <button className={filter === "clear" ? "filter active" : "filter"} onClick={() => setFilter("clear")}>Clear {clearCount}</button>
        </div>
      )}
      {!compact && (
        <div className="post-office-summary-block">
          <h3>Post Office Summary</h3>
          <div className="post-office-summary">
            <DetailRow label="Post offices" value={String(snapshot.postOffices.length)} />
            <DetailRow label="Assigned boxes" value={String(totalMailboxes(snapshot))} />
            <DetailRow label="Locations needing collection" value={String(snapshot.postOffices.filter((office) => office.mailboxes.some((box) => box.mailWaiting)).length)} />
          </div>
        </div>
      )}
      {snapshot.postOffices.length > 0 ? (
        <div className="office-list">
          {snapshot.postOffices.map((office) => (
            <OfficeSection
              key={office.id}
              office={office}
              postOffices={snapshot.postOffices}
              filter={filter}
              busyId={busyId}
              mutate={mutate}
              canManage={canManage}
              onSaveOffice={saveOffice}
              onDeleteOffice={removeOffice}
              onSaveMailbox={saveMailbox}
              onDeleteMailbox={removeMailbox}
            />
          ))}
        </div>
      ) : (
        <div className="empty-state"><MapPin size={22} />No post offices have been added yet.</div>
      )}
    </Panel>
  );
}

function OfficeSection({
  office,
  postOffices,
  filter,
  busyId,
  mutate,
  canManage,
  onSaveOffice,
  onDeleteOffice,
  onSaveMailbox,
  onDeleteMailbox
}: {
  office: PostOffice;
  postOffices: PostOffice[];
  filter: MailboxFilter;
  busyId: string | null;
  mutate: (action: () => Promise<void>, mailboxId?: string) => Promise<void>;
  canManage: boolean;
  onSaveOffice: (officeId: string, input: { name: string; address: string; phone?: string; latitude: number; longitude: number; geofenceRadius: number }) => Promise<void>;
  onDeleteOffice: (office: PostOffice) => Promise<void>;
  onSaveMailbox: (mailboxId: string, input: { postOfficeId: string; boxNumber: string }) => Promise<void>;
  onDeleteMailbox: (mailbox: Mailbox) => Promise<void>;
}) {
  const [editingOffice, setEditingOffice] = useState(false);
  const [name, setName] = useState(office.name);
  const [address, setAddress] = useState(office.address);
  const [phone, setPhone] = useState(office.phone ?? "");
  const [latitude, setLatitude] = useState(String(office.latitude));
  const [longitude, setLongitude] = useState(String(office.longitude));
  const [geofenceRadius, setGeofenceRadius] = useState(String(office.geofenceRadius));
  const boxes = office.mailboxes.filter((box) => {
    if (filter === "waiting") return box.mailWaiting;
    if (filter === "clear") return !box.mailWaiting;
    return true;
  });
  if (boxes.length === 0 && filter !== "all") return null;
  const waiting = office.mailboxes.filter((box) => box.mailWaiting).length;
  return (
    <article className="office">
      {editingOffice ? (
        <form className="editable-row office-edit" onSubmit={async (event) => {
          event.preventDefault();
          await onSaveOffice(office.id, {
            name,
            address,
            phone: phone || undefined,
            latitude: Number(latitude),
            longitude: Number(longitude),
            geofenceRadius: Number(geofenceRadius)
          });
          setEditingOffice(false);
        }}>
          <div className="edit-fields">
            <label>Name<input value={name} onChange={(event) => setName(event.target.value)} required /></label>
            <label>Address<input value={address} onChange={(event) => setAddress(event.target.value)} required /></label>
            <label>Phone<input value={phone} onChange={(event) => setPhone(event.target.value)} /></label>
            <label>Latitude<input type="number" step="any" value={latitude} onChange={(event) => setLatitude(event.target.value)} required /></label>
            <label>Longitude<input type="number" step="any" value={longitude} onChange={(event) => setLongitude(event.target.value)} required /></label>
            <label>Radius<input type="number" min="25" max="5000" value={geofenceRadius} onChange={(event) => setGeofenceRadius(event.target.value)} required /></label>
          </div>
          <div className="row-actions">
            <button className="primary" type="submit"><Save size={16} />Save</button>
            <button className="secondary" type="button" onClick={() => setEditingOffice(false)}><X size={16} />Cancel</button>
          </div>
        </form>
      ) : (
        <div className="office-title">
          <div>
            <h3>{office.name}</h3>
            <p>{office.address}</p>
          </div>
          <div className="office-actions">
            <StatusPill tone={waiting > 0 ? "warning" : "ok"}>{waiting > 0 ? `${waiting} waiting` : "Clear"}</StatusPill>
            <a className="text-link" href={appleMapsUrl(office)} target="_blank" rel="noreferrer"><ExternalLink size={15} />Apple Maps</a>
            {canManage && (
              <div className="row-actions">
                <button type="button" className="icon-button" title="Edit post office" onClick={() => setEditingOffice(true)}><Edit2 size={16} /></button>
                <button type="button" className="icon-button danger" title="Delete post office" onClick={() => onDeleteOffice(office)}><Trash2 size={16} /></button>
              </div>
            )}
          </div>
        </div>
      )}
      <div className="mailbox-table">
        <div className="mailbox-table-head">
          <span>Box</span>
          <span>Status</span>
          <span>Last event</span>
          <span>Action</span>
        </div>
        {boxes.map((box) => (
          <MailboxRow
            key={box.id}
            box={box}
            busy={busyId === box.id}
            onCollect={() => mutate(() => collectMailbox(box.id), box.id)}
            postOffices={postOffices}
            canManage={canManage}
            onSave={onSaveMailbox}
            onDelete={onDeleteMailbox}
            table
          />
        ))}
        {boxes.length === 0 && (
          <div className="mailbox-row empty-row">
            <div>
              <strong>No PO box assigned</strong>
              <small>This post office can be deleted or given a PO box.</small>
            </div>
            <span className="small">No status</span>
            <span className="small">No events yet</span>
            <span className="small">No PO box action</span>
          </div>
        )}
      </div>
    </article>
  );
}

function MapSummary({ snapshot }: { snapshot: DashboardSnapshot }) {
  return (
    <Panel title="Post Office Map">
      {snapshot.postOffices.map((office) => {
        const waiting = office.mailboxes.filter((box) => box.mailWaiting).length;
        return (
          <a className="map-location" href={appleMapsUrl(office)} target="_blank" rel="noreferrer" key={office.id}>
            <MapPin size={18} />
            <span>{office.name}</span>
            <strong>{waiting > 0 ? `${waiting} waiting` : "Clear"}</strong>
          </a>
        );
      })}
    </Panel>
  );
}

function MapSection({ snapshot }: { snapshot: DashboardSnapshot }) {
  const activeOffice = snapshot.postOffices.find((office) => office.mailboxes.some((box) => box.mailWaiting)) ?? snapshot.postOffices[0];
  return (
    <div className="page-grid map-page">
      <section className="page-main">
        <Panel title="Apple Maps Collection View" aside={activeOffice ? `${activeOffice.latitude.toFixed(4)}, ${activeOffice.longitude.toFixed(4)}` : undefined}>
          {activeOffice ? (
            <div className="apple-map-board" aria-label="Post office map overview">
              <div className="map-board-copy">
                <MapPin size={22} />
                <div>
                  <strong>{activeOffice.name}</strong>
                  <span>{activeOffice.address}</span>
                </div>
                <a className="primary map-button" href={appleMapsUrl(activeOffice)} target="_blank" rel="noreferrer"><ExternalLink size={17} />Open in Apple Maps</a>
              </div>
              <div className="map-board-grid">
                {snapshot.postOffices.map((office) => {
                  const waiting = office.mailboxes.filter((box) => box.mailWaiting).length;
                  const point = mapPoint(snapshot.postOffices, office);
                  return (
                    <a
                      className={waiting > 0 ? "map-point waiting" : "map-point"}
                      href={appleMapsUrl(office)}
                      key={office.id}
                      style={{ left: `${point.x}%`, top: `${point.y}%` }}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`${office.name}, ${waiting > 0 ? `${waiting} waiting` : "clear"}`}
                    >
                      <span>{waiting}</span>
                    </a>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="small">Add a post office to show the operational map.</p>
          )}
        </Panel>
        <Panel title="Collection Routes">
          <div className="route-list">
            {snapshot.postOffices.map((office) => <OfficeMapCard office={office} key={office.id} />)}
          </div>
        </Panel>
      </section>
      <aside className="side-panels">
        <Panel title="Map Summary">
          <div className="detail-list">
            <DetailRow label="Tracked locations" value={String(snapshot.postOffices.length)} />
            <DetailRow label="Boxes mapped" value={String(totalMailboxes(snapshot))} />
            <DetailRow label="Needs collection" value={String(snapshot.outstandingMailboxCount)} />
            <DetailRow label="Map provider" value="Apple Maps" />
          </div>
        </Panel>
        <Panel title="Priority Stops">
          {snapshot.postOffices.filter((office) => office.mailboxes.some((box) => box.mailWaiting)).length > 0 ? (
            <div className="priority-list">
              {snapshot.postOffices
                .filter((office) => office.mailboxes.some((box) => box.mailWaiting))
                .map((office) => <a href={appleMapsUrl(office)} target="_blank" rel="noreferrer" key={office.id}>{office.name}</a>)}
            </div>
          ) : (
            <p className="small">No priority stops right now.</p>
          )}
        </Panel>
      </aside>
    </div>
  );
}

function TeamSection({ snapshot, members, refresh, setError }: { snapshot: DashboardSnapshot; members: TeamMember[]; refresh: () => Promise<void>; setError: (value: string | null) => void }) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"ADMIN" | "MEMBER">("MEMBER");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    try {
      await createUser({ email, displayName, password, role });
      setEmail("");
      setDisplayName("");
      setPassword("");
      setRole("MEMBER");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create user.");
    }
  }

  async function saveMember(memberId: string, input: { email: string; displayName: string; role: "ADMIN" | "MEMBER" }) {
    try {
      await updateUser(memberId, input);
      await refresh();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update user.");
    }
  }

  async function removeMember(member: TeamMember) {
    if (!window.confirm(`Delete ${member.displayName}? This will disable their access to pobox.watch.`)) return;
    try {
      await deleteUser(member.id);
      await refresh();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete user.");
    }
  }

  return (
    <div className="page-grid">
      <section className="page-main">
        <Panel title="Team Directory" aside={`${members.length} users`}>
          <div className="team-list">
            {members.map((member) => (
              <TeamMemberRow
                key={member.id}
                member={member}
                currentUserId={snapshot.currentUser.id}
                canManage={snapshot.currentUser.role === "ADMIN"}
                onSave={saveMember}
                onDelete={removeMember}
              />
            ))}
          </div>
        </Panel>
      </section>
      <aside className="side-panels">
        <Panel title="Access Summary">
          <div className="detail-list">
            <DetailRow label="Admins" value={String(members.filter((member) => member.role === "ADMIN").length)} />
            <DetailRow label="Members" value={String(members.filter((member) => member.role === "MEMBER").length)} />
            <DetailRow label="Disabled" value={String(members.filter((member) => !member.active).length)} />
          </div>
        </Panel>
        {snapshot.currentUser.role === "ADMIN" && (
          <Panel title="Add User">
            <form className="form-grid" onSubmit={submit}>
              <label>Name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required /></label>
              <label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
              <label>Temporary password<input type="password" value={password} minLength={12} onChange={(event) => setPassword(event.target.value)} required /></label>
              <label>Role<select value={role} onChange={(event) => setRole(event.target.value as "ADMIN" | "MEMBER")}><option>MEMBER</option><option>ADMIN</option></select></label>
              <button className="primary"><Plus size={17} />Create User</button>
            </form>
          </Panel>
        )}
      </aside>
    </div>
  );
}

function TeamMemberRow({
  member,
  currentUserId,
  canManage,
  onSave,
  onDelete
}: {
  member: TeamMember;
  currentUserId: string;
  canManage: boolean;
  onSave: (memberId: string, input: { email: string; displayName: string; role: "ADMIN" | "MEMBER" }) => Promise<void>;
  onDelete: (member: TeamMember) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState(member.email);
  const [displayName, setDisplayName] = useState(member.displayName);
  const [role, setRole] = useState<"ADMIN" | "MEMBER">(member.role);
  const self = member.id === currentUserId;

  useEffect(() => {
    setEmail(member.email);
    setDisplayName(member.displayName);
    setRole(member.role);
  }, [member.email, member.displayName, member.role]);

  if (editing) {
    return (
      <form className="team-member editable-row" onSubmit={async (event) => {
        event.preventDefault();
        await onSave(member.id, { email, displayName, role });
        setEditing(false);
      }}>
        <div className="edit-fields">
          <label>Name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required /></label>
          <label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
          <label>Role<select value={role} onChange={(event) => setRole(event.target.value as "ADMIN" | "MEMBER")} disabled={self}><option>MEMBER</option><option>ADMIN</option></select></label>
        </div>
        <div className="row-actions">
          <button className="primary" type="submit"><Save size={16} />Save</button>
          <button className="secondary" type="button" onClick={() => setEditing(false)}><X size={16} />Cancel</button>
        </div>
      </form>
    );
  }

  return (
    <div className="team-member">
      <div>
        <strong>{member.displayName}</strong>
        <span>{member.email}</span>
      </div>
      <div className="team-badges">
        <StatusPill tone={member.active ? "ok" : "muted"}>{member.active ? "Active" : "Disabled"}</StatusPill>
        <StatusPill tone={member.role === "ADMIN" ? "info" : "muted"}>{member.role}</StatusPill>
        <small>{member.status}</small>
      </div>
      {canManage && (
        <div className="row-actions">
          <button type="button" className="icon-button" title="Edit user" onClick={() => setEditing(true)}><Edit2 size={16} /></button>
          <button type="button" className="icon-button danger" title="Delete user" disabled={self} onClick={() => onDelete(member)}><Trash2 size={16} /></button>
        </div>
      )}
    </div>
  );
}

function SettingsSection({ snapshot, refresh, setError }: { snapshot: DashboardSnapshot; refresh: () => Promise<void>; setError: (value: string | null) => void }) {
  return (
    <div className="page-grid settings-page">
      <section className="page-main">
        <SecurityPanel setError={setError} />
        <Panel title="Workspace">
          <div className="detail-list">
            <DetailRow label="Workspace" value={snapshot.workspace.name} />
            <DetailRow label="Current user" value={snapshot.currentUser.email} />
            <DetailRow label="Role" value={snapshot.currentUser.role} />
            <DetailRow label="Locations" value={`${snapshot.postOffices.length} post offices, ${totalMailboxes(snapshot)} boxes`} />
          </div>
        </Panel>
      </section>
      <aside className="side-panels">
        <AddPostOfficeForm snapshot={snapshot} refresh={refresh} setError={setError} />
        <AddMailboxForm snapshot={snapshot} refresh={refresh} setError={setError} />
      </aside>
    </div>
  );
}

function HistorySection({ snapshot }: { snapshot: DashboardSnapshot }) {
  const detected = snapshot.history.filter(isMailEvent).length;
  const collected = snapshot.history.filter(isCollectionEvent).length;
  return (
    <div className="page-grid">
      <section className="page-main">
        <Panel title="History Timeline" aside={`${snapshot.history.length} recent events`}>
          <History snapshot={snapshot} limit={50} />
        </Panel>
      </section>
      <aside className="side-panels">
        <Panel title="Activity Summary">
          <div className="detail-list">
            <DetailRow label="Detected mail" value={String(detected)} />
            <DetailRow label="Collections" value={String(collected)} />
            <DetailRow label="Open items" value={String(snapshot.outstandingMailboxCount)} />
          </div>
        </Panel>
        <Panel title="Needs Review">
          <div className="review-note">
            <AlertTriangle size={18} />
            <p>Parser review events are tracked by the backend audit log. A dedicated review queue is the next backend-backed workflow.</p>
          </div>
        </Panel>
      </aside>
    </div>
  );
}

function NeedsReviewSection({ snapshot, reviewItems, mutate, refresh }: { snapshot: DashboardSnapshot; reviewItems: ReviewItem[]; mutate: (action: () => Promise<void>, mailboxId?: string) => Promise<void>; refresh: () => Promise<void> }) {
  const mailboxes = snapshot.postOffices.flatMap((office) => office.mailboxes.map((box) => ({ ...box, officeName: office.name })));

  async function simulateUnclearMail() {
    await mutate(async () => {
      await simulateMail("unknown-box");
      await refresh();
    });
  }

  return (
    <div className="page-grid">
      <section className="page-main">
        <Panel title="Needs Review Queue" aside={`${reviewItems.length} items`}>
          {reviewItems.length > 0 ? (
            <div className="review-list">
              {reviewItems.map((item) => (
                <ReviewItemRow key={item.id} item={item} mailboxes={mailboxes} mutate={mutate} refresh={refresh} />
              ))}
            </div>
          ) : (
            <div className="empty-state"><Check size={22} />No mail notifications need manual review.</div>
          )}
        </Panel>
      </section>
      <aside className="side-panels">
        <Panel title="Review Summary">
          <div className="detail-list">
            <DetailRow label="Waiting review" value={String(reviewItems.length)} />
            <DetailRow label="Low confidence" value={String(reviewItems.filter((item) => (item.confidence ?? 1) < 0.7).length)} />
            <DetailRow label="Unmatched box" value={String(reviewItems.filter((item) => !item.mailboxNumber).length)} />
          </div>
        </Panel>
        <Panel title="Review Test">
          <p className="small">Create an unmatched notification to confirm the review queue is receiving parser exceptions.</p>
          <button className="primary security-action" onClick={simulateUnclearMail}><AlertTriangle size={17} />Simulate Review Item</button>
        </Panel>
      </aside>
    </div>
  );
}

function ReviewItemRow({
  item,
  mailboxes,
  mutate,
  refresh
}: {
  item: ReviewItem;
  mailboxes: Array<Mailbox & { officeName: string }>;
  mutate: (action: () => Promise<void>, mailboxId?: string) => Promise<void>;
  refresh: () => Promise<void>;
}) {
  const matchingMailbox = mailboxes.find((box) => item.mailboxNumber && normalizeBoxNumber(box.boxNumber) === normalizeBoxNumber(item.mailboxNumber));
  const defaultMailbox = matchingMailbox ?? (item.mailboxNumber ? undefined : mailboxes[0]);
  const [selectedMailboxId, setSelectedMailboxId] = useState(defaultMailbox?.id ?? "");
  const selectedMailbox = mailboxes.find((box) => box.id === selectedMailboxId);
  const receivedAt = item.receivedAt ?? item.createdAt;
  const boxMissing = Boolean(item.mailboxNumber && !matchingMailbox);

  useEffect(() => {
    if (!mailboxes.some((box) => box.id === selectedMailboxId)) {
      setSelectedMailboxId(defaultMailbox?.id ?? "");
    }
  }, [defaultMailbox?.id, mailboxes.map((box) => box.id).join(","), selectedMailboxId]);

  async function resolve() {
    if (!selectedMailboxId) return;
    await mutate(async () => {
      await resolveReviewItem(item.id, selectedMailboxId);
      await refresh();
    }, selectedMailboxId);
  }

  async function dismiss() {
    if (!window.confirm("Dismiss this review item without marking a box as having mail?")) return;
    await mutate(async () => {
      await dismissReviewItem(item.id);
      await refresh();
    });
  }

  return (
    <article className="review-item actionable">
      <div className="review-icon"><AlertTriangle size={18} /></div>
      <div className="review-content">
        <strong>{item.subject ?? "Unmatched mail notification"}</strong>
        <span>{item.mailboxNumber ? `Possible box ${item.mailboxNumber}` : "No box number could be matched."}</span>
        {item.sender && <span>From {item.sender}</span>}
        {item.bodyPreview && <small>{item.bodyPreview}</small>}
        <small>Received {new Date(receivedAt).toLocaleString()}</small>
        <small>{item.provider ?? "mail"} - {item.providerMessageId}</small>
      </div>
      <StatusPill tone="warning">{confidenceLabel(item.confidence)}</StatusPill>
      <div className="review-actions">
        {boxMissing && <p className="review-warning">No saved box matches {item.mailboxNumber}. Set up that box first, then return to review this email.</p>}
        {mailboxes.length > 0 ? (
          <>
            <label>Assign to<select value={selectedMailboxId} onChange={(event) => setSelectedMailboxId(event.target.value)}>
              <option value="">Choose a saved box</option>
              {mailboxes.map((box) => <option key={box.id} value={box.id}>{box.officeName} - Box {box.boxNumber}</option>)}
            </select></label>
            <button className="primary" disabled={!selectedMailbox} onClick={resolve}><Check size={16} />Mark Box Waiting</button>
          </>
        ) : (
          <p className="small">Add a post office and box before resolving review items.</p>
        )}
        <button className="secondary" onClick={dismiss}><X size={16} />Dismiss</button>
      </div>
    </article>
  );
}

function OfficeMapCard({ office }: { office: PostOffice }) {
  const waiting = office.mailboxes.filter((box) => box.mailWaiting).length;
  return (
    <article className={waiting > 0 ? "map-card waiting" : "map-card"}>
      <div>
        <h3>{office.name}</h3>
        <p>{office.address}</p>
        {office.phone && <span>{office.phone}</span>}
        <span>{office.geofenceRadius}m geofence radius</span>
      </div>
      <div className="map-card-footer">
        <StatusPill tone={waiting > 0 ? "warning" : "ok"}>{waiting > 0 ? `${waiting} waiting` : "Clear"}</StatusPill>
        <a className="primary map-button" href={appleMapsUrl(office)} target="_blank" rel="noreferrer"><MapPin size={17} />Apple Maps</a>
      </div>
    </article>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusPill({ tone, children }: { tone: "ok" | "warning" | "info" | "muted"; children: React.ReactNode }) {
  return <span className={`status-pill ${tone}`}>{children}</span>;
}

function securityComplete(status: SecurityStatus) {
  return status.passkeyCount > 0 && status.totpEnabled;
}

function SecurityPanel({ setError }: { setError: (value: string | null) => void }) {
  const [status, setStatus] = useState<SecurityStatus | null>(null);
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function refreshSecurity() {
    setStatus(await loadSecurityStatus());
  }

  useEffect(() => {
    refreshSecurity().catch((err) => setError(err instanceof Error ? err.message : "Unable to load security settings."));
  }, []);

  async function startSetup() {
    try {
      setBusy(true);
      setRecoveryCodes([]);
      setSetup(await beginTotpSetup());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to start 2FA setup.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmSetup(event: React.FormEvent) {
    event.preventDefault();
    try {
      setBusy(true);
      const result = await confirmTotpSetup(code);
      setRecoveryCodes(result.recoveryCodes);
      setSetup(null);
      setCode("");
      await refreshSecurity();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to confirm 2FA setup.");
    } finally {
      setBusy(false);
    }
  }

  async function addPasskey() {
    try {
      setBusy(true);
      const options = await beginPasskeyRegistration();
      const response = await startRegistration({ optionsJSON: options.options });
      setStatus(await registerPasskey(response, "Passkey"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to add passkey.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Security">
      <div className="security-list">
        <span><KeyRound size={17} />Passkeys: {status?.passkeysAvailable ? `${status.passkeyCount} registered.` : "Not available in this browser or server configuration."}</span>
        <span><Shield size={17} />2FA: {status?.totpEnabled ? `Required and on, with ${status.recoveryCodesRemaining} recovery codes left.` : "Required and not set up."}</span>
        <span><RefreshCw size={17} />Version updates: users see plain-English changes after sign-in.</span>
      </div>

      <button className="primary security-action" disabled={busy || !status?.passkeysAvailable} onClick={addPasskey}><KeyRound size={17} />Add Passkey</button>

      {!status?.totpEnabled && !setup && <button className="primary security-action" disabled={busy} onClick={startSetup}><Shield size={17} />Set Up Authenticator App</button>}

      {setup && (
        <form className="form-grid security-setup" onSubmit={confirmSetup}>
          <p className="small">Add this account to an authenticator app, then enter the six-digit code it shows.</p>
          <label>Manual setup key<input value={setup.secret} readOnly /></label>
          <a href={setup.otpauthUrl}>Open Authenticator Setup</a>
          <label>Six-digit code<input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} required /></label>
          <button className="primary" disabled={busy}>Confirm 2FA</button>
        </form>
      )}

      {status?.totpEnabled && <p className="small security-note">Authenticator 2FA is mandatory for pobox.watch accounts and cannot be turned off from the app.</p>}

      {recoveryCodes.length > 0 && (
        <div className="recovery-codes">
          <strong>Recovery codes</strong>
          <p className="small">Keep these somewhere safe. Each code can be used once if you lose access to your authenticator app.</p>
          <code>{recoveryCodes.join("\n")}</code>
        </div>
      )}
    </Panel>
  );
}

function ChangeNoticeModal({ notice, onClose }: { notice: AppChangesResponse; onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="change-modal" role="dialog" aria-modal="true" aria-labelledby="change-title">
        <div>
          <p className="workspace">pobox.watch {notice.version}</p>
          <h2 id="change-title">{notice.since ? "Changes Since Your Last Login" : "Latest Changes"}</h2>
          <p className="small">
            {notice.since
              ? `These updates were made after ${new Date(notice.since).toLocaleString()}.`
              : "Here are the latest updates to the app."}
          </p>
        </div>
        <div className="change-list">
          {notice.changes.map((change) => (
            <article key={change.id} className="change-item">
              <strong>{change.title}</strong>
              <span>{change.summary}</span>
            </article>
          ))}
        </div>
        <button className="primary" onClick={onClose}>Got It</button>
      </section>
    </div>
  );
}

function AddPostOfficeForm({ snapshot, refresh, setError }: { snapshot: DashboardSnapshot; refresh: () => Promise<void>; setError: (value: string | null) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PostOfficeLocationResult[]>([]);
  const [directoryStatus, setDirectoryStatus] = useState<PostOfficeDirectoryStatus | null>(null);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [geofenceRadius, setGeofenceRadius] = useState("200");
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [searchedQuery, setSearchedQuery] = useState("");

  useEffect(() => {
    if (snapshot.currentUser.role !== "ADMIN") return;
    loadPostOfficeDirectoryStatus()
      .then(setDirectoryStatus)
      .catch(() => setDirectoryStatus(null));
  }, [snapshot.currentUser.role]);

  useEffect(() => {
    const trimmed = query.trim();
    if (snapshot.currentUser.role !== "ADMIN") return;
    if (trimmed.length < 2) {
      setResults([]);
      setSearchedQuery("");
      return;
    }

    const handle = window.setTimeout(() => {
      void searchSuggestions(trimmed);
    }, 250);
    return () => window.clearTimeout(handle);
  }, [query, snapshot.currentUser.role]);

  if (snapshot.currentUser.role !== "ADMIN") return null;

  async function search(event: React.FormEvent) {
    event.preventDefault();
    await searchSuggestions(query.trim());
  }

  async function searchSuggestions(searchQuery: string) {
    if (searchQuery.length < 2) return;
    try {
      setBusy(true);
      setResults(await searchPostOfficeLocations(searchQuery));
      setSearchedQuery(searchQuery);
      setDirectoryStatus(await loadPostOfficeDirectoryStatus());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to search post office locations.");
    } finally {
      setBusy(false);
    }
  }

  function selectLocation(location: PostOfficeLocationResult) {
    setName(location.name);
    setAddress(location.address);
    setPhone(location.phone ?? "");
    setLatitude(String(location.latitude));
    setLongitude(String(location.longitude));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    try {
      await createPostOffice({ name, address, phone: phone || undefined, latitude: Number(latitude), longitude: Number(longitude), geofenceRadius: Number(geofenceRadius) });
      setQuery("");
      setResults([]);
      setName("");
      setAddress("");
      setPhone("");
      setLatitude("");
      setLongitude("");
      setGeofenceRadius("200");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create post office.");
    }
  }

  async function syncDirectory() {
    try {
      setSyncing(true);
      setDirectoryStatus(await syncPostOfficeDirectory());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to import post office directory.");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <Panel title="Add Post Office">
      <div className="directory-status">
        <div>
          <strong>Australia Post directory</strong>
          <span>{directoryStatusLabel(directoryStatus)}</span>
        </div>
        <button className="secondary" type="button" onClick={syncDirectory} disabled={syncing}>
          <RefreshCw size={16} />{syncing ? "Importing..." : "Refresh Directory"}
        </button>
      </div>
      <form className="form-grid" onSubmit={search}>
        <label>Search suburb, postcode, post office name, or street<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="South, Fitzroy South, 3121, or Bourke" minLength={2} autoComplete="off" /></label>
        <button className="primary" disabled={busy || query.trim().length < 2}><MapPin size={17} />Search Locations</button>
      </form>
      {!busy && searchedQuery && results.length === 0 && (
        <p className="muted-line">No matching imported post offices yet. Try a postcode for the most precise match, or refresh the directory.</p>
      )}
      {results.length > 0 && (
        <div className="lookup-results">
          {results.map((location) => (
            <button type="button" className="lookup-result" key={location.sourceId} onClick={() => selectLocation(location)}>
              <strong>{location.name}</strong>
              <span>{location.address}</span>
              <small>{[location.phone, location.hours].filter(Boolean).join(" - ")}</small>
            </button>
          ))}
        </div>
      )}
      <form className="form-grid" onSubmit={submit}>
        <label>Name<input value={name} onChange={(event) => setName(event.target.value)} required /></label>
        <label>Address<input value={address} onChange={(event) => setAddress(event.target.value)} required /></label>
        <label>Phone<input value={phone} onChange={(event) => setPhone(event.target.value)} /></label>
        <label>Latitude<input type="number" step="any" value={latitude} onChange={(event) => setLatitude(event.target.value)} required /></label>
        <label>Longitude<input type="number" step="any" value={longitude} onChange={(event) => setLongitude(event.target.value)} required /></label>
        <label>Geofence radius<input type="number" min="25" max="5000" value={geofenceRadius} onChange={(event) => setGeofenceRadius(event.target.value)} required /></label>
        <button className="primary"><Plus size={17} />Create Post Office</button>
      </form>
    </Panel>
  );
}

function directoryStatusLabel(status: PostOfficeDirectoryStatus | null) {
  if (!status) return "Status not loaded yet.";
  if (status.activeRowCount > 0) {
    const synced = status.syncedAt ? ` Last refreshed ${new Date(status.syncedAt).toLocaleString()}.` : "";
    return `${status.activeRowCount.toLocaleString()} imported active locations.${synced}`;
  }
  if (status.status === "running") return "Import is currently running.";
  if (status.status === "failed") return `Import failed${status.message ? `: ${status.message}` : "."}`;
  return "Not imported yet. Refresh the directory before searching.";
}

function AddMailboxForm({ snapshot, refresh, setError }: { snapshot: DashboardSnapshot; refresh: () => Promise<void>; setError: (value: string | null) => void }) {
  const [postOfficeId, setPostOfficeId] = useState(snapshot.postOffices[0]?.id ?? "");
  const [boxNumber, setBoxNumber] = useState("");

  useEffect(() => {
    if (!snapshot.postOffices.some((office) => office.id === postOfficeId)) {
      setPostOfficeId(snapshot.postOffices[0]?.id ?? "");
    }
  }, [snapshot.postOffices.map((office) => office.id).join(","), postOfficeId]);

  if (snapshot.currentUser.role !== "ADMIN") return null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    try {
      await createMailbox({ postOfficeId, boxNumber });
      setBoxNumber("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create PO box.");
    }
  }

  return (
    <Panel title="Add PO Box">
      {snapshot.postOffices.length > 0 ? (
        <form className="form-grid" onSubmit={submit}>
          <label>Post office<select value={postOfficeId} onChange={(event) => setPostOfficeId(event.target.value)}>{snapshot.postOffices.map((office) => <option value={office.id} key={office.id}>{office.name}</option>)}</select></label>
          <label>PO Box Number<input value={boxNumber} onChange={(event) => setBoxNumber(event.target.value)} required /></label>
          <button className="primary"><Plus size={17} />Create PO Box</button>
        </form>
      ) : (
        <p className="small">Create or import a post office before adding a PO box.</p>
      )}
    </Panel>
  );
}

function Panel({ title, aside, children }: { title: string; aside?: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>{title}</h2>
        {aside && <span>{aside}</span>}
      </div>
      {children}
    </section>
  );
}

function MailboxRow({
  box,
  busy,
  onCollect,
  table = false,
  postOffices = [],
  canManage = false,
  onSave,
  onDelete
}: {
  box: Mailbox;
  busy: boolean;
  onCollect: () => void;
  table?: boolean;
  postOffices?: PostOffice[];
  canManage?: boolean;
  onSave?: (mailboxId: string, input: { postOfficeId: string; boxNumber: string }) => Promise<void>;
  onDelete?: (mailbox: Mailbox) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [postOfficeId, setPostOfficeId] = useState(box.postOfficeId);
  const [boxNumber, setBoxNumber] = useState(box.boxNumber);
  const status = box.mailWaiting ? "Mail waiting" : "Clear";
  const lastEvent = box.latestNotificationAt
    ? `Detected ${new Date(box.latestNotificationAt).toLocaleString()}`
    : box.lastCollectedAt
      ? `Collected ${new Date(box.lastCollectedAt).toLocaleString()}`
      : "No events yet";
  if (table) {
    if (editing) {
      return (
        <form className="mailbox-row editable-row" onSubmit={async (event) => {
          event.preventDefault();
          if (!onSave) return;
          await onSave(box.id, { postOfficeId, boxNumber });
          setEditing(false);
        }}>
          <div className="edit-fields">
            <label>Post office<select value={postOfficeId} onChange={(event) => setPostOfficeId(event.target.value)}>{postOffices.map((office) => <option value={office.id} key={office.id}>{office.name}</option>)}</select></label>
            <label>PO Box Number<input value={boxNumber} onChange={(event) => setBoxNumber(event.target.value)} required /></label>
          </div>
          <span>{status}</span>
          <span>{lastEvent}</span>
          <div className="row-actions">
            <button className="primary" type="submit"><Save size={16} />Save</button>
            <button className="secondary" type="button" onClick={() => setEditing(false)}><X size={16} />Cancel</button>
          </div>
        </form>
      );
    }
    return (
      <div className={box.mailWaiting ? "mailbox-row waiting" : "mailbox-row"}>
        <div>
          <strong>{box.name}</strong>
          <small>Box {box.boxNumber}</small>
        </div>
        <StatusPill tone={box.mailWaiting ? "warning" : "ok"}>{status}</StatusPill>
        <span>{lastEvent}</span>
        <div className="row-actions">
          {box.mailWaiting && <button disabled={busy} onClick={onCollect}>{busy ? "Saving" : "Mark Collected"}</button>}
          {canManage && (
            <>
              <button type="button" className="icon-button" title="Edit PO box" onClick={() => setEditing(true)}><Edit2 size={16} /></button>
              <button type="button" className="icon-button danger" title="Delete PO box" onClick={() => onDelete?.(box)}><Trash2 size={16} /></button>
            </>
          )}
          {!box.mailWaiting && !canManage && <span className="small">No action</span>}
        </div>
      </div>
    );
  }
  return (
    <div className={box.mailWaiting ? "mailbox waiting" : "mailbox"}>
      <div>
        <strong>{box.name}</strong>
        <span>{box.mailWaiting ? "Mail waiting" : "Clear"}</span>
        <small>{lastEvent}</small>
      </div>
      {box.mailWaiting && <button disabled={busy} onClick={onCollect}>{busy ? "Saving" : "Mark Collected"}</button>}
    </div>
  );
}

function History({ snapshot, limit }: { snapshot: DashboardSnapshot; limit: number }) {
  const mailboxNames = useMemo(() => mailboxNameMap(snapshot), [snapshot]);
  const userNames = useMemo(() => new Map([[snapshot.currentUser.id, snapshot.currentUser.displayName]]), [snapshot.currentUser]);
  const events = snapshot.history.slice(0, limit);
  if (events.length === 0) return <p className="small">No history yet.</p>;
  return (
    <div className="history">
      {events.map((event) => {
        const isCollection = isCollectionEvent(event);
        const when = isCollection ? event.collectedAt : event.processedAt;
        const mailboxName = mailboxNames.get(event.mailboxId) ?? "Unknown PO box";
        return (
          <article className="history-item" key={event.id}>
            <div className={isCollection ? "history-icon ok" : "history-icon warning"}>
              {isCollection ? <Check size={16} /> : <Mail size={16} />}
            </div>
            <div>
              <strong>{isCollection ? `${mailboxName} collected` : `${mailboxName} detected mail`}</strong>
              <span>{isCollection ? `By ${userNames.get(event.collectedBy) ?? event.collectedBy} from ${event.source}` : `${event.subject} from ${event.sender}`}</span>
              <small><Clock size={13} />{new Date(when).toLocaleString()}</small>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function totalMailboxes(snapshot: DashboardSnapshot) {
  return snapshot.postOffices.reduce((total, office) => total + office.mailboxes.length, 0);
}

function mailboxNameMap(snapshot: DashboardSnapshot) {
  return new Map(snapshot.postOffices.flatMap((office) => office.mailboxes.map((box) => [box.id, box.name] as const)));
}

function normalizeBoxNumber(value: string) {
  return value.replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function isMailEvent(event: MailHistoryEvent | CollectionHistoryEvent): event is MailHistoryEvent {
  return "processedAt" in event;
}

function isCollectionEvent(event: MailHistoryEvent | CollectionHistoryEvent): event is CollectionHistoryEvent {
  return "collectedAt" in event;
}

function confidenceLabel(confidence?: number) {
  if (confidence === undefined) return "Needs review";
  return `${Math.round(confidence * 100)}% confidence`;
}

function appleMapsUrl(office: PostOffice) {
  const params = new URLSearchParams({
    ll: `${office.latitude},${office.longitude}`,
    q: office.name
  });
  return `https://maps.apple.com/?${params.toString()}`;
}

function mapPoint(offices: PostOffice[], office: PostOffice) {
  const latitudes = offices.map((item) => item.latitude);
  const longitudes = offices.map((item) => item.longitude);
  const minLat = Math.min(...latitudes);
  const maxLat = Math.max(...latitudes);
  const minLng = Math.min(...longitudes);
  const maxLng = Math.max(...longitudes);
  const x = maxLng === minLng ? 50 : 12 + ((office.longitude - minLng) / (maxLng - minLng)) * 76;
  const y = maxLat === minLat ? 50 : 88 - ((office.latitude - minLat) / (maxLat - minLat)) * 76;
  return { x, y };
}

createRoot(document.getElementById("root")!).render(<App />);
