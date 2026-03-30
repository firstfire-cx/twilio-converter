// src/components/editor/SipHeaderRow.tsx
import { useState, useEffect } from "react";

interface Props {
    headerKey: string;
    value: string;
    onRenameKey: (oldKey: string, newKey: string) => void;
    onChangeValue: (key: string, value: string) => void;
    onRemove: (key: string) => void;
}

// Every row is identical — no concept of "default" vs "custom".
// Local state on the key field prevents stale-closure bugs during rename.
export default function SipHeaderRow({ headerKey, value, onRenameKey, onChangeValue, onRemove }: Props) {
    const [localKey, setLocalKey] = useState(headerKey);
    useEffect(() => setLocalKey(headerKey), [headerKey]);

    const commitRename = () => {
        const trimmed = localKey.trim();
        if (!trimmed) { setLocalKey(headerKey); return; } // revert if blanked
        if (trimmed !== headerKey) onRenameKey(headerKey, trimmed);
    };

    return (
        <div className="branch-row">
            <div className="branch-key-row">
                <span className="branch-key-label">hdr</span>
                <input
                    className="branch-key-input"
                    value={localKey}
                    onChange={(e) => setLocalKey(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => e.key === "Enter" && commitRename()}
                    spellCheck={false}
                />
                <button
                    className="btn btn-ghost btn-danger"
                    onClick={() => onRemove(headerKey)}
                    style={{ padding: "1px 5px", height: 20, fontSize: 14, marginLeft: "auto" }}
                >×</button>
            </div>
            <div className="branch-target-row">
                <span className="branch-target-label">=</span>
                <input
                    className="input"
                    style={{ flex: 1, padding: "4px 8px" }}
                    value={value}
                    onChange={(e) => onChangeValue(headerKey, e.target.value)}
                    placeholder="value or {{variable}}"
                    spellCheck={false}
                />
            </div>
        </div>
    );
}