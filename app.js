// RF Workbench for iPad: the desktop app's workflow (desktop_app/rf_workbench.py)
// over Bluetooth LE. Device events drive a small state machine, as in the
// desktop app's handle_event().
import * as core from "./core.js";
import { BleLink } from "./link.js";
import { SimLink } from "./sim.js";
import { Library, loadPrefs, savePrefs } from "./store.js";

const $ = (id) => document.getElementById(id);
const COLORS = { plot: "#0d1829", border: "#293b54", muted: "#92a6bf", accent: "#36d6b0", fg: "#eef4fc", bg: "#7487a1", marker: "#ffd27b" };
const SCOPES = {
  "433 MHz module · 387–464 MHz": "module",
  "All CC1101 bands · experimental with this module": "all",
  "315 MHz band · 300–348 MHz": "315",
  "868 / 915 MHz bands · 779–928 MHz": "high",
};

const library = new Library();
const detector = new core.SmartDetector();
const prefs = loadPrefs();
prefs.replayProfiles ||= {};

const s = {  // app state
  link: null, demo: false, ready: false, busy: "", fw: {}, nextId: 0, deadline: 0,
  tuneId: 0, captureId: 0, txId: 0, cancelId: 0, uploadId: 0, helloId: 0,
  pendingRecord: null, pendingAuto: null, pendingTx: null, autoActive: false, autoArmedLogged: false,
  autoNew: 0, autoRepeated: 0, autoFiltered: 0, autoPrefix: "Auto", recordName: "",
  captures: [], selectedId: null, fullBurst: false, archived: [], lastFiltered: null,
  boardSignal: null,  // {crc, mhz} the board holds, so a replay can skip the upload
  samples: [], restored: false, resumeAuto: null, finder: null,
};

// ---------- small helpers ----------
function log(text) {
  const time = new Date().toTimeString().slice(0, 8);
  const pre = $("log");
  pre.textContent = (pre.textContent + `${time}  ${text}\n`).split("\n").slice(-300).join("\n");
  if (!$("logPanel").hidden) $("logPanel").scrollTop = $("logPanel").scrollHeight;
}
const footer = (text) => { $("footer").textContent = text; };
const mode = (text) => { $("modeLabel").textContent = text; };
const selected = () => s.captures.find((c) => c.id === s.selectedId) || null;
const savePreferences = () => savePrefs(prefs);
function send(cmd, params = {}) {
  if (!s.link) return 0;
  const id = ++s.nextId;
  s.link.send({ cmd, id, ...params }).catch((error) => {
    log(`Bluetooth write failed: ${error.message}`);
    if (s.busy) { stop(false); footer("Bluetooth write failed. Operation stopped; reconnect if needed."); }
  });
  return id;
}
function ask(title, value = "") {
  return new Promise((resolve) => {
    const dialog = $("ask");
    $("askTitle").textContent = title; $("askInput").value = value;
    dialog.onclose = () => resolve(dialog.returnValue === "ok" ? $("askInput").value : null);
    dialog.returnValue = ""; dialog.showModal(); $("askInput").focus();
  });
}
async function saveFile(name, text, type = "application/json") {
  const file = new File([text], name, { type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (error) { if (error.name === "AbortError") return; }
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}
const safeName = (name) => name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
let wakeLock = null;
async function keepAwake() {
  const want = s.autoActive || !!s.finder;
  try {
    if (want && !wakeLock && navigator.wakeLock && document.visibilityState === "visible") {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } else if (!want && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* not supported here; the help text explains */ }
}
document.addEventListener("visibilitychange", keepAwake);

// ---------- canvases ----------
function sizeCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
    canvas.width = Math.round(w * ratio); canvas.height = Math.round(h * ratio);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, w, h };
}

class Waveform {
  constructor(canvas) {
    this.canvas = canvas; this.pulses = []; this.bounds = [0]; this.start = 0; this.span = 1;
    this.pointers = new Map(); this.lastTap = 0;
    canvas.addEventListener("pointerdown", (e) => this.down(e));
    canvas.addEventListener("pointermove", (e) => this.move(e));
    for (const type of ["pointerup", "pointercancel", "pointerleave"]) canvas.addEventListener(type, (e) => this.up(e));
    canvas.addEventListener("wheel", (e) => { e.preventDefault(); this.zoom(e.deltaY < 0 ? 1.4 : 1 / 1.4, this.anchor(e.offsetX)); }, { passive: false });
  }
  get total() { return this.bounds[this.bounds.length - 1]; }
  set(pulses) {
    this.pulses = pulses || []; this.bounds = [0];
    for (const p of this.pulses) this.bounds.push(this.bounds[this.bounds.length - 1] + Math.abs(p));
    this.fit();
  }
  fit() { this.start = 0; this.span = Math.max(1, this.total); this.draw(); }
  clamp() { this.start = Math.max(0, Math.min(this.start, this.total - this.span)); }
  zoom(factor, anchor = 0.5) {
    const span = Math.min(Math.max(this.span / factor, 1000), Math.max(1000, this.total));
    this.start += (this.span - span) * anchor; this.span = span; this.clamp(); this.draw();
  }
  anchor(x) { return Math.max(0, Math.min(1, (x - 36) / Math.max(1, this.canvas.clientWidth - 56))); }
  timeAt(x) { return this.start + this.anchor(x) * this.span; }
  down(e) {
    this.canvas.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.offsetX, startX: e.offsetX, moved: false });
    if (this.pointers.size === 2) this.pinch = { distance: this.distance(), span: this.span };
  }
  distance() { const [a, b] = [...this.pointers.values()]; return Math.max(10, Math.abs(a.x - b.x)); }
  move(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.offsetX - p.x; p.x = e.offsetX;
    if (Math.abs(e.offsetX - p.startX) > 6) p.moved = true;
    if (this.pointers.size === 2 && this.pinch) {
      const [a, b] = [...this.pointers.values()], mid = (a.x + b.x) / 2, before = this.timeAt(mid);
      const target = this.pinch.span * this.pinch.distance / this.distance();
      this.span = Math.min(Math.max(target, 1000), Math.max(1000, this.total));
      this.start = before - this.anchor(mid) * this.span; this.clamp(); this.draw();
    } else if (this.pointers.size === 1 && p.moved) {
      this.start -= dx / Math.max(1, this.canvas.clientWidth - 56) * this.span; this.clamp(); this.draw();
    }
  }
  up(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (!p.moved && e.type === "pointerup") {
      const now = Date.now();
      if (now - this.lastTap < 300) this.fit(); else this.inspect(e.offsetX);
      this.lastTap = now;
    }
  }
  inspect(x) {
    const t = this.timeAt(x);
    let lo = 0, hi = this.pulses.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.bounds[mid] <= t) lo = mid; else hi = mid - 1; }
    const p = this.pulses[lo];
    if (p !== undefined) {
      $("inspect").textContent = `#${lo + 1}  ${p > 0 ? "ON " : "OFF"}  ${Math.abs(p).toLocaleString()} µs  |  start ${(this.bounds[lo] / 1000).toFixed(3)} ms`;
    }
  }
  draw() {
    const { ctx, w, h } = sizeCanvas(this.canvas);
    ctx.fillStyle = COLORS.plot; ctx.fillRect(0, 0, w, h);
    const left = 36, right = w - 20, top = 26, bottom = h - 36;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    if (!this.pulses.length) {
      ctx.fillStyle = COLORS.fg; ctx.font = "17px -apple-system, system-ui, sans-serif";
      ctx.fillText("Your next signal starts here", w / 2, h / 2 - 12);
      ctx.fillStyle = COLORS.muted; ctx.font = "13px -apple-system, system-ui, sans-serif";
      ctx.fillText("Record a remote, or select a saved capture.", w / 2, h / 2 + 14);
      return;
    }
    const high = top + 12, low = Math.max(top + 28, bottom - 10);
    ctx.setLineDash([2, 5]); ctx.strokeStyle = COLORS.border; ctx.lineWidth = 1;
    ctx.font = "11px -apple-system, system-ui, sans-serif"; ctx.fillStyle = COLORS.muted;
    for (let i = 0; i <= 6; i++) {
      const x = left + (right - left) * i / 6;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
      ctx.fillText(`${((this.start + this.span * i / 6) / 1000).toFixed(1)} ms`, x, h - 16);
    }
    ctx.setLineDash([]);
    ctx.font = "13px ui-monospace, Menlo, monospace";
    ctx.fillStyle = COLORS.accent; ctx.fillText("1", 15, high);
    ctx.fillStyle = COLORS.muted; ctx.fillText("0", 15, low);
    let first = 0, hi = this.pulses.length - 1;
    while (first < hi) { const mid = (first + hi + 1) >> 1; if (this.bounds[mid] <= this.start) first = mid; else hi = mid - 1; }
    ctx.beginPath(); ctx.strokeStyle = COLORS.accent; ctx.lineWidth = 2; ctx.lineJoin = "round";
    let started = false;
    const end = this.start + this.span, scale = (right - left) / this.span;
    for (let i = first; i < this.pulses.length && this.bounds[i] <= end; i++) {
      const x1 = left + (Math.max(this.bounds[i], this.start) - this.start) * scale;
      const x2 = left + (Math.min(this.bounds[i + 1], end) - this.start) * scale;
      const y = this.pulses[i] > 0 ? high : low;
      if (!started) { ctx.moveTo(x1, y); started = true; } else ctx.lineTo(x1, y);
      ctx.lineTo(x2, y);
    }
    ctx.stroke();
  }
}
const wave = new Waveform($("waveCanvas"));

function drawRssi() {
  const { ctx, w, h } = sizeCanvas($("rssiCanvas"));
  ctx.fillStyle = COLORS.plot; ctx.fillRect(0, 0, w, h);
  const y = (dbm) => (1 - (Math.max(-120, Math.min(-10, dbm)) + 120) / 110) * (h - 8) + 4;
  ctx.setLineDash([2, 6]); ctx.strokeStyle = COLORS.border; ctx.lineWidth = 1;
  for (const dbm of [-100, -70, -40]) { ctx.beginPath(); ctx.moveTo(0, y(dbm)); ctx.lineTo(w, y(dbm)); ctx.stroke(); }
  ctx.setLineDash([]);
  if (s.samples.length > 1) {
    ctx.beginPath(); ctx.strokeStyle = COLORS.accent; ctx.lineWidth = 2;
    s.samples.forEach((dbm, i) => { const x = i / 139 * w; if (i) ctx.lineTo(x, y(dbm)); else ctx.moveTo(x, y(dbm)); });
    ctx.stroke();
  }
}
function drawSpectrum(frequencies = [], signal = [], background = [], marker = null) {
  const { ctx, w, h } = sizeCanvas($("spectrum"));
  ctx.fillStyle = COLORS.plot; ctx.fillRect(0, 0, w, h);
  ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.font = "12px -apple-system, system-ui, sans-serif";
  if (!frequencies.length) {
    ctx.fillStyle = COLORS.muted; ctx.font = "15px -apple-system, system-ui, sans-serif";
    ctx.fillText("Learn the background to begin", w / 2, h / 2); return;
  }
  const low = frequencies[0], span = Math.max(1, frequencies[frequencies.length - 1] - low);
  const left = 48, right = w - 18, top = 16, bottom = h - 32;
  const x = (khz) => left + (khz - low) / span * (right - left);
  const y = (dbm) => bottom - (Math.max(-125, Math.min(5, dbm)) + 125) / 130 * (bottom - top);
  ctx.setLineDash([2, 5]); ctx.strokeStyle = COLORS.border; ctx.fillStyle = COLORS.muted; ctx.textAlign = "right";
  for (const dbm of [-120, -90, -60, -30, 0]) {
    ctx.beginPath(); ctx.moveTo(left, y(dbm)); ctx.lineTo(right, y(dbm)); ctx.stroke();
    ctx.fillText(String(dbm), left - 7, y(dbm));
  }
  ctx.setLineDash([]);
  for (let i = 0; i < 6; i++) {
    const khz = low + span * i / 5;
    ctx.textAlign = i === 5 ? "right" : "center";  // keep the last label inside the plot
    ctx.fillText((khz / 1000).toFixed(3), x(khz), h - 14);
  }
  for (const [values, color] of [[background, COLORS.bg], [signal, COLORS.accent]]) {
    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 2;
    let pen = false, previous = null;
    frequencies.forEach((khz, i) => {
      const v = values[i];
      if (v === undefined || v <= -190 || (previous !== null && khz - previous > 1000)) pen = false;
      if (v !== undefined && v > -190) { if (pen) ctx.lineTo(x(khz), y(v)); else { ctx.moveTo(x(khz), y(v)); pen = true; } }
      previous = khz;
    });
    ctx.stroke();
  }
  if (marker !== null) {
    ctx.setLineDash([4, 3]); ctx.strokeStyle = COLORS.marker;
    ctx.beginPath(); ctx.moveTo(x(marker), top); ctx.lineTo(x(marker), bottom); ctx.stroke(); ctx.setLineDash([]);
  }
}

// ---------- library ----------
async function reloadLibrary(selectId = null) {
  const { captures, archived, errors } = await library.load();
  s.captures = captures.map((c) => {
    const a = detector.analysisFor(c);
    return !c.frame_pulses && a.frame_pulses.length ? core.annotate(c, a) : c;
  });
  s.archivedCaptures = archived;
  for (const error of errors) log(error);
  if (selectId && s.captures.some((c) => c.id === selectId)) s.selectedId = selectId;
  else if (!s.captures.some((c) => c.id === s.selectedId)) s.selectedId = s.captures[0]?.id ?? null;
  renderLibrary(); selectCapture(s.selectedId, false);
}
function renderLibrary() {
  const query = $("search").value.trim().toLowerCase();
  const list = $("captureList");
  const visible = s.captures.filter((c) => !query || `${c.name} ${c.notes} ${c.frequency_mhz.toFixed(3)}`.toLowerCase().includes(query));
  list.replaceChildren(...visible.map((c) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option"); li.dataset.id = c.id;
    li.setAttribute("aria-selected", String(c.id === s.selectedId));
    const name = Object.assign(document.createElement("span"), { className: "name", textContent: c.name });
    const seen = Object.assign(document.createElement("span"), { className: "seen", textContent: `Seen ${c.seen_count}` });
    const meta = Object.assign(document.createElement("span"), { className: "meta",
      textContent: `${c.frequency_mhz.toFixed(3)} MHz · ${c.pulses.length.toLocaleString()} pulses${c.frame_pulses ? ` · ${c.frame_repeats} frames` : ""}` });
    li.append(name, seen, meta);
    return li;
  }));
  if (!visible.length) {
    const li = Object.assign(document.createElement("li"), { className: "empty",
      textContent: s.captures.length ? "No signals match the search." : "No signals yet. Record or Auto Catch a remote, or Import a file." });
    list.append(li);
  }
  const n = s.captures.length;
  $("libCount").textContent = query ? `${visible.length} shown · ${n} saved` : `${n} saved signal${n === 1 ? "" : "s"}`;
}
function selectCapture(id, user = true) {
  s.selectedId = id; s.fullBurst = false;
  for (const li of $("captureList").children) if (li.dataset.id) li.setAttribute("aria-selected", String(li.dataset.id === id));
  const c = selected();
  $("useFrame").checked = !!c?.frame_pulses;
  if (c) {
    const frame = c.frame_pulses ? ` · ${c.frame_repeats} matching frames` : "";
    const quality = c.quality !== null ? ` · timing quality ${c.quality}/100` : "";
    const warn = c.truncated ? " · buffer limit reached" : "";
    $("summary").textContent = `${c.name} · Seen ${c.seen_count} · ${c.pulses.length.toLocaleString()} raw intervals · ${(core.durationUs(c.pulses) / 1000).toFixed(1)} ms · ${c.frequency_mhz.toFixed(3)} MHz${frame}${quality}${warn}`;
    $("gap").value = c.frame_pulses && c.gap_us ? (c.gap_us / 1000).toFixed(3) : "20";
    $("repeats").value = c.frame_pulses ? "5" : "1";
    const saved = prefs.replayProfiles[c.id];
    if (saved && typeof saved === "object") {
      if (saved.repeats) $("repeats").value = String(saved.repeats);
      if (saved.gap) $("gap").value = String(saved.gap);
      if (saved.power !== undefined) $("power").value = String(saved.power);
      $("useFrame").checked = saved.clean !== false && !!c.frame_pulses;
    }
  } else {
    $("summary").textContent = "Select a saved capture to inspect its waveform.";
  }
  updateWave(); updateTxPreview(); refreshControls();
  if (user && c) $("inspect").textContent = "Tap the waveform to inspect an interval. Pinch to zoom, drag to pan.";
}
function updateWave() {
  const c = selected();
  wave.set(c ? (c.frame_pulses && !s.fullBurst ? c.frame_pulses : c.pulses) : []);
  $("waveToggle").textContent = s.fullBurst ? "Clean frame" : "Full burst";
}
function updateTxPreview() {
  const c = selected();
  if (!c) { $("txInfo").textContent = "Select a signal from your library"; return; }
  const clean = $("useFrame").checked && c.frame_pulses;
  if (!core.validTxFrequency(c.frequency_mhz)) { $("txInfo").textContent = `${c.frequency_mhz.toFixed(3)} MHz · receive-only with this module`; return; }
  const repeats = Number($("repeats").value), gap = Number($("gap").value);
  if (!Number.isFinite(gap) || gap < 5 || gap > 1000) { $("txInfo").textContent = "Gap must be 5–1000 ms"; return; }
  try {
    const plan = core.planReplay(clean ? c.frame_pulses : c.pulses, repeats, core.pyRound(gap * 1000));
    const total = plan.totalUs >= 1e6 ? `${(plan.totalUs / 1e6).toFixed(2)} s` : `${(plan.totalUs / 1000).toFixed(1)} ms`;
    $("txInfo").textContent = `${c.frequency_mhz.toFixed(3)} MHz · ${clean ? "clean frame" : "full burst"} × ${plan.frames} · ${total} total`;
  } catch (error) {
    $("txInfo").textContent = error.message;
  }
}
async function storeCapture(capture) {
  await library.save(capture);
  $("search").value = "";
  await reloadLibrary(capture.id);
}

// ---------- device operations ----------
function settings() {
  const frequency = core.validateFrequency(Number($("freq").value));
  const bandwidth = Number($("bw").value);
  if (!core.BANDWIDTHS.includes(bandwidth)) throw new Error("Choose a supported bandwidth.");
  return { frequency, bandwidth };
}
function tune() {
  if (!s.ready || s.busy) return;
  try {
    const { frequency, bandwidth } = settings();
    s.busy = "tuning";
    s.tuneId = send("tune", { frequency_mhz: frequency, bandwidth_khz: bandwidth });
    s.deadline = Date.now() + 8000;
    footer(`Tuning to ${frequency.toFixed(2)} MHz…`);
  } catch (error) {
    s.busy = ""; footer(error.message); log(error.message);
  }
  refreshControls();
}
function record() {
  if (!s.ready || s.busy) return;
  const trigger = Number($("trigger").value);
  if (!Number.isInteger(trigger) || trigger < -110 || trigger > -20) { footer("Trigger must be a whole number between −110 and −20 dBm."); return; }
  const stamp = new Date().toISOString().slice(0, 19).replace("T", " ").replace(/:/g, "-");
  const name = $("name").value.trim() || `Signal ${stamp}`;
  if (name.length > 80) { footer("Signal names can contain at most 80 characters."); return; }
  s.pendingRecord = { name, trigger };
  tune();
  if (!s.busy) s.pendingRecord = null;
}
function autoCatch() {
  if (s.autoActive || s.pendingAuto) { stop(); return; }
  if (!s.ready || s.busy || !s.fw.auto_capture) return;
  const prefix = $("name").value.trim() || "Auto";
  if (prefix.length > 60) { footer("Use a name prefix of at most 60 characters."); return; }
  s.pendingAuto = { prefix, margin: core.SENSITIVITY[$("sensitivity").value] };
  s.autoArmedLogged = false;
  s.autoNew = s.autoRepeated = s.autoFiltered = 0;
  updateAutoStats();
  tune();
  if (!s.busy) s.pendingAuto = null;
}
function stop(sendCancel = true) {
  s.pendingTx = null; s.pendingRecord = null; s.pendingAuto = null; s.resumeAuto = null;
  s.autoActive = false;
  s.captureId = s.txId = s.tuneId = s.uploadId = 0;
  if (sendCancel && s.link && s.ready) s.cancelId = send("cancel");
  s.deadline = 0; s.busy = "";
  mode("Stopped"); keepAwake(); refreshControls();
}
function transmit() {
  const c = selected();
  if (!c || !s.ready || s.busy) return;
  try {
    core.validateTxFrequency(c.frequency_mhz);
    const repeats = Number($("repeats").value), gap = Number($("gap").value), power = Number($("power").value);
    if (!core.REPEAT_CHOICES.includes(repeats) || !Number.isFinite(gap) || gap < 5 || gap > 1000 || !core.POWERS.includes(power))
      throw new Error("Choose valid transmitter settings.");
    const gapUs = core.pyRound(gap * 1000);
    const plan = core.planReplay($("useFrame").checked && c.frame_pulses ? c.frame_pulses : c.pulses, repeats, gapUs);
    const values = plan.pulses, crc = core.pulseCrc(values);
    prefs.replayProfiles[c.id] = { repeats, gap, power, clean: $("useFrame").checked };
    savePreferences();
    s.pendingTx = { values, crc, mhz: c.frequency_mhz, retried: false, frames: plan.frames, totalUs: plan.totalUs,
                    params: { repeats: plan.repeats, gap_us: gapUs, power_dbm: power, crc32: crc, frequency_mhz: c.frequency_mhz } };
    log(`Preparing ${c.name} at ${c.frequency_mhz.toFixed(2)} MHz, ${plan.frames} repeat(s)` +
        (plan.copies > 1 ? ` (${plan.copies} per upload × ${plan.repeats}).` : "."));
    const held = s.boardSignal;
    if (held && held.crc === crc && Math.abs(held.mhz - c.frequency_mhz) < 0.0005) startTx();
    else upload();
  } catch (error) {
    s.busy = ""; s.pendingTx = null; footer(error.message); log(error.message);
  }
  refreshControls();
}
function upload() {
  const tx = s.pendingTx;
  s.busy = "loading";
  s.deadline = Date.now() + 30000;  // a 4000-interval burst takes a few seconds over Bluetooth
  s.uploadId = send("upload", { frequency_mhz: tx.mhz, pulses: core.encodeCompact(tx.values), crc32: tx.crc });
  footer("Sending the signal to the board…");
  refreshControls();
}
function startTx() {
  const tx = s.pendingTx;
  s.busy = "transmitting";
  s.txId = send("transmit", tx.params);
  s.deadline = Date.now() + tx.totalUs / 1000 + 5000;
  refreshControls();
}

// ---------- device events (rf_workbench.py handle_event) ----------
function handleEvent(m) {
  const event = m.event;
  if (s.finder && (event?.startsWith("scan_") || (event === "error" && s.finder.ids.has(m.id)))) { finderEvent(m); refreshControls(); return; }
  if (["armed", "triggered", "capture", "rejected"].includes(event) && m.id !== s.captureId) {
    if (event === "capture" && Number.isInteger(m.crc32)) s.boardSignal = { crc: m.crc32, mhz: m.frequency_mhz };
    return;
  }
  if (["tx_started", "tx_done"].includes(event) && m.id !== s.txId) return;
  switch (event) {
    case "hello": {
      if (m.id !== s.helloId) break;
      if (m.firmware !== "RFWorkbench" || m.protocol !== 1) { footer("Unsupported firmware. Flash RF Workbench 2.1 from the PC."); disconnect(); return; }
      s.busy = ""; s.pendingTx = null; s.pendingRecord = null; s.pendingAuto = null; s.autoActive = false; s.deadline = 0;
      s.fw = { ...m }; s.tuneId = s.captureId = s.txId = s.uploadId = 0;
      s.ready = !!m.radio;
      s.link.setMtu?.(m.mtu);
      s.boardSignal = Number.isInteger(m.loaded_crc32) ? { crc: m.loaded_crc32, mhz: m.loaded_mhz } : null;
      $("freq").value = (m.frequency_mhz ?? 433.92).toFixed(3);
      $("bw").value = String(Math.round(m.bandwidth_khz ?? 650));
      setChip(s.ready ? "CONNECTED" : "RADIO NOT FOUND", s.ready ? "ok" : "busy");
      mode("Listening");
      footer("Ready. Name a signal, then tap Record and press your remote.");
      log(`RF Workbench ${m.version} · CC1101 ${s.ready ? "found" : "not found"} · ${(m.frequency_mhz ?? 0).toFixed(2)} MHz · MTU ${m.mtu ?? "?"}.`);
      if (m.auto_enabled) send("cancel");
      const resume = s.resumeAuto;
      s.resumeAuto = null;
      if (!s.restored) {
        s.restored = true;
        if (core.validFrequency(Number(prefs.frequency))) $("freq").value = Number(prefs.frequency).toFixed(3);
        if (["203", "325", "650"].includes(prefs.bandwidth)) $("bw").value = prefs.bandwidth;
      }
      if (resume && s.ready) {
        log("Reconnected; resuming Auto Catch.");
        $("sensitivity").value = resume.sensitivity; $("name").value = resume.prefix === "Auto" ? $("name").value : resume.prefix;
        setTimeout(() => { if (!s.busy) autoCatch(); }, 500);
      } else if (s.ready) setTimeout(tune, 500);
      break;
    }
    case "status":
      if (Number.isInteger(m.loaded_crc32)) s.boardSignal = { crc: m.loaded_crc32, mhz: m.loaded_mhz };
      if (s.tuneId && m.id === s.tuneId) {
        s.deadline = 0; s.tuneId = 0;
        prefs.frequency = $("freq").value; prefs.bandwidth = $("bw").value; savePreferences();
        $("freq").value = m.frequency_mhz.toFixed(3);
        const options = s.fw.precision_replay ? core.receiveOptions($("profile").value) : {};
        if (s.pendingAuto) {
          s.autoPrefix = s.pendingAuto.prefix;
          s.captureId = send("auto_start", { margin_db: s.pendingAuto.margin, ...options });
          s.pendingAuto = null; s.autoActive = true; s.busy = "watching";
          log(`Auto Catch started: adaptive trigger ${core.SENSITIVITY[$("sensitivity").value]} dB above background.`);
          keepAwake();
        } else if (s.pendingRecord) {
          s.recordName = s.pendingRecord.name;
          s.captureId = send("capture", { trigger_dbm: s.pendingRecord.trigger, ...(s.fw.precision_replay ? options : { duration_ms: 1500 }) });
          s.pendingRecord = null; s.busy = "armed"; s.deadline = Date.now() + 27000;
        } else {
          s.busy = "";
          footer(`Listening at ${m.frequency_mhz.toFixed(3)} MHz.`);
          log(`Tuned to ${m.frequency_mhz.toFixed(3)} MHz.`);
        }
      }
      break;
    case "rssi":
      if (Number.isFinite(m.dbm)) {
        $("rssiValue").textContent = `${Math.round(m.dbm)} dBm`;
        s.samples.push(m.dbm); if (s.samples.length > 140) s.samples.shift();
        drawRssi();
      }
      if ("noise_dbm" in m) $("detectorLine").textContent = `Noise ${m.noise_dbm} · trigger ${m.trigger_dbm} dBm`;
      if (s.autoActive) mode(m.mode === "cooldown" ? "Auto Catch · waiting for quiet" : m.mode === "armed" ? "Auto Catch · watching" : $("modeLabel").textContent);
      break;
    case "armed":
      if (m.auto) {
        s.autoActive = true; s.busy = "watching";
        mode("Auto Catch · watching");
        footer("Auto Catch is watching. New signals are saved; matching signals update Seen.");
        if (!s.autoArmedLogged) { log(`Auto Catch watching · background ${m.noise_dbm} dBm · trigger ${m.trigger_dbm} dBm.`); s.autoArmedLogged = true; }
      } else {
        s.busy = "armed"; mode("Waiting for your remote…");
        footer("Press the remote now. Waiting up to 20 seconds.");
        log(`Recording armed above ${m.trigger_dbm} dBm. Press your remote.`);
      }
      break;
    case "triggered":
      s.busy = "recording"; mode("Recording signal…"); footer("Signal detected — recording its timing.");
      break;
    case "capture":
      // One at a time, so a quick second burst is compared against the first one's library entry.
      s.captureQueue = (s.captureQueue || Promise.resolve()).then(() => captureEvent(m));
      break;
    case "rejected":
      if (s.autoActive) { s.autoFiltered++; updateAutoStats(); s.busy = "watching"; }
      break;
    case "loaded": {
      const tx = s.pendingTx;
      if (!tx || m.id !== s.uploadId) break;
      if (m.count !== tx.values.length || m.crc32 !== tx.crc) {
        stop(); footer("Upload verification failed. Nothing transmitted; try again.");
        log("Upload checksum/count verification failed."); return;
      }
      s.boardSignal = { crc: m.crc32, mhz: m.frequency_mhz };
      startTx();
      break;
    }
    case "tx_started":
      s.busy = "transmitting"; mode("Transmitting…");
      footer("Transmitting the selected signal. Stop cancels the remaining output.");
      break;
    case "tx_done":
      log(`Transmission complete: ${s.pendingTx?.frames ?? m.repeats} repeat(s) in ${m.elapsed_ms} ms.`);
      s.deadline = 0; s.busy = ""; s.pendingTx = null; mode("Listening");
      footer("Transmission complete. Receiver is listening again.");
      break;
    case "cancelled":
      if (m.id !== s.cancelId || s.busy) return;
      s.deadline = 0; s.autoActive = false; s.busy = "";
      mode("Listening"); footer("Stopped. Receiver is listening again."); log("Operation stopped.");
      keepAwake();
      break;
    case "error":
      if (m.code === "not_loaded" && s.pendingTx && m.id === s.txId && !s.pendingTx.retried) {
        s.pendingTx.retried = true; s.boardSignal = null; upload(); return;  // the board's copy changed; send it
      }
      s.deadline = 0; s.busy = ""; s.pendingTx = null; s.pendingRecord = null; s.pendingAuto = null; s.autoActive = false;
      mode("Listening"); footer(m.message || "Device error."); log(m.message || "Device error.");
      keepAwake();
      break;
  }
  refreshControls();
}

async function captureEvent(m) {
  s.deadline = 0;
  const automatic = s.autoActive && !!m.auto;
  s.busy = automatic ? "watching" : "";
  mode(automatic ? "Auto Catch · captured" : "Listening");
  try {
    if (!Array.isArray(m.pulses)) throw new Error("Capture has no pulse data.");
    if (Number.isInteger(m.crc32) && core.pulseCrc(m.pulses) !== m.crc32) throw new Error("Capture checksum mismatch. Please record again.");
    s.boardSignal = { crc: m.crc32 ?? core.pulseCrc(m.pulses), mhz: m.frequency_mhz };
    const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, "-");
    const rx = {};
    for (const k of ["bandwidth_khz", "glitch_us", "removed_glitches", "raw_edges", "quiet_ms", "record_ms", "noise_dbm", "stop_reason"]) if (k in m) rx[k] = m[k];
    let capture = core.makeCapture({ name: automatic ? `${s.autoPrefix} ${stamp}` : s.recordName || "Recorded signal",
      frequency_mhz: m.frequency_mhz, pulses: m.pulses, peak_dbm: m.peak_dbm ?? null, truncated: !!m.truncated, rx_settings: rx });
    let matched = false;
    if (automatic) {
      const existing = $("policy").value === "Group matching signals" ? s.captures : [];
      const decision = detector.observe(capture, existing, m.noise_dbm ?? null);
      if (!decision.capture) {
        s.lastFiltered = core.annotate(capture, decision.analysis);
        s.autoFiltered++; updateAutoStats(); refreshControls();
        log(`Auto Catch filtered a burst: ${decision.analysis.reason}`);
        return;
      }
      capture = decision.capture; matched = decision.repeated;
    } else {
      capture = core.annotate(capture, detector.analysisFor(capture));
    }
    await storeCapture(capture);
    if (automatic) { s.autoRepeated += matched ? 1 : 0; s.autoNew += matched ? 0 : 1; updateAutoStats(); }
    footer(`Saved ${capture.name} — ${capture.pulses.length.toLocaleString()} intervals.`);
    if (matched) log(`Matched existing library entry: ${capture.name} · Seen ${capture.seen_count}.`);
    else log(`New capture added: ${capture.name} · ${capture.pulses.length.toLocaleString()} intervals, ${(core.durationUs(capture.pulses) / 1000).toFixed(1)} ms, peak ${capture.peak_dbm} dBm.`);
    if (capture.truncated) log("Capture reached the buffer limit. Record a shorter press for a complete burst.");
    if (automatic) footer(matched ? `Updated existing entry · ${capture.name} · Seen ${capture.seen_count}. Auto Catch watching.` : `New library entry · ${capture.name}. Auto Catch watching.`);
  } catch (error) {
    log(`Could not save capture: ${error.message}`);
    footer("Capture could not be saved. See Activity.");
  }
  refreshControls();
}
function updateAutoStats() { $("autoStats").textContent = `New ${s.autoNew} · repeats ${s.autoRepeated} · filtered ${s.autoFiltered}`; }

// ---------- connection ----------
function setChip(text, kind = "") { const chip = $("linkChip"); chip.textContent = text; chip.className = `chip ${kind}`; }
async function connect(demo = false) {
  if (s.link) return;
  if (!demo && !BleLink.supported()) {
    showNotice("This browser has no Web Bluetooth. On iPad, open this page in the free Bluefy browser; on a PC, use Chrome or Edge. Demo shows the app without hardware.");
    return;
  }
  s.demo = demo;
  const Link = demo ? SimLink : BleLink;
  const link = new Link({ onEvent: (m) => s.link === link && handleEvent(m), onState: (state, detail) => s.link === link && linkState(state, detail),
                          onBadLine: (error) => log(`Ignored a malformed line from the board: ${error.message}`) });
  s.link = link;
  setChip("CONNECTING", "busy"); footer(demo ? "Starting the demo board…" : "Choose “RF Workbench” in the Bluetooth list…");
  refreshControls();
  try {
    await link.connect();
  } catch (error) {
    s.link = null; setChip("DISCONNECTED");
    footer(error.name === "NotFoundError" ? "No board selected." : `Could not connect: ${error.message}`);
    log(`Connect failed: ${error.message}`);
    refreshControls();
  }
}
function linkState(state, detail = {}) {
  if (state === "connected") {
    setChip("CHECKING", "busy");
    footer(detail.reconnected ? "Reconnected. Checking firmware…" : "Connected. Checking firmware… (first time: enter the passkey when asked)");
    log(detail.reconnected ? "Bluetooth reconnected." : `Connected to ${s.link.name}.`);
    $("simPress").hidden = !s.demo;
    s.helloId = send("hello", { compact: true });
    setTimeout(() => {
      if (s.link && !s.ready && s.helloId && !s.fw.firmware) footer("No answer from the board. It needs RF Workbench 2.1 (Bluetooth) firmware; see README-iPad.md.");
    }, 8000);
  } else if (state === "reconnecting") {
    if (s.autoActive || s.pendingAuto) s.resumeAuto = { prefix: s.autoPrefix, sensitivity: $("sensitivity").value };
    s.ready = false; s.busy = ""; s.autoActive = false; s.pendingTx = null; s.deadline = 0;
    setChip("RECONNECTING", "busy"); mode("Connection lost"); footer("Bluetooth connection lost. Reconnecting…");
  } else {
    if (detail.lost) log("Bluetooth connection lost.");
    s.link = null; s.ready = false; s.busy = ""; s.fw = {}; s.autoActive = false; s.pendingTx = null; s.pendingRecord = null;
    s.pendingAuto = null; s.resumeAuto = null; s.deadline = 0; s.boardSignal = null;
    if (s.finder) closeFinder(false);
    setChip("DISCONNECTED"); mode("Disconnected"); $("rssiValue").textContent = "— dBm"; $("simPress").hidden = true;
    footer(detail.lost ? "Connection lost. Tap Connect to reconnect." : "Disconnected.");
    keepAwake();
  }
  refreshControls();
}
function disconnect() {
  const link = s.link;
  if (!link) return;
  if (s.ready && s.busy) send("cancel");
  setTimeout(() => link.disconnect(), 150);
}
function showNotice(text) { const n = $("notice"); n.textContent = text; n.hidden = !text; }

// ---------- frequency finder (frequency_finder.py) ----------
function openFinder() {
  if (s.finder || !s.ready || !s.fw.frequency_finder || ["loading", "transmitting"].includes(s.busy)) return;
  stop();
  s.busy = "finding"; mode("Finding a frequency");
  s.finder = { phase: "initial", activeId: 0, ids: new Set(), learned: false, refined: null, lockAuto: false, rows: [], selectedRow: 0 };
  $("finderInstructions").textContent = "1. Release the remote button, then tap Learn background.";
  $("finderProgress").textContent = "Waiting to learn the background.";
  $("finderResult").textContent = "No frequency selected";
  $("finderBar").style.width = "0";
  setPeaks([]);
  scopeChanged();
  $("finder").showModal();
  drawSpectrum();
  log("Frequency finder opened; release the remote before learning background.");
  keepAwake(); finderControls(); refreshControls();
}
function closeFinder(cancel = true) {
  if (!s.finder) return;
  if (cancel && s.link && s.ready) send("cancel");
  s.finder = null; s.busy = "";
  if ($("finder").open) $("finder").close();
  mode("Listening"); keepAwake(); refreshControls();
}
function finderRequest(cmd, params = {}) {
  const id = send(cmd, params);
  s.finder.activeId = id; s.finder.ids.add(id);
  return id;
}
function scopeChanged() {
  const scope = SCOPES[$("scope").value];
  $("scopeNote").textContent = scope === "module" ? "Rated range for your Ebyte 433 MHz module."
    : "Experimental outside 387–464 MHz with this module/antenna. A missing signal does not rule out those bands. Transmission stays limited to the rated range.";
  if (s.finder) { s.finder.learned = false; s.finder.refined = null; s.finder.phase = "initial"; finderControls(); }
}
function setPeaks(rows, select = 0) {
  s.finder && (s.finder.rows = rows, s.finder.selectedRow = select);
  $("peakRows").replaceChildren(...rows.map((r, i) => {
    const tr = document.createElement("tr");
    tr.setAttribute("aria-selected", String(i === select));
    for (const text of r.cells) tr.append(Object.assign(document.createElement("td"), { textContent: text }));
    tr.addEventListener("click", () => { s.finder.selectedRow = i; setPeaks(s.finder.rows, i); finderControls(); });
    return tr;
  }));
}
function finderEvent(m) {
  const f = s.finder;
  if (m.id !== f.activeId) return;
  switch (m.event) {
    case "scan_started": $("finderProgress").textContent = `Learning background across ${m.points} frequencies… remote released.`; break;
    case "scan_progress": {
      const fraction = m.index / Math.max(1, m.total);
      const progress = m.phase === "learning" ? Math.min((m.sweep - 1 + fraction) / 3, m.elapsed_ms / 5000) * 100
        : m.phase === "refining" ? (m.sweep - 1 + fraction) / 4 * 100 : fraction * 100;
      $("finderBar").style.width = `${Math.min(99, progress)}%`;
      $("finderProgress").textContent = `${m.phase[0].toUpperCase() + m.phase.slice(1)} · sweep ${m.sweep} · ${m.frequency_mhz.toFixed(3)} MHz`;
      break;
    }
    case "scan_ready":
      f.learned = true; f.phase = "ready"; $("finderBar").style.width = "100%";
      drawSpectrum(m.frequencies_khz, m.rssi_dbm, m.noise_dbm);
      $("finderInstructions").textContent = "2. Now hold or repeatedly press the remote button, then tap Search.";
      $("finderProgress").textContent = `Background learned over ${m.sweeps} sweeps. Ready to search.`;
      log(`Frequency background learned over ${m.sweeps} sweeps. Ready to search.`);
      break;
    case "scan_searching": f.phase = "searching"; break;
    case "scan_paused": f.phase = "ready"; $("finderInstructions").textContent = "Search paused. Resume Search or refine a listed peak."; break;
    case "scan_sweep": {
      drawSpectrum(m.frequencies_khz, m.rssi_dbm, m.noise_dbm);
      const candidates = core.peakCandidates(m.frequencies_khz, m.rssi_dbm, m.noise_dbm, m.margin_db);
      setPeaks(candidates.map(([khz, rssi, rise]) => ({ mhz: khz / 1000, cells: [(khz / 1000).toFixed(3), `+${rise} dB`, `${rssi} dBm`, "Coarse candidate"] })));
      if (!candidates.length) $("finderResult").textContent = "No peak exceeded the learned background by 12 dB. Keep pressing; check the remote battery and scan range.";
      break;
    }
    case "scan_refining":
      f.phase = "refining";
      $("finderInstructions").textContent = "Signal detected. Keep holding / pressing while the narrow sweep refines it.";
      $("finderResult").textContent = `Refining around ${m.center_mhz.toFixed(3)} MHz in ${m.step_khz} kHz steps.`;
      break;
    case "scan_result": case "scan_no_peak":
      $("finderBar").style.width = "100%";
      drawSpectrum(m.frequencies_khz, m.rssi_dbm, [], Math.round(m.frequency_mhz * 1000));
      f.phase = m.event === "scan_result" ? "found" : "ready";
      if (m.event === "scan_result") {
        f.refined = m.frequency_mhz;
        setPeaks([{ mhz: f.refined, cells: [f.refined.toFixed(3), `+${m.rise_db} dB`, `${m.peak_dbm} dBm`, "Refined estimate · 25 kHz grid"] }]);
        $("finderInstructions").textContent = "3. Release and press again to check that the live RSSI responds, then use the frequency.";
        $("finderResult").textContent = `Estimated peak: ${f.refined.toFixed(3)} MHz.${m.module_rated ? "" : " Outside this module's rated band: receive-only."} Raw capture supports ASK/OOK; RSSI alone does not identify the modulation.`;
        log(`Frequency estimate ${f.refined.toFixed(3)} MHz · peak ${m.peak_dbm} dBm · +${m.rise_db} dB over background.`);
      } else {
        f.refined = null;
        $("finderInstructions").textContent = "The signal was not confirmed during refinement. Hold / press throughout the sweep and search again.";
      }
      break;
    case "scan_live":
      $("finderProgress").textContent = `At ${m.frequency_mhz.toFixed(3)} MHz · live RSSI ${m.dbm} dBm · compare button released / pressed`;
      break;
    case "scan_locked": {
      const automatic = f.lockAuto;
      closeFinder(false);
      $("freq").value = m.frequency_mhz.toFixed(3); $("bw").value = String(Math.round(m.bandwidth_khz));
      log(`Locked discovered frequency ${m.frequency_mhz.toFixed(3)} MHz.`);
      footer(`Using ${m.frequency_mhz.toFixed(3)} MHz. Press the remote to record it.`);
      if (automatic) autoCatch();
      return;
    }
    case "error":
      f.phase = f.learned ? "ready" : "initial";
      $("finderInstructions").textContent = m.message || "Scan failed.";
      break;
  }
  finderControls();
}
function finderControls() {
  const f = s.finder;
  if (!f) return;
  const busy = ["learning", "refining", "locking"].includes(f.phase);
  $("learnBtn").disabled = busy;
  $("scope").disabled = busy || f.phase === "searching";
  $("searchBtn").textContent = ["searching", "refining"].includes(f.phase) ? "Pause search" : "2. Search";
  $("searchBtn").disabled = !f.learned || f.phase === "locking";
  $("refineBtn").disabled = !f.learned || !f.rows.length || busy;
  $("useFreqBtn").disabled = $("useAutoBtn").disabled = f.refined === null || busy;
}

// ---------- controls ----------
function refreshControls() {
  const c = selected(), has = !!c;
  const active = s.ready && !s.busy && !s.finder;
  $("connectBtn").textContent = s.link ? "Disconnect" : "Connect";
  $("demoBtn").disabled = !!s.link;
  $("recordBtn").disabled = $("tuneBtn").disabled = !active;
  $("txBtn").disabled = !(active && has && core.validTxFrequency(c.frequency_mhz));
  $("findBtn").disabled = !(s.ready && s.fw.frequency_finder && !["loading", "transmitting"].includes(s.busy));
  const autoOn = s.autoActive || !!s.pendingAuto;
  $("autoBtn").textContent = autoOn ? "Stop Auto" : "Auto Catch";
  $("autoBtn").className = autoOn ? "on" : "";
  $("autoBtn").disabled = !(autoOn || (active && s.fw.auto_capture));
  $("sensitivity").disabled = $("preset").disabled = !active;
  $("stopBtn").disabled = !(s.ready && s.busy);
  $("detailsBtn").disabled = $("renameBtn").disabled = $("exportBtn").disabled = !has;
  $("listenBtn").disabled = !(active && has);
  $("archiveBtn").disabled = !has || !!s.busy;
  $("undoBtn").disabled = !s.archived.length || !!s.busy;
  $("filteredBtn").disabled = !s.lastFiltered;
  $("useFrame").disabled = !(has && c.frame_pulses) || !!s.busy;
  $("waveToggle").disabled = !(has && c.frame_pulses);
  $("exportAllBtn").disabled = !s.captures.length;
}

function populateSelect(id, values, value) {
  $(id).replaceChildren(...values.map((v) => Object.assign(document.createElement("option"), { value: String(v), textContent: String(v) })));
  if (value !== undefined) $(id).value = String(value);
}

function bind() {
  populateSelect("repeats", core.REPEAT_CHOICES, 5);
  populateSelect("power", core.POWERS, 0);
  populateSelect("profile", Object.keys(core.PROFILES), prefs.profile in core.PROFILES ? prefs.profile : "Balanced");
  populateSelect("scope", Object.keys(SCOPES));
  for (const name of Object.keys(core.PRESETS)) $("preset").append(Object.assign(document.createElement("option"), { value: name, textContent: name }));
  if (["Group matching signals", "Save every capture"].includes(prefs.policy)) $("policy").value = prefs.policy;
  if (prefs.sensitivity in core.SENSITIVITY) $("sensitivity").value = prefs.sensitivity;
  if (core.validFrequency(Number(prefs.frequency))) $("freq").value = Number(prefs.frequency).toFixed(3);
  for (const [id, key] of [["profile", "profile"], ["policy", "policy"], ["sensitivity", "sensitivity"]])
    $(id).addEventListener("change", () => { prefs[key] = $(id).value; savePreferences(); });

  $("connectBtn").addEventListener("click", () => (s.link ? disconnect() : connect(false)));
  $("demoBtn").addEventListener("click", () => connect(true));
  $("simPress").addEventListener("click", () => s.link?.press?.());
  $("tuneBtn").addEventListener("click", tune);
  $("recordBtn").addEventListener("click", record);
  $("autoBtn").addEventListener("click", autoCatch);
  $("stopBtn").addEventListener("click", () => (s.finder ? closeFinder() : stop()));
  $("txBtn").addEventListener("click", transmit);
  $("findBtn").addEventListener("click", openFinder);
  $("preset").addEventListener("change", () => {
    const mhz = core.PRESETS[$("preset").value];
    if (mhz && !s.busy) { $("freq").value = mhz.toFixed(3); tune(); }
    $("preset").value = "";
  });
  for (const id of ["repeats", "gap", "power"]) $(id).addEventListener("input", updateTxPreview);
  $("useFrame").addEventListener("change", () => {
    const c = selected();
    if (c) {
      const clean = $("useFrame").checked && c.frame_pulses;
      $("gap").value = clean && c.gap_us ? (c.gap_us / 1000).toFixed(3) : "20";
      $("repeats").value = clean ? "5" : "1";
    }
    updateTxPreview();
  });
  $("zoomIn").addEventListener("click", () => wave.zoom(1.6));
  $("zoomOut").addEventListener("click", () => wave.zoom(1 / 1.6));
  $("fitBtn").addEventListener("click", () => wave.fit());
  $("waveToggle").addEventListener("click", () => { s.fullBurst = !s.fullBurst; updateWave(); });
  $("logToggle").addEventListener("click", () => { $("logPanel").hidden = !$("logPanel").hidden; $("logPanel").scrollTop = 1e9; });
  $("search").addEventListener("input", renderLibrary);
  $("captureList").addEventListener("click", (e) => { const li = e.target.closest("li[data-id]"); if (li) selectCapture(li.dataset.id); });
  $("captureList").addEventListener("dblclick", (e) => { if (e.target.closest("li[data-id]")) openDetails(); });

  $("renameBtn").addEventListener("click", async () => {
    const c = selected();
    if (!c) return;
    const name = await ask("Rename signal", c.name);
    if (name === null) return;
    if (!name.trim() || name.trim().length > 80) { footer("Use a name of 1–80 characters."); return; }
    await storeCapture({ ...c, name: name.trim() });
  });
  $("listenBtn").addEventListener("click", () => {
    const c = selected();
    if (!c || s.busy) return;
    $("freq").value = c.frequency_mhz.toFixed(3);
    const bw = c.rx_settings?.bandwidth_khz;
    $("bw").value = core.BANDWIDTHS.includes(bw) ? String(bw) : "325";
    tune();
  });
  $("archiveBtn").addEventListener("click", async () => {
    const c = selected();
    if (!c || s.busy) return;
    await library.save(c, true);
    s.archived.push(c.id);
    log(`Archived ${c.name}. Undo archive restores it.`);
    s.selectedId = null;
    await reloadLibrary();
  });
  $("undoBtn").addEventListener("click", async () => {
    const id = s.archived.pop();
    const c = (s.archivedCaptures || []).find((x) => x.id === id);
    if (c) { await library.save(c, false); $("search").value = ""; await reloadLibrary(id); }
    refreshControls();
  });
  $("exportBtn").addEventListener("click", () => {
    const c = selected();
    if (c) saveFile(`${safeName(c.name)}.json`, JSON.stringify(core.captureToFile(c), null, 2) + "\n").then(() => log(`Exported ${c.name}.`));
  });
  $("exportAllBtn").addEventListener("click", () => {
    const day = new Date().toISOString().slice(0, 10);
    saveFile(`rf-workbench-library-${day}.json`, JSON.stringify(core.libraryBundle(s.captures), null, 1) + "\n").then(() => log(`Exported ${s.captures.length} signals.`));
  });
  $("importBtn").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", async () => {
    let count = 0, lastId = null;
    for (const file of $("importFile").files) {
      try {
        if (file.size > 20_000_000) throw new Error("File is too large.");
        for (const c of core.capturesFromText(await file.text())) {
          const copy = { ...c, id: core.newId() };  // imports never overwrite existing signals
          await library.save(copy); count++; lastId = copy.id;
        }
      } catch (error) { log(`Import ${file.name}: ${error.message}`); footer(`Import ${file.name}: ${error.message}`); }
    }
    $("importFile").value = "";
    if (count) { log(`Imported ${count} signal${count === 1 ? "" : "s"}.`); $("search").value = ""; await reloadLibrary(lastId); }
  });
  $("filteredBtn").addEventListener("click", async () => {
    if (!s.lastFiltered) return;
    await storeCapture(s.lastFiltered);
    log("Saved the last filtered burst for manual inspection.");
    s.lastFiltered = null; refreshControls();
  });

  $("detailsBtn").addEventListener("click", openDetails);
  $("detailsClose").addEventListener("click", () => $("details").close());
  $("saveNotes").addEventListener("click", async () => {
    const c = selected(), notes = $("notes").value;
    if (!c) return;
    if (notes.length > 4000) { footer("Use at most 4,000 characters."); return; }
    await storeCapture({ ...c, notes });
    $("details").close();
  });
  $("csvBtn").addEventListener("click", () => {
    const c = selected();
    if (!c) return;
    let start = 0;
    const rows = ["interval,start_us,level,duration_us,signed_us"];
    c.pulses.forEach((p, i) => { rows.push(`${i + 1},${start},${p > 0 ? 1 : 0},${Math.abs(p)},${p}`); start += Math.abs(p); });
    saveFile(`${safeName(c.name)}.csv`, rows.join("\n") + "\n", "text/csv");
  });
  $("copyJson").addEventListener("click", async () => {
    const c = selected();
    if (!c) return;
    try { await navigator.clipboard.writeText(JSON.stringify(core.captureToFile(c), null, 2)); footer("Signal JSON copied."); }
    catch { footer("Copy is not available in this browser; use Export."); }
  });

  $("infoBtn").addEventListener("click", () => {
    const f = s.fw, rows = [["Link", s.link ? (s.demo ? "Demo board (simulated)" : `Bluetooth · ${s.link.name}`) : "Not connected"],
      ["Firmware", f.version ?? "—"], ["Chip", f.part !== undefined ? `CC1101 part ${f.part} / revision ${f.chip_version}` : "—"],
      ["Bluetooth MTU", f.mtu ?? "—"], ["Pairing required", f.ble_pairing === undefined ? "—" : f.ble_pairing ? "yes" : "no"],
      ["Board free memory", f.free_heap ? `${Math.round(f.free_heap / 1024)} KB (lowest ${Math.round((f.min_free_heap || 0) / 1024)} KB)` : "—"],
      ["Screen wake lock", navigator.wakeLock ? "supported" : "not supported here: keep the iPad awake manually"],
      ["Library storage", library.db ? "this browser (IndexedDB)" : "memory only — export before closing"]];
    $("deviceInfo").replaceChildren(...rows.flatMap(([k, v]) => [Object.assign(document.createElement("dt"), { textContent: k }), Object.assign(document.createElement("dd"), { textContent: String(v) })]));
    $("info").showModal();
  });
  $("infoClose").addEventListener("click", () => $("info").close());

  $("finderClose").addEventListener("click", () => closeFinder());
  $("finder").addEventListener("cancel", (e) => { e.preventDefault(); closeFinder(); });
  $("scope").addEventListener("change", scopeChanged);
  $("learnBtn").addEventListener("click", () => {
    const f = s.finder;
    f.learned = false; f.refined = null; f.phase = "learning";
    $("finderBar").style.width = "0";
    $("finderInstructions").textContent = "Keep the remote RELEASED while the background is learned.";
    $("finderProgress").textContent = "Learning at least 3 sweeps and 5 seconds; wider ranges take longer.";
    $("finderResult").textContent = "Background learning in progress.";
    log(`Learning frequency background: ${$("scope").value}.`);
    drawSpectrum(); setPeaks([]);
    finderRequest("scan_start", { scope: SCOPES[$("scope").value], margin_db: 12 });
    finderControls();
  });
  $("searchBtn").addEventListener("click", () => {
    const f = s.finder;
    if (["searching", "refining"].includes(f.phase)) { finderRequest("scan_pause"); f.phase = "ready"; }
    else {
      f.phase = "searching"; f.refined = null;
      $("finderInstructions").textContent = "Hold the remote 20–50 cm away, or press it repeatedly. Keep going during refinement.";
      finderRequest("scan_search");
    }
    finderControls();
  });
  $("refineBtn").addEventListener("click", () => {
    const row = s.finder.rows[s.finder.selectedRow];
    if (row) { s.finder.phase = "refining"; finderRequest("scan_refine", { frequency_mhz: row.mhz }); finderControls(); }
  });
  const useFrequency = (automatic) => {
    const f = s.finder;
    if (f.refined === null) return;
    f.lockAuto = automatic; f.phase = "locking";
    finderRequest("scan_lock", { frequency_mhz: f.refined }); finderControls();
  };
  $("useFreqBtn").addEventListener("click", () => useFrequency(false));
  $("useAutoBtn").addEventListener("click", () => useFrequency(true));

  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !document.querySelector("dialog[open]")) stop(); });
  window.addEventListener("resize", () => { wave.draw(); drawRssi(); });
  setInterval(() => {
    if (s.deadline && Date.now() > s.deadline) {
      stop(); footer("Device response timed out. Operation stopped; reconnect if needed."); log("Operation timed out; cancelled pending work.");
    }
  }, 250);
}
function openDetails() {
  const c = selected();
  if (!c) return;
  $("detailsTitle").textContent = `Signal details · ${c.name}`;
  $("report").textContent = core.captureReport(c);
  $("notes").value = c.notes;
  $("details").showModal();
}

async function start() {
  bind();
  if (!(await library.open())) showNotice("This browser blocks storage here, so signals last only for this visit. Use Export all to keep them.");
  else if (!BleLink.supported()) showNotice("No Web Bluetooth in this browser. On iPad, open this page in the free Bluefy browser; on a PC, use Chrome or Edge. Tap Demo to try the app without hardware.");
  await reloadLibrary();
  drawRssi(); refreshControls();
  if (new URLSearchParams(location.search).has("demo")) connect(true);
}
start();
window.rfWorkbench = { state: s, handleEvent };  // for debugging from the console
