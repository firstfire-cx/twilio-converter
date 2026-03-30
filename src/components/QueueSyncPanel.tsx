// src/components/QueueSyncPanel.tsx
//
// Queue synchronization panel
// - Upload CSV mapping (skill_id → queue_name)
// - View planned sync actions
// - Execute sync
// - Sync queues with loaded flows

import { useState, useRef, useCallback } from "react";
import type { AwsCredentials, ConnectInstance } from "../hooks/useAwsCredentials";
import type { QueueRecord, HoursOfOperation } from "../project";
import {
    buildConnectClient,
    parseSkillMappingCSV,
    fetchQueuesWithTags,
    fetchHoosWithTags,
    planQueueSync,
    executeQueueSync,
    syncQueuesWithFlows,
    findMissingQueues,
    type SkillMappingRow,
    type SyncAction,
    type SyncResult,
    type QueuedWithTags,
} from "../utils/queueSync";

// ─── Styles ──────────────────────────────────────────────────────────────────

const MONO: React.CSSProperties = { fontFamily: "'IBM Plex Mono', monospace" };

const INPUT: React.CSSProperties = {
    background: "var(--bg-0)", border: "1px solid var(--border)",
    borderRadius: "var(--radius)", color: "var(--text-0)",
    ...MONO, fontSize: 11, padding: "4px 8px", outline: "none",
    width: "100%", boxSizing: "border-box",
};

const LABEL: React.CSSProperties = {
    fontSize: 10, color: "var(--text-2)", fontWeight: 500,
    marginBottom: 3, display: "block",
    fontFamily: "'IBM Plex Sans', sans-serif",
};

function tagStyle(color: string, bg: string, border: string): React.CSSProperties {
    return {
        fontSize: 9, borderRadius: 3, padding: "1px 6px", fontWeight: 700,
        letterSpacing: "0.05em", ...MONO, color, background: bg, border: `1px solid ${border}`,
        flexShrink: 0,
    };
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface Props {
    credentials: AwsCredentials | null;
    instances?: ConnectInstance[];
    onSelectInstance?: (instanceId: string) => void;
    flowQueues: QueueRecord[];
    setFlowQueues: (queues: QueueRecord[]) => void;
    hoo?: HoursOfOperation;
    onClose: () => void;
}

// ─── Action row component ───────────────────────────────────────────────────

function ActionRow({ action }: { action: SyncAction }) {
    const typeColors: Record<SyncAction["type"], string> = {
        create: "var(--green)",
        rename: "var(--cyan)",
        recreate: "var(--orange)",
        tag: "var(--accent)",
        untag: "var(--text-3)",
        delete: "var(--red)",
        skip: "var(--text-3)",
    };

    const typeIcons: Record<SyncAction["type"], string> = {
        create: "+",
        rename: "↗",
        recreate: "⇄",
        tag: "🏷",
        untag: "−",
        delete: "✕",
        skip: "○",
    };

    return (
        <div style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "6px 8px", background: "var(--bg-3)",
            borderRadius: "var(--radius)", fontSize: 10, ...MONO,
        }}>
            <span style={{ color: typeColors[action.type], fontSize: 12 }}>{typeIcons[action.type]}</span>
            <span style={{ textTransform: "uppercase", fontWeight: 600, color: typeColors[action.type], fontSize: 9 }}>
                {action.type}
            </span>
            <span style={{ flex: 1 }}>
                {action.currentName && action.targetName && action.currentName !== action.targetName ? (
                    <span>
                        <span style={{ color: "var(--text-3)", textDecoration: "line-through" }}>{action.currentName}</span>
                        <span style={{ margin: "0 4px" }}>→</span>
                        <span style={{ color: "var(--text-0)" }}>{action.targetName}</span>
                    </span>
                ) : (
                    action.currentName ?? action.targetName ?? "(unknown)"
                )}
            </span>
            {action.skillId && (
                <span style={{ color: "var(--text-3)", fontSize: 9 }}>#{action.skillId}</span>
            )}
            <span style={{ color: "var(--text-3)", fontSize: 9 }}>{action.reason}</span>
        </div>
    );
}

// ─── Main panel ──────────────────────────────────────────────────────────────

export default function QueueSyncPanel({
    credentials, instances, onSelectInstance, flowQueues, setFlowQueues, hoo, onClose,
}: Props) {
    const [activeTab, setActiveTab] = useState<"mapping" | "sync" | "flows">("mapping");
    const [selectedInstanceId, setSelectedInstanceId] = useState(credentials?.instance_id ?? "");
    const [csvText, setCsvText] = useState("");
    const [skillMapping, setSkillMapping] = useState<Map<string, SkillMappingRow> | null>(null);
    const [liveQueues, setLiveQueues] = useState<QueuedWithTags[]>([]);
    const [syncPlan, setSyncPlan] = useState<SyncAction[]>([]);
    const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
    const [loading, setLoading] = useState(false);
    const [executing, setExecuting] = useState(false);
    const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
    const [error, setError] = useState<string>("");
    const fileInputRef = useRef<HTMLInputElement>(null);

    // ── Instance selector ──────────────────────────────────────────────────────

    const currentInstanceId = credentials?.instance_id ?? selectedInstanceId;

    const handleSelectInstance = (id: string) => {
        setSelectedInstanceId(id);
        onSelectInstance?.(id);
    };

    // ── CSV handling ──────────────────────────────────────────────────────────

    const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        e.target.value = "";

        const reader = new FileReader();
        reader.onload = (ev) => {
            const text = ev.target?.result as string;
            setCsvText(text);
            const mapping = parseSkillMappingCSV(text);
            setSkillMapping(mapping);
            if (mapping.size === 0) {
                setError("Could not parse CSV — expected columns: skill_id, queue_name");
            } else {
                setError("");
            }
        };
        reader.readAsText(file);
    };

    const handlePasteCSV = () => {
        navigator.clipboard.readText().then(text => {
            setCsvText(text);
            const mapping = parseSkillMappingCSV(text);
            setSkillMapping(mapping);
            if (mapping.size === 0) {
                setError("Could not parse CSV — expected columns: skill_id, queue_name");
            } else {
                setError("");
            }
        });
    };

    // ── Fetch live data ───────────────────────────────────────────────────────

    const fetchLiveQueues = useCallback(async () => {
        if (!credentials || !currentInstanceId) return;
        setLoading(true);
        setError("");
        try {
            const client = buildConnectClient(credentials);
            const queues = await fetchQueuesWithTags(client, currentInstanceId);
            setLiveQueues(queues);
        } catch (e: any) {
            setError(`Failed to fetch queues: ${e.message}`);
        } finally {
            setLoading(false);
        }
    }, [credentials, currentInstanceId]);

    // ── Plan sync ─────────────────────────────────────────────────────────────

    const planSync = useCallback(() => {
        if (!skillMapping || !liveQueues.length) {
            setError("Upload CSV and fetch live queues first");
            return;
        }
        const plan = planQueueSync(liveQueues, skillMapping);
        setSyncPlan(plan);
        setSyncResult(null);
        setActiveTab("sync");
    }, [skillMapping, liveQueues]);

    // ── Execute sync ──────────────────────────────────────────────────────────

    const executeSync = async () => {
        if (!credentials || !currentInstanceId || !syncPlan.length) return;
        setExecuting(true);
        setError("");

        try {
            const client = buildConnectClient(credentials);
            const result = await executeQueueSync(
                client,
                currentInstanceId,
                syncPlan,
                hoo?.hooId,
                (current, total, action) => {
                    setProgress({ current, total });
                    console.log(`[sync] ${current}/${total}: ${action.type} ${action.currentName ?? action.targetName}`);
                }
            );
            setSyncResult(result);
            setProgress(null);
        } catch (e: any) {
            setError(`Sync failed: ${e.message}`);
        } finally {
            setExecuting(false);
        }
    };

    // ── Sync with flows ──────────────────────────────────────────────────────

    const syncWithFlows = async () => {
        if (!credentials || !currentInstanceId || !flowQueues.length) {
            setError("No flow queues to sync");
            return;
        }
        setLoading(true);
        setError("");
        try {
            const client = buildConnectClient(credentials);
            const synced = await syncQueuesWithFlows(client, currentInstanceId, flowQueues);
            setFlowQueues(synced);

            // Show missing queues
            const missing = findMissingQueues(synced, liveQueues);
            if (missing.length > 0) {
                console.warn(`[syncWithFlows] ${missing.length} queues missing from Connect:`, missing.map(q => q.connectName));
            }

            setActiveTab("flows");
        } catch (e: any) {
            setError(`Sync with flows failed: ${e.message}`);
        } finally {
            setLoading(false);
        }
    };

    // ── Stats ─────────────────────────────────────────────────────────────────

    const getPlanStats = () => {
        return {
            create: syncPlan.filter(a => a.type === "create").length,
            rename: syncPlan.filter(a => a.type === "rename").length,
            recreate: syncPlan.filter(a => a.type === "recreate").length,
            tag: syncPlan.filter(a => a.type === "tag").length,
            delete: syncPlan.filter(a => a.type === "delete").length,
            skip: syncPlan.filter(a => a.type === "skip").length,
        };
    };

    const planStats = getPlanStats();
    const hasChanges = planStats.create + planStats.rename + planStats.recreate + planStats.tag + planStats.delete > 0;

    // ── Render ────────────────────────────────────────────────────────────────

    return (
        <div style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", zIndex: 100,
            display: "flex", alignItems: "center", justifyContent: "center",
        }}>
            <div style={{
                background: "var(--bg-2)", borderRadius: "var(--radius-lg)",
                width: 800, maxHeight: "92vh", display: "flex", flexDirection: "column",
                overflow: "hidden", boxShadow: "0 32px 64px rgba(0,0,0,0.6)",
            }}>
                {/* Header */}
                <div style={{
                    padding: "12px 16px", background: "var(--bg-3)", borderBottom: "1px solid var(--border)",
                    display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0,
                }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={tagStyle("var(--green)", "rgba(61,186,126,0.12)", "rgba(61,186,126,0.3)")}>SYNC</span>
                        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-0)" }}>Queue Synchronization</span>
                        {!credentials && <span style={{ fontSize: 10, color: "var(--orange)", ...MONO }}>⚠ Not authenticated</span>}
                    </div>
                    <button className="btn btn-ghost" onClick={onClose} style={{ padding: "2px 8px", height: 24, fontSize: 16 }}>×</button>
                </div>

                {/* Instance selector */}
                {credentials && (
                    <div style={{
                        display: "flex", alignItems: "center", gap: 8, padding: "8px 16px",
                        background: "var(--bg-3)", borderBottom: "1px solid var(--border)", flexShrink: 0,
                    }}>
                        <label style={{ ...LABEL, marginBottom: 0, flexShrink: 0 }}>Connect Instance</label>
                        {instances && instances.length > 0 ? (
                            <select
                                style={{ ...INPUT, flex: 1, cursor: "pointer" }}
                                value={currentInstanceId}
                                onChange={e => handleSelectInstance(e.target.value)}
                            >
                                {instances.map(inst => (
                                    <option key={inst.id} value={inst.id}>{inst.alias} ({inst.id.slice(0, 8)}…)</option>
                                ))}
                            </select>
                        ) : (
                            <input
                                style={{ ...INPUT, flex: 1 }}
                                value={currentInstanceId}
                                onChange={e => handleSelectInstance(e.target.value)}
                                placeholder="Instance ID"
                                spellCheck={false}
                            />
                        )}
                    </div>
                )}

                {/* Tabs */}
                <div style={{
                    display: "flex", borderBottom: "1px solid var(--border)", background: "var(--bg-3)", flexShrink: 0,
                }}>
                    {[
                        ["mapping", "CSV Mapping"],
                        ["sync", "Sync Actions"],
                        ["flows", "Flow Queues"],
                    ].map(([id, label]) => (
                        <button
                            key={id}
                            onClick={() => setActiveTab(id as typeof activeTab)}
                            style={{
                                padding: "8px 16px", background: "none", border: "none", cursor: "pointer",
                                fontSize: 11, fontWeight: 500,
                                color: activeTab === id ? "var(--accent)" : "var(--text-3)",
                                borderBottom: activeTab === id ? "2px solid var(--accent)" : "2px solid transparent",
                            }}
                        >
                            {label}
                            {id === "sync" && hasChanges && <span style={{ marginLeft: 4, color: "var(--green)" }}>{hasChanges}</span>}
                        </button>
                    ))}
                </div>

                {/* Content */}
                <div style={{ flex: 1, overflow: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
                    {/* Error banner */}
                    {error && (
                        <div style={{
                            padding: "8px 12px", background: "rgba(224,90,90,0.08)",
                            border: "1px solid rgba(224,90,90,0.3)", borderRadius: "var(--radius)",
                            fontSize: 11, color: "var(--red)", ...MONO,
                        }}>
                            ⚠ {error}
                        </div>
                    )}

                    {/* ── CSV Mapping tab ── */}
                    {activeTab === "mapping" && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                            <div>
                                <label style={LABEL}>Skills CSV Mapping</label>
                                <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                                    <label className="btn" style={{ fontSize: 10, cursor: "pointer" }}>
                                        📁 Upload CSV
                                        <input ref={fileInputRef} type="file" accept=".csv,.txt" onChange={handleFileUpload} style={{ display: "none" }} />
                                    </label>
                                    <button className="btn btn-ghost" onClick={handlePasteCSV} style={{ fontSize: 10 }}>
                                        📋 Paste from Clipboard
                                    </button>
                                </div>
                                <textarea
                                    style={{ ...INPUT, height: 150, resize: "vertical", fontFamily: "inherit" }}
                                    value={csvText}
                                    onChange={e => {
                                        setCsvText(e.target.value);
                                        setSkillMapping(parseSkillMappingCSV(e.target.value));
                                    }}
                                    placeholder="skill_id,queue_name,description&#10;12345678,Support-English,General support queue"
                                />
                                {skillMapping && (
                                    <div style={{ fontSize: 10, color: "var(--text-3)", ...MONO, marginTop: 4 }}>
                                        {skillMapping.size} skill mappings loaded
                                    </div>
                                )}
                            </div>

                            <div style={{ display: "flex", gap: 8 }}>
                                <button
                                    className="btn btn-primary"
                                    onClick={fetchLiveQueues}
                                    disabled={loading || !credentials || !currentInstanceId}
                                >
                                    {loading ? "Loading…" : "↺ Fetch Live Queues"}
                                </button>
                                <button
                                    className="btn btn-ghost"
                                    onClick={planSync}
                                    disabled={!skillMapping || !liveQueues.length}
                                >
                                    ⚙️ Plan Sync
                                </button>
                            </div>

                            {liveQueues.length > 0 && (
                                <div style={{ fontSize: 10, color: "var(--text-3)", ...MONO }}>
                                    ✓ {liveQueues.length} live queues fetched
                                </div>
                            )}
                        </div>
                    )}

                    {/* ── Sync Actions tab ── */}
                    {activeTab === "sync" && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                            {!syncPlan.length ? (
                                <div style={{ fontSize: 11, color: "var(--text-3)", ...MONO, textAlign: "center", padding: 24 }}>
                                    No sync plan yet.<br />
                                    Upload a CSV and click "Plan Sync" to generate actions.
                                </div>
                            ) : (
                                <>
                                    {/* Stats */}
                                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                                        <div style={{ padding: "8px", background: "rgba(61,186,126,0.08)", border: "1px solid rgba(61,186,126,0.2)", borderRadius: "var(--radius)", textAlign: "center" }}>
                                            <div style={{ fontSize: 18, fontWeight: 700, color: "var(--green)" }}>{planStats.create}</div>
                                            <div style={{ fontSize: 9, color: "var(--text-3)", ...MONO }}>CREATE</div>
                                        </div>
                                        <div style={{ padding: "8px", background: "rgba(90,174,232,0.08)", border: "1px solid rgba(90,174,232,0.2)", borderRadius: "var(--radius)", textAlign: "center" }}>
                                            <div style={{ fontSize: 18, fontWeight: 700, color: "var(--cyan)" }}>{planStats.rename + planStats.recreate}</div>
                                            <div style={{ fontSize: 9, color: "var(--text-3)", ...MONO }}>RENAME/RECREATE</div>
                                        </div>
                                        <div style={{ padding: "8px", background: "rgba(232,149,90,0.08)", border: "1px solid rgba(232,149,90,0.2)", borderRadius: "var(--radius)", textAlign: "center" }}>
                                            <div style={{ fontSize: 18, fontWeight: 700, color: "var(--orange)" }}>{planStats.tag}</div>
                                            <div style={{ fontSize: 9, color: "var(--text-3)", ...MONO }}>RETAG</div>
                                        </div>
                                    </div>

                                    {/* Progress bar */}
                                    {progress && (
                                        <div style={{ fontSize: 10, color: "var(--text-3)", ...MONO }}>
                                            Executing… {progress.current}/{progress.total} ({Math.round(progress.current / progress.total * 100)}%)
                                        </div>
                                    )}

                                    {/* Actions list */}
                                    <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 400, overflowY: "auto" }}>
                                        {syncPlan.map((action, i) => (
                                            <ActionRow key={i} action={action} />
                                        ))}
                                    </div>

                                    {/* Execute button */}
                                    <div style={{ display: "flex", justifyContent: "flex-end" }}>
                                        <button
                                            className="btn btn-primary"
                                            onClick={executeSync}
                                            disabled={executing || !hasChanges || !credentials}
                                        >
                                            {executing ? "Executing…" : `▶ Execute ${hasChanges} Changes`}
                                        </button>
                                    </div>
                                </>
                            )}

                            {/* Results */}
                            {syncResult && (
                                <div style={{ padding: "10px", background: "var(--bg-3)", borderRadius: "var(--radius)" }}>
                                    <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-0)", marginBottom: 6 }}>Results</div>
                                    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 6, fontSize: 10, ...MONO }}>
                                        <span>Created:</span><span style={{ color: "var(--green)" }}>{syncResult.created}</span>
                                        <span>Renamed:</span><span style={{ color: "var(--cyan)" }}>{syncResult.renamed}</span>
                                        <span>Retagged:</span><span style={{ color: "var(--accent)" }}>{syncResult.retagged}</span>
                                        <span>Deleted:</span><span style={{ color: "var(--red)" }}>{syncResult.deleted}</span>
                                        <span>Skipped:</span><span>{syncResult.skipped}</span>
                                        <span>Errors:</span><span style={{ color: syncResult.errors.length ? "var(--red)" : "var(--green)" }}>{syncResult.errors.length}</span>
                                    </div>
                                    {syncResult.errors.length > 0 && (
                                        <div style={{ marginTop: 8, fontSize: 9, color: "var(--red)", ...MONO }}>
                                            {syncResult.errors.map((e, i) => <div key={i}>• {e.resource}: {e.error}</div>)}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    {/* ── Flow Queues tab ── */}
                    {activeTab === "flows" && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                            <div>
                                <label style={LABEL}>Queues from Loaded Flows</label>
                                {flowQueues.length === 0 ? (
                                    <div style={{ fontSize: 11, color: "var(--text-3)", ...MONO, padding: 16, textAlign: "center" }}>
                                        No queues from flows yet. Load a flow to see its queue mappings.
                                    </div>
                                ) : (
                                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                        {flowQueues.map((q, i) => (
                                            <div key={i} style={{
                                                display: "flex", alignItems: "center", gap: 8,
                                                padding: "6px 8px", background: "var(--bg-3)",
                                                borderRadius: "var(--radius)", fontSize: 10, ...MONO,
                                            }}>
                                                <span style={{ flex: 1, minWidth: 0 }}>
                                                    <span style={{ color: "var(--text-0)" }}>{q.connectName}</span>
                                                    {q.queueSkill && <span style={{ color: "var(--text-3)", marginLeft: 6 }}>#{q.queueSkill}</span>}
                                                </span>
                                                {q.queueArn ? (
                                                    <span style={{ color: "var(--green)", fontSize: 9 }}>✓</span>
                                                ) : (
                                                    <span style={{ color: "var(--orange)", fontSize: 9 }}>⚠</span>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>

                            <button
                                className="btn btn-primary"
                                onClick={syncWithFlows}
                                disabled={loading || !credentials || !flowQueues.length}
                            >
                                {loading ? "Syncing…" : "🔄 Sync ARNs from Connect"}
                            </button>

                            <div style={{ fontSize: 10, color: "var(--text-3)", ...MONO, lineHeight: 1.6 }}>
                                This updates the queue ARNs in your flow based on the live Connect queues.
                                Queues without ARNs will be searched by name or skill ID tag.
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}