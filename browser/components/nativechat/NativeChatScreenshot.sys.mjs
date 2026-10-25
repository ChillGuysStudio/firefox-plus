/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const SCREENSHOT_PROMPT = `Answer the question visible in this screenshot. If several questions are visible, answer the most fully visible one, choosing the topmost if tied. For single-choice questions, return only the answer letter, number, or option position. For multiple-choice questions, return each correct letter, number, or position on its own line. For other questions, give the shortest correct answer. If no question is visible, respond with exactly: no question found. Do not describe the screenshot.`;

export async function capturePage(browser, window) {
  const width = browser.clientWidth;
  const height = browser.clientHeight;
  if (!width || !height || !browser.browsingContext?.currentWindowGlobal) {
    throw new Error("native-chat-screenshot-error");
  }
  const scale = Math.min(
    window.devicePixelRatio,
    2048 / Math.max(width, height)
  );
  const snapshot = await browser.drawSnapshot(
    0,
    0,
    width,
    height,
    scale,
    "white",
    true
  );
  if (!snapshot?.width || !snapshot?.height) {
    throw new Error("native-chat-screenshot-error");
  }
  try {
    const canvas = window.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "canvas"
    );
    canvas.width = snapshot.width;
    canvas.height = snapshot.height;
    canvas.getContext("2d").drawImage(snapshot, 0, 0);
    return {
      base64: canvas.toDataURL("image/png").split(",")[1],
      mimeType: "image/png",
    };
  } finally {
    snapshot.close();
  }
}
