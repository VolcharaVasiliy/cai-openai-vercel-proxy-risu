import { createHash } from "node:crypto";

const sessionStore = globalThis.__caiSessionStore || new Map();
globalThis.__caiSessionStore = sessionStore;

const MAX_TURNS = Number(process.env.CAI_MEMORY_MAX_TURNS || 24);
const MAX_CONTENT_CHARS = Number(process.env.CAI_MEMORY_MAX_CHARS || 8000);

function clampText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    return "";
  }
  if (text.length <= MAX_CONTENT_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_CONTENT_CHARS)}...`;
}

function tokenFingerprint(token) {
  return createHash("sha1").update(String(token || "")).digest("hex").slice(0, 12);
}

export function makeSessionKey({ token, model, sessionId }) {
  const safeModel = typeof model === "string" && model.trim() ? model.trim() : "default-model";
  const safeSession = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : "default-session";
  return `${tokenFingerprint(token)}::${safeModel}::${safeSession}`;
}

export function getSessionTurns(sessionKey) {
  const turns = sessionStore.get(sessionKey);
  return Array.isArray(turns) ? turns.slice() : [];
}

export function setSessionTurns(sessionKey, turns) {
  const normalized = Array.isArray(turns)
    ? turns
        .filter((item) => item && (item.role === "user" || item.role === "assistant" || item.role === "system"))
        .map((item) => ({
          role: item.role,
          content: clampText(item.content)
        }))
        .filter((item) => item.content)
        .slice(-MAX_TURNS)
    : [];
  sessionStore.set(sessionKey, normalized);
  return normalized;
}

export function appendSessionTurns(sessionKey, turns) {
  const existing = getSessionTurns(sessionKey);
  return setSessionTurns(sessionKey, existing.concat(Array.isArray(turns) ? turns : []));
}

export function buildHistoryBlock(turns) {
  if (!Array.isArray(turns) || !turns.length) {
    return "No prior turns.";
  }

  const relevant = turns
    .filter((item) => item && (item.role === "user" || item.role === "assistant"))
    .slice(-14);

  if (!relevant.length) {
    return "No prior turns.";
  }

  return relevant
    .map((item) => `${item.role === "user" ? "User" : "Assistant"}: ${item.content}`)
    .join("\n");
}
