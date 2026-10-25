/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { JSONFile } from "resource://gre/modules/JSONFile.sys.mjs";
import {
  normalizeEndpoint,
  PROVIDERS,
} from "moz-src:///browser/components/nativechat/NativeChatProvider.sys.mjs";

const PREF = "browser.nativeChat.";
const ORIGIN = "chrome://firefox-plus-native-chat";
const LoginInfo = Components.Constructor(
  "@mozilla.org/login-manager/loginInfo;1",
  "nsILoginInfo",
  "init"
);
export const HISTORY_TOPIC = "firefox-plus-native-chat-history-changed";
export const MAX_MESSAGES = 100;
export const DEFAULT_APPEARANCE = { chatOpacity: 95, buttonOpacity: 60 };
export const APPEARANCE_PREF = PREF;
let historyFile;
let historyReady;

export const NativeChatStore = {
  getAppearance() {
    return Object.fromEntries(
      Object.entries(DEFAULT_APPEARANCE).map(([name, value]) => [
        name,
        Math.min(
          100,
          Math.max(5, Services.prefs.getIntPref(`${PREF}${name}`, value))
        ),
      ])
    );
  },

  saveAppearance(appearance) {
    for (const name of Object.keys(DEFAULT_APPEARANCE)) {
      const value = appearance[name];
      if (Number.isFinite(value)) {
        Services.prefs.setIntPref(
          `${PREF}${name}`,
          Math.min(100, Math.max(5, Math.round(value)))
        );
      }
    }
  },

  getSettings() {
    const provider = Services.prefs.getStringPref(`${PREF}provider`, "openai");
    return {
      provider: Object.hasOwn(PROVIDERS, provider) ? provider : "openai",
      endpoint: Services.prefs.getStringPref(
        `${PREF}endpoint`,
        PROVIDERS.openai
      ),
      model: Services.prefs.getStringPref(`${PREF}model`, ""),
    };
  },

  async saveSettings(settings, apiKey) {
    const endpoint = normalizeEndpoint(settings.endpoint);
    if (
      !Object.hasOwn(PROVIDERS, settings.provider) ||
      !settings.model.trim()
    ) {
      throw new Error("native-chat-missing-model");
    }
    const logins = await Services.logins.searchLoginsAsync({
      origin: ORIGIN,
      httpRealm: endpoint,
    });
    if (apiKey) {
      const login = new LoginInfo(
        ORIGIN,
        null,
        endpoint,
        "api-key",
        apiKey,
        "",
        ""
      );
      if (logins.length) {
        await Services.logins.modifyLoginAsync(logins[0], login);
      } else {
        await Services.logins.addLoginAsync(login);
      }
    } else {
      for (const login of logins) {
        await Services.logins.removeLoginAsync(login);
      }
    }
    Services.prefs.setStringPref(`${PREF}provider`, settings.provider);
    Services.prefs.setStringPref(`${PREF}endpoint`, endpoint);
    Services.prefs.setStringPref(`${PREF}model`, settings.model.trim());
  },

  async getKey(endpoint) {
    return (
      (
        await Services.logins.searchLoginsAsync({
          origin: ORIGIN,
          httpRealm: normalizeEndpoint(endpoint),
        })
      )[0]?.password || ""
    );
  },

  async loadHistory() {
    if (!historyReady) {
      historyFile = new JSONFile({
        path: PathUtils.join(PathUtils.profileDir, "native-chat-history.json"),
        dataPostProcessor(data) {
          return {
            messages: Array.isArray(data?.messages)
              ? data.messages
                  .filter(
                    message =>
                      ["user", "assistant"].includes(message?.role) &&
                      typeof message.content === "string"
                  )
                  .slice(-MAX_MESSAGES)
              : [],
          };
        },
      });
      historyReady = historyFile.load();
    }
    await historyReady;
    return historyFile.data.messages.map(message => ({ ...message }));
  },

  saveHistory(messages) {
    historyFile.data = { messages: messages.slice(-MAX_MESSAGES) };
    historyFile.saveSoon();
    Services.obs.notifyObservers(
      null,
      HISTORY_TOPIC,
      messages.length ? null : "reset"
    );
  },

  appendMessage(message) {
    this.saveHistory([...historyFile.data.messages, message]);
    return historyFile.data.messages.map(entry => ({ ...entry }));
  },

  getPosition() {
    try {
      const position = JSON.parse(
        Services.prefs.getStringPref(`${PREF}position`, "null")
      );
      if (Number.isFinite(position?.x) && Number.isFinite(position?.y)) {
        return position;
      }
    } catch {}
    return { x: 1, y: 1 };
  },

  savePosition(position) {
    Services.prefs.setStringPref(`${PREF}position`, JSON.stringify(position));
  },
};
