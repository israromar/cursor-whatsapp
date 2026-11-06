import assert from "node:assert/strict";
import test from "node:test";
import { hookOutput } from "../src/hook-output.mjs";
import { redact } from "../src/redact.mjs";
import { startHttp } from "../src/server.mjs";
import { acceptUserText, createSessionBook, decideInbound, noteEvent, queueFollowup } from "../src/sessions.mjs";

test("redacts secrets, contacts, code, and long numbers", () => {
  const text = redact(
    "Email ada@example.com phone +1 415 555 1212 token sk-abcdefghijklmnop ```\nconst patient = 123456\n``` /Users/ada/secret",
    300,
  );
  assert.equal(text.includes("ada@example.com"), false);
  assert.equal(text.includes("415"), false);
  assert.equal(text.includes("sk-"), false);
  assert.equal(text.includes("123456"), false);
  assert.equal(text.includes("/Users/ada"), false);
  assert.match(text, /code omitted/);
});

test("queues one follow-up into the matching chat and does not repeat it", () => {
  const book = createSessionBook();
  noteEvent(book, {
    hook_event_name: "sessionStart",
    conversation_id: "c1",
    workspace_name: "demo",
    composer_mode: "agent",
  });
  queueFollowup(book, "add tests");
  const first = noteEvent(book, {
    hook_event_name: "stop",
    conversation_id: "c1",
    workspace_name: "demo",
    status: "completed",
  });
  const second = noteEvent(book, {
    hook_event_name: "stop",
    conversation_id: "c1",
    workspace_name: "demo",
    status: "completed",
  });
  assert.equal(first.followup, "add tests");
  assert.equal(second.followup, null);
});

test("pause keeps approval alerts and drops progress text", () => {
  const book = createSessionBook();
  book.paused = true;
  const started = noteEvent(book, {
    hook_event_name: "sessionStart",
    conversation_id: "c1",
    workspace_name: "demo",
  });
  const blocked = noteEvent(book, {
    hook_event_name: "postToolUseFailure",
    conversation_id: "c1",
    workspace_name: "demo",
    tool_name: "Shell",
    failure_type: "permission_denied",
  });
  assert.equal(started.text, null);
  assert.match(blocked.text, /needs you/);
  assert.equal(blocked.text.includes("npm test"), false);
  const failed = noteEvent(book, {
    hook_event_name: "postToolUseFailure",
    conversation_id: "c1",
    workspace_name: "demo",
    tool_name: "Read",
    failure_type: "error",
  });
  assert.equal(failed.text, null);
});

test("only the paired personal chat is accepted", () => {
  assert.equal(
    decideInbound({
      peerPn: "111@s.whatsapp.net",
      text: "cursor-ABCD",
      pairCode: "cursor-ABCD",
    }),
    "pair",
  );
  assert.equal(
    decideInbound({
      peerPn: "222@s.whatsapp.net",
      text: "hello",
      pairCode: "cursor-ABCD",
    }),
    "ignore",
  );
  assert.equal(
    decideInbound({
      peerPn: "111@s.whatsapp.net",
      ownerPn: "111@s.whatsapp.net",
      text: "status",
      pairCode: "cursor-ABCD",
    }),
    "accept",
  );
  assert.equal(
    decideInbound({
      peerPn: "222@s.whatsapp.net",
      ownerPn: "111@s.whatsapp.net",
      text: "status",
      pairCode: "cursor-ABCD",
    }),
    "ignore",
  );
  assert.equal(
    decideInbound({
      peerPn: "111@s.whatsapp.net",
      selfPn: "111@s.whatsapp.net",
      text: "cursor-ABCD",
      pairCode: "cursor-ABCD",
    }),
    "ignore",
  );
});

test("stats is the status command", () => {
  const book = createSessionBook();
  assert.deepEqual(acceptUserText(book, "stats"), {
    kind: "command",
    name: "status",
    args: "",
    text: "stats",
  });
});

test("hook output cannot change permissions", () => {
  assert.deepEqual(hookOutput("stop", { followup_message: " hi ", permission: "allow" }), {
    followup_message: "hi",
  });
  assert.deepEqual(hookOutput("preToolUse", { permission: "allow" }), {});
  assert.equal(typeof hookOutput("sessionStart", {}).additional_context, "string");
});

test("event endpoint requires the local token and returns a follow-up once", async () => {
  const book = createSessionBook();
  const server = await startHttp({
    port: 0,
    token: "test-token",
    health: () => ({ ok: true }),
    onAsk: async () => ({ status: 200, body: { answer: "yes" } }),
    onNotify: async () => ({ status: 200, body: { ok: true } }),
    onEvent: async (event) => {
      const result = noteEvent(book, event);
      return result.followup ? { followup_message: result.followup } : {};
    },
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const denied = await fetch(`${base}/event`, { method: "POST", body: "{}" });
  assert.equal(denied.status, 401);

  noteEvent(book, { hook_event_name: "sessionStart", conversation_id: "c1", workspace_name: "demo" });
  queueFollowup(book, "ship it");
  const allowed = await fetch(`${base}/event`, {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({
      hook_event_name: "stop",
      conversation_id: "c1",
      workspace_name: "demo",
      status: "completed",
    }),
  });
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), { followup_message: "ship it" });
  server.close();
});
