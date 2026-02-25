import http from "node:http";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import path from "node:path";
import process from "node:process";

import chatHandler from "./api/v1/chat/completions.js";
import modelsHandler from "./api/v1/models.js";
import healthHandler from "./api/v1/health.js";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = path.resolve(".");

function getHandler(pathname) {
  if (pathname === "/v1/chat/completions" || pathname === "/chat/completions") {
    return chatHandler;
  }
  if (pathname === "/v1/models" || pathname === "/models") {
    return modelsHandler;
  }
  if (pathname === "/v1/health" || pathname === "/health") {
    return healthHandler;
  }
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function createCompatRes(nodeRes) {
  const state = {
    statusCode: 200
  };

  return {
    setHeader(key, value) {
      nodeRes.setHeader(key, value);
    },
    status(code) {
      state.statusCode = code;
      return this;
    },
    json(payload) {
      if (!nodeRes.headersSent) {
        nodeRes.statusCode = state.statusCode;
        nodeRes.setHeader("Content-Type", "application/json; charset=utf-8");
      }
      nodeRes.end(JSON.stringify(payload));
      return this;
    },
    write(chunk) {
      if (!nodeRes.headersSent) {
        nodeRes.statusCode = state.statusCode;
      }
      nodeRes.write(chunk);
      return true;
    },
    end(chunk) {
      if (!nodeRes.headersSent) {
        nodeRes.statusCode = state.statusCode;
      }
      nodeRes.end(chunk);
    }
  };
}

async function serveIndex(nodeRes) {
  const filePath = path.join(ROOT, "index.html");
  const html = await readFile(filePath, "utf8");
  nodeRes.statusCode = 200;
  nodeRes.setHeader("Content-Type", "text/html; charset=utf-8");
  nodeRes.end(html);
}

const server = http.createServer(async (req, nodeRes) => {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    const pathname = parsedUrl.pathname;

    if (pathname === "/" && req.method === "GET") {
      await serveIndex(nodeRes);
      return;
    }

    const handler = getHandler(pathname);
    if (!handler) {
      nodeRes.statusCode = 404;
      nodeRes.setHeader("Content-Type", "application/json; charset=utf-8");
      nodeRes.end(
        JSON.stringify({
          error: {
            message: "Not found",
            code: "not_found"
          }
        })
      );
      return;
    }

    const bodyText =
      req.method === "POST" || req.method === "PUT" || req.method === "PATCH" ? await readBody(req) : "";

    let body = {};
    if (bodyText) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = bodyText;
      }
    }

    const query = Object.fromEntries(parsedUrl.searchParams.entries());
    const compatReq = {
      method: req.method,
      headers: req.headers,
      body,
      query
    };

    const compatRes = createCompatRes(nodeRes);
    await handler(compatReq, compatRes);
  } catch (error) {
    nodeRes.statusCode = 500;
    nodeRes.setHeader("Content-Type", "application/json; charset=utf-8");
    nodeRes.end(
      JSON.stringify({
        error: {
          message: error?.message || "Internal server error",
          code: "internal_error"
        }
      })
    );
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`Local preview running at http://${HOST}:${PORT}\n`);
});
