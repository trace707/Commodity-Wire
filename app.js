/* Commodity Wire - reads data/headlines.json (rebuilt every minute by the
   GitHub Actions workflow) and renders one column per market. */
(() => {
  const MARKETS = [
    ["corn", "Corn"], ["wheat", "Wheat"], ["soybeans", "Soybeans"],
    ["gold", "Gold"], ["silver", "Silver"], ["copper", "Copper"], ["oil", "Oil"],
    ["live-cattle", "Live Cattle"], ["feeder-cattle", "Feeder Cattle"], ["lean-hogs", "Lean Hogs"],
  ];

  // Usual release schedule, US Eastern. d: 0=Sun..6=Sat (array = several days), m: months active (1-12).
  const R = {
    inspections: { n: "USDA Export Inspections", d: 1, t: "11:00" },
    progress:    { n: "USDA Crop Progress", d: 1, t: "16:00", m: [4, 5, 6, 7, 8, 9, 10, 11] },
    sales:       { n: "USDA Export Sales", d: 4, t: "08:30" },
    cot:         { n: "CFTC Commitments of Traders", d: 5, t: "15:30" },
    ethanol:     { n: "EIA ethanol production", d: 3, t: "10:30" },
    claims:      { n: "US jobless claims", d: 4, t: "08:30" },
    api:         { n: "API crude stocks", d: 2, t: "16:30" },
    eia:         { n: "EIA petroleum status", d: 3, t: "10:30" },
    rigs:        { n: "Baker Hughes rig count", d: 5, t: "13:00" },
    beef:        { n: "USDA boxed beef (PM)", d: [1, 2, 3, 4, 5], t: "15:00" },
    pork:        { n: "USDA pork cutout (PM)", d: [1, 2, 3, 4, 5], t: "15:00" },
    feederIdx:   { n: "CME feeder cattle index", d: [1, 2, 3, 4, 5], t: "16:00" },
    lme:         { n: "LME daily stocks", d: [1, 2, 3, 4, 5], t: "04:00" },
    settle:      (t) => ({ n: "Futures settlement", d: [1, 2, 3, 4, 5], t }),
  };
  const SCHEDULE = {
    corn: [R.inspections, R.progress, R.ethanol, R.sales, R.cot, R.settle("14:20")],
    wheat: [R.inspections, R.progress, R.sales, R.cot, R.settle("14:20")],
    soybeans: [R.inspections, R.progress, R.sales, R.cot, R.settle("14:20")],
    gold: [R.claims, R.cot, R.settle("13:30")],
    silver: [R.claims, R.cot, R.settle("13:25")],
    copper: [R.lme, R.cot, R.settle("13:00")],
    oil: [R.api, R.eia, R.rigs, R.cot, R.settle("14:30")],
    "live-cattle": [R.beef, R.sales, R.cot, R.settle("14:05")],
    "feeder-cattle": [R.feederIdx, R.cot, R.settle("14:05")],
    "lean-hogs": [R.pork, R.sales, R.cot, R.settle("14:05")],
  };

  const $ = (id) => document.getElementById(id);
  const store = {
    get: (k, d) => { try { return JSON.parse(localStorage.getItem("wire." + k)) ?? d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem("wire." + k, JSON.stringify(v)); } catch {} },
  };
  const state = {
    data: null, seen: null, unread: 0,
    alerts: new Set(),   // markets whose chip and column header flash until clicked
    hidden: new Set(store.get("hidden", [])),
    hotOnly: store.get("hotOnly", false), sound: store.get("sound", false),
    notify: store.get("notify", false) && "Notification" in window && Notification.permission === "granted",
    et: store.get("et", true),
  };

  // ---- data source ---------------------------------------------------------
  function sources() {
    const c = window.WIRE_CONFIG || {};
    let owner = c.owner, repo = c.repo;
    const gh = location.hostname.match(/^([^.]+)\.github\.io$/);
    if (gh && !owner) { owner = gh[1]; repo = location.pathname.split("/")[1] || `${gh[1]}.github.io`; }
    const bust = `?t=${Math.floor(Date.now() / 20000)}`;
    const list = [];
    // The data branch is updated every minute; the copy next to this page only when the site is redeployed.
    if (owner && repo) list.push(`https://raw.githubusercontent.com/${owner}/${repo}/${c.branch || "data"}/headlines.json${bust}`);
    list.push(`data/headlines.json${bust}`);
    return list;
  }
  async function load() {
    for (const url of sources()) {
      try {
        const r = await fetch(url, { cache: "no-store" });
        if (r.ok) return await r.json();
      } catch {}
    }
    throw new Error("no data");
  }

  // ---- time ----------------------------------------------------------------
  const zone = () => (state.et ? "America/New_York" : undefined);
  const fmtRow = (ts) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
      timeZone: zone(), day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true,
    }).formatToParts(ts).map((x) => [x.type, x.value]));
    return `${p.day} ${p.month} · ${p.hour}:${p.minute} ${p.dayPeriod.toUpperCase()}`;
  };
  const fmtClock = (ts) => new Intl.DateTimeFormat("en-US", { timeZone: zone(), hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true }).format(ts);
  const to12 = (t) => { const [h, m] = t.split(":").map(Number); return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
  const tzLabel = () => state.et ? "ET" : (new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value || "Local");

  // Next occurrences of the recurring releases, worked out on the Eastern wall clock.
  function upcoming(key, count = 3) {
    const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const nowMin = et.getDay() * 1440 + et.getHours() * 60 + et.getMinutes();
    const out = [];
    for (const r of SCHEDULE[key] || []) {
      if (r.m && !r.m.includes(et.getMonth() + 1)) continue;
      const [h, m] = r.t.split(":").map(Number);
      let best = Infinity;
      for (const d of [].concat(r.d)) {
        let diff = d * 1440 + h * 60 + m - nowMin;
        if (diff < 0) diff += 7 * 1440;
        best = Math.min(best, diff);
      }
      out.push({ n: r.n, t: r.t, inMin: best, day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][(et.getDay() + Math.floor((et.getHours() * 60 + et.getMinutes() + best) / 1440)) % 7] });
    }
    return out.sort((a, b) => a.inMin - b.inMin).slice(0, count);
  }
  const fmtIn = (min) => min < 60 ? `in ${min}m` : min < 1440 ? `in ${Math.floor(min / 60)}h ${min % 60}m` : `in ${Math.floor(min / 1440)}d ${Math.floor((min % 1440) / 60)}h`;

  // ---- render --------------------------------------------------------------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = (u) => (/^https?:\/\//i.test(u) ? u : "#");

  const flashing = (k) => state.alerts.has(k);
  function renderChips() {
    $("chips").innerHTML = MARKETS.map(([k, name]) => {
      const hot = (state.data?.commodities?.[k] || []).filter((h) => h.hot && Date.now() - h.ts < 3600e3).length;
      return `<button class="chip${flashing(k) ? " alert" : ""}" data-k="${k}" aria-pressed="${!state.hidden.has(k)}" title="${flashing(k) ? `New important ${name} headline - click to dismiss` : `Show or hide ${name}`}">${name}${hot ? `<b>${hot}</b>` : ""}</button>`;
    }).join("");
  }
  function renderSchedule() {
    for (const [k] of MARKETS) {
      const el = document.querySelector(`.col[data-k="${k}"] .sched`);
      if (el) el.innerHTML = upcoming(k).map((u) =>
        `<div class="${u.inMin <= 30 ? "soon" : ""}"><span>${esc(u.n)}</span><time>${u.day} ${to12(u.t)} ET · ${fmtIn(u.inMin)}</time></div>`).join("");
    }
  }
  function render(fresh = new Set()) {
    const board = $("board");
    const scroll = Object.fromEntries([...board.querySelectorAll(".col")].map((c) => [c.dataset.k, c.querySelector(".list").scrollTop]));
    board.innerHTML = MARKETS.filter(([k]) => !state.hidden.has(k)).map(([k, name]) => {
      let items = state.data?.commodities?.[k] || [];
      if (state.hotOnly) items = items.filter((h) => h.hot);
      const rows = items.map((h) => `
        <li class="row${h.hot ? " hot" : ""}${fresh.has(h.id) ? " new" : ""}">
          <time datetime="${new Date(h.ts).toISOString()}">${fmtRow(h.ts)}</time>
          <a href="${esc(safeUrl(h.url))}" target="_blank" rel="noopener noreferrer">${h.type !== "NEWS" ? `<span class="tag ${h.type}">${h.type}</span>` : ""}${esc(h.t)}</a>
          ${h.src ? `<span class="meta">${esc(h.src)}</span>` : ""}
        </li>`).join("");
      return `<section class="col" data-k="${k}" aria-label="${name} headlines">
        <div class="col-head${flashing(k) ? " alert" : ""}"><span>Headlines · <strong>${name}</strong></span><span>${tzLabel()}</span></div>
        <div class="sched"></div>
        <ul class="list">${rows || `<li class="empty">${state.data ? "No headlines in the last 72 hours." : "Loading…"}</li>`}</ul>
      </section>`;
    }).join("") || `<p class="empty">All markets are hidden. Pick one above.</p>`;
    for (const c of board.querySelectorAll(".col")) c.querySelector(".list").scrollTop = scroll[c.dataset.k] || 0;
    renderSchedule(); renderChips();
  }
  function renderStatus() {
    if (!state.data) return;
    const age = Date.now() - Date.parse(state.data.updated);
    const stale = age > 15 * 60e3;
    $("dot").className = "dot " + (stale ? "stale" : "live");
    $("status").textContent = stale
      ? `feed delayed · last update ${fmtRow(Date.parse(state.data.updated))} ${tzLabel()}`
      : `live · updated ${fmtClock(Date.parse(state.data.updated))} ${tzLabel()}`;
  }

  // ---- alerts --------------------------------------------------------------
  let audio;
  function beep() {
    try {
      audio ||= new (window.AudioContext || window.webkitAudioContext)();
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(audio.destination);
      g.gain.setValueAtTime(0.12, audio.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.35);
      o.start(); o.stop(audio.currentTime + 0.35);
    } catch {}
  }
  function alertFor(newHot) {
    if (!newHot.length) return;
    if (state.sound) beep();
    if (state.notify) for (const [name, h] of newHot.slice(0, 3)) {
      try { new Notification(`${name}: ${h.type === "NEWS" ? "headline" : h.type.toLowerCase()}`, { body: h.t, tag: h.id }); } catch {}
    }
    if (document.hidden) { state.unread += newHot.length; document.title = `(${state.unread}) Commodity Wire`; }
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { state.unread = 0; document.title = "Commodity Wire"; } });

  // ---- loop ----------------------------------------------------------------
  async function tick() {
    try {
      const data = await load();
      // never step backwards if a cached copy is older than what is on screen
      if (state.data && Date.parse(data.updated) <= Date.parse(state.data.updated)) return renderStatus();
      const ids = new Set(), fresh = new Set(), newHot = [];
      for (const [k, name] of MARKETS) for (const h of data.commodities?.[k] || []) {
        ids.add(h.id);
        if (state.seen && !state.seen.has(h.id)) { fresh.add(h.id); if (h.hot) { state.alerts.add(k); if (!state.hidden.has(k)) newHot.push([name, h]); } }
      }
      state.data = data; state.seen = ids;
      render(fresh); renderStatus(); alertFor(newHot);
    } catch {
      $("dot").className = "dot stale";
      $("status").textContent = state.data ? "connection lost · retrying" : "no data yet · waiting for the first feed run";
    }
  }

  // ---- controls ------------------------------------------------------------
  const press = (id, on) => $(id).setAttribute("aria-pressed", on);
  $("chips").addEventListener("click", (e) => {
    const k = e.target.closest(".chip")?.dataset.k; if (!k) return;
    // a flashing chip: the click acknowledges the alert (and reveals the column) instead of hiding it
    if (state.alerts.delete(k)) state.hidden.delete(k);
    else state.hidden.has(k) ? state.hidden.delete(k) : state.hidden.add(k);
    store.set("hidden", [...state.hidden]); render();
  });
  $("board").addEventListener("click", (e) => {
    const k = e.target.closest(".col-head.alert")?.parentElement.dataset.k;
    if (k && state.alerts.delete(k)) render();
  });
  $("hotOnly").onclick = () => { state.hotOnly = !state.hotOnly; store.set("hotOnly", state.hotOnly); press("hotOnly", state.hotOnly); render(); };
  $("sound").onclick = () => { state.sound = !state.sound; store.set("sound", state.sound); press("sound", state.sound); if (state.sound) beep(); };
  $("notify").onclick = async () => {
    if (!("Notification" in window)) return alert("This browser does not support desktop notifications.");
    if (!state.notify && Notification.permission !== "granted" && (await Notification.requestPermission()) !== "granted") return;
    state.notify = !state.notify; store.set("notify", state.notify); press("notify", state.notify);
  };
  $("tz").onclick = () => { state.et = !state.et; store.set("et", state.et); $("tz").textContent = state.et ? "ET" : "Local"; render(); renderStatus(); };

  press("hotOnly", state.hotOnly); press("sound", state.sound); press("notify", state.notify);
  $("tz").textContent = state.et ? "ET" : "Local";
  render(); tick();
  setInterval(tick, 20000);
  setInterval(() => { renderSchedule(); renderStatus(); }, 30000);
})();
