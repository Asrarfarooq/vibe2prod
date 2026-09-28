const SUMMARY_FIELD = /"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/;

export interface Structured {
  body: string;
  summary: string | null;
  parsed: boolean;
}

/** JSON-looking agent output: pretty body plus its "summary" field; truncated JSON falls back to the raw text. */
export function structured(text: string): Structured | null {
  const t = text.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return null;
  try {
    const v: unknown = JSON.parse(t);
    const summary = v && typeof v === "object" && typeof (v as { summary?: unknown }).summary === "string" ? (v as { summary: string }).summary : null;
    return { body: JSON.stringify(v, null, 2), summary, parsed: true };
  } catch {
    const m = SUMMARY_FIELD.exec(t);
    return { body: t, summary: m ? decodeJsonString(m[1]) : null, parsed: false };
  }
}

function decodeJsonString(s: string): string {
  try {
    return JSON.parse(`"${s}"`) as string;
  } catch {
    return s;
  }
}
