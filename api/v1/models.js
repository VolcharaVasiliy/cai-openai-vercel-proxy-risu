import { getDefaultModel, listModels } from "../../lib/config.js";

export default async function handler(req, res) {
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

  const available = listModels();
  const fallback = getDefaultModel();
  const modelIds = available.length ? available : [fallback];

  res.status(200).json({
    object: "list",
    data: modelIds.map((id) => ({
      id,
      object: "model",
      created: 0,
      owned_by: "character-ai-proxy"
    }))
  });
}
