"use strict";

// ?now=2026-11-14T03:30:00Z shows the page as it will look at that moment (handy for trying the trip out).
{ const q = new URLSearchParams(location.search).get("now"); if (q && !Number.isNaN(Date.parse(q))) { const off = Date.parse(q) - Date.now(), real = Date.now.bind(Date); Date.now = () => real() + off; } }

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
  catch (_) { err.textContent = "Fel användarnamn eller lösenord."; err.hidden = false; const card = $("loginForm"); card.classList.remove("bad"); void card.offsetWidth; card.classList.add("bad"); }
  btn.disabled = false; btn.textContent = "Logga in";
});
document.querySelectorAll(".tabbar button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
function showTab(id) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${id}`));
  const shown = document.getElementById(`tab-${id}`); if (shown) shown.querySelectorAll(".rise").forEach((n) => { n.style.animation = "none"; void n.offsetWidth; n.style.animation = ""; });
  document.querySelectorAll(".tabbar button").forEach((x) => x.classList.toggle("on", x.dataset.tab === id));
  window.scrollTo({ top: 0 });
  requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
}
$("logout").addEventListener("click", () => { try { sessionStorage.removeItem("resan.k"); } catch (_) {} location.reload(); });
resume().then((d) => { if (d) start(d); });

/* ---------- Helpers ---------- */

const SV = "sv-SE";
const fmt = (ms, zone, opts) => new Intl.DateTimeFormat(SV, { timeZone: zone, ...opts }).format(ms);
const dayLabel = (iso) => new Intl.DateTimeFormat(SV, { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(iso.slice(0, 10) + "T12:00:00Z")).replace(".", "");
const hhmm = (iso) => (iso.includes("T") ? iso.slice(11, 16) : null);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
/** Gives the children of a container their place in a staggered entrance. */
function stagger(box, step = 55) { [...box.children].forEach((c, i) => { c.classList.add("rise"); c.style.setProperty("--i", i); c.style.animationDelay = `${i * step}ms`; }); }

let revealer;
function revealOnScroll(nodes) {
  revealer = revealer || new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); revealer.unobserve(e.target); } }), { threshold: 0.12 });
  nodes.forEach((n) => { n.classList.add("reveal"); revealer.observe(n); });
}

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

/* Real tracks of recent flights with the same numbers (OpenSky), as in the app; flights without one follow the great circle. */
let TRACKS = {};
const ROAD_LA = [[98.9862, 8.0991], [99.005, 8.1], [99.07, 8.069], [99.159, 8.008], [99.204, 7.974], [99.211, 7.927], [99.204, 7.832], [99.187, 7.731], [99.153, 7.69], [99.115, 7.66], [99.07, 7.64], [99.0233, 7.6448]];

async function loadRoutes() {
  try { TRACKS = await (await fetch("assets/routes.json?v=" + window.__V)).json(); legs = buildLegs(); } catch (_) {}
}

/** The line a leg follows on the globe, from the start to the end. */
function pathOf(l) {
  if (l.kind === "fly") {
    const t = TRACKS[l.flight.number.replace(" ", "")];
    if (t && t.length > 3) return [coord(l.from), ...t, coord(l.to)];
  }
  if ((l.from === "KBV" && l.to === "LANTA") || (l.from === "LANTA" && l.to === "KBV")) return l.from === "KBV" ? ROAD_LA : [...ROAD_LA].reverse();
  return [coord(l.from), coord(l.to)];
}

/** The point a fraction of the way along a line of [lon, lat] points. */
function along(path, f) {
  const d = []; let total = 0;
  for (let i = 0; i + 1 < path.length; i++) { const x = d3.geoDistance(path[i], path[i + 1]); d.push(x); total += x; }
  let t = Math.max(0, Math.min(1, f)) * total;
  for (let i = 0; i < d.length; i++) { if (t <= d[i] || i === d.length - 1) return d3.geoInterpolate(path[i], path[i + 1])(d[i] ? Math.min(1, t / d[i]) : 1); t -= d[i]; }
  return path[0];
}

const coord = (id) => { const p = T.places[id === "KBV" ? "KBV" : id]; return [p.lon, p.lat]; };

/* ---------- Live flight times (read from the family's own status service, never from the browser to a flight API) ---------- */

const STATUS_URL = "https://tmqpfgmqywipbjqgkbtz.supabase.co/functions/v1/flight-public";

async function loadStatus() {
  try {
    const r = await (await fetch(STATUS_URL, { cache: "no-store" })).json();
    for (const st of r.flights || []) {
      const f = T.flights.find((x) => x.number.replace(" ", "") === String(st.number).replace(" ", ""));
      if (!f || !st.known) continue;
      f.live = st;
      if (st.dep) f.dep = st.dep;
      if (st.arr) f.arr = st.arr;
    }
    legs = buildLegs(); renderFlights(); renderStatus();
  } catch (_) { /* the plan's own times are shown */ }
}

/* ---------- Page ---------- */

function start(data) {
  T = data; legs = buildLegs();
  $("login").hidden = true; $("app").hidden = false;
  $("title").textContent = T.title;
  document.title = "Resan";
  renderPlaces(); renderFlights(); renderHotels(); renderTimeline();
  T.flights.forEach((f) => { f.depPlan = f.dep; f.arrPlan = f.arr; });
  tick(); setInterval(tick, 1000);
  initGlobe();
  loadWeather();
  loadStatus(); setInterval(loadStatus, 120000);
  loadRoutes();
}

function tick() { renderStatus(); updateClocks(); }

const H = 3600e3, MIN = 60e3;

/** Which of the trip's places a text is about (an airport, a hotel or a city). */
function placeOfText(t) {
  const x = t.toLowerCase();
  if (x.includes("krabi")) return "KBV";
  if (x.includes("twin bay") || x.includes("lanta")) return "LANTA";
  if (x.includes("grande") || x.includes("bangkok")) return "BKK";
  if (x.includes("fairmont") || x.includes("mumbai")) return "BOM";
  if (x.includes("nashik")) return "NASHIK";
  return null;
}

/** Everything that fills the trip's time, with estimates where the plan has none (immigration, drive times, airport margins). */
function buildSegments() {
  const segs = [];
  const flights = [...T.flights].sort((a, b) => a.dep - b.dep);
  for (const f of flights) segs.push({ kind: "flight", flight: f, start: f.dep, end: f.arr, from: f.from, to: f.to, label: `${f.number} ${T.places[f.from].name} → ${T.places[f.to].name}`, f });
  for (let i = 0; i + 1 < flights.length; i++) {
    const a = flights[i], b = flights[i + 1];
    if (a.to === b.from && b.dep - a.arr < 14 * H) segs.push({ kind: "layover", start: a.arr, end: b.dep, place: a.to, next: b });
  }
  for (const t of T.transfers) {
    const from = placeOfText(t.from), to = placeOfText(t.to);
    if (!from || !to) continue;
    if (/^Hämtning/.test(t.title)) {                       // from the airport to the hotel, after landing and passport control
      const f = flights.find((x) => x.to === from && Math.abs(x.arr - t.when) < 36 * H); if (!f) continue;
      const start = f.arr + 40 * MIN, dur = (t.driveMin || (to === "LANTA" ? 150 : 25)) * MIN;
      segs.push({ kind: "transfer", start, end: start + dur, from, to, label: t.title.replace(/^Hämtning /, "Transfer ") });
    } else if (/flygplats/i.test(t.to)) {                  // from the hotel to the airport, in time for check-in
      const f = flights.find((x) => x.from === to && Math.abs(x.dep - t.when) < 36 * H); if (!f) continue;
      const end = f.dep - 2.5 * H;
      segs.push({ kind: "transfer", start: end - (t.driveMin || 90) * MIN, end, from, to, label: t.title });
    }
  }
  for (const f of flights) segs.push({ kind: "arrival", start: f.arr, end: f.arr + 40 * MIN, place: f.to === "KBV" ? "KBV" : f.to, f });
  const stays = new Map();
  for (const h of T.hotels) { const e = stays.get(h.name) || { ...h }; e.out = Math.max(e.out, h.out); stays.set(h.name, e); }
  for (const h of stays.values()) {
    // The stay starts when the family is there: at check-in, or after landing and the drive if that is later.
    const city = h.place === "LANTA" ? "KBV" : h.place;
    const f = flights.find((x) => x.to === city && x.arr > h.in - 14 * H && x.arr < h.out);
    const reach = f ? f.arr + (h.place === "LANTA" ? 130 : 65) * MIN : 0;
    segs.push({ kind: "hotel", start: f ? reach : h.in, end: h.out, place: h.place, hotel: h });
  }
  for (const e of T.events) segs.push({ kind: "event", start: e.start, end: e.start + (/Bröllop:/.test(e.title) ? 4 : 4) * H, place: "NASHIK", event: e });
  return segs;
}

const RANK = { flight: 5, car: 5, arrival: 4, transfer: 4, event: 3, layover: 2, hotel: 1 };
const ZOOM = { flight: 2.2, car: 2.0, arrival: 3.0, transfer: 3.0, event: 3.2, layover: 3.0, hotel: 3.0 };

/** What the family is doing right now, where on the globe that is, and how close to zoom. */
let actMemo = { at: 0, v: null };
function activityAt(now) {
  if (actMemo.v && Math.abs(now - actMemo.at) < 400) return actMemo.v;
  actMemo = { at: now, v: computeActivity(now) }; return actMemo.v;
}

function computeActivity(now) {
  const segs = [...buildSegments(), ...legs.filter((l) => l.kind === "car").map((l) => ({ kind: "car", start: l.start, end: l.end, from: l.from, to: l.to, label: l.label }))];
  const cur = segs.filter((x) => now >= x.start && now < x.end).sort((a, b) => RANK[b.kind] - RANK[a.kind])[0];
  const next = segs.filter((x) => x.start > now && (x.kind === "flight" || x.kind === "car" || x.kind === "transfer")).sort((a, b) => a.start - b.start)[0];
  const frac = cur ? Math.min(1, Math.max(0, (now - cur.start) / (cur.end - cur.start))) : 0;
  const ease = (x) => x * x * (3 - 2 * x);
  let pos, place = null, zoom = 1.6;
  if (cur && (cur.kind === "flight" || cur.kind === "car" || cur.kind === "transfer")) {
    pos = along(pathOf({ ...cur, kind: cur.kind === "flight" ? "fly" : cur.kind }), cur.kind === "flight" ? frac : ease(frac)); zoom = ZOOM[cur.kind];
    if (cur.kind === "transfer") place = cur.to;
  } else if (cur) { pos = coord(cur.place); place = cur.place; zoom = ZOOM[cur.kind]; }
  else { const w = whereAt(now); place = w.place || null; pos = coord(place || "ARN"); zoom = 2.2; }
  if (now < T.start) { pos = coord("ARN"); place = "ARN"; zoom = 1; }
  return { cur, next, frac, pos, place: place === "KBV" ? "LANTA" : place, zoom };
}

const when = (ms, zone, opts = {}) => cap(fmt(ms, zone, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", ...opts }));
const left = (ms) => { const h = Math.floor(ms / H), m = Math.floor(ms / MIN) % 60; return h > 0 ? `${h} h ${m} min` : `${m} min`; };

function nextLine(act) {
  const n = act.next; if (!n) return "";
  const zone = n.f ? n.f.depZone : T.places[n.from]?.zone || "Europe/Stockholm";
  return `Nästa: ${esc(n.label)}, ${when(n.start, zone)} lokal tid`;
}

function renderStatus() {
  const now = Date.now(), box = $("status"), act = activityAt(now), c = act.cur;
  let html;
  if (now < T.start) {
    const d = T.start - now, days = Math.floor(d / 864e5), h = Math.floor(d / 36e5) % 24, m = Math.floor(d / 6e4) % 60, s = Math.floor(d / 1e3) % 60;
    html = `<span class="pill">Snart avresa</span><div class="big">${days} dagar, ${h} h ${m} min ${String(s).padStart(2, "0")} s</div><div class="small">Till avgången från Arlanda fre 13 nov kl 13:00.</div>`;
  } else if (now > T.end + 864e5) {
    html = `<span class="pill">Hemma</span><div class="big">Tillbaka i Stockholm</div><div class="small">Tack för att ni följde med.</div>`;
  } else if (c && c.kind === "flight") {
    html = `<span class="pill live">I luften</span><div class="big">${esc(c.label)}</div><div class="small">${Math.round(act.frac * 100)} % av vägen · ${left(c.end - now)} kvar · landar ${fmt(c.end, c.f.arrZone, { hour: "2-digit", minute: "2-digit" })} lokal tid</div>`;
  } else if (c && c.kind === "car") {
    html = `<span class="pill live">På väg</span><div class="big">${esc(c.label)}</div><div class="small">Bilfärd, ungefär ${left(c.end - now)} kvar</div>`;
  } else if (c && c.kind === "transfer") {
    html = `<span class="pill live">Transfer</span><div class="big">${esc(c.label)}</div><div class="small">Ungefär ${left(c.end - now)} kvar</div>`;
  } else if (c && c.kind === "arrival") {
    html = `<span class="pill live">Just landat</span><div class="big">Landat i ${esc(T.places[c.place].name)}</div><div class="small">Passkontroll och bagage${act.next ? `. ${nextLine(act)}` : ""}</div>`;
  } else if (c && c.kind === "event") {
    html = `<span class="pill live">Nu</span><div class="big">${esc(c.event.title)}</div><div class="small">${esc(c.event.place)}, Nashik · började ${fmt(c.event.start, c.event.zone, { hour: "2-digit", minute: "2-digit" })} lokal tid</div>`;
  } else if (c && c.kind === "layover") {
    html = `<span class="pill">Väntar på flygplatsen</span><div class="big">Flygplatsen i ${esc(T.places[c.place].name)}</div><div class="small">${esc(c.next.number)} till ${esc(T.places[c.next.to].name)} går ${fmt(c.next.dep, c.next.depZone, { hour: "2-digit", minute: "2-digit" })} lokal tid, om ${left(c.next.dep - now)}</div>`;
  } else if (c && c.kind === "hotel") {
    html = `<span class="pill">På hotellet</span><div class="big">${esc(c.hotel.name)}</div><div class="small">${esc(T.places[c.place].name)} · ${nextLine(act) || `utcheckning ${when(c.hotel.out, c.hotel.zone)}`}</div>`;
  } else {
    const p = T.places[act.place || "ARN"];
    html = `<span class="pill">Just nu</span><div class="big">${esc(p.name)}, ${esc(p.country)}</div><div class="small">${nextLine(act)}</div>`;
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
    n.style.setProperty("--bg-img", `url(assets/places/${{ ARN: "arn", LANTA: "kbv", BKK: "bkk", BOM: "bom", NASHIK: "nashik" }[id]}.jpg)`);
    n.innerHTML = `<div class="name">${esc(p.name)}</div><div class="country">${esc(p.country)}</div><div class="clock" data-clock="${id}">--:--</div><div class="day" data-day="${id}"></div><div class="wx" data-wx="${id}"><span class="muted">Hämtar väder…</span></div>`;
    box.appendChild(n);
  }
  stagger(box, 70);
}

function updateClocks() {
  const now = Date.now(), here = { place: activityAt(now).place };
  const se = new Date(now);
  for (const id of SHOWN) {
    const p = T.places[id];
    { const c = document.querySelector(`[data-clock="${id}"]`), t = fmt(now, p.zone, { hour: "2-digit", minute: "2-digit" }); if (c.textContent !== t) c.textContent = t; }
    const off = (tzOffset(p.zone, se) - tzOffset("Europe/Stockholm", se)) / 60;
    const diff = id === "ARN" ? "hemma" : off === 0 ? "samma tid som hemma" : `${off > 0 ? "+" : "−"}${Math.abs(off).toString().replace(".", ",")} h från hemma`;
    document.querySelector(`[data-day="${id}"]`).textContent = `${cap(fmt(now, p.zone, { weekday: "long" }))} · ${diff}`;
    const card = $(`place-${id}`);
    card.classList.toggle("here", here.place === id);
    card.classList.toggle("away", !!here.place && here.place !== id);
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

function planeImage(aircraft) {
  const a = (aircraft || "").toUpperCase();
  return a.includes("A350") ? "assets/planes/a350.jpg" : a.includes("A330") ? "assets/planes/a330.jpg" : a.includes("A320") ? "assets/planes/a320.jpg" : null;
}

const HOTEL_PHOTO = { "Twin Bay Resort": "hotel-twinbay", "Grande Centre Point Sukhumvit 55": "hotel-grande", "Fairmont Mumbai": "hotel-fairmont" };

function flightBadge(f, live) {
  const st = f.live;
  if (live) return `<span class="tag live">I luften</span>`;
  if (!st) return `<span class="tag fly">${esc(f.airline)}</span>`;
  if (st.phase === "cancelled") return `<span class="tag late">Inställt</span>`;
  if (st.phase === "landed") return `<span class="tag fly">Landat</span>`;
  if (st.delayMinutes >= 10) return `<span class="tag late">Försenat ${st.delayMinutes} min</span>`;
  return `<span class="tag ok">I tid</span>`;
}

const zoneName = (z) => z.split("/").pop().replace("_", " ").replace("Kolkata", "Indien").replace("Bangkok", "Thailand").replace("Stockholm", "Sverige").replace("Berlin", "Tyskland");

function timeBlock(ms, plannedMs, zone, local, label) {
  const now = fmt(ms, zone, { hour: "2-digit", minute: "2-digit" }), plan = fmt(plannedMs, zone, { hour: "2-digit", minute: "2-digit" });
  const changed = now !== plan;
  return `<b>${changed ? `<s class="old">${plan}</s> <span class="new">${now}</span>` : now}</b><span>${cap(dayLabel(local))} · ${esc(label)}</span><span class="loc">lokal tid · ${esc(zoneName(zone))}</span>`;
}

function renderFlights() {
  const box = $("flights"); box.innerHTML = ""; const now = Date.now();
  const nextF = T.flights.find((x) => now <= x.arr);
  for (const f of T.flights) {
    const live = now >= f.dep && now <= f.arr, past = now > f.arr, isNext = f === nextF;
    const st = f.live, gate = st && (st.depGate || st.depTerminal) ? `Terminal ${esc(st.depTerminal || "?")}${st.depGate ? `, gate ${esc(st.depGate)}` : ""}` : "";
    const n = el("div", `card glass${isNext ? " next" : " dim"}`);
    const img = planeImage(f.aircraft);
    n.innerHTML = `<div class="row"><span class="num">${esc(f.number)}</span>${isNext && !live ? '<span class="tag next">Nästa flyg</span>' : flightBadge(f, live)}</div>
      ${img ? `<img class="plane-img" src="${img}" alt="${esc(f.aircraft)}" loading="lazy">` : ""}
      <div class="route">${esc(T.places[f.from === "KBV" ? "KBV" : f.from].name)} → ${esc(T.places[f.to].name)}</div>
      <div class="times"><div>${timeBlock(f.dep, f.depPlan ?? f.dep, f.depZone, f.depLocal, f.fromName)}</div><div style="text-align:right">${timeBlock(f.arr, f.arrPlan ?? f.arr, f.arrZone, f.arrLocal, f.toName)}</div></div>
      <div class="sub">${esc(f.airline)}${f.aircraft ? ` · ${esc(f.aircraft)}` : ""}${gate ? ` · ${gate}` : ""}</div>
      ${st ? `<div class="sub live-note">Uppdaterad ${fmt(Date.parse(st.updatedAt), "Europe/Stockholm", { hour: "2-digit", minute: "2-digit" })} svensk tid</div>` : ""}`;
    box.appendChild(n);
  }
  stagger(box, 70);
}

/** Stays that are planned but not booked yet. */
const TBD_STAYS = [{ place: "NASHIK", inLocal: "2026-11-24", outLocal: "2026-11-26", photo: "nashik" }];

function renderHotels() {
  const box = $("hotels"); box.innerHTML = ""; const now = Date.now();
  const seen = new Map();
  for (const h of T.hotels) { const k = h.name; const e = seen.get(k) || { ...h }; e.out = Math.max(e.out, h.out); if (h.outLocal > e.outLocal) e.outLocal = h.outLocal; seen.set(k, e); }
  for (const h of seen.values()) {
    const nights = Math.round((new Date(h.outLocal.slice(0, 10)) - new Date(h.inLocal.slice(0, 10))) / 864e5);
    const here = now >= h.in && now <= h.out, past = now > h.out;
    const photo = HOTEL_PHOTO[h.name];
    const n = el("div", `card glass${past ? " past" : ""}${photo ? " has-photo" : ""}`);
    n.innerHTML = `${photo ? `<img class="photo" src="assets/places/${photo}.jpg" alt="${esc(h.name)}" loading="lazy">` : ""}<div class="row"><span class="num" style="font-size:18px">${esc(h.name)}</span><span class="tag ${here ? "live" : "hotel"}">${here ? "Vi bor här" : `${nights} ${nights === 1 ? "natt" : "nätter"}`}</span></div>
      <div class="route">${esc(T.places[h.place].name)}, ${esc(T.places[h.place].country)}</div>
      <div class="sub">${cap(dayLabel(h.inLocal))} till ${dayLabel(h.outLocal)}</div>`;
    box.appendChild(n);
  }
  for (const t of TBD_STAYS) {
    const nights = Math.round((new Date(t.outLocal) - new Date(t.inLocal)) / 864e5), p = T.places[t.place];
    const n = el("div", "card glass has-photo tbd");
    n.innerHTML = `<img class="photo" src="assets/places/${t.photo}.jpg" alt="${esc(p.name)}" loading="lazy">
      <div class="row"><span class="num" style="font-size:18px">Hotell i ${esc(p.name)}</span><span class="tag tbd">TBD</span></div>
      <div class="route">${esc(p.name)}, ${esc(p.country)}</div>
      <div class="sub">${cap(dayLabel(t.inLocal))} till ${dayLabel(t.outLocal)} · ${nights} nätter · hotellet är inte bestämt än</div>`;
    box.appendChild(n);
  }
  stagger(box, 80);
}

function renderTimeline() {
  const items = [];
  for (const f of T.flights) {
    items.push({ ms: f.dep, local: f.depLocal, icon: "✈️", what: `${f.number} ${T.places[f.from].name} → ${T.places[f.to].name}`, info: `${f.airline}, landar ${hhmm(f.arrLocal)} lokal tid` });
  }
  for (const t of T.transfers) items.push({ ms: t.when, local: t.whenLocal, icon: "🚗", what: t.title, info: t.driveMin ? `Cirka ${Math.floor(t.driveMin / 60) ? Math.floor(t.driveMin / 60) + " h " : ""}${t.driveMin % 60 ? (t.driveMin % 60) + " min" : ""} i bil${t.driveKm ? ` · ${t.driveKm} km` : ""}`.replace(" h  i", " h i") : "" });
  for (const h of T.hotels) {
    items.push({ ms: h.in, local: h.inLocal, icon: "🛏️", what: `Incheckning ${h.name}`, info: T.places[h.place].name });
    items.push({ ms: h.out, local: h.outLocal, icon: "🧳", what: `Utcheckning ${h.name}`, info: T.places[h.place].name });
  }
  for (const t of TBD_STAYS) {
    items.push({ ms: new Date(t.inLocal + "T15:00:00Z").getTime(), local: t.inLocal, icon: "🛏️", what: `Hotell i ${T.places[t.place].name}: TBD`, info: "Inte bestämt än" });
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
      const thumb = /Bröllop|Mottagning/.test(i.what) ? `<img class="thumb" src="assets/places/venue-gulabnagri${/Mottagning/.test(i.what) ? "-night" : ""}.jpg" alt="" loading="lazy">` : "";
      wrap.appendChild(el("div", "item glass", `<div class="t${t ? "" : " none"}">${t || "hela dagen"}</div><div><div class="what">${i.icon} ${esc(i.what)}</div>${i.info ? `<div class="info">${esc(i.info)}</div>` : ""}${thumb}</div>`));
    }
    g.appendChild(wrap); box.appendChild(g);
  }
  revealOnScroll([...box.querySelectorAll(".day-group")]);
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

/** A small airliner seen from above, nose pointing along `angle`. */
function drawPlane(ctx, x, y, angle, scale) {
  const half = [[13, 0], [6, -2.2], [-1, -13], [-5, -13], [-2.5, -2.4], [-9, -1.8], [-11.5, -5.4], [-14, -5.4], [-12.5, 0]];
  ctx.save(); ctx.translate(x, y); ctx.rotate(angle); ctx.scale(scale, scale);
  ctx.beginPath();
  half.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
  [...half].reverse().forEach(([px, py]) => ctx.lineTo(px, -py));
  ctx.closePath(); ctx.fillStyle = "#fff"; ctx.shadowColor = "rgba(84,204,255,.9)"; ctx.shadowBlur = 10; ctx.fill();
  ctx.shadowBlur = 0; ctx.strokeStyle = "rgba(10,24,48,.6)"; ctx.lineWidth = 0.8; ctx.stroke();
  ctx.restore();
}

// The first view is the whole globe from far away; then it glides in to where the family is.
const INTRO = { hold: 500, glide: 2200, zoom: 0.82, rotation: [-58, -22] };
let rotation = [INTRO.rotation[0], INTRO.rotation[1], 0], dragging = false, lastTouch = 0, lastZoomTouch = 0, zoom = INTRO.zoom, land = null, introStart = null, introFrom = null;

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
    proj.translate([r.width / 2, r.height / 2]).scale(Math.min(r.width, r.height) * 0.47 * zoom);
  };
  resize(); window.addEventListener("resize", resize);

  // Drag to turn the globe; it drifts back to the family when you let go.
  let start = null;
  canvas.addEventListener("pointerdown", (e) => { dragging = true; start = { x: e.clientX, y: e.clientY, r: rotation.slice() }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging || pointers.size > 1) return;
    const k = 0.35; rotation = [start.r[0] + (e.clientX - start.x) * k, Math.max(-80, Math.min(80, start.r[1] - (e.clientY - start.y) * k)), 0]; lastTouch = Date.now();
  });
  const setZoom = (z) => { zoom = Math.max(0.8, Math.min(8, z)); lastZoomTouch = Date.now(); lastTouch = Date.now(); };
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); setZoom(zoom * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025))); }, { passive: false });
  const pointers = new Map(); let pinch = null;
  canvas.addEventListener("pointerdown", (e) => { pointers.set(e.pointerId, [e.clientX, e.clientY]); if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), z: zoom }; dragging = false; } });
  canvas.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return; pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 2 && pinch) { const [a, b] = [...pointers.values()]; setZoom(pinch.z * Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.d); }
  });
  const release = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; };
  canvas.addEventListener("pointerup", release); canvas.addEventListener("pointercancel", release);
  $("zin").addEventListener("click", () => setZoom(zoom * 1.5));
  $("zout").addEventListener("click", () => setZoom(zoom / 1.5));
  $("zhere").addEventListener("click", () => { lastZoomTouch = 0; lastTouch = 0; });
  const up = () => { dragging = false; lastTouch = Date.now(); };
  canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up);

  const frame = () => {
    const r = canvas.getBoundingClientRect(), W = r.width, H = r.height, now = Date.now();
    const act = activityAt(now), target = { pos: act.pos };
    introStart = introStart ?? now;
    const it = (now - introStart - INTRO.hold) / INTRO.glide;
    const goal0 = [-target.pos[0], -target.pos[1]];
    if (it < 1 && !dragging) {
      // easeInOutCubic from the far view to the family's place
      const k = it <= 0 ? 0 : it < 0.5 ? 4 * it ** 3 : 1 - ((-2 * it + 2) ** 3) / 2;
      let dl = goal0[0] - INTRO.rotation[0]; dl = ((dl + 540) % 360) - 180;
      zoom = INTRO.zoom + (act.zoom - INTRO.zoom) * k;
      rotation = [INTRO.rotation[0] + dl * k, INTRO.rotation[1] + (goal0[1] - INTRO.rotation[1]) * k, 0];
    } else if (now - lastZoomTouch > 6000) zoom += (act.zoom - zoom) * 0.035;
    proj.scale(Math.min(W, H) * 0.47 * zoom);
    if (it >= 1 && !dragging && now - lastTouch > 3000) {
      const goal = [-target.pos[0], -target.pos[1]];
      let dl = goal[0] - rotation[0]; dl = ((dl + 540) % 360) - 180;
      rotation = [rotation[0] + dl * 0.045, rotation[1] + (goal[1] - rotation[1]) * 0.045, 0];
    }
    proj.rotate(rotation);
    ctx.clearRect(0, 0, W, H);
    for (const [i, s] of stars.entries()) { const tw = 0.5 + 0.5 * Math.sin(now / 900 + i * 1.7); ctx.fillStyle = `rgba(255,255,255,${(0.08 + s[2] * 0.2) * (0.4 + tw)})`; ctx.fillRect(s[0] * W, s[1] * H, s[2], s[2]); }
    const R = proj.scale();
    // glow
    const g = ctx.createRadialGradient(W / 2, H / 2, R * 0.9, W / 2, H / 2, R * 1.25);
    g.addColorStop(0, `rgba(84,204,255,${0.24 + 0.06 * Math.sin(now / 1400)})`); g.addColorStop(1, "rgba(84,204,255,0)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(W / 2, H / 2, R * 1.25, 0, 7); ctx.fill();
    // ocean
    const o = ctx.createRadialGradient(W / 2 - R * 0.3, H / 2 - R * 0.3, R * 0.1, W / 2, H / 2, R);
    o.addColorStop(0, "#17345c"); o.addColorStop(1, "#0a1830");
    ctx.beginPath(); path({ type: "Sphere" }); ctx.fillStyle = o; ctx.fill();
    ctx.beginPath(); path(graticule); ctx.strokeStyle = "rgba(255,255,255,.06)"; ctx.lineWidth = 0.6; ctx.stroke();
    if (land) { ctx.beginPath(); path(land); ctx.fillStyle = "#2c4a72"; ctx.fill(); ctx.strokeStyle = "rgba(160,200,255,.25)"; ctx.lineWidth = 0.6; ctx.stroke(); }
    // legs
    for (const l of legs) {
      const line = { type: "LineString", coordinates: pathOf(l) };
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
    // the plane: the real one while a flight is on, otherwise one that shows the whole route again and again
    const flyLegs = legs.filter((l) => l.kind === "fly");
    let planeLeg = flyLegs.find((l) => now >= l.start && now < l.end), planeF;
    if (planeLeg) planeF = (now - planeLeg.start) / (planeLeg.end - planeLeg.start);
    else if (flyLegs.length) { const per = 6500, t = (now % (per * flyLegs.length)) / per; planeLeg = flyLegs[Math.floor(t)]; const x = t - Math.floor(t); planeF = x * x * (3 - 2 * x); }
    if (planeLeg) {
      const line = pathOf(planeLeg), at = (f) => along(line, f);
      const p0 = at(planeF), p1 = at(Math.min(1, planeF + 0.012)), back = at(Math.max(0, planeF - 0.25));
      if (d3.geoDistance(p0, [-rotation[0], -rotation[1]]) < Math.PI / 2 - 0.02) {
        const trail = Array.from({ length: 16 }, (_, i) => at(Math.max(0, planeF - 0.25) + (planeF - Math.max(0, planeF - 0.25)) * i / 15));
        ctx.beginPath(); path({ type: "LineString", coordinates: trail }); ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.lineWidth = 2.2; ctx.shadowColor = "#54ccff"; ctx.shadowBlur = 12; ctx.stroke(); ctx.shadowBlur = 0;
        const [x, y] = proj(p0), [x2, y2] = proj(p1);
        drawPlane(ctx, x, y, Math.atan2(y2 - y, x2 - x), 1.15);
      }
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
