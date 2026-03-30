// src/components/editor/NodePicker.tsx
import type { IVRNode } from "../../types";

interface Props {
    value: string;
    onChange: (id: string) => void;
    nodes: Record<string, IVRNode>;
    selfId: string;
    onStartPick: () => void;
    pickingActive: boolean;
}

export default function NodePicker({ value, onChange, nodes, selfId, onStartPick, pickingActive }: Props) {
    const nodeIds = Object.keys(nodes).filter((id) => id !== selfId).sort();
    return (
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <select className="input" style={{ flex: 1 }} value={value} onChange={(e) => onChange(e.target.value)}>
                <option value="">(End Flow)</option>
                {nodeIds.map((id) => (
                    <option key={id} value={id}>[{id}] {nodes[id].label || nodes[id].action_type}</option>
                ))}
            </select>
            <button
                className="btn"
                onClick={onStartPick}
                title="Click a node on the canvas to set target"
                style={{
                    padding: "4px 8px", height: 28, flexShrink: 0, fontSize: 14,
                    background: pickingActive ? "var(--accent)" : undefined,
                    color: pickingActive ? "#fff" : "var(--text-2)",
                    borderColor: pickingActive ? "var(--accent)" : undefined,
                }}
            >↗</button>
        </div>
    );
}