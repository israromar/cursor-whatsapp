import { SESSION_CONTEXT } from "./paths.mjs";

export function hookOutput(eventName, serverBody) {
  const out = {};
  if (eventName === "sessionStart") out.additional_context = SESSION_CONTEXT;
  const followup = serverBody?.followup_message;
  if (eventName === "stop" && typeof followup === "string" && followup.trim()) {
    out.followup_message = followup.trim().slice(0, 2000);
  }
  return out;
}
