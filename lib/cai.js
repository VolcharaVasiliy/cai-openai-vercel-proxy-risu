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
  try {
    await withSoftTimeout(client.character.create_new_conversation(false, { char_id: characterId }), 8000);
  } catch {
    // Some versions can fail this call; continue with the connected chat.
  }
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

export async function sendCharacterMessage({ token, characterId, sessionId, message }) {
  const key = cacheKey(token, characterId, sessionId);

  let cached = clientCache.get(key);
  if (!cached) {
    cached = await createClient(token, characterId, sessionId);
    clientCache.set(key, cached);
  }

  try {
    const response = await cached.client.character.send_message(message, false, "", {
      timeout_ms: getRequestTimeoutMs()
    });
    return extractText(response);
  } catch {
    // Retry once with a fresh connection if the socket/session is stale.
    clientCache.delete(key);
    const retryCached = await createClient(token, characterId, sessionId);
    clientCache.set(key, retryCached);
    const retryResponse = await retryCached.client.character.send_message(message, false, "", {
      timeout_ms: getRequestTimeoutMs()
    });
    return extractText(retryResponse);
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
