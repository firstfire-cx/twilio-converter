// src/App.tsx
import { useState, useCallback, useRef, useEffect } from "react";
import type { IR, IVRNode, FlowMeta } from "./types";
import { useAwsCredentials } from "./hooks/useAwsCredentials";
import { useDdbStore } from "./stores/ddbStore";
import Toolbar from "./components/Toolbar";
import MermaidCanvas from "./components/MermaidCanvas";
import NodeEditor from "./components/editor/NodeEditor";
import SkillsPanel from "./components/SkillsPanel";
import PostProcessPanel from "./components/PostProcessPanel";
import AccountPanel from "./components/AccountPanel";
import {
  extractQueuesFromIR,
  createDefaultHoo,
  type IVRProject,
  type QueueRecord,
  type HoursOfOperation,
} from "./project";

// ── Tab data model ────────────────────────────────────────────────────────────

export interface TabData {
  id: string;
  label: string;
  irHistory: IR[];
  irIndex: number;
  meta: Partial<FlowMeta>;
  queues: QueueRecord[];
  hoo: HoursOfOperation;
  rawCx?: any;
  selectedId: string | null;
  pickingBranch: string | null;
  showSkills: boolean;
  showPostProcess: boolean;
  dirty: boolean;
}

export const ACCOUNT_TAB_ID = "__account__";

const blankIR = (): IR => ({ flow_id: "new_flow", nodes: {}, start_step: undefined });

function newTab(partial?: Partial<TabData>): TabData {
  return {
    id: `tab_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    label: "New Flow",
    irHistory: [blankIR()],
    irIndex: 0,
    meta: {},
    queues: [],
    hoo: createDefaultHoo(),
    selectedId: null,
    pickingBranch: null,
    showSkills: false,
    showPostProcess: false,
    dirty: false,
    ...partial,
  };
}

// Tab-level history helpers
export const tabIR = (t: TabData): IR => t.irHistory[t.irIndex];

const tabPushIR = (t: TabData, ir: IR): TabData => {
  const h = t.irHistory.slice(0, t.irIndex + 1);
  h.push(ir);
  return {
    ...t,
    irHistory: h,
    irIndex: h.length - 1,
    label: ir.flow_id || t.label,
    dirty: true,
  };
};

const tabUndoIR = (t: TabData): TabData => ({
  ...t, irIndex: Math.max(0, t.irIndex - 1),
});

const tabRedoIR = (t: TabData): TabData => ({
  ...t, irIndex: Math.min(t.irHistory.length - 1, t.irIndex + 1),
});

// ── Node factory ──────────────────────────────────────────────────────────────

export function makeNode(step_id: string, flow_id: string): IVRNode {
  return {
    step_id,
    action_type: "PLAY",
    label: step_id,
    content: { branches: {}, text: { eng: "", spa: "" } },
    flow_id,
  };
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const auth = useAwsCredentials();

  // Scan DynamoDB once per login session, app-wide. The store dedupes by
  // (account, instance), so this safely no-ops on unrelated re-renders and
  // re-scans only when the credentials/instance actually change.
  useEffect(() => {
    if (auth.credentials) useDdbStore.getState().scan(auth.credentials);
    else useDdbStore.getState().reset();
  }, [auth.credentials]);

  const [tabs, setTabs] = useState<TabData[]>(() => {
    const t = newTab();
    return [t];
  });
  const [activeTabId, setActiveTabId] = useState<string>(() => tabs[0].id);

  // Pick mode
  const pickCallbackRef = useRef<((id: string) => void) | null>(null);
  const [pickingActive, setPickingActive] = useState(false);

  // ── Derived ──────────────────────────────────────────────────────────────

  const isAccountTab = activeTabId === ACCOUNT_TAB_ID;
  const activeTab = isAccountTab ? null : (tabs.find(t => t.id === activeTabId) ?? tabs[0]);

  // ── Tab management ───────────────────────────────────────────────────────

  const updateTab = useCallback((id: string, updater: (t: TabData) => TabData) => {
    setTabs(prev => prev.map(t => t.id === id ? updater(t) : t));
  }, []);

  const updateActive = useCallback((updater: (t: TabData) => TabData) => {
    setTabs(prev => prev.map(t => t.id === activeTabId ? updater(t) : t));
  }, [activeTabId]);

  const addTab = useCallback(() => {
    const t = newTab();
    setTabs(prev => [...prev, t]);
    setActiveTabId(t.id);
  }, []);

  // Open a loaded flow (e.g. from the Account tab's DDB Flows list) in a new tab.
  const openFlowInTab = useCallback((ir: IR, meta?: Partial<FlowMeta>) => {
    const t = newTab({
      irHistory: [ir],
      label: ir.flow_id || meta?.target_flow_id || "Loaded Flow",
      meta: meta ?? ir.meta ?? {},
    });
    setTabs(prev => [...prev, t]);
    setActiveTabId(t.id);
  }, []);

  const closeTab = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setTabs(prev => {
      const remaining = prev.filter(t => t.id !== id);
      if (remaining.length === 0) {
        const fresh = newTab();
        setActiveTabId(fresh.id);
        return [fresh];
      }
      if (activeTabId === id) {
        const idx = prev.findIndex(t => t.id === id);
        const next = remaining[Math.max(0, idx - 1)];
        setActiveTabId(next?.id ?? remaining[0].id);
      }
      return remaining;
    });
  }, [activeTabId]);

  // ── IR helpers ───────────────────────────────────────────────────────────

  const setActiveIR = useCallback((ir: IR, cx?: any) => {
    setPickingActive(false);
    pickCallbackRef.current = null;
    updateActive(t => {
      // Auto-populate meta fields that can be inferred from the IR
      const autoMeta: Partial<FlowMeta> = {
        ...t.meta,
        ...ir.meta, // Include meta from the IR itself
        target_flow_id: ir.meta?.target_flow_id || t.meta.target_flow_id || ir.flow_id,
        start_step: ir.meta?.start_step || t.meta.start_step || ir.start_step || "",
        hoo_arn: ir.meta?.hoo_arn || t.meta.hoo_arn || ir.hoo_arn || "",
      };
      
      // Update auth credentials if instance_id is provided in meta
      if (ir.meta?.instance_id && auth.credentials && ir.meta.instance_id !== auth.credentials.instance_id) {
        auth.setManual({ ...auth.credentials, instance_id: ir.meta.instance_id });
      }
      
      return {
        ...tabPushIR(t, ir),
        rawCx: cx ?? t.rawCx,
        selectedId: null,
        pickingBranch: null,
        queues: extractQueuesFromIR(ir, t.queues),
        meta: autoMeta,
      };
    });
  }, [updateActive, auth]);

  // ── Node operations ──────────────────────────────────────────────────────

  const addNode = useCallback(() => {
    if (!activeTab) return;
    const ir = tabIR(activeTab);
    const id = `step_${Date.now().toString(36)}`;
    const node = makeNode(id, ir.flow_id);
    const newIR: IR = {
      ...ir,
      nodes: { ...ir.nodes, [id]: node },
      start_step: ir.start_step || id,
    };
    updateActive(t => ({ ...tabPushIR(t, newIR), selectedId: id }));
  }, [activeTab, updateActive]);

  const deleteNode = useCallback((id: string) => {
    if (!activeTab) return;
    const ir = tabIR(activeTab);
    const newNodes = { ...ir.nodes };
    delete newNodes[id];

    for (const n of Object.values(newNodes)) {
      let changed = false;
      const branches = { ...(n.content?.branches ?? {}) };
      for (const [k, v] of Object.entries(branches)) {
        if (v === id) { branches[k] = ""; changed = true; }
      }
      const updates: Partial<IVRNode> = {};
      if (n.default_next === id) updates.default_next = undefined;
      if (changed) updates.content = { ...n.content, branches };
      if (Object.keys(updates).length) newNodes[n.step_id] = { ...n, ...updates };
    }

    const newStart = ir.start_step === id ? Object.keys(newNodes)[0] : ir.start_step;
    const newIR: IR = { ...ir, nodes: newNodes, start_step: newStart };
    setPickingActive(false);
    pickCallbackRef.current = null;
    updateActive(t => ({ ...tabPushIR(t, newIR), selectedId: null, pickingBranch: null }));
  }, [activeTab, updateActive]);

  // ── Pick mode ────────────────────────────────────────────────────────────

  const startPick = useCallback((callback: (id: string) => void) => {
    pickCallbackRef.current = callback;
    setPickingActive(true);
  }, []);

  const handleCanvasPick = useCallback((id: string) => {
    pickCallbackRef.current?.(id);
    pickCallbackRef.current = null;
    setPickingActive(false);
    updateActive(t => ({ ...t, pickingBranch: null }));
  }, [updateActive]);

  const cancelPick = useCallback(() => {
    pickCallbackRef.current = null;
    setPickingActive(false);
    updateActive(t => ({ ...t, pickingBranch: null }));
  }, [updateActive]);

  // ── Project I/O ──────────────────────────────────────────────────────────

  const currentProject = useCallback((): IVRProject => {
    if (!activeTab) return { version: "1.1", ir: blankIR(), meta: {}, queues: [] };
    return {
      version: "1.1",
      ir: tabIR(activeTab),
      meta: activeTab.meta,
      queues: activeTab.queues,
      hoo: activeTab.hoo,
    };
  }, [activeTab]);

  const handleProjectLoaded = useCallback((project: IVRProject) => {
    const ir: IR = { ...project.ir, meta: project.meta };
    const mergedQueues = extractQueuesFromIR(ir, project.queues || []);
    const loaded: TabData = newTab({
      id: `tab_${Date.now()}`,
      label: ir.flow_id || "Loaded Flow",
      irHistory: [ir],
      irIndex: 0,
      meta: project.meta || {},
      queues: mergedQueues,
      hoo: project.hoo || createDefaultHoo(),
      dirty: false,
    });

    // Replace empty active tab; otherwise open in new tab
    const isEmpty = !activeTab || Object.keys(tabIR(activeTab).nodes).length === 0;
    if (isEmpty && activeTabId !== ACCOUNT_TAB_ID) {
      setTabs(prev => prev.map(t => t.id === activeTabId ? { ...loaded, id: activeTabId } : t));
    } else {
      setTabs(prev => [...prev, loaded]);
      setActiveTabId(loaded.id);
    }

    if (project.meta?.instance_id && auth.credentials) {
      auth.setManual({ ...auth.credentials, instance_id: project.meta.instance_id });
    }
  }, [activeTab, activeTabId, auth]);

  const handleHooCreated = useCallback((hooArn: string) => {
    if (!activeTab) return;
    const ir = tabIR(activeTab);
    const updatedNodes = { ...ir.nodes };
    for (const [id, node] of Object.entries(updatedNodes)) {
      if (node.action_type === "HOURS") {
        updatedNodes[id] = { ...node, content: { ...node.content, hoo_arn: hooArn } };
      }
    }
    updateActive(t => ({
      ...tabPushIR(t, { ...ir, hoo_arn: hooArn, nodes: updatedNodes }),
      meta: { ...t.meta, hoo_arn: hooArn },
      hoo: { ...t.hoo, hooArn },
    }));
  }, [activeTab, updateActive]);

  // ── Render ───────────────────────────────────────────────────────────────

  const ir = activeTab ? tabIR(activeTab) : blankIR();

  return (
    <div className="app-shell">
      <Toolbar
        ir={ir}
        meta={activeTab?.meta ?? {}}
        setMeta={(meta) => updateActive(t => ({ ...t, meta }))}
        setIR={setActiveIR}
        setIRWithCx={(ir, cx) => setActiveIR(ir, cx)}
        undo={() => updateActive(tabUndoIR)}
        redo={() => updateActive(tabRedoIR)}
        onAddNode={addNode}
        onShowSkills={() => updateActive(t => ({ ...t, showSkills: true }))}
        onShowPostProcess={() => updateActive(t => ({ ...t, showPostProcess: true }))}
        auth={auth}
        currentProject={currentProject}
        onProjectLoaded={handleProjectLoaded}
        disabled={isAccountTab}
        // Tab strip
        tabs={tabs}
        activeTabId={activeTabId}
        onTabSelect={setActiveTabId}
        onTabAdd={addTab}
        onTabClose={closeTab}
        showAccountTab={!!auth.credentials}
        onShowAccount={() => setActiveTabId(ACCOUNT_TAB_ID)}
        isAccountTab={isAccountTab}
      />

      {isAccountTab ? (
        <AccountPanel auth={auth} onLoadFlow={openFlowInTab} />
      ) : !activeTab ? null : (
        <div className="app-body">
          <div className="canvas-pane" style={{ position: "relative" }}>
            <MermaidCanvas
              ir={ir}
              selectedId={activeTab.selectedId}
              onSelect={pickingActive ? undefined : (id) =>
                updateActive(t => ({ ...t, selectedId: id }))}
              onPickNode={pickingActive ? handleCanvasPick : null}
            />
            {pickingActive && (
              <button
                className="btn btn-danger"
                style={{
                  position: "absolute", bottom: 12, left: "50%",
                  transform: "translateX(-50%)", zIndex: 10,
                }}
                onClick={cancelPick}
              >
                Cancel Pick (Esc)
              </button>
            )}
          </div>

          <aside className={`sidebar-pane ${activeTab.selectedId ? "sidebar-open" : ""}`}>
            <NodeEditor
              ir={ir}
              selectedId={activeTab.selectedId}
              setIR={(ir) => updateActive(t => tabPushIR(t, ir))}
              onSelect={(id) => updateActive(t => ({ ...t, selectedId: id }))}
              onDelete={deleteNode}
              onStartPick={startPick}
              pickingBranch={activeTab.pickingBranch}
            />
          </aside>

          {activeTab.showSkills && (
            <SkillsPanel
              ir={ir}
              setIR={(ir) => updateActive(t => tabPushIR(t, ir))}
              rawCx={activeTab.rawCx}
              meta={activeTab.meta}
              setMeta={(meta) => updateActive(t => ({ ...t, meta }))}
              queues={activeTab.queues}
              setQueues={(queues) => updateActive(t => ({ ...t, queues }))}
              hoo={activeTab.hoo}
              setHoo={(hoo) => updateActive(t => ({ ...t, hoo }))}
              onClose={() => updateActive(t => ({ ...t, showSkills: false }))}
              onHooCreated={handleHooCreated}
              credentials={auth.credentials}
              instances={auth.instances}
              onSelectInstance={(instanceId) => {
                if (auth.credentials) {
                  auth.setManual({ ...auth.credentials, instance_id: instanceId });
                }
              }}
              allTabs={tabs.map(t => ({ id: t.id, label: t.label, queues: t.queues }))}
            />
          )}

          {activeTab.showPostProcess && (
            <PostProcessPanel
              ir={ir}
              setIR={(ir) => updateActive(t => tabPushIR(t, ir))}
              onClose={() => updateActive(t => ({ ...t, showPostProcess: false }))}
            />
          )}
        </div>
      )}
    </div>
  );
}

