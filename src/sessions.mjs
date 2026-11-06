import { redact } from "./redact.mjs";

const COMMANDS = new Set(["help", "status", "pause", "resume", "sessions", "run"]);
const COMMAND_ALIASES = new Map([["stats", "status"]]);

export function workspaceLabel(root) {
  if (!root || typeof root !== "string") return "Cursor";
  const parts = root.split("/").filter(Boolean);
  return parts.at(-1) || "Cursor";
}

export function createSessionBook(saved = {}) {
  const byId = new Map(Object.entries(saved.sessions || {}));
  return {
    paused: Boolean(saved.paused),
    latestId: saved.latestId || null,
    byId,
    pending: saved.pending || null,
    ownerPn: saved.ownerPn || null,
    ownerLid: saved.ownerLid || null,
    pairCode: saved.pairCode || null,
  };
}

export function serializeBook(book) {
  return {
    paused: book.paused,
    latestId: book.latestId,
    pending: book.pending,
    ownerPn: book.ownerPn,
    ownerLid: book.ownerLid,
    pairCode: book.pairCode,
    sessions: Object.fromEntries(book.byId),
  };
}

function touch(book, id, patch) {
  if (!id) return null;
  const prev = book.byId.get(id) || { id, workspace: "Cursor", root: "", idle: false };
  const next = { ...prev, ...patch, id, updatedAt: Date.now() };
  book.byId.set(id, next);
  book.latestId = id;
  if (book.byId.size > 20) {
    const oldest = [...book.byId.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (oldest && oldest.id !== id) book.byId.delete(oldest.id);
  }
  return next;
}

export function latestSession(book) {
  if (!book.latestId) return null;
  return book.byId.get(book.latestId) || null;
}

export function noteEvent(book, event) {
  const name = event.hook_event_name;
  const id = event.conversation_id || "unknown";
  const root = event.workspace_root || "";
  const workspace = event.workspace_name || workspaceLabel(root);
  const session = touch(book, id, {
    workspace,
    root: root || book.byId.get(id)?.root || "",
    idle: name === "stop" || name === "sessionEnd",
    mode: event.composer_mode || book.byId.get(id)?.mode,
  });

  if (book.paused && name !== "postToolUseFailure") {
    return { text: null, followup: null, session };
  }

  let text = null;
  if (name === "sessionStart") {
    text = `Cursor started\n${workspace} · ${event.composer_mode || "agent"}`;
  } else if (name === "stop") {
    text = `Cursor finished\n${workspace} · ${event.status || "completed"}\nReply here to send a follow-up.`;
  } else if (name === "sessionEnd") {
    const reason = event.reason || "ended";
    if (reason === "completed") text = null;
    else text = `Cursor session ended\n${workspace} · ${reason}`;
  } else if (name === "postToolUseFailure" && event.failure_type === "permission_denied") {
    const tool = event.tool_name || "tool";
    text = `Cursor needs you\n${workspace}\n${tool} is waiting for approval on the Mac.`;
  }

  let followup = null;
  if (name === "stop" && book.pending && (!book.pending.conversationId || book.pending.conversationId === id)) {
    followup = book.pending.text;
    book.pending = null;
  }

  return { text, followup, session };
}

export function acceptUserText(book, raw) {
  const text = String(raw || "").trim();
  if (!text) return { kind: "empty" };
  const [head, ...rest] = text.split(/\s+/);
  const command = COMMAND_ALIASES.get(head.toLowerCase()) || head.toLowerCase();
  if (COMMANDS.has(command) && text.length < 500) {
    return { kind: "command", name: command, args: rest.join(" ").trim(), text };
  }
  return { kind: "message", text };
}

export function queueFollowup(book, text) {
  const session = latestSession(book);
  book.pending = {
    conversationId: session?.id || null,
    text: text.slice(0, 2000),
    workspace: session?.workspace || "Cursor",
    idle: Boolean(session?.idle),
  };
  return book.pending;
}

export function decideInbound({ peerPn, peerLid, selfPn, selfLid, ownerPn, ownerLid, text, pairCode }) {
  const peer = peerPn || peerLid;
  if (!peer) return "ignore";
  const isSelf =
    (selfPn && (peerPn === selfPn || peerLid === selfPn)) || (selfLid && (peerPn === selfLid || peerLid === selfLid));
  if (isSelf) return "ignore";
  const isOwner =
    (ownerPn && (peerPn === ownerPn || peerLid === ownerPn)) || (ownerLid && (peerPn === ownerLid || peerLid === ownerLid));
  if (!ownerPn && !ownerLid) {
    return text.trim().toLowerCase() === String(pairCode || "").trim().toLowerCase() ? "pair" : "ignore";
  }
  return isOwner ? "accept" : "ignore";
}

export function sessionLines(book) {
  const rows = [...book.byId.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);
  if (!rows.length) return "No Cursor session yet.";
  return rows.map((row) => `${row.idle ? "idle" : "running"} · ${row.workspace}`).join("\n");
}
