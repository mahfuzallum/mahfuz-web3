// GrowX - shared/config.js
// Loaded by the background engine (importScripts) and by every extension page,
// so the engine and the UI always agree on settings, limits and scoring.

(function (root) {
  "use strict";

  const K = {
    settings: "gx.settings",
    account: "gx.account",
    sources: "gx.sources",
    pool: "gx.pool",
    seen: "gx.seen",
    job: "gx.job",
    task: "gx.task",
    ctl: "gx.ctl",
    ledger: "gx.ledger",
    follows: "gx.follows",
    known: "gx.knownFollowers",
    growth: "gx.growth",
    events: "gx.events",
    blacklist: "gx.blacklist",
    stats: "gx.stats",
    health: "gx.health",
    fbinfo: "gx.fbinfo",
    meta: "gx.meta",
    unf: "gx.unf",             // Auto-unfollow: old-list progress
    uledger: "gx.uledger",     // Auto-unfollow: timestamps of unfollows (daily count)
    unlog: "gx.unlog",         // Auto-unfollow: who was unfollowed (follower / non-follower, why)
    bk: "gx.bk",               // Follow back: list of followers you don't follow yet + progress
    bledger: "gx.bledger",     // Follow back: timestamps of follow-backs (daily / hourly count)
    bklog: "gx.bklog",         // Follow back: who GrowX followed back
    lad: "gx.lad",             // "X refused" plan: strikes + break end, per day (follow family / unfollow)
    lost: "gx.lost",           // Unfollowed you: accounts that followed you and later stopped (detected unfollowers)
    bkpre: "gx.bkpre",         // follow-backs you asked for before the follower list existed
    actlog: "gx.actlog"        // One line for every action GrowX takes, in every mode - the record you export
  };

  const LINKS = {
    support: "https://t.me/igfrostt",
    dev1: "https://t.me/mahfuzxallum",          // Mahfuz Allum - shown first
    dev2: "https://t.me/igfrostt",
    site: "https://www.shahriarahmed.net"
  };

  // Pace presets. Delays are seconds between follows (randomised inside the
  // range), a rest every `restEvery` follows, a rolling 60-minute cap and a
  // rolling 24-hour cap. X allows about 400 follows a day on a normal account
  // (more with Premium) and watches for bursts, so every preset spreads the
  // work out and stays below those numbers.
  // A pace card is a COMPLETE, ready-to-run plan - not just the delays. Clicking one fills in the day's target,
  // the safety stop, the warm-up decision, the rest day and how the day is counted, so nothing is left to type.
  // (It never touches your ON / OFF times, your working days or "Turn ON by itself": those are your choices.)
  //   sessionTarget  the day's target, the same as the daily number, so "Run target" is never left at 0
  //   maxRunHours    comfortably above what the plan really needs, so it can never run round the clock
  //   restDays       one quiet day a week - the single biggest thing that stops a week looking automated
  //   dailyWindow    "rolling" counts any 24 hours, which is how X itself counts; only the gentlest plan
  //                  stays on calendar days, where a fresh day may start right after a busy evening
  //   warmup         on only for the plan meant for new accounts
  const PRESETS = {
    safe:     { minDelay: 45, maxDelay: 110, longPauseChance: 10, restEveryMin: 10, restEvery: 12, restMinutes: 18, restMinutesMax: 24, hourlyLimit: 18, dailyLimit: 150, sessionTarget: 150, maxRunHours: 10, restDays: 1, warmup: true,  dailyWindow: "calendar" },
    balanced: { minDelay: 30, maxDelay: 75,  longPauseChance: 8,  restEveryMin: 12, restEvery: 15, restMinutes: 17, restMinutesMax: 22, hourlyLimit: 28, dailyLimit: 280, sessionTarget: 280, maxRunHours: 13, restDays: 1, warmup: false, dailyWindow: "rolling" },
    turbo:    { minDelay: 18, maxDelay: 45,  longPauseChance: 8,  restEveryMin: 20, restEvery: 25, restMinutes: 10, restMinutesMax: 14, hourlyLimit: 40, dailyLimit: 390, sessionTarget: 390, maxRunHours: 12, restDays: 1, warmup: false, dailyWindow: "rolling" },
    premium:  { minDelay: 12, maxDelay: 32,  longPauseChance: 8,  restEveryMin: 28, restEvery: 35, restMinutes: 8,  restMinutesMax: 11, hourlyLimit: 60, dailyLimit: 800, sessionTarget: 800, maxRunHours: 14, restDays: 1, warmup: false, dailyWindow: "rolling" }
  };

  const PRESET_INFO = {
    safe: { name: "Safe", tag: "New or warming-up accounts · warm-up on", per: "~150 / day" },
    balanced: { name: "Balanced", tag: "Recommended for most accounts", per: "~280 / day" },
    turbo: { name: "Turbo", tag: "Aged accounts with a clean record", per: "~390 / day" },
    premium: { name: "Premium", tag: "X Premium only - high risk", per: "~800 / day" }
  };

  const DEFAULT_BOOST = "follow back, followback, #followback, follow4follow, f4f, ifb, i follow back, 100% follow back, tfb, mutual, mutuals, 🔙, gain followers, #teamfollowback, #f4f, #ifb";
  const DEFAULT_EXCLUDE = "nsfw, 18+, onlyfans, porn, xxx, escort";

  // The order automatic switching works through by default: grow, then follow your new followers back, then clean up.
  // (MODES, further down, is the list of modes that exist - not an order.)
  const DEFAULT_SEQ = ["follow", "followback", "unfollow"];
  // Every mode that can take a place in the sequence, Comment last. Comment starts switched OFF in the
  // sequence (see switchOff below): it keeps its row, so you only have to click it on.
  const SEQ_ALL = ["follow", "followback", "unfollow", "comment"];

  // A fresh install is simply the Balanced plan: its delays, breaks, day's target, safety stop, rest day and
  // day counting all come from PRESETS.balanced above, so nothing is left blank and the Balanced pace card is
  // lit from the start. Everything below is what a plan does NOT decide for you.
  const DEFAULT_SETTINGS = Object.assign({ speed: "balanced" }, PRESETS.balanced, {
    breakJitter: 0,            // (no longer used: the break length is a random time between its Min and Max - see below)
    extraBreaks: [],           // more break rules: [{ every: follows, minutes, minutesMax }] - checked alongside the main break

    // ---- Random breaks (v2.7.6) -------------------------------------------------
    // Every mode has its OWN break settings, and both halves of a break rule are a range:
    //   how many actions before a break   Min -> Max   (restEveryMin/restEvery, bkRestEveryMin/bkRestEvery, unfRestEveryMin/unfRestEvery)
    //   how long the break lasts          Min -> Max   (restMinutes/restMinutesMax, bkRestMinutes/bkRestMinutesMax, unfRestMinutes/unfRestMinutesMax)
    // A break is always a random time inside the range, and never outside it. The same number twice = exactly that long,
    // which is what older versions did - so upgrading changes nothing until you widen a range yourself.
    bkRestMinutesMax: 22,                              // Follow back: longest break (bkRestMinutes = shortest)
    unfRestMinutesMax: 20,                             // Unfollow: longest break (unfRestMinutes = shortest)
    unfRestEveryMin: 20,                               // Unfollow: break after a random number of unfollows between this and unfRestEvery

    // ---- Automatic mode switching (v2.7.6) --------------------------------------
    // Target reached -> stop this mode -> random transition break -> switch to the next mode in the sequence -> start it.
    // Nothing starts before the transition break has finished, and a mode that already finished today is skipped.
    autoSwitch: false,                                 // OFF = one mode only, exactly like older versions
    switchSeq: DEFAULT_SEQ.slice(),                    // the ORDER of every mode (all three, each exactly once - reorder it as you like)
    switchOff: ["comment"],                            // modes switched off: they keep their place in the order but are passed over
    switchLoop: true,                                  // after the last mode, start again at the first one
    transMin: 10,                                      // transition break: shortest, in minutes
    transMax: 30,                                      // transition break: longest, in minutes
    // The sequence adds NO numbers of its own: every mode hands over on the target you already set in that mode's
    // own section - Run target for Follow (1), Follow-backs per day for Follow back (B1), Unfollows per day for
    // Unfollow (U1). Change a number there and the sequence follows it.
    failBreak: true,           // (older versions: the one "failure break" switch - now step 1 of the X-refused plan below)
    failBreakMinutes: 18,      // (older versions: its length - the plan below has its own times)
    failBreakAfter: 1,         // failed attempts in a row (no clear "no" from X) before step 1 of the plan starts

    // The "X refused" plan - the same four steps for every mode, each mode with its own times:
    //   step 1: 1st refusal / failed attempt        -> a break (minutes, a random time between Min and Max; 18 min by default)
    //   step 2: refused again right after that break -> a longer break (minutes, 30-40 by default)
    //   step 3: refused again                        -> a long break (HOURS, 3-4 by default)
    //   step 4: refused once more                    -> stop for today, start again tomorrow by itself (always on)
    // Keys: step 1 = refuse0*, step 2 = refuse1*, step 3 = refuse2* (bkRefuse* for Follow back, unfRefuse* for Unfollow).
    // Follow and Follow back share X's follow limit, so they share the strikes; Unfollow has its own.
    hourlyAuto: true,          // the per-hour pace is worked out from the delays + breaks of the mode (OFF = type the hourly numbers yourself)
    refuse0On: true, refuse0Min: 18, refuse0Max: 18,
    refuse1On: true, refuse1Min: 30, refuse1Max: 40,
    refuse2On: true, refuse2Min: 3, refuse2Max: 4,
    bkRefuse0On: true, bkRefuse0Min: 18, bkRefuse0Max: 18,
    bkRefuse1On: true, bkRefuse1Min: 30, bkRefuse1Max: 40,
    bkRefuse2On: true, bkRefuse2Min: 3, bkRefuse2Max: 4,
    unfRefuse0On: true, unfRefuse0Min: 18, unfRefuse0Max: 18,
    unfRefuse1On: true, unfRefuse1Min: 30, unfRefuse1Max: 40,
    unfRefuse2On: true, unfRefuse2Min: 3, unfRefuse2Max: 4,
    warmupStart: 60,
    warmupStep: 20,
    activeHours: true,         // only work inside a daily time window
    activeStart: "08:00",
    activeEnd: "23:30",
    activeDays: [0, 1, 2, 3, 4, 5, 6],
    // Each mode may keep its own working days. Empty = "the same days as Follow", which is how it always worked.
    unfDays: [],
    bkDays: [],
    // Rest days: GrowX takes this many days off each week, picked at random and picked again every week.
    // Nobody follows people every single day, and a week with a gap in it looks far more like a person.
    // 0 = never (how it always worked). It uses the working days above, so it needs the daily ON / OFF switch on.
    capMode: "auto",           // following-cap guard: auto | manual | off
    autoStart: false,          // start a run by itself every day
    autoStartAt: "window",     // start when Active hours begin (window) or at a custom time (custom)
    autoStartTime: "09:00",    // custom start time (Chrome must be open)
    autoStartJitter: 5,        // start up to this many minutes late, a different amount each day
    failHaltAfter: 6,          // stop the run for good after this many failure breaks in a row
    rateHaltAfter: 5,          // stop the run after this many X rate limits in a row
    onDailyCap: "stop",        // when the daily cap is reached: stop (finish for today) | wait (rest, then continue by itself)
    followingCap: 5000,
    autoSlowdown: false,       // OFF = your plan is never changed by warnings (no lowered daily/hourly caps, no slower delays)
    verifyFollows: true,       // check that follows really stick (shadow-limit detector)
    keepAwake: true,           // keep the computer awake while running
    autoResume: true,          // continue after Chrome restarts
    // Pausing with an end time: every Pause gets this timer, so a quick pause can never turn into a lost day.
    // Off = a pause lasts until you press Resume (you can still set a timer by hand each time you pause).
    pauseResume: false,
    pauseResumeMins: 30,       // how long that pause lasts, in minutes
    notifications: true,
    fbCheckHours: 3,           // full follower scan; every follow is also checked directly on a schedule
    runMode: "follow",         // what the autopilot does: "follow" OR "unfollow" OR "followback" - never two at the same time
    unfollowOn: false,         // (kept in sync with runMode for older versions)
    bkStart: "08:00",          // active hours used in Follow back mode
    bkEnd: "23:30",
    bkDaily: 280,              // follow-backs per day (matches the Balanced preset)
    bkTurn: 0,                 // follow-backs per TURN of the mode sequence (0 = the whole day in one turn)
    bkPace: "balanced",        // Follow back pace preset: safe | balanced | fast | custom
    bkMinDelay: 10,            // seconds between follow-backs (random inside the range)
    bkMaxDelay: 45,
    bkLongPause: 8,            // % of follow-backs followed by a 2-4x longer pause
    bkRestEveryMin: 12,        // break after a random number of follow-backs between bkRestEveryMin and bkRestEvery
    bkRestEvery: 15,           // (the most before a break; 0 = no breaks; same number twice = always exactly that many)
    bkRestMinutes: 17,         // break length: the SHORTEST (bkRestMinutesMax is the longest)
    bkBreakJitter: 0,          // (no longer used: the break length is a random time between its Min and Max)
    bkHourlyLimit: 28,         // at most this many follow-backs in any 60 minutes
    bkOrder: "new",            // which followers first: "new" = newest followers first, "old" = oldest first
    bkVerifiedOnly: false,     // follow back ONLY verified accounts (blue, gold or grey check); every other follower is skipped
    bkSkipInactive: true,      // don't follow back accounts that hardly post (they would be unfollowed again later)
    bkInactiveDays: 60,        // look at the last N days ...
    bkMinPosts: 5,             // ... fewer posts (incl. replies and reposts) than this in that time = inactive
    bkSkipProtected: true,     // don't follow back private accounts (they would only get a pending request)
    bkSkipNoPhoto: false,      // don't follow back accounts without a profile photo
    unfollowStart: "08:00",    // active hours used in Unfollow mode
    unfollowEnd: "23:30",
    unfollowDaily: 500,        // unfollows per day
    unfTurn: 0,                // unfollows per TURN of the mode sequence (0 = the whole day in one turn)
    unfOrder: "old",           // which accounts you follow first: "old" = the ones you followed longest ago first, "new" = the most recent first
    unfollowAfterDays: 7,      // unfollow GrowX follows that didn't follow back after this many days
    unfollowKeep: "",          // handles that are never unfollowed
    unfPace: "balanced",       // Unfollow pace preset: safe | balanced | fast | custom
    unfMinDelay: 25,           // seconds between unfollows (random inside the range)
    unfMaxDelay: 60,
    unfLongPause: 5,           // % of unfollows followed by a 2-4x longer pause
    unfRestEvery: 25,          // break after this many unfollows (0 = no breaks)
    unfRestMinutes: 15,        // break length
    unfBreakJitter: 10,        // +/- % randomness on the break
    unfHourlyLimit: 60,        // at most this many unfollows in any 60 minutes
    unfInactive: false,        // also unfollow INACTIVE accounts - even if they follow you back
    unfInactiveDays: 60,       // inactive = NO post at all (posts, replies, reposts) in the last N days. One post = active = kept.
    unfInactiveMinPosts: 1,    // (v3.2: no longer used - a single post in the period keeps the account)
    // v3.2 - big and good accounts are never unfollowed, by any step (old list, no follow-back, inactive, unfollowed you).
    unfProtectBig: true,       // the big-account guard (leave it on)
    unfProtectScore: 70,       // Quality score (0-100) at or above this = never unfollowed
    unfProtectFollowers: 10000,// this many followers or more = never unfollowed (0 = only the score decides)
    unfNeverMutual: true,      // THE GUARD: nobody who follows you back is ever unfollowed, whatever else is set.
    unfStopWhenEmpty: true,    // when nothing is left that may be unfollowed, stop and say so instead of waiting
    unfActiveToo: false,       // (v3.2: removed - active followers are never unfollowed) when fewer non-followers are due than today's number: also unfollow ACTIVE followers (people who follow you back) to fill it. OFF = they are never unfollowed
    goalMonthly: 5000,

    // harvesting
    followQuality: false,      // v3.2 "Big score first": the queue puts the highest Quality score first (OFF = the follow-back ratio order below)
    bkQuality: false,          // v3.2 the same for Follow back: the biggest / best followers are followed back first
    learnScore: true,          // v3.2 the follow-back score also learns from YOUR results (which kinds of accounts really followed back)
    skipCapped: true,          // v3.2 skip people stuck at X's following limit - they cannot follow anyone back
    srcAutoPause: true,        // v3.2 pause a source whose follow-back rate stays poor
    srcPauseBelow: 35,         // ... below this % ...
    srcPauseAfter: 60,         // ... after this many follows from it
    preCheck: true,            // v3.2 just before a follow, read the account once more (still active? still able to follow back?)
    likeBeforeFollow: false,   // v3.2 like one recent post first (one more notification = more follow-backs; uses X's like limit)
    followOrder: "score",      // Follow mode, who first from the queue: "score" = best match first, "new" = newest found first, "old" = oldest found first
    poolTarget: 250,           // candidates kept ready in the queue
    poolMaxAgeHours: 48,       // drop candidates older than this (keep it "latest")
    freshEveryHours: 2,        // re-read each source's newest followers this often
    harvestPages: 3,           // pages of newest followers per fresh pass

    // targeting
    minScore: 55,
    minFollowers: 15,
    maxFollowers: 8000,
    minFollowing: 40,
    minRatio: 0.4,             // following / followers
    minTweets: 5,
    minAgeDays: 30,
    lastActiveDays: 45,        // last post within this many days (when X tells us)
    requireAvatar: true,
    requireBio: false,
    skipProtected: true,
    skipVerified: false,
    onlyVerified: false,
    skipFollowsMe: true,
    boostKeywords: DEFAULT_BOOST,
    includeKeywords: "",
    excludeKeywords: DEFAULT_EXCLUDE,
    locationKeywords: ""
  });

  const LIMITS = {
    minDelay: [5, 900], maxDelay: [5, 1800], restEvery: [0, 500], restEveryMin: [0, 500], restMinutes: [1, 240], restMinutesMax: [1, 240],
    hourlyLimit: [1, 200], dailyLimit: [1, 3000], longPauseChance: [0, 50],
    breakJitter: [0, 50], failBreakMinutes: [1, 720], failBreakAfter: [1, 20],
    restDays: [0, 3],
    pauseResumeMins: [1, 1440],
    maxRunHours: [0, 24], autoStartJitter: [0, 120], failHaltAfter: [1, 50], rateHaltAfter: [1, 50],
    warmupStart: [5, 1000], warmupStep: [1, 500], sessionTarget: [0, 100000],
    followingCap: [100, 100000], fbCheckHours: [1, 48], goalMonthly: [0, 1000000],
    poolTarget: [20, 2000], poolMaxAgeHours: [6, 720], freshEveryHours: [1, 72], harvestPages: [1, 20],
    minScore: [0, 99], minFollowers: [0, 10000000], maxFollowers: [0, 100000000], minFollowing: [0, 1000000],
    minTweets: [0, 1000000], minAgeDays: [0, 5000], lastActiveDays: [0, 3650],
    unfollowDaily: [10, 1000], unfollowAfterDays: [1, 60], unfTurn: [0, 100000], bkTurn: [0, 100000],
    unfMinDelay: [5, 900], unfMaxDelay: [5, 1800], unfLongPause: [0, 50], unfRestEvery: [0, 500], unfRestEveryMin: [0, 500], unfRestMinutes: [1, 240], unfRestMinutesMax: [1, 240],
    unfBreakJitter: [0, 50], unfHourlyLimit: [1, 300], unfInactiveDays: [7, 365], unfInactiveMinPosts: [1, 20],
    unfProtectScore: [0, 100], unfProtectFollowers: [0, 100000000], srcPauseBelow: [0, 100], srcPauseAfter: [10, 2000],
    bkDaily: [10, 1000], bkMinDelay: [5, 900], bkMaxDelay: [5, 1800], bkLongPause: [0, 50], bkRestEvery: [0, 500], bkRestEveryMin: [0, 500], bkRestMinutes: [1, 240], bkRestMinutesMax: [1, 240],
    // Automatic mode switching: the transition break between two modes (minutes)
    transMin: [1, 720], transMax: [1, 720],
    bkBreakJitter: [0, 50], bkHourlyLimit: [1, 200], bkInactiveDays: [7, 365], bkMinPosts: [1, 20],
    // X-refused plan, steps 1 and 2: minutes
    refuse0Min: [1, 720], refuse0Max: [1, 720], bkRefuse0Min: [1, 720], bkRefuse0Max: [1, 720], unfRefuse0Min: [1, 720], unfRefuse0Max: [1, 720],
    refuse1Min: [1, 720], refuse1Max: [1, 720], bkRefuse1Min: [1, 720], bkRefuse1Max: [1, 720], unfRefuse1Min: [1, 720], unfRefuse1Max: [1, 720]
  };
  // X-refused plan, step 3: HOURS, in quarter-hour steps (3 and 4 mean 3 and 4 hours, 2.5 means two and a half)
  const HOURS = {
    refuse2Min: [0.25, 24], refuse2Max: [0.25, 24], bkRefuse2Min: [0.25, 24], bkRefuse2Max: [0.25, 24], unfRefuse2Min: [0.25, 24], unfRefuse2Max: [0.25, 24]
  };

  const BOOLS = ["autoStart", "failBreak", "warmup", "activeHours", "autoSlowdown", "verifyFollows", "keepAwake", "autoResume", "notifications",
    "requireAvatar", "requireBio", "skipProtected", "skipVerified", "onlyVerified", "skipFollowsMe", "unfollowOn", "unfInactive", "unfActiveToo", "unfNeverMutual", "unfStopWhenEmpty", "unfProtectBig",
    "followQuality", "bkQuality", "learnScore", "skipCapped", "srcAutoPause", "preCheck", "likeBeforeFollow",
    "bkVerifiedOnly", "bkSkipInactive", "bkSkipProtected", "bkSkipNoPhoto",
    "pauseResume", "hourlyAuto", "refuse0On", "refuse1On", "refuse2On", "bkRefuse0On", "bkRefuse1On", "bkRefuse2On", "unfRefuse0On", "unfRefuse1On", "unfRefuse2On",
    "autoSwitch", "switchLoop"];
  const TEXTS = ["boostKeywords", "includeKeywords", "excludeKeywords", "locationKeywords", "unfollowKeep"];

  function hhmm(v, fallback) {
    const m = String(v || "").match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return fallback;
    const h = Math.min(23, Number(m[1])), mi = Math.min(59, Number(m[2]));
    return String(h).padStart(2, "0") + ":" + String(mi).padStart(2, "0");
  }

  const MODES = ["follow", "unfollow", "followback", "comment"];

  // ---- Unfollow: "Who first" says BOTH who is unfollowed and in what order ----------------------
  //   old / new          the people who don't follow you back, oldest or newest follow first
  //   lost               the people who followed you and later stopped, before anyone else
  //   all-old / all-new  EVERYONE you follow: the non-followers first, then the people who do follow
  //                      you back as well (the same thing switch U6 does, without having to find it)
  // Whatever is picked, the Never unfollow list (U7) and every daily number, delay and break still apply.
  // v3.2: "all-old" / "all-new" (unfollow everyone, active followers too) were removed - an active account is never
  // unfollowed. Saved settings with them are read as "old" / "new".
  const UNF_ORDERS = ["old", "new", "lost"];
  const unfNewest = (s) => s && s.unfOrder === "new";
  const unfLostFirst = (s) => !!s && s.unfOrder === "lost";
  // Does Unfollow carry on into the people who follow you back? Either the Who-first choice says so,
  // or U6 is switched on by hand.
  // The guard wins over every other unfollow setting. While it is on, the two
  // switches that would reach a mutual - "unfollow everyone" and "unfollow
  // inactive accounts even if they follow you back" - simply cannot.
  const unfProtect = (s) => !s || s.unfNeverMutual !== false;
  // v3.2: always false. Filling the day with ACTIVE followers was removed - when nothing inactive is left, Unfollow stops.
  const unfEveryone = () => false;
  const unfInactiveOn = (s) => !!s && !!s.unfInactive && !unfProtect(s);
  // One place that answers "does this person follow me back?" from whatever is
  // known about them, erring towards yes: an unfollow we are not sure about
  // never happens. `t` is a queued unfollow, `m` X's own fresh answer, `f` the
  // follow record GrowX keeps.
  function followsYouBack(t, m, f) {
    if (m) {
      if (m.fy === true) return true;
      if (m.fy === false) return false;        // X said no, plainly
    }
    if (t && t.fy === true) return true;
    if (f && f.fb && !f.lost) return true;     // followed back once, never seen to stop
    if (t && t.tg === "fb") return true;
    return false;
  }

  function normalizeSettings(s) {
    const out = Object.assign({}, DEFAULT_SETTINGS, s || {});
    for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
      let n = Number(out[k]);
      if (!Number.isFinite(n)) n = DEFAULT_SETTINGS[k];
      out[k] = Math.max(lo, Math.min(hi, Math.round(n)));
    }
    for (const [k, [lo, hi]] of Object.entries(HOURS)) {
      let n = Number(out[k]);
      if (!Number.isFinite(n)) n = DEFAULT_SETTINGS[k];
      out[k] = Math.max(lo, Math.min(hi, Math.round(n * 4) / 4));
    }
    // ---- Random breaks: every mode has its own two ranges, and a break always stays inside them ----
    const missing = (k) => !s || s[k] === undefined || s[k] === null || s[k] === "";
    // Actions before a break: a random number between "from" and "to" (never more than "to"). Older versions had one
    // number - it becomes the top, and "from" starts a little lower (15 -> 12 to 15).
    for (const [lo, hi] of [["restEveryMin", "restEvery"], ["bkRestEveryMin", "bkRestEvery"], ["unfRestEveryMin", "unfRestEvery"]]) {
      if (missing(lo) && !missing(hi)) out[lo] = Math.max(1, Math.round(out[hi] * 0.8));   // upgrade only
      if (out[lo] > out[hi] || !out[lo]) out[lo] = out[hi];
    }
    // Break length: a random time between Min and Max. Settings saved by an older version have no Max, so it becomes the
    // Min and the break stays exactly as long as it was (Unfollow folds its old "break randomness" % into the Max).
    for (const [lo, hi, jit] of [["restMinutes", "restMinutesMax", null], ["bkRestMinutes", "bkRestMinutesMax", null], ["unfRestMinutes", "unfRestMinutesMax", "unfBreakJitter"]]) {
      // Only an UPGRADE collapses the range: the saved settings have the Min but no Max yet. A fresh install
      // has neither, and keeps the range the plan gave it.
      if (missing(hi) && !missing(lo)) {
        const j = jit && s ? Math.max(0, Math.min(50, Number(s[jit]) || 0)) : 0;
        out[hi] = Math.max(out[lo], Math.round(out[lo] * (1 + j / 100)));
      }
      if (out[hi] < out[lo]) [out[lo], out[hi]] = [out[hi], out[lo]];
    }
    out.breakJitter = 0;
    out.bkBreakJitter = 0;
    out.unfBreakJitter = 0;
    // The transition break between two modes: Min never above Max.
    if (out.transMax < out.transMin) [out.transMin, out.transMax] = [out.transMax, out.transMin];
    // The mode sequence: only real modes, each one at most once, never empty.
    out.switchSeq = modeOrder(out);
    out.switchOff = [...new Set((Array.isArray(out.switchOff) ? out.switchOff : []).map(String))].filter((m) => MODES.includes(m));
    // The X-refused plan: Min never above Max.
    for (const p of ["refuse", "bkRefuse", "unfRefuse"]) {
      // (step 1 is new in v2.7.1: it always starts ON with 18 min - the old hidden "failure break" values are not carried over)
      for (const st of ["0", "1", "2"]) {
        const a = p + st + "Min", b = p + st + "Max";
        if (out[b] < out[a]) [out[a], out[b]] = [out[b], out[a]];
      }
    }
    let ratio = Number(out.minRatio);
    if (!Number.isFinite(ratio)) ratio = DEFAULT_SETTINGS.minRatio;
    out.minRatio = Math.max(0, Math.min(20, Math.round(ratio * 100) / 100));
    if (out.maxDelay < out.minDelay) [out.minDelay, out.maxDelay] = [out.maxDelay, out.minDelay];
    if (out.maxFollowers && out.maxFollowers < out.minFollowers) out.maxFollowers = out.minFollowers;
    if (!["safe", "balanced", "turbo", "premium", "custom"].includes(out.speed)) out.speed = "custom";
    if (!["auto", "manual", "off"].includes(out.capMode)) out.capMode = "auto";
    if (!["stop", "wait"].includes(out.onDailyCap)) out.onDailyCap = "stop";
    if (!["calendar", "rolling"].includes(out.dailyWindow)) out.dailyWindow = "calendar";
    if (!["window", "custom"].includes(out.autoStartAt)) out.autoStartAt = "window";
    if (!(s && MODES.includes(s.runMode))) out.runMode = (s && s.unfollowOn === true) ? "unfollow" : "follow";
    out.unfollowStart = hhmm(out.unfollowStart, DEFAULT_SETTINGS.unfollowStart);
    out.unfollowEnd = hhmm(out.unfollowEnd, DEFAULT_SETTINGS.unfollowEnd);
    out.bkStart = hhmm(out.bkStart, DEFAULT_SETTINGS.bkStart);
    out.bkEnd = hhmm(out.bkEnd, DEFAULT_SETTINGS.bkEnd);
    if (out.bkMaxDelay < out.bkMinDelay) [out.bkMinDelay, out.bkMaxDelay] = [out.bkMaxDelay, out.bkMinDelay];
    if (!["safe", "balanced", "fast", "custom"].includes(out.bkPace)) out.bkPace = "custom";
    if (!["new", "old"].includes(out.bkOrder)) out.bkOrder = "new";
    if (out.unfOrder === "all-new") out.unfOrder = "new";
    if (!UNF_ORDERS.includes(out.unfOrder)) out.unfOrder = "old";
    out.unfActiveToo = false;
    if (!["score", "new", "old"].includes(out.followOrder)) out.followOrder = "score";
    out.autoStartTime = hhmm(out.autoStartTime, DEFAULT_SETTINGS.autoStartTime);
    for (const b of BOOLS) out[b] = !!out[b];
    out.unfActiveToo = false;
    for (const t of TEXTS) out[t] = String(out[t] || "").slice(0, 3000);
    out.activeStart = hhmm(out.activeStart, DEFAULT_SETTINGS.activeStart);
    out.activeEnd = hhmm(out.activeEnd, DEFAULT_SETTINGS.activeEnd);
    const cleanDays = (v) => [...new Set((Array.isArray(v) ? v : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
    out.activeDays = cleanDays(out.activeDays);
    if (!out.activeDays.length) out.activeDays = [0, 1, 2, 3, 4, 5, 6];
    // A mode's own days; empty means "the same days as Follow".
    out.unfDays = cleanDays(out.unfDays);
    out.bkDays = cleanDays(out.bkDays);
    if (out.onlyVerified) out.skipVerified = false;
    out.unfollowOn = out.runMode === "unfollow";
    if (out.unfMaxDelay < out.unfMinDelay) [out.unfMinDelay, out.unfMaxDelay] = [out.unfMaxDelay, out.unfMinDelay];
    if (!["safe", "balanced", "fast", "custom"].includes(out.unfPace)) out.unfPace = "custom";
    // Extra break rules: up to 6, each "after N follows, rest M to M2 minutes" (no M2 = exactly M, as before).
    // Comment mode's own numbers, prompts and rules (shared/cmt.js, loaded after this file).
    if (root.GX && root.GX.normalizeComment) root.GX.normalizeComment(out);
    out.extraBreaks = (Array.isArray(out.extraBreaks) ? out.extraBreaks : []).slice(0, 6).map((b) => {
      const every = Math.round(Number(b && b.every)), minutes = Math.round(Number(b && b.minutes));
      if (!Number.isFinite(every) || !Number.isFinite(minutes) || every < 1 || minutes < 1) return null;
      const lo = Math.min(1440, minutes);
      let hi = Math.round(Number(b && b.minutesMax));
      if (!Number.isFinite(hi) || hi < 1) hi = lo;
      return { every: Math.min(5000, every), minutes: lo, minutesMax: Math.max(lo, Math.min(1440, hi)) };
    }).filter(Boolean);
    return out;
  }

  function cleanHandle(raw) {
    if (!raw) return null;
    let h = String(raw).trim();
    const m = h.match(/(?:twitter|x)\.com\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})/i);
    if (m) h = m[1];
    h = h.replace(/^@+/, "").trim();
    if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) return null;
    if (/^(home|explore|notifications|messages|settings|i|search|compose|intent|share|login|logout|signup|tos|privacy)$/i.test(h)) return null;
    return h;
  }

  function parseKeywords(s) {
    return String(s || "").split(/[,\n]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  }

  // Word-aware match: "fb" matches "#fb" or "fb 🔙" but not "fbi" or "facebook".
  function kwHit(hay, kws) {
    if (!kws.length) return null;
    for (const k of kws) {
      if (!/^[a-z0-9_ ]+$/.test(k)) { if (hay.includes(k)) return k; continue; }
      let at = hay.indexOf(k);
      while (at !== -1) {
        const b = at === 0 ? "" : hay[at - 1];
        const a = hay[at + k.length] || "";
        if (!/[a-z0-9]/.test(b) && !/[a-z0-9]/.test(a)) return k;
        at = hay.indexOf(k, at + 1);
      }
    }
    return null;
  }

  const DAY = 86400000;
  const hayOf = (u) => (String(u.n || "") + " " + String(u.h || "") + " " + String(u.b || "")).toLowerCase();

  // ---- v3.2 Quality score: how big and how good an account is (0-100) -----------------------
  // Not the follow-back score. It answers "is this a big, real, active account?" and is used to
  //   * never unfollow big / good accounts (Unfollow, every step), and
  //   * put the best accounts first when "Big score first" is on (Follow, Follow back).
  // Followers (log scale, up to 45) + followers per following (up to 20) + verified (10) + account age (8)
  // + posts (8) + recent activity (9). Unknown numbers add nothing.
  function qualityScore(u) {
    if (!u) return 0;
    const now = Date.now();
    let q = 0;
    const fc = typeof u.fc === "number" ? u.fc : null, fr = typeof u.fr === "number" ? u.fr : null;
    if (fc !== null && fc > 100) q += Math.min(45, 11.25 * Math.log10(fc / 100));
    if (fc !== null && fr !== null) {
      const r = fc / Math.max(1, fr);
      q += r >= 10 ? 20 : r >= 3 ? 14 : r >= 1.5 ? 8 : r >= 1 ? 4 : 0;
    }
    if (u.v) q += 10;
    if (u.ca) { const age = (now - u.ca) / DAY; q += age > 730 ? 8 : age > 365 ? 5 : age < 90 ? -10 : 0; }
    if (typeof u.sc === "number") q += u.sc >= 5000 ? 8 : u.sc >= 1000 ? 5 : u.sc >= 200 ? 2 : 0;
    if (u.lt) { const d = (now - u.lt) / DAY; q += d <= 7 ? 9 : d <= 30 ? 5 : d > 90 ? -10 : 0; }
    if (u.d) q -= 10;
    return Math.max(0, Math.min(100, Math.round(q)));
  }
  // Why this account must never be unfollowed (big / good), or null. With no numbers at all it is NOT
  // judged here - the caller treats "can't tell" as "keep".
  function bigReason(u, s) {
    if (!u || !s || s.unfProtectBig === false) return null;
    if (s.unfProtectFollowers > 0 && typeof u.fc === "number" && u.fc >= s.unfProtectFollowers) return `big account - ${Number(u.fc).toLocaleString()} followers`;
    const q = qualityScore(u);
    if (q >= s.unfProtectScore) return `good account - Quality score ${q}`;
    return null;
  }
  // X lets an account follow 5,000 people; past that only about 10% more than its own followers. Someone at that
  // line cannot follow anyone back, however likely they look.
  function atFollowCap(u) {
    if (!u || typeof u.fr !== "number" || typeof u.fc !== "number") return false;
    const cap = Math.max(5000, Math.floor(u.fc * 1.1));
    return u.fr >= cap - 30;
  }
  function nearFollowCap(u) {
    if (!u || typeof u.fr !== "number" || typeof u.fc !== "number") return false;
    const cap = Math.max(5000, Math.floor(u.fc * 1.1));
    return u.fr >= cap * 0.96;
  }

  // Hard filters. Returns why a candidate is NOT followed, or null if eligible.
  function rejectReason(u, s, now) {
    now = now || Date.now();
    if (u.fw === true) return "already following";
    if (s.skipCapped !== false && atFollowCap(u)) return "at X's following limit";
    if (s.skipFollowsMe && u.fy === true) return "already follows you";
    if (s.skipProtected && u.p) return "private account";
    if (s.skipVerified && u.v) return "verified";
    if (s.onlyVerified && !u.v) return "not verified";
    if (s.requireAvatar && u.d) return "no profile photo";
    if (s.requireBio && !String(u.b || "").trim()) return "no bio";
    if (typeof u.fc === "number") {
      if (u.fc < s.minFollowers) return "too few followers";
      if (s.maxFollowers > 0 && u.fc > s.maxFollowers) return "too many followers";
    }
    if (typeof u.fr === "number" && u.fr < s.minFollowing) return "follows too few people";
    if (typeof u.fc === "number" && typeof u.fr === "number" && s.minRatio > 0 && u.fr / Math.max(1, u.fc) < s.minRatio) return "low follow ratio";
    if (typeof u.sc === "number" && u.sc < s.minTweets) return "too few posts";
    if (u.ca && s.minAgeDays > 0 && now - u.ca < s.minAgeDays * DAY) return "account too new";
    if (u.lt && s.lastActiveDays > 0 && now - u.lt > s.lastActiveDays * DAY) return "inactive";
    const hay = hayOf(u);
    if (kwHit(hay, parseKeywords(s.excludeKeywords))) return "excluded keyword";
    const inc = parseKeywords(s.includeKeywords);
    if (inc.length && !kwHit(hay, inc)) return "missing keyword";
    const loc = parseKeywords(s.locationKeywords);
    if (loc.length && !kwHit(String(u.loc || "").toLowerCase() + " " + String(u.b || "").toLowerCase(), loc)) return "location";
    return null;
  }

  // Estimated follow-back probability, 1-99. Built from the signals that
  // predict follow-backs best: people who follow many accounts relative to
  // their audience, small-to-mid accounts, recent activity, "follow back"
  // language, real profiles, and how recently they followed the source.
  function scoreUser(u, s, now) {
    now = now || Date.now();
    let sc = 50;
    const fc = typeof u.fc === "number" ? u.fc : null;
    const fr = typeof u.fr === "number" ? u.fr : null;
    if (fc !== null && fr !== null) {
      const r = fr / Math.max(1, fc);
      if (r >= 2) sc += 16;
      else if (r >= 1.2) sc += 12;
      else if (r >= 0.85) sc += 7;
      else if (r >= 0.5) sc += 0;
      else if (r >= 0.25) sc -= 10;
      else sc -= 20;
    }
    if (fc !== null) {
      if (fc < 20) sc -= 6;
      else if (fc <= 1500) sc += 6;
      else if (fc <= 5000) sc += 2;
      else if (fc <= 20000) sc -= 6;
      else sc -= 16;
    }
    if (fr !== null) {
      if (fr >= 1000) sc += 6;
      else if (fr >= 300) sc += 3;
      else if (fr < 50) sc -= 6;
    }
    if (kwHit(hayOf(u), parseKeywords(s && s.boostKeywords))) sc += 15;
    if (u.lt) {
      const d = (now - u.lt) / DAY;
      if (d <= 2) sc += 8; else if (d <= 7) sc += 5; else if (d <= 30) sc += 1; else if (d <= 90) sc -= 6; else sc -= 14;
    } else if (typeof u.sc === "number" && u.ca) {
      const perDay = u.sc / Math.max(1, (now - u.ca) / DAY);
      if (perDay >= 1) sc += 3; else if (perDay < 0.02) sc -= 6;
    }
    if (u.ca) {
      const age = (now - u.ca) / DAY;
      if (age < 30) sc -= 10; else if (age < 90) sc -= 4; else if (age > 365) sc += 2;
    }
    if (u.d) sc -= 14;
    if (nearFollowCap(u)) sc -= 25;                          // close to X's following limit: may not be able to follow back
    if (!String(u.b || "").trim()) sc -= 4;
    if (u.p) sc -= 18;
    if (u.v) sc += 2;
    // One of the source's newest followers: someone who just followed an account is in "follow mode" right now.
    if (typeof u.pos === "number") sc += u.pos < 20 ? 10 : u.pos < 60 ? 6 : u.pos < 150 ? 2 : 0;
    // v3.2 learning: what YOUR own results say about accounts like this one (see learnAdjust in the engine).
    if (s && s.learnScore !== false && typeof u.lrn === "number") sc += u.lrn;
    // v3.2 the source's real follow-back rate (set by the engine once a source has enough follows).
    if (typeof u.srb === "number") sc += u.srb;
    return Math.max(1, Math.min(99, Math.round(sc)));
  }

  function scoreBand(score) {
    if (score >= 80) return "80+";
    if (score >= 70) return "70-79";
    if (score >= 60) return "60-69";
    if (score >= 50) return "50-59";
    return "<50";
  }

  // ---- time windows ----
  const mins = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };

  function inWindow(s, ts) {
    if (!s.activeHours) return true;
    const d = new Date(ts || Date.now());
    const cur = d.getHours() * 60 + d.getMinutes();
    const a = mins(s.activeStart), b = mins(s.activeEnd);
    if (a === b) return s.activeDays.includes(d.getDay());
    if (a < b) return cur >= a && cur < b && s.activeDays.includes(d.getDay());
    // Overnight window, e.g. 20:00-02:00: the early-morning part belongs to the previous day.
    if (cur >= a) return s.activeDays.includes(d.getDay());
    if (cur < b) return s.activeDays.includes((d.getDay() + 6) % 7);
    return false;
  }

  // Next moment the window opens (minute resolution, searched up to 8 days).
  // Daily auto-start: begins when Active hours begin (or at your own time).
  function autoStartMinutes(s) { return s.autoStartAt === "window" && s.activeHours ? mins(s.activeStart) : mins(s.autoStartTime); }
  // When the next automatic start is due. ranToday = a run already started today (so wait for tomorrow).
  function nextAutoStart(s, ranToday, now) {
    now = now || Date.now();
    const m = autoStartMinutes(s);
    for (let i = ranToday ? 1 : 0; i < 9; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() + i);
      d.setHours(0, 0, 0, 0);
      if (s.activeHours && !s.activeDays.includes(d.getDay())) continue;
      // The start time of that day (today: not before now). The run also needs the ON time: a start time before it waits for it,
      // and a day whose hours are already over is skipped.
      let t = Math.max(d.getTime() + m * 60000, i === 0 ? now : 0);
      if (s.activeHours && !inWindow(s, t)) {
        t = nextWindowStart(s, t);
        if (new Date(t).toDateString() !== d.toDateString()) continue;
      }
      return t <= now ? now : t;
    }
    return now + 86400000;
  }

  function nextWindowStart(s, ts) {
    const start = ts || Date.now();
    if (inWindow(s, start)) return start;
    const d = new Date(start);
    d.setSeconds(0, 0);
    const a = mins(s.activeStart);
    for (let i = 0; i < 9; i++) {
      const c = new Date(d);
      c.setDate(d.getDate() + i);
      c.setHours(Math.floor(a / 60), a % 60, 0, 0);
      if (c.getTime() > start && inWindow(s, c.getTime() + 1000)) return c.getTime();
    }
    return start + 3600000;
  }

  // ---- Hourly pace: worked out from the delays and the breaks of the mode (v2.7.0) ----
  // The numbers the engine really uses for a mode.
  function paceInfo(s, mode) {
    if (mode === "comment" && root.GX && root.GX.cmtPace) return root.GX.cmtPace(s);
    if (mode === "unfollow") return { lo: s.unfMinDelay, hi: s.unfMaxDelay, lp: s.unfLongPause, mult: 3, every: s.unfRestEvery, avgEvery: (s.unfRestEvery + (s.unfRestEveryMin || s.unfRestEvery)) / 2, mins: s.unfRestMinutes, minsMax: s.unfRestMinutesMax || s.unfRestMinutes, jit: 0, extra: [] };
    if (mode === "followback") return { lo: s.bkMinDelay, hi: s.bkMaxDelay, lp: s.bkLongPause, mult: 3.25, every: s.bkRestEvery, avgEvery: (s.bkRestEvery + (s.bkRestEveryMin || s.bkRestEvery)) / 2, mins: s.bkRestMinutes, minsMax: s.bkRestMinutesMax || s.bkRestMinutes, jit: 0, extra: [] };
    return { lo: s.minDelay, hi: s.maxDelay, lp: s.longPauseChance, mult: 3.25, every: s.restEvery, avgEvery: (s.restEvery + (s.restEveryMin || s.restEvery)) / 2, mins: s.restMinutes, minsMax: s.restMinutesMax || s.restMinutes, jit: 0, extra: s.extraBreaks || [] };
  }

  // The break length of a mode, in minutes: [shortest, longest]. A break is a random time in between, never outside it.
  function breakRange(s, mode) {
    if (mode === "comment") return [s.cmtRestMinutes, Math.max(s.cmtRestMinutes, s.cmtRestMinutesMax || s.cmtRestMinutes)];
    if (mode === "unfollow") return [s.unfRestMinutes, Math.max(s.unfRestMinutes, s.unfRestMinutesMax || s.unfRestMinutes)];
    if (mode === "followback") return [s.bkRestMinutes, Math.max(s.bkRestMinutes, s.bkRestMinutesMax || s.bkRestMinutes)];
    return [s.restMinutes, Math.max(s.restMinutes, s.restMinutesMax || s.restMinutes)];
  }
  // One break of a mode, in milliseconds (same number twice = exactly that long).
  function breakMs(s, mode) {
    const [lo, hi] = breakRange(s, mode);
    return Math.round((hi > lo ? lo + Math.random() * (hi - lo) : lo) * 60000);
  }
  // One extra break rule (Follow mode), in milliseconds - its own range.
  function extraBreakMs(b) {
    const lo = Math.max(1, Number(b && b.minutes) || 1);
    const hi = Math.max(lo, Number(b && b.minutesMax) || lo);
    return Math.round((hi > lo ? lo + Math.random() * (hi - lo) : lo) * 60000);
  }

  // ---- Automatic mode switching ------------------------------------------------
  // The transition break between two modes, in milliseconds (a random time between transMin and transMax).
  function transitionMs(s) {
    const lo = Math.max(1, s.transMin), hi = Math.max(lo, s.transMax);
    return Math.round((hi > lo ? lo + Math.random() * (hi - lo) : lo) * 60000);
  }
  // The order you put the modes in: every mode, exactly once. Anything missing is added at the end, so the list is
  // always complete and a mode you switch off keeps its place.
  function modeOrder(s) {
    const seen = new Set(), out = [];
    for (const m of (Array.isArray(s && s.switchSeq) ? s.switchSeq : [])) {
      const k = String(m);
      if (MODES.includes(k) && !seen.has(k)) { seen.add(k); out.push(k); }
    }
    for (const m of SEQ_ALL) if (!seen.has(m)) out.push(m);
    return out;
  }
  // The sequence as the engine runs it: your order, with the modes you switched off left out.
  // Everything off means an empty sequence - automatic switching then has nothing to hand over to.
  function modeSeq(s) {
    const off = new Set(Array.isArray(s && s.switchOff) ? s.switchOff : []);
    return modeOrder(s).filter((m) => !off.has(m));
  }
  // The mode that comes after `from`, or null when the sequence has ended (and "start again at the first" is off).
  // `skip` is a set/array of modes that are finished for today: they are passed over, and null means nothing is left.
  function nextMode(s, from, skip) {
    const seq = modeSeq(s);
    const done = new Set(skip || []);
    const at = seq.indexOf(from);
    const order = at === -1 ? seq.slice() : seq.slice(at + 1).concat(s.switchLoop ? seq.slice(0, at + 1) : []);
    for (const m of order) if (m !== from && !done.has(m)) return m;
    return null;
  }
  // Is a real sequence running? (Switching on, and at least two modes left in it to hand over between.)
  // Only then do the per-turn targets mean anything - with switching off, every number keeps its old meaning.
  function cycling(s) { return !!(s && s.autoSwitch) && modeSeq(s).length > 1; }

  // What a mode may still do TODAY: its own daily number. `daily` is X's shared daily follow number after warm-up.
  function modeTarget(s, mode, daily) {
    const d = daily == null ? s.dailyLimit : daily;
    if (mode === "comment") return s.cmtDaily;
    if (mode === "unfollow") return s.unfollowDaily;
    if (mode === "followback") return Math.min(s.bkDaily, d);
    // Follow: with a sequence running, "Run target" is what ONE TURN does, so the day is bounded by the daily limit.
    return (!cycling(s) && s.sessionTarget > 0) ? Math.min(s.sessionTarget, d) : d;
  }
  // What a mode does in ONE TURN before it hands over - taken straight from that mode's own settings, where
  // every number lives: Run target (1) for Follow, Follow-backs per turn (B1), Unfollows per turn (U1).
  // 0 means no turn of its own: the mode does its whole day before handing over.
  // A turn is never longer than what is left for the day.
  function modeTurnTarget(s, mode, daily) {
    const day = modeTarget(s, mode, daily);
    const turn = mode === "comment" ? s.cmtTurn : mode === "unfollow" ? s.unfTurn : mode === "followback" ? s.bkTurn : s.sessionTarget;
    return turn > 0 ? Math.min(turn, day) : day;
  }
  // Most actions per hour that X may be asked for, whatever the delays say: the biggest pace of the presets plus some room.
  const AUTO_HOURLY_MAX = { follow: 60, followback: 60, unfollow: 120, comment: 30 };

  // Hours of a working day for a mode: its active hours (or 24), and for Follow / Follow back also the "Maximum run time per day".
  function workHours(s, mode) {
    const a = mode === "comment" ? s.cmtStart : mode === "unfollow" ? s.unfollowStart : mode === "followback" ? s.bkStart : s.activeStart;
    const b = mode === "comment" ? s.cmtEnd : mode === "unfollow" ? s.unfollowEnd : mode === "followback" ? s.bkEnd : s.activeEnd;
    let h = 24;
    // Comment keeps its own ON / OFF switch ("Right away" vs "Working hours only").
    const windowed = mode === "comment" ? !s.cmtStartNow : !!s.activeHours;
    if (windowed) { let d = mins(b) - mins(a); if (d <= 0) d += 1440; h = d / 60; }
    if (mode === "follow" && s.maxRunHours > 0) h = Math.min(h, s.maxRunHours);
    return Math.max(1, h);
  }

  // What a mode's delays + breaks add up to (opts.daily = the daily limit after warm-up):
  //   natural  actions per hour on average, from the delays and the breaks
  //   peak     the most actions your own rhythm can put into any 60 minutes: every delay at its shortest, no long pauses,
  //            every break at its shortest (e.g. 15 follows, then 18 min, again and again)
  //   cap      the hourly number the engine keeps when "Auto" is on: just above that peak, so it never cuts into your rhythm
  //            (no extra pause before the 15th follow) - and never above the safe maximum of the mode (AUTO_HOURLY_MAX)
  //   goal / hours  the day's number and the working hours (shown in the dashboard, not used for the cap)
  function autoHourly(s, mode, opts) {
    const p = paceInfo(s, mode);
    const avg = Math.max(1, (p.lo + p.hi) / 2 * (1 + (p.lp / 100) * (p.mult - 1)));
    const fast = Math.max(1, p.lo);
    const shortBreak = (m) => m * 60;                     // the shortest a break can be: the densest hour your rhythm allows
    const times = [];
    let t = 0, since = 0;
    const sx = p.extra.map(() => 0);
    for (let k = 0; k < 4000 && t < 10 * 3600; k++) {
      let gap = 0;
      if (p.every && since >= p.every) { gap = shortBreak(p.mins); since = 0; }
      p.extra.forEach((b, i) => { if (sx[i] >= b.every) { gap = Math.max(gap, b.minutes * 60); sx[i] = 0; } });   // shortest of that rule too
      t += gap + fast; times.push(t); since++; sx.forEach((_, i) => sx[i]++);
    }
    let peak = 0, lo = 0;
    for (let hi = 0; hi < times.length; hi++) { while (times[hi] - times[lo] >= 3600) lo++; peak = Math.max(peak, hi - lo + 1); }
    const avgMins = ((p.mins || 0) + (p.minsMax || p.mins || 0)) / 2;         // breaks are random: the average length sets the average pace
    let restPer = p.every ? (avgMins * 60) / (p.avgEvery || p.every) : 0;
    for (const b of p.extra) restPer += (((b.minutes + (b.minutesMax || b.minutes)) / 2) * 60) / b.every;
    const natural = 3600 / Math.max(1, avg + restPer);
    const want = peak + 1;
    const max = AUTO_HOURLY_MAX[mode] || 60;
    const dailyNow = opts && opts.daily != null ? opts.daily : s.dailyLimit;
    const goal = Math.max(1, mode === "comment" ? s.cmtDaily
      : mode === "unfollow" ? s.unfollowDaily
      : mode === "followback" ? Math.min(s.bkDaily, dailyNow)
      : (s.sessionTarget > 0 ? Math.min(s.sessionTarget, dailyNow) : dailyNow));
    const hours = workHours(s, mode);
    const cap = Math.max(1, Math.min(want, max));
    const by = want > max ? "max" : "delays";
    return { natural, peak, want, max, maxed: want > max, avg, goal, hours, spread: cap, cap, by };
  }
  // The hourly number a mode runs with: its auto value, or the one you typed (when Auto is off).
  //   follow      Follow (this is X's shared follow number)
  //   followback  { cap: own number for Follow back, shared: X's shared follow number while Follow back runs }
  //   unfollow    Unfollow
  function hourlyCap(s, mode, opts) {
    const manual = mode === "comment" ? s.cmtHourlyLimit : mode === "unfollow" ? s.unfHourlyLimit : mode === "followback" ? s.bkHourlyLimit : s.hourlyLimit;
    const info = autoHourly(s, mode, opts);
    // Comment's per-hour number is always the one you typed: X counts replies, not follows.
    const cap = (s.hourlyAuto && mode !== "comment") ? info.cap : manual;
    return { auto: !!s.hourlyAuto, cap, shared: mode === "followback" ? (s.hourlyAuto ? info.cap : s.hourlyLimit) : cap, info };
  }

  // The "X refused" plan of a mode, in milliseconds: steps 1 and 2 in minutes, step 3 in hours. A step is never shorter than the
  // step before it (when that one is on). Step 4 (stop for today) has no time and is always on.
  function refusePlan(s, mode) {
    const p = mode === "unfollow" ? "unfRefuse" : mode === "followback" ? "bkRefuse" : "refuse";
    const MIN = 60000, HOUR = 3600000;
    const on0 = !!s[p + "0On"], on1 = !!s[p + "1On"], on2 = !!s[p + "2On"];
    const lo0 = s[p + "0Min"] * MIN, hi0 = Math.max(lo0, s[p + "0Max"] * MIN);
    let lo1 = s[p + "1Min"] * MIN, hi1 = Math.max(lo1, s[p + "1Max"] * MIN);
    if (on0) { lo1 = Math.max(lo1, hi0); hi1 = Math.max(hi1, lo1); }
    let lo2 = s[p + "2Min"] * HOUR, hi2 = Math.max(lo2, s[p + "2Max"] * HOUR);
    const before = on1 ? hi1 : on0 ? hi0 : 0;
    lo2 = Math.max(lo2, before); hi2 = Math.max(hi2, lo2);
    return { on0, lo0, hi0, on1, lo1, hi1, on2, lo2, hi2 };
  }

  // Daily cap after warm-up and any temporary throttle from X warnings.
  function effectiveLimits(s, meta, throttle, now) {
    now = now || Date.now();
    let daily = s.dailyLimit;
    if (s.warmup) {
      const started = (meta && meta.warmupAt) || now;
      const days = Math.max(0, Math.floor((now - started) / DAY));
      daily = Math.min(daily, s.warmupStart + days * s.warmupStep);
    }
    // Hourly pace: Auto = worked out from the day's number, the hours and the delays + breaks; otherwise the number you typed.
    let hourly = s.hourlyAuto ? autoHourly(s, s.runMode === "followback" ? "followback" : "follow", { daily }).cap : s.hourlyLimit;
    let slow = 1;
    if (throttle && throttle.until > now) {
      const f = Math.max(0.2, Math.min(1, throttle.factor || 1));
      daily = Math.max(5, Math.floor(daily * f));
      hourly = Math.max(2, Math.floor(hourly * f));
      slow = 1 / f;
      if (throttle.dailyCap) daily = Math.min(daily, throttle.dailyCap);
    }
    return { daily, hourly, slow };
  }

  // X lets everyone follow 5,000 accounts; past that the cap grows with
  // followers (roughly 10% above the follower count).
  function followingCap(s, account) {
    if (s.capMode === "off") return 0;
    if (s.capMode === "manual") return s.followingCap;
    const followers = account && typeof account.followers === "number" ? account.followers : 0;
    return Math.max(5000, Math.floor(followers * 1.1));
  }

  // Unfollow pace presets (each fits comfortably inside a 14-15 h day, breaks included).
  const UNF_PRESETS = {
    safe:     { unfollowDaily: 300, unfMinDelay: 40, unfMaxDelay: 90, unfRestEveryMin: 16, unfRestEvery: 20, unfRestMinutes: 20, unfRestMinutesMax: 27, unfHourlyLimit: 40 },
    balanced: { unfollowDaily: 500, unfMinDelay: 25, unfMaxDelay: 60, unfRestEveryMin: 20, unfRestEvery: 25, unfRestMinutes: 15, unfRestMinutesMax: 20, unfHourlyLimit: 60 },
    fast:     { unfollowDaily: 800, unfMinDelay: 15, unfMaxDelay: 40, unfRestEveryMin: 24, unfRestEvery: 30, unfRestMinutes: 12, unfRestMinutesMax: 16, unfHourlyLimit: 90 }
  };
  const UNF_PRESET_INFO = {
    safe: { name: "Safe", tag: "Gentle, for a careful start" },
    balanced: { name: "Balanced", tag: "Recommended" },
    fast: { name: "Fast", tag: "Old list cleared quickest" }
  };

  // Follow back pace presets. Follow-backs ARE follows, so they use the same numbers as the Follow
  // presets (Safe / Balanced / Turbo): same delays, same breaks, same hourly and daily ceilings.
  const BK_PRESETS = {
    safe:     { bkDaily: 150, bkMinDelay: 45, bkMaxDelay: 110, bkRestEveryMin: 10, bkRestEvery: 12, bkRestMinutes: 18, bkRestMinutesMax: 24, bkHourlyLimit: 18 },
    balanced: { bkDaily: 280, bkMinDelay: 10, bkMaxDelay: 45,  bkRestEveryMin: 12, bkRestEvery: 15, bkRestMinutes: 17, bkRestMinutesMax: 22, bkHourlyLimit: 28 },
    fast:     { bkDaily: 390, bkMinDelay: 18, bkMaxDelay: 45,  bkRestEveryMin: 20, bkRestEvery: 25, bkRestMinutes: 10, bkRestMinutesMax: 14, bkHourlyLimit: 40 }
  };
  const BK_PRESET_INFO = {
    safe: { name: "Safe", tag: "Gentle, for a careful start" },
    balanced: { name: "Balanced", tag: "Recommended" },
    fast: { name: "Fast", tag: "Clears the backlog quickest" }
  };

  // The settings the engine runs with: each mode has its own hours (Unfollow hours / Follow back hours).
  // A mode's own working days, falling back to Follow's when it does not keep its own.
  function modeDays(s, mode) {
    const own = mode === "comment" ? s.cmtDays : mode === "unfollow" ? s.unfDays : mode === "followback" ? s.bkDays : null;
    return own && own.length ? own : s.activeDays;
  }
  function modeSettings(s) {
    if (!s) return s;
    if (s.runMode === "unfollow") return Object.assign({}, s, { activeStart: s.unfollowStart, activeEnd: s.unfollowEnd, activeDays: modeDays(s, "unfollow") });
    if (s.runMode === "followback") return Object.assign({}, s, { activeStart: s.bkStart, activeEnd: s.bkEnd, activeDays: modeDays(s, "followback") });
    // Comment has its own ON / OFF switch, so "Right away" really means all day.
    if (s.runMode === "comment") return Object.assign({}, s, { activeHours: !s.cmtStartNow, activeStart: s.cmtStart, activeEnd: s.cmtEnd, activeDays: modeDays(s, "comment") });
    return s;
  }

  // ---- Rest days ---------------------------------------------------------------
  // The days off are chosen by the week itself: the same all week, different every week, and different from
  // one install to the next (the seed is when GrowX was installed). No randomness is stored, so every part of
  // GrowX - the engine, the dashboard, the "next start" times - works out the same answer.
  const WEEK = 7 * DAY;
  function weekIndex(now) { return Math.floor(((now || Date.now()) - 3 * DAY) / WEEK); }   // 1 Jan 1970 was a Thursday
  function restDayList(s, seed, now) {
    const want = Math.max(0, Math.min(3, Math.round(Number(s && s.restDays) || 0)));
    const days = (s && Array.isArray(s.activeDays) ? s.activeDays : []).slice();
    if (!want || days.length <= 1) return [];
    const take = Math.min(want, days.length - 1);                  // a week is never left with no working day
    let h = ((Number(seed) || 1) % 1000003) + weekIndex(now) * 2654435761;
    const rnd = () => { h = (Math.imul(h, 1103515245) + 12345) & 0x7fffffff; return h / 0x7fffffff; };
    rnd();                                                          // one spin so neighbouring weeks differ clearly
    const out = [];
    for (let i = 0; i < take; i++) out.push(...days.splice(Math.floor(rnd() * days.length), 1));
    return out.sort((a, b) => a - b);
  }
  // The settings the engine really runs with this week: the rest days taken out of the working days.
  function withRestDays(s, seed, now) {
    const off = restDayList(s, seed, now);
    if (!off.length) return s;
    const left = s.activeDays.filter((d) => !off.includes(d));
    return Object.assign({}, s, { activeDays: left.length ? left : s.activeDays, restOff: off });
  }

  root.GX = {
    K, LINKS, PRESETS, PRESET_INFO, DEFAULT_SETTINGS, LIMITS, DEFAULT_BOOST, DEFAULT_EXCLUDE,
    normalizeSettings, cleanHandle, parseKeywords, kwHit, rejectReason, scoreUser, scoreBand,
    inWindow, nextWindowStart, autoStartMinutes, nextAutoStart, effectiveLimits, followingCap, modeSettings, UNF_PRESETS, UNF_PRESET_INFO,
    qualityScore, bigReason, atFollowCap, nearFollowCap,
    BK_PRESETS, BK_PRESET_INFO, MODES, DEFAULT_SEQ, UNF_ORDERS, unfNewest, unfLostFirst, unfEveryone, unfProtect, unfInactiveOn, followsYouBack, autoHourly, hourlyCap, refusePlan, AUTO_HOURLY_MAX, HOURS,
    breakRange, breakMs, extraBreakMs, transitionMs, modeSeq, modeOrder, nextMode, modeTarget, modeTurnTarget, cycling, paceInfo,
    modeDays, restDayList, withRestDays, weekIndex, SEQ_ALL
  };
})(typeof self !== "undefined" ? self : window);
