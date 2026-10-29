// Web Bluetooth link to the board: the firmware's newline-delimited JSON over
// the Nordic UART Service. Bluefy provides Web Bluetooth on iPad; Chrome and
// Edge provide it on a PC.
import { decodeCompact } from "./core.js";

export const NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const NUS_RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";  // write: iPad -> board
const NUS_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";  // notify: board -> iPad
const ARRAY_FIELDS = ["pulses", "frequencies_khz", "noise_dbm", "rssi_dbm"];

// One protocol line -> event object, expanding compact arrays (base64 varints).
export function parseLine(line) {
  const message = JSON.parse(line);
  for (const key of ARRAY_FIELDS) if (typeof message[key] === "string") message[key] = decodeCompact(message[key]);
  return message;
}

// Reassembles lines from notification chunks of any size.
export class LineSplitter {
  constructor(onLine) { this.onLine = onLine; this.decoder = new TextDecoder(); this.pending = ""; }
  push(bytes) {
    this.pending += this.decoder.decode(bytes, { stream: true });
    let end;
    while ((end = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, end).replace(/\r$/, "");
      this.pending = this.pending.slice(end + 1);
      if (line) this.onLine(line);
    }
    if (this.pending.length > 200_000) this.pending = "";  // never happens with valid firmware
  }
  reset() { this.pending = ""; this.decoder = new TextDecoder(); }
}

export class BleLink {
  // onEvent(message), onState("connected" | "reconnecting" | "disconnected", detail), onBadLine(error)
  constructor({ onEvent, onState, onBadLine }) {
    Object.assign(this, { onEvent, onState, onBadLine });
    this.chunk = 20;          // safe for the default 23-byte MTU until the board reports its MTU
    this.queue = Promise.resolve();
    this.manual = false;
    this.splitter = new LineSplitter((line) => {
      try { this.onEvent(parseLine(line)); } catch (error) { this.onBadLine?.(error, line); }
    });
  }
  static supported() { return typeof navigator !== "undefined" && !!navigator.bluetooth; }
  get name() { return this.device?.name || "RF Workbench"; }

  async connect() {
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [NUS_SERVICE] }, { namePrefix: "RF Workbench" }],
      optionalServices: [NUS_SERVICE],
    });
    this.device.addEventListener("gattserverdisconnected", () => this.dropped());
    await this.open();
    this.onState("connected");
  }
  async open() {
    this.splitter.reset();
    this.chunk = 20;
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(NUS_SERVICE);
    this.rx = await service.getCharacteristic(NUS_RX);
    this.tx = await service.getCharacteristic(NUS_TX);
    if (!this.listening) {
      this.tx.addEventListener("characteristicvaluechanged", (event) => {
        const v = event.target.value;
        this.splitter.push(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
      });
      this.listening = true;
    }
    // Subscribing asks iOS to pair: the passkey prompt appears here the first time.
    await this.tx.startNotifications();
  }
  setMtu(mtu) { if (Number.isInteger(mtu) && mtu > 23) this.chunk = Math.min(mtu - 3, 509); }

  // Queues one command; resolves once every chunk is acknowledged by the board.
  send(message) {
    const bytes = new TextEncoder().encode(JSON.stringify(message) + "\n");
    const job = this.queue.then(async () => {
      if (!this.rx) throw new Error("Not connected.");
      for (let i = 0; i < bytes.length; i += this.chunk) {
        const part = bytes.slice(i, i + this.chunk);
        if (this.rx.writeValueWithResponse) await this.rx.writeValueWithResponse(part);
        else await this.rx.writeValue(part);
      }
    });
    this.queue = job.catch(() => {});
    return job;
  }

  async dropped() {
    this.rx = this.tx = null;
    this.queue = Promise.resolve();
    if (this.manual) { this.onState("disconnected"); return; }
    for (const wait of [500, 1500, 4000]) {  // out of range, iPad slept, board reset…
      this.onState("reconnecting");
      await new Promise((resolve) => setTimeout(resolve, wait));
      if (this.manual) break;
      try { await this.open(); this.onState("connected", { reconnected: true }); return; } catch { /* retry */ }
    }
    this.onState("disconnected", { lost: !this.manual });
  }
  disconnect() {
    this.manual = true;
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    else this.onState("disconnected");
  }
}
