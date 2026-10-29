// Signal library in IndexedDB (records hold the desktop app's file format, so
// they are validated on every load), plus small preferences in localStorage.
import { captureFromFile, captureToFile } from "./core.js";

const DB_NAME = "rf-workbench", STORE = "captures";

export class Library {
  constructor() { this.db = null; this.memory = new Map(); }
  async open() {
    try {
      this.db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      navigator.storage?.persist?.().catch(() => {});  // ask the browser not to evict the library
      return true;
    } catch {
      this.db = null;  // private browsing or blocked storage: keep this session in memory
      return false;
    }
  }
  tx(mode, work) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(STORE, mode);
      const result = work(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(result?.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }
  // Returns { captures (newest first), archived, errors }.
  async load() {
    const records = this.db ? await this.tx("readonly", (s) => s.getAll()) : [...this.memory.values()];
    const captures = [], archived = [], errors = [];
    for (const record of records) {
      try {
        const capture = captureFromFile(record.data);
        (record.archived ? archived : captures).push(capture);
      } catch (error) {
        errors.push(`Skipped ${record.data?.name ?? record.id}: ${error.message}`);
      }
    }
    captures.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
    return { captures, archived, errors };
  }
  async save(capture, archived = false) {
    const record = { id: capture.id, archived, data: captureToFile(capture) };
    if (this.db) await this.tx("readwrite", (s) => s.put(record));
    else this.memory.set(record.id, record);
  }
}

const PREFS_KEY = "rf-workbench-prefs";
export function loadPrefs() {
  try {
    const value = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}
export function savePrefs(prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* storage unavailable */ }
}
