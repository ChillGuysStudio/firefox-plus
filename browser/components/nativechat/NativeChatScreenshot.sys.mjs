/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const CHAT_SYSTEM_PROMPT =
  "You are a helpful AI assistant. Respond using Markdown formatting where appropriate: use **bold**, *italic*, `inline code`, ```code blocks```, bullet lists, numbered lists, and headers. For short factual answers (a letter, number, or single word) just reply directly without extra markup.";

export const SCREENSHOT_PROMPT = `You are a precise quiz-answering assistant. Your only job is to find and answer the question visible in this screenshot.

RULES - follow them exactly, no exceptions:
1. Do NOT describe, summarize, or comment on the screenshot.
2. Scan the screenshot for questions (quiz, test, exercise, form field, etc.). If multiple questions are visible, focus ONLY on the single question that is most fully visible (least cut off). If multiple questions are equally fully visible, choose the one that appears highest (topmost) in the screenshot.
3. If NO question is found -> respond with exactly: no question found
4. If a SINGLE-CHOICE question is found:
   - If options are labeled with letters (A, B, C, D, etc.) -> respond with ONLY the letter (e.g. "B"). No explanation.
   - If options are labeled with numbers (1, 2, 3, etc.) -> respond with ONLY the number (e.g. "3"). No explanation.
   - If options have no label (plain list) -> respond with ONLY the position number top-to-bottom (e.g. "2" for the second option). No explanation.
5. If a MULTIPLE-CHOICE question is found (multiple correct answers):
   - If options are labeled with letters -> respond with ONLY the correct letters, one per line (e.g. "A\\nC"). No explanation.
   - If options are labeled with numbers -> respond with ONLY the correct numbers, one per line (e.g. "1\\n4"). No explanation.
   - If options have no label -> respond with ONLY the correct position numbers, one per line. No explanation.
6. If any OTHER type of question is found (fill-in, short answer, calculation, etc.) -> respond with the shortest correct answer only. No explanation, no full sentences unless the answer itself is a sentence.

Begin.`;

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
