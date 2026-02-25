// src/App.tsx
import { useState, useCallback, useRef } from "react";
import type { IR, IVRNode, FlowMeta } from "./types";
import { useHistory } from "./hooks/useHistory";
import { useAwsCredentials } from "./hooks/useAwsCredentials";
import Toolbar from "./components/Toolbar";
import MermaidCanvas from "./components/MermaidCanvas";
import NodeEditor from "./components/NodeEditor";
import SkillsPanel from "./components/SkillsPanel";
import {
  extractQueuesFromIR,
  createDefaultHoo,
  type IVRProject,
  type QueueRecord,
  type HoursOfOperation,
} from "./project";

const initialIR: IR = { flow_id: "flow", nodes: {}, start_step: undefined };
const initialMeta: Partial<FlowMeta> = {};

export function makeNode(step_id: string, flow_id: string): IVRNode {
  return {
    step_id,
    action_type: "PLAY",
    label: step_id,
    content: { branches: {}, text: { eng: "", spa: "" } },
    flow_id,
  };
}

export default function App() {
  const history = useHistory(initialIR);
  const auth = useAwsCredentials();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showSkills, setShowSkills] = useState(false);
  const [rawCx, setRawCx] = useState<any>(null);
  const [meta, setMeta] = useState<Partial<FlowMeta>>(initialMeta);

  // ── Queues & HOO lifted to App level so they persist across modal open/close
  //    and are included in project save/load ─────────────────────────────────
  const [queues, setQueues] = useState<QueueRecord[]>([]);
  const [hoo, setHoo] = useState<HoursOfOperation>(createDefaultHoo());

  // ── Pick mode ─────────────────────────────────────────────────────────────
  const pickCallbackRef = useRef<((id: string) => void) | null>(null);
  const [pickingActive, setPickingActive] = useState(false);
  const [pickingBranch, setPickingBranch] = useState<string | null>(null);

  const startPick = useCallback((callback: (id: string) => void) => {
    pickCallbackRef.current = callback;
    setPickingActive(true);
  }, []);

  const handleCanvasPick = useCallback((id: string) => {
    if (pickCallbackRef.current) pickCallbackRef.current(id);
    pickCallbackRef.current = null;
    setPickingActive(false);
    setPickingBranch(null);
  }, []);

  const cancelPick = useCallback(() => {
    pickCallbackRef.current = null;
    setPickingActive(false);
    setPickingBranch(null);
  }, []);

  // ── Node management ───────────────────────────────────────────────────────
  const addNode = () => {
    const id = `step_${Date.now().toString(36)}`;
    const node = makeNode(id, history.state.flow_id);
    const newIR: IR = {
      ...history.state,
      nodes: { ...history.state.nodes, [id]: node },
    };
    if (!newIR.start_step) newIR.start_step = id;
    history.set(newIR);
    setSelectedId(id);
  };

  const deleteNode = (id: string) => {
    const newNodes = { ...history.state.nodes };
    delete newNodes[id];

    for (const n of Object.values(newNodes)) {
      let changed = false;
      const branches = { ...(n.content?.branches ?? {}) };
      for (const [k, v] of Object.entries(branches)) {
        if (v === id) { branches[k] = ""; changed = true; }
      }
      const nodeUpdates: Partial<IVRNode> = {};
      if (n.default_next === id) nodeUpdates.default_next = undefined;
      if (changed) nodeUpdates.content = { ...n.content, branches };
      if (Object.keys(nodeUpdates).length) {
        newNodes[n.step_id] = { ...n, ...nodeUpdates };
      }
    }

    const newStartStep =
      history.state.start_step === id
        ? Object.keys(newNodes)[0]
        : history.state.start_step;

    history.set({ ...history.state, nodes: newNodes, start_step: newStartStep });
    setSelectedId(null);
    cancelPick();
  };

  const handleSetIR = (ir: IR, cx?: any) => {
    if (cx) setRawCx(cx);
    history.set(ir);
    setSelectedId(null);
    cancelPick();
    // Re-extract queues from the new IR, preserving any existing ARNs
    setQueues((prev) => extractQueuesFromIR(ir, prev));
  };

  const handleHooCreated = useCallback(
    (hooArn: string) => {
      // Update IR: set hoo_arn at top level AND patch all HOURS nodes
      const updatedNodes = { ...history.state.nodes };
      for (const [id, node] of Object.entries(updatedNodes)) {
        if (node.action_type === "HOURS") {
          updatedNodes[id] = { ...node, content: { ...node.content, hoo_arn: hooArn } };
        }
      }
      history.set({ ...history.state, hoo_arn: hooArn, nodes: updatedNodes });
      setMeta((m) => ({ ...m, hoo_arn: hooArn }));
    },
    [history.state],
  );

  // ── Project save/load ─────────────────────────────────────────────────────
  const currentProject = useCallback((): IVRProject => ({
    version: "1.1",
    ir: history.state,
    meta,
    queues,
    hoo,
  }), [history.state, meta, queues, hoo]);

  const handleProjectLoaded = useCallback(
    (project: IVRProject) => {
      const newIR: IR = {
        ...project.ir,
        meta: project.meta,
      };
      history.set(newIR);
      setMeta(project.meta || {});
      // Merge loaded queues with freshly-extracted ones (loaded ARNs win)
      setQueues(extractQueuesFromIR(newIR, project.queues || []));
      if (project.hoo) setHoo(project.hoo);

      const instanceId = project.meta?.instance_id;
      if (instanceId && auth.credentials) {
        auth.setManual({ ...auth.credentials, instance_id: instanceId });
      }
      setSelectedId(null);
    },
    [history, auth.credentials],
  );

  return (
    <div className="app-shell">
      <Toolbar
        ir={history.state}
        meta={meta}
        setMeta={setMeta}
        setIR={(ir) => handleSetIR(ir)}
        setIRWithCx={handleSetIR}
        undo={history.undo}
        redo={history.redo}
        onAddNode={addNode}
        onShowSkills={() => setShowSkills(true)}
        auth={auth}
        currentProject={currentProject}
        onProjectLoaded={handleProjectLoaded}
      />
      <div className="app-body">
        <div className="canvas-pane" style={{ position: "relative" }}>
          <MermaidCanvas
            ir={history.state}
            selectedId={selectedId}
            onSelect={pickingActive ? undefined : setSelectedId}
            onPickNode={pickingActive ? handleCanvasPick : null}
          />
          {pickingActive && (
            <button
              className="btn btn-danger"
              style={{
                position: "absolute",
                bottom: 12,
                left: "50%",
                transform: "translateX(-50%)",
                zIndex: 10,
              }}
              onClick={cancelPick}
            >
              Cancel Pick (Esc)
            </button>
          )}
        </div>

        <aside className={`sidebar-pane ${selectedId ? "sidebar-open" : ""}`}>
          <NodeEditor
            ir={history.state}
            selectedId={selectedId}
            setIR={history.set}
            onSelect={setSelectedId}
            onDelete={deleteNode}
            onStartPick={startPick}
            pickingBranch={pickingBranch}
          />
        </aside>
      </div>

      {showSkills && (
        <SkillsPanel
          ir={history.state}
          setIR={history.set}
          rawCx={rawCx}
          meta={meta}
          queues={queues}
          setQueues={setQueues}
          hoo={hoo}
          setHoo={setHoo}
          onClose={() => setShowSkills(false)}
          onHooCreated={handleHooCreated}
          credentials={auth.credentials}
        />
      )}
    </div>
  );
}