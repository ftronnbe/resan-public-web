"use strict";

/* ---------- Login: the data file is encrypted with a key made from username and password ---------- */

const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const $ = (id) => document.getElementById(id);

async function deriveKey(user, pass, blob) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(`${user.trim().toLowerCase()}:${pass}`), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", salt: b64(blob.salt), iterations: blob.iter, hash: "SHA-256" }, base, 512);
}

async function decrypt(bits, blob) {
  const raw = new Uint8Array(bits);
  const macKey = await crypto.subtle.importKey("raw", raw.slice(32), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const iv = b64(blob.iv), ct = b64(blob.ct);
  const signed = new Uint8Array(iv.length + ct.length); signed.set(iv); signed.set(ct, iv.length);
  if (!(await crypto.subtle.verify("HMAC", macKey, b64(blob.mac), signed))) throw new Error("bad key");
  const aes = await crypto.subtle.importKey("raw", raw.slice(0, 32), "AES-CBC", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, aes, ct);
  return JSON.parse(new TextDecoder().decode(plain));
}

async function loadBlob() { return (await fetch("data.enc.json", { cache: "no-store" })).json(); }

async function tryLogin(user, pass) {
  const blob = await loadBlob();
  const bits = await deriveKey(user, pass, blob);
  const data = await decrypt(bits, blob);
  try { sessionStorage.setItem("resan.k", toB64(bits)); } catch (_) {}
  return data;
}

async function resume() {
  let k; try { k = sessionStorage.getItem("resan.k"); } catch (_) {}
  if (!k) return null;
  try { return await decrypt(b64(k).buffer, await loadBlob()); } catch (_) { return null; }
}

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("loginBtn"), err = $("loginError");
  btn.disabled = true; btn.textContent = "Loggar in…"; err.hidden = true;
  try { start(await tryLogin($("user").value, $("pass").value)); }
  catch (_) { err.textContent = "Fel användarnamn eller lösenord."; err.hidden = false; }
  btn.disabled = false; btn.textContent = "Logga in";
});
$("logout").addEventListener("click", () => { try { sessionStorage.removeItem("resan.k"); } catch (_) {} location.reload(); });
resume().then((d) => { if (d) start(d); });

/* ---------- Helpers ---------- */

const SV = "sv-SE";
const fmt = (ms, zone, opts) => new Intl.DateTimeFormat(SV, { timeZone: zone, ...opts }).format(ms);
const dayLabel = (iso) => new Intl.DateTimeFormat(SV, { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(iso.slice(0, 10) + "T12:00:00Z")).replace(".", "");
const hhmm = (iso) => (iso.includes("T") ? iso.slice(11, 16) : null);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ---------- The trip ---------- */

let T, legs, schedule;

function buildLegs() {
  const out = T.flights.map((f) => ({ kind: "fly", label: `${f.number} ${T.places[f.from === "KBV" ? "KBV" : f.from].name} → ${T.places[f.to].name}`, from: f.from, to: f.to, start: f.dep, end: f.arr, flight: f }));
  // The two drives to and from Nashik: no times in the plan, so mornings of the days.
  for (const t of T.transfers) {
    const m = [["Mumbai", "Nashik", "BOM", "NASHIK"], ["Nashik", "Mumbai", "NASHIK", "BOM"]].find((r) => t.title.startsWith(`${r[0]} → ${r[1]}`));
    if (m) { const start = t.when - 4 * 3600e3, end = start + 5 * 3600e3; out.push({ kind: "car", label: t.title, from: m[2], to: m[3], start, end, transfer: t }); }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Where the family is at a moment: in the air, on the road, or at a place. */
function whereAt(now) {
  let place = "ARN";
  for (const l of legs) {
    if (now >= l.end) place = l.to === "KBV" ? "LANTA" : l.to;
    else if (now >= l.start) return { moving: l };
    else break;
  }
  return { place };
}

const coord = (id) => { const p = T.places[id === "KBV" ? "KBV" : id]; return [p.lon, p.lat]; };

/* ---------- Page ---------- */

function start(data) {
  T = data; legs = buildLegs();
  $("login").hidden = true; $("app").hidden = false;
  $("title").textContent = T.title;
  document.title = "Resan";
  renderPlaces(); renderFlights(); renderHotels(); renderTimeline();
  tick(); setInterval(tick, 1000);
  initGlobe();
  loadWeather();
}

function tick() { renderStatus(); updateClocks(); }

function renderStatus() {
  const now = Date.now(), box = $("status");
  const nextLeg = legs.find((l) => l.start > now);
  const w = whereAt(now);
  let html;
  if (now < T.start) {
    const d = T.start - now, days = Math.floor(d / 864e5), h = Math.floor(d / 36e5) % 24, m = Math.floor(d / 6e4) % 60, s = Math.floor(d / 1e3) % 60;
    html = `<span class="pill">Snart avresa</span><div class="big">${days} dagar, ${h} h ${m} min ${String(s).padStart(2, "0")} s</div><div class="small">Till avgången från Arlanda fre 13 nov kl 13:00.</div>`;
  } else if (now > T.end + 864e5) {
    html = `<span class="pill">Hemma</span><div class="big">Tillbaka i Stockholm</div><div class="small">Tack för att ni följde med.</div>`;
  } else if (w.moving) {
    const l = w.moving, f = Math.min(1, Math.max(0, (now - l.start) / (l.end - l.start)));
    const left = Math.max(0, l.end - now), hh = Math.floor(left / 36e5), mm = Math.floor(left / 6e4) % 60;
    html = `<span class="pill">${l.kind === "fly" ? "I luften" : "På väg"}</span><div class="big">${esc(l.label)}</div><div class="small">${Math.round(f * 100)} % av vägen · ${hh} h ${mm} min kvar</div>`;
  } else {
    const p = T.places[w.place];
    const next = nextLeg ? `Nästa: ${esc(nextLeg.label)}, ${cap(fmt(nextLeg.start, nextLeg.flight ? nextLeg.flight.depZone : p.zone, { weekday: "short", day: "numeric", month: "short", hour: nextLeg.kind === "fly" ? "2-digit" : undefined, minute: nextLeg.kind === "fly" ? "2-digit" : undefined }))}` : "";
    html = `<span class="pill">Just nu</span><div class="big">${esc(p.name)}, ${esc(p.country)}</div><div class="small">${next}</div>`;
  }
  if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
}

/* ---------- Clocks and weather ---------- */

const SHOWN = ["ARN", "LANTA", "BKK", "BOM", "NASHIK"];

function renderPlaces() {
  const box = $("places"); box.innerHTML = "";
  for (const id of SHOWN) {
    const p = T.places[id];
    const n = el("div", "place glass");
    n.id = `place-${id}`;
    n.innerHTML = `<div class="name">${esc(p.name)}</div><div class="country">${esc(p.country)}</div><div class="clock" data-clock="${id}">--:--</div><div class="day" data-day="${id}"></div><div class="wx" data-wx="${id}"><span class="muted">Hämtar väder…</span></div>`;
    box.appendChild(n);
  }
}

function updateClocks() {
  const now = Date.now(), here = whereAt(now);
  const se = new Date(now);
  for (const id of SHOWN) {
    const p = T.places[id];
    document.querySelector(`[data-clock="${id}"]`).textContent = fmt(now, p.zone, { hour: "2-digit", minute: "2-digit" });
    const off = (tzOffset(p.zone, se) - tzOffset("Europe/Stockholm", se)) / 60;
    const diff = id === "ARN" ? "hemma" : off === 0 ? "samma tid som hemma" : `${off > 0 ? "+" : "−"}${Math.abs(off).toString().replace(".", ",")} h från hemma`;
    document.querySelector(`[data-day="${id}"]`).textContent = `${cap(fmt(now, p.zone, { weekday: "long" }))} · ${diff}`;
    $(`place-${id}`).classList.toggle("here", here.place === id);
  }
}

function tzOffset(zone, date) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(date);
  const g = (t) => +parts.find((p) => p.type === t).value;
  return (Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - Math.floor(date.getTime() / 1000) * 1000) / 60000;
}

const WX = {
  0: ["☀️", "Strålande sol"], 1: ["🌤️", "Mest sol"], 2: ["⛅", "Soligt och lite moln"], 3: ["☁️", "Molnigt"], 45: ["🌫️", "Dimma"], 48: ["🌫️", "Dimma"],
  51: ["🌦️", "Lätt duggregn"], 53: ["🌦️", "Duggregn"], 55: ["🌧️", "Duggregn"], 61: ["🌦️", "Lätt regn"], 63: ["🌧️", "Regn"], 65: ["🌧️", "Kraftigt regn"],
  71: ["🌨️", "Snö"], 73: ["🌨️", "Snö"], 75: ["❄️", "Snö"], 80: ["🌦️", "Skurar"], 81: ["🌧️", "Skurar"], 82: ["🌧️", "Skurar"], 95: ["⛈️", "Åska"], 96: ["⛈️", "Åska"], 99: ["⛈️", "Åska"],
};
const wxInfo = (c) => WX[c] || (c >= 51 && c <= 67 ? WX[63] : c >= 71 && c <= 77 ? WX[73] : c >= 80 && c <= 86 ? WX[81] : c >= 95 ? WX[95] : ["🌡️", ""]);

/** The nicest hour of today between 08 and 20: sunny, dry and mild beat grey and wet. */
function bestHour(h) {
  const today = h.time[0].slice(0, 10);
  let best = null;
  h.time.forEach((t, i) => {
    const hour = +t.slice(11, 13);
    if (!t.startsWith(today) || hour < 8 || hour > 20) return;
    const c = h.weathercode[i];
    const base = c === 0 ? 0 : c === 1 ? 1 : c === 2 ? 2.5 : c === 3 ? 4.5 : c === 45 || c === 48 ? 6 : c >= 95 ? 14 : c >= 51 ? 11 : 7;
    const score = base + (h.precipitation_probability[i] || 0) / 100 * 6 + Math.abs(h.temperature_2m[i] - 26) * 0.08;
    if (!best || score < best.score) best = { score, hour, temp: Math.round(h.temperature_2m[i]), code: c };
  });
  return best;
}

async function loadWeather() {
  await Promise.all(SHOWN.map(async (id) => {
    const p = T.places[id], box = document.querySelector(`[data-wx="${id}"]`);
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lon}&hourly=temperature_2m,precipitation_probability,weathercode&timezone=auto&forecast_days=1`;
      const r = await (await fetch(url)).json();
      const b = bestHour(r.hourly);
      if (!b) throw new Error("no hours");
      const [emoji, text] = wxInfo(b.code);
      box.innerHTML = `<span class="e">${emoji}</span><span><b>${b.temp}°</b> ${esc(text)}<small>Bäst väder idag kl ${String(b.hour).padStart(2, "0")}</small></span>`;
    } catch (_) { box.innerHTML = `<span class="muted">Vädret kunde inte hämtas</span>`; }
  }));
}

/* ---------- Flights, hotels, timeline ---------- */

function renderFlights() {
  const box = $("flights"); box.innerHTML = ""; const now = Date.now();
  for (const f of T.flights) {
    const live = now >= f.dep && now <= f.arr, past = now > f.arr;
    const n = el("div", `card glass${past ? " past" : ""}`);
    n.innerHTML = `<div class="row"><span class="num">${esc(f.number)}</span><span class="tag ${live ? "live" : "fly"}">${live ? "I luften" : esc(f.airline)}</span></div>
      <div class="route">${esc(T.places[f.from === "KBV" ? "KBV" : f.from].name)} → ${esc(T.places[f.to].name)}</div>
      <div class="times"><div><b>${hhmm(f.depLocal)}</b><span>${cap(dayLabel(f.depLocal))} · ${esc(f.fromName)}</span></div><div style="text-align:right"><b>${hhmm(f.arrLocal)}</b><span>${cap(dayLabel(f.arrLocal))} · ${esc(f.toName)}</span></div></div>
      ${f.aircraft ? `<div class="sub">${esc(f.aircraft)}</div>` : ""}`;
    box.appendChild(n);
  }
}

function renderHotels() {
  const box = $("hotels"); box.innerHTML = ""; const now = Date.now();
  const seen = new Map();
  for (const h of T.hotels) { const k = h.name; const e = seen.get(k) || { ...h }; e.out = Math.max(e.out, h.out); if (h.outLocal > e.outLocal) e.outLocal = h.outLocal; seen.set(k, e); }
  for (const h of seen.values()) {
    const nights = Math.round((new Date(h.outLocal.slice(0, 10)) - new Date(h.inLocal.slice(0, 10))) / 864e5);
    const here = now >= h.in && now <= h.out, past = now > h.out;
    const n = el("div", `card glass${past ? " past" : ""}`);
    n.innerHTML = `<div class="row"><span class="num" style="font-size:18px">${esc(h.name)}</span><span class="tag ${here ? "live" : "hotel"}">${here ? "Vi bor här" : `${nights} ${nights === 1 ? "natt" : "nätter"}`}</span></div>
      <div class="route">${esc(T.places[h.place].name)}, ${esc(T.places[h.place].country)}</div>
      <div class="sub">${cap(dayLabel(h.inLocal))} till ${dayLabel(h.outLocal)}</div>`;
    box.appendChild(n);
  }
}

function renderTimeline() {
  const items = [];
  for (const f of T.flights) {
    items.push({ ms: f.dep, local: f.depLocal, icon: "✈️", what: `${f.number} ${T.places[f.from].name} → ${T.places[f.to].name}`, info: `${f.airline}, landar ${hhmm(f.arrLocal)} lokal tid` });
  }
  for (const t of T.transfers) items.push({ ms: t.when, local: t.whenLocal, icon: "🚗", what: t.title, info: "" });
  for (const h of T.hotels) {
    items.push({ ms: h.in, local: h.inLocal, icon: "🛏️", what: `Incheckning ${h.name}`, info: T.places[h.place].name });
    items.push({ ms: h.out, local: h.outLocal, icon: "🧳", what: `Utcheckning ${h.name}`, info: T.places[h.place].name });
  }
  for (const e of T.events) items.push({ ms: e.start, local: e.startLocal, icon: "🎉", what: e.title, info: e.place });
  items.sort((a, b) => a.ms - b.ms);
  const groups = new Map();
  for (const i of items) { const d = i.local.slice(0, 10); (groups.get(d) || groups.set(d, []).get(d)).push(i); }
  const box = $("timeline"); box.innerHTML = ""; const now = Date.now();
  for (const [d, list] of groups) {
    const today = sameDay(d), past = !today && d < localToday();
    const g = el("div", `day-group${past ? " past" : ""}${today ? " today" : ""}`);
    g.innerHTML = `<div class="day-head">${cap(dayLabel(d))}${today ? "<small>idag</small>" : ""}</div>`;
    const wrap = el("div", "items");
    for (const i of list) {
      const t = hhmm(i.local);
      wrap.appendChild(el("div", "item glass", `<div class="t${t ? "" : " none"}">${t || "hela dagen"}</div><div><div class="what">${i.icon} ${esc(i.what)}</div>${i.info ? `<div class="info">${esc(i.info)}</div>` : ""}</div>`));
    }
    g.appendChild(wrap); box.appendChild(g);
  }
}

function localToday() {
  const w = whereAt(Date.now()); const zone = w.place ? T.places[w.place].zone : "Europe/Stockholm";
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(Date.now());
}

function sameDay(d) {
  const w = whereAt(Date.now()); const zone = w.place ? T.places[w.place].zone : "Europe/Stockholm";
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(Date.now()) === d;
}

/* ---------- Globe ---------- */

let rotation = [-40, -20, 0], dragging = false, lastTouch = 0, land = null;

async function initGlobe() {
  const canvas = $("globe");
  const ctx = canvas.getContext("2d");
  if (!window.d3) return;
  try { const w = await (await fetch("https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-110m.json")).json(); land = topojson.feature(w, w.objects.land); } catch (_) {}
  const proj = d3.geoOrthographic().clipAngle(90).precision(0.4);
  const path = d3.geoPath(proj, ctx);
  const graticule = d3.geoGraticule10();
  const stars = Array.from({ length: 90 }, () => [Math.random(), Math.random(), Math.random() * 1.2 + 0.3]);

  const resize = () => {
    const dpr = window.devicePixelRatio || 1, r = canvas.getBoundingClientRect();
    canvas.width = r.width * dpr; canvas.height = r.height * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    proj.translate([r.width / 2, r.height / 2]).scale(Math.min(r.width, r.height) * 0.43);
  };
  resize(); window.addEventListener("resize", resize);

  // Drag to turn the globe; it drifts back to the family when you let go.
  let start = null;
  canvas.addEventListener("pointerdown", (e) => { dragging = true; start = { x: e.clientX, y: e.clientY, r: rotation.slice() }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const k = 0.35; rotation = [start.r[0] + (e.clientX - start.x) * k, Math.max(-80, Math.min(80, start.r[1] - (e.clientY - start.y) * k)), 0]; lastTouch = Date.now();
  });
  const up = () => { dragging = false; lastTouch = Date.now(); };
  canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up);

  const planeAt = () => {
    const now = Date.now(), w = whereAt(now);
    if (w.moving) { const l = w.moving, f = (now - l.start) / (l.end - l.start); return { pos: d3.geoInterpolate(coord(l.from), coord(l.to))(Math.max(0, Math.min(1, f))), leg: l }; }
    return { pos: coord(w.place === "LANTA" ? "LANTA" : w.place), leg: null };
  };

  const frame = () => {
    const r = canvas.getBoundingClientRect(), W = r.width, H = r.height, now = Date.now();
    const target = planeAt();
    if (!dragging && now - lastTouch > 3000) {
      const goal = [-target.pos[0], -target.pos[1] * 0.7];
      let dl = goal[0] - rotation[0]; dl = ((dl + 540) % 360) - 180;
      rotation = [rotation[0] + dl * 0.03, rotation[1] + (goal[1] - rotation[1]) * 0.03, 0];
    }
    proj.rotate(rotation);
    ctx.clearRect(0, 0, W, H);
    for (const s of stars) { ctx.fillStyle = `rgba(255,255,255,${0.15 + s[2] * 0.25})`; ctx.fillRect(s[0] * W, s[1] * H, s[2], s[2]); }
    const R = proj.scale();
    // glow
    const g = ctx.createRadialGradient(W / 2, H / 2, R * 0.9, W / 2, H / 2, R * 1.25);
    g.addColorStop(0, "rgba(84,204,255,.28)"); g.addColorStop(1, "rgba(84,204,255,0)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(W / 2, H / 2, R * 1.25, 0, 7); ctx.fill();
    // ocean
    const o = ctx.createRadialGradient(W / 2 - R * 0.3, H / 2 - R * 0.3, R * 0.1, W / 2, H / 2, R);
    o.addColorStop(0, "#17345c"); o.addColorStop(1, "#0a1830");
    ctx.beginPath(); path({ type: "Sphere" }); ctx.fillStyle = o; ctx.fill();
    ctx.beginPath(); path(graticule); ctx.strokeStyle = "rgba(255,255,255,.06)"; ctx.lineWidth = 0.6; ctx.stroke();
    if (land) { ctx.beginPath(); path(land); ctx.fillStyle = "#2c4a72"; ctx.fill(); ctx.strokeStyle = "rgba(160,200,255,.25)"; ctx.lineWidth = 0.6; ctx.stroke(); }
    // legs
    for (const l of legs) {
      const line = { type: "LineString", coordinates: [coord(l.from), coord(l.to)] };
      const done = now >= l.end, live = now >= l.start && now < l.end;
      ctx.beginPath(); path(line);
      ctx.setLineDash(done || live ? [] : [2, 5]);
      ctx.lineWidth = done || live ? 2 : 1.2;
      ctx.strokeStyle = l.kind === "car" ? (done ? "rgba(255,184,107,.9)" : "rgba(255,184,107,.4)") : done || live ? "rgba(84,204,255,.95)" : "rgba(84,204,255,.35)";
      ctx.stroke(); ctx.setLineDash([]);
    }
    // places
    const shown = ["ARN", "LANTA", "BKK", "BOM", "NASHIK", "MUC"];
    for (const id of shown) {
      const c = coord(id), vis = d3.geoDistance(c, [-rotation[0], -rotation[1]]) < Math.PI / 2 - 0.05;
      if (!vis) continue;
      const [x, y] = proj(c);
      ctx.beginPath(); ctx.arc(x, y, 3.4, 0, 7); ctx.fillStyle = "#fff"; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, 7 + Math.sin(now / 500) * 1.2, 0, 7); ctx.strokeStyle = "rgba(255,255,255,.35)"; ctx.lineWidth = 1; ctx.stroke();
      ctx.font = "600 12px Figtree, system-ui, sans-serif"; ctx.fillStyle = "rgba(255,255,255,.9)"; ctx.textAlign = "left";
      const dy = { NASHIK: -8, BOM: 12, KBV: 4, LANTA: 12 }[id] ?? 4;
      ctx.fillText(T.places[id].name, x + 10, y + dy);
    }
    // the family
    if (d3.geoDistance(target.pos, [-rotation[0], -rotation[1]]) < Math.PI / 2) {
      const [x, y] = proj(target.pos), pulse = (now % 1800) / 1800;
      ctx.beginPath(); ctx.arc(x, y, 6 + pulse * 18, 0, 7); ctx.strokeStyle = `rgba(255,184,107,${0.7 * (1 - pulse)})`; ctx.lineWidth = 2; ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, 6, 0, 7); ctx.fillStyle = "#ffb86b"; ctx.fill(); ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke();
    }
    requestAnimationFrame(frame);
  };
  frame();
}
