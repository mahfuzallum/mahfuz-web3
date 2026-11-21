// GrowX - shared UI helpers for the popup and the dashboard.
(function () {
  "use strict";

  const U = {};

  U.$ = (sel, root) => (root || document).querySelector(sel);
  U.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  U.cmd = (cmd, extra) =>
    chrome.runtime.sendMessage(Object.assign({ cmd }, extra || {}))
      .then((r) => r || { ok: false, error: "No answer from the extension." })
      .catch((e) => ({ ok: false, error: String(e && e.message || e) }));

  U.get = async (key, fallback) => {
    try { const r = await chrome.storage.local.get(key); return r[key] === undefined ? fallback : r[key]; }
    catch (_) { return fallback; }
  };

  U.watch = (keys, fn) => {
    const set = new Set(keys);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (Object.keys(changes).some((k) => set.has(k))) fn(changes);
    });
  };

  U.esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  U.fmt = (n) => (n == null || Number.isNaN(Number(n))) ? "-" : Math.round(Number(n)).toLocaleString();
  U.compact = (n) => {
    if (n == null || Number.isNaN(Number(n))) return "-";
    n = Number(n);
    const a = Math.abs(n), sg = n < 0 ? "-" : "";
    if (a >= 1e6) return sg + (a / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
    if (a >= 1e4) return sg + Math.round(a / 1e3) + "K";
    if (a >= 1e3) return sg + (a / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
    return sg + String(Math.round(a));
  };
  U.pct = (x, digits) => (x == null || !Number.isFinite(x)) ? "-" : (x * 100).toFixed(digits == null ? 0 : digits) + "%";
  U.signed = (n) => (n == null ? "-" : (n > 0 ? "+" : "") + U.fmt(n));

  U.ago = (ts) => {
    if (!ts) return "never";
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 45) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return m + " min ago";
    const h = Math.round(m / 60);
    if (h < 24) return h + " h ago";
    const d = Math.round(h / 24);
    return d + (d === 1 ? " day ago" : " days ago");
  };

  U.dur = (sec) => {
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return sec + "s";
    const m = Math.floor(sec / 60), s = sec % 60;
    if (m < 60) return m + "m" + (s ? " " + String(s).padStart(2, "0") + "s" : "");
    const h = Math.floor(m / 60);
    if (h < 48) return h + "h " + String(m % 60).padStart(2, "0") + "m";
    return Math.floor(h / 24) + "d " + (h % 24) + "h";
  };
  U.countdown = (ms) => {
    const sec = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  };

  U.clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  U.date = (ts) => new Date(ts).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
  U.dateTime = (ts) => new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  // Animate a number from its current value to `to`.
  U.countTo = (el, to, fmt) => {
    if (!el) return;
    const f = fmt || U.fmt;
    const target = Number(to);
    if (to == null || !Number.isFinite(target)) { el.textContent = f(to); el.dataset.n = ""; return; }
    const from = Number(el.dataset.n || 0);
    el.dataset.n = String(target);
    if (from === target || matchMedia("(prefers-reduced-motion: reduce)").matches) { el.textContent = f(target); return; }
    const t0 = performance.now(), dur = Math.min(900, 250 + Math.abs(target - from) * 4);
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = f(from + (target - from) * e);
      if (k < 1 && el.dataset.n === String(target)) requestAnimationFrame(step);
      else if (k >= 1) el.textContent = f(target);
    };
    requestAnimationFrame(step);
  };

  U.copy = async (text) => {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (_) {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch (__) {}
      ta.remove();
      return ok;
    }
  };

  // Theme toggle buttons: any [data-theme-toggle] flips light/dark.
  U.themeButtons = (root) => U.$$("[data-theme-toggle]", root).forEach((b) => {
    if (b.dataset.themeWired) return;
    b.dataset.themeWired = "1";
    b.classList.add("theme-btn");
    b.insertAdjacentHTML("afterbegin", U.icon("sun", "ic-sun") + U.icon("moon", "ic-moon"));
    const label = () => b.setAttribute("aria-label", window.GXTheme && GXTheme.current() === "dark" ? "Switch to light mode" : "Switch to dark mode");
    label();
    b.title = "Light / dark mode";
    b.addEventListener("click", () => { if (window.GXTheme) GXTheme.toggle(); label(); });
    window.addEventListener("gx-theme", label);
  });

  U.bigAvatar = (url) => String(url || "").replace(/_normal(\.\w+)$/, "_bigger$1");

  // Avatar with an initial-letter fallback (no inline handlers: CSP).
  U.avatar = (url, name, size) => {
    const wrap = document.createElement("span");
    wrap.className = "avatar";
    if (size) { wrap.style.width = wrap.style.height = size + "px"; wrap.style.fontSize = Math.round(size * 0.4) + "px"; }
    const letter = (String(name || "?").replace(/^@/, "").trim()[0] || "?").toUpperCase();
    if (url) {
      const img = document.createElement("img");
      img.alt = "";
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      img.addEventListener("error", () => { img.remove(); wrap.textContent = letter; }, { once: true });
      img.src = U.bigAvatar(url);
      wrap.appendChild(img);
    } else {
      wrap.textContent = letter;
    }
    return wrap;
  };
  U.avatarHtml = (url, name, size) => U.avatar(url, name, size).outerHTML;

  let toastHost = null;
  U.toast = (msg, kind, ms) => {
    if (!toastHost) {
      toastHost = document.createElement("div");
      toastHost.className = "toast-host";
      toastHost.setAttribute("role", "status");
      document.body.appendChild(toastHost);
    }
    const t = document.createElement("div");
    t.className = "toast" + (kind ? " " + kind : "");
    t.innerHTML = U.icon(kind === "bad" ? "alert" : kind === "good" ? "check" : "info") + "<span></span>";
    t.lastChild.textContent = msg;
    toastHost.appendChild(t);
    setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 260); }, ms || 3400);
  };

  U.csvCell = (v) => {
    const s = String(v == null ? "" : v);
    return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? '"' + s.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1") + '"' : s;
  };
  U.csv = (header, rows) => [header.map(U.csvCell).join(","), ...rows.map((r) => r.map(U.csvCell).join(","))].join("\r\n");

  U.download = (filename, text, mime) => {
    const blob = new Blob([(mime && /json/.test(mime) ? "" : "﻿") + text], { type: mime || "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  // Pull @handles / profile links / bare usernames out of free text or CSV.
  U.handlesFrom = (text) => {
    const out = [], seen = new Set();
    let bad = 0;
    for (const part of String(text || "").split(/[\s,;|]+/)) {
      if (!part.trim()) continue;
      const h = GX.cleanHandle(part);
      if (!h) { bad++; continue; }
      const k = h.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(h);
    }
    return { handles: out, bad };
  };

  // Status of the engine, for pills and colours.
  U.jobView = (job, task) => {
    if (job && ["running", "resting", "sleeping", "paused", "halted"].includes(job.status)) {
      const map = {
        running: ["run", "Running"],
        resting: ["rest", job.restReason === "rate" || job.restReason === "limit" || job.restReason === "automation" || job.restReason === "soft" || job.restReason === "failure" ? "Safety rest" : job.restReason === "daily" ? "Daily cap" : job.restReason === "hourly" ? "Hourly pace" : job.restReason === "cap" ? "Following cap" : job.restReason === "empty" ? "Waiting for people" : job.restReason === "switch" ? "Switching mode" : job.restReason === "read" ? "Waiting for X" : "On a break"],
        sleeping: ["sleep", "Sleeping"],
        paused: ["paused", "Paused"],
        halted: ["halt", "Needs attention"]
      };
      const [cls, label] = map[job.status];
      const swap = job.status === "resting" && job.restReason === "switch";
      return { cls: swap ? "swap" : cls, label, active: job.status !== "paused" && job.status !== "halted", paused: job.status === "paused", halted: job.status === "halted", swap };
    }
    if (task && task.status === "running") return { cls: "task", label: task.kind === "harvest" ? "Finding people" : "Checking follow-backs", active: false, task: true };
    return { cls: "idle", label: job && job.status === "done" ? "Finished" : "Ready", active: false };
  };

  // ---- icons (24px stroke) ----
  const P = {
    home: '<path d="M3.5 10.5 12 3.5l8.5 7"/><path d="M5.5 9v11h13V9"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18.5 14.8c1.6.8 2.7 2.6 3 5.2"/>',
    userPlus: '<circle cx="10" cy="8" r="3.5"/><path d="M3.5 20c.8-3.5 3.4-5.5 6.5-5.5 1.4 0 2.7.4 3.8 1.1"/><path d="M18 13.5v6M15 16.5h6"/>',
    userX: '<circle cx="10" cy="8" r="3.5"/><path d="M3.5 20c.8-3.5 3.4-5.5 6.5-5.5 1.4 0 2.7.4 3.8 1.1"/><path d="m16.5 14.5 4 4m0-4-4 4"/>',
    userMinus: '<circle cx="10" cy="8" r="3.5"/><path d="M3.5 20c.8-3.5 3.4-5.5 6.5-5.5 1.4 0 2.7.4 3.8 1.1"/><path d="M15 16.5h6"/>',
    swap: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
    target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r=".8" fill="currentColor"/>',
    layers: '<path d="m12 3.5 8.5 4.5-8.5 4.5L3.5 8z"/><path d="m3.5 12 8.5 4.5 8.5-4.5"/><path d="m3.5 16 8.5 4.5 8.5-4.5"/>',
    list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="4.5" cy="6.5" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="17.5" r="1"/>',
    filter: '<path d="M4 5h16l-6.2 7.4V19l-3.6-1.8v-4.8z"/>',
    gauge: '<path d="M4.2 17a8.5 8.5 0 1 1 15.6 0"/><path d="m12 13 4-4.5"/><circle cx="12" cy="13" r="1.4"/>',
    chart: '<path d="M4 4v16h16"/><path d="m7.5 14.5 3.5-4 3 2.5 5-6"/>',
    trend: '<path d="m3.5 16.5 6-6 4 4 7-7"/><path d="M15 7.5h5.5V13"/>',
    bars: '<path d="M5 20V11M10 20V5M15 20v-7M20 20V8"/>',
    history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 4v4.5H8"/><path d="M12 8v4l3 2"/>',
    sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
    shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.2 7.5 9.5 4.4-1.3 7.5-4.9 7.5-9.5V6z"/><path d="m9 12 2 2 4-4"/>',
    help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8 1c0 1.7-2.4 2.2-2.4 3.7"/><path d="M12 17h.01"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8h.01"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none"/>',
    pause: '<path d="M8.5 5.5v13M15.5 5.5v13" stroke-width="2.4"/>',
    stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2.2" fill="currentColor" stroke="none"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.6-4.6L4 8"/><path d="M4 3.5V8h4.5"/><path d="M4 13a8 8 0 0 0 14.6 4.6L20 16"/><path d="M20 20.5V16h-4.5"/>',
    download: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
    upload: '<path d="M12 15V4"/><path d="m7 9 5-5 5 5"/><path d="M5 20h14"/>',
    external: '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    badge: '<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m9 12 2 2 4-4"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    bolt: '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/>',
    rocket: '<path d="M12 15c-1-1-2.5-3.4-2-6.5C10.6 5 13 3 16.5 3c.3 3.5-1.6 6-5 7.5"/><path d="M9.5 12.5 7 15l2 2 2.5-2.5M6.5 17.5 4 20M9 14l-4-1 3-3"/><path d="M14 11l1 4-3 3"/>',
    sparkles: '<path d="M12 4.5 13.6 9 18 10.5l-4.4 1.6L12 16.5l-1.6-4.4L6 10.5 10.4 9z"/><path d="M19 3v4M17 5h4"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    calendar: '<rect x="4" y="5.5" width="16" height="14.5" rx="2.2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
    moonZ: '<path d="M19 14.2A7.3 7.3 0 1 1 9.8 5a5.8 5.8 0 0 0 9.2 9.2z"/><path d="M15 4h4l-4 4h4"/>',
    flame: '<path d="M12 21c-3.6 0-6-2.4-6-5.6 0-3.4 2.6-5.3 3.5-8.4.5 1.6 1.5 2.7 2.5 3.3.4-2.4 1.5-4.6 3.5-6.3-.2 3 2.5 5.4 2.5 9.4 0 4.3-2.6 7.6-6 7.6z"/><path d="M12 21c-1.7 0-2.8-1.2-2.8-2.8 0-1.8 1.6-2.7 2.3-4.2.9 1.4 3.3 2.2 3.3 4.4 0 1.5-1.2 2.6-2.8 2.6z"/>',
    award: '<circle cx="12" cy="9" r="5.5"/><path d="m8.5 13.5-1.5 7 5-2.5 5 2.5-1.5-7"/>',
    crown: '<path d="M4 18h16M5 18 3.5 7.5l5 4 3.5-6 3.5 6 5-4L19 18"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    pin: '<path d="M9.5 3.5h5l-.8 5.5 3.3 3v1.5H7V12l3.3-3z"/><path d="M12 13.5V20"/>',
    ban: '<circle cx="12" cy="12" r="8.5"/><path d="m6 6 12 12"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    send: '<path d="M21 4 3 11l6.5 2.5L12 20l3.2-4.2L19 19z"/><path d="m9.5 13.5 5-4"/>',
    alert: '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4M12 17h.01"/>',
    heart: '<path d="M12 20s-7.5-4.4-7.5-10A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 7.5 3c0 5.6-7.5 10-7.5 10z"/>',
    star: '<path d="m12 4 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.6-4.8 2.6.9-5.4L4.2 9.7l5.4-.8z"/>',
    sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.8v2.1M12 19.1v2.1M2.8 12h2.1M19.1 12h2.1M5.5 5.5 7 7M17 17l1.5 1.5M18.5 5.5 17 7M7 17l-1.5 1.5"/>',
    moon: '<path d="M20 14.2A8.3 8.3 0 1 1 9.8 4a6.6 6.6 0 0 0 10.2 10.2z"/>',
    bug: '<rect x="7.5" y="8" width="9" height="12" rx="4.5"/><path d="M9.5 8V6.5a2.5 2.5 0 0 1 5 0V8M12 12v8M3.5 13h4M16.5 13h4M4.5 8.5l3 2M19.5 8.5l-3 2M4.5 18.5l3-2M19.5 18.5l-3-2"/>',
    copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.2"/><path d="M15.5 8.5V6.2a1.7 1.7 0 0 0-1.7-1.7H6.2a1.7 1.7 0 0 0-1.7 1.7v7.6a1.7 1.7 0 0 0 1.7 1.7h2.3"/>',
    globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5s1.2-6.1 3.5-8.5z"/>',
    coffee: '<path d="M5 9h11v5.5A4.5 4.5 0 0 1 11.5 19h-2A4.5 4.5 0 0 1 5 14.5z"/><path d="M16 10.5h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M8 3.5c-.6.8-.6 1.7 0 2.5M11 3.5c-.6.8-.6 1.7 0 2.5"/>',
    share: '<circle cx="18" cy="5.5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="m8.2 10.8 7.6-4.1M8.2 13.2l7.6 4.1"/>',
    gift: '<rect x="4" y="9" width="16" height="11" rx="1.8"/><path d="M3 9h18M12 9v11M12 9c-1.5-3.5-5.5-4-5.5-1.5S10 9 12 9zM12 9c1.5-3.5 5.5-4 5.5-1.5S14 9 12 9z"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.6-2-3.4-2.4 1a7.7 7.7 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A7.7 7.7 0 0 0 7 6.5l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 3l-2 1.6 2 3.4 2.4-1a7.7 7.7 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.7 7.7 0 0 0 2.6-1.5l2.4 1 2-3.4z"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
    wifi: '<path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19.2" r=".9" fill="currentColor"/>',
    chat: '<path d="M20.5 11.6c0 4-3.8 7.2-8.5 7.2a9.9 9.9 0 0 1-2.8-.4L4 20.5l1.4-3.6A6.8 6.8 0 0 1 3.5 11.6C3.5 7.6 7.3 4.4 12 4.4s8.5 3.2 8.5 7.2z"/>',
    robot: '<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 4.5V8M9 13h.01M15 13h.01M9.5 16.2h5"/><circle cx="12" cy="3.6" r="1.3"/>',
    key: '<circle cx="8" cy="12" r="3.8"/><path d="M11.8 12H20M17 12v3M20 12v2.5"/>',
    cash: '<rect x="3" y="6.5" width="18" height="11" rx="2.2"/><circle cx="12" cy="12" r="2.6"/><path d="M6.5 10v4M17.5 10v4"/>'
  };
  U.icon = (name, cls) =>
    `<svg class="ic ${cls || ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ""}</svg>`;

  // Fill every [data-icon] placeholder.
  U.icons = (root) => U.$$("[data-icon]", root).forEach((el) => {
    if (el.dataset.iconDone) return;
    el.insertAdjacentHTML("afterbegin", U.icon(el.dataset.icon));
    el.dataset.iconDone = "1";
  });

  // Tiny SVG charts -------------------------------------------------------
  // Area/line chart. points: [{x:label, y:number}]
  U.areaChart = (points, opts) => {
    opts = opts || {};
    const W = opts.w || 640, H = opts.h || 200, pad = { l: 44, r: 12, t: 14, b: 26 };
    if (!points.length) return `<div class="chart-empty">${U.esc(opts.empty || "Not enough data yet.")}</div>`;
    const ys = points.map((p) => p.y);
    let lo = Math.min(...ys), hi = Math.max(...ys);
    if (lo === hi) { lo -= 1; hi += 1; }
    const span = hi - lo; lo -= span * 0.08; hi += span * 0.08;
    const X = (i) => pad.l + (points.length === 1 ? (W - pad.l - pad.r) / 2 : (i * (W - pad.l - pad.r)) / (points.length - 1));
    const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
    const line = points.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(p.y).toFixed(1)}`).join(" ");
    const area = `${line} L${X(points.length - 1).toFixed(1)} ${H - pad.b} L${X(0).toFixed(1)} ${H - pad.b} Z`;
    const ticks = [0, 0.5, 1].map((f) => lo + (hi - lo) * f);
    const step = Math.max(1, Math.ceil(points.length / 6));
    const id = "g" + Math.random().toString(36).slice(2, 8);
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${U.esc(opts.label || "chart")}">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".32"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
      ${ticks.map((v) => `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="axis" x="${pad.l - 8}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${U.compact(v)}</text>`).join("")}
      ${points.map((p, i) => (i % step === 0 || i === points.length - 1) ? `<text class="axis" x="${X(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${U.esc(p.x)}</text>` : "").join("")}
      <path class="area" d="${area}" fill="url(#${id})"/>
      <path class="line draw" d="${line}" pathLength="1"/>
      ${points.map((p, i) => `<circle class="dot" cx="${X(i).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="${points.length > 40 ? 0 : 3}"><title>${U.esc(p.x)}: ${U.fmt(p.y)}</title></circle>`).join("")}
    </svg>`;
  };

  // Grouped bars. groups: [{x:label, a:number, b:number}]
  U.barChart = (groups, opts) => {
    opts = opts || {};
    const W = opts.w || 640, H = opts.h || 200, pad = { l: 36, r: 8, t: 12, b: 26 };
    if (!groups.length) return `<div class="chart-empty">${U.esc(opts.empty || "Not enough data yet.")}</div>`;
    const hi = Math.max(1, ...groups.map((g) => Math.max(g.a || 0, g.b || 0)));
    const bw = (W - pad.l - pad.r) / groups.length;
    const Y = (v) => pad.t + (1 - v / hi) * (H - pad.t - pad.b);
    const step = Math.max(1, Math.ceil(groups.length / 8));
    const inner = Math.max(2, bw * 0.34);
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${U.esc(opts.label || "chart")}">
      ${[0, 0.5, 1].map((f) => `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(hi * f).toFixed(1)}" y2="${Y(hi * f).toFixed(1)}"/><text class="axis" x="${pad.l - 6}" y="${(Y(hi * f) + 4).toFixed(1)}" text-anchor="end">${U.compact(hi * f)}</text>`).join("")}
      ${groups.map((g, i) => {
        const x = pad.l + i * bw + bw / 2;
        const ha = (H - pad.b) - Y(g.a || 0), hb = (H - pad.b) - Y(g.b || 0);
        return `<g class="bar-g" style="--d:${i * 18}ms">
          <rect class="bar-a" x="${(x - inner - 1).toFixed(1)}" y="${Y(g.a || 0).toFixed(1)}" width="${inner.toFixed(1)}" height="${Math.max(0, ha).toFixed(1)}" rx="2"><title>${U.esc(g.x)} · ${U.esc(opts.aLabel || "A")}: ${U.fmt(g.a)}</title></rect>
          ${opts.single ? "" : `<rect class="bar-b" x="${(x + 1).toFixed(1)}" y="${Y(g.b || 0).toFixed(1)}" width="${inner.toFixed(1)}" height="${Math.max(0, hb).toFixed(1)}" rx="2"><title>${U.esc(g.x)} · ${U.esc(opts.bLabel || "B")}: ${U.fmt(g.b)}</title></rect>`}
          ${(i % step === 0) ? `<text class="axis" x="${x.toFixed(1)}" y="${H - 7}" text-anchor="middle">${U.esc(g.x)}</text>` : ""}
        </g>`;
      }).join("")}
    </svg>`;
  };

  // Ring progress: returns svg markup. value 0..1
  U.ring = (value, size, stroke, cls) => {
    const r = (size - stroke) / 2, c = 2 * Math.PI * r;
    const v = Math.max(0, Math.min(1, Number(value) || 0));
    return `<svg class="ring ${cls || ""}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
      <circle class="ring-track" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}"/>
      <circle class="ring-fill" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - v)).toFixed(2)}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
    </svg>`;
  };
  U.setRing = (svg, value) => {
    const fill = svg && svg.querySelector(".ring-fill");
    if (!fill) return;
    const c = Number(fill.getAttribute("stroke-dasharray"));
    fill.setAttribute("stroke-dashoffset", (c * (1 - Math.max(0, Math.min(1, Number(value) || 0)))).toFixed(2));
  };

  window.U = U;
})();
