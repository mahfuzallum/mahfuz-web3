// GrowX - content/cmtdom.js
//
// The fallback for posting a reply: when X refuses the direct request, GrowX
// does on the post page exactly what a person does - open the reply box, type,
// wait a moment, press Reply - so X's own app sends its own request.
//
// The order and the waiting are deliberate and come from the settings:
//
//   1. the post has loaded          -> wait "before writing" (C2: 3-7 s by default)
//   2. click Reply                  -> the composer opens
//   3. type the reply, like a person, not in one paste
//   4. wait "before posting"        -> C2: 1-3 s by default
//   5. click Reply again            -> the reply is sent
//   6. wait for X to confirm it
//
// Nothing is clicked through: a login wall, a captcha or a locked account stops
// the step and the engine halts the run.

(function () {
  "use strict";

  const V = chrome.runtime.getManifest().version;
  if (window.__GX_CMTDOM && window.__GX_CMTDOM.v === V) return;

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const rnd = (a, b) => a + Math.random() * (b - a);
  const DOM = () => window.__GX_DOM;

  const SEL = {
    box: '[data-testid="tweetTextarea_0"]',
    openReply: '[data-testid="reply"]',
    send: '[data-testid="tweetButtonInline"], [data-testid="tweetButton"]',
    primary: '[data-testid="primaryColumn"]',
    tweet: 'article[data-testid="tweet"]',
    toast: '[data-testid="toast"], [role="alert"]'
  };

  function onPost(id) {
    const m = location.pathname.match(/\/status\/(\d+)/);
    return !!m && (!id || m[1] === String(id));
  }

  function toastKind() {
    for (const n of document.querySelectorAll(SEL.toast)) {
      const s = (n.innerText || "").toLowerCase();
      if (!s) continue;
      if (/automated|spam|suspicious/.test(s)) return "automation";
      if (/rate limit|too many|over the limit|try again later|daily limit/.test(s)) return "rate";
      if (/duplicate|already said/.test(s)) return "duplicate";
      if (/cannot reply|can't reply|not allowed to reply|who can reply/.test(s)) return "limited";
    }
    return null;
  }

  async function until(fn, ms, step) {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() >= end) return null;
      await wait(step || 220);
    }
  }

  // Type into X's composer so React sees every character. A real person does not
  // paste 60 characters in one frame, so the text goes in in small pieces.
  async function typeInto(box, text) {
    box.focus();
    box.click();
    await wait(rnd(120, 300));
    const chunks = [];
    let left = String(text);
    while (left) {
      const n = Math.max(2, Math.min(left.length, Math.round(rnd(3, 9))));
      chunks.push(left.slice(0, n));
      left = left.slice(n);
    }
    for (const c of chunks) {
      const ok = document.execCommand && document.execCommand("insertText", false, c);
      if (!ok) {
        // Older/locked-down builds: fall back to a composition-style input event.
        box.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: c }));
        box.textContent = (box.textContent || "") + c;
        box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: c }));
      }
      await wait(rnd(18, 70));
    }
    await wait(rnd(150, 400));
    return (box.innerText || box.textContent || "").trim();
  }

  function sendButton() {
    const root = document.querySelector(SEL.primary) || document;
    const list = Array.from(root.querySelectorAll(SEL.send));
    return list.find((b) => b.getAttribute("aria-disabled") !== "true") || list[0] || null;
  }

  // `waits` comes from the settings: { open, post } in milliseconds.
  async function replyOnPage(postId, text, waits) {
    waits = waits || {};
    const body = String(text || "").trim();
    if (!body) return { ok: false, kind: "gone", message: "empty reply" };
    if (!onPost(postId)) return { ok: false, kind: "transient", message: "not on the post yet" };

    const ch = DOM() && DOM().challenge();
    if (ch) return { ok: false, kind: ch === "captcha" ? "locked" : ch, message: "X is showing a " + ch + " screen" };

    // 1. the post itself has to be there before anything is clicked
    const art = await until(() => document.querySelector(SEL.tweet), 20000);
    if (!art) return { ok: false, kind: "transient", message: "the post did not finish loading" };

    // 2. read it for a moment, as a person would, then go to the reply box
    await wait(Math.max(400, Number(waits.open) || 0));

    let box = document.querySelector(SEL.box);
    if (!box) {
      const open = document.querySelector(SEL.openReply);
      if (!open) return { ok: false, kind: "limited", message: "this post has no reply box" };
      open.click();                                   // click "Reply": the composer opens
      await wait(rnd(500, 1100));
      box = await until(() => document.querySelector(SEL.box), 9000);
    }
    if (!box) return { ok: false, kind: "transient", message: "the reply box did not open" };

    // 3. type it
    const typed = await typeInto(box, body);
    if (!typed) return { ok: false, kind: "transient", message: "nothing could be typed into the reply box" };

    // 4. the pause before it is sent
    await wait(Math.max(300, Number(waits.post) || 0));

    // 5. press Reply
    const btn = await until(sendButton, 6000);
    if (!btn) return { ok: false, kind: "transient", message: "the Reply button never became available" };
    if (btn.getAttribute("aria-disabled") === "true") return { ok: false, kind: "transient", message: "X kept the Reply button disabled" };
    btn.click();

    // 6. wait for X to say it went
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      const t = toastKind();
      if (t === "duplicate") return { ok: true, duplicate: true, via: "page" };
      if (t) return { ok: false, kind: t === "limited" ? "gone" : t, waitMs: t === "automation" ? 6 * 3600000 : t === "rate" ? 20 * 60000 : 0, message: "X refused the reply" };
      const empty = document.querySelector(SEL.box);
      if (!empty || !(empty.innerText || "").trim()) return { ok: true, via: "page" };
      await wait(300);
    }
    return { ok: false, kind: toastKind() || "transient", message: "X did not confirm the reply" };
  }

  window.__GX_CMTDOM = { v: V, replyOnPage, onPost };
})();
