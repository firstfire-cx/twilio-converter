// src/components/AwsAuthModal.tsx
//
// Modal that walks the user through AWS credential acquisition.
// Supports two paths selectable via tabs:
//   SSO   — OIDC device flow (same as `aws sso login`)
//   Keys  — manual access key / secret / session token entry
import { useState } from "react";
import type { UseAwsCredentialsReturn } from "../hooks/useAwsCredentials";

interface Props {
  auth: UseAwsCredentialsReturn;
  onClose: () => void;
}

// Reused style tokens
const MONO: React.CSSProperties = { fontFamily: "'IBM Plex Mono', monospace" };
const INPUT: React.CSSProperties = {
  width: "100%", boxSizing: "border-box",
  background: "var(--bg-0)", border: "1px solid var(--border)",
  borderRadius: "var(--radius)", color: "var(--text-0)",
  ...MONO, fontSize: 12, padding: "6px 10px", outline: "none",
};
const LABEL: React.CSSProperties = {
  fontSize: 10, color: "var(--text-2)", fontWeight: 500,
  marginBottom: 4, display: "block",
  fontFamily: "'IBM Plex Sans', sans-serif",
};
const INFO_BOX = (color: string, bg: string, border: string): React.CSSProperties => ({
  fontSize: 11, color, lineHeight: 1.6, background: bg,
  borderRadius: "var(--radius)", padding: "10px 12px", border: `1px solid ${border}`,
});

// ---------------------------------------------------------------------------
// Sub-panels
// ---------------------------------------------------------------------------

function SsoPanel({ auth }: { auth: UseAwsCredentialsReturn }) {
  const [startUrl, setStartUrl] = useState("");
  const [ssoRegion, setSsoRegion] = useState("us-east-1");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // For account/role selection
  const [selAccount, setSelAccount] = useState("");
  const [selRole, setSelRole] = useState("");
  const [selRegion, setSelRegion] = useState("us-east-1");

  const { authStep, ssoDeviceState, ssoAccounts, startSso, selectSsoRole, cancelSso } = auth;

  // ── Step: enter URL ────────────────────────────────────────────────────────
  if (authStep === "sso-url" || authStep === "idle" || authStep === "manual") {
    const handleStart = async () => {
      if (!startUrl) { setErr("Enter your SSO start URL"); return; }
      setBusy(true); setErr("");
      try { await startSso(startUrl.trim(), ssoRegion); }
      catch (e: any) { setErr(e.message ?? "Failed to start SSO"); }
      finally { setBusy(false); }
    };

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={INFO_BOX("var(--text-2)", "var(--bg-0)", "var(--border)")}>
          Enter your AWS SSO start URL — the same one you use for{" "}
          <code style={{ ...MONO, fontSize: 10, color: "var(--cyan)" }}>aws sso login</code>.
          A browser tab will open for you to approve the login.
        </div>

        <div>
          <label style={LABEL}>SSO Start URL</label>
          <input style={INPUT} value={startUrl} onChange={(e) => setStartUrl(e.target.value)}
            placeholder="https://your-org.awsapps.com/start" spellCheck={false}
            onKeyDown={(e) => e.key === "Enter" && handleStart()} />
        </div>
        <div>
          <label style={LABEL}>SSO Region</label>
          <input style={INPUT} value={ssoRegion} onChange={(e) => setSsoRegion(e.target.value)}
            placeholder="us-east-1" spellCheck={false} />
        </div>

        {err && <div style={{ fontSize: 11, color: "var(--red)", ...MONO }}>{err}</div>}

        <button className="btn btn-primary" onClick={handleStart} disabled={busy}
          style={{ alignSelf: "flex-end" }}>
          {busy ? "Connecting…" : "Open Login Page →"}
        </button>
      </div>
    );
  }

  // ── Step: waiting for approval ─────────────────────────────────────────────
  if (authStep === "sso-pending") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={INFO_BOX("var(--text-1)", "var(--bg-0)", "var(--border)")}>
          A browser tab has opened. Approve the login request, then return here.
          {ssoDeviceState && (
            <>
              {" "}If the tab didn't open,{" "}
              <a href={ssoDeviceState.verificationUriComplete} target="_blank" rel="noopener noreferrer"
                style={{ color: "var(--accent)" }}>click here</a>.
            </>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "center", padding: "16px 0" }}>
          {ssoDeviceState ? (
            <>
              <div style={{ fontSize: 10, color: "var(--text-2)", ...MONO }}>Confirmation code</div>
              <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: "0.25em", color: "var(--text-0)", ...MONO }}>
                {ssoDeviceState.userCode}
              </div>
            </>
          ) : (
            <div style={{ fontSize: 11, color: "var(--text-3)", ...MONO }}>Opening browser…</div>
          )}
          <div style={{ fontSize: 10, color: "var(--text-3)", ...MONO }}>
            Waiting for approval…
            <span style={{ display: "inline-block", marginLeft: 6, animation: "spin 1s linear infinite" }}>⟳</span>
          </div>
        </div>

        <button className="btn" onClick={cancelSso} style={{ alignSelf: "flex-end" }}>
          Cancel
        </button>
      </div>
    );
  }

  // ── Step: pick account + role ──────────────────────────────────────────────
  if (authStep === "sso-select" && ssoAccounts.length > 0) {
    // Flatten to account→role pairs
    const pairs: { accountId: string; accountName: string; role: string }[] = [];
    for (const a of ssoAccounts) {
      for (const r of a.roles) pairs.push({ accountId: a.accountId, accountName: a.accountName, role: r });
    }

    const handleSelect = async () => {
      if (!selAccount || !selRole) return;
      await selectSsoRole(selAccount, selRole, selRegion);
    };

    // Pre-select first option
    if (!selAccount && pairs.length > 0) {
      setSelAccount(pairs[0].accountId);
      setSelRole(pairs[0].role);
    }

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={INFO_BOX("var(--green)", "rgba(61,186,126,0.06)", "rgba(61,186,126,0.2)")}>
          ✓ Login approved. Choose the account and role to use for DynamoDB writes.
        </div>

        <div>
          <label style={LABEL}>Account / Role</label>
          <select style={{ ...INPUT, cursor: "pointer" }}
            value={`${selAccount}||${selRole}`}
            onChange={(e) => {
              const [a, r] = e.target.value.split("||");
              setSelAccount(a); setSelRole(r);
            }}>
            {pairs.map((p) => (
              <option key={`${p.accountId}||${p.role}`} value={`${p.accountId}||${p.role}`}>
                {p.accountName} ({p.accountId}) — {p.role}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label style={LABEL}>Target Region (for DynamoDB)</label>
          <input style={INPUT} value={selRegion} onChange={(e) => setSelRegion(e.target.value)}
            placeholder="us-east-1" spellCheck={false} />
        </div>

        <button className="btn btn-primary" onClick={handleSelect} style={{ alignSelf: "flex-end" }}>
          Use These Credentials →
        </button>
      </div>
    );
  }

  return null;
}

function ManualPanel({ auth }: { auth: UseAwsCredentialsReturn }) {
  const [form, setForm] = useState({
    region: "us-east-1",
    accessKeyId: "",
    secretAccessKey: "",
    sessionToken: "",
    endpoint: "",
    instance_id: "",
  });
  const [err, setErr] = useState("");

  const fields: { key: keyof typeof form; label: string; placeholder: string; type: string }[] = [
    { key: "region", label: "Region", placeholder: "us-east-1", type: "text" },
    { key: "accessKeyId", label: "Access Key ID", placeholder: "AKIA…", type: "text" },
    { key: "secretAccessKey", label: "Secret Access Key", placeholder: "••••••••", type: "password" },
    { key: "sessionToken", label: "Session Token (opt.)", placeholder: "For STS / SSO sessions", type: "password" },
    { key: "instance_id", label: "Connect Instance ID (opt.)", placeholder: "abc12345-…", type: "text" },
    { key: "endpoint", label: "Custom DDB Endpoint (opt.)", placeholder: "http://localhost:8000", type: "text" },
  ];

  const handleSave = () => {
    if (!form.accessKeyId || !form.secretAccessKey) {
      setErr("Access Key ID and Secret Access Key are required"); return;
    }
    auth.setManual({
      region: form.region || "us-east-1",
      accessKeyId: form.accessKeyId,
      secretAccessKey: form.secretAccessKey,
      sessionToken: form.sessionToken || undefined,
      endpoint: form.endpoint || undefined,
      instance_id: form.instance_id || undefined,
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={INFO_BOX("var(--orange)", "rgba(232,149,90,0.06)", "rgba(232,149,90,0.2)")}>
        ⚠ Credentials go directly to AWS — they never touch a backend server.
        Prefer SSO or short-lived STS tokens over long-lived keys.
      </div>

      {fields.map(({ key, label, placeholder, type }) => (
        <div key={key}>
          <label style={LABEL}>{label}</label>
          <input style={INPUT} type={type} value={form[key]}
            onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
            placeholder={placeholder} autoComplete="off" spellCheck={false} />
        </div>
      ))}

      {err && <div style={{ fontSize: 11, color: "var(--red)", ...MONO }}>{err}</div>}

      <button className="btn btn-primary" onClick={handleSave} style={{ alignSelf: "flex-end" }}>
        Save Credentials →
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main modal
// ---------------------------------------------------------------------------

export default function AwsAuthModal({ auth, onClose }: Props) {
  // Show SSO tab first unless we're already in the manual flow
  const defaultTab = auth.authStep === "manual" ? "manual" : "sso";
  const [tab, setTab] = useState<"sso" | "manual">(defaultTab);

  const isPolling = auth.authStep === "sso-pending" || auth.authStep === "sso-select";

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 300,
      display: "flex", alignItems: "center", justifyContent: "center"
    }}>
      <div style={{
        background: "var(--bg-2)", border: "1px solid var(--border-hi)",
        borderRadius: "var(--radius-lg)", width: 480, maxHeight: "85vh",
        display: "flex", flexDirection: "column", overflow: "hidden",
        boxShadow: "0 24px 48px rgba(0,0,0,0.6)"
      }}>

        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "12px 16px", borderBottom: "1px solid var(--border)", background: "var(--bg-3)"
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {/* AWS-ish icon */}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M6.5 16.5C4 15.3 2 12.8 2 10c0-4.4 3.6-8 8-8 2.5 0 4.7 1.1 6.2 2.9"
                stroke="var(--orange)" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M17.5 7.5C20 8.7 22 11.2 22 14c0 4.4-3.6 8-8 8-2.5 0-4.7-1.1-6.2-2.9"
                stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M5 19l2-2-2-2M19 5l-2 2 2 2" stroke="var(--text-2)" strokeWidth="1.5"
                strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span style={{ fontSize: 13, color: "var(--text-0)", fontWeight: 600 }}>
              Connect to AWS
            </span>
          </div>
          {!isPolling && (
            <button className="btn btn-ghost" onClick={onClose}
              style={{ padding: "2px 6px", height: 22, fontSize: 14 }}>×</button>
          )}
        </div>

        {/* Tabs — hidden while polling (can't switch mid-flow) */}
        {!isPolling && (
          <div style={{ display: "flex", borderBottom: "1px solid var(--border)", background: "var(--bg-3)" }}>
            {(["sso", "manual"] as const).map((t) => (
              <button key={t} onClick={() => { setTab(t); if (t !== "sso") auth.cancelSso(); }}
                style={{
                  padding: "8px 16px", fontSize: 11, fontWeight: 500, background: "transparent",
                  border: "none", borderBottom: tab === t ? "2px solid var(--accent)" : "2px solid transparent",
                  color: tab === t ? "var(--accent)" : "var(--text-2)", cursor: "pointer",
                  ...MONO, letterSpacing: "0.05em", textTransform: "uppercase"
                }}>
                {t === "sso" ? "SSO / Identity Center" : "Access Keys"}
              </button>
            ))}
          </div>
        )}

        {/* Content */}
        <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
          {tab === "sso" ? <SsoPanel auth={auth} /> : null}
          {tab === "manual" ? <ManualPanel auth={auth} /> : null}
          {/* Render SSO panel even when tab isn't "sso" if we're mid-flow */}
          {isPolling && tab !== "sso" ? <SsoPanel auth={auth} /> : null}
        </div>
      </div>
    </div>
  );
}