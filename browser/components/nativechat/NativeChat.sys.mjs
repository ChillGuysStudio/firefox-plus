/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { PrivateBrowsingUtils } from "resource://gre/modules/PrivateBrowsingUtils.sys.mjs";
import {
  PROVIDERS,
  PROVIDER_DEFAULT_MODELS,
  buildRequest,
  getOpenAICompatibleModels,
  getOpenCodeModels,
  getOpenCodeV2Models,
  isOpenCodeProvider,
  pairOpenCodeV2,
  parseOpenCodePairLink,
  requestReply,
  resetOpenCodeSessions,
} from "moz-src:///browser/components/nativechat/NativeChatProvider.sys.mjs";
import {
  APPEARANCE_PREF,
  DEFAULT_APPEARANCE,
  HISTORY_TOPIC,
  MAX_MESSAGES,
  NativeChatStore,
} from "moz-src:///browser/components/nativechat/NativeChatStore.sys.mjs";
import {
  capturePage,
  SCREENSHOT_PROMPT,
} from "moz-src:///browser/components/nativechat/NativeChatScreenshot.sys.mjs";

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
    listen(this.element("screenshot"), "click", () =>
      this.send({ screenshot: true })
    );
    listen(this.element("setup"), "click", () => this.toggleSettings());
    listen(this.element("reset-position"), "click", () => this.resetPosition());
    for (const name of ["chatOpacity", "buttonOpacity"]) {
      const id = name === "chatOpacity" ? "chat-opacity" : "button-opacity";
      listen(this.element(id), "input", () => {
        NativeChatStore.saveAppearance({
          [name]: Number(this.element(id).value),
        });
      });
    }
    const modelSelect = this.element("model");
    if (modelSelect) {
      const originalValueDesc = Object.getOwnPropertyDescriptor(
        this.window.HTMLSelectElement.prototype,
        "value"
      );
      Object.defineProperty(modelSelect, "value", {
        get() {
          return originalValueDesc.get.call(this);
        },
        set(val) {
          if (
            typeof val === "string" &&
            val &&
            !Array.from(this.options).some(opt => opt.value === val)
          ) {
            const opt = this.ownerDocument.createElementNS(
              "http://www.w3.org/1999/xhtml",
              "option"
            );
            opt.value = val;
            opt.textContent = val;
            this.append(opt);
          }
          originalValueDesc.set.call(this, val);
        },
        configurable: true,
      });
    }
    listen(this.element("model"), "change", () => {
      this.updateProviderFields();
      this.autoSaveSettings();
    });
    listen(this.element("model"), "input", () => {
      this.updateProviderFields();
      this.autoSaveSettings();
    });
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
      this.autoSaveSettings();
    });
    listen(this.element("provider"), "change", async () => {
      this.element("endpoint").value =
        PROVIDERS[this.element("provider").value];
      this.element("model").value = "";
      this.updateProviderFields();
      await this.loadKey();
      await this.loadModels();
      await this.autoSaveSettings();
    });
    listen(this.element("endpoint"), "change", async () => {
      const paired = await this.maybePairFromInput();
      if (!paired) {
        await this.loadKey();
      }
      await this.loadModels();
      await this.autoSaveSettings();
    });
    listen(this.element("endpoint"), "input", async () => {
      await this.autoSaveSettings();
    });
    listen(this.element("key"), "change", async () => {
      await this.maybePairFromInput();
      await this.loadModels();
      await this.autoSaveSettings();
    });
    listen(this.element("key"), "input", async () => {
      await this.autoSaveSettings();
    });
    listen(
      this.document.getElementById("cmd_nativeChatToggle"),
      "command",
      () => this.toggle()
    );
    listen(this.document.getElementById("cmd_nativeChatHide"), "command", () =>
      this.toggleHidden()
    );
    listen(
      this.document.getElementById("cmd_nativeChatScreenshot"),
      "command",
      () => this.send({ screenshot: true })
    );
    listen(
      this.document.getElementById("cmd_nativeChatResetPosition"),
      "command",
      () => this.resetPosition()
    );
    listen(
      this.window,
      "keydown",
      event => {
        if (
          event.isTrusted &&
          !event.repeat &&
          event.code === "KeyR" &&
          event.altKey &&
          event.shiftKey &&
          !event.ctrlKey &&
          !event.metaKey
        ) {
          event.preventDefault();
          event.stopImmediatePropagation();
          this.resetPosition();
        }
      },
      { capture: true }
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
      attributeFilter: [
        "inDOMFullscreen",
        "fullscreenNavToolboxHidden",
        "sidebar-positionend",
      ],
    });
    if (!this.isPrivate) {
      Services.obs.addObserver(this, HISTORY_TOPIC);
    }
    Services.prefs.addObserver(APPEARANCE_PREF, this);
    this.applyAppearance();
    this.updateProviderLabel();
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
    if (topic === "nsPref:changed") {
      if (
        [
          "browser.nativeChat.chatOpacity",
          "browser.nativeChat.buttonOpacity",
        ].includes(data)
      ) {
        this.applyAppearance();
      }
      if (
        data === "browser.nativeChat.model" ||
        data === "browser.nativeChat.provider"
      ) {
        this.updateProviderLabel();
      }
      return;
    }
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
    const insetX = Math.min(12, maxX / 2);
    const insetY = Math.min(12, maxY / 2);
    const x =
      insetX + Math.min(1, Math.max(0, this.position.x)) * (maxX - 2 * insetX);
    const y =
      insetY + Math.min(1, Math.max(0, this.position.y)) * (maxY - 2 * insetY);
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
    await this.open();
  }

  async open() {
    await this.ready;
    if (this.destroyed) {
      return;
    }
    this.isHidden = false;
    if (this.element("panel").hidden) {
      this.previousFocus = this.document.activeElement;
    }
    this.element("panel").hidden = false;
    this.element("launcher").setAttribute("aria-expanded", "true");
    this.layout();
    this.element(
      this.element("settings").hidden ? "input" : "provider"
    ).focus();
  }

  applyAppearance(appearance = NativeChatStore.getAppearance()) {
    this.appearance = appearance;
    const overlay = this.element("overlay");
    overlay.style.setProperty(
      "--opacity-native-chat-panel",
      appearance.chatOpacity / 100
    );
    overlay.style.setProperty(
      "--opacity-native-chat-button",
      appearance.buttonOpacity / 100
    );
    for (const [name, id] of [
      ["chatOpacity", "chat-opacity"],
      ["buttonOpacity", "button-opacity"],
    ]) {
      this.element(id).value = appearance[name];
      this.element(`${id}-value`).textContent = `${appearance[name]}%`;
    }
  }

  updateProviderFields() {
    const provider = this.element("provider")?.value;
    const model = this.element("model");
    const isOpenCode = isOpenCodeProvider(provider);
    if (model) {
      model.required = !isOpenCode;
    }
    const endpointLabel = this.element("endpoint-label");
    const keyLabel = this.element("key-label");
    if (endpointLabel) {
      let l10nId = "native-chat-endpoint";
      if (provider === "opencode") {
        l10nId = "native-chat-opencode-endpoint";
      } else if (provider === "opencode-v2") {
        l10nId = "native-chat-opencode-v2-endpoint";
      }
      this.document.l10n.setAttributes(endpointLabel, l10nId);
    }
    if (keyLabel) {
      let l10nId = "native-chat-key";
      if (provider === "opencode") {
        l10nId = "native-chat-opencode-key";
      } else if (provider === "opencode-v2") {
        l10nId = "native-chat-opencode-v2-key";
      }
      this.document.l10n.setAttributes(keyLabel, l10nId);
    }
  }

  createOption(value, label) {
    const option = this.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "option"
    );
    option.value = value;
    option.textContent = label;
    return option;
  }

  async loadModels(savedModel = null) {
    const provider = this.element("provider")?.value;
    const endpoint = this.element("endpoint")?.value;
    const modelSelect = this.element("model");
    if (!modelSelect) {
      return;
    }

    const currentSelected =
      savedModel !== null ? savedModel : modelSelect.value;

    let models = (PROVIDER_DEFAULT_MODELS[provider] || []).map(m => ({
      ...m,
    }));

    if (isOpenCodeProvider(provider)) {
      if (modelSelect.options.length === 0) {
        modelSelect.replaceChildren(
          this.createOption("", "Server default model")
        );
      }
      if (endpoint) {
        try {
          const key = await NativeChatStore.getKey(endpoint);
          const data =
            provider === "opencode"
              ? await getOpenCodeModels(endpoint, key)
              : await getOpenCodeV2Models(endpoint, key);
          if (
            !this.destroyed &&
            this.element("provider")?.value === provider &&
            this.element("endpoint")?.value === endpoint &&
            Array.isArray(data?.models) &&
            data.models.length
          ) {
            models = [
              { value: "", label: "Server default model" },
              ...data.models,
            ];
          }
        } catch {}
      }
    } else if (["custom", "openai"].includes(provider) && endpoint) {
      try {
        const key = await NativeChatStore.getKey(endpoint);
        const fetched = await getOpenAICompatibleModels(endpoint, key);
        if (
          !this.destroyed &&
          this.element("provider")?.value === provider &&
          fetched.length
        ) {
          models = fetched;
        }
      } catch {}
    }

    if (this.destroyed || this.element("provider")?.value !== provider) {
      return;
    }

    const fragment = this.document.createDocumentFragment();
    let hasSelected = false;
    for (const item of models) {
      const opt = this.createOption(item.value, item.label);
      if (item.value === currentSelected) {
        opt.selected = true;
        hasSelected = true;
      }
      fragment.append(opt);
    }

    if (currentSelected && !models.some(m => m.value === currentSelected)) {
      const customOpt = this.createOption(currentSelected, currentSelected);
      customOpt.selected = true;
      hasSelected = true;
      fragment.append(customOpt);
    }

    modelSelect.replaceChildren(fragment);
    if (hasSelected && currentSelected !== null) {
      modelSelect.value = currentSelected;
    } else if (models.length && currentSelected === null) {
      modelSelect.value = models[0].value;
    }
    this.updateProviderFields();
  }

  async maybePairFromInput() {
    const provider = this.element("provider")?.value;
    if (provider !== "opencode-v2") {
      return false;
    }
    const endpointInput = this.element("endpoint");
    const keyInput = this.element("key");
    const endpointPair = parseOpenCodePairLink(endpointInput?.value);
    const keyPair = parseOpenCodePairLink(keyInput?.value);
    let pairCandidate = null;
    if (endpointPair) {
      pairCandidate = endpointInput.value;
    } else if (keyPair) {
      pairCandidate = keyInput.value;
    }
    if (pairCandidate) {
      try {
        const paired = await pairOpenCodeV2(pairCandidate);
        if (paired && !this.destroyed) {
          endpointInput.value = paired.baseUrl;
          keyInput.value = paired.password;
          return true;
        }
      } catch (error) {
        this.showError(error);
      }
    }
    return false;
  }

  updateProviderLabel() {
    const settings = NativeChatStore.getSettings();
    const model = settings.model;
    const label = this.element("model-label");
    if (model) {
      label.removeAttribute("data-l10n-id");
      label.textContent = model;
    } else if (isOpenCodeProvider(settings.provider)) {
      this.document.l10n.setAttributes(
        label,
        "native-chat-server-default-model"
      );
    } else {
      this.document.l10n.setAttributes(label, "native-chat-not-configured");
    }
    this.element("setup").hidden =
      !!model || isOpenCodeProvider(settings.provider);
  }

  async resetPosition() {
    await this.ready;
    if (this.destroyed) {
      return;
    }
    this.position = { x: 1, y: 1 };
    this.drag = null;
    this.isHidden = false;
    if (this.isPrivate) {
      this.applyAppearance({
        ...this.appearance,
        buttonOpacity: DEFAULT_APPEARANCE.buttonOpacity,
      });
    } else {
      NativeChatStore.savePosition(this.position);
      NativeChatStore.saveAppearance({
        buttonOpacity: DEFAULT_APPEARANCE.buttonOpacity,
      });
    }
    this.layout();
    this.element("launcher").focus({ preventScroll: true });
    this.status("native-chat-position-reset");
  }

  close() {
    if (!this.element("settings").hidden) {
      this.autoSaveSettings();
    }
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
            dx / Math.max(1, bounds.width - launcher.offsetWidth - 24)
        )
      ),
      y: Math.min(
        1,
        Math.max(
          0,
          this.drag.position.y +
            dy / Math.max(1, bounds.height - launcher.offsetHeight - 24)
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
    this.element("conversation").hidden = !form.hidden;
    this.element("settings-toggle").setAttribute(
      "aria-expanded",
      String(!form.hidden)
    );
    if (!form.hidden) {
      const settings = NativeChatStore.getSettings();
      for (const name of ["provider", "endpoint"]) {
        this.element(name).value = settings[name];
      }
      this.updateProviderFields();
      await this.loadKey();
      await this.loadModels(settings.model);
      this.element("provider").focus();
    } else {
      await this.autoSaveSettings();
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

  async autoSaveSettings() {
    if (this.destroyed) {
      return;
    }
    await this.maybePairFromInput();
    const settings = Object.fromEntries(
      ["provider", "endpoint", "model"].map(name => [
        name,
        this.element(name)?.value || "",
      ])
    );
    const key = this.element("key")?.value?.trim() || "";
    try {
      const saved = await NativeChatStore.saveSettings(settings, key);
      if (!this.destroyed) {
        if (saved?.endpoint && this.element("endpoint")) {
          this.element("endpoint").value = saved.endpoint;
        }
        if (saved?.key && this.element("key")) {
          this.element("key").value = saved.key;
        }
        this.updateProviderLabel();
      }
    } catch {
      // Ignore validation errors while editing incomplete settings.
    }
  }

  async saveSettings() {
    return this.autoSaveSettings();
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
      "native-chat-screenshot-error",
      "native-chat-opencode-auth-error",
      "native-chat-opencode-v2-auth-error",
      "native-chat-opencode-v2-pair-error",
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
      article.dataset.role = message.role;
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
    this.element("screenshot").disabled = busy;
    this.element("panel").setAttribute("aria-busy", String(busy));
  }

  async send({ screenshot = false } = {}) {
    const screenshotBrowser = screenshot
      ? this.window.gBrowser.selectedBrowser
      : null;
    const screenshotGlobal =
      screenshotBrowser?.browsingContext?.currentWindowGlobal;
    await this.ready;
    const input = this.element("input");
    const text = input.value.trim();
    if ((!text && !screenshot) || this.abortController || this.destroyed) {
      return;
    }
    if (!screenshot && text === "/reset") {
      input.value = "";
      this.clear();
      return;
    }
    const controller = new this.window.AbortController();
    this.abortController = controller;
    this.setBusy(true);
    try {
      if (screenshot) {
        await this.open();
        if (!this.element("settings").hidden) {
          await this.toggleSettings();
        }
      }
      const settings = NativeChatStore.getSettings();
      const key = await NativeChatStore.getKey(settings.endpoint);
      const history = this.isPrivate
        ? this.messages
        : await NativeChatStore.loadHistory();
      if (this.abortController !== controller || this.destroyed) {
        return;
      }
      const messages = [
        ...history,
        { role: "user", content: screenshot ? SCREENSHOT_PROMPT : text },
      ].slice(-MAX_MESSAGES);
      // Validate before committing the message, so setup errors preserve the draft.
      buildRequest(settings, key, messages, null);
      let image = null;
      if (screenshot) {
        this.status("native-chat-capturing");
        if (
          screenshotBrowser.browsingContext?.currentWindowGlobal !==
          screenshotGlobal
        ) {
          throw new Error("native-chat-screenshot-error");
        }
        try {
          image = await capturePage(screenshotBrowser, this.window);
        } catch {
          throw new Error("native-chat-screenshot-error");
        }
        if (this.abortController !== controller || this.destroyed) {
          return;
        }
      } else {
        input.value = "";
      }
      const content = screenshot
        ? await this.document.l10n.formatValue("native-chat-screenshot-sent")
        : text;
      if (this.abortController !== controller || this.destroyed) {
        return;
      }
      this.appendMessage({ role: "user", content });
      this.status("native-chat-working");
      const timeout = this.window.setTimeout(
        () => controller.abort(new Error("native-chat-timeout")),
        120000
      );
      let reply;
      try {
        reply = await requestReply(
          settings,
          key,
          messages,
          controller.signal,
          image,
          { isPrivate: this.isPrivate }
        );
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
    resetOpenCodeSessions({ isPrivate: this.isPrivate });
    this.saveHistory();
    this.element("input").focus();
  }

  destroy() {
    this.destroyed = true;
    this.abortController?.abort();
    this.listeners.abort();
    this.resizeObserver.disconnect();
    this.chromeObserver.disconnect();
    Services.prefs.removeObserver(APPEARANCE_PREF, this);
    if (!this.isPrivate) {
      Services.obs.removeObserver(this, HISTORY_TOPIC);
    }
  }
}
