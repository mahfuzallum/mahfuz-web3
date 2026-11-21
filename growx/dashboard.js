// GrowX - dashboard
(function () {
  "use strict";
  const { $, $$ } = U;
  const K = GX.K;
  const HOUR = 3600000, DAY = 86400000;
  const TITLES = { overview: "Overview", sources: "Sources", queue: "Queue", targeting: "Targeting", autopilot: "Autopilot & Safety", history: "History", followedback: "Followed back", unfollowed: "Unfollowed", lost: "Unfollowed you", comment: "Comment", cmthistory: "Comment history", analytics: "Analytics", settings: "Settings", help: "Help", donate: "Donate" };
  const PACE_KEYS = ["minDelay", "maxDelay", "restEveryMin", "restEvery", "restMinutes", "restMinutesMax", "hourlyLimit", "dailyLimit", "sessionTarget", "maxRunHours", "restDays"];
  const UNF_KEYS = ["unfollowDaily", "unfMinDelay", "unfMaxDelay", "unfRestEveryMin", "unfRestEvery", "unfRestMinutes", "unfRestMinutesMax", "unfHourlyLimit"];
  const BK_KEYS = ["bkDaily", "bkMinDelay", "bkMaxDelay", "bkRestEveryMin", "bkRestEvery", "bkRestMinutes", "bkRestMinutesMax", "bkHourlyLimit"];
  const MODE_NAME = { follow: "Follow", unfollow: "Unfollow", followback: "Follow back", comment: "Comment" };
  const modeOf = (s) => (s && GX.MODES.includes(s.runMode) ? s.runMode : "follow");
  const jobMode = (job) => (job ? (GX.MODES.includes(job.runMode) ? job.runMode : GX.MODES.includes(job.mode) ? job.mode : "follow") : "follow");
  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const ACTIVE_JOB = new Set(["running", "resting", "sleeping"]);
  // The hourly number a mode really runs with: Auto = worked out from the day's number, the hours, the delays and the breaks;
  // otherwise the number you typed. (follow-back: its own count; the shared one is st.limits.hourly / hourOf(s, "follow").)
  const hourOf = (s, mode) => GX.hourlyCap(s, GX.MODES.includes(mode) ? mode : "follow").cap;
  // Did X's refusals stop this mode's family for today (Follow + Follow back share one, Unfollow has its own)?
  const stopped = (mode) => (mode === "unfollow" ? !!(st && st.uLimited) : !!(st && st.xLimited));
  const LAD_PRE = { follow: "refuse", followback: "bkRefuse", unfollow: "unfRefuse" };       // step 1 = <pre>0*, step 2 = <pre>1*, step 3 = <pre>2*
  const fmtMin = (m) => (m < 90 ? `${Math.round(m)} min` : `${Math.round(m / 6) / 10} h`);

  let st = null;
  let route = "overview";
  const ui = { feed: "log", qSort: "score", qShow: 100, hShow: 100, hFilter: "all", lostShow: 100, lostFilter: "elig", sel: new Set(), dirty: {}, phase: { key: "", start: 0 }, html: {} };
  const cache = { pool: null, follows: null, growth: null, blacklist: null, lost: null };

  // =====================================================================
  // boot
  // =====================================================================
  function init() {
    U.icons();
    U.themeButtons();
    $("#version").textContent = "v" + chrome.runtime.getManifest().version;
    $("#year").textContent = String(new Date().getFullYear());

    window.GXD = { ctlButtons, pauseTimer, refresh };
  window.addEventListener("hashchange", go);
    $("#menuBtn").addEventListener("click", () => document.body.classList.toggle("menu-open"));
    document.addEventListener("click", (e) => {
      if (document.body.classList.contains("menu-open") && !e.target.closest(".side") && !e.target.closest("#menuBtn")) document.body.classList.remove("menu-open");
    });
    document.addEventListener("click", onRunControl);
    document.addEventListener("click", onPauseTimer);

    wireSources();
    wireQueue();
    wireForms();
    wireHistory();
    wireUnfollowed();
    wireLostPage();
    wireFollowedBack();
    wireAnalytics();
    wireSettings();
    wireDonate();
    wireWelcome();
    if (window.GXC) GXC.init();
    $("#feedSeg").addEventListener("click", (e) => {
      const b = e.target.closest("[data-feed]");
      if (!b) return;
      ui.feed = b.dataset.feed;
      $$("#feedSeg button").forEach((x) => x.classList.toggle("on", x === b));
      ui.html.feed = "";
      renderFeed();
    });

    U.watch([K.pool], () => { cache.pool = null; if (route === "queue" || route === "targeting") renderPage(); });
    U.watch([K.follows], () => { cache.follows = null; if (["history", "analytics", "lost"].includes(route)) renderPage(); });
    U.watch([K.lost], () => { cache.lost = null; if (route === "lost") renderPage(); });
    U.watch([K.growth], () => { cache.growth = null; ui.html.chart = ""; });
    U.watch([K.job, K.task, K.sources, K.account, K.events], debounce(refresh, 120));

    go();
    refresh().then(() => { if (st && (!st.account || Date.now() - (st.account.at || 0) > 10 * 60000)) U.cmd("refreshAccount", { ifOlder: 5 * 60000 }).then(refresh); });
    setInterval(refresh, 1500);
    setInterval(tickLocal, 250);
  }

  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  function go() {
    let h = (location.hash || "#overview").slice(1);
    if (h === "welcome") { showWelcome(); history.replaceState(null, "", "#overview"); h = "overview"; }
    if (h === "wallets" || h === "helpfree") { route = "donate"; showRoute(); setTimeout(() => { const el = document.getElementById(h); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); }, 60); return; }
    if (!TITLES[h]) h = "overview";
    route = h;
    showRoute();
  }

  function showRoute() {
    $$(".page").forEach((p) => p.classList.toggle("on", p.dataset.page === route));
    $$("#nav a").forEach((a) => a.classList.toggle("on", a.dataset.route === route));
    $("#topTitle").textContent = TITLES[route];
    document.title = TITLES[route] + " · GrowX - Unlimited Auto Follow for X/Twitter";
    document.body.classList.remove("menu-open");
    window.scrollTo({ top: 0 });
    ui.html = {};
    if (st) {
      for (const f of FORM_ROUTES[route] || []) if (!ui.dirty[f]) fillForm(f);
      renderPage();
    }
  }

  // Mode tiles (Autopilot page) and the switch in the Overview hero: one click saves and applies the mode at once.
  document.addEventListener("click", (ev) => {
    const b = ev.target.closest && ev.target.closest("#modeSeg [data-mode], #ovChips [data-ovmode]");
    if (!b) return;
    setMode(b.dataset.mode || b.dataset.ovmode);
  });
  document.addEventListener("click", async (ev) => {
    if (!ev.target.closest || !ev.target.closest("#unfReset")) return;
    if (!confirm("Read your following list from X again and rebuild the old-unfollow list?")) return;
    const r = await U.cmd("unfReset");
    U.toast(r.ok ? "GrowX reads your list again on its next step." : (r.error || "Couldn't reset."), r.ok ? "good" : "bad");
    refresh();
  });
  document.addEventListener("click", async (ev) => {
    if (!ev.target.closest || !ev.target.closest("#bkReset")) return;
    if (!confirm("Read who follows you and who you follow from X again, and rebuild the Follow back list?")) return;
    const r = await U.cmd("bkReset");
    U.toast(r.ok ? "GrowX reads your followers again on its next step." : (r.error || "Couldn't reset."), r.ok ? "good" : "bad");
    refresh();
  });

  async function refresh() {
    if (ui.modeBusy) return;
    const r = await U.cmd("state");
    if (!r || !r.ok || ui.modeBusy) return;
    const first = !st;
    st = r;
    if (first) for (const f of FORM_ROUTES[route] || []) fillForm(f);
    renderCommon();
    renderPage();
  }

  function renderPage() {
    if (!st) return;
    ({ overview: renderOverview, sources: renderSources, queue: renderQueue, targeting: renderTargeting, autopilot: renderAutopilot, history: renderHistory, followedback: renderFollowedBack, unfollowed: renderUnfollowed, lost: renderLost, analytics: renderAnalytics, settings: renderSettings })[route]?.();
    if (route === "autopilot") renderGuard();
    if (window.GXC) GXC.render(route, st);
  }

  const setHtml = (key, el, html) => { if (el && ui.html[key] !== html) { el.innerHTML = html; ui.html[key] = html; U.icons(el); } };

  // =====================================================================
  // RECORDS & EXPORT - every action, and every list, in a file you can keep
  // =====================================================================
  // Every list GrowX can hand you, with the name each file gets. The engine
  // builds the rows; this only says what they are called and where they appear.
  const EXPORTS = [
    ["unfollowed", "Unfollowed accounts", "mutual and non-mutual, with the reason for each"],
    ["following",  "Accounts you follow", "when you followed them, and whether they followed back"],
    ["followers",  "Your followers",      "everyone GrowX has seen following you"],
    ["mutuals",    "Mutuals",             "the accounts that follow you back - never unfollowed"],
    ["comments",   "Replies",             "every reply GrowX wrote, with the post it went on"],
    ["history",    "Everything GrowX did", "every follow, unfollow, follow-back and reply in one file"]
  ];

  // The rows are built HERE, in the page, straight from chrome.storage - the
  // same place the History page has always read. Nothing waits on the service
  // worker, which may be asleep, so a download can never come back empty-handed.
  const xLink = (h, i) => (h ? "https://x.com/" + String(h).replace(/^@/, "") : i ? "https://x.com/i/user/" + i : "");
  const iso = (t) => (t ? new Date(t).toISOString() : "");

  async function buildExport(what) {
    const follows = await U.get(K.follows, []);
    const book = new Map();
    const put = (i, h, n) => { if (i && h && !book.has(String(i))) book.set(String(i), { h: String(h).replace(/^@/, ""), n: n || "" }); };
    const unlog = (await U.get(K.unlog, [])) || [];
    const bklog = (await U.get(K.bklog, [])) || [];
    const lost = (await U.get(K.lost, null)) || {};
    for (const f of follows) put(f.i, f.h, f.n);
    for (const x of bklog) put(x.i, x.h, x.n);
    for (const x of unlog) put(x.i, x.h, x.n);
    for (const x of (lost.list || [])) put(x.i, x.h, x.n);
    const nameOf = (i) => book.get(String(i)) || { h: "", n: "" };

    if (what === "unfollowed") return { name: "unfollowed",
      header: ["handle", "link", "name", "user_id", "was_following_you", "mutual", "why", "unfollowed_at", "quality_score", "followers", "last_post", "followed_again_at"],
      rows: unlog.map((x) => { const h = x.h || nameOf(x.i).h;
        return [h, xLink(h, x.i), x.n || nameOf(x.i).n, x.i || "", x.k === "fb" ? "yes" : "no", x.k === "fb" ? "mutual" : "not mutual", x.w || "", iso(x.t), x.qs == null ? "" : x.qs, x.fc == null ? "" : x.fc, x.lt ? iso(x.lt) : "", x.rf ? iso(x.rf) : ""]; }) };

    if (what === "following") return { name: "following",
      header: ["handle", "link", "name", "user_id", "source", "score", "followed_at", "followed_you_back", "followed_back_at", "unfollowed_you_at", "state"],
      rows: follows.slice().reverse().map((x) => [x.h || "", xLink(x.h, x.i), x.n || "", x.i || "", x.s || "", x.sc || "", iso(x.t),
        x.fb ? "yes" : "no", iso(x.fb), iso(x.lost),
        x.nf ? "you unfollowed them" : x.p ? "follow request sent" : x.lost ? "they unfollowed you" : x.fb ? "mutual" : "waiting for a follow-back"]) };

    if (what === "followers") {
      const bk = (await U.get(K.bk, null)) || {};
      const ids = new Set([...(bk.followers || []), ...((await U.get(K.known, [])) || [])].map(String));
      const byId = new Map(follows.filter((f) => f.i).map((f) => [String(f.i), f]));
      for (const f of follows) if (f.i && f.fb && !f.lost) ids.add(String(f.i));
      const waiting = new Set((bk.list || []).map(String));
      return { name: "followers", header: ["handle", "link", "name", "user_id", "you_follow_them", "state"],
        rows: [...ids].map((i) => { const b = nameOf(i), f = byId.get(i), you = !!(f && !f.nf);
          return [b.h, xLink(b.h, i), b.n, i, you ? "yes" : "no",
            you ? "mutual" : waiting.has(i) ? "waiting in the Follow back list" : "follows you, you do not follow them"]; }) };
    }

    if (what === "mutuals") return { name: "mutuals",
      header: ["handle", "link", "name", "user_id", "score", "you_followed_at", "they_followed_back_at"],
      rows: follows.filter((f) => f.fb && !f.lost && !f.nf).map((f) => [f.h || "", xLink(f.h, f.i), f.n || "", f.i || "", f.sc || "", iso(f.t), iso(f.fb)]) };

    const log = (await U.get(K.actlog, [])) || [];
    if (what === "comments") return { name: "comments",
      header: ["when", "handle", "link", "what", "reply", "post", "model", "cost_usd", "why"],
      rows: log.filter((e) => e.m === "comment").map((e) => { const x = e.x || {};
        return [iso(e.t), e.h, xLink(e.h, e.i), e.a, x.text || "", x.post || "", x.model || "", x.cost == null ? "" : x.cost, e.w || ""]; }) };

    return { name: "history", header: ["when", "mode", "action", "handle", "link", "user_id", "worked", "why", "detail"],
      rows: log.map((e) => [iso(e.t), e.m, e.a, e.h, xLink(e.h, e.i), e.i, e.ok ? "yes" : "no", e.w || "",
        e.x ? (typeof e.x === "string" ? e.x : JSON.stringify(e.x)) : ""]) };
  }

  // One list -> one file. `kind` is "csv" or "json".
  async function download(what, kind, quiet) {
    let r;
    try {
      r = await buildExport(what);
    } catch (e) {
      // Reading storage failed: ask the worker instead, and if that fails too,
      // say what went wrong rather than doing nothing.
      r = await U.cmd("export", { what });
      if (!r || !r.ok) { U.toast(`Couldn't build that file: ${(r && r.error) || (e && e.message) || e}`, "bad", 7000); return 0; }
    }
    const day = new Date().toISOString().slice(0, 10);
    try {
      if (kind === "json") {
        const objs = r.rows.map((row) => Object.fromEntries(r.header.map((h, i) => [h, row[i]])));
        U.download(`growx-${r.name}-${day}.json`, JSON.stringify({ list: r.name, at: new Date().toISOString(), count: objs.length, rows: objs }, null, 2), "application/json");
      } else {
        U.download(`growx-${r.name}-${day}.csv`, U.csv(r.header, r.rows));
      }
    } catch (e) {
      U.toast(`The file could not be saved: ${(e && e.message) || e}`, "bad", 7000);
      return 0;
    }
    if (!quiet) U.toast(r.rows.length ? `${U.fmt(r.rows.length)} row${r.rows.length === 1 ? "" : "s"} downloaded.` : "That list is empty - the file was still saved.", r.rows.length ? "good" : "warn");
    return r.rows.length;
  }

  // Every list at once, as separate files - a browser will not take six
  // downloads in the same instant, so they go a few hundred ms apart.
  async function downloadAll(kind) {
    U.toast(`Saving ${EXPORTS.length} files…`, "good");
    let total = 0;
    for (const [k] of EXPORTS) {
      total += await download(k, kind, true);
      await new Promise((r) => setTimeout(r, 500));
    }
    U.toast(`${EXPORTS.length} files saved · ${U.fmt(total)} rows in all.`, "good", 5000);
  }

  // The guard says plainly what it is doing, and the two switches it overrules
  // are shown as overruled rather than quietly ignored.
  function renderGuard() {
    const s = st && st.settings;
    if (!s) return;
    const on = GX.unfProtect(s);
    const el = $("#unfGuardLive");
    if (el) {
      el.textContent = on
        ? `On. Nobody who follows you back will be unfollowed${s.unfInactive ? " - U5 below cannot override this while it is on." : "."}${s.unfStopWhenEmpty ? " When nothing is left that may be unfollowed, GrowX stops and tells you." : ""}`
        : `Off. ${s.unfInactive ? "U5 may unfollow followers who have not posted in " + s.unfInactiveDays + " days. Active followers and big / good accounts are still never unfollowed." : "Active followers are still never unfollowed."}${s.unfStopWhenEmpty ? " When nothing is left, GrowX stops and tells you." : ""}`;
      el.classList.toggle("warn", !on);
    }
    U.$$('[data-for="unfollow"] .fs-head').forEach((h) => {
      const k = h.querySelector("[data-k]");
      const over = on && k && ["unfInactive"].includes(k.dataset.k);
      h.closest(".card")?.classList.toggle("overruled", !!over);
    });
    const gc = U.$(".guard-card");
    if (gc) gc.classList.toggle("guard-off", !on);
  }

  async function getPool() { if (!cache.pool) cache.pool = await U.get(K.pool, []); return cache.pool; }
  async function getFollows() { if (!cache.follows) cache.follows = await U.get(K.follows, []); return cache.follows; }
  async function getGrowth() { if (!cache.growth) cache.growth = await U.get(K.growth, []); return cache.growth; }

  // =====================================================================
  // run controls (popup-style buttons anywhere: [data-run])
  // =====================================================================
  // How long a pause lasts, offered as one tap. "Custom" opens a box for any number of minutes.
  // Quick lengths on the pause panel. "Tomorrow 9 AM" is worked out when it is clicked.
  const PAUSE_MINS = [[15, "15m"], [30, "30m"], [60, "1h"], [120, "2h"]];

  // The pause panel: shown ONLY while paused, in the header, the Overview card,
  // the sidebar and the popup. Three ways to say when GrowX comes back - after N
  // minutes, at a time of day, or not until you press Resume - plus the live
  // countdown and -5 / +5.
  // The panel is drawn in more than one place at once (the sidebar, the Overview card,
  // the Comment page), so each copy gets its own radio group - with a name that stays the
  // same between redraws, or the panel would rebuild itself under your fingers.
  function pauseTimer(big, where) {
    const j = st.job;
    if (!j || j.status !== "paused") return "";
    const grp = "ppMode-" + (where || (big ? "hero" : "side"));
    const at = Number(j.resumeAt) || 0, now = Date.now();
    const live = at > now;
    const mins = live ? Math.max(1, Math.round((at - now) / 60000)) : 30;
    const t = new Date(live ? at : now + 30 * 60000);
    const hhmm = String(t.getHours()).padStart(2, "0") + ":" + String(t.getMinutes()).padStart(2, "0");
    const tomorrow = !live ? "" : (new Date(at).toDateString() !== new Date().toDateString() ? "tomorrow " : "");
    const chips = PAUSE_MINS.map(([m, l]) => `<button type="button" data-pause-mins="${m}">${l}</button>`).join("")
      + `<button type="button" data-pause-tomorrow="9">Tomorrow 9 AM</button>`;
    return `<div class="pause-panel${big ? " big" : ""}">
      <div class="pp-head">When should GrowX start again?</div>
      <label class="pp-opt"><input type="radio" name="${grp}" value="mins"${live ? " checked" : ""}>
        <span>Resume after</span><input class="input num pp-in" type="number" min="1" max="1440" value="${mins}" data-pause-input><span>min</span></label>
      <label class="pp-opt"><input type="radio" name="${grp}" value="at">
        <span>Resume at</span><input class="input pp-time" type="time" value="${hhmm}" data-pause-at></label>
      <label class="pp-opt"><input type="radio" name="${grp}" value="never"${live ? "" : " checked"}>
        <span>Stay paused until I press Resume</span></label>
      <div class="pp-chips">${chips}</div>
      <div class="pp-live">${live
        ? `<span>Starts again at <b>${tomorrow}${U.clock(at)}</b> ·</span><b class="pt-left" data-until="${at}">${U.countdown(at - now)}</b> left
           <button class="btn btn-ghost" type="button" data-pause-add="-5">-5m</button>
           <button class="btn btn-ghost" type="button" data-pause-add="5">+5m</button>
           <button class="btn btn-ghost" type="button" data-pause-mins="0">Clear</button>`
        : `<span>No timer - it waits for you.</span>`}</div>
    </div>`;
  }

  function ctlButtons(style) {
    const where = style || "side";
    const v = U.jobView(st.job, st.task);
    const hasSrc = (st.sources || []).some((x) => x.enabled && !["gone", "private"].includes(x.status));
    const big = style === "hero";
    const primary = big ? "btn btn-white btn-lg" : "btn btn-primary btn-sm";
    const second = big ? "btn btn-glass btn-lg" : "btn btn-sm";
    const b = (run, cls, icon, label) => `<button class="${cls}" data-run="${run}">${U.icon(icon)}<span>${label}</span></button>`;
    if (v.active) return b("pause", primary, "pause", "Pause") + b("stop", second, "stop", "Stop");
    if (v.paused) return b("resume", primary, "play", "Resume") + b("stop", second, "stop", "Stop") + pauseTimer(big, where);
    if (v.halted) return b("resume", primary, "play", "Resume") + b("stop", second, "stop", "Stop");
    if (v.task) return b("start", primary, "rocket", "Start autopilot") + b("taskStop", second, "stop", big ? "Stop search" : "Stop");
    return b("start", primary, "rocket", big ? "Start autopilot" : "Start") + (big && hasSrc ? b("harvest", second, "search", "Find people now") : "");
  }

  // Setting the pause timer - the engine starts itself again when it runs out.
  // A time that has already gone past today means tomorrow.
  function minsUntilClock(hhmm) {
    const [h, m] = String(hhmm || "").split(":").map(Number);
    if (!Number.isFinite(h)) return null;
    const d = new Date();
    d.setHours(h, m || 0, 0, 0);
    if (d.getTime() <= Date.now() + 30000) d.setDate(d.getDate() + 1);
    return Math.max(1, Math.round((d.getTime() - Date.now()) / 60000));
  }
  async function setPause(mins, why) {
    const r = await U.cmd("resumeAt", { mins });
    if (!r || !r.ok) return U.toast((r && r.error) || "Couldn't set the timer.", "bad");
    U.toast(r.resumeAt ? `Paused - GrowX starts again at ${U.clock(r.resumeAt)}${why ? " " + why : ""}.` : "Timer cleared - it stays paused until you press Resume.", "good");
    refresh();
  }
  async function onPauseTimer(e) {
    const panel = e.target.closest && e.target.closest(".pause-panel");
    if (!panel) return;
    const el = e.target;
    const chip = el.closest("[data-pause-mins]");
    if (chip) return setPause(Number(chip.dataset.pauseMins));
    const tom = el.closest("[data-pause-tomorrow]");
    if (tom) {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(Number(tom.dataset.pauseTomorrow) || 9, 0, 0, 0);
      return setPause(Math.round((d.getTime() - Date.now()) / 60000), "tomorrow");
    }
    const add = el.closest("[data-pause-add]");
    if (add) {
      const at = (st.job && st.job.resumeAt) || 0;
      const left = Math.round((at - Date.now()) / 60000) + Number(add.dataset.pauseAdd);
      return setPause(Math.max(1, Math.min(1440, left)));
    }
    const opt = el.closest("label.pp-opt");
    if (!opt) return;
    const radio = opt.querySelector('input[type="radio"]');
    if (!radio) return;
    if (el.matches("input[data-pause-input], input[data-pause-at]")) { radio.checked = true; return; }
    radio.checked = true;
    if (radio.value === "never") return setPause(0);
    if (radio.value === "mins") {
      const n = Math.round(Number(panel.querySelector("[data-pause-input]").value));
      if (!Number.isFinite(n) || n < 1 || n > 1440) return U.toast("Give a number of minutes between 1 and 1440 (24 h).", "bad");
      return setPause(n);
    }
    const mins = minsUntilClock(panel.querySelector("[data-pause-at]").value);
    if (mins == null) return U.toast("Pick a time first.", "bad");
    return setPause(mins, mins > 1440 - 60 ? "" : "");
  }
  // The number and the time field apply on Enter or when you leave them.
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (!el.closest || !el.closest(".pause-panel")) return;
    if (el.matches("[data-pause-input]")) {
      const n = Math.round(Number(el.value));
      if (Number.isFinite(n) && n >= 1 && n <= 1440) setPause(n);
    } else if (el.matches("[data-pause-at]")) {
      const mins = minsUntilClock(el.value);
      if (mins != null) setPause(mins);
    }
  });

  async function onRunControl(e) {
    const btn = e.target.closest("[data-run]");
    if (!btn) return;
    const act = btn.dataset.run;
    btn.disabled = true;
    let r;
    if (act === "start") r = await U.cmd("start");
    else if (act === "harvest") r = await U.cmd("harvestNow");
    else if (act === "taskStop") r = await U.cmd("taskStop");
    else if (act === "stop") {
      const ok = await confirmBox({ title: "Stop the autopilot?", body: "GrowX finishes the current request and stops. Your queue, sources and history are kept - press Start any time to continue.", ok: "Stop", icon: "stop" });
      if (!ok) { btn.disabled = false; return; }
      r = await U.cmd("stop");
    } else r = await U.cmd(act);
    btn.disabled = false;
    if (!r || !r.ok) {
      U.toast((r && r.error) || "Something went wrong.", "bad", 4500);
      if (r && r.needSources) location.hash = "#sources";
    } else if (act === "pause") U.toast(r.resumeAt ? `Paused - GrowX starts again by itself at ${U.clock(r.resumeAt)}.` : "Paused. Set a timer below, or press Resume when you want it back.", "good", 4500);
    else if (act === "start") U.toast("Autopilot started. It keeps running in the background - you can close this page.", "good", 4500);
    else if (act === "harvest") U.toast(r.viaJob ? "Looking for more people now." : "Finding people likely to follow back...", "good");
    refresh();
  }

  function confirmBox({ title, body, ok, icon }) {
    return new Promise((resolve) => {
      const m = $("#confirm");
      $("#cfTitle").textContent = title;
      $("#cfBody").textContent = body;
      $("#cfOk").querySelector("span").textContent = ok || "Confirm";
      const ic = $("#cfIcon");
      ic.innerHTML = U.icon(icon || "alert");
      m.hidden = false;
      const done = (v) => { m.hidden = true; $("#cfOk").onclick = $("#cfCancel").onclick = m.onclick = null; resolve(v); };
      $("#cfOk").onclick = () => done(true);
      $("#cfCancel").onclick = () => done(false);
      m.onclick = (e) => { if (e.target === m) done(false); };
    });
  }

  // =====================================================================
  // shared chrome: sidebar + topbar
  // =====================================================================
  // With a sequence running, the tiles no longer decide where a run begins - say so plainly, right there.
  function renderModeSeqNote() {
    const el = $("#msSeqNote");
    if (!el) return;
    const sq = st.seq || {};
    el.hidden = false;
    el.classList.toggle("off", !sq.cycling);
    if (!sq.cycling) {
      const why = !sq.on ? "" : (sq.order || []).length < 2 ? " (fewer than two modes are left in it)" : "";
      const off = `<b>Mode sequence: OFF${why}.</b> GrowX runs only the mode you pick here and stops when its target is reached. Turn it on in the <a href="#autopilot">Mode sequence</a> card below to work through your modes one after another.`;
      if (el.dataset.html !== off) { el.innerHTML = off; el.dataset.html = off; }
      return;
    }
    const order = (sq.order || []).map((m) => MODE_NAME[m]).join(" → ");
    const html = sq.running
      ? `<b>Mode sequence: ON.</b> Running <b>${MODE_NAME[sq.running]}</b> now · order: ${order}${sq.next ? " · next: <b>" + MODE_NAME[sq.next] + "</b>" : ""}.`
      : sq.trans
      ? `<b>Mode sequence: ON.</b> On a transition break · <b>${MODE_NAME[sq.trans.to]}</b> starts at ${U.clock(sq.trans.until)}.`
      : sq.startAt
      ? `<b>Mode sequence: ON</b>, so the sequence picks the mode, not these tiles. <b>Start</b> begins with <b>${MODE_NAME[sq.startAt]}</b> · order: ${order}.`
      : `<b>Mode sequence: ON</b>, but every mode in it is finished for today - it starts again tomorrow.`;
    if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
  }

  function renderCommon() {
    const v = U.jobView(st.job, st.task);
    for (const [pill, text] of [["#sidePill", "#sidePillText"], ["#topPill", "#topPillText"]]) {
      $(pill).className = "pill " + v.cls;
      $(text).textContent = v.label;
    }
    const sm = modeOf(st.settings), nu = modeNumbers();
    document.body.classList.toggle("m-unf", sm === "unfollow");
    document.body.classList.toggle("m-bk", sm === "followback");
    if (window.GXC) GXC.common(st);
    const sDone = nu.done, sMax = nu.max;
    $("#sideToday").textContent = `${sDone}/${sMax}`;
    $("#sideToday").title = `${nu.Noun} today`;
    $("#sideBar").classList.toggle("is-live", v.active && st.job && st.job.status === "running");
    $("#sideBar").firstElementChild.style.width = Math.min(100, sDone / Math.max(1, sMax) * 100) + "%";
    $("#sideMsg").textContent = engineMessage();
    setHtml("sideCtl", $("#sideCtl"), ctlButtons("side"));
    const nSrc = (st.sources || []).length;
    $("#navSrc").hidden = !nSrc; $("#navSrc").textContent = nSrc;
    $("#navQueue").hidden = !st.poolCount; $("#navQueue").textContent = U.compact(st.poolCount);
    const unTot = unfAll(st.unf);
    $("#navUnf").hidden = !unTot; $("#navUnf").textContent = U.compact(unTot);
    const bkTot = st.bk ? st.bk.all || 0 : 0;
    $("#navBk").hidden = !bkTot; $("#navBk").textContent = U.compact(bkTot);
    // "Unfollowed you": the badge shows what is picked for Unfollow mode, otherwise how many can be.
    const lo = st.lost || {};
    const loN = lo.sel || lo.elig || lo.total || 0;
    const loEl = $("#navLost");
    if (loEl) { loEl.hidden = !loN; loEl.textContent = U.compact(loN); loEl.className = lo.sel ? "on" : ""; }
    renderModeSeqNote();
  }

  function engineMessage() {
    const job = st.job, task = st.task;
    if (job && ["running", "resting", "sleeping", "paused", "halted"].includes(job.status)) return job.message || "";
    if (task && task.status === "running") return task.message || "";
    if (!(st.account && st.account.id)) return "Sign in to X in this browser to begin.";
    const m = modeOf(st.settings);
    if (m !== "follow") {
      if (job && job.message && job.status === "done" && jobMode(job) === m) return job.message;
      const b = st.bk || {};
      if (m === "comment") {
        const c = st.cmt || {};
        if (!c.hasKey) return "Comment mode is selected. Add your OpenAI key in Comment settings to begin.";
        return `Comment mode is selected${c.open ? ` · ${U.fmt(c.open)} posts waiting` : ""}. Press Start - or it starts by itself in its hours.`;
      }
      return m === "unfollow" ? "Unfollow mode is selected. Press Start - or it starts by itself in its hours."
        : `Follow back mode is selected${b.stage === "ready" ? ` · ${U.fmt(b.left)} followers waiting` : ""}. Press Start - or it starts by itself in its hours.`;
    }
    if (!(st.sources || []).length) return "Add a few source profiles to start growing.";
    if (job && job.message && jobMode(job) === "follow") return job.message;
    return `${U.fmt(st.poolCount)} people ready. Press Start - GrowX runs in the background.`;
  }

  // =====================================================================
  // MODES: Follow / Unfollow / Follow back (one runs at a time; a click applies at once)
  // =====================================================================
  // The numbers of the selected mode (today, daily number, this hour, hourly cap).
  function modeNumbers() {
    const s = st.settings, m = modeOf(s), L = st.limits || {};
    if (m === "comment") { const c = st.cmt || {}; return { m, Noun: "Replies", done: c.today || 0, max: c.goal || s.cmtDaily, hour: c.hour || 0, hourMax: c.hourCap || s.cmtHourlyLimit }; }
    if (m === "unfollow") return { m, Noun: "Unfollows", done: (st.unf && st.unf.today) || 0, max: s.unfollowDaily, hour: (st.unf && st.unf.hour) || 0, hourMax: hourOf(s, "unfollow") };
    if (m === "followback") {
      const bt = (st.bk && st.bk.today) || 0;
      const room = Math.max(0, (L.daily || 0) - (st.today || 0));          // X's follow limit is shared with Follow mode
      return { m, Noun: "Follow-backs", done: bt, max: Math.min(s.bkDaily, bt + room), hour: (st.bk && st.bk.hour) || 0, hourMax: s.hourlyAuto ? (L.hourly || hourOf(s, "followback")) : s.bkHourlyLimit };
    }
    return { m, Noun: "Follows", done: st.today || 0, max: L.daily || 0, hour: st.hour || 0, hourMax: L.hourly || 0 };
  }

  // The pace fields (delays, breaks, hourly cap) of the selected mode, under the names Follow mode uses (for the plan + estimates).
  // "12-15" (or "15" when both are the same): follows before a break
  const batchTxt = (lo, hi) => (lo && lo < hi ? `${lo}-${hi}` : `${hi}`);
  // Break length as the engine draws it: "18 min", or "18-24 min" when the range is wider.
  const brkTxt = (lo, hi) => (hi && hi > lo ? `${lo}-${hi} min` : `${lo} min`);
  const avgMins = (lo, hi) => ((lo || 0) + (hi && hi > lo ? hi : lo || 0)) / 2;
  function paceOf(s0) {
    if (s0.runMode === "unfollow") return Object.assign({}, s0, { minDelay: s0.unfMinDelay, maxDelay: s0.unfMaxDelay, longPauseChance: s0.unfLongPause, restEveryMin: s0.unfRestEveryMin, restEvery: s0.unfRestEvery, restMinutes: s0.unfRestMinutes, restMinutesMax: s0.unfRestMinutesMax, breakJitter: 0, hourlyLimit: hourOf(s0, "unfollow"), extraBreaks: [] });
    if (s0.runMode === "comment") return Object.assign({}, s0, { minDelay: s0.cmtMinDelay, maxDelay: s0.cmtMaxDelay, longPauseChance: 0, restEveryMin: s0.cmtRestEveryMin, restEvery: s0.cmtRestEvery, restMinutes: s0.cmtRestMinutes, restMinutesMax: s0.cmtRestMinutesMax, breakJitter: 0, hourlyLimit: s0.cmtHourlyLimit, extraBreaks: [] });
    if (s0.runMode === "followback") return Object.assign({}, s0, { minDelay: s0.bkMinDelay, maxDelay: s0.bkMaxDelay, longPauseChance: s0.bkLongPause, restEveryMin: s0.bkRestEveryMin, restEvery: s0.bkRestEvery, restMinutes: s0.bkRestMinutes, restMinutesMax: s0.bkRestMinutesMax, breakJitter: 0, hourlyLimit: hourOf(s0, "followback"), extraBreaks: [] });
    return Object.assign({}, s0, { hourlyLimit: hourOf(s0, "follow") });
  }

  function modeToast(r, mode) {
    const nm = MODE_NAME[mode], s = r.settings;
    if (r.started) return `${nm} mode is on - it started now.`;
    const j = st.job;
    if (j && ["running", "resting", "sleeping", "paused", "halted"].includes(j.status)) return `Switched to ${nm} mode.`;
    // Nothing is running: with a sequence on, Start will follow the sequence rather than this tile.
    if (GX.cycling(s)) {
      const seq = GX.modeSeq(s);
      return seq[0] === mode
        ? `${nm} mode selected. Your sequence starts with it anyway.`
        : `${nm} mode selected - but Mode sequence is on, so Start begins with ${MODE_NAME[seq[0]]}. Move ${nm} to the top of the sequence, or switch automatic switching off.`;
    }
    if (!s.autoStart) return `${nm} mode selected. Press Start.`;
    const t = GX.nextAutoStart(GX.modeSettings(s), stopped(mode), Date.now());
    return `${nm} mode selected. It starts by itself ${t <= Date.now() + 60000 ? "in a moment" : new Date(t).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}.`;
  }

  // One click on a mode (Autopilot page tiles or the switch in the Overview hero): saved and applied right away.
  async function setMode(mode) {
    if (!GX.MODES.includes(mode) || !st || mode === st.settings.runMode || ui.modeBusy) return;
    ui.modeBusy = true;
    $$("#modeSeg [data-mode], #ovChips [data-ovmode]").forEach((b) => { b.disabled = true; });
    let r;
    try { r = await U.cmd("saveSettings", { patch: { runMode: mode } }); } catch (_) { r = null; }
    ui.modeBusy = false;
    $$("#modeSeg [data-mode], #ovChips [data-ovmode]").forEach((b) => { b.disabled = false; });
    if (!r || !r.ok) { U.toast((r && r.error) || "Couldn't switch the mode. Try again.", "bad"); return; }
    const toast = modeToast(r, mode);
    st.settings = r.settings;
    const inp = $('[data-form="autopilot"] [data-k="runMode"]');
    if (inp) inp.value = mode;
    if (!ui.dirty.autopilot) fillForm("autopilot");        // (unsaved edits on the page are kept)
    U.toast(toast, "good", 4500);
    renderCommon();
    renderPage();
    refresh();
  }

  // A pace card: saved and applied right away (Follow, Unfollow and Follow back look the same).
  async function applyPreset(mode, key) {
    const FOCUS = { follow: "minDelay", unfollow: "unfollowDaily", followback: "bkDaily" };
    const PACE = { follow: "speed", unfollow: "unfPace", followback: "bkPace" };
    const INFO = { follow: GX.PRESET_INFO, unfollow: GX.UNF_PRESET_INFO, followback: GX.BK_PRESET_INFO };
    const WORD = { follow: "pace", unfollow: "unfollow pace", followback: "follow-back pace" };
    if (key === "custom") { const f = $(`[data-form="autopilot"] [data-k="${FOCUS[mode]}"]`); if (f) f.focus(); return; }
    if (!INFO[mode][key]) return;
    const r = await U.cmd("saveSettings", { patch: { [PACE[mode]]: key } });
    if (!r || !r.ok) { U.toast((r && r.error) || "Couldn't apply that pace.", "bad"); return; }
    st.settings = r.settings;
    fillForm("autopilot");
    const raised = (r.adjusted || []).map((k) => (k === "dailyLimit" ? `${r.settings.dailyLimit}/day` : `${r.settings.hourlyLimit}/hour`));
    U.toast(`${INFO[mode][key].name} ${WORD[mode]} applied` + (raised.length ? ` - X's shared limit was raised to ${raised.join(" and ")} so this pace can reach its number` : ""), "good", raised.length ? 6500 : undefined);
    refresh();
  }

  // A few numbers appear twice on the Autopilot page (X's limit is shared by Follow and Follow back): keep both copies equal.
  function syncTwins(el) {
    const k = el && el.dataset && el.dataset.k;
    if (!k) return;
    $$(`[data-form="autopilot"] [data-k="${k}"]`).forEach((x) => {
      if (x === el) return;
      if (x.type === "checkbox") x.checked = el.checked; else x.value = el.value;
    });
  }

  // ---- Follow back mode home: its own numbers -------------------------------
  function renderBkKpis(acc) {
    ui.kpiMode = "followback";
    const s = st.settings, b = st.bk || {}, nu = modeNumbers();
    kLabel("#kToday", "Follow-backs today");
    U.setRing($("#kTodayRing svg"), nu.done / Math.max(1, nu.max));
    U.countTo($("#kToday"), nu.done);
    $("#kTodaySub").textContent = `of ${U.fmt(nu.max)} today · ${nu.hour} this hour`;
    kLabel("#kRate", "Waiting for you");
    if (b.stage === "ready") { $("#kRate").textContent = U.fmt(b.left); $("#kRateSub").textContent = s.bkVerifiedOnly ? `${s.bkOrder === "old" ? "oldest" : "newest"} first · only verified are followed back` : `${s.bkOrder === "old" ? "oldest" : "newest"} first · ~${Math.ceil(b.left / Math.max(1, s.bkDaily))} days at ${s.bkDaily}/day`; }
    else if (b.stage === "done") { $("#kRate").textContent = "0"; $("#kRateSub").textContent = "everyone is followed back"; }
    else { $("#kRate").textContent = "…"; $("#kRateSub").textContent = b.read ? `reading your followers: ${U.fmt(b.read)}` : "reads your followers on start"; }
    kLabel("#kWeek", "You follow now");
    $("#kWeek").textContent = acc && typeof acc.following === "number" ? U.fmt(acc.following) : "-";
    $("#kWeekSub").textContent = b.startFollowing && acc && typeof acc.following === "number" ? `${U.signed(acc.following - b.startFollowing)} since follow back started` : `${acc && acc.followers != null ? U.fmt(acc.followers) + " followers" : ""}`;
    kLabel("#kQueue", "Followed back in total");
    U.countTo($("#kQueue"), b.all || 0);
    $("#kQueueSub").textContent = bkSkipText(b);
  }
  // "340 skipped · not verified": how many were skipped and the most common reason.
  function bkSkipText(b) {
    const top = Object.entries((b && b.skips) || {}).sort((x, y) => y[1] - x[1])[0];
    return !(b && b.skipped) ? "none skipped yet" : `${U.fmt(b.skipped)} skipped${top ? " · " + top[0] : ""}`;
  }

  function renderBkGoal() {
    const s = st.settings, b = st.bk || {}, nu = modeNumbers();
    const g = $("#goal"); g.classList.remove("unf-goal"); g.classList.add("bk-goal");
    $("#goal .goal-head small").textContent = b.stage === "done" ? "Follow back · all caught up" : "Follow back list";
    $("#goal .goal-head a").hidden = true;
    if (!$("#goalRing svg")) $("#goalRing").insertAdjacentHTML("afterbegin", U.ring(0, 168, 14));
    if (!$("#bkGrad")) $("#goalRing svg").insertAdjacentHTML("afterbegin", '<defs><linearGradient id="bkGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2FCBA2"/><stop offset="1" stop-color="#07503F"/></linearGradient></defs>');
    const lab = $$("#goal .goal-facts span");
    if (b.stage === "done") {
      $("#goalTitle").textContent = "Everyone is followed back";
      U.setRing($("#goalRing svg"), 1);
      $("#goalGained").textContent = U.fmt(nu.done);
      $("#goalPct").textContent = "followed back today";
      ["Followers", "Followed back", "Skipped"].forEach((t, i) => { if (lab[i]) lab[i].textContent = t; });
      $("#goalDays").textContent = U.fmt(b.fcount || 0);
      $("#goalNeed").textContent = U.fmt(b.followed || 0);
      $("#goalProj").textContent = U.fmt(b.skipped || 0);
      $("#goalNote").textContent = "Nobody is waiting right now. GrowX looks for new followers by itself every couple of hours and follows them back, newest first.";
      return;
    }
    const total = b.total || 0, left = b.left || 0, done = Math.max(0, total - left);
    const ready = b.stage === "ready" && total > 0;
    $("#goalTitle").textContent = ready ? `${U.fmt(total)} followers waiting` : b.stage === "ready" ? "Nobody waiting yet" : "Reading your followers";
    U.setRing($("#goalRing svg"), ready ? done / total : 0);
    $("#goalGained").textContent = ready ? Math.round(done / total * 100) + "%" : "…";
    $("#goalPct").textContent = ready ? "followed back" : "starting";
    ["Followed back", "Left", "Days to go"].forEach((t, i) => { if (lab[i]) lab[i].textContent = t; });
    $("#goalDays").textContent = U.fmt(b.followed || 0);
    $("#goalNeed").textContent = U.fmt(left);
    $("#goalProj").textContent = ready ? String(Math.ceil(left / Math.max(1, nu.max || s.bkDaily))) : "-";
    $("#goalNote").textContent = ready ? `${s.bkOrder === "old" ? "Oldest" : "Newest"} followers first, ${s.bkDaily} a day. Your number is finished first; if fewer people are waiting, it follows them all, rests, then looks for new followers.` : "GrowX reads who follows you and who you follow, then starts with your newest follower.";
  }

  // ---- Followed back page ----------------------------------------------------
  async function renderFollowedBack() {
    let all = await U.get(K.bklog, []);
    all = Array.isArray(all) ? all : [];
    const acc = st.account;
    if (acc && acc.id) all = all.filter((x) => !x.o || x.o === acc.id);
    const s = st.settings, b = st.bk || {};
    const sod = new Date(); sod.setHours(0, 0, 0, 0);
    const wk = Date.now() - 7 * DAY;
    const td = all.filter((x) => x.t >= sod.getTime()), wkN = all.filter((x) => x.t >= wk);
    $("#fbSub").textContent = all.length
      ? `${U.fmt(all.length)} followed back by GrowX · ${b.stage === "ready" ? U.fmt(b.left) + " followers still waiting" : b.stage === "done" ? "everyone is followed back" : "reading your followers"}`
      : "Everyone GrowX followed back because they follow you - newest followers first.";
    setHtml("fbStats", $("#fbStats"), `
      <div class="ul-stat bk"><small>Followed back</small><b class="num">${U.fmt(all.length)}</b><span>in total</span></div>
      <div class="ul-stat"><small>Today</small><b class="num">${U.fmt(td.length)}</b><span>of ${U.fmt(s.bkDaily)} planned</span></div>
      <div class="ul-stat"><small>Last 7 days</small><b class="num">${U.fmt(wkN.length)}</b><span>followed back</span></div>
      <div class="ul-stat"><small>Still waiting</small><b class="num">${b.stage === "ready" ? U.fmt(b.left) : b.stage === "done" ? "0" : "…"}</b><span>${b.skipped ? bkSkipText(b) : "followers you don't follow yet"}</span></div>`);
    const q = ($("#fbSearch").value || "").trim().toLowerCase();
    const f = ui.fbFilter || "all";
    const rows = all.filter((x) => (f === "all" || (f === "today" ? x.t >= sod.getTime() : x.t >= wk)) && (!q || `${x.h} ${x.n}`.toLowerCase().includes(q)));
    ui.fbShow = ui.fbShow || 100;
    const html = rows.length ? rows.slice(0, ui.fbShow).map((x, i) => `<div class="trow bk-cols" style="animation-delay:${Math.min(i, 14) * 18}ms">
        <div class="who">${U.avatarHtml(x.a, x.n || x.h, 32)}<div><b>${U.esc(x.n || "@" + x.h)}${x.v ? `<i class="vbadge" title="Verified account">${U.icon("badge")}</i>` : ""}</b><a href="https://x.com/${encodeURIComponent(x.h)}" target="_blank" rel="noopener">@${U.esc(x.h)}</a></div></div>
        <span class="cell-muted" title="Your newest follower is #1">${x.rk ? `<b class="rk">#${U.fmt(x.rk)}</b> of ${U.fmt(x.rkOf)}` : "-"}</span>
        <span class="cell-muted num">${x.fc == null ? "-" : U.compact(x.fc)}</span>
        <span class="cell-muted" title="${new Date(x.t).toLocaleString()}${x.pc != null ? ` · ${x.pc} post${x.pc === 1 ? "" : "s"} in the last ${x.pd || s.bkInactiveDays} days when checked` : ""}">${U.dateTime(x.t)}${x.p ? " · requested" : ""}</span>
      </div>`).join("")
      : `<div class="empty">${U.icon("userPlus")}<b>${all.length ? "No matches" : "Nobody followed back yet"}</b><span>${all.length ? "Try another filter." : "Switch to Follow back mode - every follow-back shows up here, with the follower's number (#1 = your newest follower)."}</span></div>`;
    setHtml("fb", $("#fbRows"), html);
    $("#fbMore").hidden = rows.length <= ui.fbShow;
  }
  function wireFollowedBack() {
    $("#fbSearch").addEventListener("input", debounce(() => { ui.fbShow = 100; renderFollowedBack(); }, 150));
    $("#fbFilter").addEventListener("click", (e) => {
      const b = e.target.closest("[data-f]");
      if (!b) return;
      ui.fbFilter = b.dataset.f; ui.fbShow = 100;
      $$("#fbFilter button").forEach((x) => x.classList.toggle("on", x === b));
      renderFollowedBack();
    });
    $("#fbMoreBtn").addEventListener("click", () => { ui.fbShow += 200; renderFollowedBack(); });
    $("#fbExport").addEventListener("click", async () => {
      const all = await U.get(K.bklog, []);
      const rows = (Array.isArray(all) ? all : []).map((x) => [x.h, x.n, x.i || "", x.rk || "", new Date(x.t).toISOString(), x.v ? "yes" : "", x.pc != null ? x.pc : "", x.pc != null ? (x.pd || "") : "", x.p ? "request" : ""]);
      U.download(`growx-followed-back-${new Date().toISOString().slice(0, 10)}.csv`, U.csv(["handle", "name", "id", "follower_number", "followed_back_at", "verified", "posts_in_period", "period_days", "note"], rows));
    });
  }


  // =====================================================================
  // OVERVIEW
  // =====================================================================
  function renderOverview() {
    const acc = st.account, sum = st.summary || {}, L = st.limits;
    const signed = !!(acc && acc.id);
    const av = $("#ovAvatar");
    if (av.dataset.url !== String(acc && acc.avatar)) {
      const n = U.avatar(acc && acc.avatar, acc && (acc.name || acc.handle), 64);
      n.id = "ovAvatar"; n.dataset.url = String(acc && acc.avatar);
      av.replaceWith(n);
    }
    const h = new Date().getHours();
    $("#ovKicker").textContent = signed ? (h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening") : "Growth control center";
    $("#ovHello").textContent = signed ? (acc.name || "@" + acc.handle) : "Grow on autopilot";
    $("#ovMeta").textContent = signed
      ? `@${acc.handle} · ${U.fmt(acc.followers)} followers · ${U.fmt(acc.following)} following`
      : (acc && acc.signedOut ? "You're signed out of X. Sign in at x.com, then come back." : "Sign in to X in this browser, add sources, press Start.");
    setHtml("ovCtl", $("#ovCtl"), ctlButtons("hero"));

    if (!$("#kTodayRing svg")) $("#kTodayRing").innerHTML = U.ring(0, 48, 6);
    const home = modeOf(st.settings);
    document.body.classList.toggle("m-unf", home === "unfollow");
    document.body.classList.toggle("m-bk", home === "followback");
    if (home === "unfollow") renderUnfKpis(acc);
    else if (home === "followback") renderBkKpis(acc);
    else if (home === "comment") renderCmtKpis();
    else { restoreFollowKpis(); renderFollowKpis(acc, sum, L); }

    renderOvRun();
    renderLive();
    renderPlanCard();
    if (home === "unfollow") renderUnfGoal(); else if (home === "followback") renderBkGoal(); else renderGoal();
    renderFeed();
    renderFollowersChart();
  }


  // ---- the run strip inside the hero ----------------------------------------
  // The same numbers the engine runs on, for whichever mode is selected: how far
  // today is, when it finishes at this pace, what it is doing right now, and the
  // three live boxes (next action, next break, this hour).
  const PACE_OF = {
    follow: (s) => (s.speed === "custom" ? "Custom" : (GX.PRESET_INFO[s.speed] || {}).name),
    unfollow: (s) => (s.unfPace === "custom" ? "Custom" : (GX.UNF_PRESET_INFO[s.unfPace] || {}).name),
    followback: (s) => (s.bkPace === "custom" ? "Custom" : (GX.BK_PRESET_INFO[s.bkPace] || {}).name),
    comment: (s) => (s.cmtPace === "custom" ? "Custom" : ((GX.CMT_PRESET_INFO || {})[s.cmtPace] || {}).name)
  };
  // what one action of a mode is called, singular and plural
  const ACT_WORD = { follow: ["follow", "follows"], unfollow: ["unfollow", "unfollows"], followback: ["follow-back", "follow-backs"], comment: ["reply", "replies"] };

  // Seconds per action for a mode, its breaks included, and what that is per hour.
  function ovPace(s, m) {
    const p = paceOf(Object.assign({}, s, { runMode: m }));
    const avg = (p.minDelay + p.maxDelay) / 2 * (1 + ((p.longPauseChance || 0) / 100) * 2.25);
    const batch = ((p.restEveryMin || p.restEvery) + p.restEvery) / 2;
    const brk = avgMins(p.restMinutes, p.restMinutesMax) * 60;
    const per = avg + (batch ? brk / batch : 0);
    const cap = hourOf(s, m);
    return { per, perHour: Math.max(0.1, Math.min(cap, 3600 / Math.max(1, per))) };
  }

  function renderOvRun() {
    const s = st.settings, m = modeOf(s), nu = modeNumbers(), job = st.job;
    const v = U.jobView(job, st.task);
    const mine = job && jobMode(job) === m;
    const running = v.active && mine;
    const d = (st.modes || {})[m] || {};
    const pct = Math.min(1, nu.done / Math.max(1, nu.max));
    const left = Math.max(0, nu.max - nu.done);
    const pace = ovPace(s, m);
    const [one, many] = ACT_WORD[m] || ["action", "actions"];
    const plural = (n) => `${U.fmt(n)} ${n === 1 ? one : many}`;

    // the line under the big number
    let sub;
    if (!left) sub = `Today's number is done. ${s.autoStart ? "It starts again by itself tomorrow." : "Press Start tomorrow, or raise the number."}`;
    else if (d.blocked) sub = "X limited this mode today - it carries on tomorrow.";
    else if (d.inWindow === false) sub = `Outside its hours - it starts again ${U.dateTime(d.nextWindow)}.`;
    else {
      const hrs = left / pace.perHour;
      const at = Date.now() + hrs * 3600000;
      const sameDay = new Date(at).toDateString() === new Date().toDateString();
      sub = `${plural(left)} to go · at this pace that is around ${U.clock(at)}${sameDay ? "" : " " + new Date(at).toLocaleDateString([], { weekday: "short" })} · about ${U.dur(hrs * 3600)} of working time`;
    }

    const kicker = running ? `Running · ${PACE_OF[m] ? PACE_OF[m](s) || "Custom" : "Custom"} pace`
      : v.paused ? "Paused"
      : v.halted ? "Needs your attention"
      : job && mine && job.status === "resting" ? "On a break"
      : job && mine && job.status === "sleeping" ? "Sleeping"
      : `${MODE_NAME[m]} mode · ready`;

    // the three live boxes
    const nextAt = running && job.nextAt > Date.now() ? job.nextAt : 0;
    const restUntil = mine && (job || {}).restUntil > Date.now() ? job.restUntil : 0;
    const sinceRest = mine ? (m === "unfollow" ? job.uSince : m === "followback" ? job.bSince : m === "comment" ? job.cmtSince : job.sinceRest) || 0 : 0;
    const restAfter = mine ? (m === "unfollow" ? job.uRestAfter : m === "followback" ? job.bRestAfter : m === "comment" ? job.cmtRestAfter : job.restAfter) || 0 : 0;
    const br = d.breakRange || [0, 0];
    const brTxt = br[1] > br[0] ? `${br[0]}-${br[1]} min rest` : `${br[0]} min rest`;
    const toBreak = restAfter && restAfter !== Infinity ? Math.max(0, restAfter - sinceRest) : 0;

    const box = (label, value, note, extra) =>
      `<div class="ovr-box${extra || ""}"><small>${label}</small><b${value.until ? ` class="ovr-live" data-until="${value.until}"` : ""}>${value.txt}</b><span>${note}</span></div>`;

    const boxes = [
      restUntil
        ? box(job.restReason === "schedule" ? "Starts again at" : job.restReason === "switch" ? `${MODE_NAME[(job.trans || {}).to] || "Next mode"} at` : "Back at",
            { txt: U.countdown(restUntil - Date.now()), until: restUntil }, U.clock(restUntil))
        : box(`Next ${one} in`, { txt: nextAt ? U.countdown(nextAt - Date.now()) : running ? "now" : "--", until: nextAt },
            running ? (job.inFlight ? "working on it" : `${d.delay ? d.delay[0] + "-" + d.delay[1] + " s apart" : ""}`) : "not running"),
      box("Break after", { txt: toBreak ? `${toBreak} more` : restAfter === Infinity ? "no breaks" : "--" },
          toBreak ? `then ${brTxt}` : restAfter === Infinity ? "this mode takes none" : `every ${(d.batch || [0, 0])[0] || "?"}-${(d.batch || [0, 0])[1] || "?"}`),
      box("This hour", { txt: `${U.fmt(nu.hour)} / ${U.fmt(nu.hourMax)}` }, "rolling 60 minutes")
    ].join("");

    // what it is doing right now
    const cur = running && job.current;
    const meta = [
      cur ? `Now: <b>${cur.h ? "@" + U.esc(cur.h) : "a post"}</b>` : running ? `Now: <b>${U.esc((job.message || "working").slice(0, 46))}</b>` : "",
      `Pace <b>${(PACE_OF[m] ? PACE_OF[m](s) : "") || "Custom"}</b>`,
      m === "comment" ? `Model <b>${U.esc(s.cmtModel)}</b>` : "",
      m === "comment" ? `Publishing <b>${s.cmtPublish === "auto" ? "GrowX posts it" : "you post it"}</b>` : "",
      st.seq && st.seq.cycling ? `Sequence <b>${(st.seq.order || []).map((x) => MODE_NAME[x]).join(" → ")}</b>` : ""
    ].filter(Boolean).map((x) => `<span>${x}</span>`).join("");

    setHtml("ovRun", $("#ovRun"), `<div class="ovr-main">
        <span class="ovr-kicker">${kicker}</span>
        <b class="ovr-num">${U.fmt(nu.done)} <em>of ${U.fmt(nu.max)} ${many} today</em></b>
        <p class="ovr-sub">${sub}</p>
        <div class="ovr-bar${running ? " is-live" : ""}"><i style="width:${Math.round(pct * 100)}%"></i></div>
        <div class="ovr-meta">${meta}</div>
      </div>
      <div class="ovr-boxes">${boxes}</div>`);
  }

  // ---- Follow mode home numbers (drawn only in Follow mode: drawing them first and then the other mode's
  // numbers made the tiles jump between two values on every refresh)
  function renderFollowKpis(acc, sum, L) {
    U.setRing($("#kTodayRing svg"), st.today / Math.max(1, L.daily));
    U.countTo($("#kToday"), st.today);
    $("#kTodaySub").textContent = `of ${U.fmt(L.daily)} allowed today`;
    $("#kRate").textContent = sum.rate == null ? "-" : U.pct(sum.rate, 1);
    $("#kRateSub").textContent = sum.total ? `${U.fmt(sum.back)} of ${U.fmt(sum.total)} followed back` : "checked after each follow";
    // New followers (found by the follower checks) when known; otherwise the change of your follower count.
    const since = sum.measuredSince ? new Date(sum.measuredSince) : null;
    const sinceTxt = since ? (since.toDateString() === new Date().toDateString() ? "since " + since.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "since " + since.toLocaleDateString([], { month: "short", day: "numeric" })) : "";
    if (sum.newWeek != null) {
      kLabel("#kWeek", "New followers · 7 days");
      $("#kWeek").textContent = U.signed(sum.newWeek);
      $("#kWeekSub").textContent = `${U.signed(sum.newToday || 0)} today${sum.gainedWeek != null ? " · follower count " + U.signed(sum.gainedWeek) : ""}`;
    } else {
      kLabel("#kWeek", "Gained · 7 days");
      $("#kWeek").textContent = sum.gainedWeek == null ? "-" : U.signed(sum.gainedWeek);
      $("#kWeekSub").textContent = sum.gainedToday == null ? "measured every few hours" : `${U.signed(sum.gainedToday)} today${sinceTxt ? " · " + sinceTxt : ""}`;
    }
    U.countTo($("#kQueue"), st.poolCount);
    $("#kQueueSub").textContent = `${(st.sources || []).filter((x) => x.enabled).length} active sources`;
  }

  // ---- Comment mode home: its own four numbers ---------------------------
  function renderCmtKpis() {
    const s = st.settings, c = st.cmt || {};
    if (ui.kpiMode !== "comment") {
      ui.kpiMode = "comment";
      kLabel("#kToday", "Replies · today"); kLabel("#kRate", "All-time replies"); kLabel("#kWeek", "AI cost · today"); kLabel("#kQueue", "Drafts ready");
    }
    U.setRing($("#kTodayRing svg"), (c.today || 0) / Math.max(1, c.goal || s.cmtDaily));
    U.countTo($("#kToday"), c.today || 0);
    $("#kTodaySub").textContent = `of ${U.fmt(c.goal || s.cmtDaily)} replies today`;
    $("#kRate").textContent = U.fmt(c.all || 0);
    $("#kRateSub").textContent = `since you started commenting`;
    $("#kWeek").textContent = "$" + (c.cost || 0).toFixed((c.cost || 0) < 0.01 ? 4 : 2);
    $("#kWeekSub").textContent = `of $${(c.cap || 0).toFixed(2)} you allow a day`;
    $("#kQueue").textContent = U.fmt(c.ready || 0);
    $("#kQueueSub").textContent = `${U.fmt(c.open || 0)} post${(c.open || 0) === 1 ? "" : "s"} still waiting`;
  }

  // ---- Unfollow mode home: its own numbers -------------------------------
  const kLabel = (id, txt) => { const el = $(id) && $(id).previousElementSibling; if (el && el.textContent !== txt) el.textContent = txt; };
  function restoreFollowKpis() {
    if (!ui.kpiMode || ui.kpiMode === "follow") return;
    ui.kpiMode = "follow";
    kLabel("#kToday", "Follows · 24h"); kLabel("#kRate", "Follow-back rate"); kLabel("#kWeek", "Gained · 7 days"); kLabel("#kQueue", "Ready in queue");
    const g = $("#goal"); g.classList.remove("unf-goal", "bk-goal");
    $("#goal .goal-head small").textContent = "Monthly goal";
    const lab = $$("#goal .goal-facts span"); ["Days left", "Needed / day", "On pace for"].forEach((t, i) => { if (lab[i]) lab[i].textContent = t; });
    $("#goal .goal-head a").hidden = false;
  }
  // Everyone GrowX unfollowed (all kinds, all steps) and how many of them followed you at the time.
  function unfAll(u) { return !u ? 0 : u.all != null ? u.all : (u.removed || 0) + ((u.inact && u.inact.removed) || 0); }
  function unfFol(u) { return !u ? 0 : u.fol != null ? u.fol : (u.inact && u.inact.removed) || 0; }

  function renderUnfKpis(acc) {
    ui.kpiMode = "unfollow";
    const s = st.settings, u = st.unf || {};
    kLabel("#kToday", "Unfollows today");
    U.setRing($("#kTodayRing svg"), (u.today || 0) / Math.max(1, s.unfollowDaily));
    U.countTo($("#kToday"), u.today || 0);
    $("#kTodaySub").textContent = `of ${U.fmt(s.unfollowDaily)} today · ${u.hour || 0} this hour`;
    kLabel("#kRate", u.stage === "done" ? "Due now (no follow-back)" : "Old list left");
    if (u.stage === "done") { $("#kRate").textContent = U.fmt(u.due || 0); $("#kRateSub").textContent = `${U.fmt(u.waiting || 0)} still within ${s.unfollowAfterDays} days`; }
    else if (u.stage === "ready") { $("#kRate").textContent = U.fmt(u.left); $("#kRateSub").textContent = `~${Math.ceil(u.left / Math.max(1, s.unfollowDaily))} days at ${s.unfollowDaily}/day`; }
    else { $("#kRate").textContent = "…"; $("#kRateSub").textContent = u.read ? `reading your list: ${U.fmt(u.read)}` : "reads your list on start"; }
    kLabel("#kWeek", "You follow now");
    $("#kWeek").textContent = acc && typeof acc.following === "number" ? U.fmt(acc.following) : "-";
    $("#kWeekSub").textContent = u.startFollowing && acc && typeof acc.following === "number" ? `${U.signed(acc.following - u.startFollowing)} since unfollow started` : `${acc && acc.followers != null ? U.fmt(acc.followers) + " followers" : ""}`;
    kLabel("#kQueue", "Unfollowed in total");
    const tAll = unfAll(u), tFol = Math.min(tAll, unfFol(u));
    U.countTo($("#kQueue"), tAll);
    $("#kQueueSub").textContent = tFol ? `${U.fmt(tFol)} of them followed you` : "none of them followed you";
  }
  function renderUnfGoal() {
    const s = st.settings, u = st.unf || {};
    const g = $("#goal"); g.classList.remove("bk-goal"); g.classList.add("unf-goal");
    $("#goal .goal-head small").textContent = u.stage === "done" ? "Step 2 · no follow-back" : "Step 1 · old following cleanup";
    $("#goal .goal-head a").hidden = true;
    if (!$("#goalRing svg")) $("#goalRing").insertAdjacentHTML("afterbegin", U.ring(0, 168, 14));
    if (!$("#unfGrad")) $("#goalRing svg").insertAdjacentHTML("afterbegin", '<defs><linearGradient id="unfGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#A78BFA"/><stop offset="1" stop-color="#5B21B6"/></linearGradient></defs>');
    const lab = $$("#goal .goal-facts span");
    if (u.stage === "done") {
      $("#goalTitle").textContent = "Old list finished";
      U.setRing($("#goalRing svg"), 1);
      $("#goalGained").textContent = U.fmt(u.today || 0);
      $("#goalPct").textContent = `unfollowed today`;
      ["Due now", "Waiting", "After"].forEach((t, i) => { if (lab[i]) lab[i].textContent = t; });
      $("#goalDays").textContent = U.fmt(u.due || 0);
      $("#goalNeed").textContent = U.fmt(u.waiting || 0);
      $("#goalProj").textContent = `${s.unfollowAfterDays} d`;
      const ia = u.inact || {};
      $("#goalNote").textContent = s.unfInactive && ia.total
        ? `Inactive check: ${U.fmt(Math.max(0, ia.pos - ia.deep))}/${U.fmt(ia.total)} followers-back checked, ${U.fmt(ia.removed)} inactive unfollowed. Plus: no follow-back after ${s.unfollowAfterDays} days.`
        : `GrowX unfollows people who didn't follow back within ${s.unfollowAfterDays} days, up to ${s.unfollowDaily} a day. ${GX.unfEveryone(s) ? "Followers are unfollowed too, but only when nobody else is due." : "Anyone who follows you is kept."}`;
      return;
    }
    const total = u.total || 0, done = Math.max(0, total - (u.left || 0));
    $("#goalTitle").textContent = total ? `${U.fmt(total)} old non-followers` : "Reading your following list";
    U.setRing($("#goalRing svg"), total ? done / total : 0);
    $("#goalGained").textContent = total ? Math.round(done / total * 100) + "%" : "…";
    $("#goalPct").textContent = total ? "cleaned" : "starting";
    ["Unfollowed", "Left", "Days to go"].forEach((t, i) => { if (lab[i]) lab[i].textContent = t; });
    $("#goalDays").textContent = U.fmt(u.removed || 0);
    $("#goalNeed").textContent = U.fmt(u.left || 0);
    $("#goalProj").textContent = total ? String(Math.ceil((u.left || 0) / Math.max(1, s.unfollowDaily))) : "-";
    $("#goalNote").textContent = total ? `${s.unfOrder === "new" ? "Newest" : "Oldest"} following first, ${s.unfollowDaily} a day. No following until this list is finished.` : `GrowX reads everyone you follow from X, then starts with the ${s.unfOrder === "new" ? "newest" : "oldest"}.`;
  }

  const TAG = (k) => k === "bk" ? '<em class="tg bk" title="Follows you - GrowX followed back">Follows you</em>' : k === "fb" ? '<em class="tg fb" title="Was following you (inactive, or active when you chose to unfollow active followers)">Follower</em>' : '<em class="tg nf" title="Was not following you">Non-follower</em>';

  // ---- v3.2 live unfollow stream: done -> now -> next, one after the other ------------------------
  function unfStreamHtml(compact) {
    const job = st.job, u = st.unf || {}, s = st.settings;
    const running = !!job && jobMode(job) === "unfollow" && ACTIVE_JOB.has(job.status);
    const done = ((job && jobMode(job) === "unfollow" && job.log) || []).filter((l) => l.r === "ok" && l.h && (l.tg === "nf" || l.tg === "fb")).slice(0, compact ? 3 : 5).reverse();
    const cur = running && job.current && job.current.h ? job.current : null;
    const next = (u.next || []).filter((x) => !cur || x.i !== cur.i).slice(0, compact ? 3 : 6);
    if (!done.length && !cur && !next.length) {
      return compact ? "" : `<div class="us-empty">${U.icon("userX")}<span>${s.runMode === "unfollow" ? "The live list appears here as soon as Unfollow mode picks its next accounts." : "Switch to Unfollow mode - each unfollow shows up here live, one after the other."}</span></div>`;
    }
    const meta = (x) => [x.qs != null ? `score ${x.qs}` : "", x.fc != null ? `${U.compact(x.fc)} followers` : ""].filter(Boolean).join(" · ");
    const row = (x, kind, why, when) => `<div class="us-row ${kind}" data-k="${U.esc(x.i || x.h)}">
        <span class="us-dot"></span>${U.avatarHtml(x.a, x.n || x.h, compact ? 24 : 30)}
        <div class="us-who"><b>@${U.esc(x.h || x.i)}</b><small>${U.esc(why || "")}${meta(x) ? " · " + U.esc(meta(x)) : ""}</small></div>
        <em class="us-tag">${kind === "done" ? "Unfollowed" : kind === "now" ? "Now" : "Next"}</em>${when ? `<time>${when}</time>` : ""}</div>`;
    const tl = (job && job.nextAt && job.nextAt > Date.now()) ? U.countdown(job.nextAt - Date.now()) : "";
    return `${compact ? "" : `<div class="us-head"><b>Live unfollow list</b><small>${running ? (cur ? "working now" : tl ? "next unfollow in " + tl : "running") : "not running"} · big / good and active accounts are never unfollowed</small></div>`}
      <div class="us-list">
        ${done.map((l) => row({ h: l.h, a: "", n: l.h }, "done", l.w || l.m, U.clock(l.t))).join("")}
        ${cur ? row(cur, "now", cur.why || (cur.tg === "fb" ? "inactive follower" : "doesn't follow you back"), "") : ""}
        ${next.map((x, i) => row(x, "next", x.why, i === 0 && tl && !cur ? tl : "")).join("")}
      </div>`;
  }
  function renderUnfStreams() {
    const a = $("#ulStream");
    if (a) setHtml("ulStream", a, unfStreamHtml(false));
    const b = $("#unfStream");
    if (b) {
      const on = modeOf(st.settings) === "unfollow";
      const html = on ? unfStreamHtml(true) : "";
      b.hidden = !html;
      setHtml("unfStream", b, html);
    }
  }

  // ---- Unfollowed page: filters, pick, follow again ------------------------------------------------
  const ufWhy = (x) => x.ia || x.k === "fb" ? "ia" : /no follow-back/.test(x.w || "") ? "7d" : /unfollowed you/.test(x.w || "") ? "lost" : "old";
  function ulFilters() {
    const num = (id) => { const v = Number($(id).value); return Number.isFinite(v) && v > 0 ? v : 0; };
    return { score: num("#ufScore"), followers: num("#ufFollowers"), active: Number($("#ufActive").value) || 0, why: $("#ufWhy").value,
      when: Number($("#ufWhen").value) || 0, state: $("#ufState").value, verified: $("#ufVerified").checked };
  }
  function ulMatch(x, F, now) {
    if (F.score && !(x.qs != null && x.qs >= F.score)) return false;
    if (F.followers && !(x.fc != null && x.fc >= F.followers)) return false;
    if (F.active > 0 && !(x.lt && now - x.lt <= F.active * 86400000)) return false;
    if (F.active < 0 && !(x.lt && now - x.lt > -F.active * 86400000)) return false;
    if (F.why && ufWhy(x) !== F.why) return false;
    if (F.when === 1) { const d = new Date(); d.setHours(0, 0, 0, 0); if (x.t < d.getTime()) return false; }
    else if (F.when && now - x.t > F.when * 86400000) return false;
    if (F.state === "rf" && !x.rf) return false;
    if (F.state === "q" && !(x.rq && !x.rf)) return false;
    if (F.state === "not" && (x.rf || x.rq)) return false;
    if (F.verified && !x.v) return false;
    return true;
  }
  // "Mistakes": accounts the v3.2 rules would have kept - big / good (score or followers), or active when they were
  // unfollowed as inactive. Uses the numbers read by "Refresh numbers".
  function ulMistake(x, s, now) {
    if (x.rf || x.rq || x.gone) return false;
    if (s.unfProtectFollowers && x.fc != null && x.fc >= s.unfProtectFollowers) return true;
    if (x.qs != null && x.qs >= s.unfProtectScore) return true;
    if (ufWhy(x) === "ia" && x.lt && x.lt >= x.t - s.unfInactiveDays * 86400000) return true;   // they had posted inside the period
    return false;
  }
  async function ulAll() {
    let all = await U.get(K.unlog, []);
    all = Array.isArray(all) ? all : [];
    const acc = st.account;
    if (acc && acc.id) all = all.filter((x) => !x.o || x.o === acc.id);
    return all;
  }
  async function renderUnfollowed() {
    renderUnfStreams();
    const all = await ulAll();
    const now = Date.now(), s = st.settings;
    const today0 = new Date(); today0.setHours(0, 0, 0, 0);
    const nf0 = all.filter((x) => x.k !== "fb").length, fb0 = all.length - nf0;
    const tot = Math.max(all.length, unfAll(st.unf)), fb = Math.min(tot, Math.max(fb0, unfFol(st.unf))), nf = tot - fb;
    const td = all.filter((x) => x.t >= today0.getTime());
    const rfN = all.filter((x) => x.rf).length, rqN = all.filter((x) => x.rq && !x.rf).length;
    const noData = all.filter((x) => x.qs == null || !x.ra).length;
    setHtml("ulStats", $("#ulStats"), `
      <div class="ul-stat"><small>Unfollowed</small><b class="num">${U.fmt(tot)}</b><span>in total${tot > all.length ? ` · the list shows the latest ${U.fmt(all.length)}` : ""}</span></div>
      <div class="ul-stat nf"><small>Non-followers</small><b class="num">${U.fmt(nf)}</b><span>didn't follow you</span></div>
      <div class="ul-stat fb"><small>Followers</small><b class="num">${U.fmt(fb)}</b><span>followed you, inactive</span></div>
      <div class="ul-stat"><small>Followed again</small><b class="num">${U.fmt(rfN)}</b><span>${rqN ? U.fmt(rqN) + " waiting in the Follow queue" : `today: ${U.fmt(td.length)} unfollowed`}</span></div>`);
    const q = ($("#ulSearch").value || "").trim().toLowerCase();
    const f = ui.ulFilter || "all";
    const F = ulFilters();
    const rows = all.filter((x) => (f === "all" || (f === "fb" ? x.k === "fb" : x.k !== "fb")) && (!q || `${x.h} ${x.n}`.toLowerCase().includes(q)) && ulMatch(x, F, now));
    ui.ulRows = rows;
    ui.ulSel = ui.ulSel || new Set();
    ui.ulShow = ui.ulShow || 100;
    const lastPost = (x) => x.gone ? `<span class="cell-muted">account gone</span>` : x.lt ? `<span class="${now - x.lt <= s.unfInactiveDays * 86400000 ? "lp-ok" : "lp-old"}">${U.ago(x.lt)}</span>` : `<span class="cell-muted">-</span>`;
    const scoreCell = (x) => x.qs != null || x.fc != null
      ? `<span class="qs ${x.qs >= s.unfProtectScore ? "hi" : x.qs >= 45 ? "mid" : "lo"}" title="Quality score">${x.qs != null ? x.qs : "?"}</span><small>${x.fc != null ? U.compact(x.fc) + " followers" : ""}${x.v ? " · ✓" : ""}</small>`
      : `<small class="cell-muted">press Refresh numbers</small>`;
    const status = (x) => x.rf ? `<em class="tg bk">Followed again</em>` : x.rq ? `<em class="tg wait">In Follow queue</em>` : "";
    const html = rows.length ? rows.slice(0, ui.ulShow).map((x, i) => `<div class="trow ul-cols ul-cols-x${ulMistake(x, s, now) ? " ul-mistake" : ""}" style="animation-delay:${Math.min(i, 14) * 18}ms">
        <label class="cb">${x.rf || x.rq || x.gone ? `<input type="checkbox" disabled>` : `<input type="checkbox" data-ul="${U.esc(x.i)}"${ui.ulSel.has(String(x.i)) ? " checked" : ""}>`}<i></i></label>
        <div class="who">${U.avatarHtml(x.a, x.n || x.h, 32)}<div><b>${U.esc(x.n || "@" + x.h)} ${TAG(x.k)}</b><a href="https://x.com/${encodeURIComponent(x.h)}" target="_blank" rel="noopener">@${U.esc(x.h)}</a></div></div>
        <span class="ul-score">${scoreCell(x)}</span>
        <span>${lastPost(x)}</span>
        <span class="cell-muted">${x.rk ? `<b class="rk">#${U.fmt(x.rk)}</b> of ${U.fmt(x.rkOf)} · ` : ""}${U.esc(x.w || "")} ${status(x)}</span>
        <span class="cell-muted" title="${new Date(x.t).toLocaleString()}">${U.dateTime(x.t)}</span>
      </div>`).join("")
      : `<div class="empty">${U.icon("userX")}<b>${all.length ? "No matches" : "Nobody unfollowed yet"}</b><span>${all.length ? "Try another filter." : "Switch to Unfollow mode - every unfollow shows up here, marked follower or non-follower."}</span></div>`;
    setHtml("ul", $("#ulRows"), html);
    $("#ulMore").hidden = rows.length <= ui.ulShow;
    const pickableIds = new Set(rows.filter((x) => !x.rf && !x.rq && !x.gone).map((x) => String(x.i)));
    for (const id of [...ui.ulSel]) if (!pickableIds.has(id)) ui.ulSel.delete(id);
    renderUlBulk(noData);
  }
  function renderUlBulk(noData) {
    const n = ui.ulSel ? ui.ulSel.size : 0;
    const pickable = (ui.ulRows || []).filter((x) => !x.rf && !x.rq && !x.gone).length;
    $("#ulBulk").hidden = !pickable && !n;
    $("#ulSelN").textContent = `${U.fmt(n)} picked`;
    $("#ulBulkNote").textContent = n ? "they go to the front of the Follow queue - followed at your normal pace" : `${U.fmt(pickable)} shown can be followed again${noData ? ` · ${U.fmt(noData)} without fresh numbers` : ""}`;
    $("#ulRefollow").disabled = !n;
    const allBox = $("#ulAll");
    if (allBox && document.activeElement !== allBox) allBox.checked = !!pickable && n >= pickable;
  }
  async function ulRefollow(ids, label) {
    if (!ids.length) return;
    const ok = await confirmBox({ title: `Follow ${U.fmt(ids.length)} account${ids.length === 1 ? "" : "s"} again?`,
      body: `${label ? label + " " : ""}They go to the very front of the Follow queue. Follow mode follows them first, with your normal delays, breaks and daily number - nothing outside your limits. Once followed again, they are never unfollowed again.`,
      ok: "Follow again", icon: "userPlus" });
    if (!ok) return;
    const r = await U.cmd("refollow", { ids });
    if (!r || !r.ok) { U.toast((r && r.error) || "That didn't work.", "bad"); return; }
    ui.ulSel = new Set();
    U.toast(`${U.fmt(r.added)} queued to follow again${r.already ? ` · ${U.fmt(r.already)} you already follow` : ""}${r.followRunning ? "" : " - they are followed when Follow mode runs"}`, "good", 6000);
    renderUnfollowed();
  }
  async function ulRefreshNumbers(opts) {
    const btn = $("#ulRefresh");
    btn.disabled = true; $("#ulFix").disabled = true;
    U.toast("Reading the profiles from X - 100 at a time, this can take a minute or two…", "info", 5000);
    let r;
    try { r = await U.cmd("unlogRefresh", opts || {}); } finally { btn.disabled = false; $("#ulFix").disabled = false; }
    if (!r || !r.ok) { U.toast((r && r.error) || "Couldn't read the profiles.", "bad"); return false; }
    if (r.done) U.toast(`Numbers refreshed for ${U.fmt(r.done)} accounts${r.left ? ` (${U.fmt(r.left)} more next time)` : ""}.`, "good");
    await renderUnfollowed();
    return true;
  }
  function wireUnfollowed() {
    $("#ulSearch").addEventListener("input", debounce(() => { ui.ulShow = 100; renderUnfollowed(); }, 150));
    $("#ulFilter").addEventListener("click", (e) => {
      const b = e.target.closest("[data-f]");
      if (!b) return;
      ui.ulFilter = b.dataset.f; ui.ulShow = 100;
      $$("#ulFilter button").forEach((x) => x.classList.toggle("on", x === b));
      renderUnfollowed();
    });
    $("#ulFilters").addEventListener("input", debounce(() => { ui.ulShow = 100; renderUnfollowed(); }, 200));
    $("#ufClear").addEventListener("click", () => {
      ["#ufScore", "#ufFollowers"].forEach((id) => { $(id).value = ""; });
      ["#ufActive", "#ufWhen"].forEach((id) => { $(id).value = "0"; });
      ["#ufWhy", "#ufState"].forEach((id) => { $(id).value = ""; });
      $("#ufVerified").checked = false;
      renderUnfollowed();
    });
    $("#ulRows").addEventListener("change", (e) => {
      const cb = e.target.closest("[data-ul]");
      if (!cb) return;
      ui.ulSel = ui.ulSel || new Set();
      if (cb.checked) ui.ulSel.add(cb.dataset.ul); else ui.ulSel.delete(cb.dataset.ul);
      renderUlBulk();
    });
    const pickAll = (on) => {
      ui.ulSel = new Set(on ? (ui.ulRows || []).filter((x) => !x.rf && !x.rq && !x.gone).map((x) => String(x.i)) : []);
      $$("#ulRows [data-ul]").forEach((c) => { c.checked = ui.ulSel.has(c.dataset.ul); });
      renderUlBulk();
    };
    $("#ulAll").addEventListener("change", (e) => pickAll(e.target.checked));
    $("#ulSelAll").addEventListener("click", () => pickAll(true));
    $("#ulSelNone").addEventListener("click", () => pickAll(false));
    $("#ulRefollow").addEventListener("click", () => ulRefollow([...(ui.ulSel || [])]));
    $("#ulRefresh").addEventListener("click", () => ulRefreshNumbers());
    $("#ulFix").addEventListener("click", async () => {
      // 1. fresh numbers for everyone who has none yet, 2. pick everyone the new rules would have kept, 3. ask once.
      const all = await ulAll();
      if (all.some((x) => x.qs == null || !x.ra)) { if (!await ulRefreshNumbers()) return; }
      const s = st.settings, now = Date.now();
      const bad = (await ulAll()).filter((x) => ulMistake(x, s, now));
      if (!bad.length) { U.toast("No mistakes found - nobody big, good or active was unfollowed (by the numbers X shows now).", "good", 6000); return; }
      const big = bad.filter((x) => (x.qs != null && x.qs >= s.unfProtectScore) || (s.unfProtectFollowers && x.fc >= s.unfProtectFollowers)).length;
      await ulRefollow(bad.map((x) => String(x.i)), `Found ${U.fmt(bad.length)}: ${U.fmt(big)} big / good account${big === 1 ? "" : "s"} and ${U.fmt(bad.length - big)} that were still active.`);
    });
    $("#ulMoreBtn").addEventListener("click", () => { ui.ulShow += 200; renderUnfollowed(); });
  }

  function renderLive() {
    try { renderLiveSeq(); } catch (_) {}
    try { renderUnfStreams(); } catch (_) {}
    const job = st.job, v = U.jobView(job, st.task), s = st.settings, L = st.limits;
    const mode = modeOf(s), nu = modeNumbers();
    const unfMode = mode === "unfollow", bkMode = mode === "followback";
    const mine = !!job && jobMode(job) === mode;            // the run on screen belongs to the selected mode
    // "When X refuses" notice (4 steps): 1 break / 2 longer break / 3 long break / 4 stopped for today
    const xa = $("#xAlert");
    if (xa) {
      let html = "", cls = "";
      const running = !!job && ["running", "resting", "sleeping"].includes(job.status);
      const ld = (st.lad && st.lad[unfMode ? "unfollow" : "follow"]) || {};
      const word = unfMode ? "unfollowing" : "following";
      const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      const plan = GX.refusePlan(s, mode);
      const span = (lo, hi) => (lo === hi ? fmtMin(lo / 60000) : `${fmtMin(lo / 60000)} to ${fmtMin(hi / 60000)}`);
      if (ld.until > Date.now()) {
        cls = "warn";
        const step = Math.min(3, Math.max(1, ld.n || 1));
        const wait = running ? `GrowX waits until <strong>${hhmm(ld.until)}</strong>` : `A break is still running until <strong>${hhmm(ld.until)}</strong> - if you press Start, GrowX waits for it first`;
        const why = ld.why === "limit" ? 'X said "unable to follow more people"' : ld.why === "rate" ? "X said to slow down" : `A ${unfMode ? "unfollow" : bkMode ? "follow-back" : "follow"} failed`;
        const next = step === 1 ? [plan.on1 ? span(plan.lo1, plan.hi1) : "", plan.on2 ? span(plan.lo2, plan.hi2) : ""].filter(Boolean)
          : step === 2 ? [plan.on2 ? span(plan.lo2, plan.hi2) : ""].filter(Boolean) : [];
        const title = step === 1 ? "Step 1 of 4 · break" : step === 2 ? "Step 2 of 4 · longer break" : "Step 3 of 4 · long break";
        const lead = step === 1 ? why : "X refused again right after the break";
        html = `<span class="xa-ic">!</span><div><b>${title}</b><span>${lead}. ${wait}. If X refuses again${next.length ? ", the next break" + (next.length > 1 ? "s are " : " is ") + next.join(", then ") + "; after that" : ","} ${word} stops for the rest of today and starts again tomorrow by itself. One ${unfMode ? "unfollow" : "follow"} that works starts the plan again from step 1.</span></div>`;
      } else if (stopped(mode) && !running) {
        cls = "stop";
        const lim = unfMode ? st.uLimited : st.xLimited;
        const ns = s.autoStart ? GX.nextAutoStart(GX.modeSettings(s), true, Date.now()) : 0;
        html = unfMode
          ? `<span class="xa-ic">✕</span><div><b>Step 4 of 4 · unfollowing is off for today</b><span>X kept refusing unfollows${lim.n != null ? " at " + U.fmt(lim.n) + " unfollows today" : ""}, so GrowX stopped unfollowing to keep the account safe. Follow and Follow back are not affected. ${s.autoStart ? "It starts again by itself " + new Date(ns).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) + "." : "Press Start tomorrow."}</span></div>`
          : `<span class="xa-ic">✕</span><div><b>Step 4 of 4 · following is off for today</b><span>X kept refusing${lim.n != null ? " at " + U.fmt(lim.n) + " follows today" : ""}, so GrowX stopped following (Follow and Follow back share X's limit) to keep the account safe. ${s.autoStart ? "It starts again by itself " + new Date(ns).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) + "." : "Press Start tomorrow."}</span></div>`;
      }
      ui.xLimited = cls === "stop";
      xa.className = "x-alert" + (cls ? " " + cls : "");
      xa.hidden = !html;
      setHtml("xAlert", xa, html);
    }
    const active = v.active;
    $("#live").classList.toggle("is-on", active && job.status === "running");
    $("#livePill").className = "pill " + v.cls;
    $("#livePillText").textContent = v.label;
    if (ui.xLimited) { $("#livePill").className = "pill halt"; $("#livePillText").textContent = "X limited · today"; }
    const chips = [];
    if (unfMode) chips.push(`<span class="chip red">${U.icon("gauge")}${s.unfPace === "custom" ? "Custom" : GX.UNF_PRESET_INFO[s.unfPace].name} unfollow pace</span>`);
    else if (bkMode) chips.push(`<span class="chip red">${U.icon("gauge")}${s.bkPace === "custom" ? "Custom" : GX.BK_PRESET_INFO[s.bkPace].name} follow-back pace</span>`);
    else chips.push(`<span class="chip red">${U.icon("gauge")}${s.speed === "custom" ? "Custom pace" : GX.PRESET_INFO[s.speed].name + " pace"}</span>`);
    if (job && job.throttle && job.throttle.until > Date.now() && (s.autoSlowdown || job.throttle.dailyCap)) chips.push(`<span class="chip amber">${U.icon("shield")}Slowed: ${U.esc(job.throttle.why || "warning")}</span>`);
    if (s.warmup && !unfMode) chips.push(`<span class="chip violet">${U.icon("flame")}Warm-up ${L.daily}/day</span>`);
    { const ld = (st.lad && st.lad[unfMode ? "unfollow" : "follow"]) || {};
      if (ld.n > 0 && !(ld.until > Date.now()) && !stopped(mode)) chips.push(`<span class="chip amber">${U.icon("shield")}X refused ${ld.n}x today</span>`); }
    const ms = GX.modeSettings(s);
    if (s.activeHours) chips.push(`<span class="chip ${st.inWindow ? "green" : "gray"}" title="Daily ON / OFF time">${U.icon("clock")}ON ${ms.activeStart} · OFF ${ms.activeEnd}</span>`);
    if (job && job.executor === "profile" && active) chips.push(`<span class="chip gray">profile mode</span>`);
    const unf = st.unf || {}, bk = st.bk || {};
    if (unfMode) {
      const t = unf.stage === "ready" ? `Unfollow · ${U.fmt(unf.left)} old left` : unf.stage === "done" ? `Unfollow · ${unf.today}/${s.unfollowDaily} today` : "Unfollow · reading list";
      chips.push(`<span class="chip unf">${U.icon("userX")}${t}</span>`);
    } else if (bkMode) {
      const t = bk.stage === "ready" ? `Follow back · ${U.fmt(bk.left)} waiting` : bk.stage === "done" ? `Follow back · ${nu.done}/${nu.max} today` : "Follow back · reading followers";
      chips.push(`<span class="chip bk">${U.icon("userPlus")}${t}</span>`);
    }
    setHtml("liveChips", $("#liveChips"), chips.join(""));

    const cur = unfMode || bkMode ? (mine ? job.current : null) : active && job.current ? job.current : (st.poolTop && st.poolTop[0]);
    const curKey = cur ? (cur.i || cur.h) : "";
    if (ui.html.ltKey !== curKey) {
      ui.html.ltKey = curKey;
      const n = U.avatar(cur && cur.a, cur && (cur.n || cur.h), 52);
      n.id = "ltAvatar";
      $("#ltAvatar").replaceWith(n);
    }
    const bkWord = s.bkOrder === "old" ? "oldest" : "newest";
    const uWord = s.unfOrder === "new" ? "newest" : "oldest";
    $("#ltLabel").textContent = unfMode ? "Unfollow mode" : bkMode ? (active && mine && job.inFlight ? "Following back now" : "Follow back mode") : active && job.inFlight ? "Following now" : cur ? "Up next" : "Queue";
    $("#ltName").innerHTML = cur ? `<a href="https://x.com/${encodeURIComponent(cur.h)}" target="_blank" rel="noopener">${U.esc(cur.n || "@" + (cur.h || cur.i))}</a>` : (unfMode ? "Getting the next account..." : bkMode ? (active && mine ? "Getting the next account..." : `Next: your ${bkWord} follower`) : "Nobody yet");
    const last = job && job.lastFollow;
    $("#ltMeta").textContent = unfMode
      ? (cur && cur.tg === "fb" && cur.act ? `@${cur.h} follows you and is active · unfollowed because "active followers" is on`
        : cur && cur.tg === "fb" ? `@${cur.h} follows you but is inactive${unf.inact && unf.inact.total ? ` · inactive check ${U.fmt(Math.max(0, unf.inact.pos - unf.inact.deep))}/${U.fmt(unf.inact.total)}` : ""}`
        : unf.stage === "ready" && cur && cur.rk ? `Following #${U.fmt(cur.rk)} of ${U.fmt(cur.rkOf)} · ${uWord} first · ${U.fmt(unf.left)} left`
        : unf.stage === "ready" ? `Non-followers, ${uWord} first · ${U.fmt(unf.removed)} unfollowed · ${U.fmt(unf.left)} left` : unf.stage === "done" ? `No follow-back after ${s.unfollowAfterDays} days · ${U.fmt(unf.due || 0)} due · ${unf.today}/${s.unfollowDaily} today` : "Reading your following list from X...")
      : bkMode
      ? (cur && cur.rk ? `Follower #${U.fmt(cur.rk)} of ${U.fmt(cur.rkOf)} · ${bkWord} first · ${U.fmt(bk.left)} waiting`
        : bk.stage === "ready" ? `${U.fmt(bk.left)} waiting · ${bkWord} followers first · ${U.fmt(bk.followed)} followed back so far`
        : bk.stage === "done" ? `Everyone is followed back · ${nu.done}/${nu.max} today · looks for new followers by itself`
        : "Reading who follows you from X...")
      : cur
      ? `@${cur.h}${cur.src && cur.src !== "import" ? " · via @" + cur.src : cur.src === "import" ? " · imported" : ""}${last ? " · last: @" + last.h + " " + U.ago(last.at) : ""}`
      : ((st.sources || []).length ? "Press Find people now to fill the queue." : "Add sources to fill the queue.");
    $("#ltScore").innerHTML = unfMode ? (cur && cur.tg ? `<span class="lt-tag">${TAG(cur.tg)}${cur.tg === "fb" && cur.why ? `<small>${U.esc(cur.why)}</small>` : ""}</span>` : "")
      : bkMode ? (cur ? `<span class="lt-tag">${TAG("bk")}</span>` : "")
      : cur && cur.score ? `<span class="score ${scoreCls(cur.score)}" title="Follow-back score">${cur.score}</span>` : "";
    $("#liveMsg").textContent = engineMessage();

    if (unfMode || bkMode) {
      $("#lmHour").textContent = `${nu.hour}/${nu.hourMax}`;
      $("#lmHourBar").style.width = Math.min(100, nu.hour / Math.max(1, nu.hourMax) * 100) + "%";
      $("#lmDayLabel").textContent = unfMode ? "Unfollows today" : "Follow-backs today";
      $("#lmDayLabel").title = "";
      $("#lmDay").textContent = `${nu.done}/${nu.max}`;
      $("#lmDayBar").style.width = Math.min(100, nu.done / Math.max(1, nu.max) * 100) + "%";
    } else {
      $("#lmHour").textContent = `${st.hour}/${L.hourly}`;
      $("#lmHourBar").style.width = Math.min(100, st.hour / Math.max(1, L.hourly) * 100) + "%";
      // With a sequence running, the run target is what ONE TURN does before handing over, so show the turn.
      const cyc = GX.cycling(s) && (st.seq || {}).cycling;
      const turn = cyc ? GX.modeTurnTarget(s, "follow", L.daily) : 0;
      const hasTarget = cyc ? turn > 0 && turn < L.daily : s.sessionTarget > 0;
      const doneRun = job && active ? (cyc ? (job.turnDone || 0) : s.autoStart ? job.done - (job.dayBase || 0) : job.done) : 0;
      const goal = cyc ? turn : s.sessionTarget;
      $("#lmDayLabel").textContent = hasTarget ? (cyc ? "This turn" : "Run target") : "Last 24 hours";
      $("#lmDayLabel").title = hasTarget ? (cyc ? "GrowX hands over to the next mode when this is reached" : "GrowX stops exactly when this is reached") : "Safety cap only: GrowX does not run for 24 hours";
      $("#lmDay").textContent = hasTarget ? `${doneRun}/${goal}` : `${st.today}/${L.daily}`;
      $("#lmDayBar").style.width = Math.min(100, hasTarget ? doneRun / Math.max(1, goal) * 100 : st.today / Math.max(1, L.daily) * 100) + "%";
    }
    if (unfMode) { const ee = $("#lmEta"); if (ee) ee.hidden = true; }
    else if (bkMode) renderBkEta(s, L, nu);
    else renderEta(job, active, s, L);
    const planEl = $("#lmPlan");
    if (planEl) {
      const brk = s.restEvery ? `break after <b>${batchTxt(s.restEveryMin, s.restEvery)}</b> follows for <b>${brkTxt(s.restMinutes, s.restMinutesMax)}</b>` : "<b>no breaks</b>";
      const extra = (s.extraBreaks || []).map((b) => `${b.every}→${b.minutesMax > b.minutes ? b.minutes + "-" + b.minutesMax : b.minutes}m`).join(", ");
      const unsaved = ui.dirty.autopilot ? " &nbsp;— you have UNSAVED changes on the Autopilot page" : "";
      planEl.className = "live-plan" + (ui.dirty.autopilot ? " warn" : "");
      if (unfMode) planEl.innerHTML = `Unfollow mode: break every <b>${s.unfRestEvery}</b> unfollows for <b>${s.unfRestMinutes}</b> min · delay <b>${s.unfMinDelay}-${s.unfMaxDelay}</b>s · daily <b>${s.unfollowDaily}</b> · per hour <b>${nu.hourMax}</b>${s.hourlyAuto ? " (auto)" : ""} · hours <b>${s.unfollowStart}-${s.unfollowEnd}</b>${unsaved}`;
      else if (bkMode) planEl.innerHTML = `Follow back mode: <b>${bkWord}</b> followers first · break after <b>${batchTxt(s.bkRestEveryMin, s.bkRestEvery)}</b> follow-backs for <b>${s.bkRestMinutes}</b> min · delay <b>${s.bkMinDelay}-${s.bkMaxDelay}</b>s · daily <b>${nu.max}</b> · per hour <b>${nu.hourMax}</b>${s.hourlyAuto ? " (auto)" : ""} · hours <b>${s.bkStart}-${s.bkEnd}</b>${unsaved}`;
      else planEl.innerHTML = `Running with: ${brk}${extra ? " + " + extra : ""} · delay <b>${s.minDelay}-${s.maxDelay}</b>s · ${s.sessionTarget > 0 ? (GX.cycling(s) ? "per turn <b>" : "target <b>") + U.fmt(s.sessionTarget) + "</b>" : "no run target"} · daily <b>${L.daily}</b> · per hour <b>${L.hourly}</b>${s.hourlyAuto ? " (auto)" : ""}${unsaved}`;
    }
    const until = unfMode ? (mine && job.uRestAfter ? Math.max(0, job.uRestAfter - (job.uSince || 0)) : null)
      : bkMode ? (mine && job.bRestAfter ? Math.max(0, job.bRestAfter - (job.bSince || 0)) : null)
      : job && active && Number.isFinite(job.restAfter) ? Math.max(0, job.restAfter - job.sinceRest) : null;
    const brkOn = unfMode ? s.unfRestEvery : bkMode ? s.bkRestEvery : s.restEvery;
    $("#lmBreak").textContent = until == null ? (brkOn ? "-" : "off") : `${until} ${unfMode ? "unfollows" : bkMode ? "follow-backs" : "follows"}`;
    $("#lmBreakBar").style.width = until == null ? "0%" : unfMode ? Math.min(100, (job.uSince || 0) / Math.max(1, job.uRestAfter) * 100) + "%" : bkMode ? Math.min(100, (job.bSince || 0) / Math.max(1, job.bRestAfter) * 100) + "%" : Math.min(100, job.sinceRest / Math.max(1, job.restAfter) * 100) + "%";

    const ran = job && job.startedAt && (active || v.paused || v.halted) ? (Date.now() - job.startedAt) / 1000 : null;
    $("#lsDone").textContent = U.fmt(job ? (unfMode ? job.undone || 0 : bkMode ? job.bdone || 0 : job.done) : 0);
    $("#lsDone").nextElementSibling.textContent = unfMode ? "unfollowed this run" : bkMode ? "followed back this run" : "followed this run";
    $("#lsSkip").textContent = U.fmt(unfMode ? Math.min(unfAll(unf), unfFol(unf)) : bkMode ? (bk.skipped || 0) : job ? job.skipped : 0);
    $("#lsSkip").nextElementSibling.textContent = unfMode ? "followers unfollowed" : bkMode ? "skipped (inactive, private…)" : "skipped";
    $("#lsFail").textContent = U.fmt(unfMode ? (unf.skipped || 0) : job ? job.failed : 0);
    $("#lsFail").nextElementSibling.textContent = unfMode ? "kept (follow you)" : "failed";
    $("#lsTime").textContent = ran == null ? "-" : U.dur(ran);
  }

  // Follow back: how long the rest of today's number takes (same delays and breaks the engine uses).
  function renderBkEta(s, L, nu) {
    const el = $("#lmEta");
    if (!el) return;
    const b = st.bk || {};
    const left = Math.max(0, nu.max - nu.done);
    const n = b.stage === "ready" ? Math.min(left, b.left || 0) : 0;
    if (!left) { el.hidden = false; el.className = "live-eta"; el.innerHTML = "<b>Today's follow-back number is reached.</b>"; return; }
    if (!n) { el.hidden = true; return; }
    const ms = GX.modeSettings(s);
    const plan = simulatePlan(paceOf(ms), n, L.slow);
    let at = Date.now(), rest = plan.total;
    if (s.activeHours) {
      let guard = 0;
      while (rest > 0 && guard++ < 20000) {
        if (GX.inWindow(ms, at)) { const step = Math.min(rest, 300); at += step * 1000; rest -= step; }
        else at = GX.nextWindowStart(ms, at);
      }
    } else at += rest * 1000;
    const when = new Date(at);
    const clockTxt = when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) + (when.toDateString() !== new Date().toDateString() ? " " + when.toLocaleDateString([], { weekday: "short" }) : "");
    el.hidden = false;
    el.className = "live-eta";
    el.innerHTML = `<b>${U.fmt(n)} follow-backs to go today</b> · about <b>${U.dur(plan.total)}</b> of working time · done around <b>${clockTxt}</b>${n < left ? " (fewer people are waiting than your number - then it rests and looks for new followers)" : ""}`;
  }

  function scoreCls(sc) { return !sc ? "s-na" : sc >= 70 ? "s-hi" : sc >= 55 ? "s-mid" : "s-lo"; }

  function monthInfo() {
    const now = new Date();
    const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const elapsed = Math.max(1, now.getDate() - 1 + now.getHours() / 24);
    return { days, left: Math.max(1, days - now.getDate() + 1), elapsed };
  }

  function renderGoal() {
    const s = st.settings, sum = st.summary || {};
    const goal = s.goalMonthly || 0;
    const g = sum.gainedMonth;
    const m = monthInfo();
    $("#goalTitle").textContent = goal ? `${U.fmt(goal)} new followers` : "No goal set";
    if (!$("#goalRing svg")) $("#goalRing").insertAdjacentHTML("afterbegin", U.ring(0, 168, 14));
    if (!$("#goalGrad")) $("#goalRing svg").insertAdjacentHTML("afterbegin", '<defs><linearGradient id="goalGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FF5A68"/><stop offset="1" stop-color="#B3122B"/></linearGradient></defs>');
    U.setRing($("#goalRing svg"), goal && g ? Math.max(0, g) / goal : 0);
    $("#goalGained").textContent = g == null ? "-" : U.signed(g);
    $("#goalPct").textContent = goal && g != null ? `${Math.round(Math.max(0, g) / goal * 100)}% of goal` : "this month";
    $("#goalDays").textContent = m.left;
    $("#goalNeed").textContent = goal && g != null ? U.fmt(Math.max(0, goal - g) / m.left) : (goal ? U.fmt(goal / m.days) : "-");
    $("#goalProj").textContent = g == null ? "-" : U.compact(Math.round(g / m.elapsed * m.days));
    $("#goalNote").textContent = g == null
      ? "Growth is measured from your follower count every few hours while GrowX runs."
      : g / m.elapsed * m.days >= goal ? "You're on pace. Keep the autopilot running." : "Behind pace - see the Planner in Analytics for what to change.";
  }

  async function renderFollowersChart() {
    if (ui.html.chart) return;
    const growth = await getGrowth();
    const pts = growth.slice(-30).map((d) => ({ x: d.d.slice(5).replace("-", "/"), y: d.f }));
    ui.html.chart = "1";
    $("#chFollowers").innerHTML = U.areaChart(pts, { h: 220, label: "Followers", empty: "Your follower chart appears after the first day of tracking." });
    const gained = pts.length > 1 ? pts[pts.length - 1].y - pts[0].y : null;
    $("#chGain").textContent = gained == null ? "" : U.signed(gained) + " in " + pts.length + " days";
    $("#chGain").hidden = gained == null;
  }

  function renderFeed() {
    const job = st.job;
    let rows = [];
    const ICON = { ok: "check", skip: "chevron", fail: "x", wait: "clock", run: "play", fb: "heart", warn: "alert", halt: "alert", source: "target", harvest: "search" };
    if (ui.feed === "log") {
      rows = ((job && job.log) || []).slice(0, 40).map((l) => ({ t: l.t, k: l.r, m: (l.h ? "@" + l.h + " - " : "") + (l.m || ""), tg: l.tg, w: l.w, rk: l.rk, rkOf: l.rkOf }));
    } else {
      rows = (st.events || []).slice(0, 40).map((e) => ({ t: e.t, k: e.k, m: e.m }));
    }
    const html = rows.length
      ? rows.map((r, i) => {
        const tip = [r.rk ? (r.tg === "bk" ? `follower #${U.fmt(r.rk)} of ${U.fmt(r.rkOf)} (1 = your newest follower)` : `#${U.fmt(r.rk)} of ${U.fmt(r.rkOf)} accounts you follow (1 = the first you ever followed)`) : "", r.w || ""].filter(Boolean).join(" · ") || r.m;
        return `<div class="feed-row${r.tg ? " has-tag" : ""}" style="animation-delay:${Math.min(i, 10) * 25}ms"><span class="fi ${U.esc(r.k)}">${U.icon(ICON[r.k] || "info")}</span><p title="${U.esc(tip)}">${U.esc(r.m)}${r.rk ? ` <small class="rk">#${U.fmt(r.rk)}</small>` : ""}</p>${r.tg ? TAG(r.tg) : ""}<time>${U.clock(r.t)}</time></div>`;
      }).join("")
      : `<div class="empty">${U.icon("sparkles")}<b>Nothing yet</b><span>${ui.feed === "log" ? "Every follow, skip and break shows up here live." : "Runs, warnings and follow-back checks show up here."}</span></div>`;
    setHtml("feed", $("#feed"), html);
  }

  function tickLocal() {
    if (!st) return;
    const job = st.job, now = Date.now();
    const v = U.jobView(job, st.task);
    let label = "Autopilot is off", time = "--", frac = 0, live = false;
    if (job && job.status === "running") {
      const lastAct = job.mode === "unfollow" ? job.lastUnfollow : job.mode === "followback" ? job.lastFollowBack : job.lastFollow;
      const start = Math.max((lastAct && lastAct.at) || job.startedAt, (job.nextAt || now) - 30 * 60000);
      const left = (job.nextAt || now) - now;
      label = job.mode === "unfollow" ? "Next unfollow in" : job.mode === "followback" ? (job.inFlight ? "Following back now" : "Next follow-back in") : job.inFlight ? "Following now" : "Next follow in";
      time = job.inFlight || left <= 800 ? "now" : U.countdown(left);
      frac = job.nextAt > start ? (now - start) / (job.nextAt - start) : 1;
      live = true;
    } else if (job && (job.status === "resting" || job.status === "sleeping") && job.restUntil) {
      const key = job.status + job.restUntil;
      if (ui.phase.key !== key) ui.phase = { key, start: now };
      label = (job.status === "sleeping" ? "Sleeping · back " : job.restReason === "switch" ? "Transition break · " + (MODE_NAME[(job.trans || {}).to] || "next mode") + " at " : "On a break · back ") + U.clock(job.restUntil);
      time = U.countdown(job.restUntil - now);
      frac = job.restUntil > ui.phase.start ? (now - ui.phase.start) / (job.restUntil - ui.phase.start) : 0;
    } else if (v.paused) label = "Paused";
    else if (v.halted) label = "Stopped - needs your attention";
    else if (v.task) { label = "Searching your sources"; time = "..."; live = true; frac = 1; }
    $$(".ovr-live[data-until]").forEach((el) => {
      const u = Number(el.dataset.until) || 0;
      el.textContent = u > now ? U.countdown(u - now) : "now";
    });
    $$(".pt-left[data-until]").forEach((el) => {
      const u = Number(el.dataset.until) || 0;
      el.textContent = u > now ? U.countdown(u - now) : "now";
    });
    if (route === "overview") {
      const c = $("#liveSeq .ls-count");
      if (c) { const u = Number(c.dataset.until) || 0; c.textContent = u > now ? U.countdown(u - now) : "now"; }
      $("#lcLabel").textContent = label;
      $("#lcTime").textContent = time;
      $("#lcBar").classList.toggle("is-live", live);
      $("#lcBar").firstElementChild.style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + "%";
    }
  }

  // =====================================================================
  // SOURCES
  // =====================================================================
  function wireSources() {
    $("#srcAdd").addEventListener("click", async () => {
      const { handles, bad } = U.handlesFrom($("#srcText").value);
      if (!handles.length) { U.toast("Type one or more usernames, like @creator", "bad"); return; }
      const r = await U.cmd("addSources", { handles });
      if (!r.ok) return U.toast(r.error || "Couldn't add sources.", "bad");
      $("#srcText").value = "";
      U.toast(`Added ${r.added} source${r.added === 1 ? "" : "s"}${bad ? ` · ${bad} not valid` : ""}${handles.length - r.added > 0 ? ` · ${handles.length - r.added} already added` : ""}`, r.added ? "good" : "");
      refresh();
    });
    $("#srcText").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("#srcAdd").click(); });
    $("#srcHarvest").addEventListener("click", harvestNow);
    $("#taskStop").addEventListener("click", async () => { await U.cmd("taskStop"); refresh(); });
    $("#srcList").addEventListener("click", async (e) => {
      const card = e.target.closest("[data-h]");
      if (!card) return;
      const h = card.dataset.h;
      if (e.target.closest("[data-src-remove]")) {
        const ok = await confirmBox({ title: `Remove @${h}?`, body: "GrowX stops reading this profile. People already queued from it stay in the queue.", ok: "Remove", icon: "trash" });
        if (!ok) return;
        await U.cmd("source", { op: "remove", h });
        U.toast(`Removed @${h}`);
      } else if (e.target.closest("[data-src-reset]")) {
        await U.cmd("source", { op: "reset", h });
        U.toast(`@${h} will be re-read from its newest followers`, "good");
      } else return;
      refresh();
    });
    $("#srcList").addEventListener("change", async (e) => {
      const t = e.target.closest("[data-src-toggle]");
      if (!t) return;
      const h = t.closest("[data-h]").dataset.h;
      await U.cmd("source", { op: "toggle", h, on: t.checked });
      refresh();
    });
  }

  async function harvestNow() {
    const r = await U.cmd("harvestNow");
    if (!r.ok) U.toast(r.error || "Couldn't start.", "bad", 4500);
    else {
      const j = st.job, paused = j && (j.status === "sleeping" || (j.status === "resting" && !["cooldown", "daily", "hourly", "cap", "empty", "errors"].includes(j.restReason)));
      U.toast(!r.viaJob ? "Searching all your sources..." : paused ? "The autopilot will search all your sources as soon as it resumes." : "The autopilot is searching all your sources now.", "good");
    }
    refresh();
  }

  function srcStatus(x) {
    if (!x.enabled) return ["gray", "Paused"];
    switch (x.status) {
      case "ok": return x.deepDone && x.lastTopAt ? ["green", "Up to date"] : ["green", "Active"];
      case "private": return ["amber", "Private"];
      case "gone": return ["red", "Not found"];
      case "error": return ["red", "Error"];
      default: return ["gray", "Not read yet"];
    }
  }

  // The "Find people now" sweep in progress: a one-off search, or one the
  // running autopilot is doing between follows.
  function liveSweep() {
    const t = st.task, j = st.job;
    if (t && t.status === "running" && t.kind === "harvest" && t.sweep) return t.sweep;
    if (j && j.sweep && ["running", "resting"].includes(j.status)) return j.sweep;
    return null;
  }

  function sweepChip(sw, x) {
    const k = String(x.h).toLowerCase();
    if (!sw || !sw.list.includes(k)) return "";
    if (sw.done[k]) {
      return sw.notes[k]
        ? `<span class="chip amber">skipped: ${U.esc(sw.notes[k])}</span>`
        : `<span class="chip green">${U.icon("check")}searched · +${U.fmt(sw.added[k] || 0)}</span>`;
    }
    return sw.pages[k] ? `<span class="chip red">${U.icon("search")}searching · +${U.fmt(sw.added[k] || 0)}</span>` : '<span class="chip gray">in line</span>';
  }

  function renderSources() {
    const t = st.task, now = Date.now();
    const running = t && t.status === "running";
    const sw = liveSweep();
    const banner = running || !!sw;
    $("#taskBanner").hidden = !banner;
    if (banner) {
      const n = sw ? sw.list.length : 0, d = sw ? sw.list.filter((k) => sw.done[k]).length : 0;
      const added = sw ? Object.values(sw.added).reduce((a, b) => a + b, 0) : 0;
      $("#taskMsg").textContent = running ? (t.message || "Working...")
        : `Autopilot is searching every source · ${d} of ${n} done · +${U.fmt(added)} people`;
      $("#taskBar").hidden = !sw;
      if (sw) $("#taskBar").firstElementChild.style.width = Math.max(4, n ? d / n * 100 : 0) + "%";
      $("#taskStop").hidden = !running;
    }
    // Result of the last search, shown for a while after it finished.
    let note = null;
    if (!banner) {
      const j = st.job;
      if (t && t.kind === "harvest" && t.status === "done" && t.finishedAt) note = { at: t.finishedAt, text: t.message };
      if (j && j.lastSweep && (!note || j.lastSweep.at > note.at)) note = j.lastSweep;
      if (note && now - note.at > 6 * HOUR) note = null;
    }
    $("#sweepNote").hidden = !note;
    if (note) $("#sweepText").textContent = `Last search ${U.ago(note.at)}: ${note.text}`;
    const list = st.sources || [];
    const html = list.length ? list.map((x) => {
      const [cls, label] = srcStatus(x);
      const rate = x.followed >= 10 ? (x.back || 0) / x.followed : null;
      const reasons = Object.entries(x.reasons || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(" · ");
      return `<div class="card src lift ${x.enabled ? "" : "off"}" data-h="${U.esc(x.h)}">
        <div class="src-top">${U.avatarHtml(x.a, x.n || x.h, 44)}
          <div class="src-who"><b>${U.esc(x.n || "@" + x.h)}</b><a href="https://x.com/${encodeURIComponent(x.h)}" target="_blank" rel="noopener">@${U.esc(x.h)}${x.fc != null ? " · " + U.compact(x.fc) + " followers" : ""}</a></div>
          <label class="switch" title="${x.enabled ? "Pause this source" : "Use this source"}"><input type="checkbox" data-src-toggle ${x.enabled ? "checked" : ""}><span class="track"></span></label>
        </div>
        <div class="btn-row"><span class="chip ${cls}">${U.esc(label)}</span>${sw ? sweepChip(sw, x) : x.pass ? '<span class="chip red">in rotation</span>' : ""}${x.v ? '<span class="chip violet">verified</span>' : ""}</div>
        ${x.note && x.status !== "ok" ? `<p class="src-note">${U.esc(x.note)}</p>` : ""}
        <div class="src-stats">
          <div><b class="num">${U.compact(x.harvested || 0)}</b><span>read</span></div>
          <div><b class="num">${U.compact(x.queued || 0)}</b><span>queued</span></div>
          <div><b class="num">${U.compact(x.followed || 0)}</b><span>followed</span></div>
          <div><b class="num">${U.compact(x.back || 0)}</b><span>back</span></div>
        </div>
        <div class="src-rate"><span class="text-2">Follow-back rate</span><b class="num">${rate == null ? `<span class="muted">${x.followed ? "learning" : "-"}</span>` : U.pct(rate, 1)}</b><div class="bar thin ${rate != null && rate >= 0.25 ? "green" : ""}"><i style="width:${rate == null ? 0 : Math.min(100, rate * 250)}%"></i></div></div>
        <div class="src-foot"><small title="${U.esc(reasons)}">${x.lastHarvestAt ? "read " + U.ago(x.lastHarvestAt) : "added " + U.ago(x.addedAt)}${reasons ? " · top skip: " + U.esc(Object.keys(x.reasons || {}).sort((a, b) => x.reasons[b] - x.reasons[a])[0]) : ""}</small>
          <div class="row-acts"><button class="icon-btn" data-src-reset title="Re-read from the newest followers">${U.icon("refresh")}</button><button class="icon-btn" data-src-remove title="Remove source">${U.icon("trash")}</button></div></div>
      </div>`;
    }).join("") : `<div class="card empty" style="grid-column:1/-1">${U.icon("target")}<b>No sources yet</b><span>Add profiles in your niche above. Their newest followers become your audience.</span></div>`;
    setHtml("src", $("#srcList"), html);
  }

  // =====================================================================
  // QUEUE
  // =====================================================================
  function wireQueue() {
    $("#qHarvest").addEventListener("click", harvestNow);
    $("#qSearch").addEventListener("input", debounce(() => { ui.qShow = 100; renderQueue(); }, 150));
    $("#qSource").addEventListener("change", () => { ui.qShow = 100; renderQueue(); });
    $("#qSort").addEventListener("click", (e) => {
      const b = e.target.closest("[data-sort]");
      if (!b) return;
      ui.qSort = b.dataset.sort;
      $$("#qSort button").forEach((x) => x.classList.toggle("on", x === b));
      renderQueue();
    });
    $("#qMoreBtn").addEventListener("click", () => { ui.qShow += 200; renderQueue(); });
    $("#qClear").addEventListener("click", async () => {
      const ok = await confirmBox({ title: "Clear the queue?", body: "Everyone waiting is removed. GrowX refills the queue from your sources when needed.", ok: "Clear queue", icon: "trash" });
      if (!ok) return;
      await U.cmd("pool", { op: "clear" });
      ui.sel.clear();
      U.toast("Queue cleared");
    });
    $("#qAll").addEventListener("change", async (e) => {
      const rows = await queueRows();
      if (e.target.checked) rows.slice(0, ui.qShow).forEach((c) => ui.sel.add(String(c.i || c.h)));
      else ui.sel.clear();
      renderQueue(true);
    });
    $("#qRows").addEventListener("change", (e) => {
      const cb = e.target.closest("[data-sel]");
      if (!cb) return;
      const id = cb.closest("[data-id]").dataset.id;
      if (cb.checked) ui.sel.add(id); else ui.sel.delete(id);
      updateBulk();
    });
    $("#qRows").addEventListener("click", async (e) => {
      const b = e.target.closest("[data-q]");
      if (!b) return;
      const id = b.closest("[data-id]").dataset.id;
      await poolOp(b.dataset.q, [id]);
    });
    $("#qBulk").addEventListener("click", async (e) => {
      const b = e.target.closest("[data-bulk]");
      if (!b) return;
      if (b.dataset.bulk === "none") { ui.sel.clear(); renderQueue(true); return; }
      await poolOp(b.dataset.bulk, [...ui.sel]);
      ui.sel.clear();
      renderQueue(true);
    });
    $("#qImport").addEventListener("click", () => { $("#importModal").hidden = false; $("#impText").focus(); });
    $("#impCancel").addEventListener("click", () => { $("#importModal").hidden = true; });
    $("#importModal").addEventListener("click", (e) => { if (e.target.id === "importModal") $("#importModal").hidden = true; });
    $("#impOk").addEventListener("click", async () => {
      const r = await addByName($("#impText").value, $("#impPin").checked);
      if (!r) return;
      $("#importModal").hidden = true;
      $("#impText").value = "";
    });
    $("#listAdd")?.addEventListener("click", async () => {
      const r = await addByName($("#listText").value, $("#listPin").checked);
      if (!r) return;
      $("#listText").value = "";
      showListResult(r);
    });
  }

  // Paste usernames or profile links -> the Follow queue. Already-followed
  // accounts are skipped, and the answer says what happened to every name.
  async function addByName(text, pin) {
    const { handles } = U.handlesFrom(text || "");
    if (!handles.length) { U.toast("No usernames or links found in that.", "bad"); return null; }
    const r = await U.cmd("pool", { op: "import", handles, pin: !!pin });
    if (!r || !r.ok) { U.toast((r && r.error) || "Couldn't add those.", "bad"); return null; }
    const bits = [];
    if (r.back) bits.push(`${r.back} sent to Follow back`);
    if (r.cleaned) bits.push(`${r.cleaned} cleared off the queue`);
    if (r.following) bits.push(`${r.following} already followed`);
    if (r.queued) bits.push(`${r.queued} already in the queue`);
    if (r.again) bits.push(`${r.again} you unfollowed before`);
    if (r.blocked) bits.push(`${r.blocked} on a keep or block list`);
    if (r.bad) bits.push(`${r.bad} not a username`);
    if (r.dup) bits.push(`${r.dup} repeated`);
    U.toast(r.added || r.back
      ? `${U.fmt(r.added)} added to the Follow queue${bits.length ? " · " + bits.join(" · ") : ""}.`
      : `Nothing new to add${bits.length ? " · " + bits.join(" · ") : ""}.`, r.added || r.back ? "good" : "warn", 6000);
    refresh();
    return r;
  }

  // The same answer written out, so you can see which names were skipped.
  function showListResult(r) {
    const box = $("#listResult");
    if (!box) return;
    const line = (n, label, names, cls) => n
      ? `<div class="ir-row ${cls || ""}"><b>${U.fmt(n)}</b><span>${label}</span>${names && names.length ? `<em>${names.slice(0, 12).map((h) => "@" + U.esc(h)).join(", ")}${n > names.length || n > 12 ? " …" : ""}</em>` : ""}</div>`
      : "";
    box.innerHTML = line(r.added, "added to the Follow queue", null, "ir-ok")
      + line(r.back, "they already follow you - sent to the front of Follow back", r.names && r.names.back, "ir-ok")
      + line(r.cleaned, "taken off the queue - you already follow them")
      + line(r.following, "skipped - you already follow them", r.names && r.names.following)
      + line(r.queued, "skipped - already waiting in the queue", r.names && r.names.queued)
      + line(r.again, "skipped - you unfollowed them before", r.names && r.names.again)
      + line(r.blocked, "skipped - on your keep or block list", r.names && r.names.blocked)
      + line(r.bad, "not a username or link", r.names && r.names.bad, "ir-bad")
      + (r.dup ? `<div class="ir-row"><b>${U.fmt(r.dup)}</b><span>the same name more than once</span></div>` : "");
    box.hidden = !box.innerHTML;
  }

  async function poolOp(op, ids) {
    const r = await U.cmd("pool", { op, ids });
    if (!r.ok) return U.toast(r.error || "Failed.", "bad");
    U.toast(op === "pin" ? "Pinned to the top - followed first" : op === "block" ? "Added to Never follow" : "Removed from the queue");
  }

  async function queueRows() {
    const pool = await getPool();
    const q = $("#qSearch").value.trim().toLowerCase();
    const src = $("#qSource").value;
    let rows = pool.filter((c) => (!src || c.src === src) && (!q || (`${c.n} ${c.h} ${c.b || ""}`).toLowerCase().includes(q)));
    if (ui.qSort === "new") rows = rows.slice().sort((a, b) => (b.at || 0) - (a.at || 0));
    else if (ui.qSort === "fc") rows = rows.slice().sort((a, b) => (a.fc ?? 1e12) - (b.fc ?? 1e12));
    return rows;
  }

  function updateBulk() {
    $("#qBulk").hidden = !ui.sel.size;
    $("#qSel").textContent = `${ui.sel.size} selected`;
  }

  async function renderQueue(force) {
    // source filter options
    const opts = ['<option value="">All sources</option>'].concat((st.sources || []).map((x) => `<option value="${U.esc(x.h)}">@${U.esc(x.h)}</option>`), '<option value="import">Imported</option>').join("");
    const sel = $("#qSource");
    if (ui.html.qSrc !== opts) { const v = sel.value; sel.innerHTML = opts; sel.value = v; ui.html.qSrc = opts; }
    const rows = await queueRows();
    const shown = rows.slice(0, ui.qShow);
    const html = shown.length ? shown.map((c, i) => {
      const id = String(c.i || c.h);
      const ratio = c.fc != null && c.fr != null ? (c.fr / Math.max(1, c.fc)).toFixed(2) : "-";
      return `<div class="trow q-cols" data-id="${U.esc(id)}" style="animation-delay:${Math.min(i, 14) * 18}ms">
        <label class="cb"><input type="checkbox" data-sel ${ui.sel.has(id) ? "checked" : ""}><i></i></label>
        <div class="who">${U.avatarHtml(c.a, c.n || c.h, 34)}<div><b>${c.pin ? "📌 " : ""}${U.esc(c.n || "@" + c.h)}</b><a href="https://x.com/${encodeURIComponent(c.h)}" target="_blank" rel="noopener">@${U.esc(c.h)}</a>${c.b ? `<small title="${U.esc(c.b)}">${U.esc(c.b)}</small>` : ""}</div></div>
        <span class="score ${scoreCls(c.score)}">${c.score || "-"}</span>
        <span class="num">${U.compact(c.fc)}</span>
        <span class="num">${U.compact(c.fr)}</span>
        <span class="num">${ratio}</span>
        <span class="cell-muted">${c.lt ? U.ago(c.lt) : "-"}</span>
        <span class="cell-muted">${c.src === "import" ? "imported" : "@" + U.esc(c.src || "")}</span>
        <div class="row-acts"><button class="icon-btn" data-q="pin" title="${c.pin ? "Unpin" : "Follow first"}">${U.icon("pin")}</button><button class="icon-btn" data-q="remove" title="Remove">${U.icon("x")}</button><button class="icon-btn" data-q="block" title="Never follow">${U.icon("ban")}</button></div>
      </div>`;
    }).join("") : `<div class="empty">${U.icon("list")}<b>${(await getPool()).length ? "No matches" : "The queue is empty"}</b><span>${(st.sources || []).length ? "Press Find more - or just start the autopilot, it fills the queue by itself." : "Add sources first, then GrowX fills the queue."}</span></div>`;
    if (force) ui.html.q = "";
    setHtml("q", $("#qRows"), html);
    $("#qMore").hidden = rows.length <= ui.qShow;
    $("#qAll").checked = shown.length > 0 && shown.every((c) => ui.sel.has(String(c.i || c.h)));
    updateBulk();
  }

  // =====================================================================
  // FORMS (targeting / autopilot / settings)
  // =====================================================================
  const SAVEBAR = { targeting: "#saveTargeting", autopilot: "#saveAutopilot", settings: "#saveSettings", sequence: "#saveSequence" };
  // Forms that are filled from the saved settings when their page opens.
  const FORM_ROUTES = { targeting: ["targeting"], autopilot: ["autopilot", "sequence"], settings: ["settings"] };

  function wireForms() {
    for (const name of Object.keys(SAVEBAR)) {
      $$(`[data-form="${name}"]`).forEach((f) => {
        // Switching "unfollow active followers" ON asks first (it is the one switch that unfollows people who follow you back).
        const askFirst = (el) => !!(el && el.matches && el.matches('[data-k="unfActiveToo"]') && el.checked);
        f.addEventListener("input", (e) => { if (askFirst(e.target)) return; syncTwins(e.target); markDirty(name); if (e.target.closest(".card") && e.target.closest(".card").querySelector("[data-batch-preview]")) renderBatchPreview(e.target.closest(".card")); });
        f.addEventListener("change", async (e) => {
          if (askFirst(e.target)) {
            const el = e.target, sx = draft(name);
            const ok = await confirmBox({
              title: "Unfollow active followers too?",
              body: `When fewer non-followers are due than your daily number, GrowX will also unfollow people who follow you back - ${sx.unfOrder === "new" ? "the ones you followed most recently first" : "the ones you followed longest ago first"} - until the number is reached. They stay your followers; you just stop following them, and some may unfollow you back. Anyone on your Never unfollow list and anyone you followed in the last ${sx.unfollowAfterDays} days is skipped. You can switch this off any time.`,
              ok: "Yes, turn it on", icon: "userX"
            });
            if (!ok) { el.checked = false; return; }
          }
          syncTwins(e.target); markDirty(name);
        });
      });
      const bar = $(SAVEBAR[name]);
      bar.querySelector("[data-save]").addEventListener("click", () => saveForm(name));
      bar.querySelector("[data-revert]").addEventListener("click", () => fillForm(name));
    }
    $("#f_minScore").addEventListener("input", () => { $("#f_minScoreVal").textContent = $("#f_minScore").value; });
    // Each Daily ON / OFF card keeps its OWN working days. Unfollow and Follow back start out sharing Follow's
    // days ("Same days as Follow"); untick that and they keep their own.
    $$(".days").forEach((box) => {
      box.innerHTML = DAY_NAMES.map((d, i) => `<button type="button" data-day="${i}">${d}</button>`).join("");
      box.addEventListener("click", (e) => {
        const b = e.target.closest("[data-day]");
        if (!b) return;
        b.classList.toggle("on");
        // Changing Follow's days also moves any mode that is set to follow them.
        if (box.dataset.days === "follow") syncSameDays();
        markDirty("autopilot");
      });
    });
    for (const [id, mode] of [["#unfSameDays", "unfollow"], ["#bkSameDays", "followback"]]) {
      const cb = $(id);
      if (!cb) continue;
      cb.addEventListener("change", () => { syncSameDays(); markDirty("autopilot"); });
    }
    wireExtraBreaks();
    wireSequence();
    ['phGoal', 'phHours', 'phBreak', 'phDelay'].forEach((id) => $('#' + id).addEventListener('input', () => { if (id === 'phBreak') $('#phBreak').dataset.init = '1'; renderPlanHelper(draft('autopilot')); }));
    $('#phApply').addEventListener('click', applyPlanHelper);
    $("#unsavedSave").addEventListener("click", () => { const b = $("#saveAutopilot [data-save]"); if (b) b.click(); });
    // pace cards: one click saves and applies that pace
    $("#unfPresets").addEventListener("click", (e) => { const b = e.target.closest("[data-upreset]"); if (b) applyPreset("unfollow", b.dataset.upreset); });
    $("#bkPresets").addEventListener("click", (e) => { const b = e.target.closest("[data-bpreset]"); if (b) applyPreset("followback", b.dataset.bpreset); });
    $("#presets").addEventListener("click", (e) => { const b = e.target.closest("[data-preset]"); if (b) applyPreset("follow", b.dataset.preset); });
  }

  // ---- working days: one set of chips per mode (not data-k fields) ----
  const daysBox = (mode) => $(`.days[data-days="${mode}"]`);
  function setDays(mode, list) {
    const box = daysBox(mode);
    if (!box) return;
    const on = new Set((list || []).map(Number));
    $$("[data-day]", box).forEach((b) => b.classList.toggle("on", on.has(Number(b.dataset.day))));
  }
  function getDays(mode) {
    const box = daysBox(mode);
    return box ? $$("[data-day].on", box).map((b) => Number(b.dataset.day)) : null;
  }
  // A mode set to "Same days as Follow" shows Follow's days and cannot be edited on its own.
  function syncSameDays() {
    for (const [id, mode] of [["#unfSameDays", "unfollow"], ["#bkSameDays", "followback"]]) {
      const cb = $(id), box = daysBox(mode);
      if (!cb || !box) continue;
      box.classList.toggle("locked", cb.checked);
      if (cb.checked) setDays(mode, getDays("follow") || []);
    }
  }

  // ---- extra break rules (rows are not data-k fields: read/written by hand) ----
  function renderExtraBreaks(list) {
    const box = $("#extraBreaks");
    if (!box) return;
    box.innerHTML = (list && list.length ? list : []).map((b) =>
      `<div class="xb-row"><span>After</span><input class="input num xb-every" type="number" min="1" value="${Number(b.every) || ""}"><span>follows, rest</span><input class="input num xb-min" type="number" min="1" value="${Number(b.minutes) || ""}"><span>to</span><input class="input num xb-max" type="number" min="1" value="${Number(b.minutesMax || b.minutes) || ""}"><span>min</span><button type="button" class="btn btn-ghost xb-del">Remove</button></div>`
    ).join("") || '<div class="xb-empty">No extra rules. Only the main break applies.</div>';
  }
  function readExtraBreaks() {
    return $$("#extraBreaks .xb-row").map((r) => ({ every: Number(r.querySelector(".xb-every").value), minutes: Number(r.querySelector(".xb-min").value), minutesMax: Number(r.querySelector(".xb-max").value) }))
      .filter((b) => b.every >= 1 && b.minutes >= 1);
  }
  function wireExtraBreaks() {
    $("#addBreak").addEventListener("click", () => {
      const cur = $$("#extraBreaks .xb-row").length ? readExtraBreaksRaw() : [];
      if (cur.length >= 6) return U.toast("Up to 6 extra break rules.", "bad");
      cur.push({ every: 100, minutes: 60, minutesMax: 75 });
      renderExtraBreaks(cur);
      markDirty("autopilot");
    });
    $("#extraBreaks").addEventListener("click", (e) => {
      const b = e.target.closest(".xb-del");
      if (!b) return;
      b.closest(".xb-row").remove();
      if (!$$("#extraBreaks .xb-row").length) renderExtraBreaks([]);
      markDirty("autopilot");
    });
  }
  function readExtraBreaksRaw() {
    return $$("#extraBreaks .xb-row").map((r) => ({ every: Number(r.querySelector(".xb-every").value) || 0, minutes: Number(r.querySelector(".xb-min").value) || 0, minutesMax: Number(r.querySelector(".xb-max").value) || 0 }));
  }

  function markDirty(name) {
    ui.dirty[name] = true;
    $(SAVEBAR[name]).hidden = false;
    if (name === "autopilot") { const bn = $("#unsavedBanner"); if (bn) bn.hidden = false; }
    if (name === "targeting") renderTargeting();
    if (name === "autopilot") { renderAutopilot(); if (!ui.dirty.sequence) renderSeqCards(GX.modeOrder(seqDraft()), seqDraft().switchOff || []); }
    if (name === "sequence") renderSeqCard();
  }

  // Live line under "Take a break after": what one round looks like with the numbers typed right now
  function renderBatchPreview(root) {
    $$("[data-batch-preview]", root).forEach((el) => {
      const card = el.closest(".card") || document;
      const f = el.closest(".batch-field");
      const ins = f.querySelectorAll("input[data-k]");
      let lo = Math.round(Number(ins[0].value) || 0), hi = Math.round(Number(ins[1].value) || 0);
      const mEl = card.querySelector(`[data-k="${el.dataset.mk}"]`);
      const mEl2 = card.querySelector(`[data-k="${el.dataset.mk}Max"]`);
      const mins = mEl ? Math.round(Number(mEl.value) || 0) : 0;
      let mmax = mEl2 ? Math.round(Number(mEl2.value) || 0) : 0;
      if (!mmax || mmax < mins) mmax = mins;
      const bt = mmax > mins ? `<b>${mins}-${mmax} min</b>` : `<b>${mins} min</b>`;
      const w = el.dataset.word;
      if (!hi) { el.className = "batch-preview warn"; el.innerHTML = `Breaks are off - ${w} go on without a pause (not recommended).`; return; }
      if (!lo || lo > hi) lo = hi;
      const list = [];
      for (let n = lo; n <= hi && list.length < 6; n++) list.push(n);
      const many = hi - lo + 1 > 6 ? `${lo} to ${hi}` : list.length > 1 ? list.slice(0, -1).join(", ") + " or " + list[list.length - 1] : String(lo);
      el.className = "batch-preview";
      el.innerHTML = lo === hi
        ? `Every round: exactly <b>${hi}</b> ${w}, then a ${bt} break${mmax > mins ? " (a random length in that range)" : ""}.`
        : `Every round: <b>${many}</b> ${w} (picked at random, never more than <b>${hi}</b>), then a ${bt} break${mmax > mins ? " (also picked at random)" : ""}.`;
    });
  }

  function fillForm(name) {
    if (!st) return;
    const s = st.settings;
    $$(`[data-form="${name}"] [data-k]`).forEach((el) => {
      const k = el.dataset.k;
      if (!(k in s)) return;
      if (el.type === "checkbox") el.checked = !!s[k];
      else el.value = s[k];
    });
    if (name === "targeting") $("#f_minScoreVal").textContent = s.minScore;
    if (name === "autopilot") {
      setDays("follow", s.activeDays);
      // an empty list means "the same days as Follow"
      const unfOwn = (s.unfDays || []).length, bkOwn = (s.bkDays || []).length;
      if ($("#unfSameDays")) $("#unfSameDays").checked = !unfOwn;
      if ($("#bkSameDays")) $("#bkSameDays").checked = !bkOwn;
      setDays("unfollow", unfOwn ? s.unfDays : s.activeDays);
      setDays("followback", bkOwn ? s.bkDays : s.activeDays);
      syncSameDays();
      renderExtraBreaks(s.extraBreaks);
      renderBatchPreview(document);
    }
    if (name === "sequence") renderSeqCards(GX.modeOrder(s), s.switchOff || []);
    ui.dirty[name] = false;
    $(SAVEBAR[name]).hidden = true;
    if (name === "autopilot") { const bn = $("#unsavedBanner"); if (bn) bn.hidden = true; }
    if (route === name) renderPage();
  }

  function readForm(name) {
    const patch = {};
    $$(`[data-form="${name}"] [data-k]`).forEach((el) => {
      const k = el.dataset.k;
      if (el.type === "checkbox") patch[k] = el.checked;
      else if (el.type === "number" || el.type === "range") patch[k] = el.value === "" ? undefined : Number(el.value);
      else patch[k] = el.value;
    });
    for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];
    if (name === "autopilot") {
      delete patch.runMode;          // the mode is saved by the mode tiles / switches only - a stale hidden field must never flip it back
      patch.activeDays = getDays("follow") || st.settings.activeDays;
      // a mode that follows Follow's days is saved with an empty list
      patch.unfDays = $("#unfSameDays") && $("#unfSameDays").checked ? [] : (getDays("unfollow") || []);
      patch.bkDays = $("#bkSameDays") && $("#bkSameDays").checked ? [] : (getDays("followback") || []);
      patch.extraBreaks = readExtraBreaks();
      // With "Per hour: Auto" the typed hourly numbers are not used, so they don't decide which pace card is lit.
      const auto = patch.hourlyAuto !== undefined ? !!patch.hourlyAuto : !!st.settings.hourlyAuto;
      const keys = (arr) => (auto ? arr.filter((k) => !/ourlyLimit$/.test(k)) : arr);
      const match = Object.entries(GX.PRESETS).find(([, p]) => keys(PACE_KEYS).every((k) => Number(patch[k]) === p[k]));
      patch.speed = match ? match[0] : "custom";
      const um = Object.entries(GX.UNF_PRESETS).find(([, p]) => keys(UNF_KEYS).every((k) => Number(patch[k]) === p[k]));
      patch.unfPace = um ? um[0] : "custom";
      const bm = Object.entries(GX.BK_PRESETS).find(([, p]) => keys(BK_KEYS).every((k) => Number(patch[k]) === p[k]));
      patch.bkPace = bm ? bm[0] : "custom";
    }
    // The sequence owns the order, the on/off switches and the transition break - nothing else.
    // Every mode's numbers stay where they are, in that mode's own section.
    if (name === "sequence") { patch.switchSeq = seqOrder(); patch.switchOff = seqOff(); }
    return patch;
  }

  // Settings as they would be after saving this form (for live previews).
  function draft(name) { return GX.normalizeSettings(Object.assign({}, st.settings, ui.dirty[name] ? readForm(name) : {})); }

  async function saveForm(name) {
    const patch = readForm(name);
    const r = await U.cmd("saveSettings", { patch });
    if (!r.ok) return U.toast(r.error || "Couldn't save.", "bad");
    st.settings = r.settings;
    fillForm(name);
    U.toast("Saved. The autopilot uses the new settings right away.", "good");
    refresh();
  }

  // =====================================================================
  // TARGETING preview
  // =====================================================================
  async function renderTargeting() {
    const s = draft("targeting");
    if (st && st.poolCount && !(cache.pool || []).length) cache.pool = null;      // the queue changed since it was read: read it again
    const pool = (await getPool()).filter((c) => !c.manual);
    const now = Date.now();
    let pass = 0;
    const why = {};
    const bands = { "80+": 0, "70-79": 0, "60-69": 0, "50-59": 0, "<50": 0 };
    for (const c of pool) {
      const r = GX.rejectReason(c, s, now);
      const sc = GX.scoreUser(c, s, now);
      if (!r && sc >= s.minScore) { pass++; bands[GX.scoreBand(sc)]++; }
      else { const k = r || "below min score"; why[k] = (why[k] || 0) + 1; }
    }
    $("#pvPass").textContent = pool.length ? U.fmt(pass) : "-";
    $("#pvOf").textContent = pool.length ? `of ${U.fmt(pool.length)} pass (${Math.round(pass / pool.length * 100)}%)` : st && st.poolCount ? "loading the queue..." : "queue is empty right now - it fills when GrowX searches your sources (press Start). Then you see here how many pass your rules.";
    $("#pvBar").style.width = pool.length ? (pass / pool.length * 100) + "%" : "0%";
    const max = Math.max(1, ...Object.values(bands));
    setHtml("pvBands", $("#pvBands"), Object.entries(bands).map(([b, n]) => `<div class="band"><span>score ${b}</span><div class="bar thin"><i style="width:${n / max * 100}%"></i></div><b class="num">${U.fmt(n)}</b></div>`).join(""));
    const top = Object.entries(why).sort((a, b) => b[1] - a[1]).slice(0, 5);
    setHtml("pvWhy", $("#pvWhy"), top.length ? `<b class="text-2" style="font-size:12px">Would be skipped because</b>` + top.map(([k, n]) => `<div><span>${U.esc(k)}</span><b class="num">${U.fmt(n)}</b></div>`).join("") : "");
  }

  // =====================================================================
  // AUTOPILOT presets + estimate
  // =====================================================================
  function windowHours(s) {
    if (!s.activeHours) return 24;
    const m = (t) => { const [h, mi] = t.split(":").map(Number); return h * 60 + mi; };
    let d = m(s.activeEnd) - m(s.activeStart);
    if (d <= 0) d += 24 * 60;
    return d / 60 * (s.activeDays.length / 7);
  }

  // How long until the run target is reached: same rules the engine uses
  // (delays, long pauses, the main break + extra breaks, hourly cap, active hours).
  function etaFor(s, L, job, active, doneNow, opts) {
    const target = (opts && opts.goal) || s.sessionTarget;
    let remaining = Math.max(0, target - doneNow);
    if (!remaining) return { secs: 0, at: (opts && opts.startAt) || Date.now(), remaining: 0 };
    const avg = (s.minDelay + s.maxDelay) / 2 * (1 + (s.longPauseChance / 100) * 2.25) * L.slow;
    let sinceRest = active && job ? job.sinceRest || 0 : 0;
    const sinceExtra = (s.extraBreaks || []).map((_, i) => (active && job && job.sinceExtra && job.sinceExtra[i]) || 0);
    let t = 0;
    if (active && job) {
      if (job.status === "resting" && job.restUntil > Date.now()) t += (job.restUntil - Date.now()) / 1000;
      else if (job.nextAt > Date.now()) t += (job.nextAt - Date.now()) / 1000;
    }
    for (let k = 0; k < remaining; k++) {
      let mins = 0;
      if (s.restEvery && sinceRest >= s.restEvery) { mins = avgMins(s.restMinutes, s.restMinutesMax); sinceRest = 0; }
      (s.extraBreaks || []).forEach((b, i) => { if (sinceExtra[i] >= b.every) { mins = Math.max(mins, avgMins(b.minutes, b.minutesMax)); sinceExtra[i] = 0; } });
      t += mins * 60;
      t += k === 0 && active && job && t > 0 ? 0 : avg;
      sinceRest++; sinceExtra.forEach((_, i) => sinceExtra[i]++);
    }
    // hourly cap can slow it down further
    const used = active ? st.hour : 0;
    t = Math.max(t, Math.max(0, remaining - Math.max(0, L.hourly - used)) / Math.max(1, L.hourly) * 3600);
    // active hours: time outside the window does not count as work time
    let at = (opts && opts.startAt) || Date.now(), left = t;
    if (s.activeHours) {
      let guard = 0;
      while (left > 0 && guard++ < 20000) {
        if (GX.inWindow(s, at)) { const step = Math.min(left, 300); at += step * 1000; left -= step; }
        else at = GX.nextWindowStart(s, at);
      }
    } else at += t * 1000;
    return { secs: t, at, remaining };
  }

  function renderEta(job, active, s, L) {
    const el = $("#lmEta");
    if (!(s.sessionTarget > 0)) { el.hidden = true; return; }
    const doneNow = active && job ? (s.autoStart ? job.done - (job.dayBase || 0) : job.done) : 0;
    const e = etaFor(s, L, job, active, doneNow);
    const when = new Date(e.at);
    const clockTxt = when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) + (when.toDateString() !== new Date().toDateString() ? " " + when.toLocaleDateString([], { weekday: "short" }) : "");
    el.hidden = false;
    el.className = "live-eta";
    if (!e.remaining) { el.innerHTML = `<b>Target reached.</b>`; return; }
    let txt = `<b>${U.fmt(e.remaining)} follows to go</b> · about <b>${U.dur(e.secs)}</b> of working time · done around <b>${clockTxt}</b>`;
    if (s.activeHours && e.at - Date.now() > e.secs * 1000 + 60000) txt += ` (includes the OFF time ${s.activeEnd}-${s.activeStart})`;
    if (active && st.today + e.remaining > L.daily) { el.className = "live-eta warn"; txt += `. The 24-hour safety cap of ${L.daily} is lower than your target, so it will pause at the cap.`; }
    el.innerHTML = txt;
  }

  // =====================================================================
  // PLAN: same rules the engine uses, played forward (follows, delays, breaks)
  // =====================================================================
  function simulatePlan(s, goal, slow) {
    const avg = (s.minDelay + s.maxDelay) / 2 * (1 + (s.longPauseChance / 100) * 2.25) * (slow || 1);
    let t = 0, sinceRest = 0, workAcc = 0, breaks = 0, breakSecs = 0;
    const sinceExtra = (s.extraBreaks || []).map(() => 0);
    const segs = [], times = [];
    for (let k = 0; k < goal; k++) {
      let mins = 0;
      if (s.restEvery && sinceRest >= s.restEvery) { mins = avgMins(s.restMinutes, s.restMinutesMax); sinceRest = 0; }
      (s.extraBreaks || []).forEach((b, i) => { if (sinceExtra[i] >= b.every) { mins = Math.max(mins, avgMins(b.minutes, b.minutesMax)); sinceExtra[i] = 0; } });
      if (mins) {
        if (workAcc) { segs.push({ w: 1, secs: workAcc }); workAcc = 0; }
        segs.push({ w: 0, secs: mins * 60 });
        t += mins * 60; breaks++; breakSecs += mins * 60;
      }
      t += avg; workAcc += avg; times.push(t);
      sinceRest++; sinceExtra.forEach((_, i) => sinceExtra[i]++);
    }
    if (workAcc) segs.push({ w: 1, secs: workAcc });
    let peak = 0, lo = 0;                                   // most follows inside any rolling hour
    for (let hi = 0; hi < times.length; hi++) { while (times[hi] - times[lo] >= 3600) lo++; peak = Math.max(peak, hi - lo + 1); }
    return { total: t, work: goal * avg, breaks, breakSecs, segs, times, peak, avg };
  }

  // Smallest batch size that still finishes `goal` follows inside `hours` (smaller batches = smoother).
  function solvePlan(s, goal, hours, breakMin) {
    const lp = 1 + (s.longPauseChance / 100) * 2.25;
    const avg = (s.minDelay + s.maxDelay) / 2 * lp;
    const H = hours * 3600, A = goal * avg;
    if (A > H * 0.97) return { ok: false, avg, need: Math.max(5, Math.floor((H * 0.85) / goal / lp)) };
    let n = 3;
    for (; n < goal; n++) { if (A + Math.floor((goal - 1) / n) * breakMin * 60 <= H) break; }
    return { ok: true, n, avg };
  }

  // =====================================================================
  // SAFETY: plain-language review of the current numbers
  // =====================================================================
  function goalOf(s, e) { return Math.max(1, GX.modeTarget(s, "follow", e.L.daily)); }

  // The "when X refuses" plan of a mode, as safety lines.
  function ladderSafety(s, mode, add) {
    const p = GX.refusePlan(s, mode), noun = mode === "unfollow" ? "unfollow" : mode === "followback" ? "follow-back" : "follow";
    const r = (lo, hi) => (lo === hi ? fmtMin(lo / 60000) : `${fmtMin(lo / 60000)} to ${fmtMin(hi / 60000)}`);
    const steps = [p.on0 ? r(p.lo0, p.hi0) : "", p.on1 ? r(p.lo1, p.hi1) : "", p.on2 ? r(p.lo2, p.hi2) : ""].filter(Boolean);
    if (steps.length === 3) add(0, `If X refuses or a ${noun} fails: a ${steps[0]} break, then ${steps[1]}, then ${steps[2]} if it keeps refusing, then the rest of the day off.`);
    else if (steps.length) add(1, `If X refuses or a ${noun} fails: ${steps.join(", then ")} break${steps.length > 1 ? "s" : ""}, then the rest of the day off (some steps of the plan are switched off).`);
    else add(1, `Steps 1 to 3 of the X-refused plan are off: four refusals in a row stop the day, with no breaks in between. Switch them on.`);
  }

  function safetyItems(s, e, plan) {
    const items = [];
    const add = (lvl, text) => items.push({ lvl, text });
    const d = goalOf(s, e);
    if (d <= 200) add(0, `${d} follows a day is gentle.`);
    else if (d <= 400) add(1, `${d} follows a day is near the usual X limit (about 400). Fine for an older account.`);
    else add(2, `${d} follows a day is above X's normal limit. Only sensible with X Premium; expect X to stop you.`);
    if (s.runMode === "unfollow") {
      if (s.unfollowDaily <= 400) add(0, `Auto-unfollow ${s.unfollowDaily}/day, only non-followers.`);
      else if (s.unfollowDaily <= 600) add(1, `Auto-unfollow ${s.unfollowDaily}/day is fairly fast.`);
      else add(2, `Auto-unfollow ${s.unfollowDaily}/day is very fast; X may pause unfollows (GrowX then takes a break by itself).`);
    }
    const ph = Math.round(e.schedPerHour);
    if (ph <= 25) add(0, `About ${ph} follows an hour on average: relaxed.`);
    else if (ph <= 45) add(1, `About ${ph} follows an hour on average: fairly fast.`);
    else add(2, `About ${ph} follows an hour on average: fast, X may rate-limit you.`);
    const hourCap = e.L.hourly;
    if (s.hourlyAuto) add(0, `Per hour is on Auto: about ${hourCap} follows an hour at most, worked out from your plan.`);
    else if (plan.peak > hourCap) add(1, `Your busiest hour reaches ~${plan.peak} follows but the hourly cap is ${hourCap}, so GrowX would add extra pauses. Raise the cap to ${Math.min(200, Math.ceil(plan.peak * 1.1) + 2)} - or switch Per hour to Auto.`);
    else add(0, `Busiest hour ~${plan.peak} follows. The hourly cap of ${hourCap} leaves room.`);
    if (s.minDelay >= 40) add(0, `Delay of ${s.minDelay}-${s.maxDelay} sec between follows looks human.`);
    else if (s.minDelay >= 20) add(1, `Delay starts at ${s.minDelay} sec. 40 sec or more is safer.`);
    else add(2, `Delay starts at ${s.minDelay} sec: too quick, a strong robot signal.`);
    if (!s.restEvery) add(2, "Breaks are off. Regular breaks protect the account.");
    else if (s.restEvery > 40) add(1, `${s.restEvery} follows in a row before a break is a long burst. Smaller batches look more natural.`);
    else if (s.restMinutesMax > s.restMinutes) add(0, `Break of ${s.restMinutes}-${s.restMinutesMax} min (a random length) after ${batchTxt(s.restEveryMin, s.restEvery)} follows (never more than ${s.restEvery}).`);
    else add(0, `Break of exactly ${s.restMinutes} min after ${batchTxt(s.restEveryMin, s.restEvery)} follows (never more than ${s.restEvery}).`);
    ladderSafety(s, s.runMode === "followback" ? "followback" : "follow", add);
    if (s.failHaltAfter > 8) add(1, `It only stops after ${s.failHaltAfter} failures in a row. 3-6 is safer.`);
    if (s.verifyFollows) add(0, "Checks that follows really stick (catches hidden limits).");
    else add(1, "Follow check is off, so hidden limits would go unnoticed.");
    const hrs = plan.total / 3600;
    if (s.maxRunHours > 0) {
      if (hrs > s.maxRunHours) add(1, `The plan needs ~${hrs.toFixed(1)} h but the maximum run time is ${s.maxRunHours} h, so it would stop early.`);
      else add(0, `Stops by itself after at most ${s.maxRunHours} h a day.`);
    } else add(1, "No maximum run time. Set one so it can never run around the clock.");
    if (hrs > 14) add(1, `A ${hrs.toFixed(1)} h working day is long. 8-11 h looks more natural.`);
    if (d >= 300 && !s.warmup) add(1, `Going straight to ${d} a day. If the account is new to automation, switch on Warm-up.`);
    if (s.restDays > 0 && s.activeHours) add(0, `${s.restDays} rest day${s.restDays === 1 ? "" : "s"} a week, picked at random and picked again every week.`);
    else if (s.restDays > 0) add(1, "Rest days are set but the OFF time switch is off, so they are not used.");
    else if (d >= 300 && s.activeHours && s.activeDays.length === 7) add(1, "No day off. Set 1 rest day a week - the single biggest thing that stops a week looking automated.");
    if (s.dailyWindow === "calendar" && d > 150) add(1, "Calendar-day counting lets a new day start at midnight, even right after a busy evening. Rolling 24h is stricter.");
    if (s.autoStart) add(0, `Turns ON by itself every day ${s.autoStartAt === "window" && s.activeHours ? "at the ON time (" + s.activeStart + ")" : "at " + s.autoStartTime}${s.autoStartJitter ? ", up to " + s.autoStartJitter + " min late" : ""}.`);
    if (!s.activeHours && !(s.sessionTarget > 0)) add(1, "No OFF time and no target: it may run around the clock.");
    return items;
  }

  function renderSafety(s, e) {
    const plan = simulatePlan(s, goalOf(s, e));
    const items = safetyItems(s, e, plan);
    const worst = Math.max(...items.map((i) => i.lvl));
    const label = worst === 2 ? "High risk" : worst === 1 ? "Medium risk" : "Low risk";
    const icon = ["✓", "!", "✕"];
    setHtml("safety", $("#safetyBox"), `<div class="sf-head"><b>Safety</b><span class="sf-badge l${worst}">${label}</span></div><ul>${items.map((i) => `<li class="l${i.lvl}"><i>${icon[i.lvl]}</i><span>${U.esc(i.text)}</span></li>`).join("")}</ul><p class="sf-foot">No setting makes automation 100% safe. These numbers only lower the risk; X can still limit an account that uses automation.</p>`);
  }

  // =====================================================================
  // PLAN HELPER: "I want N follows in H hours"
  // =====================================================================
  function renderPlanHelper(s) {
    const out = $("#phResult");
    if (!out) return;
    const brkI = $("#phBreak");
    if (!brkI.dataset.init) { brkI.value = s.restMinutes; brkI.dataset.init = "1"; }
    const goal = Math.max(1, Math.round(Number($("#phGoal").value) || 0));
    const hours = Math.max(0.5, Number($("#phHours").value) || 0);
    const brk = Math.max(1, Math.round(Number(brkI.value) || 0));
    const dsel = $("#phDelay").value;
    const dl = dsel === "keep" ? null : dsel.split("-").map(Number);
    if (dl) s = Object.assign({}, s, { minDelay: dl[0], maxDelay: dl[1] });
    const r = solvePlan(s, goal, hours, brk);
    ui.ph = null;
    if (!r.ok) {
      out.className = "ph-result warn";
      out.innerHTML = `With delays of ${s.minDelay}-${s.maxDelay} s, ${U.fmt(goal)} follows need about <b>${U.dur(goal * r.avg)}</b> of pure following, which already uses up your ${hours} h. Shorten the delays to an average of about <b>${r.need} s</b>, lower the number of follows, or allow more hours.`;
      $("#phApply").disabled = true;
      return;
    }
    const tmp = Object.assign({}, s, { restEvery: r.n >= goal ? 0 : r.n, restMinutes: brk, restMinutesMax: brk, sessionTarget: goal });
    const sim = simulatePlan(tmp, goal, 1);
    const cap = Math.min(200, Math.ceil(sim.peak * 1.1) + 2);
    ui.ph = { goal, n: r.n >= goal ? 0 : r.n, brk, cap, hours, total: sim.total, dl };
    out.className = "ph-result";
    out.innerHTML = r.n >= goal
      ? `No breaks needed: ${U.fmt(goal)} follows take about <b>${U.dur(sim.total)}</b>.`
      : `Break every <b>${r.n}</b> follows for <b>${brk}</b> min → ${U.fmt(goal)} follows in about <b>${U.dur(sim.total)}</b> (following ${U.dur(sim.work)} + ${sim.breaks} breaks ${U.dur(sim.breakSecs)}). Busiest hour ≈ <b>${sim.peak}</b> follows, so the hourly cap becomes <b>${cap}</b>.`;
    $("#phApply").disabled = false;
  }

  function applyPlanHelper() {
    const p = ui.ph;
    if (!p) return;
    const set = (k, v) => { const el = $(`[data-form="autopilot"] [data-k="${k}"]`); if (el) { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); } };
    set("sessionTarget", p.goal);
    set("dailyLimit", Math.max(p.goal, 1));
    set("restEvery", p.n);
    set("restEveryMin", p.n);
    set("restMinutes", p.brk);
    set("restMinutesMax", p.brk);          // the helper plans with one exact length; widen the range yourself afterwards
    set("hourlyLimit", p.cap);
    if (p.dl) { set("minDelay", p.dl[0]); set("maxDelay", p.dl[1]); }
    set("maxRunHours", Math.min(24, Math.ceil(p.total / 3600) + 1));
    U.toast("Plan filled in. Check it, then press Save & apply.", "good");
  }

  // =====================================================================
  // What is risky about a Comment-mode plan. Replies are seen by people, not just
  // counted by X, so the numbers that matter here are different from Follow's.
  function cmtSafetyItems(s) {
    const out = [];
    const d = s.cmtDaily, lo = s.cmtMinDelay;
    out.push(d > 200 ? { lvl: 2, text: `${d} replies a day is above what an unverified X account can usually post (about 200)` }
      : d > 120 ? { lvl: 1, text: `${d} replies a day is a lot - keep an eye on your reply quality` }
      : { lvl: 0, text: `${d} replies a day is a safe number` });
    out.push(lo < 60 ? { lvl: 2, text: `${lo} s between replies is fast enough for people to notice` }
      : lo < 90 ? { lvl: 1, text: `${lo} s between replies is quick - 90 s and up reads as human` }
      : { lvl: 0, text: `${lo}-${s.cmtMaxDelay} s between replies looks like a person reading` });
    out.push(s.cmtAuthorMax > 2 ? { lvl: 2, text: `${s.cmtAuthorMax} replies to the same person in one day is how reports start` }
      : s.cmtAuthorMax > 1 ? { lvl: 1, text: `${s.cmtAuthorMax} replies per person per day - one is safer` }
      : { lvl: 0, text: "One reply per person per day" });
    out.push(s.cmtRestEvery ? { lvl: 0, text: `A break of ${s.cmtRestMinutes}-${s.cmtRestMinutesMax} min every ${s.cmtRestEveryMin}-${s.cmtRestEvery} replies` }
      : { lvl: 2, text: "No breaks at all - a steady stream of replies is the easiest pattern to spot" });
    out.push(s.cmtPublish === "draft" ? { lvl: 0, text: "GrowX only writes - you post each reply yourself" }
      : { lvl: 1, text: "GrowX posts the replies itself - read your first twenty before leaving it alone" });
    out.push(s.cmtStartNow ? { lvl: 1, text: "Replying all day - an ON / OFF time looks more human" }
      : { lvl: 0, text: `Only between ${s.cmtStart} and ${s.cmtEnd}` });
    return out;
  }

  // HOME: today's plan card (timeline + safety)
  // =====================================================================
  function renderPlanCard() {
    const card = $("#planCard");
    if (!card) return;
    const s0 = GX.modeSettings(st.settings), L = st.limits, job = st.job;
    const s = paceOf(s0);
    const unfP = s.runMode === "unfollow", bkP = s.runMode === "followback", cmtP = s.runMode === "comment";
    const word = cmtP ? "replies" : unfP ? "unfollows" : bkP ? "follow-backs" : "follows";
    const v = U.jobView(job, st.task), active = v.active;
    const e = estimate(s);
    const nu = modeNumbers();
    const goal = cmtP || bkP ? Math.max(1, nu.max) : unfP ? s.unfollowDaily : goalOf(s, e);
    const plan = simulatePlan(s, goal, L.slow);
    const items = unfP
      ? unfSafetyItems(s0, Math.min(hourOf(s0, "unfollow"), 3600 / Math.max(1, (s0.unfMinDelay + s0.unfMaxDelay) / 2 * (1 + s0.unfLongPause / 50) + (s0.unfRestEvery ? s0.unfRestMinutes * 60 / s0.unfRestEvery : 0))))
      : bkP
      ? bkSafetyItems(s0, Math.min(s0.hourlyAuto ? (L.hourly || hourOf(s0, "followback")) : s0.bkHourlyLimit, 3600 / Math.max(1, (s0.bkMinDelay + s0.bkMaxDelay) / 2 * (1 + s0.bkLongPause / 100 * 2.25) + (s0.bkRestEvery ? s0.bkRestMinutes * 60 / s0.bkRestEvery : 0))))
      : cmtP
      ? cmtSafetyItems(s0)
      : safetyItems(s, e, plan);
    const worst = Math.max(...items.map((i) => i.lvl));
    const label = worst === 2 ? "High risk" : worst === 1 ? "Medium risk" : "Low risk";
    const doneNow = unfP || bkP || cmtP ? nu.done : active && job ? (s.autoStart ? job.done - (job.dayBase || 0) : job.done) : Math.min(st.today, goal);
    const k = Math.max(0, Math.min(goal, doneNow));
    const p = k ? plan.times[k - 1] / plan.total : 0;
    const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    let finish;
    if (k >= goal) finish = "Done for today";
    else if (active && job && !unfP && !bkP && !cmtP) finish = "Done around " + clock(etaFor(s, L, job, true, k > 0 ? k : 0, { goal }).at);
    else finish = "If started now: " + clock(Date.now() + (plan.total - (k ? plan.times[k - 1] : 0)) * 1000);

    // Clean timeline: one smooth track, filled up to "now", small ticks where the breaks are.
    const pc = (p * 100).toFixed(2);
    let acc = 0; const ticks = [];
    const totalSecs = plan.segs.reduce((n, g) => n + g.secs, 0) || 1;
    plan.segs.forEach((g) => { if (!g.w) ticks.push(((acc + g.secs / 2) / totalSecs) * 100); acc += g.secs; });
    const tickHtml = ticks.map((x) => `<i class="tl-tick${x <= p * 100 ? " done" : ""}" style="left:${x.toFixed(2)}%"></i>`).join("");
    setHtml("planTl", $("#planTl"), `<div class="tl-track"><div class="tl-done" style="width:${pc}%"></div></div>${tickHtml}<span class="tl-now" style="left:${pc}%"></span>`);
    const ends = $("#planEnds");
    if (ends) ends.textContent = `${ticks.length} breaks · ${Math.round(p * 100)}% of today's plan`;

    const bTxt = s.restEvery ? `${batchTxt(s.restEveryMin, s.restEvery)} ${word}, then a ${brkTxt(s.restMinutes, s.restMinutesMax)} break` : "no breaks";
    $("#planTitle").textContent = `${U.fmt(k)} / ${U.fmt(goal)} ${word}`;
    $("#planSub").textContent = `${bTxt} · delay ${s.minDelay}-${s.maxDelay} s`;
    setHtml("planFacts", $("#planFacts"), `
      <div><span>Working time</span><b class="num">${U.dur(plan.work)}</b></div>
      <div><span>Breaks</span><b class="num">${plan.breaks} · ${U.dur(plan.breakSecs)}</b></div>
      <div><span>Whole day</span><b class="num">${U.dur(plan.total)}</b></div>
      <div><span>Finish</span><b class="num">${U.esc(finish)}</b></div>`);

    const top = items.slice().sort((a, b) => b.lvl - a.lvl).slice(0, 3);
    const icon = ["✓", "!", "✕"];
    setHtml("planSafety", $("#planSafety"), `<div class="sf-head"><b>Safety</b><span class="sf-badge l${worst}">${label}</span></div><ul>${top.map((i) => `<li class="l${i.lvl}"><i>${icon[i.lvl]}</i><span>${U.esc(i.text)}</span></li>`).join("")}</ul><a class="sf-more" href="#autopilot">Review all safety settings</a>`);

    // hero: the mode switch (one click, applies at once) + a few facts
    let next = "";
    const curMode = modeOf(s0);
    if (s.autoStart && !active) {
      const ranToday = stopped(curMode) || !!(job && jobMode(job) === curMode && job.startedAt && new Date(job.startedAt).toDateString() === new Date().toDateString());
      const t = GX.nextAutoStart(GX.modeSettings(s), ranToday, Date.now());
      next = t <= Date.now() + 60000 ? "Starting any moment" : "Next start " + new Date(t).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
    }
    const seg = `<span class="ov-modes" role="group" aria-label="Mode">${[["follow", "Follow"], ["unfollow", "Unfollow"], ["followback", "Follow back"], ["comment", "Comment"]].map(([k, l]) => `<button type="button" data-ovmode="${k}" class="${k === curMode ? "on" : ""}" title="${k === curMode ? "Current mode" : "Switch to " + l + " mode"}">${l}</button>`).join("")}</span>`;
    const sq = st.seq || {};
    const seqChip = `<a class="ov-chip seq ${sq.cycling ? "on" : "off"}" href="#autopilot" title="${sq.cycling ? "Mode sequence: " + (sq.order || []).map((m) => MODE_NAME[m]).join(" → ") : "Mode sequence is off - GrowX stays in the one mode you pick"}">Sequence · <b>${sq.cycling ? "On" : "Off"}</b></a>`;
    setHtml("ovChips", $("#ovChips"), `${seg}${seqChip}<a class="ov-chip mode" href="#autopilot" title="Open Autopilot &amp; Safety">${U.fmt(goal)} ${word} a day</a><span class="ov-chip">Safety · ${label}</span>${next ? `<span class="ov-chip">${U.esc(next)}</span>` : ""}`);
  }

  function estimate(s) {
    const L = GX.effectiveLimits(s, st.meta, null, Date.now());
    const avgDelay = (s.minDelay + s.maxDelay) / 2 * (1 + (s.longPauseChance / 100) * 2.25);
    let restPer = s.restEvery ? (avgMins(s.restMinutes, s.restMinutesMax) * 60) / ((s.restEvery + (s.restEveryMin || s.restEvery)) / 2) : 0;
    for (const b of s.extraBreaks || []) restPer += (avgMins(b.minutes, b.minutesMax) * 60) / b.every;   // extra rules (approx.: they add up)
    const schedPerHour = 3600 / Math.max(1, avgDelay + restPer);
    const perHour = Math.min(L.hourly, schedPerHour);
    const perDay = Math.round(Math.min(L.daily, perHour * windowHours(s)));
    const rate = st.summary && st.summary.rate != null && st.summary.settled >= 30 ? st.summary.rate : 0.2;
    return { L, perHour, schedPerHour, perDay, rate, measured: !!(st.summary && st.summary.rate != null && st.summary.settled >= 30) };
  }

  function renderUnfStatus(s) {
    const el = $("#unfStatus");
    if (!el) return;
    const u = st.unf || {};
    let html = "";
    if (s.runMode !== "unfollow") html = `Unfollow is not the selected mode. Click <b>Unfollow</b> at the top to start with your old following list.`;
    else if (u.stage === "new" || u.stage === "friends" || u.stage === "followers") html = `<span>Step 1: reading your following list from X${u.read ? ` (${U.fmt(u.read)} accounts read)` : ""}...</span>`;
    else if (u.stage === "ready") {
      const done = Math.max(0, u.total - u.left);
      html = `<span>Step 1 · old list: <b>${U.fmt(u.removed)}</b> unfollowed · <b>${U.fmt(u.left)}</b> left · today <b>${u.today}/${s.unfollowDaily}</b> · about <b>${Math.ceil(u.left / Math.max(1, s.unfollowDaily))}</b> more days</span><span class="bar"><i style="width:${(done / Math.max(1, u.total) * 100).toFixed(1)}%"></i></span>`;
    } else if (u.stage === "done") html = `<span>Step 1 finished (${U.fmt(u.removed)} old unfollowed). Step 2: <b>${U.fmt(u.due || 0)}</b> due now · <b>${U.fmt(u.waiting || 0)}</b> still within ${s.unfollowAfterDays} days · today <b>${u.today}/${s.unfollowDaily}</b></span>`;
    const ia = u.inact || {};
    if (s.runMode === "unfollow" && s.unfInactive) {
      html += ia.ready && ia.total
        ? `<span>Inactive check: <b>${U.fmt(Math.max(0, ia.pos - ia.deep))}</b> of <b>${U.fmt(ia.total)}</b> followers-back checked · <b>${U.fmt(ia.removed)}</b> inactive unfollowed${u.stage === "ready" ? " · runs alongside the old list" : ""}</span>`
        : `<span>Inactive check: GrowX reads your list again first.</span>`;
    }
    const ac = u.act || {};
    if (s.runMode === "unfollow" && GX.unfEveryone(s)) {
      html += ac.ready && ac.total
        ? `<span>Active followers: <b>${U.fmt(ac.removed)}</b> unfollowed · <b>${U.fmt(Math.max(0, ac.total - ac.pos + (ac.queued || 0)))}</b> left on the list · used only when no non-follower is due</span>`
        : `<span>Active followers: GrowX reads your list first.</span>`;
    }
    if (s.runMode === "unfollow") html += `<button class="btn btn-ghost btn-xs" type="button" id="unfReset">Read my list again</button>`;
    setHtml("unfStatus", el, html);
    const ih = $("#inactHint");
    if (ih) ih.textContent = s.unfInactive
      ? `Unfollows only accounts with no post at all in the last ${s.unfInactiveDays} days (about ${Math.round(s.unfInactiveDays / 30 * 10) / 10} months) - checked by reading their posts, twice. ${ia.keptActive ? U.fmt(ia.keptActive) + " active and " : ""}${ia.keptBig ? U.fmt(ia.keptBig) + " big accounts kept so far. " : ""}Up to 120 profiles are read per hour, so a big list takes a few days. Keep list (U7) and U4c always win.${GX.unfProtect(s) ? " (Switch U4b off to let this run.)" : ""}`
      : "Off.";
    const bh = $("#bigHint");
    if (bh) {
      bh.className = "hint" + (s.unfProtectBig ? "" : " warn");
      bh.textContent = s.unfProtectBig
        ? `On - kept: Quality score ${s.unfProtectScore}+${s.unfProtectFollowers ? ` or ${U.fmt(s.unfProtectFollowers)}+ followers` : ""}.${u.keptBig ? ` ${U.fmt(u.keptBig)} big / good accounts kept so far.` : ""}`
        : "Off - big accounts can be unfollowed like any other. Not recommended.";
    }
  }

  function unfSafetyItems(s, perHour) {
    const items = [], add = (lvl, text) => items.push({ lvl, text });
    if (s.unfollowDaily <= 400) add(0, `${s.unfollowDaily} unfollows a day is gentle.`);
    else if (s.unfollowDaily <= 700) add(1, `${s.unfollowDaily} unfollows a day is fairly fast. Fine for an older account.`);
    else add(2, `${s.unfollowDaily} unfollows a day is very fast; X may pause unfollows (GrowX then takes a break by itself).`);
    if (s.unfMinDelay < 10) add(2, `Delay starts at ${s.unfMinDelay} sec: too quick, a strong robot signal.`);
    else if (s.unfMinDelay < 20) add(1, `Delay starts at ${s.unfMinDelay} sec: fairly quick.`);
    else add(0, `Delay ${s.unfMinDelay}-${s.unfMaxDelay} sec between unfollows.`);
    if (!s.unfRestEvery) add(2, "Unfollow breaks are off. Regular breaks look human - keep them on.");
    else add(0, `Break of ${s.unfRestMinutes} min after every ${s.unfRestEvery} unfollows.`);
    const ph = Math.round(perHour);
    add(ph <= 50 ? 0 : ph <= 80 ? 1 : 2, `About ${ph} unfollows an hour while working.`);
    if (s.unfInactive) add(1, `Accounts with no post in ${s.unfInactiveDays} days are unfollowed even if they follow you - some may unfollow you back. Active accounts never are.`);
    if (s.unfProtectBig) add(0, `Big / good accounts (Quality score ${s.unfProtectScore}+${s.unfProtectFollowers ? `, or ${U.fmt(s.unfProtectFollowers)}+ followers` : ""}) are never unfollowed.`);
    else add(2, "The big-account guard (U4c) is off - big accounts can be unfollowed.");
    if (GX.unfEveryone(s)) add(1, `The people who follow you back are unfollowed too, once no non-follower is due (${GX.unfNewest(s) ? "newest" : "oldest"} follow first) - they stay your followers, but some may unfollow you in return.`);
    if (!s.unfInactive && !GX.unfEveryone(s)) add(0, "Anyone who follows you is checked again right before and never unfollowed.");
    ladderSafety(s, "unfollow", add);
    if (s.hourlyAuto) add(0, `Per hour is on Auto: about ${hourOf(s, "unfollow")} unfollows an hour at most, worked out from your plan.`);
    if (s.autoStart) add(0, `Starts by itself every day at ${s.autoStartAt === "window" && s.activeHours ? s.unfollowStart : s.autoStartTime}.`);
    return items;
  }

  function renderUnfEstimate(s) {
    const mm = (t) => { const [h, mi] = t.split(":").map(Number); return h * 60 + mi; };
    const avg = (s.unfMinDelay + s.unfMaxDelay) / 2 * (1 + (s.unfLongPause / 100) * 2);
    const restPer = s.unfRestEvery ? (s.unfRestMinutes * 60) / s.unfRestEvery : 0;
    const sched = 3600 / Math.max(1, avg + restPer);
    const uCap = hourOf(s, "unfollow");
    const perHour = Math.min(uCap, sched);
    let winH = 24;
    if (s.activeHours) { let dm = mm(s.unfollowEnd) - mm(s.unfollowStart); if (dm <= 0) dm += 1440; winH = dm / 60; }
    const secs = s.unfollowDaily / Math.max(0.1, perHour) * 3600;
    const fits = secs <= winH * 3600 + 60;
    const perDay = fits ? s.unfollowDaily : Math.floor(perHour * winH);
    const start = new Date(); const sm = s.activeHours ? mm(s.unfollowStart) : 0; start.setHours(Math.floor(sm / 60), sm % 60, 0, 0);
    const hhmm = (ts) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const u = st.unf || {};
    const oldLeft = u.stage === "ready" ? u.left : 0;
    const oldTxt = u.stage === "done" ? "finished" : u.stage === "ready" ? `~${Math.ceil(oldLeft / Math.max(1, perDay))} days (${U.fmt(oldLeft)} left)` : "after the first scan";
    setHtml("est", $("#estRows"), `
      <div><span>Unfollows per hour (working)</span><b class="num">~${Math.round(perHour)}</b></div>
      <div><span>Unfollows per day</span><b class="num">~${U.fmt(perDay)}</b></div>
      <div><span>Real working time for ${U.fmt(s.unfollowDaily)} (with breaks)</span><b class="num">~${U.dur(secs)}</b></div>
      <div><span>Done around (starting ${hhmm(start.getTime())})</span><b class="num">${fits ? hhmm(start.getTime() + secs * 1000) : "not in one day"}</b></div>
      <div><span>Daily ON / OFF time</span><b class="num">${s.activeHours ? s.unfollowStart + " - " + s.unfollowEnd : "no OFF time"}</b></div>
      <div><span>Who first</span><b class="num">${s.unfOrder === "new" ? "newest" : "oldest"} following</b></div>
      <div><span>After that</span><b class="num">${s.autoStart ? "rests, auto-starts next day" : "rests until tomorrow"}</b></div>
      <div class="big"><span>Old list cleared in</span><b class="num">${oldTxt}</b></div>`);
    const note = $("#estNote");
    if (!fits) { note.className = "est-note warn"; note.textContent = `${U.fmt(s.unfollowDaily)} unfollows need about ${U.dur(secs)} with your breaks, but the Daily ON / OFF time (U4) gives only ${winH.toFixed(1)} h. Make the ON / OFF time longer, shorten breaks or delays, or raise the per-hour number.`; }
    else if (!s.hourlyAuto && sched > uCap * 1.02) { note.className = "est-note warn"; note.textContent = `Your delays allow ~${Math.round(sched)} an hour but the hourly cap is ${uCap}, so GrowX adds pauses. That's fine - it just finishes later. (Per hour: Auto works this out for you.)`; }
    else { note.className = "est-note"; note.textContent = "Numbers are estimates. If X slows unfollows down, GrowX takes a break by itself."; }
    const items = unfSafetyItems(s, perHour);
    const worst = Math.max(...items.map((i) => i.lvl));
    const label = worst === 2 ? "High risk" : worst === 1 ? "Medium risk" : "Low risk";
    const icon = ["✓", "!", "✕"];
    setHtml("safety", $("#safetyBox"), `<div class="sf-head"><b>Safety</b><span class="sf-badge l${worst}">${label}</span></div><ul>${items.map((i) => `<li class="l${i.lvl}"><i>${icon[i.lvl]}</i><span>${U.esc(i.text)}</span></li>`).join("")}</ul><p class="sf-foot">No setting makes automation 100% safe. These numbers only lower the risk.</p>`);
  }

  // ---- Follow back: status line, safety review and "what to expect" -----------
  function renderBkStatus(s) {
    const el = $("#bkStatus");
    if (!el) return;
    const b = st.bk || {};
    let html = "";
    if (b.stage === "new" || b.stage === "friends" || b.stage === "followers") html = `<span>Reading who you follow and who follows you${b.read ? ` (${U.fmt(b.read)} accounts read)` : ""}...</span>`;
    else if (b.stage === "ready") {
      const done = Math.max(0, (b.total || 0) - (b.left || 0));
      html = `<span><b>${U.fmt(b.left)}</b> followers waiting · <b>${U.fmt(b.followed)}</b> followed back · <b>${U.fmt(b.skipped)}</b> skipped · today <b>${b.today || 0}/${s.bkDaily}</b> · about <b>${Math.ceil((b.left || 0) / Math.max(1, s.bkDaily))}</b> more days</span><span class="bar"><i style="width:${(done / Math.max(1, b.total || 1) * 100).toFixed(1)}%"></i></span>`;
    } else if (b.stage === "done") html = `<span>Everyone on the list is handled (<b>${U.fmt(b.followed)}</b> followed back, <b>${U.fmt(b.skipped)}</b> skipped). GrowX looks for new followers by itself every couple of hours.</span>`;
    const why = Object.entries(b.skips || {}).sort((x, y) => y[1] - x[1]).slice(0, 4).map(([k, n]) => `${k}: ${U.fmt(n)}`).join(" · ");
    if (why) html += `<span class="hint" style="flex-basis:100%">Skipped so far - ${U.esc(why)}</span>`;
    html += `<button class="btn btn-ghost btn-xs" type="button" id="bkReset">Read my followers again</button>`;
    setHtml("bkStatus", el, html);
    const sk = b.skips || {}, deep = b.deep || {};
    const vh = $("#bkVerHint");
    if (vh) vh.textContent = !s.bkVerifiedOnly
      ? "Off - every follower who passes the skip rules (B7) is followed back, verified or not."
      : `On - only verified followers are followed back${sk["not verified"] ? ` (${U.fmt(sk["not verified"])} without a badge skipped so far)` : ""}. Each follower's badge is read from X right before; if X doesn't show it, the follower is skipped, never guessed${sk["verified badge unknown"] ? ` (${U.fmt(sk["verified badge unknown"])} so far)` : ""}. Skipped followers stay your followers; they are looked at again after 3 days.`;
    const ih = $("#bkInactHint");
    if (ih) ih.textContent = !s.bkSkipInactive
      ? "Off - inactive accounts are followed back too (Unfollow mode can remove them later)."
      : `Skips anyone with fewer than ${s.bkMinPosts} posts in the last ${s.bkInactiveDays} days (about ${Math.round(s.bkInactiveDays / 30 * 10) / 10} months) - replies and reposts count as posts. Accounts with too few posts in total, or none in that time, are skipped from their profile data; for the rest GrowX counts the posts on the profile right before following back (up to 120 profiles an hour${deep.checked ? ", " + U.fmt(deep.checked) + " read so far" : ""}).${deep.off ? " X is not showing post lists right now, so for a short while only the post total and latest-post date are used." : ""}`;
  }

  function bkSafetyItems(s, perHour) {
    const items = [], add = (lvl, text) => items.push({ lvl, text });
    const L = GX.effectiveLimits(s, st.meta, null, Date.now());
    const d = Math.min(s.bkDaily, L.daily);
    if (s.bkDaily > L.daily) add(1, `Your Follow back number is ${s.bkDaily}, but X's shared daily limit (B2) is ${L.daily}, so it stops at ${L.daily}.`);
    if (d <= 200) add(0, `${d} follow-backs a day is gentle.`);
    else if (d <= 400) add(1, `${d} follow-backs a day is near the usual X limit (about 400). Fine for an older account.`);
    else add(2, `${d} follow-backs a day is above X's normal limit. Only sensible with X Premium; expect X to stop you.`);
    if (s.bkMinDelay < 20) add(2, `Delay starts at ${s.bkMinDelay} sec: too quick, a strong robot signal.`);
    else if (s.bkMinDelay < 30) add(1, `Delay starts at ${s.bkMinDelay} sec: fairly quick. 40 sec or more is safer.`);
    else add(0, `Delay ${s.bkMinDelay}-${s.bkMaxDelay} sec between follow-backs looks human.`);
    if (!s.bkRestEvery) add(2, "Follow back breaks are off. Regular breaks protect the account.");
    else if (s.bkRestEvery > 40) add(1, `${s.bkRestEvery} follow-backs in a row before a break is a long burst.`);
    else add(0, `Break of exactly ${s.bkRestMinutes} min after ${batchTxt(s.bkRestEveryMin, s.bkRestEvery)} follow-backs (never more than ${s.bkRestEvery}).`);
    const ph = Math.round(perHour);
    add(ph <= 25 ? 0 : ph <= 45 ? 1 : 2, `About ${ph} follow-backs an hour while working.`);
    const needH = d / Math.max(0.1, perHour);
    if (s.maxRunHours > 0 && needH > s.maxRunHours) add(1, `${d} follow-backs need ~${needH.toFixed(1)} h but the maximum run time is ${s.maxRunHours} h, so the day would end early (B2).`);
    add(0, "Follow and Follow back share X's daily and hourly limit, so together they never go over it.");
    ladderSafety(s, "followback", add);
    if (s.hourlyAuto) add(0, `Per hour is on Auto: about ${L.hourly} follow-backs an hour at most, worked out from your plan.`);
    if (s.bkVerifiedOnly) add(0, "Only verified accounts are followed back; every other follower is skipped, so far fewer than your daily number may qualify.");
    if (s.bkSkipInactive) add(0, `Accounts with fewer than ${s.bkMinPosts} posts in ${s.bkInactiveDays} days are skipped, so you don't follow back accounts that would be unfollowed again.`);
    else add(1, "Inactive accounts are not skipped. Unfollow mode may remove them later.");
    if (s.autoStart) add(0, `Starts by itself every day at ${s.autoStartAt === "window" && s.activeHours ? s.bkStart : s.autoStartTime}.`);
    return items;
  }

  function renderBkEstimate(s) {
    const mm = (t) => { const [h, mi] = t.split(":").map(Number); return h * 60 + mi; };
    const L = GX.effectiveLimits(s, st.meta, null, Date.now());
    const avg = (s.bkMinDelay + s.bkMaxDelay) / 2 * (1 + (s.bkLongPause / 100) * 2.25);
    const restPer = s.bkRestEvery ? (s.bkRestMinutes * 60) / ((s.bkRestEvery + (s.bkRestEveryMin || s.bkRestEvery)) / 2) : 0;
    const sched = 3600 / Math.max(1, avg + restPer);
    const cap = s.hourlyAuto ? L.hourly : Math.min(s.bkHourlyLimit, L.hourly);
    const perHour = Math.min(cap, sched);
    let winH = 24;
    if (s.activeHours) { let dm = mm(s.bkEnd) - mm(s.bkStart); if (dm <= 0) dm += 1440; winH = dm / 60; }
    const target = Math.min(s.bkDaily, L.daily);
    const secs = target / Math.max(0.1, perHour) * 3600;
    const fits = secs <= winH * 3600 + 60;
    const perDay = fits ? target : Math.floor(perHour * winH);
    const start = new Date(); const sm = s.activeHours ? mm(s.bkStart) : 0; start.setHours(Math.floor(sm / 60), sm % 60, 0, 0);
    const hhmm = (ts) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const b = st.bk || {};
    const needH = secs / 3600;
    const waitTxt = b.stage === "done" ? "everyone is followed back" : b.stage === "ready" ? (s.bkVerifiedOnly ? `${U.fmt(b.left)} to check (verified only)` : `~${Math.ceil((b.left || 0) / Math.max(1, perDay))} days (${U.fmt(b.left)} waiting)`) : "after the first scan";
    setHtml("est", $("#estRows"), `
      <div><span>Follow-backs per hour (working)</span><b class="num">~${Math.round(perHour)}</b></div>
      <div><span>Follow-backs per day</span><b class="num">~${U.fmt(perDay)}</b></div>
      <div><span>Real working time for ${U.fmt(target)} (with breaks)</span><b class="num">~${U.dur(secs)}</b></div>
      <div><span>Done around (starting ${hhmm(start.getTime())})</span><b class="num">${fits ? hhmm(start.getTime() + secs * 1000) : "not in one day"}</b></div>
      <div><span>Daily ON / OFF time</span><b class="num">${s.activeHours ? s.bkStart + " - " + s.bkEnd : "no OFF time"}</b></div>
      <div><span>Who first</span><b class="num">${s.bkOrder === "old" ? "oldest" : "newest"} followers</b></div>
      <div><span>After that</span><b class="num">${s.autoStart ? "rests, auto-starts next day" : "rests until tomorrow"}</b></div>
      <div class="big"><span>Waiting list cleared in</span><b class="num">${waitTxt}</b></div>`);
    const note = $("#estNote");
    if (s.bkDaily > L.daily) { note.className = "est-note warn"; note.textContent = `X's shared daily limit (B2) is ${L.daily}, lower than your Follow back number of ${s.bkDaily}. Follow back stops at ${L.daily}. Raise the limit in B2 (X allows about 400 a day) or lower your number.`; }
    else if (!fits) { note.className = "est-note warn"; note.textContent = `${U.fmt(target)} follow-backs need about ${U.dur(secs)} with your breaks, but the Daily ON / OFF time (B5) gives only ${winH.toFixed(1)} h. Make the ON / OFF time longer, shorten breaks or delays, or raise the per-hour number.`; }
    else if (s.maxRunHours > 0 && needH > s.maxRunHours) { note.className = "est-note warn"; note.textContent = `${U.fmt(target)} follow-backs need about ${U.dur(secs)} with your breaks, but the maximum run time is ${s.maxRunHours} h, so the day would end early. Raise "Maximum run time per day" in B2.`; }
    else if (!s.hourlyAuto && sched > cap * 1.02) { note.className = "est-note warn"; note.textContent = `Your delays allow ~${Math.round(sched)} an hour but the hourly cap is ${cap}, so GrowX adds pauses. That's fine - it just finishes later. (Per hour: Auto works this out for you.)`; }
    else { note.className = "est-note"; note.textContent = s.bkVerifiedOnly ? "Only verified followers are followed back, so the real number per day depends on how many of your followers have a badge. The numbers above are the most it can do." : "Numbers are estimates. If X slows follows down, GrowX takes a break by itself."; }
    const items = bkSafetyItems(s, perHour);
    const worst = Math.max(...items.map((i) => i.lvl));
    const label = worst === 2 ? "High risk" : worst === 1 ? "Medium risk" : "Low risk";
    const icon = ["✓", "!", "✕"];
    setHtml("safety", $("#safetyBox"), `<div class="sf-head"><b>Safety</b><span class="sf-badge l${worst}">${label}</span></div><ul>${items.map((i) => `<li class="l${i.lvl}"><i>${icon[i.lvl]}</i><span>${U.esc(i.text)}</span></li>`).join("")}</ul><p class="sf-foot">No setting makes automation 100% safe. These numbers only lower the risk.</p>`);
  }

  // Follow mode: what a normal day really looks like (follows + breaks until the target, then it stops)
  function renderFollowEstimate(s, e) {
    const goal = Math.max(1, GX.modeTarget(s, "follow", e.L.daily));
    const mm = (t) => { const [h, mi] = t.split(":").map(Number); return h * 60 + mi; };
    let winH = 24;
    if (s.activeHours) { let dm = mm(s.activeEnd) - mm(s.activeStart); if (dm <= 0) dm += 1440; winH = dm / 60; }
    const startD = new Date();
    const startMin = s.autoStart ? GX.autoStartMinutes(s) : (s.activeHours ? mm(s.activeStart) : startD.getHours() * 60 + startD.getMinutes());
    startD.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);
    const startsNow = !s.autoStart && startD.getTime() < Date.now();      // manual start: the clock starts when you press Start
    if (startsNow) startD.setTime(Date.now());
    const eta = etaFor(s, e.L, null, false, 0, { goal, startAt: startD.getTime() });
    const fits = eta.secs <= winH * 3600 + 60;
    const perDayReal = fits ? goal : Math.floor(e.perHour * winH);
    e.fits = fits; e.workSecs = eta.secs; e.winH = winH; e.goal = goal;
    const fpd = perDayReal * e.rate;
    const daysFactor = s.activeHours ? s.activeDays.length / 7 : 1;
    const hhmm = (ts) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    setHtml("est", $("#estRows"), `
      <div><span>Follows per hour (working)</span><b class="num">~${Math.round(e.perHour)}</b></div>
      <div><span>Follows per day</span><b class="num">~${U.fmt(perDayReal)}</b></div>
      <div><span>Real working time for ${U.fmt(goal)} (with breaks)</span><b class="num">~${U.dur(eta.secs)}</b></div>
      <div><span>Done around (${startsNow ? "if you start now" : "starting " + hhmm(startD.getTime())})</span><b class="num">${fits ? hhmm(eta.at) : "not in one day"}</b></div>
      <div><span>After that</span><b class="num">${s.autoStart ? "stops, auto-starts next day" : "stops, waits for you"}</b></div>
      <div><span>Daily ON / OFF time</span><b class="num">${s.activeHours ? s.activeStart + " - " + s.activeEnd : "no OFF time"}</b></div>
      <div><span>Follow-back rate ${e.measured ? "(yours)" : "(typical)"}</span><b class="num">${U.pct(e.rate, 1)}</b></div>
      <div class="big"><span>Expected new followers</span><b class="num">~${U.fmt(fpd)}/day · ${U.compact(fpd * 30 * daysFactor)}/mo</b></div>`);
    renderSafety(s, e);
    const note = $("#estNote");
    if (!s.hourlyAuto && s.restEvery && e.L.hourly < e.schedPerHour * 0.98) { note.className = "est-note warn"; note.textContent = `Your breaks and delays produce about ${Math.round(e.schedPerHour)} follows an hour, but the hourly cap is ${e.L.hourly}. The cap will force extra long pauses - raise it to at least ${Math.ceil(e.schedPerHour)} so only your own breaks apply, or switch Per hour to Auto.`; }
    else if (!e.fits) { note.className = "est-note warn"; note.textContent = `With your breaks, ${U.fmt(e.goal)} follows need about ${U.dur(e.workSecs)} of work, but the Daily ON / OFF time (6) gives only ${e.winH.toFixed(1)} h. The target will not finish in one day. Make the ON / OFF time longer, shorten the breaks, or lower the target.`; }
    else if (s.dailyLimit > 400 && s.speed !== "premium") { note.className = "est-note warn"; note.textContent = "Above ~400 follows a day is only safe with X Premium. Normal accounts hit X's daily follow limit there."; }
    else if (s.restEvery === 0) { note.className = "est-note warn"; note.textContent = "Breaks are off. Regular breaks are one of the strongest signals of a real person - keep them on."; }
    else if (!s.activeHours && !(s.sessionTarget > 0)) { note.className = "est-note warn"; note.textContent = "Running 24 hours a day looks automated. Set a run target or a Daily ON / OFF time."; }
    else if (!s.activeHours) { note.className = "est-note"; note.textContent = `Always on is fine here: it works about ${U.dur(e.workSecs)}, reaches the target, stops, and does not run the rest of the day.`; }
    else { note.className = "est-note"; note.textContent = s.warmup ? `Warm-up is on: today's cap is ${e.L.daily}, rising by ${s.warmupStep} a day up to ${s.dailyLimit}.` : "Numbers are estimates. GrowX slows down by itself whenever X shows a warning."; }
  }

  // ---- Daily ON / OFF time: the 24-hour bar, "ON time now / OFF time now" and the next automatic start, in every mode's card ----
  function renderDaily(s) {
    const now = Date.now(), j = st.job, sel = modeOf(s);
    const mm = (t) => { const [h, mi] = String(t || "0:00").split(":").map(Number); return (h || 0) * 60 + (mi || 0); };
    const hm = (min) => { const d = new Date(now); d.setHours(Math.floor(min / 60) % 24, min % 60, 0, 0); return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); };
    const when = (t) => {
      const d = new Date(t), day = d.toDateString();
      const w = day === new Date(now).toDateString() ? "today" : day === new Date(now + DAY).toDateString() ? "tomorrow" : d.toLocaleDateString([], { weekday: "long" });
      return `${w} at ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    };
    const sod = new Date(now); sod.setHours(0, 0, 0, 0);
    // same rule as the engine: a run of this mode that started, stepped or finished today counts as today's run
    const ranTodayJob = (x) => !!x && ((x.startedAt || 0) >= sod.getTime() || (x.finishedAt || 0) >= sod.getTime() || x.dayKey === new Date(now).toDateString());
    const nd = new Date(now), nowMin = nd.getHours() * 60 + nd.getMinutes();
    $$(".daily-card").forEach((card) => {
      const m = card.dataset.dn;
      const msOwn = GX.modeSettings(Object.assign({}, s, { runMode: m }));      // this mode's own hours and days
      const seed = (st.meta || {}).installedAt || (st.meta || {}).warmupAt || 0;
      const ms = GX.withRestDays(msOwn, seed, now);                             // minus this week's rest days
      const restOff = ms.restOff || [];
      const a = mm(ms.activeStart), b = mm(ms.activeEnd);
      const len = a === b ? 1440 : (b - a + 1440) % 1440;
      card.classList.toggle("no-window", !s.activeHours);
      const lenEl = card.querySelector("[data-dn-len]");
      if (lenEl) setHtml("dnlen_" + m, lenEl, s.activeHours ? `<b>${Math.floor(len / 60)} h${len % 60 ? " " + (len % 60) + " min" : ""}</b>a day` : "<b>No OFF time</b>it works any time");
      const segs = !s.activeHours || a === b ? [[0, 1440]] : a < b ? [[a, b]] : [[a, 1440], [0, b]];
      const bar = card.querySelector("[data-dn-bar]");
      if (bar) setHtml("dnbar_" + m, bar, `<div class="dn-track">${segs.map(([x, y]) => `<i class="dn-seg" style="left:${(x / 14.4).toFixed(2)}%;width:${((y - x) / 14.4).toFixed(2)}%"></i>`).join("")}</div><span class="dn-now" style="left:${(nowMin / 14.4).toFixed(2)}%" title="Now"></span><div class="dn-ticks"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div>`);
      const stEl = card.querySelector("[data-dn-status]");
      if (stEl) {
        let cls = "", txt;
        if (!s.activeHours) txt = "No OFF time: once started it works until the day's number is done.";
        else if (!(msOwn.activeDays || []).length) { cls = "off"; txt = "No working day picked - pick at least one day below, or GrowX never turns ON."; }
        else if (restOff.includes(new Date(now).getDay())) { cls = "off"; txt = `Rest day today (${DAY_NAMES[new Date(now).getDay()]}) · back ${when(GX.nextWindowStart(ms, now))}`; }
        else if (GX.inWindow(ms, now)) { cls = "on"; txt = `ON time now · turns OFF at ${hm(b)}`; }
        else { cls = "off"; txt = `OFF time now · turns ON ${when(GX.nextWindowStart(ms, now))}`; }
        stEl.className = "dn-status" + (cls ? " " + cls : "");
        setHtml("dnst_" + m, stEl, `<i></i><span>${U.esc(txt)}</span>`);
      }
      const cu = card.querySelector(".dn-custom");
      if (cu) cu.hidden = s.autoStartAt !== "custom" && !!s.activeHours;
      const nx = card.querySelector(".dn-next");
      if (nx) {
        const running = !!j && ["running", "resting", "sleeping"].includes(j.status) && jobMode(j) === m;
        let txt;
        if (running) txt = "Running now.";
        else if (s.activeHours && !(msOwn.activeDays || []).length) txt = "No working day picked.";
        else if (!s.autoStart) txt = 'It turns ON only when you press Start. Switch on "Turn ON by itself every day" for no clicking.';
        else {
          const t = GX.nextAutoStart(ms, stopped(m) || (!!j && jobMode(j) === m && ranTodayJob(j)), now);
          txt = `Next automatic start: ${t <= now + 60000 ? "any moment now" : when(t)}${m === sel ? "" : " (once this mode is selected)"}.`;
        }
        // this week's days off, so you can see them without waiting for one to arrive
        if (restOff.length) txt += ` Resting this week: ${restOff.map((d) => DAY_NAMES[d]).join(", ")} (picked again next week).`;
        else if (s.restDays && !s.activeHours) txt += " Rest days need the OFF time switch on.";
        nx.textContent = txt;
      }
    });
  }

  // ---- Per hour: Auto (worked out for you) or your own number -------------------
  function renderHourly(s) {
    const L = GX.effectiveLimits(s, st.meta, null, Date.now());
    const hrs = (h) => (h >= 24 ? "the whole day" : `${Math.round(h * 10) / 10} h`);
    $$('[data-form="autopilot"] .hr-field').forEach((f) => {
      const kind = f.dataset.hr;                                 // follow | followback | unfollow | shared
      const mode = kind === "shared" ? "followback" : kind;
      const man = f.querySelector(".hr-manual"), hint = f.querySelector(".hr-hint");
      if (man) man.hidden = !!s.hourlyAuto;
      if (!hint) return;
      let info;
      try { info = GX.autoHourly(s, mode, { daily: L.daily }); } catch (_) { hint.textContent = ""; return; }
      const noun = mode === "unfollow" ? "unfollows" : mode === "followback" ? "follow-backs" : "follows";
      let html;
      if (kind === "shared") html = s.hourlyAuto ? `Auto: <b>${info.cap}</b> an hour for follows and follow-backs together (X counts them together).` : "Follows and follow-backs together in any 60 minutes.";
      else if (s.hourlyAuto) html = `About <b>${info.cap}</b> ${noun} an hour at most - just above the busiest hour your delays and breaks can make, so it never stops you before your break count${info.by === "max" ? " (the highest GrowX allows)" : ""}. It changes by itself when you change them.`;
      else html = `Never more than this in any 60 minutes. Auto would use <b>${info.cap}</b> here.`;
      setHtml("hr_" + kind, hint, html);
    });
  }

  // ---- "When X refuses" plan: dim switched-off steps, say where today stands ------------
  function renderLadders(s) {
    const now = Date.now(), lad = st.lad || {};
    const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const span = (lo, hi) => (lo === hi ? fmtMin(lo / 60000) : `${fmtMin(lo / 60000)} to ${fmtMin(hi / 60000)}`);
    for (const [mode, id] of [["follow", "ladFollow"], ["followback", "ladBk"], ["unfollow", "ladUnfollow"]]) {
      const card = $("#" + id);
      if (!card) continue;
      const pre = LAD_PRE[mode];
      [1, 2, 3].forEach((n) => { const el = card.querySelector(`.lad-step[data-lad="${n}"]`); if (el) el.classList.toggle("off", !s[pre + (n - 1) + "On"]); });
      const hint = $("#" + id + "Hint");
      if (!hint) continue;
      const p = GX.refusePlan(s, mode), ld = lad[mode === "unfollow" ? "unfollow" : "follow"] || {};
      const word = mode === "unfollow" ? "unfollowing" : "following";
      const short = `${p.on0 ? span(p.lo0, p.hi0) + " break" : "no break"} → ${p.on1 ? span(p.lo1, p.hi1) + " break" : "no break"} → ${p.on2 ? span(p.lo2, p.hi2) + " break" : "no break"} → stop for today`;
      let html = `In short: X refuses → ${short}.`, live = false;
      if (stopped(mode)) { live = true; html = `<b>Today: stopped (step 4).</b> X kept refusing, so ${word} is off until tomorrow${s.autoStart ? " - it starts again by itself" : " - press Start tomorrow"}.`; }
      else if (ld.until > now) { live = true; html = `<b>Today: step ${Math.min(3, ld.n || 1)} break running until ${hhmm(ld.until)}.</b> If X refuses again: ${short.split(" → ").slice(Math.min(3, ld.n || 1)).join(" → ")}.`; }
      else if (ld.n > 0) { live = true; html = `<b>Today: X refused ${ld.n} time${ld.n === 1 ? "" : "s"}.</b> If the next try is refused too, that is step ${Math.min(4, ld.n + 1)}; one ${mode === "unfollow" ? "unfollow" : "follow"} that works starts the plan again from step 1.`; }
      hint.className = "hint lad-hint" + (live ? " live" : "");
      setHtml("lad_" + mode, hint, html);
    }
  }

  function renderAutopilot() {
    try { renderBatchPreview(document); } catch (_) {}
    try { renderSeqCard(); } catch (_) {}
    const s = draft("autopilot");
    const mode = modeOf(s);
    const unfSel = mode === "unfollow", bkSel = mode === "followback", cmtSel = mode === "comment";
    const pg = $('[data-page="autopilot"]');
    if (pg) { pg.dataset.m = mode; pg.classList.toggle("m-unf", unfSel); pg.classList.toggle("m-bk", bkSel); pg.classList.toggle("m-cmt", cmtSel); }
    $$("#modeSeg [data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
    const j0 = st.job, live = j0 && ["running", "resting", "sleeping"].includes(j0.status);
    const savedMode = st.settings.runMode;
    const stTxt = (m) => (live && jobMode(j0) === m ? '<em class="on">Running now</em>' : savedMode === m ? "<em>Selected</em>" : "");
    setHtml("msF", $("#msFollow"), stTxt("follow"));
    setHtml("msU", $("#msUnfollow"), stTxt("unfollow"));
    setHtml("msB", $("#msFollowBack"), stTxt("followback"));
    setHtml("msC", $("#msComment"), stTxt("comment"));
    renderUnfStatus(s);
    renderBkStatus(s);
    // A pace card shows the hourly number the pace really gets: worked out (Auto) or the preset's own number.
    const presetHour = (p, m) => {
      if (!s.hourlyAuto) return m === "unfollow" ? p.unfHourlyLimit : m === "followback" ? p.bkHourlyLimit : p.hourlyLimit;
      try { return GX.hourlyCap(GX.normalizeSettings(Object.assign({}, s, p, { runMode: m })), m).cap; } catch (_) { return "?"; }
    };
    const upCards = Object.entries(GX.UNF_PRESETS).map(([k, p]) => {
      const info = GX.UNF_PRESET_INFO[k];
      return `<button class="preset ${s.unfPace === k ? "on" : ""}" data-upreset="${k}"><b>${info.name}</b><small>${info.tag}</small><span class="pr-per">~${p.unfollowDaily} / day</span><span class="pr-meta">${p.unfMinDelay}-${p.unfMaxDelay}s · ${presetHour(p, "unfollow")}/h · break every ${p.unfRestEvery}</span></button>`;
    }).join("") + `<button class="preset ${s.unfPace === "custom" ? "on" : ""}" data-upreset="custom"><b>Custom</b><small>Your own numbers below</small><span class="pr-per">~${s.unfollowDaily} / day</span><span class="pr-meta">every value is adjustable</span></button>`;
    setHtml("unfPresets", $("#unfPresets"), upCards);

    const bpCards = Object.entries(GX.BK_PRESETS).map(([k, p]) => {
      const info = GX.BK_PRESET_INFO[k];
      return `<button class="preset ${s.bkPace === k ? "on" : ""}" data-bpreset="${k}"><b>${info.name}</b><small>${info.tag}</small><span class="pr-per">~${p.bkDaily} / day</span><span class="pr-meta">${p.bkMinDelay}-${p.bkMaxDelay}s · ${presetHour(p, "followback")}/h · break every ${p.bkRestEvery}</span></button>`;
    }).join("") + `<button class="preset ${s.bkPace === "custom" ? "on" : ""}" data-bpreset="custom"><b>Custom</b><small>Your own numbers below</small><span class="pr-per">~${s.bkDaily} / day</span><span class="pr-meta">every value is adjustable</span></button>`;
    setHtml("bkPresets", $("#bkPresets"), bpCards);

    const cards = Object.entries(GX.PRESETS).map(([k, p]) => {
      const info = GX.PRESET_INFO[k];
      return `<button class="preset ${st.settings.speed === k && !ui.dirty.autopilot ? "on" : ""}" data-preset="${k}"><b>${info.name}</b><small>${info.tag}</small><span class="pr-per">${info.per}</span><span class="pr-meta">${p.minDelay}-${p.maxDelay}s · ${presetHour(p, "follow")}/h · break every ${p.restEvery}</span><span class="pr-sets">target ${U.fmt(p.sessionTarget)} · max ${p.maxRunHours} h · ${p.restDays} rest day${p.restDays === 1 ? "" : "s"}${p.warmup ? " · warm-up" : ""}</span></button>`;
    }).join("") + `<button class="preset ${st.settings.speed === "custom" && !ui.dirty.autopilot ? "on" : ""}" data-preset="custom"><b>Custom</b><small>Your own numbers below</small><span class="pr-per">${st.settings.speed === "custom" ? "~" + st.settings.dailyLimit + " / day" : "your call"}</span><span class="pr-meta">every value is adjustable</span></button>`;
    setHtml("presets", $("#presets"), cards);

    if (cmtSel) { renderDaily(s); return; }
    const e = estimate(s);
    if (unfSel) renderUnfEstimate(s);
    else if (bkSel) renderBkEstimate(s);
    else renderFollowEstimate(s, e);
    renderPlanHelper(s);
    renderDaily(s);
    const bh = $("#bkDailyHint");
    if (bh) {
      const lowShared = s.bkDaily > s.dailyLimit;
      bh.className = "hint" + (lowShared ? " warn" : "");
      bh.textContent = lowShared ? `Lower than your Follow back number (${s.bkDaily}), so Follow back stops at ${s.dailyLimit}. Raise it - X allows about 400 a day.` : "Follows and follow-backs together. X allows about 400 a day (more with Premium).";
    }
    $("#warmHint").textContent = s.warmup ? `Today's cap with warm-up: ${e.L.daily} follows (goes up ${s.warmupStep}/day to ${s.dailyLimit}).` : "Off - the full daily cap applies from day one.";
    renderHourly(s);
    renderLadders(s);
    const uoh = $("#unfOrderHint");
    if (uoh) {
      const every = false;
      const newest = s.unfOrder === "new";
      uoh.textContent = every
        ? `Clears your WHOLE following list, ${newest ? "the accounts you followed most recently" : "the accounts you followed longest ago"} first: the people who don't follow you back, then the people who do as well (they stay your followers - you just stop following them, and some may unfollow you in return). Your Never unfollow list (U7) is always respected, and it runs at your daily number, so a long list takes several days.`
        : s.unfOrder === "lost"
        ? `Everyone on your "Unfollowed you" page goes first - the people who followed you and later stopped (${U.fmt((st.lost || {}).elig || 0)} can be unfollowed right now). After them the list carries on oldest first. Your Never unfollow list is still respected.`
        : newest
        ? `Newest = the accounts you followed most recently go first (people GrowX followed still get their ${s.unfollowAfterDays} days to follow back). Changing it mid-way turns the rest of the list around - nobody is unfollowed twice.`
        : "Oldest = the accounts you followed longest ago go first. It works through the whole list, one by one.";
    }
    const foh = $("#followOrderHint");
    if (foh) foh.textContent = s.followOrder === "new" ? "Newest found = people who just followed your sources (active right now) go first. Pinned people always go first."
      : s.followOrder === "old" ? "Oldest found = people waiting longest in your queue go first, before they get too old. Pinned people always go first."
      : "Best match = the highest follow-back score in your queue goes first. Pinned people always go first.";
  }

  // =====================================================================
  // MODE SEQUENCE: the order, each mode's turn target, the transition break,
  // and a live preview of how the whole thing will run.
  // =====================================================================
  const MODE_ICON = { follow: "users", unfollow: "userX", followback: "userPlus", comment: "chat" };
  const MODE_CLS = { follow: "th-fl", unfollow: "th-unf", followback: "th-bk", comment: "th-cmt" };
  const MODE_WORD = { follow: "follows", unfollow: "unfollows", followback: "follow-backs", comment: "replies" };
  const MODE_SUB = {
    follow: "Follow new people from your sources",
    unfollow: "Clear out the people who don't follow you",
    followback: "Follow the people who follow you",
    comment: "Write and post AI replies on the posts you choose"
  };
  // Where each mode's own settings live, and what its numbers are called there.
  const MODE_KEYS = {
    follow: { card: '[data-for~="follow"]', where: "section 1", turnLabel: "Run target" },
    followback: { card: ".bk-card", where: "B1", turnLabel: "Follow-backs per day" },
    unfollow: { card: ".unf-card", where: "U1", turnLabel: "Unfollows per day" },
    comment: { card: "#cmtSettings", where: "C1", turnLabel: "Target per turn" }
  };
  // Every order of the three modes, so any arrangement can be picked straight from the list.
  // Every order of the three follow modes, plus the same orders with Comment on the end
  // (Comment is the one mode that does not touch X's follow limit, so it fits anywhere).
  const SEQ_BASE = [
    ["follow,followback,unfollow", "Follow → Follow back → Unfollow"],
    ["follow,unfollow,followback", "Follow → Unfollow → Follow back"],
    ["followback,follow,unfollow", "Follow back → Follow → Unfollow"],
    ["followback,unfollow,follow", "Follow back → Unfollow → Follow"],
    ["unfollow,follow,followback", "Unfollow → Follow → Follow back"],
    ["unfollow,followback,follow", "Unfollow → Follow back → Follow"]
  ];
  const SEQ_PRESETS = SEQ_BASE.map(([k, l]) => [k + ",comment", l + " → Comment"])
    .concat([["comment,follow,followback,unfollow", "Comment → Follow → Follow back → Unfollow"]])
    .concat(SEQ_BASE);          // the same orders for when Comment is switched off

  // The settings the sequence card should show: saved, plus anything unsaved in EITHER form - the day numbers
  // (daily limit, follow-backs a day, unfollows a day) also live on the mode cards further down the page.
  function seqDraft() {
    return GX.normalizeSettings(Object.assign({}, st.settings,
      ui.dirty.autopilot ? readForm("autopilot") : {},
      ui.dirty.sequence ? readForm("sequence") : {}));
  }

  // ---- the order, read and written by hand (these are not data-k fields) ----
  function seqOrder() { return $$("#seqCards .sq-card").map((c) => c.dataset.m); }
  function seqOff() { return $$("#seqCards .sq-card.off").map((c) => c.dataset.m); }

  function renderSeqCards(order, off) {
    const box = $("#seqCards");
    if (!box) return;
    const s = seqDraft();
    const M = st.modes || {};
    const offSet = new Set(off);
    const on = order.filter((m) => !offSet.has(m));
    box.innerHTML = order.map((m, i) => {
      const k = MODE_KEYS[m], d = M[m] || {};
      const isOff = offSet.has(m);
      const place = isOff ? "-" : on.indexOf(m) + 1;
      const daily = (st.limits || {}).daily;
      const turnN = GX.modeTurnTarget(s, m, daily), dayN = GX.modeTarget(s, m, daily);
      return `<div class="sq-card ${MODE_CLS[m]}${isOff ? " off" : ""}" data-m="${m}">
        <div class="sq-card-top">
          <span class="sq-n" title="${isOff ? "Left out of the sequence" : "Place in the sequence"}">${place}</span>
          <span class="sq-move">
            <button type="button" class="icon-btn sq-up" data-icon="chevron" title="Move earlier"${i === 0 ? " disabled" : ""}></button>
            <button type="button" class="icon-btn sq-down" data-icon="chevron" title="Move later"${i === order.length - 1 ? " disabled" : ""}></button>
          </span>
          <span class="sq-card-ic">${U.icon(MODE_ICON[m])}</span>
          <b class="sq-card-name">${MODE_NAME[m]}</b>
          <label class="switch sq-on" title="${isOff ? "Put this mode back in the sequence" : "Leave this mode out of the sequence"}"><input type="checkbox" class="sq-use"${isOff ? "" : " checked"}><span class="track"></span></label>
        </div>
        <small class="sq-card-sub">${MODE_SUB[m]}</small>
        <div class="sq-card-nums" title="These come from ${MODE_NAME[m]}'s own settings (${k.where}) - change them there and the sequence follows.">
          <div class="sq-num"><small>Each turn</small><b>${U.fmt(turnN)}</b><span>${MODE_WORD[m]}</span></div>
          <div class="sq-num"><small>Per day</small><b>${U.fmt(dayN)}</b><span>${MODE_WORD[m]}</span></div>
        </div>
        <div class="sq-card-foot">
          <span class="sq-pace">${d.delay ? `${d.delay[0]}-${d.delay[1]} s apart` : ""}${d.breakRange ? ` · break ${brkTxt(d.breakRange[0], d.breakRange[1])}` : ""}</span>
          <button type="button" class="btn btn-ghost btn-xs sq-more" data-icon="chevron" title="Open ${MODE_NAME[m]}'s own settings (${k.where}) - every number this card shows is set there"><span>Mode settings</span></button>
        </div>
      </div>`;
    }).join("");
    // the arrows between the cards follow the real running order
    U.icons(box);
  }

  function wireSequence() {
    const box = $("#seqCards");
    if (!box) return;
    box.addEventListener("click", (e) => {
      const card = e.target.closest(".sq-card");
      if (!card) return;
      if (e.target.closest(".sq-more")) {                 // jump to that mode's own settings further down the page
        e.preventDefault();
        return setMode(card.dataset.m).then(() => {
          const el = $(MODE_KEYS[card.dataset.m].card);
          if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      }
      const up = e.target.closest(".sq-up"), down = e.target.closest(".sq-down");
      if (!up && !down) return;
      const order = seqOrder(), i = order.indexOf(card.dataset.m);
      if (up && i > 0) [order[i - 1], order[i]] = [order[i], order[i - 1]];
      else if (down && i < order.length - 1) [order[i + 1], order[i]] = [order[i], order[i + 1]];
      else return;
      renderSeqCards(order, seqOff());
      markDirty("sequence");
    });
    box.addEventListener("change", (e) => {
      const card = e.target.closest(".sq-card");
      if (!card || !e.target.closest(".sq-use")) return;
      card.classList.toggle("off", !e.target.checked);
      renderSeqCards(seqOrder(), seqOff());
      markDirty("sequence");
    });

    // "At the end of the list" is ONE choice: the radio group writes the one setting behind it, so the two
    // halves can never end up disagreeing (which is what made this look broken before).
    $("#seqOpts").addEventListener("change", (e) => {
      const r = e.target.closest(".seq-end");
      if (!r) return;
      const loop = $('[data-form="sequence"] [data-k="switchLoop"]');
      if (loop) loop.checked = r.value === "loop";
      markDirty("sequence");
    });
    const preset = $("#seqPreset");
    preset.addEventListener("change", (e) => {
      const v = e.target.value;
      if (!v) return;
      // a mode switched off keeps its place in the order the preset gives
      renderSeqCards(v.split(","), seqOff());
      markDirty("sequence");
      e.target.value = v;                 // markDirty re-renders; make sure the list still shows what was picked
      e.target.blur();                    // and hand focus back so the next tick may refresh it again
    });
    $("#seqReset").addEventListener("click", async () => {
      if (!await confirmBox({ title: "Reset the sequence?", body: "The order goes back to Follow → Follow back → Unfollow, every mode is switched back on, the transition break goes back to 10-30 minutes and the sequence repeats. Your per-mode targets, delays and breaks are not touched.", ok: "Reset", icon: "refresh" })) return;
      renderSeqCards(GX.DEFAULT_SEQ.slice(), []);
      const set = (k, v) => { const el = $(`[data-form="sequence"] [data-k="${k}"]`); if (el) { if (el.type === "checkbox") el.checked = !!v; else el.value = v; } };
      set("transMin", GX.DEFAULT_SETTINGS.transMin);
      set("transMax", GX.DEFAULT_SETTINGS.transMax);
      set("switchLoop", true);
      $$("#seqOpts .seq-end").forEach((r) => { r.checked = r.value === "loop"; });
      markDirty("sequence");
    });
    // the two-handle slider for the transition break
    const lo = $("#tsLo"), hi = $("#tsHi");
    const fromSlider = () => {
      let a = Number(lo.value), b = Number(hi.value);
      if (a > b) { if (document.activeElement === lo) b = a; else a = b; lo.value = a; hi.value = b; }
      $('[data-form="sequence"] [data-k="transMin"]').value = a;
      $('[data-form="sequence"] [data-k="transMax"]').value = b;
      markDirty("sequence");
    };
    lo.addEventListener("input", fromSlider);
    hi.addEventListener("input", fromSlider);
  }

  // ---- the card, its note, the slider and the preview panel ----
  function renderSeqCard() {
    if (!st) return;
    const s = seqDraft();
    const order = ui.dirty.sequence ? seqOrder() : GX.modeOrder(s);
    const off = ui.dirty.sequence ? seqOff() : (s.switchOff || []);
    if (!$("#seqCards").children.length || !ui.dirty.sequence) renderSeqCards(order, off);
    const on = order.filter((m) => !off.includes(m));

    const wrap = $("#seqWrap");
    if (wrap) wrap.classList.toggle("seq-on", !!s.autoSwitch);
    const badge = $("#seqState");
    if (badge) {
      badge.textContent = s.autoSwitch ? "On" : "Off";
      badge.classList.toggle("on", !!s.autoSwitch);
      badge.title = s.autoSwitch ? "The sequence decides the order and the dashboard shows it" : "GrowX runs the one mode you pick, and the dashboard looks as it always did";
    }
    const note = $("#seqOffNote");
    if (note) note.hidden = !!s.autoSwitch;
    // the radio group always shows exactly what is saved (or typed, when the form is dirty)
    $$("#seqOpts .seq-end").forEach((r) => { r.checked = (r.value === "loop") === !!s.switchLoop; });
    $$("#seqOpts .opt.pick").forEach((o) => o.classList.toggle("on", (o.dataset.opt === "loop") === !!s.switchLoop));

    // quick-order list, with "Custom" shown when the cards say something else
    const sel = $("#seqPreset");
    if (sel && document.activeElement !== sel) {
      const cur = on.join(",");
      const opts = SEQ_PRESETS.filter(([v]) => v.split(",").every((m) => on.includes(m)) && v.split(",").length === on.length);
      const html = (opts.length ? opts : SEQ_PRESETS).map(([v, l]) => `<option value="${v}">${l}</option>`).join("")
        + (opts.some(([v]) => v === cur) ? "" : `<option value="" selected>Your own order${on.length ? ": " + on.map((m) => MODE_NAME[m]).join(" → ") : ""}</option>`);
      if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
      sel.value = opts.some(([v]) => v === cur) ? cur : "";
    }

    // transition break: the slider, its labels and the plain-language line
    const a = Math.max(1, Number(s.transMin) || 1), b = Math.max(a, Number(s.transMax) || a);
    const top = Math.max(60, Math.ceil(b * 1.5 / 10) * 10);
    const lo = $("#tsLo"), hi = $("#tsHi"), fill = $("#tsFill");
    if (lo && hi && document.activeElement !== lo && document.activeElement !== hi) {
      lo.max = hi.max = top; lo.value = a; hi.value = b;
    }
    if (fill) {
      const l = (Math.min(a, top) - 1) / (top - 1) * 100, r = (Math.min(b, top) - 1) / (top - 1) * 100;
      fill.style.left = l + "%";
      fill.style.width = Math.max(0, r - l) + "%";
    }
    const le = $("#tsLoLab"), he = $("#tsHiLab");
    if (le) le.textContent = "1 min";
    if (he) he.textContent = top + " min";
    const tr = $("#transRand");
    if (tr) tr.textContent = b > a
      ? `Every hand-over waits a different time between ${a} and ${b} minutes.`
      : `Every hand-over waits exactly ${a} minute${a === 1 ? "" : "s"}. Set a longer "at most" for a random wait.`;

    // the note under the cards
    const n = $("#seqNote");
    if (n) {
      const bits = [];
      if (!on.length) bits.push("Every mode is switched off, so there is nothing to switch between. Switch at least two back on.");
      else if (on.length === 1) bits.push(`Only <b>${MODE_NAME[on[0]]}</b> is left in the sequence, so there is nobody to hand over to - it just runs on its own numbers.`);
      else {
        bits.push(`Order: <b>${on.map((m) => MODE_NAME[m]).join(" &rarr; ")}</b>${s.switchLoop ? ", then round again" : ", then it stops for the day"}.`);
        const turns = on.map((m) => `${MODE_NAME[m]} <b>${U.fmt(GX.modeTurnTarget(s, m, (st.limits || {}).daily))}</b>`);
        bits.push(`Each turn: ${turns.join(" &middot; ")} - every one of those comes from that mode's own settings, not from here.`);
        if (!Number(s.sessionTarget) && on.includes("follow")) bits.push("Give Follow a <b>Run target</b> in section 1 if you want it to hand over before its whole day is done.");
      }
      const sq = st.seq || {};
      if (sq.doneToday && sq.doneToday.length) bits.push(`Finished today: <b>${sq.doneToday.map((m) => MODE_NAME[m]).join(", ")}</b>.`);
      if (sq.switchN) bits.push(`${sq.switchN} of ${sq.max} hand-overs used today.`);
      n.innerHTML = bits.join(" ");
    }

    renderSeqPreview(s, on);
    renderSeqNow(s, on);
  }

  // ---- the right-hand panel: how a run will look ----
  function renderSeqPreview(s, on) {
    const box = $("#seqPrev");
    if (!box) return;
    if (!on.length) {
      setHtml("seqPrev", box, `<p class="seq-empty">No mode is in the sequence yet.</p>`);
      return;
    }
    const daily = (st.limits || {}).daily;
    const trans = s.transMax > s.transMin ? `${s.transMin}-${s.transMax} min, at random` : `exactly ${s.transMin} min`;
    const rows = [];
    on.forEach((m, i) => {
      const d = (st.modes || {})[m] || {};
      rows.push(`<div class="pv-step ${MODE_CLS[m]}">
        <span class="pv-n">${i + 1}</span>
        <span class="pv-ic">${U.icon(MODE_ICON[m])}</span>
        <div class="pv-body">
          <b>${MODE_NAME[m]}</b>
          <span><em>${U.fmt(GX.modeTurnTarget(s, m, daily))}</em> ${MODE_WORD[m]} this turn${d.delay ? ` &middot; ${d.delay[0]}-${d.delay[1]} s apart` : ""}</span>
          <span class="pv-dim">Up to ${U.fmt(GX.modeTarget(s, m, daily))} a day${d.breakRange ? ` &middot; break ${brkTxt(d.breakRange[0], d.breakRange[1])}` : ""}</span>
        </div>
      </div>`);
      if (i < on.length - 1 || s.switchLoop) rows.push(`<div class="pv-gap">${U.icon("clock")}<span>Transition break</span><em>${trans}</em></div>`);
    });
    if (s.switchLoop && on.length > 1) rows.push(`<div class="pv-loop">${U.icon("refresh")}<span>Starts again at ${MODE_NAME[on[0]]}</span></div>`);
    else rows.push(`<div class="pv-loop end">${U.icon("check")}<span>Stops for the day</span></div>`);
    setHtml("seqPrev", box, rows.join(""));
  }

  // ---- the right-hand panel: where the run actually is ----
  function renderSeqNow(s, on) {
    const box = $("#seqNow");
    if (!box) return;
    const sq = st.seq || {}, M = st.modes || {}, v = U.jobView(st.job, st.task);
    const pill = $("#seqPill"), txt = $("#seqPillText");
    if (pill) pill.className = "pill " + v.cls;
    if (txt) txt.textContent = v.label;
    const t = sq.trans;
    const cur = sq.running;
    const rows = [];
    if (cur) {
      const d = M[cur] || {};
      const pct = Math.round((d.turnPct || 0) * 100);
      rows.push(`<div class="nw-row ${MODE_CLS[cur]}">
        <span class="nw-ic">${U.icon(MODE_ICON[cur])}</span>
        <div class="nw-body"><small>Running now</small><b>${MODE_NAME[cur]}</b>
          <div class="bar thin"><i style="width:${pct}%"></i></div>
          <span>${U.fmt(d.turnDone)} / ${U.fmt(d.turn)} this turn &middot; ${U.fmt(d.done)} / ${U.fmt(d.target)} today</span>
        </div></div>`);
    } else if (t) {
      rows.push(`<div class="nw-row swap">
        <span class="nw-ic">${U.icon("clock")}</span>
        <div class="nw-body"><small>Transition break</small><b>${MODE_NAME[t.from]} finished</b>
          <span>${MODE_NAME[t.to]} starts at ${U.clock(t.until)} &middot; <em class="ls-count" data-until="${t.until}">${U.countdown(t.until - Date.now())}</em> left</span>
        </div></div>`);
    } else {
      const begin = sq.startAt || modeOf(s);
      const cyc = s.autoSwitch && on.length > 1;
      rows.push(`<div class="nw-row idle ${MODE_CLS[begin] || ""}">
        <span class="nw-ic">${U.icon(MODE_ICON[begin] || "users")}</span>
        <div class="nw-body"><small>${v.paused ? "Paused" : v.halted ? "Needs you" : "Not running"}</small>
          <b>${sq.startAt ? "Start begins with " + MODE_NAME[sq.startAt] : cyc ? "Nothing left in the sequence today" : MODE_NAME[modeOf(s)] + " is selected"}</b>
          <span>${cyc ? (sq.startAt ? "First in your order that still has work today" : "It starts again tomorrow") : "Press Start, or let it start by itself in its hours"}</span>
        </div></div>`);
    }
    const next = t ? t.to : sq.next;
    if (next && next !== cur) {
      const d = M[next] || {};
      rows.push(`<div class="nw-row next ${MODE_CLS[next]}">
        <span class="nw-ic">${U.icon(MODE_ICON[next])}</span>
        <div class="nw-body"><small>Next</small><b>${MODE_NAME[next]}</b>
          <span>${U.fmt(GX.modeTurnTarget(s, next, (st.limits || {}).daily))} ${MODE_WORD[next]} on its turn</span>
        </div></div>`);
    }
    if (!s.autoSwitch) rows.push(`<p class="seq-empty">Automatic switching is off, so GrowX stays in this mode.</p>`);
    setHtml("seqNow", box, rows.join(""));
  }

  // ---- the Live card on the Overview: the sequence strip + every mode's progress ----
  function renderLiveSeq() {
    const sq = st.seq || {}, M = st.modes || {};
    const box = $("#liveSeq");
    if (box) {
      const order = sq.order || [];
      box.hidden = !sq.on || !order.length;
      if (!box.hidden) {
        const t = sq.trans;
        const head = t
          ? `<div class="ls-head swap" title="Nothing is followed or unfollowed during a transition break.">${U.icon("swap")}<b>Transition break</b><span>${MODE_NAME[t.from]} finished &middot; ${MODE_NAME[t.to]} starts at ${U.clock(t.until)}</span><em class="ls-count" data-until="${t.until}">${U.countdown(t.until - Date.now())}</em></div>`
          : `<div class="ls-head">${U.icon("refresh")}<b>Mode sequence</b><span>${sq.running ? MODE_NAME[sq.running] + " is running" : "waiting"}${sq.next ? " &middot; next: " + MODE_NAME[sq.next] : ""}</span></div>`;
        const chips = order.map((m) => {
          const d = M[m] || {};
          const cls = [MODE_CLS[m], d.running ? "now" : "", d.doneToday || d.reached ? "done" : "", d.blocked ? "blocked" : "", t && t.to === m ? "next" : ""].filter(Boolean).join(" ");
          const num = d.running && sq.cycling ? `${U.fmt(d.turnDone)}/${U.fmt(d.turn)}` : `${U.fmt(d.done)}/${U.fmt(d.target)}`;
          return `<span class="sq-chip ${cls}" title="${MODE_NAME[m]}: ${seqWhy(m, d)}">${U.icon(MODE_ICON[m])}<b>${MODE_NAME[m]}</b><small>${num}</small></span>`;
        }).join(`<span class="sq-arrow">${U.icon("chevron")}</span>`);
        setHtml("liveSeq", box, head + `<div class="ls-flow">${chips}</div>`);
      }
    }
    // The per-mode progress row belongs to the sequence: with it switched off the Overview looks exactly
    // as it did before this feature existed.
    const prog = $("#modeProg");
    if (!prog) return;
    prog.hidden = !sq.on || !(sq.order || []).length;
    if (prog.hidden) { if (ui.html.modeProg) { prog.innerHTML = ""; ui.html.modeProg = ""; } return; }
    const order = sq.on && (sq.order || []).length ? sq.order.concat(GX.MODES.filter((m) => !sq.order.includes(m))) : GX.MODES;
    const html = order.map((m) => {
      const d = M[m] || {};
      const pct = Math.round((d.pct || 0) * 100);
      const state = d.running ? "Running" : d.blocked ? (m === "unfollow" ? "X refused unfollows today" : "X limited follows today")
        : d.doneToday ? "Target reached today" : d.reached ? "Number used up today"
        : d.off ? "Left out of the sequence"
        : d.selected ? "Selected, not started" : !d.inWindow ? "Outside its hours" : sq.on && (sq.order || []).includes(m) ? "Waiting its turn" : "Idle";
      const brk = d.batch && d.batch[1] ? `break every ${batchTxt(d.batch[0], d.batch[1])} &middot; ${brkTxt((d.breakRange || [])[0], (d.breakRange || [])[1])}` : "no breaks";
      const turn = d.running && sq.cycling && d.turn < d.target ? ` &middot; ${U.fmt(d.turnDone)}/${U.fmt(d.turn)} this turn` : "";
      return `<div class="mp ${MODE_CLS[m]}${d.running ? " now" : ""}${d.doneToday || d.reached ? " done" : ""}${d.off ? " skip" : ""}" title="${U.esc(MODE_NAME[m])}: ${U.esc(state)} &#10;${pct}% of today's ${MODE_WORD[m]} &#10;${U.fmt(d.hour)} of ${U.fmt(d.cap)} this hour &#10;${U.esc(brk)}">
        <div class="mp-top">${U.icon(MODE_ICON[m])}<b>${MODE_NAME[m]}</b><em class="num">${U.fmt(d.done)}<i>/${U.fmt(d.target)}</i></em></div>
        <div class="bar thin"><i style="width:${pct}%"></i></div>
        <span class="mp-state">${U.esc(state)}</span>
        <small>${pct}% of today's ${MODE_WORD[m]} &middot; ${U.fmt(d.hour)}/${U.fmt(d.cap)} this hour${turn}</small>
        <small class="mp-brk">${brk}</small>
      </div>`;
    }).join("");
    setHtml("modeProg", prog, html);
  }

  function seqWhy(m, d) {
    if (d.running) return "running now";
    if (d.off) return "left out of the sequence";
    if (d.blocked) return m === "unfollow" ? "X refused unfollows today" : "X limited following today";
    if (d.doneToday) return "target reached today";
    if (d.reached) return "its number for today is already used up";
    return "waiting its turn";
  }

  // =====================================================================
  // HISTORY
  // =====================================================================
  function wireHistory() {
    $("#hSearch").addEventListener("input", debounce(() => { ui.hShow = 100; renderHistory(); }, 150));
    $("#hFilter").addEventListener("click", (e) => {
      const b = e.target.closest("[data-f]");
      if (!b) return;
      ui.hFilter = b.dataset.f;
      ui.hShow = 100;
      $$("#hFilter button").forEach((x) => x.classList.toggle("on", x === b));
      renderHistory();
    });
    $("#hMoreBtn").addEventListener("click", () => { ui.hShow += 200; renderHistory(); });
    $("#hCheck").addEventListener("click", async () => {
      const r = await U.cmd("fbCheckNow");
      U.toast(r.ok ? "Checking who followed back..." : (r.error || "Couldn't start."), r.ok ? "good" : "bad");
    });
    document.addEventListener("click", (ev) => {
      const b = ev.target.closest && ev.target.closest("[data-ex]");
      if (b) { b.dataset.ex === "all" ? downloadAll(b.dataset.kind) : download(b.dataset.ex, b.dataset.kind); }
    });

  }

  function result(f, now) {
    // They followed you and later stopped: say so, instead of still showing it as a follow-back.
    if (f.lost) return ["no", "userMinus", `Unfollowed you · ${U.ago(f.lost).replace(" ago", " ago")}`];
    if (f.fy0) return ["back", "check", "Already followed you"];
    if (f.fb) return ["back", "check", `Followed back · ${U.dur((f.fb - f.t) / 1000)}`];
    if (f.nf) return ["no", "x", "You unfollowed them"];
    if (f.p) return ["wait", "clock", "Request sent (private)"];
    if (now - f.t < 7 * DAY) return ["wait", "clock", `Waiting · ${U.ago(f.t).replace(" ago", "")}`];
    return ["no", "x", "No follow-back yet"];
  }

  // When GrowX last checked for follow-backs, and when it checks next.
  function fbStatus(now) {
    const i = st.fbinfo || {};
    const parts = [];
    if (i.at) parts.push(`Checked ${U.ago(i.at)}${i.found ? ` (+${U.fmt(i.found)} new)` : ""}`);
    if (i.scanAt) parts.push(`full follower scan ${U.ago(i.scanAt)}`);
    const next = st.relNext;
    if (st.relPending) parts.push(`${U.fmt(st.relPending)} waiting · next check ${!next || next <= now ? "due now" : next - now < DAY ? "at " + U.clock(next) : U.date(next)}`);
    const err = i.errorAt && (!i.at || i.errorAt > i.at) ? i.error : i.scanErrorAt && (!i.scanAt || i.scanErrorAt > i.scanAt) ? i.scanError : null;
    if (err) parts.push(`last try failed (${err}) - retrying automatically`);
    if (!parts.length) return "Follow-backs are checked automatically 30 min, 2 h, 8 h, 1 day, 3, 7 and 14 days after each follow.";
    const s = parts.join(" · ");
    return s.charAt(0).toUpperCase() + s.slice(1) + ".";
  }

  async function renderHistory() {
    const all = await getFollows();
    const now = Date.now();
    const acc = st.account;
    const q = $("#hSearch").value.trim().toLowerCase();
    const rows = [];
    for (let i = all.length - 1; i >= 0; i--) {
      const f = all[i];
      if (acc && acc.id && f.o && f.o !== acc.id) continue;
      if (q && !(`${f.h} ${f.n}`).toLowerCase().includes(q)) continue;
      const back = !!((f.fb || f.fy0) && !f.lost);
      if (ui.hFilter === "back" && !back) continue;
      if (ui.hFilter === "wait" && (back || now - f.t >= 7 * DAY)) continue;
      if (ui.hFilter === "no" && (back || now - f.t < 7 * DAY)) continue;
      rows.push(f);
    }
    const sum = st.summary || {};
    $("#hSub").textContent = all.length ? `${U.fmt(sum.total)} followed by GrowX · ${U.fmt(sum.back)} followed back${sum.rate != null ? " · " + U.pct(sum.rate, 1) + " follow-back rate" + (sum.settled ? " (after 48h)" : "") : ""}` : "Everyone GrowX followed, and who followed you back.";
    $("#hStatus").textContent = all.length ? fbStatus(now) : "";
    const shown = rows.slice(0, ui.hShow);
    const html = shown.length ? shown.map((f, i) => {
      const [cls, ic, label] = result(f, now);
      return `<div class="trow h-cols" style="animation-delay:${Math.min(i, 14) * 18}ms">
        <div class="who">${U.avatarHtml(f.a, f.n || f.h, 32)}<div><b>${U.esc(f.n || "@" + f.h)}</b><a href="https://x.com/${encodeURIComponent(f.h)}" target="_blank" rel="noopener">@${U.esc(f.h)}</a></div></div>
        <span class="cell-muted">${f.s === "import" ? "imported" : f.s ? "@" + U.esc(f.s) : "-"}</span>
        <span class="score ${scoreCls(f.sc)}">${f.sc || "-"}</span>
        <span class="cell-muted" title="${new Date(f.t).toLocaleString()}">${U.dateTime(f.t)}</span>
        <span class="res ${cls}">${U.icon(ic)}${U.esc(label)}</span>
      </div>`;
    }).join("") : `<div class="empty">${U.icon("history")}<b>${all.length ? "No matches" : "No follows yet"}</b><span>${all.length ? "Try another filter." : "Start the autopilot - every follow and follow-back appears here."}</span></div>`;
    setHtml("h", $("#hRows"), html);
    $("#hMore").hidden = rows.length <= ui.hShow;
  }

  // =====================================================================
  // UNFOLLOWED YOU: the separate list of detected unfollowers
  //   Nobody here is unfollowed by itself. You tick accounts and they go to the
  //   front of the Unfollow mode queue - with the same re-check, the same Never
  //   unfollow list, the same daily number and the same breaks as every unfollow.
  // =====================================================================
  const LOST_SRC = { scan: "follower scan", check: "follow-back check", followback: "Follow back", unfollow: "Unfollow re-check" };

  async function getLost() { if (!cache.lost) cache.lost = await U.get(K.lost, null); return cache.lost || { list: [] }; }

  function wireLostPage() {
    $("#lostSearch").addEventListener("input", debounce(() => { ui.lostShow = 100; renderLost(); }, 150));
    $("#lostFilter").addEventListener("click", (e) => {
      const b = e.target.closest("[data-f]");
      if (!b) return;
      ui.lostFilter = b.dataset.f;
      ui.lostShow = 100;
      $$("#lostFilter button").forEach((x) => x.classList.toggle("on", x === b));
      renderLost();
    });
    $("#lostMoreBtn").addEventListener("click", () => { ui.lostShow += 200; renderLost(); });
    // One row ticked or unticked.
    $("#lostRows").addEventListener("change", async (e) => {
      const cb = e.target.closest("input[type=checkbox][data-i]");
      if (!cb) return;
      await lostPick([cb.dataset.i], cb.checked);
    });
    // The header tick box: every eligible account at once.
    $("#lostAll").addEventListener("change", async (e) => {
      const r = await U.cmd("lostSelect", { all: true, on: e.target.checked });
      if (!r.ok) return U.toast(r.error || "Couldn't save your pick.", "bad");
      cache.lost = null;
      U.toast(e.target.checked ? `${U.fmt(r.selected)} account${r.selected === 1 ? "" : "s"} picked for Unfollow mode.` : "Pick cleared.", "good");
      refresh();
    });
    $("#lostNone").addEventListener("click", async () => {
      const r = await U.cmd("lostSelect", { all: true, on: false });
      cache.lost = null;
      U.toast(r.ok ? "Pick cleared." : (r.error || "Couldn't clear."), r.ok ? "good" : "bad");
      refresh();
    });
    // "Unfollow these": the picks are already saved, so this explains what happens next and switches mode if needed.
    $("#lostQueue").addEventListener("click", async () => {
      const n = (st.lost || {}).sel || 0;
      if (!n) return U.toast("Tick at least one account first.", "bad");
      const mode = modeOf(st.settings);
      const ok = await confirmBox({
        title: `Unfollow ${U.fmt(n)} account${n === 1 ? "" : "s"}?`,
        body: `They go to the front of the Unfollow mode queue. Each one is looked up again right before unfollowing, your Never unfollow list is respected, and they count towards your daily unfollow number (${U.fmt(st.settings.unfollowDaily)}/day) with the usual delays and breaks.${mode === "unfollow" ? "" : " Unfollow mode is not the mode running now - GrowX will switch to it."}`,
        ok: mode === "unfollow" ? "Yes, unfollow them" : "Switch to Unfollow mode",
        icon: "userX"
      });
      if (!ok) return;
      if (mode !== "unfollow") await setMode("unfollow");
      else refresh();
      U.toast("Queued. Unfollow mode takes them first.", "good");
    });
    $("#lostForget").addEventListener("click", async () => {
      const ok = await confirmBox({
        title: "Clear the list?",
        body: "The whole list of detected unfollowers is thrown away. Nobody is followed or unfollowed by this - GrowX simply starts noticing unfollowers again from now on.",
        ok: "Clear it", icon: "trash"
      });
      if (!ok) return;
      const r = await U.cmd("lostForget", { all: true });
      cache.lost = null;
      U.toast(r.ok ? "List cleared." : (r.error || "Couldn't clear."), r.ok ? "good" : "bad");
      refresh();
    });
    $("#lostCheck").addEventListener("click", async () => {
      const r = await U.cmd("fbCheckNow");
      U.toast(r.ok ? "Checking who still follows you - unfollowers appear here." : (r.error || "Couldn't start."), r.ok ? "good" : "bad");
    });
    $("#lostExport").addEventListener("click", async () => {
      const l = await getLost();
      const rows = (l.list || []).map((x) => [x.h, x.n, x.i, x.fbAt ? new Date(x.fbAt).toISOString() : "", new Date(x.t).toISOString(), LOST_SRC[x.src] || x.src || "", x.uf ? "unfollowed" : x.sel ? "picked" : ""]);
      U.download(`growx-unfollowed-you-${new Date().toISOString().slice(0, 10)}.csv`, U.csv(["handle", "name", "id", "followed_you_at", "stopped_at", "found_by", "status"], rows));
    });
  }

  async function lostPick(ids, on) {
    const r = await U.cmd("lostSelect", { ids, on });
    if (!r.ok) return U.toast(r.error || "Couldn't save your pick.", "bad");
    cache.lost = null;
    refresh();
  }

  // Can this one still be unfollowed? You follow them, they are not on your keep list, GrowX has not done it already.
  function lostEligible(x, idx, keep) {
    if (!x || x.uf) return false;
    if (x.h && keep.has(String(x.h).toLowerCase())) return false;
    const f = idx.get(x.i);
    return !!(f && !f.nf);
  }

  async function renderLost() {
    const l = await getLost();
    const all = l.list || [];
    const now = Date.now();
    const follows = await getFollows();
    const acc = st.account;
    const idx = new Map();
    for (const f of follows) if (f.i && (!acc || !acc.id || !f.o || f.o === acc.id)) idx.set(f.i, f);
    const keep = new Set(GX.parseKeywords(st.settings.unfollowKeep).map((h) => String(h).replace(/^@+/, "")));
    const q = $("#lostSearch").value.trim().toLowerCase();
    const sum = st.lost || {};

    // KPI strip: today's count first, because that is the number people look for.
    setHtml("lostStats", $("#lostStats"), `
      <div class="card ul-stat"><small>Stopped following you today</small><b class="num">${U.fmt(sum.today)}</b><span>found by the checks GrowX already makes</span></div>
      <div class="card ul-stat"><small>On the list</small><b class="num">${U.fmt(sum.total)}</b><span>${U.fmt(sum.unfollowed)} of them already unfollowed</span></div>
      <div class="card ul-stat"><small>You can unfollow</small><b class="num">${U.fmt(sum.elig)}</b><span>you still follow them, not on your keep list</span></div>
      <div class="card ul-stat"><small>Picked for Unfollow mode</small><b class="num">${U.fmt(sum.sel)}</b><span>${sum.sel ? "Unfollow mode takes them first" : "tick the ones you want"}</span></div>`);

    const rows = [];
    for (const x of all) {
      if (q && !(`${x.h} ${x.n}`).toLowerCase().includes(q)) continue;
      const elig = lostEligible(x, idx, keep);
      if (ui.lostFilter === "elig" && !elig) continue;
      if (ui.lostFilter === "sel" && !x.sel) continue;
      if (ui.lostFilter === "done" && !x.uf) continue;
      rows.push([x, elig]);
    }
    const shown = rows.slice(0, ui.lostShow);
    const html = shown.length ? shown.map(([x, elig], i) => {
      const status = x.uf ? `<span class="res no">${U.icon("check")}Unfollowed ${U.ago(x.uf)}</span>`
        : !elig ? `<span class="res wait">${U.icon("info")}${x.h && keep.has(String(x.h).toLowerCase()) ? "On your Never unfollow list" : "You don't follow them"}</span>`
        : x.sel ? `<span class="res back" title="Unfollow mode takes the ones you picked first">${U.icon("check")}Picked</span>`
        : `<span class="res wait">${U.icon("clock")}Not picked</span>`;
      return `<div class="trow lost-cols" style="animation-delay:${Math.min(i, 14) * 18}ms">
        <label class="cb">${elig ? `<input type="checkbox" data-i="${U.esc(x.i)}"${x.sel ? " checked" : ""}>` : `<input type="checkbox" disabled>`}<i></i></label>
        <div class="who">${U.avatarHtml(x.a, x.n || x.h, 32)}<div><b>${U.esc(x.n || "@" + x.h)}</b><a href="https://x.com/${encodeURIComponent(x.h)}" target="_blank" rel="noopener">@${U.esc(x.h)}</a></div></div>
        <span class="cell-muted">${x.fbAt ? U.dateTime(x.fbAt) : "-"}</span>
        <span class="cell-muted" title="${new Date(x.t).toLocaleString()}">${U.ago(x.t)}</span>
        <span class="cell-muted">${U.esc(LOST_SRC[x.src] || "check")}</span>
        ${status}
      </div>`;
    }).join("") : `<div class="empty">${U.icon("userMinus")}<b>${all.length ? "No matches" : "Nobody has unfollowed you"}</b><span>${all.length ? "Try another filter." : "GrowX checks who still follows you as it works. Anyone who leaves appears here."}</span></div>`;
    setHtml("lostRows", $("#lostRows"), html);
    $("#lostMore").hidden = rows.length <= ui.lostShow;
    const bulk = $("#lostBulk");
    bulk.hidden = !sum.elig && !sum.sel;
    $("#lostSel").textContent = `${U.fmt(sum.sel)} picked`;
    $("#lostBulkNote").textContent = sum.sel
      ? `of ${U.fmt(sum.elig)} you can unfollow · they count towards your ${U.fmt(st.settings.unfollowDaily)}/day`
      : `${U.fmt(sum.elig)} can be unfollowed`;
    $("#lostQueue").disabled = !sum.sel;
    const allBox = $("#lostAll");
    if (allBox && document.activeElement !== allBox) allBox.checked = !!sum.elig && sum.sel >= sum.elig;
  }

  // =====================================================================
  // ANALYTICS
  // =====================================================================
  function wireAnalytics() {
    $("#plGoal").addEventListener("change", async () => {
      const v = Math.max(0, Math.round(Number($("#plGoal").value) || 0));
      const r = await U.cmd("saveSettings", { patch: { goalMonthly: v } });
      if (r.ok) { st.settings = r.settings; U.toast("Goal saved", "good"); renderAnalytics(); }
    });
  }

  async function renderAnalytics() {
    const s = st.settings, sum = st.summary || {};
    const follows = await getFollows();
    const growth = await getGrowth();
    const now = Date.now();
    const m = monthInfo();

    // planner
    if (document.activeElement !== $("#plGoal")) $("#plGoal").value = s.goalMonthly;
    const measured = sum.rate != null && sum.settled >= 30;
    const rate = measured ? sum.rate : 0.2;
    const goal = s.goalMonthly || 0;
    const gained = sum.gainedMonth || 0;
    const needPerDay = goal ? Math.max(0, goal - gained) / m.left / Math.max(0.01, rate) : 0;
    const steady = goal ? goal / 30 / Math.max(0.01, rate) : 0;
    const daily = st.limits.daily;
    const scale = Math.max(1000, needPerDay * 1.1);
    $("#plFill").style.width = Math.min(100, needPerDay / scale * 100) + "%";
    $("#plMark").style.left = Math.min(100, daily / scale * 100) + "%";
    $("#plSafe").textContent = `your cap: ${daily}/day`;
    $("#plMax").textContent = U.fmt(scale) + "/day";
    let txt;
    if (!goal) txt = "Set a monthly goal to get a plan.";
    else if (needPerDay <= daily) txt = `At a ${U.pct(rate, 1)} follow-back rate${measured ? "" : " (typical - yours is measured after ~30 settled follows)"}, you need about ${U.fmt(needPerDay)} follows a day for the rest of the month. Your current cap of ${daily}/day covers it - keep the autopilot running.`;
    else if (needPerDay <= 400) txt = `You need about ${U.fmt(needPerDay)} follows a day at a ${U.pct(rate, 1)} follow-back rate. Raise your daily cap (Turbo pace) - still under X's ~400/day limit.`;
    else if (needPerDay <= 1000) txt = `You need about ${U.fmt(needPerDay)} follows a day at a ${U.pct(rate, 1)} rate - more than a normal account may do. Options: X Premium (higher limits, Premium pace), or lift your follow-back rate with better sources and a higher minimum score. At ${U.pct(Math.min(0.6, goal / 30 / 380), 0)} follow-back, ~380/day reaches it.`;
    else txt = `${U.fmt(goal)} a month would need ${U.fmt(needPerDay)} follows a day at your rate. Focus on rate: tighter targeting and stronger sources matter more than speed.`;
    $("#plText").textContent = txt;
    setHtml("plFacts", $("#plFacts"), `
      <div><span>Follow-back rate</span><b class="num">${U.pct(rate, 1)}</b></div>
      <div><span>Follows/day needed</span><b class="num">${goal ? U.fmt(needPerDay) : "-"}</b></div>
      <div><span>Steady-state need</span><b class="num">${goal ? U.fmt(steady) + "/day" : "-"}</b></div>
      <div><span>Gained this month</span><b class="num">${sum.gainedMonth == null ? "-" : U.signed(sum.gainedMonth)}</b></div>`);

    // charts
    const key = follows.length + ":" + growth.length + ":" + (follows.length ? follows[follows.length - 1].fb : 0);
    if (ui.html.anKey !== key) {
      ui.html.anKey = key;
      $("#an90").innerHTML = U.areaChart(growth.slice(-90).map((d) => ({ x: d.d.slice(5).replace("-", "/"), y: d.f })), { h: 220, label: "Followers", empty: "Your follower chart appears after the first day of tracking." });
      const days = [];
      for (let i = 29; i >= 0; i--) { const d = new Date(now - i * DAY); days.push({ k: d.toDateString(), x: (d.getMonth() + 1) + "/" + d.getDate(), a: 0, b: 0 }); }
      const idx = new Map(days.map((d) => [d.k, d]));
      for (const f of follows) {
        const a = idx.get(new Date(f.t).toDateString()); if (a) a.a++;
        if (f.fb && !f.fy0) { const b = idx.get(new Date(f.fb).toDateString()); if (b) b.b++; }
      }
      $("#anDaily").innerHTML = follows.length ? U.barChart(days, { h: 220, aLabel: "follows", bLabel: "follow-backs" }) : '<div class="chart-empty">Daily numbers appear once GrowX starts following.</div>';

      // score bands
      const bands = {};
      const hours = Array.from({ length: 24 }, (_, h) => ({ x: String(h), n: 0, b: 0 }));
      for (const f of follows) {
        if (f.fy0 || now - f.t < 48 * HOUR || !f.sc) continue;
        const k = GX.scoreBand(f.sc);
        bands[k] = bands[k] || { n: 0, b: 0 };
        bands[k].n++; if (f.fb) bands[k].b++;
        const hr = hours[new Date(f.t).getHours()];
        hr.n++; if (f.fb) hr.b++;
      }
      const order = ["80+", "70-79", "60-69", "50-59", "<50"];
      $("#anBands").innerHTML = Object.keys(bands).length ? order.filter((k) => bands[k]).map((k) => {
        const r = bands[k].b / bands[k].n;
        return `<div class="band"><span>score ${k}</span><div class="bar ${r >= 0.25 ? "green" : ""}"><i style="width:${Math.min(100, r * 200)}%"></i></div><b class="num" title="${bands[k].b} of ${bands[k].n}">${U.pct(r, 0)}</b></div>`;
      }).join("") + `<p class="hint">Higher scores should follow back more. If they don't, adjust your keywords and sources.</p>` : '<div class="chart-empty">Shows up 48 hours after your first follows.</div>';
      const hasHours = hours.some((h) => h.n >= 3);
      $("#anHours").innerHTML = hasHours ? U.barChart(hours.map((h) => ({ x: h.x, a: h.n >= 3 ? Math.round(h.b / h.n * 100) : 0 })), { h: 220, single: true, aLabel: "follow-back %" }) : '<div class="chart-empty">Shows up after a few days of follows.</div>';
    }

    // leaderboard
    const src = (st.sources || []).slice().sort((a, b) => {
      const ra = a.followed >= 10 ? (a.back || 0) / a.followed : -1, rb = b.followed >= 10 ? (b.back || 0) / b.followed : -1;
      return rb - ra || (b.followed || 0) - (a.followed || 0);
    });
    const lb = src.length ? src.map((x) => {
      const r = x.followed >= 10 ? (x.back || 0) / x.followed : null;
      const verdict = r == null ? ["gray", "Learning"] : r >= 0.25 ? ["green", "Top performer"] : r >= 0.12 ? ["amber", "Average"] : x.followed >= 40 ? ["red", "Consider removing"] : ["gray", "Learning"];
      return `<div class="trow l-cols">
        <div class="who">${U.avatarHtml(x.a, x.n || x.h, 32)}<div><b>${U.esc(x.n || "@" + x.h)}</b><a href="https://x.com/${encodeURIComponent(x.h)}" target="_blank" rel="noopener">@${U.esc(x.h)}</a></div></div>
        <span class="num">${U.fmt(x.followed || 0)}</span>
        <span class="num">${U.fmt(x.back || 0)}</span>
        <div class="ratebar"><b class="num">${r == null ? "-" : U.pct(r, 0)}</b><div class="bar thin ${r != null && r >= 0.25 ? "green" : ""}"><i style="width:${r == null ? 0 : Math.min(100, r * 250)}%"></i></div></div>
        <span><span class="chip ${verdict[0]} verdict">${verdict[1]}</span></span>
      </div>`;
    }).join("") : `<div class="empty">${U.icon("award")}<b>No sources yet</b><span>Add sources to see which audiences follow you back.</span></div>`;
    setHtml("lb", $("#lbRows"), lb);
  }

  // =====================================================================
  // SETTINGS
  // =====================================================================
  function wireSettings() {
    $("#blSave").addEventListener("click", async () => {
      const { handles } = U.handlesFrom($("#blText").value);
      const r = await U.cmd("blacklist", { handles });
      if (r.ok) { U.toast(`Never-follow list saved (${r.count})`, "good"); $("#blCount").textContent = `${r.count} accounts`; }
    });
    $("#bkExport").addEventListener("click", async () => {
      const CK = GX.CK;
      const d = await chrome.storage.local.get([K.settings, K.sources, K.blacklist, K.follows, CK.days, CK.replied, CK.hist, CK.watch, CK.target]);
      const out = { app: "GrowX", version: chrome.runtime.getManifest().version, at: new Date().toISOString(), settings: d[K.settings] || {}, sources: (d[K.sources] || []).map((x) => ({ h: x.h, enabled: x.enabled, addedAt: x.addedAt, followed: x.followed, back: x.back })), blacklist: d[K.blacklist] || [], follows: d[K.follows] || [] };
      // Comment mode travels with the backup too - the day totals, the post ids that
      // make "one post, one reply" work, the history, the watch list and the targets.
      // (The OpenAI key and the Telegram token never leave this browser.)
      out.comment = { v: 1, days: d[CK.days] || {}, replied: d[CK.replied] || [], hist: d[CK.hist] || [], watch: d[CK.watch] || [], targets: d[CK.target] || [] };
      U.download(`growx-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(out), "application/json");
    });
    $("#bkImport").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        const r = await U.cmd("importBackup", { data });
        U.toast(r.ok ? "Backup imported" : (r.error || "Import failed"), r.ok ? "good" : "bad");
        cache.follows = null; cache.blacklist = null;
        refresh();
      } catch (_) { U.toast("That file isn't valid JSON.", "bad"); }
      e.target.value = "";
    });
    $("#hcRun").addEventListener("click", async () => {
      const out = $("#hcOut");
      out.hidden = false;
      out.textContent = "Checking your X session...";
      const r = await U.cmd("health");
      out.textContent = r.ok ? healthText(r.health) : (r.error || "Failed.");
    });
    $$("[data-reset]").forEach((b) => b.addEventListener("click", async () => {
      const what = b.dataset.reset;
      const label = { queue: "Clear the queue?", history: "Clear history and stats?", all: "Reset everything?" }[what];
      const body = { queue: "Removes everyone waiting and forgets who was already checked.", history: "Removes your follow history, follow-back tracking, growth chart and events. Sources and settings stay.", all: "Removes every setting, source, queue entry and statistic. This can't be undone." }[what];
      if (!await confirmBox({ title: label, body, ok: "Reset", icon: "trash" })) return;
      const r = await U.cmd("reset", { what });
      U.toast(r.ok ? "Done" : (r.error || "Failed"), r.ok ? "good" : "bad");
      cache.pool = cache.follows = cache.growth = null;
      ui.html = {};
      refresh();
    }));
  }

  function healthText(h) {
    if (!h) return "";
    const lines = [
      `Checked: ${new Date(h.at).toLocaleString()}`,
      `Signed in: ${h.signedIn ? "yes" : "no"}   CSRF token: ${h.csrf ? "yes" : "no"}`,
      `Transaction id: ${h.txid || "-"}`,
      `X operations: ${h.ops || "-"}`,
      `Follower read: ${h.read || "-"}`,
      `Follow-back check: ${h.rel || "-"}`,
      `Follower id scan: ${h.ids || "-"}`
    ];
    if (h.note) lines.push(h.note);
    if (h.ok === false && h.message) lines.push("Error: " + h.message);
    return lines.join("\n");
  }

  async function renderSettings() {
    if (!ui.html.bl) {
      ui.html.bl = "1";
      const bl = await U.get(K.blacklist, []);
      $("#blText").value = bl.map((h) => "@" + h).join(" ");
      $("#blCount").textContent = bl.length ? `${bl.length} accounts` : "";
    }
    if (st.health && $("#hcOut").hidden) { $("#hcOut").hidden = false; $("#hcOut").textContent = healthText(st.health); }
  }

  // =====================================================================
  // DONATE + WELCOME
  // =====================================================================
  function wireDonate() {
    $$(".w-copy").forEach((b) => b.addEventListener("click", async () => {
      const addr = b.closest(".wallet").querySelector(".addr").textContent.trim();
      const ok = await U.copy(addr);
      const span = b.querySelector("span");
      span.textContent = ok ? "Copied!" : "Copy failed";
      b.classList.toggle("done", ok);
      setTimeout(() => { span.textContent = "Copy address"; b.classList.remove("done"); }, 1800);
    }));
    $("#shareBtn").addEventListener("click", async () => {
      const ok = await U.copy("GrowX - Unlimited Auto Follow for X/Twitter. Free tool by Unique Labs that grows real followers on autopilot. Find it in the Chrome Web Store: \"GrowX Unlimited Auto Follow\".");
      U.toast(ok ? "Copied - paste it anywhere" : "Couldn't copy", ok ? "good" : "bad");
    });
    for (const id of ["donateJump", "helpJump"]) {
      $("#" + id).addEventListener("click", (e) => {
        e.preventDefault();
        const el = document.getElementById(id === "donateJump" ? "wallets" : "helpfree");
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  }

  function showWelcome() { $("#welcome").hidden = false; setTimeout(() => $("#wInput").focus(), 100); }

  function wireWelcome() {
    $("#wLater").addEventListener("click", () => { $("#welcome").hidden = true; });
    $("#wForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const { handles } = U.handlesFrom($("#wInput").value);
      if (!handles.length) return U.toast("Type one or more usernames", "bad");
      const r = await U.cmd("addSources", { handles });
      $("#wInput").value = "";
      U.toast(`Added ${r.added || 0} source${r.added === 1 ? "" : "s"}`, "good");
      refresh();
    });
    $("#wStart").addEventListener("click", async () => {
      if ($("#wInput").value.trim()) { $("#wForm").requestSubmit(); await new Promise((r) => setTimeout(r, 300)); }
      const r = await U.cmd("start");
      if (!r.ok) { U.toast(r.error || "Couldn't start.", "bad", 4500); return; }
      $("#welcome").hidden = true;
      U.toast("Autopilot started. It keeps running in the background.", "good", 4500);
      refresh();
    });
  }

  init();
})();
