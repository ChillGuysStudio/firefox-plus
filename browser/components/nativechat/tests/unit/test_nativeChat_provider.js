/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

const {
  buildRequest,
  normalizeEndpoint,
  requestReply,
  PROVIDERS,
  parseOpenCodePairLink,
  pairOpenCodeV2,
  resetOpenCodeSessions,
  CHAT_SYSTEM_PROMPT,
  QUIZ_SYSTEM_PROMPT,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/nativechat/NativeChatProvider.sys.mjs"
);
const { HttpServer } = ChromeUtils.importESModule(
  "resource://testing-common/httpd.sys.mjs"
);
const { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);

const messages = [
  { role: "user", content: "Hello" },
  { role: "assistant", content: "Hi" },
];

add_task(function test_endpoint_validation() {
  Assert.equal(
    normalizeEndpoint(" https://example.com/api/// "),
    "https://example.com/api"
  );
  for (const endpoint of [
    "http://localhost:1234/v1",
    "http://127.0.0.1:4096/v1",
    "http://[::1]:1234/v1",
    "http://127.0.0.1:4096",
    "http://127.0.0.1:49374",
  ]) {
    Assert.equal(normalizeEndpoint(endpoint), endpoint);
  }
  Assert.equal(
    normalizeEndpoint(
      "http://127.0.0.1:49374/auth/connect/3r4l5Y7UB1umkTSI0xlH0A"
    ),
    "http://127.0.0.1:49374"
  );
  for (const endpoint of [
    "http://example.com",
    "javascript:alert(1)",
    "file:///tmp/key",
    "https://user:password@example.com",
    "https://example.com?key=secret",
    "https://example.com/#fragment",
  ]) {
    Assert.throws(
      () => normalizeEndpoint(endpoint),
      /native-chat-invalid-endpoint/
    );
  }
});

add_task(function test_provider_requests() {
  for (const provider of Object.keys(PROVIDERS)) {
    const settings = {
      provider,
      endpoint: PROVIDERS[provider],
      model: "test-model",
    };
    const request = buildRequest(settings, "secret", messages);
    Assert.ok(!request.url.includes("secret"), "Keys never appear in URLs");
    if (["gemini", "vertex"].includes(provider)) {
      Assert.equal(request.headers["x-goog-api-key"], "secret");
      Assert.deepEqual(request.body.systemInstruction, {
        parts: [{ text: CHAT_SYSTEM_PROMPT }],
      });
      Assert.deepEqual(request.body.contents[1], {
        role: "model",
        parts: [{ text: "Hi" }],
      });
      Assert.ok(request.url.endsWith("/models/test-model:generateContent"));
    } else if (provider === "anthropic") {
      Assert.equal(request.headers["x-api-key"], "secret");
      Assert.equal(request.headers["anthropic-version"], "2023-06-01");
      Assert.equal(request.body.system, CHAT_SYSTEM_PROMPT);
      Assert.greater(request.body.max_tokens, 0);
    } else if (provider === "opencode") {
      Assert.ok(request.headers.Authorization.startsWith("Basic "));
      Assert.equal(request.body.system, CHAT_SYSTEM_PROMPT);
      Assert.equal(request.body.parts[0].text, "Hello");
      Assert.equal(request.body.model.modelID, "test-model");
      Assert.ok(request.url.endsWith("/session"));
    } else if (provider === "opencode-v2") {
      Assert.ok(request.headers.Authorization.startsWith("Basic "));
      Assert.equal(request.body.system, CHAT_SYSTEM_PROMPT);
      Assert.equal(request.body.text, "Hello");
      Assert.equal(request.body.model.id, "test-model");
      Assert.ok(request.url.endsWith("/api/session"));
    } else {
      Assert.equal(request.headers.Authorization, "Bearer secret");
      Assert.deepEqual(request.body.messages, [
        { role: "system", content: CHAT_SYSTEM_PROMPT },
        ...messages,
      ]);
      Assert.ok(request.url.endsWith("/chat/completions"));
    }
  }

  const custom = {
    provider: "custom",
    endpoint: PROVIDERS.custom,
    model: "local-model",
  };
  Assert.ok(!buildRequest(custom, "", messages).headers.Authorization);
  Assert.throws(
    () => buildRequest({ ...custom, model: " " }, "", messages),
    /native-chat-missing-model/
  );
  Assert.throws(
    () => buildRequest({ ...custom, provider: "openai" }, "", messages),
    /native-chat-missing-key/
  );

  const opencodeNoModel = {
    provider: "opencode",
    endpoint: PROVIDERS.opencode,
    model: "",
  };
  Assert.ok(buildRequest(opencodeNoModel, "", messages));

  const opencodeV2NoModel = {
    provider: "opencode-v2",
    endpoint: PROVIDERS["opencode-v2"],
    model: "",
  };
  Assert.ok(buildRequest(opencodeV2NoModel, "", messages));
});

add_task(async function test_network_responses_and_errors() {
  const server = new HttpServer();
  let responseBody = { choices: [{ message: { content: "Reply" } }] };
  let status = 200;
  let redirect = false;
  let received;
  server.registerPathHandler("/v1/chat/completions", (request, response) => {
    received = {
      body: JSON.parse(
        NetUtil.readInputStreamToString(
          request.bodyInputStream,
          request.bodyInputStream.available()
        )
      ),
      hasCookie: request.hasHeader("Cookie"),
      hasReferer: request.hasHeader("Referer"),
    };
    response.setStatusLine(request.httpVersion, status, "Test");
    if (redirect) {
      response.setHeader("Location", "/redirect-target");
    }
    response.setHeader("Content-Type", "application/json");
    response.write(JSON.stringify(responseBody));
  });
  server.start(-1);
  registerCleanupFunction(() => new Promise(resolve => server.stop(resolve)));
  const settings = {
    provider: "custom",
    endpoint: `http://localhost:${server.identity.primaryPort}/v1`,
    model: "test-model",
  };
  Assert.equal(await requestReply(settings, "", messages), "Reply");
  Assert.deepEqual(received.body.messages, [
    { role: "system", content: CHAT_SYSTEM_PROMPT },
    ...messages,
  ]);
  Assert.ok(!received.hasCookie);
  Assert.ok(!received.hasReferer);
  responseBody = { choices: [] };
  await Assert.rejects(
    requestReply(settings, "", messages),
    /native-chat-empty-response/
  );
  status = 401;
  responseBody = { error: { message: "Do not expose this sensitive body" } };
  await Assert.rejects(
    requestReply(settings, "", messages),
    /native-chat-request-error/
  );
  status = 302;
  redirect = true;
  await Assert.rejects(
    requestReply(settings, "secret", messages),
    /./,
    "Credential-bearing redirects fail"
  );
  const controller = new AbortController();
  controller.abort();
  await Assert.rejects(
    requestReply(settings, "", messages, controller.signal),
    /./,
    "Stopped requests reject"
  );
});

add_task(function test_screenshot_payloads() {
  const image = { mimeType: "image/png", base64: "c2NyZWVuc2hvdA==" };
  const original = JSON.stringify(messages);
  for (const provider of Object.keys(PROVIDERS)) {
    const request = buildRequest(
      { provider, endpoint: PROVIDERS[provider], model: "vision-test" },
      "secret",
      messages,
      image
    );
    if (["gemini", "vertex"].includes(provider)) {
      Assert.deepEqual(request.body.systemInstruction, {
        parts: [{ text: QUIZ_SYSTEM_PROMPT }],
      });
      const contents = request.body.contents;
      Assert.deepEqual(contents.at(-1).parts[1], {
        inline_data: { mime_type: "image/png", data: image.base64 },
      });
      Assert.equal(
        contents[0].parts.length,
        1,
        "Only the newest message receives the screenshot"
      );
    } else if (provider === "anthropic") {
      Assert.equal(request.body.system, QUIZ_SYSTEM_PROMPT);
      const content = request.body.messages.at(-1).content;
      Assert.deepEqual(content[0], {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: image.base64 },
      });
      Assert.equal(content[1].text, "Hi");
    } else if (provider === "opencode") {
      Assert.equal(request.body.system, QUIZ_SYSTEM_PROMPT);
      Assert.equal(request.body.parts[0].type, "file");
      Assert.equal(request.body.parts[0].mime, "image/png");
      Assert.equal(request.body.parts[1].text, "Hello");
    } else if (provider === "opencode-v2") {
      Assert.equal(request.body.system, QUIZ_SYSTEM_PROMPT);
      Assert.equal(
        request.body.files[0].uri,
        "data:image/png;base64,c2NyZWVuc2hvdA=="
      );
      Assert.equal(request.body.text, "Hello");
    } else {
      Assert.deepEqual(request.body.messages[0], {
        role: "system",
        content: QUIZ_SYSTEM_PROMPT,
      });
      Assert.deepEqual(request.body.messages.at(-1).content[1], {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${image.base64}` },
      });
      Assert.equal(request.body.messages[1].content, "Hello");
    }
  }
  Assert.equal(
    JSON.stringify(messages),
    original,
    "Building a vision request never mutates saved history"
  );
});

add_task(async function test_opencode_pair_link_and_redemption() {
  Assert.deepEqual(
    parseOpenCodePairLink("http://127.0.0.1:49374/auth/connect/code123"),
    { baseUrl: "http://127.0.0.1:49374", code: "code123" }
  );
  Assert.equal(parseOpenCodePairLink("not-a-link"), null);

  const server = new HttpServer();
  let pairStatus = 200;
  let receivedAccept = "";
  server.registerPathHandler("/auth/connect/code123", (request, response) => {
    receivedAccept = request.getHeader("Accept");
    response.setStatusLine(request.httpVersion, pairStatus, "Test");
    response.setHeader("Content-Type", "application/json");
    if (pairStatus === 200) {
      response.write(JSON.stringify({ token: "session-secret-token" }));
    } else {
      response.write(JSON.stringify({ message: "Expired" }));
    }
  });
  server.start(-1);
  registerCleanupFunction(() => new Promise(resolve => server.stop(resolve)));

  const pairUrl = `http://localhost:${server.identity.primaryPort}/auth/connect/code123`;
  const paired = await pairOpenCodeV2(pairUrl);
  Assert.equal(
    paired.baseUrl,
    `http://localhost:${server.identity.primaryPort}`
  );
  Assert.equal(paired.password, "session-secret-token");
  Assert.equal(receivedAccept, "application/json");

  pairStatus = 401;
  await Assert.rejects(
    pairOpenCodeV2(pairUrl),
    /native-chat-opencode-v2-pair-error/
  );
});

add_task(async function test_opencode_v1_relay_and_recovery() {
  resetOpenCodeSessions();
  const server = new HttpServer();
  let sessionCreatedCount = 0;
  let messageCount = 0;
  let return404OnMessage = false;

  server.registerPathHandler("/global/health", (request, response) => {
    response.setStatusLine(request.httpVersion, 200, "OK");
    response.setHeader("Content-Type", "application/json");
    response.write(JSON.stringify({ healthy: true }));
  });

  server.registerPathHandler("/session", (request, response) => {
    sessionCreatedCount++;
    response.setStatusLine(request.httpVersion, 200, "OK");
    response.setHeader("Content-Type", "application/json");
    response.write(JSON.stringify({ id: `ses_v1_${sessionCreatedCount}` }));
  });

  server.registerPathHandler(
    "/session/ses_v1_1/message",
    (request, response) => {
      if (return404OnMessage) {
        response.setStatusLine(request.httpVersion, 404, "Not Found");
        response.write("Session lost");
        return;
      }
      messageCount++;
      response.setStatusLine(request.httpVersion, 200, "OK");
      response.setHeader("Content-Type", "application/json");
      response.write(
        JSON.stringify({ parts: [{ type: "text", text: "OpenCode 1 reply" }] })
      );
    }
  );

  server.registerPathHandler(
    "/session/ses_v1_2/message",
    (request, response) => {
      messageCount++;
      response.setStatusLine(request.httpVersion, 200, "OK");
      response.setHeader("Content-Type", "application/json");
      response.write(
        JSON.stringify({
          parts: [{ type: "text", text: "OpenCode 1 recovered reply" }],
        })
      );
    }
  );

  server.start(-1);
  registerCleanupFunction(() => new Promise(resolve => server.stop(resolve)));

  const settings = {
    provider: "opencode",
    endpoint: `http://localhost:${server.identity.primaryPort}`,
    model: "",
  };

  const reply1 = await requestReply(settings, "pass", messages);
  Assert.equal(reply1, "OpenCode 1 reply");
  Assert.equal(sessionCreatedCount, 1);

  return404OnMessage = true;
  const reply2 = await requestReply(settings, "pass", messages);
  Assert.equal(reply2, "OpenCode 1 recovered reply");
  Assert.equal(sessionCreatedCount, 2);
  Assert.equal(messageCount, 2);

  resetOpenCodeSessions();
});

add_task(async function test_opencode_v2_relay_and_recovery() {
  resetOpenCodeSessions();
  const server = new HttpServer();
  let sessionCreatedCount = 0;
  let modelSwitched = false;
  let promptReceived = null;
  let return404OnModel = false;

  server.registerPathHandler("/api/info", (request, response) => {
    response.setStatusLine(request.httpVersion, 200, "OK");
    response.setHeader("Content-Type", "application/json");
    response.write(JSON.stringify({ version: "2.1.2" }));
  });

  server.registerPathHandler("/api/session", (request, response) => {
    sessionCreatedCount++;
    response.setStatusLine(request.httpVersion, 200, "OK");
    response.setHeader("Content-Type", "application/json");
    response.write(
      JSON.stringify({ data: { id: `ses_v2_${sessionCreatedCount}` } })
    );
  });

  server.registerPathHandler(
    "/api/session/ses_v2_1/model",
    (request, response) => {
      if (return404OnModel) {
        response.setStatusLine(request.httpVersion, 404, "Not Found");
        response.write("Stale session");
        return;
      }
      modelSwitched = true;
      response.setStatusLine(request.httpVersion, 204, "No Content");
    }
  );

  server.registerPathHandler(
    "/api/session/ses_v2_2/model",
    (request, response) => {
      modelSwitched = true;
      response.setStatusLine(request.httpVersion, 204, "No Content");
    }
  );

  server.registerPathHandler(
    "/api/session/ses_v2_1/prompt",
    (request, response) => {
      promptReceived = JSON.parse(
        NetUtil.readInputStreamToString(
          request.bodyInputStream,
          request.bodyInputStream.available()
        )
      );
      response.setStatusLine(request.httpVersion, 200, "OK");
      response.setHeader("Content-Type", "application/json");
      response.write(JSON.stringify({ data: { id: "p1" } }));
    }
  );

  server.registerPathHandler(
    "/api/session/ses_v2_2/prompt",
    (request, response) => {
      promptReceived = JSON.parse(
        NetUtil.readInputStreamToString(
          request.bodyInputStream,
          request.bodyInputStream.available()
        )
      );
      response.setStatusLine(request.httpVersion, 200, "OK");
      response.setHeader("Content-Type", "application/json");
      response.write(JSON.stringify({ data: { id: "p2" } }));
    }
  );

  server.registerPathHandler(
    "/api/experimental/session/ses_v2_1/wait",
    (request, response) => {
      response.setStatusLine(request.httpVersion, 204, "No Content");
    }
  );

  server.registerPathHandler(
    "/api/experimental/session/ses_v2_2/wait",
    (request, response) => {
      response.setStatusLine(request.httpVersion, 204, "No Content");
    }
  );

  server.registerPathHandler(
    "/api/session/ses_v2_1/message",
    (request, response) => {
      response.setStatusLine(request.httpVersion, 200, "OK");
      response.setHeader("Content-Type", "application/json");
      response.write(
        JSON.stringify({
          data: [
            { type: "idle", outcome: "succeeded" },
            {
              type: "assistant",
              content: [{ type: "text", text: "OpenCode 2 reply" }],
            },
          ],
        })
      );
    }
  );

  server.registerPathHandler(
    "/api/session/ses_v2_2/message",
    (request, response) => {
      response.setStatusLine(request.httpVersion, 200, "OK");
      response.setHeader("Content-Type", "application/json");
      response.write(
        JSON.stringify({
          data: [
            { type: "idle", outcome: "succeeded" },
            {
              type: "assistant",
              content: [{ type: "text", text: "OpenCode 2 recovered reply" }],
            },
          ],
        })
      );
    }
  );

  server.start(-1);
  registerCleanupFunction(() => new Promise(resolve => server.stop(resolve)));

  const settings = {
    provider: "opencode-v2",
    endpoint: `http://localhost:${server.identity.primaryPort}`,
    model: "opencode/test-model",
  };

  const reply1 = await requestReply(settings, "token123", messages, null, null);
  Assert.equal(reply1, "OpenCode 2 reply");
  Assert.ok(modelSwitched);
  Assert.equal(promptReceived.text, `${CHAT_SYSTEM_PROMPT}\n\nHello`);

  return404OnModel = true;
  const reply2 = await requestReply(settings, "token123", messages);
  Assert.equal(reply2, "OpenCode 2 recovered reply");
  Assert.equal(sessionCreatedCount, 2);

  resetOpenCodeSessions();
});
