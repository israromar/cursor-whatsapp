import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const TOOL_ROOT = dirname(here);
export const STATE_DIR = join(homedir(), ".cursor-whatsapp");
export const CONFIG_PATH = join(STATE_DIR, "config.json");
export const AUTH_DIR = join(STATE_DIR, "auth");
export const STATE_PATH = join(STATE_DIR, "state.json");
export const QR_PATH = join(STATE_DIR, "qr.png");
export const PAIR_PATH = join(STATE_DIR, "pair-code");
export const HOOK_SCRIPT = join(TOOL_ROOT, "hooks", "on-event.mjs");
export const MCP_SCRIPT = join(TOOL_ROOT, "src", "mcp.mjs");
export const CLI_SCRIPT = join(TOOL_ROOT, "src", "cli.mjs");
export const LAUNCH_LABEL = "com.cursor-whatsapp.bridge";
export const LAUNCH_PLIST = join(homedir(), "Library", "LaunchAgents", `${LAUNCH_LABEL}.plist`);
export const DEFAULT_PORT = 4777;

export const SESSION_CONTEXT = [
  "A personal WhatsApp bridge is connected for this Mac.",
  "When you need a decision, confirmation, or you are blocked, call the cursor-whatsapp MCP tool `ask` and wait for the reply.",
  "Use `notify` only for a one-line status.",
  "Never send secrets, patient data, file contents, diffs, or logs through ask or notify.",
  "If the WhatsApp tool fails, ask in the Cursor chat instead.",
].join(" ");
