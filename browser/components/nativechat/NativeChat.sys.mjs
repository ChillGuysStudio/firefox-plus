/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { PrivateBrowsingUtils } from "resource://gre/modules/PrivateBrowsingUtils.sys.mjs";
import {
  PROVIDERS,
  buildRequest,
  normalizeEndpoint,
  requestReply,
} from "moz-src:///browser/components/nativechat/NativeChatProvider.sys.mjs";
import {
  HISTORY_TOPIC,
  MAX_MESSAGES,
  NativeChatStore,
} from "moz-src:///browser/components/nativechat/NativeChatStore.sys.mjs";

/** Manages a floating chat in browser chrome, independently of web content. */
export class NativeChat {
  constructor(window) {
    this.window = window;
    this.document = window.document;
    this.isPrivate = PrivateBrowsingUtils.isWindowPrivate(window);
    this.messages = [];
    this.position = NativeChatStore.getPosition();
    this.abortController = null;
    this.destroyed = false;
    this.ready = this.init();
  }

  element(name) {
    return this.document.getElementById(`native-chat-${name}`);
  }

  async init() {
    this.listeners = new this.window.AbortController();
    const listen = (target, type, callback, options = {}) => {
      target.addEventListener(type, callback, {
        ...options,
        signal: this.listeners.signal,
      });
    };
    listen(this.window, "unload", () => this.destroy(), { once: true });
    listen(this.element("launcher"), "click", () => {
      if (!this.suppressClick) {
        this.toggle();
      }
      this.suppressClick = false;
    });
    listen(this.element("launcher"), "pointerdown", event =>
      this.startDrag(event)
    );
    listen(this.element("launcher"), "pointermove", event =>
      this.moveDrag(event)
    );
    listen(this.element("launcher"), "pointerup", event => this.endDrag(event));
    listen(this.element("launcher"), "pointercancel", () => this.cancelDrag());
    listen(this.element("launcher"), "lostpointercapture", () =>
      this.cancelDrag()
    );
    listen(this.element("close"), "click", () => this.close());
    listen(this.element("new"), "click", () => this.clear());
    listen(this.element("stop"), "click", () => this.stop());
    listen(this.element("composer"), "submit", event => {
      event.preventDefault();
      this.send();
    });
    listen(this.element("input"), "keydown", event => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.send();
      }
    });
    listen(this.element("overlay"), "keydown", event => {
      if (
        event.key === "Escape" &&
        !event.isComposing &&
        !this.element("panel").hidden
      ) {
        event.preventDefault();
        event.stopPropagation();
        this.close();
      }
    });
    listen(this.element("settings-toggle"), "click", () =>
      this.toggleSettings()
    );
    listen(this.element("settings"), "submit", event => {
      event.preventDefault();
      this.saveSettings();
    });
    listen(this.element("provider"), "change", () => {
      this.element("endpoint").value =
        PROVIDERS[this.element("provider").value];
      this.element("model").value = "";
      this.loadKey();
    });
    listen(this.element("endpoint"), "change", () => this.loadKey());
    listen(
      this.document.getElementById("cmd_nativeChatToggle"),
      "command",
      () => this.toggle()
    );
    listen(this.document.getElementById("cmd_nativeChatHide"), "command", () =>
      this.toggleHidden()
    );

    this.resizeObserver = new this.window.ResizeObserver(() => this.layout());
    this.resizeObserver.observe(
      this.document.getElementById("tabbrowser-tabbox")
    );
    this.resizeObserver.observe(this.element("panel"));
    listen(this.window, "resize", () => this.layout());
    listen(this.window, "fullscreen", () => this.layout());
    listen(this.document, "fullscreenchange", () => this.layout());
    this.chromeObserver = new this.window.MutationObserver(() => this.layout());
    this.chromeObserver.observe(this.document.documentElement, {
      attributes: true,
      attributeFilter: ["inDOMFullscreen", "fullscreenNavToolboxHidden"],
    });
    if (!this.isPrivate) {
      Services.obs.addObserver(this, HISTORY_TOPIC);
    }
    this.element("private").hidden = !this.isPrivate;
    this.layout();
    try {
      if (!this.isPrivate) {
        this.messages = await NativeChatStore.loadHistory();
      }
      if (!this.destroyed) {
        this.renderMessages();
      }
    } catch {
      this.status("native-chat-storage-error", true);
    }
  }

  async observe(subject, topic, data) {
    if (data === "reset") {
      this.stop();
    }
    if (!this.abortController) {
      this.messages = await NativeChatStore.loadHistory();
      if (!this.destroyed) {
        this.renderMessages();
      }
    }
  }

  layout() {
    if (this.destroyed || this.isHidden) {
      return;
    }
    const bounds = this.document
      .getElementById("tabbrowser-tabbox")
      .getBoundingClientRect();
    if (!bounds.width || !bounds.height) {
      return;
    }
    const overlay = this.element("overlay");
    Object.assign(overlay.style, {
      left: `${bounds.left}px`,
      top: `${bounds.top}px`,
      width: `${bounds.width}px`,
      height: `${bounds.height}px`,
    });
    if (!overlay.matches(":popover-open")) {
      overlay.showPopover();
    }
    const launcher = this.element("launcher");
    const maxX = Math.max(0, bounds.width - launcher.offsetWidth);
    const maxY = Math.max(0, bounds.height - launcher.offsetHeight);
    const x = Math.min(1, Math.max(0, this.position.x)) * maxX;
    const y = Math.min(1, Math.max(0, this.position.y)) * maxY;
    launcher.style.left = `${x}px`;
    launcher.style.top = `${y}px`;
    const panel = this.element("panel");
    panel.style.left = `${Math.max(0, Math.min(x + launcher.offsetWidth - panel.offsetWidth, bounds.width - panel.offsetWidth))}px`;
    panel.style.top = `${Math.max(0, Math.min(y > panel.offsetHeight + 8 ? y - panel.offsetHeight - 8 : y + launcher.offsetHeight + 8, bounds.height - panel.offsetHeight))}px`;
  }

  async toggle() {
    await this.ready;
    if (this.destroyed) {
      return;
    }
    if (!this.element("panel").hidden) {
      this.close();
      return;
    }
    this.isHidden = false;
    this.previousFocus = this.document.activeElement;
    this.element("panel").hidden = false;
    this.element("launcher").setAttribute("aria-expanded", "true");
    this.layout();
    this.element("input").focus();
  }

  close() {
    this.element("panel").hidden = true;
    this.element("launcher").setAttribute("aria-expanded", "false");
    if (this.previousFocus?.isConnected) {
      this.previousFocus.focus();
    } else {
      this.window.gBrowser.selectedBrowser.focus();
    }
    this.previousFocus = null;
  }

  toggleHidden() {
    this.close();
    this.isHidden = !this.isHidden;
    if (this.isHidden) {
      this.element("overlay").hidePopover();
    } else {
      this.layout();
    }
  }

  startDrag(event) {
    if (event.button !== 0) {
      return;
    }
    this.suppressClick = false;
    this.drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      position: { ...this.position },
    };
    this.element("launcher").setPointerCapture(event.pointerId);
  }

  moveDrag(event) {
    if (this.drag?.id !== event.pointerId) {
      return;
    }
    const dx = event.clientX - this.drag.x;
    const dy = event.clientY - this.drag.y;
    if (!this.suppressClick && Math.hypot(dx, dy) < 4) {
      return;
    }
    this.suppressClick = true;
    const bounds = this.element("overlay").getBoundingClientRect();
    const launcher = this.element("launcher");
    this.position = {
      x: Math.min(
        1,
        Math.max(
          0,
          this.drag.position.x +
            dx / Math.max(1, bounds.width - launcher.offsetWidth)
        )
      ),
      y: Math.min(
        1,
        Math.max(
          0,
          this.drag.position.y +
            dy / Math.max(1, bounds.height - launcher.offsetHeight)
        )
      ),
    };
    this.layout();
  }

  endDrag(event) {
    if (this.drag?.id !== event.pointerId) {
      return;
    }
    if (this.suppressClick && !this.isPrivate) {
      NativeChatStore.savePosition(this.position);
    }
    this.element("launcher").releasePointerCapture(event.pointerId);
    this.drag = null;
  }

  cancelDrag() {
    this.drag = null;
  }

  async toggleSettings() {
    const form = this.element("settings");
    form.hidden = !form.hidden;
    this.element("settings-toggle").setAttribute(
      "aria-expanded",
      String(!form.hidden)
    );
    if (!form.hidden) {
      const settings = NativeChatStore.getSettings();
      for (const name of ["provider", "endpoint", "model"]) {
        this.element(name).value = settings[name];
      }
      await this.loadKey();
      this.element("provider").focus();
    } else {
      this.element("key").value = "";
      this.element("input").focus();
    }
  }

  async loadKey() {
    const endpoint = this.element("endpoint").value;
    this.element("key").value = "";
    try {
      const key = await NativeChatStore.getKey(endpoint);
      if (
        !this.destroyed &&
        !this.element("settings").hidden &&
        endpoint === this.element("endpoint").value
      ) {
        this.element("key").value = key;
      }
    } catch {
      this.status("native-chat-storage-error", true);
    }
  }

  async saveSettings() {
    const settings = Object.fromEntries(
      ["provider", "endpoint", "model"].map(name => [
        name,
        this.element(name).value,
      ])
    );
    this.element("settings-save").disabled = true;
    try {
      settings.endpoint = normalizeEndpoint(settings.endpoint);
      await NativeChatStore.saveSettings(
        settings,
        this.element("key").value.trim()
      );
      if (!this.destroyed) {
        await this.toggleSettings();
        this.status("native-chat-settings-saved");
      }
    } catch (error) {
      this.showError(error, "native-chat-storage-error");
    } finally {
      this.element("settings-save").disabled = false;
    }
  }

  status(id, error = false, args = null) {
    const status = this.element("status");
    status.hidden = !id;
    status.toggleAttribute("data-error", error);
    if (id) {
      this.document.l10n.setAttributes(status, id, args);
    }
  }

  showError(error, fallback = "native-chat-network-error") {
    const known = [
      "native-chat-invalid-endpoint",
      "native-chat-missing-model",
      "native-chat-missing-key",
      "native-chat-empty-response",
      "native-chat-request-error",
      "native-chat-timeout",
    ];
    this.status(
      known.includes(error.message) ? error.message : fallback,
      true,
      error.cause?.status ? { status: error.cause.status } : null
    );
  }

  renderMessages() {
    const container = this.element("messages");
    const fragment = this.document.createDocumentFragment();
    for (const message of this.messages) {
      const article = this.document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "article"
      );
      const label = this.document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "strong"
      );
      this.document.l10n.setAttributes(
        label,
        message.role === "user" ? "native-chat-you" : "native-chat-assistant"
      );
      const text = this.document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "p"
      );
      text.textContent = message.content;
      article.append(label, text);
      fragment.append(article);
    }
    container.replaceChildren(fragment);
    this.element("empty").hidden = !!this.messages.length;
    container.scrollTop = container.scrollHeight;
  }

  saveHistory() {
    this.messages = this.messages.slice(-MAX_MESSAGES);
    this.renderMessages();
    if (!this.isPrivate) {
      NativeChatStore.saveHistory(this.messages);
    }
  }

  appendMessage(message) {
    this.messages = this.isPrivate
      ? [...this.messages, message].slice(-MAX_MESSAGES)
      : NativeChatStore.appendMessage(message);
    this.renderMessages();
  }

  setBusy(busy) {
    this.element("send").hidden = busy;
    this.element("stop").hidden = !busy;
    this.element("input").disabled = busy;
    this.element("panel").setAttribute("aria-busy", String(busy));
  }

  async send() {
    await this.ready;
    const input = this.element("input");
    const text = input.value.trim();
    if (!text || this.abortController || this.destroyed) {
      return;
    }
    if (text === "/reset") {
      input.value = "";
      this.clear();
      return;
    }
    const controller = new this.window.AbortController();
    this.abortController = controller;
    this.setBusy(true);
    try {
      const settings = NativeChatStore.getSettings();
      const key = await NativeChatStore.getKey(settings.endpoint);
      const history = this.isPrivate
        ? this.messages
        : await NativeChatStore.loadHistory();
      if (this.abortController !== controller || this.destroyed) {
        return;
      }
      const messages = [...history, { role: "user", content: text }].slice(
        -MAX_MESSAGES
      );
      // Validate before committing the message, so setup errors preserve the draft.
      buildRequest(settings, key, messages);
      input.value = "";
      this.appendMessage({ role: "user", content: text });
      this.status("native-chat-working");
      const timeout = this.window.setTimeout(
        () => controller.abort(new Error("native-chat-timeout")),
        120000
      );
      let reply;
      try {
        reply = await requestReply(settings, key, messages, controller.signal);
      } finally {
        this.window.clearTimeout(timeout);
      }
      if (this.abortController !== controller || this.destroyed) {
        return;
      }
      this.appendMessage({ role: "assistant", content: reply });
      this.status(null);
    } catch (error) {
      if (this.abortController === controller && !this.destroyed) {
        this.showError(error);
      }
    } finally {
      if (this.abortController === controller && !this.destroyed) {
        this.abortController = null;
        this.setBusy(false);
        if (!this.element("panel").hidden) {
          input.focus();
        }
      }
    }
  }

  stop() {
    this.abortController?.abort();
    this.abortController = null;
    this.setBusy(false);
    this.status(null);
  }

  clear() {
    this.stop();
    this.element("input").value = "";
    this.messages = [];
    this.saveHistory();
    this.element("input").focus();
  }

  destroy() {
    this.destroyed = true;
    this.abortController?.abort();
    this.listeners.abort();
    this.resizeObserver.disconnect();
    this.chromeObserver.disconnect();
    if (!this.isPrivate) {
      Services.obs.removeObserver(this, HISTORY_TOPIC);
    }
  }
}
