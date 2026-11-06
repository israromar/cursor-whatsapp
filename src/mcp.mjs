#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { CONFIG_PATH } from "./paths.mjs";

const tools = [
  {
    name: "ask",
    description:
      "Ask the user on WhatsApp and wait for their reply. Use this for a decision or when you are blocked. Do not include secrets, patient data, file contents, diffs, or logs.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string" },
        timeout_minutes: { type: "number" },
      },
      required: ["question"],
    },
  },
  {
    name: "notify",
    description:
      "Send a one-line status to the user's WhatsApp. Do not include secrets, patient data, file contents, diffs, or logs.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string" },
      },
      required: ["message"],
    },
  },
];

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function loadConfig() {
  const raw = await readFile(CONFIG_PATH, "utf8");
  return JSON.parse(raw);
}

async function post(path, body, timeoutMs) {
  const config = await loadConfig();
  const response = await fetch(`http://127.0.0.1:${config.port}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, payload };
}

function toolResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

async function callTool(name, args) {
  try {
    if (name === "ask") {
      const minutes = Number(args.timeout_minutes) || 8;
      const timeoutMs = Math.min(Math.max(minutes, 1), 15) * 60 * 1000;
      const result = await post("/ask", { question: args.question, timeoutMs }, timeoutMs + 10_000);
      if (result.status === 504) return toolResult("The user did not answer on WhatsApp in time. Ask in the Cursor chat.", true);
      if (!result.ok) return toolResult("WhatsApp bridge could not send the question.", true);
      return toolResult(result.payload.answer || "The user replied with an empty message.");
    }
    if (name === "notify") {
      const result = await post("/notify", { message: args.message }, 10_000);
      if (!result.ok) return toolResult("WhatsApp bridge could not send the status.", true);
      return toolResult("Sent.");
    }
    return toolResult(`Unknown tool ${name}.`, true);
  } catch {
    return toolResult("WhatsApp bridge is not running on this Mac.", true);
  }
}

async function handle(message) {
  if (!message || message.jsonrpc !== "2.0") return;
  const { id, method, params } = message;
  if (method === "notifications/initialized" || method === "initialized") return;
  if (id === undefined) return;

  if (method === "initialize") {
    writeMessage({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "cursor-whatsapp", version: "0.1.0" },
        instructions:
          "When you need a decision or you are blocked, call ask and wait. Use notify only for a one-line status. Never send secrets, patient data, file contents, diffs, or logs. If ask fails, ask in the Cursor chat.",
      },
    });
    return;
  }
  if (method === "tools/list") {
    writeMessage({ jsonrpc: "2.0", id, result: { tools } });
    return;
  }
  if (method === "ping") {
    writeMessage({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/call") {
    const result = await callTool(params?.name, params?.arguments || {});
    writeMessage({ jsonrpc: "2.0", id, result });
    return;
  }
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: "Method not found" },
  });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      try {
        handle(JSON.parse(line));
      } catch {
        writeMessage({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      }
    }
    newline = buffer.indexOf("\n");
  }
});
