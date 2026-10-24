/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

do_get_profile();
const { NativeChatStore, MAX_MESSAGES } = ChromeUtils.importESModule(
  "moz-src:///browser/components/nativechat/NativeChatStore.sys.mjs"
);

add_task(async function test_keys_and_settings() {
  await Services.logins.initializationPromise;
  const settings = {
    provider: "custom",
    endpoint: "http://localhost:1234/v1/",
    model: "test-model",
  };
  await NativeChatStore.saveSettings(settings, "test-secret");
  Assert.equal(await NativeChatStore.getKey(settings.endpoint), "test-secret");
  Assert.equal(
    NativeChatStore.getSettings().endpoint,
    "http://localhost:1234/v1"
  );
  Assert.ok(
    !JSON.stringify(NativeChatStore.getSettings()).includes("test-secret")
  );
  Assert.equal(await NativeChatStore.getKey("http://localhost:5678/v1"), "");
  await NativeChatStore.saveSettings(settings, "replacement");
  Assert.equal(await NativeChatStore.getKey(settings.endpoint), "replacement");
  await NativeChatStore.saveSettings(settings, "");
  Assert.equal(await NativeChatStore.getKey(settings.endpoint), "");
  Services.prefs.deleteBranch("browser.nativeChat.");
});

add_task(async function test_history_persistence_and_clear() {
  Assert.deepEqual(await NativeChatStore.loadHistory(), []);
  const messages = Array.from({ length: MAX_MESSAGES + 5 }, (_, index) => ({
    role: "user",
    content: String(index),
  }));
  NativeChatStore.saveHistory(messages);
  const history = await NativeChatStore.loadHistory();
  Assert.equal(history.length, MAX_MESSAGES);
  Assert.equal(history[0].content, "5");
  history[0].content = "mutated";
  Assert.equal((await NativeChatStore.loadHistory())[0].content, "5");
  NativeChatStore.appendMessage({
    role: "assistant",
    content: "persisted-reply",
  });
  const { TestUtils } = ChromeUtils.importESModule(
    "resource://testing-common/TestUtils.sys.mjs"
  );
  await TestUtils.waitForCondition(async () => {
    const saved = await IOUtils.readJSON(
      PathUtils.join(PathUtils.profileDir, "native-chat-history.json")
    ).catch(() => null);
    return saved?.messages?.at(-1)?.content === "persisted-reply";
  }, "History reaches the profile file");
  Assert.equal((await NativeChatStore.loadHistory()).length, MAX_MESSAGES);
  NativeChatStore.saveHistory([]);
  Assert.deepEqual(await NativeChatStore.loadHistory(), []);
});

add_task(function test_invalid_saved_position() {
  Services.prefs.setStringPref("browser.nativeChat.position", "invalid-json");
  Assert.deepEqual(NativeChatStore.getPosition(), { x: 1, y: 1 });
  NativeChatStore.savePosition({ x: 0.25, y: 0.5 });
  Assert.deepEqual(NativeChatStore.getPosition(), { x: 0.25, y: 0.5 });
  Services.prefs.deleteBranch("browser.nativeChat.");
});
