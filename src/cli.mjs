#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { appendFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startBridge } from "./bridge.mjs";
import { clearAuth } from "./whatsapp.mjs";
import {
  CLI_SCRIPT,
  CONFIG_PATH,
  DEFAULT_PORT,
  HOOK_SCRIPT,
  LAUNCH_LABEL,
  LAUNCH_PLIST,
  MCP_SCRIPT,
  STATE_DIR,
} from "./paths.mjs";

const HOOK_EVENTS = [
  "sessionStart",
  "sessionEnd",
  "stop",
  "afterAgentResponse",
  "subagentStart",
  "subagentStop",
  "postToolUseFailure",
];
const HOOKS_PATH = join(homedir(), ".cursor", "hooks.json");
const MCP_PATH = join(homedir(), ".cursor", "mcp.json");

function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: stdout?.trim() || "", stderr: stderr?.trim() || "", error });
    });
  });
}

async function ensureConfig() {
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  await chmod(STATE_DIR, 0o700);
  if (!existsSync(CONFIG_PATH)) {
    const config = {
      port: DEFAULT_PORT,
      token: randomBytes(24).toString("hex"),
      nodePath: process.execPath,
    };
    await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  }
  await chmod(CONFIG_PATH, 0o600);
  return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
}

async function installHooks(nodePath) {
  let config = { version: 1, hooks: {} };
  if (existsSync(HOOKS_PATH)) {
    config = JSON.parse(await readFile(HOOKS_PATH, "utf8"));
    config.version = 1;
    config.hooks ||= {};
  }
  const command = `${nodePath} ${HOOK_SCRIPT}`;
  for (const event of HOOK_EVENTS) {
    const existing = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
    const kept = existing.filter((hook) => !String(hook.command || "").includes("cursor-whatsapp/hooks/on-event.mjs"));
    const entry = { command, timeout: 5 };
    if (event === "stop") entry.loop_limit = 10;
    config.hooks[event] = [...kept, entry];
  }
  await writeFile(HOOKS_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

async function removeHooks() {
  if (!existsSync(HOOKS_PATH)) return;
  const config = JSON.parse(await readFile(HOOKS_PATH, "utf8"));
  for (const event of Object.keys(config.hooks || {})) {
    config.hooks[event] = config.hooks[event].filter(
      (hook) => !String(hook.command || "").includes("cursor-whatsapp/hooks/on-event.mjs"),
    );
    if (config.hooks[event].length === 0) delete config.hooks[event];
  }
  await writeFile(HOOKS_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

async function installMcp(nodePath) {
  const config = existsSync(MCP_PATH) ? JSON.parse(await readFile(MCP_PATH, "utf8")) : { mcpServers: {} };
  config.mcpServers ||= {};
  config.mcpServers["cursor-whatsapp"] = { command: nodePath, args: [MCP_SCRIPT] };
  await writeFile(MCP_PATH, `${JSON.stringify(config, null, 2)}\n`);
  return "ready";
}

async function removeMcp() {
  if (!existsSync(MCP_PATH)) return;
  const config = JSON.parse(await readFile(MCP_PATH, "utf8"));
  if (config.mcpServers) delete config.mcpServers["cursor-whatsapp"];
  await writeFile(MCP_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

function plist(nodePath) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${CLI_SCRIPT}</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${homedir()}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${join(STATE_DIR, "bridge.log")}</string>
  <key>StandardErrorPath</key>
  <string>${join(STATE_DIR, "bridge.err.log")}</string>
</dict>
</plist>
`;
}

async function installService(nodePath) {
  await mkdir(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  await writeFile(LAUNCH_PLIST, plist(nodePath));
  const domain = `gui/${process.getuid()}`;
  await run("launchctl", ["bootout", domain, LAUNCH_PLIST]);
  const started = await run("launchctl", ["bootstrap", domain, LAUNCH_PLIST]);
  if (!started.ok) throw new Error(started.stderr || "Could not start the background service.");
  await run("launchctl", ["enable", `${domain}/${LAUNCH_LABEL}`]);
}

async function uninstallService() {
  const domain = `gui/${process.getuid()}`;
  await run("launchctl", ["bootout", domain, LAUNCH_PLIST]);
  if (existsSync(LAUNCH_PLIST)) {
    const { unlink } = await import("node:fs/promises");
    await unlink(LAUNCH_PLIST);
  }
}

async function health(config) {
  const response = await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(1500) });
  if (!response.ok) throw new Error("unhealthy");
  return response.json();
}

const [command = "help"] = process.argv.slice(2);

if (command === "start") {
  const config = await ensureConfig();
  try {
    await health(config);
    console.log("Bridge is already running.");
    process.exit(0);
  } catch {
    await startBridge({
    port: config.port,
    token: config.token,
    log: (line) => {
      console.log(line);
      appendFileSync(join(STATE_DIR, "bridge.log"), `${new Date().toISOString()} ${line}\n`);
    },
  });
  }
} else if (command === "install") {
  const config = await ensureConfig();
  await installHooks(config.nodePath || process.execPath);
  const mcp = await installMcp(config.nodePath || process.execPath);
  await installService(config.nodePath || process.execPath);
  console.log(`Installed user hooks, WhatsApp tool (${mcp}), and the background service.`);
  console.log("Open WhatsApp Business → Settings → Linked devices → Link a device.");
  console.log("Scan ~/.cursor-whatsapp/qr.png, then send the code in ~/.cursor-whatsapp/pair-code");
  console.log("from your personal WhatsApp to that business number.");
} else if (command === "status") {
  const config = await ensureConfig();
  try {
    const body = await health(config);
    console.log(
      `Link: ${body.link}\nChat: ${body.paired ? "paired with your personal WhatsApp" : "waiting for the pairing code"}\nProgress texts: ${body.paused ? "paused" : "on"}\nWaiting questions: ${body.pendingAsks}\nLatest workspace: ${body.latestWorkspace || "none"}`,
    );
  } catch {
    console.log("Bridge is not running. Start it with: node src/cli.mjs install");
    process.exit(1);
  }
} else if (command === "unlink") {
  await clearAuth();
  const domain = `gui/${process.getuid()}`;
  await run("launchctl", ["kickstart", "-k", `${domain}/${LAUNCH_LABEL}`]);
  console.log("Removed the linked WhatsApp session. Scan the new QR when it opens.");
} else if (command === "uninstall") {
  await removeHooks();
  await removeMcp();
  await uninstallService();
  console.log("Removed the Cursor hooks, WhatsApp tool, and background service.");
  console.log("The link session in ~/.cursor-whatsapp was left in place.");
} else {
  console.log(`Usage:
  node src/cli.mjs install
  node src/cli.mjs status
  node src/cli.mjs unlink
  node src/cli.mjs uninstall`);
}
