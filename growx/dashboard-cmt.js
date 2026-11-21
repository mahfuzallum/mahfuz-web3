// GrowX - dashboard-cmt.js
//
// Everything Comment mode adds to the dashboard:
//   * the Comment page (hero, today's numbers, the four sources, the one queue)
//   * the Comment settings C1 - C8 on the Autopilot page
//   * the Comment history page with its day-by-day totals and backup
//   * the four mode cards on the Overview
//
// dashboard.js owns the shell (routing, the run controls, the state it already
// loads); this file hangs on it through window.GXC and never reaches into it.

(function () {
  "use strict";
  const { $, $$, esc, fmt } = U;
  const HOUR = 3600000, DAY = 86400000;
  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  let st = null;          // the shared dashboard state (uiState)
  let cs = null;          // the Comment state (cmt/state)
  let busy = false;
  const ui = { tab: "links", filter: "all", src: "", show: 60, range: 14, built: false, rows: [], total: 0, html: {} };

  const cmd = (op, extra) => U.cmd("cmt", Object.assign({ op }, extra || {}));
  const setHtml = (key, el, html) => { if (el && ui.html[key] !== html) { el.innerHTML = html; ui.html[key] = html; U.icons(el); } };
  // Money, written so a fraction of a cent is still readable: $0.50, $0.0041.
  const money = (v) => { const n = Number(v) || 0; return "$" + (n === 0 ? "0.00" : n >= 0.01 ? n.toFixed(2) : n.toFixed(4)); };
  const taka = (v, rate) => { const n = (Number(v) || 0) * (rate || 122); return "৳" + (n === 0 ? "0" : n >= 10 ? Math.round(n).toLocaleString() : n.toFixed(2)); };
  const both = (v, rate) => `${money(v)} <em>≈ ${taka(v, rate)}</em>`;
  const sOf = () => (st && st.settings) || GX.normalizeSettings({});

  // =====================================================================
  // boot + the hooks dashboard.js calls
  // =====================================================================
  let wired = false;
  function init() {
    if (wired) return;              // dashboard.js may also call this; once is enough
    wired = true;
    document.addEventListener("click", onClick);
    document.addEventListener("change", onChange);
    document.addEventListener("input", onInput);
    $("#cmtText") && $("#cmtText").addEventListener("input", debounce(previewPaste, 350));
    $("#cmtGoText") && $("#cmtGoText").addEventListener("input", debounce(() => renderGo(true), 400));
    document.addEventListener("input", (e) => { if (e.target && e.target.id === "ovcText") ovcDebounced(); });
  }
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const ovcDebounced = debounce(() => ovcPreview(), 350);

  // Called on every refresh, whatever page is open.
  function common(state) {
    st = state;
    const c = st.cmt || {};
    document.body.classList.toggle("m-cmt", st.settings.runMode === "comment");
    const n = $("#navCmt");
    if (n) {
      const show = c.ready || c.open || 0;
      n.hidden = !show;
      n.textContent = U.compact(show);
      n.className = c.ready ? "on" : "";
    }
  }

  // Called after dashboard.js renders a page.
  function render(route, state) {
    st = state;
    if (route === "overview") { renderModeCards(); renderOvCmt(); }
    else if (route === "autopilot") renderSettings();
    else if (route === "comment") renderComment();
    else if (route === "cmthistory") renderHistory();
  }

  async function load(force) {
    if (busy && !force) return cs;
    busy = true;
    try { const r = await cmd("state"); if (r && r.ok) cs = r; } catch (_) {}
    busy = false;
    return cs;
  }

  // =====================================================================
  // Overview: one card per mode
  // =====================================================================
  const MODE_META = {
    follow: { name: "Follow", icon: "users", cls: "th-fl", word: "follows", page: "#autopilot" },
    followback: { name: "Follow back", icon: "userPlus", cls: "th-bk", word: "follow-backs", page: "#followedback" },
    unfollow: { name: "Unfollow", icon: "userX", cls: "th-unf", word: "unfollows", page: "#unfollowed" },
    comment: { name: "Comment", icon: "chat", cls: "th-cmt", word: "replies", page: "#comment" }
  };
  const STATUS_WORD = { running: "Running", done: "Goal reached", reached: "Goal reached", blocked: "X limited it today", waiting: "Waiting" };

  // Each mode's own facts, so a card says something real rather than a number.
  function modeFacts(m, d, s) {
    const c = st.cmt || {};
    if (m === "comment") {
      return `<span>Drafts ready <b class="v">${fmt(c.ready || 0)}</b></span><span>Skipped <b class="a">${fmt(c.skipped || 0)}</b></span><span>AI today <b>${money(c.cost || 0)}</b></span>`;
    }
    if (m === "follow") {
      const sum = st.summary || {};
      return `<span>In queue <b>${fmt(st.poolCount || 0)}</b></span><span>Follow-back <b>${sum.rate == null ? "-" : U.pct(sum.rate, 0)}</b></span><span>Sources <b>${fmt((st.sources || []).length)}</b></span>`;
    }
    if (m === "followback") {
      const b = st.bk || {};
      return `<span>Waiting <b>${b.stage === "ready" ? fmt(b.left) : b.stage === "done" ? "0" : "…"}</b></span><span>All time <b>${fmt(b.all || 0)}</b></span><span>This hour <b>${fmt(d.hour || 0)}/${fmt(d.cap || 0)}</b></span>`;
    }
    const u = st.unf || {};
    return `<span>Due now <b>${fmt(u.due || 0)}</b></span><span>All time <b>${fmt(u.all || 0)}</b></span><span>This hour <b>${fmt(d.hour || 0)}/${fmt(d.cap || 0)}</b></span>`;
  }

  // Start / Pause / Resume / Stop, per mode. Only the mode that is actually
  // running shows Pause and Stop - the others show Start, which switches to that
  // mode and begins straight away.
  function modeControls(m, d) {
    const job = st.job;
    const v = U.jobView(job, st.task);
    const mine = job && (job.runMode === m || job.mode === m);
    const b = (run, cls, icon, label, extra) => `<button class="btn ${cls} btn-xs" data-run="${run}"${extra || ""}>${U.icon(icon)}<span>${label}</span></button>`;
    if (v.active && mine) return b("pause", "btn-primary", "pause", "Pause") + b("stop", "", "stop", "Stop");
    if ((v.paused || v.halted) && mine) return b("resume", "btn-primary", "play", "Resume") + b("stop", "", "stop", "Stop");
    const why = d.blocked ? "X limited this mode today" : d.doneToday ? "Finished for today" : d.reached ? "Today's number is done" : "";
    return `<button class="btn btn-primary btn-xs" data-mstart="${m}"${why ? ` title="${why}"` : ""}>${U.icon("rocket")}<span>${v.active ? "Switch to this" : "Start"}</span></button>`;
  }

  function renderModeCards() {
    const box = $("#modeCards");
    if (!box || !st.modes) return;
    const c = st.cmt || {};
    const s = sOf();
    const seqOff = new Set(s.switchOff || []);
    const html = ["follow", "followback", "unfollow", "comment"].map((m) => {
      const d = st.modes[m] || {};
      const meta = MODE_META[m];
      const pct = Math.round((d.pct || 0) * 100);
      const pillCls = d.running ? "st-posting" : d.status === "blocked" ? "st-failed" : d.reached || d.doneToday ? "st-posted" : "st-waiting";
      const off = m === "comment" && s.cmtOn === false;
      const strip = m === "comment"
        ? (!c.hasKey
          ? `<div class="mc-strip"><span>Connect ChatGPT to start writing replies</span><a class="btn btn-primary btn-xs" href="#autopilot"><span>Set up</span></a></div>`
          : off
          ? `<div class="mc-strip"><span>Comment mode is switched off</span><a class="btn btn-primary btn-xs" href="#comment"><span>Turn on</span></a></div>`
          : c.ready && s.cmtPublish === "draft"
          ? `<div class="mc-strip"><span><b>${fmt(c.ready)}</b> ${c.ready === 1 ? "draft" : "drafts"} waiting for you</span><a class="btn btn-primary btn-xs" href="#comment"><span>Open</span></a></div>`
          : "")
        : "";
      return `<div class="card mc ${meta.cls}${d.running ? " is-live" : ""}${off ? " mc-off" : ""}" data-mcard="${m}">
        <div class="mc-top"><span class="mc-ic">${U.icon(meta.icon)}</span><b>${meta.name}</b><span class="st-pill ${pillCls}">${off ? "Off" : STATUS_WORD[d.status] || "Waiting"}</span></div>
        <div class="mc-num">${fmt(d.done || 0)} <em>/ ${fmt(d.target || 0)} ${meta.word} today</em></div>
        <div class="bar thin${d.running ? " is-live" : ""}"><i style="width:${pct}%"></i></div>
        <div class="mc-sub">${d.left ? `${fmt(d.left)} to go` : "the day's number is done"}${d.running ? " · running now" : d.inWindow === false ? ` · starts ${U.clock(d.nextWindow)}` : seqOff.has(m) ? " · not in the sequence" : ""}</div>
        <div class="mc-mini">${modeFacts(m, d, s)}</div>
        ${strip}
        <div class="mc-act">${modeControls(m, d)}<a class="btn btn-ghost btn-xs" href="${meta.page}"><span>Open →</span></a></div>
      </div>`;
    }).join("");
    setHtml("modeCards", box, html);
  }

  // =====================================================================
  // COMMENT CONTROL, on the Overview
  // =====================================================================
  function renderOvCmt() {
    const box = $("#ovCmt");
    if (!box) return;
    const s = sOf();
    const c = st.cmt || {};
    // It belongs to Comment mode: the Overview shows it only while Comment is the
    // mode you picked, and never when Comment is switched off entirely.
    box.hidden = s.cmtOn === false || s.runMode !== "comment";
    if (box.hidden) { ui.html.ovCmt = ""; return; }
    // a redraw while you are typing in it would throw away what you typed
    if (box.contains(document.activeElement)) return;

    const sel = (id, k, opts, cur) => `<select class="select" data-ck="${k}" id="${id}">${opts.map(([v, l]) => `<option value="${v}"${v === cur ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    const meter = (label, n, max, txt) => {
      const pct = Math.min(100, Math.round((n / Math.max(0.0001, max)) * 100));
      return `<div class="lim"><div class="lim-top"><span>${label}</span><b>${txt || `${fmt(n)} / ${fmt(max)}`}</b></div><div class="bar thin"><i style="width:${pct}%"></i></div></div>`;
    };
    const qbox = (href, n, one, many) => `<a href="${href}"><b>${fmt(n)}</b><span>${n === 1 ? one : many}</span></a>`;

    setHtml("ovCmt", box, `
      <div class="card th-cmt ovc-top">
        <div class="ovc-head"><span class="mc-ic">${U.icon("chart")}</span><div style="flex:1;min-width:0"><b>Comment overview</b><small>Every post GrowX has been given, where each one got to, and when the rest will be done.</small></div>
          <a class="btn btn-ghost btn-sm" href="#cmthistory"><span>History →</span></a></div>
        ${cmtTiles(s, c)}
      </div>

      <div class="card th-cmt ovc-add">
        <div class="ovc-head"><span class="mc-ic">${U.icon("chat")}</span><div style="flex:1;min-width:0"><b>Comment control</b><small>Paste links, set the voice and the pace - without leaving this page.</small></div>
          <a class="btn btn-ghost btn-sm" href="#comment"><span>Open Comment →</span></a></div>
        <label class="lbl" for="ovcText">Post links · one per line, commas, or mixed with text</label>
        <textarea class="textarea" id="ovcText" rows="3" spellcheck="false" placeholder="https://x.com/someone/status/1983200114522"></textarea>
        <div class="ovc-row">
          <button class="btn btn-primary" id="ovcAdd">${U.icon("plus")}<span>Add to queue</span></button>
          <input class="input" id="ovcTarget" placeholder="@account to follow and reply to" spellcheck="false" style="flex:1 1 220px;min-width:0">
          <button class="btn" id="ovcTargetAdd">${U.icon("target")}<span>Add target</span></button>
        </div>
        <div class="cmt-chips" id="ovcChips"></div>
        ${removables(c)}
        <p class="hint">The voice, the pace, the model and the daily number live in <a href="#autopilot">Comment settings</a>.</p>
      </div>

      <div class="card th-cmt ovc-meters">
        <div class="ovc-head"><span class="mc-ic">${U.icon("gauge")}</span><div style="flex:1;min-width:0"><b>Comment right now</b><small>nothing runs past these</small></div></div>
        ${linkProgress(c)}
        ${meter("This hour", c.hour || 0, c.hourCap || s.cmtHourlyLimit)}
        ${meter("Today", c.today || 0, c.goal || s.cmtDaily)}
        ${meter("AI spend today", c.cost || 0, c.cap || 0.5, `${money(c.cost || 0)} / ${money(c.cap || 0)}`)}
        <div class="ovc-q">
          ${qbox("#comment", c.ready || 0, "draft ready", "drafts ready")}
          ${qbox("#comment", c.open || 0, "post waiting", "posts waiting")}
          ${qbox("#comment", c.watch || 0, "account watched", "accounts watched")}
          ${qbox("#comment", c.targets || 0, "target account", "target accounts")}
        </div>
        <div class="ovc-facts">
          <div>Hours: <b>${s.cmtStartNow ? "all day" : esc(s.cmtStart) + " – " + esc(s.cmtEnd)}</b></div>
          <div>Voice: <b>${esc(lbl(GX.CMT_LANGS, s.cmtLang))} · ${esc(lbl(GX.CMT_TONES, s.cmtTone))} · ${esc(lbl(GX.CMT_MOODS, s.cmtMood))}</b></div>
          <div>Reply length: <b>${s.cmtWordsMin}-${s.cmtWordsMax} words</b>, at most <b>${s.cmtLines}</b> line${s.cmtLines === 1 ? "" : "s"}</div>
          <div>All-time replies: <b>${fmt(c.all || 0)}</b></div>
          ${!c.hasKey ? `<div class="aggressive">No OpenAI key yet - add it in <a href="#autopilot">Comment settings</a>.</div>` : ""}
        </div>
      </div>`);
    // the number field is filled in after the html is in place, like the settings page
    const n = $('#ovCmt [data-ck="cmtDaily"]');
    if (n && n !== document.activeElement) n.value = s.cmtDaily;
  }
  const lbl = (list, v) => { const hit = (list || []).find(([x]) => x === v); return hit ? hit[1] : v; };

  // Saved timing sets. Each one holds every box in C2 and nothing else, so
  // applying one changes the waits and leaves goals, rules and the voice alone.
  function renderTimePresets(s) {
    const box = $("#cmtTimePresets");
    if (!box) return;
    const list = (cs && cs.timings) || [];
    const mine = JSON.stringify(GX.CMT_TIMING_KEYS.map((k) => s[k]));
    const html = list.map((t) => {
      const on = JSON.stringify(GX.CMT_TIMING_KEYS.map((k) => t.v[k])) === mine;
      return `<span class="tp ${on ? "on" : ""}"><button type="button" data-ctime="${esc(t.name)}">${esc(t.name)}${on ? " · in use" : ""}</button><button type="button" class="tp-x" data-ctimedel="${esc(t.name)}" title="Delete this set">×</button></span>`;
    }).join("");
    setHtml("cmtTimePresets", box, html || `<span class="hint">None yet. Set the boxes below the way you want them, give it a name and press Save.</span>`);
  }

  // Everything you have added that is still to be used, each with an X. Nothing
  // here is a setting - it is the work queued up, and you can take any of it back out.
  function removables(c) {
    const rows = (c.links && c.links.rows) || [];
    const targets = c.targetList || [];
    const one = (cls, key, val, label, title, sub) =>
      `<span class="rm ${cls}" title="${esc(title || "")}"><a href="${esc(label.href)}"${label.href.startsWith("http") ? ' target="_blank" rel="noopener"' : ""}>${esc(label.text)}</a>${sub ? `<em>${esc(sub)}</em>` : ""}<button type="button" class="rm-x" data-${key}="${esc(val)}" aria-label="Remove">×</button></span>`;
    const linkHtml = rows.map((r) => one("rm-link", "ovcdellink", r.i,
      { href: GX.postUrl(r.i, r.h), text: r.h ? "@" + r.h : r.i },
      `${GX.CMT_STATUS_NAME[r.st] || r.st} - opens the post on X`,
      GX.CMT_STATUS_NAME[r.st] || r.st)).join("");
    const tgtHtml = targets.map((t) => one("rm-tgt", "ovcdeltarget", t.h,
      { href: "https://x.com/" + t.h, text: "@" + t.h },
      t.done ? t.done : t.followed ? "Followed - waiting for a post to reply to" : "Waiting for Follow mode to follow them",
      t.done ? t.done : t.followed ? "followed" : "to follow")).join("");
    return `<div class="rm-sets">
      <div class="rm-set">
        <div class="rm-head"><b>Links waiting</b><span>${fmt((c.links && c.links.all) || 0)} pasted · ${fmt(rows.length)} not replied to yet</span>${rows.length ? `<button type="button" class="btn btn-ghost btn-xs" id="ovcClearLinks"><span>Remove all</span></button>` : ""}</div>
        <div class="rm-list">${linkHtml || `<span class="hint">Nothing waiting. Paste links above.</span>`}</div>
      </div>
      <div class="rm-set">
        <div class="rm-head"><b>Target accounts</b><span>${fmt(targets.length)} added</span>${targets.length ? `<button type="button" class="btn btn-ghost btn-xs" id="ovcClearTargets"><span>Remove all</span></button>` : ""}</div>
        <div class="rm-list">${tgtHtml || `<span class="hint">None yet. Add one above.</span>`}</div>
      </div>
    </div>`;
  }

  // The eight numbers that answer "where is this up to?" - counted over the whole
  // queue, not just today, with the day's progress and when the rest will be done.
  function cmtTiles(s, c) {
    const T = (c && c.tot) || { posts: 0, replied: 0, skipped: 0, failed: 0, left: 0, cost: 0 };
    const done = c.today || 0, goal = c.goal || s.cmtDaily;
    const pct = Math.min(100, Math.round((done / Math.max(1, goal)) * 100));
    const fin = GX.cmtFinish(s, { left: T.left, hourCap: c.hourCap || s.cmtHourlyLimit });
    const tile = (label, value, sub, cls) => `<div class="ct ${cls || ""}"><small>${label}</small><b>${value}</b><span>${sub}</span></div>`;
    return `<div class="ct-grid">
      ${tile("Posts in the queue", fmt(T.posts), `${fmt((c.links && c.links.all) || 0)} from links you pasted`)}
      ${tile("Replied", fmt(T.replied), `${fmt(c.all || 0)} all time`, "ct-ok")}
      ${tile("Skipped", fmt(T.skipped), "with a reason on every row", "ct-sk")}
      ${tile("Failed", fmt(T.failed), T.failed ? "open the row to see why" : "nothing has failed", "ct-no")}
      ${tile("AI cost, all time", money(T.cost), `${money(c.cost || 0)} of ${money(c.cap || 0)} today`)}
      ${tile("Still to do", fmt(T.left), `${fmt(T.ready)} already written`)}
      ${tile("Today", `${fmt(done)} / ${fmt(goal)}`, `<span class="ct-bar"><i style="width:${pct}%"></i></span>`, "ct-prog")}
      ${tile("Finishes in", fin ? U.dur(fin.seconds) : "—", fin ? `about ${U.clock(fin.at)}${fin.capped ? " · held to your hourly cap" : ""}` : "nothing left to do", "ct-fin")}
    </div>`;
  }

  // "You pasted 7 links. 2 replied, 1 skipped, 1 failed, 3 to go." - the plain
  // answer to "how many are done?", with the same bar the modes use.
  function linkProgress(c) {
    const L = (c && c.links) || null;
    if (!L || !L.all) return `<div class="lp lp-none">No pasted links in the queue. Paste some above and they show up here.</div>`;
    const done = L.posted + L.skipped + L.failed;
    const pct = Math.round((done / Math.max(1, L.all)) * 100);
    const bit = (n, word, cls) => (n ? `<span class="${cls}"><b>${fmt(n)}</b> ${word}</span>` : "");
    return `<div class="lp">
      <div class="lp-top"><span>Links you pasted</span><b>${fmt(done)} of ${fmt(L.all)} done</b></div>
      <div class="bar thin"><i style="width:${pct}%"></i></div>
      <div class="lp-row">
        ${bit(L.posted, "replied", "lp-ok")}
        ${bit(L.ready, "written, waiting to post", "lp-rd")}
        ${bit(L.busy, "being worked on now", "lp-rd")}
        ${bit(L.skipped, "skipped", "lp-sk")}
        ${bit(L.failed, "failed", "lp-no")}
        ${bit(L.left, "still to go", "lp-left")}
      </div>
    </div>`;
  }

  // =====================================================================
  // THE COMMENT PAGE
  // =====================================================================
  async function renderComment() {
    await load();
    if (!cs) return;
    const s = sOf();
    const c = st.cmt || {};
    renderCtl();
    renderGo();
    renderHero(s, c);
    renderStats(s, c);
    renderLimits(s, c);
    renderTabs();
    if (ui.tab === "watch") renderWatch();
    if (ui.tab === "target") renderTargets();
    if (ui.tab === "back") renderBack(s);
    await renderRows();
  }

  // ---- v3.2 Start commenting: the checklist, the time it takes, one button ---------------------------
  const FIX_LABEL = { turnOn: "Turn on", key: "Add key", startNow: "Start now anyway", likeOn: "Turn on", auto: "Post automatically", spend: "Raise the cap", goal: "Raise the goal", links: "Paste links", openX: "Open x.com" };
  let goAt = 0, goBusy = false;
  async function renderGo(force) {
    const box = $("#cmtCheck");
    if (!box) return;
    const txt = $("#cmtGoText");
    if (!force && Date.now() - goAt < 2500) return;
    if (goBusy) return;
    goAt = Date.now(); goBusy = true;
    let r;
    try { r = await cmd("preflight", { text: txt ? txt.value : "" }); } finally { goBusy = false; }
    if (!r || !r.ok) return;
    ui.pf = r;
    const ic = (x) => x.ok ? U.icon("check") : x.block ? U.icon("x") : U.icon("info");
    const rows = r.items.map((x) => `<div class="ck ${x.ok ? "ok" : x.block ? "no" : "note"}"><span class="ck-ic">${ic(x)}</span><span class="ck-t">${esc(x.text)}</span>${x.fix ? `<button type="button" class="btn btn-xs ${x.block ? "btn-primary" : ""}" data-cfix="${esc(x.fix)}"><span>${esc(FIX_LABEL[x.fix] || "Fix")}</span></button>` : ""}</div>`).join("");
    const blockers = r.items.filter((x) => x.block).length;
    setHtml("cmtCheck", box, `<div class="ck-head"><b>${blockers ? `${blockers} thing${blockers === 1 ? "" : "s"} to fix before it can start` : "Ready to start"}</b><small>checked just now</small></div>${rows}`);
    const job = st && st.job;
    const running = job && ["running", "resting", "sleeping"].includes(job.status) && (job.runMode === "comment" || job.mode === "comment");
    const btn = $("#cmtGoBtn");
    if (btn) {
      btn.disabled = !r.canStart && !(txt && txt.value.trim());
      btn.querySelector("span").textContent = running ? (r.fresh ? `Add ${r.fresh} and keep going` : "Running - add more links") : r.fresh ? `Start with ${r.fresh} link${r.fresh === 1 ? "" : "s"}` : "Start commenting";
    }
    const sum = $("#cmtGoSum");
    if (sum) sum.textContent = r.mine ? `${r.mine} own post${r.mine === 1 ? "" : "s"} will be skipped` : r.fresh ? `${r.fresh} new link${r.fresh === 1 ? "" : "s"} in the box` : "";
    const eta = $("#cmtEta");
    if (eta) {
      const e = r.eta;
      setHtml("cmtEta", eta, e ? `<div class="eta-grid">
          <div><small>Posts to do</small><b>${fmt(r.left)}</b></div>
          <div><small>Per reply</small><b>${U.dur(r.perReply)}</b><span>wait + read + write${sOf().cmtLike ? " + like" : ""} + post</span></div>
          <div><small>Total time</small><b>${U.dur(e.seconds)}</b><span>${e.breaks ? `${e.breaks} break${e.breaks === 1 ? "" : "s"}` : "no break needed"}${e.capped ? ` · max ${fmt(r.hourCap)}/hour` : ""}</span></div>
          <div><small>Finishes</small><b>${U.clock(e.at)}</b><span>${e.days ? `${new Date(e.at).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} - your daily goal moves the rest to the next day` : new Date(e.at).toDateString() !== new Date().toDateString() ? "after midnight" : "today"}${e.waitsForWindow ? " · starts with your working hours" : ""}</span></div>
        </div>` : `<p class="hint">Paste links to see how long they take and when they finish - worked out from your own delays, breaks, hourly cap and working hours.</p>`);
    }
  }
  async function cmtGoClick() {
    const txt = $("#cmtGoText");
    const btn = $("#cmtGoBtn");
    btn.disabled = true;
    let r;
    try { r = await cmd("go", { text: txt ? txt.value : "" }); } finally { btn.disabled = false; }
    if (r && r.preflight) ui.pf = r.preflight;
    if (!r || !r.ok) {
      U.toast((r && r.error) || "Couldn't start.", "bad", 6000);
      if (r && r.add && r.add.added && txt) txt.value = "";
      return renderGo(true);
    }
    const a = r.add || {};
    if (txt) txt.value = "";
    U.toast(`${a.added ? `${a.added} link${a.added === 1 ? "" : "s"} added. ` : ""}${r.started ? "Comment mode started - it likes each post, then replies." : r.switched ? "Switching to Comment mode - it takes over on the next step." : "Comment mode keeps going with these links."}${a.mine ? ` ${a.mine} own post${a.mine === 1 ? "" : "s"} skipped.` : ""}`, "good", 6000);
    await load(true);
    if (window.GXD && GXD.refresh) GXD.refresh();
    renderGo(true);
  }
  async function cmtFix(k) {
    if (k === "turnOn") { await saveOne({ cmtOn: true }); }
    else if (k === "startNow") { await saveOne({ cmtStartNow: true }); U.toast("Working hours set to Right away.", "good"); }
    else if (k === "likeOn") { await saveOne({ cmtLike: true }); }
    else if (k === "auto") { await saveOne({ cmtPublish: "auto" }); }
    else if (k === "links") { const t = $("#cmtGoText"); if (t) t.focus(); return; }
    else if (k === "openX") { await U.cmd("openX"); return; }
    else if (k === "key" || k === "spend" || k === "goal") {
      location.hash = "#autopilot";
      setTimeout(() => { const el = k === "key" ? $("#cmtKey") : $(`[data-ck="${k === "spend" ? "cmtSpendCents" : "cmtDaily"}"]`); if (el) { el.scrollIntoView({ block: "center", behavior: "smooth" }); el.focus(); } }, 400);
      return;
    }
    if (window.GXD && GXD.refresh) GXD.refresh();
    renderGo(true);
  }

  function renderCtl() {
    const s = sOf();
    const on = s.cmtOn !== false;
    // Start / Pause / Stop and the pause panel are the dashboard's own controls, so
    // the Comment page behaves exactly like every other page.
    const run = window.GXD ? GXD.ctlButtons("cmt") : "";
    const html = `<label class="switch"><input type="checkbox" data-ck="cmtOn"${on ? " checked" : ""}><span class="track"></span><span class="sw-lbl">Comment mode ${on ? "ON" : "OFF"}</span></label>`
      + `<a class="btn btn-ghost btn-sm" href="#autopilot">${U.icon("settings")}<span>Settings</span></a>`
      + run;
    setHtml("cmtCtl", $("#cmtCtl"), html);
  }

  function paceLine(s) {
    const avgDelay = (s.cmtMinDelay + s.cmtMaxDelay) / 2;
    const perBatch = (s.cmtRestEveryMin + s.cmtRestEvery) / 2 || 1;
    const breakMin = (s.cmtRestMinutes + s.cmtRestMinutesMax) / 2;
    const perReply = avgDelay + (perBatch ? (breakMin * 60) / perBatch : 0);
    return { perReply, perHour: Math.min(s.cmtHourlyLimit, Math.round(3600 / Math.max(1, perReply))) };
  }

  function renderHero(s, c) {
    const done = c.today || 0, goal = c.goal || s.cmtDaily;
    const pct = Math.round(Math.min(1, done / Math.max(1, goal)) * 100);
    const p = paceLine(s);
    const left = Math.max(0, goal - done);
    const eta = left && p.perHour ? Date.now() + (left / Math.max(1, p.perHour)) * HOUR : 0;
    const job = st.job;
    const running = job && ["running", "resting", "sleeping"].includes(job.status) && (job.runMode === "comment" || job.mode === "comment");
    const nextIn = running && job.nextAt > Date.now() ? U.countdown(job.nextAt - Date.now()) : "-";
    const model = GX.modelInfo(s.cmtModel);
    setHtml("cmtHero", $("#cmtHero"), `<div>
        <span class="kicker">Today's goal${s.cmtPublish === "draft" ? " · drafts only, you post" : ""}</span>
        <h2>${fmt(done)} of ${fmt(goal)} replies posted</h2>
        <p>${left ? `${fmt(left)} to go${eta ? ` · at your pace you reach it around ${U.clock(eta)}` : ""}` : "the day's goal is done"}</p>
        <div class="bar"><i style="width:${pct}%"></i></div>
        <div class="cmt-foot"><span>Model ${esc(model.id)}</span><span>Publishing: ${s.cmtPublish === "auto" ? "GrowX posts the reply" : "you post it"}</span><span>Hour ${c.hour || 0} / ${c.hourCap || s.cmtHourlyLimit}</span></div>
      </div>
      <div class="cmt-boxes">
        <div class="cmt-box"><small>Drafts ready</small><b>${fmt(c.ready || 0)}</b><span>${s.cmtPublish === "draft" ? `of ${s.cmtReady} kept ready` : "posted next"}</span></div>
        <div class="cmt-box"><small>Avg per reply</small><b>${Math.round(p.perReply)}s</b><span>delays + breaks</span></div>
        <div class="cmt-box"><small>Next reply in</small><b>${nextIn}</b><span>${running ? (job.message || "").slice(0, 40) : "not running"}</span></div>
      </div>`);
  }

  function renderStats(s, c) {
    const spent = c.cost || 0;
    const per = (c.today || 0) ? spent / c.today : 0;
    setHtml("cmtStats", $("#cmtStats"), `
      <div class="card cmt-stat good"><small>Posted today</small><b>${fmt(c.today || 0)}</b><span>${fmt(c.drafts || 0)} drafts written</span></div>
      <div class="card cmt-stat warn"><small>Skipped</small><b>${fmt(c.skipped || 0)}</b><span>already replied, too old, replies limited</span></div>
      <div class="card cmt-stat bad"><small>Failed</small><b>${fmt(c.failed || 0)}</b><span>the rule check or X refused</span></div>
      <div class="card cmt-stat"><small>AI cost, today</small><b>${money(spent)}</b><span>${both(spent, s.cmtRate).replace(/^.*<em>/, "<em>")} · ${per ? money(per) + " per reply" : "of " + money(c.cap || 0)}</span></div>`);
    // the same plain tally of the links you pasted, right above the queue
    const lp = $("#cmtLinkProg");
    if (lp) setHtml("cmtLinkProg", lp, `<div class="card lp-card">${linkProgress(c)}</div>`);
  }

  function renderLimits(s, c) {
    const meter = (label, n, max, extra) => {
      const pct = Math.min(100, Math.round((n / Math.max(1, max)) * 100));
      return `<div class="lim"><div class="lim-top"><span>${label}</span><b>${fmt(n)} / ${fmt(max)}</b></div><div class="bar thin"><i style="width:${pct}%"></i></div>${extra ? `<small class="hint">${extra}</small>` : ""}</div>`;
    };
    const spendPct = Math.min(100, Math.round(((c.cost || 0) / Math.max(0.0001, c.cap || 0.5)) * 100));
    const d = st.modes && st.modes.comment;
    setHtml("cmtLimits", $("#cmtLimits"), `
      <div class="card-head"><div><b>Limits right now</b><small>nothing runs past these</small></div></div>
      ${meter("This hour", c.hour || 0, c.hourCap || s.cmtHourlyLimit)}
      ${meter("Today", c.today || 0, c.goal || s.cmtDaily)}
      <div class="lim"><div class="lim-top"><span>AI spend today</span><b>${money(c.cost || 0)} / ${money(c.cap || 0)}</b></div><div class="bar thin"><i style="width:${spendPct}%"></i></div></div>
      <div class="cmt-facts">
        <div>Working hours: <b>${s.cmtStartNow ? "all day (Right away)" : esc(s.cmtStart) + " – " + esc(s.cmtEnd)}</b></div>
        <div>Working days: <b>${(GX.modeDays(s, "comment") || []).map((x) => DAY_NAMES[x]).join(", ") || "every day"}</b></div>
        <div>Already-replied posts skipped today: <b>${fmt(c.skipped || 0)}</b></div>
        <div>X warnings today: <b>${c.limited ? "X limited your replies" : "none"}</b></div>
        ${d && d.inWindow === false ? `<div>Outside its hours — starts <b>${U.dateTime(d.nextWindow)}</b></div>` : ""}
        ${!c.hasKey ? `<div class="aggressive">No OpenAI key yet. Add it in <a href="#autopilot">Comment settings</a> (section 2).</div>` : ""}
      </div>`);
  }

  function renderTabs() {
    const c = cs || {};
    const b = c.bySrc || {};
    const set = (id, n) => { const el = $(id); if (el) el.textContent = n ? String(n) : ""; };
    set("#tabLinks", b.links); set("#tabWatch", (c.watch || []).length); set("#tabTarget", (c.targets || []).filter((t) => !t.done).length); set("#tabBack", b.back);
    $$("#cmtTabs button").forEach((x) => x.classList.toggle("on", x.dataset.ctab === ui.tab));
    $$("[data-ctabp]").forEach((x) => { x.hidden = x.dataset.ctabp !== ui.tab; });
  }

  // The same "what would this paste do" chips as on the Comment page.
  async function ovcPreview() {
    const box = $("#ovcText");
    const chips = $("#ovcChips");
    if (!box || !chips) return;
    const r = await cmd("preview", { text: box.value });
    if (!r || !r.ok) return;
    const chip = (n, word, cls) => (n ? `<span class="chip ${cls || ""}">${n} ${word}</span>` : "");
    chips.innerHTML = r.pasted
      ? chip(r.pasted, r.pasted === 1 ? "link" : "links") + chip(r.dup, "duplicate", "amber")
        + chip(r.already, "already replied", "amber") + chip(r.queued, "already queued", "amber") + chip(r.added, "new", "green")
      : "";
    const b = $("#ovcAdd span");
    if (b) b.textContent = r.added ? `Add ${r.added} to queue` : "Add to queue";
  }

  async function previewPaste() {
    const box = $("#cmtText");
    if (!box) return;
    const r = await cmd("preview", { text: box.value });
    const chips = $("#cmtChips");
    if (!chips || !r || !r.ok) return;
    const chip = (n, word, cls) => (n ? `<span class="chip ${cls || ""}">${n} ${word}</span>` : "");
    chips.innerHTML = r.pasted
      ? chip(r.pasted, r.pasted === 1 ? "link pasted" : "links pasted")
        + chip(r.dup, "duplicate · counted once", "amber")
        + chip(r.already, "already replied · skipped", "amber")
        + chip(r.queued, "already in queue · skipped", "amber")
        + chip(r.mine, "your own post · never replied to", "amber")
        + chip(r.added, "new", "green")
      : "";
    const btn = $("#cmtAdd");
    if (btn) btn.querySelector("span").textContent = r.added ? `Add ${r.added} new to queue` : "Add to queue";
  }

  // ---- the one queue ---------------------------------------------------
  const SRC_TAG = { links: "Links", watch: "Watch", target: "Target", back: "Reply-back" };

  async function renderRows() {
    const r = await cmd("rows", { filter: ui.filter, src: ui.src, limit: 400 });
    if (!r || !r.ok) return;
    ui.rows = r.rows; ui.total = r.total;
    const sub = $("#cmtQueueSub");
    if (sub) sub.textContent = `${fmt(r.total)} in all · ${fmt((cs && cs.counts && cs.counts.ready) || 0)} ready · ${fmt((cs && cs.counts && cs.counts.posted) || 0)} posted`;
    const rows = r.rows.slice(0, ui.show);
    const s = sOf();
    const html = rows.map((x, i) => {
      const post = x.post || {};
      const h = x.h || (post.author && post.author.h) || "";
      const url = GX.postUrl(x.id, h);
      const txt = String(post.text || "").replace(/\s+/g, " ").slice(0, 110);
      const result = x.stats ? `♡ ${fmt(x.stats.likes)} · ${U.compact(x.stats.views)} views`
        : x.st === "posted" ? (Date.now() - x.postedAt < 3 * HOUR ? "updates in 3 h" : "—") : "—";
      const draft = x.st === "ready"
        ? `<textarea class="edit" data-cedit="${esc(x.id)}" rows="2">${esc(x.draft)}</textarea>`
        : x.draft ? esc(x.draft) : x.fail ? `<span class="muted">${esc(x.fail)}</span>` : x.skip ? `<span class="muted">${esc(x.skip)}</span>` : x.st === "writing" ? "writing…" : "—";
      const acts = x.st === "ready"
        ? `<button class="btn btn-primary btn-xs" data-cact="open" data-id="${esc(x.id)}"><span>${s.cmtPublish === "auto" ? "Post now" : "Open & insert"}</span></button>`
          + `<button class="btn btn-xs" data-cact="copy" data-id="${esc(x.id)}"><span>Copy</span></button>`
          + `<button class="btn btn-xs" data-cact="retry" data-id="${esc(x.id)}"><span>Rewrite</span></button>`
          + `<button class="btn btn-ghost btn-xs" data-cact="skip" data-id="${esc(x.id)}"><span>Skip</span></button>`
          + `<button class="btn btn-ghost btn-xs" data-cact="remove" data-id="${esc(x.id)}"><span>Remove</span></button>`
        : x.st === "posted"
        ? (x.replyId ? `<a class="btn btn-ghost btn-xs" href="https://x.com/i/web/status/${esc(x.replyId)}" target="_blank" rel="noopener"><span>See my reply ↗</span></a>` : `<span class="muted">posted</span>`)
        : ["skipped", "failed"].includes(x.st)
        ? `<button class="btn btn-xs" data-cact="retry" data-id="${esc(x.id)}"><span>Try again</span></button><button class="btn btn-ghost btn-xs" data-cact="remove" data-id="${esc(x.id)}"><span>Remove</span></button>`
        : `<button class="btn btn-ghost btn-xs" data-cact="skip" data-id="${esc(x.id)}"><span>Skip</span></button><button class="btn btn-ghost btn-xs" data-cact="remove" data-id="${esc(x.id)}"><span>Remove</span></button>`;
      return `<div class="trow cq-cols" data-crow="${esc(x.id)}">
        <span class="muted">${i + 1}</span>
        <span class="cq-post"><a href="${esc(url)}" target="_blank" rel="noopener">@${esc(h || "post")} ↗</a><em class="cq-src">${SRC_TAG[x.src] || x.src}</em><small>${esc(txt) || "—"}</small></span>
        <span class="cq-draft">${draft}${x.st === "ready" && x.byHand !== true ? "" : ""}</span>
        <span class="cq-res">${result}</span>
        <span><span class="st-pill st-${x.st}">${GX.CMT_STATUS_NAME[x.st] || x.st}</span>${x.st === "ready" && s.cmtPublish === "draft" ? `<br><button class="btn btn-ghost btn-xs" data-cact="posted" data-id="${esc(x.id)}"><span>Mark as posted</span></button>` : ""}</span>
        <span class="cq-act">${acts}<button class="btn btn-ghost btn-xs" data-cact="panel" data-id="${esc(x.id)}"><span>Details</span></button></span>
      </div>`;
    }).join("") || `<div class="empty"><b>Nothing here yet</b><p>Paste a few post links above and press Add to queue.</p></div>`;
    setHtml("cmtRows", $("#cmtRows"), html);
    const more = $("#cmtMore");
    if (more) more.hidden = r.rows.length <= ui.show;
  }

  // ---- watch list ------------------------------------------------------
  function renderWatch() {
    const list = (cs && cs.watch) || [];
    const html = list.map((w) => `<div class="trow cw-cols">
      <span><b>@${esc(w.h)}</b></span>
      <span>${w.last ? U.ago(w.last) : "—"}</span>
      <span>${w.lastDraft ? U.ago(w.lastDraft) : "—"}</span>
      <span>${w.err ? `<span class="st-pill st-failed">${esc(w.err)}</span>` : w.on === false ? `<span class="st-pill st-waiting">Off</span>` : w.id ? `<span class="st-pill st-posted">Watching</span>` : `<span class="st-pill st-waiting">Not found yet</span>`}</span>
      <span class="cq-act"><label class="switch sm"><input type="checkbox" data-cwatch="${esc(w.h)}"${w.on !== false ? " checked" : ""}><span class="track"></span></label><button class="btn btn-ghost btn-xs" data-cact="watchDel" data-h="${esc(w.h)}"><span>Remove</span></button></span>
    </div>`).join("") || `<div class="empty"><b>No accounts yet</b><p>Add 10 to 50 accounts whose new posts you want to reply to first.</p></div>`;
    setHtml("cmtWatchRows", $("#cmtWatchRows"), html);
  }

  // ---- target accounts -------------------------------------------------
  function renderTargets() {
    const list = (cs && cs.targets) || [];
    const html = list.map((t) => `<div class="trow ct-cols">
      <span><b>@${esc(t.h)}</b></span>
      <span>${t.followed ? `<span class="st-pill st-posted">Followed</span>` : `<span class="st-pill st-waiting">In Follow queue</span>`}</span>
      <span>${t.post ? `<a href="${esc(GX.postUrl(t.post, t.h))}" target="_blank" rel="noopener">Draft queued ↗</a>` : t.done ? `<span class="muted">${esc(t.done)}</span>` : "—"}</span>
      <span>${targetBack(t)}</span>
      <span class="cq-act"><button class="btn btn-ghost btn-xs" data-cact="targetDel" data-h="${esc(t.h)}"><span>Remove</span></button></span>
    </div>`).join("") || `<div class="empty"><b>No target accounts yet</b><p>Add the accounts you want to follow and reply to. Follow mode follows them first.</p></div>`;
    setHtml("cmtTargetRows", $("#cmtTargetRows"), html);
    // Does a follow WITH a reply get followed back more often than a bare follow?
    const sum = st.summary || {};
    const base = sum.rate != null ? Math.round(sum.rate * 100) : null;
    setHtml("cmtTargetRate", $("#cmtTargetRate"), `<div class="card-head"><div><b>Does the reply help?</b><small>measured from your own follows</small></div></div>
      <p class="hint">${base == null ? "GrowX needs a few days of follows before it can compare." : `Your follow-back rate on plain follows is <b>${base}%</b>. Target accounts get a follow <em>and</em> a reply, and GrowX counts them separately here as soon as ${list.length ? "these" : "some"} accounts have had their follow-back check.`}</p>`);
  }
  function targetBack(t) {
    if (!t.followed) return "—";
    const f = (st.summary && st.summary.rate) || 0;
    return t.back ? `<span class="st-pill st-posted">Follows you</span>` : `<span class="st-pill st-waiting">Waiting</span>`;
  }

  function renderBack(s) {
    setHtml("cmtBackCard", $("#cmtBackCard"), `<div class="card-head"><div><b>Reply-back</b><small>answers to the replies people leave on your own posts</small></div>
      <label class="switch"><input type="checkbox" data-ck="cmtSrcBack"${s.cmtSrcBack ? " checked" : ""}><span class="track"></span><span class="sw-lbl">${s.cmtSrcBack ? "ON" : "OFF"}</span></label></div>
      <p class="hint">GrowX looks at your own posts from the last <b>${s.cmtBackHours} h</b>, finds replies from other people and writes an answer with your <b>separate Reply-back prompt</b> (Comment settings, section 3). At most <b>${s.cmtBackMax}</b> answer per person per post. Spam, abuse and replies you already answered are skipped.</p>
      <p class="hint">Everything else - your pace, your rules, your limits and your working hours - is exactly the same as for any other reply.</p>`);
  }

  // =====================================================================
  // THE QUEUE SIDE PANEL
  // =====================================================================
  async function openPanel(id) {
    const r = await cmd("row", { id });
    if (!r || !r.ok || !r.row) return U.toast("That row is gone.", "bad");
    const x = r.row, post = x.post || {};
    const el = document.createElement("div");
    el.className = "cq-panel";
    el.innerHTML = `<div class="scrim" data-close></div><div class="sheet">
      <div class="card-head"><h3>@${esc(x.h || "post")}</h3><button class="icon-btn" data-close>${U.icon("x")}</button></div>
      <div class="blk"><b>The post</b><p>${esc(post.text || "(not read yet)")}</p></div>
      ${(post.media || []).length ? `<div class="blk"><b>Images</b><div class="shots">${post.media.map((m) => `<img src="${esc(m.url)}" alt="${esc(m.alt || "")}">`).join("")}</div>${post.media.some((m) => m.alt) ? `<p>${esc(post.media.map((m) => m.alt).filter(Boolean).join(" | "))}</p>` : ""}</div>` : ""}
      ${post.quoted ? `<div class="blk"><b>It quotes @${esc((post.quoted.author && post.quoted.author.h) || "")}</b><p>${esc(post.quoted.text || "")}</p></div>` : ""}
      ${post.parent ? `<div class="blk"><b>It replies to @${esc((post.parent.author && post.parent.author.h) || "")}</b><p>${esc(post.parent.text || "")}</p></div>` : ""}
      ${x.read ? `<div class="blk"><b>What the AI read first</b><p>${esc(x.read)}</p></div>` : ""}
      <div class="blk"><b>The reply</b><p>${esc(x.draft || "—")}</p></div>
      ${(x.rejects || []).length ? `<div class="blk"><b>Drafts that broke a rule</b>${x.rejects.map((j) => `<div class="rej">${esc(j.t)}<em>${esc((j.b || []).join(" · "))}</em></div>`).join("")}</div>` : ""}
      <div class="blk"><b>This draft</b><p>Model ${esc(x.model || "-")} · ${money(x.cost || 0)} (${taka(x.cost || 0, sOf().cmtRate)}) · ${fmt(x.inTok || 0)} in / ${fmt(x.outTok || 0)} out tokens${x.liked ? " · post liked" : ""}</p></div>
      <div class="btn-row"><a class="btn" href="${esc(GX.postUrl(x.id, x.h))}" target="_blank" rel="noopener"><span>Open the post ↗</span></a>${x.replyId ? `<a class="btn" href="https://x.com/i/web/status/${esc(x.replyId)}" target="_blank" rel="noopener"><span>See my reply ↗</span></a>` : ""}</div>
    </div>`;
    el.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) el.remove(); });
    document.body.appendChild(el);
    U.icons(el);
  }

  // =====================================================================
  // COMMENT SETTINGS C1 - C8 (on the Autopilot page, in Comment mode)
  // =====================================================================
  function renderSettings() {
    const box = $("#cmtSettings");
    if (!box) return;
    if (!ui.built) { box.innerHTML = settingsHtml(); U.icons(box); ui.built = true; wireSettingsOnce(); }
    syncSettings();
  }

  const num = (k, unit, attrs) => {
    const [lo, hi] = GX.CMT_LIMITS[k] || [0, 9999];
    return `<div class="with-unit"><input class="input num" type="number" min="${lo}" max="${hi}" step="1" data-ck="${k}" ${attrs || ""}><span>${unit}</span></div>`;
  };
  const range = (a, b, unit) => `<div class="duo">${num(a, unit)}<em>to</em>${num(b, unit)}</div>`;
  // A timing box. The value is always kept in seconds; this only changes what you
  // type into it, so switching to minutes never moves a setting.
  const tnum = (k) => `<div class="with-unit"><input class="input num" type="number" min="0" step="1" data-ck="${k}" data-sec="1"><span class="u-sec">sec</span></div>`;
  const trange = (a, b) => `<div class="duo">${tnum(a)}<em>to</em>${tnum(b)}</div>`;
  const sw = (k, title, sub, badge) => `<div class="sw-row"><div class="sw-txt"><b>${title}</b><small>${sub || ""}</small></div>${badge ? `<span class="locked-badge">${badge}</span>` : `<label class="switch"><input type="checkbox" data-ck="${k}"><span class="track"></span></label>`}</div>`;
  const pick = (k, opts, hint, label) => field(label, `<select class="select" data-ck="${k}"></select>`, hint);
  const field = (label, body, hint, id) => `<div class="field"${id ? ` id="${id}"` : ""}><label>${label}</label>${body}${hint ? `<span class="hint">${hint}</span>` : ""}</div>`;

  function settingsHtml() {
    const RULE_CHIPS = [
      ["cmtLower", "lowercase"], ["cmtNoEmoji", "no emoji"], ["cmtNoHash", "no hashtags"], ["cmtNoMention", "no @mentions"],
      ["cmtNoLink", "no links"], ["cmtNoQuote", "no quotes"], ["cmtEndAlnum", "ends on a letter or number"],
      ["cmtNoCopy", "not a copy of the post"], ["cmtNoRepeat", "not like my last replies"]
    ];
    return `
    <div class="cmt-live" id="cmtLive"></div>

    <div class="card fs">
      <div class="fs-head"><span data-icon="chat"></span><div><b>C1. How many replies</b><small>One click on a pace card fills in every delay, break and limit below. You can still change any of them - every change saves itself.</small></div></div>
      <div class="cmt-presets" id="cmtPresets"></div>
      <div class="fgrid">
        ${field("Daily goal", num("cmtDaily", "replies"), "Unverified X accounts can post about 200 replies a day; a verified one more. GrowX never goes past this number.", "cmtDailyField")}
        ${field("Drafts to keep ready", num("cmtReady", "drafts"), "Only used when publishing is set to &quot;I post them myself&quot;: GrowX writes ahead until this many are waiting.")}
        ${field("Target per turn (mode sequence)", num("cmtTurn", "replies"), "How many replies one turn does before Comment hands over to the next mode. 0 = it does its whole day.")}
      </div>
      <div class="sw-row"><div class="sw-txt"><b>Publishing</b><small>GrowX can post the reply for you through your own signed-in X session, or just write it and let you post it.</small></div>
        <div class="seg" id="cmtPub"><button type="button" data-cpub="auto">GrowX posts it</button><button type="button" data-cpub="draft">I post it myself</button></div>
      </div>
      <div class="aggressive" id="cmtAggressive" hidden></div>
    </div>

    <div class="card fs">
      <div class="fs-head"><span data-icon="clock"></span><div><b>C2. Timing</b><small>Every wait is a random time inside its own range, so two replies never look alike. Each step of one reply has its own range, and all of them are yours to set.</small></div>
        <div class="seg sm" id="cmtUnitSeg"><button type="button" data-cunit="sec">Seconds</button><button type="button" data-cunit="min">Minutes</button></div></div>

      <div class="tpresets">
        <label class="lbl">Your saved timing sets</label>
        <div class="tp-list" id="cmtTimePresets"></div>
        <div class="tp-save">
          <input class="input" id="cmtTimeName" placeholder="Name this set, e.g. Night, slow" maxlength="40" spellcheck="false">
          <button class="btn" type="button" id="cmtTimeSave">${U.icon("check")}<span>Save these timings</span></button>
        </div>
        <span class="hint">A set holds every box in this card. Saving under a name you already used replaces it.</span>
      </div>

      <div class="fgrid" id="cmtTimeGrid"></div>
      ${sw("cmtLike", "Like the post before replying", "Looks like a person reading first. Its own wait is the \"Like, then reply\" box above.")}
      <div class="tsum" id="cmtTimeSum"></div>
    </div>

    <div class="card fs">
      <div class="fs-head"><span data-icon="moonZ"></span><div><b>C3. Breaks &amp; limits</b><small>"After 8 to 12 replies, rest 15 to 30 minutes" - both halves are a range, and every break is a random value inside it. Put the same number in both boxes to make it exact.</small></div></div>
      <div class="fgrid">
        ${field("Take a break after", range("cmtRestEveryMin", "cmtRestEvery", "replies"), "0 in the second box = no breaks.")}
        ${field("Break length", range("cmtRestMinutes", "cmtRestMinutesMax", "min"), "Never shorter, never longer.")}
        ${field("Max per hour", num("cmtHourlyLimit", "replies"), "A rolling 60 minutes, like X counts it.")}
        ${field("Same author, max per day", num("cmtAuthorMax", "replies"), "Replying to one person over and over is the fastest way to be reported.")}
        ${field("Rest days a week", num("cmtRestDays", "days"), "GrowX picks them itself, a different day each week.")}
      </div>
      ${sw("cmtWarmup", "Warm-up", "Start low and add a few replies each day instead of going to the full number at once.")}
      ${sw("cmtSolo", "Don't run with the other modes at the same time", "One job after the other: Comment waits until Follow, Follow back and Unfollow have done their turn.")}
    </div>

    <div class="card fs">
      <div class="fs-head"><span data-icon="robot"></span><div><b>C4. AI (ChatGPT)</b><small>Your key is kept in this browser only and is sent to api.openai.com and nowhere else. Every cost below comes from the real token counts OpenAI returns.</small></div></div>
      ${field("OpenAI API key", `<div class="key-row"><input class="input" type="password" id="cmtKey" placeholder="sk-..." autocomplete="off" spellcheck="false"><button class="btn" type="button" id="cmtKeySave"><span>Save</span></button><button class="btn btn-soft" type="button" id="cmtKeyCheck"><span>Check key</span></button><span id="cmtKeyState"></span></div>`, "Kept only in this browser. Sent only to api.openai.com.")}
      <div class="mdl-wrap"><table class="mdl" id="cmtModels"><thead><tr><th></th><th>Model</th><th>1,000 replies</th><th>Quality</th><th>Speed</th></tr></thead><tbody></tbody></table></div>
      <div class="fgrid">
        ${field("Creativity (temperature)", `<div class="range-row"><input type="range" class="range" min="0" max="2" step="0.1" data-ck="cmtTemp"><b class="range-val num" id="cmtTempVal"></b></div>`, "Higher = more variety, lower = safer and more repetitive.")}
        ${field("US$ → ৳ rate", num("cmtRate", "৳/$"), "Only changes the second price shown next to every dollar amount.")}
      </div>
      ${sw("cmtVision", "Look at the images in the post", "The reply can react to a picture, not only to the text. Needs a model that can see.")}
      ${sw("cmtTwoStep", "Read the post first, then write (2 steps)", "One cheap call works out what the post is about, the second writes the reply. Better replies, a little more cost.")}
      ${sw("cmtSkipOff", "Skip posts that are off your prompt's topic", "The model answers SKIP and GrowX moves on instead of forcing a reply.")}
    </div>

    <div class="card fs">
      <div class="fs-head"><span data-icon="sparkles"></span><div><b>C5. Voice &amp; prompts</b><small>The four boxes below are added <b>under</b> your prompt as a short instruction block - your own wording still leads. The post, its author, the quoted post, the images and your last 10 replies are added for you.</small></div></div>
      <div class="fgrid">
        ${pick("cmtLang", 0, "\"Match the post\" replies in whatever language the post is written in.", "Language")}
        ${pick("cmtTone", 0, "How it talks.", "Tone")}
        ${pick("cmtMood", 0, "How it feels.", "Mood")}
        ${pick("cmtLength", 0, "A named size writes the word range in C6 for you. Custom hands it back.", "Reply length")}
      </div>
      ${sw("cmtEmojiOk", "Allow one emoji", "Off by default. One emoji at most - two or more are always rewritten.")}
      ${field("Anything else about the voice", `<input class="input" data-ck="cmtVoiceNote" placeholder="e.g. never mention prices · always lowercase i" spellcheck="false">`, "One line, added to the block. Leave it empty and nothing extra is sent.")}
      <div class="prompt-prev" id="cmtVoicePrev"></div>
      ${field("Comment prompt", `<textarea class="textarea prompt-box" data-ck="cmtPrompt" spellcheck="false"></textarea>`, "Used for every post from Links, Watch list and Target.")}
      ${field("Reply-back prompt", `<textarea class="textarea prompt-box" data-ck="cmtBackPrompt" spellcheck="false"></textarea>`, "Used only for answers to replies on your own posts.")}
      <div class="btn-row"><input class="input" id="cmtTestLink" placeholder="Paste one post link to test on" spellcheck="false"><button class="btn btn-primary" type="button" id="cmtTest"><span>Test on one link</span></button></div>
      <div id="cmtTestOut"></div>
    </div>

    <div class="card fs">
      <div class="fs-head"><span data-icon="shield"></span><div><b>C6. Reply rules</b><small>Checked by GrowX, not by the model. A reply that breaks one is rewritten with the broken rules named, and is never posted.</small></div></div>
      ${field("Banned words", `<textarea class="textarea" data-ck="cmtBanned" rows="4" spellcheck="false"></textarea>`, "Separated by commas. These are the words that make a reply read like a bot.")}
      ${sw("cmtForms", "Block every form of a word", "improve → improves, improved, improving")}
      ${field("Filler phrases", `<textarea class="textarea" data-ck="cmtFillers" rows="3" spellcheck="false"></textarea>`, "Whole phrases, separated by commas.")}
      <div class="fgrid">
        ${field("Words", range("cmtWordsMin", "cmtWordsMax", "words"), "", "cmtWordsField")}
        ${field("Max lines", num("cmtLines", "lines"))}
        ${field("Rewrites", num("cmtRewrites", "times"), "How many times a broken reply may be rewritten before the post is marked Failed.")}
      </div>
      <div class="chips-row" id="cmtRuleChips">${RULE_CHIPS.map(([k, l]) => `<button type="button" class="rchip" data-crule="${k}">${l}</button>`).join("")}</div>
    </div>

    <div class="card fs">
      <div class="fs-head"><span data-icon="ban"></span><div><b>C7. Who to skip</b><small>A skipped post is logged with its reason and never written for.</small></div></div>
      ${sw("", "One post, one reply, forever", "The same post in any link form counts once. Checked against every reply you have ever made.", "Always on")}
      ${sw("", "Skip posts you already replied to", "Read from X before writing, so a reply you made by hand or on another device counts too.", "Always on")}
      ${sw("cmtSkipLimited", "Skip posts where replies are limited", "The author only lets certain people reply.")}
      ${sw("cmtSkipLiked", "Skip posts I already liked", "")}
      <div class="fgrid">${field("Skip posts older than", num("cmtMaxAgeDays", "days"), "An old post gets almost no views, so a reply on it is wasted.")}</div>
    </div>

    <div class="card fs">
      <div class="fs-head"><span data-icon="target"></span><div><b>C8. Where the posts come from</b><small>All four feed the same queue, the same rules and the same limits.</small></div></div>
      ${sw("cmtSrcLinks", "Links you paste", "The queue on the Comment page.")}
      ${sw("cmtSrcWatch", "Watch list", "New posts from the accounts you follow closely - they go to the front of the queue.")}
      <div class="fgrid">
        ${field("Check every", num("cmtWatchEvery", "min"))}
        ${field("Ignore posts older than", num("cmtWatchAge", "min"), "A reply in the first minutes is seen by far more people.")}
        ${field("Max per account per day", num("cmtWatchMax", "replies"))}
      </div>
      ${sw("cmtWatchReplies", "Watch list: their replies too, not only their own posts", "")}
      ${sw("cmtSrcTarget", "Target accounts", "Follow them through Follow mode, then reply to their newest post.")}
      <div class="fgrid">
        ${field("Their latest post, not older than", num("cmtTargetAge", "days"))}
      </div>
      ${sw("cmtTargetReplies", "Target: their replies too", "")}
      ${sw("cmtTargetSkipRT", "Target: skip reposts", "")}
      ${sw("cmtSrcBack", "Reply-back", "Answer the replies people leave on your own posts.")}
      <div class="fgrid">
        ${field("Your posts from the last", num("cmtBackHours", "hours"))}
        ${field("Max answers per person per post", num("cmtBackMax", "replies"))}
      </div>
    </div>

    <div class="card fs">
      <div class="fs-head"><span data-icon="calendar"></span><div><b>C9. Daily ON / OFF time</b><small>Comment keeps its own hours and its own working days, like Unfollow and Follow back do.</small></div></div>
      <div class="sw-row"><div class="sw-txt"><b>Start</b><small>Right away = all day. Working hours only = between the two times below.</small></div>
        <div class="seg" id="cmtWhen"><button type="button" data-cwhen="now">Right away</button><button type="button" data-cwhen="hours">Working hours only</button></div>
      </div>
      <div class="fgrid">
        ${field("Turn on at", `<input class="input" type="time" data-ck="cmtStart">`)}
        ${field("Turn off at", `<input class="input" type="time" data-ck="cmtEnd">`)}
      </div>
      ${field("Working days", `<div class="days" id="cmtDays"></div>`, "Nothing picked = the same days as Follow mode.")}
    </div>

    <div class="card fs">
      <div class="fs-head"><span data-icon="shield"></span><div><b>C10. Limits &amp; safety</b><small>These stop a run before it can cost you money or your account.</small></div></div>
      <div class="fgrid">
        ${field("Daily AI spend cap", `<div class="with-unit money"><input class="input num" type="number" min="0.01" max="1000" step="0.01" id="cmtSpend"><span>$</span></div>`, "When today's AI cost reaches this, writing stops until tomorrow and you get a notification.")}
        ${field("Stop after failed drafts in a row", num("cmtFailStop", "times"), "The rule check failing again and again means the prompt and the rules disagree - GrowX pauses instead of burning your credit.")}
      </div>
      <div class="sw-row"><div class="sw-txt"><b>Emergency stop</b><small>Stops all four modes at once, from anywhere in Chrome.</small></div><span class="shortcut">Alt + Shift + S</span></div>
    </div>

    <div class="card fs">
      <div class="fs-head"><span data-icon="send"></span><div><b>C11. Telegram</b><small>Run updates on your phone, for all four modes. Your bot token stays in this browser.</small></div></div>
      <div class="fgrid">
        ${field("Bot token", `<input class="input" type="password" id="tgToken" placeholder="123456:ABC-DEF..." autocomplete="off">`, "Open @BotFather on Telegram → /newbot → copy the token.")}
        ${field("Chat id", `<input class="input" id="tgChat" placeholder="123456789">`, "Message your new bot once, then open @userinfobot to get your id.")}
        ${field("Daily report at", `<input class="input" type="time" id="tgDaily">`)}
      </div>
      <div class="btn-row"><button class="btn" type="button" id="tgSave"><span>Save</span></button><button class="btn btn-soft" type="button" id="tgTest"><span>Send test</span></button><span id="tgState"></span></div>
      <div id="tgEvents"></div>
    </div>`;
  }

  const TG_EVENTS = [
    ["run", "Run started, paused, resumed, finished"],
    ["warn", "X warning, rate limit or captcha"],
    ["fails", "Several failures in a row"],
    ["break", "Break started"],
    ["ready", "Drafts ready (every 10)"],
    ["watch", "A watched account posted"],
    ["target", "A target account followed you back"],
    ["reply", "A reply was posted"],
    ["daily", "The daily report"]
  ];

  // The OpenAI key. It is kept apart from the settings blob, so it has its own
  // save - which now happens as you type, a moment after you stop, exactly like
  // every other Comment setting. The Save button is still there and still works.
  let keyTimer = 0;
  async function saveKey(k, loud) {
    const st = $("#cmtKeyState");
    if (!k) { if (loud) U.toast("Paste your OpenAI key first.", "bad"); return; }
    if (!/^sk-/.test(k)) {
      if (st) st.innerHTML = '<span class="st-pill st-failed">An OpenAI key starts with sk-</span>';
      if (loud) U.toast("An OpenAI key starts with sk-.", "bad");
      return;
    }
    if (st) st.innerHTML = '<span class="st-pill st-waiting">Saving…</span>';
    const r = await cmd("key", { key: k });
    if (!r || !r.ok) { if (st) st.innerHTML = '<span class="st-pill st-failed">Could not save the key</span>'; return; }
    if (st) st.innerHTML = '<span class="ok-badge">Key saved</span>';
    if (loud) U.toast("Key saved in this browser.", "good");
    await load(true);
    const el = $("#cmtKey");
    if (el && el !== document.activeElement) { el.value = ""; el.placeholder = "saved - type a new one to replace it"; }
  }

  // Everything that only has to be wired once.
  function wireSettingsOnce() {
    const key = $("#cmtKey");
    if (key && !key.dataset.wired) {
      key.dataset.wired = "1";
      key.addEventListener("input", () => {
        clearTimeout(keyTimer);
        const v = key.value.trim();
        if (!v) return;
        keyTimer = setTimeout(() => saveKey(v, false), 900);
      });
      key.addEventListener("blur", () => { clearTimeout(keyTimer); const v = key.value.trim(); if (v) saveKey(v, false); });
      key.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); clearTimeout(keyTimer); saveKey(key.value.trim(), true); } });
    }
    cmd("tgGet").then((r) => {
      if (!r || !r.ok) return;
      const t = r.tg;
      $("#tgChat").value = t.chat || "";
      $("#tgDaily").value = t.dailyAt || "22:00";
      if (t.hasToken) $("#tgToken").placeholder = "saved - type a new one to replace it";
      setHtml("tgEvents", $("#tgEvents"), TG_EVENTS.map(([k, l]) => `<div class="sw-row"><div class="sw-txt"><b>${l}</b></div><label class="switch"><input type="checkbox" data-tg="${k}"${t.on[k] !== false ? " checked" : ""}><span class="track"></span></label></div>`).join(""));
      $("#tgState").innerHTML = t.lastAt ? (t.lastOk ? `<span class="ok-badge">Last send worked</span>` : `<span class="st-pill st-failed">${esc(t.lastErr || "failed")}</span>`) : "";
    });
    cs && cs.hasKey && ($("#cmtKey").placeholder = "saved - type a new one to replace it");
    load().then(() => { if (cs && cs.hasKey) $("#cmtKey").placeholder = "saved - type a new one to replace it"; });
  }

  // Fill the values in, without touching whatever the person is typing in.
  // One box per timing, drawn from GX.CMT_TIMINGS so Settings and the engine can
  // never disagree about which waits exist.
  function timingGrid() {
    return GX.CMT_TIMINGS.map((t) => field(t.name, trange(t.min, t.max), t.hint)).join("");
  }

  function syncSettings() {
    const s = sOf();
    const live = document.activeElement;
    const grid = $("#cmtTimeGrid");
    if (grid && !grid.dataset.built) { grid.innerHTML = timingGrid(); grid.dataset.built = "1"; }
    const inMin = s.cmtUnit === "min";
    $$("#cmtSettings [data-sec]").forEach((el) => {
      const [lo, hi] = GX.CMT_LIMITS[el.dataset.ck] || [0, 9999];
      el.min = inMin ? 0 : lo;
      el.max = inMin ? Math.ceil(hi / 60) : hi;
      el.step = inMin ? "0.5" : "1";
      if (el === live) return;
      const want = inMin ? String(Math.round((s[el.dataset.ck] / 60) * 10) / 10) : String(s[el.dataset.ck]);
      if (el.value !== want) el.value = want;
    });
    $$("#cmtSettings .u-sec").forEach((el) => { el.textContent = inMin ? "min" : "sec"; });
    $$("#cmtUnitSeg button").forEach((b) => b.classList.toggle("on", b.dataset.cunit === s.cmtUnit));
    renderTimePresets(s);
    const sum = $("#cmtTimeSum");
    if (sum) {
      const per = GX.cmtStepSeconds(s);
      const auto = s.cmtPublish === "auto";
      sum.innerHTML = `<b>One reply takes about ${U.dur(per)}</b> end to end at these numbers - that is up to <b>${Math.floor(3600 / Math.max(1, per))} an hour</b> before your hourly cap of <b>${fmt(GX.hourlyCap(s, "comment").cap)}</b> is applied.<small>${auto ? "Counted: the wait between replies, reading, writing, the reply box and sending." : "Counted: the wait between replies, reading, writing and your gap between drafts. Nothing is sent, so the sending waits are not used."}</small>`;
    }
    $$("#cmtSettings [data-ck]").forEach((el) => {
      if (el === live || el.dataset.sec) return;   // the timing boxes are filled in above, in your unit
      const k = el.dataset.ck;
      if (el.type === "checkbox") el.checked = !!s[k];
      else if (String(el.value) !== String(s[k])) el.value = s[k];
    });
    const spend = $("#cmtSpend");
    if (spend && spend !== live) spend.value = (s.cmtSpendCents / 100).toFixed(2);
    const tv = $("#cmtTempVal");
    if (tv) tv.textContent = Number(s.cmtTemp).toFixed(1);

    // pace cards
    setHtml("cmtPresets", $("#cmtPresets"), Object.entries(GX.CMT_PRESETS).map(([k, p]) => {
      const i = GX.CMT_PRESET_INFO[k];
      return `<button type="button" class="preset ${s.cmtPace === k ? "on" : ""}" data-cpreset="${k}"><b>${i.name}</b><small>${i.who}</small><span class="pr-per">${i.line}</span><span class="pr-meta">break ${p.cmtRestMinutes}-${p.cmtRestMinutesMax} min every ${p.cmtRestEveryMin}-${p.cmtRestEvery} · ${p.cmtHourlyLimit}/h</span></button>`;
    }).join("") + `<button type="button" class="preset ${s.cmtPace === "custom" ? "on" : ""}" data-cpreset="custom"><b>Custom</b><small>Your own numbers below</small><span class="pr-per">~${s.cmtDaily} / day</span><span class="pr-meta">every value is adjustable</span></button>`);

    // the live line
    const p = paceLine(s);
    const perDraft = GX.per1000(s.cmtModel) / 1000 * (s.cmtTwoStep ? 1.5 : 1);
    const hours = s.cmtDaily / Math.max(1, p.perHour);
    const open = s.cmtStartNow ? 24 : (() => { const m = (x) => { const [h, mi] = x.split(":").map(Number); return h * 60 + mi; }; let d = m(s.cmtEnd) - m(s.cmtStart); if (d <= 0) d += 1440; return d / 60; })();
    setHtml("cmtLive", $("#cmtLive"), `<div><b>With these settings:</b> ${fmt(s.cmtDaily)} replies take about <b>${hours < 1 ? Math.round(hours * 60) + " min" : (Math.round(hours * 10) / 10) + " h"}</b> · up to <b>${p.perHour} an hour</b> · AI about <b>${money(perDraft * s.cmtDaily)}</b> (${taka(perDraft * s.cmtDaily, s.cmtRate)}) a day</div><small>updates as you type</small>`);

    // the model table
    const tb = $("#cmtModels tbody");
    setHtml("cmtModels", tb, GX.MODELS.map((m) => {
      const k = GX.per1000(m.id);
      return `<tr class="${s.cmtModel === m.id ? "on" : ""}" data-cmodel="${m.id}"><td><input type="radio" name="cmtModel"${s.cmtModel === m.id ? " checked" : ""}></td>
        <td>${m.id}${m.rec ? '<span class="rec">RECOMMENDED</span>' : ""}</td>
        <td class="price">~${money(k)} <em>${taka(k, s.cmtRate)}</em></td><td>${m.quality}</td><td>${m.speed}</td></tr>`;
    }).join(""));

    // the voice selects, and a preview of exactly what gets sent
    const fill = (k, opts) => {
      const el = $(`#cmtSettings [data-ck="${k}"]`);
      if (!el || el === live) return;
      const html = opts.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("");
      if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
      el.value = s[k];
    };
    fill("cmtLang", GX.CMT_LANGS);
    fill("cmtTone", GX.CMT_TONES.map(([v, l, note]) => [v, `${l} - ${note}`]));
    fill("cmtMood", GX.CMT_MOODS.map(([v, l, note]) => [v, `${l} - ${note}`]));
    fill("cmtLength", Object.entries(GX.CMT_LENGTHS).map(([v, x]) => [v, v === "custom" ? `${x.name} - ${x.note}` : `${x.name} · ${x.min}-${x.max} words - ${x.note}`]));
    const prev = $("#cmtVoicePrev");
    if (prev) {
      const block = GX.styleBlock(s);
      prev.innerHTML = block ? `<b>Added under your prompt:</b><pre>${esc(block)}</pre>` : "";
    }
    // a named length owns the word range, so the boxes say where it comes from
    const wf = $("#cmtWordsField");
    if (wf) {
      const owned = s.cmtLength !== "custom";
      wf.classList.toggle("owned", owned);
      $$("input", wf).forEach((x) => { x.disabled = owned; });
      let h = wf.querySelector(".hint");
      if (!h) { h = document.createElement("span"); h.className = "hint"; wf.appendChild(h); }
      h.textContent = owned
        ? `Set by Reply length "${(GX.CMT_LENGTHS[s.cmtLength] || {}).name}" in C5. Pick Custom there to type your own range.`
        : "Your own range. A reply outside it is rewritten.";
    }

    // the rule chips
    $$("#cmtRuleChips .rchip").forEach((b) => b.classList.toggle("on", !!s[b.dataset.crule]));
    $$("#cmtPub button").forEach((b) => b.classList.toggle("on", b.dataset.cpub === s.cmtPublish));
    $$("#cmtWhen button").forEach((b) => b.classList.toggle("on", (b.dataset.cwhen === "now") === !!s.cmtStartNow));

    // working days
    const days = GX.modeDays(s, "comment");
    const own = (s.cmtDays || []).length;
    setHtml("cmtDays", $("#cmtDays"), DAY_NAMES.map((d, i) => `<button type="button" class="day ${own && days.includes(i) ? "on" : ""}" data-cday="${i}">${d}</button>`).join("")
      + `<button type="button" class="day ${own ? "" : "on"}" data-cday="same">Same as Follow</button>`);

    // "these numbers are unusually aggressive"
    const warn = [];
    if (s.cmtDaily > 200) warn.push(`${s.cmtDaily} replies a day is above what an unverified X account can usually post (about 200)`);
    if (s.cmtMinDelay < 60) warn.push(`${s.cmtMinDelay} seconds between replies is fast - under a minute is noticeable`);
    if (s.cmtHourlyLimit > 20) warn.push(`${s.cmtHourlyLimit} an hour is a lot for replies`);
    if (s.cmtAuthorMax > 3) warn.push(`${s.cmtAuthorMax} replies to the same person in one day is how reports start`);
    if (hours > open) warn.push(`${fmt(s.cmtDaily)} replies need about ${Math.round(hours)} h at this pace, but Comment is only on for ${Math.round(open)} h a day - it will stop short`);
    const ag = $("#cmtAggressive");
    if (ag) { ag.hidden = !warn.length; ag.textContent = warn.length ? "Careful: " + warn.join(" · ") + "." : ""; }

    // the day's spend cap field label
    const df = $("#cmtDailyField .hint");
    if (df && s.cmtDaily > 200) df.classList.add("warn"); else if (df) df.classList.remove("warn");
  }

  // =====================================================================
  // COMMENT HISTORY
  // =====================================================================
  async function renderHistory() {
    await load(true);
    if (!cs) return;
    const s = sOf();
    const days = cs.days || {};
    const keys = Object.keys(days).sort();
    const all = cs.all || 0;
    const first = keys[0] || "";
    const nDays = keys.length || 1;
    const likes = Object.values(days).reduce((a, x) => a + (x.likes || 0), 0);
    setHtml("chHero", $("#chHero"), `<div>
        <span class="kicker">All-time replies</span>
        <h2>${fmt(all)}</h2>
        <p>${first ? `since ${U.date(new Date(first + "T12:00:00").getTime())} · ${nDays} day${nDays === 1 ? "" : "s"} · ${Math.round(all / nDays)} a day on average` : "no replies yet"}</p>
      </div>
      <div class="cmt-boxes">
        <div class="cmt-box"><small>Likes on my replies</small><b>${fmt(likes)}</b></div>
        <div class="cmt-box"><small>All-time AI cost</small><b>${money(cs.allCost || 0)}</b><span>${taka(cs.allCost || 0, s.cmtRate)}</span></div>
      </div>`);

    const today = GX.cmtDayKey(Date.now());
    const d0 = days[today] || {};
    const yKey = GX.cmtDayKey(Date.now() - DAY);
    const d1 = days[yKey] || {};
    const weekStart = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); })();
    const sumFrom = (ms) => keys.filter((k) => new Date(k + "T12:00:00").getTime() >= ms).reduce((a, k) => a + (days[k].posted || 0), 0);
    const monthStart = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(1); return d.getTime(); })();
    setHtml("chKpis", $("#chKpis"), `
      <div class="card kpi"><div><small>Today</small><b class="num">${fmt(d0.posted || 0)}</b><span>${(st.cmt && st.cmt.left) ? `still going · ${fmt(st.cmt.left)} to the goal` : "the goal is done"}</span></div></div>
      <div class="card kpi"><div><small>Yesterday</small><b class="num">${fmt(d1.posted || 0)}</b><span>${U.date(Date.now() - DAY)}</span></div></div>
      <div class="card kpi"><div><small>This week</small><b class="num">${fmt(sumFrom(weekStart))}</b><span>Mon – today</span></div></div>
      <div class="card kpi"><div><small>This month</small><b class="num">${fmt(sumFrom(monthStart))}</b><span>${new Date().toLocaleDateString([], { month: "long" })}</span></div></div>`);

    const span = ui.range || 14;
    const list = [];
    if (span) { for (let i = span - 1; i >= 0; i--) { const k = GX.cmtDayKey(Date.now() - i * DAY); list.push([k, days[k] || {}]); } }
    else for (const k of keys) list.push([k, days[k]]);
    const max = Math.max(1, ...list.map(([, v]) => v.posted || 0));
    setHtml("chBars", $("#chBars"), list.map(([k, v]) => {
      const n = v.posted || 0;
      const isToday = k === today;
      return `<div class="cb ${isToday ? "today" : ""} ${n ? "" : "zero"}"><b>${n || 0}</b><i style="height:${Math.round((n / max) * 130)}px"></i><small>${isToday ? "today" : new Date(k + "T12:00:00").getDate()}</small></div>`;
    }).join(""));
    const sub = $("#chChartSub"); if (sub) sub.textContent = span ? `last ${span} days` : "every day";

    // day by day, with the running total
    let run = 0;
    const rowsAsc = keys.map((k) => { run += days[k].posted || 0; return [k, days[k], run]; });
    const show = span ? rowsAsc.slice(-span) : rowsAsc;
    setHtml("chRows", $("#chRows"), show.slice().reverse().map(([k, v, total]) => {
      const dt = new Date(k + "T12:00:00");
      return `<div class="trow cd-cols cd-row ${k === today ? "today" : ""} ${v.posted ? "" : "rest"}">
        <span><b>${dt.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}</b>${k === today ? ' <em class="muted">today</em>' : ""}</span>
        <span><b>${fmt(v.posted || 0)}</b></span><span>${fmt(v.drafts || 0)}</span><span>${fmt(v.skipped || 0)}</span><span>${fmt(v.failed || 0)}</span>
        <span>${fmt(v.likes || 0)}</span><span>${money(v.cost || 0)}</span><span><b>${fmt(total)}</b></span></div>`;
    }).join("") || `<div class="empty"><b>No replies yet</b><p>Post your first reply and this page fills in by itself.</p></div>`);

    setHtml("chBackup", $("#chBackup"), `<div class="card-head"><div><b>Your history is safe</b><small>saved in this browser, through restarts, sleep and GrowX updates</small></div></div>
      <p class="hint">Every post you replied to is kept forever, which is what makes "one post, one reply" work. Day totals never go down, and a restore <b>merges</b> - it can only raise a total, never lower it.</p>
      <p class="hint">Automatic backup to <b>Downloads/GrowX/</b> every day${cs.backupAt ? ` · last backup <b>${U.dateTime(cs.backupAt)}</b>` : " · the first one runs tonight"}.</p>
      <div class="btn-row"><button class="btn btn-primary" id="chBackupNow">${U.icon("download")}<span>Back up now</span></button><button class="btn" id="chRestore">${U.icon("upload")}<span>Restore from file</span></button></div>
      <p class="hint warn">Removing GrowX or clearing your browser data deletes the copy in the browser. The backup file brings it all back.</p>`);
  }

  // =====================================================================
  // Events
  // =====================================================================
  async function saveOne(patch, quiet) {
    const r = await U.cmd("saveSettings", { patch, noStart: true });
    if (!r || !r.ok) { U.toast((r && r.error) || "Couldn't save that.", "bad"); return null; }
    if (st) st.settings = r.settings;
    if (!quiet) syncSettings();
    return r;
  }
  // Any pace number typed by hand means the pace is yours, not a card's.
  const PACE_KEYS = new Set(Object.keys(GX.CMT_PRESETS.balanced));

  async function onChange(e) {
    const el = e.target;
    if (!el || !el.dataset) return;

    // the Comment-mode switch on the Comment page
    if (el.dataset.ck === "cmtOn") { await saveOne({ cmtOn: el.checked }, true); renderCtl(); return; }

    if (el.dataset.ck && (el.closest("#cmtSettings") || el.closest("#ovCmt"))) {
      const k = el.dataset.ck;
      let v;
      if (el.type === "checkbox") v = el.checked;
      else if (el.type === "time") v = el.value;
      else if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") v = el.value;
      else if (el.type === "text" || el.type === "password" || k in GX.CMT_TEXTS) v = el.value;
      else if (k === "cmtTemp") v = Number(el.value);
      else {
        // A timing box may be typed in minutes; it is always kept in seconds.
        const inMin = el.dataset.sec && sOf().cmtUnit === "min";
        v = Math.round(Number(el.value) * (inMin ? 60 : 1));
        const [lo, hi] = GX.CMT_LIMITS[k] || [0, 1e9];
        if (!Number.isFinite(v) || v < lo || v > hi) {
          const u = inMin ? "minute" : "second";
          const sl = inMin ? Math.round((lo / 60) * 10) / 10 : lo, sh = inMin ? Math.round((hi / 60) * 10) / 10 : hi;
          markBad(el, `Give a number of ${u}s between ${sl} and ${sh}.`);
          return;
        }
      }
      markBad(el, "");
      const patch = { [k]: v };
      if (PACE_KEYS.has(k)) patch.cmtPace = "custom";
      await saveOne(patch, el.tagName === "TEXTAREA");
      if (el.closest("#ovCmt")) { ui.html.ovCmt = ""; renderOvCmt(); }
      return;
    }
    if (el.id === "cmtSpend") {
      const cents = Math.round(Number(el.value) * 100);
      if (!Number.isFinite(cents) || cents < 1) return markBad(el, "Give an amount of at least $0.01.");
      markBad(el, "");
      await saveOne({ cmtSpendCents: cents });
      return;
    }
    if (el.dataset.cwatch !== undefined) { await cmd("watchSet", { h: el.dataset.cwatch, on: el.checked }); return; }
    if (el.dataset.tg) { await cmd("tgSet", { on: { [el.dataset.tg]: el.checked } }); return; }
    if (el.dataset.cedit !== undefined) { await cmd("edit", { id: el.dataset.cedit, text: el.value }); return; }
  }

  function onInput(e) {
    const el = e.target;
    if (el && el.dataset && el.dataset.ck === "cmtTemp") { const v = $("#cmtTempVal"); if (v) v.textContent = Number(el.value).toFixed(1); }
  }

  function markBad(el, why) {
    el.classList.toggle("bad", !!why);
    const field = el.closest(".field") || el.parentElement;
    let note = field && field.querySelector(".why-bad");
    if (!why) { if (note) note.remove(); return; }
    if (!note && field) { note = document.createElement("span"); note.className = "why-bad"; field.appendChild(note); }
    if (note) note.textContent = why;
  }

  async function onClick(e) {
    const t = e.target;
    const close = (sel) => t.closest && t.closest(sel);

    // Start on a mode card: switch to that mode and begin. While something is
    // already running, the engine picks the new mode up on its next step.
    const ms = close("[data-mstart]");
    if (ms) {
      const m = ms.dataset.mstart;
      ms.disabled = true;
      const live = st.job && ["running", "resting", "sleeping"].includes(st.job.status);
      // v3.2: Comment says what is missing instead of switching over and doing nothing.
      if (m === "comment") {
        const pf = await cmd("preflight", { text: "" });
        if (pf && pf.ok && !pf.canStart) {
          ms.disabled = false;
          const first = pf.items.find((x) => x.block);
          U.toast(`Comment can't start yet: ${first ? first.text : "something is missing"}. The Comment page shows what to fix.`, "bad", 6500);
          location.hash = "#comment";
          return;
        }
      }
      let r;
      if (live) r = await U.cmd("saveSettings", { patch: { runMode: m } });
      else r = await U.cmd("start", { mode: m });
      ms.disabled = false;
      if (!r || !r.ok) {
        U.toast((r && r.error) || "Couldn't start that mode.", "bad", 5000);
        if (r && r.needSources) location.hash = "#sources";
        if (r && (r.needKey || r.cmtOff)) location.hash = "#comment";
        return;
      }
      U.toast(live ? `Switched to ${MODE_META[m].name} mode - it takes over on the next step.` : `${MODE_META[m].name} mode started. You can close this page.`, "good", 4500);
      if (window.GXD && GXD.refresh) GXD.refresh();
      return;
    }

    if (close("#cmtGoBtn")) { cmtGoClick(); return; }
    const fx = close("[data-cfix]");
    if (fx) { cmtFix(fx.dataset.cfix); return; }

    if (close("#ovcAdd")) {
      const box = $("#ovcText");
      const r = await cmd("add", { text: box.value, src: "links" });
      if (!r || !r.ok) return U.toast("Couldn't add those.", "bad");
      U.toast(r.added ? `${r.added} post${r.added === 1 ? "" : "s"} added to the comment queue.` : "Nothing new in there - every link was a duplicate or already replied to.", r.added ? "good" : "warn");
      if (r.added) box.value = "";
      ovcPreview();
      await load(true);
      if (window.GXD && GXD.refresh) GXD.refresh();
      return;
    }
    if (close("#ovcTargetAdd")) {
      const box = $("#ovcTarget");
      if (!box.value.trim()) return U.toast("Type an account, like @creator.", "bad");
      const btn = close("#ovcTargetAdd");
      btn.disabled = true;
      const r = await cmd("targetAdd", { text: box.value });
      btn.disabled = false;
      if (r && r.ok && r.added) { box.value = ""; U.toast(`Added${r.queued ? " · it went to the front of the Follow queue" : ""}.`, "good"); await load(true); ui.html.ovCmt = ""; renderOvCmt(); }
      else U.toast((r && r.bad && r.bad.length) ? `Couldn't look up @${r.bad[0]} on X.` : "Nothing new to add.", "warn");
      return;
    }

    const tab = close("[data-ctab]");
    if (tab) { ui.tab = tab.dataset.ctab; renderTabs(); renderComment(); return; }

    const f = close("#cmtFilter [data-f]");
    if (f) { ui.filter = f.dataset.f; $$("#cmtFilter button").forEach((x) => x.classList.toggle("on", x === f)); ui.show = 60; renderRows(); return; }

    if (close("#cmtMoreBtn")) { ui.show += 60; renderRows(); return; }

    if (close("#cmtAdd")) {
      const box = $("#cmtText");
      const r = await cmd("add", { text: box.value, src: "links" });
      if (!r || !r.ok) return U.toast("Couldn't add those.", "bad");
      U.toast(r.added ? `${r.added} post${r.added === 1 ? "" : "s"} added to the queue.` : "Nothing new in there - every link was a duplicate or already replied to.", r.added ? "good" : "warn");
      if (r.added) box.value = "";
      previewPaste();
      await load(true); renderComment();
      return;
    }
    if (close("#cmtClear")) { $("#cmtText").value = ""; previewPaste(); return; }
    if (close("#cmtImport")) { importCsv(); return; }
    if (close("#cmtExport")) { exportQueue(); return; }

    const act = close("[data-cact]");
    if (act) { await rowAction(act.dataset.cact, act.dataset.id, act.dataset.h, act); return; }

    if (close("#cmtWatchAdd")) {
      const box = $("#cmtWatchText");
      const r = await cmd("watchAdd", { text: box.value });
      if (r && r.ok) { U.toast(r.added ? `${r.added} account${r.added === 1 ? "" : "s"} added to the watch list.` : "Nothing new to add.", r.added ? "good" : "warn"); box.value = ""; await load(true); renderWatch(); renderTabs(); }
      return;
    }
    if (close("#cmtTargetAdd")) {
      const box = $("#cmtTargetText");
      const r = await cmd("targetAdd", { text: box.value });
      if (r && r.ok) { U.toast(r.added ? `${r.added} added${r.queued ? ` · ${r.queued} went to the front of the Follow queue` : ""}.` : "Nothing new to add.", r.added ? "good" : "warn"); box.value = ""; await load(true); renderTargets(); renderTabs(); }
      return;
    }

    // ---- settings ----
    const pre = close("[data-cpreset]");
    if (pre) {
      const k = pre.dataset.cpreset;
      if (k === "custom") { const el = $('[data-ck="cmtDaily"]'); if (el) el.focus(); return; }
      await saveOne(Object.assign({ cmtPace: k }, GX.CMT_PRESETS[k]));
      U.toast(`${GX.CMT_PRESET_INFO[k].name} comment pace applied.`, "good");
      return;
    }
    const pub = close("[data-cpub]");
    if (pub) { await saveOne({ cmtPublish: pub.dataset.cpub }); U.toast(pub.dataset.cpub === "auto" ? "GrowX will post the replies itself." : "GrowX will only write the replies - you post them.", "good"); return; }
    const when = close("[data-cwhen]");
    if (when) { await saveOne({ cmtStartNow: when.dataset.cwhen === "now" }); return; }
    const rule = close("[data-crule]");
    if (rule) { const k = rule.dataset.crule; await saveOne({ [k]: !sOf()[k] }); return; }
    const mdl = close("[data-cmodel]");
    if (mdl) { await saveOne({ cmtModel: mdl.dataset.cmodel }); return; }
    const day = close("[data-cday]");
    if (day) {
      const s = sOf();
      if (day.dataset.cday === "same") await saveOne({ cmtDays: [] });
      else {
        const i = Number(day.dataset.cday);
        const cur = (s.cmtDays || []).length ? s.cmtDays.slice() : GX.modeDays(s, "comment").slice();
        const at = cur.indexOf(i);
        if (at >= 0) cur.splice(at, 1); else cur.push(i);
        await saveOne({ cmtDays: cur.length ? cur.sort((a, b) => a - b) : [0, 1, 2, 3, 4, 5, 6] });
      }
      return;
    }
    if (close("#cmtKeySave")) { await saveKey($("#cmtKey").value.trim(), true); return; }

    const dl = close("[data-ovcdellink]");
    if (dl) {
      const r = await cmd("remove", { ids: [dl.dataset.ovcdellink] });
      if (r && r.ok) { U.toast("Link removed from the queue.", "good"); await load(true); ui.html.ovCmt = ""; renderOvCmt(); if (window.GXD && GXD.refresh) GXD.refresh(); }
      return;
    }
    const dt = close("[data-ovcdeltarget]");
    if (dt) {
      const r = await cmd("targetDel", { h: dt.dataset.ovcdeltarget });
      if (r && r.ok) { U.toast(`@${dt.dataset.ovcdeltarget} removed.`, "good"); await load(true); ui.html.ovCmt = ""; renderOvCmt(); if (window.GXD && GXD.refresh) GXD.refresh(); }
      return;
    }
    if (close("#ovcClearLinks")) {
      // only the ones listed - a post already replied to is history and stays
      const ids = (((st.cmt || {}).links || {}).rows || []).map((x) => x.i);
      if (!ids.length) return;
      if (!confirm(`Remove ${ids.length} link${ids.length === 1 ? "" : "s"} that have not been replied to yet? Replies already posted are kept.`)) return;
      const r = await cmd("remove", { ids });
      if (r && r.ok) { U.toast(`${r.removed} removed.`, "good"); await load(true); ui.html.ovCmt = ""; renderOvCmt(); if (window.GXD && GXD.refresh) GXD.refresh(); }
      return;
    }
    if (close("#ovcClearTargets")) {
      if (!confirm("Remove every target account? Accounts you already followed stay followed.")) return;
      const r = await cmd("targetDel", { all: true });
      if (r && r.ok) { U.toast("Target accounts removed.", "good"); await load(true); ui.html.ovCmt = ""; renderOvCmt(); if (window.GXD && GXD.refresh) GXD.refresh(); }
      return;
    }

    const un = close("[data-cunit]");
    if (un) { await saveOne({ cmtUnit: un.dataset.cunit }); return; }

    const tp = close("[data-ctime]");
    if (tp) {
      const r = await cmd("timeApply", { name: tp.dataset.ctime });
      if (r && r.ok) { st.settings = r.settings; syncSettings(); U.toast(`Timings set to "${tp.dataset.ctime}".`, "good"); await load(true); syncSettings(); }
      else U.toast((r && r.error) || "Could not apply that set.", "bad");
      return;
    }

    const td = close("[data-ctimedel]");
    if (td) {
      const name = td.dataset.ctimedel;
      if (!confirm(`Delete the timing set "${name}"? Your current timings do not change.`)) return;
      const r = await cmd("timeDelete", { name });
      if (r && r.ok) { if (cs) cs.timings = r.timings; renderTimePresets(sOf()); U.toast("Set deleted.", "good"); }
      return;
    }

    if (close("#cmtTimeSave")) {
      const el = $("#cmtTimeName");
      const name = el.value.trim();
      const r = await cmd("timeSave", { name });
      if (!r || !r.ok) { U.toast((r && r.error) || "Could not save it.", "bad"); return; }
      el.value = "";
      if (cs) cs.timings = r.timings;
      renderTimePresets(sOf());
      U.toast(`Saved as "${name}".`, "good");
      return;
    }
    if (close("#cmtKeyCheck")) {
      const el = $("#cmtKeyState");
      el.innerHTML = '<span class="st-pill st-waiting">Checking…</span>';
      const r = await cmd("checkKey", { key: $("#cmtKey").value.trim() });
      el.innerHTML = r && r.ok ? '<span class="ok-badge">Key works</span>' : `<span class="st-pill st-failed">${esc((r && r.error) || "no answer")}</span>`;
      return;
    }
    if (close("#cmtTest")) {
      const out = $("#cmtTestOut");
      const link = $("#cmtTestLink").value.trim();
      out.innerHTML = '<p class="hint">Reading the post and writing one reply… nothing is posted and nothing is saved.</p>';
      const r = await cmd("test", { link });
      if (!r || !r.ok) { out.innerHTML = `<div class="aggressive">${esc((r && r.error) || "That did not work.")}</div>`; return; }
      out.innerHTML = `<div class="blk card" style="margin-top:10px">
        <p class="hint"><b>What the AI read:</b> ${esc(r.read || "(one step only)")}</p>
        <p class="hint"><b>The post:</b> ${esc(String(r.post.text || "").slice(0, 300))}</p>
        <p><b>The reply:</b> ${r.draft ? esc(r.draft) : `<span class="st-pill st-failed">${esc(r.why)}</span>`}</p>
        ${(r.rejects || []).length ? `<p class="hint"><b>Rewritten because:</b> ${esc(r.rejects.map((x) => (x.b || []).join(", ")).join(" | "))}</p>` : ""}
        <p class="hint">This test cost ${money(r.cost)} (${taka(r.cost, sOf().cmtRate)}).</p></div>`;
      U.icons(out);
      return;
    }
    if (close("#tgSave")) {
      const patch = { chat: $("#tgChat").value.trim(), dailyAt: $("#tgDaily").value || "22:00" };
      const tok = $("#tgToken").value.trim();
      if (tok) patch.token = tok;
      await cmd("tgSet", patch);
      $("#tgToken").value = "";
      U.toast("Telegram settings saved.", "good");
      return;
    }
    if (close("#tgTest")) {
      const el = $("#tgState");
      el.innerHTML = '<span class="st-pill st-waiting">Sending…</span>';
      const r = await cmd("tgTest");
      el.innerHTML = r && r.ok ? '<span class="ok-badge">Sent - check Telegram</span>' : `<span class="st-pill st-failed">${esc((r && r.error) || "could not send")}</span>`;
      return;
    }

    // ---- history ----
    const rng = close("#chRange [data-r]");
    if (rng) { ui.range = Number(rng.dataset.r); $$("#chRange button").forEach((x) => x.classList.toggle("on", x === rng)); ui.html = {}; renderHistory(); return; }
    if (close("#chBackupNow")) {
      const r = await cmd("backup");
      if (r && r.ok) { U.download(`growx-comments-${GX.cmtDayKey(Date.now())}.json`, JSON.stringify(r.data), "application/json"); U.toast("Backup saved to your downloads.", "good"); }
      return;
    }
    if (close("#chRestore")) { restoreFile(); return; }
    if (close("#chExport")) { exportDays(); return; }
  }

  async function rowAction(act, id, h, btn) {
    if (btn) btn.disabled = true;
    try {
      if (act === "panel") return openPanel(id);
      if (act === "copy") {
        const r = await cmd("row", { id });
        if (r && r.ok && r.row) { await U.copy(r.row.draft || ""); U.toast("Reply copied.", "good"); }
        return;
      }
      if (act === "open") {
        const r = await cmd("row", { id });
        if (!r || !r.ok || !r.row) return;
        window.open(GX.postUrl(id, r.row.h), "_blank", "noopener");
        await U.copy(r.row.draft || "");
        U.toast("The post is open and the reply is on your clipboard - paste it and press Reply.", "good", 6000);
        return;
      }
      if (act === "posted") { const r = await cmd("posted", { id }); if (r && r.ok) { U.toast("Counted as posted.", "good"); await load(true); renderRows(); } return; }
      if (act === "retry") { const r = await cmd("retry", { ids: [id] }); if (r && r.ok) { U.toast("It goes back into the queue.", "good"); renderRows(); } return; }
      if (act === "skip") { const r = await cmd("skip", { ids: [id] }); if (r && r.ok) renderRows(); return; }
      if (act === "remove") { const r = await cmd("remove", { ids: [id] }); if (r && r.ok) renderRows(); return; }
      if (act === "watchDel") { await cmd("watchDel", { h }); await load(true); renderWatch(); renderTabs(); return; }
      if (act === "targetDel") { await cmd("targetDel", { h }); await load(true); renderTargets(); renderTabs(); return; }
    } finally { if (btn) btn.disabled = false; }
  }

  // ---- files -----------------------------------------------------------
  function pickFile(accept, fn) {
    const i = document.createElement("input");
    i.type = "file"; i.accept = accept;
    i.onchange = () => { const f = i.files && i.files[0]; if (f) { const r = new FileReader(); r.onload = () => fn(String(r.result || "")); r.readAsText(f); } };
    i.click();
  }
  function importCsv() {
    pickFile(".csv,.txt", async (text) => {
      const r = await cmd("add", { text, src: "links" });
      U.toast(r && r.ok ? `${r.added} post${r.added === 1 ? "" : "s"} added from the file.` : "Couldn't read that file.", r && r.added ? "good" : "warn");
      await load(true); renderComment();
    });
  }
  function restoreFile() {
    pickFile(".json", async (text) => {
      let data;
      try { data = JSON.parse(text); } catch (_) { return U.toast("That file isn't a GrowX comment backup.", "bad"); }
      const r = await cmd("restore", { data });
      U.toast(r && r.ok ? "Restored and merged - no total went down." : (r && r.error) || "Couldn't restore that file.", r && r.ok ? "good" : "bad");
      await load(true); renderHistory();
    });
  }
  function exportQueue() {
    const rows = ui.rows.map((x) => [x.id, x.h, x.src, x.st, x.draft || "", x.skip || x.fail || "", x.postedAt ? new Date(x.postedAt).toISOString() : "", x.cost || 0, (x.stats && x.stats.likes) || "", (x.stats && x.stats.views) || ""]);
    U.download(`growx-comment-queue-${GX.cmtDayKey(Date.now())}.csv`, U.csv(["post id", "handle", "source", "status", "reply", "reason", "posted at", "ai cost", "likes", "views"], rows), "text/csv");
  }
  function exportDays() {
    const days = (cs && cs.days) || {};
    let run = 0;
    const rows = Object.keys(days).sort().map((k) => { const v = days[k]; run += v.posted || 0; return [k, v.posted || 0, v.drafts || 0, v.skipped || 0, v.failed || 0, v.likes || 0, (v.cost || 0).toFixed(5), run]; });
    U.download(`growx-comment-history-${GX.cmtDayKey(Date.now())}.csv`, U.csv(["day", "replies", "drafts", "skipped", "failed", "likes", "ai cost usd", "running total"], rows), "text/csv");
  }

  window.GXC = { init, render, common, renderModeCards, renderOvCmt };
  // dashboard.js has already run its own init() by the time this file loads, so the
  // Comment page wires itself up here.
  init();
})();
