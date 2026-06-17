// src/utils/flowSeedExport.ts
//
// Pure builders for exporting selected flows to the TwilioIVREngine seed
// pipeline. No DOM/network access (download + DDB reads live in the panel) so
// these stay unit-testable. The serializer mirrors export_flows.py's
// json.dumps(item, sort_keys=True): recursively sorted keys, ", "/": "
// separators, ensure_ascii (non-ASCII escaped). This keeps the converter's
// seed.jsonl byte-compatible with the Python exporter for clean git diffs.

/** A raw DynamoDB row as stored/exported (content is a nested object). */
export type SeedRow = Record<string, unknown>;

function encodeString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20) out += "\\u" + code.toString(16).padStart(4, "0");
    else if (code < 0x80) out += ch;
    else if (code > 0xffff) {
      const u = code - 0x10000;
      const hi = 0xd800 + (u >> 10);
      const lo = 0xdc00 + (u & 0x3ff);
      out += "\\u" + hi.toString(16).padStart(4, "0") + "\\u" + lo.toString(16).padStart(4, "0");
    } else {
      out += "\\u" + code.toString(16).padStart(4, "0");
    }
  }
  return out + '"';
}

export function pythonJsonDumps(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return encodeString(value);
  if (Array.isArray(value)) return "[" + value.map(pythonJsonDumps).join(", ") + "]";
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return "{" + keys.map((k) => encodeString(k) + ": " + pythonJsonDumps(obj[k])).join(", ") + "}";
  }
  throw new Error(`pythonJsonDumps: cannot serialize ${typeof value}`);
}
