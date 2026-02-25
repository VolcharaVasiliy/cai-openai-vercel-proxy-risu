const DEFAULT_MODEL_ALIAS = process.env.CAI_MODEL_ALIAS || "cai-default";

function parseModelMap(raw) {
  if (!raw || typeof raw !== "string") {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const map = {};
    for (const [model, characterId] of Object.entries(parsed)) {
      if (
        typeof model === "string" &&
        model.trim() &&
        typeof characterId === "string" &&
        characterId.trim()
      ) {
        map[model.trim()] = characterId.trim();
      }
    }
    return map;
  } catch {
    return {};
  }
}

const modelMap = parseModelMap(process.env.CAI_MODEL_MAP_JSON);

if (process.env.CAI_CHARACTER_ID && !modelMap[DEFAULT_MODEL_ALIAS]) {
  modelMap[DEFAULT_MODEL_ALIAS] = process.env.CAI_CHARACTER_ID;
}

export function listModels() {
  return Object.keys(modelMap);
}

export function getDefaultModel() {
  return DEFAULT_MODEL_ALIAS;
}

export function resolveCharacterId(model) {
  if (typeof model !== "string") {
    return null;
  }

  const trimmed = model.trim();
  if (!trimmed) {
    return null;
  }

  return modelMap[trimmed] || null;
}

export function resolveToken(authorizationHeader) {
  if (typeof authorizationHeader === "object" && authorizationHeader !== null) {
    const headers = authorizationHeader;
    const bearer =
      headers.authorization ||
      headers.Authorization ||
      headers["authorization"] ||
      headers["Authorization"];
    if (typeof bearer === "string" && bearer.startsWith("Bearer ")) {
      const token = bearer.slice("Bearer ".length).trim();
      if (token) {
        return token;
      }
    }

    const xApiKey =
      headers["x-api-key"] ||
      headers["X-API-Key"] ||
      headers["x_api_key"] ||
      headers["X_API_KEY"];

    if (typeof xApiKey === "string" && xApiKey.trim()) {
      return xApiKey.trim();
    }
  } else if (typeof authorizationHeader === "string" && authorizationHeader.startsWith("Bearer ")) {
    const token = authorizationHeader.slice("Bearer ".length).trim();
    if (token) {
      return token;
    }
  }

  const allowServerToken =
    String(process.env.CAI_ALLOW_SERVER_TOKEN || "")
      .trim()
      .toLowerCase() === "true";
  if (allowServerToken) {
    const serverToken = process.env.CAI_TOKEN;
    if (typeof serverToken === "string" && serverToken.trim()) {
      return serverToken.trim();
    }
  }

  return null;
}

export function resolveSessionId(reqHeaders, bodyUserField) {
  const rawHeader =
    reqHeaders?.["x-session-id"] ||
    reqHeaders?.["X-Session-Id"] ||
    reqHeaders?.["x-conversation-id"] ||
    reqHeaders?.["X-Conversation-Id"];

  const candidates = [rawHeader, bodyUserField, "default-session"];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim().slice(0, 80);
    }
  }

  return "default-session";
}

export function getLeakGuardTerms(characterId) {
  const terms = [];
  if (typeof characterId === "string" && characterId.trim()) {
    terms.push(characterId.trim());
  }

  const extra = process.env.CAI_LEAK_GUARD_TERMS;
  if (typeof extra === "string" && extra.trim()) {
    for (const part of extra.split(",")) {
      const value = part.trim();
      if (value) {
        terms.push(value);
      }
    }
  }

  return terms;
}
