import express from "express";
import fetch from "node-fetch";
import { v4 as uuidv4 } from "uuid";

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// In-memory session store — cleaned up after 10 minutes
// ---------------------------------------------------------------------------

interface SsoSession {
  region: string;
  client: { clientId: string; clientSecret: string };
  device: {
    deviceCode: string;
    verificationUriComplete: string;
    userCode: string;
    interval?: number;
  };
  status: "pending" | "done" | "error";
  tokens?: Record<string, unknown>;
  createdAt: number;
}

const sessions = new Map<string, SsoSession>();

// Prune sessions older than 10 minutes every 5 minutes
setInterval(
  () => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [id, session] of sessions) {
      if (session.createdAt < cutoff) sessions.delete(id);
    }
  },
  5 * 60 * 1000,
);

// ---------------------------------------------------------------------------
// Helper: throw a readable error for non-2xx AWS OIDC responses
// ---------------------------------------------------------------------------

async function checkOidcResponse(
  res: Awaited<ReturnType<typeof fetch>>,
  step: string,
) {
  if (!res.ok) {
    let body = "";
    try {
      body = await res.text();
    } catch {
      /* ignore */
    }
    throw new Error(`AWS OIDC ${step} failed (${res.status}): ${body}`);
  }
}

// ---------------------------------------------------------------------------
// POST /api/aws/sso/credentials
// ---------------------------------------------------------------------------

app.post("/api/aws/sso/credentials", async (req, res) => {
  try {
    const { accessToken, region, accountId, roleName } = req.body;

    const resp = await fetch(
      `https://portal.sso.${region}.amazonaws.com/federation/credentials?account_id=${accountId}&role_name=${roleName}`,
      {
        headers: {
          "x-amz-sso_bearer_token": accessToken,
        },
      }
    );

    const data = await resp.json();

    res.json(data.roleCredentials);
  } catch (e: any) {
    console.error("[SSO credentials]", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/aws/sso/accounts", async (req, res) => {
  try {
    const { accessToken, region } = req.body;

    const accountsRes = await fetch(
      `https://portal.sso.${region}.amazonaws.com/assignment/accounts`,
      {
        headers: {
          "x-amz-sso_bearer_token": accessToken,
        },
      },
    );

    const accounts = await accountsRes.json();

    const result = [];

    for (const acct of accounts.accountList ?? []) {
      const rolesRes = await fetch(
        `https://portal.sso.${region}.amazonaws.com/assignment/roles?account_id=${acct.accountId}`,
        {
          headers: {
            "x-amz-sso_bearer_token": accessToken,
          },
        },
      );

      const roles = await rolesRes.json();

      result.push({
        accountId: acct.accountId,
        accountName: acct.accountName,
        roles: (roles.roleList ?? []).map((r: any) => r.roleName),
      });
    }

    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/aws/sso/start
// ---------------------------------------------------------------------------

app.post("/api/aws/sso/start", async (req, res) => {
  try {
    const { startUrl, region } = req.body as {
      startUrl: string;
      region: string;
    };
    if (!startUrl || !region) {
      return res
        .status(400)
        .json({ error: "startUrl and region are required" });
    }

    // Step 1: register a public OIDC client
    const clientRes = await fetch(
      `https://oidc.${region}.amazonaws.com/client/register`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName: "ivr-flow-editor",
          clientType: "public",
        }),
      },
    );
    await checkOidcResponse(clientRes, "client/register");
    const client = (await clientRes.json()) as {
      clientId: string;
      clientSecret: string;
    };

    // Step 2: start device authorization
    const deviceRes = await fetch(
      `https://oidc.${region}.amazonaws.com/device_authorization`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: client.clientId,
          clientSecret: client.clientSecret,
          startUrl,
        }),
      },
    );
    await checkOidcResponse(deviceRes, "device_authorization");
    const device = (await deviceRes.json()) as {
      deviceCode: string;
      verificationUriComplete: string;
      userCode: string;
      interval?: number;
    };

    const sessionId = uuidv4();
    sessions.set(sessionId, {
      region,
      client,
      device,
      status: "pending",
      createdAt: Date.now(),
    });

    return res.json({
      sessionId,
      verificationUriComplete: device.verificationUriComplete,
      userCode: device.userCode,
    });
  } catch (err: any) {
    console.error("[SSO start]", err);
    return res.status(500).json({ error: err.message ?? "Internal error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/aws/sso/poll/:sessionId
// ---------------------------------------------------------------------------

app.get("/api/aws/sso/poll/:sessionId", async (req, res) => {
  try {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });

    if (session.status === "done") {
      return res.json({ status: "done", tokens: session.tokens });
    }

    const tokenRes = await fetch(
      `https://oidc.${session.region}.amazonaws.com/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grantType: "urn:ietf:params:oauth:grant-type:device_code",
          deviceCode: session.device.deviceCode,
          clientId: session.client.clientId,
          clientSecret: session.client.clientSecret,
        }),
      },
    );

    const data = (await tokenRes.json()) as Record<string, unknown>;

    // authorization_pending / slow_down are normal while user hasn't approved yet
    if (data.error) {
      if (
        data.error === "authorization_pending" ||
        data.error === "slow_down"
      ) {
        return res.json({ status: "pending" });
      }
      session.status = "error";
      return res.status(400).json({
        status: "error",
        error: data.error,
        error_description: data.error_description,
      });
    }

    if (data.accessToken) {
      session.status = "done";
      session.tokens = data;
      return res.json({ status: "done", tokens: data });
    }

    return res.json({ status: "pending" });
  } catch (err: any) {
    console.error("[SSO poll]", err);
    return res.status(500).json({ error: err.message ?? "Internal error" });
  }
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.listen(3001, () => console.log("Server running on :3001"));
