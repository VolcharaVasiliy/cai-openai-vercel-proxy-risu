import {
  getDefaultModel,
  listModels,
  resolveCharacterId,
  resolveToken
} from "../../lib/config.js";
import { probeCharacterConnection } from "../../lib/cai.js";

function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  return `${proto}://${host}`;
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Session-Id, X-Conversation-Id, X-API-Key");
}

export default async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({
      error: {
        message: "Method not allowed",
        type: "invalid_request_error",
        code: "method_not_allowed"
      }
    });
    return;
  }

  const baseUrl = getBaseUrl(req);
  const models = listModels();
  const defaultModel = getDefaultModel();
  const defaultCharacter = resolveCharacterId(defaultModel);

  const result = {
    status: "ok",
    service: "cai-openai-vercel-proxy",
    time: new Date().toISOString(),
    endpoints: {
      guide: `${baseUrl}/`,
      chat_completions: `${baseUrl}/v1/chat/completions`,
      models: `${baseUrl}/v1/models`,
      health: `${baseUrl}/v1/health`
    },
    risu: {
      recommended_provider: "openai_compatible",
      format: "OpenAI Compatible",
      recommended_base_url: baseUrl,
      recommended_model: defaultModel,
      autofill_request_url: true
    },
    config: {
      models_configured: models.length,
      default_model: defaultModel,
      has_default_character_mapping: Boolean(defaultCharacter),
      has_server_token: Boolean(process.env.CAI_TOKEN && process.env.CAI_TOKEN.trim()),
      memory_enabled: true
    },
    checks: {
      endpoint_ready: models.length > 0
    }
  };

  const liveRequested = req.query?.live === "1" || req.query?.check === "live";
  if (liveRequested) {
    const token = resolveToken(req.headers);
    if (!token) {
      result.checks.live = {
        ok: false,
        reason: "No token provided. Set CAI_TOKEN or send Authorization/X-API-Key."
      };
      res.status(200).json(result);
      return;
    }

    if (!defaultCharacter) {
      result.checks.live = {
        ok: false,
        reason: "Default model is not mapped to a character. Configure CAI_CHARACTER_ID or CAI_MODEL_MAP_JSON."
      };
      res.status(200).json(result);
      return;
    }

    try {
      const live = await probeCharacterConnection({
        token,
        characterId: defaultCharacter
      });
      result.checks.live = live;
    } catch (error) {
      result.checks.live = {
        ok: false,
        reason: error?.message || "Live check failed"
      };
    }
  }

  res.status(200).json(result);
}
