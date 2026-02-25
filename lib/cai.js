import { CAINode } from "cainode";

const clientCache = globalThis.__caiClientCache || new Map();
globalThis.__caiClientCache = clientCache;

function cacheKey(token, characterId, sessionId) {
  return `${token}::${characterId}::${sessionId}`;
}

async function withTimeout(promise, ms, stage) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timeout during ${stage}`)), ms);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function withSoftTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function getConnectTimeoutMs() {
  const value = Number(process.env.CAI_CONNECT_TIMEOUT_MS || 45000);
  if (!Number.isFinite(value) || value < 1) {
    return 45000;
  }
  return value;
}

async function createClient(token, characterId, sessionId) {
  const client = new CAINode();
  const connectTimeout = getConnectTimeoutMs();
  await withTimeout(client.login(token), connectTimeout, "login");
  await withTimeout(client.character.connect(characterId), connectTimeout, "connect");
  return {
    client,
    sessionId
  };
}

function extractText(response) {
  if (typeof response?.turn?.candidates?.[0]?.raw_content === "string") {
    return response.turn.candidates[0].raw_content;
  }

  if (typeof response?.text === "string") {
    return response.text;
  }

  return "";
}

function getRequestTimeoutMs() {
  const value = Number(process.env.CAI_REQUEST_TIMEOUT_MS || 60000);
  if (!Number.isFinite(value) || value < 1) {
    return 60000;
  }
  return value;
}

function shouldInjectSystemIntoReplay() {
  const raw = String(process.env.CAI_REPLAY_INCLUDE_SYSTEM || "")
    .trim()
    .toLowerCase();
  if (!raw) {
    return true;
  }
  return raw !== "false";
}

function getReplayUserTurnsLimit() {
  const value = Number(process.env.CAI_REPLAY_MAX_USER_TURNS || 0);
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

function clampReplayUserTurns(userTurns) {
  const turns = Array.isArray(userTurns) ? userTurns : [];
  const limit = getReplayUserTurnsLimit();
  if (!limit || turns.length <= limit) {
    return {
      turns,
      truncated: false
    };
  }
  return {
    turns: turns.slice(-limit),
    truncated: true
  };
}

function normalizeReplayUserTurns(turns) {
  if (!Array.isArray(turns)) {
    return [];
  }

  return turns
    .filter((item) => item && item.role === "user" && typeof item.content === "string")
    .map((item) => item.content.trim())
    .filter(Boolean);
}

function makeReplayBootstrapMessage(systemText, userMessage) {
  const cleanUser = typeof userMessage === "string" ? userMessage.trim() : "";
  if (!cleanUser) {
    return "";
  }

  const cleanSystem = typeof systemText === "string" ? systemText.trim() : "";
  if (!cleanSystem || !shouldInjectSystemIntoReplay()) {
    return cleanUser;
  }

  return `SYSTEM:\n${cleanSystem}\n\nUSER:\n${cleanUser}`;
}

async function sendRawCharacterMessage(client, message) {
  return client.character.send_message(message, false, "", {
    timeout_ms: getRequestTimeoutMs()
  });
}

async function createNewConversationIfNeeded(client, characterId) {
  try {
    await withSoftTimeout(client.character.create_new_conversation(false, { char_id: characterId }), 5000);
  } catch {
    // Best effort only.
  }
}

async function runReplaySync({ cached, characterId, resetConversation, systemText, turns }) {
  if (resetConversation) {
    await createNewConversationIfNeeded(cached.client, characterId);
  }

  const rawUserTurns = normalizeReplayUserTurns(turns);
  if (!rawUserTurns.length) {
    throw new Error("Replay sync requires at least one user turn.");
  }

  const limited = clampReplayUserTurns(rawUserTurns);
  const replayMessages = limited.turns.map((content, index) =>
    index === 0 ? makeReplayBootstrapMessage(systemText, content) : content
  );

  if (!replayMessages.length || !replayMessages[replayMessages.length - 1]) {
    throw new Error("Replay sync failed to build replay messages.");
  }

  let lastResponse = null;
  for (const replayMessage of replayMessages) {
    lastResponse = await sendRawCharacterMessage(cached.client, replayMessage);
  }

  return {
    text: extractText(lastResponse),
    replayedUserTurns: replayMessages.length,
    truncatedByLimit: limited.truncated
  };
}

export async function sendCharacterMessage({ token, characterId, sessionId, message, resetConversation = false }) {
  const key = cacheKey(token, characterId, sessionId);

  let cached = clientCache.get(key);
  if (!cached) {
    cached = await createClient(token, characterId, sessionId);
    clientCache.set(key, cached);
  }

  if (resetConversation) {
    await createNewConversationIfNeeded(cached.client, characterId);
  }

  try {
    const response = await sendRawCharacterMessage(cached.client, message);
    return extractText(response);
  } catch {
    // Retry once with a fresh connection if the socket/session is stale.
    clientCache.delete(key);
    const retryCached = await createClient(token, characterId, sessionId);
    clientCache.set(key, retryCached);
    if (resetConversation) {
      await createNewConversationIfNeeded(retryCached.client, characterId);
    }
    const retryResponse = await sendRawCharacterMessage(retryCached.client, message);
    return extractText(retryResponse);
  }
}

export async function sendCharacterMessageWithReplaySync({
  token,
  characterId,
  sessionId,
  turns,
  systemText = "",
  resetConversation = true
}) {
  const key = cacheKey(token, characterId, sessionId);

  let cached = clientCache.get(key);
  if (!cached) {
    cached = await createClient(token, characterId, sessionId);
    clientCache.set(key, cached);
  }

  try {
    return await runReplaySync({
      cached,
      characterId,
      resetConversation,
      systemText,
      turns
    });
  } catch {
    clientCache.delete(key);
    const retryCached = await createClient(token, characterId, sessionId);
    clientCache.set(key, retryCached);
    return await runReplaySync({
      cached: retryCached,
      characterId,
      resetConversation,
      systemText,
      turns
    });
  }
}

export async function probeCharacterConnection({ token, characterId }) {
  const start = Date.now();
  const connectTimeout = getConnectTimeoutMs();
  const client = new CAINode();

  await withTimeout(client.login(token), connectTimeout, "login");
  await withTimeout(client.character.connect(characterId), connectTimeout, "connect");

  try {
    await withSoftTimeout(client.character.disconnect(), 3000);
  } catch {}
  try {
    await withSoftTimeout(client.logout(), 3000);
  } catch {}

  return {
    ok: true,
    latency_ms: Date.now() - start
  };
}
