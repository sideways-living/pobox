import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Bell, Check, KeyRound, LogIn, Mail, MapPin, Plus, RefreshCw, Shield, Users } from "lucide-react";
import { collectMailbox, createMailbox, createPostOffice, createUser, loadDashboard, loadMembers, login, realtimeUrl, simulateMail } from "./api";
import type { DashboardSnapshot, Mailbox, TeamMember } from "./types";
import "./styles.css";

type Section = "Overview" | "Mailboxes" | "Map" | "History" | "Team" | "Settings";

function App() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [section, setSection] = useState<Section>("Overview");
  const [members, setMembers] = useState<TeamMember[]>([]);

  async function refresh() {
    const nextSnapshot = await loadDashboard();
    setSnapshot(nextSnapshot);
    if (nextSnapshot.currentUser.role === "ADMIN") {
      setMembers(await loadMembers());
    }
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
          <NavItem icon={<Bell size={17} />} label="Overview" active={section === "Overview"} onClick={() => setSection("Overview")} />
          <NavItem icon={<Mail size={17} />} label="Mailboxes" active={section === "Mailboxes"} onClick={() => setSection("Mailboxes")} />
          <NavItem icon={<MapPin size={17} />} label="Map" active={section === "Map"} onClick={() => setSection("Map")} />
          <NavItem icon={<RefreshCw size={17} />} label="History" active={section === "History"} onClick={() => setSection("History")} />
          <NavItem icon={<Users size={17} />} label="Team" active={section === "Team"} onClick={() => setSection("Team")} />
          <NavItem icon={<Shield size={17} />} label="Settings" active={section === "Settings"} onClick={() => setSection("Settings")} />
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

        <SectionView
          section={section}
          snapshot={snapshot}
          members={members}
          busyId={busyId}
          mutate={mutate}
          refresh={refresh}
          setError={setError}
        />
      </section>
    </main>
  );
}

function NavItem({ icon, label, active, onClick }: { icon: React.ReactNode; label: Section; active: boolean; onClick: () => void }) {
  return <button className={active ? "nav-item active" : "nav-item"} onClick={onClick}>{icon}{label}</button>;
}

function SectionView({
  section,
  snapshot,
  members,
  busyId,
  mutate,
  refresh,
  setError
}: {
  section: Section;
  snapshot: DashboardSnapshot;
  members: TeamMember[];
  busyId: string | null;
  mutate: (action: () => Promise<void>, mailboxId?: string) => Promise<void>;
  refresh: () => Promise<void>;
  setError: (value: string | null) => void;
}) {
  if (section === "Team") return <TeamSection snapshot={snapshot} members={members} refresh={refresh} setError={setError} />;
  if (section === "Settings") return <SettingsSection snapshot={snapshot} refresh={refresh} setError={setError} />;
  if (section === "Map") return <MapSection snapshot={snapshot} />;
  if (section === "History") return <Panel title="History"><History snapshot={snapshot} limit={30} /></Panel>;
  if (section === "Mailboxes") return <MailboxSection snapshot={snapshot} busyId={busyId} mutate={mutate} />;
  return <OverviewSection snapshot={snapshot} busyId={busyId} mutate={mutate} />;
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

function OverviewSection({ snapshot, busyId, mutate }: { snapshot: DashboardSnapshot; busyId: string | null; mutate: (action: () => Promise<void>, mailboxId?: string) => Promise<void> }) {
  const waitingBoxes = snapshot.postOffices.flatMap((office) => office.mailboxes.filter((box) => box.mailWaiting));
  return (
    <div className="layout-grid">
      <MailboxSection snapshot={snapshot} busyId={busyId} mutate={mutate} compact />
      <aside className="side-panels">
        <MapSummary snapshot={snapshot} />
        <Panel title="History"><History snapshot={snapshot} limit={8} /></Panel>
        <Panel title="Team"><p className="small">Signed in as {snapshot.currentUser.displayName} ({snapshot.currentUser.role}). Server authorization applies to every request.</p></Panel>
      </aside>
      {waitingBoxes.length === 0 && <div className="empty-state"><Check size={22} />No mailboxes currently need checking.</div>}
    </div>
  );
}

function MailboxSection({ snapshot, busyId, mutate, compact = false }: { snapshot: DashboardSnapshot; busyId: string | null; compact?: boolean; mutate: (action: () => Promise<void>, mailboxId?: string) => Promise<void> }) {
  return (
    <Panel title={compact ? "Overview" : "Mailboxes"} aside={new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}>
      <div className="office-list">
        {snapshot.postOffices.map((office) => (
          <article className="office" key={office.id}>
            <div className="office-title">
              <div>
                <h3>{office.name}</h3>
                <p>{office.address}</p>
              </div>
              <a href={mapUrl(office.latitude, office.longitude)} target="_blank" rel="noreferrer">Directions</a>
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
    </Panel>
  );
}

function MapSummary({ snapshot }: { snapshot: DashboardSnapshot }) {
  return (
    <Panel title="Map">
      {snapshot.postOffices.map((office) => {
        const waiting = office.mailboxes.filter((box) => box.mailWaiting).length;
        return (
          <a className="map-location" href={mapUrl(office.latitude, office.longitude)} target="_blank" rel="noreferrer" key={office.id}>
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
  return (
    <Panel title="Map">
      <div className="map-grid">
        {snapshot.postOffices.map((office) => (
          <article className="map-card" key={office.id}>
            <div>
              <h3>{office.name}</h3>
              <p>{office.address}</p>
              <span>{office.geofenceRadius}m geofence radius</span>
            </div>
            <a className="primary map-button" href={mapUrl(office.latitude, office.longitude)} target="_blank" rel="noreferrer"><MapPin size={17} />Open Map</a>
          </article>
        ))}
      </div>
    </Panel>
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

  return (
    <div className="admin-grid">
      <Panel title="Team">
        <div className="team-list">
          {members.map((member) => (
            <div className="team-member" key={member.id}>
              <strong>{member.displayName}</strong>
              <span>{member.email}</span>
              <small>{member.role} - {member.status} - {member.active ? "Active" : "Disabled"}</small>
            </div>
          ))}
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
    </div>
  );
}

function SettingsSection({ snapshot, refresh, setError }: { snapshot: DashboardSnapshot; refresh: () => Promise<void>; setError: (value: string | null) => void }) {
  return (
    <div className="admin-grid">
      <AddPostOfficeForm snapshot={snapshot} refresh={refresh} setError={setError} />
      <AddMailboxForm snapshot={snapshot} refresh={refresh} setError={setError} />
      <Panel title="Security Roadmap">
        <div className="security-list">
          <span><KeyRound size={17} />Passkeys: schema exists, WebAuthn ceremony still to build.</span>
          <span><Shield size={17} />2FA: next step is TOTP setup, recovery codes, and login challenge flow.</span>
        </div>
      </Panel>
    </div>
  );
}

function AddPostOfficeForm({ snapshot, refresh, setError }: { snapshot: DashboardSnapshot; refresh: () => Promise<void>; setError: (value: string | null) => void }) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [geofenceRadius, setGeofenceRadius] = useState("200");

  if (snapshot.currentUser.role !== "ADMIN") return null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    try {
      await createPostOffice({ name, address, latitude: Number(latitude), longitude: Number(longitude), geofenceRadius: Number(geofenceRadius) });
      setName("");
      setAddress("");
      setLatitude("");
      setLongitude("");
      setGeofenceRadius("200");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create post office.");
    }
  }

  return (
    <Panel title="Add Post Office">
      <form className="form-grid" onSubmit={submit}>
        <label>Name<input value={name} onChange={(event) => setName(event.target.value)} required /></label>
        <label>Address<input value={address} onChange={(event) => setAddress(event.target.value)} required /></label>
        <label>Latitude<input type="number" step="any" value={latitude} onChange={(event) => setLatitude(event.target.value)} required /></label>
        <label>Longitude<input type="number" step="any" value={longitude} onChange={(event) => setLongitude(event.target.value)} required /></label>
        <label>Geofence radius<input type="number" min="25" max="5000" value={geofenceRadius} onChange={(event) => setGeofenceRadius(event.target.value)} required /></label>
        <button className="primary"><Plus size={17} />Create Post Office</button>
      </form>
    </Panel>
  );
}

function AddMailboxForm({ snapshot, refresh, setError }: { snapshot: DashboardSnapshot; refresh: () => Promise<void>; setError: (value: string | null) => void }) {
  const [postOfficeId, setPostOfficeId] = useState(snapshot.postOffices[0]?.id ?? "");
  const [name, setName] = useState("");
  const [boxNumber, setBoxNumber] = useState("");

  if (snapshot.currentUser.role !== "ADMIN") return null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    try {
      await createMailbox({ postOfficeId, name, boxNumber });
      setName("");
      setBoxNumber("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create mailbox.");
    }
  }

  return (
    <Panel title="Add PO Box">
      <form className="form-grid" onSubmit={submit}>
        <label>Post office<select value={postOfficeId} onChange={(event) => setPostOfficeId(event.target.value)}>{snapshot.postOffices.map((office) => <option value={office.id} key={office.id}>{office.name}</option>)}</select></label>
        <label>Name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="PO Box 1234" required /></label>
        <label>Box number<input value={boxNumber} onChange={(event) => setBoxNumber(event.target.value)} required /></label>
        <button className="primary"><Plus size={17} />Create PO Box</button>
      </form>
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

function History({ snapshot, limit }: { snapshot: DashboardSnapshot; limit: number }) {
  const userNames = useMemo(() => new Map([[snapshot.currentUser.id, snapshot.currentUser.displayName]]), [snapshot.currentUser]);
  return (
    <div className="history">
      {snapshot.history.slice(0, limit).map((event) => {
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

function mapUrl(latitude: number, longitude: number) {
  return `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
}

createRoot(document.getElementById("root")!).render(<App />);
