// Demo mode: an in-page board that speaks the firmware protocol, including the
// compact arrays, so the app (and its tests) run without hardware. Its lines go
// through the same parser as Bluetooth.
import { encodeCompact, pulseCrc, validatePulses, validFrequency, validTxFrequency, durationUs, BANDWIDTHS, POWERS } from "./core.js";
import { parseLine } from "./link.js";

const REMOTES = [  // fixed-code remotes, 12 address bits each (UM3750-style)
  { code: "101100110101", unit: 330, mhz: 433.92 },
  { code: "010011010110", unit: 372, mhz: 433.92 },
];
const random = (lo, hi) => lo + Math.random() * (hi - lo);

// 13 symbols per frame = 25 intervals, frames separated by ~25.8 ms OFF.
function remoteBurst({ code, unit }, frames) {
  const pulses = [];
  const symbols = [[1, 2], ...[...code].map((bit) => (bit === "1" ? [2, 1] : [1, 2]))];
  for (let f = 0; f < frames; f++) {
    symbols.forEach(([high, low], s) => {
      pulses.push(Math.round(high * unit + random(-12, 12)));
      const last = s === symbols.length - 1;
      if (!(last && f === frames - 1)) pulses.push(-Math.round(low * unit + (last ? 25800 : 0) + random(-12, 12)));
    });
  }
  return pulses;
}
function noiseBurst() {
  const pulses = [];
  for (let i = 0; i < 61; i++) pulses.push((i % 2 ? -1 : 1) * Math.round(random(70, 2600)));
  return pulses;
}

export class SimLink {
  constructor({ onEvent, onState }) {
    this.onEvent = onEvent; this.onState = onState;
    this.board = new SimBoard((message) => this.deliver(message));
  }
  static supported() { return true; }
  get name() { return "Demo board"; }
  async connect() { await new Promise((r) => setTimeout(r, 250)); this.onState("connected"); }
  setMtu() {}
  send(message) {
    const copy = JSON.parse(JSON.stringify(message));
    setTimeout(() => this.board.receive(copy), 15);
    return Promise.resolve();
  }
  deliver(message) { this.onEvent(parseLine(JSON.stringify(message))); }
  press() { this.board.press(); }
  disconnect() { this.board.stop(); this.onState("disconnected"); }
}

class SimBoard {
  constructor(emit) {
    this.emit = emit; this.mhz = 433.92; this.bw = 650; this.mode = "idle"; this.auto = false;
    this.noise = -88; this.trigger = -70; this.margin = 12; this.loaded = null; this.pressUntil = 0;
    this.timers = new Set(); this.compact = false; this.requestId = 0;
    this.rssiTimer = setInterval(() => this.publishRssi(), 200);
  }
  later(ms, work) { const t = setTimeout(() => { this.timers.delete(t); work(); }, ms); this.timers.add(t); return t; }
  clearTimers() { for (const t of this.timers) clearTimeout(t); this.timers.clear(); clearInterval(this.scanTimer); this.scanTimer = null; }
  stop() { this.clearTimers(); clearInterval(this.rssiTimer); }
  rssi() { return Date.now() < this.pressUntil ? Math.round(random(-38, -32)) : Math.round(this.noise + random(-3, 3)); }
  arrays(fields) {  // what the firmware does for a link that asked for compact arrays
    const out = {};
    for (const [k, v] of Object.entries(fields)) out[k] = this.compact ? encodeCompact(v) : v;
    return out;
  }
  status(id, event = "status") {
    return {
      event, id, firmware: "RFWorkbench", protocol: 1, version: "2.1.0-demo", frequency_finder: true,
      precision_replay: true, capture_profiles: true, free_heap: 154000, min_free_heap: 131000, ble: true,
      ble_pairing: true, link: "ble", compact: this.compact, mtu: 185, loaded_count: this.loaded?.pulses.length ?? 0,
      ...(this.loaded ? { loaded_crc32: pulseCrc(this.loaded.pulses), loaded_mhz: this.loaded.mhz } : {}),
      auto_capture: true, auto_enabled: this.auto, noise_dbm: this.noise, trigger_dbm: this.trigger, radio: true,
      mode: this.mode === "idle" ? "idle" : this.mode, frequency_mhz: this.mhz, bandwidth_khz: this.bw, modulation: "OOK",
      rssi_dbm: this.rssi(), marcstate: 13, part: 0, chip_version: 20, max_pulses: 4000,
    };
  }
  error(id, message, code) { this.emit({ event: "error", id, message, ...(code ? { code } : {}) }); }
  publishRssi() {
    if (this.mode === "transmitting" || this.mode.startsWith("scan")) return;
    if (this.auto) this.trigger = Math.max(-105, Math.min(-20, this.noise + this.margin));
    this.emit({ event: "rssi", dbm: this.rssi(), mode: this.mode, auto_enabled: this.auto, noise_dbm: this.noise, trigger_dbm: this.trigger });
  }

  receive(c) {
    const id = c.id ?? 0;
    if (c.cmd === "hello") { this.compact = !!c.compact; this.emit(this.status(id, "hello")); return; }
    if (c.cmd === "status") { this.emit(this.status(id)); return; }
    if (c.cmd === "cancel") {
      const interrupted = this.requestId;
      this.clearTimers(); this.auto = false; this.mode = "idle";
      this.emit({ event: "cancelled", id, interrupted_id: interrupted }); return;
    }
    if (c.cmd.startsWith("scan_")) { this.scan(c, id); return; }
    if (this.mode !== "idle") { this.error(id, "Device busy. Stop the current operation first."); return; }
    if (c.cmd === "tune") {
      if (!validFrequency(c.frequency_mhz) || !BANDWIDTHS.includes(c.bandwidth_khz)) {
        this.error(id, "RX frequency must be 300-348, 387-464 or 779-928 MHz; bandwidth 203, 325 or 650 kHz."); return;
      }
      this.mhz = c.frequency_mhz; this.bw = c.bandwidth_khz; this.emit(this.status(id)); return;
    }
    if (c.cmd === "capture" || c.cmd === "auto_start") {
      this.auto = c.cmd === "auto_start"; this.requestId = id; this.margin = c.margin_db ?? 12;
      this.trigger = this.auto ? this.noise + this.margin : c.trigger_dbm ?? -70;
      this.arm();
      if (!this.auto) this.later(4000, () => this.mode === "armed" && this.press());  // demo convenience
      return;
    }
    if (c.cmd === "upload") {
      try {
        const pulses = typeof c.pulses === "string" ? parseLine(JSON.stringify({ pulses: c.pulses })).pulses : c.pulses;
        validatePulses(pulses);
        if (c.crc32 !== undefined && c.crc32 !== pulseCrc(pulses)) throw new Error("Waveform checksum mismatch; upload again.");
        this.loaded = { pulses, mhz: c.frequency_mhz };
        this.emit({ event: "loaded", id, count: pulses.length, crc32: pulseCrc(pulses), frequency_mhz: c.frequency_mhz });
      } catch (error) { this.loaded = null; this.error(id, error.message); }
      return;
    }
    if (c.cmd === "transmit") {
      const l = this.loaded;
      if ((c.crc32 !== undefined && (!l || pulseCrc(l.pulses) !== c.crc32)) ||
          (c.frequency_mhz !== undefined && (!l || Math.abs(l.mhz - c.frequency_mhz) > 0.0005))) {
        this.error(id, "The board holds a different signal; upload it again.", "not_loaded"); return;
      }
      if (!validTxFrequency(l?.mhz)) { this.error(id, "This module's transmit range is 387-464 MHz; other bands are receive-only."); return; }
      const planned = (durationUs(l.pulses) + c.gap_us) * c.repeats;
      if (!(c.repeats >= 1 && c.repeats <= 10) || !POWERS.includes(c.power_dbm) || planned > 10_000_000) {
        this.error(id, "Invalid TX settings or more than 10 seconds total duration."); return;
      }
      this.mode = "transmitting"; this.requestId = id;
      const crc32 = pulseCrc(l.pulses), started = Date.now();
      this.emit({ event: "tx_started", id, planned_us: planned, crc32, dry_run: false, repeats: c.repeats });
      this.later(planned / 1000 + 40, () => {
        this.mode = "idle";
        this.emit({ event: "tx_done", id, dry_run: false, repeats: c.repeats, planned_us: planned, elapsed_ms: Date.now() - started });
      });
      return;
    }
    this.error(id, "Unknown command.");
  }

  arm() {
    this.mode = "armed";
    this.emit({ event: "armed", id: this.requestId, timeout_ms: this.auto ? 0 : 20000, auto: this.auto, noise_dbm: this.noise, trigger_dbm: this.trigger });
    if (this.auto) this.later(random(3500, 7000), () => this.mode === "armed" && this.press());
  }
  press() {
    if (this.mode !== "armed") { this.pressUntil = Date.now() + 600; return; }
    const roll = Math.random();
    const remote = REMOTES[roll < 0.65 ? 0 : 1];
    const pulses = roll > 0.9 ? noiseBurst() : remoteBurst(remote, Math.round(random(3, 9)));
    this.pressUntil = Date.now() + 500;
    this.mode = "recording";
    this.emit({ event: "triggered", id: this.requestId });
    this.later(450, () => {
      const peak = roll > 0.9 ? -72 : Math.round(random(-38, -30));
      this.emit({
        event: "capture", id: this.requestId, frequency_mhz: this.mhz, modulation: "OOK", peak_dbm: peak,
        duration_us: durationUs(pulses), bandwidth_khz: this.bw, glitch_us: 60, removed_glitches: 0,
        raw_edges: pulses.length + 1, quiet_ms: 80, record_ms: 1500, crc32: pulseCrc(pulses), truncated: false,
        stop_reason: "quiet", auto: this.auto, noise_dbm: this.noise, trigger_dbm: this.trigger, ...this.arrays({ pulses }),
      });
      this.loaded = { pulses, mhz: this.mhz };
      if (this.auto) { this.mode = "cooldown"; this.later(900, () => this.auto && this.arm()); }
      else this.mode = "idle";
    });
  }

  // Frequency finder: a learned background, then a peak at 433.92 MHz while "pressed".
  scan(c, id) {
    const points = [];
    for (let khz = 387000; khz <= 464000; khz += 400) points.push(khz);
    if (points[points.length - 1] !== 464000) points.push(464000);
    if (c.cmd === "scan_start") {
      this.clearTimers(); this.auto = false; this.mode = "scan_learning"; this.scanId = id; this.requestId = id;
      this.points = points; this.background = points.map(() => Math.round(random(-96, -90)));
      this.emit({ event: "scan_started", id, points: points.length, scope: c.scope ?? "module", minimum_ms: 5000, minimum_sweeps: 3 });
      let step = 0;
      this.scanTimer = setInterval(() => {
        step++;
        this.emit({ event: "scan_progress", id, phase: "learning", index: (step * 37) % points.length, total: points.length,
                    sweep: Math.min(3, 1 + Math.floor(step / 7)), elapsed_ms: step * 250, frequency_mhz: points[(step * 37) % points.length] / 1000 });
        if (step >= 20) {
          clearInterval(this.scanTimer); this.mode = "scan_ready";
          this.emit({ event: "scan_ready", id, sweeps: 3, margin_db: 12,
                      ...this.arrays({ frequencies_khz: points, noise_dbm: this.background, rssi_dbm: points.map(() => -200) }) });
        }
      }, 250);
      return;
    }
    if (!this.points) { this.error(id, "Learn the background before searching."); return; }
    if (c.cmd === "scan_search") {
      this.mode = "scan_searching"; this.scanId = id; this.requestId = id;
      this.emit({ event: "scan_searching", id });
      this.later(900, () => {
        const signal = this.points.map((khz, i) => (Math.abs(khz - 433920) < 300 ? -41 : this.background[i] + Math.round(random(0, 3))));
        this.emit({ event: "scan_sweep", id, sweeps: 1, margin_db: 12,
                    ...this.arrays({ frequencies_khz: this.points, noise_dbm: this.background, rssi_dbm: signal }) });
        this.refine(433800, id);
      });
      return;
    }
    if (c.cmd === "scan_refine") { this.refine(Math.round(c.frequency_mhz * 1000), id); return; }
    if (c.cmd === "scan_pause") { this.clearTimers(); this.mode = "scan_ready"; this.emit({ event: "scan_paused", id }); return; }
    if (c.cmd === "scan_lock") {
      this.clearTimers(); this.mode = "idle"; this.mhz = c.frequency_mhz; this.bw = 325;
      this.emit({ event: "scan_locked", id, frequency_mhz: this.mhz, bandwidth_khz: 325 }); return;
    }
    this.error(id, "Unknown frequency-finder command.");
  }
  refine(centerKhz, id) {
    this.mode = "scan_refining"; this.scanId = id;
    this.emit({ event: "scan_refining", id, center_mhz: centerKhz / 1000, points: 49, passes: 4, step_khz: 25 });
    this.later(1600, () => {
      const khz = [], rssi = [];
      for (let o = -600; o <= 600; o += 25) { khz.push(centerKhz + o); rssi.push(Math.abs(centerKhz + o - 433920) <= 60 ? -40 : -85 - Math.round(random(0, 6))); }
      this.mode = "scan_found";
      this.emit({ event: "scan_result", id, frequency_mhz: 433.92, peak_dbm: -40, noise_dbm: -93, rise_db: 53, resolution_khz: 25,
                  module_rated: true, ...this.arrays({ frequencies_khz: khz, rssi_dbm: rssi }) });
      this.scanTimer = setInterval(() => this.emit({ event: "scan_live", id, frequency_mhz: 433.92, dbm: this.rssi() }), 200);
    });
  }
}
