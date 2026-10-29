// Pure logic shared by the iPad app and the Node tests: signal validation,
// the compact wire format, CRC32, and the Auto Catch detector. Ported from
// desktop_app/signals.py, detector.py, precision.py and frequency_finder.py;
// tests/web checks it against the Python originals.

export const TX_BAND = [387, 464];
export const RX_BANDS = [[300, 348], [387, 464], [779, 928]];
export const MAX_PULSES = 4000;
export const MAX_DURATION_US = 3_000_000;
export const BANDWIDTHS = [203, 325, 650];
export const POWERS = [-20, -15, -10, 0, 5, 7, 10];
export const PRESETS = {
  "307 MHz": 307.0, "315 MHz": 315.0, "318 MHz": 318.0, "390 MHz": 390.0,
  "418 MHz": 418.0, "433.92 MHz": 433.92, "868.46 MHz": 868.46, "915 MHz": 915.0,
};
export const PROFILES = {
  "Balanced": [1500, 80, 60], "Short press": [700, 60, 40],
  "Long / slow remote": [2800, 150, 60], "Fast pulses": [1000, 40, 10],
};
export const SENSITIVITY = { "Sensitive": 8, "Balanced": 12, "Strong only": 18 };

export function receiveOptions(profile) {
  const [duration, quiet, glitch] = PROFILES[profile] || PROFILES.Balanced;
  return { duration_ms: duration, quiet_ms: quiet, glitch_us: glitch };
}

// ---------- Python-compatible arithmetic ----------

// Python's round(): exact halves go to the even neighbour.
export function pyRound(x) {
  const floor = Math.floor(x), fraction = x - floor;
  if (fraction > 0.5) return floor + 1;
  if (fraction < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  if (!n) throw new Error("median of no values");
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}
export function mean(values) {
  let sum = 0, compensation = 0;  // Neumaier sum, close to statistics.mean's exact one
  for (const v of values) {
    const t = sum + v;
    compensation += Math.abs(sum) >= Math.abs(v) ? (sum - t) + v : (v - t) + sum;
    sum = t;
  }
  return (sum + compensation) / values.length;
}

// ---------- validation (signals.py) ----------

export function validFrequency(value) {
  return typeof value === "number" && Number.isFinite(value) && RX_BANDS.some(([lo, hi]) => lo <= value && value <= hi);
}
export function validateFrequency(value) {
  if (typeof value !== "number") throw new Error("Frequency must be a number.");
  if (!validFrequency(value)) throw new Error("Receive frequency must be 300–348, 387–464 or 779–928 MHz.");
  return value;
}
export function validTxFrequency(value) { return validFrequency(value) && TX_BAND[0] <= value && value <= TX_BAND[1]; }
export function validateTxFrequency(value) {
  validateFrequency(value);
  if (!validTxFrequency(value)) throw new Error("This Ebyte module is rated for 387–464 MHz. Other bands are receive-only in this app.");
  return value;
}
export function validatePulses(values) {
  if (!Array.isArray(values) || values.length < 8 || values.length > MAX_PULSES)
    throw new Error("A signal needs between 8 and 4,000 timing intervals.");
  let previous = 0, total = 0;
  for (const value of values) {
    if (!Number.isInteger(value) || Math.abs(value) < 10 || Math.abs(value) > 1_000_000)
      throw new Error("Durations must be signed whole microseconds, 10–1,000,000 each.");
    if (previous && (previous > 0) === (value > 0))
      throw new Error("Signal levels must alternate between positive and negative durations.");
    previous = value; total += Math.abs(value);
  }
  if (values[0] < 0) throw new Error("A signal must start with a positive (carrier ON) duration.");
  if (total > MAX_DURATION_US) throw new Error("A signal may last at most 3 seconds.");
  return [...values];
}
export const durationUs = (pulses) => pulses.reduce((sum, p) => sum + Math.abs(p), 0);
export const replayDuration = (pulses, repeats, gapUs) => (durationUs(pulses) + gapUs) * repeats;

// ---------- longer replays without new firmware ----------

export const REPEAT_CHOICES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 30, 40, 50, 75, 100, 150, 200];
const BOARD_MAX_REPEATS = 10, BOARD_MAX_TX_US = 10_000_000;

// The board replays one uploaded signal at most 10 times and 10 s in total.
// More repeats are packed into the upload itself: `copies` frames joined by
// their gap, replayed `repeats` times, is the same waveform as copies*repeats
// frames. Returns { pulses, repeats, frames, copies, totalUs } for the board.
export function planReplay(values, frames, gapUs) {
  const frameUs = durationUs(values);
  if ((frameUs + gapUs) * frames > BOARD_MAX_TX_US)
    throw new Error(`${frames} repeats would last ${((frameUs + gapUs) * frames / 1e6).toFixed(1)} s; the board allows 10 s.`);
  if (frames <= BOARD_MAX_REPEATS) return { pulses: values, repeats: frames, frames, copies: 1, totalUs: (frameUs + gapUs) * frames };
  const perUpload = Math.min(Math.floor((MAX_PULSES + 1) / (values.length + 1)),
                             Math.floor((MAX_DURATION_US + gapUs) / (frameUs + gapUs)));
  // The most replays that divide the count exactly keeps the upload smallest (fastest over Bluetooth).
  let repeats = 0;
  for (let r = BOARD_MAX_REPEATS; r >= 1 && !repeats; r--) if (frames % r === 0 && frames / r <= perUpload) repeats = r;
  if (!repeats) repeats = Math.ceil(frames / Math.max(1, perUpload));
  const copies = Math.ceil(frames / repeats);
  if (repeats > BOARD_MAX_REPEATS || copies > perUpload) throw new Error("This signal is too long to repeat that many times.");
  const block = [];
  const add = (v) => {  // a frame ending OFF simply lengthens the following gap
    if (block.length && (block[block.length - 1] > 0) === (v > 0)) block[block.length - 1] += v;
    else block.push(v);
  };
  for (let i = 0; i < copies; i++) {
    if (i) add(-gapUs);
    for (const p of values) add(p);
  }
  validatePulses(block);
  const totalUs = (durationUs(block) + gapUs) * repeats;
  if (totalUs > BOARD_MAX_TX_US) throw new Error("That many repeats would pass the board's 10 s limit.");
  return { pulses: block, repeats, frames: copies * repeats, copies, totalUs };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export const nowIso = () => new Date().toISOString().slice(0, 19) + "+00:00";  // Python isoformat(timespec="seconds")

const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
// Validates and normalises a capture; mirrors Capture.__post_init__.
export function makeCapture(fields) {
  const c = {
    name: fields.name, frequency_mhz: fields.frequency_mhz, pulses: fields.pulses,
    id: fields.id ?? newId(), created_at: fields.created_at ?? nowIso(),
    peak_dbm: fields.peak_dbm ?? null, truncated: fields.truncated ?? false,
    frame_pulses: fields.frame_pulses ?? null, gap_us: fields.gap_us ?? null,
    seen_count: fields.seen_count ?? 1, last_seen_at: fields.last_seen_at ?? null,
    quality: fields.quality ?? null, frame_repeats: fields.frame_repeats ?? 0,
    notes: fields.notes ?? "", rx_settings: fields.rx_settings ?? {},
  };
  if (typeof c.name !== "string" || !c.name.trim() || c.name.length > 80) throw new Error("Choose a signal name of 1–80 characters.");
  if (typeof c.notes !== "string" || c.notes.length > 4000) throw new Error("Notes must be at most 4,000 characters.");
  if (typeof c.rx_settings !== "object" || Array.isArray(c.rx_settings) || Object.keys(c.rx_settings).length > 20)
    throw new Error("Invalid receive metadata.");
  for (const [k, v] of Object.entries(c.rx_settings)) {
    const ok = k.length <= 40 && (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.length <= 120));
    if (!ok) throw new Error("Invalid receive metadata values.");
  }
  c.name = c.name.trim();
  if (typeof c.id !== "string" || !UUID.test(c.id)) throw new Error("Invalid signal identifier.");
  c.id = c.id.toLowerCase();
  if (typeof c.created_at !== "string" || c.created_at.length > 64) throw new Error("Invalid capture date.");
  validateFrequency(c.frequency_mhz);
  c.pulses = validatePulses(c.pulses);
  if (c.peak_dbm !== null && !intIn(c.peak_dbm, -150, 20)) throw new Error("Invalid signal strength.");
  if (typeof c.truncated !== "boolean") throw new Error("Invalid truncation flag.");
  if (c.frame_pulses !== null) c.frame_pulses = validatePulses(c.frame_pulses);
  if (c.gap_us !== null && !intIn(c.gap_us, 5000, 1_000_000)) throw new Error("Invalid frame gap.");
  if (!intIn(c.seen_count, 1, 1_000_000_000)) throw new Error("Invalid observation count.");
  if (c.last_seen_at !== null && (typeof c.last_seen_at !== "string" || c.last_seen_at.length > 64)) throw new Error("Invalid last-seen date.");
  if (c.quality !== null && !intIn(c.quality, 0, 100)) throw new Error("Invalid timing quality.");
  if (!intIn(c.frame_repeats, 0, MAX_PULSES)) throw new Error("Invalid frame count.");
  return c;
}
// The desktop app's file format, so signals move freely between PC and iPad.
export function captureToFile(c) {
  return {
    format: "rf-workbench", version: 1, id: c.id, name: c.name, created_at: c.created_at,
    frequency_mhz: c.frequency_mhz, modulation: "OOK", pulses: c.pulses, peak_dbm: c.peak_dbm,
    truncated: c.truncated, frame_pulses: c.frame_pulses, gap_us: c.gap_us, seen_count: c.seen_count,
    last_seen_at: c.last_seen_at, quality: c.quality, frame_repeats: c.frame_repeats, notes: c.notes,
    rx_settings: c.rx_settings,
  };
}
export function captureFromFile(data) {
  if (!data || typeof data !== "object" || data.format !== "rf-workbench" || data.version !== 1)
    throw new Error("This is not a supported RF Workbench signal file.");
  if (data.modulation !== "OOK") throw new Error("This version supports ASK/OOK signals.");
  for (const key of ["name", "frequency_mhz", "pulses", "id", "created_at"])
    if (!(key in data)) throw new Error("Signal file has missing or invalid fields.");
  return makeCapture(data);
}
// Accepts one signal file, an array of them, or an exported library bundle.
export function capturesFromText(text) {
  const data = JSON.parse(text.replace(/^﻿/, ""));
  const list = Array.isArray(data) ? data : data?.format === "rf-workbench-library" ? data.captures : [data];
  if (!Array.isArray(list) || !list.length) throw new Error("No signals found in that file.");
  return list.map(captureFromFile);
}
export function libraryBundle(captures) {
  return { format: "rf-workbench-library", version: 1, exported_at: nowIso(), captures: captures.map(captureToFile) };
}

// ---------- CRC32 (zlib) over little-endian int32 pulses, as precision.py ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
export function pulseCrc(pulses) {
  let crc = 0xffffffff;
  for (const p of pulses) {
    for (let b = 0; b < 4; b++) crc = CRC_TABLE[(crc ^ (p >>> (8 * b))) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------- compact arrays (CC1101_Workbench/compact_codec.h) ----------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) B64_INDEX[B64.charCodeAt(i)] = i;

// Zigzag LEB128 varints, base64-encoded.
export function encodeCompact(values) {
  const bytes = [];
  for (const v of values) {
    let zz = ((v << 1) ^ (v >> 31)) >>> 0;
    while (zz >= 0x80) { bytes.push((zz & 0x7f) | 0x80); zz >>>= 7; }
    bytes.push(zz);
  }
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? B64[n & 63] : "=";
  }
  return out;
}
export function decodeCompact(text) {
  const out = [];
  let acc = 0, bits = 0, value = 0, shift = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 61) break;  // '='
    const six = code < 128 ? B64_INDEX[code] : -1;
    if (six < 0) throw new Error("Malformed compact array.");
    acc = ((acc << 6) | six) & 0xffff; bits += 6;
    if (bits < 8) continue;
    bits -= 8;
    const b = (acc >> bits) & 0xff;
    if (shift > 21) throw new Error("Malformed compact array.");
    value = (value | ((b & 0x7f) << shift)) >>> 0; shift += 7;
    if (b & 0x80) continue;
    out.push((value >>> 1) ^ -(value & 1));
    value = 0; shift = 0;
  }
  if (shift) throw new Error("Malformed compact array.");
  return out;
}

// ---------- detector (detector.py) ----------

function analysis(accepted, reason, quality, pattern = [], unit = 0, framePulses = [], gapUs = null, frameRepeats = 0) {
  return { accepted, reason, quality, pattern, patternKey: pattern.join(","), unit_us: unit,
           frame_pulses: framePulses, gap_us: gapUs, frame_repeats: frameRepeats };
}

export function timingPattern(pulses) {
  const durations = pulses.map(Math.abs).sort((a, b) => a - b);
  if (!durations.length) return { tokens: [], unit: 0, fit: 0 };
  const unit = median(durations.slice(0, Math.max(1, Math.floor((durations.length + 1) / 2))));
  if (unit < 60) return { tokens: [], unit, fit: 0 };
  const tokens = [];
  let fitted = 0;
  for (const pulse of pulses) {
    const multiple = Math.max(1, pyRound(Math.abs(pulse) / unit));
    const error = Math.abs(Math.abs(pulse) - multiple * unit) / unit;
    if (error <= 0.24 && multiple <= 64) fitted++;
    tokens.push(pulse > 0 ? multiple : -multiple);
  }
  return { tokens, unit, fit: fitted / pulses.length };
}

export function analyze(pulses, peakDbm = null, noiseDbm = null) {
  validatePulses(pulses);
  if (pulses.length < 12) return analysis(false, "Burst is too short to classify reliably.", 0);
  const snr = peakDbm != null && noiseDbm != null ? peakDbm - noiseDbm : null;
  if (snr !== null && snr < 6) return analysis(false, "Signal is too close to the background level.", 0);
  const ordered = pulses.map(Math.abs).sort((a, b) => a - b);
  const short = ordered[Math.floor(ordered.length / 4)];
  const gapThreshold = Math.max(4000, short * 6);
  const frames = [], gaps = [];
  let beginning = 0;
  pulses.forEach((pulse, index) => {
    if (pulse < -gapThreshold) { frames.push(pulses.slice(beginning, index)); gaps.push(-pulse); beginning = index + 1; }
  });
  frames.push(pulses.slice(beginning));

  // First/last chunks may be clipped by the trigger and duration limit.
  const complete = frames.map((frame, index) => [index, frame]).filter(([index]) => 0 < index && index < frames.length - 1);
  const groups = new Map();
  for (const [index, frame] of complete) {
    if (frame.length < 12 || frame[0] <= 0 || frame[frame.length - 1] <= 0) continue;
    const { tokens, unit, fit } = timingPattern(frame);
    if (fit >= 0.88) {
      const key = tokens.join(",");
      if (!groups.has(key)) groups.set(key, { pattern: tokens, items: [] });
      groups.get(key).items.push({ index, frame, unit, fit });
    }
  }
  if (groups.size) {
    let best = null;
    for (const group of groups.values()) if (!best || group.items.length > best.items.length) best = group;
    const matching = best.items;
    // Require an actual repeat and a dominant pattern, so mixed commands or
    // changing payloads are not condensed into one alleged "clean" frame.
    if (matching.length >= 2 && matching.length >= 0.65 * complete.length) {
      const representative = best.pattern.map((_, i) => pyRound(median(matching.map((m) => m.frame[i]))));
      const gap = pyRound(median(matching.map((m) => gaps[m.index])));
      if (gap >= 5000 && gap <= 1_000_000) {
        const fit = mean(matching.map((m) => m.fit));
        const score = Math.min(100, pyRound(65 * fit + Math.min(20, matching.length * 5) + (snr === null ? 15 : Math.min(15, snr))));
        return analysis(true, "Consistent repeating frames.", score, best.pattern,
                        median(matching.map((m) => m.unit)), representative, gap, matching.length);
      }
    }
  }

  // A quick press may contain just one or two complete-looking frames. It can
  // match a previously known waveform without claiming enough evidence to
  // shorten a new recording. Do not collapse visibly mixed payloads.
  if (frames.length > 1 && frames.length <= 3) {
    const structured = [];
    for (const frame of frames) {
      if (frame.length < 20) continue;
      const t = timingPattern(frame);
      if (t.fit >= 0.92) structured.push({ frame, ...t });
    }
    if (structured.length) {
      const longest = Math.max(...structured.map((s) => s.frame.length));
      const choices = structured.filter((s) => s.frame.length === longest);
      if (new Set(choices.map((c) => c.tokens.join(","))).size === 1 && (snr === null || snr >= 8)) {
        let gap = gaps.length ? pyRound(median(gaps)) : null;
        if (gap !== null && !(gap >= 5000 && gap <= 1_000_000)) gap = null;
        const fit = mean(choices.map((c) => c.fit));
        const score = Math.min(79, pyRound(65 * fit + (snr === null ? 14 : Math.min(14, snr))));
        return analysis(true, "Short structured burst; repeat frame not confirmed.", score, choices[0].tokens,
                        median(choices.map((c) => c.unit)), [], gap);
      }
    }
  }

  const { tokens, unit, fit } = timingPattern(pulses);
  const score = Math.min(79, pyRound(65 * fit + (snr === null ? 14 : Math.min(14, snr))));
  const accepted = pulses.length >= 20 && fit >= 0.92 && (snr === null || snr >= 8);
  return analysis(accepted, accepted ? "Structured burst; no repeated frame confirmed." : "Irregular timing; filtered as possible noise.",
                  score, tokens, unit);
}

export function sameSignal(left, leftMhz, right, rightMhz) {
  return left.accepted && right.accepted && Math.abs(leftMhz - rightMhz) <= 0.025
    && left.patternKey === right.patternKey && left.pattern.length > 0
    && (left.gap_us === null || right.gap_us === null
        || Math.abs(left.gap_us - right.gap_us) <= Math.max(left.gap_us, right.gap_us) * 0.20)
    && Math.abs(left.unit_us - right.unit_us) <= Math.max(left.unit_us, right.unit_us) * 0.12;
}

// Keeps original timings intact and attaches optional replay metadata.
export function annotate(capture, a) {
  return { ...capture, frame_pulses: a.frame_pulses.length ? [...a.frame_pulses] : null,
           gap_us: a.gap_us, quality: a.quality, frame_repeats: a.frame_repeats };
}

export class SmartDetector {
  constructor() { this.cache = new Map(); }
  analysisFor(capture) {
    if (!this.cache.has(capture.id)) this.cache.set(capture.id, analyze(capture.pulses, capture.peak_dbm));
    return this.cache.get(capture.id);
  }
  // Returns { capture: null when filtered, repeated, analysis }.
  observe(candidate, existing, noiseDbm, now = nowIso()) {
    const a = analyze(candidate.pulses, candidate.peak_dbm, noiseDbm);
    if (!a.accepted) return { capture: null, repeated: false, analysis: a };
    for (const saved of existing) {
      if (sameSignal(a, candidate.frequency_mhz, this.analysisFor(saved), saved.frequency_mhz)) {
        // Preserve the user's name, original raw recording, and ID.
        const better = a.quality >= (saved.quality || 0) ? annotate(saved, a) : saved;
        return { capture: { ...better, seen_count: Math.min(saved.seen_count + 1, 1_000_000_000), last_seen_at: now },
                 repeated: true, analysis: a };
      }
    }
    const result = { ...annotate(candidate, a), last_seen_at: now };
    this.cache.set(result.id, a);
    return { capture: result, repeated: false, analysis: a };
  }
}

// ---------- frequency finder (frequency_finder.py) ----------

export function peakCandidates(frequencies, signal, background, margin = 12, limit = 6) {
  if (frequencies.length !== signal.length || signal.length !== background.length) throw new Error("Spectrum arrays have different lengths.");
  const ranked = [];
  frequencies.forEach((khz, i) => {
    const rssi = signal[i], noise = background[i];
    if (!Number.isInteger(khz) || typeof rssi !== "number" || typeof noise !== "number") throw new Error("Invalid spectrum sample.");
    validateFrequency(khz / 1000);
    if (rssi > -190 && noise > -190 && rssi - noise >= margin) ranked.push([khz, Math.trunc(rssi), Math.trunc(rssi - noise)]);
  });
  ranked.sort((a, b) => b[2] - a[2] || b[1] - a[1]);
  const result = [];
  for (const point of ranked) {
    if (result.every((chosen) => Math.abs(point[0] - chosen[0]) >= 800)) {
      result.push(point);
      if (result.length === limit) break;
    }
  }
  return result;
}

// ---------- details text (precision.py capture_report) ----------

export function captureReport(c) {
  const v = (x, fallback) => (x === null || x === undefined || x === 0 || x === "" ? fallback : x);
  const lines = [c.name, `Frequency: ${c.frequency_mhz.toFixed(3)} MHz (receiver tuning)`,
    `Raw: ${c.pulses.length} intervals / ${(durationUs(c.pulses) / 1000).toFixed(3)} ms`,
    `Seen: ${c.seen_count} | Last: ${v(c.last_seen_at, c.created_at)}`,
    `Peak: ${c.peak_dbm ?? "unknown"} dBm`,
    `Timing consistency: ${c.quality ?? "unknown"}/100`,
    `Repeated frames: ${c.frame_repeats}`,
    `Measured frame gap: ${v(c.gap_us, "unknown")} us`,
    `Raw waveform CRC32: ${pulseCrc(c.pulses).toString(16).toUpperCase().padStart(8, "0")}`];
  const info = c.rx_settings || {};
  if (Object.keys(info).length) {
    lines.push("Reception: " + Object.entries(info).map(([k, x]) => `${k}=${typeof x === "boolean" ? (x ? "True" : "False") : x}`).join(", "));
  }
  if (c.truncated) lines.push("BUFFER LIMIT: the recording may be incomplete.");
  if (!c.frame_pulses) lines.push("No stable repeated frame confirmed; inspect the full burst.");
  lines.push("Timing consistency does not prove a decoded command or successful replay.");
  return lines.join("\n");
}
