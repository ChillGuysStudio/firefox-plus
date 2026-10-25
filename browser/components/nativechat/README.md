# Native floating chat

Firefox Plus includes a small, draggable chat button above the active web page.
The button and chat belong to the browser window. They stay available across
navigations, on internal pages, and in popup windows with the toolbars hidden.
Page scripts, styles, CSP, and extension permissions do not control the chat.
The chat also remains available in browser and DOM fullscreen.

Click the button or press **Alt+C** to open or close chat. **Ctrl+Alt+C**, or
**Command+Option+C** on macOS, is an alternative. **Alt+Shift+C** hides or restores
the whole interface. Either opening shortcut also restores a hidden button.
**Escape** closes chat while it has focus. Drag the button to move it anywhere
inside the page area. Its position persists and stays inside the window when
resized. Resize the chat using its bottom corner.

**Alt+Q** captures the visible page and answers the question in it. There is also
a camera button in the composer. The capture uses Firefox's renderer, works with
page scripts disabled, and excludes the chat and browser controls. Choose a
model that accepts images. The screenshot is sent only for that request and is
never saved in conversation history. A typed draft stays in the composer.

Lost the button? Press **Alt+Shift+R**, or open **Settings > Appearance > Reset
button position**. This restores it to the bottom-right corner, unhides it, and
resets button opacity to 60%. On macOS these shortcuts use the Option key.

**Settings > Appearance** has independent button and chat opacity sliders from
5% to 100%. Changes apply immediately, persist without saving the provider form,
and sync between open browser windows. Defaults are 60% for the button and 95%
for chat. The button becomes fully visible on hover or keyboard focus.

Open **Settings**, choose a provider, and enter the API base URL, model ID, and
API key. Supported APIs are OpenAI, Google AI Studio, Vertex AI Express Mode,
Anthropic, OpenRouter, Grok, custom OpenAI-compatible servers, OpenCode (v1), and
OpenCode v2. The model ID comes from your provider. For OpenCode and OpenCode v2,
the model ID is optional and defaults to the server's configured default model.
A local server or OpenCode may leave the key empty. Remote endpoints require HTTPS;
HTTP is supported for loopback servers (`http://127.0.0.1:4096` for v1, `http://127.0.0.1:49374` for v2).
For OpenCode v2, you can paste an `opencode pair` link directly into either the API base URL
or password field; the browser will automatically redeem the code and store the server URL and token.
Settings save automatically as you make changes.

Press **Enter** to send and **Shift+Enter** for a new line. **Stop** cancels the
current request. **New** or `/reset` clears the conversation, resets provider session state,
and cancels any pending reply. Responses render as selectable plain text, including code and
math notation. The clipboard disguise, DOM quiz autofill, and arbitrary file attachments
are outside this port.

Messages go directly to the configured provider only when sent. The browser
includes a page screenshot only when you use the camera button or Alt+Q. API keys are stored
in Firefox's encrypted password manager, scoped to each API base URL. Requests
omit cookies and referrers and reject redirects. Normal windows share the last
100 messages through `native-chat-history.json` in the Firefox profile. Private
windows start with an empty conversation and never save their messages or button
positions. Closing a private window discards its conversation. Provider settings
and saved credentials belong to the profile.

The UI uses a manual browser chrome popover, Firefox design tokens, and Fluent
strings. Browser-reserved XUL shortcuts work even when web content prevents
keyboard events. No content script, WebExtension, or website allowlist is used.
The browser must still be Firefox Plus; this does not change restrictions imposed
by a separate operating-system kiosk or a dedicated exam application.

Run the checks from the repository root after an artifact build:

```sh
./mach build
./mach xpcshell-test browser/components/nativechat/tests/unit
./mach mochitest --headless browser/components/nativechat/tests/browser
./mach lint -l eslint -l stylelint browser/components/nativechat browser/base/content/native-chat.css
```
