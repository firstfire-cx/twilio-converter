// src/hooks/useAwsCredentials.ts
//
// Manages AWS credential acquisition for the IVR editor.
// Three modes, tried in order:
//   1. SSO (OIDC device flow) — same protocol as `aws sso login`
//   2. Manual key entry        — access key / secret / session token
//
// Resolved credentials are cached in sessionStorage so the user does not
// have to re-authenticate on every upload within the same browser session.
//
// Required packages (add once):
//   npm install @aws-sdk/client-sso-oidc @aws-sdk/client-sso \
//               @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb

import { useState, useCallback } from "react";
import {
  SSOOIDCClient,
  RegisterClientCommand,
  StartDeviceAuthorizationCommand,
  CreateTokenCommand,
  type CreateTokenCommandOutput,
} from "@aws-sdk/client-sso-oidc";
import {
  SSOClient,
  GetRoleCredentialsCommand,
  ListAccountRolesCommand,
  ListAccountsCommand,
} from "@aws-sdk/client-sso";

// ---------------------------------------------------------------------------
// Credential shape
// ---------------------------------------------------------------------------

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
  region: string;
  endpoint?: string; // for LocalStack / DynamoDB local
  source: "sso" | "manual";
  identity?: string; // display name shown in UI (SSO account/role)
  instance_id?: string; // Amazon Connect instance ID (used by SkillsPanel)
}

// Serialisable form stored in sessionStorage (Date as ISO string)
interface StoredCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expirationIso?: string;
  region: string;
  endpoint?: string;
  source: "sso" | "manual";
  identity?: string;
}

// ---------------------------------------------------------------------------
// SSO intermediate state
// ---------------------------------------------------------------------------

export interface SsoDeviceCodeState {
  verificationUriComplete: string; // open in new tab
  userCode: string; // show to user as confirmation
  deviceCode: string; // used internally when polling
  clientId: string;
  clientSecret: string;
  expiresAt: number; // ms epoch
  ssoStartUrl: string;
  ssoRegion: string;
}

export interface SsoAccount {
  accountId: string;
  accountName: string;
  roles: string[];
}

// ---------------------------------------------------------------------------
// localStorage helpers (with 1-hour expiry)
// ---------------------------------------------------------------------------

const STORAGE_KEY = "ivr_aws_credentials";
const EXPIRY_KEY = "ivr_aws_credentials_expiry";
const EXPIRY_DURATION_MS = 3600000; // 1 hour

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
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    localStorage.setItem(EXPIRY_KEY, String(Date.now() + EXPIRY_DURATION_MS));
  } catch {
    /* ignore */
  }
}

function loadFromStorage(): AwsCredentials | null {
  try {
    // Check custom expiry first
    const expiryStr = localStorage.getItem(EXPIRY_KEY);
    if (expiryStr && Date.now() > parseInt(expiryStr, 10)) {
      // Expired - clear storage
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(EXPIRY_KEY);
      return null;
    }

    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const stored: StoredCredentials = JSON.parse(raw);
    const expiration = stored.expirationIso
      ? new Date(stored.expirationIso)
      : undefined;
    // Discard if credential expiration is within 5 minutes
    if (expiration && expiration.getTime() - Date.now() < 5 * 60 * 1000) {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(EXPIRY_KEY);
      return null;
    }
    return {
      accessKeyId: stored.accessKeyId,
      secretAccessKey: stored.secretAccessKey,
      sessionToken: stored.sessionToken,
      expiration,
      region: stored.region,
      endpoint: stored.endpoint,
      source: stored.source,
      identity: stored.identity,
    };
  } catch {
    return null;
  }
}

function clearStorage(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(EXPIRY_KEY);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// SSO OIDC helpers (exported so tests can call them directly)
// ---------------------------------------------------------------------------

const SSO_CLIENT_NAME = "ivr-flow-editor";
const SSO_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const POLL_INTERVAL_MS = 5_000;

export async function startSsoDeviceFlow(
  ssoStartUrl: string,
  ssoRegion: string,
): Promise<SsoDeviceCodeState> {
  const oidc = new SSOOIDCClient({ region: ssoRegion });

  const regResp = await oidc.send(
    new RegisterClientCommand({
      clientName: SSO_CLIENT_NAME,
      clientType: "public",
    }),
  );

  const authResp = await oidc.send(
    new StartDeviceAuthorizationCommand({
      clientId: regResp.clientId!,
      clientSecret: regResp.clientSecret!,
      startUrl: ssoStartUrl,
    }),
  );

  return {
    verificationUriComplete: authResp.verificationUriComplete!,
    userCode: authResp.userCode!,
    deviceCode: authResp.deviceCode!,
    clientId: regResp.clientId!,
    clientSecret: regResp.clientSecret!,
    expiresAt: Date.now() + (authResp.expiresIn ?? 600) * 1000,
    ssoStartUrl,
    ssoRegion,
  };
}

export async function pollForSsoToken(
  state: SsoDeviceCodeState,
  signal?: AbortSignal,
): Promise<CreateTokenCommandOutput> {
  const oidc = new SSOOIDCClient({ region: state.ssoRegion });

  while (true) {
    if (signal?.aborted) throw new Error("Login cancelled");
    if (Date.now() > state.expiresAt)
      throw new Error("Device code expired — please try again");

    await new Promise<void>((res) => setTimeout(res, POLL_INTERVAL_MS));
    if (signal?.aborted) throw new Error("Login cancelled");

    try {
      return await oidc.send(
        new CreateTokenCommand({
          clientId: state.clientId,
          clientSecret: state.clientSecret,
          grantType: SSO_GRANT_TYPE,
          deviceCode: state.deviceCode,
        }),
      );
    } catch (err: any) {
      const code = err?.name ?? "";
      if (code === "AuthorizationPendingException") continue;
      if (code === "SlowDownException") {
        await new Promise<void>((res) => setTimeout(res, POLL_INTERVAL_MS * 2));
        continue;
      }
      throw err;
    }
  }
}

export async function listSsoAccountsAndRoles(
  accessToken: string,
  ssoRegion: string,
): Promise<SsoAccount[]> {
  const sso = new SSOClient({ region: ssoRegion });
  const accounts = await sso.send(
    new ListAccountsCommand({ accessToken, maxResults: 50 }),
  );
  const result: SsoAccount[] = [];

  for (const acct of accounts.accountList ?? []) {
    const rolesResp = await sso.send(
      new ListAccountRolesCommand({
        accessToken,
        accountId: acct.accountId!,
        maxResults: 20,
      }),
    );
    result.push({
      accountId: acct.accountId!,
      accountName: acct.accountName ?? acct.accountId!,
      roles: (rolesResp.roleList ?? []).map((r) => r.roleName!).filter(Boolean),
    });
  }
  return result;
}

export async function getSsoRoleCredentials(
  accessToken: string,
  accountId: string,
  roleName: string,
  ssoRegion: string,
  targetRegion: string,
): Promise<AwsCredentials> {
  const sso = new SSOClient({ region: ssoRegion });
  const resp = await sso.send(
    new GetRoleCredentialsCommand({ accessToken, accountId, roleName }),
  );
  const rc = resp.roleCredentials!;
  return {
    accessKeyId: rc.accessKeyId!,
    secretAccessKey: rc.secretAccessKey!,
    sessionToken: rc.sessionToken,
    expiration: rc.expiration ? new Date(rc.expiration) : undefined,
    region: targetRegion,
    source: "sso",
    identity: `${accountId} / ${roleName}`,
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export type AuthStep =
  | "idle" // no creds, not trying
  | "sso-url" // waiting for SSO start URL entry
  | "sso-pending" // device code shown, polling for approval
  | "sso-select" // token received, user picks account/role
  | "manual" // user entering keys manually
  | "ready"; // credentials resolved

export interface UseAwsCredentialsReturn {
  credentials: AwsCredentials | null;
  authStep: AuthStep;
  startSso: (startUrl: string, region: string) => Promise<void>;
  setManual: (creds: Omit<AwsCredentials, "source">) => void;
  logout: () => void;
  setAuthStep: (step: AuthStep) => void;
  ssoDeviceState: SsoDeviceCodeState | null;
  ssoToken: string | null;
  ssoAccounts: SsoAccount[];
  selectSsoRole: (
    accountId: string,
    roleName: string,
    region: string,
  ) => Promise<void>;
  cancelSso: () => void;
}

export function useAwsCredentials(): UseAwsCredentialsReturn {
  const [credentials, setCredentials] = useState<AwsCredentials | null>(() =>
    loadFromStorage(),
  );
  const [authStep, setAuthStep] = useState<AuthStep>(() =>
    loadFromStorage() ? "ready" : "idle",
  );
  const [ssoDeviceState, setSsoDeviceState] =
    useState<SsoDeviceCodeState | null>(null);
  const [ssoToken, setSsoToken] = useState<string | null>(null);
  const [ssoAccounts, setSsoAccounts] = useState<SsoAccount[]>([]);
  const [abortCtrl, setAbortCtrl] = useState<AbortController | null>(null);

  function applyCredentials(creds: AwsCredentials) {
    saveToStorage(creds);
    setCredentials(creds);
    setAuthStep("ready");
    setSsoDeviceState(null);
    setSsoToken(null);
    setSsoAccounts([]);
    setAbortCtrl(null);
  }

  const startSso = useCallback(async (startUrl: string, ssoRegion: string) => {
    setAuthStep("sso-pending");
    const deviceState = await startSsoDeviceFlow(startUrl, ssoRegion);
    setSsoDeviceState(deviceState);

    window.open(
      deviceState.verificationUriComplete,
      "_blank",
      "noopener,noreferrer",
    );

    const ctrl = new AbortController();
    setAbortCtrl(ctrl);

    pollForSsoToken(deviceState, ctrl.signal)
      .then(async (tokenResp) => {
        const token = tokenResp.accessToken!;
        setSsoToken(token);
        const accounts = await listSsoAccountsAndRoles(token, ssoRegion);
        setSsoAccounts(accounts);

        // Auto-select if there is only one option
        if (accounts.length === 1 && accounts[0].roles.length === 1) {
          const a = accounts[0];
          const creds = await getSsoRoleCredentials(
            token,
            a.accountId,
            a.roles[0],
            ssoRegion,
            ssoRegion,
          );
          applyCredentials(creds);
        } else {
          setAuthStep("sso-select");
        }
      })
      .catch((err: Error) => {
        if (err.message !== "Login cancelled")
          console.error("SSO polling failed:", err);
        setAuthStep("sso-url");
      });
  }, []);

  const selectSsoRole = useCallback(
    async (accountId: string, roleName: string, region: string) => {
      if (!ssoToken || !ssoDeviceState) return;
      const creds = await getSsoRoleCredentials(
        ssoToken,
        accountId,
        roleName,
        ssoDeviceState.ssoRegion,
        region,
      );
      applyCredentials(creds);
    },
    [ssoToken, ssoDeviceState],
  );

  const cancelSso = useCallback(() => {
    abortCtrl?.abort();
    setAbortCtrl(null);
    setSsoDeviceState(null);
    setSsoToken(null);
    setSsoAccounts([]);
  }, [abortCtrl]);

  const setManual = useCallback((base: Omit<AwsCredentials, "source">) => {
    applyCredentials({ ...base, source: "manual" });
  }, []);

  const logout = useCallback(() => {
    clearStorage();
    setCredentials(null);
    setAuthStep("idle");
    cancelSso();
  }, [cancelSso]);

  return {
    credentials,
    authStep,
    startSso,
    setManual,
    logout,
    setAuthStep,
    ssoDeviceState,
    ssoToken,
    ssoAccounts,
    selectSsoRole,
    cancelSso,
  };
}
