import { sendCharacterMessage } from "../../../lib/cai.js";
import {
  getDefaultModel,
  getLeakGuardTerms,
  listModels,
  resolveCharacterId,
  resolveSessionId,
  resolveToken
} from "../../../lib/config.js";
import {
  appendSessionTurns,
  buildHistoryBlock,
  makeSessionKey,
  setSessionTurns
} from "../../../lib/memory.js";
import { buildChatCompletion, buildChatCompletionFromList, writeSingleChunkSSE } from "../../../lib/openai-format.js";

const CYRILLIC_RE = /[\u0400-\u04FF]/;
const MAX_LOCAL_TOKEN = 64;
const MAX_ASSISTANT_CHARS = Number(process.env.CAI_MAX_ASSISTANT_CHARS || 2000);
const MAX_SYSTEM_CHARS = Number(process.env.CAI_MAX_SYSTEM_CHARS || 3200);
const MAX_SAMPLE_CHARS = Number(process.env.CAI_MAX_SAMPLE_CHARS || 1000);

const sessionPersonaStore = globalThis.__caiSessionPersonaStore || new Map();
globalThis.__caiSessionPersonaStore = sessionPersonaStore;

const RU_TEXT = {
  remembered: (token) => `\u0417\u0430\u043f\u043e\u043c\u043d\u0438\u043b: ${token}.`,
  notFound:
    "\u041d\u0435 \u0432\u0438\u0436\u0443 \u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u043d\u043e\u0433\u043e \u0447\u0438\u0441\u043b\u0430 \u0438\u043b\u0438 \u0441\u043b\u043e\u0432\u0430 \u0432 \u0438\u0441\u0442\u043e\u0440\u0438\u0438.",
  safeFallback: "\u041d\u0435 \u0441\u043c\u043e\u0433 \u0434\u0430\u0442\u044c \u0447\u0438\u0441\u0442\u044b\u0439 \u043e\u0442\u0432\u0435\u0442. \u041f\u043e\u0432\u0442\u043e\u0440\u0438 \u0437\u0430\u043f\u0440\u043e\u0441 \u043a\u043e\u0440\u043e\u0442\u043a\u043e."
};

const EN_TEXT = {
  remembered: (token) => `Remembered: ${token}.`,
  notFound: "I do not see a remembered number or word in this chat history.",
  safeFallback: "I could not produce a clean reply. Please repeat the request briefly."
};

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Session-Id, X-Conversation-Id, X-API-Key"
  );
}

function clipText(value, maxChars) {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (!Number.isFinite(maxChars) || maxChars < 1 || trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxChars)}...`;
}

function isRuText(value) {
  return typeof value === "string" && CYRILLIC_RE.test(value);
}

function pickLocale(...values) {
  for (const value of values) {
    if (isRuText(value)) {
      return "ru";
    }
  }
  return "en";
}

function localeText(locale) {
  return locale === "ru" ? RU_TEXT : EN_TEXT;
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

function getLastUserMessage(messages) {
  if (!Array.isArray(messages)) {
    return "";
  }

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role === "user") {
      return normalizeMessageContent(msg.content);
    }
  }

  return "";
}

function normalizeMessageList(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages
    .map((msg) => ({
      role: msg?.role,
      content: normalizeMessageContent(msg?.content)
    }))
    .filter((msg) => (msg.role === "system" || msg.role === "user" || msg.role === "assistant") && msg.content);
}

function parseRequestBody(req) {
  if (!req.body) {
    return {};
  }

  if (typeof req.body === "string") {
    return JSON.parse(req.body);
  }

  return req.body;
}

function normalizeForMatch(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .toLowerCase()
    .replace(/\u0451/g, "\u0435")
    .replace(/[^\p{L}\p{N}\s_-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeWords(value) {
  if (typeof value !== "string") {
    return [];
  }
  return value.match(/[A-Za-z\u0410-\u044f0-9_-]+/g) || [];
}

function isIdentityQuestion(userMessage) {
  const normalized = normalizeForMatch(userMessage);
  if (!normalized) {
    return false;
  }

  if (normalized.includes("who are you") || normalized.includes("what are you") || normalized.includes("your name")) {
    return true;
  }

  return (
    normalized.includes("\u043a\u0442\u043e \u0442\u044b") ||
    normalized.includes("\u043a\u0430\u043a \u0442\u0435\u0431\u044f \u0437\u043e\u0432\u0443\u0442") ||
    normalized.includes("\u0442\u0432\u043e\u0435 \u0438\u043c\u044f")
  );
}

function cleanNameCandidate(candidate) {
  if (typeof candidate !== "string") {
    return "";
  }

  let name = candidate.trim();
  name = name.replace(/["'`\u00ab\u00bb]+/g, "");
  name = name.replace(/[.,!?;:]+$/g, "");
  name = name.replace(/\s+/g, " ").trim();
  if (!name || name.length < 2 || name.length > 60) {
    return "";
  }
  return name;
}

function extractIdentityFromSystem(clientSystem) {
  if (typeof clientSystem !== "string" || !clientSystem.trim()) {
    return "";
  }

  const directPatterns = [
    /(?:\u043d\u0430\s+\u0432\u043e\u043f\u0440\u043e\u0441\s+["'\u00ab]?\u043a\u0442\u043e\s+\u0442\u044b["'\u00bb]?\s+\u043e\u0442\u0432\u0435\u0447\u0430\u0439\s*[:\-]\s*)([^\n]{1,200})/iu,
    /(?:if\s+asked\s+who\s+you\s+are\s*,?\s*answer\s*[:\-]\s*)([^\n]{1,200})/iu
  ];

  for (const pattern of directPatterns) {
    const match = clientSystem.match(pattern);
    if (match?.[1]) {
      const identity = cleanNameCandidate(match[1]);
      if (identity) {
        return identity;
      }
    }
  }

  return "";
}

function extractNameFromText(text) {
  if (typeof text !== "string" || !text.trim()) {
    return "";
  }

  const directPatterns = [
    /(?:\u043c\u0435\u043d\u044f\s+\u0437\u043e\u0432\u0443\u0442|\u044f\s+\u0437\u043e\u0432\u0443\u0441\u044c)\s+([A-Za-z\u0410-\u042f\u0430-\u044f0-9_-]{2,40}(?:\s+[A-Za-z\u0410-\u042f\u0430-\u044f0-9_-]{2,40}){0,2})/iu,
    /(?:my\s+name\s+is|i\s+am|i'm)\s+([A-Za-z][A-Za-z0-9_-]{1,40}(?:\s+[A-Za-z][A-Za-z0-9_-]{1,40}){0,2})/i,
    /(?:name|\u0438\u043c\u044f)\s*[:\-]\s*([^\n,.;]{2,60})/iu
  ];

  for (const pattern of directPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const name = cleanNameCandidate(match[1]);
      if (name) {
        return name;
      }
    }
  }

  const stopWords = new Set([
    "The",
    "A",
    "An",
    "In",
    "On",
    "At",
    "From",
    "With",
    "As",
    "Of",
    "And",
    "But",
    "Or",
    "If",
    "When",
    "While",
    "Her",
    "His",
    "Their",
    "Its"
  ]);

  const properWordPattern = /\b([A-Z][a-z]{1,24})\s+([A-Z][a-z]{1,24})(?:\s+([A-Z][a-z]{1,24}))?/g;
  let match;
  while ((match = properWordPattern.exec(text)) !== null) {
    const first = match[1];
    const second = match[2];
    const third = match[3];
    if (stopWords.has(first) || stopWords.has(second) || (third && stopWords.has(third))) {
      continue;
    }
    const candidate = cleanNameCandidate([first, second, third].filter(Boolean).join(" "));
    if (candidate) {
      return candidate;
    }
  }

  return "";
}

function collectAssistantSamples(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages
    .filter((msg) => msg.role === "assistant")
    .map((msg) => clipText(msg.content, MAX_SAMPLE_CHARS))
    .filter(Boolean)
    .slice(0, 2);
}

function getSessionPersona(sessionKey) {
  const raw = sessionPersonaStore.get(sessionKey);
  if (!raw || typeof raw !== "object") {
    return {
      name: "",
      identity: ""
    };
  }

  return {
    name: typeof raw.name === "string" ? raw.name : "",
    identity: typeof raw.identity === "string" ? raw.identity : ""
  };
}

function setSessionPersona(sessionKey, value) {
  const current = getSessionPersona(sessionKey);
  const merged = {
    name: cleanNameCandidate(value?.name) || current.name || "",
    identity: typeof value?.identity === "string" && value.identity.trim() ? value.identity.trim() : current.identity || ""
  };

  sessionPersonaStore.set(sessionKey, merged);

  if (sessionPersonaStore.size > 1000) {
    const firstKey = sessionPersonaStore.keys().next().value;
    if (firstKey) {
      sessionPersonaStore.delete(firstKey);
    }
  }

  return merged;
}

function buildPersonaHints({ clientSystem, assistantSamples, locale }) {
  const nameFromSystem = extractNameFromText(clientSystem);
  const nameFromSamples = extractNameFromText((assistantSamples || []).join("\n\n"));
  const name = nameFromSystem || nameFromSamples || "";

  let identity = extractIdentityFromSystem(clientSystem);
  if (!identity && name) {
    identity = locale === "ru" ? `\u042f ${name}.` : `I am ${name}.`;
  }

  return {
    name,
    identity
  };
}

function extractForcedLiteral(userMessage) {
  if (typeof userMessage !== "string" || !userMessage.trim()) {
    return "";
  }

  const generic = new Set([
    "\u0441\u043b\u043e\u0432\u043e",
    "\u043e\u0434\u043d\u0438\u043c",
    "word",
    "one word",
    "only",
    "just"
  ]);
  const patterns = [
    /(?:\u043e\u0442\u0432\u0435\u0442\u044c|\u043d\u0430\u043f\u0438\u0448\u0438)\s+(?:\u0442\u043e\u043b\u044c\u043a\u043e\s+)?(?:\u0441\u043b\u043e\u0432\u043e\u043c\s+)?[:\-]?\s*["'\u00ab]?([^"'\n\u00bb]{1,120})["'\u00bb]?/i,
    /answer\s+only(?:\s+with)?\s*[:\-]?\s*["']?([^"\n']{1,120})["']?/i
  ];

  for (const pattern of patterns) {
    const match = userMessage.match(pattern);
    if (!match?.[1]) {
      continue;
    }
    const value = match[1].trim();
    const normalized = normalizeForMatch(value);
    if (!value || !normalized || generic.has(normalized)) {
      continue;
    }
    return value;
  }

  return "";
}

function parseRememberInstruction(message) {
  if (typeof message !== "string" || !message.trim()) {
    return "";
  }

  const words = tokenizeWords(message);
  if (!words.length) {
    return "";
  }

  const lowers = words.map((word) => normalizeForMatch(word));
  const commandIndex = lowers.findIndex(
    (word) => word.startsWith("remember") || word.startsWith("memor") || word.startsWith("\u0437\u0430\u043f\u043e\u043c")
  );
  if (commandIndex === -1) {
    return "";
  }

  const ignore = new Set([
    "remember",
    "memorize",
    "this",
    "that",
    "number",
    "word",
    "code",
    "codeword",
    "please",
    "the",
    "a",
    "an",
    "\u0437\u0430\u043f\u043e\u043c\u043d\u0438",
    "\u0437\u0430\u043f\u043e\u043c\u043d\u0438\u0442\u0435",
    "\u044d\u0442\u043e",
    "\u0447\u0438\u0441\u043b\u043e",
    "\u043d\u043e\u043c\u0435\u0440",
    "\u0441\u043b\u043e\u0432\u043e",
    "\u043a\u043e\u0434",
    "\u043a\u043e\u0434\u043e\u0432\u043e\u0435",
    "\u043f\u043e\u0436\u0430\u043b\u0443\u0439\u0441\u0442\u0430",
    "\u043f\u0436"
  ]);

  for (let i = commandIndex + 1; i < words.length; i += 1) {
    const raw = words[i];
    const clean = raw.replace(/^["'\u00ab]+|["'\u00bb]+$/g, "").trim();
    if (!clean || clean.length > MAX_LOCAL_TOKEN) {
      continue;
    }
    const lower = normalizeForMatch(clean);
    if (!lower || ignore.has(lower)) {
      continue;
    }
    if (/^\d{1,64}$/.test(clean)) {
      return clean;
    }
  }

  for (let i = commandIndex + 1; i < words.length; i += 1) {
    const raw = words[i];
    const clean = raw.replace(/^["'\u00ab]+|["'\u00bb]+$/g, "").trim();
    if (!clean || clean.length > MAX_LOCAL_TOKEN) {
      continue;
    }
    const lower = normalizeForMatch(clean);
    if (!lower || ignore.has(lower)) {
      continue;
    }
    return clean;
  }

  const quoted = message.match(/["'\u00ab]([^"'\u00bb]{1,64})["'\u00bb]/);
  if (quoted?.[1]) {
    const token = quoted[1].trim();
    if (token) {
      return token;
    }
  }

  return "";
}

function isMemoryRecallQuestion(userMessage) {
  const normalized = normalizeForMatch(userMessage);
  if (!normalized) {
    return false;
  }

  const hasRememberStem = normalized.includes("\u0437\u0430\u043f\u043e\u043c") || normalized.includes("remember");
  const hasAskCue =
    normalized.includes("\u043a\u0430\u043a\u043e\u0435") ||
    normalized.includes("\u043a\u0430\u043a\u043e\u0439") ||
    normalized.includes("\u043a\u0430\u043a\u0443\u044e") ||
    normalized.includes("\u0447\u0442\u043e") ||
    normalized.includes("what") ||
    normalized.includes("which");
  const hasObjectStem =
    normalized.includes("\u0447\u0438\u0441\u043b") ||
    normalized.includes("\u043d\u043e\u043c\u0435\u0440") ||
    normalized.includes("\u0441\u043b\u043e\u0432") ||
    normalized.includes("\u043a\u043e\u0434") ||
    normalized.includes("number") ||
    normalized.includes("word") ||
    normalized.includes("code");

  if (hasRememberStem && hasAskCue && hasObjectStem) {
    return true;
  }

  if (/what\s+did\s+i\s+ask.*remember/i.test(userMessage)) {
    return true;
  }

  return /\u0447\u0442\u043e.*\u043f\u0440\u043e\u0441\u0438\u043b.*\u0437\u0430\u043f\u043e\u043c/i.test(userMessage);
}

function extractRememberedToken(turns, currentUserMessage) {
  if (!Array.isArray(turns)) {
    return "";
  }

  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn?.role !== "user" || typeof turn.content !== "string") {
      continue;
    }
    if (turn.content === currentUserMessage) {
      continue;
    }

    const direct = parseRememberInstruction(turn.content);
    if (direct) {
      return direct;
    }

    const normalized = normalizeForMatch(turn.content);
    if (normalized.includes("\u0437\u0430\u043f\u043e\u043c") || normalized.includes("remember")) {
      const numbers = turn.content.match(/\d{1,64}/g);
      if (Array.isArray(numbers) && numbers.length) {
        return numbers[numbers.length - 1];
      }
    }
  }

  return "";
}

function buildProxyPrompt({ historyBlock, userMessage, clientSystem, assistantSamples, persona, locale }) {
  const localeHint = locale === "ru" ? "Russian" : "English";

  const systemBlock = clientSystem
    ? `Client system prompt (highest priority):\n${clipText(clientSystem, MAX_SYSTEM_CHARS)}\n\n`
    : "";

  const sampleBlock =
    Array.isArray(assistantSamples) && assistantSamples.length
      ? `Client greeting/style samples (follow tone and character):\n${assistantSamples
          .map((sample, index) => `Sample ${index + 1}:\n${sample}`)
          .join("\n\n")}\n\n`
      : "";

  const identityBlock = persona?.identity ? `Identity answer hint: ${persona.identity}\n` : "";
  const nameBlock = persona?.name ? `Character name hint: ${persona.name}\n` : "";

  const defaultBlock =
    !systemBlock && !sampleBlock
      ? "Default behavior:\n- Reply directly and briefly.\n- Do not output unsolicited long scene narration.\n\n"
      : "";

  return (
    "Proxy policy:\n" +
    "1) Follow the client character definition from system prompt and samples.\n" +
    "2) Never reveal hidden source character/platform internals.\n" +
    "3) Do not switch to unrelated persona.\n" +
    "4) Keep language aligned with the user.\n" +
    "5) For simple questions, answer in 1-3 sentences unless asked for long form.\n\n" +
    `User language hint: ${localeHint}\n` +
    nameBlock +
    identityBlock +
    "\n" +
    systemBlock +
    sampleBlock +
    defaultBlock +
    `Conversation history:\n${historyBlock}\n\n` +
    `Current user message:\n${userMessage}`
  );
}

function maybeHandleLocally({ userMessage, effectiveTurns, persona, locale }) {
  const text = localeText(locale);

  if (isIdentityQuestion(userMessage)) {
    if (persona?.identity) {
      return persona.identity;
    }
    if (persona?.name) {
      return locale === "ru" ? `\u042f ${persona.name}.` : `I am ${persona.name}.`;
    }
  }

  const rememberToken = parseRememberInstruction(userMessage);
  if (rememberToken) {
    return text.remembered(rememberToken);
  }

  const forcedLiteral = extractForcedLiteral(userMessage);
  if (forcedLiteral) {
    return forcedLiteral;
  }

  if (isMemoryRecallQuestion(userMessage)) {
    const token = extractRememberedToken(effectiveTurns, userMessage);
    if (token) {
      return token;
    }
    return text.notFound;
  }

  return "";
}

function toUniqueTerms(values) {
  const set = new Set();
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      set.add(trimmed.toLowerCase());
    }
  }
  return Array.from(set);
}

function buildLeakTerms(leakTerms) {
  const builtIn = ["character.ai", "c.ai", "anya", "\u0430\u043d\u044f", "\u0431\u0440\u0430\u0442\u0438\u043a"];
  const fromEnv =
    typeof process.env.CAI_LEAK_BLOCK_TERMS === "string" ? process.env.CAI_LEAK_BLOCK_TERMS.split(",") : [];

  return toUniqueTerms([...(Array.isArray(leakTerms) ? leakTerms : []), ...builtIn, ...fromEnv]);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripMemoryResetClaims(text) {
  if (typeof text !== "string") {
    return "";
  }

  return text
    .replace(/[^.!?\n]*(?:can'?t|cannot)\s+remember[^.!?\n]*between\s+messages[^.!?\n]*[.!?]?/giu, "")
    .replace(/[^.!?\n]*\u043d\u0435\s+\u043c\u043e\u0433\u0443\s+\u0437\u0430\u043f\u043e\u043c\u043d[^.!?\n]*[.!?]?/giu, "");
}

function sanitizeAssistantText(text, leakTerms, locale) {
  const localized = localeText(locale);
  let output = typeof text === "string" ? text : "";
  if (!output) {
    return localized.safeFallback;
  }

  output = output.replace(/\*[^*]{1,120}\*/g, "");
  output = output.replace(/^[ \t]*[A-Za-z\u0410-\u044f0-9_-]{2,24}\s*:\s*/gm, "");
  output = output.replace(/\bcharacter\.ai\b/gi, "the platform");
  output = output.replace(/\bc\.ai\b/gi, "the platform");
  output = stripMemoryResetClaims(output);

  const terms = toUniqueTerms(Array.isArray(leakTerms) ? leakTerms : []);
  for (const term of terms) {
    const termNorm = normalizeForMatch(term);
    if (!termNorm || termNorm.length < 2) {
      continue;
    }
    const regex = new RegExp(escapeRegExp(term), "giu");
    output = output.replace(regex, "");
  }

  output = output.replace(/[ \t]+\n/g, "\n");
  output = output.replace(/\n{3,}/g, "\n\n");
  output = output.replace(/[ ]{2,}/g, " ");
  output = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();

  if (!output) {
    return localized.safeFallback;
  }

  if (output.length > MAX_ASSISTANT_CHARS) {
    return `${output.slice(0, MAX_ASSISTANT_CHARS)}...`;
  }

  return output;
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
  const choiceCount = Math.max(1, Math.min(8, Number(body.n) || 1));
  const normalizedMessages = normalizeMessageList(body.messages);
  const userMessage = getLastUserMessage(normalizedMessages);
  const locale = pickLocale(userMessage, normalizedMessages.map((msg) => msg.content).join("\n"));

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

  const sessionId = resolveSessionId(
    req.headers,
    body.user || body.conversation_id || body.conversationId || body.chat_id || body.chatId
  );
  const leakTerms = buildLeakTerms(getLeakGuardTerms(characterId));
  const sessionKey = makeSessionKey({ token, model, sessionId });

  const clientSystem = normalizedMessages
    .filter((msg) => msg.role === "system")
    .map((msg) => msg.content)
    .join("\n")
    .trim();
  const assistantSamples = collectAssistantSamples(normalizedMessages);

  const inferredPersona = buildPersonaHints({ clientSystem, assistantSamples, locale });
  const sessionPersona = setSessionPersona(sessionKey, inferredPersona);

  const nonSystemMessages = normalizedMessages.filter((msg) => msg.role !== "system");
  let effectiveTurns;
  if (nonSystemMessages.length > 1) {
    effectiveTurns = setSessionTurns(sessionKey, nonSystemMessages);
  } else {
    effectiveTurns = appendSessionTurns(sessionKey, [{ role: "user", content: userMessage }]);
  }

  const prompt = buildProxyPrompt({
    historyBlock: buildHistoryBlock(effectiveTurns),
    userMessage,
    clientSystem,
    assistantSamples,
    persona: sessionPersona,
    locale
  });

  try {
    const localResponse = maybeHandleLocally({
      userMessage,
      effectiveTurns,
      persona: sessionPersona,
      locale
    });

    if (localResponse) {
      appendSessionTurns(sessionKey, [{ role: "assistant", content: localResponse }]);
      if (stream) {
        writeSingleChunkSSE(res, { model, content: localResponse });
        return;
      }
      res
        .status(200)
        .json(
          choiceCount > 1
            ? buildChatCompletionFromList({
                model,
                contents: Array.from({ length: choiceCount }, () => localResponse)
              })
            : buildChatCompletion({ model, content: localResponse })
        );
      return;
    }

    const assistantText = await sendCharacterMessage({
      token,
      characterId,
      sessionId,
      message: prompt
    });
    const safeAssistantText = sanitizeAssistantText(assistantText, leakTerms, locale);

    appendSessionTurns(sessionKey, [{ role: "assistant", content: safeAssistantText }]);

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
