#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { hookOutput } from "../src/hook-output.mjs";
import { CONFIG_PATH } from "../src/paths.mjs";
import { redact } from "../src/redact.mjs";
import { workspaceLabel } from "../src/sessions.mjs";

function reduce(input) {
  const root = Array.isArray(input.workspace_roots) ? input.workspace_roots[0] : "";
  const event = {
    hook_event_name: input.hook_event_name,
    conversation_id: input.conversation_id || input.session_id,
    workspace_root: typeof root === "string" ? root : "",
    workspace_name: workspaceLabel(typeof root === "string" ? root : ""),
    composer_mode: input.composer_mode,
    status: input.status,
    reason: input.reason,
    subagent_type: input.subagent_type,
    failure_type: input.failure_type,
    tool_name: input.tool_name,
  };
  if (input.hook_event_name === "afterAgentResponse") {
    event.excerpt = redact(input.text, 3200);
  }
  return event;
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  const input = raw ? JSON.parse(raw) : {};
  const eventName = input.hook_event_name;
  let serverBody = null;
  try {
    const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
    const response = await fetch(`http://127.0.0.1:${config.port}/event`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(reduce(input)),
      signal: AbortSignal.timeout(1500),
    });
    if (response.ok) serverBody = await response.json();
  } catch {
    serverBody = null;
  }
  process.stdout.write(JSON.stringify(hookOutput(eventName, serverBody)));
}

main()
  .catch(() => {
    process.stdout.write("{}");
  })
  .finally(() => {
    process.exit(0);
  });
