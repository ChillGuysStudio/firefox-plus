/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  OPENCODE_DEFAULT_URL,
  OPENCODE_V2_DEFAULT_URL,
  isOpenCodeProvider,
  parseOpenCodePairLink,
  pairOpenCodeV2,
  buildOpenCodeRequest,
  requestOpenCodeV1Reply,
  requestOpenCodeV2Reply,
  resetOpenCodeSessions,
  getOpenCodeModels,
  getOpenCodeV2Models,
} from "moz-src:///browser/components/nativechat/NativeChatOpenCode.sys.mjs";
import {
  CHAT_SYSTEM_PROMPT,
  SCREENSHOT_PROMPT,
} from "moz-src:///browser/components/nativechat/NativeChatScreenshot.sys.mjs";

export const QUIZ_SYSTEM_PROMPT = SCREENSHOT_PROMPT;

export {
  parseOpenCodePairLink,
  pairOpenCodeV2,
  resetOpenCodeSessions,
  getOpenCodeModels,
  getOpenCodeV2Models,
  isOpenCodeProvider,
  CHAT_SYSTEM_PROMPT,
};

export const PROVIDERS = {
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  vertex: "https://aiplatform.googleapis.com/v1/publishers/google",
  anthropic: "https://api.anthropic.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  grok: "https://api.x.ai/v1",
  custom: "http://localhost:1234/v1",
  opencode: OPENCODE_DEFAULT_URL,
  "opencode-v2": OPENCODE_V2_DEFAULT_URL,
};

export const PROVIDER_DEFAULT_MODELS = {
  openai: [
    { value: "o3-mini", label: "o3-mini (reasoning)" },
    { value: "o1", label: "o1 (reasoning)" },
    { value: "gpt-4o", label: "GPT-4o" },
    { value: "gpt-4o-mini", label: "GPT-4o Mini" },
  ],
  gemini: [
    {
      value: "gemini-2.0-flash-thinking-exp-01-21",
      label: "Gemini 2.0 Flash Thinking",
    },
    { value: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
    { value: "gemini-1.5-pro", label: "Gemini 1.5 Pro" },
    { value: "gemini-1.5-flash", label: "Gemini 1.5 Flash" },
  ],
  vertex: [
    {
      value: "gemini-2.0-flash-thinking-exp-01-21",
      label: "Gemini 2.0 Flash Thinking",
    },
    { value: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
    { value: "gemini-1.5-pro", label: "Gemini 1.5 Pro" },
  ],
  anthropic: [
    { value: "claude-3-7-sonnet-20250219", label: "Claude 3.7 Sonnet" },
    { value: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet" },
    { value: "claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku" },
  ],
  openrouter: [
    { value: "deepseek/deepseek-r1", label: "DeepSeek R1" },
    { value: "openai/o3-mini", label: "OpenAI o3-mini" },
    { value: "openai/gpt-4o", label: "OpenAI GPT-4o" },
    { value: "anthropic/claude-3.7-sonnet", label: "Claude 3.7 Sonnet" },
    { value: "anthropic/claude-3.5-sonnet", label: "Claude 3.5 Sonnet" },
    { value: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B" },
  ],
  grok: [
    { value: "grok-2", label: "Grok 2" },
    { value: "grok-2-mini", label: "Grok 2 Mini" },
    { value: "grok-beta", label: "Grok Beta" },
  ],
  custom: [{ value: "default", label: "Server default" }],
  opencode: [{ value: "", label: "Server default model" }],
  "opencode-v2": [{ value: "", label: "Server default model" }],
};

export async function getOpenAICompatibleModels(endpoint, apiKey, signal) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const base = endpoint.replace(/\/+$/, "");
  const response = await fetch(`${base}/models`, {
    method: "GET",
    headers,
    signal,
  });
  if (!response.ok) {
    throw new Error("Failed to fetch models");
  }
  const data = await response.json();
  const list = Array.isArray(data?.data) ? data.data : [];
  return list
    .filter(m => m?.id && typeof m.id === "string")
    .map(m => ({ value: m.id, label: m.id }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function normalizeEndpoint(value) {
  const trimmed = value.trim();
  const pairLink = parseOpenCodePairLink(trimmed);
  const target = pairLink ? pairLink.baseUrl : trimmed;
  const url = new URL(target);
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

export function buildRequest(
  settings,
  apiKey,
  messages,
  image = null,
  systemPrompt = null
) {
  const base = normalizeEndpoint(settings.endpoint);
  const model = settings.model.trim();
  const isOpenCode = isOpenCodeProvider(settings.provider);
  if (!Object.hasOwn(PROVIDERS, settings.provider)) {
    throw new Error("native-chat-missing-model");
  }
  if (!model && !isOpenCode) {
    throw new Error("native-chat-missing-model");
  }
  if (
    !apiKey &&
    !["custom", "opencode", "opencode-v2"].includes(settings.provider)
  ) {
    throw new Error("native-chat-missing-key");
  }

  const system =
    systemPrompt || (image ? QUIZ_SYSTEM_PROMPT : CHAT_SYSTEM_PROMPT);

  if (isOpenCode) {
    return buildOpenCodeRequest(
      { ...settings, endpoint: base },
      apiKey,
      messages,
      image,
      system
    );
  }

  const headers = { "Content-Type": "application/json" };
  const withImage = messages.map((message, index) => {
    if (!image || index !== messages.length - 1) {
      return message;
    }
    return {
      ...message,
      content: [
        { type: "text", text: message.content },
        {
          type: "image_url",
          image_url: { url: `data:${image.mimeType};base64,${image.base64}` },
        },
      ],
    };
  });
  let url = `${base}/chat/completions`;
  let body = {
    model,
    messages: [{ role: "system", content: system }, ...withImage],
    stream: false,
  };
  if (["gemini", "vertex"].includes(settings.provider)) {
    url = `${base}/models/${encodeURIComponent(model)}:generateContent`;
    headers["x-goog-api-key"] = apiKey;
    body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map(({ role, content }, index) => ({
        role: role === "assistant" ? "model" : "user",
        parts: [
          { text: content },
          ...(image && index === messages.length - 1
            ? [
                {
                  inline_data: {
                    mime_type: image.mimeType,
                    data: image.base64,
                  },
                },
              ]
            : []),
        ],
      })),
    };
  } else if (settings.provider === "anthropic") {
    url = `${base}/messages`;
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
    body = {
      model,
      system,
      messages: messages.map((message, index) =>
        image && index === messages.length - 1
          ? {
              ...message,
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: image.mimeType,
                    data: image.base64,
                  },
                },
                { type: "text", text: message.content },
              ],
            }
          : message
      ),
      max_tokens: 8192,
    };
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return { url, headers, body };
}

export async function requestReply(
  settings,
  apiKey,
  messages,
  signal,
  image = null,
  options = {}
) {
  const system =
    options.systemPrompt || (image ? QUIZ_SYSTEM_PROMPT : CHAT_SYSTEM_PROMPT);
  const forwardOptions = { ...options, systemPrompt: system };

  if (settings.provider === "opencode") {
    return requestOpenCodeV1Reply(
      settings,
      apiKey,
      messages,
      signal,
      image,
      forwardOptions
    );
  }
  if (settings.provider === "opencode-v2") {
    return requestOpenCodeV2Reply(
      settings,
      apiKey,
      messages,
      signal,
      image,
      forwardOptions
    );
  }

  const request = buildRequest(settings, apiKey, messages, image, system);
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
