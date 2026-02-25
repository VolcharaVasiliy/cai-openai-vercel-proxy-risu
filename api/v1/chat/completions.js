import { sendCharacterMessage } from "../../../lib/cai.js";
import { getDefaultModel, listModels, resolveCharacterId, resolveSessionId, resolveToken } from "../../../lib/config.js";
import { appendSessionTurns, getSessionTurns, makeSessionKey, setSessionTurns } from "../../../lib/memory.js";
import { buildChatCompletion, buildChatCompletionFromList, writeSingleChunkSSE } from "../../../lib/openai-format.js";

const MAX_ASSISTANT_CHARS = Number(process.env.CAI_MAX_ASSISTANT_CHARS || 8000);

const sessionRuntimeStore = globalThis.__caiSessionRuntimeStore || new Map();
globalThis.__caiSessionRuntimeStore = sessionRuntimeStore;

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
    return JSON.parse(req.body);
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

function normalizeMessageList(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }

  const normalized = messages
    .map((msg) => ({
      role: msg?.role,
      content: normalizeMessageContent(msg?.content)
    }))
    .filter((msg) => (msg.role === "system" || msg.role === "user" || msg.role === "assistant") && msg.content);

  return rebuildMessagesFromRisuBlob(normalized);
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

function parseRisuConversationBlob(content) {
  if (typeof content !== "string" || !content.trim()) {
    return null;
  }

  const historyMarker = findFirstMarkerMatch(content, [
    /^\s*Conversation history\s*:/im,
    /^\s*История диалога\s*:/im,
    /^\s*История чата\s*:/im
  ]);
  const currentMarker = findFirstMarkerMatch(content, [
    /^\s*Current user message\s*:/im,
    /^\s*Current user input\s*:/im,
    /^\s*Текущее сообщение пользователя\s*:/im,
    /^\s*Сообщение пользователя\s*:/im,
    /^\s*Текущее сообщение\s*:/im
  ]);

  if (!historyMarker || !currentMarker) {
    return null;
  }

  const historyStart = historyMarker.index + historyMarker.length;
  if (currentMarker.index <= historyStart) {
    return null;
  }

  const systemText = content.slice(0, historyMarker.index).trim();
  const historySection = content.slice(historyStart, currentMarker.index).trim();
  const currentUserMessage = content.slice(currentMarker.index + currentMarker.length).trim();

  if (!currentUserMessage) {
    return null;
  }

  const turns = [];
  let lastTurn = null;

  for (const line of historySection.split(/\r?\n/)) {
    const roleMatch = line.match(
      /^\s*(assistant|user|ассистент|пользователь|юзер)\s*:\s*(.*)$/i
    );

    if (roleMatch) {
      const rawRole = roleMatch[1].toLowerCase();
      const contentPart = roleMatch[2].trim();
      const role =
        rawRole === "assistant" || rawRole === "ассистент"
          ? "assistant"
          : "user";

      lastTurn = {
        role,
        content: contentPart
      };
      turns.push(lastTurn);
      continue;
    }

    const continuation = line.trimEnd();
    if (lastTurn && continuation) {
      lastTurn.content = lastTurn.content ? `${lastTurn.content}\n${continuation}` : continuation;
    }
  }

  const normalizedTurns = turns.filter((item) => item && item.content);
  normalizedTurns.push({
    role: "user",
    content: currentUserMessage
  });

  return {
    systemText,
    turns: normalizedTurns
  };
}

function rebuildMessagesFromRisuBlob(messages) {
  if (!Array.isArray(messages) || !messages.length) {
    return [];
  }

  const lastUserMessage = [...messages].reverse().find((msg) => msg.role === "user" && msg.content);
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

function shouldResetConversation(previousTurns, nextTurns) {
  if (!Array.isArray(previousTurns) || !previousTurns.length) {
    return false;
  }

  if (!Array.isArray(nextTurns) || nextTurns.length <= 1) {
    return false;
  }

  return !isAppendOnly(previousTurns, nextTurns);
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
  const sessionKey = makeSessionKey({ token, model, sessionId });

  const runtime = getRuntimeState(sessionKey);
  const previousTurns = getSessionTurns(sessionKey).filter(
    (item) => item && (item.role === "user" || item.role === "assistant") && item.content
  );

  const { systemText: incomingSystemText, turns: incomingTurns } = splitIncomingMessages(normalizedMessages);
  const systemText = incomingSystemText || runtime.systemText || "";
  const systemChanged = Boolean(incomingSystemText && incomingSystemText !== runtime.systemText);
  const incomingHasHistory = incomingTurns.length > 1 || incomingTurns.some((item) => item.role === "assistant");

  let effectiveTurns = previousTurns;
  let resetConversation = false;
  let fullSyncNeeded = runtime.bootstrapped !== true;

  if (incomingHasHistory) {
    const normalizedIncomingTurns = ensureTrailingUserTurn(incomingTurns, userMessage);
    const rewritten = shouldResetConversation(previousTurns, normalizedIncomingTurns);
    effectiveTurns = setSessionTurns(sessionKey, normalizedIncomingTurns);
    if (rewritten) {
      resetConversation = true;
      fullSyncNeeded = true;
    }
  } else {
    const lastStored = previousTurns[previousTurns.length - 1];
    const isDuplicateUser = lastStored?.role === "user" && lastStored.content === userMessage;

    if (!isDuplicateUser) {
      effectiveTurns = appendSessionTurns(sessionKey, [{ role: "user", content: userMessage }]);
    }
  }

  if (systemChanged) {
    if (runtime.bootstrapped === true) {
      resetConversation = true;
    }
    fullSyncNeeded = true;
  }

  const upstreamMessage = fullSyncNeeded
    ? buildTranscriptPrompt({
        systemText,
        turns: effectiveTurns
      })
    : userMessage;

  if (!upstreamMessage) {
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
    const assistantText = await sendCharacterMessage({
      token,
      characterId,
      sessionId,
      message: upstreamMessage,
      resetConversation
    });

    const safeAssistantText = clampAssistantText(assistantText);
    if (safeAssistantText) {
      appendSessionTurns(sessionKey, [{ role: "assistant", content: safeAssistantText }]);
    }

    setRuntimeState(sessionKey, {
      bootstrapped: true,
      systemText
    });

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
