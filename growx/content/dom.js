// GrowX - content/dom.js
//
// Fallback for when X rejects the direct follow request: on x.com/<handle>,
// press the profile's own Follow button exactly as a person would, so X's app
// sends its own request. A profile page has exactly one follow control for
// that account (rows under "You might like" are excluded), so this can never
// follow the wrong person. Also detects X's challenge screens, which GrowX
// never clicks through.

(function () {
  "use strict";

  const V = chrome.runtime.getManifest().version;
  if (window.__GX_DOM && window.__GX_DOM.v === V) return;

  const SEL = {
    cell: '[data-testid="UserCell"]',
    primary: '[data-testid="primaryColumn"]',
    emptyState: '[data-testid="empty_state_header_text"]',
    toast: '[data-testid="toast"], [role="alert"]'
  };

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (v) => (window.CSS && CSS.escape) ? CSS.escape(v) : String(v).replace(/["\\]/g, "\\$&");

  function challenge() {
    const p = location.pathname;
    if (/^\/account\/access/i.test(p)) return "locked";
    if (/^\/account\/suspended/i.test(p)) return "suspended";
    if (/^\/i\/flow\/(login|signup)/i.test(p) || /^\/login\/?$/i.test(p)) return "auth";
    if (document.querySelector('iframe[src*="arkoselabs"], iframe[src*="funcaptcha"], #arkose, div[id^="arkose"]')) return "captcha";
    return null;
  }

  function toastKind() {
    for (const n of document.querySelectorAll(SEL.toast)) {
      const s = (n.innerText || "").toLowerCase();
      if (!s) continue;
      if (/automated|spam/.test(s)) return "automation";
      if (/unable to follow more|follow limit/.test(s)) return "limit";
      if (/rate limit|too many|over the limit|try again later/.test(s)) return "rate";
    }
    return null;
  }

  function profileButtons(id) {
    const root = document.querySelector(SEL.primary) || document;
    const notInList = (b) => !b.closest(SEL.cell);
    if (id) {
      return {
        fo: root.querySelector(`[data-testid="${esc(id)}-follow"]`),
        un: root.querySelector(`[data-testid="${esc(id)}-unfollow"]`),
        pend: root.querySelector(`[data-testid="${esc(id)}-cancel"]`)
      };
    }
    return {
      fo: [...root.querySelectorAll('[data-testid$="-follow"]')].find(notInList) || null,
      un: [...root.querySelectorAll('[data-testid$="-unfollow"]')].find(notInList) || null,
      pend: [...root.querySelectorAll('[data-testid$="-cancel"]')].find(notInList) || null
    };
  }

  function pageSaysGone() {
    const el = document.querySelector(SEL.emptyState);
    return !!el && /exist|suspend|unavailable|not found|doesn/.test((el.innerText || "").toLowerCase());
  }

  async function profileFollow(target) {
    const h = String(target.h || "").replace(/^@/, "").toLowerCase();
    const here = (location.pathname.split("/")[1] || "").toLowerCase();
    if (!h || here !== h) return { ok: false, kind: "transient", message: "not on the profile yet" };

    let id = target.id || null;
    let btn = null;
    const until = Date.now() + 22000;
    while (Date.now() < until) {
      const ch = challenge();
      if (ch) return { ok: false, kind: ch === "captcha" ? "locked" : ch, message: "X is showing a " + ch + " screen" };
      const b = profileButtons(id);
      if (b.fo) { btn = b.fo; break; }
      if (b.un) return { ok: false, kind: "gone", message: "already following" };
      if (b.pend) return { ok: false, kind: "gone", message: "follow request already sent" };
      if (pageSaysGone()) return { ok: false, kind: "gone", message: "account unavailable" };
      await wait(350);
    }
    if (!btn) return { ok: false, kind: "transient", message: "the profile did not finish loading" };

    const m = (btn.getAttribute("data-testid") || "").match(/^(.+)-follow$/);
    if (m) id = m[1];

    await wait(400 + Math.random() * 700);
    btn.click();

    const verifyUntil = Date.now() + 9000;
    while (Date.now() < verifyUntil) {
      const b = profileButtons(id);
      if (b.un) return { ok: true, kind: "ok", id, via: "profile" };
      if (b.pend) return { ok: true, kind: "ok", id, pending: true, via: "profile" };
      const t = toastKind();
      if (t) return { ok: false, kind: t, waitMs: t === "automation" ? 6 * 3600000 : t === "limit" ? 4 * 3600000 : 20 * 60000, message: "X says to slow down" };
      await wait(250);
    }
    return { ok: false, kind: toastKind() || "transient", waitMs: 20 * 60000, message: "X did not confirm the follow" };
  }

  window.__GX_DOM = { v: V, challenge, profileFollow };
})();
