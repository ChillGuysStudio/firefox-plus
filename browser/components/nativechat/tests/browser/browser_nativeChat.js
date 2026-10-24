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
