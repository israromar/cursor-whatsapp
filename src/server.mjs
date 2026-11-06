import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

function authorized(req, token) {
  const header = req.headers.authorization || "";
  const got = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(got);
  const b = Buffer.from(token);
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65_536) {
      const error = new Error("too_large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function startHttp({ port, token, onEvent, onAsk, onNotify, health }) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/health") {
        send(res, 200, health());
        return;
      }
      if (req.method !== "POST" || !authorized(req, token)) {
        send(res, 401, { error: "unauthorized" });
        return;
      }
      const body = await readJson(req);
      if (url.pathname === "/event") {
        const result = await onEvent(body);
        send(res, 200, result || {});
        return;
      }
      if (url.pathname === "/ask") {
        const result = await onAsk(body);
        send(res, result.status || 200, result.body);
        return;
      }
      if (url.pathname === "/notify") {
        const result = await onNotify(body);
        send(res, result.status || 200, result.body);
        return;
      }
      send(res, 404, { error: "not_found" });
    } catch (error) {
      send(res, error.status || 400, { error: "bad_request" });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
