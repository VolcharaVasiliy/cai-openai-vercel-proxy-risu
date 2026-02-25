function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function completionId() {
  const random = Math.random().toString(16).slice(2, 10);
  return `chatcmpl-${Date.now()}-${random}`;
}

export function buildChatCompletion({ model, content }) {
  return buildChatCompletionFromList({
    model,
    contents: [content]
  });
}

export function buildChatCompletionFromList({ model, contents }) {
  const safeContents = Array.isArray(contents) && contents.length ? contents : [""];

  return {
    id: completionId(),
    object: "chat.completion",
    created: nowSeconds(),
    model,
    choices: safeContents.map((value, index) => ({
        index,
        message: {
          role: "assistant",
          content: typeof value === "string" ? value : ""
        },
        finish_reason: "stop"
      })),
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  };
}

export function writeSingleChunkSSE(res, { model, content }) {
  const id = completionId();
  const created = nowSeconds();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const chunk = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          content
        },
        finish_reason: null
      }
    ]
  };

  const done = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop"
      }
    ]
  };

  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write(`data: ${JSON.stringify(done)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}
