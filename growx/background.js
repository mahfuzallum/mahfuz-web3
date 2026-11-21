// GrowX - background.js (service worker)
//
// The engine. It owns every run from start to finish and keeps going until
// you press Stop:
//
//   harvest   read the newest followers of your source profiles, a page at a
//             time, through X's own API; filter and score every account for
//             its chance to follow back; keep the best in the queue
//   follow    work through the queue one follow at a time with randomised,
//             human-like pacing, scheduled rests, a rolling hourly cap, a
//             rolling daily cap, active hours and an optional warm-up ramp
//   protect   back off on every warning X gives (rate limits, the daily
//             follow limit, "looks automated", follows that don't stick),
//             halt on anything that needs a person (signed out, locked)
//   measure   detect who followed back, rate each source by its follow-back
//             rate, and track your follower growth day by day
//
// Why the worker and not the x.com tab: a page script lives and dies with its
// tab - switch tabs and Chrome throttles it, navigate and it is gone. Here the
// x.com tab only executes single, short requests on demand. All state is in
// chrome.storage, so a closed popup, a reloaded tab, a restarted worker or a
// restarted browser never loses a run.

importScripts("shared/config.js", "shared/cmt.js", "cmt-engine.js");

const { K } = GX;
const X_URLS = ["https://x.com/*", "https://twitter.com/*"];
const CS_FILES = ["content/txid.js", "content/xapi.js", "content/xcmt.js", "content/dom.js", "content/cmtdom.js", "content/content.js"];
const ACTIVE = new Set(["running", "resting", "sleeping"]);
// Rests during which background reads (harvest, follow-back checks) are fine.
// Never during a warning from X or outside active hours.
const READS_OK_WHILE = new Set(["cooldown", "daily", "hourly", "cap", "empty", "errors", "switch", "read"]);
// Rests during which only the quiet follow-back lookups continue (night time,
// X's daily follow limit). Never after a warning from X.
const REL_OK_WHILE = new Set(["schedule", "limit"]);
const readsMode = (job) => job.status === "resting" && READS_OK_WHILE.has(job.restReason) ? "all"
  : (job.status === "resting" || job.status === "sleeping") && REL_OK_WHILE.has(job.restReason) ? "rel" : false;
const FOLLOWS_MAX = 40000, SEEN_MAX = 120000, KNOWN_MAX = 150000, EVENTS_MAX = 400, POOL_MAX = 1500, GROWTH_DAYS = 400;
const VERIFY_EVERY = 10;
const MIN = 60000, HOUR = 3600000, DAY = 86400000;
// When each follow is checked for a follow-back, counted from the follow.
const FB_SCHEDULE = [30 * MIN, 2 * HOUR, 8 * HOUR, DAY, 3 * DAY, 7 * DAY, 14 * DAY];

const COLORS = { run: "#E11D2E", rest: "#F59E0B", sleep: "#7C3AED", halt: "#7F1D1D", done: "#16A34A", paused: "#64748B", task: "#DB2777", swap: "#0EA5E9", cmt: "#1D4ED8" };

// ===========================================================================
// Storage helpers + in-memory caches (storage is the source of truth)
// ===========================================================================
async function load(key, fallback) {
  try {
    const r = await chrome.storage.local.get(key);
    return r[key] === undefined ? fallback : r[key];
  } catch (_) { return fallback; }
}
async function save(obj) {
  try { await chrome.storage.local.set(obj); } catch (e) { console.warn("[gx] save failed", e); }
}

const mem = { pool: null, sources: null, seen: null, seenDirty: 0, follows: null, fidx: null, known: null, blacklist: null,
  // The ids of the follower scan that is running, kept in memory only (a full follower list must never go into storage).
  // When a scan reaches the real end of X's list, this is the complete set of your followers - so anyone who followed
  // you back and is NOT in it has unfollowed you.
  scan: null };

// The settings the engine runs with: the mode's own hours and days, with this week's rest days taken out.
// Everything downstream (active hours, the next window, auto-start, the plan) then works without knowing
// rest days exist at all.
async function getSettings() {
  const raw = GX.normalizeSettings(await load(K.settings, {}));
  const s = GX.modeSettings(raw);
  if (!raw.restDays) return s;
  const meta = await load(K.meta, {});
  return GX.withRestDays(s, meta.installedAt || meta.warmupAt || 0, Date.now());
}
async function getRawSettings() { return GX.normalizeSettings(await load(K.settings, {})); }

async function getPool() {
  if (!mem.pool) { const a = await load(K.pool, []); mem.pool = Array.isArray(a) ? a : []; }
  return mem.pool;
}
const savePool = () => save({ [K.pool]: mem.pool || [] });

async function getSources() {
  if (!mem.sources) { const a = await load(K.sources, []); mem.sources = Array.isArray(a) ? a : []; }
  return mem.sources;
}
const saveSources = () => save({ [K.sources]: mem.sources || [] });

async function getSeen() {
  if (!mem.seen) mem.seen = new Set(await load(K.seen, []));
  return mem.seen;
}
async function flushSeen(force) {
  if (!mem.seen || (!force && mem.seenDirty < 3) || !mem.seenDirty) return;
  let arr = [...mem.seen];
  if (arr.length > SEEN_MAX) { arr = arr.slice(arr.length - SEEN_MAX); mem.seen = new Set(arr); }
  mem.seenDirty = 0;
  await save({ [K.seen]: arr });
}

async function getFollows() {
  if (!mem.follows) {
    const a = await load(K.follows, []);
    mem.follows = Array.isArray(a) ? a : [];
    mem.fidx = new Map();
    const now = Date.now();
    let migrated = 0;
    for (const f of mem.follows) {
      if (f.i) mem.fidx.set(f.i, f);
      // History from before direct follow-back checks: check it soon.
      if (f.k === undefined) {
        f.k = 0;
        f.c = f.i && !f.fb && !f.fy0 && now - f.t < 30 * DAY ? now + Math.floor(Math.random() * 5 * MIN) : 0;
        migrated++;
      }
    }
    if (migrated) await save({ [K.follows]: mem.follows });
  }
  return mem.follows;
}
async function getFollowIndex() { await getFollows(); return mem.fidx; }
async function saveFollows() {
  if (mem.follows.length > FOLLOWS_MAX) {
    const drop = mem.follows.splice(0, mem.follows.length - FOLLOWS_MAX);
    for (const f of drop) if (f.i && mem.fidx.get(f.i) === f) mem.fidx.delete(f.i);
  }
  await save({ [K.follows]: mem.follows });
}

async function getKnown() {
  if (!mem.known) mem.known = new Set(await load(K.known, []));
  return mem.known;
}
async function saveKnown() {
  let arr = [...mem.known];
  if (arr.length > KNOWN_MAX) { arr = arr.slice(arr.length - KNOWN_MAX); mem.known = new Set(arr); }
  await save({ [K.known]: arr });
}

async function getBlacklist() {
  if (!mem.blacklist) {
    const a = await load(K.blacklist, []);
    mem.blacklist = new Set((Array.isArray(a) ? a : []).map((h) => String(h).toLowerCase()));
  }
  return mem.blacklist;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  // Data reset from the dashboard: drop in-memory copies too.
  for (const [k, field] of [[K.pool, "pool"], [K.sources, "sources"], [K.seen, "seen"], [K.known, "known"], [K.blacklist, "blacklist"]]) {
    if (changes[k] && changes[k].newValue === undefined) mem[field] = null;
  }
  if (changes[K.follows] && changes[K.follows].newValue === undefined) { mem.follows = null; mem.fidx = null; }
  if (changes[K.job] || changes[K.ledger] || changes[K.uledger] || changes[K.bledger] || changes[K.settings]) refreshBadge();
});

// Rolling 24h ledger of follow timestamps (hourly + daily caps).
async function getLedger() {
  const cutoff = Date.now() - DAY;
  const arr = await load(K.ledger, []);
  return (Array.isArray(arr) ? arr : []).filter((t) => t > cutoff).sort((a, b) => a - b);
}
// With daily auto-start, the run target counts per calendar day: every new day starts from 0,
// so a run that sleeps overnight does not carry yesterday's follows into today's target.
function runDone(job, s) { return s.autoStart ? job.done - (job.dayBase || 0) : job.done; }
function nextStartText(s) {
  if (!s.autoStart) return "";
  const t = GX.nextAutoStart(s, true, Date.now());
  return ` Next automatic start: ${new Date(t).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}.`;
}

// Follows counted against the daily limit: since local midnight ("calendar") or the last 24 hours ("rolling").
function startOfToday(now) { const d = new Date(now || Date.now()); d.setHours(0, 0, 0, 0); return d.getTime(); }
function dayEntries(ledger, s, now) {
  now = now || Date.now();
  return s.dailyWindow === "rolling" ? ledger : ledger.filter((t) => t >= startOfToday(now));
}
function dayFreeAt(ledger, s, daily, now) {
  now = now || Date.now();
  if (s.dailyWindow === "rolling") return ledger[ledger.length - daily] + DAY + rand(30000, 180000);
  return startOfToday(now) + DAY + rand(30000, 180000);   // just after midnight
}
// Follows in a row with no real break: counted back from the newest follow until a pause of (almost) the break length.
// It reads X's side of things (every follow, whichever mode or run made it), so a Stop -> Start, a new day's run or a
// mode switch can never start a fresh count in the middle of a batch.
function ledgerRun(ledger, now, breakMs) {
  const gap = Math.max(60000, breakMs * 0.9);
  if (!ledger.length || now - ledger[ledger.length - 1] >= gap) return 0;
  let n = 1;
  for (let i = ledger.length - 1; i > 0; i--) { if (ledger[i] - ledger[i - 1] >= gap) break; n++; }
  return n;
}
// A follow whose answer never came back (tab asleep, worker restarted) may still have reached X: count it for the batch.
const unsure = (r) => !r.ok && (r.noAnswer || r.kind === "transient");

async function pushLedger() {
  const l = await getLedger();
  l.push(Date.now());
  await save({ [K.ledger]: l });
  return l;
}

// The mode a run is in ("follow" | "unfollow" | "followback"). Runs from older versions have no field.
function jobMode(job) {
  if (!job) return "follow";
  if (GX.MODES.includes(job.runMode)) return job.runMode;
  return GX.MODES.includes(job.mode) ? job.mode : "follow";
}
// X refused following twice today ("unable to follow more people"): no automatic follows - in Follow OR Follow back,
// they share X's follow limit - until tomorrow.
function xLimitedToday(meta, job, now) {
  now = now || Date.now();
  if (meta && meta.xLimitedDay === dayKey(now)) return true;
  return !!(job && job.xLimitedAt && job.xLimitedAt >= startOfToday(now));
}

// X kept refusing unfollows (the third step of the X-refused plan): no automatic unfollowing until tomorrow.
// Follow and Follow back are not affected - they have their own plan and their own limit.
function uLimitedToday(meta, job, now) {
  now = now || Date.now();
  if (meta && meta.uLimitedDay === dayKey(now)) return true;
  return !!(job && job.uLimitedAt && job.uLimitedAt >= startOfToday(now));
}

// "Stop for today" when X's daily follow limit is used up. With a rolling 24-hour count the limit frees up again
// during the day, and nobody would press Start - so with auto-start on, GrowX rests and carries on by itself instead.
function stopForDay(s) { return s.onDailyCap === "stop" && !(s.autoStart && s.dailyWindow === "rolling"); }

// Did this run (or the run it replaced) already work today? A run can start late, sleep over midnight and carry on the next
// morning, so "started today" alone is not enough: stopping/finishing/stepping today counts too.
function ranToday(job, now) {
  if (!job) return false;
  now = now || Date.now();
  return (job.startedAt || 0) >= startOfToday(now) || (job.finishedAt || 0) >= startOfToday(now) || job.dayKey === new Date(now).toDateString();
}

async function pushEvent(k, m, extra) {
  const ev = await load(K.events, []);
  const arr = Array.isArray(ev) ? ev : [];
  arr.unshift(Object.assign({ t: Date.now(), k, m }, extra || {}));
  if (arr.length > EVENTS_MAX) arr.length = EVENTS_MAX;
  await save({ [K.events]: arr });
}

async function bumpStats(patch) {
  const st = await load(K.stats, {});
  for (const [k, v] of Object.entries(patch)) st[k] = (Number(st[k]) || 0) + v;
  if (!st.since) st.since = Date.now();
  await save({ [K.stats]: st });
}

const rand = (a, b) => a + Math.random() * (b - a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const dayKey = (ts) => { const d = new Date(ts || Date.now()); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
const plural = (n, w) => n.toLocaleString() + " " + w + (n === 1 ? "" : "s");

// ===========================================================================
// Keepalive + scheduling
//
// While a run is active a cheap API call every 20s keeps the worker up so
// short waits can use setTimeout. Every wait is ALSO backed by a chrome.alarm,
// so if Chrome stops the worker anyway the alarm starts it again and the run
// continues from storage. Long rests rely on the alarm alone.
// ===========================================================================
let keepTimer = null;
function keepAlive(on) {
  if (on && !keepTimer) keepTimer = setInterval(() => { chrome.runtime.getPlatformInfo().catch(() => {}); }, 20000);
  if (!on && keepTimer) { clearInterval(keepTimer); keepTimer = null; }
}

let tickTimer = null;
function scheduleTick(ms) {
  ms = Math.max(0, Math.round(ms || 0));
  clearTimeout(tickTimer);
  tickTimer = setTimeout(() => tick("timer"), ms);
  chrome.alarms.create("gx.tick", { when: Date.now() + Math.max(ms + 2000, 30000) });
  keepAlive(ms < 120000);
}

let ticking = false, tickAt = 0;
async function tick(reason) {
  // A tick that has been "running" for minutes is a lost promise; never let
  // it block the engine forever.
  if (ticking && Date.now() - tickAt < 180000) return;
  ticking = true;
  tickAt = Date.now();
  try {
    // Once a day: the Telegram report, and the backup file in Downloads/GrowX/.
    tgDailyReport(Date.now());
    cmtAutoBackup(Date.now());
    const job = await load(K.job, null);
    if (job && ACTIVE.has(job.status)) { await jobStep(job); return; }
    // A pause you gave an end time to: when it runs out, GrowX starts again by itself.
    if (job && job.status === "paused" && job.resumeAt && Date.now() >= job.resumeAt) {
      await pushEvent("run", "Pause finished - starting again by itself.");
      await notify("resume", "GrowX is running again", "The pause you set has finished.");
      const r = await controlJob("resume");
      if (r && r.ok) return;
    }
    const task = await load(K.task, null);
    if (task && task.status === "running") { await taskStep(task); return; }
    if (await maybeAutoRecover(job)) return;
    if (await maybeAutoStart()) return;
    keepAlive(false);
    chrome.alarms.clear("gx.tick");
    syncPower(false);
    await idleFollowBacks();
  } catch (e) {
    console.error("[gx] tick failed:", e);
    scheduleTick(15000);
  } finally {
    ticking = false;
  }
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "gx.tick" || a.name === "gx.watch") tick(a.name);
  if (a.name === "gx.badgeClear") setBadge("", null);
});
chrome.alarms.create("gx.watch", { periodInMinutes: 1 });

let powerHeld = false;
function syncPower(on) {
  try {
    if (on && !powerHeld) { chrome.power.requestKeepAwake("system"); powerHeld = true; }
    if (!on && powerHeld) { chrome.power.releaseKeepAwake(); powerHeld = false; }
  } catch (_) {}
}

// ===========================================================================
// Tabs: find an x.com tab that can take work, inject the executor if a tab
// predates this version, or open a pinned background tab of our own.
// ===========================================================================
const readyWaiters = new Map();

function sendTab(tabId, msg, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(t); resolve(r); } };
    const t = setTimeout(() => finish({ ok: false, kind: "transient", message: "The X tab did not answer.", noAnswer: true }), timeoutMs || 60000);
    try {
      chrome.tabs.sendMessage(tabId, msg).then(
        (r) => finish(r || { ok: false, kind: "transient", message: "No answer from the X tab.", noAnswer: true }),
        (e) => finish({ ok: false, kind: "transient", message: String((e && e.message) || e), noAnswer: true })
      );
    } catch (e) {
      finish({ ok: false, kind: "transient", message: String(e.message || e), noAnswer: true });
    }
  });
}

async function tabInfo(tabId) {
  if (tabId == null) return null;
  try { return await chrome.tabs.get(tabId); } catch (_) { return null; }
}

const isXUrl = (u) => /^https:\/\/(x|twitter)\.com\//.test(u || "");

async function ping(tabId, guard) {
  const r = await sendTab(tabId, guard === undefined ? { gx: "ping" } : { gx: "ping", guard }, 3500);
  return r && r.ok ? r : null;
}

async function inject(tabId) {
  try { await chrome.scripting.executeScript({ target: { tabId }, files: CS_FILES }); return true; }
  catch (_) { return false; }
}

async function usable(tabId) {
  const tab = await tabInfo(tabId);
  if (!tab || !isXUrl(tab.url) || tab.discarded) return null;
  let p = await ping(tabId);
  if (!p && tab.status === "complete") {
    if (await inject(tabId)) p = await ping(tabId);
  }
  return p ? tab : null;
}

function waitReady(tabId, match, timeoutMs) {
  return new Promise((resolve) => {
    const list = readyWaiters.get(tabId) || [];
    const entry = { match, resolve: null };
    const t = setTimeout(() => {
      const l = readyWaiters.get(tabId) || [];
      readyWaiters.set(tabId, l.filter((e) => e !== entry));
      resolve(false);
    }, timeoutMs);
    entry.resolve = (ok) => { clearTimeout(t); resolve(ok); };
    list.push(entry);
    readyWaiters.set(tabId, list);
  });
}

function resolveReady(tabId, url) {
  const list = readyWaiters.get(tabId);
  if (!list || !list.length) return;
  const keep = [];
  for (const e of list) { if (!e.match || e.match(url)) e.resolve(true); else keep.push(e); }
  readyWaiters.set(tabId, keep);
}

async function waitTabReady(tabId, match, timeoutMs, readyPromise) {
  const until = Date.now() + (timeoutMs || 45000);
  let announced = false;
  if (readyPromise) readyPromise.then((ok) => { if (ok) announced = true; });
  while (Date.now() < until) {
    if (announced) return true;
    const tab = await tabInfo(tabId);
    if (!tab) return false;
    if (tab.status === "complete" && (!match || match(tab.url))) {
      const p = await ping(tabId);
      if (p && (!match || match(p.url))) return true;
      if (!p && await inject(tabId)) {
        const p2 = await ping(tabId);
        if (p2 && (!match || match(p2.url))) return true;
      }
    }
    await sleep(1200);
  }
  return false;
}

async function navigate(tabId, url, match, timeoutMs) {
  const ready = waitReady(tabId, match, timeoutMs || 45000);
  try { await chrome.tabs.update(tabId, { url }); } catch (_) { return false; }
  await sleep(400);
  return waitTabReady(tabId, match, timeoutMs || 45000, ready);
}

// Returns { tabId, created } or null.
async function acquireTab(preferId, opts) {
  opts = opts || {};
  if (preferId != null) {
    const t = await usable(preferId);
    if (t) return { tabId: t.id, created: false };
    // Our own tab went quiet (frozen or crashed): reload it rather than open another.
    if (opts.ownTab) {
      const info = await tabInfo(preferId);
      if (info && isXUrl(info.url)) {
        const ready = waitReady(preferId, null, 40000);
        try { await chrome.tabs.reload(preferId); } catch (_) {}
        if (await ready || await usable(preferId)) return { tabId: preferId, created: true };
      }
    }
  }
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: X_URLS }); } catch (_) {}
  // Visible tabs first (least likely to be frozen), then most recently used.
  tabs.sort((a, b) => (b.active - a.active) || ((b.lastAccessed || 0) - (a.lastAccessed || 0)));
  for (const t of tabs) {
    if (t.id === preferId) continue;
    if (await usable(t.id)) return { tabId: t.id, created: false };
  }
  const sleeping = tabs.find((t) => t.discarded);
  if (sleeping) {
    const ready = waitReady(sleeping.id, null, 40000);
    try { await chrome.tabs.reload(sleeping.id); } catch (_) {}
    if (await ready && await usable(sleeping.id)) return { tabId: sleeping.id, created: false };
  }
  if (!opts.create) return null;
  try {
    const tab = await chrome.tabs.create({ url: "https://x.com/home", active: !!opts.active, pinned: !opts.active });
    const ok = await waitReady(tab.id, null, 45000);
    if (ok || await usable(tab.id)) return { tabId: tab.id, created: true };
  } catch (_) {}
  return null;
}

async function protectTab(tabId, on) {
  if (tabId == null) return;
  try { await chrome.tabs.update(tabId, { autoDiscardable: !on }); } catch (_) {}
  await sendTab(tabId, { gx: "ping", guard: !!on }, 3000);
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  readyWaiters.delete(tabId);
  const job = await load(K.job, null);
  if (job && (job.tabId === tabId || job.workerTabId === tabId)) {
    if (job.tabId === tabId) { job.tabId = null; job.ownTab = false; }
    if (job.workerTabId === tabId) job.workerTabId = null;
    await save({ [K.job]: job });
  }
});

// ===========================================================================
// Badge + notifications
// ===========================================================================
function short(n) {
  n = Number(n) || 0;
  if (n >= 10000) return Math.floor(n / 1000) + "k";
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

function setBadge(text, color, title) {
  try {
    chrome.action.setBadgeText({ text: text || "" }).catch(() => {});
    if (color) chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
    if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: "#FFFFFF" }).catch(() => {});
    chrome.action.setTitle({ title: title || "GrowX - Unlimited Auto Follow" }).catch(() => {});
  } catch (_) {}
}

let badgeTimer = null;
function refreshBadge() {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(async () => {
    const job = await load(K.job, null);
    const task = await load(K.task, null);
    const bs = await getSettings();
    const bUnf = bs.runMode === "unfollow", bBk = bs.runMode === "followback", bCmt = bs.runMode === "comment";
    const today = bCmt ? await cmtTodayN(Date.now()) : bUnf ? await unfToday(Date.now()) : bBk ? await bkToday(Date.now()) : dayEntries(await getLedger(), bs, Date.now()).length;   // same count as the dashboard
    if (task && task.status === "running" && !(job && ACTIVE.has(job.status))) return setBadge("•••", COLORS.task, task.message || "Working");
    if (!job) return setBadge("");
    switch (job.status) {
      case "running": return setBadge(short(today), bCmt ? COLORS.cmt : COLORS.run, `GrowX autopilot - ${today} ${bCmt ? "replies" : bUnf ? "unfollows" : bBk ? "follow-backs" : "follows"} today`);
      case "resting": return setBadge(job.restReason === "switch" ? "⇄" : short(today), job.restReason === "switch" ? COLORS.swap : COLORS.rest, job.message || "Resting");
      case "sleeping": return setBadge("zz", COLORS.sleep, job.message || "Sleeping until your active hours");
      case "paused": return setBadge("||", COLORS.paused, "GrowX is paused");
      case "halted": return setBadge("!", COLORS.halt, job.message || "GrowX needs your attention");
      case "done":
        setBadge("✓", COLORS.done, job.message || "Finished");
        chrome.alarms.create("gx.badgeClear", { when: Date.now() + 10 * 60000 });
        return;
      default: return setBadge("");
    }
  }, 120);
}

async function notify(id, title, message) {
  const s = await getSettings();
  if (!s.notifications) return;
  try {
    chrome.notifications.create("gx." + id + "." + Date.now(), { type: "basic", iconUrl: "icon128.png", title, message, priority: 1 }, () => void chrome.runtime.lastError);
  } catch (_) {}
}

// ===========================================================================
// Account + growth
// ===========================================================================
async function refreshAccount(tabId) {
  const who = await sendTab(tabId, { gx: "whoami", deep: true }, 30000);
  if (who && who.ok && who.signedIn) {
    const prev = await load(K.account, null);
    const same = prev && prev.id === who.id;
    const acc = {
      id: who.id,
      handle: who.handle || (same ? prev.handle : ""),
      name: who.name || (same ? prev.name : ""),
      avatar: who.avatar || (same ? prev.avatar : ""),
      followers: who.followers != null ? who.followers : (same ? prev.followers : null),
      following: who.following != null ? who.following : (same ? prev.following : null),
      at: Date.now()
    };
    await save({ [K.account]: acc });
    await snapshotGrowth(acc);
    return acc;
  }
  if (who && who.ok && !who.signedIn) await save({ [K.account]: { id: null, signedOut: true, at: Date.now() } });
  return null;
}

async function snapshotGrowth(acc) {
  if (!acc || typeof acc.followers !== "number") return;
  const g = await load(K.growth, []);
  const arr = Array.isArray(g) ? g : [];
  const d = dayKey();
  const last = arr[arr.length - 1];
  if (last && last.d === d) { last.f = acc.followers; last.g = acc.following; last.t = Date.now(); }
  else arr.push({ d, f0: acc.followers, f: acc.followers, g: acc.following, t: Date.now(), t0: Date.now() });
  if (arr.length > GROWTH_DAYS) arr.splice(0, arr.length - GROWTH_DAYS);
  await save({ [K.growth]: arr });
}

// New followers found by a follower scan (people who were not in your follower list before), counted per day.
// The very first scan only builds the list, so it adds nothing.
async function addNewFollowers(n) {
  const g = await load(K.growth, []);
  const arr = Array.isArray(g) ? g : [];
  const d = dayKey();
  let last = arr[arr.length - 1];
  if (!last || last.d !== d) {
    if (!last || typeof last.f !== "number") return;
    last = { d, f0: last.f, f: last.f, g: last.g, t: Date.now() };
    arr.push(last);
    if (arr.length > GROWTH_DAYS) arr.splice(0, arr.length - GROWTH_DAYS);
  }
  last.nf = (Number(last.nf) || 0) + Math.max(0, Number(n) || 0);
  await save({ [K.growth]: arr });
}

// ===========================================================================
// HARVEST - newest followers of the source profiles -> scored queue
// ===========================================================================
function srcRate(src) { return src.followed >= 20 ? (src.back || 0) / src.followed : 0.3; }

// ---- v3.2 learning from YOUR results ---------------------------------------------------------------
// Every follow GrowX made more than 3 days ago is a result: they followed back, or they didn't. Grouped by the
// things that predict a follow-back (following/followers ratio, size, source), those results tell how much better
// or worse each group really does than your average - and the score is nudged by that much (at most +/-15, and
// +/-12 for the source). Smoothed, so a group with few results barely moves anything. Recomputed once an hour.
const learnMem = { at: 0, data: null };
const ratioBucket = (u) => (typeof u.fr === "number" && typeof u.fc === "number") ? (() => { const r = u.fr / Math.max(1, u.fc); return r >= 2 ? "r4" : r >= 1.2 ? "r3" : r >= 0.85 ? "r2" : r >= 0.5 ? "r1" : "r0"; })() : null;
const sizeBucket = (u) => typeof u.fc === "number" ? (u.fc < 100 ? "f0" : u.fc < 500 ? "f1" : u.fc < 1500 ? "f2" : u.fc < 5000 ? "f3" : "f4") : null;
async function learnData() {
  if (learnMem.data && Date.now() - learnMem.at < HOUR) return learnMem.data;
  const now = Date.now(), cut = now - 3 * DAY;
  const d = { n: 0, b: 0, rate: null, r: {}, f: {}, src: {} };
  const add = (map, k, back) => { if (!k) return; const x = map[k] || (map[k] = { n: 0, b: 0 }); x.n++; x.b += back; };
  for (const f of await getFollows()) {
    if (!f || !f.t || f.t > cut || f.fy0 || f.p || f.rf) continue;
    const back = f.fb ? 1 : 0;
    d.n++; d.b += back;
    add(d.r, ratioBucket(f), back); add(d.f, sizeBucket(f), back); add(d.src, f.s ? String(f.s).toLowerCase() : null, back);
  }
  d.rate = d.n ? d.b / d.n : null;
  learnMem.at = now; learnMem.data = d;
  return d;
}
const LEARN_K = 25;
const smooth = (x, L) => (x.b + LEARN_K * L.rate) / (x.n + LEARN_K);
function learnAdjust(u, L) {
  if (!L || L.n < 150 || L.rate == null) return 0;
  let a = 0;
  const rk = ratioBucket(u), fk = sizeBucket(u);
  if (rk && L.r[rk]) a += (smooth(L.r[rk], L) - L.rate) * 45;
  if (fk && L.f[fk]) a += (smooth(L.f[fk], L) - L.rate) * 45;
  return Math.max(-15, Math.min(15, Math.round(a)));
}
function srcBoost(h, L) {
  const x = L && L.rate != null && h ? L.src[String(h).toLowerCase()] : null;
  if (!x || x.n < 30) return 0;
  return Math.max(-12, Math.min(12, Math.round((smooth(x, L) - L.rate) * 40)));
}
// A source whose people keep not following back is paused once (you can switch it on again; it is not paused twice).
async function srcAutoPauseCheck(s) {
  if (!s.srcAutoPause) return;
  const L = await learnData();
  if (!L || L.rate == null) return;
  const sources = await getSources();
  let changed = false;
  for (const src of sources) {
    if (!src.enabled || src.ap) continue;
    const x = L.src[String(src.h || "").toLowerCase()];
    if (!x || x.n < s.srcPauseAfter) continue;
    const r = x.b / x.n;
    if (r * 100 < s.srcPauseBelow) {
      src.enabled = false; src.ap = Date.now(); src.note = `Paused by GrowX: only ${Math.round(r * 100)}% followed back (${x.b} of ${x.n}).`;
      changed = true;
      await pushEvent("warn", `Source @${src.h} paused: only ${Math.round(r * 100)}% of the ${x.n} people followed from it followed back (your average is ${Math.round(L.rate * 100)}%). Switch it on again on the Sources page if you want.`);
    }
  }
  if (changed) await saveSources();
}
const srcKey = (x) => String((x && x.h) || x || "").toLowerCase();
const freshDue = (src, s, now) => !src.lastTopAt || now - src.lastTopAt >= s.freshEveryHours * HOUR;
const readable = (src) => src.enabled && !["gone", "private", "error"].includes(src.status);

function sourceHasWork(src, s, now) {
  if (!src.enabled || ["gone", "private"].includes(src.status)) return false;
  if (src.pass || !src.id) return true;
  if (freshDue(src, s, now)) return true;
  return !!(src.cursor && !src.deepDone);
}

// Round-robin: every source takes turns, one page at a time. Sources never
// read go first, then newest-follower passes, then deeper reading (where the
// sources with the best follow-back rate get their turn sooner).
function pickSource(sources, s, now) {
  const tier = (x) => (!x.id || !x.lastHarvestAt) ? 0 : (x.pass || freshDue(x, s, now)) ? 1 : 2;
  const turn = (x) => (x.lastHarvestAt || 0) - (tier(x) === 2 ? (srcRate(x) - 0.3) * 2 * HOUR : 0);
  const ready = sources.filter((x) => sourceHasWork(x, s, now) && (x.nextAt || 0) <= now);
  ready.sort((a, b) => (tier(a) - tier(b)) || (turn(a) - turn(b)));
  return ready[0] || null;
}

// A sweep ("Find people now") reads every enabled source: its newest
// followers, or its next deeper pages, up to harvestPages pages each.
function newSweep(sources) {
  return { at: Date.now(), list: sources.filter(readable).map(srcKey), done: {}, pages: {}, added: {}, tries: {}, notes: {} };
}

function pickSweepSource(sweep, sources, now) {
  const byKey = new Map(sources.map((x) => [srcKey(x), x]));
  let wait = Infinity;
  const ready = [];
  for (const k of sweep.list) {
    if (sweep.done[k]) continue;
    const x = byKey.get(k);
    if (!x || !readable(x)) {
      sweep.done[k] = true;
      sweep.notes[k] = !x ? "removed" : !x.enabled ? "paused" : x.status === "private" ? "private" : x.status === "gone" ? "not found" : "couldn't be read";
      continue;
    }
    if ((x.nextAt || 0) > now) { wait = Math.min(wait, x.nextAt); continue; }
    ready.push(x);
  }
  ready.sort((a, b) => (a.lastHarvestAt || 0) - (b.lastHarvestAt || 0));
  return { src: ready[0] || null, wait };
}

function sweepSummary(sweep) {
  const total = Object.values(sweep.added).reduce((a, b) => a + b, 0);
  const parts = sweep.list.map((k) => "@" + k + (sweep.notes[k] ? " (" + sweep.notes[k] + ")" : " +" + (sweep.added[k] || 0)));
  return { total, text: `Searched ${plural(sweep.list.length, "source")} · +${total.toLocaleString()} people. ${parts.join(" · ")}` };
}

// When the next source will have something to read (for an empty queue).
function nextSourceTime(sources, s, now) {
  let best = Infinity;
  for (const x of sources) {
    if (!x.enabled || ["gone", "private"].includes(x.status)) continue;
    if (sourceHasWork(x, s, now)) best = Math.min(best, Math.max(now, x.nextAt || 0));
    else if (x.lastTopAt) best = Math.min(best, x.lastTopAt + s.freshEveryHours * HOUR);
  }
  return best;
}

function compact(u, score, src, now) {
  return {
    i: u.i, h: u.h, n: String(u.n || "").slice(0, 60), a: u.a || "",
    fc: u.fc, fr: u.fr, sc: u.sc, ca: u.ca || null, lt: u.lt || null,
    v: !!u.v, p: !!u.p, fy: u.fy === true, b: String(u.b || "").slice(0, 160), loc: u.loc || "",
    score, qs: GX.qualityScore(u), pos: typeof u.pos === "number" ? u.pos : undefined, src, at: now
  };
}

function sortPool(pool) {
  pool.sort((a, b) => ((b.pin ? 1 : 0) - (a.pin ? 1 : 0)) || ((b.score || 0) - (a.score || 0)) || ((b.at || 0) - (a.at || 0)));
  if (pool.length > POOL_MAX) pool.length = POOL_MAX;
}

// Follow mode, "Who first": best match first (the queue's own order), newest found first or oldest found first.
// People you pinned always come first.
function queueOrder(pool, s) {
  // v3.2 "Big score first": the highest Quality score first (everyone in the queue already passed your
  // follow-back score), the follow-back score breaks ties. Off = exactly the order below, as before.
  if (pool.length && s && s.followQuality) {
    const q = (c) => (c.qs != null ? c.qs : GX.qualityScore(c));
    return pool.slice().sort((a, b) => ((b.pin ? 1 : 0) - (a.pin ? 1 : 0)) || (q(b) - q(a)) || ((b.score || 0) - (a.score || 0)));
  }
  if (!pool.length || !s || !s.followOrder || s.followOrder === "score") return pool;
  const dir = s.followOrder === "new" ? -1 : 1;
  return pool.slice().sort((a, b) => ((b.pin ? 1 : 0) - (a.pin ? 1 : 0)) || dir * ((a.at || 0) - (b.at || 0)) || ((b.score || 0) - (a.score || 0)));
}

// The next person to follow: the first in your "Who first" order that is not waiting after a failed try.
function pickCandidate(pool, s, now) {
  const ordered = queueOrder(pool, s);
  return ordered.find((c) => !(c.later > now)) || ordered[0];
}

async function prunePool(s, now) {
  const pool = await getPool();
  const idx = await getFollowIndex();
  const bl = await getBlacklist();
  const byHandle = await followingHandles();
  const maxAge = s.poolMaxAgeHours * HOUR;
  const before = pool.length;
  const seen = new Set();
  for (let i = pool.length - 1; i >= 0; i--) {
    const c = pool[i];
    const k = String(c.h || "").toLowerCase();
    // Already followed - by id, or by name for a row that was added by name and
    // so has no id of its own. Plus the same name twice, and the usual rules.
    const refollowOk = c.rf && c.i && idx.has(c.i) && idx.get(c.i).nf;      // v3.2 "Follow again": the old record says unfollowed
    if ((c.i && idx.has(c.i) && !refollowOk) || (k && byHandle.has(k)) || (k && seen.has(k)) || bl.has(k)
        || (!c.manual && !c.pin && now - (c.at || 0) > maxAge)
        || (!c.manual && !c.rf && s.skipCapped && GX.atFollowCap(c))) { pool.splice(i, 1); continue; }
    if (k) seen.add(k);
  }
  if (pool.length !== before) await savePool();
  return pool;
}

// The @names you follow right now, lower-cased. (getFollowIndex is by user id;
// a list you paste is by name, so both are needed.)
async function followingHandles() {
  const out = new Set();
  for (const f of await getFollows()) {
    const h = String(f.h || "").toLowerCase();
    if (h && !f.nf) out.add(h);        // f.nf = you unfollowed them again
  }
  return out;
}

// Everyone GrowX has seen following you, as lower-cased @names where it knows
// one. Used to spot "they follow me, I don't follow them" in a pasted list.
async function followerHandles() {
  const ids = new Set();
  const bk = await load(K.bk, null);
  for (const i of ((bk && bk.followers) || [])) ids.add(String(i));
  for (const i of (await load(K.known, [])) || []) ids.add(String(i));
  const book = await handleBook();
  const out = new Map();                       // handle -> user id
  for (const i of ids) { const b = book.get(i); if (b && b.h) out.set(b.h.toLowerCase(), i); }
  // Someone who followed you back is a follower too, whatever list they are on.
  for (const f of await getFollows()) if (f.fb && !f.lost && f.h) out.set(String(f.h).toLowerCase(), String(f.i || ""));
  return out;
}

// One page of one source. With a sweep, the source comes from the sweep.
// Returns { called, added, halt?, waitUntil?, sweepDone? }.
async function harvestStep(ctx, s, sweep) {
  const now = Date.now();
  const sources = await getSources();
  let src;
  if (sweep) {
    const pick = pickSweepSource(sweep, sources, now);
    if (!pick.src) return pick.wait < Infinity ? { called: false, waitUntil: pick.wait } : { called: false, sweepDone: true };
    src = pick.src;
  } else {
    src = pickSource(sources, s, now);
    if (!src) return { called: false };
  }
  const key = srcKey(src);
  const sweepFail = (note) => {
    if (!sweep) return;
    sweep.tries[key] = (sweep.tries[key] || 0) + 1;
    if (!readable(src) || sweep.tries[key] >= 3) { sweep.done[key] = true; sweep.notes[key] = note || src.note || "couldn't be read"; }
  };

  if (!src.id) {
    const r = await sendTab(ctx.tabId, { gx: "resolve", handle: src.h }, 30000);
    if (r.uid && ctx.ownerId && r.uid !== ctx.ownerId) return { called: true, halt: "account" };
    if (!r.ok) {
      if (r.kind === "gone") { src.status = "gone"; src.note = r.message || "Account not found."; }
      else if (r.kind === "rate") { src.nextAt = now + Math.min(Math.max(r.waitMs || 15 * 60000, 60000), 3 * HOUR); ctx.readUntil = src.nextAt; }
      else if (["locked", "suspended", "automation"].includes(r.kind)) { await saveSources(); return { called: true, halt: r.kind, message: r.message }; }
      else { src.errors = (src.errors || 0) + 1; src.nextAt = now + Math.min(30, src.errors * 2) * 60000; src.note = r.message || "Lookup failed."; if (src.errors > 6) src.status = "error"; }
      if (r.kind !== "rate") sweepFail(src.status === "gone" ? "not found" : null);
      await saveSources();
      return { called: true };
    }
    const u = r.user;
    Object.assign(src, { id: u.i, h: u.h || src.h, n: u.n || "", a: u.a || "", fc: u.fc, fr: u.fr, v: !!u.v, p: !!u.p, status: "ok", note: "", errors: 0 });
    if (u.p && u.fw !== true) { src.status = "private"; src.note = "Private account - its followers can't be read."; if (sweep) { sweep.done[key] = true; sweep.notes[key] = "private"; } }
    src.nextAt = 0;
    await saveSources();
    return { called: true };
  }

  if (!src.pass) {
    if (freshDue(src, s, now)) src.pass = { fresh: true, first: !src.lastTopAt, pages: 0, offset: 0, cursor: null };
    else if (src.cursor && !src.deepDone) src.pass = { fresh: false, pages: 0, offset: 0, cursor: src.cursor };
    // You asked for new people now: re-read the newest followers anyway.
    else if (sweep) src.pass = { fresh: true, first: false, pages: 0, offset: 0, cursor: null };
    else { await saveSources(); return { called: false }; }
  }

  const r = await sendTab(ctx.tabId, { gx: "page", op: "Followers", userId: src.id, cursor: src.pass.cursor, count: 100 }, 90000);
  if (r.uid && ctx.ownerId && r.uid !== ctx.ownerId) return { called: true, halt: "account" };

  if (!r.ok) {
    switch (r.kind) {
      case "rate": {
        const ms = Math.min(Math.max(r.waitMs || 15 * 60000, 60000), 3 * HOUR);
        ctx.readUntil = now + ms;
        src.nextAt = now + ms;
        break;
      }
      case "private": src.status = "private"; src.note = r.message || "Its followers can't be read."; src.pass = null; break;
      case "gone": src.status = "gone"; src.note = r.message || "Account unavailable."; src.pass = null; break;
      case "locked": case "suspended": case "automation":
        await saveSources();
        return { called: true, halt: r.kind, message: r.message, waitMs: r.waitMs };
      case "auth":
        // Signed out, or X refusing just this list? The cookie tells.
        if (!r.uid) { await saveSources(); return { called: true, halt: "auth" }; }
        src.status = "private"; src.note = "X refused to show this account's followers."; src.pass = null; break;
      default:
        src.errors = (src.errors || 0) + 1;
        src.nextAt = now + Math.min(30, 2 * src.errors) * 60000;
        src.note = r.message || "Read failed.";
        if (src.errors > 6) { src.status = "error"; src.pass = null; }
        if (r.noAnswer) ctx.tabId = null;
    }
    if (r.kind !== "rate") sweepFail(src.status === "private" ? "private" : src.status === "gone" ? "not found" : null);
    await saveSources();
    return { called: true };
  }

  const seen = await getSeen();
  const idx = await getFollowIndex();
  const bl = await getBlacklist();
  const pool = await getPool();
  const inPool = new Set(pool.map((c) => c.i));
  let fresh = 0, added = 0, rejected = 0;
  const reasons = {};
  const L = s.learnScore ? await learnData() : null;
  const srb = L ? srcBoost(src.h, L) : 0;
  (r.users || []).forEach((u, i) => {
    if (!u || !u.i || u.i === ctx.ownerId) return;
    if (seen.has(u.i) || idx.has(u.i) || inPool.has(u.i)) return;
    fresh++;
    seen.add(u.i);
    if (bl.has(String(u.h).toLowerCase())) { rejected++; reasons.blacklist = (reasons.blacklist || 0) + 1; return; }
    if (src.pass.fresh) u.pos = src.pass.offset + i;
    const why = GX.rejectReason(u, s, now);
    if (why) { rejected++; reasons[why] = (reasons[why] || 0) + 1; return; }
    if (L) { u.lrn = learnAdjust(u, L); u.srb = srb; }
    const score = GX.scoreUser(u, s, now);
    if (score < s.minScore) { rejected++; reasons["low score"] = (reasons["low score"] || 0) + 1; return; }
    pool.push(compact(u, score, src.h, now));
    inPool.add(u.i);
    added++;
  });
  mem.seenDirty += 1;

  src.errors = 0;
  src.status = "ok";
  src.note = "";
  src.pages = (src.pages || 0) + 1;
  src.harvested = (src.harvested || 0) + (r.users || []).length;
  src.queued = (src.queued || 0) + added;
  src.rejected = (src.rejected || 0) + rejected;
  src.lastHarvestAt = now;
  src.reasons = src.reasons || {};
  for (const [k, v] of Object.entries(reasons)) src.reasons[k] = (src.reasons[k] || 0) + v;
  src.pass.pages++;
  src.pass.offset += (r.users || []).length;
  const end = !!r.end || !r.cursor;

  if (src.pass.fresh) {
    // The very first pass also walks into the deep list; later fresh passes
    // only pick up followers who arrived since, and leave the deep cursor alone.
    if (src.pass.first) { src.cursor = end ? null : r.cursor; src.deepDone = end; }
    const caughtUp = !src.pass.first && fresh === 0;
    if (end || caughtUp || src.pass.pages >= s.harvestPages) { src.lastTopAt = now; src.pass = null; }
    else src.pass.cursor = r.cursor;
  } else {
    src.cursor = end ? null : r.cursor;
    if (end) { src.deepDone = true; src.pass = null; }
    else if (src.pass.pages >= Math.max(2, s.harvestPages)) src.pass = null;
    else src.pass.cursor = r.cursor;
  }
  if (sweep) {
    sweep.pages[key] = (sweep.pages[key] || 0) + 1;
    sweep.added[key] = (sweep.added[key] || 0) + added;
    if (!src.pass || sweep.pages[key] >= s.harvestPages) sweep.done[key] = true;
  }
  // Pacing between reads is global (nextReadAt); a source only waits after errors.
  src.nextAt = 0;
  if (r.rate && r.rate.remaining !== null && r.rate.remaining <= 1 && r.rate.resetAt) ctx.readUntil = r.rate.resetAt + 3000;

  sortPool(pool);
  await save({ [K.pool]: pool, [K.sources]: sources });
  await flushSeen(false);
  if (added) await bumpStats({ queued: added });
  return { called: true, added, fresh, src: src.h };
}

// ===========================================================================
// FOLLOW-BACK DETECTION
//
// 1. Direct checks (primary): every follow is checked 30 min, 2 h, 8 h,
//    1 day, 3 days, 7 days and 14 days after it happened, 100 accounts per
//    request, by asking X whether each one follows you - the same fact behind
//    the "Follows you" badge. Order and size of your followers list don't
//    matter.
// 2. Full follower scan (backstop, every few hours): every follower id,
//    5,000 per request, matched against everyone GrowX followed. Falls back
//    to reading the followers list page by page.
// ===========================================================================
// ===========================================================================
// UNFOLLOWED YOU (v2.7.6)
//   A separate list of accounts that followed you and later stopped - "detected unfollowers".
//   They are found from reads GrowX already does, so this costs no extra requests to X:
//     * the full follower scan (fbStep): a complete follower list, so anyone missing from it has left
//     * the direct follow-back checks (relStep)
//     * the re-check right before an unfollow (unfollowStep)
//     * the re-check right before a follow-back (bkNextBatch)
//   Nobody is unfollowed because of this list. You pick who goes to Unfollow mode (one by one, or all
//   the eligible ones at once) and only then are they queued.
// ===========================================================================
const LOST_MAX = 5000;
function newLost(owner) { return { owner, list: [], at: 0 }; }
async function getLost(owner) {
  const l = await load(K.lost, null);
  return l && l.owner === owner ? l : newLost(owner);
}
async function saveLost(l) {
  if (l.list.length > LOST_MAX) l.list.length = LOST_MAX;
  await save({ [K.lost]: l });
}
// Accounts that stopped following you. `rows` = [{ i, h, n, a, fbAt }]. Returns how many were new.
// An account already on the list is left alone, so "found today" keeps meaning the day it was first seen.
async function addLost(owner, rows, src, now) {
  if (!owner || !rows || !rows.length) return 0;
  const l = await getLost(owner);
  const have = new Set(l.list.map((x) => x.i));
  let added = 0;
  for (const r of rows) {
    if (!r || !r.i || have.has(r.i)) continue;
    have.add(r.i);
    l.list.unshift({ i: r.i, h: r.h || "", n: r.n || "", a: r.a || "", t: now, fbAt: r.fbAt || 0, src, sel: 0, uf: 0 });
    added++;
  }
  if (!added) return 0;
  l.at = now;
  await saveLost(l);
  await bumpStats({ lost: added });
  await pushEvent("fb", `${plural(added, "account")} stopped following you (found by the ${src === "scan" ? "follower scan" : "follow-back check"}). See the "Unfollowed you" page.`);
  return added;
}
// How many were found today (what the dashboard shows as "today's count").
function lostToday(l, now) {
  const from = startOfToday(now);
  return (l && l.list ? l.list : []).filter((x) => x.t >= from).length;
}
// Which of them you can still unfollow: you follow them, they are not on your keep list, and GrowX has not
// unfollowed them already. (Accounts you never followed can be on the list, but cannot be unfollowed.)
function lostEligible(x, idx, keep) {
  if (!x || x.uf) return false;
  if (x.h && keep && keep.has(String(x.h).toLowerCase())) return false;
  const f = idx.get(x.i);
  return !!(f && !f.nf);
}

// The accounts you ticked on the "Unfollowed you" page, ready for Unfollow mode. They jump the queue, because
// you chose them yourself - but they still go through the same re-check, the same keep list, the same daily
// number and the same breaks as every other unfollow. A tick that is no longer eligible is quietly dropped.
// `opts.any`: take every unfollower that can still be unfollowed, not only the ones you ticked. That is what
// "Who first: people who unfollowed you" uses - the same list, just without needing a tick on each row.
async function pickLostIds(owner, s, now, opts) {
  const any = !!(opts && opts.any);
  const l = await getLost(owner);
  if (!any && !l.list.some((x) => x.sel)) return [];
  const idx = await getFollowIndex();
  const keep = keepSet(s);
  const out = [];
  let changed = false;
  for (const x of l.list) {
    if (!any && !x.sel) continue;
    if (!lostEligible(x, idx, keep)) { if (x.sel) { x.sel = 0; changed = true; } continue; }
    if (out.length < 100) out.push(x.i);
  }
  if (changed) await saveLost(l);
  return out;
}
// One of them has been unfollowed: tick off, and never offer it again.
async function markLostDone(owner, id, now) {
  const l = await getLost(owner);
  const x = l.list.find((y) => y.i === id);
  if (!x) return;
  x.uf = now;
  x.sel = 0;
  await saveLost(l);
}

const fbPending = (f, owner) => !!f.i && !f.fb && !f.fy0 && !f.nf && (!f.o || !owner || f.o === owner);

function nextCheckAt(f, now) {
  let k = f.k || 0;
  while (k < FB_SCHEDULE.length && f.t + FB_SCHEDULE[k] <= now) k++;
  f.k = k;
  f.c = k < FB_SCHEDULE.length ? f.t + FB_SCHEDULE[k] : 0;
}

// Earliest scheduled direct check (Infinity if none).
function relNextDue(follows, owner) {
  let best = Infinity;
  for (let i = follows.length - 1; i >= 0; i--) {
    const f = follows[i];
    if (f.c && f.c < best && fbPending(f, owner)) best = f.c;
  }
  return best;
}

// Up to 100 accounts to check now: due ones, or - for "Check now" - every
// pending follow from the last 30 days not checked since the request.
const RECHECK_AFTER = 7 * DAY;     // a follow-back is looked at again this long after the last look
async function relPick(ctx, now) {
  const follows = await getFollows();
  const force = ctx.relForce;
  const out = [];
  for (let i = follows.length - 1; i >= 0 && out.length < 100; i--) {
    const f = follows[i];
    if (!fbPending(f, ctx.ownerId)) continue;
    if (force) { if (now - f.t < 30 * DAY && (f.lc || 0) < force.since) out.push(f); }
    else if (f.c && f.c <= now) out.push(f);
  }
  // One request asks X about up to 100 accounts, so any room left over is free: fill it with people who DID follow
  // back and haven't been looked at for a while. That is how unfollowers are noticed without a single extra request.
  if (out.length && out.length < 100) {
    const re = [];
    for (const f of follows) {
      if (!f.i || !f.fb || f.nf || f.lost) continue;
      if (f.o && ctx.ownerId && f.o !== ctx.ownerId) continue;
      if (now - Math.max(f.lc || 0, f.fb) < RECHECK_AFTER) continue;
      re.push(f);
    }
    re.sort((a, b) => Math.max(a.lc || 0, a.fb) - Math.max(b.lc || 0, b.fb));   // longest unchecked first
    out.push(...re.slice(0, 100 - out.length));
  }
  return out;
}

async function relStep(ctx, s) {
  const now = Date.now();
  const batch = await relPick(ctx, now);
  if (!batch.length) { if (ctx.relForce) ctx.relForce = null; return { called: false }; }
  const r = await sendTab(ctx.tabId, { gx: "rel", ids: batch.map((f) => f.i) }, 60000);
  if (r.uid && ctx.ownerId && r.uid !== ctx.ownerId) return { called: true, halt: "account" };
  const info = await load(K.fbinfo, {});
  if (!r.ok) {
    if (["locked", "suspended", "automation"].includes(r.kind)) return { called: true, halt: r.kind, message: r.message, waitMs: r.waitMs };
    if (r.kind === "auth" && !r.uid) return { called: true, halt: "auth" };
    ctx.relErrors = (ctx.relErrors || 0) + 1;
    ctx.relUntil = now + (r.kind === "rate" ? Math.min(Math.max(r.waitMs || 15 * MIN, MIN), 3 * HOUR) : Math.min(60, 5 * ctx.relErrors) * MIN);
    if (r.noAnswer && !ctx.ownTab) ctx.tabId = null;
    // X won't answer direct checks right now: the full follower scan still finds follow-backs.
    if (r.kind !== "rate" && ctx.relErrors >= 2 && !ctx.fb) ctx.nextFbAt = now;
    Object.assign(info, { error: r.message || r.kind || "no answer", errorAt: now });
    await save({ [K.fbinfo]: info });
    return { called: true };
  }
  ctx.relErrors = 0;
  const sources = await getSources();
  const bySrc = new Map(sources.map((x) => [srcKey(x), x]));
  let found = 0;
  const gone = [];
  for (const f of batch) {
    f.lc = now;
    const rel = r.map && r.map[f.i];
    // A settled follow-back looked at again (relPick tops the batch up with these for free); a pending follow has no f.fb.
    const again = !!f.fb;
    if (again) {
      if (rel && rel.fy === false && !f.nf) { f.lost = now; gone.push({ i: f.i, h: f.h, n: f.n, a: f.a, fbAt: f.fb }); }
      else if (rel && rel.fy) f.lost = 0;                 // still following you
      continue;
    }
    if (rel && rel.fy) {
      f.fb = now;
      f.c = 0;
      found++;
      const src = f.s && bySrc.get(srcKey(f.s));
      if (src) src.back = (src.back || 0) + 1;
    } else if (rel && rel.fw === false && !rel.pending && !f.p) {
      f.nf = 1;           // you don't follow them any more (unfollowed here, or somewhere else)
      f.c = 0;
    } else {
      nextCheckAt(f, now);
    }
  }
  if (gone.length) await addLost(ctx.ownerId, gone, "check", now);
  await saveFollows();
  if (found) { await saveSources(); await bumpStats({ back: found }); }
  ctx.relDone = (ctx.relDone || 0) + batch.length;
  ctx.relFound = (ctx.relFound || 0) + found;
  Object.assign(info, { at: now, via: r.via, checked: batch.length, found, error: null, errorAt: null });
  await save({ [K.fbinfo]: info });
  if (found) await pushEvent("fb", `${plural(found, "new follow-back")} (checked ${plural(batch.length, "account")} directly)`, { n: found });
  return { called: true, found };
}

async function fbStep(ctx, s) {
  const now = Date.now();
  const known = await getKnown();
  // After the id list failed, the followers list is used for a day, then ids are tried again.
  const listMode = ctx.fbMode === "list" && now - (ctx.fbModeAt || 0) < DAY;
  if (!ctx.fb) ctx.fb = { mode: listMode ? "list" : "ids", cursor: null, pages: 0, fresh: 0, matched: 0, quiet: 0, first: known.size === 0, errors: 0, at: now };
  const fb = ctx.fb;
  if (!mem.scan || mem.scan.key !== fb.at) mem.scan = { key: fb.at, ids: new Set(), pages: 0, from: fb.pages };
  const r = fb.mode === "ids"
    ? await sendTab(ctx.tabId, { gx: "fids", userId: ctx.ownerId, cursor: fb.cursor }, 90000)
    : await sendTab(ctx.tabId, { gx: "page", op: "Followers", userId: ctx.ownerId, cursor: fb.cursor, count: 100 }, 90000);
  if (r.uid && ctx.ownerId && r.uid !== ctx.ownerId) return { called: true, halt: "account" };
  if (!r.ok) {
    if (r.kind === "rate") { ctx.readUntil = now + Math.min(Math.max(r.waitMs || 15 * MIN, MIN), 3 * HOUR); return { called: true }; }
    if (["auth", "locked", "suspended", "automation"].includes(r.kind)) return { called: true, halt: r.kind, message: r.message, waitMs: r.waitMs };
    if (fb.mode === "ids" && fb.pages === 0) {
      // The follower-id list isn't available: read the followers list instead.
      fb.mode = "list";
      ctx.fbMode = "list";
      ctx.fbModeAt = now;
      fb.cursor = null;
      return { called: true };
    }
    fb.errors++;
    if (r.noAnswer && !ctx.ownTab) ctx.tabId = null;
    if (fb.errors > 3) {
      ctx.fb = null;
      ctx.nextFbAt = now + HOUR;
      const info = await load(K.fbinfo, {});
      await save({ [K.fbinfo]: Object.assign(info, { scanError: r.message || r.kind || "no answer", scanErrorAt: now }) });
    }
    return { called: true };
  }
  const ids = fb.mode === "ids" ? (r.ids || []).map(String) : (r.users || []).map((u) => u && u.i).filter(Boolean);
  const idx = await getFollowIndex();
  const pool = await getPool();
  const sources = await getSources();
  const bySrc = new Map(sources.map((x) => [srcKey(x), x]));
  const followers = new Set(ids);
  for (const id of ids) mem.scan.ids.add(id);
  mem.scan.pages++;
  let unknown = 0, matched = 0;
  for (const id of ids) {
    if (!known.has(id)) { unknown++; known.add(id); if (!fb.first) fb.fresh++; }
    const f = idx.get(id);
    if (f && !f.fb && !f.fy0 && (!f.o || f.o === ctx.ownerId)) {
      f.fb = now;
      f.c = 0;
      f.nf = 0;
      matched++;
      const src = f.s && bySrc.get(srcKey(f.s));
      if (src) src.back = (src.back || 0) + 1;
    }
  }
  const before = pool.length;
  for (let i = pool.length - 1; i >= 0; i--) if (pool[i].i && followers.has(pool[i].i)) pool.splice(i, 1);   // already follow you
  fb.matched += matched;
  fb.pages++;
  fb.cursor = r.cursor;
  fb.quiet = unknown ? 0 : fb.quiet + 1;
  const maxPages = fb.mode === "ids" ? 20 : fb.first ? 8 : 15;
  const atEnd = !!(r.end || !r.cursor);                 // X has no more pages: the list we read is complete
  const done = atEnd || fb.pages >= maxPages || (fb.mode === "list" && !fb.first && fb.quiet >= 2);
  if (matched) { await saveFollows(); await saveSources(); }
  if (pool.length !== before) await savePool();
  if (done) {
    await saveKnown();
    // A COMPLETE id scan is the one moment we know exactly who follows you: anyone who followed back and is missing
    // from it has unfollowed you. Anything less proves nothing and is never used here - not a scan cut short by the
    // page limit, not the followers list instead of the ids, and not one whose first pages were read by a worker that
    // has since been replaced (the job survives that, this in-memory set does not, so `pages` must cover them all).
    if (atEnd && fb.mode === "ids" && mem.scan && mem.scan.ids.size && mem.scan.pages === fb.pages && !mem.scan.from) {
      const all = mem.scan.ids;
      const gone = [];
      let touched = false;
      for (const f of await getFollows()) {
        if (!f.i || f.nf || f.lost) continue;
        if (f.o && ctx.ownerId && f.o !== ctx.ownerId) continue;
        if (!(f.fb || f.fy0)) continue;                 // never followed you in the first place: not an unfollower
        if (all.has(f.i)) continue;
        f.lost = now;
        touched = true;
        gone.push({ i: f.i, h: f.h, n: f.n, a: f.a, fbAt: f.fb || f.t });
      }
      if (touched) await saveFollows();
      if (gone.length) await addLost(ctx.ownerId, gone, "scan", now);
    }
    mem.scan = null;
    if (fb.matched) await bumpStats({ back: fb.matched });
    const acc = await refreshAccount(ctx.tabId);
    if (!fb.first) await addNewFollowers(fb.fresh);
    const msg = fb.first
      ? `Follower scan done: ${plural(known.size, "follower")} indexed${fb.matched ? ", " + plural(fb.matched, "follow-back") + " found" : ""}.`
      : `Follower scan: ${plural(fb.matched, "new follow-back")} · ${plural(fb.fresh, "new follower")}${acc && typeof acc.followers === "number" ? " · " + acc.followers.toLocaleString() + " followers" : ""}`;
    await pushEvent("fb", msg, { n: fb.matched });
    const info = await load(K.fbinfo, {});
    await save({ [K.fbinfo]: Object.assign(info, { scanAt: now, scanVia: fb.mode, scanFound: fb.matched, scanFresh: fb.fresh, scanError: null, scanErrorAt: null }) });
    ctx.lastFb = { at: now, matched: fb.matched, fresh: fb.fresh, first: fb.first, mode: fb.mode };
    ctx.fb = null;
    ctx.nextFbAt = now + s.fbCheckHours * HOUR;
  }
  return { called: true };
}

// Follow-backs keep happening while the autopilot is off: check them now and
// then through an open x.com tab (never opening one just for this).
async function idleFollowBacks() {
  const now = Date.now();
  const meta = await load(K.meta, {});
  if (!meta.ownerId || now - (meta.idleFbAt || 0) < 20 * MIN) return;
  const job = await load(K.job, null);
  if (job && job.status === "halted" && ["locked", "suspended", "automation"].includes(job.haltKind)) return;
  if (relNextDue(await getFollows(), meta.ownerId) > now) return;
  meta.idleFbAt = now;
  await save({ [K.meta]: meta });
  const got = await acquireTab(null, { create: false });
  if (!got) return;
  const p = await ping(got.tabId);
  if (!p || p.uid !== meta.ownerId) return;
  const ctx = { tabId: got.tabId, ownerId: meta.ownerId };
  const s = await getSettings();
  for (let i = 0; i < 5; i++) {
    const r = await relStep(ctx, s);
    if (!r.called || r.halt || ctx.relUntil) break;
    await sleep(rand(1500, 3000));
  }
}

// ===========================================================================
// VERIFY - are recent follows really on your Following list? A quiet drop
// means X is silently limiting the account: stop and rest instead of
// burning through the queue.
// ===========================================================================
async function verifyStep(job, s) {
  const now = Date.now();
  const ids = (job.verify && job.verify.ids) || [];
  const r = await sendTab(job.tabId, { gx: "page", op: "Following", userId: job.ownerId, cursor: null, count: 100 }, 90000);
  if (r.uid && job.ownerId && r.uid !== job.ownerId) return { called: true, halt: "account" };
  if (!r.ok) {
    if (r.kind === "rate") { job.readUntil = now + Math.min(Math.max(r.waitMs || 15 * 60000, 60000), 3 * HOUR); return { called: true }; }
    if (["auth", "locked", "suspended", "automation"].includes(r.kind)) return { called: true, halt: r.kind, message: r.message, waitMs: r.waitMs };
    job.verify.tries = (job.verify.tries || 0) + 1;
    if (job.verify.tries > 2) job.verify = { ids: [] };
    if (r.noAnswer) job.tabId = null;
    return { called: true };
  }
  const have = new Set((r.users || []).map((u) => u.i));
  const present = ids.filter((id) => have.has(id)).length;
  job.verify = { ids: [] };
  job.lastVerify = { at: now, checked: ids.length, present };
  if (ids.length >= 4 && present / ids.length < 0.5) {
    job.softHits = (job.softHits || 0) + 1;
    // X quietly dropped follows: rest for the step-1 time of your X-refused plan (it is a hint, not a clear "no", so no longer steps).
    const plan = GX.refusePlan(s, modeNow(s));
    const ms = plan.on0 ? rand(plan.lo0, plan.hi0) : plan.on1 ? rand(plan.lo1, plan.hi1) : Math.min(2 * HOUR * job.softHits, 8 * HOUR);
    if (s.autoSlowdown) job.throttle = { factor: Math.min((job.throttle && job.throttle.until > now ? job.throttle.factor : 1), 0.6), until: now + 48 * HOUR, why: "follows not sticking" };
    await pushEvent("warn", `Only ${present} of your last ${ids.length} follows stuck. X may be quietly limiting follows - resting ${fmtSpan(ms)}.`);
    await notify("soft", "GrowX is resting", `X didn't keep ${ids.length - present} of your last ${ids.length} follows. Resting for safety, then continuing slower.`);
    return { called: true, rest: { reason: "soft", ms, message: `Follows weren't sticking - resting until ${clock(now + ms)} for safety.` } };
  }
  job.softHits = 0;
  return { called: true };
}

// ===========================================================================
// THE RUN (autopilot)
// ===========================================================================
// `forceMode`: the mode the caller already decided on (the daily auto-start does, because it also has to
// respect each mode's ON / OFF hours). Left out, Start decides for itself.
async function startJob(forceMode, why) {
  const cur = await load(K.job, null);
  if (cur && ACTIVE.has(cur.status)) return { ok: false, error: "Autopilot is already running." };
  const task = await load(K.task, null);
  if (task && task.status === "running") { task.status = "idle"; await save({ [K.task]: task }); }

  let s = await getSettings();
  // With automatic switching on, Start always begins at the first mode of your sequence that still has work,
  // whichever mode tile is lit. Without it, the tile decides, exactly as before.
  let begin = forceMode || null;
  if (!begin && GX.cycling(s)) {
    begin = await startMode(s, cur, Date.now());
    if (!begin) {
      return { ok: false, error: `Every mode in your sequence is finished for today (${GX.modeSeq(s).map((m) => MODE_NAME[m]).join(", ")}). It starts again tomorrow - or switch automatic switching off to run one mode on its own.` };
    }
  }
  if (begin) s = await useMode(s, begin, why || (forceMode ? "Auto-start" : "Start"));
  const sources = await getSources();
  const pool = await getPool();
  if (s.runMode === "follow" && !sources.some((x) => x.enabled && !["gone", "private"].includes(x.status)) && !pool.length) {
    return { ok: false, error: "Add at least one source profile first (Sources page).", needSources: true };
  }
  if (s.runMode === "comment" && !s.cmtOn) {
    return { ok: false, cmtOff: true, error: "Comment mode is switched off. Turn it on at the top of the Comment page." };
  }
  if (s.runMode === "comment" && !(await cmtKey())) {
    return { ok: false, needKey: true, error: "Comment mode needs your OpenAI key. Add it in Comment settings, then press Start." };
  }
  // X refused follows twice today: following (and following back) stays off until tomorrow. Unfollow mode still works.
  if (s.runMode !== "unfollow" && s.runMode !== "comment" && xLimitedToday(await load(K.meta, {}), cur, Date.now())) {
    return { ok: false, xLimited: true, error: `X has limited following on your account today, so ${MODE_NAME[s.runMode]} stays off until tomorrow to keep the account safe. Unfollow mode still works.` };
  }
  if (s.runMode === "unfollow" && uLimitedToday(await load(K.meta, {}), cur, Date.now())) {
    return { ok: false, uLimited: true, error: "X kept refusing unfollows on your account today, so Unfollow stays off until tomorrow to keep the account safe. Follow and Follow back still work." };
  }

  const got = await acquireTab(null, { create: true });
  if (!got) return { ok: false, error: "Couldn't open X. Check that x.com loads in this browser." };
  const p = await ping(got.tabId);
  const uid = p && p.uid;
  if (!uid) {
    if (got.created) { try { await chrome.tabs.remove(got.tabId); } catch (_) {} }
    return { ok: false, error: "You're not signed in to X. Sign in at x.com first.", needLogin: true };
  }
  const acc = await refreshAccount(got.tabId);

  const meta = await load(K.meta, {});
  if (s.warmup && !meta.warmupAt) { meta.warmupAt = Date.now(); await save({ [K.meta]: meta }); }
  await switchOwner(meta, uid);

  const known = await getKnown();
  const now = Date.now();
  // With daily auto-start the run target is a number for the DAY: a run started later the same day (after a Stop, or after
  // switching modes) only does what is left of it - it never starts a second full target.
  const doneToday = s.autoStart ? (await getFollows()).filter((f) => f.t >= startOfToday(now) && (!f.o || f.o === uid)).length : 0;
  const job = {
    id: now.toString(36), status: "running", ownerId: uid, handle: (acc && acc.handle) || "",
    startedAt: now, runMode: s.runMode, mode: s.runMode, done: 0, skipped: 0, failed: 0, pending: 0,
    dayKey: s.autoStart ? new Date(now).toDateString() : undefined, dayBase: -doneToday,
    sinceRest: 0, restAfter: restAfter(s, "follow"), restBase: restKey(s, "follow"), sinceExtra: [],
    nextAt: now, nextReadAt: now, nextFbAt: known.size ? now + 5 * 60000 : now + 20000, nextAcctAt: now + 30 * 60000,
    executor: "api", tabId: got.tabId, ownTab: got.created, workerTabId: null,
    consecutiveFails: 0, targetFails: 0, rateHits: 0, softHits: 0, tabWaits: 0,
    throttle: cur && cur.throttle && cur.throttle.until > now && !cur.throttle.limitProbe ? cur.throttle : null,
    autoHits: cur && Array.isArray(cur.autoHits) ? cur.autoHits.filter((t) => now - t < 48 * HOUR) : [],
    verify: { ids: [] }, current: null, inFlight: null, message: "Starting autopilot...", log: [],
    cdone: 0, cmtSince: 0, cmtRestAfter: restAfter(s, "comment"), cmtRestBase: restKey(s, "comment"), cmtFails: 0,
    // Automatic mode switching: what already reached its target today carries over, so a Stop + Start never redoes a mode.
    switchDone: cur && cur.switchDone && cur.switchDone.day === dayKey(now) ? cur.switchDone : { day: dayKey(now), modes: [] },
    switchDay: dayKey(now), switchN: cur && cur.switchDay === dayKey(now) ? (cur.switchN || 0) : 0, trans: null, turnDone: 0
  };
  await save({ [K.job]: job });
  await protectTab(got.tabId, true);
  await pushEvent("run", "Autopilot started.");
  tgSend("run", `<b>GrowX started</b>\n${MODE_NAME[s.runMode]} mode.`);
  if (s.keepAwake) syncPower(true);
  scheduleTick(300);
  return { ok: true };
}

// Daily auto-start: begins a run by itself at the time you set (Chrome must be
// open). It never overrides a paused/halted run, never starts twice in one day,
// and does not restart a run you stopped yourself today.
// v2.2.1: no clicking needed. A run that stopped for a recoverable reason (repeated X refusals,
// x.com tab not reachable, signed out) restarts by itself after a cool-down, inside your Active hours.
// It does NOT restart by itself when X locked/restricted the account or flagged it as automated -
// pushing on in that state is what gets accounts suspended.
const RECOVERABLE = { errors: 90 * MIN, tab: 10 * MIN, auth: 30 * MIN };
const MAX_RECOVERIES_PER_DAY = 4;
async function maybeAutoRecover(job) {
  try {
    if (!job || job.status !== "halted" || !(job.haltKind in RECOVERABLE)) return false;
    const now = Date.now();
    if (!job.recoverAt) {
      job.recoverAt = now + RECOVERABLE[job.haltKind];
      job.message = `${job.message} GrowX restarts by itself at ${clock(job.recoverAt)}.`;
      await save({ [K.job]: job });
      return false;
    }
    if (now < job.recoverAt) return false;
    const s = await getSettings();
    if (!GX.inWindow(s, now)) return false;
    const day = new Date(now).toDateString();
    if (job.recoverDay !== day) { job.recoverDay = day; job.recoveries = 0; }
    if ((job.recoveries || 0) >= MAX_RECOVERIES_PER_DAY) return false;   // tomorrow's auto-start takes over
    job.recoveries = (job.recoveries || 0) + 1;
    job.recoverAt = null;
    await save({ [K.job]: job });
    await pushEvent("run", `Restarting by itself after a stop (${job.recoveries}/${MAX_RECOVERIES_PER_DAY} today).`);
    const r = await controlJob("resume");
    if (r && r.ok) { scheduleTick(500); return true; }
  } catch (e) { console.error("[gx] autorecover:", e); }
  return false;
}

async function maybeAutoStart() {
  try {
    let s = await getSettings();
    if (!s.autoStart) return false;
    const now = Date.now();
    const d = new Date(now);
    const meta0 = await load(K.meta, {});
    const dkey = d.toDateString();
    if (meta0.autoOffsetDay !== dkey) {                       // a different small delay each day, like a person
      meta0.autoOffsetDay = dkey;
      meta0.autoOffset = Math.round(rand(0, s.autoStartJitter));
      await save({ [K.meta]: meta0 });
    }
    if (d.getHours() * 60 + d.getMinutes() < GX.autoStartMinutes(s) + (meta0.autoOffset || 0)) return false;
    const job = await load(K.job, null);
    if (job && job.status === "paused") return false;                                  // you paused it yourself
    if (job && job.status === "halted" && !(job.haltKind in RECOVERABLE)) return false;   // account warning: needs you
    // With automatic switching on the sequence decides where the day begins, exactly as it does when you press
    // Start yourself: the first mode in your order that still has work and is inside its own hours. Nothing is
    // saved here - startJob writes the mode only when a run really begins.
    const cyc = GX.cycling(s);
    let begin = s.runMode;
    if (cyc) {
      begin = await startMode(s, job, now, { inWindow: true });
      if (!begin) return false;                       // nothing in the sequence can run right now
      s = GX.modeSettings(Object.assign({}, s, { runMode: begin }));   // that mode's own hours and numbers, unsaved
    }
    if (!GX.inWindow(s, now)) return false;
    // Already ran today IN THIS MODE (started, stepped or finished today - a run that crossed midnight still counts).
    // Picking a different mode (e.g. Follow back after Follow) starts that mode's own run. With a sequence running a
    // mode comes round again on purpose, so there the sequence itself (finished today / nothing left) is the guard.
    if (!cyc && job && ranToday(job, now) && jobMode(job) === s.runMode) return false;
    const meta = await load(K.meta, {});
    if (xLimitedToday(meta, job, now) && s.runMode !== "unfollow") return false;      // X limited follows today (Follow + Follow back share X's follow limit)
    if (uLimitedToday(meta, job, now) && s.runMode === "unfollow") return false;      // X kept refusing unfollows today
    const key = new Date(now).toDateString();
    // A start that fails (x.com still loading, offline for a moment, ...) is tried again every minute at first, then every
    // 5 minutes, then every 20 minutes, all day inside your hours - a short outage must never cost a whole day.
    const tries = meta.autoStartDay === key ? (meta.autoStartTries || 0) : 0;
    if (tries >= 40) return false;
    if (now - (meta.autoStartAt || 0) < (tries < 5 ? 0 : tries < 12 ? 5 * MIN : 20 * MIN)) return false;
    const L = GX.effectiveLimits(s, meta, null, now);
    const rolling = s.dailyWindow === "rolling";       // a rolling 24-hour count frees up by itself: the run starts and rests until then
    if (s.runMode === "unfollow") { if (await unfToday(now) >= s.unfollowDaily) return false; }
    else if (s.runMode === "followback") {
      if (await bkToday(now) >= s.bkDaily) return false;
      if (!rolling && dayEntries(await getLedger(), s, now).length >= L.daily) return false;
    }
    else if (!rolling && dayEntries(await getLedger(), s, now).length >= L.daily) return false;
    meta.autoStartTries = tries + 1;
    meta.autoStartDay = key;
    meta.autoStartAt = now;
    await save({ [K.meta]: meta });
    const r = await startJob(cyc ? begin : null, "Auto-start");
    if (r && r.ok) {
      await pushEvent("run", `Auto-start: began today's run.`);
      await notify("milestone", "GrowX auto-started", "Today's run has started.");
      return true;
    }
    if (tries < 3 || tries % 10 === 0) await pushEvent("warn", `Auto-start couldn't begin: ${(r && r.error) || "unknown"}. GrowX keeps trying by itself.`);
  } catch (e) { console.error("[gx] autostart:", e); }
  return false;
}

// The queue and the follower index belong to one X account. Signing in as
// someone else starts those fresh (history is kept, tagged by account).
async function switchOwner(meta, uid) {
  if (meta.ownerId === uid) return;
  if (meta.ownerId) {
    mem.pool = []; mem.known = new Set(); mem.seen = new Set(); mem.seenDirty = 0;
    await save({ [K.pool]: [], [K.known]: [], [K.seen]: [] });
  }
  meta.ownerId = uid;
  await save({ [K.meta]: meta });
}

// Break timing (v2.7.6). Every mode has its own two ranges, and a break always stays inside them:
//   how many actions before a break   a random whole number between Min and Max  (restAfter)
//   how long the break lasts          a random time between Min and Max          (GX.breakMs)
// The same number twice means exactly that number - which is what older versions did, so an upgrade changes nothing.
// How many follows before the next break: a random whole number between "from" and "to" (e.g. 12 to 15), never more than "to".
function batchSize(lo, hi) {
  hi = Math.max(1, Math.round(hi));
  lo = Math.max(1, Math.min(hi, Math.round(lo || hi)));
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}
// Actions before the next break, for any mode (Infinity = this mode takes no breaks).
function restAfter(s, mode) {
  if (mode === "comment") return s.cmtRestEvery ? batchSize(s.cmtRestEveryMin, s.cmtRestEvery) : Infinity;
  if (mode === "unfollow") return s.unfRestEvery ? batchSize(s.unfRestEveryMin, s.unfRestEvery) : Infinity;
  if (mode === "followback") return s.bkRestEvery ? batchSize(s.bkRestEveryMin, s.bkRestEvery) : Infinity;
  if (!s.restEvery) return Infinity;
  return batchSize(s.restEveryMin, s.restEvery);
}
// The break settings of a mode as one string: changing any of them mid-run draws a fresh count and a fresh length.
const restKey = (s, mode) => mode === "comment" ? [s.cmtRestEveryMin, s.cmtRestEvery, s.cmtRestMinutes, s.cmtRestMinutesMax].join("/")
  : mode === "unfollow" ? [s.unfRestEveryMin, s.unfRestEvery, s.unfRestMinutes, s.unfRestMinutesMax].join("/")
  : mode === "followback" ? [s.bkRestEveryMin, s.bkRestEvery, s.bkRestMinutes, s.bkRestMinutesMax].join("/")
  : [s.restEveryMin, s.restEvery, s.restMinutes, s.restMinutesMax].join("/");
// A break of `ms` in plain words: "18 min", or "21 min of 18-24" when the range is wider.
function breakText(s, mode, ms) {
  const [lo, hi] = GX.breakRange(s, mode);
  return `${Math.round(ms / 60000)} min${hi > lo ? ` of ${lo}-${hi}` : ""}`;
}

// ===========================================================================
// AUTOMATIC MODE SWITCHING (v2.7.6)
//   Target reached -> stop this mode -> random transition break -> switch mode -> start the next mode.
// Nothing ever starts before the transition break has finished: the switch is applied by the engine only when
// the break runs out (applySwitch), never when it is planned (beginSwitch).
// Rules kept deliberately tight:
//   * one transition at a time (a second one is never planned while one is running)
//   * a mode that reached its target today is skipped for the rest of the day, so two modes can't bounce
//   * a mode with no work left (its number is done, or X limited it today) is skipped
//   * at most MAX_SWITCHES_PER_DAY switches a day
//   * you pick a mode yourself -> your choice wins and the pending transition is dropped
// ===========================================================================
const MAX_SWITCHES_PER_DAY = 30;
const ACTION_NOUN = { follow: "follow", followback: "follow-back", unfollow: "unfollow", comment: "reply" };

// Modes that reached their target today (kept on the job, reset at midnight).
function doneSet(job, now) {
  if (!job || !job.switchDone || job.switchDone.day !== dayKey(now)) return new Set();
  return new Set(Array.isArray(job.switchDone.modes) ? job.switchDone.modes : []);
}
function markModeDone(job, now, mode) {
  const day = dayKey(now);
  if (!job.switchDone || job.switchDone.day !== day) job.switchDone = { day, modes: [] };
  if (!job.switchDone.modes.includes(mode)) job.switchDone.modes.push(mode);
  if (job.switchDay !== day) { job.switchDay = day; job.switchN = 0; }
}

// Is there anything left for a mode to do today? (Its own number, X's shared follow number, and X's refusals.)
async function modeHasWork(s, mode, now) {
  const meta = await load(K.meta, {});
  if (mode === "comment") {
    if (meta.cLimitedDay === dayKey(now)) return false;
    // "One job after the other": Comment waits while another mode still has something to do today.
    if (s.cmtSolo) {
      for (const m of ["follow", "followback", "unfollow"]) {
        if ((s.switchOff || []).includes(m)) continue;
        if (await modeHasWork(s, m, now)) return false;
      }
    }
    return cmtHasWork(s, now);
  }
  if (mode === "unfollow") {
    if (uLimitedToday(meta, null, now)) return false;
    return (await unfToday(now)) < s.unfollowDaily;
  }
  if (xLimitedToday(meta, null, now)) return false;
  const L = GX.effectiveLimits(s, meta, null, now);
  if (dayEntries(await getLedger(), s, now).length >= L.daily) return false;
  if (mode === "followback") return (await bkToday(now)) < s.bkDaily;
  // Follow: it also needs somewhere to get people from.
  if (!(await getPool()).length && !(await getSources()).some((x) => x.enabled && !["gone", "private"].includes(x.status))) return false;
  const target = GX.modeTarget(s, "follow", L.daily);
  return dayEntries(await getLedger(), s, now).length < target;
}

// Which mode a run BEGINS in.
//   No sequence  -> simply the mode you picked with the Mode tiles, exactly as before.
//   A sequence   -> the sequence decides: the FIRST mode in your order that still has work today. That is what
//                   makes pressing Start do the same thing every time, whatever the tiles happen to show - the
//                   order you wrote in the sequence card is the order the day is worked through.
// `opts.inWindow` also requires the mode to be inside its own ON / OFF hours (used by the daily auto-start;
// a Start you press yourself may begin outside them, and the engine then sleeps until the window opens).
// Returns null when every mode in the sequence is finished or blocked for today.
async function startMode(s, job, now, opts) {
  if (!GX.cycling(s)) return s.runMode;
  const done = doneSet(job, now);
  for (const m of GX.modeSeq(s)) {
    if (done.has(m)) continue;
    if (opts && opts.inWindow && !GX.inWindow(GX.modeSettings(Object.assign({}, s, { runMode: m })), now)) continue;
    if (await modeHasWork(s, m, now)) return m;
  }
  return null;
}

// Write the mode a run is about to begin in, so every later step agrees with it. Returns the live settings.
async function useMode(s, mode, why) {
  if (!mode || mode === s.runMode) return s;
  const raw = GX.normalizeSettings(await load(K.settings, {}));
  const from = raw.runMode;
  raw.runMode = mode;
  raw.unfollowOn = mode === "unfollow";
  await save({ [K.settings]: raw });
  await pushEvent("run", `${why}: starting in ${MODE_NAME[mode]} mode${from && from !== mode ? ` (not ${MODE_NAME[from]} - your sequence puts ${MODE_NAME[mode]} first)` : ""}.`);
  return GX.modeSettings(raw);
}

// The next mode to run after `from`: the sequence order, skipping whatever is finished or blocked today.
async function pickNextMode(job, s, now, from) {
  const seq = GX.modeSeq(s);
  const at = seq.indexOf(from);
  const order = at === -1 ? seq.slice() : seq.slice(at + 1).concat(s.switchLoop ? seq.slice(0, at + 1) : []);
  const done = doneSet(job, now);
  for (const m of order) {
    if (m === from || done.has(m)) continue;
    if (await modeHasWork(s, m, now)) return m;
  }
  return null;
}

// A mode reached its target. Plan the transition break and the mode after it.
// Returns true when a transition was planned (the caller must then just park the job), false when the
// caller should do what it always did (stop for today / rest until tomorrow).
// `opts.turn` = this mode only finished its turn, not its day: it keeps its place in the sequence and comes back round.
async function beginSwitch(job, s, now, from, doneMsg, opts) {
  if (!s.autoSwitch) return false;
  if (job.trans && job.trans.until > now) return true;              // a transition is already running: never plan a second one
  if (!(opts && opts.turn)) markModeDone(job, now, from);
  if ((job.switchN || 0) >= MAX_SWITCHES_PER_DAY) {
    await pushEvent("warn", `Mode switching: ${MAX_SWITCHES_PER_DAY} switches today is the limit, so GrowX stays in ${MODE_NAME[from]} mode until tomorrow.`);
    return false;
  }
  const to = await pickNextMode(job, s, now, from);
  if (!to) return false;                                            // nothing left to switch to: the caller stops for today
  const ms = GX.transitionMs(s);
  const until = now + ms;
  const mins = Math.round(ms / 60000);
  job.trans = { from, to, at: now, until, ms, turn: !!(opts && opts.turn) };
  job.switchN = (job.switchN || 0) + 1;
  // The transition break itself: actions stop now, and only when it runs out does the next mode start.
  rest(job, "switch", until, `${doneMsg} Transition break of ${mins} min${s.transMax > s.transMin ? ` (your range: ${s.transMin}-${s.transMax} min)` : ""} - then ${MODE_NAME[to]} mode starts, at ${clock(until)}.`);
  logLine(job, "", "wait", `${MODE_NAME[from]} target reached - ${MODE_NAME[to]} in ${mins} min`);
  await pushEvent("run", `${MODE_NAME[from]}: target reached. Transition break of ${mins} min, then GrowX switches to ${MODE_NAME[to]} mode by itself.`);
  await notify("switch", "GrowX is switching mode", `${MODE_NAME[from]} is done for today. ${MODE_NAME[to]} starts at ${clock(until)}.`);
  return true;
}

// A mode has done its turn: hand over to the next one in the sequence. Only ever while a real sequence is running
// (switching on, two or more modes in it) - otherwise every number keeps the meaning it always had.
// Returns true when a transition was planned, and the caller then just parks the job.
async function turnOver(job, s, now, mode, daily) {
  if (!GX.cycling(s)) return false;
  const target = GX.modeTurnTarget(s, mode, daily);
  const done = job.turnDone || 0;
  if (!target || done < target) return false;
  return beginSwitch(job, s, now, mode, `${MODE_NAME[mode]}: ${plural(done, ACTION_NOUN[mode])} done this turn.`, { turn: true });
}

// The transition break has finished: switch the mode for real. Returns the settings to carry on this step with
// (mode hours applied), or null when nothing was switched.
async function applySwitch(job, now) {
  const t = job.trans;
  job.trans = null;
  if (!t || !GX.MODES.includes(t.to)) return null;
  const raw = GX.normalizeSettings(await load(K.settings, {}));
  // Switched off, or you picked a mode yourself while the break ran: your choice wins.
  if (!raw.autoSwitch || raw.runMode !== t.from) {
    await pushEvent("run", `Transition break finished, but the mode was changed meanwhile - staying in ${MODE_NAME[raw.runMode] || raw.runMode} mode.`);
    return null;
  }
  raw.runMode = t.to;
  raw.unfollowOn = t.to === "unfollow";
  await save({ [K.settings]: raw });
  // The run follows at once, so the "you picked another mode" check at the top of the next step sees no change.
  job.runMode = t.to;
  job.mode = t.to;
  job.nextAt = now;
  job.current = null;
  job.inFlight = null;
  job.sinceRest = 0; job.restAfter = 0; job.uSince = 0; job.uRestAfter = null; job.bSince = 0; job.bRestAfter = null;
  job.cmtSince = 0; job.cmtRestAfter = 0;
  job.turnDone = 0;                         // the new mode's turn starts from zero
  job.switchedAt = now;
  if (t.from === "unfollow" || t.to === "unfollow") job.dayStart = now;   // Follow and Follow back share one working day
  if (t.to !== "follow") { job.harvesting = false; job.sweep = null; }
  job.message = `Transition break finished - ${MODE_NAME[t.to]} mode is now running.`;
  logLine(job, "", "wait", `switched to ${MODE_NAME[t.to]} mode`);
  await pushEvent("run", `Transition break finished: switched from ${MODE_NAME[t.from]} to ${MODE_NAME[t.to]} mode.`);
  await notify("switch", `GrowX: ${MODE_NAME[t.to]} mode`, `The transition break is over and ${MODE_NAME[t.to]} mode has started.`);
  return GX.modeSettings(raw);
}

// ---------------------------------------------------------------------------
// THE RECORD
// ---------------------------------------------------------------------------
// One line for every action GrowX takes, in every mode, kept whatever happens
// to the per-mode lists: this is the history you export. Newest first.
// { t: when, m: mode, a: what, h: handle, i: id, ok: worked, w: why, x: extra }
const ACTLOG_MAX = 20000;
let actMem = null;

async function actLogAll() {
  if (!actMem) { const v = await load(K.actlog, []); actMem = Array.isArray(v) ? v : []; }
  return actMem;
}

async function actLog(e) {
  if (!e) return;
  const all = await actLogAll();
  all.unshift({
    t: e.t || Date.now(),
    m: e.mode || "",
    a: e.act || "",
    h: String(e.h || "").replace(/^@/, ""),
    i: e.i ? String(e.i) : "",
    ok: e.ok === undefined ? true : !!e.ok,
    w: String(e.why || "").slice(0, 200),
    x: e.extra === undefined ? undefined : e.extra
  });
  if (all.length > ACTLOG_MAX) all.length = ACTLOG_MAX;
  await save({ [K.actlog]: all });
}

// A handle for every id GrowX has ever seen one for, so a list of bare
// follower ids can still be exported as @names and links.
async function handleBook() {
  const book = new Map();
  const put = (i, h, n) => { if (i && h && !book.has(String(i))) book.set(String(i), { h: String(h).replace(/^@/, ""), n: n || "" }); };
  for (const f of await getFollows()) put(f.i, f.h, f.n);
  for (const x of (await load(K.bklog, [])) || []) put(x.i, x.h, x.n);
  for (const x of (await load(K.unlog, [])) || []) put(x.i, x.h, x.n);
  const lo = await load(K.lost, null);
  for (const x of ((lo && lo.list) || [])) put(x.i, x.h, x.n);
  return book;
}
const xLink = (h, i) => (h ? "https://x.com/" + String(h).replace(/^@/, "") : i ? "https://x.com/i/user/" + i : "");
const iso = (t) => (t ? new Date(t).toISOString() : "");

// Everything GrowX knows, in rows anyone can read. `what` picks the list.
async function exportRows(what) {
  const book = await handleBook();
  const nameOf = (i) => book.get(String(i)) || { h: "", n: "" };

  if (what === "unfollowed") {
    const log = (await load(K.unlog, [])) || [];
    return {
      name: "unfollowed",
      header: ["handle", "link", "name", "user_id", "was_following_you", "mutual", "why", "unfollowed_at", "quality_score", "followers", "last_post", "followed_again_at"],
      rows: log.map((x) => {
        const h = x.h || nameOf(x.i).h;
        return [h, xLink(h, x.i), x.n || nameOf(x.i).n, x.i || "", x.k === "fb" ? "yes" : "no", x.k === "fb" ? "mutual" : "not mutual", x.w || "", iso(x.t), x.qs == null ? "" : x.qs, x.fc == null ? "" : x.fc, x.lt ? iso(x.lt) : "", x.rf ? iso(x.rf) : ""];
      })
    };
  }

  if (what === "following") {
    const f = await getFollows();
    return {
      name: "following",
      header: ["handle", "link", "name", "user_id", "followed_at", "followed_you_back", "followed_back_at", "unfollowed_you_at", "state"],
      rows: f.slice().reverse().map((x) => [x.h || "", xLink(x.h, x.i), x.n || "", x.i || "", iso(x.t),
        x.fb ? "yes" : "no", iso(x.fb), iso(x.lost),
        x.nf ? "you unfollowed them" : x.p ? "follow request sent" : x.lost ? "they unfollowed you" : x.fb ? "mutual" : "waiting for a follow-back"])
    };
  }

  if (what === "followers") {
    // Everyone GrowX has seen following you: the ones it follows back (mutuals),
    // the ones still waiting in the Follow back list, and the rest of the scan.
    const ids = new Set();
    const bk = await load(K.bk, null);
    for (const i of ((bk && bk.followers) || [])) ids.add(String(i));
    for (const i of (await load(K.known, [])) || []) ids.add(String(i));
    const idx = await getFollowIndex();
    for (const [i, f] of idx) if (f && f.fb && !f.lost) ids.add(String(i));
    const waiting = new Set(((bk && bk.list) || []).map(String));
    return {
      name: "followers",
      header: ["handle", "link", "name", "user_id", "you_follow_them", "state"],
      rows: [...ids].map((i) => {
        const b = nameOf(i), f = idx.get(i);
        const youFollow = !!(f && !f.nf);
        return [b.h, xLink(b.h, i), b.n, i, youFollow ? "yes" : "no",
          youFollow ? "mutual" : waiting.has(i) ? "waiting in the Follow back list" : "follows you, you do not follow them"];
      })
    };
  }

  if (what === "mutuals") {
    const idx = await getFollowIndex();
    const rows = [];
    for (const [i, f] of idx) if (f && f.fb && !f.lost && !f.nf) rows.push([f.h || nameOf(i).h, xLink(f.h || nameOf(i).h, i), f.n || "", i, iso(f.t), iso(f.fb)]);
    return { name: "mutuals", header: ["handle", "link", "name", "user_id", "you_followed_at", "they_followed_back_at"], rows };
  }

  if (what === "comments") {
    const all = (await actLogAll()).filter((e) => e.m === "comment");
    return {
      name: "comments",
      header: ["when", "handle", "link", "what", "reply", "post", "model", "cost_usd", "why"],
      rows: all.map((e) => {
        const x = e.x || {};
        return [iso(e.t), e.h, xLink(e.h, e.i), e.a, x.text || "", x.post || "", x.model || "", x.cost == null ? "" : x.cost, e.w || ""];
      })
    };
  }

  // the whole record, every mode
  const all = await actLogAll();
  return {
    name: "history",
    header: ["when", "mode", "action", "handle", "link", "user_id", "worked", "why", "detail"],
    rows: all.map((e) => [iso(e.t), e.m, e.a, e.h, xLink(e.h, e.i), e.i, e.ok ? "yes" : "no", e.w || "",
      e.x ? (typeof e.x === "string" ? e.x : JSON.stringify(e.x)) : ""])
  };
}

function logLine(job, h, r, m, tg) {
  job.log = job.log || [];
  job.log.unshift(tg ? { t: Date.now(), h, r, m, tg } : { t: Date.now(), h, r, m });
  if (job.log.length > 60) job.log.length = 60;
}

async function finishJob(job, status, message) {
  job.status = status;
  job.message = message;
  job.finishedAt = Date.now();
  job.current = null;
  job.inFlight = null;
  job.restUntil = null;
  await save({ [K.job]: job });
  keepAlive(false);
  syncPower(false);
  await flushSeen(true);
  if (job.workerTabId != null) { try { await chrome.tabs.remove(job.workerTabId); } catch (_) {} job.workerTabId = null; }
  if (job.tabId != null) {
    if (job.ownTab) { try { await chrome.tabs.remove(job.tabId); } catch (_) {} }
    else await protectTab(job.tabId, false);
  }
  job.tabId = null;
  job.ownTab = false;
  await save({ [K.job]: job });
  await pushEvent("run", message);
}

// Save progress without undoing a Pause/Stop pressed while a request was in flight.
async function commitJob(job) {
  const latest = await load(K.job, null);
  if (!latest || latest.id !== job.id) return false;
  if (!ACTIVE.has(latest.status) || latest.status === "paused") {
    job.status = latest.status;
    job.message = latest.message;
    job.finishedAt = latest.finishedAt;
    job.tabId = latest.tabId;
    job.workerTabId = latest.workerTabId;
    job.ownTab = latest.ownTab;
    job.restUntil = null;
  }
  await save({ [K.job]: job });
  return true;
}

// The throttle only counts when you switched on "lower my caps after a warning".
// X's own daily follow limit (dailyCap) is always respected.
function activeThrottle(job, s) {
  const th = job && job.throttle;
  if (!th || th.until <= Date.now()) return null;
  if (s.autoSlowdown) return th;
  return th.dailyCap ? { factor: 1, until: th.until, dailyCap: th.dailyCap, why: th.why } : null;
}

function rest(job, reason, until, message) {
  // A break caused by a failure/warning counts as your break: the "15 follows" count starts again after it
  // (otherwise you'd get the failure break and then another full break right after).
  if (["rate", "failure", "soft", "errors", "limit"].includes(reason)) { job.sinceRest = 0; job.restAfter = 0; }
  job.status = "resting";
  job.restReason = reason;
  job.restFrom = Date.now();
  job.restUntil = Math.max(until, Date.now() + 5000);
  job.message = message;
}

// When maintenance reads could next be useful (to wake up during waits).
async function maintWake(job, s, now, mode) {
  const due = (v) => (typeof v === "number" ? v : Infinity);
  // Direct follow-back checks have their own rate bucket.
  let at = job.relForce ? now : relNextDue(await getFollows(), job.ownerId);
  if (job.relUntil && job.relUntil > now) at = Math.max(at, job.relUntil);
  if (mode !== "rel") {
    let l = Math.min(due(job.nextAcctAt), due(job.nextFbAt));
    if (job.fb) l = Math.min(l, now);
    if (job.sweep && s.runMode === "follow") l = Math.min(l, Math.max(now, job.sweepWait || 0));
    if (s.verifyFollows && job.verify && job.verify.ids && job.verify.ids.length >= VERIFY_EVERY) l = Math.min(l, now);
    const pool = await getPool();
    if (s.runMode === "follow" && (pool.length < Math.max(15, Math.round(s.poolTarget * 0.4)) || job.harvesting)) {
      const srcAt = nextSourceTime(await getSources(), s, now);
      if (srcAt < Infinity) l = Math.min(l, srcAt);
    }
    if (job.readUntil && job.readUntil > now) l = Math.max(l, job.readUntil);
    at = Math.min(at, l);
  }
  return Math.max(at, job.nextReadAt || now);
}

async function park(job, s, wakeAt, readsOk) {
  if (!await commitJob(job)) return;
  if (!ACTIVE.has(job.status)) { keepAlive(false); syncPower(false); return; }
  const now = Date.now();
  let at = wakeAt;
  // Background reads may wake us early, but never more than once a second.
  if (readsOk) at = Math.min(at, Math.max(await maintWake(job, s, now, readsOk === "rel" ? "rel" : "all"), now + 1000));
  scheduleTick(Math.max(250, at - now));
  if (s.keepAwake) syncPower(true);
}

// At most one read (verify / follow-back check / account / follower scan /
// source search). Returns the step result, or null if nothing was due.
// mode "rel": only the quiet follow-back lookups (night time, some rests).
async function maintenance(job, s, now, mode) {
  if (now < (job.nextReadAt || 0)) return null;
  const listsOk = mode !== "rel" && !(job.readUntil && now < job.readUntil);
  if (listsOk && s.verifyFollows && job.verify && job.verify.ids && job.verify.ids.length >= VERIFY_EVERY) return verifyStep(job, s);
  if (!(job.relUntil && now < job.relUntil) && (job.relForce || relNextDue(await getFollows(), job.ownerId) <= now)) {
    const m = await relStep(job, s);
    if (m.called) return m;
  }
  if (!listsOk) return null;
  if (now >= (job.nextAcctAt || 0)) {
    await refreshAccount(job.tabId);
    job.nextAcctAt = now + 15 * MIN;
    return { called: true };
  }
  if (job.fb || now >= (job.nextFbAt || 0)) return fbStep(job, s);
  if (s.runMode === "comment") { if (await cmtStatsStep(job, s, now)) return { called: true }; return null; }
  if (s.runMode !== "follow") return null;            // Unfollow / Follow back mode: no searching for new people
  if (job.sweep && !(job.sweepWait > now)) {
    const h = await harvestStep(job, s, job.sweep);
    if (h.called) { job.sweepWait = 0; return h; }
    if (h.sweepDone) await finishSweep(job);
    else if (h.waitUntil) job.sweepWait = h.waitUntil;
  }
  const pool = await getPool();
  const low = Math.max(15, Math.round(s.poolTarget * 0.4));
  if (pool.length < low || (job.harvesting && pool.length < s.poolTarget)) {
    const h = await harvestStep(job, s);
    if (!h.called) { job.harvesting = false; return null; }
    job.harvesting = pool.length < s.poolTarget;
    return h;
  }
  return null;
}

async function finishSweep(ctx) {
  const sum = sweepSummary(ctx.sweep);
  ctx.lastSweep = { at: Date.now(), total: sum.total, text: sum.text };
  ctx.sweep = null;
  ctx.sweepWait = 0;
  await pushEvent("harvest", sum.text);
}

async function applyStepResult(job, s, m) {
  const now = Date.now();
  job.nextReadAt = now + rand(1500, 4000);
  if (m.halt) return haltFor(job, m.halt, m.message, m.waitMs);
  if (m.rest) rest(job, m.rest.reason, now + m.rest.ms, m.rest.message);
  return false;
}

// Warnings that need the person, or a long automatic rest. Returns true when
// the job was halted or put to rest.
async function haltFor(job, kind, message, waitMs) {
  const now = Date.now();
  const s0 = await getSettings();
  if (kind === "automation") {
    job.autoHits = (job.autoHits || []).filter((t) => now - t < 48 * HOUR).concat(now);
    if (job.autoHits.length >= 2) {
      job.status = "halted";
      job.haltKind = "automation";
      job.message = "X flagged the activity as automated twice. GrowX stopped for your account's safety. Open x.com, use it normally for a day, then press Resume.";
      await notify("halt", "GrowX stopped for safety", "X flagged activity as automated twice. Use X normally for a day before resuming.");
    } else {
      const ms = Math.max(waitMs || 6 * HOUR, 6 * HOUR);
      if (s0.autoSlowdown) job.throttle = { factor: 0.5, until: now + 72 * HOUR, why: "automation warning" };
      rest(job, "automation", now + ms, `X said the activity looks automated. Resting until ${clock(now + ms)}${s0.autoSlowdown ? ", then continuing at half speed" : ""}.`);
      await notify("auto", "GrowX is resting 6 hours", "X said the activity looked automated. This is the one long safety rest GrowX keeps.");
    }
    await pushEvent("warn", job.message);
    return true;
  }
  job.status = "halted";
  job.haltKind = kind;
  job.message = kind === "auth" ? "You're signed out of X. Sign in at x.com, then press Resume."
    : kind === "locked" ? "X is asking you to verify your account. Open x.com, complete X's check, wait a few hours, then press Resume."
    : kind === "suspended" ? "X has restricted this account. Check x.com before doing anything else."
    : kind === "account" ? "You switched to a different X account. Switch back, then press Resume."
    : (message || "GrowX needs your attention.");
  await pushEvent("halt", job.message);
  await notify("halt", "GrowX needs your attention", job.message);
  return true;
}

// =====================================================================
// Auto-unfollow (v2.2.1)
//   Phase 1 - old list: everyone you follow who does NOT follow you back, OLDEST first.
//             While this runs GrowX only unfollows (no following).
//   Phase 2 - every day: accounts GrowX followed that didn't follow back within
//             `unfollowAfterDays` are unfollowed first, then GrowX goes back to following.
// Every batch of 100 is re-checked right before unfollowing: anyone who follows you
// (or is on your keep list) is never unfollowed.
// =====================================================================
const U_fmt = (n) => Number(n || 0).toLocaleString();
function newUnf(owner) {
  return { owner, stage: "friends", cursor: null, friends: [], followers: [], list: [], pos: 0, batch: [], total: 0, removed: 0, skipped: 0, startedAt: Date.now() };
}
async function getUnf(owner) {
  const u = await load(K.unf, null);
  return u && u.owner === owner ? u : newUnf(owner);
}
async function unfToday(now) {
  const l = await load(K.uledger, []);
  return (Array.isArray(l) ? l : []).filter((t) => t >= startOfToday(now)).length;
}
async function pushUledger() {
  const cutoff = Date.now() - 2 * DAY;
  const l = (await load(K.uledger, [])).filter((t) => t > cutoff);
  l.push(Date.now());
  await save({ [K.uledger]: l });
}
// Accounts you named as targets. You asked GrowX to reach them, so unfollowing
// one would undo your own instruction: they are kept exactly like the Never
// unfollow list. Filled in whenever the target list is read or written.
let tgtKeep = new Set();
function tgtKeepSync(list) {
  tgtKeep = new Set((list || []).map((t) => String(t && t.h || "").toLowerCase()).filter(Boolean));
}

// THE LAST WORD BEFORE AN UNFOLLOW (v3.2: always asked, whatever the switches say).
// In this order:
//   1. what GrowX already knows (a queue built under older settings, or someone who followed you back while waiting);
//   2. a fresh question to X: do they follow you? (an ACTIVE follower is never unfollowed - only an inactive find may be);
//   3. the profile, read now: a big or good account (Quality score / followers) is never unfollowed;
//   4. for an inactive find: their posts, read now. One post in the period = active = kept.
// If X does not give a clear answer the account is skipped - an unfollow is never sent on a guess.
// Returns { info } to go ahead, or { skip, why, retry?, theyFollowYou?, big? }.
async function unfVerify(job, s, t) {
  const inactOk = !!t.ia && GX.unfInactiveOn(s);              // an inactive find: allowed even though they follow you
  const fRec = (await getFollowIndex()).get(t.i);
  if (!inactOk && GX.followsYouBack(t, null, fRec)) return { skip: true, theyFollowYou: true, why: "follows you back - never unfollowed" };

  const chk = await sendTab(job.tabId, { gx: "rel", ids: [t.i] }, 45000);
  if (chk && chk.uid && job.ownerId && chk.uid !== job.ownerId) return { wrongAccount: true };
  if (isRate(chk)) return { rate: chk };
  const fresh = chk && chk.ok ? (chk.map || {})[t.i] : null;
  if (!fresh) return { skip: true, retry: true, why: "could not check whether they follow you - left alone" };
  if (fresh.fy === true && !inactOk) return { skip: true, theyFollowYou: true, why: "follows you back (checked just now) - never unfollowed" };
  if (fresh.gone) return { skip: true, why: "the account is gone" };
  if (fresh.fw === false && !fresh.pending) return { skip: true, why: "you do not follow them any more" };

  const ri = await sendTab(job.tabId, { gx: "uinfo", ids: [t.i] }, 45000);
  if (ri && ri.uid && job.ownerId && ri.uid !== job.ownerId) return { wrongAccount: true };
  if (isRate(ri)) return { rate: ri };
  if (!ri || !ri.ok) return { skip: true, retry: true, why: "could not read the profile - left alone" };
  const info = (ri.map || {})[t.i];
  if (!info) return { skip: true, why: "the account is gone" };
  const big = GX.bigReason(info, s);
  if (big) return { skip: true, big: true, info, why: `${big} - never unfollowed` };

  if (t.ia) {
    const now = Date.now(), since = now - s.unfInactiveDays * DAY;
    if (info.lt && info.lt >= since) return { skip: true, active: true, info, why: `active - posted ${agoDays(now, info.lt)} - never unfollowed` };
    const rp = await sendTab(job.tabId, { gx: "rposts", id: t.i, since }, 45000);
    if (rp && rp.uid && job.ownerId && rp.uid !== job.ownerId) return { wrongAccount: true };
    if (isRate(rp)) return { rate: rp };
    if (!rp || !rp.ok) return { skip: true, why: "could not read their posts - left alone" };
    if (rp.seen > 0 && rp.newest && rp.newest >= since) return { skip: true, active: true, info, why: `active - posted ${agoDays(now, rp.newest)} - never unfollowed` };
    if (!rp.seen && info.sc !== 0) return { skip: true, why: "their posts could not be read - left alone" };
  }
  return { info };
}
const agoDays = (now, t) => { const d = Math.floor((now - t) / DAY); return d <= 0 ? "today" : d === 1 ? "1 day ago" : `${d} days ago`; };

function keepSet(s) {
  const out = new Set(String(s.unfollowKeep || "").split(/[\s,]+/).map((h) => GX.cleanHandle(h)).filter(Boolean).map((h) => h.toLowerCase()));
  for (const h of tgtKeep) out.add(h);
  return out;
}
// Should this step unfollow (true) or follow (false)?
async function unfollowWanted(job, s, now) {
  return s.runMode === "unfollow";      // one mode at a time: the one you chose
}

// =====================================================================
// The "X refused" plan (v2.7.0) - one ladder for Follow, Follow back and Unfollow
//   1st refusal / failed attempt   -> a break (minutes: a random time between the Min and Max you set)
//   refused again after that       -> a longer break (hours, same idea)
//   refused once more              -> stop for the rest of today; the next day it starts again by itself
// Each step has its own on/off switch (the third is always on - it is what keeps the account safe). Follow and Follow back share
// X's follow limit, so they share the strikes; Unfollow has its own. The steps count refusals IN A ROW: as soon as X accepts one again,
// the plan starts from step 1 again
// or on a new day. The plan can only make GrowX slower or stop it - never faster.
// =====================================================================
// A list read that X rate-limited is NOT a refusal. X is only saying "not so fast - try again at <time>",
// and it says exactly when. Reading a big following list needs more pages than X allows in one window, so
// treating that as a refusal used to take a safety break, climb the X-refused plan and eventually stop the
// run - with the list only half read. Now it simply waits out X's own window and carries on where it
// stopped. No strike, no step of the plan. (The follow-back checks already worked this way.)
async function readRate(job, s, now, r, what) {
  const ms = Math.min(Math.max(Number(r && r.waitMs) || 15 * MIN, MIN), 3 * HOUR);
  const until = now + ms + rand(5000, 30000);
  job.rateHits = 0;                    // a read window is not a refusal: it must not arm the plan
  rest(job, "read", until, `${what}: X asked for a pause (${(r && r.message) || "rate limit"}). Carrying on at ${clock(until)} - nothing is lost, it picks up exactly where it stopped.`);
  logLine(job, "", "wait", `${what} paused by X - back at ${clock(until)}`);
  return park(job, s, job.restUntil, true);
}
const isRate = (r) => !!r && !r.ok && r.kind === "rate";

const ladFam = (mode) => (mode === "unfollow" ? "unfollow" : mode === "comment" ? "comment" : "follow");
const modeNow = (s) => (s.runMode === "unfollow" ? "unfollow" : s.runMode === "followback" ? "followback" : s.runMode === "comment" ? "comment" : "follow");
function fmtSpan(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 90) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}
async function ladGet(fam, now) {
  const all = (await load(K.lad, null)) || {};
  const st = all[fam], day = dayKey(now);
  if (st && st.d === day) return st;
  // A new day: the plan starts again from step 1 - but a break that is still running (it began before midnight) is kept to its end.
  const keep = !!(st && st.until > now);
  return { d: day, n: 0, t: 0, at: 0, until: keep ? st.until : 0, why: keep ? st.why || "" : "" };
}
async function ladPut(fam, st) {
  const all = (await load(K.lad, null)) || {};
  all[fam] = st;
  await save({ [K.lad]: all });
}
// A break that is still running from an earlier run (stopped and started again, new auto-start, another mode with the same limit).
async function ladWait(fam, now) {
  const st = await ladGet(fam, now);
  return st.until > now ? st : null;
}
// The next step of the plan. st = { n, t, at, until, why } is changed; returns what to do.
//   { act: "break", lvl, ms }  /  { act: "stop" }  /  { act: "go" } (the break of this step is switched off)
function ladNext(s, now, mode, r, st) {
  const plan = GX.refusePlan(s, mode);
  st.n = (st.n || 0) + 1; st.t = (st.t || 0) + 1; st.at = now;
  let out;
  if (st.n >= 4) out = { act: "stop" };
  else if (st.n === 1 && plan.on0) out = { act: "break", lvl: 1, ms: rand(plan.lo0, plan.hi0) };
  else if (st.n === 2 && plan.on1) out = { act: "break", lvl: 2, ms: rand(plan.lo1, plan.hi1) };
  else if (st.n === 3 && plan.on2) out = { act: "break", lvl: 3, ms: rand(plan.lo2, plan.hi2) };
  else out = { act: "go" };
  if (out.act === "break") {
    // X's own rate-limit reset time, when it is longer than the break (never more than 3 hours).
    if (r && r.kind === "rate" && r.waitMs > out.ms) out.ms = Math.min(r.waitMs, 3 * HOUR);
    st.until = now + out.ms;
    st.why = r && r.kind === "limit" ? "limit" : r && r.kind === "rate" ? "rate" : "failure";
  }
  out.n = st.n;
  out.plan = plan;
  return out;
}
// A read worked (a list or a lookup): the failure streak of reads starts again. It says nothing about the plan itself - that is only
// forgiven by actions that worked (ladOk).
function readOk(job) { job.rateHits = 0; job.consecutiveFails = 0; job.failsAtStrike = 0; job.readLad = null; job.noAnswerN = 0; }
// Something worked: X accepts again, so the earlier refusals are forgotten (the plan starts from step 1 again).
async function ladOk(job, s, now) {
  readOk(job);
  job.targetFails = 0;
  if (job.ladAfter) {
    job.ladAfter = false; job.lad = null;
    const okNoun = modeNow(s) === "unfollow" ? "unfollows" : modeNow(s) === "comment" ? "replies" : "follows";
    await pushEvent("run", `X accepts ${okNoun} again. GrowX carries on at its normal pace.`);
  }
  // (Follow + Follow back share one plan, Unfollow has its own: only the family that just worked starts again from step 1.)
  const fam = ladFam(modeNow(s)), st = await ladGet(fam, now);
  if (st.n) { st.n = 0; await ladPut(fam, st); }
}
// Step 3: stop for the rest of today. Follow AND Follow back (they share X's follow limit), or Unfollow on its own.
async function ladStop(job, s, now, mode, handle, st) {
  // Comment has its own limit on X: it stops for the day on its own, and the follow family keeps working.
  if (ladFam(mode) === "comment") {
    const n = await cmtTodayN(now);
    const cMeta = await load(K.meta, {});
    cMeta.cLimitedDay = dayKey(now); cMeta.cLimitedAt = now; cMeta.cLimitedToday = n;
    await save({ [K.meta]: cMeta });
    st.until = 0;
    await ladPut("comment", st);
    logLine(job, handle, "fail", "X kept refusing replies - commenting stopped for today");
    const cm = `X kept refusing replies (${st.n} times, at ${n} replies today). Commenting is stopped for the rest of today so the account stays safe.${s.autoStart ? nextStartText(s) : " Press Start tomorrow."}`;
    await notify("halt", "X limited your replies", `Commenting stopped for today at ${n} replies.`);
    await pushEvent("warn", cm);
    await tgSend("warn", "<b>X limited your replies</b>\n" + cm);
    await finishJob(job, "done", cm);
    return;
  }
  const unf = ladFam(mode) === "unfollow";
  const today = unf ? await unfToday(now) : dayEntries(await getLedger(), s, now).length;
  const meta = await load(K.meta, {});
  if (unf) { job.uLimitedAt = now; job.uLimitedToday = today; meta.uLimitedDay = dayKey(now); meta.uLimitedAt = now; meta.uLimitedToday = today; }
  else { job.xLimitedAt = now; job.xLimitedToday = today; meta.xLimitedDay = dayKey(now); meta.xLimitedAt = now; meta.xLimitedToday = today; }
  await save({ [K.meta]: meta });
  st.until = 0;
  await ladPut(ladFam(mode), st);
  logLine(job, handle, "fail", unf ? "X kept refusing - unfollowing stopped for today" : "X kept refusing - following stopped for today");
  const msg = unf
    ? `X kept refusing unfollows (${st.n} times, at ${today} unfollows today). Unfollowing is stopped for the rest of today so the account stays safe.${s.autoStart ? nextStartText(s) : " Press Start tomorrow."}`
    : `X kept refusing (${st.n} times, at ${today} follows today). Following is stopped for the rest of today - Follow and Follow back, they share X's limit - so the account stays safe.${s.autoStart ? nextStartText(s) : " Press Start tomorrow."}`;
  await notify("halt", unf ? "X limited your unfollows" : "X limited your follows", `${unf ? "Unfollowing" : "Following"} stopped for today at ${today}.${s.autoStart ? " It starts again by itself tomorrow." : ""}`);
  await pushEvent("warn", msg);
  await flushSeen(false);
  await finishJob(job, "done", msg);
}
// One refused or failed request (X said no / slow down / limit, or the request failed) goes through the plan.
//   ctx = { mode, noun ("follow" | "follow-back" | "unfollow" | "list read" | "profile read"), since (break counter to restart), label (@handle), read }
// Returns "break" (resting now), "stop" (finished for today), "halt" (needs you), "go" (this step is switched off) or "retry" (a short wait first).
async function refuseOutcome(job, s, now, r, ctx) {
  r = r || { kind: "transient", message: "no answer" };
  const mode = ctx.mode, noun = ctx.noun, read = !!ctx.read;
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
  const nouns = read ? noun + "s" : noun + "s";
  const explicit = r.kind === "rate" || r.kind === "limit";
  const what = r.kind === "limit" ? 'X said "unable to follow more people at this time"'
    : r.kind === "rate" ? `X slowed things down (${r.message || "rate limit"})` : `${Noun} failed (${r.message || "error"})`;
  const haltNow = async (message) => {
    job.status = "halted"; job.haltKind = "errors"; job.message = message;
    logLine(job, ctx.label, "wait", "stopped for safety");
    await pushEvent("warn", message);
    await notify("halt", "GrowX stopped for safety", message);
    return "halt";
  };
  // The X tab itself did not answer (closed, reloading, asleep): a problem on this computer, not X refusing - no strike.
  // A fresh tab and a short wait; a long streak stops the run (it restarts by itself in a few minutes).
  if (r.noAnswer) {
    job.noAnswerN = (job.noAnswerN || 0) + 1;
    if (!job.ownTab) job.tabId = null;
    if (job.noAnswerN >= 8) {
      job.noAnswerN = 0; job.status = "halted"; job.haltKind = "tab";
      job.message = "The X tab isn't answering. Check that x.com is open and loads - GrowX tries again by itself.";
      logLine(job, ctx.label, "wait", "X tab not answering - stopped");
      await pushEvent("warn", job.message);
      return "halt";
    }
    job.nextAt = now + Math.min(60000, 5000 * Math.pow(1.6, job.noAnswerN - 1));
    job.message = "The X tab didn't answer. Trying again...";
    return "retry";
  }
  job.noAnswerN = 0;
  // A new day: the plan starts again from step 1 (ladGet), and so do the "in a row" counters behind it.
  const today = dayKey(now);
  if (job.ladDay !== today) { job.ladDay = today; job.rateHits = 0; job.consecutiveFails = 0; job.failsAtStrike = 0; job.readLad = null; }
  if (!job.rateHits && !job.consecutiveFails) job.readLad = null;          // something worked since the last failure: a fresh streak
  const haltAt = read ? Math.max(6, s.failHaltAfter) : s.failHaltAfter;
  const failMsg = () => `${Noun} failed ${job.consecutiveFails} times in a row (${r.message || "error"}). Stopped for safety.`;
  let strike;
  if (explicit) {
    job.rateHits = (job.rateHits || 0) + 1;
    if (r.kind === "rate" && s.autoSlowdown) job.throttle = { factor: Math.min(job.throttle && job.throttle.until > now ? job.throttle.factor : 1, 0.75), until: now + 24 * HOUR, why: "rate limit" };
    strike = true;
  } else {
    job.consecutiveFails = (job.consecutiveFails || 0) + 1;
    // After a break, the first failure counts at once; otherwise `failBreakAfter` failures in a row start the plan.
    const armed = read ? !!(job.readLad && job.readLad.n) : (await ladGet(ladFam(mode), now)).n > 0;
    strike = job.consecutiveFails - (job.failsAtStrike || 0) >= (armed ? 1 : Math.max(1, s.failBreakAfter));
  }
  if (!strike) {
    // Failures that never reach a step ("Count a failed ... after" set higher than "Stop for good after"): that safety stop still applies.
    if (job.consecutiveFails >= haltAt) return haltNow(failMsg());
    job.nextAt = now + Math.min(60000, 4000 * Math.pow(1.7, Math.max(0, job.consecutiveFails - (job.failsAtStrike || 0) - 1)));
    job.message = `${Noun} failed (${r.message || "error"}). Trying again...`;
    return "retry";
  }
  job.failsAtStrike = job.consecutiveFails || 0;
  let st, out;
  if (read) { st = job.readLad = job.readLad || { n: 0, t: 0 }; out = ladNext(s, now, mode, r, st); }
  else { st = await ladGet(ladFam(mode), now); out = ladNext(s, now, mode, r, st); await ladPut(ladFam(mode), st); }
  if (out.act === "stop") {
    if (read) return haltNow(`X kept refusing ${nouns} (${st.n} times). Stopped for safety - GrowX tries again by itself in a while.`);
    await ladStop(job, s, now, mode, ctx.label, st);
    return "stop";
  }
  if (out.act === "break") {
    const until = now + out.ms;
    const span = (lo, hi) => `${fmtSpan(lo)}${hi > lo ? " to " + fmtSpan(hi) : ""}`;
    const P = out.plan, stopTxt = read ? "GrowX stops" : nouns + " stop for today";
    const nextTxt = out.lvl === 1
      ? [P.on1 ? "a break of " + span(P.lo1, P.hi1) : "", P.on2 ? "then " + span(P.lo2, P.hi2) : ""].filter(Boolean).join(", ")
      : out.lvl === 2 ? (P.on2 ? "a longer break of " + span(P.lo2, P.hi2) : "") : "";
    job.lad = { lvl: out.lvl, n: out.n, until, kind: r.kind };
    job.ladAfter = true;
    rest(job, r.kind === "limit" ? "limit" : explicit ? "rate" : "failure", until,
      out.lvl === 3
        ? `X refused again. Step 3 of 4: long break ${fmtSpan(out.ms)}, back at ${clock(until)}. If X refuses once more, ${stopTxt} and start again tomorrow by themselves.`
        : `${out.lvl === 1 ? what : "X refused again right after the break"}. Step ${out.lvl} of 4: break ${fmtSpan(out.ms)}, back at ${clock(until)}. If X refuses again${nextTxt ? ", " + nextTxt + " follows" : ""}; after that ${stopTxt}.`);
    job[ctx.since] = 0;
    logLine(job, ctx.label, "wait", `${out.lvl === 1 ? "X refused" : "X refused again"} - ${fmtSpan(out.ms)} break`);
    await commitJob(job);                 // the strike and the break survive even if the worker is stopped right now
    await pushEvent("warn", job.message);
    await notify("limit", out.lvl === 1 ? `X refused a ${noun}` : "X refused again", `Break of ${fmtSpan(out.ms)} - GrowX tries again at ${clock(until)}.`);
    return "break";
  }
  // The break for this step is switched off: the safety stops you set still apply...
  if (explicit && s.rateHaltAfter > 0 && job.rateHits >= s.rateHaltAfter) return haltNow(`X refused ${nouns} ${job.rateHits} times in a row. Stopped for safety.`);
  if (!explicit && job.consecutiveFails >= haltAt) return haltNow(failMsg());
  // ...otherwise carry on after a short pause (the next refusal moves on to the next step).
  job.nextAt = now + rand(15000, 45000);
  job.message = `${what}. Step ${out.n} of the X-refused plan is switched off, so GrowX goes on after a short pause.`;
  logLine(job, ctx.label, "wait", `X refused - step ${out.n} is off`);
  await pushEvent("warn", job.message);
  return "go";
}

// One failed request in Unfollow / Follow back mode (or while reading their lists): the same plan as every other failure.
// o.noun = what failed ("unfollow", "follow-back", "list read"), o.since = which break counter restarts, o.read = a read, not an action.
async function actFail(job, s, now, r, label, o) {
  o = o || {};
  r = r || { kind: "transient", message: "no answer" };
  if (["automation", "auth", "locked", "suspended", "challenge", "captcha"].includes(r.kind)) {
    logLine(job, label, "fail", r.kind);
    await haltFor(job, r.kind === "challenge" || r.kind === "captcha" ? "locked" : r.kind, r.message, r.waitMs);
    return park(job, s, job.status === "halted" ? Infinity : job.restUntil, false);
  }
  const noun = o.noun || "unfollow";
  const out = await refuseOutcome(job, s, now, r, { mode: modeNow(s), noun, since: o.since || "uSince", label, read: o.read !== undefined ? !!o.read : /read$/.test(noun) });
  if (out === "stop") return;
  return park(job, s, out === "halt" ? Infinity : out === "break" ? job.restUntil : job.nextAt, false);
}
const unfFail = (job, s, now, r, label) => actFail(job, s, now, r, label, { noun: "read", since: "uSince", read: true });          // a list / lookup read in Unfollow mode
const unfActFail = (job, s, now, r, label) => actFail(job, s, now, r, label, { noun: "unfollow", since: "uSince", read: false });   // the unfollow itself

// ---- Inactive check (accounts that follow you back but hardly post) ----
function inactivePending(u) { return (u.mpos || 0) < (u.mutual || []).length || (u.deep || []).length > 0; }
// "Who first" (unfOrder) changed after the lists were made: the part that is not done yet is turned around.
//   old list (u.list / u.rank, pointer u.pos): the rest is reversed and numbered again (#1 = first in the new order)
//   followers list (u.mutual: inactive check at u.mpos, active followers at u.apos): what neither of them reached yet is reversed.
//   Pointers never move back, so nobody is looked at or unfollowed twice (the one that is behind finishes the part between the
//   two pointers in the old order first).
function unfReorder(u, s) {
  const want = GX.unfNewest(s) ? "new" : "old";
  let changed = false;
  if (u.stage === "ready" && Array.isArray(u.list) && (u.order || "old") !== want) {
    const p = Math.min(u.pos || 0, u.list.length);
    const n = u.ftotal || 0;
    u.list = u.list.slice(0, p).concat(u.list.slice(p).reverse());
    if (Array.isArray(u.rank)) u.rank = u.rank.slice(0, p).concat(u.rank.slice(p).reverse().map((r) => (r && n ? n - r + 1 : 0)));
    changed = true;
  }
  if ((u.stage === "ready" || u.stage === "done") && u.order !== want) { u.order = want; changed = true; }
  if (Array.isArray(u.mutual) && u.mutual.length && (u.morder || "old") !== want) {
    const hi = Math.min(Math.max(u.mpos || 0, u.apos || 0), u.mutual.length);
    u.mutual = u.mutual.slice(0, hi).concat(u.mutual.slice(hi).reverse());
    u.morder = want;
    changed = true;
  }
  return changed;
}
// "Also unfollow active followers": followers left on the list, oldest follow first (u.apos = how far it got).
function actPending(u) { return (u.apos || 0) < (u.mutual || []).length; }
// GrowX follows that didn't follow back within the days you set: the ids to look at next, oldest first.
const dueFollowFilter = (job, now, cut) => (f) => f.i && !f.fb && !f.fy0 && !f.nf && !f.uf && !f.uk && f.t <= cut && !(f.uq && now - f.uq < DAY) && (!f.o || f.o === job.ownerId);
// One unit of inactive work: a lookup of 100 accounts, or reading one account's recent posts.
// v3.2 - the rule is exactly: INACTIVE = no post at all (posts, replies, reposts) in the last unfInactiveDays days,
// and that has to be SEEN, not guessed:
//   * a profile whose latest post is inside the period is active and kept straight away;
//   * everyone else gets their posts read; inactive only when the read worked and the newest post is older;
//   * a read that shows nothing (protected, X hiding it, an error) = unknown = kept;
//   * a big or good account (Quality score / followers, see GX.bigReason) is never even looked at.
async function inactiveWork(job, s, u, now) {
  const since = now - s.unfInactiveDays * DAY;
  u.deepTimes = (u.deepTimes || []).filter((x) => x > now - HOUR);
  u.deep = u.deep || []; u.ibatch = u.ibatch || [];
  if (u.inactUntil && now < u.inactUntil && !((u.mpos || 0) < (u.mutual || []).length)) return { pauseUntil: u.inactUntil, msg: "Inactive check: X isn't showing post lists right now - nobody is unfollowed without a confirmed read." };
  const capFull = u.deepTimes.length >= 120;
  const lookupLeft = (u.mpos || 0) < (u.mutual || []).length;
  if (lookupLeft && (u.deep.length < 30 || (capFull && u.deep.length < 500))) {
    const iids = u.mutual.slice(u.mpos, u.mpos + 100);
    const ri = await sendTab(job.tabId, { gx: "uinfo", ids: iids }, 45000);
    if (ri && ri.uid && job.ownerId && ri.uid !== job.ownerId) return { wrongAccount: true };
    if (!ri || !ri.ok) return { fail: ri || { kind: "transient", message: "no answer" } };
    const keep = keepSet(s);
    const queued = new Set([].concat(u.ibatch || [], u.deep || [], u.batch || []).map((x) => x.i));
    let active = 0, big = 0, deepAdded = 0;
    for (const id of iids) {
      const m = (ri.map || {})[id];
      if (!m || m.fw === false) continue;                                      // gone, or not followed any more
      if (m.h && keep.has(String(m.h).toLowerCase())) continue;
      if (queued.has(id)) continue;                                            // already waiting: never queued twice
      queued.add(id);
      if (GX.bigReason(m, s)) { big++; continue; }                             // big / good account: never
      if (m.lt && m.lt >= since) { active++; continue; }                       // posted inside the period: active
      u.deep.push({ i: id, h: m.h, n: m.n, a: m.a, lt: m.lt || 0, sc: m.sc, fc: m.fc, fr: m.fr, v: m.v, ca: m.ca }); deepAdded++;
    }
    u.mpos += iids.length;
    u.inactChecked = (u.inactChecked || 0) + (iids.length - deepAdded);
    u.inactLooked = (u.inactLooked || 0) + iids.length;
    u.inactKeptBig = (u.inactKeptBig || 0) + big;
    u.inactKeptActive = (u.inactKeptActive || 0) + active;
    if (deepAdded) logLine(job, "", "wait", `${deepAdded} follower${deepAdded === 1 ? "" : "s"} to double-check (${active} active and ${big} big kept)`);
    return { did: true };
  }
  if (u.deep.length && !capFull) {
    const d = u.deep[0];
    const rp = await sendTab(job.tabId, { gx: "rposts", id: d.i, since }, 45000);
    if (rp && rp.uid && job.ownerId && rp.uid !== job.ownerId) return { wrongAccount: true };
    if (rp && !rp.ok && rp.kind === "auth" && rp.uid) {
      // Signed in (uid present) but this one profile's posts are not readable (protected/blocked): unknown = kept.
      u.deep.shift();
      return { did: true };
    }
    if (!rp || !rp.ok) {
      if (rp && (rp.kind === "endpoint" || rp.kind === "transient")) {
        u.deepOff = (u.deepOff || 0) + 1;
        if (u.deepOff >= 3) {
          // v3.2: no fallback to guessing. The finds wait (they are not lost) and the check tries again in 30 minutes.
          u.deepOff = 0;
          u.inactUntil = Date.now() + 30 * MIN;
          await pushEvent("warn", "Inactive check: X isn't showing post lists right now. Nobody is unfollowed as inactive without a confirmed read - trying again in 30 minutes.");
          return { pauseUntil: u.inactUntil, msg: "Inactive check: X isn't showing post lists right now - nobody is unfollowed without a confirmed read." };
        }
        u.deep.push(u.deep.shift());
        return { did: true };
      }
      if (rp && rp.kind === "gone") { u.deep.shift(); return { did: true }; }
      return { fail: rp || { kind: "transient" }, label: d.h };
    }
    u.deepOff = 0;
    u.deep.shift();
    u.deepTimes.push(Date.now());
    u.inactChecked = (u.inactChecked || 0) + 1;
    if (rp.seen > 0 && rp.newest && rp.newest < since) {
      u.ibatch.push({ i: d.i, h: d.h, n: d.n, a: d.a, ia: 1, fc: d.fc, qs: GX.qualityScore(Object.assign({}, d, { lt: rp.newest })), lt: rp.newest,
        why: `no post in ${s.unfInactiveDays} days - last one ${agoDays(Date.now(), rp.newest)}` });
      logLine(job, d.h, "wait", `inactive: last post ${agoDays(Date.now(), rp.newest)}`, "fb");
    } else if (!rp.seen && d.sc === 0) {
      u.ibatch.push({ i: d.i, h: d.h, n: d.n, a: d.a, ia: 1, fc: d.fc, qs: GX.qualityScore(d), why: "has never posted" });
    } else u.inactKeptActive = (u.inactKeptActive || 0) + 1;              // posted inside the period, or unknown: kept
    if (!u.deep.length && (u.mpos || 0) >= (u.mutual || []).length) u.mutualDoneAt = Date.now();
    return { did: true };
  }
  if (u.deep.length && capFull) return { capUntil: u.deepTimes[0] + HOUR + rand(20000, 90000) };
  return { did: false };
}

async function unfollowStep(job, s, now) {
  job.mode = "unfollow";
  if (job.nextAt && now < job.nextAt) {
    // The wait between two unfollows is used for the inactive check (reads only, no extra unfollows).
    if (GX.unfInactiveOn(s) && job.nextAt - now > 7000) {
      const u0 = await getUnf(job.ownerId);
      if ((u0.stage === "ready" || u0.stage === "done") && u0.mutualAt && inactivePending(u0) && now >= (u0.inactUntil || 0)) {
        const w = await inactiveWork(job, s, u0, now);
        if (w.wrongAccount) { await haltFor(job, "account"); return park(job, s, Infinity, false); }
        if (w.fail && ["automation", "auth", "locked", "suspended", "challenge", "captcha"].includes(w.fail.kind)) return unfFail(job, s, Date.now(), w.fail, w.label || "");
        // Other read errors: back off the inactive check for a while instead of retrying every tick.
        if (w.fail) u0.inactUntil = Date.now() + Math.min(Math.max(w.fail.waitMs || 0, 5 * MIN), HOUR);
        if (w.pauseUntil) u0.inactUntil = w.pauseUntil;
        await save({ [K.unf]: u0 });
        // More time left before the next unfollow: do another read in a few seconds.
        if (w.did && job.nextAt - Date.now() > 9000) return park(job, s, Date.now() + rand(3000, 6000), false);
      }
    }
    return park(job, s, job.nextAt, true);
  }
  const u = await getUnf(job.ownerId);

  // The inactive check and the "active followers" step both need the list of people who follow you back: read the
  // list again if it's missing, and once a month after everything on it was handled (people change over time).
  const needMutual = GX.unfInactiveOn(s) || GX.unfEveryone(s);
  const inactDone = !GX.unfInactiveOn(s) || ((u.mpos || 0) >= (u.mutual || []).length && !(u.deep || []).length);
  const actDone = !GX.unfEveryone(s) || (u.apos || 0) >= (u.mutual || []).length;
  if (needMutual && (u.stage === "ready" || u.stage === "done") &&
      (!u.mutualAt || (u.stage === "done" && inactDone && actDone && now - (Math.max(u.mutualDoneAt || 0, u.actDoneAt || 0) || u.mutualAt) > 30 * DAY))) {
    if (!u.mscan) {
      u.mscan = { stage: "friends", cursor: null, friends: [], followers: [] };
      await save({ [K.unf]: u });
      await pushEvent("run", "Inactive check: reading who you follow and who follows you back.");
    }
  }

  // A0. Inactive-only re-read (does not touch the old list or its progress).
  if (u.mscan && (u.stage === "ready" || u.stage === "done")) {
    const sc = u.mscan, isF = sc.stage === "friends";
    job.message = `Inactive check: reading ${isF ? "who you follow" : "your followers"} (${(isF ? sc.friends : sc.followers).length.toLocaleString()} so far)...`;
    if (!await commitJob(job) || !ACTIVE.has(job.status)) return;
    const r = await sendTab(job.tabId, { gx: isF ? "frids" : "fids", cursor: sc.cursor, userId: job.ownerId }, 60000);
    if (r && r.uid && job.ownerId && r.uid !== job.ownerId) { await haltFor(job, "account"); return park(job, s, Infinity, false); }
    if (isRate(r)) return readRate(job, s, Date.now(), r, "Inactive check: reading your lists");
    if (!r || !r.ok) return unfFail(job, s, Date.now(), r, "");
    readOk(job);
    (isF ? sc.friends : sc.followers).push(...r.ids);
    sc.cursor = r.end ? null : r.cursor;
    if (!sc.cursor) {
      if (isF) sc.stage = "followers";
      else {
        const fol = new Set(sc.followers), queued = new Set((u.ibatch || []).map((x) => x.i)), mseen = new Set();
        // X lists newest first: "old" = reversed (the ones you followed longest ago first), "new" = as X lists them.
        u.mutual = (GX.unfNewest(s) ? sc.friends.slice() : sc.friends.slice().reverse()).filter((id) => { if (mseen.has(id) || !fol.has(id) || queued.has(id)) return false; mseen.add(id); return true; });
        u.morder = GX.unfNewest(s) ? "new" : "old";
        u.mpos = 0; u.mutualAt = Date.now(); u.mutualDoneAt = null; u.deep = [];
        u.apos = 0; u.abase = 0; u.actDoneAt = null;
        delete u.mscan;
        await pushEvent("run", `Followers list: ${u.mutual.length.toLocaleString()} accounts follow you back${GX.unfInactiveOn(s) ? " and will be checked for activity" : " - none of them will be unfollowed"}.`);
      }
    }
    await save({ [K.unf]: u });
    job.nextAt = Date.now() + rand(4000, 9000);
    return park(job, s, job.nextAt, false);
  }

  // You changed "Who first" while a list was half done: what is left is turned around, nothing is done twice, nothing is lost.
  if (unfReorder(u, s)) await save({ [K.unf]: u });

  // Lists built by v2.4.1 or older don't know each account's place in your following: read once more.
  if (u.stage === "ready" && !u.rank && !(u.batch || []).length) {
    Object.assign(u, { stage: "friends", cursor: null, friends: [], followers: [], batch: [], deep: [] });
    await save({ [K.unf]: u });
    await pushEvent("run", "Unfollow: reading your following list again to number every account.");
  }

  // A. Build the old list: all accounts you follow (newest first from X), then your followers.
  if (u.stage === "friends" || u.stage === "followers") {
    const isF = u.stage === "friends";
    job.message = isF
      ? `Auto-unfollow: reading the accounts you follow (${u.friends.length.toLocaleString()} so far)...`
      : `Auto-unfollow: reading your followers (${u.followers.length.toLocaleString()} so far)...`;
    if (!await commitJob(job) || !ACTIVE.has(job.status)) return;
    const r = await sendTab(job.tabId, { gx: isF ? "frids" : "fids", cursor: u.cursor, userId: job.ownerId }, 60000);
    if (r && r.uid && job.ownerId && r.uid !== job.ownerId) { await haltFor(job, "account"); return park(job, s, Infinity, false); }
    if (isRate(r)) return readRate(job, s, Date.now(), r, `Reading ${isF ? "the accounts you follow" : "your followers"} (${(isF ? u.friends : u.followers).length.toLocaleString()} so far)`);
    if (!r || !r.ok) return unfFail(job, s, Date.now(), r, "");
    readOk(job);
    if (isF) u.friends.push(...r.ids); else u.followers.push(...r.ids);
    u.cursor = r.end ? null : r.cursor;
    if (!u.cursor) {
      if (isF) u.stage = "followers";
      else {
        const fol = new Set(u.followers);
        const idx = await getFollowIndex();
        const recent = Date.now() - s.unfollowAfterDays * DAY;
        const seen = new Set();
        // X lists newest first -> reverse = oldest first (or as X lists them for "newest first"). Skip followers and GrowX
        // follows that are still "young". #1 is the first one in the order you chose.
        const ordered = GX.unfNewest(s) ? u.friends.slice() : u.friends.slice().reverse();
        const rankOf = new Map();
        ordered.forEach((id, i) => { if (!rankOf.has(id)) rankOf.set(id, rankOf.size + 1); });
        u.ftotal = rankOf.size;
        u.list = ordered.filter((id) => {
          if (seen.has(id)) return false; seen.add(id);
          if (fol.has(id)) return false;
          const f = idx.get(id);
          return !(f && f.t > recent);
        });
        const mseen = new Set();
        u.mutual = ordered.filter((id) => { if (mseen.has(id) || !fol.has(id)) return false; mseen.add(id); return true; });
        u.order = u.morder = GX.unfNewest(s) ? "new" : "old";
        u.mpos = 0; u.mutualAt = Date.now(); u.mutualDoneAt = null; u.deep = []; delete u.mscan;
        u.apos = 0; u.abase = 0; u.actDoneAt = null;
        u.rank = u.list.map((id) => rankOf.get(id) || 0);
        u.total = u.list.length; u.pos = 0; u.batch = []; u.friends = []; u.followers = []; u.stage = "ready"; u.builtAt = Date.now();
        const accNow = await load(K.account, null);
        if (accNow && typeof accNow.following === "number") u.startFollowing = accNow.following;
        await pushEvent("run", `Auto-unfollow: ${u.total.toLocaleString()} accounts you follow don't follow you back. Unfollowing them ${GX.unfLostFirst(s) ? "with the people who unfollowed you first, then oldest" : GX.unfNewest(s) ? "newest" : "oldest"} first, ${s.unfollowDaily}/day.${GX.unfEveryone(s) ? " After them the people who DO follow you back are unfollowed too." : ""}`);
      }
    }
    await save({ [K.unf]: u });
    job.nextAt = Date.now() + rand(4000, 9000);
    return park(job, s, job.nextAt, false);
  }

  // B. Daily unfollow limit
  const today = await unfToday(now);
  if (today >= s.unfollowDaily) {
    const freeAt = startOfToday(now) + DAY + rand(30000, 180000);
    const left = u.stage === "ready" ? " Old list: " + Math.max(0, u.total - u.pos + (u.batch || []).length).toLocaleString() + " left." : "";
    // Unfollow is done for today: with automatic switching on, the next mode takes over after a transition break.
    if (await beginSwitch(job, s, now, "unfollow", `Unfollow target of ${s.unfollowDaily} reached for today.${left}`)) return park(job, s, job.restUntil, true);
    rest(job, "daily", freeAt, `Unfollow limit of ${s.unfollowDaily} reached for today.${left} Continues at ${clock(freeAt)}.`);
    logLine(job, "", "wait", "daily unfollow limit");
    return park(job, s, job.restUntil, true);
  }

  // B2. Its turn is done: hand over to the next mode (today's number is not used up, so it comes back round).
  if (await turnOver(job, s, now, "unfollow")) return park(job, s, job.restUntil, true);

  // C. Unfollow breaks and hourly cap - Unfollow's OWN break settings: a random count between
  //    unfRestEveryMin and unfRestEvery, then a random length between unfRestMinutes and unfRestMinutesMax.
  const newRestAfter = () => { const n = restAfter(s, "unfollow"); return Number.isFinite(n) ? n : 0; };
  const uBase = restKey(s, "unfollow");
  if (job.uRestBase !== uBase || job.uRestAfter == null) { job.uRestBase = uBase; job.uRestAfter = newRestAfter(); }
  if (s.unfRestEvery) job.uSince = Math.max(job.uSince || 0, ledgerRun((await load(K.uledger, [])).filter(Number.isFinite).sort((a, b) => a - b), now, s.unfRestMinutes * 60000));
  if (job.uRestAfter && (job.uSince || 0) >= job.uRestAfter) {
    const ms = GX.breakMs(s, "unfollow");
    rest(job, "cooldown", now + ms, `Break after ${job.uSince} unfollows (${breakText(s, "unfollow", ms)}). Back at ${clock(now + ms)}.`);
    job.uSince = 0; job.uRestAfter = newRestAfter();
    logLine(job, "", "wait", `unfollow break ${Math.round(ms / 60000)} min`);
    return park(job, s, job.restUntil, true);
  }
  const ul = (await load(K.uledger, [])).filter((x) => x > now - HOUR).sort((x, y) => x - y);
  const uCap = GX.hourlyCap(s, "unfollow").cap;
  if (ul.length >= uCap) {
    const freeAt = ul[ul.length - uCap] + HOUR + rand(20000, 90000);
    rest(job, "hourly", freeAt, `Hourly pace of ${uCap} unfollows reached${s.hourlyAuto ? " (worked out for you)" : ""}. Back at ${clock(freeAt)}.`);
    return park(job, s, job.restUntil, true);
  }

  await cmtTargets();          // so a target account is in the keep list from the first batch
  // D. Next batch of up to 100, re-checked right now
  // Inactive finds wait (they are not lost) while their switch is off.
  const useI = GX.unfInactiveOn(s) && (u.ibatch || []).length > 0;
  if ((!u.batch || !u.batch.length) && !useI) {
    let ids, act = false, lost = false;
    const phase2 = u.stage === "done";
    // The people who unfollowed you go first: the ones you ticked on the "Unfollowed you" page always, and
    // with "Who first: people who unfollowed you" every one of them. Whatever stage the old list is at.
    const lsel = await pickLostIds(job.ownerId, s, now, { any: GX.unfLostFirst(s) });
    if (lsel.length) { ids = lsel; lost = true; }
    else if (!phase2) {
      ids = u.list.slice(u.pos, u.pos + 100);
      if (!ids.length) {
        u.stage = "done"; u.doneAt = Date.now(); u.list = []; u.batch = [];
        await save({ [K.unf]: u });
        const msg = `Auto-unfollow: old list finished (${u.removed.toLocaleString()} unfollowed). From now on GrowX unfollows non-followers after ${s.unfollowAfterDays} days, then follows.`;
        await pushEvent("run", msg);
        await notify("milestone", "Old following list cleaned", msg);
        return park(job, s, Date.now() + 1000, true);
      }
    } else {
      const cut = now - s.unfollowAfterDays * DAY;
      ids = (await getFollows()).filter(dueFollowFilter(job, now, cut))
        .sort((a, b) => (GX.unfNewest(s) ? b.t - a.t : a.t - b.t)).slice(0, 100).map((f) => f.i);
      // "Also unfollow active followers" is on and followers are left: they fill today's number once no non-follower is due.
      // (The inactive check then runs in the waits between unfollows, so it never holds this up.)
      const actReady = GX.unfEveryone(s) && actPending(u);
      if (!ids.length && GX.unfInactiveOn(s) && inactivePending(u) && !actReady) {
        // No non-followers due: spend the time on the inactive check.
        const w = await inactiveWork(job, s, u, now);
        if (w.wrongAccount) { await haltFor(job, "account"); return park(job, s, Infinity, false); }
        if (w.fail) return unfFail(job, s, Date.now(), w.fail, w.label || "");
        await save({ [K.unf]: u });
        if (w.capUntil && !(u.ibatch || []).length) {
          rest(job, "hourly", w.capUntil, `Inactive check: 120 profiles read this hour - next reads at ${clock(w.capUntil)}.`);
          return park(job, s, job.restUntil, true);
        }
        if (w.pauseUntil && !(u.ibatch || []).length) {
          rest(job, "hourly", w.pauseUntil, `${w.msg} Next try at ${clock(w.pauseUntil)}.`);
          return park(job, s, job.restUntil, true);
        }
        readOk(job);
        job.nextAt = Date.now() + rand(2500, 6000);
        return park(job, s, job.nextAt, false);
      }
      if (!ids.length && actReady) {
        u.abase = u.apos || 0;
        ids = u.mutual.slice(u.abase, u.abase + 50);
        act = true;
        if (u.actNoteDay !== dayKey(now)) {
          u.actNoteDay = dayKey(now);
          await pushEvent("run", `Unfollow: no non-follower is due, so GrowX now unfollows the people who follow you back too - ${GX.unfNewest(s) ? "the ones you followed most recently first" : "the ones you followed longest ago first"}. Your Never unfollow list is respected.`);
        }
      }
      if (!ids.length) {
        // Nobody has reached the no-follow-back age yet: check again in an hour (or when the next one is due).
        const soon = (await getFollows()).filter((f) => f.i && !f.fb && !f.fy0 && !f.nf && !f.uf && !f.uk && (!f.o || f.o === job.ownerId))
          .reduce((m, f) => Math.min(m, f.t + s.unfollowAfterDays * DAY), Infinity);
        const until = Math.max(now + 10 * MIN, Math.min(now + HOUR, soon + rand(30000, 120000)));
        const guarded = GX.unfProtect(s);
        const why = guarded
          ? " Nobody who follows you back is ever unfollowed - that guard is on."
          : GX.unfEveryone(s) ? "" : " People who follow you back are never unfollowed (Who first is not set to \"everyone\", and switch U6 is off).";
        // You asked GrowX to stop rather than idle when there is nobody left it
        // is allowed to unfollow. It says so once, then waits for you to Start.
        // v3.2: this works with the guard off too (inactive mode) - once the inactive check has nothing left either.
        if (s.unfStopWhenEmpty && (guarded || !GX.unfInactiveOn(s) || !inactivePending(u))) {
          const msg = `Unfollow finished: nobody is left that GrowX may unfollow. Everyone still on your list follows you back${GX.unfInactiveOn(s) ? " and is active" : ""}, or is a big / good account - those are never unfollowed. ${today} of ${s.unfollowDaily} done today.`;
          job.status = "halted";
          job.haltKind = "done";
          job.message = msg;
          job.restUntil = null;
          await pushEvent("run", msg);
          await notify("milestone", "Unfollow stopped - nobody left to unfollow", msg);
          await actLog({ mode: "unfollow", act: "stop", why: "no one left that may be unfollowed" });
          logLine(job, "", "wait", "stopped - nobody left that may be unfollowed");
          return park(job, s, Infinity, false);
        }
        rest(job, "empty", until, `Nobody to unfollow right now (${today} of ${s.unfollowDaily} done today).${why} Next check ${clock(until)}.`);
        logLine(job, "", "wait", "nothing due to unfollow");
        return park(job, s, job.restUntil, true);
      }
    }
    job.message = lost
      ? `Unfollowed you: checking ${ids.length} account${ids.length === 1 ? "" : "s"} that stopped following you...`
      : act
      ? `Auto-unfollow: checking ${ids.length} followers before unfollowing (active followers is on)...`
      : `Auto-unfollow: checking ${ids.length} accounts before unfollowing...`;
    if (!await commitJob(job) || !ACTIVE.has(job.status)) return;
    const rr = await sendTab(job.tabId, { gx: "rel", ids }, 45000);
    if (rr && rr.uid && job.ownerId && rr.uid !== job.ownerId) { await haltFor(job, "account"); return park(job, s, Infinity, false); }
    if (isRate(rr)) return readRate(job, s, Date.now(), rr, "Checking the next accounts before unfollowing");
    if (!rr || !rr.ok) return unfFail(job, s, Date.now(), rr, "");
    const map = Object.assign({}, rr.map || {}), keep = keepSet(s), idx = await getFollowIndex();
    // No answer for some accounts: ask once more with the profile lookup before deciding.
    const missing = ids.filter((id) => !map[id]);
    const unknown = new Set();
    if (missing.length) {
      const ri = await sendTab(job.tabId, { gx: "uinfo", ids: missing }, 45000);
      if (ri && ri.ok) {
        for (const id of missing) {
          const x = (ri.map || {})[id];
          if (!x) map[id] = { gone: true };                                         // deleted / suspended
          else if (x.fy === true || x.fy === false) map[id] = { fy: x.fy, fw: x.fw !== false, h: x.h };
          else unknown.add(id);
        }
      } else missing.forEach((id) => unknown.add(id));
    }
    const go = [];
    const lostFound = [];
    let touched = false;
    // Active followers: anyone GrowX followed or followed back in the last "unfollow after" days is left alone.
    let youngBk = null;
    const youngCut = now - s.unfollowAfterDays * DAY;
    if (act) {
      const bl = await load(K.bklog, []);
      youngBk = new Set((Array.isArray(bl) ? bl : []).filter((x) => x && x.i && x.t > youngCut).map((x) => x.i));
    }
    for (const id of ids) {
      const m = map[id];
      const f = idx.get(id);
      if (act) {
        // Never a guess: no clear answer, gone, or not followed any more = skipped. Keep list and recent follows are skipped too.
        if (unknown.has(id) || !m || m.gone || m.fw === false) continue;
        if (m.h && keep.has(String(m.h).toLowerCase())) continue;
        if ((f && f.t > youngCut) || youngBk.has(id)) continue;
        if (GX.unfProtect(s) && GX.followsYouBack(null, m, f)) continue;   // THE GUARD
        go.push({ i: id, h: m.h || (f && f.h) || "", src: "act", fy: m.fy === true });
        continue;
      }
      // THE GUARD, where the list is built: anyone who follows you back is left
      // out, whatever the other switches say.
      if (GX.unfProtect(s) && GX.followsYouBack(null, m, f)) {
        if (f && m && m.fy === true && !f.fb) { f.fb = Date.now(); touched = true; }
        continue;
      }
      if (unknown.has(id)) { if (f) { f.uq = Date.now(); touched = true; } continue; }   // can't tell: never guess, retry tomorrow
      if (m && m.gone) { if (f) { f.nf = 1; touched = true; } continue; }
      // Followed you back once and X now says they don't: note the unfollower before deciding anything else.
      if (m && m.fy === false && f && f.fb && !f.lost && !f.nf) { f.lost = now; touched = true; lostFound.push({ i: id, h: m.h || f.h, n: f.n, a: f.a, fbAt: f.fb }); }
      if (m && m.fy) { if (f) { if (!f.fb) f.fb = Date.now(); if (f.lost) f.lost = 0; touched = true; } continue; }   // follows you: keep
      if (m && m.fw === false && !m.pending) { if (f) { f.nf = 1; touched = true; } continue; } // already not following
      if (m && m.h && keep.has(String(m.h).toLowerCase())) { if (f) { f.uk = 1; touched = true; } continue; }
      if (f && f.rf) continue;                                                  // v3.2: you followed them again by hand - kept
      go.push({ i: id, h: (m && m.h) || (f && f.h) || "", src: lost ? "lost" : phase2 ? "7d" : "old", rk: lost || phase2 ? 0 : ((u.rank || [])[u.pos + ids.indexOf(id)] || 0) });
    }
    // v3.2 big-account guard where the batch is built: one lookup for the whole batch, big / good accounts are dropped
    // (and kept for good). The same check runs again right before each unfollow.
    if (go.length && s.unfProtectBig !== false) {
      const gi = await sendTab(job.tabId, { gx: "uinfo", ids: go.map((x) => x.i) }, 45000);
      if (gi && gi.uid && job.ownerId && gi.uid !== job.ownerId) { await haltFor(job, "account"); return park(job, s, Infinity, false); }
      if (gi && gi.ok) {
        const kept = [];
        for (let j = go.length - 1; j >= 0; j--) {
          const info = (gi.map || {})[go[j].i];
          if (!info) continue;
          go[j].fc = info.fc; go[j].qs = GX.qualityScore(info); go[j].n = go[j].n || info.n; go[j].a = go[j].a || info.a;
          const why = GX.bigReason(info, s);
          if (why) {
            kept.push(go[j].h || info.h);
            const fk = idx.get(go[j].i);
            if (fk) { fk.uk = 1; touched = true; }
            go.splice(j, 1);
          }
        }
        if (kept.length) {
          u.keptBig = (u.keptBig || 0) + kept.length;
          logLine(job, "", "skip", `${kept.length} big / good account${kept.length === 1 ? "" : "s"} kept (${kept.slice(0, 3).map((h) => "@" + h).join(", ")}${kept.length > 3 ? "…" : ""})`);
        }
      }
    }
    if (touched) await saveFollows();
    if (lostFound.length) await addLost(job.ownerId, lostFound, "unfollow", now);
    if (act) {
      u.apos = (u.abase || 0) + ids.length;
      if (u.apos >= (u.mutual || []).length) u.actDoneAt = Date.now();
    } else if (!phase2 && !lost) { u.pos += ids.length; u.skipped += ids.length - go.length; }
    else if (!go.length) { /* everyone was skipped; the next step picks the next 100 */ }
    u.batch = go;
    await save({ [K.unf]: u });
    readOk(job);
    job.nextAt = Date.now() + rand(3000, 7000);
    return park(job, s, job.nextAt, false);
  }

  // E. Unfollow one (inactive finds first - they are few)
  // Settings can change while a batch waits: an OFF switch means those accounts are not touched (they stay queued
  // or go back on the list, so switching it on again picks them up).
  const dropAct = async () => {
    u.batch = (u.batch || []).filter((x) => x.src !== "act");
    u.apos = Math.min(u.apos || 0, u.abase || 0);
    await save({ [K.unf]: u });
    return park(job, s, Date.now() + 1500, false);
  };
  if (!GX.unfEveryone(s) && (u.batch || []).some((x) => x.src === "act")) return dropAct();
  if (!(u.batch || []).length && !useI) return park(job, s, Date.now() + 1500, false);
  const fromI = useI;
  const t = fromI ? u.ibatch[0] : u.batch[0];
  // Non-followers always come first: if one became due while followers were waiting, the followers step back.
  if (!fromI && t.src === "act" && (await getFollows()).some(dueFollowFilter(job, now, now - s.unfollowAfterDays * DAY))) return dropAct();
  // Never unfollow someone you added to the keep list after this batch was made.
  if (t.h && keepSet(s).has(String(t.h).toLowerCase())) {
    (fromI ? u.ibatch : u.batch).shift();
    const fk = (await getFollowIndex()).get(t.i);
    if (fk) { fk.uk = 1; await saveFollows(); }
    logLine(job, t.h, "skip", "on your Never unfollow list", t.ia || (t.src === "act" && t.fy) ? "fb" : "nf");
    await save({ [K.unf]: u });
    job.nextAt = Date.now() + rand(1500, 3500);
    return park(job, s, job.nextAt, false);
  }
  // THE GUARD, one step before the request leaves. Two parts, in this order:
  //   1. what GrowX already knows - a queue built under older settings, or an
  //      account that followed you back while it waited in it;
  //   2. a fresh question to X about this one account, asked now.
  // If X does not give a clear answer, the account is skipped. An unfollow is
  // never sent on a guess.
  const verdict = await unfVerify(job, s, t);
  if (verdict.wrongAccount) { await haltFor(job, "account"); return park(job, s, Infinity, false); }
  if (verdict.rate) return readRate(job, s, Date.now(), verdict.rate, "Checking who follows you before unfollowing");
  if (verdict.skip) {
    const list = fromI ? u.ibatch : u.batch;
    const row = list.shift();
    if (verdict.retry) {                 // not an answer, so ask again later
      row.recheck = (row.recheck || 0) + 1;
      if (row.recheck < 3) list.push(row);
    } else if (verdict.theyFollowYou) {
      const fk = (await getFollowIndex()).get(t.i);
      if (fk && !fk.fb) { fk.fb = Date.now(); await saveFollows(); }
    } else if (verdict.big) {
      // A big / good account: kept for good, never picked again.
      const fk = (await getFollowIndex()).get(t.i);
      if (fk) { fk.uk = 1; await saveFollows(); }
      u.keptBig = (u.keptBig || 0) + 1;
    } else if (verdict.active) u.inactKeptActive = (u.inactKeptActive || 0) + 1;
    await save({ [K.unf]: u });
    logLine(job, t.h, "skip", verdict.why, verdict.theyFollowYou || t.ia ? "fb" : undefined);
    await actLog({ mode: "unfollow", act: "skip", h: t.h, i: t.i, ok: !verdict.retry, why: verdict.why });
    job.nextAt = Date.now() + rand(verdict.retry ? 2000 : 800, verdict.retry ? 5000 : 2000);
    return park(job, s, job.nextAt, false);
  }
  const vi = verdict.info || {};
  const actFollower = t.src === "act" && t.fy === true;       // an active follower (setting U6), not a non-follower
  const tg = t.ia || actFollower ? "fb" : "nf";
  job.current = { i: t.i, h: t.h, n: t.n || "", a: t.a || "", tg, act: t.src === "act" ? 1 : 0, why: t.why || "", rk: t.rk || 0, rkOf: u.ftotal || 0 };
  job.message = `Unfollowing @${t.h || t.i}...`;
  if (!await commitJob(job) || !ACTIVE.has(job.status)) return;
  const r = (await sendTab(job.tabId, { gx: "unfollow", id: t.i, owner: job.ownerId }, 45000)) || { ok: false, kind: "transient", message: "no result" };
  now = Date.now();
  if (r.uid && job.ownerId && r.uid !== job.ownerId) { await haltFor(job, "account"); return park(job, s, Infinity, false); }
  if (!(r.ok || r.kind === "gone")) {
    // This one account failed (not X refusing in general, not the X tab): the others go first; a second failure leaves it for now,
    // so one bad account can never stop the whole day. (X saying no / slow down goes straight to the X-refused plan.)
    if (!["rate", "limit", "automation", "auth", "locked", "suspended", "challenge", "captcha"].includes(r.kind) && !r.noAnswer) {
      const list = fromI ? u.ibatch : u.batch;
      t.tf = (t.tf || 0) + 1;
      if (t.tf >= 2) {
        list.shift();
        const fq = (await getFollowIndex()).get(t.i);
        if (fq) { fq.uq = Date.now(); await saveFollows(); }               // a GrowX follow: looked at again tomorrow
        if (!fromI && t.src === "old" && u.stage !== "done") u.skipped++;
        if (t.src === "lost") { const ll = await getLost(job.ownerId); const lx = ll.list.find((y) => y.i === t.i); if (lx) { lx.sel = 0; await saveLost(ll); } }
        logLine(job, t.h || t.i, "fail", `${r.message || "failed"} - left for now`, tg);
      } else if (list.length > 1) list.push(list.shift());
      await save({ [K.unf]: u });
    }
    return unfActFail(job, s, now, r, t.h);
  }

  (fromI ? u.ibatch : u.batch).shift();
  // The same account can be queued twice (an inactive find and the followers batch): it is never unfollowed twice.
  u.batch = (u.batch || []).filter((x) => x.i !== t.i);
  u.ibatch = (u.ibatch || []).filter((x) => x.i !== t.i);
  u.deep = (u.deep || []).filter((x) => x.i !== t.i);
  const f = (await getFollowIndex()).get(t.i);
  if (f) { f.nf = 1; f.uf = now; await saveFollows(); }
  job.consecutiveFails = 0; job.failsAtStrike = 0; job.rateHits = 0;
  const h = r.h || t.h || t.i;
  if (r.ok) {
    await ladOk(job, s, now);                       // X accepted it: after a few in a row earlier refusals are forgotten
    if (t.ia) u.inactRemoved = (u.inactRemoved || 0) + 1;
    else if (t.src === "act") u.actRemoved = (u.actRemoved || 0) + 1;
    else if (t.src === "lost") { u.lostRemoved = (u.lostRemoved || 0) + 1; await markLostDone(job.ownerId, t.i, now); }
    else if (u.stage !== "done") u.removed++;
    job.undone = (job.undone || 0) + 1;
    job.turnDone = (job.turnDone || 0) + 1;
    job.uSince = (job.uSince || 0) + 1;
    await pushUledger();
    await bumpStats({ unfollowed: 1 });
    const acc = await load(K.account, null);
    if (acc && typeof acc.following === "number") { acc.following = Math.max(0, acc.following - 1); await save({ [K.account]: acc }); }
    const why = t.ia ? `inactive - ${t.why || "no recent posts"}`
      : t.src === "lost" ? "followed you, then unfollowed you"
      : t.src === "act" ? (actFollower ? "follows you, active - unfollowed because \"active followers\" is on" : "stopped following you")
      : t.src === "7d" ? `no follow-back in ${s.unfollowAfterDays} days` : "old following, didn't follow you";
    logLine(job, h, "ok", "unfollowed", tg);
    job.log[0].w = why;
    if (t.rk) { job.log[0].rk = t.rk; job.log[0].rkOf = u.ftotal || 0; }
    const ul = await load(K.unlog, []);
    const arr = Array.isArray(ul) ? ul : [];
    if (tg === "fb") {
      // Lifetime number of followers GrowX unfollowed (inactive, or active with U6). First time it is seeded from the log, so older ones count too.
      const sx = await load(K.stats, {});
      await bumpStats({ unfollowedFollowers: (sx.unfollowedFollowers == null ? arr.filter((x) => x && x.k === "fb").length : 0) + 1 });
    }
    // v3.2: the numbers at the time of the unfollow, so the Unfollowed page can filter by score / activity / size and follow again.
    arr.unshift({ i: t.i, h, n: r.n || t.n || "", a: r.a || t.a || "", t: now, k: tg, w: why, o: job.ownerId, rk: t.rk || 0, rkOf: u.ftotal || 0,
      fc: vi.fc != null ? vi.fc : null, fr: vi.fr != null ? vi.fr : null, v: vi.v ? 1 : 0, lt: vi.lt || t.lt || null, sc: vi.sc != null ? vi.sc : null, ca: vi.ca || null,
      qs: GX.qualityScore(Object.keys(vi).length ? vi : t), ia: t.ia ? 1 : 0 });
    if (arr.length > 5000) arr.length = 5000;
    await save({ [K.unlog]: arr });
    await actLog({ mode: "unfollow", act: "unfollow", h, i: t.i, why, extra: { was: tg === "fb" ? "followed you back" : "not following you" } });
    let delay = rand(s.unfMinDelay, s.unfMaxDelay);
    if (Math.random() * 100 < s.unfLongPause) delay *= rand(2, 4);
    job.nextAt = now + delay * 1000;
    job.lastUnfollow = { h, n: r.n || "", a: r.a || "", at: now };
    job.message = `Unfollowed @${h} (${t.ia ? "follower, inactive" : actFollower ? "follower, active" : "non-follower"}). Next in ${Math.round(delay)}s${job.uRestAfter ? ` · ${job.uSince} of ${job.uRestAfter} before the break` : ""} · ${today + 1}/${s.unfollowDaily} today${u.stage !== "done" ? " · old list " + Math.max(0, u.total - u.pos + u.batch.length).toLocaleString() + " left" : ""}.`;
  } else {
    if (u.stage !== "done" && !t.ia) u.skipped++;
    logLine(job, h, "skip", r.message || "account gone", tg);
    job.nextAt = now + rand(2000, 5000);
  }
  await save({ [K.unf]: u });
  return park(job, s, job.nextAt, true);
}

// =====================================================================
// Follow back (v2.6.0)
//   Follows the people who follow YOU but whom you don't follow yet.
//   1. reads who you follow + who follows you (5,000 ids a request, newest first)
//   2. list = followers - following, in the order you chose (newest followers first by default)
//   3. every batch of 100 is looked up once more right before following: still following you? already
//      followed? private? hardly posts? -> skipped, never guessed
//   4. follows them one at a time with Follow back's OWN delays, breaks, hourly + daily numbers and hours,
//      and the SAME safety as Follow mode: X's daily + hourly follow limit is shared with Follow mode,
//      a failed follow = break, X refusing "unable to follow more people" twice = stopped for today.
// =====================================================================
function newBk(owner) {
  return { owner, stage: "friends", cursor: null, friends: [], followers: [], list: [], rank: [], pos: 0, batch: [], total: 0, followed: 0, skipped: 0, skips: {}, skip: {}, startedAt: Date.now() };
}
async function getBk(owner) {
  const b = await load(K.bk, null);
  return b && b.owner === owner ? b : newBk(owner);
}
async function bkToday(now) {
  const l = await load(K.bledger, []);
  return (Array.isArray(l) ? l : []).filter((t) => t >= startOfToday(now)).length;
}
async function pushBledger() {
  const cutoff = Date.now() - 2 * DAY;
  const l = (await load(K.bledger, [])).filter((t) => t > cutoff);
  l.push(Date.now());
  await save({ [K.bledger]: l });
}

// The list: everyone who follows you, minus everyone you follow, in the order you chose.
// Never again: accounts GrowX already followed back once, and followers GrowX unfollowed for being inactive.
async function bkBuild(job, s, b) {
  const now = Date.now();
  const mine = new Set(b.friends);
  const blog = await load(K.bklog, []);
  const never = new Set((Array.isArray(blog) ? blog : []).map((x) => x && x.i).filter(Boolean));
  const ul = await load(K.unlog, []);
  for (const x of Array.isArray(ul) ? ul : []) if (x && x.k === "fb" && x.i) never.add(x.i);
  const recent = now - 14 * DAY;
  const skip = b.skip || {};
  for (const k of Object.keys(skip)) if (!(skip[k] > recent)) delete skip[k];
  const keys = Object.keys(skip);
  if (keys.length > 30000) keys.sort((x, y) => skip[x] - skip[y]).slice(0, keys.length - 25000).forEach((k) => delete skip[k]);
  const ordered = s.bkOrder === "old" ? b.followers.slice().reverse() : b.followers;        // X lists followers newest first
  const seen = new Set(), list = [], rank = [], nAll = ordered.length;
  ordered.forEach((id, i) => {
    if (seen.has(id)) return;
    seen.add(id);
    if (id === job.ownerId || mine.has(id) || never.has(id) || skip[id]) return;
    list.push(id); rank.push(s.bkOrder === "old" ? nAll - i : i + 1);     // follower #N: your newest follower is #1, whatever the order
  });
  // Anyone you named in a pasted list who already follows you waits here until
  // the follower list exists; they then go to the very front of it.
  const pre = (await load(K.bkpre, [])) || [];
  if (pre.length) {
    const have = new Set(list.map(String));
    const first = pre.map(String).filter((i) => have.has(i));
    if (first.length) {
      const firstSet = new Set(first);
      for (let i = list.length - 1; i >= 0; i--) if (firstSet.has(String(list[i]))) { list.splice(i, 1); rank.splice(i, 1); }
      list.unshift(...first);
      rank.unshift(...first.map(() => 0));
    }
    await chrome.storage.local.remove(K.bkpre);
  }
  Object.assign(b, { fcount: seen.size, frcount: mine.size, list, rank, total: list.length, pos: 0, batch: [], friends: [], followers: [], skip, stage: "ready", builtAt: now, order: s.bkOrder, cursor: null });
  if (b.startFollowing == null) {
    const acc = await load(K.account, null);
    if (acc && typeof acc.following === "number") b.startFollowing = acc.following;
  }
  return list.length;
}

// Who-to-follow-back rules (B6, B7) just changed: everyone skipped under the OLD rules gets a fresh look under the new ones,
// and the list is read again (a few requests) so the already looked-up batch can't carry old decisions.
const BK_RULES = ["bkVerifiedOnly", "bkSkipInactive", "bkInactiveDays", "bkMinPosts", "bkSkipProtected", "bkSkipNoPhoto"];
async function bkForgetSkips() {
  const b = await load(K.bk, null);
  if (!b) return;
  b.skip = {};
  b.skipped = 0; b.skips = {};                    // the "skipped so far" numbers describe the new rules only
  b.deepFailRun = 0; b.deepOffUntil = 0; b.announced = null;
  if (b.stage === "ready" || b.stage === "done") Object.assign(b, { stage: "friends", cursor: null, friends: [], followers: [], list: [], rank: [], pos: 0, batch: [] });
  await save({ [K.bk]: b });
}
async function bkRulesChanged() {
  const j = await load(K.job, null);
  if (j && ACTIVE.has(j.status)) { const c = (await load(K.ctl, null)) || {}; c.bkRules = true; await save({ [K.ctl]: c }); scheduleTick(500); }   // the engine does it at the start of its next step
  else await bkForgetSkips();
}

// Is this follower one to skip (with the settings and Never follow list as they are RIGHT NOW)?
// Returns [reason, remember, days, detail] or null.
//   reason   short name, counted on the dashboard ("Skipped so far - inactive: 12")
//   remember keep the account off the list for `days` (default 14) so it isn't looked up again and again
//   detail   the longer text for the activity feed
// m: { h, p, d, sc, lt, v } - used for a fresh lookup and again just before every follow-back.
// The post COUNT (fewer than N posts in the last D days) needs a profile read: that is bkCountPosts(), done right before following.
function bkWhy(m, s, bl, now) {
  if (m.h && bl.has(String(m.h).toLowerCase())) return ["on your Never follow list", true];
  if (s.bkVerifiedOnly) {
    const v = m.v === true || m.v === 1 ? 1 : m.v === false || m.v === 0 ? 0 : null;
    if (v === 0) return ["not verified", true, 3];
    if (v === null) return ["verified badge unknown", true, 1];         // X didn't show the badge: never guessed
  }
  if (s.bkSkipProtected && m.p) return ["private account", true];
  if (s.bkSkipNoPhoto && m.d) return ["no profile photo", true];
  if (s.bkSkipInactive) {
    // Two cases are certain without reading the profile: not enough posts in total, or no post at all in the period.
    if (typeof m.sc === "number" && m.sc < s.bkMinPosts) return ["inactive", true, 14, `inactive - only ${m.sc} post${m.sc === 1 ? "" : "s"} ever`];
    if (m.lt && now - m.lt > s.bkInactiveDays * DAY) return ["inactive", true, 14, `inactive - last post ${Math.round((now - m.lt) / DAY)} days ago`];
  }
  return null;
}
// The Never follow list can be changed any time (Queue page, Settings): read it fresh before acting.
async function freshBlacklist() { mem.blacklist = null; return getBlacklist(); }

// Looks up the next 100 on the list once more and keeps only those that are really worth following back right now.
async function bkNextBatch(job, s, b, now) {
  // v3.2 "Big score first" (bkQuality): three lookups (300 followers) at a time, the biggest / best followed back first.
  const ids = b.list.slice(b.pos, b.pos + (s.bkQuality ? 300 : 100));
  let map = {}, thin = false;
  for (let o = 0; o < ids.length; o += 100) {
    const part = ids.slice(o, o + 100);
    const ask = { gx: "uinfo", ids: part, verified: !!s.bkVerifiedOnly };     // verified: X's badge is needed too
    const ri = await sendTab(job.tabId, ask, 45000);
    if (ri && ri.uid && job.ownerId && ri.uid !== job.ownerId) return { wrongAccount: true };
    if (!ri || !ri.ok) { if (o) { ids.length = o; break; } return { fail: ri || { kind: "transient", message: "no answer" } }; }
    let pm = ri.map || {};
    // X answered with far fewer accounts than asked. Ask once more. If it says the same again, believe the accounts it did
    // answer (their data is fresh) and skip the missing ones for ONE day only - a slice of old followers can really be mostly
    // deleted/suspended accounts, and the list must keep moving.
    if (part.length >= 10 && Object.keys(pm).length < part.length * 0.5) {
      const r2 = await sendTab(job.tabId, ask, 45000);
      if (r2 && r2.uid && job.ownerId && r2.uid !== job.ownerId) return { wrongAccount: true };
      if (!r2 || !r2.ok) { if (o) { ids.length = o; break; } return { fail: r2 || { kind: "transient", message: "no answer" } }; }
      pm = Object.assign({}, pm, r2.map || {});
      if (Object.keys(pm).length < part.length * 0.5) thin = true;
    }
    Object.assign(map, pm);
    if (o + 100 < ids.length) await sleep(rand(1200, 2500));
  }
  const bl = await freshBlacklist();
  const go = [];
  const lostHere = [];
  let unknownBadge = 0;
  // remember: keep this account out of the list for a while (days) so it isn't looked up again and again
  const skipped = (id, why, remember, days) => { b.skipped++; b.skips[why] = (b.skips[why] || 0) + 1; if (remember) b.skip[id] = now - (14 - (days || 14)) * DAY; };
  ids.forEach((id, k) => {
    const m = map[id];
    const rk = (b.rank || [])[b.pos + k] || 0;
    if (!m) return thin ? skipped(id, "no answer from X", true, 1) : skipped(id, "account gone", true);   // deleted or suspended
    if (m.fw === true) return skipped(id, "already following");                  // you follow them now (the list was a little older)
    if (m.fy === false) { lostHere.push({ i: id, h: m.h, n: m.n, a: m.a, fbAt: 0 }); return skipped(id, "unfollowed you since", true, 1); }   // not a follower any more (X's list was a little old): not looked at again today
    const why = bkWhy(m, s, bl, now);
    if (why) { if (why[0] === "verified badge unknown") unknownBadge++; return skipped(id, why[0], why[1], why[2]); }
    go.push({ i: id, h: m.h, n: m.n || "", a: m.a || "", rk, fc: m.fc, fr: m.fr, p: !!m.p, d: !!m.d, sc: typeof m.sc === "number" ? m.sc : null, lt: m.lt || 0, v: m.v === true ? 1 : m.v === false ? 0 : null, qs: GX.qualityScore(m) });
  });
  if (s.bkQuality) go.sort((x, y) => (y.qs || 0) - (x.qs || 0));
  // X didn't show the verified badge for (almost) all of them: say so once in a while - nobody can be judged "verified" without it.
  if (unknownBadge >= 5 && unknownBadge >= ids.length * 0.5 && now - (b.badgeWarnAt || 0) > 6 * HOUR) {
    b.badgeWarnAt = now;
    await pushEvent("warn", `Follow back: X is not showing the verified badge right now, so ${unknownBadge} followers were skipped instead of guessed. Try again later, or switch "Only verified accounts" off.`);
  }
  if (lostHere.length) await addLost(job.ownerId, lostHere, "followback", now);
  b.pos += ids.length;
  b.batch = go;
  return { ok: true, asked: ids.length, kept: go.length };
}

// The inactive rule: fewer than `bkMinPosts` posts (replies and reposts count too) in the last `bkInactiveDays` days.
// The profile is read right before following back, the way a person looks first. Reads are paced: at most 40 in any
// 15 minutes and 120 an hour (every request counts, also a failed one).
// Returns one of:
//   { count }              the number of posts in the period
//   { unreadable, why }    THIS profile's posts can't be read (private, blocked, X gave nothing): the follower is skipped, not guessed
//   { unknown }            X isn't showing post lists at all right now (3 different profiles in a row): quick rules only for 30 minutes
//   { gone } | { retry } | { capUntil } | { wrong } | { fail }
async function bkCountPosts(job, s, b, t, now) {
  b.deepTimes = (b.deepTimes || []).filter((x) => x > now - HOUR);
  if (b.deepOffUntil && now < b.deepOffUntil) return { unknown: true };
  if (b.deepTimes.length >= 120) return { capUntil: b.deepTimes[0] + HOUR + rand(20000, 90000) };
  const burst = b.deepTimes.filter((x) => x > now - 15 * MIN);
  if (burst.length >= 40) return { capUntil: burst[0] + 15 * MIN + rand(10000, 40000), burst: true };
  const since = now - s.bkInactiveDays * DAY;
  b.deepTimes.push(Date.now());
  const rp = await sendTab(job.tabId, { gx: "rposts", id: t.i, since }, 45000);
  if (rp && rp.uid && job.ownerId && rp.uid !== job.ownerId) return { wrong: true };
  // One profile that can't be read is skipped (and looked at again tomorrow). Three DIFFERENT profiles in a row mean X isn't
  // showing post lists right now: only then the quick rules (post total, latest-post date) decide, for 30 minutes.
  const unreadable = async (why) => {
    b.deepFailRun = (b.deepFailRun || 0) + 1;
    if (b.deepFailRun >= 3) {
      b.deepFailRun = 2;                                   // after the pause, the very next failure closes it again
      b.deepOffUntil = Date.now() + 30 * MIN;
      await pushEvent("warn", "Follow back: X isn't showing post lists right now, so for the next 30 minutes only the latest-post date and the post total are used to find inactive accounts.");
    }
    return { unreadable: true, why };
  };
  if (rp && !rp.ok && rp.kind === "auth" && rp.uid) return unreadable("posts hidden");     // signed in, but this profile's posts can't be read
  if (!rp || !rp.ok) {
    if (rp && rp.kind === "gone") return { gone: true };
    if (rp && (rp.kind === "endpoint" || rp.kind === "transient")) {
      t.rf = (t.rf || 0) + 1;
      if (t.rf < 2) return { retry: true };                // one more try for the same profile
      return unreadable("X didn't show them");
    }
    return { fail: rp || { kind: "transient", message: "no answer" } };
  }
  b.pcChecked = (b.pcChecked || 0) + 1;
  // An empty read for an account whose profile showed a recent post is "unknown", never "inactive".
  if (!rp.seen && t.lt && t.lt >= since) return unreadable("X showed no posts");
  b.deepFailRun = 0;
  return { count: rp.count };
}

async function followBackStep(job, s, now) {
  job.mode = "followback";
  if (job.nextAt && now < job.nextAt) return park(job, s, job.nextAt, true);
  const b = await getBk(job.ownerId);
  const READ = { noun: "list read", since: "bSince" }, PREAD = { noun: "profile read", since: "bSince" };
  const jf = (p) => (p ? rand(1 - p / 100, 1 + p / 100) : 1);

  // Fresh list: when it was built on an earlier day (new followers come first again), when you changed the order,
  // or (everyone followed back) every 2 hours. Anything looked up on an earlier day is looked up again.
  if (b.stage === "ready" || b.stage === "done") {
    const dayOld = b.builtAt && dayKey(b.builtAt) !== dayKey(now) && now - b.builtAt > 6 * HOUR;
    const orderChanged = b.order && b.order !== s.bkOrder;
    const doneAgain = b.stage === "done" && now - (b.builtAt || 0) > 2 * HOUR;
    if (dayOld || orderChanged || doneAgain) {
      Object.assign(b, { stage: "friends", cursor: null, friends: [], followers: [], list: [], rank: [], pos: 0, batch: [] });
      await save({ [K.bk]: b });
    }
  }

  // A. read the two lists from X
  if (b.stage === "friends" || b.stage === "followers") {
    const isF = b.stage === "friends";
    job.message = isF
      ? `Follow back: reading the accounts you follow (${b.friends.length.toLocaleString()} so far)...`
      : `Follow back: reading your followers (${b.followers.length.toLocaleString()} so far)...`;
    if (!await commitJob(job) || !ACTIVE.has(job.status)) return;
    const r = await sendTab(job.tabId, { gx: isF ? "frids" : "fids", cursor: b.cursor, userId: job.ownerId }, 60000);
    if (r && r.uid && job.ownerId && r.uid !== job.ownerId) { await haltFor(job, "account"); return park(job, s, Infinity, false); }
    if (isRate(r)) return readRate(job, s, Date.now(), r, `Follow back: reading ${isF ? "who you follow" : "your followers"} (${(isF ? b.friends : b.followers).length.toLocaleString()} so far)`);
    if (!r || !r.ok) return actFail(job, s, Date.now(), r, "", READ);
    readOk(job);
    if (isF) b.friends.push(...r.ids); else b.followers.push(...r.ids);
    b.cursor = r.end ? null : r.cursor;
    if (!b.cursor) {
      if (isF) b.stage = "followers";
      else {
        const first = !b.builtAt;
        const n = await bkBuild(job, s, b);
        if (first || n) await pushEvent("run", `Follow back: ${n.toLocaleString()} of your ${b.fcount.toLocaleString()} followers are waiting for a follow back from you. ${s.bkOrder === "old" ? "Oldest" : "Newest"} followers first, ${s.bkDaily}/day.`);
      }
    }
    await save({ [K.bk]: b });
    job.nextAt = Date.now() + rand(4000, 9000);
    return park(job, s, job.nextAt, false);
  }

  // B. nobody left on the list: look again for new followers in a while
  if (b.pos >= b.list.length && !(b.batch || []).length) {
    if (b.stage !== "done") {
      b.stage = "done"; b.doneAt = now;
      // Say it once - and again only when something new was followed back since (the list is re-read every 2 hours, that must not repeat the same news).
      const news = b.announced == null || (b.followed || 0) !== b.announced;
      if (news) b.announced = b.followed || 0;
      await save({ [K.bk]: b });
      if (news) {
        const msg = `Follow back: everyone on the list is handled (${b.followed.toLocaleString()} followed back${b.skipped ? ", " + b.skipped.toLocaleString() + " skipped" : ""}). GrowX looks for new followers by itself.`;
        await pushEvent("run", msg);
        if (b.followed) await notify("milestone", "Follow back list finished", msg);
      }
    }
    const until = Math.max(now + 10 * MIN, (b.builtAt || now) + 2 * HOUR + rand(30000, 180000));
    rest(job, "empty", until, `Follow back: nobody${s.bkVerifiedOnly ? " verified" : ""} is waiting for a follow back right now. Looking for new followers at ${clock(until)}.`);
    logLine(job, "", "wait", "nobody left to follow back");
    return park(job, s, job.restUntil, true);
  }

  // C. limits - your Follow back number, and X's follow limit that Follow mode shares
  const meta = await load(K.meta, {});
  let L = GX.effectiveLimits(s, meta, activeThrottle(job, s), now);
  const ledger = await getLedger();
  const limitCheck = async (at) => {
    const bt = await bkToday(at);
    if (bt >= s.bkDaily) return { own: true, why: `Follow back target of ${s.bkDaily} reached today.`, freeAt: startOfToday(at) + DAY + rand(30000, 180000) };
    const all = dayEntries(await getLedger(), s, at);
    if (all.length >= L.daily) return { own: false, why: `X's safe follow limit of ${L.daily} a day is used up (Follow and Follow back share it${bt ? "; " + bt + " were follow-backs" : ""}).`, freeAt: dayFreeAt(all, s, L.daily, at) };
    return null;
  };
  // Your own number (calendar day) stops the run for the day; X's shared limit does too - unless it is a rolling 24-hour count with auto-start.
  const stopNow = (lim) => s.onDailyCap === "stop" && (lim.own || stopForDay(s));
  const dayLimit = async (lim) => {
    // Follow back has nothing left to do today: with automatic switching on, the next mode takes over after a transition break.
    if (await beginSwitch(job, s, Date.now(), "followback", lim.why)) return park(job, s, job.restUntil, true);
    if (stopNow(lim)) {
      await notify("milestone", "GrowX finished for today", `${lim.why} It starts again ${s.autoStart ? "by itself tomorrow" : "when you press Start tomorrow"}.`);
      return finishJob(job, "done", `${lim.why} Stopped for today, as you set.${nextStartText(s)}`);
    }
    rest(job, "daily", lim.freeAt, `${lim.why} Continues automatically at ${clock(lim.freeAt)}.`);
    logLine(job, "", "wait", "daily limit");
    return park(job, s, job.restUntil, true);
  };
  const lim0 = await limitCheck(now);
  if (lim0) return dayLimit(lim0);
  // Its turn is done: hand over to the next mode (the day's number has not been reached, so it comes back round).
  if (await turnOver(job, s, now, "followback", L.daily)) return park(job, s, job.restUntil, true);
  const bl1 = (await load(K.bledger, [])).filter((x) => x > now - HOUR).sort((x, y) => x - y);
  const bkCap = s.hourlyAuto ? L.hourly : s.bkHourlyLimit;       // Auto: the same worked-out number for Follow back's own count and X's shared one
  if (bl1.length >= bkCap) {
    const freeAt = bl1[bl1.length - bkCap] + HOUR + rand(20000, 90000);
    rest(job, "hourly", freeAt, `Hourly pace of ${bkCap} follow-backs reached${s.hourlyAuto ? " (worked out for you)" : ""}. Back at ${clock(freeAt)}.`);
    return park(job, s, job.restUntil, true);
  }
  const inHour = ledger.filter((t) => t > now - HOUR);
  if (inHour.length >= L.hourly) {
    const freeAt = inHour[inHour.length - L.hourly] + HOUR + rand(20000, 120000);
    rest(job, "hourly", freeAt, `Hourly pace of ${L.hourly} follows reached (Follow and Follow back share it). Back at ${clock(freeAt)}.`);
    return park(job, s, job.restUntil, true);
  }
  const acc = await load(K.account, null);
  const cap = GX.followingCap(s, acc);
  if (cap && acc && typeof acc.following === "number" && acc.following >= cap - 5) {
    rest(job, "cap", now + 30 * 60000, `You follow ${acc.following.toLocaleString()} accounts - X's following cap is about ${cap.toLocaleString()}. Clear non-followers with Unfollow mode; GrowX checks again every 30 min.`);
    job.nextAcctAt = Math.min(job.nextAcctAt || Infinity, now + 25 * 60000);
    if (!job.capNotified) { job.capNotified = true; await notify("cap", "Following cap reached", "Switch to Unfollow mode to remove non-followers, then Follow back continues."); await pushEvent("warn", job.message); }
    return park(job, s, job.restUntil, true);
  }
  job.capNotified = false;

  // D. break after N follow-backs - Follow back's OWN break settings: a random count between
  //    bkRestEveryMin and bkRestEvery, then a random length between bkRestMinutes and bkRestMinutesMax.
  const newRestAfter = () => { const n = restAfter(s, "followback"); return Number.isFinite(n) ? n : 0; };
  const bBase = restKey(s, "followback");
  if (job.bRestBase !== bBase || job.bRestAfter == null) { job.bRestBase = bBase; job.bRestAfter = newRestAfter(); }
  if (s.bkRestEvery) job.bSince = Math.max(job.bSince || 0, ledgerRun(await getLedger(), now, s.bkRestMinutes * 60000));
  if (job.bRestAfter && (job.bSince || 0) >= job.bRestAfter) {
    const ms = GX.breakMs(s, "followback");
    rest(job, "cooldown", now + ms, `Break after ${job.bSince} follow-backs (${breakText(s, "followback", ms)}). Back at ${clock(now + ms)}.`);
    job.bSince = 0; job.bRestAfter = newRestAfter();
    logLine(job, "", "wait", `break ${Math.round(ms / 60000)} min`);
    return park(job, s, job.restUntil, true);
  }

  // E. next 100 from the list, looked up right now
  if (!(b.batch || []).length) {
    job.message = `Follow back: checking the next ${Math.min(100, b.list.length - b.pos)} followers before following...`;
    if (!await commitJob(job) || !ACTIVE.has(job.status)) return;
    const nb = await bkNextBatch(job, s, b, now);
    if (nb.wrongAccount) { await haltFor(job, "account"); return park(job, s, Infinity, false); }
    if (nb.fail) return actFail(job, s, Date.now(), nb.fail, "", READ);
    readOk(job);
    await save({ [K.bk]: b });
    job.nextAt = Date.now() + rand(3000, 7000);
    return park(job, s, job.nextAt, false);
  }

  // F. follow back one account
  const t = b.batch[0];
  // A skipped account: out of the batch, counted by reason, remembered for a few days so it isn't looked up again and again.
  const skipOne = async (why, remember, days, detail, pauseMs) => {
    b.batch.shift();
    b.skipped++; b.skips[why] = (b.skips[why] || 0) + 1;
    if (remember) b.skip[t.i] = Date.now() - (14 - (days || 14)) * DAY;
    logLine(job, t.h, "skip", detail || why, "bk");
    job.nextAt = Date.now() + (pauseMs || rand(1500, 4000));
    job.message = `@${t.h} skipped - ${detail || why}`;
    await save({ [K.bk]: b });
    return park(job, s, job.nextAt, true);
  };
  // The Never follow list and your skip settings are checked again right now (they may have changed since the lookup).
  const skipWhy = bkWhy(t, s, await freshBlacklist(), Date.now());
  if (skipWhy) return skipOne(skipWhy[0], skipWhy[1], skipWhy[2], skipWhy[3]);
  // F2. Activity: how many posts in the last N days (only for accounts the quick rules above could not decide).
  if (s.bkSkipInactive && t.pc == null) {
    job.message = `Follow back: checking @${t.h}'s posts...`;
    if (!await commitJob(job) || !ACTIVE.has(job.status)) return;
    const a = await bkCountPosts(job, s, b, t, Date.now());
    now = Date.now();
    if (a.wrong) { await haltFor(job, "account"); return park(job, s, Infinity, false); }
    if (a.fail) return actFail(job, s, now, a.fail, t.h, PREAD);
    if (a.capUntil) {
      await save({ [K.bk]: b });
      rest(job, "hourly", a.capUntil, a.burst ? `Activity check: a short pause so X isn't asked for too many profiles at once. Back at ${clock(a.capUntil)}.` : `Activity check: up to 120 profiles are read an hour. Back at ${clock(a.capUntil)}.`);
      return park(job, s, job.restUntil, true);
    }
    if (a.retry) {
      await save({ [K.bk]: b });
      job.nextAt = now + rand(4000, 9000);
      job.message = `Follow back: @${t.h}'s posts couldn't be read right now. Trying again...`;
      return park(job, s, job.nextAt, false);
    }
    if (a.gone) return skipOne("account gone", true, 14, "account unavailable", rand(2000, 5000));
    // This one profile's posts can't be read: skipped, never guessed; looked at again tomorrow.
    if (a.unreadable) return skipOne(t.p ? "private - posts hidden" : "activity unknown", true, 1, `posts couldn't be checked (${a.why}) - looked at again tomorrow`, rand(3000, 7000));
    // (A read that worked says nothing about follows: the "failed N times in a row" streak is only cleared by a follow that worked.)
    if (a.count != null) {
      t.pc = a.count; t.pd = s.bkInactiveDays;
      if (a.count < s.bkMinPosts) return skipOne("inactive", true, 14, `inactive - ${a.count} post${a.count === 1 ? "" : "s"} in ${s.bkInactiveDays} days`, rand(3000, 7000));
    } else t.pc = -1;                                  // X isn't showing post lists at all right now (warning shown): the quick rules decide for a while
    await save({ [K.bk]: b });
    // Your rules or the Never follow list may have changed while the profile was being read (up to 45 s): check once more.
    const again = bkWhy(t, await getSettings(), await freshBlacklist(), Date.now());
    if (again) return skipOne(again[0], again[1], again[2], again[3]);
  }
  job.current = { i: t.i, h: t.h, n: t.n, a: t.a, tg: "bk", rk: t.rk || 0, rkOf: b.fcount || 0 };
  job.inFlight = { i: t.i, h: t.h, at: Date.now() };
  job.message = `Following back @${t.h}...`;
  if (!await commitJob(job) || !ACTIVE.has(job.status)) return;
  const r = await followOne(job, t);
  job.inFlight = null;
  now = Date.now();
  if (unsure(r)) job.bSince = (job.bSince || 0) + 1;
  if (r.uid && job.ownerId && r.uid !== job.ownerId) { await haltFor(job, "account"); return park(job, s, Infinity, false); }

  if (r.ok) {
    b.batch.shift();
    b.followed++;
    await save({ [K.bk]: b });          // first: if the worker is stopped right now, this person is never followed back twice
    job.bdone = (job.bdone || 0) + 1;
    job.turnDone = (job.turnDone || 0) + 1;
    job.bSince = (job.bSince || 0) + 1;
    await ladOk(job, s, now);                // X accepted it: after a few in a row earlier refusals are forgotten
    if (job.throttle && job.throttle.limitProbe) { job.throttle = null; L = GX.effectiveLimits(s, meta, activeThrottle(job, s), now); }   // (a temporary cap from before v2.7.0)
    if (r.pending) job.pending = (job.pending || 0) + 1;
    await pushLedger();            // X's follow limit counts every follow, whichever mode made it
    await pushBledger();
    if (acc && typeof acc.following === "number" && !r.pending) { acc.following++; await save({ [K.account]: acc }); }
    await bumpStats({ followedBack: 1 });
    if (s.verifyFollows && t.i && !r.pending) { job.verify = job.verify || { ids: [] }; job.verify.ids.push(t.i); }
    const h = r.h || t.h || t.i;
    logLine(job, h, "ok", r.pending ? "follow request sent" : "followed back", "bk");
    job.log[0].w = `follows you · follower #${(t.rk || 0).toLocaleString()} of ${(b.fcount || 0).toLocaleString()}${t.v ? " · verified" : ""}${typeof t.pc === "number" && t.pc >= 0 ? ` · ${t.pc} post${t.pc === 1 ? "" : "s"} in ${t.pd || s.bkInactiveDays} days` : ""}`;
    if (t.rk) { job.log[0].rk = t.rk; job.log[0].rkOf = b.fcount || 0; }
    const bl = await load(K.bklog, []);
    const arr = Array.isArray(bl) ? bl : [];
    arr.unshift({ i: t.i, h, n: t.n || "", a: t.a || "", t: now, o: job.ownerId, rk: t.rk || 0, rkOf: b.fcount || 0, fc: t.fc == null ? null : t.fc, p: r.pending ? 1 : 0, v: t.v ? 1 : 0, pc: typeof t.pc === "number" && t.pc >= 0 ? t.pc : null, pd: typeof t.pc === "number" && t.pc >= 0 ? (t.pd || s.bkInactiveDays) : null });
    if (arr.length > 5000) arr.length = 5000;
    await save({ [K.bklog]: arr });
    await actLog({ mode: "followback", act: r.pending ? "request" : "followback", h, i: t.i, why: "follows you" });
    let delay = rand(s.bkMinDelay, s.bkMaxDelay) * L.slow;
    if (Math.random() * 100 < s.bkLongPause) delay *= rand(2, 4.5);
    job.nextAt = now + delay * 1000;
    job.lastFollowBack = { h, n: t.n || "", a: t.a || "", at: now };
    const left = Math.max(0, b.list.length - b.pos + b.batch.length);
    job.message = `Followed back @${h}. Next in ${Math.round(delay)}s${job.bRestAfter ? ` · ${job.bSince} of ${job.bRestAfter} before the break` : ""} · ${await bkToday(now)}/${s.bkDaily} today · ${left.toLocaleString()} waiting.`;
    await save({ [K.bk]: b });
    if (job.bdone % 100 === 0) await notify("milestone", "GrowX milestone", `${job.bdone.toLocaleString()} follow-backs this run.`);
    // Strict daily number: stop right after the follow-back that reaches it (no waiting for the next step).
    const lim = await limitCheck(now);
    if (lim && stopNow(lim)) { await flushSeen(false); return dayLimit(lim); }
    if (await turnOver(job, s, now, "followback", L.daily)) { await flushSeen(false); return park(job, s, job.restUntil, true); }
  } else if (r.kind === "gone") {
    b.batch.shift();
    b.skipped++; b.skips["account gone"] = (b.skips["account gone"] || 0) + 1; b.skip[t.i] = now;
    logLine(job, t.h, "skip", r.message || "unavailable", "bk");
    job.nextAt = now + rand(2000, 5000);
    job.message = `@${t.h} skipped - ${r.message || "unavailable"}`;
    await save({ [K.bk]: b });
  } else if (["automation", "auth", "locked", "suspended", "challenge", "captcha"].includes(r.kind)) {
    logLine(job, t.h, "fail", r.kind, "bk");
    await haltFor(job, r.kind === "challenge" || r.kind === "captcha" ? "locked" : r.kind, r.message, r.waitMs);
  } else {
    // X said no ("unable to follow more people"), slowed us down, or this follow failed: the X-refused plan
    // (break -> longer break -> stop for today). Three failures on the same account (not X refusing in general): skip it.
    if (r.kind !== "rate" && r.kind !== "limit" && !r.noAnswer) {
      // This one account failed: the others go first; a second failure skips it (looked at again tomorrow), so one bad
      // account can never stop the whole day.
      t.tf = (t.tf || 0) + 1;
      if (t.tf >= 2) {
        b.batch.shift();
        job.failed++;
        b.skipped++; b.skips["follow failed"] = (b.skips["follow failed"] || 0) + 1;
        b.skip[t.i] = Date.now() - 13 * DAY;              // remembered for one day
        logLine(job, t.h, "fail", r.message || "failed", "bk");
      } else if (b.batch.length > 1) b.batch.push(b.batch.shift());
    }
    await save({ [K.bk]: b });
    const out = await refuseOutcome(job, s, now, r, { mode: "followback", noun: "follow-back", since: "bSince", label: t.h, read: false });
    if (out === "stop") return;
  }

  await save({ [K.bk]: b });
  await flushSeen(false);
  if (job.status === "halted") return park(job, s, Infinity, false);
  return park(job, s, job.status === "resting" ? job.restUntil : job.nextAt, job.status === "running" || READS_OK_WHILE.has(job.restReason));
}

async function jobStep(job) {
  let now = Date.now();
  let s = await getSettings();

  // Manual triggers from the dashboard.
  const ctl = await load(K.ctl, null);
  if (ctl) {
    if (ctl.harvest) { job.sweep = newSweep(await getSources()); job.sweepWait = 0; }
    if (ctl.fb) { job.relForce = { since: Date.now() }; job.relUntil = 0; job.relErrors = 0; if (!job.fb) job.nextFbAt = 0; }
    if (ctl.unfReset) { await chrome.storage.local.remove(K.unf); await pushEvent("run", "Unfollow: your following list will be read again from X."); }
    // "Nobody is waiting" is not a safety break: a new list or new rules may bring people back, so look again right away.
    const wakeEmpty = () => { if (job.status === "resting" && job.restReason === "empty" && s.runMode === "followback") job.restUntil = now; };
    if (ctl.bkReset) { await chrome.storage.local.remove(K.bk); await pushEvent("run", "Follow back: your follower list will be read again from X."); wakeEmpty(); }
    else if (ctl.bkRules) { await bkForgetSkips(); wakeEmpty(); }
    await chrome.storage.local.remove(K.ctl);
  }

  // You picked another mode (while this run was going, or while it was paused): the run follows your choice.
  // Waits that belong to the old mode end now; X's own safety breaks are kept.
  const wasMode = jobMode(job);
  if (s.runMode !== wasMode) {
    const to = s.runMode;
    job.runMode = to; job.mode = to;
    // You chose yourself, so a transition break that was waiting to switch somewhere else is dropped.
    if (job.trans) { job.trans = null; await pushEvent("run", "Mode switching: you picked a mode yourself, so the transition break was dropped."); }
    const SOFT = ["daily", "hourly", "cooldown", "empty", "cap", "schedule", "switch"];
    if ((job.status === "resting" || job.status === "sleeping") && (!job.restReason || SOFT.includes(job.restReason))) job.restUntil = now;
    // An X-refused break belongs to its family (Follow + Follow back share X's follow limit, Unfollow has its own plan):
    // moving to the other family ends it here - it is still waiting for you in the old family (see ladWait).
    if (ladFam(to) !== ladFam(wasMode)) {
      if (job.status === "resting" && ["limit", "rate", "failure"].includes(job.restReason)) job.restUntil = now;
      job.lad = null; job.ladAfter = false;
    }
    job.nextAt = now;
    if (wasMode === "unfollow" || to === "unfollow") job.dayStart = now;      // Follow and Follow back share one working day
    job.sinceRest = 0; job.restAfter = 0; job.uSince = 0; job.uRestAfter = null; job.bSince = 0; job.bRestAfter = null;
    job.cmtSince = 0; job.cmtRestAfter = 0;
    job.turnDone = 0;
    job.current = null; job.inFlight = null;
    if (to !== "follow") { job.harvesting = false; job.sweep = null; }
    job.message = `Switched to ${MODE_NAME[to]} mode.`;
    await pushEvent("run", job.message);
  }

  if (s.autoStart) {
    const dk = new Date(now).toDateString();
    if (job.dayKey !== dk) { job.dayKey = dk; job.dayBase = job.done || 0; job.dayStart = now; }
  }

  // Working-day clock for the maximum run time: starts at the first tick, restarts after a night's sleep or a new day.
  if (!job.dayStart) job.dayStart = job.startedAt || now;
  if (job.status === "sleeping" && job.restReason === "schedule" && GX.inWindow(s, now) && job.restUntil <= now) job.dayStart = now;
  if (s.runMode !== "unfollow" && s.runMode !== "comment" && s.maxRunHours > 0 && now - job.dayStart >= s.maxRunHours * HOUR) {
    const fb = s.runMode === "followback";
    return finishJob(job, "done", `Maximum run time of ${s.maxRunHours} h reached after ${plural(fb ? (job.bdone || 0) : runDone(job, s), fb ? "follow-back" : "follow")}. Stopped for safety, as you set.${nextStartText(s)}`);
  }

  // 1. rests
  if (job.status === "resting" || job.status === "sleeping") {
    if (job.restUntil && now < job.restUntil) {
      const mode = readsMode(job);
      if (mode) {
        const got = await acquireTab(job.tabId, { create: false, ownTab: job.ownTab });
        if (got) {
          if (got.tabId !== job.tabId) { job.tabId = got.tabId; job.ownTab = got.created; await protectTab(job.tabId, true); }
          const m = await maintenance(job, s, now, mode);
          if (m) {
            if (await applyStepResult(job, s, m) && job.status === "halted") return park(job, s, Infinity, false);
            return park(job, s, job.status === "resting" || job.status === "sleeping" ? job.restUntil : Date.now(), readsMode(job) || (job.status === "running"));
          }
        } else {
          // No X tab right now: nothing to read, just sleep until the rest ends.
          return park(job, s, job.restUntil, false);
        }
      }
      return park(job, s, job.restUntil, mode);
    }
    // Waiting for new people (empty list) is not working time: it must not eat into the maximum run time.
    if (job.restReason === "empty" && job.restFrom) job.dayStart = (job.dayStart || now) + Math.max(0, Math.min(now, job.restUntil || now) - job.restFrom);
    const wasSwitch = job.restReason === "switch";
    job.status = "running";
    job.restReason = null;
    job.restUntil = null;
    job.message = "Back to work.";
    // The transition break is over: NOW the next mode is switched on - never before, and never from any other break.
    if (wasSwitch && job.trans) {
      const ns = await applySwitch(job, now);
      if (ns) { s = ns; if (!await commitJob(job) || !ACTIVE.has(job.status)) return; return park(job, s, now + 1500, true); }
      job.message = "Transition break finished.";
    } else if (job.trans) job.trans = null;          // a leftover plan from a run that was stopped: never switch on it
  }

  // X refused follows twice today: Follow and Follow back stay off until tomorrow, Unfollow keeps working.
  // This also covers switching to a following mode (or resuming one) on such a day.
  if (s.runMode !== "unfollow" && s.runMode !== "comment" && xLimitedToday(await load(K.meta, {}), job, now)) {
    const at = startOfToday(now) + DAY + rand(60000, 240000);
    rest(job, "daily", at, `X limited following on your account today, so ${MODE_NAME[s.runMode]} stays off until tomorrow (${clock(at)}). Switch to Unfollow mode to keep working today.`);
    logLine(job, "", "wait", "X limited follows - off for today");
    return park(job, s, job.restUntil, false);
  }

  // X kept refusing unfollows today: Unfollow stays off until tomorrow, Follow and Follow back keep working.
  if (s.runMode === "unfollow" && uLimitedToday(await load(K.meta, {}), job, now)) {
    const at = startOfToday(now) + DAY + rand(60000, 240000);
    rest(job, "daily", at, `X kept refusing unfollows today, so Unfollow stays off until tomorrow (${clock(at)}). Switch to Follow or Follow back to keep working today.`);
    logLine(job, "", "wait", "X refused unfollows - off for today");
    return park(job, s, job.restUntil, false);
  }

  // The X-refused plan: a break that is still running (the run was stopped and started again, auto-start began a new one,
  // or another mode with the same limit took over) is kept - starting again never skips it.
  {
    const w = await ladWait(ladFam(s.runMode), now);
    if (w) {
      rest(job, w.why === "limit" ? "limit" : w.why === "rate" ? "rate" : "failure", w.until,
        `X refused earlier, so the break is still running. Back at ${clock(w.until)}.`);
      logLine(job, "", "wait", `X-refused break until ${clock(w.until)}`);
      job.ladAfter = true;
      return park(job, s, job.restUntil, w.why === "limit" ? "rel" : false);
    }
  }

  // 2. active hours
  if (s.activeHours && !GX.inWindow(s, now)) {
    job.status = "sleeping";
    job.restReason = "schedule";
    job.restUntil = GX.nextWindowStart(s, now);
    job.message = `Outside your active hours. Continues at ${new Date(job.restUntil).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}.`;
    logLine(job, "", "wait", "sleeping until active hours");
    return park(job, s, job.restUntil, "rel");
  }

  // 3. targets - the turn target hands over to the next mode, the run target ends the day
  if (s.runMode === "follow") {
    if (await turnOver(job, s, now, "follow")) return park(job, s, job.restUntil, true);
    // With a sequence running, "Run target" IS the turn target above, so it must not also stop the day here.
    if (!GX.cycling(s) && s.sessionTarget > 0 && runDone(job, s) >= s.sessionTarget) {
      const msg = `Target reached: ${plural(runDone(job, s), "follow")} ${s.autoStart ? "today" : "this run"}.`;
      if (await beginSwitch(job, s, now, "follow", msg)) return park(job, s, job.restUntil, true);
      return finishJob(job, "done", `${msg} Stopped, as you set.${nextStartText(s)}`);
    }
  }

  // 4. an X tab to work in
  const got = await acquireTab(job.tabId, { create: true, ownTab: job.ownTab });
  if (!got) {
    job.tabWaits = (job.tabWaits || 0) + 1;
    if (job.tabWaits > 20) return park(Object.assign(job, { status: "halted", haltKind: "tab", message: "Couldn't reach x.com." }), s, Infinity, false);
    job.message = "Waiting for an X tab...";
    job.nextAt = now + 15000;
    return park(job, s, job.nextAt, false);
  }
  job.tabWaits = 0;
  if (got.tabId !== job.tabId) { job.tabId = got.tabId; job.ownTab = got.created; await protectTab(job.tabId, true); }

  // 5. background reads, during the wait between follows
  const m = await maintenance(job, s, now);
  if (m) {
    if (await applyStepResult(job, s, m) && job.status === "halted") return park(job, s, Infinity, false);
    return park(job, s, job.status === "resting" ? job.restUntil : Math.max(Date.now(), job.nextAt || 0), job.status === "running" || READS_OK_WHILE.has(job.restReason));
  }
  now = Date.now();
  // 5b. Unfollow / Follow back: the mode you chose (one mode at a time)
  if (s.runMode === "unfollow") return unfollowStep(job, s, now);
  if (s.runMode === "followback") return followBackStep(job, s, now);
  if (s.runMode === "comment") return commentStep(job, s, now);
  if (job.mode !== "follow") { job.mode = "follow"; job.runMode = "follow"; job.current = null; job.dayStart = now; job.nextAt = Math.min(job.nextAt || 0, now + 3000); }
  if (job.nextAt && now < job.nextAt) return park(job, s, job.nextAt, true);

  // 6. limits
  const meta = await load(K.meta, {});
  const L = GX.effectiveLimits(s, meta, activeThrottle(job, s), now);
  const ledger = await getLedger();
  const todayList = dayEntries(ledger, s, now);
  if (todayList.length >= L.daily) {
    const freeAt = dayFreeAt(todayList, s, L.daily, now);
    const th = activeThrottle(job, s);
    const bt = await bkToday(now);       // Follow and Follow back share X's limit: say so when follow-backs used part of it
    const why = (th && th.dailyCap && th.dailyCap === L.daily && L.daily < s.dailyLimit ? ` (lowered from ${s.dailyLimit} for now because X refused a follow; it goes back up as soon as X accepts one)` : "")
      + (bt ? ` (${bt} of them follow-back${bt === 1 ? "" : "s"}: Follow and Follow back share X's limit)` : "");
    // Follow is done for today either way: with automatic switching on, the next mode takes over after a transition break.
    if (await beginSwitch(job, s, now, "follow", `Daily limit of ${L.daily} follows reached${why}.`)) return park(job, s, job.restUntil, true);
    if (stopForDay(s)) {
      await notify("milestone", "GrowX finished for today", `Daily limit of ${L.daily} reached. You can start again ${s.dailyWindow === "rolling" ? "after " + clock(freeAt) : "tomorrow, after midnight"}${s.autoStart ? " (auto-start is on)" : ""}.`);
      return finishJob(job, "done", `Daily limit of ${L.daily} follows reached${why}. Stopped, as you set. ${s.dailyWindow === "rolling" ? "The 24-hour count frees up at " + clock(freeAt) + " - press Start after that." : s.autoStart ? nextStartText(s).trim() : "A new day starts at midnight - press Start then."}`);
    }
    rest(job, "daily", freeAt, `Daily limit of ${L.daily} follows reached${why}. Continues automatically at ${clock(freeAt)}.`);
    logLine(job, "", "wait", "daily limit");
    return park(job, s, job.restUntil, true);
  }
  const inHour = ledger.filter((t) => t > now - HOUR);
  if (inHour.length >= L.hourly) {
    const freeAt = inHour[inHour.length - L.hourly] + HOUR + rand(20000, 120000);
    rest(job, "hourly", freeAt, `Hourly pace of ${L.hourly} reached. Back at ${clock(freeAt)}.`);
    return park(job, s, job.restUntil, true);
  }
  const acc = await load(K.account, null);
  const cap = GX.followingCap(s, acc);
  if (cap && acc && typeof acc.following === "number" && acc.following >= cap - 5) {
    rest(job, "cap", now + 30 * 60000, `You follow ${acc.following.toLocaleString()} accounts - X's following cap is about ${cap.toLocaleString()}. Switch to Unfollow mode to clear out non-followers; GrowX checks again every 30 min.`);
    job.nextAcctAt = Math.min(job.nextAcctAt || Infinity, now + 25 * 60000);
    if (!job.capNotified) { job.capNotified = true; await notify("cap", "Following cap reached", "Switch to Unfollow mode to remove non-followers, and GrowX will continue."); await pushEvent("warn", job.message); }
    return park(job, s, job.restUntil, true);
  }
  job.capNotified = false;
  // Break rules: the main one (every N follows -> M minutes) plus any extra
  // rules. If several are due together, the longest break wins and all the
  // rules that were due start counting again.
  const rBase = restKey(s, "follow");
  if (job.restBase !== rBase || !job.restAfter) { job.restBase = rBase; job.restAfter = restAfter(s, "follow"); }  // picked up if you change it mid-run
  // The shortest break of the range is the gap that counts as a real break.
  if (s.restEvery) job.sinceRest = Math.max(job.sinceRest || 0, ledgerRun(await getLedger(), now, s.restMinutes * 60000));
  job.sinceExtra = job.sinceExtra || [];
  const dueRules = [];
  // Each rule draws its own length inside its own range, so "the longest break wins" compares real lengths.
  if (job.sinceRest >= (job.restAfter || Infinity)) dueRules.push({ main: true, ms: GX.breakMs(s, "follow"), n: job.sinceRest });
  (s.extraBreaks || []).forEach((b, i) => { if ((job.sinceExtra[i] || 0) >= b.every) dueRules.push({ i, ms: GX.extraBreakMs(b), n: job.sinceExtra[i] }); });
  if (dueRules.length) {
    const pick = dueRules.reduce((a, b) => (b.ms > a.ms ? b : a));
    const ms = pick.ms;                                               // a random time inside the range of the rule that won
    rest(job, "cooldown", now + ms, `Break after ${pick.n} follows (${pick.main ? breakText(s, "follow", ms) : Math.round(ms / 60000) + " min"}). Back at ${clock(now + ms)}.`);
    for (const d of dueRules) { if (d.main) { job.sinceRest = 0; job.restAfter = restAfter(s, "follow"); } else job.sinceExtra[d.i] = 0; }
    logLine(job, "", "wait", `break ${Math.round(ms / 60000)} min`);
    return park(job, s, job.restUntil, true);
  }

  // 7. next candidate (v3.2: once an hour, sources that keep doing badly are paused - see srcAutoPauseCheck)
  if (now - (mem.srcApAt || 0) > HOUR) { mem.srcApAt = now; try { await srcAutoPauseCheck(s); } catch (_) {} }
  const pool = await prunePool(s, now);
  if (!pool.length) {
    if (!job.readUntil || now >= job.readUntil) {
      const h = await harvestStep(job, s);
      if (h.called) {
        if (await applyStepResult(job, s, h) && job.status === "halted") return park(job, s, Infinity, false);
        return park(job, s, Date.now() + 1500, true);
      }
    }
    const sources = await getSources();
    const usableSrc = sources.some((x) => x.enabled && !["gone", "private", "error"].includes(x.status));
    let until = Math.min(nextSourceTime(sources, s, now), now + 3 * HOUR);
    if (job.readUntil && job.readUntil > now) until = Math.max(until, job.readUntil);
    if (!usableSrc || until === Infinity) until = now + 30 * 60000;
    rest(job, "empty", until, usableSrc
      ? `Queue is empty - waiting for new followers on your sources. Next check ${clock(until)}.`
      : "Queue is empty and no source can be read. Add more source profiles to keep growing.");
    if (!usableSrc && !job.emptyNotified) { job.emptyNotified = true; await notify("empty", "GrowX needs more sources", "Add a few popular profiles in your niche on the Sources page."); }
    return park(job, s, job.restUntil, true);
  }
  job.emptyNotified = false;
  let t = pickCandidate(pool, s, now);
  // 7b. v3.2 a fresh look at the front of the queue right before following: one lookup for up to 100 people.
  // Anyone who meanwhile went quiet, got stuck at X's following limit, followed you already or no longer
  // passes your rules comes off the queue, and the rest are scored again with today's numbers.
  if (s.preCheck && t && t.i && !t.rf && !t.manual && !(t.pc > now - 6 * HOUR)) {
    const pc = await preCheckQueue(job, s, pool, now);
    if (pc.wrongAccount) { await haltFor(job, "account"); return park(job, s, Infinity, false); }
    if (pc.rate) return readRate(job, s, Date.now(), pc.rate, "Checking the next people before following");
    if (pc.removed) logLine(job, "", "skip", `fresh look: ${pc.removed} dropped from the queue (${Object.entries(pc.reasons).map(([k, v]) => `${v} ${k}`).join(", ")})`);
    if (!pool.length) return park(job, s, Date.now() + 1500, true);
    t = pickCandidate(pool, s, Date.now());
  }
  job.current = { i: t.i, h: t.h, n: t.n, a: t.a, score: t.score, src: t.src };
  job.inFlight = { i: t.i, h: t.h, at: Date.now() };
  job.message = `Following @${t.h}...`;
  if (!await commitJob(job) || !ACTIVE.has(job.status)) return;

  // 8. follow (v3.2: optionally like one of their recent posts first - one more notification from you)
  if (s.likeBeforeFollow && t.i && !t.rf) await likeFirst(job, t);
  let r = await followOne(job, t);
  job.inFlight = null;
  now = Date.now();
  if (unsure(r)) job.sinceRest = (job.sinceRest || 0) + 1;

  if (r.uid && job.ownerId && r.uid !== job.ownerId) {
    await haltFor(job, "account");
    return park(job, s, Infinity, false);
  }

  const removeCandidate = async () => {
    const i = pool.findIndex((c) => c === t || (t.i && c.i === t.i) || (!t.i && c.h === t.h));
    if (i >= 0) pool.splice(i, 1);
    await savePool();
    if (t.i) { (await getSeen()).add(t.i); mem.seenDirty++; }
  };

  if (r.ok) {
    const id = t.i || r.id || null;
    job.done++;
    job.turnDone = (job.turnDone || 0) + 1;
    job.sinceRest++;
    job.sinceExtra = (s.extraBreaks || []).map((_, i) => ((job.sinceExtra && job.sinceExtra[i]) || 0) + 1);
    await ladOk(job, s, now);                // X accepted it: after a few in a row earlier refusals are forgotten
    if (job.throttle && job.throttle.limitProbe) job.throttle = null;       // (a temporary cap from before v2.7.0)
    if (r.pending) job.pending = (job.pending || 0) + 1;
    await pushLedger();
    const follows = await getFollows();
    const entry = { i: id, h: t.h, n: t.n || "", a: t.a || "", s: t.src || "", t: now, sc: t.score || 0, fc: t.fc, fr: t.fr, fb: 0, o: job.ownerId, k: 0, c: id ? now + FB_SCHEDULE[0] : 0 };
    if (r.pending) entry.p = 1;
    if (t.rf) { entry.rf = 1; entry.uk = 1; await unlogPatch({ [id || t.i]: { rf: now, rq: 0 } }); }   // followed again: never unfollowed again
    // Already following you before this follow: not a follow-back.
    if (t.fy || r.followedBy || (id && (await getKnown()).has(id))) { entry.fy0 = 1; entry.c = 0; }
    follows.push(entry);
    if (id) mem.fidx.set(id, entry);
    await saveFollows();
    await removeCandidate();
    const sources = await getSources();
    const src = t.src && sources.find((x) => String(x.h).toLowerCase() === String(t.src).toLowerCase());
    if (src) { src.followed = (src.followed || 0) + 1; await saveSources(); }
    if (acc && typeof acc.following === "number" && !r.pending) { acc.following++; await save({ [K.account]: acc }); }
    await bumpStats({ followed: 1 });
    if (s.verifyFollows && id && !r.pending) { job.verify = job.verify || { ids: [] }; job.verify.ids.push(id); }
    logLine(job, t.h, "ok", t.rf ? "followed again" : r.pending ? "follow request sent" : "followed");
    await actLog({ mode: "follow", act: r.pending ? "request" : "follow", h: t.h || "", i: t.i, why: t.rf ? "followed again (Unfollowed page)" : t.s ? "source: " + t.s : "", extra: t.tgt ? { target: t.tgt } : undefined });
    let delay = rand(s.minDelay, s.maxDelay) * L.slow;
    if (Math.random() * 100 < s.longPauseChance) delay *= rand(2, 4.5);
    job.nextAt = now + delay * 1000;
    job.lastFollow = { h: t.h, n: t.n, a: t.a, at: now };
    job.message = `Followed @${t.h}. Next in ${Math.round(delay)}s${s.restEvery && job.restAfter && job.restAfter !== Infinity ? ` · ${job.sinceRest} of ${job.restAfter} before the break` : ""}.`;
    if (job.done % 100 === 0) await notify("milestone", "GrowX milestone", `${job.done.toLocaleString()} accounts followed this run.`);
    // Strict target: stop right after the follow that reaches it (no waiting for the next tick).
    if (await turnOver(job, s, Date.now(), "follow", L.daily)) { await flushSeen(false); return park(job, s, job.restUntil, true); }
    if (!GX.cycling(s) && s.sessionTarget > 0 && runDone(job, s) >= s.sessionTarget) {
      await flushSeen(false);
      const msg = `Target reached: followed ${plural(runDone(job, s), "account")} ${s.autoStart ? "today" : "this run"}.`;
      // Stop following at once. With automatic switching on, a transition break starts and the next mode follows it.
      if (await beginSwitch(job, s, Date.now(), "follow", msg)) return park(job, s, job.restUntil, true);
      await finishJob(job, "done", `${msg} Stopped, as you set.${nextStartText(s)}`);
      await notify("milestone", "GrowX finished", `Target of ${runDone(job, s).toLocaleString()} follows reached. GrowX has stopped.${nextStartText(s)}`);
      return;
    }
  } else if (r.kind === "gone") {
    job.skipped++;
    job.targetFails = 0;
    await removeCandidate();
    logLine(job, t.h, "skip", r.message || "unavailable");
    job.nextAt = now + rand(2000, 5000);
    job.message = `@${t.h} skipped - ${r.message || "unavailable"}`;
  } else if (["automation", "auth", "locked", "suspended", "challenge", "captcha"].includes(r.kind)) {
    logLine(job, t.h, "fail", r.kind);
    await haltFor(job, r.kind === "challenge" || r.kind === "captcha" ? "locked" : r.kind, r.message, r.waitMs);
  } else {
    // X said no ("unable to follow more people"), slowed us down, or this follow failed: the X-refused plan
    // (break -> longer break -> stop for today). Three failures on the same account (not X refusing in general): skip it.
    if (r.kind !== "rate" && r.kind !== "limit" && !r.noAnswer) {
      // This one person failed: the others go first for 2 hours; a second failure drops them from the queue, so one bad
      // account can never stop the whole day.
      t.tf = (t.tf || 0) + 1;
      if (t.tf >= 2) {
        job.failed++;
        await removeCandidate();
        logLine(job, t.h, "fail", r.message || "failed");
      } else { t.later = now + 2 * HOUR; await savePool(); }
    }
    const out = await refuseOutcome(job, s, now, r, { mode: "follow", noun: "follow", since: "sinceRest", label: t.h, read: false });
    if (out === "stop") return;
  }

  const next = pickCandidate(pool, s, Date.now());
  job.current = next ? { i: next.i, h: next.h, n: next.n, a: next.a, score: next.score, src: next.src } : null;
  await flushSeen(false);
  if (job.status === "halted") return park(job, s, Infinity, false);
  return park(job, s, job.status === "resting" ? job.restUntil : job.nextAt, job.status === "running" || READS_OK_WHILE.has(job.restReason));
}

// v3.2 the fresh look before following (see step 7b).
async function preCheckQueue(job, s, pool, now) {
  const ordered = queueOrder(pool, s).filter((c) => c.i && !c.rf && !c.manual && !(c.pc > now - 6 * HOUR)).slice(0, 100);
  if (!ordered.length) return {};
  const ri = await sendTab(job.tabId, { gx: "uinfo", ids: ordered.map((c) => c.i) }, 45000);
  if (ri && ri.uid && job.ownerId && ri.uid !== job.ownerId) return { wrongAccount: true };
  if (isRate(ri)) return { rate: ri };
  if (!ri || !ri.ok) return {};
  const L = s.learnScore ? await learnData() : null;
  const sources = L ? await getSources() : [];
  const reasons = {};
  let removed = 0;
  const drop = (c, why) => { const i = pool.indexOf(c); if (i >= 0) { pool.splice(i, 1); removed++; reasons[why] = (reasons[why] || 0) + 1; } };
  for (const c of ordered) {
    const m = (ri.map || {})[c.i];
    if (!m) { drop(c, "gone"); continue; }
    for (const k of ["fc", "fr", "sc", "lt", "ca"]) if (m[k] != null) c[k] = m[k];
    c.p = !!m.p; c.d = !!m.d; if (m.v != null) c.v = !!m.v;
    c.fw = m.fw; c.fy = m.fy === true;
    c.pc = now;
    const why = GX.rejectReason(c, s, now);
    if (why) { drop(c, why); continue; }
    if (L) { c.lrn = learnAdjust(c, L); const src = c.src && sources.find((x) => String(x.h).toLowerCase() === String(c.src).toLowerCase()); c.srb = src ? srcBoost(src.h, L) : 0; }
    c.score = GX.scoreUser(c, s, now);
    c.qs = GX.qualityScore(c);
    if (c.score < s.minScore) drop(c, "low score");
  }
  delete ri.map;
  sortPool(pool);
  await savePool();
  return { removed, reasons };
}

// v3.2 like one recent post of theirs (not a repost, not a reply) and pause like a person before the follow.
// A failed like never stops the follow.
async function likeFirst(job, t) {
  try {
    const p = await sendTab(job.tabId, { gx: "cmtPosts", userId: t.i, count: 10 }, 30000);
    const post = p && p.ok && (p.posts || []).find((x) => x && x.id && !x.isRepost && !x.isReply && !x.liked);
    if (!post) return false;
    const lr = await sendTab(job.tabId, { gx: "cmtLike", id: post.id, owner: job.ownerId }, 30000);
    if (!lr || !lr.ok) return false;
    t.liked = 1;
    await bumpStats({ likedBeforeFollow: 1 });
    await sleep(rand(3500, 11000));
    return true;
  } catch (_) { return false; }
}

// One follow through X (used by Follow and by Follow back): the direct request first, the profile page as a fallback.
async function followOne(job, t) {
  let r = null;
  // Profile mode is a fallback: try the direct request again every hour.
  const tryApi = job.executor === "api" || Date.now() >= (job.apiRetryAt || 0);
  if (tryApi) {
    r = await sendTab(job.tabId, { gx: "follow", id: t.i, h: t.h, owner: job.ownerId }, 45000);
    if (r && !r.ok && r.kind === "endpoint") {
      if (job.executor === "api") {
        console.warn("[gx] direct follow rejected, switching to profile mode:", r.message);
        await save({ [K.health]: { at: Date.now(), note: "Direct follow rejected by X (" + (r.status || "?") + "). Using profile mode." } });
        await pushEvent("warn", "X rejected the direct follow request - switched to profile mode (slower, same result).");
      }
      job.executor = "profile";
      job.apiRetryAt = Date.now() + HOUR;
    } else if (job.executor === "profile" && r && (r.ok || ["gone", "rate", "limit", "automation", "auth", "locked", "suspended"].includes(r.kind))) {
      job.executor = "api";
      if (job.workerTabId != null) { try { await chrome.tabs.remove(job.workerTabId); } catch (_) {} job.workerTabId = null; }
      await pushEvent("run", "Direct follow requests work again - left profile mode.");
    }
  }
  if (job.executor === "profile" && (!r || (!r.ok && r.kind === "endpoint"))) {
    r = await profileExec(job, t);
    if (r && !r.ok && r.kind === "endpoint") r.kind = "transient";
  }
  return r || { ok: false, kind: "transient", message: "no result" };
}

// Fallback executor: press Follow on the profile, in a dedicated background tab.
async function profileExec(job, t) {
  if (!t.h) return { ok: false, kind: "transient", message: "no handle" };
  const url = "https://x.com/" + encodeURIComponent(t.h);
  const match = (u) => { try { return new URL(u).pathname.split("/")[1].toLowerCase() === t.h.toLowerCase(); } catch (_) { return false; } };
  let wt = job.workerTabId != null && await tabInfo(job.workerTabId) ? job.workerTabId : null;
  if (wt == null) {
    let tab;
    try { tab = await chrome.tabs.create({ url, active: false }); }
    catch (_) { return { ok: false, kind: "transient", message: "couldn't open a tab" }; }
    wt = tab.id;
    job.workerTabId = wt;
    await save({ [K.job]: job });
    try { await chrome.tabs.update(wt, { autoDiscardable: false }); } catch (_) {}
    if (!await waitTabReady(wt, match, 45000, waitReady(wt, match, 45000))) return { ok: false, kind: "transient", message: "the profile page didn't load" };
  } else if (!await navigate(wt, url, match, 45000)) {
    return { ok: false, kind: "transient", message: "the profile page didn't load" };
  }
  await sleep(rand(900, 1800));
  return sendTab(wt, { gx: "profileFollow", id: t.i, h: t.h, owner: job.ownerId }, 50000);
}

async function controlJob(action, ms) {
  const job = await load(K.job, null);
  if (!job) return { ok: false, error: "Autopilot isn't running." };
  if (action === "pause") {
    if (!ACTIVE.has(job.status)) return { ok: true };
    const sp = await getRawSettings();
    job.status = "paused";
    job.restUntil = null;
    // A pause can carry its own end: either the minutes you set here, or the default from Settings.
    const mins = Number(ms && ms.mins);
    const use = Number.isFinite(mins) && mins > 0 ? mins : (sp.pauseResume ? sp.pauseResumeMins : 0);
    job.resumeAt = use > 0 ? Date.now() + Math.round(use) * MIN : 0;
    job.message = job.resumeAt ? `Paused. Starts again by itself at ${clock(job.resumeAt)}.` : "Paused.";
    await save({ [K.job]: job });
    syncPower(false);
    await pushEvent("run", job.resumeAt ? `Autopilot paused for ${fmtSpan(job.resumeAt - Date.now())} - it starts again at ${clock(job.resumeAt)}.` : "Autopilot paused.");
    tgSend("run", job.resumeAt ? `<b>GrowX paused</b>\nBack at ${clock(job.resumeAt)}.` : "<b>GrowX paused</b>");
    if (job.resumeAt) scheduleTick(Math.min(60000, job.resumeAt - Date.now()));
    return { ok: true, resumeAt: job.resumeAt };
  }
  // Set, change or clear the timer while already paused (mins = 0 clears it).
  if (action === "resumeAt") {
    if (job.status !== "paused") return { ok: false, error: "The autopilot isn't paused." };
    const mins = Math.round(Number(ms && ms.mins) || 0);
    job.resumeAt = mins > 0 ? Date.now() + mins * MIN : 0;
    job.message = job.resumeAt ? `Paused. Starts again by itself at ${clock(job.resumeAt)}.` : "Paused.";
    await save({ [K.job]: job });
    await pushEvent("run", job.resumeAt ? `Pause timer set: back at ${clock(job.resumeAt)}.` : "Pause timer cleared - it stays paused until you press Resume.");
    if (job.resumeAt) scheduleTick(Math.min(60000, job.resumeAt - Date.now()));
    return { ok: true, resumeAt: job.resumeAt };
  }
  if (action === "resume") {
    if (!["paused", "halted"].includes(job.status)) return { ok: true };
    const s = await getSettings();
    job.status = "running";
    job.haltKind = null;
    job.recoverAt = null;
    job.nextAt = Date.now();
    job.consecutiveFails = 0; job.failsAtStrike = 0; job.noAnswerN = 0; job.readLad = null;
    job.rateHits = 0;
    job.tabWaits = 0;
    job.resumeAt = 0;                       // the pause timer is spent
    job.message = "Resuming...";
    await save({ [K.job]: job });
    if (s.keepAwake) syncPower(true);
    await pushEvent("run", "Autopilot resumed.");
    tgSend("run", "<b>GrowX is running again</b>");
    scheduleTick(200);
    return { ok: true };
  }
  if (action === "stop") {
    if (["done", "stopped"].includes(job.status)) return { ok: true };
    const jm = jobMode(job);
    await finishJob(job, "stopped", jm === "unfollow" ? `Stopped. Unfollowed ${plural(job.undone || 0, "account")} this run.`
      : jm === "followback" ? `Stopped. Followed back ${plural(job.bdone || 0, "account")} this run.`
      : jm === "comment" ? `Stopped. Posted ${plural(job.cdone || 0, "reply")} this run.` : `Stopped. Followed ${plural(job.done, "account")} this run.`);
    return { ok: true };
  }
  return { ok: false, error: "unknown action" };
}

// ===========================================================================
// One-off tasks while autopilot is off: fill the queue, or check follow-backs.
// ===========================================================================
async function startTask(kind) {
  const job = await load(K.job, null);
  if (job && ACTIVE.has(job.status)) {
    const c = (await load(K.ctl, null)) || {};            // merge - never throw away a pending reset/rule-change request
    if (kind === "harvest") c.harvest = true; else c.fb = true;
    await save({ [K.ctl]: c });
    scheduleTick(200);
    return { ok: true, viaJob: true };
  }
  const cur = await load(K.task, null);
  if (cur && cur.status === "running") return { ok: true, already: true };
  if (kind === "harvest") {
    const sources = await getSources();
    if (!sources.some((x) => x.enabled && !["gone", "private"].includes(x.status))) return { ok: false, error: "Add at least one source profile first." };
  }
  const got = await acquireTab(null, { create: true });
  if (!got) return { ok: false, error: "Couldn't open X. Check that x.com loads in this browser." };
  const p = await ping(got.tabId);
  if (!p || !p.uid) {
    if (got.created) { try { await chrome.tabs.remove(got.tabId); } catch (_) {} }
    return { ok: false, error: "You're not signed in to X. Sign in at x.com first.", needLogin: true };
  }
  await refreshAccount(got.tabId);
  await switchOwner(await load(K.meta, {}), p.uid);
  const task = { kind, status: "running", ownerId: p.uid, tabId: got.tabId, ownTab: got.created, startedAt: Date.now(), steps: 0, added: 0, nextReadAt: Date.now(), message: kind === "harvest" ? "Searching all your sources for people likely to follow back..." : "Checking who followed back..." };
  if (kind === "harvest") task.sweep = newSweep(await getSources());
  else task.relForce = { since: Date.now() };
  await save({ [K.task]: task });
  scheduleTick(200);
  return { ok: true };
}

async function endTask(task, message) {
  task.status = "done";
  task.message = message;
  task.finishedAt = Date.now();
  if (task.ownTab && task.tabId != null) { try { await chrome.tabs.remove(task.tabId); } catch (_) {} }
  task.tabId = null;
  await save({ [K.task]: task });
  await flushSeen(true);
  await pushEvent(task.kind === "harvest" ? "harvest" : "fb", message);
  refreshBadge();
}

async function nextTaskStep(task) {
  task.nextReadAt = Date.now() + rand(1500, 3500);
  await save({ [K.task]: task });
  scheduleTick(task.nextReadAt - Date.now());
}

async function taskWait(task, until) {
  task.message = `X asked for a short break. Continuing at ${clock(until)}.`;
  await save({ [K.task]: task });
  scheduleTick(Math.max(1000, until - Date.now()));
}

async function taskStep(task) {
  const now = Date.now();
  const s = await getSettings();
  if (now < (task.nextReadAt || 0)) return scheduleTick(task.nextReadAt - now);
  // Direct checks unavailable right now: go straight to the follower scan.
  if (task.kind === "fbcheck" && task.relForce && task.relUntil > now) task.relForce = null;
  const listWait = task.readUntil > now && !(task.kind === "fbcheck" && task.relForce);
  if (listWait) return taskWait(task, task.readUntil);
  const got = await acquireTab(task.tabId, { create: true, ownTab: task.ownTab });
  if (!got) return endTask(task, "Couldn't reach x.com.");
  if (got.tabId !== task.tabId) { task.tabId = got.tabId; task.ownTab = got.created; }
  task.steps++;
  if (task.steps > 500) return endTask(task, "Stopped after many pages.");

  if (task.kind === "fbcheck") {
    if (task.relForce) {
      const m = await relStep(task, s);
      if (m.halt) return endTask(task, "X needs your attention: " + (m.message || m.halt));
      if (m.called) {
        task.message = task.relUntil > Date.now()
          ? "Direct check unavailable right now - scanning your followers instead..."
          : `Checking follow-backs directly... ${plural(task.relDone || 0, "account")} checked · ${(task.relFound || 0).toLocaleString()} followed back`;
        return nextTaskStep(task);
      }
      task.relForce = null;
    }
    if (task.readUntil > Date.now()) return taskWait(task, task.readUntil);
    const r = await fbStep(task, s);
    if (r.halt) return endTask(task, "X needs your attention: " + (r.message || r.halt));
    if (!task.fb) {
      const scan = task.lastFb;
      if (!scan && !task.relDone) return endTask(task, "Couldn't check follow-backs right now. Try again in a few minutes.");
      const found = (task.relFound || 0) + (scan ? scan.matched : 0);
      const how = [];
      if (task.relDone) how.push(`checked ${plural(task.relDone, "account")} directly`);
      if (scan) how.push(scan.mode === "ids" ? "scanned all your followers" : "scanned your newest followers");
      return endTask(task, `${plural(found, "new follow-back")} found - ${how.join(" and ")}.`);
    }
    task.message = `Scanning your followers... page ${task.fb.pages}`;
    return nextTaskStep(task);
  }

  if (!task.sweep) task.sweep = newSweep(await getSources());
  const r = await harvestStep(task, s, task.sweep);
  if (r.halt) return endTask(task, "X needs your attention: " + (r.message || r.halt));
  if (r.sweepDone) {
    await prunePool(s, Date.now());
    return endTask(task, sweepSummary(task.sweep).text);
  }
  if (!r.called) {
    if (r.waitUntil) return taskWait(task, r.waitUntil);
    return endTask(task, "No source can be read right now.");
  }
  task.added += r.added || 0;
  const sw = task.sweep;
  const doneN = sw.list.filter((k) => sw.done[k]).length;
  task.message = `Reading @${r.src || "..."} · ${doneN} of ${sw.list.length} sources done · +${task.added.toLocaleString()} people`;
  if (task.readUntil > Date.now()) return taskWait(task, task.readUntil);
  return nextTaskStep(task);
}

// ===========================================================================
// Sources, queue and settings commands
// ===========================================================================
async function addSources(handles) {
  const sources = await getSources();
  const have = new Set(sources.map((x) => String(x.h).toLowerCase()));
  const acc = await load(K.account, null);
  let added = 0, bad = 0;
  for (const raw of handles || []) {
    const h = GX.cleanHandle(raw);
    if (!h) { bad++; continue; }
    const k = h.toLowerCase();
    if (have.has(k) || (acc && acc.handle && acc.handle.toLowerCase() === k)) continue;
    have.add(k);
    sources.push({ h, id: null, enabled: true, status: "new", addedAt: Date.now(), harvested: 0, queued: 0, rejected: 0, followed: 0, back: 0, pages: 0, errors: 0 });
    added++;
  }
  await saveSources();
  if (added) await pushEvent("source", `Added ${plural(added, "source")}.`);
  return { ok: true, added, bad, total: sources.length };
}

async function sourceCmd(msg) {
  const sources = await getSources();
  const i = sources.findIndex((x) => String(x.h).toLowerCase() === String(msg.h || "").toLowerCase());
  if (i < 0) return { ok: false, error: "Source not found." };
  const src = sources[i];
  if (msg.op === "remove") {
    sources.splice(i, 1);
    if (msg.purge) { const pool = await getPool(); mem.pool = pool.filter((c) => String(c.src).toLowerCase() !== String(src.h).toLowerCase()); await savePool(); }
  } else if (msg.op === "toggle") {
    src.enabled = msg.on === undefined ? !src.enabled : !!msg.on;
  } else if (msg.op === "reset") {
    Object.assign(src, { id: null, status: "new", note: "", cursor: null, deepDone: false, lastTopAt: null, pass: null, nextAt: 0, errors: 0 });
  }
  await saveSources();
  return { ok: true };
}

async function poolCmd(msg) {
  const pool = await getPool();
  if (msg.op === "clear") { mem.pool = []; await savePool(); return { ok: true }; }
  const ids = new Set((msg.ids || []).map(String));
  if (msg.op === "remove" || msg.op === "block") {
    const bl = await getBlacklist();
    const seen = await getSeen();
    for (let i = pool.length - 1; i >= 0; i--) {
      if (!ids.has(String(pool[i].i || pool[i].h))) continue;
      if (msg.op === "block") bl.add(String(pool[i].h).toLowerCase());
      if (pool[i].i) seen.add(pool[i].i);
      pool.splice(i, 1);
    }
    mem.seenDirty++;
    await savePool();
    await flushSeen(true);
    if (msg.op === "block") await save({ [K.blacklist]: [...bl] });
    return { ok: true };
  }
  if (msg.op === "pin") {
    for (const c of pool) if (ids.has(String(c.i || c.h))) c.pin = !c.pin;
    sortPool(pool);
    await savePool();
    return { ok: true };
  }
  if (msg.op === "import") {
    // A list of usernames or profile links to follow. Anyone you already follow
    // is skipped; everyone else joins the queue and is followed by Follow mode,
    // with its pacing, its daily number, its breaks and every safety setting.
    // The answer says what happened to each name, so nothing is silently dropped.
    const all = await getFollows();
    const following = new Map();          // you follow them now
    const already = new Map();            // you followed them before and unfollowed
    for (const f of all) {
      const k = String(f.h || "").toLowerCase();
      if (!k) continue;
      if (f.nf) already.set(k, f); else following.set(k, f);
    }
    const followsMe = await followerHandles();
    const bl = await getBlacklist();
    const keep = keepSet(await getRawSettings());

    const idxNow = await getFollowIndex();
    // STEP 1 - the queue itself. Anyone on it you have since followed comes off
    // now, so the list you are about to add to is already true.
    const wasPool = pool.length;
    for (let i = pool.length - 1; i >= 0; i--) {
      const c = pool[i];
      const k = String(c.h || "").toLowerCase();
      if ((k && following.has(k)) || (c.i && idxNow.has(String(c.i)))) pool.splice(i, 1);
    }
    const cleaned = wasPool - pool.length;
    const inPool = new Set(pool.map((c) => String(c.h).toLowerCase()));

    const out = { added: 0, following: 0, queued: 0, blocked: 0, bad: 0, again: 0, dup: 0, back: 0, cleaned,
                  names: { following: [], queued: [], blocked: [], bad: [], again: [], back: [] } };
    const seenHere = new Set();
    const note = (bucket, h) => { out[bucket]++; if (out.names[bucket] && out.names[bucket].length < 50) out.names[bucket].push(h); };
    const toBack = [];

    // STEP 2 - the list you pasted, name by name.
    for (const raw of msg.handles || []) {
      const h = GX.cleanHandle(raw);
      if (!h) { note("bad", String(raw).slice(0, 40)); continue; }
      const k = h.toLowerCase();
      if (seenHere.has(k)) { out.dup++; continue; }       // the same name twice in one paste
      seenHere.add(k);
      if (following.has(k)) { note("following", h); continue; }         // ALREADY FOLLOWED - dropped
      if (bl.has(k) || keep.has(k)) { note("blocked", h); continue; }
      // They follow you and you do not follow them: that is a follow-BACK, and
      // it goes to the front of the Follow back list rather than the Follow queue.
      if (followsMe.has(k)) {
        const id = followsMe.get(k);
        if (id) { toBack.push(id); note("back", h); continue; }
      }
      if (inPool.has(k)) { note("queued", h); continue; }
      if (already.has(k) && !msg.refollow) { note("again", h); continue; }  // you unfollowed them once
      inPool.add(k);
      pool.push({ i: null, h, n: "", a: "", score: 0, src: "import", at: Date.now(), manual: true, pin: !!msg.pin });
      out.added++;
    }
    sortPool(pool);
    await savePool();

    // STEP 3 - the follow-backs, put before everyone still waiting.
    if (toBack.length) {
      const b = await load(K.bk, null);
      if (b && Array.isArray(b.list)) {
        const have = new Set(b.list.map(String));
        const fresh = toBack.filter((i) => !have.has(String(i)));
        if (fresh.length) {
          b.list.splice(b.pos || 0, 0, ...fresh);
          if (Array.isArray(b.rank)) b.rank.splice(b.pos || 0, 0, ...fresh.map(() => 0));
          await save({ [K.bk]: b });
        }
      } else {
        // The follower list has not been built yet: remember them for when it is.
        const waiting = (await load(K.bkpre, [])) || [];
        await save({ [K.bkpre]: [...new Set(waiting.concat(toBack.map(String)))].slice(0, 5000) });
      }
    }
    if (out.added || out.back || out.cleaned) {
      const bits = [];
      if (out.added) bits.push(`${out.added} to the Follow queue`);
      if (out.back) bits.push(`${out.back} to the front of Follow back (they already follow you)`);
      if (out.following) bits.push(`${out.following} skipped, you already follow them`);
      if (out.cleaned) bits.push(`${out.cleaned} taken off the queue, already followed`);
      await pushEvent("run", "Your list: " + bits.join(" · ") + ".");
      await actLog({ mode: "follow", act: "queued", why: bits.join("; ") });
    }
    return Object.assign({ ok: true }, out);
  }
  return { ok: false, error: "unknown" };
}

const MODE_NAME = { follow: "Follow", unfollow: "Unfollow", followback: "Follow back", comment: "Comment" };

// `opts.noStart`: save the settings but never let the save itself begin a run. Used by buttons that only
// PREPARE something (pick an order, rebuild a list) - the person presses Start when they are ready.
async function saveSettings(patch, opts) {
  const cur = await load(K.settings, {});
  const prevMode = GX.normalizeSettings(cur).runMode;
  let next = Object.assign({}, cur, patch || {});
  const DMAX = GX.LIMITS.dailyLimit[1], HMAX = GX.LIMITS.hourlyLimit[1];
  const adjusted = [];       // shared X limits a pace card had to raise so its own number can be reached
  // A pace card click sends only its name: the preset fills in everything. A save from the form names the matching pace too, but
  // then every number you typed (also the hidden hourly ones while "Per hour: Auto" is on) stays as you typed it.
  if (patch && patch.speed && GX.PRESETS[patch.speed]) {
    next = Object.assign(next, GX.PRESETS[patch.speed], patch);
    // A pace preset sets the speed; it must never pull the daily number below the run target you set.
    if (!(patch.dailyLimit > 0) && next.sessionTarget > 0 && next.dailyLimit < next.sessionTarget) next.dailyLimit = Math.min(next.sessionTarget, DMAX);
  }
  if (patch && patch.unfPace && GX.UNF_PRESETS[patch.unfPace]) next = Object.assign(next, GX.UNF_PRESETS[patch.unfPace], patch);
  // A Comment pace card is a complete plan too: the card fills everything in, then anything you typed wins.
  if (patch && patch.cmtPace && GX.CMT_PRESETS[patch.cmtPace]) next = Object.assign(next, GX.CMT_PRESETS[patch.cmtPace], patch);
  if (patch && patch.bkPace && GX.BK_PRESETS[patch.bkPace]) {
    next = Object.assign(next, GX.BK_PRESETS[patch.bkPace], patch);
    // Follow and Follow back share X's daily and hourly follow limit, so the shared numbers must fit the follow-back numbers you picked.
    // (Compared as they will really be: a fresh install has no saved daily/hourly numbers yet - the defaults apply.)
    const eff = GX.normalizeSettings(next);
    if (!(patch.dailyLimit > 0) && eff.dailyLimit < eff.bkDaily) { next.dailyLimit = Math.min(eff.bkDaily, DMAX); adjusted.push("dailyLimit"); }
    if (!eff.hourlyAuto && !(patch.hourlyLimit > 0) && eff.hourlyLimit < eff.bkHourlyLimit) { next.hourlyLimit = Math.min(eff.bkHourlyLimit, HMAX); adjusted.push("hourlyLimit"); }
  }
  next = GX.normalizeSettings(next);
  const prevN = GX.normalizeSettings(cur);
  const rulesChanged = BK_RULES.some((k) => prevN[k] !== next[k]);
  await save({ [K.settings]: next });
  if (rulesChanged) await bkRulesChanged();
  const meta = await load(K.meta, {});
  if (next.warmup && !meta.warmupAt) { meta.warmupAt = Date.now(); await save({ [K.meta]: meta }); }
  if (!next.warmup && meta.warmupAt) { delete meta.warmupAt; await save({ [K.meta]: meta }); }
  const job = await load(K.job, null);
  const switched = prevMode !== next.runMode;
  let started = false;
  if (job && ACTIVE.has(job.status)) {
    const ms = GX.modeSettings(next);
    // A mode change is picked up by the engine on its next step (it compares the run with your settings, so a step that is in progress can't lose it).
    if (!switched && job.restReason === "schedule" && GX.inWindow(ms, Date.now())) { job.restUntil = Date.now(); await save({ [K.job]: job }); }
    scheduleTick(500);
  } else if (switched && next.autoStart && !(opts && opts.noStart) && (!job || job.status === "done" || job.status === "stopped")) {
    // No run is active and you picked another mode: start it now if it is due (its hours, its daily number, X not limiting follows).
    started = await maybeAutoStart();
    if (started) await pushEvent("run", `Started in ${MODE_NAME[next.runMode]} mode.`);
  }
  refreshBadge();
  return { ok: true, settings: next, switched, started, adjusted };
}

// ===========================================================================
// State for the UI
// ===========================================================================
function summarize(follows, growth, now) {
  let settled = 0, settledBack = 0, recent = 0, recentBack = 0, pending = 0;
  for (const f of follows) {
    if (f.fy0) continue;
    if (f.p) pending++;
    if (now - f.t > 48 * HOUR) { settled++; if (f.fb) settledBack++; }
    if (now - f.t < 7 * DAY) { recent++; if (f.fb) recentBack++; }
  }
  const total = follows.length;
  const back = follows.filter((f) => f.fb && !f.fy0).length;
  const g = Array.isArray(growth) ? growth : [];
  const last = g[g.length - 1];
  const month = dayKey(now).slice(0, 7);
  const firstOfMonth = g.find((x) => x.d.slice(0, 7) === month);
  const prev = g.filter((x) => x.d < dayKey(now)).pop();
  const weekAgo = g.find((x) => x.d >= dayKey(now - 7 * DAY));
  return {
    total, back, pending,
    rate: settled ? settledBack / settled : (total ? back / total : null),
    settled, recent, recentBack, recentRate: recent ? recentBack / recent : null,
    followers: last ? last.f : null,
    gainedToday: last ? last.f - (prev ? prev.f : last.f0) : null,
    gainedWeek: last && weekAgo ? last.f - (weekAgo.f0 != null ? weekAgo.f0 : weekAgo.f) : null,
    measuredSince: weekAgo ? (g.indexOf(weekAgo) === 0 ? (g[0].t0 || null) : null) : null,
    newToday: last && last.d === dayKey(now) && typeof last.nf === "number" ? last.nf : (g.some((x) => typeof x.nf === "number") ? 0 : null),
    newWeek: g.some((x) => typeof x.nf === "number" && x.d >= dayKey(now - 7 * DAY)) ? g.filter((x) => x.d >= dayKey(now - 7 * DAY)).reduce((a, x) => a + (Number(x.nf) || 0), 0) : null,
    gainedMonth: last && firstOfMonth ? last.f - (firstOfMonth.f0 != null ? firstOfMonth.f0 : firstOfMonth.f) : null
  };
}

async function uiState() {
  const now = Date.now();
  const [account, job, task, settings, ledger, health, meta, events, growth, stats] = await Promise.all([
    load(K.account, null), load(K.job, null), load(K.task, null), getRawSettings(), getLedger(), load(K.health, null),
    load(K.meta, {}), load(K.events, []), load(K.growth, []), load(K.stats, {})
  ]);
  const pool = await getPool();
  const sources = await getSources();
  const follows = await getFollows();
  const limits = GX.effectiveLimits(settings, meta, activeThrottle(job, settings), now);
  const owner = (account && account.id) || meta.ownerId;
  let relPending = 0;
  for (const f of follows) if (f.c && fbPending(f, owner)) relPending++;
  const lost = await getLost(owner);
  const keep = keepSet(settings);
  const idx = await getFollowIndex();
  // A transition break means NO mode is acting: the one that finished must not still read as "running".
  const pending = job && job.trans && job.trans.until > now ? job.trans : null;
  const running = job && ACTIVE.has(job.status) && !pending ? jobMode(job) : null;
  const doneToday = [...doneSet(job, now)];
  const unfT = await unfToday(now);
  const bkT = await bkToday(now);
  const todayN = dayEntries(ledger, settings, now).length;
  const cmtDaysAll = await cmtDays();
  const cmtDay = cmtDaysAll[GX.cmtDayKey(now)] || {};
  const cmtT = cmtDay.posted || 0;
  const cQ = await cmtQueue();
  const cReady = cQ.filter((r) => r.st === "ready").length;
  const cOpen = cQ.filter(GX.cmtOpen).length;
  // The links you pasted, counted the way you would count them yourself:
  // how many you gave, how many are replied to, and how many are still to come.
  const cLinks = cQ.filter((r) => r.src === "links");
  const cLink = {
    all: cLinks.length,
    posted: cLinks.filter((r) => r.st === "posted").length,
    ready: cLinks.filter((r) => r.st === "ready").length,
    skipped: cLinks.filter((r) => r.st === "skipped").length,
    failed: cLinks.filter((r) => r.st === "failed").length,
    busy: cLinks.filter((r) => ["reading", "writing", "posting"].includes(r.st)).length,
    // Each link is counted in exactly one of these, so the numbers add up to "all".
    left: cLinks.filter((r) => r.st === "waiting").length,
    // the links themselves, so the Overview can list them and take one back out
    rows: cLinks.filter((r) => r.st !== "posted").slice(0, 30).map((r) => ({ i: r.id, h: r.h || "", st: r.st }))
  };
  // The same counts for the whole queue, whatever a post came from, plus the
  // money spent across every day GrowX has run. This is what the Overview shows.
  const cTot = {
    posts: cQ.length,
    replied: cQ.filter((r) => r.st === "posted").length,
    skipped: cQ.filter((r) => r.st === "skipped").length,
    failed: cQ.filter((r) => r.st === "failed").length,
    ready: cReady,
    left: cQ.filter((r) => GX.cmtOpen(r)).length,
    cost: Object.values(cmtDaysAll).reduce((a, x) => a + (x.cost || 0), 0)
  };
  const cKey = !!(await cmtKey());
  const hourN = {
    follow: ledger.filter((t) => t > now - HOUR).length,
    followback: (await load(K.bledger, [])).filter((t) => t > now - HOUR).length,
    unfollow: (await load(K.uledger, [])).filter((t) => t > now - HOUR).length,
    comment: (await cmtLedger()).filter((t) => t > now - HOUR).length
  };
  const modesOut = GX.MODES.reduce((o, m) => {
    const target = GX.modeTarget(settings, m, limits.daily);
    const turn = GX.modeTurnTarget(settings, m, limits.daily);
    const done = m === "comment" ? cmtT : m === "unfollow" ? unfT : m === "followback" ? bkT : todayN;
    const blocked = m === "comment" ? meta.cLimitedDay === dayKey(now) : m === "unfollow" ? !!uLimitedToday(meta, job, now) : !!xLimitedToday(meta, job, now);
    const ms = GX.modeSettings(Object.assign({}, settings, { runMode: m }));
    o[m] = {
      done, target, left: Math.max(0, target - done), pct: Math.min(1, done / Math.max(1, target)),
      // This turn of the sequence: how far the mode is towards handing over.
      turn, turnDone: running === m ? ((job && job.turnDone) || 0) : 0,
      turnPct: Math.min(1, (running === m ? ((job && job.turnDone) || 0) : 0) / Math.max(1, turn)),
      off: (settings.switchOff || []).includes(m),
      delay: m === "comment" ? [settings.cmtMinDelay, settings.cmtMaxDelay] : m === "unfollow" ? [settings.unfMinDelay, settings.unfMaxDelay] : m === "followback" ? [settings.bkMinDelay, settings.bkMaxDelay] : [settings.minDelay, settings.maxDelay],
      hour: hourN[m] || 0,
      cap: GX.hourlyCap(settings, m, { daily: limits.daily }).cap,
      reached: done >= target, blocked, doneToday: doneToday.includes(m),
      running: running === m, selected: settings.runMode === m,
      inWindow: GX.inWindow(ms, now), nextWindow: GX.nextWindowStart(ms, now),
      breakRange: GX.breakRange(settings, m),
      batch: m === "comment" ? [settings.cmtRestEveryMin, settings.cmtRestEvery] : m === "unfollow" ? [settings.unfRestEveryMin, settings.unfRestEvery] : m === "followback" ? [settings.bkRestEveryMin, settings.bkRestEvery] : [settings.restEveryMin, settings.restEvery],
      status: running === m ? "running" : doneToday.includes(m) ? "done" : blocked ? "blocked" : done >= target ? "reached" : "waiting"
    };
    return o;
  }, {});
  // The mode a Start pressed right now would begin in - the same rule the engine uses (startMode), worked out
  // from numbers uiState already has so the dashboard can show it without costing extra reads.
  const canRun = (m) => {
    const d = modesOut[m];
    if (!d || d.doneToday || d.blocked || d.reached) return false;
    if (m === "follow" && !pool.length && !sources.some((x) => x.enabled && !["gone", "private"].includes(x.status))) return false;
    if (m === "comment" && (!cKey || (!cOpen && !settings.cmtSrcWatch && !settings.cmtSrcTarget && !settings.cmtSrcBack))) return false;
    return true;
  };
  const startAt = GX.cycling(settings) ? (GX.modeSeq(settings).find(canRun) || null) : settings.runMode;
  return {
    // ---- Automatic mode switching: the sequence, where it stands, and a transition break that is running ----
    seq: {
      on: !!settings.autoSwitch, order: GX.modeSeq(settings), full: GX.modeOrder(settings), off: settings.switchOff || [],
      loop: !!settings.switchLoop, cycling: GX.cycling(settings),
      transMin: settings.transMin, transMax: settings.transMax,
      turnDone: (job && job.turnDone) || 0,
      running, doneToday, switchN: (job && job.switchDay === dayKey(now) ? job.switchN : 0) || 0, max: MAX_SWITCHES_PER_DAY,
      trans: pending ? { from: pending.from, to: pending.to, at: pending.at, until: pending.until, ms: pending.ms } : null,
      next: pending ? pending.to : GX.nextMode(settings, running || settings.runMode, doneToday),
      startAt
    },
    // ---- Progress and status of every mode, so the dashboard can show all three at once ----
    modes: modesOut,
    // ---- Unfollowed you: the separate list of detected unfollowers ----
    lost: (() => {
      const list = lost.list || [];
      let elig = 0, sel = 0, done = 0;
      for (const x of list) { if (x.uf) { done++; continue; } if (x.sel) sel++; if (lostEligible(x, idx, keep)) elig++; }
      return { total: list.length, today: lostToday(lost, now), elig, sel, unfollowed: done, at: lost.at || 0, all: (stats && stats.lost) || list.length };
    })(),
    // ---- Comment mode: enough for the sidebar, the Overview card and the popup ----
    cmt: {
      on: settings.cmtOn !== false, hasKey: cKey, publish: settings.cmtPublish,
      today: cmtT, goal: settings.cmtDaily, left: Math.max(0, settings.cmtDaily - cmtT),
      ready: cReady, open: cOpen, queue: cQ.length, links: cLink, tot: cTot,
      hour: hourN.comment, hourCap: GX.hourlyCap(settings, "comment").cap,
      drafts: cmtDay.drafts || 0, skipped: cmtDay.skipped || 0, failed: cmtDay.failed || 0, cost: cmtDay.cost || 0,
      cap: settings.cmtSpendCents / 100,
      all: Object.values(cmtDaysAll).reduce((a, x) => a + (x.posted || 0), 0),
      limited: meta.cLimitedDay === dayKey(now) ? { at: meta.cLimitedAt || 0, n: meta.cLimitedToday || 0 } : null,
      watch: (await cmtWatch()).length, targets: (await cmtTargets()).filter((t) => !t.done).length,
      targetList: (await cmtTargets()).slice(0, 30).map((t) => ({ h: t.h, followed: !!t.followed, done: t.done || "" })),
      last: (await cmtHist())[0] || null
    },
    fbinfo: await load(K.fbinfo, {}), relPending, relNext: relNextDue(follows, owner),
    ok: true, now, version: chrome.runtime.getManifest().version,
    account, job, task, settings, health, meta,
    today: dayEntries(ledger, settings, now).length, hour: ledger.filter((t) => t > now - HOUR).length, limits,
    cap: GX.followingCap(settings, account),
    poolCount: pool.length, poolTop: queueOrder(pool, settings).slice(0, 6),
    sources, events: (events || []).slice(0, 40),
    summary: summarize(follows, growth, now), stats,
    inWindow: GX.inWindow(GX.modeSettings(settings), now), nextWindow: GX.nextWindowStart(GX.modeSettings(settings), now),
    uLimited: uLimitedToday(meta, job, now) ? { at: meta.uLimitedAt || (job && job.uLimitedAt) || null, n: meta.uLimitedDay === dayKey(now) ? (meta.uLimitedToday == null ? null : meta.uLimitedToday) : ((job && job.uLimitedToday) == null ? null : job.uLimitedToday) } : null,
    lad: await (async () => {
      // The X-refused plan: how far each family (Follow + Follow back, Unfollow) is today, and a break that is still running.
      const out = {};
      for (const fam of ["follow", "unfollow", "comment"]) {
        const st = await ladGet(fam, now);
        out[fam] = { n: st.n || 0, t: st.t || 0, at: st.at || 0, until: st.until > now ? st.until : 0, why: st.why || "" };
      }
      return out;
    })(),
    xLimited: xLimitedToday(meta, job, now) ? { at: meta.xLimitedAt || (job && job.xLimitedAt) || null, n: meta.xLimitedDay === dayKey(now) ? (meta.xLimitedToday == null ? null : meta.xLimitedToday) : ((job && job.xLimitedToday) == null ? null : job.xLimitedToday) } : null,
    bk: await (async () => {
      const b = await load(K.bk, null);
      const today = await bkToday(now);
      const hour = (await load(K.bledger, [])).filter((x) => x > now - HOUR).length;
      const bl = await load(K.bklog, []);
      const all = Array.isArray(bl) ? bl.filter((x) => x && (!x.o || x.o === owner)).length : 0;
      if (!b || b.owner !== owner) return { stage: "new", today, hour, all };
      const left = b.stage === "ready" ? Math.max(0, b.total - b.pos + (b.batch || []).length) : 0;
      return { stage: b.stage, total: b.total || 0, followed: b.followed || 0, skipped: b.skipped || 0, skips: b.skips || {}, left, today, hour, all,
        fcount: b.fcount || 0, frcount: b.frcount || 0, startFollowing: b.startFollowing || null, order: b.order || null,
        read: (b.friends || []).length + (b.followers || []).length, builtAt: b.builtAt || null, doneAt: b.doneAt || null,
        deep: { checked: b.pcChecked || 0, hour: (b.deepTimes || []).filter((x) => x > now - HOUR).length, off: !!(b.deepOffUntil && b.deepOffUntil > now) } };
    })(),
    unf: await (async () => {
      const u = await load(K.unf, null);
      const today = await unfToday(now);
      const hour = (await load(K.uledger, [])).filter((x) => x > now - HOUR).length;
      // Everything GrowX ever unfollowed (kept in the stats, so "Read my list again" and Step 2 don't change it) and how many of them followed you.
      const allU = (n) => Math.max((stats && stats.unfollowed) || 0, n), folU = (n) => Math.max((stats && stats.unfollowedFollowers) || 0, n);
      if (!u || u.owner !== owner) return { stage: "new", today, hour, all: allU(0), fol: folU(0) };
      const left = u.stage === "ready" ? Math.max(0, u.total - u.pos + (u.batch || []).length) : 0;
      let due = 0, waiting = 0;
      if (u.stage === "done") {
        const cut = now - settings.unfollowAfterDays * DAY;
        for (const f of follows) if (f.i && !f.fb && !f.fy0 && !f.nf && !f.uf && !f.uk && (!f.o || f.o === owner)) { if (f.t <= cut) due++; else waiting++; }
      }
      return { stage: u.stage, total: u.total, removed: u.removed, skipped: u.skipped, left, today, hour, due, waiting, startFollowing: u.startFollowing || null, order: u.order || "old",
        all: allU((u.removed || 0) + (u.inactRemoved || 0) + (u.actRemoved || 0) + (u.lostRemoved || 0)), fol: folU(u.inactRemoved || 0), lostRemoved: u.lostRemoved || 0,
        inact: { total: (u.mutual || []).length, pos: u.mpos || 0, deep: (u.deep || []).length, found: (u.ibatch || []).length, removed: u.inactRemoved || 0, checked: u.inactChecked || 0, doneAt: u.mutualDoneAt || null, ready: !!u.mutualAt,
          keptActive: u.inactKeptActive || 0, keptBig: u.inactKeptBig || 0 },
        keptBig: (u.keptBig || 0) + (u.inactKeptBig || 0),
        // v3.2 live feed: who comes next (inactive finds go first, exactly as the engine picks them)
        next: [].concat(settings.unfInactive && !GX.unfProtect(settings) ? (u.ibatch || []) : [], u.batch || []).slice(0, 8).map((x) => ({
          i: x.i, h: x.h || "", n: x.n || "", a: x.a || "", ia: x.ia ? 1 : 0, qs: x.qs == null ? null : x.qs, fc: x.fc == null ? null : x.fc,
          why: x.ia ? (x.why || "inactive") : x.src === "lost" ? "followed you, then unfollowed you" : x.src === "7d" ? `no follow-back in ${settings.unfollowAfterDays} days` : "doesn't follow you back" })),
        act: { total: (u.mutual || []).length, pos: u.apos || 0, queued: (u.batch || []).filter((x) => x.src === "act").length, removed: u.actRemoved || 0, doneAt: u.actDoneAt || null, ready: !!u.mutualAt },
        read: (u.friends || []).length + (u.followers || []).length, doneAt: u.doneAt || null };
    })()
  };
}

async function runHealth() {
  const got = await acquireTab(null, { create: true });
  if (!got) return { ok: false, error: "Couldn't open x.com." };
  const r = await sendTab(got.tabId, { gx: "health" }, 120000);
  const out = { at: Date.now(), ...r };
  await save({ [K.health]: out });
  const job = await load(K.job, null);
  if (got.created && !(job && job.tabId === got.tabId)) { try { await chrome.tabs.remove(got.tabId); } catch (_) {} }
  return { ok: true, health: out };
}

async function openX(path) {
  const url = "https://x.com/" + (path || "home");
  try {
    const [tab] = await chrome.tabs.query({ url: X_URLS, currentWindow: true });
    if (tab && !path) { await chrome.tabs.update(tab.id, { active: true }); return; }
  } catch (_) {}
  chrome.tabs.create({ url });
}

async function resetData(what) {
  const job = await load(K.job, null);
  if (job && ACTIVE.has(job.status)) return { ok: false, error: "Stop autopilot first." };
  if (what === "history") {
    await chrome.storage.local.remove([K.follows, K.events, K.stats, K.growth, K.known, K.fbinfo, K.bklog, K.bk, K.lost]);
    mem.follows = null; mem.fidx = null; mem.known = null;
  } else if (what === "comments") {
    // The comment queue only. The post ids and the day totals are kept: "one post, one reply" must survive it.
    await chrome.storage.local.remove([CK.queue]);
    cmem.q = null;
  } else if (what === "queue") {
    await chrome.storage.local.remove([K.pool, K.seen]);
    mem.pool = null; mem.seen = null;
  } else if (what === "all") {
    const keep = await chrome.storage.local.get(["gx.ops", "gx.txid"]);
    await chrome.storage.local.clear();
    await chrome.storage.local.set(keep);
    for (const k of Object.keys(mem)) mem[k] = k === "seenDirty" ? 0 : null;
    for (const k of Object.keys(cmem)) cmem[k] = null;
  }
  refreshBadge();
  return { ok: true };
}

async function importBackup(data) {
  if (!data || data.app !== "GrowX") return { ok: false, error: "That file isn't a GrowX backup." };
  const patch = {};
  const prevN = data.settings ? GX.normalizeSettings(await load(K.settings, {})) : null;
  if (data.settings) patch[K.settings] = GX.normalizeSettings(data.settings);
  if (Array.isArray(data.sources)) patch[K.sources] = data.sources.filter((x) => x && GX.cleanHandle(x.h)).map((x) => ({ ...x, pass: null, nextAt: 0 }));
  if (Array.isArray(data.blacklist)) patch[K.blacklist] = data.blacklist.map(String);
  if (Array.isArray(data.follows)) patch[K.follows] = data.follows.filter((f) => f && f.h);
  await save(patch);
  mem.sources = null; mem.blacklist = null; mem.follows = null; mem.fidx = null;
  // A backup can change who Follow back skips (verified only, inactive rule): everyone skipped under the old rules gets a fresh look.
  if (prevN && BK_RULES.some((k) => prevN[k] !== patch[K.settings][k])) await bkRulesChanged();
  // Comment mode travels with the backup: totals are merged upward, never lowered.
  if (data.comment) await cmtRestore(data.comment);
  return { ok: true };
}

async function emergencyStop() {
  const task = await load(K.task, null);
  if (task && task.status === "running") await endTask(task, "Stopped.");
  await controlJob("stop");
}

// ===========================================================================
// v3.2 Unfollowed page: follow again, and fresh numbers for the filters
// ===========================================================================
// Small changes to the unfollow log by user id, in one read-modify-write (the engine adds to the same list).
async function unlogPatch(patches) {
  const ids = Object.keys(patches || {});
  if (!ids.length) return 0;
  const arr = await load(K.unlog, []);
  if (!Array.isArray(arr)) return 0;
  let n = 0;
  for (const x of arr) if (x && patches[x.i]) { Object.assign(x, patches[x.i]); n++; }
  if (n) await save({ [K.unlog]: arr });
  return n;
}
// "Follow again": the accounts go to the very front of the Follow queue (pinned) and Follow mode follows them with
// all its own pacing, daily number, breaks and the X-refused plan. Nothing is followed outside those limits.
async function refollowQueue(ids) {
  ids = [...new Set((ids || []).map(String).filter((x) => /^\d+$/.test(x)))].slice(0, 2000);
  if (!ids.length) return { ok: false, error: "Nobody picked." };
  const arr = await load(K.unlog, []);
  const byId = new Map((Array.isArray(arr) ? arr : []).map((x) => [String(x.i), x]));
  const pool = await getPool();
  const inPool = new Set(pool.map((c) => String(c.i || "")));
  const following = await followingHandles();
  let added = 0, already = 0, queued = 0;
  const patch = {};
  const now = Date.now();
  for (const id of ids) {
    const x = byId.get(id);
    if (!x) continue;
    if (x.h && following.has(String(x.h).toLowerCase())) { already++; continue; }
    if (inPool.has(id)) { queued++; continue; }
    pool.push({ i: id, h: x.h || "", n: x.n || "", a: x.a || "", fc: x.fc, fr: x.fr, sc: x.sc, lt: x.lt, v: !!x.v, score: 99, qs: x.qs, src: "refollow", at: now, manual: true, pin: true, rf: 1 });
    inPool.add(id);
    patch[id] = { rq: now };
    added++;
  }
  sortPool(pool);
  await savePool();
  await unlogPatch(patch);
  if (added) await pushEvent("run", `Follow again: ${added} account${added === 1 ? "" : "s"} put at the front of the Follow queue. Follow mode follows them first, at your normal pace and daily number.`);
  const job = await load(K.job, null);
  const followRunning = job && ACTIVE.has(job.status) && jobMode(job) === "follow";
  return { ok: true, added, already, queued, followRunning };
}
// Reads the profiles of unfollowed accounts again (100 per request) so the filters can use real, current numbers:
// followers, following, verified, last post, posts, Quality score, and whether you follow them now.
let unlogRefreshing = false;
async function unlogRefresh(msg) {
  if (unlogRefreshing) return { ok: false, error: "Already reading - wait a moment." };
  const arr = await load(K.unlog, []);
  if (!Array.isArray(arr) || !arr.length) return { ok: true, done: 0 };
  const maxN = Math.min(3000, Number(msg && msg.max) || 1500);
  const want = (msg && Array.isArray(msg.ids) && msg.ids.length) ? new Set(msg.ids.map(String)) : null;
  const stale = Date.now() - 12 * HOUR;
  const ids = arr.filter((x) => x && x.i && (want ? want.has(String(x.i)) : !(x.ra > stale))).slice(0, maxN).map((x) => String(x.i));
  if (!ids.length) return { ok: true, done: 0, fresh: true };
  const got = await acquireTab(null, { create: true });
  if (!got) return { ok: false, error: "Couldn't open x.com." };
  unlogRefreshing = true;
  let done = 0, gone = 0;
  try {
    for (let i = 0; i < ids.length; i += 100) {
      const part = ids.slice(i, i + 100);
      const r = await sendTab(got.tabId, { gx: "uinfo", ids: part }, 45000);
      if (!r || !r.ok) { if (done) break; return { ok: false, error: (r && r.message) || "X didn't answer. Try again in a few minutes." }; }
      const now = Date.now(), patch = {};
      for (const id of part) {
        const m = (r.map || {})[id];
        if (!m) { patch[id] = { ra: now, gone: 1 }; gone++; continue; }
        patch[id] = { ra: now, gone: 0, fc: m.fc, fr: m.fr, v: m.v ? 1 : 0, lt: m.lt || null, sc: m.sc, ca: m.ca || null, qs: GX.qualityScore(m), fwNow: m.fw === true ? 1 : 0, fyNow: m.fy === true ? 1 : 0, n: m.n || undefined, a: m.a || undefined };
        if (!patch[id].n) delete patch[id].n;
        if (!patch[id].a) delete patch[id].a;
      }
      await unlogPatch(patch);
      done += part.length;
      if (i + 100 < ids.length) await sleep(rand(1500, 3200));
    }
  } finally { unlogRefreshing = false; }
  return { ok: true, done, gone, left: Math.max(0, ids.length - done) };
}

// ===========================================================================
// Messages
// ===========================================================================
const FETCH_ALLOWED = /^https:\/\/(abs(-\d+)?\.twimg\.com|x\.com|twitter\.com)\//;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || sender.id !== chrome.runtime.id) return;

  // From content scripts ------------------------------------------------
  if (msg.gx === "ready" && sender.tab) { resolveReady(sender.tab.id, msg.url || sender.tab.url); return; }
  if (msg.x7 === "fetchText") {
    if (typeof msg.url !== "string" || !FETCH_ALLOWED.test(msg.url)) { sendResponse({ ok: false, error: "blocked host" }); return; }
    fetch(msg.url, { credentials: "omit", cache: "force-cache" })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error("HTTP " + r.status))))
      .then((text) => sendResponse({ ok: true, text }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }

  // From the popup / dashboard (never from x.com) -----------------------
  const fromExtensionPage = typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
  if (typeof msg.cmd !== "string" || !fromExtensionPage) return;
  const run = async () => {
    switch (msg.cmd) {
      case "state": return uiState();
      // Start can name the mode to begin in (the Start button on a mode card),
      // otherwise the sequence or your selected mode decides, exactly as before.
      case "start": return startJob(GX.MODES.includes(msg.mode) ? msg.mode : undefined, "Start");
      case "pause": return controlJob("pause", msg);
      case "resumeAt": return controlJob("resumeAt", msg);
      case "resume": return controlJob("resume");
      case "stop": return controlJob("stop");
      case "harvestNow": return startTask("harvest");
      case "fbCheckNow": return startTask("fbcheck");
      case "taskStop": { const t = await load(K.task, null); if (t && t.status === "running") await endTask(t, "Stopped."); return { ok: true }; }
      case "addSources": return addSources(msg.handles);
      case "source": return sourceCmd(msg);
      case "pool": return poolCmd(msg);
      case "blacklist": {
        const list = [...new Set((msg.handles || []).map(GX.cleanHandle).filter(Boolean).map((h) => h.toLowerCase()))];
        await save({ [K.blacklist]: list });
        mem.blacklist = null;
        return { ok: true, count: list.length };
      }
      case "saveSettings": return saveSettings(msg.patch, { noStart: !!msg.noStart });
      case "cmt": return cmtCmd(msg);
      case "clearLog": { const j = await load(K.job, null); if (j) { j.log = []; await save({ [K.job]: j }); } await save({ [K.events]: [] }); return { ok: true }; }
      case "reset": return resetData(msg.what);
      case "importBackup": return importBackup(msg.data);
      case "health": return runHealth();
      case "refreshAccount": {
        const cur = await load(K.account, null);
        if (msg.ifOlder && cur && cur.id && Date.now() - (cur.at || 0) < msg.ifOlder) return { ok: true, account: cur, cached: true };
        const got = await acquireTab(null, { create: false });
        if (!got) return { ok: false, noTab: true };
        return { ok: true, account: await refreshAccount(got.tabId) };
      }
      case "openX": await openX(msg.path); return { ok: true };
      case "dashboard":
        chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html" + (msg.hash ? "#" + msg.hash : "")) });
        return { ok: true };
      // Everything GrowX knows, as rows the dashboard turns into a CSV or JSON file.
      case "export": return Object.assign({ ok: true }, await exportRows(String(msg.what || "history")));
      case "actlog": {
        const all = await actLogAll();
        return { ok: true, total: all.length, rows: all.slice(Number(msg.from) || 0, (Number(msg.from) || 0) + (Number(msg.limit) || 200)) };
      }
      case "actlogClear": { actMem = []; await save({ [K.actlog]: [] }); return { ok: true }; }

      case "refollow": return refollowQueue(msg.ids);
      case "unlogRefresh": return unlogRefresh(msg);
      case "unfReset": {
        const j = await load(K.job, null);
        if (j && ACTIVE.has(j.status)) { const c = (await load(K.ctl, null)) || {}; c.unfReset = true; await save({ [K.ctl]: c }); scheduleTick(500); }
        else { await chrome.storage.local.remove(K.unf); await pushEvent("run", "Unfollow: your following list will be read again from X."); }
        return { ok: true };
      }
      // ---- Unfollowed you: pick who goes to Unfollow mode ----
      case "lostSelect": {
        const meta = await load(K.meta, {});
        const owner = meta.ownerId;
        const l = await getLost(owner);
        const on = msg.on !== false;
        if (msg.all) {
          // Every account that can still be unfollowed (you follow them, not on your keep list, not done yet).
          const idx = await getFollowIndex();
          const keep = keepSet(await getRawSettings());
          for (const x of l.list) if (lostEligible(x, idx, keep)) x.sel = on ? 1 : 0;
        } else {
          const want = new Set((msg.ids || []).map(String));
          for (const x of l.list) if (want.has(x.i)) x.sel = on ? 1 : 0;
        }
        await saveLost(l);
        const sel = l.list.filter((x) => x.sel).length;
        // Picked while Unfollow mode is resting because nothing was due: look again straight away.
        const j = await load(K.job, null);
        if (sel && j && j.status === "resting" && j.restReason === "empty" && jobMode(j) === "unfollow") { j.restUntil = Date.now(); await save({ [K.job]: j }); }
        if (sel) scheduleTick(500);
        return { ok: true, selected: sel };
      }
      case "lostForget": {
        const meta = await load(K.meta, {});
        const l = await getLost(meta.ownerId);
        const drop = new Set((msg.ids || []).map(String));
        const before = l.list.length;
        l.list = msg.all ? [] : l.list.filter((x) => !drop.has(x.i));
        await saveLost(l);
        return { ok: true, removed: before - l.list.length };
      }
      case "bkReset": {
        const j = await load(K.job, null);
        if (j && ACTIVE.has(j.status)) { const c = (await load(K.ctl, null)) || {}; c.bkReset = true; await save({ [K.ctl]: c }); scheduleTick(500); }
        else { await chrome.storage.local.remove(K.bk); await pushEvent("run", "Follow back: your follower list will be read again from X."); }
        return { ok: true };
      }
      default: return { ok: false, error: "unknown command" };
    }
  };
  run().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true;
});

chrome.commands?.onCommand.addListener((command) => {
  if (command === "emergency-stop") emergencyStop();
});

// ===========================================================================
// Install / update / startup
// ===========================================================================
async function migrateLegacy() {
  const meta = await load(K.meta, {});
  if (meta.migrated21) return;
  try {
    // Earlier X Follow Manager builds: carry over their target accounts as
    // sources, then remove their leftover run state so nothing old resumes.
    const sync = await chrome.storage.sync.get(null).catch(() => ({}));
    const old = String(sync.targetAccounts || "").split(/[\s,]+/).map(GX.cleanHandle).filter(Boolean);
    if (old.length && !(await load(K.sources, null))) await addSources(old);
    const local = await chrome.storage.local.get(null).catch(() => ({}));
    const legacy = Object.keys(local).filter((k) => /^(xfm|x7\.)/.test(k) || ["lastProgressState", "queueState", "unfollowState", "workerTabId", "workerWindowId", "workerTabOwned", "tabHealth", "progressAt", "followedProfiles", "unfollowedProfiles", "sessionHistory", "dailyFollowCount", "onboardingDismissed", "dashboardDarkMode"].includes(k));
    if (legacy.length) await chrome.storage.local.remove(legacy);
    await chrome.storage.sync.clear().catch(() => {});
    try { indexedDB.deleteDatabase("xfm-manager-local-v2"); } catch (_) {}
  } catch (e) {
    console.warn("[gx] migration skipped:", e);
  }
  meta.migrated21 = true;
  meta.installedAt = meta.installedAt || Date.now();
  await save({ [K.meta]: meta });
}

async function injectIntoOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: X_URLS });
    for (const t of tabs) {
      if (t.discarded || t.status !== "complete") continue;
      chrome.scripting.executeScript({ target: { tabId: t.id }, files: CS_FILES }).catch(() => {});
    }
  } catch (_) {}
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await migrateLegacy();
  injectIntoOpenTabs();
  setBadge("");
  if (details.reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html#welcome") }).catch(() => {});
  // An update replaces the worker mid-run; pick the run back up.
  resumeOnWake();
});

// After a browser restart the run continues by itself (unless you turned
// that off): GrowX is meant to keep running until you press Stop.
chrome.runtime.onStartup.addListener(async () => {
  const s = await getSettings();
  const job = await load(K.job, null);
  if (job && ACTIVE.has(job.status)) {
    job.tabId = null; job.workerTabId = null; job.ownTab = false; job.inFlight = null;
    if (s.autoResume) {
      job.nextAt = Math.max(job.nextAt || 0, Date.now() + 20000);
      job.message = "Continuing after the browser restarted...";
      logLine(job, "", "wait", "browser restarted - continuing");
    } else {
      job.status = "paused";
      job.message = "Paused because the browser restarted. Press Resume to continue.";
    }
    await save({ [K.job]: job });
  }
  const task = await load(K.task, null);
  if (task && task.status === "running") { task.tabId = null; task.ownTab = false; await save({ [K.task]: task }); }
  resumeOnWake();
});

async function resumeOnWake() {
  const job = await load(K.job, null);
  const task = await load(K.task, null);
  if (job && job.inFlight && Date.now() - job.inFlight.at > 120000) {
    job.inFlight = null;
    if (jobMode(job) === "followback") job.bSince = (job.bSince || 0) + 1; else if (jobMode(job) === "follow") job.sinceRest = (job.sinceRest || 0) + 1;
    await save({ [K.job]: job });
  }
  if ((task && task.status === "running") || (job && ACTIVE.has(job.status))) {
    if (job && ACTIVE.has(job.status)) { const s = await getSettings(); if (s.keepAwake) syncPower(true); }
    scheduleTick(1500);
  }
  refreshBadge();
}

resumeOnWake();
