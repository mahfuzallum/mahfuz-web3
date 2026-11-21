// GrowX - popup: a compact, live control center for the autopilot.
(function () {
  "use strict";
  const { $, $$ } = U;
  let st = null;
  let ring = null;
  let phase = { key: "", start: Date.now() };
  let busy = false;

  function init() {
    U.icons();
    U.themeButtons();
    $("#ringWrap").insertAdjacentHTML("afterbegin", U.ring(0, 100, 8, "white"));
    ring = $("#ringWrap svg");
    $("#ver").textContent = "v" + chrome.runtime.getManifest().version;
    $("#openDash").addEventListener("click", () => openDash());
    $("#dash").addEventListener("click", () => openDash());
    $("#openCmt").addEventListener("click", () => openDash("comment"));
    $("#donate").addEventListener("click", (e) => { e.preventDefault(); openDash("donate"); });
    $("#signIn").addEventListener("click", () => closeAfter(U.cmd("openX")));
    $("#srcForm").addEventListener("submit", addSource);
    $("#ctl").addEventListener("click", onControl);
    $("#popModes").addEventListener("click", onMode);
    refresh().then(() => { if (st && !st.account) U.cmd("refreshAccount").then(refresh); });
    setInterval(refresh, 1500);
    setInterval(tickLocal, 250);
    U.watch([GX.K.job, GX.K.task, GX.K.account, GX.K.pool, GX.K.sources], debounce(refresh, 150));
  }

  // Close only once the engine has the request (closing first can drop it).
  function closeAfter(p) { Promise.resolve(p).catch(() => {}).finally(() => window.close()); }
  function openDash(hash) { closeAfter(U.cmd("dashboard", { hash: hash || "" })); }
  function debounce(fn, ms) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }

  async function refresh() {
    const r = await U.cmd("state");
    if (r && r.ok) { st = r; render(); }
  }

  async function addSource(e) {
    e.preventDefault();
    const { handles } = U.handlesFrom($("#srcInput").value);
    if (!handles.length) { U.toast("Type a username like @creator", "bad"); return; }
    const r = await U.cmd("addSources", { handles });
    if (r.ok) {
      $("#srcInput").value = "";
      U.toast(r.added ? `Added ${handles.length > 1 ? r.added + " sources" : "@" + handles[0]}` : "Already in your sources", r.added ? "good" : "");
      refresh();
    } else U.toast(r.error || "Couldn't add that.", "bad");
  }

  async function onControl(e) {
    const b = e.target.closest("[data-act]");
    if (!b || busy) return;
    busy = true;
    b.disabled = true;
    const act = b.dataset.act;
    let r;
    if (act === "start") { b.querySelector("span").textContent = "Starting..."; r = await U.cmd("start"); }
    else if (act === "harvest") r = await U.cmd("harvestNow");
    else if (act === "taskStop") r = await U.cmd("taskStop");
    else r = await U.cmd(act);
    busy = false;
    if (!r || !r.ok) {
      U.toast((r && r.error) || "Something went wrong.", "bad", 4200);
      if (r && r.needSources) $("#srcInput").focus();
    } else if (act === "start") U.toast("Autopilot is on. You can close this popup.", "good");
    else if (act === "harvest") U.toast(r.viaJob ? "Looking for more people now." : "Finding people likely to follow back...", "good");
    refresh();
  }

  const MODE_NAME = { follow: "Follow", unfollow: "Unfollow", followback: "Follow back", comment: "Comment" };
  const modeOf = (s) => (s && GX.MODES.includes(s.runMode) ? s.runMode : "follow");
  const jobMode = (job) => (job ? (GX.MODES.includes(job.runMode) ? job.runMode : GX.MODES.includes(job.mode) ? job.mode : "follow") : "follow");

  // One click on a mode: saved and applied right away.
  async function onMode(e) {
    const b = e.target.closest("[data-pmode]");
    if (!b || busy || !st) return;
    const mode = b.dataset.pmode;
    if (mode === st.settings.runMode) return;
    busy = true;
    $$("#popModes button").forEach((x) => { x.disabled = true; });
    const r = await U.cmd("saveSettings", { patch: { runMode: mode } });
    busy = false;
    $$("#popModes button").forEach((x) => { x.disabled = false; });
    if (!r || !r.ok) { U.toast((r && r.error) || "Couldn't switch the mode.", "bad", 4200); return; }
    st.settings = r.settings;
    U.toast(r.started ? `${MODE_NAME[mode]} mode is on - it started now.` : `Switched to ${MODE_NAME[mode]} mode.`, "good");
    render();
    refresh();
  }

  function btn(act, cls, icon, label) {
    return `<button class="btn ${cls}" data-act="${act}">${U.icon(icon)}<span>${label}</span></button>`;
  }

  // The pause panel: when GrowX comes back, in minutes or at a time of day.
  const PAUSE_MINS = [[15, "15m"], [30, "30m"], [60, "1h"], [120, "2h"]];
  function pausePanel() {
    const j = st.job;
    if (!j || j.status !== "paused") return "";
    const at = Number(j.resumeAt) || 0, now = Date.now();
    const live = at > now;
    const t = new Date(live ? at : now + 30 * 60000);
    const hhmm = String(t.getHours()).padStart(2, "0") + ":" + String(t.getMinutes()).padStart(2, "0");
    return `<div class="pause-panel big">
      <div class="pp-head">Start again</div>
      <div class="pp-chips">${PAUSE_MINS.map(([m, l]) => `<button type="button" data-pmins="${m}">${l}</button>`).join("")}<button type="button" data-ptom>Tomorrow 9 AM</button></div>
      <label class="pp-opt"><span>At</span><input class="input pp-time" type="time" value="${hhmm}" data-pat></label>
      <div class="pp-live">${live ? `<span>Back at <b>${U.clock(at)}</b> ·</span><b class="pt-left" data-until="${at}">${U.countdown(at - now)}</b><button class="btn btn-ghost" type="button" data-pmins="0">Clear</button>` : "<span>No timer - it waits for you.</span>"}</div>
    </div>`;
  }
  async function setPause(mins) {
    const r = await U.cmd("resumeAt", { mins });
    if (!r || !r.ok) return U.toast((r && r.error) || "Couldn't set the timer.", "bad");
    U.toast(r.resumeAt ? `GrowX starts again at ${U.clock(r.resumeAt)}.` : "Timer cleared.", "good");
    refresh();
  }
  document.addEventListener("click", (e) => {
    const m = e.target.closest && e.target.closest("[data-pmins]");
    if (m) return setPause(Number(m.dataset.pmins));
    if (e.target.closest && e.target.closest("[data-ptom]")) {
      const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
      return setPause(Math.round((d.getTime() - Date.now()) / 60000));
    }
  });
  document.addEventListener("change", (e) => {
    if (!e.target.matches || !e.target.matches("[data-pat]")) return;
    const [h, mi] = String(e.target.value || "").split(":").map(Number);
    if (!Number.isFinite(h)) return;
    const d = new Date(); d.setHours(h, mi || 0, 0, 0);
    if (d.getTime() <= Date.now() + 30000) d.setDate(d.getDate() + 1);
    setPause(Math.max(1, Math.round((d.getTime() - Date.now()) / 60000)));
  });

  function render() {
    const s = st.settings, job = st.job, task = st.task, acc = st.account, sum = st.summary || {};
    const v = U.jobView(job, task);
    const signedIn = !!(acc && acc.id);
    const hasSources = (st.sources || []).some((x) => x.enabled && !["gone", "private"].includes(x.status));
    const mode = modeOf(s), pUnf = mode === "unfollow", pBk = mode === "followback", pCmt = mode === "comment";
    const bk = st.bk || {}, unf = st.unf || {}, cmt = st.cmt || {};
    const popEl = document.querySelector(".pop");
    popEl.classList.toggle("th-unf", pUnf);
    popEl.classList.toggle("th-bk", pBk);
    popEl.classList.toggle("th-cmt", pCmt);
    const oc = $("#openCmt");
    if (oc) oc.hidden = !pCmt;
    $$("#popModes button").forEach((x) => x.classList.toggle("on", x.dataset.pmode === mode));

    // account
    const av = $("#acAvatar");
    av.replaceWith(Object.assign(U.avatar(acc && acc.avatar, acc && (acc.name || acc.handle), 34), { id: "acAvatar" }));
    $("#acName").textContent = signedIn ? (acc.name || "@" + acc.handle) : acc && acc.signedOut ? "Signed out of X" : "Not connected yet";
    $("#acHandle").textContent = signedIn ? "@" + (acc.handle || "") : acc && acc.signedOut ? "Sign in at x.com" : "Open x.com in this browser";
    U.countTo($("#acFollowers"), signedIn ? acc.followers : null, U.compact);
    const d = $("#acDelta");
    if (sum.gainedToday) { d.textContent = U.signed(sum.gainedToday) + " today"; d.className = sum.gainedToday > 0 ? "up" : ""; }
    else { d.textContent = "followers"; d.className = ""; }

    // pill + mode
    $("#pill").className = "pill " + v.cls;
    $("#pillText").textContent = v.label;
    const thr = job && job.throttle && job.throttle.until > Date.now() && (s.autoSlowdown || job.throttle.dailyCap);
    $("#mode").textContent = pCmt ? (s.cmtPace === "custom" ? "Custom pace" : (GX.CMT_PRESET_INFO[s.cmtPace] || {}).name + " pace")
      : thr && !pUnf ? "Safety slow-down"
      : pUnf ? (s.unfPace === "custom" ? "Custom pace" : (GX.UNF_PRESET_INFO[s.unfPace] || {}).name + " pace")
      : pBk ? (s.bkPace === "custom" ? "Custom pace" : (GX.BK_PRESET_INFO[s.bkPace] || {}).name + " pace")
      : (s.speed === "custom" ? "Custom pace" : (GX.PRESET_INFO[s.speed] || {}).name + " pace");

    // ring + meters
    const L = st.limits;
    const bkToday = bk.today || 0, bkRoom = Math.max(0, L.daily - st.today);       // X's follow limit is shared with Follow mode
    const pDone = pCmt ? (cmt.today || 0) : pUnf ? (unf.today || 0) : pBk ? bkToday : st.today;
    const pMax = pCmt ? (cmt.goal || s.cmtDaily) : pUnf ? s.unfollowDaily : pBk ? Math.min(s.bkDaily, bkToday + bkRoom) : L.daily;
    U.countTo($("#today"), pDone);
    $("#todayOf").textContent = pCmt ? `of ${pMax} replies today` : pUnf ? `of ${pMax} unfollows today` : pBk ? `of ${pMax} follow-backs` : `of ${L.daily} today`;
    U.setRing(ring, pMax ? pDone / pMax : 0);
    // per hour: worked out (Auto) or your own number - the same one the engine uses
    const pHour = pCmt ? (cmt.hour || 0) : pUnf ? (unf.hour || 0) : pBk ? (bk.hour || 0) : st.hour;
    const pHourMax = pCmt ? (cmt.hourCap || s.cmtHourlyLimit) : pUnf ? GX.hourlyCap(s, "unfollow").cap : pBk ? (s.hourlyAuto ? L.hourly : s.bkHourlyLimit) : L.hourly;
    $("#hourTxt").textContent = `${pHour}/${pHourMax}`;
    $("#hourBar").style.width = Math.min(100, (pHour / Math.max(1, pHourMax)) * 100) + "%";
    const q2 = $("#queueTxt").previousElementSibling;
    if (pCmt) {
      q2.textContent = "Drafts ready";
      $("#queueTxt").textContent = U.fmt(cmt.ready || 0);
      $("#queueBar").style.width = Math.min(100, ((cmt.ready || 0) / Math.max(1, s.cmtReady)) * 100) + "%";
    } else if (pUnf) {
      q2.textContent = unf.stage === "done" ? "Due now" : "Old list left";
      $("#queueTxt").textContent = unf.stage === "done" ? U.fmt(unf.due || 0) : unf.stage === "ready" ? U.fmt(unf.left) : "...";
      $("#queueBar").style.width = unf.stage === "ready" && unf.total ? Math.min(100, (unf.total - unf.left) / unf.total * 100) + "%" : unf.stage === "done" ? "100%" : "0%";
    } else if (pBk) {
      q2.textContent = "Waiting for you";
      $("#queueTxt").textContent = bk.stage === "ready" ? U.fmt(bk.left) : bk.stage === "done" ? "0" : "...";
      $("#queueBar").style.width = bk.stage === "ready" && bk.total ? Math.min(100, (bk.total - bk.left) / bk.total * 100) + "%" : bk.stage === "done" ? "100%" : "0%";
    } else {
      q2.textContent = "Queue";
      $("#queueTxt").textContent = U.fmt(st.poolCount);
      $("#queueBar").style.width = Math.min(100, (st.poolCount / Math.max(1, s.poolTarget)) * 100) + "%";
    }

    // target
    const cur = job && v.active && jobMode(job) === mode && job.current;
    $("#target").hidden = !cur;
    if (cur) {
      $("#tgAvatar").replaceWith(Object.assign(U.avatar(cur.a, cur.h, 26), { id: "tgAvatar" }));
      $("#tgHandle").textContent = "@" + cur.h;
      $("#tgMeta").textContent = job.mode === "comment"
        ? "writing a reply" + (cur.src ? " · from " + ({ links: "your links", watch: "the watch list", target: "a target account", back: "a reply on your post" }[cur.src] || cur.src) : "")
        : job.mode === "unfollow"
        ? (cur.tg === "fb" ? (cur.act ? "follower · active" : "follower · inactive") : "non-follower") + (cur.rk ? ` · #${cur.rk} ${s.unfOrder === "new" ? "newest" : "oldest"} first` : "")
        : job.mode === "followback"
        ? "follows you" + (cur.rk ? ` · follower #${cur.rk}` : "")
        : (cur.score ? "score " + cur.score : "imported") + (cur.src && cur.src !== "import" ? " · via @" + cur.src : "");
    }

    // message
    let msg = "Grow your X audience on autopilot.";
    if (job && ["running", "resting", "sleeping", "paused", "halted"].includes(job.status)) msg = job.message || msg;
    else if (task && task.status === "running") msg = task.message;
    else if (acc && acc.signedOut) msg = "Sign in to X in this browser to begin.";
    else if (!signedIn) msg = pUnf || pBk ? "Open x.com in this browser, then press Start." : "Open x.com in this browser, add a source profile, then press Start.";
    else if (pCmt) msg = !cmt.hasKey ? "Comment mode needs your OpenAI key - open the dashboard to add it."
      : job && job.message && job.status === "done" && jobMode(job) === mode ? job.message
      : `Comment mode is selected${cmt.ready ? " · " + U.fmt(cmt.ready) + " drafts ready" : cmt.open ? " · " + U.fmt(cmt.open) + " posts waiting" : ""}. Press Start - or it starts by itself in its hours.`;
    else if (pUnf) msg = job && job.message && job.status === "done" && jobMode(job) === mode ? job.message : "Unfollow mode is selected. Press Start - or it starts by itself in its hours.";
    else if (pBk) msg = job && job.message && job.status === "done" && jobMode(job) === mode ? job.message : `Follow back mode is selected${bk.stage === "ready" ? " · " + U.fmt(bk.left) + " followers waiting" : ""}. Press Start - or it starts by itself in its hours.`;
    else if (!hasSources && !st.poolCount) msg = "Add a source profile and GrowX finds its newest followers who are likely to follow back.";
    else if (job && job.message && jobMode(job) === "follow") msg = job.message;
    else msg = `${U.fmt(st.poolCount)} people ready in your queue. Press Start - you can close this popup.`;
    $("#msg").textContent = msg;

    // controls
    let html = "";
    if (v.active) html = btn("pause", "btn-white", "pause", "Pause") + btn("stop", "btn-glass", "stop", "Stop");
    else if (v.paused || v.halted) html = btn("resume", "btn-white", "play", "Resume") + btn("stop", "btn-glass", "stop", "Stop");
    else if (v.task) html = btn("start", "btn-white", "play", "Start autopilot") + btn("taskStop", "btn-glass", "stop", "Stop search");
    else html = btn("start", "btn-white", "rocket", "Start autopilot") + (hasSources && !pUnf && !pBk && !pCmt ? btn("harvest", "btn-glass", "search", "Find people") : "");
    // While paused, the popup shows the same pause panel as the dashboard.
    if (v.paused) html += pausePanel();
    const ctl = $("#ctl");
    if (ctl.dataset.html !== html) { ctl.innerHTML = html; ctl.dataset.html = html; }

    // setup card
    const needSignIn = !signedIn && !v.active && !(acc && acc.id === undefined && st.poolCount);
    const needSources = !hasSources && !st.poolCount && !pUnf && !pBk && !pCmt;
    $("#setup").hidden = !(needSources || (needSignIn && acc && acc.signedOut));
    $("#tiles").hidden = !$("#setup").hidden && !(sum.total > 0);
    document.querySelector(".pop").classList.toggle("first", !$("#setup").hidden);
    $("#signIn").hidden = !(acc && acc.signedOut);
    $("#srcForm").hidden = !needSources;
    $("#setupTitle").textContent = acc && acc.signedOut ? "Sign in to X" : "Add a source profile";
    $("#setupSub").textContent = acc && acc.signedOut ? "GrowX works through your own signed-in x.com session." : "GrowX follows the newest, most active followers of profiles in your niche.";

    // tiles
    if (pUnf) {
      $("#tRateL").textContent = unf.stage === "done" ? "Due now" : "Old left";
      $("#tRate").textContent = unf.stage === "done" ? U.compact(unf.due || 0) : unf.stage === "ready" ? U.compact(unf.left) : "-";
      $("#tRateSub").textContent = unf.stage === "done" ? "no follow-back" : "non-followers";
      $("#tTotalL").textContent = "Unfollowed";
      $("#tTotalSub").textContent = "by GrowX";
    } else if (pBk) {
      $("#tRateL").textContent = "Waiting";
      $("#tRate").textContent = bk.stage === "ready" ? U.compact(bk.left) : bk.stage === "done" ? "0" : "-";
      $("#tRateSub").textContent = "follow you, not followed";
      $("#tTotalL").textContent = "All time";
      $("#tTotalSub").textContent = bk.skipped ? `${U.compact(bk.skipped)} skipped` : "by GrowX";
    } else {
      $("#tRateL").textContent = "FB rate";
      $("#tRate").textContent = sum.rate == null ? "-" : U.pct(sum.rate);
      $("#tRateSub").textContent = sum.total ? `${U.compact(sum.back)} followed back` : "after each follow";
      $("#tTotalL").textContent = "Followed";
      $("#tTotalSub").textContent = "by GrowX";
    }
    const goal = s.goalMonthly || 0;
    $("#tMonth").textContent = sum.gainedMonth == null ? "-" : U.signed(sum.gainedMonth);
    $("#tMonthBar").style.width = goal && sum.gainedMonth ? Math.min(100, Math.max(0, sum.gainedMonth / goal * 100)) + "%" : "0%";
    U.countTo($("#tTotal"), pUnf ? (unf.all != null ? unf.all : (unf.removed || 0) + ((unf.inact && unf.inact.removed) || 0)) : pBk ? (bk.all || 0) : (st.stats && st.stats.followed) || sum.total || 0, U.compact);
    tickLocal();
  }

  function tickLocal() {
    if (!st) return;
    const job = st.job, now = Date.now();
    const v = U.jobView(job, st.task);
    let label = "Autopilot is off", time = "--", frac = 0, live = false;
    if (job && job.status === "running") {
      const lastAct = job.mode === "unfollow" ? job.lastUnfollow : job.mode === "followback" ? job.lastFollowBack : job.mode === "comment" ? job.lastReply : job.lastFollow;
      const start = Math.max((lastAct && lastAct.at) || job.startedAt, (job.nextAt || now) - 30 * 60000);
      const left = (job.nextAt || now) - now;
      label = job.mode === "unfollow" ? "Next unfollow in" : job.mode === "followback" ? "Next follow-back in" : job.mode === "comment" ? "Next reply in" : "Next follow in";
      time = left > 800 ? U.countdown(left) : "now";
      frac = job.nextAt > start ? (now - start) / (job.nextAt - start) : 1;
      live = true;
    } else if (job && (job.status === "resting" || job.status === "sleeping") && job.restUntil) {
      const key = job.status + job.restUntil;
      if (phase.key !== key) phase = { key, start: now };
      label = (job.status === "sleeping" ? "Sleeping · back " : "Break · back ") + U.clock(job.restUntil);
      time = U.countdown(job.restUntil - now);
      frac = job.restUntil > phase.start ? (now - phase.start) / (job.restUntil - phase.start) : 0;
    } else if (v.paused) {
      label = "Paused";
      const at = job && job.resumeAt;
      if (at > now) { label = "Starts again " + U.clock(at); time = U.countdown(at - now); }
      // the countdown inside the pause panel
      $$(".pt-left[data-until]").forEach((el) => { const t = Number(el.dataset.until) - now; el.textContent = t > 0 ? U.countdown(t) : "now"; });
    }
    else if (v.halted) { label = "Stopped for safety"; }
    else if (v.task) { label = "Searching sources"; time = "..."; live = true; frac = 1; }
    $("#nextLabel").textContent = label;
    $("#nextTime").textContent = time;
    $("#nextBar").classList.toggle("is-live", live);
    $("#nextBar").firstElementChild.style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + "%";
  }

  init();
})();
