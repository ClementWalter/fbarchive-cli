/**
 * fbarchive single-page UI. Hash routes:
 *   #/search?q=&kind=&with=&author=&since=&until=&sort=
 *   #/thread/<id>?at=<itemId>   #/threads?q=   #/people?q=   #/person/<id>
 *   #/timeline                  #/gallery?since=&until=&with=&sort=
 * Every view reads its state from the URL so any screen can be bookmarked.
 */
"use strict";

const $ = (sel, el = document) => el.querySelector(sel);
const view = $("#view");
const HL_START = "\x02", HL_END = "\x03";
const KINDS = [
  ["", "All"], ["message", "Messages"], ["post", "Posts"], ["comment", "Comments"],
  ["photo", "Photos"], ["event", "Events"], ["reaction", "Reactions"], ["friend", "Friends"],
  ["group", "Groups"], ["activity", "Activity"], ["log", "Meta logs"],
];
const KIND_COLORS = {
  message: "#2f5fd0", post: "#d0762f", comment: "#2fa37a", photo: "#b43fa8", event: "#c9a422",
  reaction: "#d04a5a", friend: "#5aa0c8", group: "#7a6bd0", activity: "#8a8a80", log: "#555",
};

// ---------- helpers ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const hl = (s) => esc(s).replaceAll(HL_START, "<mark>").replaceAll(HL_END, "</mark>");
const linkify = (html) => html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
const fmtDate = (ms) => ms ? new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "undated";
const fmtTime = (ms) => ms ? new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "";
const fmtDay = (ms) => new Date(ms).toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
const num = (n) => Number(n).toLocaleString();

async function api(path, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "" && v != null));
  const r = await fetch(`/api/${path}${qs.toString() ? "?" + qs : ""}`);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

function route() {
  const h = location.hash.slice(1) || "/search";
  const [path, qs] = h.split("?");
  return { parts: path.split("/").filter(Boolean).map(decodeURIComponent), params: new URLSearchParams(qs || "") };
}
function go(path, params = {}, replace = false) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "" && v != null)).toString();
  const h = "#" + path + (qs ? "?" + qs : "");
  if (replace) history.replaceState(null, "", h); else location.hash = h;
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/** Calls `load` whenever `sentinel` scrolls into view, until it returns false. */
function infinite(sentinel, load) {
  let busy = false, done = false;
  const io = new IntersectionObserver(async (entries) => {
    if (!entries[0].isIntersecting || busy || done) return;
    busy = true;
    try { done = (await load()) === false; } finally { busy = false; }
    if (done) io.disconnect();
    else if (sentinel.getBoundingClientRect().top < innerHeight) { io.unobserve(sentinel); io.observe(sentinel); }
  }, { rootMargin: "600px" });
  io.observe(sentinel);
  return io;
}
let observers = [];
const track = (io) => (observers.push(io), io);

// ---------- modal / lightbox ----------
const modal = $("#modal");
function openModal(html, bare = false) {
  $("#modal-body").innerHTML = html;
  $(".modal-box").classList.toggle("bare", bare);
  modal.hidden = false;
}
function closeModal() { modal.hidden = true; $("#modal-body").innerHTML = ""; }
modal.addEventListener("click", (e) => { if (e.target === modal || e.target.closest(".modal-close")) closeModal(); });
addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
  if (e.key === "/" && document.activeElement.tagName !== "INPUT") { e.preventDefault(); $("input[type=search]")?.focus(); }
});

function lightbox(m, contextHref) {
  const media = m.mtype === "video"
    ? `<video src="/media/${m.id}" controls autoplay></video>`
    : `<img src="/media/${m.id}">`;
  const cap = `<div class="cap"><span>${esc(m.caption || "")}</span>
    <span>${contextHref ? `<a href="${contextHref}">Open in context →</a> · ` : ""}<a href="/media/${m.id}" target="_blank">Original</a></span></div>`;
  openModal(`<div class="lightbox">${media}${cap}</div>`, true);
}
document.addEventListener("click", (e) => {
  const img = e.target.closest("[data-lightbox]");
  if (!img) return;
  e.preventDefault(); e.stopPropagation();
  lightbox({ id: img.dataset.lightbox, mtype: img.dataset.mtype, caption: img.dataset.caption }, img.dataset.ctx);
  const a = $(".lightbox a[href^='#']");
  a?.addEventListener("click", closeModal);
});

function mediaHtml(media, { size = 320, caption = "", ctx = "" } = {}) {
  return media.map((m) => {
    const attrs = `data-lightbox="${m.id}" data-mtype="${m.mtype}" data-caption="${esc(caption)}" data-ctx="${esc(ctx)}"`;
    switch (m.mtype) {
      case "photo": case "gif":
        return `<img loading="lazy" src="/thumb/${m.id}?s=${size}" ${attrs} alt="">`;
      case "sticker":
        return `<img class="sticker" loading="lazy" src="/media/${m.id}" alt="sticker">`;
      case "video":
        return `<video controls preload="none" src="/media/${m.id}"></video>`;
      case "audio":
        return `<audio controls preload="none" src="/media/${m.id}"></audio>`;
      default:
        return `<a href="/media/${m.id}" target="_blank">📎 ${esc(m.name)}</a>`;
    }
  }).join("");
}

// ---------- person picker ----------
/** Text input that resolves a name to a person id through /api/people. */
function personPicker(input, onPick) {
  const list = document.createElement("datalist");
  list.id = "dl-" + Math.random().toString(36).slice(2);
  input.setAttribute("list", list.id);
  input.after(list);
  let byName = new Map();
  input.addEventListener("input", debounce(async () => {
    const hit = byName.get(input.value);
    if (hit) { onPick(hit); return; }
    if (input.value.length < 2) return;
    const people = await api("people", { q: input.value, limit: 15 });
    byName = new Map(people.map((p) => [p.name, p]));
    list.innerHTML = people.map((p) => `<option value="${esc(p.name)}">${num(p.n_items)} msgs</option>`).join("");
    if (byName.has(input.value)) onPick(byName.get(input.value));
  }, 150));
}

// ---------- histogram ----------
function monthRange(a, b) {
  const out = []; let [y, m] = a.split("-").map(Number); const [by, bm] = b.split("-").map(Number);
  while (y < by || (y === by && m <= bm)) { out.push(`${y}-${String(m).padStart(2, "0")}`); if (++m > 12) { m = 1; y++; } }
  return out;
}
/** Bar chart of hits per month; `stacked` colours by kind. Click → onPick(month). */
function histogram(el, rows, { onPick, selected, stacked = false, height = 64 } = {}) {
  if (!rows.length) { el.innerHTML = ""; return; }
  const byMonth = new Map();
  for (const r of rows) {
    const m = byMonth.get(r.month) || {}; m[r.kind] = (m[r.kind] || 0) + r.n; byMonth.set(r.month, m);
  }
  const months = monthRange(rows[0].month, rows[rows.length - 1].month);
  const totals = months.map((m) => Object.values(byMonth.get(m) || {}).reduce((a, b) => a + b, 0));
  const max = Math.max(...totals, 1), w = 1000 / months.length;
  let bars = "";
  months.forEach((mo, i) => {
    const t = totals[i]; if (!t) return;
    const on = selected && mo.startsWith(selected) ? " on" : "";
    if (!stacked) {
      const h = Math.max(2, (t / max) * height);
      bars += `<rect data-m="${mo}" class="${on}" x="${i * w}" y="${height - h}" width="${Math.max(w - 1, 1)}" height="${h}"><title>${mo}: ${num(t)}</title></rect>`;
      return;
    }
    let y = height;
    for (const [k, n] of Object.entries(byMonth.get(mo))) {
      const h = (n / max) * height; y -= h;
      bars += `<rect data-m="${mo}" x="${i * w}" y="${y}" width="${Math.max(w - 1, 1)}" height="${h}" style="fill:${KIND_COLORS[k] || "#888"}"><title>${mo} ${k}: ${num(n)}</title></rect>`;
    }
  });
  const years = [...new Set(months.map((m) => m.slice(0, 4)))];
  const step = Math.ceil(years.length / 12);
  el.innerHTML = `<svg viewBox="0 0 1000 ${height}" preserveAspectRatio="none" style="height:${height}px">${bars}</svg>
    <div class="axis">${years.filter((_, i) => i % step === 0).map((y) => `<span>${y}</span>`).join("")}</div>`;
  el.querySelector("svg").addEventListener("click", (e) => { const m = e.target.dataset?.m; if (m) onPick?.(m); });
}

// ---------- result card ----------
function itemTarget(it) {
  return it.thread_id ? `#/thread/${encodeURIComponent(it.thread_id)}?at=${it.id}` : null;
}
function card(it) {
  const where = it.thread_title || it.title || it.category.split("/").pop().replaceAll("_", " ");
  const who = it.author && it.thread_id ? `<b>${esc(it.author)}:</b> ` : "";
  const thumbs = (it.media || []).filter((m) => m.mtype === "photo" || m.mtype === "gif").slice(0, 6)
    .map((m) => `<img loading="lazy" src="/thumb/${m.id}?s=160" alt="">`).join("");
  const el = document.createElement("div");
  el.className = "card";
  el.innerHTML = `<div class="head"><span class="kind">${esc(it.kind)}</span>
      <span>${fmtDate(it.ts)}</span><span class="where">${esc(where)}</span></div>
    <div class="body">${who}${hl(it.snippet || it.body || it.meta || "")}</div>
    ${thumbs ? `<div class="thumbs">${thumbs}</div>` : ""}`;
  el.addEventListener("click", () => {
    const t = itemTarget(it);
    if (t) location.hash = t; else showItem(it.id);
  });
  return el;
}
async function showItem(id) {
  const it = await api(`item/${id}`);
  const links = (it.extra?.links || []).map((l) => `<div><a href="${esc(l)}" target="_blank" rel="noopener">${esc(l)}</a></div>`).join("");
  openModal(`<div class="detail">
    <div class="muted small"><span class="kind">${esc(it.kind)}</span> ${fmtDate(it.ts)} ${fmtTime(it.ts)} · ${esc(it.category)}</div>
    ${it.title ? `<h3>${esc(it.title)}</h3>` : ""}
    ${it.author ? `<div class="muted">by <a href="#/search?author=${it.author_id ?? ""}">${esc(it.author)}</a></div>` : ""}
    <div class="body">${linkify(esc(it.body || ""))}</div>
    ${it.meta ? `<div class="muted small">${linkify(esc(it.meta))}</div>` : ""}
    ${links}
    <div class="media">${mediaHtml(it.media || [], { size: 640, caption: it.title || "" })}</div>
    ${it.ts ? `<p><a href="#/search?since=${new Date(it.ts).toISOString().slice(0, 10)}&until=${new Date(it.ts).toISOString().slice(0, 10)}&sort=old">What else happened that day →</a></p>` : ""}
  </div>`);
  $("#modal-body a[href^='#']")?.addEventListener("click", closeModal);
}

// ---------- views ----------
const views = {};

views.search = async ({ params }) => {
  const st = Object.fromEntries(params);
  view.innerHTML = `
    <div class="searchbar"><input type="search" placeholder="Search everything… (press / to focus)" value="${esc(st.q || "")}" autofocus></div>
    <div class="filters">
      <div class="chips">${KINDS.map(([k, l]) => `<span class="chip${(st.kind || "") === k ? " on" : ""}" data-k="${k}">${l}</span>`).join("")}</div>
    </div>
    <div class="filters">
      ${st.with ? `<span class="pill">with ${esc(st.withName || st.with)}<button data-clear="with">×</button></span>`
                : `<input class="person" data-role="with" placeholder="Conversations with…">`}
      ${st.author ? `<span class="pill">from ${esc(st.authorName || st.author)}<button data-clear="author">×</button></span>`
                  : `<input class="person" data-role="author" placeholder="Written by…">`}
      ${st.thread ? `<span class="pill">in thread<button data-clear="thread">×</button></span>` : ""}
      <input class="date" data-f="since" placeholder="from YYYY-MM" value="${esc(st.since || "")}">
      <input class="date" data-f="until" placeholder="to YYYY-MM" value="${esc(st.until || "")}">
      <select data-f="sort">
        ${[["rank", "Best match"], ["new", "Newest"], ["old", "Oldest"]].map(([v, l]) => `<option value="${v}"${(st.sort || "rank") === v ? " selected" : ""}>${l}</option>`).join("")}
      </select>
    </div>
    <div class="hist"></div>
    <div class="summary"></div>
    <div class="results"></div>
    <div class="sentinel"></div>`;

  let resultsIo = null;
  const rerender = () => {
    observers.forEach((o) => o.disconnect()); observers = [];
    views.search({ params: new URLSearchParams(Object.entries(st).filter(([, v]) => v)) });
  };
  /** Filters rebuild the view; typing only refreshes results so the input keeps focus. */
  const update = (patch, full = true) => {
    Object.assign(st, patch);
    go("/search", st, true);
    full ? rerender() : refresh();
  };
  const input = $("input[type=search]");
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  input.addEventListener("input", debounce(() => update({ q: input.value }, false), 180));
  view.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => update({ kind: c.dataset.k })));
  view.querySelectorAll("[data-clear]").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.clear; update({ [k]: "", [k + "Name"]: "" });
  }));
  view.querySelectorAll("input.person").forEach((inp) =>
    personPicker(inp, (p) => update({ [inp.dataset.role]: p.id, [inp.dataset.role + "Name"]: p.name })));
  view.querySelectorAll("[data-f]").forEach((el) => el.addEventListener("change", () => update({ [el.dataset.f]: el.value })));

  let generation = 0;
  async function refresh() {
    const gen = ++generation;
    resultsIo?.disconnect();
    const results = $(".results");
    results.innerHTML = "";
    const q = { q: st.q, kind: st.kind, with: st.with, author: st.author, thread: st.thread, since: st.since, until: st.until };
    const hasQuery = Object.values(q).some(Boolean);
    api("histogram", q).then((rows) => gen === generation && histogram($(".hist"), rows, {
      selected: st.since && st.since === st.until ? st.since : null,
      onPick: (m) => update(st.since === m && st.until === m ? { since: "", until: "" } : { since: m, until: m }),
    }));
    if (!hasQuery) {
      const stats = await api("stats");
      $(".summary").innerHTML = `${num(Object.values(stats.kinds).reduce((a, b) => a + b, 0))} items · ${num(stats.threads)} threads · ${num(stats.people)} people · ${num(stats.media)} media files, from ${fmtDate(stats.range[0])} to ${fmtDate(stats.range[1])}. Type to search, or filter by kind, person or date.`;
      return;
    }
    let offset = 0;
    const load = async () => {
      const res = await api("search", { ...q, sort: st.sort, limit: 50, offset });
      // A newer keystroke superseded this request.
      if (gen !== generation) return false;
      if (offset === 0) {
        $(".summary").textContent = `${num(res.total)} results`;
        if (!res.total) results.innerHTML = `<div class="empty">Nothing found.</div>`;
      }
      res.items.forEach((it) => results.append(card(it)));
      offset += res.items.length;
      return offset < res.total && res.items.length > 0;
    };
    if (await load()) resultsIo = track(infinite($(".sentinel"), load));
  }
  await refresh();
};

views.thread = async ({ parts, params }) => {
  const id = parts[1];
  const at = params.get("at") ? Number(params.get("at")) : null;
  const info = await api(`thread/${encodeURIComponent(id)}`);
  const chip = (p) => `<a href="#/person/${p.id}">${esc(p.name)} <span class="muted">${num(p.n)}</span></a>`;
  // Big groups would otherwise turn the sticky header into a wall of names.
  const shown = info.people.slice(0, 12), hidden = info.people.slice(12);
  const people = shown.map(chip).join("") +
    (hidden.length ? `<a href="#" class="more">+${hidden.length} more</a>` : "");
  view.innerHTML = `
    <div class="thread-head">
      <h2>${esc(info.title)}</h2>
      <div class="muted small">${num(info.n_items)} messages · ${fmtDate(info.first_ts)} → ${fmtDate(info.last_ts)} · ${esc(info.box)}
        · <a href="#/search?thread=${encodeURIComponent(id)}">search in thread</a>
        · <a href="#/gallery?thread=${encodeURIComponent(id)}">media</a></div>
      <div class="people-chips">${people}</div>
    </div>
    <div class="sentinel s-older"></div>
    <div class="msgs"></div>
    <div class="sentinel s-newer"></div>`;

  $(".people-chips .more")?.addEventListener("click", (e) => {
    e.preventDefault(); e.target.outerHTML = hidden.map(chip).join("");
  });
  const box = $(".msgs");
  let first = null, last = null, lastDay = null;
  const isGroup = info.people.length > 2;
  const render = (m, prevAuthor) => {
    const el = document.createElement("div");
    el.className = "msg" + (m.author_is_me ? " me" : "") + (m.id === at ? " target" : "");
    el.id = "m" + m.id;
    const reacts = (m.extra?.reactions || []).map((r) => `<span title="${esc(r.by)}">${esc(r.r)}</span>`).join(" ");
    const share = m.extra?.share?.link ? `<div><a href="${esc(m.extra.share.link)}" target="_blank" rel="noopener">${esc(m.extra.share.share_text || m.extra.share.link)}</a></div>` : "";
    const call = m.extra?.call_duration != null ? `📞 ${Math.round(m.extra.call_duration / 60)} min` : "";
    const text = m.body ? linkify(esc(m.body)) : "";
    const bubble = text || share || call ? `<div class="bubble">${text}${share}${call}</div>` : "";
    el.innerHTML = `${isGroup && !m.author_is_me && m.author !== prevAuthor ? `<div class="who">${esc(m.author)}</div>` : ""}
      ${bubble}<div class="media">${mediaHtml(m.media, { caption: `${m.author} · ${fmtDate(m.ts)}` })}</div>
      ${reacts ? `<div class="reacts">${reacts}</div>` : ""}<div class="time">${fmtDate(m.ts)} ${fmtTime(m.ts)}</div>`;
    return el;
  };
  /** Build nodes for a chronological batch, inserting day separators. */
  const build = (msgs, dayBefore) => {
    const frag = document.createDocumentFragment();
    let day = dayBefore, prev = null;
    for (const m of msgs) {
      const d = new Date(m.ts).toDateString();
      if (d !== day) {
        const sep = document.createElement("div"); sep.className = "day"; sep.textContent = fmtDay(m.ts);
        frag.append(sep); day = d; prev = null;
      }
      frag.append(render(m, prev)); prev = m.author;
    }
    return { frag, day };
  };
  const initial = await api(`thread/${encodeURIComponent(id)}/messages`, at ? { around: at, n: 80 } : { n: 80 });
  if (!initial.length) { box.innerHTML = `<div class="empty">Empty thread.</div>`; return; }
  first = initial[0]; last = initial[initial.length - 1];
  const b = build(initial, null); box.append(b.frag); lastDay = b.day;
  if (at) $("#m" + at)?.scrollIntoView({ block: "center" });
  else scrollTo(0, document.body.scrollHeight);

  let olderDone = false, newerDone = !at;
  track(infinite($(".sentinel.s-older"), async () => {
    if (olderDone) return false;
    const msgs = await api(`thread/${encodeURIComponent(id)}/messages`, { before_ts: first.ts, before_id: first.id, n: 80 });
    if (!msgs.length) { olderDone = true; return false; }
    // Drop the separator that would duplicate the current first day.
    const firstSep = box.querySelector(".day");
    const { frag } = build(msgs, null);
    if (firstSep && new Date(msgs[msgs.length - 1].ts).toDateString() === new Date(first.ts).toDateString()) firstSep.remove();
    const h = document.documentElement.scrollHeight;
    box.prepend(frag);
    scrollBy(0, document.documentElement.scrollHeight - h);
    first = msgs[0];
  }));
  track(infinite($(".sentinel.s-newer"), async () => {
    if (newerDone) return false;
    const msgs = await api(`thread/${encodeURIComponent(id)}/messages`, { after_ts: last.ts, after_id: last.id, n: 80 });
    if (!msgs.length) { newerDone = true; return false; }
    const b2 = build(msgs, lastDay); box.append(b2.frag); lastDay = b2.day;
    last = msgs[msgs.length - 1];
  }));
};

views.threads = async ({ params }) => {
  const q = params.get("q") || "";
  view.innerHTML = `<div class="searchbar"><input type="search" placeholder="Filter threads by name…" value="${esc(q)}"></div>
    <div class="summary"></div><div class="list"></div>`;
  const input = $("input[type=search]");
  const load = async () => {
    const rows = await api("threads", { q: input.value });
    $(".summary").textContent = `${rows.length}${rows.length === 300 ? "+" : ""} threads, most recent first`;
    $(".list").innerHTML = rows.map((t) => `<a class="row" href="#/thread/${encodeURIComponent(t.id)}">
      <span class="grow">${t.is_group ? "👥 " : ""}${esc(t.title)}</span>
      <span class="muted small">${num(t.n_items)} msgs</span>
      <span class="muted small">${fmtDate(t.first_ts)} → ${fmtDate(t.last_ts)}</span></a>`).join("");
  };
  input.addEventListener("input", debounce(() => { go("/threads", { q: input.value }, true); load(); }, 150));
  load();
};

views.people = async ({ params }) => {
  const q = params.get("q") || "";
  view.innerHTML = `<div class="searchbar"><input type="search" placeholder="Find a person…" value="${esc(q)}"></div>
    <div class="list"></div>`;
  const input = $("input[type=search]");
  const load = async () => {
    const rows = await api("people", { q: input.value, limit: 300 });
    $(".list").innerHTML = rows.map((p) => `<a class="row" href="#/person/${p.id}">
      <span class="grow">${esc(p.name)}${p.is_me ? " <span class='kind'>you</span>" : ""}</span>
      <span class="muted small">${num(p.n_items)} items</span>
      <span class="muted small">${num(p.n_threads)} threads</span></a>`).join("");
  };
  input.addEventListener("input", debounce(() => { go("/people", { q: input.value }, true); load(); }, 150));
  load();
};

views.person = async ({ parts }) => {
  const p = await api(`person/${parts[1]}`);
  const max = Math.max(...p.per_year.map((y) => y.n), 1);
  const years = p.per_year.length ? monthRange(p.per_year[0].year + "-01", p.per_year[p.per_year.length - 1].year + "-01")
    .filter((m) => m.endsWith("-01")).map((m) => m.slice(0, 4)) : [];
  const byYear = Object.fromEntries(p.per_year.map((y) => [y.year, y]));
  const w = encodeURIComponent(p.name);
  view.innerHTML = `
    <div class="person-head">
      <h2>${esc(p.name)}</h2>
      <div class="muted">${num(p.n_items)} items written · ${p.first_ts ? `${fmtDate(p.first_ts)} → ${fmtDate(p.last_ts)}` : "no dated activity"}</div>
      <p><a href="#/search?with=${p.id}&withName=${w}&sort=new">Search conversations with ${esc(p.name)}</a> ·
         <a href="#/search?author=${p.id}&authorName=${w}&sort=new">Everything they wrote</a> ·
         <a href="#/gallery?with=${p.id}">Shared media</a></p>
    </div>
    <h3>Messages exchanged per year</h3>
    <div class="bars">${years.map((y) => { const r = byYear[y]; return `<div style="height:${r ? (r.n / max) * 100 : 0}%" title="${y}: ${r ? num(r.n) : 0} (${r ? num(r.theirs) : 0} from them)"></div>`; }).join("")}</div>
    <div class="bars-axis">${years.map((y) => `<span>${y.slice(2)}</span>`).join("")}</div>
    <h3>Threads (${p.threads.length})</h3>
    <div class="list">${p.threads.map((t) => `<a class="row" href="#/thread/${encodeURIComponent(t.id)}">
      <span class="grow">${t.is_group ? "👥 " : ""}${esc(t.title)}</span>
      <span class="muted small">${num(t.n_items)} msgs</span>
      <span class="muted small">${fmtDate(t.first_ts)} → ${fmtDate(t.last_ts)}</span></a>`).join("")}</div>`;
};

views.timeline = async () => {
  view.innerHTML = `<h2>Everything, month by month</h2>
    <div class="legend">${Object.entries(KIND_COLORS).filter(([k]) => k !== "log").map(([k, c]) => `<span><i style="background:${c}"></i>${k}</span>`).join("")}</div>
    <div class="hist big"></div>
    <p class="muted small">Click a month to browse everything from it in order.</p>`;
  const rows = await api("histogram");
  histogram($(".hist"), rows, { stacked: true, height: 220, onPick: (m) => go("/search", { since: m, until: m, sort: "old" }) });
};

views.gallery = async ({ params }) => {
  const st = Object.fromEntries(params);
  view.innerHTML = `<div class="filters">
      <input class="date" data-f="since" placeholder="from YYYY-MM" value="${esc(st.since || "")}">
      <input class="date" data-f="until" placeholder="to YYYY-MM" value="${esc(st.until || "")}">
      ${st.with ? `<span class="pill">with ${esc(st.withName || st.with)}<button data-clear="with">×</button></span>` : `<input class="person" data-role="with" placeholder="Shared with…">`}
      ${st.thread ? `<span class="pill">one thread<button data-clear="thread">×</button></span>` : ""}
      <select data-f="kind">${[["", "All sources"], ["message", "Messenger"], ["photo", "Albums"], ["post", "Posts"]].map(([v, l]) => `<option value="${v}"${(st.kind || "") === v ? " selected" : ""}>${l}</option>`).join("")}</select>
      <select data-f="sort">${[["new", "Newest"], ["old", "Oldest"]].map(([v, l]) => `<option value="${v}"${(st.sort || "new") === v ? " selected" : ""}>${l}</option>`).join("")}</select>
    </div><div class="grid"></div><div class="sentinel"></div>`;
  const update = (patch) => go("/gallery", { ...st, ...patch });
  view.querySelectorAll("[data-f]").forEach((el) => el.addEventListener("change", () => update({ [el.dataset.f]: el.value })));
  view.querySelectorAll("[data-clear]").forEach((b) => b.addEventListener("click", () => update({ [b.dataset.clear]: "", withName: "" })));
  view.querySelectorAll("input.person").forEach((inp) => personPicker(inp, (p) => update({ with: p.id, withName: p.name })));

  const grid = $(".grid");
  let offset = 0, lastMonth = null;
  const load = async () => {
    const rows = await api("gallery", { since: st.since, until: st.until, with: st.with, thread: st.thread, kind: st.kind, sort: st.sort, limit: 150, offset });
    if (!rows.length && offset === 0) grid.innerHTML = `<div class="empty">No media.</div>`;
    for (const m of rows) {
      const mo = m.ts ? new Date(m.ts).toLocaleDateString(undefined, { year: "numeric", month: "long" }) : "Undated";
      if (mo !== lastMonth) { grid.insertAdjacentHTML("beforeend", `<div class="grid-month">${mo}</div>`); lastMonth = mo; }
      const ctx = m.thread_id ? `#/thread/${encodeURIComponent(m.thread_id)}?at=${m.item_id}` : "";
      const cap = [m.author, m.thread_title, fmtDate(m.ts)].filter(Boolean).join(" · ");
      const inner = m.mtype === "video"
        ? `<video preload="metadata" src="/media/${m.id}#t=0.5" muted></video><span class="badge">▶ video</span>`
        : `<img loading="lazy" src="/thumb/${m.id}?s=320" alt="">`;
      grid.insertAdjacentHTML("beforeend", `<div class="tile" data-lightbox="${m.id}" data-mtype="${m.mtype}" data-caption="${esc(cap)}" data-ctx="${esc(ctx)}">${inner}</div>`);
    }
    offset += rows.length;
    return rows.length === 150;
  };
  await load();
  track(infinite($(".sentinel"), load));
};

// ---------- router ----------
async function render() {
  observers.forEach((o) => o.disconnect()); observers = [];
  closeModal();
  const r = route();
  const name = r.parts[0] || "search";
  document.querySelectorAll("[data-nav]").forEach((a) =>
    a.classList.toggle("on", a.dataset.nav === name || (name === "thread" && a.dataset.nav === "threads") || (name === "person" && a.dataset.nav === "people")));
  scrollTo(0, 0);
  try { await (views[name] || views.search)(r); }
  catch (e) { view.innerHTML = `<div class="empty">Error: ${esc(e.message)}</div>`; console.error(e); }
}
addEventListener("hashchange", render);
api("stats").then((s) => { $("#stats").textContent = `${s.me || ""} · ${num(Object.values(s.kinds).reduce((a, b) => a + b, 0))} items`; });
render();
