/**
 * Archive UI — a clean, Facebook-like single-page app over the fbarchive JSON API.
 *
 * Routes (hash):
 *   #/                         home: on-this-day memories + contacts
 *   #/search?q&kind&with&author&thread&since&until&sort
 *   #/messages[/<thread>]?at=  Messenger-style inbox + conversation
 *   #/people?q   #/person/<id>[/photos|/posts]
 *   #/memories                 archive over time
 *   #/photos?since&until&with&thread&kind&sort
 * All state lives in the URL, so every screen can be bookmarked or reloaded.
 */
"use strict";

// ---------------------------------------------------------------- utilities
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const app = $("#app");
const HL_START = "\x02", HL_END = "\x03";
const ME = { id: null, name: "", avatar: null, cover: null };
let STATS = null;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const hl = (s) => esc(s).replaceAll(HL_START, "<mark>").replaceAll(HL_END, "</mark>");
const linkify = (html) => html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
const num = (n) => Number(n || 0).toLocaleString();
const plural = (n, w) => `${num(n)} ${w}${n === 1 ? "" : "s"}`;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const enc = encodeURIComponent;

const LOCALE = undefined;
const fmtDate = (ms) => ms ? new Date(ms).toLocaleDateString(LOCALE, { day: "numeric", month: "long", year: "numeric" }) : "Undated";
const fmtTime = (ms) => new Date(ms).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });
// One locale-aware call, so French reads "23 octobre 2021 à 19:30" rather than mixing languages.
const fmtLong = (ms) => ms ? new Date(ms).toLocaleString(LOCALE, { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "Undated";
const fmtMonth = (ms) => new Date(ms).toLocaleDateString(LOCALE, { month: "long", year: "numeric" });
const fmtShort = (ms) => {
  if (!ms) return "";
  const d = new Date(ms), now = new Date();
  return d.getFullYear() === now.getFullYear()
    ? d.toLocaleDateString(LOCALE, { day: "numeric", month: "short" })
    : d.toLocaleDateString(LOCALE, { month: "short", year: "numeric" });
};
const yearOf = (ms) => new Date(ms).getFullYear();
const isoDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

async function api(path, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "" && v != null));
  const r = await fetch(`/api/${path}${qs.toString() ? "?" + qs : ""}`);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}
const qsOf = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "" && v != null)).toString();
const href = (path, params = {}) => { const q = qsOf(params); return "#" + path + (q ? "?" + q : ""); };
function go(path, params = {}, replace = false) {
  const h = href(path, params);
  if (replace) { history.replaceState(null, "", h); render(); } else location.hash = h;
}

// ---------------------------------------------------------------- icons (Feather, MIT)
const ICONS = {
  home: '<path d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  search: '<circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.2" y2="16.2"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  comment: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21.2l7.8-7.7 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>',
  userPlus: '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.7-4 3-9 3s-9-1.3-9-3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/>',
  bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  left: '<polyline points="15 18 9 12 15 6"/>',
  right: '<polyline points="9 18 15 12 9 6"/>',
  info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  file: '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  star: '<polygon points="12 2 15.1 8.3 22 9.3 17 14.1 18.2 21 12 17.8 5.8 21 7 14.1 2 9.3 8.9 8.3 12 2"/>',
  mail: '<path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><polyline points="22 6 12 13 2 6"/>',
  mapPin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  sparkles: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/>',
};
const icon = (n, cls = "") => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ""}</svg>`;

const EVENTS_DIR = "your_facebook_activity/events/";
const KINDS = {
  message: { label: "Messages", icon: "chat", color: "#0a7cff" },
  post: { label: "Posts", icon: "edit", color: "#45bd62" },
  comment: { label: "Comments", icon: "comment", color: "#f7b928" },
  photo: { label: "Photos", icon: "image", color: "#e42645" },
  video: { label: "Videos", icon: "play", color: "#f02849" },
  event: { label: "Events", icon: "calendar", color: "#f5533d" },
  reaction: { label: "Reactions", icon: "heart", color: "#f33e58" },
  friend: { label: "Friends", icon: "userPlus", color: "#1877f2" },
  group: { label: "Groups", icon: "grid", color: "#7b5cd6" },
  saved: { label: "Saved", icon: "bookmark", color: "#8c50e0" },
  search: { label: "Searches", icon: "search", color: "#5b6b7c" },
  activity: { label: "Activity", icon: "activity", color: "#2abba7" },
  log: { label: "Meta logs", icon: "database", color: "#65686c" },
};
// Kinds that are always the owner's own activity even when no author is recorded.
const OWN_KINDS = new Set(["post", "comment", "reaction", "photo", "video", "saved", "search", "event", "group"]);

// ---------------------------------------------------------------- avatars
const PALETTE = ["#f35369", "#f7923b", "#45bd62", "#1ab7ea", "#0866ff", "#7b5cd6", "#e05dab", "#2abba7", "#d4a017", "#5e8ce6", "#c46b3c", "#8f60c7"];
function colorOf(name) { let h = 0; for (const c of name || "?") h = (h * 31 + c.codePointAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; }
function initials(name) {
  const w = (name || "?").replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (!w.length) return "?";
  return ((w[0][0] || "") + (w.length > 1 ? w[w.length - 1][0] : "")).toUpperCase();
}
const isMe = (name) => !!name && name === ME.name;
function avatar(name, size = 40) {
  const st = `width:${size}px;height:${size}px`;
  if (isMe(name) && ME.avatar) return `<img class="av" style="${st}" src="/thumb/${ME.avatar}?s=${size > 80 ? 320 : 160}" alt="">`;
  return `<span class="av" style="${st};background:${colorOf(name)};font-size:${Math.round(size * 0.4)}px">${esc(initials(name))}</span>`;
}
/** Two overlapping single-initial discs, like Messenger's group avatars. */
function groupAvatar(title, size = 40) {
  const parts = String(title || "").split(/,| and /).map((s) => s.trim()).filter(Boolean);
  const a = parts[0] || title || "?", b = parts[1] || `${a} ·`;
  const s = Math.round(size * 0.68), fs = Math.round(s * 0.45);
  const disc = (n) => `<span class="av" style="width:${s}px;height:${s}px;background:${colorOf(n)};font-size:${fs}px">${esc(initials(n)[0])}</span>`;
  return `<span class="av-group" style="width:${size}px;height:${size}px">${disc(b)}${disc(a)}</span>`;
}
function kindAvatar(kind, size = 40) {
  const k = KINDS[kind] || KINDS.activity;
  return `<span class="av" style="width:${size}px;height:${size}px;background:${k.color}">${icon(k.icon, size < 36 ? "sm" : "")}</span>`;
}
const threadAvatar = (t, size) => (t.is_group ? groupAvatar(t.title, size) : avatar(t.title, size));

// ---------------------------------------------------------------- observers
let routeObservers = [];
/** Calls `load` when `sentinel` nears the viewport of `root` (null = window), until it returns false. */
function infinite(sentinel, load, root = null, bucket = routeObservers) {
  let busy = false, done = false;
  const io = new IntersectionObserver(async (entries) => {
    if (!entries[0].isIntersecting || busy || done) return;
    busy = true;
    try { done = (await load()) === false; } catch (e) { console.error(e); done = true; } finally { busy = false; }
    if (done) { io.disconnect(); return; }
    // Still visible after loading (short pages): observe again to keep filling.
    io.unobserve(sentinel); io.observe(sentinel);
  }, { root, rootMargin: "800px 0px" });
  io.observe(sentinel);
  bucket.push(io);
  return io;
}
const spinner = () => `<div class="loading"><div class="spinner"></div></div>`;

// ---------------------------------------------------------------- overlay: modal + theater
const overlay = $("#overlay");
let overlayKeys = null;
function openOverlay(html, onKey = null) {
  overlay.innerHTML = html;
  overlay.hidden = false;
  document.body.style.overflow = "hidden";
  overlayKeys = onKey;
}
function closeOverlay() {
  overlay.hidden = true; overlay.innerHTML = ""; overlayKeys = null;
  document.body.style.overflow = "";
}
overlay.addEventListener("click", (e) => {
  if (e.target.classList.contains("modal-bg") || e.target.closest("[data-close]")) closeOverlay();
  if (e.target.closest("a[href^='#']")) closeOverlay();
});
addEventListener("keydown", (e) => {
  if (!overlay.hidden) {
    if (e.key === "Escape") closeOverlay();
    else overlayKeys?.(e);
    return;
  }
  const tag = document.activeElement?.tagName;
  if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA") { e.preventDefault(); $("#q").focus(); }
});

function modal(title, body) {
  openOverlay(`<div class="modal-bg"><div class="modal" role="dialog">
    <div class="modal-head"><span></span><h3>${esc(title)}</h3><button class="close-btn" data-close aria-label="Close">${icon("x")}</button></div>
    ${body}</div></div>`);
}

/** Photo/video theater over every media tile of the current view, with ←/→ navigation. */
function openTheater(tile) {
  const tiles = $$("[data-lb]", app);
  let i = Math.max(0, tiles.indexOf(tile));
  const show = () => {
    const d = tiles[i].dataset;
    const media = d.mtype === "video"
      ? `<video src="/media/${d.lb}" controls autoplay playsinline></video>`
      : `<img src="/media/${d.lb}" alt="">`;
    const who = d.author || ME.name;
    openOverlay(`<div class="theater">
      <div class="th-stage">${media}
        <button class="icon-btn th-close" data-close aria-label="Close">${icon("x")}</button>
        <button class="th-nav prev" ${i === 0 ? "disabled" : ""} aria-label="Previous">${icon("left", "lg")}</button>
        <button class="th-nav next" ${i === tiles.length - 1 ? "disabled" : ""} aria-label="Next">${icon("right", "lg")}</button>
        <div class="th-count">${i + 1} / ${tiles.length}</div>
      </div>
      <aside class="th-side">
        <div class="p-head">${avatar(who, 40)}<div class="p-who">
          <div class="p-name">${esc(who)}</div>
          <div class="p-meta">${esc(fmtLong(+d.ts || 0))}</div></div></div>
        ${d.where ? `<p class="muted" style="margin:14px 0 0">${esc(d.where)}</p>` : ""}
        <div class="th-actions">
          ${d.ctx ? `<a class="btn primary" href="${esc(d.ctx)}">${icon("chat", "sm")} Open in conversation</a>` : ""}
          ${d.ts ? `<a class="btn" href="${href("/search", { since: isoDay(+d.ts), until: isoDay(+d.ts), sort: "old" })}">${icon("calendar", "sm")} What happened that day</a>` : ""}
          <a class="btn" href="/media/${d.lb}" target="_blank">${icon("external", "sm")} Open original</a>
        </div>
      </aside></div>`, (e) => {
      if (e.key === "ArrowLeft" && i > 0) { i--; show(); }
      if (e.key === "ArrowRight" && i < tiles.length - 1) { i++; show(); }
    });
    $(".th-nav.prev", overlay).onclick = () => { if (i > 0) { i--; show(); } };
    $(".th-nav.next", overlay).onclick = () => { if (i < tiles.length - 1) { i++; show(); } };
  };
  show();
}
app.addEventListener("click", (e) => {
  const tile = e.target.closest("[data-lb]");
  if (!tile) return;
  e.preventDefault(); e.stopPropagation();
  openTheater(tile);
});

/** data-* attributes that feed the theater side panel. */
function lbAttrs(m, it) {
  const ctx = it?.thread_id ? href(`/messages/${enc(it.thread_id)}`, { at: it.item_id ?? it.id }) : "";
  const where = it?.thread_title || it?.title || "";
  return `data-lb="${m.id}" data-mtype="${m.mtype}" data-ts="${it?.ts || ""}" data-author="${esc(it?.author || "")}" data-ctx="${esc(ctx)}" data-where="${esc(where)}"`;
}

// ---------------------------------------------------------------- person picker
/** Turns `input` into a people autocomplete; calls onPick(person). */
function personPicker(input, onPick) {
  const menu = document.createElement("div");
  menu.className = "picker-menu"; menu.hidden = true;
  input.parentElement.classList.add("picker");
  input.after(menu);
  let people = [], sel = 0;
  const draw = () => {
    menu.innerHTML = people.map((p, k) => `<div class="pick${k === sel ? " on" : ""}" data-k="${k}">${avatar(p.name, 28)}<span class="ell">${esc(p.name)}</span><span class="sub">${num(p.n_items)}</span></div>`).join("")
      || `<div class="pick muted">No one found</div>`;
    menu.hidden = false;
  };
  input.addEventListener("input", debounce(async () => {
    if (input.value.trim().length < 2) { menu.hidden = true; return; }
    people = await api("people", { q: input.value.trim(), limit: 8 }); sel = 0; draw();
  }, 120));
  input.addEventListener("keydown", (e) => {
    if (menu.hidden) return;
    if (e.key === "ArrowDown") { sel = Math.min(sel + 1, people.length - 1); draw(); e.preventDefault(); }
    if (e.key === "ArrowUp") { sel = Math.max(sel - 1, 0); draw(); e.preventDefault(); }
    if (e.key === "Enter" && people[sel]) onPick(people[sel]);
  });
  menu.addEventListener("mousedown", (e) => { const k = e.target.closest("[data-k]")?.dataset.k; if (k != null) onPick(people[+k]); });
  input.addEventListener("blur", () => setTimeout(() => (menu.hidden = true), 150));
}

// ---------------------------------------------------------------- histogram
function monthRange(a, b) {
  const out = []; let [y, m] = a.split("-").map(Number); const [by, bm] = b.split("-").map(Number);
  while (y < by || (y === by && m <= bm)) { out.push(`${y}-${String(m).padStart(2, "0")}`); if (++m > 12) { m = 1; y++; } }
  return out;
}
function histogram(el, rows, { onPick, selected, height = 72, stacked = false } = {}) {
  if (!rows.length) { el.innerHTML = `<div class="sub">No dated results.</div>`; return; }
  const by = new Map();
  for (const r of rows) { const m = by.get(r.month) || {}; m[r.kind] = (m[r.kind] || 0) + r.n; by.set(r.month, m); }
  const months = monthRange(rows[0].month, rows[rows.length - 1].month);
  const tot = months.map((m) => Object.values(by.get(m) || {}).reduce((a, b) => a + b, 0));
  const max = Math.max(...tot, 1), w = 1000 / months.length, gap = months.length > 120 ? 0.15 : 0.25;
  let bars = "";
  months.forEach((mo, i) => {
    if (!tot[i]) return;
    const x = i * w, bw = Math.max(w * (1 - gap), 1);
    if (!stacked) {
      const h = Math.max(3, (tot[i] / max) * height);
      bars += `<rect data-m="${mo}" class="${selected && mo.startsWith(selected) ? "on" : ""}" x="${x}" y="${height - h}" width="${bw}" height="${h}" rx="${Math.min(bw / 2, 2)}"><title>${mo} · ${num(tot[i])}</title></rect>`;
      return;
    }
    let y = height;
    for (const [k, n] of Object.entries(by.get(mo))) {
      const h = (n / max) * height; y -= h;
      bars += `<rect data-m="${mo}" x="${x}" y="${y}" width="${bw}" height="${h}" style="fill:${(KINDS[k] || KINDS.activity).color};opacity:.9"><title>${mo} · ${KINDS[k]?.label || k}: ${num(n)}</title></rect>`;
    }
  });
  const years = [...new Set(months.map((m) => m.slice(0, 4)))];
  const step = Math.ceil(years.length / (el.clientWidth > 500 ? 12 : 6));
  el.innerHTML = `<svg viewBox="0 0 1000 ${height}" preserveAspectRatio="none" style="height:${height}px">${bars}</svg>
    <div class="hist-axis">${years.filter((_, k) => k % step === 0).map((y) => `<span>${y}</span>`).join("")}</div>`;
  $("svg", el).addEventListener("click", (e) => { const m = e.target.dataset?.m; if (m) onPick?.(m); });
}

// ---------------------------------------------------------------- post card
// URLs use the content uid, stable across index rebuilds (row ids are not).
const msgHref = (it) => href(`/messages/${enc(it.thread_id)}`, { at: it.uid || it.id });
const nicePath = (c) => { const s = (c || "").split("/").pop().replace(/_\d+$/, "").replace(/_/g, " "); return s.charAt(0).toUpperCase() + s.slice(1); };
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } }

function postMedia(media, it) {
  const vis = (media || []).filter((m) => m.mtype === "photo" || m.mtype === "gif" || m.mtype === "video");
  const other = (media || []).filter((m) => !vis.includes(m) && m.mtype !== "sticker");
  let html = "";
  if (vis.length) {
    const n = Math.min(vis.length, 4);
    html += `<div class="pm pm-${n}">` + vis.slice(0, n).map((m, k) => {
      const inner = m.mtype === "video"
        ? `<video preload="metadata" muted src="/media/${m.id}#t=0.5"></video><div class="play"><span>${icon("play")}</span></div>`
        : `<img loading="lazy" src="/thumb/${m.id}?s=${n === 1 ? 640 : 320}" alt="">`;
      const more = k === n - 1 && vis.length > n ? `<div class="pm-more">+${vis.length - n}</div>` : "";
      return `<div class="pm-tile" ${lbAttrs(m, it)}>${inner}${more}</div>`;
    }).join("") + `</div>`;
  }
  for (const m of other) {
    html += m.mtype === "audio"
      ? `<div class="p-extra"><audio controls preload="none" src="/media/${m.id}"></audio></div>`
      : `<a class="linkcard" href="/media/${m.id}" target="_blank"><span class="lc-ic">${icon("file")}</span><span class="ell"><div class="lc-host">Attachment</div><div class="lc-url ell">${esc(m.name)}</div></span></a>`;
  }
  return html;
}

function linkCards(it) {
  const share = it.extra?.share;
  const links = [...(share?.link ? [share.link] : []), ...(it.extra?.links || [])];
  return [...new Set(links)].slice(0, 2).map((u) => `<a class="linkcard" href="${esc(u)}" target="_blank" rel="noopener">
    <span class="lc-ic">${icon("link")}</span><span class="ell"><div class="lc-host">${esc(hostOf(u))}</div><div class="lc-url ell">${esc(share?.share_text && u === share.link ? share.share_text : u)}</div></span></a>`).join("");
}

/** Bold the owner's name at the start of Facebook's "X shared a link." titles. */
function titleHtml(t) {
  if (ME.name && t.startsWith(ME.name)) return `<a href="#/person/${ME.id}">${esc(ME.name)}</a><span class="thin">${esc(t.slice(ME.name.length))}</span>`;
  return esc(t);
}

// ---------------------------------------------------------------- events
const RSVP = {
  going: { label: "Going", icon: "check" },
  interested: { label: "Interested", icon: "star" },
  hosted: { label: "Your event", icon: "user" },
  declined: { label: "Can't go", icon: "x" },
  invited: { label: "Invited", icon: "mail" },
  visited: { label: "Viewed", icon: "eye" },
};
const itemHref = (it) => (it.thread_id ? msgHref(it) : `#/item/${it.uid || it.id}`);
const rsvpPill = (r) => r && RSVP[r] ? `<span class="rsvp rsvp-${r}">${icon(RSVP[r].icon, "sm")}${RSVP[r].label}</span>` : "";
function dateTile(ms, big = false) {
  if (!ms) return `<div class="dtile${big ? " big" : ""}"><span>—</span><b>?</b></div>`;
  const d = new Date(ms);
  return `<div class="dtile${big ? " big" : ""}"><span>${esc(d.toLocaleDateString(LOCALE, { month: "short" }).replace(".", ""))}</span><b>${d.getDate()}</b></div>`;
}
/** "SATURDAY 16 JANUARY 2010 AT 19:30 – 02:30", with the end date when it's another day. */
function eventWhen(ev) {
  if (!ev?.start) return "Date unknown";
  const s = new Date(ev.start);
  let out = s.toLocaleString(LOCALE, { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
  if (ev.end && ev.end > ev.start) {
    const sameDay = ev.end - ev.start < 20 * 3600 * 1000;
    out += ` – ${sameDay ? fmtTime(ev.end) : new Date(ev.end).toLocaleString(LOCALE, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}`;
  }
  return out;
}
function eventCard(it) {
  const ev = it.extra?.event || {};
  const el = document.createElement("article");
  el.className = "card ev-card";
  const snippet = it.snippet && it.snippet.includes(HL_START) && it.body ? `<div class="ev-snip">${hl(it.snippet)}</div>` : "";
  el.innerHTML = `<a class="ev-row" href="${itemHref(it)}">${dateTile(ev.start || it.ts)}
    <div class="ev-main"><div class="ev-when">${esc(eventWhen(ev))}</div>
      <div class="ev-title">${hl(it.title || "Event")}</div>
      ${ev.place ? `<div class="sub ell">${icon("mapPin", "xs")} ${esc(ev.place)}</div>` : ""}${snippet}</div>
    ${rsvpPill(ev.rsvp)}</a>`;
  return el;
}

function postCard(it, { full = false } = {}) {
  if (it.kind === "event" && it.extra?.event && !full) return eventCard(it);
  const msg = !!it.thread_id;
  const who = it.author || (OWN_KINDS.has(it.kind) ? ME.name : null);
  const av = who ? avatar(who, 40) : kindAvatar(it.kind, 40);
  const kind = KINDS[it.kind] || KINDS.activity;
  let name;
  if (msg) {
    name = `<a href="#/person/${it.author_id}">${esc(it.author)}</a> ${icon("right", "xs")} <a href="${msgHref(it)}">${esc(it.thread_title)}</a>`;
  } else if (it.title) {
    name = titleHtml(it.title);
  } else {
    name = who ? `<a href="#/person/${it.author_id || ME.id}">${esc(who)}</a>` : esc(kind.label);
  }
  // Items without a body only carry Facebook's metadata: show it small, not as the post text.
  const raw = it.body ? (full ? it.body : it.snippet || it.body) : "";
  const text = full ? linkify(esc(raw)) : hl(raw);
  const big = !msg && it.kind === "post" && raw.length < 90 && !(it.media || []).length
    && !raw.includes(HL_START) && !/https?:\/\//.test(raw);
  const metaText = it.body ? (full ? it.meta : "") : full ? it.meta : it.snippet || it.meta;
  const meta = metaText ? `<div class="p-extra">${full ? linkify(esc(metaText)) : hl(metaText)}</div>` : "";
  const el = document.createElement("article");
  el.className = "card post";
  el.innerHTML = `
    <div class="p-head">${av}<div class="p-who">
      <div class="p-name">${name}</div>
      <div class="p-meta"><span title="${esc(fmtLong(it.ts))}">${esc(fmtDate(it.ts))}</span> · ${icon(kind.icon, "xs")}
        <span>${msg ? "Messenger" : esc(nicePath(it.category) || kind.label)}</span></div>
    </div></div>
    ${raw ? `<div class="p-text${big ? " big" : ""}">${text}</div>` : `<div style="height:10px"></div>`}
    ${meta}${linkCards(it)}${postMedia(it.media, it)}
    <div class="p-actions">
      ${msg ? `<a href="${msgHref(it)}">${icon("chat")} Open conversation</a>`
            : (full ? "" : `<a href="${itemHref(it)}">${icon("info")} Details</a>`)}
      ${it.ts ? `<a href="${href("/search", { since: isoDay(it.ts), until: isoDay(it.ts), sort: "old" })}">${icon("calendar")} That day</a>` : ""}
    </div>`;
  if (!full) {
    // Like Facebook: clicking anywhere on the card (but its links and media) opens it.
    el.classList.add("clickable");
    el.addEventListener("click", (e) => {
      if (e.target.closest("a, button, video, audio, [data-lb]")) return;
      location.hash = itemHref(it);
    });
  }
  return el;
}

// ---------------------------------------------------------------- shared chrome
const TABS = [
  ["", "home", "Home"], ["messages", "chat", "Messenger"], ["people", "users", "People"],
  ["memories", "clock", "Memories"], ["photos", "image", "Photos"],
];
function drawTabs(active) {
  $("#tabs").innerHTML = TABS.map(([r, ic, label]) =>
    `<a class="tab${r === active ? " on" : ""}" href="#/${r}" title="${label}" aria-label="${label}"><span>${icon(ic)}</span></a>`).join("");
}
function sidebar(activeKind = null) {
  const k = STATS?.kinds || {};
  const item = (h, ic, color, label, count, on) =>
    `<a class="side-item${on ? " on" : ""}" href="${h}"><span class="side-ic" style="background:${color}">${icon(ic)}</span><span class="ell">${label}</span>${count != null ? `<span class="side-count">${num(count)}</span>` : ""}</a>`;
  return `
    <a class="side-item" href="#/person/${ME.id}">${avatar(ME.name, 36)}<span class="ell">${esc(ME.name)}</span></a>
    ${item("#/messages", "chat", "#0a7cff", "Messenger", STATS?.threads)}
    ${item("#/people", "users", "#1877f2", "People", null)}
    ${item("#/memories", "clock", "#7b5cd6", "Memories", null)}
    ${item("#/photos", "image", "#45bd62", "Photos", STATS?.media)}
    <div class="side-sep"></div>
    <div class="side-title">Browse</div>
    ${Object.entries(KINDS).filter(([kk]) => k[kk]).map(([kk, v]) =>
      item(href("/search", { kind: kk, sort: "new" }), v.icon, v.color, v.label, k[kk], activeKind === kk)).join("")}`;
}
async function contactsCard() {
  const people = (await api("people", { limit: 18 })).filter((p) => !p.is_me && p.name !== "Facebook user").slice(0, 14);
  return `<div class="card rcard hide-narrow"><h3>Contacts</h3>${people.map((p) =>
    `<a class="contact" href="#/person/${p.id}">${avatar(p.name, 36)}<span class="ell">${esc(p.name)}</span><span class="sub">${num(p.n_items)}</span></a>`).join("")}</div>`;
}
function layout3(left, center, right) {
  app.className = "page-3";
  app.innerHTML = `<aside class="lrail">${left}</aside><main class="feed">${center}</main><aside class="rrail">${right}</aside>`;
}

/** Year dropdown bounded by the archive's date range. */
function yearSelect(field, label, value) {
  const first = yearOf(STATS.range[0]), last = Math.min(yearOf(STATS.range[1]), new Date().getFullYear());
  const cur = (value || "").slice(0, 4);
  const opts = [];
  for (let y = last; y >= first; y--) opts.push(`<option value="${y}"${String(y) === cur ? " selected" : ""}>${y}</option>`);
  return `<select class="input" data-f="${field}" aria-label="${label}"><option value="">${label}</option>${opts.join("")}</select>`;
}

// ---------------------------------------------------------------- views
const views = {};

// Home: on this day + contacts.
views[""] = async () => {
  const now = new Date();
  const md = `${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const total = Object.values(STATS.kinds).reduce((a, b) => a + b, 0);
  layout3(sidebar(), `
    <div class="hero">${icon("clock")}<h2>On this day</h2><p>${esc(now.toLocaleDateString(LOCALE, { day: "numeric", month: "long" }))} — your memories from past years.</p></div>
    <div id="mem" class="feed">${spinner()}</div>`,
  `<div class="card rcard hide-narrow"><h3>Your archive</h3><div class="stat-grid">
      <div class="stat"><b>${num(STATS.kinds.message)}</b><span>messages</span></div>
      <div class="stat"><b>${num(STATS.threads)}</b><span>conversations</span></div>
      <div class="stat"><b>${num(STATS.media)}</b><span>photos & videos</span></div>
      <div class="stat"><b>${num(total)}</b><span>items since ${yearOf(STATS.range[0])}</span></div>
    </div></div><div id="contacts" style="margin-top:16px"></div>`);
  $(".rrail", app).classList.add("hide-narrow");
  contactsCard().then((h) => { const c = $("#contacts"); if (c) c.innerHTML = h; });
  const mem = await api("onthisday", { day: md });
  const box = $("#mem");
  if (!box) return;
  const years = new Map();
  const slot = (y) => { if (!years.has(y)) years.set(y, { items: [], convos: [] }); return years.get(y); };
  for (const it of mem.items) slot(yearOf(it.ts)).items.push(it);
  for (const c of mem.conversations) slot(+c.year).convos.push(c);
  box.innerHTML = "";
  if (!years.size) { box.innerHTML = `<div class="card empty-state">${icon("clock")}<h3>No memories today</h3><p>Nothing happened on this day in past years. Try searching instead.</p></div>`; return; }
  for (const [y, g] of [...years.entries()].sort((a, b) => b[0] - a[0])) {
    const ago = now.getFullYear() - y;
    const head = document.createElement("div");
    head.className = "card";
    head.innerHTML = `<div class="mem-year"><span class="badge">${ago === 0 ? "Earlier today" : `${ago} year${ago > 1 ? "s" : ""} ago`}</span><span class="muted">${y}</span></div>
      ${g.convos.slice(0, 6).map((c) => `<a class="convo-row" href="${href(`/messages/${enc(c.thread_id)}`, { at: c.first_id })}">
        ${c.is_group ? groupAvatar(c.thread_title, 40) : avatar(c.thread_title, 40)}
        <div class="grow"><div class="ell"><b>${esc(c.thread_title)}</b></div><div class="sub">${plural(c.n, "message")} exchanged</div></div>${icon("right", "sm")}</a>`).join("")}
      ${g.convos.length > 6 ? `<div class="sub" style="padding:4px 16px 12px">and ${plural(g.convos.length - 6, "more conversation")}</div>` : `<div style="height:8px"></div>`}`;
    box.append(head);
    g.items.slice(0, 6).forEach((it) => box.append(postCard(it)));
  }
};

// Search results as a feed with a filter rail.
let searchGen = 0;
views.search = async ({ params }) => {
  const st = Object.fromEntries(params);
  const kind = st.kind || "";
  const pickerField = (role, label) => st[role]
    ? `<div class="field"><label>${label}</label><div class="pill">${avatar(st[role + "Name"] || "?", 28)}<span class="ell">${esc(st[role + "Name"] || "Selected person")}</span><button class="x" data-clear="${role}">${icon("x", "sm")}</button></div></div>`
    : `<div class="field"><label>${label}</label><div><input class="input" data-role="${role}" placeholder="Type a name…"></div></div>`;
  const monthPill = /^\d{4}-\d{2}$/.test(st.since || "") && st.since === st.until
    ? `<div class="field"><label>Month</label><div class="pill">${icon("calendar", "sm")}<span>${esc(fmtMonth(new Date(st.since + "-15T12:00").getTime()))}</span><button class="x" data-clear-day>${icon("x", "sm")}</button></div></div>` : "";
  const dayPill = st.since && st.since.length === 10 && st.since === st.until
    ? `<div class="field"><label>Day</label><div class="pill">${icon("calendar", "sm")}<span>${esc(fmtDate(new Date(st.since + "T12:00").getTime()))}</span><button class="x" data-clear-day>${icon("x", "sm")}</button></div></div>` : "";
  const sort = st.sort || (st.q ? "rank" : "new");
  layout3(sidebar(kind), `
    <div class="card feed-head">
      <h2>${st.q ? `Results for “${esc(st.q)}”` : kind ? esc(KINDS[kind]?.label || kind) : "Everything"}</h2>
      <div class="sub" id="count">&nbsp;</div>
      <div class="chips">${[["", "All"], ...Object.entries(KINDS).map(([k, v]) => [k, v.label])].map(([k, l]) => `<button class="chip${k === kind ? " on" : ""}" data-k="${k}">${l}</button>`).join("")}</div>
      ${kind === "event" ? `<div class="chips rsvp-chips">${[["", "All events"], ...Object.entries(RSVP).map(([k, v]) => [k, v.label])].map(([k, l]) =>
        `<button class="chip${(st.category || "") === (k && EVENTS_DIR + k) ? " on" : ""}" data-cat="${k && EVENTS_DIR + k}">${l}</button>`).join("")}</div>` : ""}
    </div>
    <div id="results" class="feed"></div><div class="sentinel"></div>`,
  `<div class="card rcard filters-card"><h3 class="filters-toggle">${icon("search", "sm")} Filters<span class="grow"></span>${icon("right", "sm")}</h3><div class="filters-body">
      ${st.thread ? `<div class="field"><label>Conversation</label><div class="pill">${icon("chat", "sm")}<span class="ell" id="thread-name">One conversation</span><button class="x" data-clear="thread">${icon("x", "sm")}</button></div></div>` : ""}
      ${pickerField("with", "Conversations with")}
      ${pickerField("author", "Written by")}
      ${dayPill || monthPill || `<div class="field"><label>Date</label><div class="field-row">
        ${yearSelect("since", "From", st.since)}${yearSelect("until", "To", st.until)}</div></div>`}
      <div class="field"><label>Sort by</label><div class="seg">${[["rank", "Relevance"], ["new", "Newest"], ["old", "Oldest"]].map(([v, l]) =>
        `<button data-sort="${v}" class="${sort === v ? "on" : ""}">${l}</button>`).join("")}</div></div>
      <button class="btn-link" data-reset>Clear all filters</button>
    </div></div>
    <div class="card rcard hide-narrow" style="margin-top:16px"><h3>When</h3><div class="hist" id="hist"></div><div class="sub" style="margin-top:8px">Click a bar to zoom into that month.</div></div>`);

  const update = (patch) => go("/search", { ...st, ...patch }, true);
  $(".filters-toggle", app).addEventListener("click", () => $(".filters-card", app).classList.toggle("open"));
  $$(".chip[data-k]", app).forEach((c) => c.addEventListener("click", () => update({ kind: c.dataset.k, category: "" })));
  $$(".chip[data-cat]", app).forEach((c) => c.addEventListener("click", () => update({ category: c.dataset.cat })));
  $$("[data-clear]", app).forEach((b) => b.addEventListener("click", () => update({ [b.dataset.clear]: "", [b.dataset.clear + "Name"]: "" })));
  $("[data-clear-day]", app)?.addEventListener("click", () => update({ since: "", until: "" }));
  $$("input[data-role]", app).forEach((inp) => personPicker(inp, (p) => update({ [inp.dataset.role]: p.id, [inp.dataset.role + "Name"]: p.name })));
  $$("[data-f]", app).forEach((el) => el.addEventListener("change", () => update({ [el.dataset.f]: el.value })));
  $$("[data-sort]", app).forEach((b) => b.addEventListener("click", () => update({ sort: b.dataset.sort })));
  $("[data-reset]", app).addEventListener("click", () => go("/search", { q: st.q }, true));
  if (st.thread) api(`thread/${enc(st.thread)}`).then((t) => { const n = $("#thread-name"); if (n) n.textContent = t.title; });

  const q = { q: st.q, kind, with: st.with, author: st.author, thread: st.thread, since: st.since, until: st.until, category: st.category };
  const gen = ++searchGen;
  api("histogram", q).then((rows) => {
    const h = $("#hist");
    if (h && gen === searchGen) histogram(h, rows, {
      selected: st.since && st.since === st.until ? st.since : null,
      onPick: (m) => update(st.since === m && st.until === m ? { since: "", until: "" } : { since: m, until: m }),
    });
  });

  const results = $("#results");
  if (!Object.values(q).some(Boolean)) {
    results.innerHTML = `<div class="card empty-state">${icon("search")}<h3>Search your archive</h3><p>Messages, posts, comments, photos and more — ${num(Object.values(STATS.kinds).reduce((a, b) => a + b, 0))} items since ${yearOf(STATS.range[0])}.</p></div>`;
    $("#count").textContent = "";
    return;
  }
  results.innerHTML = spinner();
  let offset = 0;
  const load = async () => {
    const res = await api("search", { ...q, sort, limit: 30, offset });
    if (gen !== searchGen) return false;
    if (offset === 0) {
      results.innerHTML = "";
      $("#count").textContent = plural(res.total, "result");
      if (!res.total) results.innerHTML = `<div class="card empty-state">${icon("search")}<h3>No results</h3><p>Try other words or remove some filters.</p></div>`;
    }
    res.items.forEach((it) => results.append(postCard(it)));
    offset += res.items.length;
    return offset < res.total && res.items.length > 0;
  };
  if (await load()) infinite($(".sentinel", app), load);
};

// Messenger: inbox list + conversation + info panel. The list survives thread switches.
let msgr = null;
views.messages = async ({ parts, params }) => {
  const tid = parts[1] || null;
  const at = params.get("at") || null;
  if (!msgr || !app.querySelector(".msgr")) buildInbox();
  $(".msgr", app).classList.toggle("has-thread", !!tid);
  $$(".trow", app).forEach((r) => r.classList.toggle("on", r.dataset.id === tid));
  msgr.convObservers.forEach((o) => o.disconnect()); msgr.convObservers = [];
  const conv = $(".conv", app), info = $(".msgr-info", app);
  if (!tid) {
    conv.innerHTML = `<div class="conv-empty"><div>${icon("chat")}<h2 style="color:var(--text)">Your messages</h2><p>Select a conversation, or search across all of them.</p></div></div>`;
    info.innerHTML = "";
    return;
  }
  await openConversation(tid, at, conv, info);
};

function buildInbox() {
  app.className = "";
  app.innerHTML = `<div class="msgr">
    <aside class="msgr-list">
      <div class="msgr-list-head"><h1>Chats</h1>
        <label class="msgr-filter">${icon("search", "sm")}<input placeholder="Search conversations" aria-label="Filter conversations"></label>
        <div class="msgr-tabs"><button class="chip on" data-box="">All</button><button class="chip" data-box="group">Groups</button><button class="chip" data-box="dm">People</button></div>
      </div>
      <div class="msgr-rows"><div class="rows"></div><div class="sentinel"></div></div>
    </aside>
    <section class="conv"></section>
    <aside class="msgr-info"></aside></div>`;
  msgr = { filter: "", box: "", convObservers: [], listIo: null, gen: 0 };
  const rowsEl = $(".rows", app), scroller = $(".msgr-rows", app);
  const row = (t) => {
    const who = t.last_is_me ? "You: " : t.is_group && t.last_author ? `${esc(t.last_author.split(" ")[0])}: ` : "";
    const media = { photo: "a photo", gif: "a GIF", video: "a video", sticker: "a sticker", audio: "a voice message" };
    const what = t.last_body ? esc(t.last_body.split("\n")[0]) : t.last_mtype ? `sent ${media[t.last_mtype] || "an attachment"}` : "…";
    return `<a class="trow" data-id="${esc(t.id)}" href="#/messages/${enc(t.id)}">${threadAvatar(t, 56)}
      <div class="trow-main"><div class="trow-title ell">${esc(t.title)}</div>
      <div class="trow-sub"><span class="ell">${who}${what}</span><span>·</span><span style="flex:none">${fmtShort(t.last_ts)}</span></div></div></a>`;
  };
  let offset = 0;
  const load = async () => {
    const gen = msgr.gen;
    const page = await api("threads", { q: msgr.filter, limit: 40, offset });
    if (!msgr || gen !== msgr.gen) return false;
    const shown = page.filter((t) => !msgr.box || (msgr.box === "group" ? t.is_group : !t.is_group));
    rowsEl.insertAdjacentHTML("beforeend", shown.map(row).join(""));
    const cur = route().parts[1];
    $$(".trow", rowsEl).forEach((r) => r.classList.toggle("on", r.dataset.id === cur));
    offset += page.length;
    return page.length === 40;
  };
  const restart = () => {
    msgr.gen++; offset = 0; rowsEl.innerHTML = "";
    msgr.listIo?.disconnect();
    msgr.listIo = infinite($(".sentinel", scroller), load, scroller, []);
  };
  $(".msgr-filter input", app).addEventListener("input", debounce((e) => { msgr.filter = e.target.value; restart(); }, 150));
  $$(".msgr-tabs .chip", app).forEach((b) => b.addEventListener("click", () => {
    $$(".msgr-tabs .chip", app).forEach((x) => x.classList.toggle("on", x === b));
    msgr.box = b.dataset.box; restart();
  }));
  restart();
}

const SYSTEM_RE = /^(.+ (left the group|joined the group|added .+ to the group|removed .+ from the group|named the group.*|changed the group photo|changed the theme.*|set the emoji to.*|set (the|your|his|her|their) nickname.*|created the group.*|started a (video|audio) call|joined the (video|audio) call|pinned a message)\.?|You can now message and call each other.*|You are now connected on Messenger.*|Say hi to your new Facebook friend.*)$/i;
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|\s){1,16}$/u;

async function openConversation(tid, atKey, conv, info) {
  let at = atKey;
  const t = await api(`thread/${enc(tid)}`);
  const others = t.people.filter((p) => !p.is_me);
  const other = !t.is_group && others.length === 1 ? others[0] : null;
  const span = `${yearOf(t.first_ts)}${yearOf(t.last_ts) !== yearOf(t.first_ts) ? `–${yearOf(t.last_ts)}` : ""}`;
  conv.innerHTML = `
    <div class="conv-head">
      <a class="icon-btn back" href="#/messages" aria-label="Back">${icon("left")}</a>
      ${threadAvatar(t, 40)}
      <div class="grow"><div class="conv-title ell">${other ? `<a href="#/person/${other.id}">${esc(t.title)}</a>` : esc(t.title)}</div>
        <div class="sub">${plural(t.n_items, "message")} · ${span}${t.is_group ? ` · ${plural(t.people.length, "member")}` : ""}</div></div>
      <a class="icon-btn" href="${href("/search", { thread: tid })}" title="Search in conversation">${icon("search")}</a>
      <a class="icon-btn" href="${href("/photos", { thread: tid })}" title="Photos and videos">${icon("image")}</a>
      <button class="icon-btn" data-info title="Conversation info">${icon("info")}</button>
    </div>
    <div class="conv-scroll"><div class="sentinel s-old"></div><div class="conv-msgs"></div><div class="sentinel s-new"></div></div>`;
  $("[data-info]", conv).addEventListener("click", () => $(".msgr", app).classList.toggle("no-info"));
  info.innerHTML = `${threadAvatar(t, 80)}<h2>${esc(t.title)}</h2><div class="sub">${esc(fmtDate(t.first_ts))} → ${esc(fmtDate(t.last_ts))}</div>
    <div class="info-actions">
      ${other ? `<a href="#/person/${other.id}"><span>${icon("user")}</span>Profile</a>` : ""}
      <a href="${href("/search", { thread: tid })}"><span>${icon("search")}</span>Search</a>
      <a href="${href("/photos", { thread: tid })}"><span>${icon("image")}</span>Media</a>
    </div>
    <div class="info-sec"><h4>${t.is_group ? `Members · ${t.people.length}` : "People"}</h4>
      ${t.people.slice(0, 60).map((p) => `<a class="member" href="#/person/${p.id}">${avatar(p.name, 32)}<span class="ell">${esc(p.name)}</span><span class="sub">${num(p.n)}</span></a>`).join("")}
      ${t.people.length > 60 ? `<div class="sub" style="padding:6px 8px">and ${t.people.length - 60} more</div>` : ""}</div>`;

  const scroller = $(".conv-scroll", conv), box = $(".conv-msgs", conv);
  const GAP = 30 * 60 * 1000, JOIN = 5 * 60 * 1000;
  const isSys = (m) => m && m.body && !m.media.length && SYSTEM_RE.test(m.body);
  const same = (a, b) => a && b && a.author === b.author && Math.abs(b.ts - a.ts) < JOIN && !isSys(a) && !isSys(b);

  const msgHtml = (m, prev, next) => {
    let out = "";
    const sep = !prev || m.ts - prev.ts > GAP;
    if (sep) out += `<div class="tsep">${esc(fmtLong(m.ts))}</div>`;
    if (isSys(m)) return out + `<div class="sysmsg" id="m${m.id}">${esc(m.body)}</div>`;
    const mine = !!m.author_is_me;
    const joinPrev = !sep && same(prev, m), joinNext = same(m, next) && !(next.ts - m.ts > GAP);
    const pos = joinPrev && joinNext ? "g-mid" : joinPrev ? "g-last" : joinNext ? "g-first" : "g-single";
    const x = m.extra || {};
    let content = "";
    if (x.unsent) content += `<div class="bubble unsent">Message unsent</div>`;
    else if (m.body) {
      const jumbo = EMOJI_ONLY.test(m.body) && /\p{Extended_Pictographic}/u.test(m.body);
      content += jumbo ? `<div class="jumbo" title="${esc(fmtLong(m.ts))}">${esc(m.body)}</div>`
        : `<div class="bubble" title="${esc(fmtLong(m.ts))}">${linkify(esc(m.body))}</div>`;
    }
    if (x.call_duration != null) {
      const mins = Math.round(x.call_duration / 60);
      content += `<div class="bubble mcall"><span class="cic">${icon("phone", "sm")}</span><span><b>${x.call_duration ? "Call" : "Missed call"}</b>${x.call_duration ? `<br><span style="opacity:.8;font-size:13px">${mins ? `${mins} min` : `${x.call_duration} s`}</span>` : ""}</span></div>`;
    }
    if (x.share?.link && !(m.body || "").includes(x.share.link)) {
      content += `<a class="mshare" href="${esc(x.share.link)}" target="_blank" rel="noopener"><div class="ms-body"><div class="ms-host">${esc(hostOf(x.share.link))}</div><div class="ms-title">${esc(x.share.share_text || x.share.link)}</div></div></a>`;
    }
    const pics = m.media.filter((a) => a.mtype === "photo" || a.mtype === "gif");
    if (pics.length) content += `<div class="mmedia${pics.length > 1 ? " multi" : ""}">${pics.map((a) => `<img class="ph" loading="lazy" src="/thumb/${a.id}?s=${pics.length > 1 ? 320 : 640}" ${lbAttrs(a, { ...m, thread_title: t.title, item_id: m.id })} alt="">`).join("")}</div>`;
    for (const a of m.media) {
      if (a.mtype === "sticker") content += `<div class="mmedia"><img class="sticker" loading="lazy" src="/media/${a.id}" alt="sticker"></div>`;
      else if (a.mtype === "video") content += `<div class="mmedia"><video controls preload="metadata" src="/media/${a.id}"></video></div>`;
      else if (a.mtype === "audio") content += `<div class="mmedia"><audio controls preload="none" src="/media/${a.id}"></audio></div>`;
      else if (a.mtype === "file") content += `<a class="bubble mfile" href="/media/${a.id}" target="_blank">${icon("file", "sm")} ${esc(a.name)}</a>`;
    }
    if (!content) content = `<div class="bubble unsent">Attachment unavailable</div>`;
    const reacts = x.reactions || [];
    const rx = reacts.length ? `<div class="mreacts" title="${esc(reacts.map((r) => `${r.r} ${r.by}`).join("\n"))}">${esc([...new Set(reacts.map((r) => r.r))].slice(0, 3).join(""))}${reacts.length > 1 ? ` ${reacts.length}` : ""}</div>` : "";
    return out + `<div class="mrow ${mine ? "me" : "them"} ${pos}${m.id === at ? " target" : ""}" id="m${m.id}">
      <div class="mav">${!mine && !joinNext ? `<a href="#/person/${m.author_id}" title="${esc(m.author)}">${avatar(m.author, 28)}</a>` : ""}</div>
      <div class="mcol">${t.is_group && !mine && !joinPrev ? `<div class="mname">${esc(m.author)}</div>` : ""}${content}${rx}</div></div>`;
  };
  const batchHtml = (list, before, after) => list.map((m, k) => msgHtml(m, k ? list[k - 1] : before, list[k + 1] || after)).join("");

  const first = await api(`thread/${enc(tid)}/messages`, at ? { around: at, n: 80 } : { n: 80 });
  // `at` may be a uid or a row id; highlight whichever message it names.
  const target = at ? first.find((m) => m.uid === at || String(m.id) === String(at)) : null;
  at = target ? target.id : null;
  if (route().parts[1] !== tid) return; // the user already moved on
  if (!first.length) { box.innerHTML = `<div class="conv-empty">Empty conversation</div>`; return; }
  let oldest = first[0], newest = first[first.length - 1];
  box.innerHTML = batchHtml(first, null, null);
  if (at) $("#m" + at, box)?.scrollIntoView({ block: "center" });
  else scroller.scrollTop = scroller.scrollHeight;

  const intro = () => `<div class="conv-intro">${threadAvatar(t, 72)}<h2>${esc(t.title)}</h2><div class="sub">Conversation started ${esc(fmtDate(t.first_ts))}</div></div>`;
  let olderDone = first[0].ts <= t.first_ts && !at, newerDone = !at;
  if (olderDone) box.insertAdjacentHTML("afterbegin", intro());
  infinite($(".s-old", scroller), async () => {
    if (olderDone) return false;
    const msgs = await api(`thread/${enc(tid)}/messages`, { before_ts: oldest.ts, before_id: oldest.id, n: 80 });
    if (!msgs.length) { olderDone = true; box.insertAdjacentHTML("afterbegin", intro()); return false; }
    const h = scroller.scrollHeight, top = scroller.scrollTop;
    // The previous first time separator is redundant when the new batch ends close to it.
    const firstSep = box.firstElementChild;
    if (firstSep?.classList.contains("tsep") && oldest.ts - msgs[msgs.length - 1].ts <= GAP) firstSep.remove();
    box.insertAdjacentHTML("afterbegin", batchHtml(msgs, null, oldest));
    oldest = msgs[0];
    if (msgs.length < 80) { olderDone = true; box.insertAdjacentHTML("afterbegin", intro()); }
    scroller.scrollTop = top + (scroller.scrollHeight - h);
    return !olderDone;
  }, scroller, msgr.convObservers);
  infinite($(".s-new", scroller), async () => {
    if (newerDone) return false;
    const msgs = await api(`thread/${enc(tid)}/messages`, { after_ts: newest.ts, after_id: newest.id, n: 80 });
    if (!msgs.length) { newerDone = true; return false; }
    box.insertAdjacentHTML("beforeend", batchHtml(msgs, newest, null));
    newest = msgs[msgs.length - 1];
    if (msgs.length < 80) newerDone = true;
    return !newerDone;
  }, scroller, msgr.convObservers);
}

// Item page: a full post, or a Facebook-style event page, with related conversations.
const STOP = new Set("les des une pour avec dans sur par the and for with chez ans party soirée soiree".split(" "));
function mentionQuery(title) {
  const words = ((title || "").match(/[\p{L}\p{N}]{3,}/gu) || []).filter((w) => !STOP.has(w.toLowerCase()));
  return [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, 3).map((w) => `"${w}"`).join(" ");
}
function threadRows(items, sub) {
  const by = new Map();
  for (const m of items) {
    const g = by.get(m.thread_id) || { t: m, n: 0 };
    g.n++; by.set(m.thread_id, g);
  }
  return [...by.values()].sort((a, b) => b.n - a.n).slice(0, 8).map(({ t, n }) =>
    `<a class="list-row" href="${msgHref(t)}">${avatar(t.thread_title, 36)}<div class="grow"><div class="t ell">${esc(t.thread_title)}</div>
      <div class="sub ell">${sub(t, n)}</div></div>${icon("right", "sm")}</a>`).join("");
}
views.item = async ({ parts }) => {
  const it = await api(`item/${parts[1]}`);
  const ev = it.kind === "event" ? it.extra?.event || {} : null;
  const day = (ev?.start || it.ts) ? isoDay(ev?.start || it.ts) : null;
  app.className = "page-1";
  app.innerHTML = `<div class="item-page"><main id="item-main"></main><aside class="item-rail">
      ${ev?.fbid ? `<div class="card" id="shared"><h3 class="card-title">Shared in Messenger</h3>${spinner()}</div>` : ""}
      ${ev ? `<div class="card" id="mentions"><h3 class="card-title">Mentioned in conversations</h3>${spinner()}</div>` : ""}
      ${day ? `<div class="card" id="thatday"><h3 class="card-title">Conversations that day</h3>${spinner()}</div>` : ""}
    </aside></div>`;
  const main = $("#item-main");
  if (ev) {
    const map = ev.lat != null ? `https://www.openstreetmap.org/?mlat=${ev.lat}&mlon=${ev.lon}#map=15/${ev.lat}/${ev.lon}` : null;
    const hours = ev.end && ev.start ? (ev.end - ev.start) / 3600000 : null;
    main.innerHTML = `
      <div class="card ev-page">
        <div class="ev-cover" style="background:linear-gradient(135deg, ${colorOf(it.title)} 0%, ${colorOf(it.title + "·")} 100%)">${dateTile(ev.start, true)}</div>
        <div class="ev-head">
          <div class="ev-when big">${esc(eventWhen(ev))}</div>
          <h1>${esc(it.title)}</h1>
          ${ev.place ? `<div class="muted">${esc(ev.place)}</div>` : ""}
          <div class="ev-actions">${rsvpPill(ev.rsvp)}
            ${day ? `<a class="btn" href="${href("/search", { since: day, until: day, sort: "old" })}">${icon("calendar", "sm")} What happened that day</a>` : ""}
            ${it.title ? `<a class="btn" href="${href("/search", { q: mentionQuery(it.title), kind: "message" })}">${icon("search", "sm")} Search mentions</a>` : ""}
            ${ev.url ? `<a class="btn" href="${esc(ev.url)}" target="_blank" rel="noopener">${icon("external", "sm")} View on Facebook</a>` : ""}
          </div>
        </div>
      </div>
      <div class="card rcard"><h3>Details</h3>
        ${ev.rsvp ? `<div class="intro-row">${icon(RSVP[ev.rsvp]?.icon || "info", "sm")} ${
          ev.rsvp === "hosted" ? "You created this event"
          : ev.rsvp === "visited" ? "You viewed this event without answering"
          : `Your response: <b>${esc(RSVP[ev.rsvp]?.label)}</b>`}${ev.responded ? ` <span class="muted">· ${esc(fmtDate(ev.responded))}</span>` : ""}</div>` : ""}
        ${ev.rsvp !== "hosted" ? `<div class="intro-row muted">${icon("info", "sm")} Facebook's export doesn't include the host, the guest list or who invited you.</div>` : ""}
        ${hours ? `<div class="intro-row">${icon("clock", "sm")} ${hours < 24 ? `${Math.round(hours * 10) / 10} hours` : `${Math.round(hours / 24)} days`}</div>` : ""}
        ${ev.place || ev.address ? `<div class="intro-row">${icon("mapPin", "sm")} <span>${esc([...new Set([ev.place, ev.address].filter(Boolean))].join(" · "))}
          ${map ? ` · <a class="link" href="${map}" target="_blank" rel="noopener">Open map</a>` : ""}</span></div>` : ""}
        ${it.body ? `<div class="ev-desc">${linkify(esc(it.body))}</div>` : `<p class="muted">Facebook only exported the name and date of this event.</p>`}
      </div>`;
    if (ev.fbid) {
      // The event link carries its id: messages sharing it show who sent it around.
      const shared = await api("search", { q: `"${ev.fbid}"`, kind: "message", sort: "old", limit: 20 }).catch(() => ({ items: [] }));
      const box = $("#shared");
      if (box) box.innerHTML = `<h3 class="card-title">Shared in Messenger</h3>` + (shared.items.map((m) =>
        `<a class="list-row" href="${msgHref(m)}">${avatar(m.author, 36)}<div class="grow"><div class="t ell">${esc(m.author_is_me ? "You" : m.author)}</div>
          <div class="sub ell">Shared in ${esc(m.thread_title)} · ${esc(fmtLong(m.ts))}</div></div>${icon("right", "sm")}</a>`).join("")
        || `<p class="muted card-empty">Nobody sent this event's link in Messenger.</p>`);
    }
    const mq = mentionQuery(it.title);
    const mentions = !mq ? { items: [] } : await api("search", {
      q: mq, kind: "message", limit: 60,
      since: ev.start ? isoDay(ev.start - 60 * 86400000) : "", until: ev.start ? isoDay(ev.start + 30 * 86400000) : "",
    }).catch(() => ({ items: [] }));
    const mbox = $("#mentions");
    if (mbox) mbox.innerHTML = `<h3 class="card-title">Mentioned in conversations</h3>` + (threadRows(mentions.items, (t, n) => `${plural(n, "mention")} · ${hl(t.snippet || "")}`)
      || `<p class="muted card-empty">No messages mention it around that date.</p>`);
  } else {
    main.append(postCard(it, { full: true }));
  }
  if (day) {
    const res = await api("search", { kind: "message", since: day, until: day, sort: "old", limit: 300 });
    const box = $("#thatday");
    if (box) box.innerHTML = `<h3 class="card-title">Conversations that day</h3>` + (threadRows(res.items, (t, n) => `${plural(n, "message")} · from ${fmtTime(t.ts)}`)
      || `<p class="muted card-empty">No messages that day.</p>`);
  }
};

// People: Facebook "Friends"-style grid.
views.people = async ({ params }) => {
  const q0 = params.get("q") || "";
  app.className = "page-1";
  app.innerHTML = `<div class="card card-pad" style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
      <div style="flex:1;min-width:200px"><h2>People</h2><div class="sub">Everyone you've talked with, ranked by messages.</div></div>
      <label class="msgr-filter" style="width:300px;max-width:100%">${icon("search", "sm")}<input value="${esc(q0)}" placeholder="Search people" aria-label="Search people"></label>
    </div>
    <div class="people-grid"></div><div class="sentinel"></div>`;
  const grid = $(".people-grid", app), input = $("input", app);
  let offset = 0, gen = 0, io = null;
  const load = async () => {
    const g = gen;
    const rows = await api("people", { q: input.value.trim(), limit: 48, offset });
    if (g !== gen) return false;
    grid.insertAdjacentHTML("beforeend", rows.map((p) => {
      const photo = isMe(p.name) && ME.avatar;
      const pic = photo ? `style="background-image:url(/thumb/${ME.avatar}?s=320)"` : `style="background:${colorOf(p.name)}"`;
      return `<a class="card pcard" href="#/person/${p.id}"><div class="pc-av" ${pic}>${photo ? "" : esc(initials(p.name))}</div>
        <div class="pc-body"><div class="pc-name ell">${esc(p.name)}</div><div class="sub">${plural(p.n_items, "message")} · ${plural(p.n_threads, "chat")}</div>
        <span class="btn">View profile</span></div></a>`;
    }).join(""));
    if (!rows.length && !offset) grid.innerHTML = `<div class="card empty-state" style="grid-column:1/-1"><h3>No one found</h3></div>`;
    offset += rows.length;
    return rows.length === 48;
  };
  const restart = () => { gen++; offset = 0; grid.innerHTML = ""; io?.disconnect(); io = infinite($(".sentinel", app), load); };
  input.addEventListener("input", debounce(() => { history.replaceState(null, "", href("/people", { q: input.value })); restart(); }, 150));
  restart();
};

// Profile: cover, identity, tabs, intro + per-year chart + conversations.
views.person = async ({ parts }) => {
  const id = parts[1], tab = parts[2] || "";
  const p = await api(`person/${id}`);
  const mine = !!p.is_me;
  const cover = mine && ME.cover ? `background-image:linear-gradient(180deg,transparent 60%,rgba(0,0,0,.25)),url(/thumb/${ME.cover}?s=640)`
    : `background:linear-gradient(135deg, ${colorOf(p.name)} 0%, ${colorOf(p.name + "·")} 100%)`;
  const dm = p.threads.find((t) => !t.is_group);
  const total = p.per_year.reduce((a, y) => a + y.n, 0);
  const tabs = [["", "Conversations"], ["posts", mine ? "Posts & activity" : "Messages"], ["photos", "Photos"]];
  app.className = "";
  app.innerHTML = `
    <div class="profile-top"><div class="profile-inner">
      <div class="cover" style="${cover}"></div>
      <div class="profile-id">${avatar(p.name, 168)}
        <div class="grow"><h1>${esc(p.name)}</h1><div class="muted" style="font-weight:600">${plural(p.n_items, "message")} · ${plural(p.n_threads, "conversation")}</div></div>
        <div class="acts">
          ${dm && !mine ? `<a class="btn primary" href="#/messages/${enc(dm.id)}">${icon("chat", "sm")} Message</a>` : ""}
          <a class="btn" href="${href("/search", mine ? { author: p.id, authorName: p.name, sort: "new" } : { with: p.id, withName: p.name, sort: "new" })}">${icon("search", "sm")} Search</a>
        </div>
      </div>
      <nav class="ptabs">${tabs.map(([k, l]) => `<a class="ptab${tab === k ? " on" : ""}" href="#/person/${id}${k ? "/" + k : ""}">${l}</a>`).join("")}</nav>
    </div></div>
    <div class="profile-body${tab ? " single" : ""}" id="pbody"></div>`;
  const body = $("#pbody");

  if (tab === "photos") {
    body.innerHTML = `<div class="card"><div class="toolbar"><h2 class="grow">Photos</h2></div><div class="photo-grid"></div><div class="sentinel"></div></div>`;
    photoGrid($(".photo-grid", body), $(".sentinel", body), mine ? {} : { with: p.id });
    return;
  }
  if (tab === "posts") {
    body.innerHTML = `<div class="feed" id="pfeed"></div><div class="sentinel"></div>`;
    let offset = 0;
    const load = async () => {
      const res = await api("search", { author: p.id, sort: "new", limit: 25, offset });
      res.items.forEach((it) => $("#pfeed").append(postCard(it)));
      if (!offset && !res.total) $("#pfeed").innerHTML = `<div class="card empty-state"><h3>Nothing here</h3></div>`;
      offset += res.items.length;
      return offset < res.total && res.items.length > 0;
    };
    if (await load()) infinite($(".sentinel", body), load);
    return;
  }
  const years = p.per_year.length ? monthRange(`${p.per_year[0].year}-01`, `${p.per_year[p.per_year.length - 1].year}-01`).filter((m) => m.endsWith("-01")).map((m) => m.slice(0, 4)) : [];
  const byYear = Object.fromEntries(p.per_year.map((y) => [y.year, y]));
  const max = Math.max(...p.per_year.map((y) => y.n), 1);
  const top = [...p.per_year].sort((a, b) => b.n - a.n)[0];
  const groups = p.threads.filter((t) => t.is_group).length;
  body.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:16px">
      <div class="card rcard"><h3>Intro</h3>
        ${p.first_ts ? `<div class="intro-row">${icon("clock", "sm")} First message on ${esc(fmtDate(p.first_ts))}</div>
        <div class="intro-row">${icon("chat", "sm")} Last message on ${esc(fmtDate(p.last_ts))}</div>` : ""}
        ${top ? `<div class="intro-row">${icon("sparkles", "sm")} Most active in ${top.year} · ${plural(top.n, "message")}</div>` : ""}
        ${mine ? "" : `<div class="intro-row">${icon("users", "sm")} ${plural(groups, "group chat")} together</div>`}
      </div>
      ${years.length ? `<div class="card rcard"><h3>${mine ? "Messages per year" : "Messages exchanged per year"}</h3>
        <div class="bars">${years.map((y) => { const r = byYear[y]; return `<div style="height:${r ? Math.max(2, (r.n / max) * 100) : 0}%" title="${y}: ${r ? num(r.n) : 0} messages${r && !mine ? ` (${num(r.theirs)} from ${esc(p.name.split(" ")[0])})` : ""}"></div>`; }).join("")}</div>
        <div class="bars-axis">${years.map((y) => `<span>${years.length > 12 ? "’" + y.slice(2) : y}</span>`).join("")}</div>
        <div class="sub" style="margin-top:8px">${plural(total, "message")} in total</div></div>` : ""}
    </div>
    <div class="card" style="padding:8px 0">
      <h3 style="padding:8px 16px 4px">Conversations · ${num(p.n_threads)}</h3>
      ${p.threads.map((t) => `<a class="list-row" href="#/messages/${enc(t.id)}">${threadAvatar(t, 44)}
        <div class="grow"><div class="t ell">${esc(t.title)}</div><div class="sub">${plural(t.n_items, "message")} · ${esc(fmtShort(t.first_ts))} – ${esc(fmtShort(t.last_ts))}</div></div>${icon("right", "sm")}</a>`).join("")
        || `<div class="empty-state">No conversations</div>`}
    </div>`;
};

// Photos: month-grouped grid with filters.
function photoGrid(grid, sentinel, params) {
  let offset = 0, last = null;
  const load = async () => {
    const rows = await api("gallery", { ...params, limit: 120, offset });
    if (!rows.length && !offset) grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">${icon("image")}<h3>No photos</h3></div>`;
    let html = "";
    for (const m of rows) {
      const mo = m.ts ? fmtMonth(m.ts) : "Undated";
      if (mo !== last) { html += `<div class="pg-month">${esc(mo)}</div>`; last = mo; }
      const inner = m.mtype === "video"
        ? `<video preload="metadata" muted src="/media/${m.id}#t=0.5"></video><div class="play"><span>${icon("play")}</span></div>`
        : `<img loading="lazy" src="/thumb/${m.id}?s=320" alt="">`;
      html += `<div class="pg-tile" ${lbAttrs(m, m)}>${inner}</div>`;
    }
    grid.insertAdjacentHTML("beforeend", html);
    offset += rows.length;
    return rows.length === 120;
  };
  infinite(sentinel, load);
}
views.photos = async ({ params }) => {
  const st = Object.fromEntries(params);
  app.className = "page-1";
  app.innerHTML = `<div class="card">
    <div class="toolbar">
      <h2 class="grow">Photos & videos</h2>
      ${st.thread ? `<div class="pill">${icon("chat", "sm")}<span id="pthread">Conversation</span><button class="x" data-clear="thread">${icon("x", "sm")}</button></div>` : ""}
      ${st.with ? `<div class="pill">${avatar(st.withName || "?", 28)}<span>${esc(st.withName || "Person")}</span><button class="x" data-clear="with">${icon("x", "sm")}</button></div>`
                : `<div><input class="input" data-role="with" placeholder="Shared with…" style="width:190px"></div>`}
      <select class="input" data-f="kind">${[["", "All sources"], ["message", "Messenger"], ["photo", "Albums"], ["post", "Posts"]].map(([v, l]) => `<option value="${v}"${(st.kind || "") === v ? " selected" : ""}>${l}</option>`).join("")}</select>
      ${yearSelect("since", "From", st.since)}${yearSelect("until", "To", st.until)}
      <div class="seg">${[["new", "Newest"], ["old", "Oldest"]].map(([v, l]) => `<button data-sort="${v}" class="${(st.sort || "new") === v ? "on" : ""}">${l}</button>`).join("")}</div>
    </div>
    <div class="photo-grid"></div><div class="sentinel"></div></div>`;
  const update = (patch) => go("/photos", { ...st, ...patch }, true);
  $$("[data-f]", app).forEach((el) => el.addEventListener("change", () => update({ [el.dataset.f]: el.value })));
  $$("[data-sort]", app).forEach((b) => b.addEventListener("click", () => update({ sort: b.dataset.sort })));
  $$("[data-clear]", app).forEach((b) => b.addEventListener("click", () => update({ [b.dataset.clear]: "", withName: "" })));
  $$("input[data-role]", app).forEach((inp) => personPicker(inp, (p) => update({ with: p.id, withName: p.name })));
  if (st.thread) api(`thread/${enc(st.thread)}`).then((t) => { const n = $("#pthread"); if (n) n.textContent = t.title; });
  photoGrid($(".photo-grid", app), $(".sentinel", app), { since: st.since, until: st.until, with: st.with, thread: st.thread, kind: st.kind, sort: st.sort });
};

// Memories: the archive over time, then one card per year with a month heatmap.
views.memories = async () => {
  app.className = "page-1";
  app.innerHTML = `<div class="hero" style="margin-bottom:16px">${icon("clock")}<h2>Memories</h2><p>Your whole archive, month by month. Click any month to relive it.</p></div>
    <div class="card rcard" style="margin-bottom:16px"><h3>Activity over the years</h3><div class="hist" id="hist"></div>
      <div class="sub" style="margin-top:10px;display:flex;flex-wrap:wrap;gap:12px">${Object.entries(KINDS).filter(([k]) => k !== "log" && STATS.kinds[k]).map(([, v]) => `<span><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${v.color};margin-right:5px"></span>${v.label}</span>`).join("")}</div></div>
    <div class="years" id="years">${spinner()}</div>`;
  const rows = await api("histogram");
  histogram($("#hist"), rows, { stacked: true, height: 200, onPick: (m) => go("/search", { since: m, until: m, sort: "old" }) });
  const byYear = new Map();
  for (const r of rows) {
    const [y, m] = r.month.split("-");
    if (!byYear.has(y)) byYear.set(y, new Array(12).fill(0));
    byYear.get(y)[+m - 1] += r.n;
  }
  const max = Math.max(...[...byYear.values()].flat(), 1);
  const MONTHS = [..."JFMAMJJASOND"];
  $("#years").innerHTML = [...byYear.entries()].sort((a, b) => b[0] - a[0]).map(([y, ms]) => `
    <div class="card year-card"><div class="yh"><b>${y}</b><span class="sub">${plural(ms.reduce((a, b) => a + b, 0), "item")}</span></div>
      <div class="months">${ms.map((n, i) => { const mo = `${y}-${String(i + 1).padStart(2, "0")}`; return `<a href="${href("/search", { since: mo, until: mo, sort: "old" })}"
        title="${num(n)} items" style="${n ? `background:var(--blue);opacity:${(0.15 + 0.85 * Math.sqrt(n / max)).toFixed(2)}` : ""}"></a>`; }).join("")}</div>
      <div class="months-lbl">${MONTHS.map((m) => `<span>${m}</span>`).join("")}</div></div>`).join("");
};

// ---------------------------------------------------------------- router
function route() {
  const h = location.hash.slice(1) || "/";
  const [path, qs] = h.split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  return { name: parts[0] || "", parts, params: new URLSearchParams(qs || "") };
}
async function render() {
  const r = route();
  // Routes of the first UI keep working.
  if (r.name === "thread") { location.replace(href(`/messages/${enc(r.parts[1])}`, Object.fromEntries(r.params))); return; }
  if (r.name === "gallery") { location.replace(href("/photos", Object.fromEntries(r.params))); return; }
  if (r.name === "timeline") { location.replace("#/memories"); return; }
  routeObservers.forEach((o) => o.disconnect()); routeObservers = [];
  closeOverlay();
  drawTabs(TABS.some(([k]) => k === r.name) ? r.name : r.name === "person" ? "people" : "");
  const q = $("#q");
  if (document.activeElement !== q) q.value = r.name === "search" ? r.params.get("q") || "" : "";
  if (r.name !== "messages") { msgr = null; scrollTo(0, 0); }
  try { await (views[r.name] || views[""])(r); }
  catch (e) { console.error(e); app.className = "page-1"; app.innerHTML = `<div class="card empty-state">${icon("info")}<h3>Something went wrong</h3><p>${esc(e.message)}</p></div>`; }
}

// Global search box: live results while typing, without losing focus.
const qInput = $("#q");
qInput.addEventListener("input", debounce(() => {
  const r = route(), v = qInput.value;
  if (!v && r.name !== "search") return;
  const keep = r.name === "search" ? Object.fromEntries(r.params) : {};
  const params = { ...keep, q: v };
  if (!v || params.sort === "rank") delete params.sort;
  go("/search", params, r.name === "search");
}, 200));
qInput.addEventListener("keydown", (e) => { if (e.key === "Escape") qInput.blur(); });

addEventListener("hashchange", render);
(async () => {
  STATS = await api("stats");
  Object.assign(ME, { id: STATS.me_id, name: STATS.me || "", avatar: STATS.me_avatar, cover: STATS.me_cover });
  $("#me-chip").href = `#/person/${ME.id}`;
  $("#me-chip").innerHTML = `${avatar(ME.name, 28)}<span>${esc(ME.name.split(" ")[0])}</span>`;
  render();
})();
