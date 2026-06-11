// src/stores/ddbStore.ts
//
// App-wide cache of the DynamoDB flow scan. The scan is expensive (full table
// scan + per-flow queries), so it runs once per login session and is shared by
// every view, rather than re-scanning each time the Account tab mounts.

import { create } from "zustand";
import type { AwsCredentials } from "../hooks/useAwsCredentials";
import { scanDdb, type DdbState } from "../utils/ddbScan";

type Status = "idle" | "scanning" | "done" | "error";

/** Identifies a login session so we scan once per (account, instance). */
function sessionKey(creds: AwsCredentials): string {
  return `${creds.accessKeyId}:${creds.instance_id ?? ""}`;
}

interface DdbStore {
  ddb: DdbState | null;
  status: Status;
  error: string;
  progress: string;
  scannedKey: string | null;
  /** Scan once per login session. Pass force=true to re-scan (Refresh). */
  scan: (creds: AwsCredentials, force?: boolean) => Promise<void>;
  /** Patch the cached state in place (e.g. after a sync mutation). */
  patch: (updater: (prev: DdbState | null) => DdbState | null) => void;
  reset: () => void;
}

export const useDdbStore = create<DdbStore>((set, get) => ({
  ddb: null,
  status: "idle",
  error: "",
  progress: "",
  scannedKey: null,

  scan: async (creds, force = false) => {
    const key = sessionKey(creds);
    if (get().status === "scanning") return;
    if (!force && get().scannedKey === key && get().ddb) return; // already scanned this session
    set({ status: "scanning", error: "", progress: "Starting scan…" });
    try {
      const result = await scanDdb(creds, (msg) => set({ progress: msg }));
      set({ ddb: result, status: "done", progress: "", scannedKey: key });
    } catch (e: any) {
      set({ status: "error", error: e?.message ?? "DDB scan failed", progress: "" });
    }
  },

  patch: (updater) => set((s) => ({ ddb: updater(s.ddb) })),

  reset: () =>
    set({ ddb: null, status: "idle", error: "", progress: "", scannedKey: null }),
}));
