/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";
import {
  CHAT_SYSTEM_PROMPT,
  SCREENSHOT_PROMPT,
} from "moz-src:///browser/components/nativechat/NativeChatScreenshot.sys.mjs";

export const OPENCODE_DEFAULT_URL = "http://127.0.0.1:4096";
export const OPENCODE_V2_DEFAULT_URL = "http://127.0.0.1:49374";
export const OPENCODE_PROVIDERS = new Set(["opencode", "opencode-v2"]);

const OPENCODE_V2_POLL_INTERVAL_MS = 1000;
const OPENCODE_V2_WAIT_TIMEOUT_MS = 120000;

const sessionCache = new Map();

export function isOpenCodeProvider(provider) {
  return OPENCODE_PROVIDERS.has(provider);
}

export function parseOpenCodePairLink(input) {
  const raw = (input || "").trim();
  if (!raw) {
    return null;
  }
  const match = raw.match(
    /(https?:\/\/[^\s"'<>\\]+?)\/auth\/connect\/([A-Za-z0-9_-]+)/
  );
  if (!match) {
    return null;
  }
  try {
    const origin = new URL(match[1]).origin;
    return {
      baseUrl: origin,
      code: decodeURIComponent(match[2]),
    };
  } catch {
    return null;
  }
}

export async function pairOpenCodeV2(pairUrl, signal) {
  const link = parseOpenCodePairLink(pairUrl);
  if (!link) {
    throw new Error("native-chat-opencode-v2-pair-error");
  }
  let response;
  try {
    response = await fetch(
      `${link.baseUrl}/auth/connect/${encodeURIComponent(link.code)}`,
      {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "omit",
        referrerPolicy: "no-referrer",
        redirect: "error",
        signal,
      }
    );
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    throw new Error("native-chat-network-error");
  }
  if (!response.ok) {
    if ([400, 401, 404, 410].includes(response.status)) {
      throw new Error("native-chat-opencode-v2-pair-error");
    }
    throw new Error("native-chat-request-error", {
      cause: { status: response.status },
    });
  }
  const data = await response.json().catch(() => null);
  if (!data?.token) {
    throw new Error("native-chat-opencode-v2-pair-error");
  }
  return { baseUrl: link.baseUrl, password: data.token };
}

export function resetOpenCodeSessions({ isPrivate } = {}) {
  if (typeof isPrivate === "boolean") {
    const suffix = `::${isPrivate ? "private" : "normal"}`;
    for (const key of sessionCache.keys()) {
      if (key.endsWith(suffix)) {
        sessionCache.delete(key);
      }
    }
  } else {
    sessionCache.clear();
  }
}

function getSessionCacheKey(settings, isPrivate) {
  return `${settings.provider}::${settings.endpoint}::${isPrivate ? "private" : "normal"}`;
}

function createAuthHeader(apiKey) {
  if (!apiKey) {
    return null;
  }
  return `Basic ${btoa(`opencode:${apiKey}`)}`;
}

function parseModelRef(modelString) {
  if (!modelString) {
    return null;
  }
  let baseModel = modelString;
  let variant;
  if (baseModel.includes("@")) {
    const parts = baseModel.split("@");
    baseModel = parts[0];
    variant = parts[1];
  }
  const splitIndex = baseModel.indexOf("/");
  const providerID =
    splitIndex === -1 ? "opencode" : baseModel.slice(0, splitIndex);
  const id = splitIndex === -1 ? baseModel : baseModel.slice(splitIndex + 1);
  const result = { providerID, id, modelID: id };
  if (variant) {
    result.variant = variant;
  }
  return result;
}

export function buildOpenCodeRequest(
  settings,
  apiKey,
  messages,
  image = null,
  systemPrompt = null
) {
  const system =
    systemPrompt || (image ? SCREENSHOT_PROMPT : CHAT_SYSTEM_PROMPT);
  const model = settings.model.trim();
  const latestMessage = messages.findLast(message => message.role === "user");
  const text = latestMessage ? latestMessage.content : "";
  const headers = { "Content-Type": "application/json" };
  const auth = createAuthHeader(apiKey);
  if (auth) {
    headers.Authorization = auth;
  }

  if (settings.provider === "opencode") {
    const parts = [];
    if (image) {
      parts.push({
        type: "file",
        mime: image.mimeType,
        filename: "screenshot.png",
        url: `data:${image.mimeType};base64,${image.base64}`,
      });
    }
    parts.push({ type: "text", text });
    const body = { system, parts };
    if (model) {
      const modelRef = parseModelRef(model);
      body.model = {
        providerID: modelRef.providerID,
        modelID: modelRef.modelID,
      };
    }
    return {
      url: `${settings.endpoint}/session`,
      headers,
      body,
    };
  }

  const body = { system, text };
  if (image) {
    body.files = [
      {
        uri: `data:${image.mimeType};base64,${image.base64}`,
        name: "screenshot.png",
      },
    ];
  }
  if (model) {
    const modelRef = parseModelRef(model);
    body.model = {
      providerID: modelRef.providerID,
      id: modelRef.id,
    };
    if (modelRef.variant) {
      body.model.variant = modelRef.variant;
    }
  }
  return {
    url: `${settings.endpoint}/api/session`,
    headers,
    body,
  };
}

async function openCodeFetch(base, apiKey, path, options = {}) {
  const headers = { "Content-Type": "application/json", ...options.headers };
  const auth = createAuthHeader(apiKey);
  if (auth) {
    headers.Authorization = auth;
  }
  const response = await fetch(`${base}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: "omit",
    referrerPolicy: "no-referrer",
    redirect: "error",
    signal: options.signal,
  });
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(
        options.isV2
          ? "native-chat-opencode-v2-auth-error"
          : "native-chat-opencode-auth-error",
        { cause: { status: 401 } }
      );
    }
    throw new Error("native-chat-request-error", {
      cause: { status: response.status },
    });
  }
  if (response.status === 204) {
    return null;
  }
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

async function ensureOpenCodeV1Session(base, apiKey, signal, sessionKey) {
  const existing = sessionCache.get(sessionKey);
  if (existing) {
    return existing;
  }
  const data = await openCodeFetch(base, apiKey, "/session", {
    method: "POST",
    body: { title: "Native Chat" },
    signal,
    isV2: false,
  });
  if (!data?.id) {
    throw new Error("native-chat-empty-response");
  }
  sessionCache.set(sessionKey, data.id);
  return data.id;
}

export async function requestOpenCodeV1Reply(
  settings,
  apiKey,
  messages,
  signal,
  image = null,
  options = {}
) {
  const base = settings.endpoint;
  const sessionKey = getSessionCacheKey(settings, options.isPrivate);
  const request = buildOpenCodeRequest(
    settings,
    apiKey,
    messages,
    image,
    options.systemPrompt
  );

  await openCodeFetch(base, apiKey, "/global/health", {
    method: "GET",
    signal,
    isV2: false,
  });

  let sessionId = await ensureOpenCodeV1Session(
    base,
    apiKey,
    signal,
    sessionKey
  );
  let data;
  try {
    data = await openCodeFetch(
      base,
      apiKey,
      `/session/${encodeURIComponent(sessionId)}/message`,
      {
        method: "POST",
        body: request.body,
        signal,
        isV2: false,
      }
    );
  } catch (error) {
    if (error.cause?.status === 404) {
      sessionCache.delete(sessionKey);
      sessionId = await ensureOpenCodeV1Session(
        base,
        apiKey,
        signal,
        sessionKey
      );
      data = await openCodeFetch(
        base,
        apiKey,
        `/session/${encodeURIComponent(sessionId)}/message`,
        {
          method: "POST",
          body: request.body,
          signal,
          isV2: false,
        }
      );
    } else {
      throw error;
    }
  }

  const parts = Array.isArray(data?.parts) ? data.parts : [];
  const text = parts
    .filter(part => part?.type === "text" && typeof part.text === "string")
    .map(part => part.text)
    .join("\n\n")
    .trim();

  if (!text) {
    throw new Error("native-chat-empty-response");
  }
  return text;
}

async function ensureOpenCodeV2Session(base, apiKey, signal, sessionKey) {
  const existing = sessionCache.get(sessionKey);
  if (existing) {
    return existing;
  }
  const data = await openCodeFetch(base, apiKey, "/api/session", {
    method: "POST",
    body: { title: "Native Chat" },
    signal,
    isV2: true,
  });
  const id = data?.data?.id;
  if (!id) {
    throw new Error("native-chat-empty-response");
  }
  sessionCache.set(sessionKey, id);
  return id;
}

async function waitOpenCodeV2Session(base, apiKey, sessionId, signal) {
  try {
    await openCodeFetch(
      base,
      apiKey,
      `/api/experimental/session/${encodeURIComponent(sessionId)}/wait`,
      { method: "POST", signal, isV2: true }
    );
    return;
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    if (error.cause?.status !== 404 && error.cause?.status !== 405) {
      throw error;
    }
  }

  const deadline = Date.now() + OPENCODE_V2_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new Error("native-chat-timeout");
    }
    const data = await openCodeFetch(
      base,
      apiKey,
      `/api/session/${encodeURIComponent(sessionId)}/message?order=desc&limit=20`,
      { method: "GET", signal, isV2: true }
    );
    const messages = Array.isArray(data?.data) ? data.data : [];
    const assistant = messages.find(message => message.type === "assistant");
    const idle = messages.find(message => message.type === "idle");
    if (assistant && (assistant.time?.completed || idle)) {
      return;
    }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, OPENCODE_V2_POLL_INTERVAL_MS);
      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("native-chat-timeout"));
          },
          { once: true }
        );
      }
    });
  }
  throw new Error("native-chat-timeout");
}

export async function requestOpenCodeV2Reply(
  settings,
  apiKey,
  messages,
  signal,
  image = null,
  options = {}
) {
  const base = settings.endpoint;
  const sessionKey = getSessionCacheKey(settings, options.isPrivate);
  const request = buildOpenCodeRequest(
    settings,
    apiKey,
    messages,
    image,
    options.systemPrompt
  );

  await openCodeFetch(base, apiKey, "/api/info", {
    method: "GET",
    signal,
    isV2: true,
  });

  let sessionId = await ensureOpenCodeV2Session(
    base,
    apiKey,
    signal,
    sessionKey
  );

  const sendPrompt = async id => {
    if (request.body.model) {
      await openCodeFetch(
        base,
        apiKey,
        `/api/session/${encodeURIComponent(id)}/model`,
        {
          method: "POST",
          body: { model: request.body.model },
          signal,
          isV2: true,
        }
      );
    }
    const system =
      typeof request.body.system === "string" ? request.body.system.trim() : "";
    const messageText =
      typeof request.body.text === "string" ? request.body.text.trim() : "";
    const text =
      system && messageText
        ? `${system}\n\n${messageText}`
        : messageText || system;
    const promptBody = { text };
    if (request.body.files) {
      promptBody.files = request.body.files;
    }
    await openCodeFetch(
      base,
      apiKey,
      `/api/session/${encodeURIComponent(id)}/prompt`,
      {
        method: "POST",
        body: promptBody,
        signal,
        isV2: true,
      }
    );
  };

  try {
    await sendPrompt(sessionId);
  } catch (error) {
    if (error.cause?.status === 404) {
      sessionCache.delete(sessionKey);
      sessionId = await ensureOpenCodeV2Session(
        base,
        apiKey,
        signal,
        sessionKey
      );
      await sendPrompt(sessionId);
    } else {
      throw error;
    }
  }

  await waitOpenCodeV2Session(base, apiKey, sessionId, signal);

  const messagesData = await openCodeFetch(
    base,
    apiKey,
    `/api/session/${encodeURIComponent(sessionId)}/message?order=desc&limit=50`,
    { method: "GET", signal, isV2: true }
  );

  const messageList = Array.isArray(messagesData?.data)
    ? messagesData.data
    : [];
  const idle = messageList.find(message => message.type === "idle");
  if (idle?.error?.message) {
    throw new Error(idle.error.message);
  }
  if (idle?.outcome === "failed") {
    throw new Error("native-chat-empty-response");
  }

  const assistant = messageList.find(message => message.type === "assistant");
  if (!assistant) {
    throw new Error("native-chat-empty-response");
  }

  const content = Array.isArray(assistant.content) ? assistant.content : [];
  const text = content
    .filter(part => part?.type === "text" && typeof part.text === "string")
    .map(part => part.text)
    .join("\n\n")
    .trim();

  if (!text) {
    throw new Error("native-chat-empty-response");
  }
  return text;
}

export async function getOpenCodeModels(endpoint, apiKey, signal) {
  const data = await openCodeFetch(endpoint, apiKey, "/config/providers", {
    method: "GET",
    signal,
    isV2: false,
  });
  const providers = Array.isArray(data?.providers) ? data.providers : [];
  const models = [];
  providers.forEach(provider => {
    if (!provider?.id || typeof provider.models !== "object") {
      return;
    }
    Object.entries(provider.models).forEach(([modelKey, model]) => {
      if (model?.status === "deprecated") {
        return;
      }
      const value = `${provider.id}/${modelKey}`;
      const label = model?.name ? `${model.name} (${provider.id})` : value;
      models.push({ value, label });
    });
  });
  models.sort((a, b) => a.label.localeCompare(b.label));
  let defaultModel = "";
  if (data?.default && typeof data.default === "object") {
    const firstProvider = Object.keys(data.default)[0];
    if (firstProvider && data.default[firstProvider]) {
      defaultModel = `${firstProvider}/${data.default[firstProvider]}`;
    }
  }
  return { models, defaultModel };
}

export async function getOpenCodeV2Models(endpoint, apiKey, signal) {
  const data = await openCodeFetch(endpoint, apiKey, "/api/model", {
    method: "GET",
    signal,
    isV2: true,
  });
  const available = Array.isArray(data?.data) ? data.data : [];
  const models = [];
  available.forEach(model => {
    if (
      !model?.id ||
      !model.providerID ||
      model.status === "deprecated" ||
      model.enabled === false
    ) {
      return;
    }
    const value = `${model.providerID}/${model.id}`;
    const label = model.name ? `${model.name} (${model.providerID})` : value;
    models.push({ value, label });
  });
  models.sort((a, b) => a.label.localeCompare(b.label));
  let defaultModel = "";
  try {
    const defaultData = await openCodeFetch(
      endpoint,
      apiKey,
      "/api/model/default",
      { method: "GET", signal, isV2: true }
    );
    if (defaultData?.data?.id && defaultData.data.providerID) {
      defaultModel = `${defaultData.data.providerID}/${defaultData.data.id}`;
    }
  } catch {}
  return { models, defaultModel };
}
