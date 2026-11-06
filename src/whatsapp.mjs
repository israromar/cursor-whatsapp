import { mkdir, rm, writeFile } from "node:fs/promises";
import pino from "pino";
import QRCode from "qrcode";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isLidUser,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import { AUTH_DIR, QR_PATH } from "./paths.mjs";
import { decideInbound } from "./sessions.mjs";

const logger = pino({ level: "silent" });
let consolePatched = false;

function silenceSessionDumps(log) {
  if (consolePatched) return;
  consolePatched = true;
  const info = console.info.bind(console);
  const warn = console.warn.bind(console);
  const error = console.error.bind(console);
  const textOf = (value) => (typeof value === "string" ? value : value instanceof Error ? value.message : "");
  console.info = (...args) => {
    if (textOf(args[0]).startsWith("Closing session")) return;
    info(...args);
  };
  console.warn = (...args) => {
    if (textOf(args[0]).startsWith("Session already")) return;
    warn(...args);
  };
  console.error = (...args) => {
    const text = textOf(args[0]);
    if (text.includes("Bad MAC") || text.includes("Failed to decrypt") || text.startsWith("Session error:")) {
      log?.("whatsapp could not read one message");
      return;
    }
    error(...args);
  };
}

function jidKind(jid = "") {
  if (jid.endsWith("@g.us")) return "group";
  if (jid.endsWith("@lid")) return "lid";
  if (jid.endsWith("@s.whatsapp.net")) return "phone";
  if (jid === "status@broadcast") return "status";
  return "other";
}

function messageText(message) {
  if (!message) return "";
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    ""
  );
}

export function createWhatsApp({ onText, onLink, onPair, route, log }) {
  silenceSessionDumps(log);
  let sock = null;
  let selfPn = null;
  let selfLid = null;
  let link = "connecting";
  let reconnectTimer = null;
  let stopped = false;
  const outboundIds = new Set();
  const outboundText = new Map();
  const messageCache = new Map();
  let openedQr = false;

  function isEcho(id, text) {
    if (id && outboundIds.has(id)) return true;
    const expires = outboundText.get(text);
    if (!expires) return false;
    if (expires < Date.now()) {
      outboundText.delete(text);
      return false;
    }
    return true;
  }

  async function isSelf(key) {
    if (!selfPn || !key) return false;
    const candidates = [key.remoteJid, key.remoteJidAlt, key.participant].filter(Boolean);
    for (const jid of candidates) {
      let normalized = "";
      try {
        normalized = jidNormalizedUser(jid);
      } catch {
        continue;
      }
      if (normalized === selfPn || (selfLid && normalized === selfLid)) return true;
      if (isLidUser(jid)) {
        try {
          const pn = await sock?.signalRepository?.lidMapping?.getPNForLID?.(jid);
          if (pn && jidNormalizedUser(pn) === selfPn) return true;
        } catch {
          continue;
        }
      }
    }
    return false;
  }

  async function showQr(qr) {
    link = "qr";
    await mkdir(AUTH_DIR, { recursive: true });
    await QRCode.toFile(QR_PATH, qr, { width: 420, margin: 2 });
    onLink?.("qr");
    if (!openedQr) {
      openedQr = true;
      const { spawn } = await import("node:child_process");
      spawn("open", [QR_PATH], { detached: true, stdio: "ignore" }).unref();
    }
  }

  async function connect() {
    if (stopped) return;
    await mkdir(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {
      version = undefined;
    }
    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      logger,
      printQRInTerminal: false,
      browser: Browsers.macOS("Cursor"),
      markOnlineOnConnect: true,
      syncFullHistory: false,
      getMessage: async (key) => messageCache.get(key.id),
      shouldIgnoreJid: (jid) => jid.endsWith("@g.us") || jid === "status@broadcast" || jid.endsWith("@newsletter"),
    });
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) await showQr(qr).catch((error) => log?.(`qr failed: ${error.message}`));
      if (connection === "open") {
        selfPn = jidNormalizedUser(sock.user.id);
        selfLid = sock.user.lid ? jidNormalizedUser(sock.user.lid) : null;
        link = "linked";
        openedQr = false;
        await rm(QR_PATH, { force: true }).catch(() => {});
        onLink?.("linked");
        log?.(`whatsapp linked lid=${Boolean(selfLid)}`);
      }
      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        link = code === DisconnectReason.loggedOut ? "logged_out" : "connecting";
        sock = null;
        selfPn = null;
        selfLid = null;
        onLink?.(link);
        if (stopped || code === DisconnectReason.loggedOut) {
          log?.(code === DisconnectReason.loggedOut ? "whatsapp logged out" : "whatsapp stopped");
          return;
        }
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          connect().catch((error) => log?.(`reconnect failed: ${error.message}`));
        }, 3_000);
      }
    });
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages) {
        if (msg.key?.id && msg.message) {
          messageCache.set(msg.key.id, msg.message);
          if (messageCache.size > 200) messageCache.delete(messageCache.keys().next().value);
        }
        const kind = jidKind(msg.key?.remoteJid);
        const text = messageText(msg.message).trim();
        if (!text) {
          log?.(`inbound unreadable ${kind}`);
          continue;
        }
        const peer = await peerFrom(msg.key);
        const current = route?.() || {};
        const decision = decideInbound({
          peerPn: peer?.pn || null,
          peerLid: peer?.lid || null,
          selfPn,
          selfLid,
          ownerPn: current.ownerPn || null,
          ownerLid: current.ownerLid || null,
          text,
          pairCode: current.pairCode || "",
        });
        if (decision === "ignore") {
          log?.(`inbound ignored ${kind}`);
          continue;
        }
        if (isEcho(msg.key?.id, text)) {
          log?.("inbound echo");
          continue;
        }
        const ts = Number(msg.messageTimestamp || 0) * 1000;
        if (ts && Date.now() - ts > 120_000) {
          log?.("inbound old");
          continue;
        }
        if (decision === "pair") {
          log?.("inbound paired");
          await onPair?.(peer);
          continue;
        }
        log?.("inbound accepted");
        onText(text);
      }
    });
  }

  async function peerFrom(key) {
    if (!key?.remoteJid || (await isSelf(key))) return null;
    const remote = key.remoteJid;
    if (isLidUser(remote)) {
      let pn = null;
      try {
        const mapped = await sock?.signalRepository?.lidMapping?.getPNForLID?.(remote);
        if (mapped) pn = jidNormalizedUser(mapped);
      } catch {
        pn = null;
      }
      return { pn, lid: jidNormalizedUser(remote) };
    }
    try {
      return { pn: jidNormalizedUser(remote), lid: null };
    } catch {
      return null;
    }
  }

  return {
    connect,
    status: () => link,
    hasPeer: () => {
      const current = route?.() || {};
      return Boolean(current.ownerPn || current.ownerLid);
    },
    stop() {
      stopped = true;
      clearTimeout(reconnectTimer);
      sock?.end?.();
    },
    async send(text) {
      const current = route?.() || {};
      const peer = current.ownerPn || current.ownerLid;
      if (!sock || link !== "linked" || !peer) return false;
      const body = String(text).slice(0, 3500);
      outboundText.set(body, Date.now() + 30_000);
      const sent = await sock.sendMessage(peer, { text: body });
      if (sent?.key?.id) {
        outboundIds.add(sent.key.id);
        if (sent.message) messageCache.set(sent.key.id, sent.message);
        if (outboundIds.size > 200) outboundIds.delete(outboundIds.values().next().value);
      }
      return true;
    },
  };
}

export async function clearAuth() {
  await rm(AUTH_DIR, { recursive: true, force: true });
  await writeFile(QR_PATH, "", { flag: "w" }).catch(() => {});
  await rm(QR_PATH, { force: true }).catch(() => {});
}
