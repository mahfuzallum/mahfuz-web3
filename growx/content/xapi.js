// GrowX - content/xapi.js
//
// A small client for the same internal endpoints X's own web app calls:
//
//   * Followers / Following lists (REST v1.1 list route first, GraphQL
//     timeline as fallback) - to harvest the newest followers of a source
//     profile, to detect follow-backs, and to verify that follows stick.
//   * REST friendships/create.json - the request X's own Follow button sends
//     (GraphQL CreateFriendship as fallback).
//   * users/show.json - resolve a source handle and read fresh counts.
//
// It runs in the user's own signed-in x.com tab, with the user's own session.
// Nothing is sent anywhere except x.com (and abs.twimg.com for X's own JS).
//
// Everything that X rotates is discovered at runtime instead of hardcoded:
// query ids and the feature-switch list (read from X's JS bundles), feature
// values (from the app shell's __INITIAL_STATE__), GET vs POST, and the
// x-client-transaction-id header (txid.js). GrowX never unfollows anyone -
// unfollowing is done by Unfollow mode in this extension.

(function () {
  "use strict";

  const V = chrome.runtime.getManifest().version;
  if (window.__GX_API && window.__GX_API.v === V) return;

  const TX = () => window.__GX_TXID;

  // X's public web-app bearer. Stable for years; the bundle copy wins if found.
  const WEB_BEARER = "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
  const OPS_KEY = "gx.ops";
  const OPS_TTL_MS = 12 * 60 * 60 * 1000;

  // Known-good feature flags, used when the bundle metadata cannot be read.
  const BASE_FEATURES = {
    articles_preview_enabled: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    communities_web_enable_tweet_community_results_fetch: true,
    content_disclosure_ai_generated_indicator_enabled: true,
    content_disclosure_indicator_enabled: true,
    creator_subscriptions_tweet_preview_api_enabled: true,
    freedom_of_speech_not_reach_fetch_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    hidden_profile_subscriptions_enabled: true,
    highlights_tweets_tab_ui_enabled: true,
    longform_notetweets_consumption_enabled: true,
    longform_notetweets_inline_media_enabled: false,
    longform_notetweets_rich_text_read_enabled: true,
    post_ctas_fetch_enabled: false,
    premium_content_api_read_enabled: false,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    responsive_web_birdwatch_enforce_author_user_quotas: true,
    responsive_web_birdwatch_fast_notes_badge_enabled: false,
    responsive_web_birdwatch_live_note_enabled: true,
    responsive_web_birdwatch_media_notes_enabled: true,
    responsive_web_birdwatch_note_internal_insights_enabled: false,
    responsive_web_birdwatch_note_limit_enabled: true,
    responsive_web_birdwatch_note_request_download_enabled: true,
    responsive_web_birdwatch_note_request_sources_enabled: true,
    responsive_web_birdwatch_signup_prompt_enabled: true,
    responsive_web_birdwatch_top_contributor_enabled: true,
    responsive_web_birdwatch_translation_enabled: true,
    responsive_web_birdwatch_url_notes_enabled: false,
    responsive_web_edit_tweet_api_enabled: true,
    responsive_web_enhance_cards_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_grok_analysis_button_from_backend: true,
    responsive_web_grok_analyze_button_fetch_trends_enabled: false,
    responsive_web_grok_analyze_post_followups_enabled: false,
    responsive_web_grok_annotations_enabled: true,
    responsive_web_grok_community_note_auto_translation_is_enabled: true,
    responsive_web_grok_community_note_translation_is_enabled: true,
    responsive_web_grok_image_annotation_enabled: true,
    responsive_web_grok_imagine_annotation_enabled: true,
    responsive_web_grok_share_attachment_enabled: true,
    responsive_web_grok_show_grok_translated_post: true,
    responsive_web_jetfuel_frame: true,
    responsive_web_profile_redirect_enabled: true,
    responsive_web_twitter_article_notes_tab_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    rweb_cashtags_composer_attachment_enabled: true,
    rweb_cashtags_enabled: true,
    rweb_tipjar_consumption_enabled: false,
    rweb_video_screen_enabled: false,
    spaces_2022_h2_clipping: true,
    spaces_2022_h2_spaces_communities: true,
    standardized_nudges_misinfo: true,
    subscriptions_feature_can_gift_premium: true,
    subscriptions_management_fetch_next_billing_time: true,
    subscriptions_marketing_page_fetch_promotions: true,
    subscriptions_upsells_api_enabled: false,
    subscriptions_verification_info_is_identity_verified_enabled: true,
    subscriptions_verification_info_verified_since_enabled: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    verified_phone_label_enabled: false,
    view_counts_everywhere_api_enabled: true,
    // Legacy flags for older X web bundles.
    payments_enabled: false,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    tweet_awards_web_tipping_enabled: false,
    creator_subscriptions_quote_tweet_preview_enabled: false
  };

  const CURRENT_LIST_FEATURES = [
    "articles_preview_enabled","c9s_tweet_anatomy_moderator_badge_enabled",
    "communities_web_enable_tweet_community_results_fetch","content_disclosure_ai_generated_indicator_enabled",
    "content_disclosure_indicator_enabled","creator_subscriptions_tweet_preview_api_enabled",
    "freedom_of_speech_not_reach_fetch_enabled","graphql_is_translatable_rweb_tweet_is_translatable_enabled",
    "longform_notetweets_consumption_enabled","longform_notetweets_inline_media_enabled",
    "longform_notetweets_rich_text_read_enabled","post_ctas_fetch_enabled","premium_content_api_read_enabled",
    "profile_label_improvements_pcf_label_in_post_enabled","responsive_web_edit_tweet_api_enabled",
    "responsive_web_enhance_cards_enabled","responsive_web_graphql_timeline_navigation_enabled",
    "responsive_web_grok_analysis_button_from_backend","responsive_web_grok_analyze_button_fetch_trends_enabled",
    "responsive_web_grok_analyze_post_followups_enabled","responsive_web_grok_annotations_enabled",
    "responsive_web_grok_community_note_auto_translation_is_enabled",
    "responsive_web_grok_community_note_translation_is_enabled","responsive_web_grok_image_annotation_enabled",
    "responsive_web_grok_imagine_annotation_enabled","responsive_web_grok_share_attachment_enabled",
    "responsive_web_grok_show_grok_translated_post","responsive_web_jetfuel_frame",
    "responsive_web_profile_redirect_enabled","responsive_web_twitter_article_notes_tab_enabled",
    "responsive_web_twitter_article_tweet_consumption_enabled","rweb_cashtags_composer_attachment_enabled",
    "rweb_cashtags_enabled","rweb_tipjar_consumption_enabled","standardized_nudges_misinfo",
    "tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled","view_counts_everywhere_api_enabled"
  ];

  // ---------------------------------------------------------------------
  // Session
  // ---------------------------------------------------------------------
  function cookie(name) {
    const m = document.cookie.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }

  // The signed-in account's numeric id, from the `twid` cookie ("u=123").
  function uid() {
    const raw = cookie("twid");
    const m = raw && String(raw).match(/(\d{2,})/);
    return m ? m[1] : null;
  }

  async function sessionUidFallback() {
    const direct = uid();
    if (direct) return direct;
    try {
      const shell = await TX().shell();
      const st = shell && extractInitialState(shell.html);
      const id = st && st.session && st.session.user_id;
      if (id) return String(id);
    } catch (_) {}
    return null;
  }

  const csrf = () => cookie("ct0") || "";
  const lang = () => (document.documentElement.getAttribute("lang") || navigator.language || "en").slice(0, 5);

  // ---------------------------------------------------------------------
  // Errors carry a `kind` the engine understands:
  //   rate      - X asked us to slow down; waitMs says how long
  //   auth      - signed out / session expired
  //   locked    - account temporarily locked by X
  //   suspended - account suspended
  //   gone      - the target account no longer exists / not followed
  //   endpoint  - X rejected the request shape (header, method, query id)
  //   transient - network or 5xx; try again later
  // ---------------------------------------------------------------------
  function apiError(kind, message, extra) {
    const e = new Error(message || kind);
    e.kind = kind;
    Object.assign(e, extra || {});
    return e;
  }

  function rateWait(res, fallbackMs) {
    const reset = Number(res && res.headers && res.headers.get("x-rate-limit-reset")) * 1000;
    if (reset && reset > Date.now()) return Math.min(reset - Date.now() + 5000, 3 * 60 * 60000);
    return fallbackMs;
  }

  function classify(res, json) {
    const status = res.status;
    const errors = (json && Array.isArray(json.errors)) ? json.errors : [];
    const codes = errors.map((e) => Number(e.code)).filter((c) => !Number.isNaN(c));
    const msg = (errors.map((e) => e.message).filter(Boolean).join("; ") || (json && typeof json.error === "string" ? json.error : "")).slice(0, 300);

    // "This request looks like it might be automated" - the strongest warning X gives.
    if (codes.includes(226)) return { kind: "automation", status, waitMs: 6 * 3600000, message: msg || "X flagged the activity as automated" };
    if (status === 429 || codes.includes(88)) {
      return { kind: "rate", status, waitMs: rateWait(res, 15 * 60000), message: msg || "rate limited" };
    }
    // Daily follow limit reached.
    if (codes.includes(161) || codes.includes(344)) return { kind: "limit", status, waitMs: 4 * 3600000, message: msg || "You are unable to follow more people at this time." };
    if (codes.includes(326) || codes.includes(231)) return { kind: "locked", status, message: msg || "account locked" };
    if (codes.includes(64)) return { kind: "suspended", status, message: msg || "account suspended" };
    if (codes.some((c) => c === 32 || c === 89 || c === 215 || c === 239)) return { kind: "auth", status, message: msg || "not signed in" };
    if (codes.includes(353)) return { kind: "auth", status, message: "session token mismatch - reload x.com" };
    if (codes.includes(160)) return { kind: "gone", status, pending: true, message: msg || "follow request already sent" };
    if (codes.includes(162)) return { kind: "gone", status, message: msg || "blocked from following this account" };
    if (codes.includes(158)) return { kind: "gone", status, message: "that is your own account" };
    if (codes.some((c) => c === 34 || c === 50 || c === 63 || c === 108)) {
      return { kind: "gone", status, message: msg || "account not found" };
    }
    if (codes.some((c) => c === 130 || c === 131)) return { kind: "transient", status, message: msg || "X is over capacity" };
    if (status === 401) return { kind: "auth", status, message: msg || "not signed in" };
    if (/limit/i.test(msg)) return { kind: "rate", status, waitMs: rateWait(res, 30 * 60000), message: msg };
    if (status >= 500) return { kind: "transient", status, message: msg || "X server error " + status };
    if (status === 404 || status === 405 || status === 403 || status === 400) {
      return { kind: "endpoint", status, message: msg || "X rejected the request (" + status + ")" };
    }
    return { kind: "transient", status, message: msg || "HTTP " + status };
  }

  async function readJson(res) {
    const text = await res.text().catch(() => "");
    if (!text) return null;
    try { return JSON.parse(text); } catch (_) { return null; }
  }

  // ---------------------------------------------------------------------
  // Bundle discovery: bearer, query ids, feature switches
  // ---------------------------------------------------------------------
  let ops = null;          // { at, bearer, ops: {Name: {id, type, features, toggles}}, methods: {Name: "GET"|"POST"} }
  let featureValues = {};  // name -> boolean, from __INITIAL_STATE__
  // The session-backed v1.1 list route returns larger pages (200 users, with
  // each user's latest post) than the GraphQL timeline. Remember which family
  // worked last; cursors are tagged "R:" / "G:" so a list is never continued
  // with the other family's cursor.
  const listModes = { Followers: null, Following: null };

  async function fetchCrossOrigin(url) {
    try {
      const res = await chrome.runtime.sendMessage({ x7: "fetchText", url });
      if (res && res.ok) return res.text;
    } catch (_) {}
    const r = await fetch(url, { credentials: "omit" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.text();
  }

  function listOf(str) {
    if (!str) return [];
    return str.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  }

  // Find an operation's metadata in a bundle. Minified bundles contain
  //   {queryId:"abc",operationName:"Following",operationType:"query",
  //    metadata:{featureSwitches:[...],fieldToggles:[...]}}
  // but the key order has changed before, so search around the name.
  function findOp(text, name) {
    if (!text) return null;
    // Current X bundles often keep queryId/operationName/operationType in a
    // compact metadata object. Match the exact operation before using the
    // legacy nearby-string fallback.
    const exact = new RegExp(
      "queryId\\s*:\\s*[\"']([A-Za-z0-9_-]{8,})[\"'][^{}]{0,260}" +
      "operationName\\s*:\\s*[\"']" + name + "[\"'][^{}]{0,1400}" +
      "operationType\\s*:\\s*[\"'](query|mutation)[\"']"
    );
    const m = exact.exec(text);
    if (m) {
      const scope = text.slice(m.index, Math.min(text.length, m.index + m[0].length + 6000));
      const fs = scope.match(/featureSwitches\s*:\s*\[([^\]]*)\]/);
      const ft = scope.match(/fieldToggles\s*:\s*\[([^\]]*)\]/);
      return { id: m[1], type: m[2], features: listOf(fs && fs[1]), toggles: listOf(ft && ft[1]) };
    }
    const marker = 'operationName:"' + name + '"';
    let at = text.indexOf(marker);
    while (at !== -1) {
      const before = text.slice(Math.max(0, at - 500), at);
      const after = text.slice(at, at + 10000);
      let id = null;
      const qb = before.match(/queryId\s*:\s*["']([A-Za-z0-9_-]{8,})["'][^{}]*$/);
      if (qb) id = qb[1];
      if (!id) {
        const qa = after.match(/queryId\s*:\s*["']([A-Za-z0-9_-]{8,})["']/);
        if (qa) id = qa[1];
      }
      if (id) {
        const next = after.indexOf('operationName:', marker.length);
        const scope = next > 0 ? after.slice(0, next) : after;
        const fs = scope.match(/featureSwitches\s*:\s*\[([^\]]*)\]/);
        const ft = scope.match(/fieldToggles\s*:\s*\[([^\]]*)\]/);
        const ot = scope.match(/operationType\s*:\s*["'](\w+)["']/);
        return { id, type: ot ? ot[1] : "query", features: listOf(fs && fs[1]), toggles: listOf(ft && ft[1]) };
      }
      at = text.indexOf(marker, at + marker.length);
    }
    return null;
  }

  function extractInitialState(text) {
    const at = text.indexOf("__INITIAL_STATE__");
    if (at < 0) return null;
    const start = text.indexOf("{", at);
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let j = start; j < text.length; j++) {
      const c = text.charCodeAt(j);
      if (inStr) {
        if (esc) esc = false;
        else if (c === 92) esc = true;           // backslash
        else if (c === 34) inStr = false;        // quote
        continue;
      }
      if (c === 34) inStr = true;
      else if (c === 123) depth++;
      else if (c === 125) {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(text.slice(start, j + 1)); } catch (_) { return null; }
        }
      }
    }
    return null;
  }

  function featureValuesFrom(state) {
    const out = {};
    const fsw = state && state.featureSwitch;
    if (!fsw) return out;
    const take = (cfg) => {
      if (!cfg) return;
      for (const [k, v] of Object.entries(cfg)) {
        if (v && typeof v === "object" && "value" in v && typeof v.value === "boolean") out[k] = v.value;
        else if (typeof v === "boolean") out[k] = v;
      }
    };
    take(fsw.defaultConfig);
    take(fsw.user && fsw.user.config);
    take(fsw.config);
    return out;
  }

  function bundleUrlsFrom(doc) {
    const urls = [];
    if (!doc) return urls;
    doc.querySelectorAll("script[src], link[rel='preload'][href], link[rel='modulepreload'][href]").forEach((el) => {
      const raw = el.getAttribute("src") || el.getAttribute("href") || "";
      if (!/\.js(\?|$)/.test(raw)) return;
      let u;
      try { u = new URL(raw, location.origin).href; } catch (_) { return; }
      if (/abs\.twimg\.com|\/responsive-web\/|client-web|x-web/.test(u) && !urls.includes(u)) urls.push(u);
    });
    // main.* first: it carries the GraphQL operation table.
    return urls.sort((a, b) => (/\/main\./.test(b) ? 1 : 0) - (/\/main\./.test(a) ? 1 : 0));
  }

  const KNOWN_OPS = ["Following", "Followers"];

  async function discover(force, wanted) {
    const need = wanted || KNOWN_OPS;
    if (!force && ops && Date.now() - ops.at < OPS_TTL_MS && need.every((n) => ops.ops[n])) return ops;
    if (!force && !ops) {
      try {
        const c = (await chrome.storage.local.get(OPS_KEY))[OPS_KEY];
        if (c && Date.now() - c.at < OPS_TTL_MS && need.every((n) => c.ops && c.ops[n])) {
          ops = c;
          featureValues = c.featureValues || {};
          return ops;
        }
      } catch (_) {}
    }

    const found = { at: Date.now(), bearer: null, ops: {}, methods: (ops && ops.methods) || {}, learned: (ops && ops.learned) || {}, featureValues: {} };
    const look = [...new Set([...need, ...KNOWN_OPS])];
    const shell = await TX().shell(force ? 0 : undefined).catch(() => null);
    if (shell) {
      const st = extractInitialState(shell.html);
      found.featureValues = featureValuesFrom(st);
      found.viewer = viewerFrom(st);
    }

    const urls = [...new Set([...bundleUrlsFrom(document), ...bundleUrlsFrom(shell && shell.doc)])];
    for (const url of urls.slice(0, 14)) {
      if (look.every((n) => found.ops[n]) && found.bearer) break;
      let text;
      try { text = await fetchCrossOrigin(url); } catch (_) { continue; }
      if (!found.bearer) {
        const b = text.match(/"(AAAAAAAAAAAAAAAAAAAAA[A-Za-z0-9%_-]{40,})"/);
        if (b) found.bearer = "Bearer " + b[1];
      }
      for (const n of look) if (!found.ops[n]) {
        const op = findOp(text, n);
        if (op) found.ops[n] = op;
      }
    }

    // Keep anything found earlier that this pass did not see again.
    if (ops && ops.ops) for (const [n, op] of Object.entries(ops.ops)) if (!found.ops[n]) found.ops[n] = op;

    // Current web-app fallback IDs observed in the live Followers/Following
    // operations. Discovery still wins, but a cached/stale bundle must not
    // make the initial database scan fail simply because the operation entry
    // was split into another web chunk.
    const knownListOps = {
      Followers: { id: "JNyQdTISpzCkj_1fqxDvFg", type: "query", features: CURRENT_LIST_FEATURES.slice(), toggles: [] },
      Following: { id: "qGZZDF3mp91q7X22s3HxpA", type: "query", features: CURRENT_LIST_FEATURES.slice(), toggles: [] }
    };
    const knownWriteOps = {
      CreateFriendship: { id: "8h9JVdV8dlSyqyRDJEPCsA", type: "mutation", features: [], toggles: [] }
    };
    for (const n of KNOWN_OPS) if (!found.ops[n] && knownListOps[n]) found.ops[n] = knownListOps[n];
    for (const n of Object.keys(knownWriteOps)) if (!found.ops[n] && knownWriteOps[n]) found.ops[n] = knownWriteOps[n];

    const missing = need.filter((n) => !found.ops[n]);
    if (missing.length) {
      throw apiError("endpoint", "Could not find X's " + missing.join(" / ") + " query in its app code.");
    }
    if (!found.bearer && ops && ops.bearer) found.bearer = ops.bearer;
    ops = found;
    featureValues = found.featureValues || {};
    try { await chrome.storage.local.set({ [OPS_KEY]: ops }); } catch (_) {}
    return ops;
  }

  const bearer = () => (ops && ops.bearer) || WEB_BEARER;

  // X validates the Followers/Following GraphQL feature set separately from
  // the generic web GraphQL baseline. A cached operation table can therefore
  // contain a valid query id but still return an empty/404 response if it is
  // paired with the wrong feature set. Keep this current browser-shaped set
  // as a fallback candidate instead of permanently hard-coding one query id.
  function followersFeatures() {
    const out = {};
    for (const n of CURRENT_LIST_FEATURES) out[n] = n in featureValues ? featureValues[n] : (n in BASE_FEATURES ? BASE_FEATURES[n] : false);
    return out;
  }

  function buildFeatures(op, extra, forced) {
    const out = {};
    const names = forced ? Object.keys(forced) : (op.features && op.features.length ? op.features : Object.keys(BASE_FEATURES));
    for (const n of names) {
      if (forced && n in forced) out[n] = forced[n];
      else out[n] = n in featureValues ? featureValues[n] : (n in BASE_FEATURES ? BASE_FEATURES[n] : false);
    }
    return Object.assign(out, extra || {});
  }

  function buildToggles(op) {
    const out = {};
    for (const n of op.toggles || []) out[n] = n in featureValues ? featureValues[n] : false;
    return out;
  }

  // ---------------------------------------------------------------------
  // Request plumbing
  // ---------------------------------------------------------------------
  let lastTxError = null;

  async function headers(method, url, extra) {
    const h = {
      authorization: bearer(),
      "x-csrf-token": csrf(),
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-active-user": "yes",
      "x-twitter-client-language": lang()
    };
    try {
      h["x-client-transaction-id"] = await TX().generate(method, new URL(url).pathname);
      lastTxError = null;
    } catch (e) {
      // Some endpoints still work without it; the caller sees the 404 if not.
      lastTxError = String(e && e.message || e);
    }
    return Object.assign(h, extra || {});
  }

  async function send(method, url, body, contentType) {
    const hdr = await headers(method, url, contentType ? { "content-type": contentType } : null);
    let res;
    try {
      res = await fetch(url, { method, credentials: "include", headers: hdr, body: body || undefined, cache: "no-store" });
    } catch (e) {
      throw apiError("transient", "Network error talking to X.");
    }
    const json = await readJson(res);
    return { res, json };
  }

  // One GraphQL read with self-healing: method switch, fresh transaction
  // material, fresh query ids and learned feature flags, in that order.
  async function gql(name, variables, forceListFeatures = false) {
    await discover(false, [name]);
    // Flags X demanded on an earlier call are sent from the start.
    let extraFeatures = Object.assign({}, (ops.learned && ops.learned[name]) || {});
    let refreshedTx = false, rediscovered = false;

    for (let round = 0; round < 8; round++) {
      const op = ops.ops[name];
      if (!op) throw apiError("endpoint", "X's " + name + " query is unavailable.");
      const fieldToggles = buildToggles(op);
      // X migrated Followers/Following to POST. Prefer POST on a fresh
      // install instead of deliberately making a failing GET before every
      // page. If POST is rejected, the legacy GET path remains as fallback.
      const preferred = ops.methods[name] || (name === "Followers" ? "POST" : (name === "Following" ? "POST" : "GET"));
      const order = preferred === "POST" ? ["POST", "GET"] : ["GET", "POST"];

      // The Followers/Following operations have historically been sensitive
      // to their feature-set shape. Try the operation-discovered features
      // first, then the browser-captured list feature set before refreshing
      // the query id/session. This avoids treating a valid 200 response with
      // an empty parsed page as a completed scan.
      const featureCandidates = (name === "Following" || name === "Followers")
        ? (forceListFeatures
          ? [buildFeatures(op, extraFeatures, followersFeatures()), buildFeatures(op, extraFeatures)]
          : [buildFeatures(op, extraFeatures), buildFeatures(op, extraFeatures, followersFeatures())])
        : [buildFeatures(op, extraFeatures)];

      let last = null;
      let emptySuccess = null;
      for (const features of featureCandidates) {
        for (const method of order) {
          const base = location.origin + "/i/api/graphql/" + op.id + "/" + name;
        let r;
        if (method === "GET") {
          const qs = "?variables=" + encodeURIComponent(JSON.stringify(variables)) +
            "&features=" + encodeURIComponent(JSON.stringify(features)) +
            (Object.keys(fieldToggles).length ? "&fieldToggles=" + encodeURIComponent(JSON.stringify(fieldToggles)) : "");
          r = await send("GET", base + qs, null, "application/json");
        } else {
          r = await send("POST", base, JSON.stringify({
            variables,
            features,
            queryId: op.id,
            ...(Object.keys(fieldToggles).length ? { fieldToggles } : {})
          }), "application/json");
        }
        last = r;
        if (r.res.ok && r.json && r.json.data) {
          // A successful HTTP 200 is not enough for Followers/Following.
          // X can return a valid data envelope with the wrong feature set or
          // method and an empty timeline. Keep probing the remaining
          // method/feature candidates before accepting an empty page.
          if (name === "Followers" || name === "Following") {
            let probe = { users: [], cursor: null };
            try { probe = parsePage(r.json); } catch (_) {}
            if (!probe.users.length) {
              // Keep the first successful empty response as a last resort,
              // but do not return yet. Another candidate may contain the list.
              if (!emptySuccess) emptySuccess = r;
              continue;
            }
          }
          if (ops.methods[name] !== method) {
            ops.methods[name] = method;
            try { await chrome.storage.local.set({ [OPS_KEY]: ops }); } catch (_) {}
          }
          return { json: r.json, res: r.res };
        }
        const errText = ((r.json && r.json.errors) || []).map((e) => e.message).join("; ");
        const missing = errText.match(/features cannot be null:?\s*([A-Za-z0-9_,\s]+)/i);
        if (missing) break;                               // handled below
        const cls = classify(r.res, r.json);
        if (cls.kind !== "endpoint") throw apiError(cls.kind, cls.message, cls);
          // endpoint -> try the other method
        }
        // Try the alternate feature set before forcing rediscovery.
      }

      // All list candidates returned HTTP 200 but no users. Return the
      // successful empty envelope only after every method/feature candidate
      // has been exhausted. listPage() has an internal REST fallback.
      if (emptySuccess) return { json: emptySuccess.json, res: emptySuccess.res };

      const errText = ((last.json && last.json.errors) || []).map((e) => e.message).join("; ");
      const missing = errText.match(/features cannot be null:?\s*([A-Za-z0-9_,\s]+)/i);
      if (missing) {
        for (const f of listOf(missing[1])) extraFeatures[f] = f in featureValues ? featureValues[f] : false;
        ops.learned = ops.learned || {};
        ops.learned[name] = Object.assign({}, extraFeatures);
        try { await chrome.storage.local.set({ [OPS_KEY]: ops }); } catch (_) {}
        continue;
      }
      if (!refreshedTx) {
        refreshedTx = true;
        await TX().invalidate();
        try { await TX().init(true); } catch (_) {}
        continue;
      }
      if (!rediscovered) {
        rediscovered = true;
        await discover(true, [name]);
        continue;
      }
      const cls = classify(last.res, last.json);
      throw apiError("endpoint", cls.message || "X rejected the " + name + " request.", { status: last.res.status, txError: lastTxError });
    }
    throw apiError("endpoint", "X kept rejecting the " + name + " request.");
  }

  // ---------------------------------------------------------------------
  // Timeline parsing
  // ---------------------------------------------------------------------
  // X can return several sibling instruction arrays in one response (for
  // example the real user timeline plus a small sidebar/module). Picking the
  // first array is unreliable and was the main cause of tiny ~10-user pages
  // and empty target scans. Pick the instruction set with the largest number
  // of timeline entries, matching the current open-source X parsers.
  function findInstructions(node, depth = 0) {
    if (!node || typeof node !== "object" || depth > 24) return null;
    let best = null, bestScore = -1;
    const score = (arr) => {
      if (!Array.isArray(arr)) return -1;
      let n = 0;
      for (const i of arr) {
        if (!i || typeof i !== "object") continue;
        if (Array.isArray(i.entries)) n += i.entries.length;
        if (i.entry) n += 1;
        if (Array.isArray(i.moduleItems)) n += i.moduleItems.length;
      }
      return n;
    };
    const walk = (v, d) => {
      if (!v || typeof v !== "object" || d > 24) return;
      if (Array.isArray(v.instructions)) {
        const n = score(v.instructions);
        if (n > bestScore) { bestScore = n; best = v.instructions; }
      }
      if (Array.isArray(v)) {
        for (const x of v) walk(x, d + 1);
      } else {
        for (const k of Object.keys(v)) walk(v[k], d + 1);
      }
    };
    walk(node, depth);
    return best;
  }

  function entriesOf(json) {
    const result = json && json.data && json.data.user && json.data.user.result;
    const typedCandidates = [
      result && result.timeline && result.timeline.timeline && result.timeline.timeline.instructions,
      result && result.timeline_v2 && result.timeline_v2.timeline && result.timeline_v2.timeline.instructions,
      result && result.timelineV2 && result.timelineV2.timeline && result.timelineV2.timeline.instructions
    ];
    const ins = typedCandidates.find(x => Array.isArray(x) && x.length) || findInstructions(json && json.data, 0) || [];
    const out = [];
    const addEntry = (e) => {
      if (!e || typeof e !== "object") return;
      out.push(e);
      if (Array.isArray(e.items)) for (const x of e.items) addEntry(x);
      if (e.item && typeof e.item === "object") addEntry({ entryId: e.entryId, content: e.item });
    };
    for (const i of ins) {
      if (Array.isArray(i.entries)) for (const e of i.entries) addEntry(e);
      if (i.entry) addEntry(i.entry);
      if (Array.isArray(i.moduleItems)) {
        for (const m of i.moduleItems) addEntry({ entryId: m.entryId, content: m.item || m });
      }
    }
    return out;
  }

  function userResultFromNode(node, depth = 0) {
    if (!node || typeof node !== "object" || depth > 16) return null;
    if (node.user_results && node.user_results.result) return node.user_results.result;
    if (node.user_result && node.user_result.result) return node.user_result.result;
    if (node.core && node.core.user_results && node.core.user_results.result) return node.core.user_results.result;
    if (node.user && node.user.result) return node.user.result;
    if (node.result && typeof node.result === "object" && (node.result.rest_id || node.result.legacy || node.result.core)) return node.result;
    for (const key of ["itemContent", "item", "content", "userContent", "userResult"]) {
      if (node[key]) { const r = userResultFromNode(node[key], depth + 1); if (r) return r; }
    }
    if (Array.isArray(node.items)) {
      for (const x of node.items) { const r = userResultFromNode(x, depth + 1); if (r) return r; }
    }
    return null;
  }

  // A verification badge of any colour: blue (paid or old), gold (business) or grey (government). Only these known words count;
  // anything else ("None", "", {}, "Unknown"...) is NOT a badge - with "verified only" on, a wrong "yes" would follow back a wrong account.
  const vType = (t) => t === true || (typeof t === "string" && /^(blue|business|government|gold|grey|gray)$/i.test(t.trim()));
  function verifiedOf(result) {
    const lg = (result && result.legacy) || {};
    const ver = result && result.verification;
    return !!(result && (result.is_blue_verified || (ver && (ver.verified || vType(ver.verified_type))) || lg.verified || vType(lg.verified_type)));
  }

  function parseUser(result) {
    if (!result || typeof result !== "object") return null;
    if (result.__typename === "UserUnavailable") return null;
    if (result.user && !result.rest_id) result = result.user;
    const legacy = result.legacy || {};
    const core = result.core || {};
    const id = result.rest_id || legacy.id_str;
    const handle = core.screen_name || legacy.screen_name;
    if (!id || !handle) return null;
    const relObj = result.relationship_perspectives;
    const rel = relObj || {};
    const legacyHasRel = "following" in legacy || "followed_by" in legacy;
    const tri = (a, b) => {
      if (a !== undefined && a !== null) return !!a;
      if (b !== undefined && b !== null) return !!b;
      return (relObj && typeof relObj === "object") || legacyHasRel ? false : null;
    };
    const avatar = (result.avatar && result.avatar.image_url) || legacy.profile_image_url_https || "";
    const created = core.created_at || legacy.created_at;
    const bio = (result.profile_bio && result.profile_bio.description) || legacy.description || "";
    const prot = result.privacy && result.privacy.protected !== undefined ? result.privacy.protected : legacy.protected;
    return {
      i: String(id), h: String(handle), n: String(core.name || legacy.name || ""), a: String(avatar),
      fy: tri(rel.followed_by, legacy.followed_by), fw: tri(rel.following, legacy.following),
      v: verifiedOf(result),
      p: !!prot, fc: typeof legacy.followers_count === "number" ? legacy.followers_count : null,
      fr: typeof legacy.friends_count === "number" ? legacy.friends_count : null,
      sc: typeof legacy.statuses_count === "number" ? legacy.statuses_count : null,
      ca: created ? (Date.parse(created) || null) : null,
      d: !!legacy.default_profile_image || /default_profile_images/.test(avatar),
      b: String(bio).replace(/\s+/g, " ").slice(0, 220),
      loc: String((result.location && result.location.location) || legacy.location || "").slice(0, 80),
      lt: legacy.status && legacy.status.created_at ? (Date.parse(legacy.status.created_at) || null) : null
    };
  }

  function findBottomCursorAnywhere(node, depth = 0) {
    if (!node || typeof node !== "object" || depth > 28) return null;
    let found = null;
    const visit = (v, d) => {
      if (found || !v || typeof v !== "object" || d > 28) return;
      if (typeof v.cursorType === "string" && /^(Bottom|ShowMore)$/i.test(v.cursorType) && typeof v.value === "string" && v.value) {
        found = v.value; return;
      }
      if (typeof v.entryId === "string" && /cursor-bottom/i.test(v.entryId) && typeof v.value === "string" && v.value) {
        found = v.value; return;
      }
      if (Array.isArray(v)) { for (const x of v) visit(x, d + 1); }
      else { for (const k of Object.keys(v)) visit(v[k], d + 1); }
    };
    visit(node, depth);
    return found;
  }

  function parsePage(json) {
    const users = [];
    let cursor = null;
    for (const e of entriesOf(json)) {
      const eid = String(e.entryId || "");
      const c = e.content || e.item || e;
      const cc = c && c.itemContent || {};
      const cursorNode = c && c.cursorType ? c : (cc.cursorType ? cc : null);
      if (/cursor-bottom|cursor-showmore/i.test(eid) || (cursorNode && /^(Bottom|ShowMore)$/i.test(String(cursorNode.cursorType || "")))) {
        cursor = (cursorNode && (cursorNode.value || (cursorNode.itemContent && cursorNode.itemContent.value))) || (c && c.value) || cursor;
        continue;
      }
      const u = parseUser(userResultFromNode(c));
      if (u) users.push(u);
      // Some migrated list responses put the actual TimelineUser payload one
      // level deeper under itemContent/items. The recursive user extractor
      // above handles it without requiring a specific wrapper name.
    }
    const deduped = []; const seen = new Set();
    for (const u of users) if (!seen.has(u.i)) { seen.add(u.i); deduped.push(u); }
    if (!cursor) cursor = findBottomCursorAnywhere(json);
    return { users: deduped, cursor };
  }

  function parseRestUser(x) {
    if (!x || typeof x !== "object") return null;
    const id = x.id_str || x.id;
    const h = x.screen_name || x.username;
    if (!id || !h) return null;
    const avatar = String(x.profile_image_url_https || x.profile_image_url || "");
    return {
      i: String(id), h: String(h), n: String(x.name || ""), a: avatar,
      fy: x.followed_by !== undefined ? !!x.followed_by : null,
      fw: x.following !== undefined ? !!x.following : null,
      v: !!(x.verified || x.is_blue_verified || x.ext_is_blue_verified || vType(x.verified_type) || vType(x.ext_verified_type)), p: !!x.protected,
      fc: typeof x.followers_count === "number" ? x.followers_count : null,
      fr: typeof x.friends_count === "number" ? x.friends_count : null,
      sc: typeof x.statuses_count === "number" ? x.statuses_count : null,
      ca: x.created_at ? (Date.parse(x.created_at) || null) : null,
      d: !!x.default_profile_image || /default_profile_images/.test(avatar),
      b: String(x.description || "").replace(/\s+/g, " ").slice(0, 220),
      loc: String(x.location || "").slice(0, 80),
      lt: x.status && x.status.created_at ? (Date.parse(x.status.created_at) || null) : null
    };
  }

  function rateInfo(res) {
    if (!res || !res.headers) return { remaining: null, resetAt: null };
    const remaining = Number(res.headers.get("x-rate-limit-remaining"));
    const reset = Number(res.headers.get("x-rate-limit-reset")) * 1000;
    return { remaining: Number.isFinite(remaining) && res.headers.get("x-rate-limit-remaining") !== null ? remaining : null, resetAt: Number.isFinite(reset) && reset ? reset : null };
  }

  // Reading someone else's list can be refused because the account is
  // private - that is about the source, never about your own session.
  function listError(r, userId, label) {
    const cls = classify(r.res, r.json);
    const other = String(userId) !== String(uid());
    if (other && (r.res.status === 401 || r.res.status === 403) && !["rate", "automation", "locked", "suspended"].includes(cls.kind)) {
      const hard = ((r.json && r.json.errors) || []).some((e) => [32, 89, 215, 239, 353].includes(Number(e.code)));
      if (!hard) return apiError("private", "X does not show this account's " + label + " (private or restricted).", { status: r.res.status });
    }
    return apiError(cls.kind, cls.message || label + " request failed.", cls);
  }

  async function restPage(name, userId, cursor, count) {
    const endpoint = name === "Followers" ? "followers/list.json" : "friends/list.json";
    const p = new URLSearchParams({
      user_id: String(userId),
      count: String(Math.min(Number(count) || 200, 200)),
      include_user_entities: "false",
      // The latest post is what tells us whether an account is active.
      skip_status: name === "Followers" ? "false" : "true",
      include_ext_is_blue_verified: "true",
      include_ext_verified_type: "true"
    });
    if (cursor) p.set("cursor", String(cursor));
    const r = await send("GET", location.origin + "/i/api/1.1/" + endpoint + "?" + p.toString(), null, "application/json");
    if (!r.res.ok || !r.json || !Array.isArray(r.json.users)) throw listError(r, userId, name.toLowerCase());
    const users = [], seen = new Set();
    for (const raw of r.json.users) {
      const u = parseRestUser(raw);
      if (u && !seen.has(u.i)) { seen.add(u.i); users.push(u); }
    }
    const next = String(r.json.next_cursor_str ?? r.json.next_cursor ?? "");
    const end = !next || next === "0" || next === String(cursor || "");
    return { ok: true, users, cursor: end ? null : "R:" + next, end, source: "rest", rate: rateInfo(r.res) };
  }

  async function gqlPage(name, userId, cursor, count) {
    const variables = { userId: String(userId), count: Math.min(Number(count) || 100, 100), includePromotedContent: false, withGrokTranslatedBio: false };
    if (cursor) variables.cursor = cursor;
    let got;
    try {
      got = await gql(name, variables);
    } catch (e) {
      if (e.kind !== "endpoint" || variables.count <= 20) throw e;
      variables.count = 20;
      got = await gql(name, variables);
    }
    let parsed = { users: [], cursor: null };
    try { parsed = parsePage(got.json); } catch (_) {}
    if (!parsed.users.length && !cursor) {
      // A cached query id can be paired with the wrong feature set; refresh once.
      try {
        await discover(true, [name]);
        const retry = await gql(name, variables, true);
        const rp = parsePage(retry.json);
        if (rp.users.length || rp.cursor) { parsed = rp; got = retry; }
      } catch (_) {}
    }
    const next = parsed.cursor || null;
    const end = !next || /^0\|/.test(next) || next === cursor || !parsed.users.length;
    return { ok: true, users: parsed.users, cursor: end ? null : "G:" + next, end, source: "gql", rate: rateInfo(got.res) };
  }

  // One page of a user's Followers or Following list, newest first.
  async function listPage(name, userId, cursor, count) {
    if (name !== "Followers" && name !== "Following") throw apiError("endpoint", "Unknown list " + name);
    if (!userId) throw apiError("gone", "Missing account id.");
    const fam = cursor ? String(cursor).slice(0, 2) : null;
    const raw = cursor ? String(cursor).slice(2) : null;
    if (fam === "R:") return restPage(name, userId, raw, 200);
    if (fam === "G:") return gqlPage(name, userId, raw, count || 100);
    if (cursor) return gqlPage(name, userId, String(cursor), count || 100);   // untagged legacy cursor

    const order = listModes[name] === "gql" ? ["gql", "rest"] : ["rest", "gql"];
    let empty = null, lastErr = null;
    for (const f of order) {
      try {
        const r = f === "rest" ? await restPage(name, userId, null, 200) : await gqlPage(name, userId, null, count || 100);
        if (r.users.length) { listModes[name] = f; return r; }
        if (!empty) empty = r;
      } catch (e) {
        lastErr = e;
        if (["auth", "locked", "suspended", "automation", "private"].includes(e.kind)) throw e;
      }
    }
    if (empty) return { ...empty, cursor: null, end: true };
    throw lastErr || apiError("transient", "X returned no list.");
  }

  // ---------------------------------------------------------------------
  // Follow
  // ---------------------------------------------------------------------
  function mutationUser(json) {
    const root = json && json.data && json.data.create_friendship;
    const result = root && root.user && root.user.result;
    return parseUser(result);
  }

  async function gqlFollow(target) {
    try {
      const got = await gql("CreateFriendship", { userId: String(target.id) });
      const j = (got && got.json) || {};
      if (Array.isArray(j.errors) && j.errors.length) return { ok: false, ...classify(got.res, j) };
      const u = mutationUser(j);
      return { ok: true, kind: "ok", id: (u && u.i) || String(target.id), h: (u && u.h) || target.h || "", pending: !!(u && u.p), via: "graphql" };
    } catch (e) {
      return { ok: false, kind: e.kind || "endpoint", message: String(e.message || e) };
    }
  }

  // The same form X's own Follow button posts.
  async function follow(target) {
    if (!target || !(target.id || target.h)) return { ok: false, kind: "gone", message: "Missing target account." };
    if (target.id && String(target.id) === String(uid())) return { ok: false, kind: "gone", message: "that is your own account" };
    const url = location.origin + "/i/api/1.1/friendships/create.json";
    const p = new URLSearchParams({
      include_profile_interstitial_type: "1",
      include_blocking: "1",
      include_blocked_by: "1",
      include_followed_by: "1",
      include_want_retweets: "1",
      include_mute_edge: "1",
      include_can_dm: "1",
      include_can_media_tag: "1",
      include_ext_is_blue_verified: "1",
      include_ext_verified_type: "1",
      include_ext_profile_image_shape: "1",
      skip_status: "1"
    });
    if (target.id) p.set("user_id", String(target.id));
    else p.set("screen_name", String(target.h).replace(/^@/, ""));

    let last = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      let r;
      try { r = await send("POST", url, p.toString(), "application/x-www-form-urlencoded"); }
      catch (e) { return { ok: false, kind: e.kind || "transient", message: e.message || String(e) }; }
      const j = r.json || {};
      if (r.res.ok && !(Array.isArray(j.errors) && j.errors.length)) {
        return {
          ok: true, kind: "ok", id: String(j.id_str || target.id || ""), h: String(j.screen_name || target.h || ""),
          pending: !!j.follow_request_sent || (!!j.protected && j.following === false), followedBy: !!j.followed_by, via: "rest"
        };
      }
      last = classify(r.res, j);
      if (last.kind !== "endpoint") return { ok: false, ...last };
      if (attempt === 0) { try { await TX().invalidate(); await TX().init(true); } catch (_) {} }
    }
    if (target.id) {
      const g = await gqlFollow(target);
      if (g.ok || g.kind !== "endpoint") return g;
    }
    return { ok: false, ...(last || { kind: "endpoint", message: "X rejected the follow request." }) };
  }

  // ---------------------------------------------------------------------
  // The signed-in account
  // ---------------------------------------------------------------------
  function viewerFrom(state) {
    try {
      const id = state && state.session && state.session.user_id;
      const ents = state && state.entities && state.entities.users && state.entities.users.entities;
      const u = id && ents && ents[id];
      if (!u) return null;
      const legacy = u.legacy || u;
      const core = u.core || {};
      return {
        id: String(id),
        handle: core.screen_name || legacy.screen_name || "",
        name: core.name || legacy.name || "",
        avatar: (u.avatar && u.avatar.image_url) || legacy.profile_image_url_https || "",
        followers: typeof legacy.followers_count === "number" ? legacy.followers_count : null,
        following: typeof legacy.friends_count === "number" ? legacy.friends_count : null
      };
    } catch (_) { return null; }
  }

  function viewerFromDom() {
    const out = { handle: "", name: "", avatar: "" };
    const sw = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    if (sw) {
      const img = sw.querySelector("img[src]");
      if (img) out.avatar = img.src;
      const lines = (sw.innerText || "").split("\n").map((x) => x.trim()).filter(Boolean);
      const h = lines.find((x) => x.startsWith("@"));
      const n = lines.find((x) => !x.startsWith("@"));
      if (h) out.handle = h.slice(1);
      if (n) out.name = n;
    }
    if (!out.handle) {
      const href = (document.querySelector('[data-testid="AppTabBar_Profile_Link"]') || {}).getAttribute?.("href") || "";
      if (/^\/[A-Za-z0-9_]{1,15}$/.test(href)) out.handle = href.slice(1);
    }
    return out;
  }

  async function showUser(params) {
    const q = new URLSearchParams(Object.assign({ include_ext_is_blue_verified: "1", include_ext_verified_type: "1" }, params));
    const r = await send("GET", location.origin + "/i/api/1.1/users/show.json?" + q.toString(), null, "application/json");
    if (r.res.ok && r.json && (r.json.id_str || r.json.id)) return parseRestUser(r.json);
    throw apiError(classify(r.res, r.json).kind, classify(r.res, r.json).message);
  }

  async function whoami(deep) {
    const id = await sessionUidFallback();
    if (!id) return { ok: true, signedIn: false };
    const dom = viewerFromDom();
    let v = (ops && ops.viewer && ops.viewer.id === id) ? ops.viewer : null;
    if (deep || !v || !v.handle) {
      try {
        const shell = await TX().shell();
        const fresh = shell && viewerFrom(extractInitialState(shell.html));
        if (fresh && fresh.id === id) v = fresh;
      } catch (_) {}
    }
    let counts = null;
    if (deep) { try { counts = await showUser({ user_id: id }); } catch (_) {} }
    return {
      ok: true, signedIn: true, id,
      handle: (counts && counts.h) || (v && v.handle) || dom.handle || "",
      name: (counts && counts.n) || (v && v.name) || dom.name || "",
      avatar: (counts && counts.a) || (v && v.avatar) || dom.avatar || "",
      followers: counts && counts.fc !== null ? counts.fc : (v ? v.followers : null),
      following: counts && counts.fr !== null ? counts.fr : (v ? v.following : null)
    };
  }

  // Resolve a source handle to its id and profile, without opening its page.
  async function resolveHandle(handle) {
    const wanted = String(handle || "").replace(/^@/, "").trim();
    if (!/^[A-Za-z0-9_]{1,15}$/.test(wanted)) return { ok: false, kind: "gone", message: "Not a valid username." };
    try {
      const u = await showUser({ screen_name: wanted });
      if (u) return { ok: true, user: u };
    } catch (e) {
      if (e.kind && !["endpoint", "transient"].includes(e.kind)) return { ok: false, kind: e.kind, message: e.message };
    }
    try {
      const got = await gql("UserByScreenName", { screen_name: wanted, withSafetyModeUserFields: true, withGrokTranslatedBio: false });
      const result = got && got.json && got.json.data && got.json.data.user && got.json.data.user.result;
      const u = parseUser(result);
      if (u) return { ok: true, user: u };
      if (got && got.json && got.json.data && (!got.json.data.user || result && result.__typename === "UserUnavailable")) {
        return { ok: false, kind: "gone", message: "@" + wanted + " does not exist or is suspended." };
      }
    } catch (e) {
      if (e.kind && !["endpoint", "transient"].includes(e.kind)) return { ok: false, kind: e.kind, message: e.message };
    }
    return { ok: false, kind: "transient", message: "Could not look up @" + wanted + " right now." };
  }

  // ---------------------------------------------------------------------
  // Relationships: which of these accounts follow you (follow-back check)
  // ---------------------------------------------------------------------
  // Asks X directly, the same fact behind the "Follows you" badge on a
  // profile. Three independent ways, tried in order; the first that answers
  // is remembered, and a way that fails is skipped for 30 minutes.
  //   lookup  REST friendships/lookup  - 100 accounts per request
  //   gql     GraphQL UsersByRestIds   - relationship_perspectives.followed_by
  //   users   REST users/lookup        - followed_by on each user object
  const relState = { mode: null, dead: {} };

  function relFail(r, what) {
    const c = classify(r.res, r.json);
    return apiError(c.kind, c.message || what + " failed", c);
  }

  async function relLookup(ids) {
    const r = await send("GET", location.origin + "/i/api/1.1/friendships/lookup.json?user_id=" + ids.join(","), null, "application/json");
    if (!r.res.ok || !Array.isArray(r.json)) throw relFail(r, "friendships/lookup");
    const map = {};
    for (const x of r.json) {
      const id = String((x && (x.id_str || x.id)) || "");
      if (!id) continue;
      const c = Array.isArray(x.connections) ? x.connections : [];
      map[id] = { fy: c.includes("followed_by"), fw: c.includes("following"), pending: c.includes("following_requested"), h: String(x.screen_name || "") };
    }
    return map;
  }

  async function relGql(ids) {
    const got = await gql("UsersByRestIds", { userIds: ids, withSafetyModeUserFields: true });
    const arr = (got && got.json && got.json.data && got.json.data.users) || [];
    const map = {};
    for (const it of arr) {
      const u = parseUser(it && (it.result || it));
      if (u && u.fy !== null) map[u.i] = { fy: u.fy === true, fw: u.fw === true, pending: false, h: u.h };
    }
    return map;
  }

  async function relUsers(ids) {
    const r = await send("GET", location.origin + "/i/api/1.1/users/lookup.json?user_id=" + ids.join(",") + "&include_entities=false&include_ext_is_blue_verified=1", null, "application/json");
    if (!r.res.ok || !Array.isArray(r.json)) throw relFail(r, "users/lookup");
    const map = {};
    for (const x of r.json) {
      const u = parseRestUser(x);
      if (u && u.fy !== null) map[u.i] = { fy: u.fy === true, fw: u.fw === true, pending: !!x.follow_request_sent, h: u.h };
    }
    return map;
  }

  async function relationships(ids, prefer) {
    ids = [...new Set((ids || []).map(String).filter((x) => /^\d+$/.test(x)))].slice(0, 100);
    if (!ids.length) return { ok: true, map: {}, via: "none", asked: 0 };
    const all = ["lookup", "gql", "users"];
    let order = [...new Set([relState.mode, prefer, ...all].filter((m) => all.includes(m)))];
    const alive = order.filter((m) => !(relState.dead[m] && Date.now() - relState.dead[m] < 30 * 60000));
    // Every route failed recently: probe the one that failed longest ago, so a short outage doesn't block checks.
    order = alive.length ? alive : [order.slice().sort((a, b) => relState.dead[a] - relState.dead[b])[0]];
    let lastErr = null;
    for (const m of order) {
      try {
        const map = m === "lookup" ? await relLookup(ids) : m === "gql" ? await relGql(ids) : await relUsers(ids);
        if (Object.keys(map).length || ids.length < 5) { relState.mode = m; return { ok: true, map, via: m, asked: ids.length }; }
        relState.dead[m] = Date.now();          // answered, but without relationship data
      } catch (e) {
        lastErr = e;
        if (["auth", "locked", "suspended", "automation"].includes(e.kind)) throw e;
        if (e.kind !== "rate") relState.dead[m] = Date.now();
      }
    }
    if (lastErr) throw lastErr;
    throw apiError("endpoint", "X didn't answer the follow-back check.");
  }

  // Every follower id, 5,000 per page: the full-scan backstop.
  async function followerIds(userId, cursor) {
    const p = new URLSearchParams({ user_id: String(userId || uid()), count: "5000", stringify_ids: "true", cursor: cursor ? String(cursor) : "-1" });
    const r = await send("GET", location.origin + "/i/api/1.1/followers/ids.json?" + p.toString(), null, "application/json");
    if (!r.res.ok || !r.json || !Array.isArray(r.json.ids)) throw relFail(r, "followers/ids");
    const next = String(r.json.next_cursor_str ?? r.json.next_cursor ?? "0");
    const end = !next || next === "0" || next === String(cursor || "");
    return { ok: true, ids: r.json.ids.map(String), cursor: end ? null : next, end, rate: rateInfo(r.res) };
  }


  // Every account you follow, 5,000 ids per page, NEWEST first (used by Auto-unfollow:
  // GrowX reverses the list so the oldest follows are unfollowed first).
  async function friendIds(userId, cursor) {
    const p = new URLSearchParams({ user_id: String(userId || uid()), count: "5000", stringify_ids: "true", cursor: cursor ? String(cursor) : "-1" });
    const r = await send("GET", location.origin + "/i/api/1.1/friends/ids.json?" + p.toString(), null, "application/json");
    if (!r.res.ok || !r.json || !Array.isArray(r.json.ids)) throw relFail(r, "friends/ids");
    const next = String(r.json.next_cursor_str ?? r.json.next_cursor ?? "0");
    const end = !next || next === "0" || next === String(cursor || "");
    return { ok: true, ids: r.json.ids.map(String), cursor: end ? null : next, end, rate: rateInfo(r.res) };
  }


  // Up to 100 accounts per request with their post count, latest post date, privacy, photo, follower numbers and
  // verified badge (Unfollow's inactive check, and Follow back's check right before following).
  // opts.verified: the caller needs the badge. X's old-style lookup normally carries it; if it doesn't, the same accounts are
  // asked once more the other way (GraphQL). If the badge can't be read at all, `v` stays undefined - never guessed.
  let vgqlOffUntil = 0;
  async function usersInfo(ids, opts) {
    ids = [...new Set((ids || []).map(String).filter((x) => /^\d+$/.test(x)))].slice(0, 100);
    if (!ids.length) return { ok: true, map: {} };
    const r = await send("GET", location.origin + "/i/api/1.1/users/lookup.json?user_id=" + ids.join(",") + "&include_entities=false&include_ext_is_blue_verified=1&include_ext_verified_type=1", null, "application/json");
    // X answers 404 / code 17 ("No user matches") when NONE of the asked accounts exist any more (deleted, suspended): that is an answer, not a broken endpoint.
    if (r.res.status === 404 && r.json && Array.isArray(r.json.errors) && r.json.errors.length && r.json.errors.every((e) => Number(e && e.code) === 17)) return { ok: true, map: {}, asked: ids.length, vsrc: "" };
    if (!r.res.ok || !Array.isArray(r.json)) throw relFail(r, "users/lookup");
    const map = {};
    let carries = false;               // does X's answer say anything about the blue badge?
    for (const x of r.json) {
      const u = parseRestUser(x);
      if (!u) continue;
      if (x && ("ext_is_blue_verified" in x || "is_blue_verified" in x)) carries = true;
      map[u.i] = { h: u.h, n: u.n, a: u.a, fw: u.fw, fy: u.fy, sc: u.sc, lt: u.lt, p: u.p, d: u.d, fc: u.fc, fr: u.fr, v: u.v, ca: u.ca };
    }
    let vsrc = carries ? "lookup" : "";
    if (opts && opts.verified && !carries && Object.keys(map).length) {
      // The second way is only tried when it can work: after a failure it rests for 20 minutes (no bundle re-scans per batch).
      if (Date.now() >= vgqlOffUntil) {
        try {
          const got = await gql("UsersByRestIds", { userIds: ids, withSafetyModeUserFields: true });
          const arr = (got && got.json && got.json.data && got.json.data.users) || [];
          const seenV = new Set();
          for (const it of arr) {
            const res = it && (it.result || it);
            const u = res && typeof res === "object" ? parseUser(res) : null;
            const rid = u ? u.i : (res && typeof res === "object" && res.__typename !== "UserUnavailable" ? String(res.rest_id || "") : "");
            if (rid && map[rid]) { map[rid].v = u ? u.v : verifiedOf(res); seenV.add(rid); }
          }
          if (seenV.size) { vsrc = "graphql"; vgqlOffUntil = 0; for (const id of Object.keys(map)) if (!seenV.has(id)) map[id].v = undefined; }
          else vgqlOffUntil = Date.now() + 20 * 60000;
        } catch (e) {
          if (["auth", "locked", "suspended", "automation", "rate"].includes(e.kind)) throw e;
          vgqlOffUntil = Date.now() + 20 * 60000;
        }
      }
      if (!vsrc) for (const id of Object.keys(map)) map[id].v = undefined;     // not readable: unknown
    }
    return { ok: true, map, asked: ids.length, vsrc };
  }

  // Inactive check, step 2: how many posts (incl. replies and reposts) an account made since `since`.
  function collectOwnTweetTimes(node, userId, out, seen, depth = 0) {
    if (!node || typeof node !== "object" || depth > 40) return;
    if (Array.isArray(node)) { for (const x of node) collectOwnTweetTimes(x, userId, out, seen, depth + 1); return; }
    const lg = node.legacy;
    if (lg && typeof lg === "object" && lg.created_at && (lg.id_str || node.rest_id) && String(lg.user_id_str || "") === String(userId)) {
      const id = String(lg.id_str || node.rest_id);
      if (!seen.has(id)) { seen.add(id); const t = Date.parse(lg.created_at); if (t) out.push(t); }
    }
    for (const k in node) if (k !== "legacy" || !lg) collectOwnTweetTimes(node[k], userId, out, seen, depth + 1);
  }
  let postsOpOffUntil = 0;          // "X's app code doesn't contain the post-list query": remembered for 20 minutes (no bundle re-scan per profile)
  async function recentPosts(userId, since) {
    userId = String(userId);
    let times = [], via = "";
    try {
      if (Date.now() < postsOpOffUntil) throw apiError("endpoint", "X's post-list query is unavailable right now.");
      try { await discover(false, ["UserTweetsAndReplies"]); }
      catch (e) { if (e && e.kind === "endpoint") postsOpOffUntil = Date.now() + 20 * 60000; throw e; }
      const got = await gql("UserTweetsAndReplies", { userId, count: 40, includePromotedContent: false, withCommunity: true, withVoice: true });
      collectOwnTweetTimes(got.json && got.json.data, userId, times, new Set());
      via = "graphql";
    } catch (e) {
      if (["auth", "locked", "suspended", "automation", "rate"].includes(e.kind)) throw e;
      const p = new URLSearchParams({ user_id: userId, count: "40", include_rts: "1", exclude_replies: "false", trim_user: "1", tweet_mode: "extended" });
      const r = await send("GET", location.origin + "/i/api/1.1/statuses/user_timeline.json?" + p.toString(), null, "application/json");
      if (!r.res.ok || !Array.isArray(r.json)) throw relFail(r, "user timeline");
      times = r.json.map((t) => Date.parse(t.created_at)).filter(Boolean);
      via = "rest";
    }
    times.sort((a, b) => b - a);
    return { ok: true, count: times.filter((t) => t >= since).length, newest: times[0] || null, seen: times.length, via };
  }

  // Unfollow: the same form X's own "Following -> Unfollow" button posts.
  async function unfollow(target) {
    if (!target || !target.id) return { ok: false, kind: "gone", message: "Missing target account." };
    if (String(target.id) === String(uid())) return { ok: false, kind: "gone", message: "that is your own account" };
    const url = location.origin + "/i/api/1.1/friendships/destroy.json";
    const p = new URLSearchParams({
      include_profile_interstitial_type: "1", include_blocking: "1", include_blocked_by: "1", include_followed_by: "1",
      include_want_retweets: "1", include_mute_edge: "1", include_can_dm: "1", include_can_media_tag: "1",
      include_ext_is_blue_verified: "1", include_ext_verified_type: "1", include_ext_profile_image_shape: "1",
      skip_status: "1", user_id: String(target.id)
    });
    let last = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      let r;
      try { r = await send("POST", url, p.toString(), "application/x-www-form-urlencoded"); }
      catch (e) { return { ok: false, kind: e.kind || "transient", message: e.message || String(e) }; }
      const j = r.json || {};
      if (r.res.ok && !(Array.isArray(j.errors) && j.errors.length)) {
        return { ok: true, kind: "ok", id: String(j.id_str || target.id), h: String(j.screen_name || ""), n: String(j.name || ""),
          a: String(j.profile_image_url_https || ""), followedBy: !!j.followed_by };
      }
      last = classify(r.res, j);
      if (last.kind !== "endpoint") return { ok: false, ...last };
      if (attempt === 0) { try { await TX().invalidate(); await TX().init(true); } catch (_) {} }
    }
    return { ok: false, ...(last || { kind: "endpoint", message: "X rejected the unfollow request." }) };
  }

  // ---------------------------------------------------------------------
  // Health check for the Help page. Read-only.
  // ---------------------------------------------------------------------
  async function health() {
    const out = { signedIn: !!uid(), csrf: !!csrf(), txid: null, ops: null, read: null, rel: null, ids: null };
    if (!out.signedIn) return out;
    try { await TX().init(false); out.txid = "ok"; }
    catch (e) { out.txid = String(e.message || e); }
    try {
      await discover(false);
      out.ops = Object.keys(ops.ops).join(", ") + (ops.bearer ? " (bearer from app)" : " (default bearer)");
    } catch (e) { out.ops = String(e.message || e); }
    try {
      const r = await listPage("Followers", uid(), null, 20);
      out.read = "ok via " + r.source + ", " + r.users.length + " followers on the first page";
    } catch (e) { out.read = (e.kind || "error") + ": " + (e.message || e); }
    try {
      const fl = await listPage("Following", uid(), null, 20);
      const ids = fl.users.slice(0, 10).map((u) => u.i);
      if (!ids.length) out.rel = "nobody followed yet";
      else {
        const rr = await relationships(ids);
        const back = Object.values(rr.map).filter((x) => x.fy).length;
        out.rel = "ok via " + rr.via + " (" + Object.keys(rr.map).length + " of " + ids.length + " checked, " + back + " follow you)";
      }
    } catch (e) { out.rel = (e.kind || "error") + ": " + (e.message || e); }
    try { const fi = await followerIds(uid(), null); out.ids = "ok, " + fi.ids.length + " follower ids on the first page"; }
    catch (e) { out.ids = (e.kind || "error") + ": " + (e.message || e); }
    return out;
  }

  // One GraphQL operation by name. `opts.method` pins the HTTP method, which a
  // mutation needs: X answers 405 to a GET on CreateTweet. Comment mode (xcmt.js)
  // builds on this so there is only ever one copy of the request plumbing.
  async function gqlOp(name, variables, opts) {
    await discover(false, [name]);
    if (opts && opts.method && ops.methods[name] !== opts.method) ops.methods[name] = opts.method;
    return gql(name, variables);
  }

  window.__GX_API = {
    v: V, uid, csrf, whoami, listPage, follow, unfollow, relationships, followerIds, friendIds, usersInfo, recentPosts, resolveHandle, health, discover,
    gqlOp, send, classify, apiError, parseUser, rateWait,
    _test: { parsePage, parseUser, parseRestUser, findOp, extractInitialState, featureValuesFrom, classify }
  };
})();
