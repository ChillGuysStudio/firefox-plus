/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

const { buildRequest, normalizeEndpoint, requestReply, PROVIDERS } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/nativechat/NativeChatProvider.sys.mjs"
  );
const { HttpServer } = ChromeUtils.importESModule(
  "resource://testing-common/httpd.sys.mjs"
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
  ]) {
    Assert.equal(normalizeEndpoint(endpoint), endpoint);
  }
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
      Assert.deepEqual(request.body.contents[1], {
        role: "model",
        parts: [{ text: "Hi" }],
      });
      Assert.ok(request.url.endsWith("/models/test-model:generateContent"));
    } else if (provider === "anthropic") {
      Assert.equal(request.headers["x-api-key"], "secret");
      Assert.equal(request.headers["anthropic-version"], "2023-06-01");
      Assert.greater(request.body.max_tokens, 0);
    } else {
      Assert.equal(request.headers.Authorization, "Bearer secret");
      Assert.deepEqual(request.body.messages, messages);
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
  Assert.deepEqual(received.body.messages, messages);
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

const { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);
