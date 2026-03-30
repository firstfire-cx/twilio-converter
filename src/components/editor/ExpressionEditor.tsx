// src/components/editor/ExpressionEditor.tsx
const KEYWORDS = new Set(["and", "or", "not", "True", "False", "None", "in", "is"]);
const RESERVED_PYTHON = /^(and|or|not|True|False|None|in|is)$/;

interface ExprToken {
    text: string;
    kind: "var" | "keyword" | "op" | "string" | "number" | "paren" | "unknown";
}

function tokenizeExpression(expr: string): ExprToken[] {
    if (!expr) return [];
    const tokens: ExprToken[] = [];
    const re =
        /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\\b\d+\\.?\d*\\b)|(==|!=|>=|<=|>|<|&&|\|\||&|\|)|([\w]+)|([(){}[\]])|([^\s\w"'<>=!&|()\[\]{}]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(expr)) !== null) {
        const [full, str, num, op, word, paren] = m;
        if (str) tokens.push({ text: full, kind: "string" });
        else if (num) tokens.push({ text: full, kind: "number" });
        else if (op) tokens.push({ text: full, kind: "op" });
        else if (paren) tokens.push({ text: full, kind: "paren" });
        else if (word) tokens.push({ text: full, kind: KEYWORDS.has(word.toLowerCase()) ? "keyword" : "var" });
        else tokens.push({ text: m[0], kind: "unknown" });
    }
    return tokens;
}

interface Props {
    value: string;
    onChange: (v: string) => void;
    knownVars: string[];
    placeholder?: string;
}

export default function ExpressionEditor({ value, onChange, knownVars, placeholder }: Props) {
    const tokens = tokenizeExpression(value);
    const vars = tokens.filter((t) => t.kind === "var").map((t) => t.text);
    const unknownVars = vars.filter(
        (v) => !knownVars.includes(v) && !RESERVED_PYTHON.test(v) && !/^\d+(\.\d+)?$/.test(v),
    );

    return (
        <div>
            <textarea
                className="input"
                style={{ minHeight: 64, fontFamily: "'IBM Plex Mono', monospace", fontSize: 12 }}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder ?? "e.g. Lang == 'spa'  or  RetryCount >= 3"}
                spellCheck={false}
            />

            {value && (
                <div style={{
                    marginTop: 6, display: "flex", flexWrap: "wrap", gap: "3px",
                    background: "var(--bg-0)", border: "1px solid var(--border)",
                    borderRadius: "var(--radius)", padding: "6px 8px",
                }}>
                    {tokens.map((t, i) => {
                        const isNumericLiteral = /^\d+(\.\d+)?$/.test(t.text);
                        const isUnknown =
                            t.kind === "var" && !isNumericLiteral &&
                            !knownVars.includes(t.text) && !RESERVED_PYTHON.test(t.text);
                        const color =
                            t.kind === "var"
                                ? isNumericLiteral ? "#b5cea8"
                                    : knownVars.includes(t.text) ? "var(--cyan)"
                                        : "var(--orange)"
                                : t.kind === "string" ? "var(--green)"
                                    : t.kind === "number" ? "#b5cea8"
                                        : t.kind === "keyword" ? "var(--purple)"
                                            : t.kind === "op" ? "var(--accent)"
                                                : "var(--text-2)";
                        return (
                            <span key={i} style={{
                                fontFamily: "'IBM Plex Mono', monospace", fontSize: 11,
                                color, padding: "1px 3px", borderRadius: 2,
                                background: isUnknown ? "rgba(232,149,90,0.1)" : "transparent",
                            }}>
                                {t.text}
                            </span>
                        );
                    })}
                </div>
            )}

            {unknownVars.length > 0 && (
                <div style={{ marginTop: 5, fontSize: 10, color: "var(--orange)", fontFamily: "'IBM Plex Mono', monospace", lineHeight: 1.6 }}>
                    ⚠ Unknown vars: <b>{unknownVars.join(", ")}</b> — evaluates as False if not in state
                </div>
            )}

            {vars.length > 0 && (
                <div style={{ marginTop: 3, fontSize: 10, color: "var(--text-3)", fontFamily: "'IBM Plex Mono', monospace" }}>
                    <span style={{ color: "var(--cyan)" }}>■</span> cyan = known &nbsp;
                    <span style={{ color: "var(--orange)" }}>■</span> orange = unrecognised &nbsp;
                    <span style={{ color: "var(--green)" }}>■</span> string literal
                </div>
            )}
        </div>
    );
}