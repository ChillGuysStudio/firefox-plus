/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

const { NativeChatStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/nativechat/NativeChatStore.sys.mjs"
);
const { DOMFullscreenTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/DOMFullscreenTestUtils.sys.mjs"
);
DOMFullscreenTestUtils.init(this, window);
const RESTRICTED_URL =
  getRootDirectory(gTestPath).replace(
    "chrome://mochitests/content",
    "https://example.com"
  ) + "file_restricted.html";

async function withChatWindow(options, task) {
  const win = await BrowserTestUtils.openNewBrowserWindow(options);
  try {
    await TestUtils.waitForCondition(() => win.gNativeChat);
    await win.gNativeChat.ready;
    await task(win, win.gNativeChat);
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
}

add_setup(async function setup() {
  await window.gNativeChat.ready;
  const settings = Object.fromEntries(
    ["provider", "endpoint", "model", "position"].map(name => {
      const pref = `browser.nativeChat.${name}`;
      return [
        pref,
        Services.prefs.prefHasUserValue(pref)
          ? Services.prefs.getStringPref(pref)
          : null,
      ];
    })
  );
  const history = await NativeChatStore.loadHistory();
  registerCleanupFunction(async () => {
    NativeChatStore.saveHistory(history);
    for (const [name, value] of Object.entries(settings)) {
      if (value === null) {
        Services.prefs.clearUserPref(name);
      } else {
        Services.prefs.setStringPref(name, value);
      }
    }
    window.gNativeChat.close();
  });
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.nativeChat.chatOpacity", 95],
      ["browser.nativeChat.buttonOpacity", 60],
    ],
  });
});

add_task(async function test_restricted_pages_and_reserved_shortcuts() {
  await withChatWindow({}, async (win, chat) => {
    await BrowserTestUtils.loadURIString({
      browser: win.gBrowser.selectedBrowser,
      uriString: RESTRICTED_URL,
    });
    const browser = win.gBrowser.selectedBrowser;
    await SpecialPowers.spawn(browser, [], () => {
      content.addEventListener(
        "keydown",
        event => {
          event.preventDefault();
          event.stopImmediatePropagation();
        },
        true
      );
      content.document.body.replaceChildren();
      Assert.equal(
        content.document.querySelector("#native-chat-overlay"),
        null,
        "The page cannot find the native overlay"
      );
    });
    await SimpleTest.promiseFocus(browser);
    EventUtils.synthesizeKey("c", { altKey: true }, win);
    await TestUtils.waitForCondition(() => !chat.element("panel").hidden);
    ok(
      chat.element("overlay").matches(":popover-open"),
      "Chat is in browser top layer"
    );
    is(
      chat.element("overlay").ownerDocument,
      win.document,
      "Chat belongs to browser chrome"
    );
    EventUtils.synthesizeKey("KEY_Escape", {}, win);
    await TestUtils.waitForCondition(() => chat.element("panel").hidden);
    EventUtils.synthesizeKey("c", { altKey: true, shiftKey: true }, win);
    await TestUtils.waitForCondition(
      () => !chat.element("overlay").matches(":popover-open")
    );
    EventUtils.synthesizeKey("c", { altKey: true, accelKey: true }, win);
    await TestUtils.waitForCondition(() => !chat.element("panel").hidden);
    ok(
      chat.element("overlay").matches(":popover-open"),
      "Shortcut restores a hidden launcher"
    );
    await BrowserTestUtils.loadURIString({
      browser,
      uriString: "about:config",
    });
    ok(
      !chat.element("panel").hidden,
      "Chat survives navigation to a restricted about page"
    );
  });
});

add_task(async function test_toolbarless_popup() {
  await withChatWindow(
    { features: "chrome,dialog=no,all=no,toolbar=no" },
    async (win, chat) => {
      ok(!win.toolbar.visible, "The popup has no toolbar");
      EventUtils.synthesizeMouseAtCenter(chat.element("launcher"), {}, win);
      await TestUtils.waitForCondition(() => !chat.element("panel").hidden);
      ok(
        chat.element("overlay").matches(":popover-open"),
        "Native chat works in a toolbarless popup"
      );
    }
  );
});

add_task(async function test_page_scripts_disabled_and_click_through() {
  await withChatWindow({}, async (win, chat) => {
    const browser = win.gBrowser.selectedBrowser;
    browser.browsingContext.allowJavascript = false;
    await BrowserTestUtils.loadURIString({
      browser,
      uriString: RESTRICTED_URL,
    });
    await BrowserTestUtils.synthesizeMouseAtCenter("#page-input", {}, browser);
    ok(
      await SpecialPowers.spawn(
        browser,
        [],
        () => content.document.activeElement.id === "page-input"
      ),
      "The transparent native layer allows normal page interaction"
    );
    await chat.toggle();
    ok(
      !chat.element("panel").hidden,
      "Chat opens with page JavaScript disabled"
    );
    is(
      win.document.activeElement,
      chat.element("input"),
      "Chat input receives keyboard focus"
    );
  });
});

add_task(async function test_drag_clamp_and_resize() {
  await withChatWindow({}, async (win, chat) => {
    const launcher = chat.element("launcher");
    const start = launcher.getBoundingClientRect();
    EventUtils.synthesizeMouseAtCenter(launcher, { type: "mousedown" }, win);
    EventUtils.synthesizeMouse(
      launcher,
      -100,
      -100,
      { type: "mousemove" },
      win
    );
    EventUtils.synthesizeMouse(launcher, 1, 1, { type: "mouseup" }, win);
    ok(chat.element("panel").hidden, "Dragging does not open chat");
    const end = launcher.getBoundingClientRect();
    ok(end.x < start.x && end.y < start.y, "Dragging moves the launcher");
    chat.position = { x: -5, y: 50 };
    chat.layout();
    await chat.toggle();
    const bounds = chat.element("overlay").getBoundingClientRect();
    const panel = chat.element("panel").getBoundingClientRect();
    ok(
      panel.left >= bounds.left && panel.right <= bounds.right,
      "Chat stays inside the page horizontally"
    );
    ok(
      panel.top >= bounds.top && panel.bottom <= bounds.bottom,
      "Chat stays inside the page vertically"
    );
    NativeChatStore.savePosition({ x: 1, y: 1 });
  });
});

add_task(async function test_private_history_and_safe_rendering() {
  const before = await NativeChatStore.loadHistory();
  await withChatWindow({ private: true }, async (win, chat) => {
    Assert.deepEqual(
      chat.messages,
      [],
      "Private windows do not load normal history"
    );
    chat.messages = [
      {
        role: "assistant",
        content:
          '<img src="https://example.com/leak" onerror="alert(1)">private',
      },
    ];
    chat.saveHistory();
    is(
      chat.element("messages").querySelector("img"),
      null,
      "Provider output is inert text"
    );
    ok(chat.element("messages").textContent.includes("private"));
    Assert.deepEqual(
      await NativeChatStore.loadHistory(),
      before,
      "Private chat never writes normal history"
    );
  });
  await withChatWindow({ private: true }, async (win, chat) => {
    Assert.deepEqual(
      chat.messages,
      [],
      "Closing the private window discards its conversation"
    );
  });
});

add_task(async function test_request_and_clear() {
  const { HttpServer } = ChromeUtils.importESModule(
    "resource://testing-common/httpd.sys.mjs"
  );
  const server = new HttpServer();
  let pending;
  server.registerPathHandler("/v1/chat/completions", (request, response) => {
    response.processAsync();
    pending = response;
  });
  server.start(-1);
  try {
    await NativeChatStore.saveSettings(
      {
        provider: "custom",
        endpoint: `http://localhost:${server.identity.primaryPort}/v1`,
        model: "test",
      },
      ""
    );
    await withChatWindow({}, async (win, chat) => {
      await chat.toggle();
      chat.clear();
      chat.element("input").value = "Hello";
      const sent = chat.send();
      await TestUtils.waitForCondition(() => pending);
      ok(chat.element("input").disabled, "Duplicate requests are disabled");
      pending.setHeader("Content-Type", "application/json");
      pending.write(
        JSON.stringify({ choices: [{ message: { content: "Hello back" } }] })
      );
      pending.finish();
      await sent;
      is(
        chat.messages.at(-1).content,
        "Hello back",
        "Provider response reaches chat"
      );
      is(
        (await NativeChatStore.loadHistory()).at(-1).content,
        "Hello back",
        "History persists"
      );
      pending = null;
      chat.element("input").value = "Cancel me";
      const cancelled = chat.send();
      await TestUtils.waitForCondition(() => pending);
      chat.clear();
      pending.write(
        JSON.stringify({ choices: [{ message: { content: "Late reply" } }] })
      );
      pending.finish();
      await cancelled;
      is(
        chat.messages.length,
        0,
        "Clearing aborts in-flight requests and rejects stale replies"
      );
      ok(
        !chat.element("input").disabled,
        "Composer recovers after cancellation"
      );
      await withChatWindow({}, async (secondWindow, secondChat) => {
        pending = null;
        chat.element("input").value = "First window";
        const firstReply = chat.send();
        await TestUtils.waitForCondition(() => pending);
        const firstResponse = pending;
        pending = null;
        secondChat.element("input").value = "Second window";
        const secondReply = secondChat.send();
        await TestUtils.waitForCondition(() => pending);
        pending.write(
          JSON.stringify({
            choices: [{ message: { content: "Second reply" } }],
          })
        );
        pending.finish();
        await secondReply;
        firstResponse.write(
          JSON.stringify({ choices: [{ message: { content: "First reply" } }] })
        );
        firstResponse.finish();
        await firstReply;
        const shared = await NativeChatStore.loadHistory();
        Assert.deepEqual(
          shared.map(message => message.content),
          ["First window", "Second window", "Second reply", "First reply"],
          "Concurrent replies from different windows preserve all messages"
        );
        pending = null;
        chat.element("input").value = "Clear from another window";
        const cleared = chat.send();
        await TestUtils.waitForCondition(() => pending);
        secondChat.clear();
        pending.write(
          JSON.stringify({ choices: [{ message: { content: "Stale reply" } }] })
        );
        pending.finish();
        await cleared;
        is(
          (await NativeChatStore.loadHistory()).length,
          0,
          "Clear cancels pending replies across windows"
        );
      });
    });
  } finally {
    await new Promise(resolve => server.stop(resolve));
  }
});

add_task(async function test_dom_fullscreen() {
  await withChatWindow({}, async (win, chat) => {
    const browser = win.gBrowser.selectedBrowser;
    BrowserTestUtils.startLoadingURIString(browser, RESTRICTED_URL);
    await BrowserTestUtils.browserLoaded(browser);
    await SpecialPowers.pushPrefEnv({
      set: [
        ["full-screen-api.allow-trusted-requests-only", false],
        ["full-screen-api.transition-duration.enter", "0 0"],
        ["full-screen-api.transition-duration.leave", "0 0"],
      ],
    });
    await SimpleTest.promiseFocus(browser);
    await DOMFullscreenTestUtils.changeFullscreen(browser, true);
    try {
      await chat.toggle();
      ok(
        chat.element("overlay").matches(":popover-open"),
        "Chat remains in the top layer in DOM fullscreen"
      );
      Assert.greater(chat.element("launcher").getBoundingClientRect().width, 0);
    } finally {
      chat.close();
      await SimpleTest.promiseFocus(browser);
      await DOMFullscreenTestUtils.changeFullscreen(browser, false);
    }
  });
});

add_task(async function test_opacity_and_position_recovery() {
  await withChatWindow({}, async (win, chat) => {
    await chat.open();
    await chat.toggleSettings();
    ok(chat.element("conversation").hidden, "Settings gets a separate view");
    chat.element("chat-opacity").value = "30";
    chat
      .element("chat-opacity")
      .dispatchEvent(new win.Event("input", { bubbles: true }));
    chat.element("button-opacity").value = "5";
    chat
      .element("button-opacity")
      .dispatchEvent(new win.Event("input", { bubbles: true }));
    is(
      win.getComputedStyle(chat.element("panel")).opacity,
      "0.3",
      "Chat opacity previews immediately"
    );
    is(
      chat.element("button-opacity-value").textContent,
      "5%",
      "Button opacity control reports its own value"
    );
    await withChatWindow({}, async (otherWindow, otherChat) => {
      Assert.deepEqual(
        otherChat.appearance,
        { chatOpacity: 30, buttonOpacity: 5 },
        "Opacity settings persist in new windows"
      );
    });
    chat.position = { x: 0, y: 0 };
    EventUtils.synthesizeKey("R", { shiftKey: true }, win);
    is(chat.position.x, 0, "Typing without Alt does not reset the launcher");
    chat.toggleHidden();
    await SimpleTest.promiseFocus(win);
    EventUtils.synthesizeKey("R", { altKey: true, shiftKey: true }, win);
    await TestUtils.waitForCondition(() => !chat.isHidden);
    Assert.deepEqual(
      chat.position,
      { x: 1, y: 1 },
      "Recovery shortcut restores the default position"
    );
    is(
      chat.appearance.buttonOpacity,
      60,
      "Recovery makes a nearly invisible button visible"
    );
    ok(
      chat.element("overlay").matches(":popover-open"),
      "Recovery restores a hidden overlay"
    );
    Assert.deepEqual(
      NativeChatStore.getPosition(),
      { x: 1, y: 1 },
      "Recovered position persists"
    );
    await chat.open();
    chat.position = { x: 0.2, y: 0.3 };
    chat.element("reset-position").click();
    await TestUtils.waitForCondition(() => chat.position.x === 1);
    is(chat.position.y, 1, "Settings provides the same recovery action");
  });
  NativeChatStore.saveAppearance({ chatOpacity: 95, buttonOpacity: 60 });
});

add_task(
  async function test_native_screenshot_and_answer_in_restricted_popup() {
    const { HttpServer } = ChromeUtils.importESModule(
      "resource://testing-common/httpd.sys.mjs"
    );
    const server = new HttpServer();
    const received = [];
    server.registerPathHandler("/v1/chat/completions", (request, response) => {
      const { NetUtil } = ChromeUtils.importESModule(
        "resource://gre/modules/NetUtil.sys.mjs"
      );
      received.push(
        JSON.parse(
          NetUtil.readInputStreamToString(
            request.bodyInputStream,
            request.bodyInputStream.available()
          )
        )
      );
      response.setHeader("Content-Type", "application/json");
      response.write(
        JSON.stringify({ choices: [{ message: { content: "4" } }] })
      );
    });
    server.start(-1);
    try {
      await NativeChatStore.saveSettings(
        {
          provider: "custom",
          endpoint: `http://localhost:${server.identity.primaryPort}/v1`,
          model: "vision-test",
        },
        ""
      );
      await withChatWindow(
        { all: false, features: "toolbar=no" },
        async (win, chat) => {
          const browser = win.gBrowser.selectedBrowser;
          browser.browsingContext.allowJavascript = false;
          await BrowserTestUtils.loadURIString({
            browser,
            uriString: RESTRICTED_URL,
          });
          await SpecialPowers.spawn(browser, [], () => {
            content.document.documentElement.style.backgroundColor =
              "rgb(0, 170, 68)";
            content.document.body.style.margin = "0";
            content.document.body.style.height = "3000px";
            content.document.body.style.background =
              "linear-gradient(rgb(170, 0, 0) 0 1000px, rgb(0, 170, 68) 1000px)";
            content.document.body.textContent = "What is 2 + 2?";
            content.scrollTo(0, 1200);
            content.addEventListener(
              "keydown",
              event => {
                event.preventDefault();
                event.stopImmediatePropagation();
              },
              true
            );
          });
          await chat.open();
          chat.clear();
          chat.element("input").value = "Keep this draft";
          EventUtils.synthesizeMouseAtCenter(
            chat.element("screenshot"),
            {},
            win
          );
          await TestUtils.waitForCondition(
            () => received.length === 1 && !chat.abortController
          );
          is(
            chat.messages.at(-1).content,
            "4",
            "Screenshot button returns the answer in a toolbarless popup"
          );
          is(
            chat.element("input").value,
            "Keep this draft",
            "Screenshot requests preserve the typed draft"
          );
          const parts = received[0].messages.at(-1).content;
          is(
            parts[1].type,
            "image_url",
            "The provider receives an image request"
          );
          is(
            received[0].messages[0].role,
            "system",
            "The screenshot request includes a system message"
          );
          ok(
            parts[0].text.includes("question visible in this screenshot"),
            "The screenshot uses the short-answer prompt"
          );
          const imageURL = parts[1].image_url.url;
          ok(
            imageURL.startsWith("data:image/png;base64,iVBOR"),
            "The native renderer returns a real PNG"
          );
          const image = new win.Image();
          image.src = imageURL;
          await image.decode();
          const canvas = win.document.createElementNS(
            "http://www.w3.org/1999/xhtml",
            "canvas"
          );
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext("2d");
          context.drawImage(image, 0, 0);
          const pixel = Array.from(
            context.getImageData(image.width - 24, image.height - 24, 1, 1).data
          );
          Assert.deepEqual(
            pixel,
            [0, 170, 68, 255],
            "The screenshot contains page pixels, without the native launcher or chat"
          );
          ok(
            !JSON.stringify(await NativeChatStore.loadHistory()).includes(
              imageURL.split(",")[1]
            ),
            "Screenshot pixels are never saved in chat history"
          );
          chat.close();
          await SimpleTest.promiseFocus(browser);
          EventUtils.synthesizeKey("q", { altKey: true }, win);
          await TestUtils.waitForCondition(
            () => received.length === 2 && !chat.abortController
          );
          is(
            chat.messages.at(-1).content,
            "4",
            "Reserved Alt+Q works with page scripts disabled and a hostile keyboard listener"
          );
          chat.position = { x: 0, y: 0 };
          chat.toggleHidden();
          await SimpleTest.promiseFocus(browser);
          EventUtils.synthesizeKey("R", { altKey: true, shiftKey: true }, win);
          await TestUtils.waitForCondition(() => !chat.isHidden);
          Assert.deepEqual(
            chat.position,
            { x: 1, y: 1 },
            "Position recovery also works in a restricted popup"
          );
        }
      );
    } finally {
      await new Promise(resolve => server.stop(resolve));
    }
  }
);

add_task(async function test_provider_settings_and_setup_error() {
  await withChatWindow({}, async (win, chat) => {
    await chat.open();
    await chat.toggleSettings();
    chat.element("provider").value = "custom";
    chat.element("endpoint").value = "http://localhost:1234/v1";
    chat.element("model").value = "local-vision-model";
    chat.element("key").value = "";
    chat
      .element("model")
      .dispatchEvent(new win.Event("change", { bubbles: true }));
    await TestUtils.waitForCondition(
      () => NativeChatStore.getSettings().model === "local-vision-model"
    );
    is(
      NativeChatStore.getSettings().model,
      "local-vision-model",
      "Provider form saves automatically on change"
    );
    await chat.toggleSettings();
    is(
      chat.element("model-label").textContent,
      "local-vision-model",
      "Header shows the selected model"
    );
    ok(
      !chat.element("conversation").hidden,
      "Closing settings returns to the conversation"
    );
    await SpecialPowers.pushPrefEnv({
      set: [["browser.nativeChat.model", ""]],
    });
    chat.element("input").value = "Preserve this draft";
    await chat.send({ screenshot: true });
    is(
      chat.element("status").getAttribute("data-l10n-id"),
      "native-chat-missing-model",
      "Screenshot setup failures explain how to recover"
    );
    is(
      chat.element("input").value,
      "Preserve this draft",
      "Setup failures preserve the draft"
    );
    ok(
      !chat.element("screenshot").disabled,
      "Screenshot action recovers after setup failure"
    );
    await SpecialPowers.popPrefEnv();
  });
});

add_task(async function test_opencode_provider_settings() {
  await withChatWindow({}, async (win, chat) => {
    await chat.open();
    await chat.toggleSettings();

    chat.element("provider").value = "opencode";
    chat
      .element("provider")
      .dispatchEvent(new win.Event("change", { bubbles: true }));
    is(
      chat.element("endpoint").value,
      "http://127.0.0.1:4096",
      "Selecting OpenCode populates default port 4096"
    );
    ok(!chat.element("model").required, "Model is optional for OpenCode");

    chat.element("model").value = "";
    chat
      .element("model")
      .dispatchEvent(new win.Event("change", { bubbles: true }));
    await chat.toggleSettings();
    is(
      chat.element("model-label").getAttribute("data-l10n-id"),
      "native-chat-server-default-model",
      "Model label shows server default when model is empty"
    );
    ok(
      chat.element("setup").hidden,
      "Setup button is hidden when OpenCode is configured"
    );

    // Test OpenCode v2 pair link redemption
    const { HttpServer } = ChromeUtils.importESModule(
      "resource://testing-common/httpd.sys.mjs"
    );
    const server = new HttpServer();
    server.registerPathHandler(
      "/auth/connect/code-browser-test",
      (request, response) => {
        response.setStatusLine(request.httpVersion, 200, "OK");
        response.setHeader("Content-Type", "application/json");
        response.write(JSON.stringify({ token: "browser-paired-token" }));
      }
    );
    server.start(-1);
    try {
      await chat.toggleSettings();
      chat.element("provider").value = "opencode-v2";
      chat
        .element("provider")
        .dispatchEvent(new win.Event("change", { bubbles: true }));
      is(
        chat.element("endpoint").value,
        "http://127.0.0.1:49374",
        "Selecting OpenCode v2 populates default port 49374"
      );

      server.registerPathHandler("/api/model", (request, response) => {
        response.setStatusLine(request.httpVersion, 200, "OK");
        response.setHeader("Content-Type", "application/json");
        response.write(
          JSON.stringify({
            data: [
              {
                id: "test-model-1",
                providerID: "opencode",
                name: "Test Model 1",
              },
            ],
          })
        );
      });

      const pairUrl = `http://localhost:${server.identity.primaryPort}/auth/connect/code-browser-test`;
      chat.element("endpoint").value = pairUrl;
      chat
        .element("endpoint")
        .dispatchEvent(new win.Event("change", { bubbles: true }));

      await TestUtils.waitForCondition(() =>
        Array.from(chat.element("model").options).some(
          opt => opt.value === "opencode/test-model-1"
        )
      );
      ok(
        true,
        "Model dropdown populated with identified model from OpenCode v2 server"
      );

      chat.element("model").value = "opencode/test-model-1";
      chat
        .element("model")
        .dispatchEvent(new win.Event("change", { bubbles: true }));
      await chat.toggleSettings();
      is(
        NativeChatStore.getSettings().endpoint,
        `http://localhost:${server.identity.primaryPort}`,
        "Pair link base URL was saved"
      );
      is(
        NativeChatStore.getSettings().model,
        "opencode/test-model-1",
        "Identified model selected from dropdown was saved"
      );
      is(
        await NativeChatStore.getKey(
          `http://localhost:${server.identity.primaryPort}`
        ),
        "browser-paired-token",
        "Redeemed pairing token was saved to password manager"
      );
    } finally {
      await new Promise(resolve => server.stop(resolve));
    }
  });
});
