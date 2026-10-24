/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const PROVIDERS = {
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  vertex: "https://aiplatform.googleapis.com/v1/publishers/google",
  anthropic: "https://api.anthropic.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  grok: "https://api.x.ai/v1",
  custom: "http://localhost:1234/v1",
};

export function normalizeEndpoint(value) {
  const url = new URL(value.trim());
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("native-chat-invalid-endpoint");
  }
  return url.href.replace(/\/+$/, "");
}

export function buildRequest(settings, apiKey, messages) {
  const base = normalizeEndpoint(settings.endpoint);
  const model = settings.model.trim();
  if (!Object.hasOwn(PROVIDERS, settings.provider) || !model) {
    throw new Error("native-chat-missing-model");
  }
  if (!apiKey && settings.provider !== "custom") {
    throw new Error("native-chat-missing-key");
  }
  const headers = { "Content-Type": "application/json" };
  let url = `${base}/chat/completions`;
  let body = { model, messages, stream: false };
  if (["gemini", "vertex"].includes(settings.provider)) {
    url = `${base}/models/${encodeURIComponent(model)}:generateContent`;
    headers["x-goog-api-key"] = apiKey;
    body = {
      contents: messages.map(({ role, content }) => ({
        role: role === "assistant" ? "model" : "user",
        parts: [{ text: content }],
      })),
    };
  } else if (settings.provider === "anthropic") {
    url = `${base}/messages`;
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
    body = { model, messages, max_tokens: 8192 };
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return { url, headers, body };
}

export async function requestReply(settings, apiKey, messages, signal) {
  const request = buildRequest(settings, apiKey, messages);
  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(request.body),
    credentials: "omit",
    referrerPolicy: "no-referrer",
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    throw new Error("native-chat-request-error", {
      cause: { status: response.status },
    });
  }
  const data = await response.json();
  let text;
  if (["gemini", "vertex"].includes(settings.provider)) {
    text = data.candidates?.[0]?.content?.parts
      ?.filter(part => !part.thought && typeof part.text === "string")
      .map(part => part.text)
      .join("\n");
  } else if (settings.provider === "anthropic") {
    text = data.content
      ?.filter(part => part.type === "text")
      .map(part => part.text)
      .join("\n");
  } else {
    text = data.choices?.[0]?.message?.content;
  }
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("native-chat-empty-response");
  }
  return text;
}
