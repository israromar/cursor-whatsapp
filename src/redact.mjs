const SECRET =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,}|Bearer\s+\S{8,})\b/gi;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/g;
const LONG_NUMBER = /\b\d{6,}\b/g;
const HOME = /\/Users\/[^/\s]+/g;
const FENCE = /```[\s\S]*?```/g;
const LONG_TICK = /`[^`]{40,}`/g;

export function redact(value, max = 180) {
  let text = String(value ?? "");
  const diffLines = text.split("\n").filter((line) => /^(diff --git|\+\+\+|---|\+\+|@@)/.test(line));
  if (diffLines.length >= 2) return "Diff omitted.";

  text = text
    .replace(FENCE, " [code omitted] ")
    .replace(LONG_TICK, " [code] ")
    .replace(SECRET, "[secret]")
    .replace(EMAIL, "[email]")
    .replace(PHONE, "[phone]")
    .replace(LONG_NUMBER, "[number]")
    .replace(HOME, "~");

  text = text.replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length > max) text = `${text.slice(0, max - 1).trim()}…`;
  return text;
}
