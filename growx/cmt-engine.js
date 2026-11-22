// GrowX - cmt-engine.js
//
// Comment mode, the fourth mode of the autopilot. It is imported into the
// background service worker next to background.js and shares its globals, so a
// comment run uses exactly the same machinery as the other three modes: the same
// job, the same Start / Pause / Stop, the same pause timer, the same rests, the
// same "X refused" plan, the same tab handling and the same notifications.
//
// What one turn of Comment mode does, for one post:
//
//   1. take the next post from the queue (pasted links, watch list, target
//      accounts, replies on your own posts)
//   2. read the post from X - full text, author, quoted post, the post it
//      answers, image descriptions, link card, language
//   3. skip it if it may not be replied to (already replied, too old, replies
//      limited, deleted, that author's daily number reached, off topic)
//   4. ask your AI model for ONE reply, with your prompt and your last replies
//   5. check the reply against your rules in GrowX, not in the model; small
//      things are repaired, anything else is rewritten, up to your limit
//   6. optionally like the post, then wait, exactly as a person would
//   7. post the reply through your own signed-in session, wait, and confirm it
//      on X before it is ever counted as posted
//   8. wait a random time inside your range and start again
//
// Nothing is counted, charged or marked Posted on a guess: every number comes
// from what X and OpenAI actually answered.

const CK = GX.CK;
const CMT_HIST_MAX = 8000;
const CMT_Q_MAX = 5000;
const CMT_REPLIED_MAX = 200000;
const CMT_TEXT_KEEP = 90 * 24 * 3600000;      // draft text is compacted after this long; counts and ids never are
const AI_URL = "https://api.openai.com/v1/chat/completions";
const TG_URL = "https://api.telegram.org/bot";

const cmem = { q: null, replied: null, watch: null, targets: null };

// ===========================================================================
// Storage
// ===========================================================================
async function cmtQueue() {
  if (!cmem.q) cmem.q = await load(CK.queue, []);
  if (!Array.isArray(cmem.q)) cmem.q = [];
  return cmem.q;
}
async function cmtSaveQueue() {
  const q = await cmtQueue();
  // Finished rows are trimmed oldest first; the post ids themselves live in
  // gx.cmt.replied and are never trimmed, so "one post, one reply" still holds.
  if (q.length > CMT_Q_MAX) {
    const open = q.filter(GX.cmtOpen);
    const done = q.filter((r) => !GX.cmtOpen(r)).sort((a, b) => (b.doneAt || b.at || 0) - (a.doneAt || a.at || 0));
    cmem.q = open.concat(done.slice(0, Math.max(0, CMT_Q_MAX - open.length)));
  }
  await save({ [CK.queue]: cmem.q });
}
async function cmtReplied() {
  if (!cmem.replied) cmem.replied = new Set((await load(CK.replied, [])).map(String));
  return cmem.replied;
}
async function cmtMarkReplied(id) {
  const set = await cmtReplied();
  if (set.has(String(id))) return;
  set.add(String(id));
  let arr = [...set];
  if (arr.length > CMT_REPLIED_MAX) arr = arr.slice(arr.length - CMT_REPLIED_MAX);
  cmem.replied = new Set(arr);
  await save({ [CK.replied]: arr });
}
async function cmtWatch() { if (!cmem.watch) cmem.watch = await load(CK.watch, []); return cmem.watch; }
async function cmtSaveWatch() { await save({ [CK.watch]: cmem.watch || [] }); }
async function cmtTargets() { if (!cmem.targets) { cmem.targets = await load(CK.target, []); tgtKeepSync(cmem.targets); } return cmem.targets; }
async function cmtSaveTargets() { tgtKeepSync(cmem.targets || []); await save({ [CK.target]: cmem.targets || [] }); }

// Per-day totals, kept forever. The running total is simply their sum.
async function cmtDays() { return (await load(CK.days, null)) || {}; }
async function cmtBump(patch, now, src) {
  const days = await cmtDays();
  const k = GX.cmtDayKey(now);
  const d = days[k] || (days[k] = { posted: 0, drafts: 0, skipped: 0, failed: 0, likes: 0, cost: 0, src: {} });
  for (const [key, v] of Object.entries(patch)) d[key] = (d[key] || 0) + v;
  if (src && patch.posted) d.src[src] = (d.src[src] || 0) + patch.posted;
  await save({ [CK.days]: days });
  return d;
}
async function cmtLedger() { return (await load(CK.ledger, [])) || []; }
async function cmtPushLedger(now) {
  const l = (await cmtLedger()).filter((t) => now - t < 36 * HOUR);
  l.push(now);
  await save({ [CK.ledger]: l });
  return l;
}
const cmtTodayN = async (now) => {
  const days = await cmtDays();
  return (days[GX.cmtDayKey(now)] || {}).posted || 0;
};
const cmtHourN = async (now) => (await cmtLedger()).filter((t) => t > now - HOUR).length;
const cmtSpendToday = async (now) => (await cmtDays())[GX.cmtDayKey(now)] ? ((await cmtDays())[GX.cmtDayKey(now)].cost || 0) : 0;

async function cmtHist() { return (await load(CK.hist, [])) || []; }
async function cmtPushHist(row, now) {
  let h = await cmtHist();
  h.unshift({ i: row.id, h: row.h || "", t: now, x: String(row.draft || "").slice(0, 300), r: row.replyId || "", s: row.src, c: row.cost || 0 });
  if (h.length > CMT_HIST_MAX) h.length = CMT_HIST_MAX;
  // Old entries keep their id, date and counts; only the text is dropped.
  for (const e of h) if (e.x && now - e.t > CMT_TEXT_KEEP) e.x = "";
  await save({ [CK.hist]: h });
}
// Your last replies: the model is told not to write anything like them again.
async function cmtRecent(n) { return (await cmtHist()).slice(0, n || 10).map((e) => e.x).filter(Boolean); }

async function cmtKey() { return String((await load(CK.key, "")) || ""); }

// ===========================================================================
// Telegram
// ===========================================================================
const TG_EVENTS = ["run", "warn", "fails", "break", "ready", "watch", "target", "reply", "daily"];
async function tgConf() {
  const t = (await load(CK.tg, null)) || {};
  t.on = Object.assign({ run: true, warn: true, fails: true, break: false, ready: true, watch: true, target: true, reply: true, daily: true }, t.on || {});
  t.dailyAt = GX.LIMITS && t.dailyAt ? t.dailyAt : (t.dailyAt || "22:00");
  return t;
}
async function tgSave(t) { await save({ [CK.tg]: t }); }

// One Telegram message. Never throws: a failed send must not stop a run.
async function tgSend(event, text, force) {
  try {
    const t = await tgConf();
    if (!t.token || !t.chat) return { ok: false, off: true };
    if (!force && event && t.on[event] === false) return { ok: false, off: true };
    const body = JSON.stringify({ chat_id: String(t.chat), text: String(text).slice(0, 3500), parse_mode: "HTML", disable_web_page_preview: true });
    let last = null;
    for (let i = 0; i < 2; i++) {
      try {
        const r = await fetch(TG_URL + encodeURIComponent(t.token) + "/sendMessage", { method: "POST", headers: { "content-type": "application/json" }, body });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.ok) { t.lastAt = Date.now(); t.lastOk = true; t.lastErr = ""; await tgSave(t); return { ok: true }; }
        last = (j && j.description) || ("HTTP " + r.status);
      } catch (e) { last = String(e.message || e); }
    }
    t.lastAt = Date.now(); t.lastOk = false; t.lastErr = String(last || "failed");
    await tgSave(t);
    return { ok: false, error: t.lastErr };
  } catch (_) { return { ok: false }; }
}

// ---- the automatic daily backup file ------------------------------------
// Once a day GrowX writes the whole comment history to Downloads/GrowX/. The
// browser copy can be wiped by removing the extension or clearing site data;
// this file brings every total and every post id back.
async function cmtAutoBackup(now) {
  if (!chrome.downloads) return;
  const meta = await load(K.meta, {});
  const day = GX.cmtDayKey(now);
  if (meta.cmtBackupDay === day) return;
  const days = await cmtDays();
  if (!Object.keys(days).length) return;            // nothing worth backing up yet
  meta.cmtBackupDay = day;
  await save({ [K.meta]: meta });
  try {
    const b = await cmtBackup();
    const url = "data:application/json;base64," + btoa(unescape(encodeURIComponent(JSON.stringify(b.data))));
    await chrome.downloads.download({ url, filename: `GrowX/growx-comments-${day}.json`, saveAs: false, conflictAction: "overwrite" });
    meta.cmtBackupAt = now;
    await save({ [K.meta]: meta });
  } catch (e) {
    await pushEvent("warn", "The daily comment backup could not be saved: " + String((e && e.message) || e));
  }
}

// The daily report, sent once a day at the time you set.
async function tgDailyReport(now) {
  const t = await tgConf();
  if (!t.token || !t.chat || t.on.daily === false) return;
  const [hh, mm] = String(t.dailyAt || "22:00").split(":").map(Number);
  const due = new Date(now); due.setHours(hh || 22, mm || 0, 0, 0);
  if (now < due.getTime()) return;
  const day = GX.cmtDayKey(now);
  if (t.dailyDay === day) return;
  t.dailyDay = day; await tgSave(t);
  const days = await cmtDays();
  const d = days[day] || {};
  const all = Object.values(days).reduce((a, x) => a + (x.posted || 0), 0);
  const s = await getSettings();
  const stats = await load(K.stats, {});
  await tgSend("daily", [
    "<b>GrowX - today</b>",
    `Replies ${d.posted || 0} · Drafts ${d.drafts || 0} · Skipped ${d.skipped || 0}`,
    `Follows ${dayEntries(await getLedger(), s, now).length} · Follow-backs ${await bkToday(now)} · Unfollows ${await unfToday(now)}`,
    `AI $${(d.cost || 0).toFixed(3)} · All-time replies ${all.toLocaleString()}`,
    stats && stats.followed ? `All-time follows ${Number(stats.followed).toLocaleString()}` : ""
  ].filter(Boolean).join("\n"), true);
}

// ===========================================================================
// The queue
// ===========================================================================
const cmtRow = (id, src, extra) => Object.assign({
  id: String(id), src: src || "links", st: "waiting", at: Date.now(), tries: 0, h: "", note: "",
  draft: "", rejects: [], cost: 0, liked: false
}, extra || {});

// Add posts to the queue. Returns what happened to every link, so the page can
// say "6 pasted · 1 duplicate · 1 already replied · 1 already in queue · 3 new".
async function cmtAdd(items, src, opts) {
  opts = opts || {};
  const q = await cmtQueue();
  const replied = await cmtReplied();
  const have = new Set(q.map((r) => String(r.id)));
  const out = { pasted: 0, dup: 0, already: 0, queued: 0, added: 0, mine: 0, rows: [] };
  const me = await cmtMyHandle();
  for (const it of items || []) {
    const id = typeof it === "string" ? GX.postId(it) : (it && GX.postId(it.id));
    if (!id) continue;
    out.pasted++;
    if (it && it.dup) { out.dup++; continue; }
    if (me && it && it.h && String(it.h).toLowerCase() === me) { out.mine++; continue; }   // v3.2: never your own post
    if (replied.has(id)) { out.already++; continue; }
    if (have.has(id)) { out.queued++; continue; }
    have.add(id);
    const row = cmtRow(id, src, { h: (it && it.h) || "", note: (it && it.note) || "", top: !!opts.top });
    if (opts.top) q.unshift(row); else q.push(row);
    out.added++;
    out.rows.push(row);
  }
  if (out.added) await cmtSaveQueue();
  return out;
}

// v3.2 the signed-in account's @name, lower-cased (from the account GrowX last read), or "".
async function cmtMyHandle() {
  const acc = await load(K.account, null);
  return acc && acc.handle ? String(acc.handle).toLowerCase() : "";
}
const cmtOpenRows = (q) => q.filter(GX.cmtOpen);
const cmtReadyRows = (q) => q.filter((r) => r.st === "ready");

// How many replies that author already got today (C5: same author, max N).
async function cmtAuthorToday(handle, now) {
  if (!handle) return 0;
  const cut = startOfToday(now);
  const h = String(handle).toLowerCase();
  return (await cmtHist()).filter((e) => e.t >= cut && String(e.h).toLowerCase() === h).length;
}

// ===========================================================================
// OpenAI
// ===========================================================================
const VISION_OK = (id) => /^gpt-(4o|4\.1|5)/.test(String(id || ""));

function cmtPostBlock(post, note) {
  const a = post.author || {};
  const lines = [
    `POST BY: @${a.h || "unknown"}${a.n ? " (" + a.n + ")" : ""}`,
    a.bio ? `THEIR BIO: ${a.bio}` : "",
    post.lang ? `LANGUAGE: ${post.lang}` : "",
    "",
    "THE POST:",
    post.text || "(no text)"
  ];
  if (post.quoted && post.quoted.text) lines.push("", `IT QUOTES @${(post.quoted.author && post.quoted.author.h) || "someone"}:`, post.quoted.text);
  if (post.parent && post.parent.text) lines.push("", `IT REPLIES TO @${(post.parent.author && post.parent.author.h) || "someone"}:`, post.parent.text);
  const alts = (post.media || []).map((m) => m.alt).filter(Boolean);
  if (alts.length) lines.push("", "IMAGES: " + alts.join(" | "));
  else if ((post.media || []).length) lines.push("", `IMAGES: ${post.media.length} attached`);
  if (post.card) lines.push("", "LINK CARD: " + post.card);
  if (note) lines.push("", "MY NOTE FOR THIS POST: " + note);
  return lines.filter((x) => x !== undefined).join("\n");
}

function cmtUserContent(s, post, note, extra) {
  const text = cmtPostBlock(post, note) + (extra ? "\n\n" + extra : "");
  const pics = s.cmtVision && VISION_OK(s.cmtModel) ? (post.media || []).filter((m) => m.type === "photo").slice(0, 2) : [];
  if (!pics.length) return text;
  return [{ type: "text", text }].concat(pics.map((m) => ({ type: "image_url", image_url: { url: m.url, detail: "low" } })));
}

// One call to OpenAI. Returns { ok, text, inTok, outTok, cost } or a classified failure.
//
// gpt-5* think before they answer, and that thinking is paid for out of the same
// budget as the reply. Given only a reply's worth of room they spend all of it
// thinking and hand back an empty message - which is what "the reply came back
// empty" was. So those models get their thinking turned down and room for it on
// top of the words we actually want, and an empty answer is tried once more with
// much more room before it counts as a failure.
const AI_THINK = 1400;
// The model every reply falls back to when the one you picked hands back nothing.
// It does not think before it answers, so it cannot run out of budget doing so.
const AI_FALLBACK = "gpt-4.1-mini";

async function aiCall(s, key, messages, opts) {
  opts = opts || {};
  const want = opts.max || 160;
  const five = GX.isGpt5(s.cmtModel);
  let effortOk = true, room = want + (opts.reserve == null ? AI_THINK : opts.reserve);
  let spent = 0, inTok = 0, outTok = 0;

  for (let attempt = 0; attempt < 3; attempt++) {
    const body = { model: s.cmtModel, messages, n: 1 };
    if (five) {
      body.max_completion_tokens = room;
      if (effortOk) body.reasoning_effort = opts.effort || "minimal";
    } else {
      body.max_tokens = want;
      body.temperature = s.cmtTemp;
    }
    let res, j;
    try {
      res = await fetch(AI_URL, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + key }, body: JSON.stringify(body) });
      j = await res.json().catch(() => ({}));
    } catch (e) {
      return { ok: false, kind: "transient", message: "Could not reach api.openai.com.", cost: spent, inTok, outTok };
    }
    if (!res.ok) {
      const msg = (j && j.error && j.error.message) || ("HTTP " + res.status);
      // An older model that has never heard of reasoning_effort: drop it and retry.
      if (res.status === 400 && effortOk && /reasoning_effort/.test(msg)) { effortOk = false; continue; }
      if (res.status === 401 || res.status === 403) return { ok: false, kind: "aikey", message: "OpenAI refused the key: " + msg, cost: spent, inTok, outTok };
      if (res.status === 429) return { ok: false, kind: "airate", message: "OpenAI is rate limiting or out of credit: " + msg, waitMs: 5 * MIN, cost: spent, inTok, outTok };
      if (res.status >= 500) return { ok: false, kind: "transient", message: "OpenAI error: " + msg, cost: spent, inTok, outTok };
      return { ok: false, kind: "ai", message: "OpenAI: " + msg, cost: spent, inTok, outTok };
    }
    const choice = (j.choices && j.choices[0]) || {};
    const text = String((choice.message && choice.message.content) || "").trim();
    const u = j.usage || {};
    const ti = Number(u.prompt_tokens) || 0, to = Number(u.completion_tokens) || 0;
    inTok += ti; outTok += to;
    spent += GX.replyCost(s.cmtModel, ti, to);
    if (text) return { ok: true, text, inTok, outTok, cost: spent };

    const why = choice.finish_reason || "";
    if (why === "content_filter") return { ok: false, kind: "skip", message: "OpenAI's own filter blocked a reply to this post", cost: spent, inTok, outTok };
    // Empty because the thinking ate the budget: give it far more room, once.
    if (five && room < want + 6000) { room = want + 6000; continue; }
    return { ok: false, kind: "transient", empty: true, message: why === "length"
      ? `${s.cmtModel} used its whole budget thinking and wrote nothing`
      : "OpenAI sent back an empty reply", cost: spent, inTok, outTok };
  }
  return { ok: false, kind: "transient", empty: true, message: "OpenAI sent back an empty reply", cost: spent, inTok, outTok };
}

// Write one reply for a post: optionally read the post first, then write, then
// check it against your rules and ask again - naming the broken rules - until it
// passes or your rewrite limit is used up.
async function cmtDraft(s, key, row, recent) {
  const post = row.post;
  const system = row.src === "back" ? s.cmtBackPrompt : s.cmtPrompt;
  let spent = 0, inTok = 0, outTok = 0;
  const rejects = [];
  let read = "";
  let usedModel = s.cmtModel;
  let work = s;                      // swapped for the fallback model if need be

  if (s.cmtTwoStep) {
    const r = await aiCall(s, key, [
      { role: "system", content: "in one short line, say what this post is about, the mood, and one specific thing worth reacting to. no reply, just the line." },
      { role: "user", content: cmtUserContent(s, post, row.note) }
    ], { max: 80 });
    // The read is only extra context. A key or billing problem still stops
    // everything, but a model that says nothing here is no reason to give up on
    // the reply - it is written from the post itself instead.
    if (!r.ok && ["aikey", "airate", "ai"].includes(r.kind)) return r;
    spent += r.cost || 0; inTok += r.inTok || 0; outTok += r.outTok || 0;
    if (r.ok) read = r.text;
    // It already answered with nothing here - don't pay it to do that again below.
    else if (r.empty && work.cmtModel !== AI_FALLBACK) { work = Object.assign({}, work, { cmtModel: AI_FALLBACK }); usedModel = AI_FALLBACK; }
  }

  // Your prompt leads; the voice settings (language, tone, mood, length) are added
  // under it as a short block, so the two can never contradict each other.
  const style = GX.styleBlock(s, { lang: post.lang });
  const base = [
    { role: "system", content: style ? [system, style].join("\n\n") : system },
    recent.length ? { role: "system", content: "MY LAST REPLIES (write nothing like these):\n" + recent.map((x) => "- " + x).join("\n") } : null,
    { role: "user", content: cmtUserContent(s, post, row.note, read ? "WHAT THIS POST IS ABOUT: " + read : "") }
  ].filter(Boolean);

  const tries = Math.max(1, s.cmtRewrites + 1);
  for (let i = 0; i < tries; i++) {
    const msgs = base.slice();
    if (rejects.length) {
      const last = rejects[rejects.length - 1];
      msgs.push({ role: "assistant", content: last.text });
      msgs.push({ role: "user", content: "that reply broke my rules: " + last.broke.join("; ") + ". write a different one that does not." });
    }
    let r = await aiCall(work, key, msgs);
    // The model you picked wrote nothing at all. Rather than failing the post,
    // the same request goes to a model that always writes words - and the rest
    // of this draft's rewrites go straight to it, so you are not charged twice
    // over for a model that has already shown it answers with nothing.
    if (!r.ok && r.empty && work.cmtModel !== AI_FALLBACK) {
      spent += r.cost || 0; inTok += r.inTok || 0; outTok += r.outTok || 0;
      const alt = Object.assign({}, work, { cmtModel: AI_FALLBACK });
      const r2 = await aiCall(alt, key, msgs);
      if (r2.ok) { r = r2; work = alt; usedModel = AI_FALLBACK; }
      else { r = r2; }
    }
    // Both the model you picked and the fallback answered with nothing: say so,
    // naming the model you chose rather than the one GrowX reached for.
    if (!r.ok && r.empty && usedModel !== s.cmtModel) r.message = `${s.cmtModel} and ${AI_FALLBACK} both sent back nothing`;
    if (!r.ok) return Object.assign(r, { cost: spent + (r.cost || 0), inTok: inTok + (r.inTok || 0), outTok: outTok + (r.outTok || 0), model: usedModel });
    spent += r.cost; inTok += r.inTok; outTok += r.outTok;
    const chk = GX.checkReply(r.text, s, { post: post.text, recent });
    if (chk.skip) return { ok: false, kind: "skip", message: "the model answered SKIP (off topic)", cost: spent, inTok, outTok };
    if (chk.ok) return { ok: true, text: chk.text, cost: spent, inTok, outTok, rejects, read, model: usedModel };
    rejects.push({ text: chk.text || r.text, broke: chk.broke });
  }
  return { ok: false, kind: "rules", message: `${rejects.length} drafts broke the rules (${(rejects[rejects.length - 1] || {}).broke?.join(", ") || "rule check"})`, cost: spent, inTok, outTok, rejects, model: usedModel };
}

// ===========================================================================
// Where posts come from, besides the links you paste
// ===========================================================================
// Ask the x.com tab for something, with the account guard every action uses.
const cmtAsk = (job, msg) => sendTab(job.tabId, Object.assign({ owner: job.ownerId }, msg));

async function cmtWatchStep(job, s, now) {
  if (!s.cmtSrcWatch) return 0;
  const list = await cmtWatch();
  const due = list.filter((w) => w.on !== false && w.id && now - (w.at || 0) >= s.cmtWatchEvery * MIN);
  if (!due.length) return 0;
  let added = 0;
  for (const w of due.slice(0, 3)) {
    w.at = now;
    const fw = GX.waitFetch(s);
    if (fw) await sleep(Math.min(fw, 10 * MIN));
    if (!ACTIVE.has(job.status)) return added;
    const r = await cmtAsk(job, { gx: "cmtPosts", userId: w.id, count: 10, withReplies: !!s.cmtWatchReplies });
    if (!r || !r.ok) { w.err = (r && r.message) || "could not read"; continue; }
    w.err = "";
    const fresh = (r.posts || []).filter((p) => {
      if (!p.at || now - p.at > s.cmtWatchAge * MIN) return false;
      if (!s.cmtWatchReplies && p.isReply) return false;
      if (p.isRepost) return false;
      return true;
    });
    const madeToday = await cmtAuthorToday(w.h, now);
    const room = Math.max(0, s.cmtWatchMax - madeToday);
    const take = fresh.slice(0, room);
    if (take.length) {
      const got = await cmtAdd(take.map((p) => ({ id: p.id, h: p.author.h })), "watch", { top: true });
      added += got.added;
      if (got.added) {
        w.last = take[0].at;
        w.lastDraft = now;
        await pushEvent("cmt", `Watch list: @${w.h} posted - ${got.added} new ${got.added === 1 ? "post" : "posts"} went to the front of the queue.`);
        await notify("cmtwatch", "@" + w.h + " posted", "GrowX is writing a reply now.");
        await tgSend("watch", `<b>@${w.h} posted</b>\nGrowX is writing a reply.\n${GX.postUrl(take[0].id, w.h)}`);
      }
    }
  }
  await cmtSaveWatch();
  return added;
}

async function cmtTargetStep(job, s, now) {
  if (!s.cmtSrcTarget) return 0;
  const list = await cmtTargets();
  // Only accounts GrowX already followed get a reply draft - the follow itself is
  // done by Follow mode, with its pacing, its daily number and its following cap.
  const idx = await getFollowIndex();
  let added = 0;
  for (const t of list) {
    if (added >= 3) break;
    if (t.done || !t.id) continue;
    if (!t.followed) { if (idx.has(String(t.id))) { t.followed = now; } else continue; }
    if (now - (t.at || 0) < 10 * MIN) continue;
    t.at = now;
    const fw = GX.waitFetch(s);
    if (fw) await sleep(Math.min(fw, 10 * MIN));
    if (!ACTIVE.has(job.status)) return added;
    const r = await cmtAsk(job, { gx: "cmtPosts", userId: t.id, count: 15, withReplies: !!s.cmtTargetReplies });
    if (!r || !r.ok) { t.err = (r && r.message) || "could not read"; continue; }
    t.err = "";
    const cut = now - s.cmtTargetAge * DAY;
    const p = (r.posts || []).find((x) => x.at >= cut && (s.cmtTargetReplies || !x.isReply) && !(s.cmtTargetSkipRT && x.isRepost));
    if (!p) { t.done = "no recent post"; continue; }
    const got = await cmtAdd([{ id: p.id, h: p.author.h }], "target");
    if (got.added) { t.post = p.id; t.done = ""; t.queued = now; added += got.added; }
    else t.done = got.already ? "already replied" : "";
  }
  await cmtSaveTargets();
  return added;
}

async function cmtBackStep(job, s, now) {
  if (!s.cmtSrcBack) return 0;
  if (job.cmtBackAt && now - job.cmtBackAt < 10 * MIN) return 0;
  job.cmtBackAt = now;
  const r = await cmtAsk(job, { gx: "cmtMentions", since: now - s.cmtBackHours * HOUR });
  if (!r || !r.ok) return 0;
  const hist = await cmtHist();
  const answered = new Set(hist.map((e) => String(e.i)));
  const perPost = {};
  const want = [];
  for (const m of r.replies || []) {
    if (answered.has(String(m.id))) continue;
    const key = m.parentId + "|" + (m.author && m.author.id);
    perPost[key] = (perPost[key] || 0) + 1;
    if (perPost[key] > s.cmtBackMax) continue;
    // Obvious spam and abuse never get an answer.
    const txt = String(m.text || "").toLowerCase();
    if (/\b(free followers|dm me|click here|airdrop|giveaway|t\.me\/|bit\.ly)\b/.test(txt)) continue;
    if ((m.author && m.author.followers) === 0 && txt.length < 8) continue;
    want.push({ id: m.id, h: (m.author && m.author.h) || "" });
  }
  if (!want.length) return 0;
  const got = await cmtAdd(want.slice(0, 10), "back");
  if (got.added) await pushEvent("cmt", `Reply-back: ${got.added} new ${got.added === 1 ? "reply" : "replies"} on your posts went into the queue.`);
  return got.added;
}

// Keep the queue fed. Runs between replies, never during one.
async function cmtTopUp(job, s, now) {
  let n = 0;
  try { n += await cmtWatchStep(job, s, now); } catch (_) {}
  try { n += await cmtTargetStep(job, s, now); } catch (_) {}
  try { n += await cmtBackStep(job, s, now); } catch (_) {}
  return n;
}

// ===========================================================================
// Is there anything for Comment mode to do?
// ===========================================================================
async function cmtHasWork(s, now) {
  if (!s.cmtOn) return false;                       // the master switch on the Comment page
  if ((await cmtTodayN(now)) >= s.cmtDaily) return false;
  if ((await cmtSpendToday(now)) >= s.cmtSpendCents / 100) return false;
  if (!(await cmtKey())) return false;
  const q = await cmtQueue();
  if (cmtOpenRows(q).length) return true;
  // Nothing waiting, but a live source can still bring something in.
  return !!(s.cmtSrcWatch && (await cmtWatch()).some((w) => w.on !== false))
    || !!(s.cmtSrcTarget && (await cmtTargets()).some((t) => !t.done))
    || !!s.cmtSrcBack;
}

// ===========================================================================
// One step of Comment mode
// ===========================================================================
const CMT_SKIP_WORD = {
  replied: "already replied", mine: "your own post", old: "older than your limit",
  limited: "replies are limited", gone: "deleted or unavailable", author: "that author's daily number is used up",
  offtopic: "off your prompt's topic", liked: "already liked"
};

async function cmtFinishRow(row, st, why, now) {
  row.st = st;
  row.doneAt = now;
  if (st === "skipped") row.skip = why;
  if (st === "failed") row.fail = why;
  await cmtSaveQueue();
  // skipped and failed go in the record too - not only the replies that worked
  if (st === "skipped" || st === "failed") {
    await actLog({ mode: "comment", act: st, h: row.h, i: row.id, ok: false, why, extra: { post: GX.postUrl(row.id, row.h) } });
  }
}

async function commentStep(job, s, now) {
  // ---- 0. the master switch and the key ---------------------------------
  if (!s.cmtOn) {
    rest(job, "empty", now + 30 * MIN, "Comment mode is switched off. Turn it on at the top of the Comment page.");
    logLine(job, "", "wait", "Comment mode is off");
    return park(job, s, job.restUntil, false);
  }
  const key = await cmtKey();
  if (!key) {
    rest(job, "empty", now + 30 * MIN, "Comment mode needs your OpenAI key. Add it on the Comment settings page, then press Start.");
    logLine(job, "", "wait", "no OpenAI key");
    return park(job, s, job.restUntil, false);
  }

  // ---- 1. the day's AI spend cap ---------------------------------------
  const spent = await cmtSpendToday(now);
  const cap = s.cmtSpendCents / 100;
  if (spent >= cap) {
    const at = startOfToday(now) + DAY + rand(60000, 240000);
    if (!job.cmtCapNoted) {
      job.cmtCapNoted = true;
      await notify("cmtcap", "GrowX reached your AI spend cap", `$${spent.toFixed(3)} spent today. Drafting starts again tomorrow.`);
      await tgSend("warn", `<b>AI spend cap reached</b>\n$${spent.toFixed(3)} of $${cap.toFixed(2)} today. Comment mode is off until tomorrow.`);
    }
    if (await beginSwitch(job, s, now, "comment", `AI spend cap of $${cap.toFixed(2)} reached.`)) { await chrome.storage.local.remove(GX.CK.focus); return park(job, s, job.restUntil, true); }
    rest(job, "daily", at, `AI spend cap of $${cap.toFixed(2)} reached ($${spent.toFixed(3)} today). Comment mode continues at ${clock(at)}.`);
    return park(job, s, job.restUntil, false);
  }
  job.cmtCapNoted = false;

  // ---- 2. the day's and this turn's numbers ----------------------------
  const todayN = await cmtTodayN(now);
  const focus = await load(GX.CK.focus, null);          // v3.2 started with links from the Comment page
  if (!focus && await turnOver(job, s, now, "comment")) return park(job, s, job.restUntil, true);
  if (todayN >= s.cmtDaily) {
    const msg = `Daily goal of ${s.cmtDaily} replies reached.`;
    if (await beginSwitch(job, s, now, "comment", msg)) { await chrome.storage.local.remove(GX.CK.focus); return park(job, s, job.restUntil, true); }
    await notify("milestone", "GrowX finished commenting", `${todayN} replies posted today.`);
    await tgSend("run", `<b>Comment goal reached</b>\n${todayN} replies posted today.`);
    return finishJob(job, "done", `${msg} Stopped, as you set.${nextStartText(s)}`);
  }

  // ---- 3. this hour ----------------------------------------------------
  const L = GX.hourlyCap(s, "comment");
  const led = await cmtLedger();
  const inHour = led.filter((t) => t > now - HOUR);
  if (inHour.length >= L.cap) {
    const freeAt = inHour[inHour.length - L.cap] + HOUR + rand(20000, 90000);
    rest(job, "hourly", freeAt, `Hourly pace of ${L.cap} replies reached. Back at ${clock(freeAt)}.`);
    return park(job, s, job.restUntil, false);
  }

  // ---- 4. breaks -------------------------------------------------------
  const rBase = restKey(s, "comment");
  if (job.cmtRestBase !== rBase || !job.cmtRestAfter) { job.cmtRestBase = rBase; job.cmtRestAfter = restAfter(s, "comment"); }
  if (job.cmtSince >= (job.cmtRestAfter || Infinity)) {
    const ms = GX.breakMs(s, "comment");
    rest(job, "cooldown", now + ms, `Break after ${plural(job.cmtSince, "reply")} (${breakText(s, "comment", ms)}). Back at ${clock(now + ms)}.`);
    job.cmtSince = 0;
    job.cmtRestAfter = restAfter(s, "comment");
    logLine(job, "", "wait", `break ${Math.round(ms / 60000)} min`);
    await tgSend("break", `<b>Comment break</b>\n${breakText(s, "comment", ms)} - back at ${clock(now + ms)}.`);
    return park(job, s, job.restUntil, false);
  }

  // ---- 5. the wait between replies -------------------------------------
  if (job.nextAt && now < job.nextAt) return park(job, s, job.nextAt, false);

  // ---- 6. keep the queue fed -------------------------------------------
  let q = await cmtQueue();
  if (cmtOpenRows(q).length < Math.max(3, Math.round(s.cmtReady / 2))) {
    const got = await cmtTopUp(job, s, now);
    if (got) { q = await cmtQueue(); now = Date.now(); }
  }

  // ---- 7. pick the next row --------------------------------------------
  const draftOnly = s.cmtPublish === "draft";
  // Started with links: once none of the rows that were there at the start is left open, those links are done -
  // rows the watch list / targets / reply-back added later don't keep the focus (and its turn bypass) alive.
  if (focus && !q.some((r) => GX.cmtOpen(r) && !(draftOnly && r.st === "ready") && (r.at || 0) <= (focus.at || 0))) return cmtFocusDone(job, s, now);
  const ready = cmtReadyRows(q);
  // Auto publishing: a draft that is waiting is posted before a new one is written.
  let row = !draftOnly ? ready[0] : null;
  if (!row) row = q.find((r) => r.st === "waiting" || r.st === "reading" || r.st === "writing" || (r.st === "posting" && r.tries < 3));
  if (!row && draftOnly && ready.length >= s.cmtReady) {
    rest(job, "cap", now + 15 * MIN, `${plural(ready.length, "draft")} ready and waiting for you - that is the number you asked GrowX to keep ready.`);
    return park(job, s, job.restUntil, false);
  }
  if (!row) {
    const live = (s.cmtSrcWatch && (await cmtWatch()).some((w) => w.on !== false)) || (s.cmtSrcTarget && (await cmtTargets()).some((t) => !t.done)) || s.cmtSrcBack;
    const until = now + (live ? Math.max(1, s.cmtWatchEvery) * MIN : 20 * MIN);
    if (!live && !job.cmtEmptyNoted) {
      job.cmtEmptyNoted = true;
      await notify("cmtempty", "GrowX needs post links", "Paste a few post links on the Comment page and GrowX carries on.");
    }
    if (focus) return cmtFocusDone(job, s, now);
    if (GX.cycling(s) && await beginSwitch(job, s, now, "comment", "Comment: nothing left in the queue.", { turn: true })) return park(job, s, job.restUntil, true);
    rest(job, "empty", until, live
      ? `Nothing to reply to right now. GrowX looks for new posts again at ${clock(until)}.`
      : "The comment queue is empty. Paste post links on the Comment page, or switch on the watch list.");
    return park(job, s, job.restUntil, false);
  }
  job.cmtEmptyNoted = false;

  // ---- 8. a ready draft: post it ---------------------------------------
  if (row.st === "ready" || row.st === "posting") return cmtPublish(job, s, now, row, key);

  // ---- 9. read the post, then write ------------------------------------
  return cmtPrepare(job, s, now, row, key);
}

// Every link you started with is done: say so plainly. With a mode sequence the next mode takes over.
async function cmtFocusDone(job, s, now) {
  await chrome.storage.local.remove(GX.CK.focus);
  const msg = `All your links are done - ${plural(job.cdone || 0, "reply")} posted this run.`;
  await pushEvent("cmt", msg);
  await notify("milestone", "GrowX: comment links done", msg);
  if (GX.cycling(s) && await beginSwitch(job, s, now, "comment", msg, { turn: true })) return park(job, s, job.restUntil, true);
  return finishJob(job, "done", msg);
}

// Read one post, run the skip checks, write the reply.
async function cmtPrepare(job, s, now, row, key) {
  row.st = "reading";
  row.tries = (row.tries || 0) + 1;
  job.current = { h: row.h, i: row.id, src: row.src };
  job.message = `Reading the post${row.h ? " by @" + row.h : ""}...`;
  await cmtSaveQueue();
  if (!await commitJob(job) || !ACTIVE.has(job.status)) return;

  const replied = await cmtReplied();
  if (replied.has(String(row.id))) {
    await cmtFinishRow(row, "skipped", CMT_SKIP_WORD.replied, now);
    await cmtBump({ skipped: 1 }, now);
    logLine(job, row.h, "skip", "already replied");
    job.skipped = (job.skipped || 0) + 1;
    job.nextAt = now + rand(1500, 4000);
    return park(job, s, job.nextAt, false);
  }

  // the pause before the post itself is read - your "Before reading the post"
  const readWait = GX.waitRead(s);
  if (readWait) await sleep(Math.min(readWait, 10 * MIN));
  if (!ACTIVE.has(job.status)) return;

  const r = await cmtAsk(job, { gx: "cmtRead", id: row.id });
  now = Date.now();
  if (r && r.uid && job.ownerId && r.uid !== job.ownerId) { await haltFor(job, "account"); return park(job, s, Infinity, false); }
  if (!r || !r.ok) {
    if (r && r.kind === "gone") {
      await cmtFinishRow(row, "skipped", CMT_SKIP_WORD.gone, now);
      await cmtBump({ skipped: 1 }, now);
      job.skipped = (job.skipped || 0) + 1;
      logLine(job, row.h, "skip", "post unavailable");
      job.nextAt = now + rand(1500, 4000);
      return park(job, s, job.nextAt, false);
    }
    if (isRate(r)) return readRate(job, s, now, r, "Reading posts");
    row.st = "waiting";
    await cmtSaveQueue();
    return cmtFail(job, s, now, r, row.h || row.id, { noun: "post read", read: true });
  }
  readOk(job);
  const post = r.post;
  row.h = row.h || (post.author && post.author.h) || "";
  row.post = {
    text: String(post.text || "").slice(0, 4000), author: post.author, at: post.at, lang: post.lang,
    media: post.media, card: post.card, quoted: post.quoted, parent: post.parent,
    likes: post.likes, replies: post.replies, views: post.views
  };

  // ---- the skip checks -------------------------------------------------
  const skip = await (async () => {
    if (post.repliedByMe) return "replied";
    // v3.2: never a reply on your own post - whatever the source (the author is checked on the post itself).
    if (job.ownerId && post.author && String(post.author.id) === String(job.ownerId)) return "mine";
    { const me = await cmtMyHandle(); if (me && post.author && String(post.author.h || "").toLowerCase() === me) return "mine"; }
    if (post.at && now - post.at > s.cmtMaxAgeDays * DAY) return "old";
    if (s.cmtSkipLimited && post.limited) return "limited";
    if (s.cmtSkipLiked && post.liked) return "liked";
    if ((await cmtAuthorToday(row.h, now)) >= s.cmtAuthorMax) return "author";
    return null;
  })();
  if (skip) {
    if (skip === "replied") await cmtMarkReplied(row.id);
    await cmtFinishRow(row, "skipped", CMT_SKIP_WORD[skip], now);
    await cmtBump({ skipped: 1 }, now);
    job.skipped = (job.skipped || 0) + 1;
    logLine(job, row.h, "skip", CMT_SKIP_WORD[skip]);
    job.message = `@${row.h || row.id} skipped - ${CMT_SKIP_WORD[skip]}.`;
    job.nextAt = now + rand(2000, 5000);
    return park(job, s, job.nextAt, false);
  }

  // ---- write it --------------------------------------------------------
  row.st = "writing";
  job.message = `Writing a reply for @${row.h || row.id}...`;
  await cmtSaveQueue();
  if (!await commitJob(job) || !ACTIVE.has(job.status)) return;

  // the thinking pause before the model is asked - your "Before the reply is written"
  const genWait = GX.waitGen(s);
  if (genWait) await sleep(Math.min(genWait, 10 * MIN));
  if (!ACTIVE.has(job.status)) return;

  const recent = await cmtRecent(10);
  const d = await cmtDraft(s, key, row, recent);
  now = Date.now();
  row.cost = (row.cost || 0) + (d.cost || 0);
  row.model = d.model || s.cmtModel;
  if (d.model && d.model !== s.cmtModel) {
    row.fellBack = d.model;
    if (!job.cmtSaidFallback) {
      job.cmtSaidFallback = true;
      await pushEvent("warn", `${s.cmtModel} kept answering with nothing, so GrowX wrote this reply with ${d.model}. Pick ${d.model} in Comment settings to stop paying for both.`);
    }
  }
  row.inTok = (row.inTok || 0) + (d.inTok || 0);
  row.outTok = (row.outTok || 0) + (d.outTok || 0);
  if (d.cost) await cmtBump({ cost: d.cost }, now);
  row.rejects = (d.rejects || []).map((x) => ({ t: x.text, b: x.broke }));
  if (d.read) row.read = d.read;

  if (!d.ok) {
    if (d.kind === "skip") {
      await cmtFinishRow(row, "skipped", CMT_SKIP_WORD.offtopic, now);
      await cmtBump({ skipped: 1 }, now);
      job.skipped = (job.skipped || 0) + 1;
      logLine(job, row.h, "skip", "off topic");
      job.nextAt = now + rand(2000, 6000);
      return park(job, s, job.nextAt, false);
    }
    if (d.kind === "aikey" || d.kind === "ai") {
      job.status = "halted"; job.haltKind = "errors";
      job.message = d.message;
      await pushEvent("warn", d.message);
      await notify("halt", "GrowX: the AI call failed", d.message);
      await tgSend("warn", "<b>GrowX stopped</b>\n" + d.message);
      return park(job, s, Infinity, false);
    }
    if (d.kind === "airate") {
      const until = now + (d.waitMs || 5 * MIN);
      rest(job, "read", until, `OpenAI asked for a pause (${d.message}). Back at ${clock(until)}.`);
      return park(job, s, job.restUntil, false);
    }
    // Nothing came back at all - the network, or a model that answered with
    // nothing. That is not this post's fault and not a rule you could loosen, so
    // the post waits its turn again instead of being written off as Failed.
    if (d.kind === "transient") {
      row.st = "waiting";
      row.tries = (row.tries || 0) + 1;
      if (row.tries >= 4) {
        await cmtFinishRow(row, "failed", d.message || "the model sent nothing back", now);
        await cmtBump({ failed: 1 }, now);
        job.failed = (job.failed || 0) + 1;
      }
      await cmtSaveQueue();
      logLine(job, row.h, "fail", d.message || "the model sent nothing back");
      job.message = d.message || "The model sent nothing back - trying the next post.";
      await pushEvent("warn", job.message);
      job.nextAt = now + rand(8000, 20000);
      return park(job, s, job.nextAt, false);
    }
    // The rules were never met: the row is marked Failed and the next post goes ahead.
    await cmtFinishRow(row, "failed", d.message || "the rule check failed", now);
    await cmtBump({ failed: 1 }, now);
    job.failed = (job.failed || 0) + 1;
    job.cmtFails = (job.cmtFails || 0) + 1;
    logLine(job, row.h, "fail", d.message || "rule check failed");
    if (job.cmtFails >= s.cmtFailStop) {
      job.cmtFails = 0;
      job.status = "paused";
      job.message = `${s.cmtFailStop} drafts in a row failed the rule check. Paused - loosen a rule or change the prompt, then press Resume.`;
      await pushEvent("warn", job.message);
      await notify("halt", "GrowX paused", job.message);
      await tgSend("fails", "<b>GrowX paused</b>\n" + job.message);
      return park(job, s, Infinity, false);
    }
    job.nextAt = now + rand(3000, 8000);
    return park(job, s, job.nextAt, false);
  }

  job.cmtFails = 0;
  row.draft = d.text;
  row.st = "ready";
  row.readyAt = now;
  await cmtSaveQueue();
  await cmtBump({ drafts: 1 }, now);
  logLine(job, row.h, "ok", "draft ready");

  const readyN = cmtReadyRows(await cmtQueue()).length;
  if (s.cmtPublish === "draft") {
    job.cmtDrafts = (job.cmtDrafts || 0) + 1;
    job.message = `Draft ready for @${row.h || row.id}. ${plural(readyN, "draft")} waiting for you.`;
    if (readyN && readyN % 10 === 0) {
      await notify("cmtready", "GrowX has drafts ready", `${readyN} replies are written and waiting for you.`);
      await tgSend("ready", `<b>${readyN} drafts ready</b>\nOpen GrowX to post them.`);
    }
    job.nextAt = now + Math.max(2000, GX.waitApprove(s));
    return park(job, s, job.nextAt, false);
  }
  // Auto publishing carries straight on to the post, with the waits in between.
  return cmtPublish(job, s, now, row, key);
}

// Like (optional), wait, post the reply, wait, confirm it on X.
async function cmtPublish(job, s, now, row, key) {
  if (!row.draft) { row.st = "waiting"; await cmtSaveQueue(); job.nextAt = now + 2000; return park(job, s, job.nextAt, false); }
  row.st = "posting";
  row.tries = (row.tries || 0) + 1;
  await cmtSaveQueue();

  // ---- the like, and the pause between the like and the reply ----------
  if (s.cmtLike && !row.liked) {
    const lr = await cmtAsk(job, { gx: "cmtLike", id: row.id });
    if (lr && lr.ok) { row.liked = true; await cmtSaveQueue(); }
    const wait = GX.waitLike(s);
    job.message = `Liked @${row.h || row.id}'s post. Replying in ${Math.round(wait / 1000)}s...`;
    await commitJob(job);
    await sleep(Math.min(wait, 120000));
  }

  // ---- the pause after the post is open, before the reply is written in --
  const openWait = GX.waitOpen(s);
  if (openWait) {
    job.message = `Opening the reply box for @${row.h || row.id}...`;
    await commitJob(job);
    await sleep(Math.min(openWait, 60000));
  }

  // ---- the pause right before it is sent --------------------------------
  const postWait = GX.waitPost(s);
  job.message = `Posting the reply to @${row.h || row.id}...`;
  job.inFlight = { i: row.id, h: row.h, at: Date.now() };
  await commitJob(job);
  if (postWait) await sleep(Math.min(postWait, 60000));

  let r = await cmtAsk(job, { gx: "cmtReply", id: row.id, text: row.draft });
  // X refused the direct request: do it on the post page instead, the way a
  // person does - open the reply box, type, wait, press Reply.
  if (r && !r.ok && ["endpoint", "transient", "unknown"].includes(r.kind) && row.tries <= 2) {
    const moved = await navigate(job.tabId, GX.postUrl(row.id, row.h), /\/status\/\d+/, 30000).catch(() => null);
    if (moved !== false) {
      r = await cmtAsk(job, { gx: "cmtReplyPage", id: row.id, text: row.draft, waits: { open: GX.waitOpen(s), post: GX.waitPost(s) } });
    }
  }
  job.inFlight = null;
  now = Date.now();
  if (r && r.uid && job.ownerId && r.uid !== job.ownerId) { await haltFor(job, "account"); return park(job, s, Infinity, false); }

  if (!r || !r.ok) {
    if (["automation", "auth", "locked", "suspended", "challenge", "captcha"].includes(r && r.kind)) {
      logLine(job, row.h, "fail", r.kind);
      row.st = "ready"; await cmtSaveQueue();
      await tgSend("warn", `<b>X pushed back</b>\nGrowX stopped commenting: ${r.message || r.kind}.`);
      await haltFor(job, r.kind === "challenge" || r.kind === "captcha" ? "locked" : r.kind, r.message, r.waitMs);
      return park(job, s, Infinity, false);
    }
    if (r && r.kind === "gone") {
      await cmtFinishRow(row, "skipped", CMT_SKIP_WORD.limited, now);
      await cmtBump({ skipped: 1 }, now);
      job.skipped = (job.skipped || 0) + 1;
      logLine(job, row.h, "skip", r.message || "cannot reply to this post");
      job.nextAt = now + rand(2000, 6000);
      return park(job, s, job.nextAt, false);
    }
    if (row.tries >= 3) {
      await cmtFinishRow(row, "failed", (r && r.message) || "X refused the reply", now);
      await cmtBump({ failed: 1 }, now);
      job.failed = (job.failed || 0) + 1;
    } else { row.st = "ready"; await cmtSaveQueue(); }
    return cmtFail(job, s, now, r, row.h || row.id, { noun: "reply", read: false });
  }

  // ---- confirm it on X before it counts ---------------------------------
  let replyId = r.id || "";
  if (!r.duplicate) {
    await sleep(rand(1200, 2600));
    const c = await cmtAsk(job, { gx: "cmtConfirm", id: row.id, replyId });
    if (c && c.ok && c.found) replyId = c.id || replyId;
    else if (c && c.ok && !c.found && !replyId) {
      // X answered but the reply is not there: try the row again rather than
      // marking something Posted that nobody can see.
      row.st = "ready"; await cmtSaveQueue();
      job.nextAt = now + rand(20000, 50000);
      job.message = "X did not show the reply yet - GrowX checks again shortly.";
      return park(job, s, job.nextAt, false);
    }
  }

  // ---- it is posted -----------------------------------------------------
  row.st = "posted";
  row.replyId = replyId;
  row.postedAt = now;
  row.doneAt = now;
  await cmtSaveQueue();
  await cmtMarkReplied(row.id);
  await cmtPushLedger(now);
  await cmtBump({ posted: 1 }, now, row.src);
  await cmtPushHist(row, now);
  await ladOk(job, s, now);
  job.cdone = (job.cdone || 0) + 1;
  job.turnDone = (job.turnDone || 0) + 1;
  job.cmtSince = (job.cmtSince || 0) + 1;
  job.cmtFails = 0;
  job.lastReply = { h: row.h, id: row.id, at: now, text: row.draft };
  logLine(job, row.h, "ok", "replied");
  await bumpStats({ replied: 1 });

  const todayN = await cmtTodayN(now);
  const delay = rand(s.cmtMinDelay, s.cmtMaxDelay) * 1000;
  job.nextAt = now + delay;
  job.message = `Replied to @${row.h || row.id}. Next in ${Math.round(delay / 1000)}s${job.cmtRestAfter && job.cmtRestAfter !== Infinity ? ` · ${job.cmtSince} of ${job.cmtRestAfter} before the break` : ""}.`;
  if (todayN % 25 === 0) await notify("milestone", "GrowX milestone", `${todayN} replies posted today.`);
  await actLog({ mode: "comment", act: "reply", h: row.h, i: row.id, why: "source: " + row.src, extra: { text: row.draft, post: GX.postUrl(row.id, row.h), cost: row.cost || 0, model: row.model || "" } });
  if (row.src === "watch" || row.src === "back") await tgSend("reply", `<b>Replied to @${row.h}</b>\n${row.draft}\n${GX.postUrl(row.id, row.h)}`);

  if (await turnOver(job, s, Date.now(), "comment")) return park(job, s, job.restUntil, true);
  if (todayN >= s.cmtDaily) {
    const msg = `Daily goal of ${s.cmtDaily} replies reached.`;
    if (await beginSwitch(job, s, Date.now(), "comment", msg)) return park(job, s, job.restUntil, true);
    await notify("milestone", "GrowX finished commenting", `${todayN} replies posted today.`);
    return finishJob(job, "done", `${msg} Stopped, as you set.${nextStartText(s)}`);
  }
  return park(job, s, job.nextAt, false);
}

// A refused or failed reply goes through the same "X refused" plan as a follow.
async function cmtFail(job, s, now, r, label, o) {
  r = r || { kind: "transient", message: "no answer" };
  const out = await refuseOutcome(job, s, now, r, { mode: "comment", noun: o.noun || "reply", since: "cmtSince", label, read: !!o.read });
  if (out === "stop") return;
  return park(job, s, out === "halt" ? Infinity : out === "break" ? job.restUntil : job.nextAt, false);
}

// ===========================================================================
// Commands from the dashboard and the popup
// ===========================================================================
async function cmtCmd(msg) {
  const now = Date.now();
  switch (msg.op) {
    case "state": return cmtState();

    case "add": {
      const items = Array.isArray(msg.items) ? msg.items : GX.parseLinks(msg.text || "");
      const out = await cmtAdd(items, msg.src || "links", { top: !!msg.top });
      if (out.added) { await pushEvent("cmt", `${out.added} post ${out.added === 1 ? "link" : "links"} added to the comment queue.`); scheduleTick(400); }
      return Object.assign({ ok: true }, out);
    }

    case "preflight": return Object.assign({ ok: true }, await cmtPreflight(msg.text || ""));
    case "go": return cmtGo(msg);
    case "preview": {
      // What a paste would do, without changing anything.
      const items = GX.parseLinks(msg.text || "");
      const q = await cmtQueue();
      const replied = await cmtReplied();
      const have = new Set(q.map((r) => String(r.id)));
      const out = { ok: true, pasted: 0, dup: 0, already: 0, queued: 0, added: 0, mine: 0 };
      const seen = new Set();
      const me = await cmtMyHandle();
      for (const it of items) {
        out.pasted++;
        if (it.dup) { out.dup++; continue; }
        if (me && it.h && String(it.h).toLowerCase() === me) { out.mine++; continue; }
        if (replied.has(it.id)) { out.already++; continue; }
        if (have.has(it.id) || seen.has(it.id)) { out.queued++; continue; }
        seen.add(it.id); out.added++;
      }
      return out;
    }

    case "rows": {
      const q = await cmtQueue();
      const f = msg.filter || "all", src = msg.src || "";
      let rows = q.slice();
      if (src) rows = rows.filter((r) => r.src === src);
      if (f === "ready") rows = rows.filter((r) => r.st === "ready");
      else if (f === "posted") rows = rows.filter((r) => r.st === "posted");
      else if (f === "waiting") rows = rows.filter((r) => ["waiting", "reading", "writing", "posting"].includes(r.st));
      else if (f === "bad") rows = rows.filter((r) => ["skipped", "failed"].includes(r.st));
      const order = { posting: 0, writing: 1, reading: 2, ready: 3, waiting: 4, posted: 5, failed: 6, skipped: 7 };
      rows.sort((a, b) => (order[a.st] - order[b.st]) || ((b.doneAt || b.readyAt || b.at) - (a.doneAt || a.readyAt || a.at)));
      return { ok: true, rows: rows.slice(0, Math.min(500, msg.limit || 200)), total: q.length };
    }

    case "row": {
      const q = await cmtQueue();
      return { ok: true, row: q.find((r) => String(r.id) === String(msg.id)) || null };
    }

    case "edit": {
      const q = await cmtQueue();
      const row = q.find((r) => String(r.id) === String(msg.id));
      if (!row) return { ok: false, error: "not in the queue" };
      row.draft = String(msg.text || "").slice(0, 280);
      row.edited = now;
      if (row.st === "waiting") row.st = "ready";
      await cmtSaveQueue();
      return { ok: true };
    }

    case "retry": {
      const q = await cmtQueue();
      let n = 0;
      for (const row of q) {
        if (!(msg.ids || []).map(String).includes(String(row.id))) continue;
        row.st = "waiting"; row.draft = ""; row.skip = ""; row.fail = ""; row.tries = 0; row.doneAt = 0; n++;
      }
      if (n) { await cmtSaveQueue(); scheduleTick(400); }
      return { ok: true, n };
    }

    case "skip": {
      const q = await cmtQueue();
      let n = 0;
      for (const row of q) if ((msg.ids || []).map(String).includes(String(row.id)) && GX.cmtOpen(row)) { row.st = "skipped"; row.skip = "you skipped it"; row.doneAt = now; n++; }
      if (n) { await cmtSaveQueue(); await cmtBump({ skipped: n }, now); }
      return { ok: true, n };
    }

    case "remove": {
      let q = await cmtQueue();
      const drop = new Set((msg.ids || []).map(String));
      const before = q.length;
      cmem.q = msg.all ? q.filter((r) => GX.cmtOpen(r) && !msg.open) : q.filter((r) => !drop.has(String(r.id)));
      await cmtSaveQueue();
      return { ok: true, removed: before - cmem.q.length };
    }

    case "posted": {
      // "Mark as posted": you posted this draft yourself.
      const q = await cmtQueue();
      const row = q.find((r) => String(r.id) === String(msg.id));
      if (!row) return { ok: false, error: "not in the queue" };
      row.st = "posted"; row.postedAt = now; row.doneAt = now; row.byHand = true;
      await cmtSaveQueue();
      await cmtMarkReplied(row.id);
      await cmtPushLedger(now);
      await cmtBump({ posted: 1 }, now, row.src);
      await cmtPushHist(row, now);
      return { ok: true };
    }

    // ---- saved timing sets ------------------------------------------------
    case "timeSave": {
      const name = String(msg.name || "").trim().slice(0, 40);
      if (!name) return { ok: false, error: "Give the set a name." };
      const s0 = await getRawSettings();
      const v = {};
      for (const k of GX.CMT_TIMING_KEYS) v[k] = s0[k];
      const list = (await load(CK.timings, [])).filter((t) => t.name.toLowerCase() !== name.toLowerCase());
      list.unshift({ name, v, at: Date.now() });
      await save({ [CK.timings]: list.slice(0, 20) });
      return { ok: true, timings: list };
    }

    case "timeApply": {
      const list = await load(CK.timings, []);
      const hit = list.find((t) => t.name === msg.name);
      if (!hit) return { ok: false, error: "That set is gone." };
      // Only the timing keys are taken from the set - goals, rules and the voice
      // are yours and are left exactly as they are.
      const patch = {};
      for (const k of GX.CMT_TIMING_KEYS) if (hit.v[k] !== undefined) patch[k] = hit.v[k];
      patch.cmtPace = "custom";
      const r = await saveSettings(patch);
      return r && r.ok ? { ok: true, settings: r.settings } : { ok: false, error: (r && r.error) || "Could not apply it." };
    }

    case "timeDelete": {
      const list = (await load(CK.timings, [])).filter((t) => t.name !== msg.name);
      await save({ [CK.timings]: list });
      return { ok: true, timings: list };
    }

    case "key": {
      const k = String(msg.key || "").trim();
      await save({ [CK.key]: k });
      return { ok: true, set: !!k };
    }

    case "checkKey": {
      const k = String(msg.key || "").trim() || await cmtKey();
      if (!k) return { ok: false, error: "No key yet." };
      const s = await getRawSettings();
      const r = await aiCall(s, k, [{ role: "user", content: "reply with the single word: ok" }], { max: 8 });
      if (r.ok) return { ok: true, text: r.text, cost: r.cost };
      return { ok: false, error: r.message };
    }

    case "test": {
      // "Test on one link": read, write, check - and change nothing.
      const id = GX.postId(msg.link || "");
      if (!id) return { ok: false, error: "That is not a post link." };
      const k = await cmtKey();
      if (!k) return { ok: false, error: "Add your OpenAI key first." };
      const got = await acquireTab(null, { create: true });
      if (!got) return { ok: false, error: "Couldn't open X." };
      const read = await sendTab(got.tabId, { gx: "cmtRead", id });
      if (!read || !read.ok) return { ok: false, error: (read && read.message) || "The post could not be read." };
      const s = await getSettings();
      const row = { id, src: msg.src === "back" ? "back" : "links", post: read.post, note: "", h: read.post.author.h };
      const d = await cmtDraft(s, k, row, await cmtRecent(10));
      return {
        ok: true, post: read.post, draft: d.ok ? d.text : "", why: d.ok ? "" : d.message,
        rejects: (d.rejects || []).map((x) => ({ t: x.text, b: x.broke })), read: d.read || "", cost: d.cost || 0
      };
    }

    // ---- watch list ----------------------------------------------------
    case "watchAdd": {
      const list = await cmtWatch();
      const want = cmtHandles(msg.text);
      const got = await acquireTab(null, { create: true });
      let added = 0, bad = [];
      for (const h of want) {
        if (list.some((w) => String(w.h).toLowerCase() === h.toLowerCase())) continue;
        if (list.length >= 50) break;
        const u = got ? await cmtResolve(got.tabId, h) : null;
        if (!u) { bad.push(h); continue; }
        list.push({ h: u.h || h, id: String(u.i || ""), n: u.n || "", a: u.a || "", on: true, at: 0, last: 0 });
        added++;
      }
      await cmtSaveWatch();
      if (added) scheduleTick(600);
      return { ok: true, added, bad };
    }
    case "watchSet": {
      const list = await cmtWatch();
      const w = list.find((x) => String(x.h).toLowerCase() === String(msg.h || "").toLowerCase());
      if (!w) return { ok: false };
      if (msg.on !== undefined) w.on = !!msg.on;
      await cmtSaveWatch();
      return { ok: true };
    }
    case "watchDel": {
      cmem.watch = (await cmtWatch()).filter((w) => !(msg.all || String(w.h).toLowerCase() === String(msg.h || "").toLowerCase()));
      await cmtSaveWatch();
      return { ok: true };
    }

    // ---- target accounts -------------------------------------------------
    case "targetAdd": {
      const list = await cmtTargets();
      const want = cmtHandles(msg.text);
      const got = await acquireTab(null, { create: true });
      const idx = await getFollowIndex();
      let added = 0, bad = [], queued = 0;   // queued stays 0: a target is for replies, not for following
      for (const h of want) {
        if (list.some((t) => String(t.h).toLowerCase() === h.toLowerCase())) continue;
        const u = got ? await cmtResolve(got.tabId, h) : null;
        if (!u) { bad.push(h); continue; }
        const id = String(u.i || "");
        const followed = id && idx.has(id);
        list.push({ h: u.h || h, id, n: u.n || "", a: u.a || "", at: 0, addedAt: now, followed: followed ? now : 0, done: "" });
        added++;
      }
      await cmtSaveTargets();
      if (added) { await pushEvent("cmt", `Target: ${added} ${added === 1 ? "account" : "accounts"} added for replies. Following is a separate thing - add them to the Follow queue if you want that too.`); scheduleTick(600); }
      return { ok: true, added, queued, bad };
    }
    case "targetDel": {
      cmem.targets = (await cmtTargets()).filter((t) => !(msg.all || String(t.h).toLowerCase() === String(msg.h || "").toLowerCase()));
      await cmtSaveTargets();
      return { ok: true };
    }

    // ---- Telegram --------------------------------------------------------
    case "tgGet": { const t = await tgConf(); return { ok: true, tg: { chat: t.chat || "", hasToken: !!t.token, on: t.on, dailyAt: t.dailyAt, lastAt: t.lastAt || 0, lastOk: !!t.lastOk, lastErr: t.lastErr || "" } }; }
    case "tgSet": {
      const t = await tgConf();
      if (msg.token !== undefined) t.token = String(msg.token || "").trim();
      if (msg.chat !== undefined) t.chat = String(msg.chat || "").trim();
      if (msg.dailyAt) t.dailyAt = String(msg.dailyAt);
      if (msg.on) t.on = Object.assign(t.on, msg.on);
      await tgSave(t);
      return { ok: true };
    }
    case "tgTest": return tgSend("run", "<b>GrowX</b>\nTelegram is connected. You will get your run updates here.", true);

    // ---- backup ----------------------------------------------------------
    case "backup": return cmtBackup();
    case "restore": return cmtRestore(msg.data);
    default: return { ok: false, error: "unknown comment command" };
  }
}

// @handles or profile links, one or many.
function cmtHandles(text) {
  return [...new Set(String(text || "").split(/[\s,]+/).map(GX.cleanHandle).filter(Boolean))].slice(0, 60);
}
// One handle -> the account, through the x.com tab.
async function cmtResolve(tabId, h) {
  const r = await sendTab(tabId, { gx: "resolve", handle: h });
  return r && r.ok && r.user ? r.user : null;
}

// Everything Comment mode knows, for the pages.
// ---- v3.2 "Start commenting": everything that has to be true first, said plainly -------------------
// Each item: { k, ok, block, text, fix }. block = it cannot start until this is fixed; the others are notes.
async function cmtPreflight(text) {
  const now = Date.now();
  const s = await getSettings();
  const items = [];
  const add = (k, ok, block, txt, fix) => items.push({ k, ok: !!ok, block: !ok && !!block, text: txt, fix: ok ? "" : (fix || "") });
  const key = await cmtKey();
  add("on", s.cmtOn, true, s.cmtOn ? "Comment mode is ON" : "Comment mode is switched OFF", "turnOn");
  add("key", !!key, true, key ? "OpenAI key is saved" : "No OpenAI key yet - GrowX needs it to write the replies", "key");
  const acc = await load(K.account, null);
  add("x", !!(acc && acc.id), false, acc && acc.id ? `Signed in to X as @${acc.handle || acc.id}` : "Not sure you are signed in to X - GrowX checks when it starts", "openX");
  const pasted = GX.parseLinks(text || "");
  const q = await cmtQueue();
  const open = cmtOpenRows(q).length;
  const me = await cmtMyHandle();
  const mine = me ? pasted.filter((it) => it.h && String(it.h).toLowerCase() === me).length : 0;
  const replied = await cmtReplied();
  const have = new Set(q.map((r) => String(r.id)));
  const fresh = pasted.filter((it) => !it.dup && !(me && it.h && String(it.h).toLowerCase() === me) && !replied.has(it.id) && !have.has(String(it.id))).length;
  add("links", open + fresh > 0, true, open + fresh > 0 ? `${fresh ? fresh + " new link" + (fresh === 1 ? "" : "s") + " pasted" : ""}${fresh && open ? " + " : ""}${open ? open + " already waiting in the queue" : ""}` : "No post links - paste at least one link", "links");
  if (mine) add("mine", false, false, `${mine} of the links ${mine === 1 ? "is" : "are"} your own post - ${mine === 1 ? "it is" : "they are"} skipped (GrowX never replies to your own posts)`);
  const spent = await cmtSpendToday(now), cap = s.cmtSpendCents / 100;
  add("spend", spent < cap, true, spent < cap ? `AI spend today $${spent.toFixed(3)} of $${cap.toFixed(2)}` : `Today's AI spend cap of $${cap.toFixed(2)} is used up`, "spend");
  const todayN = await cmtTodayN(now);
  add("goal", todayN < s.cmtDaily, true, todayN < s.cmtDaily ? `Today: ${todayN} of ${s.cmtDaily} replies - ${s.cmtDaily - todayN} left` : `Today's goal of ${s.cmtDaily} replies is already reached`, "goal");
  const meta = await load(K.meta, {});
  add("limited", meta.cLimitedDay !== dayKey(now), true, meta.cLimitedDay !== dayKey(now) ? "X has not limited your replies today" : "X limited your replies today - Comment waits until tomorrow to keep the account safe");
  const inH = GX.cmtInHours(s, now);
  add("hours", inH, false, inH ? (s.cmtStartNow ? "Works right away (all day)" : `Inside your working hours (${s.cmtStart} - ${s.cmtEnd})`) : `Working hours only (${s.cmtStart} - ${s.cmtEnd}): it waits until ${clock(GX.cmtNextOpen(s, now))}`, "startNow");
  add("like", s.cmtLike, false, s.cmtLike ? "Likes each post first, then replies" : "Like before reply is OFF", "likeOn");
  add("publish", s.cmtPublish === "auto", false, s.cmtPublish === "auto" ? "GrowX posts each reply itself" : "Drafts only - GrowX writes, you post", "auto");
  const job = await load(K.job, null);
  if (job && ACTIVE.has(job.status) && jobMode(job) !== "comment") add("other", false, false, `${MODE_NAME[jobMode(job)]} mode is running now - it hands over to Comment on its next step`);
  const left = open + fresh;
  const hourCap = GX.hourlyCap(s, "comment").cap;
  const eta = left ? GX.cmtFinish(s, { left, todayLeft: Math.max(0, s.cmtDaily - todayN), hourCap }, now) : null;
  return { items, canStart: !items.some((x) => x.block), left, fresh, open, mine, eta, perReply: GX.cmtStepSeconds(s), hourCap };
}
// Paste + Start in one go: add the links, check everything, then start Comment (or hand over to it) and stay on
// those links until they are done.
async function cmtGo(msg) {
  const items = GX.parseLinks(msg.text || "");
  const added = items.length ? await cmtAdd(items, "links") : { added: 0, mine: 0, already: 0, queued: 0, dup: 0 };
  const pf = await cmtPreflight("");
  if (!pf.canStart) return { ok: false, preflight: pf, add: added, error: (pf.items.find((x) => x.block) || {}).text || "Can't start yet." };
  await save({ [GX.CK.focus]: { at: Date.now() } });
  const job = await load(K.job, null);
  if (job && ACTIVE.has(job.status)) {
    const other = jobMode(job) !== "comment";
    if (other) await saveSettings({ runMode: "comment" }, { noStart: true });
    else if ((job.status === "resting" || job.status === "sleeping") && ["empty", "cap"].includes(job.restReason)) {
      // Waiting only because the queue was empty (or drafts were full): the new links are work, start on them now.
      job.restUntil = Date.now(); job.cmtEmptyNoted = false;
      await save({ [K.job]: job });
    }
    scheduleTick(300);
    return { ok: true, switched: other, add: added, preflight: pf };
  }
  const r = await startJob("comment", "Comment links");
  if (!r || !r.ok) { await chrome.storage.local.remove(GX.CK.focus); return Object.assign({ add: added, preflight: pf }, r || { ok: false }); }
  return { ok: true, started: true, add: added, preflight: pf };
}

async function cmtState() {
  const now = Date.now();
  const s = await getRawSettings();
  const q = await cmtQueue();
  const days = await cmtDays();
  const today = days[GX.cmtDayKey(now)] || {};
  const led = await cmtLedger();
  const hist = await cmtHist();
  const all = Object.values(days).reduce((a, x) => a + (x.posted || 0), 0);
  const allCost = Object.values(days).reduce((a, x) => a + (x.cost || 0), 0);
  const counts = { all: q.length, ready: 0, posted: 0, waiting: 0, bad: 0 };
  const bySrc = { links: 0, watch: 0, target: 0, back: 0 };
  // Every status counted on its own, and the same again for the links you pasted,
  // so a page can say plainly how many are done and how many are still to go.
  const blank = () => ({ waiting: 0, reading: 0, writing: 0, ready: 0, posting: 0, posted: 0, skipped: 0, failed: 0 });
  const byStat = blank(), linkStat = blank();
  for (const r of q) {
    if (r.st === "ready") counts.ready++;
    else if (r.st === "posted") counts.posted++;
    else if (["skipped", "failed"].includes(r.st)) counts.bad++;
    else counts.waiting++;
    if (bySrc[r.src] !== undefined) bySrc[r.src]++;
    if (byStat[r.st] !== undefined) byStat[r.st]++;
    if (r.src === "links" && linkStat[r.st] !== undefined) linkStat[r.st]++;
  }
  const firstDay = Object.keys(days).sort()[0] || "";
  return {
    ok: true, now,
    hasKey: !!(await cmtKey()),
    counts, bySrc, byStat, linkStat,
    today: { posted: today.posted || 0, drafts: today.drafts || 0, skipped: today.skipped || 0, failed: today.failed || 0, cost: today.cost || 0 },
    hour: led.filter((t) => t > now - HOUR).length,
    hourCap: GX.hourlyCap(s, "comment").cap,
    goal: s.cmtDaily,
    all, allCost, firstDay,
    days,
    hist: hist.slice(0, 50),
    watch: await cmtWatch(),
    targets: await cmtTargets(),
    tg: await (async () => { const t = await tgConf(); return { on: !!(t.token && t.chat), events: t.on, dailyAt: t.dailyAt, lastOk: !!t.lastOk, lastErr: t.lastErr || "" }; })(),
    spend: { today: today.cost || 0, cap: s.cmtSpendCents / 100 },
    timings: await load(CK.timings, []),
    backupAt: (await load(K.meta, {})).cmtBackupAt || 0,
    last: hist[0] || null
  };
}

// ---- backup / restore -------------------------------------------------------
async function cmtBackup() {
  const [q, replied, days, hist, watch, targets] = await Promise.all([
    cmtQueue(), cmtReplied(), cmtDays(), cmtHist(), cmtWatch(), cmtTargets()
  ]);
  return { ok: true, data: { v: 1, at: Date.now(), queue: q, replied: [...replied], days, hist, watch, targets } };
}
// A restore merges and never lowers a total.
async function cmtRestore(data) {
  if (!data || typeof data !== "object") return { ok: false, error: "Not a GrowX comment backup." };
  const days = await cmtDays();
  for (const [k, v] of Object.entries(data.days || {})) {
    const cur = days[k] || (days[k] = { posted: 0, drafts: 0, skipped: 0, failed: 0, likes: 0, cost: 0, src: {} });
    for (const f of ["posted", "drafts", "skipped", "failed", "likes", "cost"]) cur[f] = Math.max(cur[f] || 0, Number(v[f]) || 0);
  }
  await save({ [CK.days]: days });
  const set = await cmtReplied();
  for (const id of data.replied || []) set.add(String(id));
  cmem.replied = set;
  await save({ [CK.replied]: [...set].slice(-CMT_REPLIED_MAX) });
  const hist = await cmtHist();
  const have = new Set(hist.map((e) => e.i + "|" + e.t));
  for (const e of data.hist || []) if (!have.has(e.i + "|" + e.t)) hist.push(e);
  hist.sort((a, b) => b.t - a.t);
  await save({ [CK.hist]: hist.slice(0, CMT_HIST_MAX) });
  if (Array.isArray(data.watch) && data.watch.length) { cmem.watch = data.watch; await cmtSaveWatch(); }
  if (Array.isArray(data.targets) && data.targets.length) { cmem.targets = data.targets; await cmtSaveTargets(); }
  if (Array.isArray(data.queue)) {
    const q = await cmtQueue();
    const have2 = new Set(q.map((r) => String(r.id)));
    for (const r of data.queue) if (!have2.has(String(r.id))) q.push(r);
    await cmtSaveQueue();
  }
  return { ok: true };
}

// Refresh the likes and views on replies posted a few hours ago, so the Result
// column means something. Cheap: at most 20 ids, at most once an hour.
async function cmtStatsStep(job, s, now) {
  if (job.cmtStatsAt && now - job.cmtStatsAt < HOUR) return false;
  const q = await cmtQueue();
  const want = q.filter((r) => r.st === "posted" && r.replyId && now - r.postedAt > 3 * HOUR && (!r.stats || now - r.stats.at > 12 * HOUR)).slice(0, 20);
  if (!want.length) { job.cmtStatsAt = now; return false; }
  const r = await cmtAsk(job, { gx: "cmtStats", ids: want.map((x) => x.replyId) });
  job.cmtStatsAt = now;
  if (!r || !r.ok) return false;
  let likes = 0;
  for (const row of want) {
    const st = r.stats[row.replyId];
    if (!st) continue;
    likes += Math.max(0, (st.likes || 0) - ((row.stats && row.stats.likes) || 0));
    row.stats = { likes: st.likes || 0, views: st.views || 0, at: now };
  }
  await cmtSaveQueue();
  if (likes) await cmtBump({ likes }, now);
  return true;
}
