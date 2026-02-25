import { createHash } from "node:crypto";
import { sendCharacterMessage, sendCharacterMessageWithReplaySync } from "../../../lib/cai.js";
import { getDefaultModel, listModels, resolveCharacterId, resolveSessionId, resolveToken } from "../../../lib/config.js";
import { appendSessionTurns, getSessionTurns, makeSessionKey, setSessionTurns } from "../../../lib/memory.js";
import { buildChatCompletion, buildChatCompletionFromList, writeSingleChunkSSE } from "../../../lib/openai-format.js";

const MAX_ASSISTANT_CHARS = Number(process.env.CAI_MAX_ASSISTANT_CHARS || 0);

const sessionRuntimeStore = globalThis.__caiSessionRuntimeStore || new Map();
globalThis.__caiSessionRuntimeStore = sessionRuntimeStore;
const sessionAliasStore = globalThis.__caiSessionAliasStore || new Map();
globalThis.__caiSessionAliasStore = sessionAliasStore;
const sessionContextAliasStore = globalThis.__caiSessionContextAliasStore || new Map();
globalThis.__caiSessionContextAliasStore = sessionContextAliasStore;
const ALLOW_MULTI_CHOICE =
  String(process.env.CAI_ALLOW_MULTI_CHOICE || "")
    .trim()
    .toLowerCase() === "true";
const DEBUG_SYNC_HEADERS =
  String(process.env.CAI_DEBUG_SYNC_HEADERS || "")
    .trim()
    .toLowerCase() === "true";

function parsePossiblyNestedJson(value, maxDepth = 4) {
  let current = value;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (typeof current !== "string") {
      return current;
    }

    const trimmed = current.trim();
    if (!trimmed) {
      return {};
    }

    try {
      current = JSON.parse(trimmed);
    } catch {
      return depth === 0 ? null : current;
    }
  }
  return current;
}

function tryParseLooseJsonObject(raw) {
  if (typeof raw !== "string") {
    return null;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return null;
  }
  if (!/"[A-Za-z0-9_]+"\s*:/.test(trimmed)) {
    return null;
  }

  const attempts = [trimmed];
  if (trimmed.includes('\\"')) {
    attempts.push(trimmed.replace(/\\"/g, "\""));
  }

  for (const candidate of attempts) {
    try {
      return JSON.parse(`{${candidate}}`);
    } catch {}
  }

  return null;
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Session-Id, X-Conversation-Id, X-API-Key"
  );
}

function parseRequestBody(req) {
  if (!req.body) {
    return {};
  }

  if (typeof req.body === "string") {
    const parsed = parsePossiblyNestedJson(req.body);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }

    const looseParsed = tryParseLooseJsonObject(req.body);
    if (looseParsed && typeof looseParsed === "object") {
      return looseParsed;
    }

    throw new Error("Invalid JSON body");
  }

  return req.body;
}

function normalizeMessageContent(content) {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const textParts = content
      .filter((part) => part && typeof part === "object" && part.type === "text")
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .filter(Boolean);

    return textParts.join("\n").trim();
  }

  return "";
}

function decodeEscapedJsonString(value) {
  if (typeof value !== "string") {
    return "";
  }

  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return value
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, "\"")
      .replace(/\\\\/g, "\\");
  }
}

function extractRoleContentPairsFromSerializedText(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    return [];
  }

  const inputs = [raw];
  if (raw.includes('\\"role\\"') || raw.includes('\\\\\"role\\\\\"')) {
    inputs.push(raw.replace(/\\"/g, "\""));
  }

  const pairPattern = /"role"\s*:\s*"((?:\\.|[^"\\])*)"\s*,\s*"content"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  for (const input of inputs) {
    const result = [];
    let match = pairPattern.exec(input);
    while (match) {
      const rawRole = decodeEscapedJsonString(match[1]).trim().toLowerCase();
      const content = decodeEscapedJsonString(match[2]).trim();
      if ((rawRole === "system" || rawRole === "user" || rawRole === "assistant") && content) {
        result.push({
          role: rawRole,
          content
        });
      }
      match = pairPattern.exec(input);
    }

    if (result.length) {
      return result;
    }
  }

  return [];
}

function coerceMessagesToArray(messages) {
  if (Array.isArray(messages)) {
    return messages;
  }

  if (typeof messages === "string") {
    const nested = parsePossiblyNestedJson(messages);
    if (nested && nested !== messages) {
      return coerceMessagesToArray(nested?.messages ?? nested);
    }

    const extractedPairs = extractRoleContentPairsFromSerializedText(messages);
    if (extractedPairs.length) {
      return extractedPairs;
    }

    return [];
  }

  if (messages && typeof messages === "object") {
    if (Array.isArray(messages.messages)) {
      return messages.messages;
    }

    if (typeof messages.role === "string" && Object.prototype.hasOwnProperty.call(messages, "content")) {
      return [messages];
    }

    const numericKeys = Object.keys(messages)
      .filter((key) => /^\d+$/.test(key))
      .sort((a, b) => Number(a) - Number(b));
    if (numericKeys.length) {
      return numericKeys.map((key) => messages[key]).filter(Boolean);
    }
  }

  return [];
}

function normalizeMessageList(messages) {
  const sourceMessages = coerceMessagesToArray(messages);
  if (!Array.isArray(sourceMessages) || !sourceMessages.length) {
    return [];
  }

  const normalized = sourceMessages
    .map((msg) => ({
      role: msg?.role,
      content: normalizeMessageContent(msg?.content)
    }))
    .filter((msg) => (msg.role === "system" || msg.role === "user" || msg.role === "assistant") && msg.content);

  const rebuilt = rebuildMessagesFromRisuBlob(normalized);
  if (rebuilt !== normalized) {
    return rebuilt;
  }

  return sanitizeSerializedUserMessage(normalized);
}

function findFirstMarkerMatch(text, patterns) {
  if (typeof text !== "string" || !text) {
    return null;
  }

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && typeof match.index === "number") {
      return {
        index: match.index,
        length: match[0].length
      };
    }
  }

  return null;
}

function normalizeMarkerLabel(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s*[:\-]\s*$/, "");
}

function matchesMarkerLabel(value, labels) {
  const normalized = normalizeMarkerLabel(value);
  if (!normalized) {
    return false;
  }
  return labels.some((label) => {
    if (normalized === label) {
      return true;
    }
    return normalized.startsWith(`${label} `);
  });
}

function normalizeRoleLabel(rawRole) {
  return normalizeMarkerLabel(rawRole).replace(/^['"`([{<\s]+|['"`)\]}>]+$/g, "");
}

function normalizeRoleToken(rawRole) {
  const role = normalizeRoleLabel(rawRole);
  if (!role) {
    return "";
  }

  const assistantHints = new Set([
    "assistant",
    "\u0430\u0441\u0441\u0438\u0441\u0442\u0435\u043d\u0442",
    "ai",
    "bot",
    "\u0431\u043e\u0442",
    "\u0438\u0438",
    "character",
    "\u043f\u0435\u0440\u0441\u043e\u043d\u0430\u0436",
    "model",
    "\u043c\u043e\u0434\u0435\u043b\u044c"
  ]);
  if (assistantHints.has(role)) {
    return "assistant";
  }

  const userHints = new Set([
    "user",
    "\u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044c",
    "\u044e\u0437\u0435\u0440",
    "human",
    "\u0447\u0435\u043b\u043e\u0432\u0435\u043a",
    "me",
    "\u044f",
    "client",
    "\u043a\u043b\u0438\u0435\u043d\u0442",
    "you",
    "xleb"
  ]);
  if (userHints.has(role)) {
    return "user";
  }

  return "";
}

function isSystemLikeLabel(rawRole) {
  const label = normalizeRoleLabel(rawRole);
  if (!label) {
    return false;
  }

  const systemLabels = [
    "system",
    "system rule",
    "system_rule",
    "proxy policy",
    "configuration",
    "config",
    "roleplay_rule",
    "roleplay info",
    "client system prompt",
    "conversation history",
    "chat history",
    "history",
    "current user message",
    "current user input",
    "current message",
    "user message",
    "\u0441\u0438\u0441\u0442\u0435\u043c\u0430",
    "\u0441\u0438\u0441\u0442\u0435\u043c\u043d\u043e\u0435 \u043f\u0440\u0430\u0432\u0438\u043b\u043e",
    "\u0438\u0441\u0442\u043e\u0440\u0438\u044f \u0447\u0430\u0442\u0430",
    "\u0438\u0441\u0442\u043e\u0440\u0438\u044f \u0434\u0438\u0430\u043b\u043e\u0433\u0430",
    "\u0438\u0441\u0442\u043e\u0440\u0438\u044f",
    "\u0442\u0435\u043a\u0443\u0449\u0435\u0435 \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435",
    "\u0442\u0435\u043a\u0443\u0449\u0435\u0435 \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435 \u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044f",
    "\u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435 \u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044f"
  ];

  return systemLabels.some((item) => label === item || label.startsWith(`${item} `));
}

function inferRoleFromLabel({ rawRole, content, currentUserMessage, lastRole, labelRoleMap }) {
  const normalizedLabel = normalizeRoleLabel(rawRole);
  if (!normalizedLabel) {
    return "";
  }

  const explicitRole = normalizeRoleToken(normalizedLabel);
  if (explicitRole) {
    labelRoleMap.set(normalizedLabel, explicitRole);
    return explicitRole;
  }

  const mapped = labelRoleMap.get(normalizedLabel);
  if (mapped) {
    return mapped;
  }

  if (isSystemLikeLabel(normalizedLabel)) {
    return "";
  }

  const normalizedContent = typeof content === "string" ? content.trim() : "";
  const normalizedCurrent = typeof currentUserMessage === "string" ? currentUserMessage.trim() : "";
  if (normalizedCurrent && normalizedContent && normalizedContent === normalizedCurrent) {
    labelRoleMap.set(normalizedLabel, "user");
    return "user";
  }

  if (lastRole === "user") {
    labelRoleMap.set(normalizedLabel, "assistant");
    return "assistant";
  }

  if (lastRole === "assistant") {
    labelRoleMap.set(normalizedLabel, "user");
    return "user";
  }

  labelRoleMap.set(normalizedLabel, "user");
  return "user";
}

function parseHistoryTurns(historySection, currentUserMessage = "") {
  if (typeof historySection !== "string" || !historySection.trim()) {
    return [];
  }

  const turns = [];
  let lastTurn = null;
  const labelRoleMap = new Map();

  for (const rawLine of historySection.split(/\r?\n/)) {
    const line = typeof rawLine === "string" ? rawLine : "";
    const roleMatch = line.match(/^\s*(?:[-*]\s*)?([^:\n]{1,64})\s*:\s*(.*)$/);
    if (roleMatch) {
      const content = roleMatch[2].trim();
      const role = inferRoleFromLabel({
        rawRole: roleMatch[1],
        content,
        currentUserMessage,
        lastRole: lastTurn?.role || "",
        labelRoleMap
      });

      if (role) {
        lastTurn = {
          role,
          content
        };
        turns.push(lastTurn);
        continue;
      }

      if (isSystemLikeLabel(roleMatch[1])) {
        continue;
      }
    }

    const continuation = line.trimEnd();
    if (lastTurn && continuation) {
      lastTurn.content = lastTurn.content ? `${lastTurn.content}\n${continuation}` : continuation;
    }
  }

  return turns.filter((item) => item && item.content);
}

function parseRisuConversationBlob(content) {
  if (typeof content !== "string" || !content.trim()) {
    return null;
  }

  const historyMarker = findFirstMarkerMatch(content, [
    /^\s*Conversation history\s*[:\-]/im,
    /^\s*Chat history\s*[:\-]/im,
    /^\s*History\s*[:\-]/im,
    /^\s*\u0418\u0441\u0442\u043e\u0440\u0438\u044f \u0434\u0438\u0430\u043b\u043e\u0433\u0430\s*[:\-]/im,
    /^\s*\u0418\u0441\u0442\u043e\u0440\u0438\u044f \u0447\u0430\u0442\u0430\s*[:\-]/im,
    /^\s*\u0418\u0441\u0442\u043e\u0440\u0438\u044f\s*[:\-]/im
  ]);
  const currentMarker = findFirstMarkerMatch(content, [
    /^\s*Current user message\s*[:\-]/im,
    /^\s*Current user input\s*[:\-]/im,
    /^\s*Current message\s*[:\-]/im,
    /^\s*User message\s*[:\-]/im,
    /^\s*\u0422\u0435\u043a\u0443\u0449\u0435\u0435 \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435 \u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044f\s*[:\-]/im,
    /^\s*\u0421\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435 \u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044f\s*[:\-]/im,
    /^\s*\u0422\u0435\u043a\u0443\u0449\u0435\u0435 \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435\s*[:\-]/im
  ]);

  if (!historyMarker && !currentMarker) {
    const roughTurnCount = (content.match(/^\s*(?:[-*]\s*)?[^:\n]{1,64}\s*:\s*/gim) || []).length;
    if (roughTurnCount < 2) {
      return null;
    }
  }

  const lines = content.split(/\r?\n/);
  const historyLabels = [
    "conversation history",
    "chat history",
    "history",
    "\u0438\u0441\u0442\u043e\u0440\u0438\u044f \u0434\u0438\u0430\u043b\u043e\u0433\u0430",
    "\u0438\u0441\u0442\u043e\u0440\u0438\u044f \u0447\u0430\u0442\u0430",
    "\u0438\u0441\u0442\u043e\u0440\u0438\u044f"
  ];
  const currentLabels = [
    "current user message",
    "current user input",
    "current message",
    "user message",
    "\u0442\u0435\u043a\u0443\u0449\u0435\u0435 \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435 \u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044f",
    "\u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435 \u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044f",
    "\u0442\u0435\u043a\u0443\u0449\u0435\u0435 \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435"
  ];

  let historyMarkerLine = -1;
  let currentMarkerLine = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (historyMarkerLine < 0 && matchesMarkerLabel(lines[i], historyLabels)) {
      historyMarkerLine = i;
      continue;
    }
    if (currentMarkerLine < 0 && matchesMarkerLabel(lines[i], currentLabels)) {
      currentMarkerLine = i;
    }
  }

  const historyStartLine = historyMarkerLine >= 0 ? historyMarkerLine + 1 : 0;
  const historyEndLine = currentMarkerLine >= 0 ? currentMarkerLine : lines.length;
  if (historyEndLine < historyStartLine) {
    return null;
  }

  const historySection = lines.slice(historyStartLine, historyEndLine).join("\n").trim();
  const currentUserMessage = currentMarkerLine >= 0 ? lines.slice(currentMarkerLine + 1).join("\n").trim() : "";

  const normalizedTurns = parseHistoryTurns(historySection, currentUserMessage);
  if (currentUserMessage) {
    const lastTurn = normalizedTurns[normalizedTurns.length - 1];
    if (!lastTurn || lastTurn.role !== "user" || lastTurn.content !== currentUserMessage) {
      normalizedTurns.push({
        role: "user",
        content: currentUserMessage
      });
    }
  }

  if (!normalizedTurns.length && !currentUserMessage) {
    return null;
  }

  let systemText = "";
  if (historyMarkerLine > 0) {
    systemText = lines.slice(0, historyMarkerLine).join("\n").trim();
  } else if (historyMarkerLine < 0) {
    const firstRoleLine = lines.findIndex((line) => {
      const roleMatch = String(line || "").match(/^\s*(?:[-*]\s*)?([^:\n]{1,64})\s*:\s*(.*)$/);
      if (!roleMatch) {
        return false;
      }
      if (isSystemLikeLabel(roleMatch[1])) {
        return false;
      }
      return Boolean(
        inferRoleFromLabel({
          rawRole: roleMatch[1],
          content: roleMatch[2],
          currentUserMessage,
          lastRole: "",
          labelRoleMap: new Map()
        })
      );
    });
    if (firstRoleLine > 0) {
      systemText = lines.slice(0, firstRoleLine).join("\n").trim();
    }
  }

  if (!historyMarker && !currentMarker) {
    const hasAssistant = normalizedTurns.some((item) => item.role === "assistant");
    const hasUser = normalizedTurns.some((item) => item.role === "user");
    if (!(hasAssistant && hasUser)) {
      return null;
    }
  }

  return {
    systemText,
    turns: normalizedTurns
  };
}

function extractCurrentUserMessageFromBlob(content) {
  if (typeof content !== "string" || !content.trim()) {
    return "";
  }

  const lines = content.split(/\r?\n/);
  const currentLabels = [
    "current user message",
    "current user input",
    "current message",
    "user message",
    "\u0442\u0435\u043a\u0443\u0449\u0435\u0435 \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435 \u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044f",
    "\u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435 \u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044f",
    "\u0442\u0435\u043a\u0443\u0449\u0435\u0435 \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435"
  ];

  for (let i = 0; i < lines.length; i += 1) {
    if (matchesMarkerLabel(lines[i], currentLabels)) {
      return lines.slice(i + 1).join("\n").trim();
    }
  }

  let fallbackUser = "";
  let lastRole = "";
  const labelRoleMap = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    const roleMatch = lines[i].match(/^\s*(?:[-*]\s*)?([^:\n]{1,64})\s*:\s*(.*)$/);
    if (!roleMatch) {
      continue;
    }

    const role = inferRoleFromLabel({
      rawRole: roleMatch[1],
      content: roleMatch[2],
      currentUserMessage: "",
      lastRole,
      labelRoleMap
    });
    if (!role) {
      continue;
    }
    lastRole = role;
    if (role === "user") {
      fallbackUser = roleMatch[2].trim();
    }
  }

  if (fallbackUser) {
    return fallbackUser;
  }

  return "";
}

function looksLikeSerializedConversation(content) {
  if (typeof content !== "string" || !content.trim()) {
    return false;
  }

  if (
    /(conversation history|chat history|current user message|current user input|\u0438\u0441\u0442\u043e\u0440\u0438\u044f \u0447\u0430\u0442\u0430|\u0438\u0441\u0442\u043e\u0440\u0438\u044f \u0434\u0438\u0430\u043b\u043e\u0433\u0430|\u0442\u0435\u043a\u0443\u0449\u0435\u0435 \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435)/i.test(
      content
    )
  ) {
    return true;
  }

  const explicitRoleLines = content.match(
    /^\s*(?:[-*]\s*)?(assistant|user|\u0430\u0441\u0441\u0438\u0441\u0442\u0435\u043d\u0442|\u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044c|\u044e\u0437\u0435\u0440)\s*:\s*.+$/gim
  );
  if (explicitRoleLines && explicitRoleLines.length >= 2) {
    return true;
  }

  const genericRoleLines = content.match(/^\s*(?:[-*]\s*)?[^:\n]{1,64}\s*:\s*.+$/gim);
  return Boolean(genericRoleLines && genericRoleLines.length >= 4 && content.length >= 200);
}

function sanitizeSerializedUserMessage(messages) {
  if (!Array.isArray(messages) || !messages.length) {
    return messages;
  }

  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user" && messages[i].content) {
      lastUserIndex = i;
      break;
    }
  }

  if (lastUserIndex < 0) {
    return messages;
  }

  const rawContent = messages[lastUserIndex].content;
  if (!looksLikeSerializedConversation(rawContent)) {
    return messages;
  }

  const extracted = extractCurrentUserMessageFromBlob(rawContent);
  if (!extracted) {
    return messages;
  }

  const next = messages.slice();
  next[lastUserIndex] = {
    ...next[lastUserIndex],
    content: extracted
  };
  return next;
}

function rebuildMessagesFromRisuBlob(messages) {
  if (!Array.isArray(messages) || !messages.length) {
    return [];
  }

  let lastUserMessage = null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user" && messages[i].content) {
      lastUserMessage = messages[i];
      break;
    }
  }

  if (!lastUserMessage) {
    return messages;
  }

  const parsed = parseRisuConversationBlob(lastUserMessage.content);
  if (!parsed) {
    return messages;
  }

  const existingSystemText = messages
    .filter((msg) => msg.role === "system")
    .map((msg) => msg.content)
    .filter(Boolean)
    .join("\n\n")
    .trim();

  const mergedSystemText = [existingSystemText, parsed.systemText].filter(Boolean).join("\n\n").trim();
  const rebuilt = [];

  if (mergedSystemText) {
    rebuilt.push({
      role: "system",
      content: mergedSystemText
    });
  }

  if (!Array.isArray(parsed.turns) || !parsed.turns.length) {
    return messages;
  }

  return rebuilt.concat(parsed.turns);
}

function getLastUserMessage(messages) {
  if (!Array.isArray(messages)) {
    return "";
  }

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role === "user") {
      return msg.content;
    }
  }

  return "";
}

function splitIncomingMessages(messages) {
  const systems = [];
  const turns = [];

  for (const message of messages) {
    if (!message || !message.content) {
      continue;
    }

    if (message.role === "system") {
      systems.push(message.content);
      continue;
    }

    if (message.role === "user" || message.role === "assistant") {
      turns.push({
        role: message.role,
        content: message.content
      });
    }
  }

  return {
    systemText: systems.join("\n\n").trim(),
    turns
  };
}

function buildTranscriptPrompt({ systemText, turns }) {
  const parts = [];

  if (typeof systemText === "string" && systemText.trim()) {
    parts.push(`SYSTEM:\n${systemText.trim()}`);
  }

  if (Array.isArray(turns)) {
    for (const turn of turns) {
      if (!turn || !turn.content || (turn.role !== "user" && turn.role !== "assistant")) {
        continue;
      }
      parts.push(`${turn.role.toUpperCase()}:\n${turn.content}`);
    }
  }

  return parts.join("\n\n").trim();
}

function isAppendOnly(previousTurns, nextTurns) {
  if (!Array.isArray(previousTurns) || !Array.isArray(nextTurns)) {
    return false;
  }

  if (nextTurns.length < previousTurns.length) {
    return false;
  }

  for (let i = 0; i < previousTurns.length; i += 1) {
    const prev = previousTurns[i];
    const next = nextTurns[i];
    if (!prev || !next) {
      return false;
    }
    if (prev.role !== next.role || prev.content !== next.content) {
      return false;
    }
  }

  return true;
}

function commonPrefixLength(previousTurns, nextTurns) {
  if (!Array.isArray(previousTurns) || !Array.isArray(nextTurns)) {
    return 0;
  }

  const limit = Math.min(previousTurns.length, nextTurns.length);
  let matched = 0;
  for (let i = 0; i < limit; i += 1) {
    const prev = previousTurns[i];
    const next = nextTurns[i];
    if (!prev || !next || prev.role !== next.role || prev.content !== next.content) {
      break;
    }
    matched += 1;
  }
  return matched;
}

function hasExplicitRewriteSignal(body) {
  if (!body || typeof body !== "object") {
    return false;
  }

  const booleanSignals = [
    "regenerate",
    "is_regenerate",
    "isRegenerate",
    "is_regen",
    "isRegen",
    "rewrite",
    "is_rewrite",
    "isRewrite",
    "edited",
    "is_edited",
    "isEdited",
    "deleted",
    "is_deleted",
    "isDeleted",
    "replace_last",
    "replaceLast"
  ];

  for (const key of booleanSignals) {
    if (body[key] === true) {
      return true;
    }
  }

  const textSignals = [body.action, body.operation, body.event, body.mode]
    .filter((value) => typeof value === "string")
    .map((value) => value.trim().toLowerCase());
  if (textSignals.some((value) => /(regen|regenerate|rewrite|edit|delete|remove)/.test(value))) {
    return true;
  }

  return false;
}

function shouldApplyRewrite(previousTurns, nextTurns, body) {
  if (!Array.isArray(previousTurns) || !previousTurns.length) {
    return false;
  }
  if (!Array.isArray(nextTurns) || !nextTurns.length) {
    return false;
  }

  if (hasExplicitRewriteSignal(body)) {
    return true;
  }

  const prefix = commonPrefixLength(previousTurns, nextTurns);
  if (prefix < 1) {
    return false;
  }

  const minLen = Math.min(previousTurns.length, nextTurns.length);
  const nearTailRewrite = prefix >= Math.max(1, minLen - 2);
  if (!nearTailRewrite) {
    return false;
  }

  const previousLast = previousTurns[previousTurns.length - 1];
  const nextLast = nextTurns[nextTurns.length - 1];
  const lastTurnChanged =
    !previousLast ||
    !nextLast ||
    previousLast.role !== nextLast.role ||
    previousLast.content !== nextLast.content;

  if (!lastTurnChanged) {
    return false;
  }

  if (nextTurns.length <= previousTurns.length) {
    return true;
  }

  const includesAssistant = nextTurns.some((item) => item.role === "assistant");
  return includesAssistant;
}

function ensureTrailingUserTurn(turns, userMessage) {
  const normalizedTurns = Array.isArray(turns)
    ? turns.filter((item) => item && (item.role === "user" || item.role === "assistant") && item.content)
    : [];

  if (!userMessage) {
    return normalizedTurns;
  }

  const last = normalizedTurns[normalizedTurns.length - 1];
  if (last?.role === "user" && last.content === userMessage) {
    return normalizedTurns;
  }

  return normalizedTurns.concat([{ role: "user", content: userMessage }]);
}

function clampAssistantText(text) {
  const value = typeof text === "string" ? text.trim() : "";
  if (!value) {
    return "";
  }
  if (!Number.isFinite(MAX_ASSISTANT_CHARS) || MAX_ASSISTANT_CHARS <= 0) {
    return value;
  }
  if (value.length <= MAX_ASSISTANT_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_ASSISTANT_CHARS)}...`;
}

function getRuntimeState(sessionKey) {
  const raw = sessionRuntimeStore.get(sessionKey);
  if (!raw || typeof raw !== "object") {
    return {
      bootstrapped: false,
      systemText: ""
    };
  }

  return {
    bootstrapped: raw.bootstrapped === true,
    systemText: typeof raw.systemText === "string" ? raw.systemText : ""
  };
}

function setRuntimeState(sessionKey, state) {
  sessionRuntimeStore.set(sessionKey, {
    bootstrapped: state?.bootstrapped === true,
    systemText: typeof state?.systemText === "string" ? state.systemText : "",
    updatedAt: Date.now()
  });

  if (sessionRuntimeStore.size > 2000) {
    const firstKey = sessionRuntimeStore.keys().next().value;
    if (firstKey) {
      sessionRuntimeStore.delete(firstKey);
    }
  }
}

function makeSessionAliasKey(token, model) {
  const tokenPart = createHash("sha1").update(String(token || "")).digest("hex").slice(0, 12);
  const modelPart = typeof model === "string" && model.trim() ? model.trim() : "default-model";
  return `${tokenPart}::${modelPart}`;
}

function makeSessionContextAliasKey({ token, model, systemText, firstUserMessage }) {
  const tokenPart = createHash("sha1").update(String(token || "")).digest("hex").slice(0, 12);
  const modelPart = typeof model === "string" && model.trim() ? model.trim() : "default-model";
  const normalizedSystem = normalizeHashText(systemText || "", 800);
  const normalizedFirstUser = normalizeHashText(firstUserMessage || "", 700);
  const contextSignature = `${normalizedSystem}\n---\n${normalizedFirstUser}`;
  const contextHash = createHash("sha1").update(contextSignature).digest("hex").slice(0, 16);
  return `${tokenPart}::${modelPart}::ctx-${contextHash}`;
}

function createEphemeralSessionId() {
  const seed = `${Date.now()}-${Math.random().toString(16).slice(2, 12)}`;
  return `auto-${createHash("sha1").update(seed).digest("hex").slice(0, 16)}`;
}

function firstUserTurnContent(turns, fallback = "") {
  if (Array.isArray(turns)) {
    for (const item of turns) {
      if (item?.role === "user" && typeof item.content === "string" && item.content.trim()) {
        return item.content.trim();
      }
    }
  }
  return typeof fallback === "string" ? fallback.trim() : "";
}

function normalizeHashText(value, maxLength = 1200) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    return "";
  }
  const compact = text.replace(/\s+/g, " ").trim();
  if (!maxLength || compact.length <= maxLength) {
    return compact;
  }
  return compact.slice(0, maxLength);
}

function deriveImplicitSessionId({ systemText, turns, userMessage }) {
  const normalizedTurns = Array.isArray(turns)
    ? turns.filter((item) => item && (item.role === "user" || item.role === "assistant") && item.content)
    : [];

  const userTurns = normalizedTurns.filter((item) => item.role === "user");
  const firstUser = normalizeHashText(userTurns[0]?.content || userMessage || "", 900);
  const normalizedSystem = normalizeHashText(systemText || "", 1500);

  const signatureParts = [normalizedSystem, firstUser].filter(Boolean);
  if (!signatureParts.length) {
    return "default-session";
  }

  const signature = signatureParts.join("\n---\n");
  return `auto-${createHash("sha1").update(signature).digest("hex").slice(0, 16)}`;
}

function hasContextForImplicitSession({ systemText, turns }) {
  if (typeof systemText === "string" && systemText.trim()) {
    return true;
  }
  if (!Array.isArray(turns) || !turns.length) {
    return false;
  }
  const hasAssistant = turns.some((item) => item && item.role === "assistant" && item.content);
  if (hasAssistant) {
    return true;
  }
  return turns.length > 1;
}

function countRole(turns, role) {
  if (!Array.isArray(turns) || !turns.length) {
    return 0;
  }
  return turns.reduce((total, item) => total + (item?.role === role ? 1 : 0), 0);
}

function hasExplicitSessionRequest(reqHeaders, sessionCandidate) {
  const headerValue =
    reqHeaders?.["x-session-id"] ||
    reqHeaders?.["X-Session-Id"] ||
    reqHeaders?.["x-conversation-id"] ||
    reqHeaders?.["X-Conversation-Id"];

  if (typeof headerValue === "string" && headerValue.trim()) {
    return true;
  }
  if (Array.isArray(headerValue) && headerValue.some((item) => typeof item === "string" && item.trim())) {
    return true;
  }
  return typeof sessionCandidate === "string" && sessionCandidate.trim().length > 0;
}

function allowSessionAliasFallback() {
  return (
    String(process.env.CAI_SESSION_ALIAS_FALLBACK || "")
      .trim()
      .toLowerCase() === "true"
  );
}

function looksLikeContinuationTurn(previousTurns, nextTurns, userMessage) {
  if (!Array.isArray(previousTurns) || !previousTurns.length) {
    return false;
  }
  if (!Array.isArray(nextTurns) || !nextTurns.length) {
    return false;
  }

  const safeUserMessage = typeof userMessage === "string" ? userMessage.trim() : "";
  if (!safeUserMessage) {
    return false;
  }

  const previousLast = previousTurns[previousTurns.length - 1];
  const nextLast = nextTurns[nextTurns.length - 1];
  if (!previousLast || !nextLast) {
    return false;
  }
  if (previousLast.role !== "assistant") {
    return false;
  }
  if (nextLast.role !== "user") {
    return false;
  }
  if (nextLast.content !== safeUserMessage) {
    return false;
  }

  const previousUserCount = countRole(previousTurns, "user");
  const nextUserCount = countRole(nextTurns, "user");
  const previousAssistantCount = countRole(previousTurns, "assistant");
  const nextAssistantCount = countRole(nextTurns, "assistant");

  if (nextUserCount >= previousUserCount + 1 && nextAssistantCount >= previousAssistantCount) {
    return true;
  }
  if (nextUserCount > previousUserCount && nextTurns.length >= previousTurns.length) {
    return true;
  }

  return false;
}

function normalizeSyncMode(value) {
  const mode = String(value || "")
    .trim()
    .toLowerCase();
  return mode === "replay" ? "replay" : "prompt";
}

function readSingleHeaderValue(headers, key) {
  const raw = headers?.[key];
  if (Array.isArray(raw)) {
    return raw[0] || "";
  }
  return typeof raw === "string" ? raw : "";
}

function resolveSyncMode(req, body) {
  const headerMode = readSingleHeaderValue(req?.headers, "x-cai-sync-mode");
  const bodyMode =
    typeof body?.proxy_sync_mode === "string"
      ? body.proxy_sync_mode
      : typeof body?.sync_mode === "string"
      ? body.sync_mode
      : "";
  const envMode = process.env.CAI_SYNC_MODE || "";
  return normalizeSyncMode(headerMode || bodyMode || envMode || "prompt");
}

function allowReplayAuthoritativeMode() {
  return (
    String(process.env.CAI_REPLAY_AUTHORITATIVE_HISTORY || "")
      .trim()
      .toLowerCase() === "true"
  );
}

function assumeReplayContinuationFromIncomingHistory() {
  const raw = String(process.env.CAI_REPLAY_ASSUME_CONTINUATION || "")
    .trim()
    .toLowerCase();
  if (!raw) {
    return true;
  }
  return raw !== "false";
}

export default async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({
      error: {
        message: "Method not allowed",
        type: "invalid_request_error",
        code: "method_not_allowed"
      }
    });
    return;
  }

  let body;
  try {
    body = parseRequestBody(req);
  } catch {
    res.status(400).json({
      error: {
        message: "Invalid JSON body",
        type: "invalid_request_error",
        code: "invalid_json"
      }
    });
    return;
  }

  const model = typeof body.model === "string" ? body.model.trim() : "";
  const stream = body.stream === true;
  const requestedChoiceCount = Math.max(1, Math.min(8, Number(body.n) || 1));
  const choiceCount = ALLOW_MULTI_CHOICE ? requestedChoiceCount : 1;
  const normalizedMessages = normalizeMessageList(body.messages);
  const userMessage = getLastUserMessage(normalizedMessages);
  const syncMode = resolveSyncMode(req, body);

  if (!model) {
    res.status(400).json({
      error: {
        message: "Missing required field: model",
        type: "invalid_request_error",
        code: "invalid_model"
      }
    });
    return;
  }

  if (!userMessage) {
    res.status(400).json({
      error: {
        message: "At least one user message is required",
        type: "invalid_request_error",
        code: "invalid_messages"
      }
    });
    return;
  }

  const token = resolveToken(req.headers);
  if (!token) {
    res.status(401).json({
      error: {
        message:
          "Missing token. Send Authorization: Bearer <token>. Optional server fallback requires CAI_ALLOW_SERVER_TOKEN=true and CAI_TOKEN.",
        type: "invalid_request_error",
        code: "missing_api_key"
      }
    });
    return;
  }

  const characterId = resolveCharacterId(model);
  if (!characterId) {
    const configured = listModels();
    res.status(400).json({
      error: {
        message: `Unknown model "${model}". Configure CAI_MODEL_MAP_JSON or CAI_CHARACTER_ID (default alias: ${getDefaultModel()}).`,
        type: "invalid_request_error",
        code: "model_not_found",
        available_models: configured
      }
    });
    return;
  }

  const allowBodyUserSession =
    String(process.env.CAI_SESSION_USE_BODY_USER || "")
      .trim()
      .toLowerCase() === "true";
  const sessionCandidate =
    body.conversation_id ||
    body.conversationId ||
    body.chat_id ||
    body.chatId ||
    (allowBodyUserSession ? body.user : "");
  const { systemText: incomingSystemText, turns: incomingTurns } = splitIncomingMessages(normalizedMessages);
  const sessionAliasKey = makeSessionAliasKey(token, model);
  const firstIncomingUserMessage = firstUserTurnContent(incomingTurns, userMessage);
  const incomingAssistantCount = countRole(incomingTurns, "assistant");
  const incomingUserCount = countRole(incomingTurns, "user");
  const canUseContextAlias = Boolean(
    (typeof incomingSystemText === "string" && incomingSystemText.trim()) || firstIncomingUserMessage
  );
  const contextAliasKey = canUseContextAlias
    ? makeSessionContextAliasKey({
        token,
        model,
        systemText: incomingSystemText,
        firstUserMessage: firstIncomingUserMessage
      })
    : "";
  const hasImplicitSessionContext = hasContextForImplicitSession({
    systemText: incomingSystemText,
    turns: incomingTurns
  });
  const explicitSessionRequested = hasExplicitSessionRequest(req.headers, sessionCandidate);
  const shortHistoryStart =
    !explicitSessionRequested &&
    incomingTurns.length <= 2 &&
    incomingUserCount <= 1 &&
    incomingAssistantCount <= 1 &&
    typeof userMessage === "string" &&
    userMessage.trim().length > 0;

  let sessionId = resolveSessionId(req.headers, sessionCandidate);
  let sessionSource = "explicit";
  if (sessionId !== "default-session") {
    sessionSource = "explicit";
  } else if (canUseContextAlias) {
    const mappedContextSession = sessionContextAliasStore.get(contextAliasKey);
    if (typeof mappedContextSession === "string" && mappedContextSession.trim()) {
      sessionId = mappedContextSession.trim();
      sessionSource = "context-alias";
    }
  }

  if (sessionId === "default-session" && hasImplicitSessionContext) {
    sessionId = deriveImplicitSessionId({
      systemText: incomingSystemText,
      turns: incomingTurns,
      userMessage
    });
    sessionSource = "implicit-context";
  }

  if (sessionId === "default-session" && allowSessionAliasFallback()) {
    const remembered = sessionAliasStore.get(sessionAliasKey);
    if (typeof remembered === "string" && remembered.trim()) {
      sessionId = remembered.trim();
      sessionSource = "alias-fallback";
    }
  }

  if (sessionId === "default-session") {
    sessionId = createEphemeralSessionId();
    sessionSource = "fallback-ephemeral";
  }

  if (allowSessionAliasFallback()) {
    sessionAliasStore.set(sessionAliasKey, sessionId);
    if (sessionAliasStore.size > 5000) {
      const firstAliasKey = sessionAliasStore.keys().next().value;
      if (firstAliasKey) {
        sessionAliasStore.delete(firstAliasKey);
      }
    }
  }
  if (canUseContextAlias && sessionId !== "default-session") {
    sessionContextAliasStore.set(contextAliasKey, sessionId);
    if (sessionContextAliasStore.size > 10000) {
      const firstContextAliasKey = sessionContextAliasStore.keys().next().value;
      if (firstContextAliasKey) {
        sessionContextAliasStore.delete(firstContextAliasKey);
      }
    }
  }
  const sessionKey = makeSessionKey({ token, model, sessionId });

  const runtime = getRuntimeState(sessionKey);
  const previousTurns = getSessionTurns(sessionKey).filter(
    (item) => item && (item.role === "user" || item.role === "assistant") && item.content
  );
  const forceFreshReset = shortHistoryStart && sessionSource !== "explicit";

  const authoritativeIncomingHistory =
    String(process.env.CAI_AUTHORITATIVE_HISTORY || "true")
      .trim()
      .toLowerCase() !== "false";
  const authoritativeForThisRequest =
    syncMode === "replay" ? allowReplayAuthoritativeMode() : authoritativeIncomingHistory;
  const systemText = incomingSystemText || runtime.systemText || "";
  const incomingHasHistory = incomingTurns.length > 1 || incomingTurns.some((item) => item.role === "assistant");
  const incomingHasAssistantHistory = incomingTurns.some((item) => item.role === "assistant");
  const replayCanAssumeContinuation =
    syncMode === "replay" &&
    assumeReplayContinuationFromIncomingHistory() &&
    runtime.bootstrapped !== true &&
    incomingHasAssistantHistory;

  let effectiveTurns = previousTurns;
  let resetConversation = false;
  let fullSyncNeeded = runtime.bootstrapped !== true && !replayCanAssumeContinuation;
  let rewriteApplied = false;
  let rewriteRequested = false;

  if (incomingHasHistory) {
    const normalizedIncomingTurns = ensureTrailingUserTurn(incomingTurns, userMessage);
    const explicitRewriteSignal = hasExplicitRewriteSignal(body);
    const likelyContinuation = looksLikeContinuationTurn(previousTurns, normalizedIncomingTurns, userMessage);
    const heuristicRewrite = shouldApplyRewrite(previousTurns, normalizedIncomingTurns, body) && !likelyContinuation;
    rewriteRequested = explicitRewriteSignal || heuristicRewrite;
    if (authoritativeForThisRequest && normalizedIncomingTurns.length >= 2) {
      effectiveTurns = setSessionTurns(sessionKey, normalizedIncomingTurns);
      fullSyncNeeded = true;
      resetConversation = runtime.bootstrapped === true;
    } else if (!previousTurns.length) {
      effectiveTurns = setSessionTurns(sessionKey, normalizedIncomingTurns);
    } else if (isAppendOnly(previousTurns, normalizedIncomingTurns)) {
      effectiveTurns = setSessionTurns(sessionKey, normalizedIncomingTurns);
    } else if (rewriteRequested) {
      effectiveTurns = setSessionTurns(sessionKey, normalizedIncomingTurns);
      resetConversation = true;
      fullSyncNeeded = true;
      rewriteApplied = true;
    } else {
      const lastStored = previousTurns[previousTurns.length - 1];
      const isDuplicateUser = lastStored?.role === "user" && lastStored.content === userMessage;
      if (!isDuplicateUser) {
        effectiveTurns = appendSessionTurns(sessionKey, [{ role: "user", content: userMessage }]);
      } else {
        effectiveTurns = previousTurns;
      }
    }
  } else {
    const lastStored = previousTurns[previousTurns.length - 1];
    const isDuplicateUser = lastStored?.role === "user" && lastStored.content === userMessage;

    if (!isDuplicateUser) {
      effectiveTurns = appendSessionTurns(sessionKey, [{ role: "user", content: userMessage }]);
    }
  }

  if (forceFreshReset) {
    const freshTurns = ensureTrailingUserTurn(incomingTurns, userMessage);
    if (freshTurns.length) {
      effectiveTurns = setSessionTurns(sessionKey, freshTurns);
    } else if (userMessage) {
      effectiveTurns = setSessionTurns(sessionKey, [{ role: "user", content: userMessage }]);
    } else {
      effectiveTurns = setSessionTurns(sessionKey, []);
    }
    fullSyncNeeded = true;
    resetConversation = true;
    rewriteApplied = false;
  }

  const useReplayFullSync = syncMode === "replay" && fullSyncNeeded;
  if (useReplayFullSync) {
    // Replay must start from a clean c.ai thread, otherwise it can append into unrelated chat state.
    resetConversation = true;
  }

  const upstreamMessage = useReplayFullSync
    ? ""
    : fullSyncNeeded
    ? buildTranscriptPrompt({
        systemText,
        turns: effectiveTurns
      })
    : userMessage;

  if (!useReplayFullSync && !upstreamMessage) {
    res.status(400).json({
      error: {
        message: "No valid messages to send upstream",
        type: "invalid_request_error",
        code: "invalid_messages"
      }
    });
    return;
  }

  try {
    let assistantText = "";
    let replayMeta = null;

    if (useReplayFullSync) {
      replayMeta = await sendCharacterMessageWithReplaySync({
        token,
        characterId,
        sessionId,
        turns: effectiveTurns,
        systemText,
        resetConversation
      });
      assistantText = replayMeta?.text || "";
    } else {
      assistantText = await sendCharacterMessage({
        token,
        characterId,
        sessionId,
        message: upstreamMessage,
        resetConversation
      });
    }

    const safeAssistantText = clampAssistantText(assistantText);
    if (safeAssistantText) {
      appendSessionTurns(sessionKey, [{ role: "assistant", content: safeAssistantText }]);
    }

    setRuntimeState(sessionKey, {
      bootstrapped: true,
      systemText
    });

    if (DEBUG_SYNC_HEADERS) {
      const modeValue = useReplayFullSync ? "replay-full-sync" : fullSyncNeeded ? "prompt-full-sync" : "continuation";
      res.setHeader("X-Proxy-Sync-Mode", modeValue);
      res.setHeader("X-Proxy-Sync-Requested-Mode", syncMode);
      res.setHeader("X-Proxy-Authoritative-Mode", authoritativeForThisRequest ? "true" : "false");
      res.setHeader("X-Proxy-Replay-Assume-Continuation", replayCanAssumeContinuation ? "true" : "false");
      res.setHeader("X-Proxy-Rewrite-Requested", rewriteRequested ? "true" : "false");
      res.setHeader("X-Proxy-Rewrite-Applied", rewriteApplied ? "true" : "false");
      res.setHeader("X-Proxy-Fresh-Reset", forceFreshReset ? "true" : "false");
      res.setHeader("X-Proxy-Session-Source", sessionSource);
      res.setHeader("X-Proxy-Session-Id", sessionId);
      res.setHeader("X-Proxy-Replayed-User-Turns", String(replayMeta?.replayedUserTurns || 0));
      res.setHeader("X-Proxy-Replay-Truncated", replayMeta?.truncatedByLimit ? "true" : "false");
    }

    if (stream) {
      writeSingleChunkSSE(res, { model, content: safeAssistantText });
      return;
    }

    res
      .status(200)
      .json(
        choiceCount > 1
          ? buildChatCompletionFromList({
              model,
              contents: Array.from({ length: choiceCount }, () => safeAssistantText)
            })
          : buildChatCompletion({ model, content: safeAssistantText })
      );
  } catch (error) {
    res.status(500).json({
      error: {
        message: error?.message || "Character.AI request failed",
        type: "server_error",
        code: "character_ai_error"
      }
    });
  }
}

