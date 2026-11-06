import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redact } from "./redact.mjs";
import {
  acceptUserText,
  createSessionBook,
  latestSession,
  noteEvent,
  queueFollowup,
  serializeBook,
  sessionLines,
} from "./sessions.mjs";
import { startHttp } from "./server.mjs";
import { createWhatsApp } from "./whatsapp.mjs";
import { PAIR_PATH, STATE_DIR, STATE_PATH } from "./paths.mjs";

const PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makePairCode() {
  const bytes = randomBytes(4);
  return `cursor-${[...bytes].map((byte) => PAIR_ALPHABET[byte % PAIR_ALPHABET.length]).join("")}`;
}

const HELP = [
  "Cursor bridge",
  "Reply in this chat to answer a waiting question.",
  "If nothing is waiting, the reply is sent into the current Cursor chat when that turn ends.",
  "status — link and sessions",
  "pause / resume — progress texts",
  "sessions — recent chats",
  "run — continue an idle chat in the terminal agent",
].join("\n");

function agentBinary() {
  const candidates = [
    process.env.CURSOR_AGENT_BIN,
    join(homedir(), ".local", "bin", "agent"),
    join(homedir(), ".local", "bin", "cursor-agent"),
    "/usr/local/bin/agent",
    "/opt/homebrew/bin/agent",
  ].filter(Boolean);
  return candidates.find((path) => existsSync(path)) || null;
}

async function loadBook() {
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    return createSessionBook(JSON.parse(raw));
  } catch {
    return createSessionBook();
  }
}

export async function startBridge({ port, token, log = console.log }) {
  await mkdir(STATE_DIR, { recursive: true });
  const book = await loadBook();
  if (!book.pairCode) book.pairCode = makePairCode();
  let saveTimer = null;
  const asks = [];
  let askSeq = 0;
  const sentAt = [];
  let rateWarned = false;
  let runningAgent = false;
  const outboundQueue = [];

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const tmp = `${STATE_PATH}.tmp`;
      await writeFile(tmp, JSON.stringify(serializeBook(book), null, 2), { mode: 0o600 });
      await rename(tmp, STATE_PATH);
    }, 200);
  }

  async function publishPairCode() {
    if (book.ownerPn || book.ownerLid) {
      await rm(PAIR_PATH, { force: true });
      return;
    }
    await writeFile(PAIR_PATH, `${book.pairCode}\n`, { mode: 0o600 });
  }

  const whatsapp = createWhatsApp({
    log: (line) => log(line),
    route: () => ({ ownerPn: book.ownerPn, ownerLid: book.ownerLid, pairCode: book.pairCode }),
    onLink: async (state) => {
      log(`link ${state}`);
      if (state !== "linked" || !whatsapp.hasPeer()) return;
      await flushQueue();
    },
    onPair: async (peer) => {
      book.ownerPn = peer?.pn || book.ownerPn;
      book.ownerLid = peer?.lid || book.ownerLid;
      persist();
      await publishPairCode();
      await whatsapp.send("This chat is Cursor.\nYour notes stay in this thread.\nReply status to confirm.");
      await flushQueue();
    },
    onText: (text) => {
      handleIncoming(text).catch((error) => log(`incoming failed: ${error.message}`));
    },
  });

  async function flushQueue() {
    while (outboundQueue.length && whatsapp.hasPeer()) {
      const next = outboundQueue.shift();
      await whatsapp.send(next).catch(() => {});
    }
  }

  async function deliver(text, { priority = false, max = 900 } = {}) {
    const body = redact(text, max);
    if (!body) return false;
    if (!priority && !allowProgress()) return false;
    if (whatsapp.status() !== "linked" || !whatsapp.hasPeer()) {
      outboundQueue.push(body);
      if (outboundQueue.length > 20) outboundQueue.shift();
      return false;
    }
    return whatsapp.send(body);
  }

  function allowProgress() {
    const now = Date.now();
    while (sentAt.length && now - sentAt[0] > 10 * 60 * 1000) sentAt.shift();
    if (sentAt.length >= 15) {
      if (!rateWarned) {
        rateWarned = true;
        deliver("Cursor is quiet for a few minutes. Too many updates.", { priority: true }).catch(() => {});
      }
      return false;
    }
    rateWarned = false;
    sentAt.push(now);
    return true;
  }

  function resolveOldestAsk(answer) {
    const ask = asks.shift();
    if (!ask) return false;
    clearTimeout(ask.timer);
    ask.resolve(answer);
    const next = asks[0];
    if (next) promptAsk(next).catch(() => {});
    return true;
  }

  async function promptAsk(ask) {
    const session = latestSession(book);
    const where = session?.workspace || "Cursor";
    await deliver(`Cursor needs an answer\n${where}\n${redact(ask.question, 500)}\n\nReply in this chat.`, {
      priority: true,
    });
  }

  async function enqueueAsk(question, timeoutMs) {
    const clean = redact(question, 500);
    if (!clean) {
      return { status: 400, body: { error: "empty_question" } };
    }
    const answer = await new Promise((resolve) => {
      const ask = { id: ++askSeq, question: clean, resolve };
      ask.timer = setTimeout(() => {
        const index = asks.indexOf(ask);
        if (index >= 0) asks.splice(index, 1);
        resolve(null);
      }, timeoutMs);
      asks.push(ask);
      if (asks.length === 1) promptAsk(ask).catch(() => {});
    });
    if (!answer) return { status: 504, body: { error: "timeout" } };
    return { status: 200, body: { answer } };
  }

  async function runAgent(prompt) {
    if (runningAgent) {
      await deliver("A terminal agent is already running.", { priority: true });
      return;
    }
    const bin = agentBinary();
    const session = latestSession(book);
    if (!bin) {
      await deliver(
        "Cursor's terminal agent is not installed, so an idle chat cannot be continued from WhatsApp yet. Replies still answer waiting questions, and they still continue a chat that is running.",
        { priority: true },
      );
      return;
    }
    if (!session?.root) {
      await deliver("No Cursor workspace yet. Start a chat on the Mac first.", { priority: true });
      return;
    }
    runningAgent = true;
    const text = redact(prompt || book.pending?.text || "Continue the current task.", 1500);
    await deliver(`Starting terminal agent\n${session.workspace}`, { priority: true });
    const args = ["-p", "--trust", "--workspace", session.root, "--output-format", "text"];
    if (session.id && session.id !== "unknown") args.push("--resume", session.id);
    args.push(text);
    const child = spawn(bin, args, { cwd: session.root, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const take = (chunk) => {
      if (output.length < 20_000) output += chunk.toString("utf8");
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => child.kill("SIGTERM"), 10 * 60 * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      runningAgent = false;
      const excerpt = redact(output, 400) || `Terminal agent exited (${code ?? "unknown"}).`;
      deliver(`Terminal agent finished\n${session.workspace}\n${excerpt}`, { priority: true }).catch(() => {});
    });
  }

  async function handleIncoming(text) {
    const action = acceptUserText(book, text);
    if (action.kind === "empty") return;
    if (action.kind === "command") {
      if (action.name === "help") await deliver(HELP, { priority: true });
      else if (action.name === "pause") {
        book.paused = true;
        persist();
        await deliver("Progress texts paused. Questions still come through.", { priority: true });
      } else if (action.name === "resume") {
        book.paused = false;
        persist();
        await deliver("Progress texts resumed.", { priority: true });
      } else if (action.name === "status") {
        const session = latestSession(book);
        await deliver(
          `Link: ${whatsapp.status()}\nProgress texts: ${book.paused ? "paused" : "on"}\nWaiting questions: ${asks.length}\nLatest: ${session ? `${session.workspace} · ${session.idle ? "idle" : "running"}` : "none"}`,
          { priority: true },
        );
      } else if (action.name === "sessions") {
        await deliver(sessionLines(book), { priority: true });
      } else if (action.name === "run") {
        await runAgent(action.args);
      }
      return;
    }
    if (resolveOldestAsk(action.text)) return;
    const pending = queueFollowup(book, action.text);
    persist();
    const idleNote = pending.idle
      ? "\nThat chat is idle, so this waits until Cursor is running again."
      : "\nThe answer will come back to this chat.";
    await deliver(`Saved for ${pending.workspace}.${idleNote}`, { priority: true });
  }

  const server = await startHttp({
    port,
    token,
    health: () => ({
      ok: true,
      link: whatsapp.status(),
      paired: Boolean(book.ownerPn || book.ownerLid),
      paused: book.paused,
      pendingAsks: asks.length,
      latestWorkspace: latestSession(book)?.workspace || null,
    }),
    onEvent: async (event) => {
      const result = noteEvent(book, event);
      persist();
      if (result.text) {
        await deliver(result.text, { priority: Boolean(result.priority), max: result.priority ? 3200 : 900 }).catch(
          () => {},
        );
      }
      return result.followup ? { followup_message: result.followup } : {};
    },
    onAsk: (body) => {
      const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 8 * 60 * 1000, 15_000), 15 * 60 * 1000);
      return enqueueAsk(body.question, timeoutMs);
    },
    onNotify: async (body) => {
      const text = redact(body.message, 300);
      if (!text) return { status: 400, body: { error: "empty_message" } };
      await deliver(`Cursor\n${text}`, { priority: true });
      return { status: 200, body: { ok: true } };
    },
  });

  await publishPairCode();
  persist();
  whatsapp.connect().catch((error) => log(`whatsapp failed: ${error.message}`));
  log(`listening on 127.0.0.1:${port}`);
  return { server, whatsapp, book };
}
