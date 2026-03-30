// src/hooks/useAwsCredentials.ts
import { useState, useCallback } from "react";
import {
  ConnectClient,
  ListInstancesCommand,
  type InstanceSummary,
} from "@aws-sdk/client-connect";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
  region: string;
  endpoint?: string;
  source: "sso" | "manual";
  identity?: string;
  instance_id?: string;
}

export interface ConnectInstance {
  id: string;
  arn: string;
  alias: string;
  status: string;
}

interface StoredCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expirationIso?: string;
  region: string;
  endpoint?: string;
  source: "sso" | "manual";
  identity?: string;
  instance_id?: string;
}

export interface SsoAccount {
  accountId: string;
  accountName: string;
  roles: string[];
}

export type AuthStep =
  | "idle"
  | "sso-url"
  | "sso-pending"
  | "sso-select"
  | "manual"
  | "ready";

const STORAGE_KEY = "ivr_aws_credentials";
const EXPIRY_KEY = "ivr_aws_credentials_expiry";
const EXPIRY_DURATION_MS = 3600000;

function saveToStorage(creds: AwsCredentials): void {
  const stored: StoredCredentials = {
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
    expirationIso: creds.expiration?.toISOString(),
    region: creds.region,
    endpoint: creds.endpoint,
    source: creds.source,
    identity: creds.identity,
    instance_id: creds.instance_id,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  localStorage.setItem(EXPIRY_KEY, String(Date.now() + EXPIRY_DURATION_MS));
}

function loadFromStorage(): AwsCredentials | null {
  try {
    const expiryStr = localStorage.getItem(EXPIRY_KEY);
    if (expiryStr && Date.now() > parseInt(expiryStr, 10)) {
      localStorage.clear();
      return null;
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const stored: StoredCredentials = JSON.parse(raw);
    return {
      accessKeyId: stored.accessKeyId,
      secretAccessKey: stored.secretAccessKey,
      sessionToken: stored.sessionToken,
      expiration: stored.expirationIso ? new Date(stored.expirationIso) : undefined,
      region: stored.region,
      endpoint: stored.endpoint,
      source: stored.source,
      identity: stored.identity,
      instance_id: stored.instance_id,
    };
  } catch {
    return null;
  }
}

function clearStorage(): void {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(EXPIRY_KEY);
}

function buildConnectClient(creds: AwsCredentials): ConnectClient {
  return new ConnectClient({
    region: creds.region || "us-east-1",
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
    },
  });
}

export interface UseAwsCredentialsReturn {
  credentials: AwsCredentials | null;
  authStep: AuthStep;
  instances: ConnectInstance[];
  instancesLoading: boolean;
  startSso: (startUrl: string, region: string) => Promise<void>;
  setManual: (base: Omit<AwsCredentials, "source">) => void;
  logout: () => void;
  setAuthStep: (step: AuthStep) => void;
  ssoDeviceState: { verificationUriComplete: string; userCode: string } | null;
  ssoToken: string | null;
  ssoAccounts: SsoAccount[];
  selectSsoRole: (accountId: string, roleName: string, region: string) => Promise<void>;
  cancelSso: () => void;
  fetchInstances: () => Promise<void>;
}

export function useAwsCredentials(): UseAwsCredentialsReturn {
  const [credentials, setCredentials] = useState<AwsCredentials | null>(loadFromStorage);
  const [authStep, setAuthStep] = useState<AuthStep>(() =>
    loadFromStorage() ? "ready" : "idle"
  );
  const [instances, setInstances] = useState<ConnectInstance[]>([]);
  const [instancesLoading, setInstancesLoading] = useState(false);

  const [ssoSessionId, setSsoSessionId] = useState<string | null>(null);
  const [ssoRegion, setSsoRegion] = useState("");
  const [ssoToken, setSsoToken] = useState<string | null>(null);
  const [ssoAccounts, setSsoAccounts] = useState<SsoAccount[]>([]);
  const [ssoDeviceState, setSsoDeviceState] = useState<{
    verificationUriComplete: string;
    userCode: string;
  } | null>(null);
  const [abortCtrl, setAbortCtrl] = useState<AbortController | null>(null);

  // ── Fetch Connect instances ──────────────────────────────────────────────

  const fetchInstances = useCallback(async (creds?: AwsCredentials) => {
    const c = creds ?? credentials;
    if (!c) return;
    setInstancesLoading(true);
    try {
      const client = buildConnectClient(c);
      const all: InstanceSummary[] = [];
      let nextToken: string | undefined;
      do {
        const resp = await client.send(
          new ListInstancesCommand({ MaxResults: 10, ...(nextToken ? { NextToken: nextToken } : {}) })
        );
        all.push(...(resp.InstanceSummaryList ?? []));
        nextToken = resp.NextToken;
      } while (nextToken);

      setInstances(
        all
          .filter(i => i.InstanceStatus === "ACTIVE")
          .map(i => ({
            id: i.Id ?? "",
            arn: i.Arn ?? "",
            alias: i.InstanceAlias ?? i.Id ?? "Unknown",
            status: i.InstanceStatus ?? "",
          }))
      );
    } catch (e) {
      console.warn("[useAwsCredentials] ListInstances failed:", e);
      setInstances([]);
    } finally {
      setInstancesLoading(false);
    }
  }, [credentials]);

  // ── Apply & persist credentials ──────────────────────────────────────────

  function applyCredentials(creds: AwsCredentials) {
    saveToStorage(creds);
    setCredentials(creds);
    setAuthStep("ready");
    setSsoToken(null);
    setSsoAccounts([]);
    setSsoDeviceState(null);
    setAbortCtrl(null);
    // Fetch instances automatically after auth
    fetchInstances(creds);
  }

  // ── SSO flow ─────────────────────────────────────────────────────────────

  const startSso = useCallback(async (startUrl: string, region: string) => {
    setAuthStep("sso-pending");
    setSsoRegion(region);

    const res = await fetch("/api/aws/sso/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ startUrl, region }),
    });
    const data = await res.json();
    setSsoSessionId(data.sessionId);
    setSsoDeviceState({
      verificationUriComplete: data.verificationUriComplete,
      userCode: data.userCode,
    });
    window.open(data.verificationUriComplete, "_blank");

    const ctrl = new AbortController();
    setAbortCtrl(ctrl);

    (async () => {
      try {
        while (true) {
          if (ctrl.signal.aborted) throw new Error("cancelled");
          await new Promise(r => setTimeout(r, 5000));

          const pollRes = await fetch(`/api/aws/sso/poll/${data.sessionId}`);
          const pollData = await pollRes.json();

          if (pollData.status === "done") {
            const token = pollData.tokens.accessToken ?? pollData.tokens.access_token;
            setSsoToken(token);

            const acctRes = await fetch("/api/aws/sso/accounts", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ accessToken: token, region }),
            });
            const accounts = await acctRes.json();
            setSsoAccounts(accounts);

            if (accounts.length === 1 && accounts[0].roles.length === 1) {
              const a = accounts[0];
              const credRes = await fetch("/api/aws/sso/credentials", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ accessToken: token, region, accountId: a.accountId, roleName: a.roles[0] }),
              });
              const rc = await credRes.json();
              applyCredentials({
                accessKeyId: rc.accessKeyId,
                secretAccessKey: rc.secretAccessKey,
                sessionToken: rc.sessionToken,
                expiration: rc.expiration ? new Date(rc.expiration) : undefined,
                region,
                source: "sso",
                identity: `${a.accountId} / ${a.roles[0]}`,
              });
            } else {
              setAuthStep("sso-select");
            }
            return;
          }
        }
      } catch {
        setAuthStep("sso-url");
        setSsoDeviceState(null);
      }
    })();
  }, []);

  const selectSsoRole = useCallback(async (accountId: string, roleName: string, region: string) => {
    if (!ssoToken) return;
    const res = await fetch("/api/aws/sso/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken: ssoToken, region, accountId, roleName }),
    });
    const rc = await res.json();
    applyCredentials({
      accessKeyId: rc.accessKeyId,
      secretAccessKey: rc.secretAccessKey,
      sessionToken: rc.sessionToken,
      expiration: rc.expiration ? new Date(rc.expiration) : undefined,
      region,
      source: "sso",
      identity: `${accountId} / ${roleName}`,
    });
  }, [ssoToken]);

  const cancelSso = useCallback(() => {
    abortCtrl?.abort();
    setAbortCtrl(null);
    setSsoSessionId(null);
    setSsoToken(null);
    setSsoAccounts([]);
    setSsoDeviceState(null);
  }, [abortCtrl]);

  // ── Manual credentials ───────────────────────────────────────────────────

  const setManual = useCallback((base: Omit<AwsCredentials, "source">) => {
    applyCredentials({ ...base, source: "manual" });
  }, []);

  // ── Logout ───────────────────────────────────────────────────────────────

  const logout = useCallback(() => {
    clearStorage();
    setCredentials(null);
    setAuthStep("idle");
    setInstances([]);
    cancelSso();
  }, [cancelSso]);

  return {
    credentials,
    authStep,
    instances,
    instancesLoading,
    startSso,
    setManual,
    logout,
    setAuthStep,
    ssoDeviceState,
    ssoToken,
    ssoAccounts,
    selectSsoRole,
    cancelSso,
    fetchInstances,
  };
}
