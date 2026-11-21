// GrowX - content/content.js
//
// The x.com side of the extension is a thin executor. All scheduling, pacing
// and state live in the background engine (background.js), which survives
// tab switches, reloads, the popup closing and the worker restarting. The
// engine asks this script to do one small thing at a time - read one page of
// a list, follow one account - and records the result.
//
// This script never acts on its own initiative and never alters x.com's page.

(function () {
  "use strict";

  const VERSION = chrome.runtime.getManifest().version;
  if (window.__GX_CS === VERSION) return;
  window.__GX_CS = VERSION;

  const API = window.__GX_API;
  const DOM = window.__GX_DOM;
  const CMT = window.__GX_CMT;
  const CMTDOM = window.__GX_CMTDOM;

  // While the engine works through this tab it holds a Web Lock, which keeps
  // Chrome from freezing the tab in the background between requests.
  let releaseLock = null;
  function guard(on) {
    if (on && !releaseLock && navigator.locks && navigator.locks.request) {
      navigator.locks.request("growx-engine", { mode: "shared" }, () => new Promise((r) => { releaseLock = r; })).catch(() => {});
    } else if (!on && releaseLock) {
      try { releaseLock(); } catch (_) {}
      releaseLock = null;
    }
  }

  function fail(e) {
    return { ok: false, kind: (e && e.kind) || "transient", message: String((e && e.message) || e), waitMs: e && e.waitMs };
  }

  // The engine says which account the run belongs to: an action is never carried out as a different account
  // (for example after you switched accounts in x.com). The reply carries our uid, so the engine halts the run.
  function otherAccount(msg) {
    const u = API.uid();
    return !!(msg.owner && u && String(u) !== String(msg.owner));
  }
  const REFUSED = () => ({ ok: false, kind: "account", message: "x.com is signed in as a different account." });

  function reply(promise, sendResponse) {
    Promise.resolve()
      .then(() => promise())
      .then((r) => sendResponse({ ...(r || {}), uid: API.uid() }))
      .catch((e) => sendResponse({ ...fail(e), uid: API.uid() }));
    return true;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.gx !== "string" || sender.id !== chrome.runtime.id) return;

    switch (msg.gx) {
      case "ping":
        if (typeof msg.guard === "boolean") guard(msg.guard);
        sendResponse({
          ok: true, v: VERSION, url: location.href, uid: API.uid(),
          hidden: document.hidden, challenge: DOM.challenge(), guarded: !!releaseLock
        });
        return;

      case "whoami":
        return reply(() => API.whoami(!!msg.deep), sendResponse);

      case "resolve":
        return reply(() => API.resolveHandle(msg.handle), sendResponse);

      case "page":
        return reply(() => API.listPage(msg.op || "Followers", msg.userId || API.uid(), msg.cursor || null, msg.count), sendResponse);

      case "follow":
        if (otherAccount(msg)) return reply(async () => REFUSED(), sendResponse);
        return reply(() => API.follow({ id: msg.id, h: msg.h }), sendResponse);

      case "rel":
        return reply(() => API.relationships(msg.ids, msg.prefer), sendResponse);

      case "unfollow":
        if (otherAccount(msg)) return reply(async () => REFUSED(), sendResponse);
        return reply(() => API.unfollow({ id: msg.id }), sendResponse);

      case "uinfo":
        return reply(() => API.usersInfo(msg.ids, { verified: !!msg.verified }), sendResponse);

      case "rposts":
        return reply(() => API.recentPosts(msg.id, Number(msg.since) || 0), sendResponse);

      case "frids":
        return reply(() => API.friendIds(msg.userId || API.uid(), msg.cursor || null), sendResponse);

      case "fids":
        return reply(() => API.followerIds(msg.userId || API.uid(), msg.cursor || null), sendResponse);

      case "profileFollow":
        if (otherAccount(msg)) return reply(async () => REFUSED(), sendResponse);
        return reply(() => DOM.profileFollow({ id: msg.id, h: msg.h }), sendResponse);

      // ---- Comment mode ----------------------------------------------
      case "cmtRead":
        return reply(() => CMT.readPost(msg.id), sendResponse);

      case "cmtLike":
        if (otherAccount(msg)) return reply(async () => REFUSED(), sendResponse);
        return reply(() => CMT.likePost(msg.id), sendResponse);

      case "cmtReply":
        if (otherAccount(msg)) return reply(async () => REFUSED(), sendResponse);
        return reply(() => CMT.postReply(msg.id, msg.text), sendResponse);

      case "cmtReplyPage":
        if (otherAccount(msg)) return reply(async () => REFUSED(), sendResponse);
        return reply(() => CMTDOM.replyOnPage(msg.id, msg.text, msg.waits), sendResponse);

      case "cmtConfirm":
        return reply(() => CMT.confirmReply(msg.id, msg.replyId), sendResponse);

      case "cmtStats":
        return reply(() => CMT.replyStats(msg.ids), sendResponse);

      case "cmtPosts":
        return reply(() => CMT.userPosts(msg.userId || API.uid(), { count: msg.count, withReplies: !!msg.withReplies }), sendResponse);

      case "cmtMentions":
        return reply(() => CMT.myMentions(Number(msg.since) || 0), sendResponse);

      case "health":
        return reply(() => API.health(), sendResponse);

      default:
        return;
    }
  });

  // Tell the engine this tab is ready to take work.
  try {
    chrome.runtime.sendMessage({ gx: "ready", url: location.href, uid: API.uid() }).catch(() => {});
  } catch (_) {}
})();
