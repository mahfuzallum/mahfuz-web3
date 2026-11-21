// GrowX - shared/cmt.js
//
// Comment mode: the fourth mode. Everything the engine and the pages must agree
// on lives here - the settings and their safe ranges, the pace presets, the model
// price table, how a pasted link becomes a post id, and the rule check every AI
// reply has to pass before it may be posted.
//
// Loaded next to shared/config.js (importScripts in the worker, a <script> tag on
// every page) and hung on the same GX namespace.

(function (root) {
  "use strict";

  const GX = root.GX;
  if (!GX) throw new Error("shared/cmt.js must load after shared/config.js");

  // ---- storage -------------------------------------------------------------
  // The numbers, prompts and rules live in gx.settings with the other modes, so
  // one normalize pass covers all four. Everything that grows (the queue, the
  // post ids, the day totals) gets a key of its own.
  const CK = {
    queue: "gx.cmt.queue",      // the posts waiting, being written, ready, posted
    replied: "gx.cmt.replied",  // every post id ever replied to - kept forever
    days: "gx.cmt.days",        // per-day totals - kept forever
    ledger: "gx.cmt.ledger",    // timestamps of posted replies (hour / day counts)
    watch: "gx.cmt.watch",      // the watch list
    target: "gx.cmt.target",    // the target accounts
    hist: "gx.cmt.hist",        // what was posted, newest first (text is compacted after a while)
    key: "gx.cmt.key",          // the OpenAI key, apart from the settings
    tg: "gx.tg", timings: "gx.cmt.timings",                // Telegram bot token, chat id and per-event switches
    focus: "gx.cmt.focus"       // v3.2 started from the Comment page with links: work only on those, don't switch away
  };

  // ---- the models GrowX can write with -------------------------------------
  // `in` / `out` are dollars per 1,000,000 tokens, as OpenAI lists them. The cost
  // shown in the dashboard always comes from the real token counts in the reply,
  // never from an estimate.
  const MODELS = [
    { id: "gpt-4.1-nano", in: 0.10, out: 0.40, quality: "Basic", speed: "Fastest" },
    { id: "gpt-4o-mini", in: 0.15, out: 0.60, quality: "Good", speed: "Fast" },
    { id: "gpt-4.1-mini", in: 0.40, out: 1.60, quality: "Very good with long rules", speed: "Fast", rec: true },
    { id: "gpt-5-mini", in: 0.25, out: 2.00, quality: "Very good", speed: "Slower" },
    { id: "gpt-4.1", in: 2.00, out: 8.00, quality: "High", speed: "Fast" },
    { id: "gpt-4o", in: 2.50, out: 10.00, quality: "High", speed: "Fast" },
    { id: "gpt-5", in: 1.25, out: 10.00, quality: "Highest", speed: "Slower" },
    { id: "gpt-5-nano", in: 0.05, out: 0.40, quality: "Basic", speed: "Fastest" }
  ];
  const MODEL_IDS = MODELS.map((m) => m.id);
  const modelInfo = (id) => MODELS.find((m) => m.id === id) || MODELS[2];
  // gpt-5* take max_completion_tokens and refuse a temperature.
  const isGpt5 = (id) => /^gpt-5/.test(String(id || ""));
  // Dollars for one reply at the usual shape of a call (prompt in, a short reply out).
  function replyCost(id, inTok, outTok) {
    const m = modelInfo(id);
    return (Number(inTok) || 0) / 1e6 * m.in + (Number(outTok) || 0) / 1e6 * m.out;
  }
  // What 1,000 drafts cost, for the model table. A draft is about 1,100 tokens in and 40 out,
  // and roughly 1.3 calls (the two-step read, or a rewrite) per finished reply.
  const per1000 = (id) => replyCost(id, 1100 * 1300, 40 * 1300);

  // ---- the prompts GrowX ships with ---------------------------------------
  const DEFAULT_PROMPT = [
    "write ONE natural casual x reply to the post",
    "",
    "GOAL:",
    "react to ONE specific detail, idea, claim, joke, achievement or personal thought in the post",
    "",
    "VOICE:",
    "a real person typing fast on their phone. lowercase. no punctuation at the end.",
    "short. 3 to 18 words. one or two lines at most.",
    "",
    "NEVER:",
    "no emoji, no hashtags, no @mentions, no links, no quotation marks",
    "never repeat the post back",
    "never start with \"this\", \"so\", \"honestly\", \"literally\", \"actually\"",
    "never give advice unless the post asks for it",
    "never praise the poster",
    "",
    "if the post is not something you can reply to naturally, answer exactly: SKIP"
  ].join("\n");

  const DEFAULT_BACK_PROMPT = [
    "someone replied to my post. write ONE short natural answer back.",
    "",
    "VOICE:",
    "friendly, lowercase, 3 to 18 words, no punctuation at the end.",
    "answer what they actually said. if they asked something, answer it.",
    "",
    "NEVER:",
    "no emoji, no hashtags, no @mentions, no links, no quotation marks",
    "never thank them more than once",
    "",
    "if the reply is spam, abuse or nothing to answer, answer exactly: SKIP"
  ].join("\n");

  const DEFAULT_BANNED = [
    "really", "wonder", "change", "actually", "honestly", "literally", "definitely", "very", "pretty", "quite",
    "insight", "leverage", "utilize", "robust", "seamless", "crucial", "vital", "essential", "profound", "fascinating",
    "incredible", "amazing", "awesome", "fantastic", "brilliant", "stunning", "remarkable", "noteworthy", "underscore",
    "testament", "landscape", "realm", "tapestry", "delve", "embark", "navigate", "unlock", "unleash", "elevate",
    "transform", "empower", "resonate", "align", "holistic", "synergy", "paradigm", "ecosystem", "framework",
    "game changer", "deep dive", "moving forward", "at the end of the day", "needless to say", "it is worth noting",
    "in today's world", "the fact that", "when it comes to", "first and foremost", "last but not least",
    "kudos", "bravo", "spot on", "well said", "couldn't agree more", "food for thought", "this hits different"
  ].join(", ");

  const DEFAULT_FILLERS = [
    "really is", "i wonder if", "i wonder how", "this is why", "that is why", "so true", "love this",
    "great point", "well put", "thanks for sharing", "appreciate you", "big if true"
  ].join(", ");


  // ---- the voice: language, tone, mood and length -------------------------
  // These do not replace your prompt - they are added under it as a short, plain
  // instruction block, so your own wording still leads and the model is never
  // given two sets of contradictory rules.
  const CMT_LANGS = [
    ["auto", "Match the post"],
    ["en", "English"], ["bn", "Bangla"], ["banglish", "Banglish (Bangla in English letters)"],
    ["hi", "Hindi"], ["ur", "Urdu"], ["ar", "Arabic"], ["es", "Spanish"], ["pt", "Portuguese"],
    ["fr", "French"], ["de", "German"], ["it", "Italian"], ["tr", "Turkish"], ["ru", "Russian"],
    ["id", "Indonesian"], ["vi", "Vietnamese"], ["ja", "Japanese"], ["ko", "Korean"], ["zh", "Chinese"]
  ];
  const LANG_LINE = {
    auto: "write in the same language the post is written in",
    en: "write in English", bn: "write in Bangla (Bengali script)",
    banglish: "write in Banglish - Bangla words typed in English letters, the way people actually text",
    hi: "write in Hindi", ur: "write in Urdu", ar: "write in Arabic", es: "write in Spanish",
    pt: "write in Portuguese", fr: "write in French", de: "write in German", it: "write in Italian",
    tr: "write in Turkish", ru: "write in Russian", id: "write in Indonesian", vi: "write in Vietnamese",
    ja: "write in Japanese", ko: "write in Korean", zh: "write in Chinese"
  };

  const CMT_TONES = [
    ["casual", "Casual", "like a friend typing fast, no formality"],
    ["friendly", "Friendly", "warm and easy, never gushing"],
    ["professional", "Professional", "clear and plain, no slang"],
    ["witty", "Witty", "one light joke at most, never forced"],
    ["supportive", "Supportive", "on their side, specific about why"],
    ["curious", "Curious", "react, then ask one real question"],
    ["bold", "Bold", "say what you think, straight, no hedging"],
    ["expert", "Expert", "add one concrete fact or detail you know"]
  ];
  const TONE_LINE = {
    casual: "tone: casual - like a friend typing fast on their phone. no formality, no sign-off",
    friendly: "tone: friendly and warm, but never gushing and never flattering the poster",
    professional: "tone: professional - clear, plain, no slang, no jokes",
    witty: "tone: witty - one light joke at most, and only if it actually lands. never a pun for its own sake",
    supportive: "tone: supportive - be on their side and be specific about why, not generically nice",
    curious: "tone: curious - react to one detail, then ask one real question about it",
    bold: "tone: bold - say what you think straight out, no hedging, no \"maybe\" or \"i think\"",
    expert: "tone: like someone who knows the subject - add one concrete detail, number or example"
  };

  const CMT_MOODS = [
    ["neutral", "Neutral", "flat and matter of fact"],
    ["positive", "Positive", "upbeat without cheerleading"],
    ["playful", "Playful", "light, a bit cheeky"],
    ["thoughtful", "Thoughtful", "slower, one real observation"],
    ["hyped", "Hyped", "energetic - use sparingly"],
    ["dry", "Dry", "understated, deadpan"]
  ];
  const MOOD_LINE = {
    neutral: "mood: matter of fact. no excitement you do not feel",
    positive: "mood: upbeat, but no cheerleading and no exclamation marks",
    playful: "mood: light and a bit cheeky",
    thoughtful: "mood: unhurried - one real observation, not a reaction",
    hyped: "mood: genuinely excited, still short",
    dry: "mood: dry and understated, deadpan"
  };

  // Reply length: a named size writes the word range for you; Custom leaves the two
  // boxes under your own control.
  const CMT_LENGTHS = {
    tiny: { name: "Very short", min: 2, max: 8, note: "a few words - highest reply rate" },
    short: { name: "Short", min: 3, max: 12, note: "one quick line" },
    medium: { name: "Medium", min: 3, max: 18, note: "one natural sentence" },
    long: { name: "Long", min: 8, max: 32, note: "two sentences, more to say" },
    custom: { name: "Custom", min: 0, max: 0, note: "your own word range below" }
  };

  // The block that is added under your prompt. Only the parts that say something
  // are included, so a plain setup sends nothing extra at all.
  function styleBlock(s, opts) {
    const out = [];
    const lang = LANG_LINE[s.cmtLang] || LANG_LINE.auto;
    if (s.cmtLang && s.cmtLang !== "auto") out.push(lang);
    else if (opts && opts.lang) out.push(`write in the same language as the post (it looks like "${opts.lang}")`);
    if (TONE_LINE[s.cmtTone]) out.push(TONE_LINE[s.cmtTone]);
    if (MOOD_LINE[s.cmtMood]) out.push(MOOD_LINE[s.cmtMood]);
    out.push(`length: ${s.cmtWordsMin} to ${s.cmtWordsMax} words, at most ${s.cmtLines} line${s.cmtLines === 1 ? "" : "s"}`);
    if (s.cmtEmojiOk) out.push("one emoji is allowed, never more");
    const extra = String(s.cmtVoiceNote || "").trim();
    if (extra) out.push(extra.slice(0, 400));
    return out.length ? "HOW IT SHOULD SOUND:\n" + out.map((x) => "- " + x).join("\n") : "";
  }

  // ---- the pace cards ------------------------------------------------------
  // One click fills in every delay, break and limit below. Each card is a complete
  // plan: nothing is left to type afterwards.
  // Each card is checked against its own clock: the day's goal has to fit inside a
  // normal working day at that card's delays and breaks. A goal that cannot be
  // reached is not a plan, it is a number that makes GrowX look broken.
  const CMT_PRESETS = {
    safe: {
      cmtDaily: 100, cmtReady: 10, cmtTurn: 20,
      cmtMinDelay: 180, cmtMaxDelay: 360, cmtHourlyLimit: 8,
      cmtRestEveryMin: 8, cmtRestEvery: 12, cmtRestMinutes: 20, cmtRestMinutesMax: 35,
      cmtLikeMin: 12, cmtLikeMax: 50, cmtOpenMin: 4, cmtOpenMax: 9, cmtPostMin: 2, cmtPostMax: 5,
      cmtFetchMin: 20, cmtFetchMax: 60, cmtReadMin: 4, cmtReadMax: 12, cmtGenMin: 3, cmtGenMax: 10, cmtApproveMin: 5, cmtApproveMax: 15,
      cmtAuthorMax: 1, cmtWarmup: true, cmtRestDays: 1
    },
    balanced: {
      cmtDaily: 150, cmtReady: 20, cmtTurn: 30,
      cmtMinDelay: 90, cmtMaxDelay: 240, cmtHourlyLimit: 12,
      cmtRestEveryMin: 8, cmtRestEvery: 12, cmtRestMinutes: 15, cmtRestMinutesMax: 30,
      cmtLikeMin: 10, cmtLikeMax: 40, cmtOpenMin: 3, cmtOpenMax: 7, cmtPostMin: 1, cmtPostMax: 3,
      cmtFetchMin: 10, cmtFetchMax: 40, cmtReadMin: 2, cmtReadMax: 8, cmtGenMin: 2, cmtGenMax: 6, cmtApproveMin: 3, cmtApproveMax: 10,
      cmtAuthorMax: 1, cmtWarmup: false, cmtRestDays: 1
    },
    fast: {
      cmtDaily: 250, cmtReady: 30, cmtTurn: 45,
      cmtMinDelay: 60, cmtMaxDelay: 150, cmtHourlyLimit: 20,
      cmtRestEveryMin: 10, cmtRestEvery: 15, cmtRestMinutes: 10, cmtRestMinutesMax: 20,
      cmtLikeMin: 8, cmtLikeMax: 30, cmtOpenMin: 2, cmtOpenMax: 5, cmtPostMin: 1, cmtPostMax: 3,
      cmtFetchMin: 5, cmtFetchMax: 20, cmtReadMin: 1, cmtReadMax: 4, cmtGenMin: 1, cmtGenMax: 4, cmtApproveMin: 2, cmtApproveMax: 6,
      cmtAuthorMax: 2, cmtWarmup: false, cmtRestDays: 1
    }
  };
  const CMT_PRESET_INFO = {
    safe: { name: "Safe", who: "New accounts · warm-up on", line: "~100 / day · 3-6 min apart" },
    balanced: { name: "Balanced", who: "Most accounts", line: "~150 / day · 1.5-4 min apart" },
    fast: { name: "Fast", who: "Aged, clean accounts only", line: "~250 / day · 1-2.5 min apart" }
  };

  // ---- the settings --------------------------------------------------------
  const CMT_DEFAULTS = Object.assign({
    cmtPace: "balanced",
    cmtPublish: "auto",            // auto = GrowX posts the reply · draft = it only writes, you post
    cmtOn: true,                   // the master switch on the Comment page header: off = this mode does nothing at all
    cmtLike: true,
    cmtStartNow: true,             // "Right away" vs "Working hours only"
    cmtStart: "21:00", cmtEnd: "03:00", cmtDays: [],
    cmtModel: "gpt-4.1-mini",
    cmtTemp: 0.9,
    cmtVision: true, cmtTwoStep: true, cmtSkipOff: false,
    cmtRate: 122,                  // USD -> BDT, for the second price shown next to every dollar amount
    cmtPrompt: DEFAULT_PROMPT,
    cmtBackPrompt: DEFAULT_BACK_PROMPT,
    // the voice: added under your prompt, never instead of it
    cmtLang: "auto", cmtTone: "casual", cmtMood: "neutral", cmtLength: "medium",
    cmtEmojiOk: false, cmtVoiceNote: "",
    cmtBanned: DEFAULT_BANNED,
    cmtFillers: DEFAULT_FILLERS,
    cmtForms: true,                // block every form of a banned word (improve -> improves, improved, improving)
    cmtWordsMin: 3, cmtWordsMax: 18, cmtLines: 2, cmtRewrites: 4,
    cmtLower: true, cmtNoEmoji: true, cmtNoHash: true, cmtNoMention: true, cmtNoLink: true,
    cmtNoQuote: true, cmtEndAlnum: true, cmtNoCopy: true, cmtNoRepeat: true,
    cmtMaxAgeDays: 7, cmtSkipLimited: true, cmtSkipLiked: false,
    cmtSrcLinks: true, cmtSrcWatch: false, cmtSrcTarget: false, cmtSrcBack: false,
    cmtWatchEvery: 5, cmtWatchAge: 10, cmtWatchMax: 2, cmtWatchReplies: false,
    cmtTargetAge: 7, cmtTargetReplies: false, cmtTargetSkipRT: true,
    cmtBackHours: 24, cmtBackMax: 1,
    cmtSpendCents: 50,             // the day's AI spend cap, in cents
    cmtFailStop: 3,
    cmtSolo: true,                 // one job after the other: Comment waits while another mode still has work
    cmtTurnMode: "turn",
    cmtUnit: "sec"                 // whether the timing boxes are typed in seconds or in minutes
  }, CMT_PRESETS.balanced);

  const CMT_LIMITS = {
    cmtDaily: [1, 350], cmtReady: [1, 200], cmtTurn: [0, 1000],
    cmtMinDelay: [30, 3600], cmtMaxDelay: [30, 7200], cmtHourlyLimit: [1, 60],
    cmtRestEveryMin: [0, 200], cmtRestEvery: [0, 200], cmtRestMinutes: [1, 240], cmtRestMinutesMax: [1, 240],
    cmtLikeMin: [1, 600], cmtLikeMax: [1, 1200],
    cmtOpenMin: [0, 120], cmtOpenMax: [0, 300],
    cmtPostMin: [0, 120], cmtPostMax: [0, 300],
    cmtFetchMin: [0, 3600], cmtFetchMax: [0, 7200],
    cmtReadMin: [0, 600], cmtReadMax: [0, 1200],
    cmtGenMin: [0, 600], cmtGenMax: [0, 1200],
    cmtApproveMin: [0, 1800], cmtApproveMax: [0, 3600],
    cmtAuthorMax: [1, 50], cmtRestDays: [0, 3],
    cmtWordsMin: [1, 60], cmtWordsMax: [2, 120], cmtLines: [1, 8], cmtRewrites: [0, 10],
    cmtMaxAgeDays: [1, 90], cmtWatchEvery: [1, 180], cmtWatchAge: [1, 1440], cmtWatchMax: [1, 20],
    cmtTargetAge: [1, 90], cmtBackHours: [1, 168], cmtBackMax: [1, 10],
    cmtSpendCents: [1, 100000], cmtFailStop: [1, 20], cmtRate: [1, 1000]
  };
  const CMT_BOOLS = ["cmtOn", "cmtLike", "cmtStartNow", "cmtVision", "cmtTwoStep", "cmtSkipOff", "cmtForms", "cmtEmojiOk",
    "cmtLower", "cmtNoEmoji", "cmtNoHash", "cmtNoMention", "cmtNoLink", "cmtNoQuote", "cmtEndAlnum", "cmtNoCopy", "cmtNoRepeat",
    "cmtSkipLimited", "cmtSkipLiked", "cmtWarmup", "cmtSolo",
    "cmtSrcLinks", "cmtSrcWatch", "cmtSrcTarget", "cmtSrcBack", "cmtWatchReplies", "cmtTargetReplies", "cmtTargetSkipRT"];
  // Prompts and word lists are long, so they get their own, larger cap.
  const CMT_TEXTS = { cmtPrompt: 12000, cmtBackPrompt: 12000, cmtBanned: 8000, cmtFillers: 4000, cmtVoiceNote: 400 };

  // The part of normalizeSettings that belongs to Comment mode. Called from
  // GX.normalizeSettings, so nothing can set a comment number out of range.
  function normalizeComment(out) {
    // config.js is loaded first and cannot see these defaults, so they are filled in here.
    for (const k of Object.keys(CMT_DEFAULTS)) {
      if (out[k] === undefined || out[k] === null) out[k] = Array.isArray(CMT_DEFAULTS[k]) ? CMT_DEFAULTS[k].slice() : CMT_DEFAULTS[k];
    }
    out.cmtDays = [...new Set((Array.isArray(out.cmtDays) ? out.cmtDays : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
    for (const [k, [lo, hi]] of Object.entries(CMT_LIMITS)) {
      let n = Number(out[k]);
      if (!Number.isFinite(n)) n = CMT_DEFAULTS[k];
      out[k] = Math.max(lo, Math.min(hi, Math.round(n)));
    }
    for (const b of CMT_BOOLS) out[b] = !!out[b];
    for (const [k, max] of Object.entries(CMT_TEXTS)) out[k] = String(out[k] == null ? CMT_DEFAULTS[k] : out[k]).slice(0, max);
    let t = Number(out.cmtTemp);
    out.cmtTemp = Number.isFinite(t) ? Math.max(0, Math.min(2, Math.round(t * 10) / 10)) : CMT_DEFAULTS.cmtTemp;
    if (!MODEL_IDS.includes(out.cmtModel)) out.cmtModel = CMT_DEFAULTS.cmtModel;
    if (!["auto", "draft"].includes(out.cmtPublish)) out.cmtPublish = "auto";
    if (!CMT_LANGS.some(([v]) => v === out.cmtLang)) out.cmtLang = "auto";
    if (!CMT_TONES.some(([v]) => v === out.cmtTone)) out.cmtTone = "casual";
    if (!CMT_MOODS.some(([v]) => v === out.cmtMood)) out.cmtMood = "neutral";
    if (!CMT_LENGTHS[out.cmtLength]) out.cmtLength = "custom";
    // A named length owns the word range; Custom hands it back to you.
    if (out.cmtLength !== "custom") { out.cmtWordsMin = CMT_LENGTHS[out.cmtLength].min; out.cmtWordsMax = CMT_LENGTHS[out.cmtLength].max; }
    // "one emoji is allowed" and "no emoji" cannot both be true.
    if (out.cmtEmojiOk) out.cmtNoEmoji = false;
    if (!["safe", "balanced", "fast", "custom"].includes(out.cmtPace)) out.cmtPace = "custom";
    if (out.cmtMaxDelay < out.cmtMinDelay) [out.cmtMinDelay, out.cmtMaxDelay] = [out.cmtMaxDelay, out.cmtMinDelay];
    if (out.cmtLikeMax < out.cmtLikeMin) [out.cmtLikeMin, out.cmtLikeMax] = [out.cmtLikeMax, out.cmtLikeMin];
    if (out.cmtOpenMax < out.cmtOpenMin) [out.cmtOpenMin, out.cmtOpenMax] = [out.cmtOpenMax, out.cmtOpenMin];
    if (out.cmtPostMax < out.cmtPostMin) [out.cmtPostMin, out.cmtPostMax] = [out.cmtPostMax, out.cmtPostMin];
    for (const [a, b] of [["cmtFetchMin", "cmtFetchMax"], ["cmtReadMin", "cmtReadMax"], ["cmtGenMin", "cmtGenMax"], ["cmtApproveMin", "cmtApproveMax"]]) {
      if (out[b] < out[a]) [out[a], out[b]] = [out[b], out[a]];
    }
    if (out.cmtUnit !== "min") out.cmtUnit = "sec";
    if (out.cmtRestMinutesMax < out.cmtRestMinutes) [out.cmtRestMinutes, out.cmtRestMinutesMax] = [out.cmtRestMinutesMax, out.cmtRestMinutes];
    if (!out.cmtRestEveryMin || out.cmtRestEveryMin > out.cmtRestEvery) out.cmtRestEveryMin = out.cmtRestEvery;
    if (out.cmtWordsMax <= out.cmtWordsMin) out.cmtWordsMax = out.cmtWordsMin + 1;
    if (out.cmtWatchAge < 1) out.cmtWatchAge = 1;
    return out;
  }

  // ---- links ---------------------------------------------------------------
  // Every form a post link comes in ends up as the same id, so one post is one
  // reply whichever way it was pasted.
  const POST_RE = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:twitter|x)\.com\/(?:i\/web\/status\/(\d{5,25})|@?[A-Za-z0-9_]{1,15}\/status(?:es)?\/(\d{5,25}))/gi;

  function postId(one) {
    if (!one) return null;
    const s = String(one).trim();
    if (/^\d{5,25}$/.test(s)) return s;
    POST_RE.lastIndex = 0;
    const m = POST_RE.exec(s);
    return m ? (m[1] || m[2]) : null;
  }
  function postHandle(one) {
    const m = String(one || "").match(/(?:twitter|x)\.com\/@?([A-Za-z0-9_]{1,15})\/status/i);
    return m && !/^(i|home|search|explore)$/i.test(m[1]) ? m[1] : null;
  }
  // Every post link in a block of text, in the order they appear, each one once.
  // A " | note" after a link is kept and added to the prompt for that post only.
  function parseLinks(text) {
    const out = [];
    const seen = new Set();
    for (const raw of String(text || "").split(/[\r\n]+/)) {
      const bar = raw.indexOf("|");
      const note = bar >= 0 ? raw.slice(bar + 1).trim().slice(0, 300) : "";
      const body = bar >= 0 ? raw.slice(0, bar) : raw;
      POST_RE.lastIndex = 0;
      let m, found = 0;
      while ((m = POST_RE.exec(body))) {
        const id = m[1] || m[2];
        found++;
        if (seen.has(id)) { out.push({ id, dup: true }); continue; }
        seen.add(id);
        out.push({ id, h: postHandle(m[0]) || "", note });
      }
      if (!found) for (const tok of body.split(/[\s,]+/)) {
        if (!/^\d{10,25}$/.test(tok)) continue;
        if (seen.has(tok)) { out.push({ id: tok, dup: true }); continue; }
        seen.add(tok);
        out.push({ id: tok, h: "", note });
      }
    }
    return out;
  }
  const postUrl = (id, h) => "https://x.com/" + (h ? String(h).replace(/^@/, "") : "i/web") + "/status/" + id;

  // ---- the rule check ------------------------------------------------------
  // Everything here runs in GrowX, never in the model: a reply that breaks a rule
  // is sent back to be rewritten with the broken rules named, and is never posted.
  // Pictographs, dingbats, flags and the variation selector, written as code points
  // so the character class can never collapse into a range that also covers letters.
  const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{20E3}\u{203C}\u{2049}\u{2122}\u{2139}\u{2764}\u{2B50}\u{2705}\u{274C}\u{3030}\u{303D}\u{3297}\u{3299}]/u;
  // The emoji (and the space before it) at the very end of a reply. Used so that
  // "allow one emoji" and "ends on a letter or number" can both be on at once.
  const TRAIL_EMOJI_RE = new RegExp("(?:" + EMOJI_RE.source + "|\\s)+$", "u");

  function wordForms(w) {
    const b = String(w || "").toLowerCase().trim();
    if (!b || b.includes(" ")) return b ? [b] : [];
    const out = new Set([b]);
    out.add(b + "s"); out.add(b + "es"); out.add(b + "ed"); out.add(b + "d"); out.add(b + "ing"); out.add(b + "ly");
    if (/e$/.test(b)) out.add(b.slice(0, -1) + "ing");                         // change -> changing
    if (/y$/.test(b)) { out.add(b.slice(0, -1) + "ies"); out.add(b.slice(0, -1) + "ied"); }
    if (/[^aeiou][aeiou][bdgklmnprt]$/.test(b)) { out.add(b + b.slice(-1) + "ing"); out.add(b + b.slice(-1) + "ed"); }
    return [...out];
  }
  function bannedSet(text, allForms) {
    const words = new Set(), phrases = [];
    for (const raw of GX.parseKeywords(text)) {
      if (!raw) continue;
      if (raw.includes(" ")) { phrases.push(raw); continue; }
      if (allForms) for (const f of wordForms(raw)) words.add(f); else words.add(raw);
    }
    return { words, phrases };
  }
  const tokens = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9'\s]/g, " ").split(/\s+/).filter(Boolean);
  // Do two texts share a run of `n` words? Used for "not a copy of the post".
  function sharesRun(a, b, n) {
    const A = tokens(a), B = tokens(b);
    if (A.length < n || B.length < n) return false;
    const set = new Set();
    for (let i = 0; i + n <= A.length; i++) set.add(A.slice(i, i + n).join(" "));
    for (let i = 0; i + n <= B.length; i++) if (set.has(B.slice(i, i + n).join(" "))) return true;
    return false;
  }
  // 0..1, how alike two short replies are (shared words over the smaller one).
  function likeness(a, b) {
    const A = new Set(tokens(a)), B = new Set(tokens(b));
    if (!A.size || !B.size) return 0;
    let hit = 0;
    for (const w of A) if (B.has(w)) hit++;
    return hit / Math.min(A.size, B.size);
  }

  // The small things are repaired instead of being sent back: lowercase, a trailing
  // full stop, wrapping quotes, a stray emoji.
  function autoFix(text, s) {
    let t = String(text || "").replace(/\r/g, "").trim();
    t = t.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "").trim();
    if (s.cmtLower) t = t.toLowerCase();
    if (s.cmtNoEmoji) t = t.replace(new RegExp(EMOJI_RE.source, "gu"), "").replace(/\s{2,}/g, " ").trim();
    if (s.cmtNoQuote) t = t.replace(/["“”]/g, "").trim();
    if (s.cmtEndAlnum) t = t.replace(/[\s.,;:!?-]+$/g, "").trim();
    t = t.replace(/\n{3,}/g, "\n\n").trim();
    return t;
  }

  // Returns { ok, text, broke: [reasons] }. `ctx` carries the post text and the
  // last replies, for "not a copy" and "not like my last replies".
  function checkReply(raw, s, ctx) {
    ctx = ctx || {};
    const text = autoFix(raw, s);
    const broke = [];
    if (!text) return { ok: false, text, broke: ["the reply came back empty"] };
    if (/^skip$/i.test(text.trim())) return { ok: false, skip: true, text, broke: ["the model answered SKIP"] };

    const low = text.toLowerCase();
    const words = tokens(text);
    if (words.length < s.cmtWordsMin) broke.push(`too short (${words.length} words, at least ${s.cmtWordsMin})`);
    if (words.length > s.cmtWordsMax) broke.push(`too long (${words.length} words, at most ${s.cmtWordsMax})`);
    const lines = text.split(/\n+/).filter((x) => x.trim()).length;
    if (lines > s.cmtLines) broke.push(`too many lines (${lines}, at most ${s.cmtLines})`);

    const bans = bannedSet(s.cmtBanned, s.cmtForms);
    const hitWord = words.find((w) => bans.words.has(w));
    if (hitWord) broke.push(`banned word "${hitWord}"`);
    const hitPhrase = bans.phrases.find((p) => low.includes(p));
    if (hitPhrase) broke.push(`banned phrase "${hitPhrase}"`);
    const fillers = GX.parseKeywords(s.cmtFillers);
    const hitFill = fillers.find((p) => low.includes(p));
    if (hitFill) broke.push(`filler phrase "${hitFill}"`);

    if (s.cmtLower && /[A-Z]/.test(text)) broke.push("must be all lowercase");
    if (s.cmtNoEmoji && EMOJI_RE.test(text)) broke.push("no emoji");
    if (s.cmtEmojiOk) {
      const n = (text.match(new RegExp(EMOJI_RE.source, "gu")) || []).length;
      if (n > 1) broke.push(`${n} emoji - one is the most you allow`);
    }
    if (s.cmtNoHash && /#\w/.test(text)) broke.push("no hashtags");
    if (s.cmtNoMention && /(^|\s)@\w/.test(text)) broke.push("no @mentions");
    if (s.cmtNoLink && /(https?:\/\/|www\.|\w+\.(com|net|org|io|xyz|co)\b)/i.test(text)) broke.push("no links");
    if (s.cmtNoQuote && /["“”]/.test(text)) broke.push("no quotation marks");
    // "ends on a letter or number" looks past a trailing emoji when you allow one -
    // otherwise the two settings could never both be satisfied.
    const tail = s.cmtEmojiOk ? text.replace(TRAIL_EMOJI_RE, "") : text;
    if (s.cmtEndAlnum && !/[a-z0-9]$/i.test(tail)) broke.push("must end on a letter or number");
    if (s.cmtNoCopy && ctx.post && sharesRun(text, ctx.post, 4)) broke.push("too close to the post (four words in a row)");
    if (s.cmtNoRepeat && Array.isArray(ctx.recent)) {
      const near = ctx.recent.find((r) => likeness(text, r) >= 0.7);
      if (near) broke.push("too much like one of your recent replies");
    }
    return { ok: !broke.length, text, broke };
  }

  // ---- pace ----------------------------------------------------------------
  // The same shape as the other modes' paceInfo, so the engine's break and hourly
  // maths work unchanged.
  const cmtPace = (s) => ({
    lo: s.cmtMinDelay, hi: s.cmtMaxDelay, lp: 0, mult: 1,
    every: s.cmtRestEvery, avgEvery: (s.cmtRestEvery + (s.cmtRestEveryMin || s.cmtRestEvery)) / 2,
    mins: s.cmtRestMinutes, minsMax: s.cmtRestMinutesMax || s.cmtRestMinutes, jit: 0, extra: []
  });
  // One wait, in milliseconds, picked at random inside a pair of "seconds" settings.
  const randMs = (lo, hi) => Math.round((lo + Math.random() * Math.max(0, hi - lo)) * 1000);
  const waitOpen = (s) => randMs(s.cmtOpenMin, s.cmtOpenMax);       // after the post loads, before the reply box
  const waitPost = (s) => randMs(s.cmtPostMin, s.cmtPostMax);       // after the reply is typed, before it is sent
  const waitLike = (s) => randMs(s.cmtLikeMin, s.cmtLikeMax);       // between the like and the reply
  const waitFetch = (s) => randMs(s.cmtFetchMin, s.cmtFetchMax);    // before asking X for an account's new posts
  const waitRead = (s) => randMs(s.cmtReadMin, s.cmtReadMax);       // before the post itself is read
  const waitGen = (s) => randMs(s.cmtGenMin, s.cmtGenMax);          // before the model is asked to write
  const waitApprove = (s) => randMs(s.cmtApproveMin, s.cmtApproveMax); // between drafts, when you post them yourself

  // Every timing box, in one list, so Settings can draw them and a saved preset
  // knows exactly which numbers it holds. `step` says where in one reply it falls.
  const CMT_TIMINGS = [
    { min: "cmtMinDelay", max: "cmtMaxDelay", name: "Wait between replies", step: "between",
      hint: "A random wait inside this range after every reply. 90 to 240 seconds reads like a person browsing." },
    { min: "cmtFetchMin", max: "cmtFetchMax", name: "Before fetching an account's posts", step: "fetch",
      hint: "The pause before GrowX asks X for a watched or target account's recent posts." },
    { min: "cmtReadMin", max: "cmtReadMax", name: "Before reading the post", step: "read",
      hint: "The moment of settling on a post before its text, images and numbers are read." },
    { min: "cmtGenMin", max: "cmtGenMax", name: "Before the reply is written", step: "gen",
      hint: "The thinking pause before the model is asked for a reply." },
    { min: "cmtOpenMin", max: "cmtOpenMax", name: "After the post opens, before writing", step: "open",
      hint: "Reading the post on screen before GrowX goes to the reply box." },
    { min: "cmtPostMin", max: "cmtPostMax", name: "Before the reply is sent", step: "post",
      hint: "The reply is typed, then GrowX waits this long and only then sends it - 1 to 3 seconds looks natural." },
    { min: "cmtLikeMin", max: "cmtLikeMax", name: "Like, then reply", step: "like",
      hint: "The gap between liking the post and replying to it. Only used when the like is on." },
    { min: "cmtApproveMin", max: "cmtApproveMax", name: "Between drafts you post yourself", step: "approve",
      hint: "Used instead of the sending waits when Publishing is set to \"I post it myself\"." }
  ];
  const CMT_TIMING_KEYS = CMT_TIMINGS.reduce((a, t) => a.concat([t.min, t.max]), []);

  // The average seconds one reply takes, start to finish, at these settings -
  // every wait that really runs, plus the model's own time. This is what the
  // finish estimate and the "replies an hour" figure are built on.
  function cmtStepSeconds(s, opts) {
    const mid = (a, b) => (s[a] + s[b]) / 2;
    const draftOnly = (opts && opts.publish ? opts.publish : s.cmtPublish) === "draft";
    let n = mid("cmtMinDelay", "cmtMaxDelay") + mid("cmtReadMin", "cmtReadMax") + mid("cmtGenMin", "cmtGenMax");
    n += AI_SECONDS * (s.cmtTwoStep ? 2 : 1);
    if (draftOnly) n += mid("cmtApproveMin", "cmtApproveMax");
    else {
      n += mid("cmtOpenMin", "cmtOpenMax") + mid("cmtPostMin", "cmtPostMax") + POST_SECONDS;
      if (s.cmtLike) n += mid("cmtLikeMin", "cmtLikeMax");
    }
    return Math.round(n);
  }
  // Rough, and deliberately so: the model's own answer, and the round trip to X.
  const AI_SECONDS = 6;
  const POST_SECONDS = 4;

  // How long the posts still waiting will take, and when they would be done -
  // held back by the hourly cap and by the day's goal, the same as the engine is.
  // Returns { seconds, at, perHour, capped } or null when nothing is left.
  function cmtFinish(s, c, now) {
    now = now || Date.now();
    const left = Math.max(0, Number(c && c.left) || 0);
    if (!left) return null;
    const per = Math.max(1, cmtStepSeconds(s));
    const byPace = 3600 / per;
    const cap = Math.max(1, Number(c && c.hourCap) || s.cmtHourlyLimit);
    const perHour = Math.min(byPace, cap);
    // v3.2: walk the replies one by one with the breaks, the hourly cap, the day's goal and the working hours,
    // so "finishes at" is the time the engine will really get there.
    const plan = cmtPlan(s, { left, hourCap: cap, todayLeft: c && c.todayLeft != null ? c.todayLeft : null }, now);
    const seconds = plan ? plan.seconds : Math.round((left / perHour) * 3600);
    return { seconds, at: now + seconds * 1000, perHour: Math.round(perHour * 10) / 10, per, capped: cap < byPace, left,
      work: plan ? plan.work : seconds, breaks: plan ? plan.breaks : 0, days: plan ? plan.days : 0, waitsForWindow: plan ? plan.waitsForWindow : false };
  }
  const hm = (t) => { const m = String(t || "").match(/^(\d{1,2}):(\d{2})$/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  // Inside the Comment working hours at time t? ("Right away" = always.) The window may cross midnight (21:00 - 03:00).
  function cmtInHours(s, t) {
    if (s.cmtStartNow) return true;
    const a = hm(s.cmtStart), b = hm(s.cmtEnd);
    if (a == null || b == null || a === b) return true;
    const d = new Date(t), m = d.getHours() * 60 + d.getMinutes();
    return a < b ? (m >= a && m < b) : (m >= a || m < b);
  }
  function cmtNextOpen(s, t) {
    if (cmtInHours(s, t)) return t;
    const a = hm(s.cmtStart);
    const d = new Date(t); d.setSeconds(0, 0); d.setHours(Math.floor(a / 60), a % 60, 0, 0);
    if (d.getTime() <= t) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  // Reply by reply: delay + read + write + like + post (cmtStepSeconds), a break after every
  // (cmtRestEveryMin..cmtRestEvery) replies, never more than the hourly cap in any hour, never past the day's goal
  // (the rest moves to the next day), and only inside the working hours.
  function cmtPlan(s, c, now) {
    now = now || Date.now();
    let left = Math.max(0, Number(c && c.left) || 0);
    if (!left) return null;
    const per = Math.max(1, cmtStepSeconds(s)) * 1000;
    const cap = Math.max(1, Number(c && c.hourCap) || s.cmtHourlyLimit);
    const gap = Math.max(per, 3600000 / cap);
    const every = (s.cmtRestEveryMin + s.cmtRestEvery) / 2;
    const brk = ((s.cmtRestMinutes + s.cmtRestMinutesMax) / 2) * 60000;
    let dayLeft = c && c.todayLeft != null ? Math.max(0, c.todayLeft) : s.cmtDaily;
    let t = cmtNextOpen(s, now), since = 0, breaks = 0, days = 0, work = 0, guard = 0;
    const waitsForWindow = t > now;
    let day = new Date(t).toDateString();
    while (left > 0 && guard++ < 5000) {
      if (dayLeft <= 0) {
        const d = new Date(t); d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0);
        t = cmtNextOpen(s, d.getTime()); dayLeft = s.cmtDaily; days++; since = 0; day = new Date(t).toDateString();
      }
      if (!cmtInHours(s, t)) { t = cmtNextOpen(s, t); since = 0; }
      if (new Date(t).toDateString() !== day) { day = new Date(t).toDateString(); dayLeft = s.cmtDaily; }   // a new calendar day: a fresh goal
      t += gap; work += gap; left--; dayLeft--; since++;
      if (left > 0 && every > 0 && s.cmtRestEvery > 0 && since >= every) { t += brk; breaks++; since = 0; }
    }
    return { seconds: Math.round((t - now) / 1000), at: t, work: Math.round(work / 1000), breaks, days, waitsForWindow };
  }

  // ---- the queue -----------------------------------------------------------
  const SOURCES = ["links", "watch", "target", "back"];
  const SRC_NAME = { links: "Links", watch: "Watch", target: "Target", back: "Reply-back" };
  const STATUS = ["waiting", "reading", "writing", "ready", "posting", "posted", "skipped", "failed"];
  const STATUS_NAME = {
    waiting: "Waiting", reading: "Reading", writing: "Writing", ready: "Ready",
    posting: "Posting", posted: "Posted", skipped: "Skipped", failed: "Failed"
  };
  const isOpen = (r) => r && ["waiting", "reading", "writing", "ready", "posting"].includes(r.st);
  const isDone = (r) => r && ["posted", "skipped"].includes(r.st);

  const dayKey = (ts) => { const d = new Date(ts || Date.now()); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };

  root.GX.CK = CK;
  Object.assign(root.GX, {
    CK, MODELS, MODEL_IDS, modelInfo, isGpt5, replyCost, per1000,
    CMT_DEFAULTS, CMT_LIMITS, CMT_BOOLS, CMT_TEXTS, CMT_PRESETS, CMT_PRESET_INFO,
    DEFAULT_PROMPT, DEFAULT_BACK_PROMPT, DEFAULT_BANNED, DEFAULT_FILLERS,
    CMT_LANGS, CMT_TONES, CMT_MOODS, CMT_LENGTHS, styleBlock,
    normalizeComment, postId, postHandle, parseLinks, postUrl,
    CMT_TIMINGS, CMT_TIMING_KEYS, cmtStepSeconds, cmtFinish, cmtPlan, cmtInHours, cmtNextOpen,
    waitFetch, waitRead, waitGen, waitApprove,
    wordForms, bannedSet, sharesRun, likeness, autoFix, checkReply,
    cmtPace, waitOpen, waitPost, waitLike,
    CMT_SOURCES: SOURCES, CMT_SRC_NAME: SRC_NAME, CMT_STATUS: STATUS, CMT_STATUS_NAME: STATUS_NAME,
    cmtOpen: isOpen, cmtDone: isDone, cmtDayKey: dayKey
  });
})(typeof self !== "undefined" ? self : window);
