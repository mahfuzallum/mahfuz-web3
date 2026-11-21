// GrowX - content/xcmt.js
//
// The x.com side of Comment mode. Like the rest of the content layer it never
// acts on its own: the engine asks for one thing at a time and records what
// comes back.
//
//   read     one post with everything the model needs to write about it:
//            the full text, the author, the quoted post, the post it answers,
//            image descriptions, the link card, the language, and whether you
//            already liked it or already have a reply on it
//   like     the same request X's own heart button sends
//   reply    the same request X's own Reply button sends, through your own
//            signed-in session - no second account, no third-party service
//   watch    the newest post of an account (watch list and target accounts)
//   back     the replies people left on your own posts
//   stats    the likes and views your posted reply has collected
//
// Everything here uses the request plumbing in xapi.js (transaction id, bearer,
// csrf, operation discovery, rate-limit classification), so there is one copy
// of it and one place where X's changes have to be followed.

(function () {
  "use strict";

  const V = chrome.runtime.getManifest().version;
  if (window.__GX_CMT && window.__GX_CMT.v === V) return;

  const API = window.__GX_API;
  const { gqlOp, send, classify, apiError, uid } = API;
  const origin = () => location.origin;

  const str = (x) => (x == null ? "" : String(x));
  const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

  // ---------------------------------------------------------------------
  // Walking X's answers
  // ---------------------------------------------------------------------
  // A tweet arrives either plainly or wrapped in TweetWithVisibilityResults.
  function unwrap(r) {
    let x = r;
    for (let i = 0; i < 6 && x; i++) {
      if (x.__typename === "TweetWithVisibilityResults" && x.tweet) { x = x.tweet; continue; }
      if (x.result) { x = x.result; continue; }
      break;
    }
    return x && (x.legacy || x.rest_id) ? x : null;
  }

  // Every tweet object anywhere in a response, keyed by its id.
  function collectTweets(node, out, depth) {
    out = out || new Map();
    depth = depth || 0;
    if (!node || typeof node !== "object" || depth > 26) return out;
    if (Array.isArray(node)) { for (const v of node) collectTweets(v, out, depth + 1); return out; }
    const t = unwrap(node);
    if (t && t.rest_id && t.legacy && !out.has(String(t.rest_id))) out.set(String(t.rest_id), t);
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (v && typeof v === "object") collectTweets(v, out, depth + 1);
    }
    return out;
  }

  function authorOf(t) {
    const u = t && t.core && t.core.user_results && t.core.user_results.result;
    const legacy = (u && (u.legacy || u.core)) || {};
    const prof = (u && u.legacy) || {};
    return {
      id: str(u && u.rest_id),
      h: str(legacy.screen_name || (u && u.core && u.core.screen_name)),
      n: str(legacy.name || (u && u.core && u.core.name)),
      bio: str(prof.description || "").slice(0, 400),
      followers: num(prof.followers_count),
      v: !!(u && (u.is_blue_verified || (u.verification && u.verification.verified)))
    };
  }

  function fullText(t) {
    const note = t && t.note_tweet && t.note_tweet.note_tweet_results && t.note_tweet.note_tweet_results.result;
    if (note && note.text) return str(note.text);
    const l = (t && t.legacy) || {};
    let txt = str(l.full_text || l.text);
    // X appends the media link and shortens urls: put the real links back and drop the media one.
    const ents = (l.entities && l.entities.urls) || [];
    for (const u of ents) if (u.url && u.expanded_url) txt = txt.split(u.url).join(u.expanded_url);
    const media = ((l.extended_entities && l.extended_entities.media) || (l.entities && l.entities.media) || []);
    for (const m of media) if (m.url) txt = txt.split(m.url).join("");
    return txt.replace(/\s+$/, "");
  }

  function mediaOf(t) {
    const l = (t && t.legacy) || {};
    const list = (l.extended_entities && l.extended_entities.media) || (l.entities && l.entities.media) || [];
    return list.slice(0, 4).map((m) => ({
      type: str(m.type || "photo"),
      url: str(m.media_url_https || ""),
      alt: str(m.ext_alt_text || (m.ext_media_availability && m.ext_media_availability.reason) || "").slice(0, 300)
    })).filter((m) => m.url);
  }

  function cardTitle(t) {
    const bv = t && t.card && t.card.legacy && t.card.legacy.binding_values;
    if (!Array.isArray(bv)) return "";
    const pick = (k) => { const e = bv.find((x) => x && x.key === k); return str(e && e.value && (e.value.string_value || e.value.scribe_key)); };
    return [pick("title"), pick("description")].filter(Boolean).join(" - ").slice(0, 240);
  }

  // Can anyone reply, or has the author limited it?
  function replyLimited(t) {
    if (!t) return false;
    const lar = t.limitedActionResults || (t.tweet && t.tweet.limitedActionResults);
    const acts = (lar && lar.limited_actions) || [];
    if (acts.some((a) => /reply/i.test(str(a && a.action)))) return true;
    const cc = t.legacy && t.legacy.conversation_control;
    if (cc && cc.policy && !/everyone/i.test(str(cc.policy))) return true;
    return false;
  }

  function summarize(t) {
    if (!t) return null;
    const l = t.legacy || {};
    const q = unwrap(t.quoted_status_result) || unwrap(l.quoted_status_result);
    return {
      id: str(t.rest_id),
      text: fullText(t),
      author: authorOf(t),
      at: Date.parse(l.created_at) || 0,
      lang: str(l.lang || ""),
      likes: num(l.favorite_count), replies: num(l.reply_count), reposts: num(l.retweet_count),
      views: num(t.views && t.views.count),
      liked: !!l.favorited, repliedByMe: false,
      media: mediaOf(t),
      card: cardTitle(t),
      limited: replyLimited(t),
      convId: str(l.conversation_id_str || t.rest_id),
      parentId: str(l.in_reply_to_status_id_str || ""),
      parentHandle: str(l.in_reply_to_screen_name || ""),
      isRepost: !!l.retweeted_status_result,
      isReply: !!l.in_reply_to_status_id_str,
      quoted: q ? { id: str(q.rest_id), text: fullText(q), author: authorOf(q) } : null
    };
  }

  // ---------------------------------------------------------------------
  // Read one post
  // ---------------------------------------------------------------------
  async function restShow(id) {
    const p = new URLSearchParams({ id: String(id), tweet_mode: "extended", include_ext_alt_text: "true", include_entities: "true", trim_user: "false" });
    const r = await send("GET", origin() + "/i/api/1.1/statuses/show.json?" + p.toString(), null, "application/json");
    if (!r.res.ok || !r.json || !r.json.id_str) {
      const c = classify(r.res, r.json);
      throw apiError(c.kind === "endpoint" && r.res.status === 404 ? "gone" : c.kind, c.message, c);
    }
    const j = r.json;
    const u = j.user || {};
    return {
      id: str(j.id_str), text: str(j.full_text || j.text), at: Date.parse(j.created_at) || 0, lang: str(j.lang || ""),
      author: { id: str(u.id_str), h: str(u.screen_name), n: str(u.name), bio: str(u.description || "").slice(0, 400), followers: num(u.followers_count), v: !!u.verified },
      likes: num(j.favorite_count), replies: num(j.reply_count), reposts: num(j.retweet_count), views: 0,
      liked: !!j.favorited, repliedByMe: false,
      media: (((j.extended_entities && j.extended_entities.media) || (j.entities && j.entities.media) || []).slice(0, 4)
        .map((m) => ({ type: str(m.type), url: str(m.media_url_https), alt: str(m.ext_alt_text || "").slice(0, 300) }))),
      card: "", limited: false, convId: str(j.id_str), parentId: str(j.in_reply_to_status_id_str || ""),
      parentHandle: str(j.in_reply_to_screen_name || ""), isRepost: !!j.retweeted_status, isReply: !!j.in_reply_to_status_id_str,
      quoted: j.quoted_status ? { id: str(j.quoted_status.id_str), text: str(j.quoted_status.full_text || j.quoted_status.text), author: { h: str(j.quoted_status.user && j.quoted_status.user.screen_name) } } : null,
      via: "rest"
    };
  }

  // The post, the post it answers, and whether you already have a reply under it.
  // "Already replied" is read from X itself, so a reply you wrote by hand or on
  // another device counts too.
  async function readPost(id) {
    id = String(id);
    const me = String(uid() || "");
    let got = null, via = "";
    try {
      got = await gqlOp("TweetDetail", {
        focalTweetId: id, referrer: "tweet", with_rux_injections: false, rankingMode: "Relevance",
        includePromotedContent: false, withCommunity: true, withQuickPromoteEligibilityTweetFields: true,
        withBirdwatchNotes: true, withVoice: true, withV2Timeline: true
      });
      via = "TweetDetail";
    } catch (e) {
      if (["auth", "locked", "suspended", "automation", "rate"].includes(e.kind)) throw e;
      try {
        got = await gqlOp("TweetResultByRestId", { tweetId: id, withCommunity: false, includePromotedContent: false, withVoice: false });
        via = "TweetResultByRestId";
      } catch (e2) {
        if (["auth", "locked", "suspended", "automation", "rate"].includes(e2.kind)) throw e2;
        const out = await restShow(id);
        return { ok: true, post: out, via: "rest" };
      }
    }

    const all = collectTweets(got.json && got.json.data);
    const focal = all.get(id);
    if (!focal) {
      // A 200 with no post means it is gone, protected or taken down.
      const txt = JSON.stringify((got.json && got.json.errors) || []).slice(0, 300);
      if (/NsfwLoggedOut|Protected|not authorized|suspended/i.test(txt)) return { ok: false, kind: "gone", message: "the post is not visible to you" };
      try { const out = await restShow(id); return { ok: true, post: out, via: "rest" }; }
      catch (e) { return { ok: false, kind: e.kind || "gone", message: e.message || "the post could not be read" }; }
    }
    const post = summarize(focal);
    // Any reply of mine anywhere in the conversation that answers this post.
    if (me) for (const [tid, t] of all) {
      if (tid === id) continue;
      const l = t.legacy || {};
      if (String(l.in_reply_to_status_id_str || "") !== id) continue;
      if (String((t.core && t.core.user_results && t.core.user_results.result && t.core.user_results.result.rest_id) || "") === me) { post.repliedByMe = true; post.myReplyId = tid; break; }
    }
    const parent = post.parentId ? all.get(post.parentId) : null;
    if (parent) post.parent = { id: post.parentId, text: fullText(parent), author: authorOf(parent) };
    return { ok: true, post, via };
  }

  // ---------------------------------------------------------------------
  // Like
  // ---------------------------------------------------------------------
  async function likePost(id) {
    try {
      const got = await gqlOp("FavoriteTweet", { tweet_id: String(id) }, { method: "POST" });
      const errs = (got.json && got.json.errors) || [];
      if (errs.length && !errs.some((e) => /already favorited/i.test(str(e.message)))) {
        const c = classify(got.res, got.json);
        return { ok: false, ...c };
      }
      return { ok: true, via: "graphql" };
    } catch (e) {
      if (["auth", "locked", "suspended", "automation", "rate"].includes(e.kind)) return { ok: false, kind: e.kind, message: e.message, waitMs: e.waitMs };
      const p = new URLSearchParams({ id: String(id) });
      const r = await send("POST", origin() + "/i/api/1.1/favorites/create.json", p.toString(), "application/x-www-form-urlencoded");
      const already = ((r.json && r.json.errors) || []).some((x) => x && x.code === 139);
      if (r.res.ok || already) return { ok: true, via: "rest" };
      return { ok: false, ...classify(r.res, r.json) };
    }
  }

  // ---------------------------------------------------------------------
  // Post the reply
  // ---------------------------------------------------------------------
  // The same request X's own Reply button sends, with your own session. The
  // engine has already paused, checked the rules and counted the limits; this
  // only carries the one request out and reports exactly what X answered.
  async function postReply(id, text) {
    const body = String(text || "").trim();
    if (!body) return { ok: false, kind: "gone", message: "empty reply" };
    if (body.length > 280) return { ok: false, kind: "gone", message: "longer than 280 characters" };

    try {
      const got = await gqlOp("CreateTweet", {
        tweet_text: body,
        reply: { in_reply_to_tweet_id: String(id), exclude_reply_user_ids: [] },
        dark_request: false,
        media: { media_entities: [], possibly_sensitive: false },
        semantic_annotation_ids: [],
        disallowed_reply_options: null
      }, { method: "POST" });
      const j = got.json || {};
      const errs = j.errors || [];
      if (errs.length) {
        const c = classify(got.res, j);
        // A duplicate is not a failure: X already has the reply.
        if (errs.some((e) => /duplicate/i.test(str(e.message)))) return { ok: true, duplicate: true, via: "graphql" };
        return { ok: false, ...c };
      }
      const made = j.data && j.data.create_tweet && j.data.create_tweet.tweet_results && j.data.create_tweet.tweet_results.result;
      const newId = str(made && (made.rest_id || (made.tweet && made.tweet.rest_id)));
      if (!newId) return { ok: false, kind: "transient", message: "X did not confirm the reply" };
      return { ok: true, id: newId, via: "graphql" };
    } catch (e) {
      if (["auth", "locked", "suspended", "automation", "rate", "limit"].includes(e.kind)) {
        return { ok: false, kind: e.kind, message: e.message, waitMs: e.waitMs };
      }
      // Fallback: the session-backed v1.1 route, same account, same session.
      const p = new URLSearchParams({ status: body, in_reply_to_status_id: String(id), auto_populate_reply_metadata: "true", tweet_mode: "extended" });
      const r = await send("POST", origin() + "/i/api/1.1/statuses/update.json", p.toString(), "application/x-www-form-urlencoded");
      const j = r.json || {};
      if (r.res.ok && j.id_str) return { ok: true, id: str(j.id_str), via: "rest" };
      if (((j.errors) || []).some((x) => x && x.code === 187)) return { ok: true, duplicate: true, via: "rest" };
      return { ok: false, ...classify(r.res, j) };
    }
  }

  // Did the reply really land? Read the post back and look for it. This is what
  // lets a row be marked Posted only once X itself shows the reply.
  async function confirmReply(postId, replyId) {
    try {
      if (replyId) {
        const got = await gqlOp("TweetResultByRestId", { tweetId: String(replyId), withCommunity: false, includePromotedContent: false, withVoice: false });
        const t = collectTweets(got.json && got.json.data).get(String(replyId));
        if (t) return { ok: true, found: true, stats: { likes: num(t.legacy && t.legacy.favorite_count), views: num(t.views && t.views.count) } };
      }
      const r = await readPost(postId);
      if (r.ok && r.post && r.post.repliedByMe) return { ok: true, found: true, id: r.post.myReplyId || replyId || "" };
      return { ok: true, found: false };
    } catch (e) {
      return { ok: false, kind: e.kind || "transient", message: str(e.message || e) };
    }
  }

  // Likes and views on replies you already posted (refreshed every few hours).
  async function replyStats(ids) {
    const out = {};
    for (const id of (ids || []).slice(0, 20)) {
      try {
        const got = await gqlOp("TweetResultByRestId", { tweetId: String(id), withCommunity: false, includePromotedContent: false, withVoice: false });
        const t = collectTweets(got.json && got.json.data).get(String(id));
        if (t) out[id] = { likes: num(t.legacy && t.legacy.favorite_count), views: num(t.views && t.views.count), replies: num(t.legacy && t.legacy.reply_count) };
      } catch (e) {
        if (["auth", "locked", "suspended", "automation", "rate"].includes(e.kind)) throw e;
      }
    }
    return { ok: true, stats: out };
  }

  // ---------------------------------------------------------------------
  // Where posts come from: an account's own timeline
  // ---------------------------------------------------------------------
  async function userPosts(userId, opts) {
    opts = opts || {};
    const want = opts.withReplies ? "UserTweetsAndReplies" : "UserTweets";
    const me = String(userId);
    let list = [];
    try {
      const got = await gqlOp(want, { userId: me, count: Math.min(40, opts.count || 20), includePromotedContent: false, withCommunity: true, withVoice: true, withQuickPromoteEligibilityTweetFields: false });
      for (const [, t] of collectTweets(got.json && got.json.data)) {
        const s = summarize(t);
        if (!s || s.author.id !== me) continue;
        list.push(s);
      }
    } catch (e) {
      if (["auth", "locked", "suspended", "automation", "rate"].includes(e.kind)) throw e;
      const p = new URLSearchParams({ user_id: me, count: String(Math.min(40, opts.count || 20)), include_rts: "1", exclude_replies: opts.withReplies ? "false" : "true", tweet_mode: "extended" });
      const r = await send("GET", origin() + "/i/api/1.1/statuses/user_timeline.json?" + p.toString(), null, "application/json");
      if (!r.res.ok || !Array.isArray(r.json)) { const c = classify(r.res, r.json); throw apiError(c.kind, c.message, c); }
      list = r.json.map((j) => ({
        id: str(j.id_str), text: str(j.full_text || j.text), at: Date.parse(j.created_at) || 0,
        author: { id: str(j.user && j.user.id_str), h: str(j.user && j.user.screen_name), n: str(j.user && j.user.name), bio: "" },
        likes: num(j.favorite_count), replies: num(j.reply_count), liked: !!j.favorited, media: [], card: "", limited: false,
        isRepost: !!j.retweeted_status, isReply: !!j.in_reply_to_status_id_str, parentId: str(j.in_reply_to_status_id_str || ""),
        convId: str(j.id_str), quoted: null, repliedByMe: false
      }));
    }
    list.sort((a, b) => b.at - a.at);
    return { ok: true, posts: list.slice(0, Math.min(40, opts.count || 20)) };
  }

  // Replies other people left on your own posts (Reply-back).
  async function myMentions(sinceMs) {
    const me = String(uid() || "");
    const p = new URLSearchParams({ count: "50", tweet_mode: "extended", include_entities: "true" });
    const r = await send("GET", origin() + "/i/api/1.1/statuses/mentions_timeline.json?" + p.toString(), null, "application/json");
    if (!r.res.ok || !Array.isArray(r.json)) { const c = classify(r.res, r.json); throw apiError(c.kind, c.message, c); }
    const out = [];
    for (const j of r.json) {
      const at = Date.parse(j.created_at) || 0;
      if (sinceMs && at < sinceMs) continue;
      if (!j.in_reply_to_status_id_str) continue;                      // a mention, not a reply
      if (String(j.in_reply_to_user_id_str || "") !== me) continue;    // a reply to somebody else
      if (String((j.user && j.user.id_str) || "") === me) continue;    // your own answer
      out.push({
        id: str(j.id_str), text: str(j.full_text || j.text), at,
        parentId: str(j.in_reply_to_status_id_str),
        author: { id: str(j.user && j.user.id_str), h: str(j.user && j.user.screen_name), n: str(j.user && j.user.name), bio: str((j.user && j.user.description) || "").slice(0, 300), followers: num(j.user && j.user.followers_count) }
      });
    }
    out.sort((a, b) => b.at - a.at);
    return { ok: true, replies: out };
  }

  window.__GX_CMT = { v: V, readPost, likePost, postReply, confirmReply, replyStats, userPosts, myMentions, _test: { summarize, collectTweets, fullText } };
})();
