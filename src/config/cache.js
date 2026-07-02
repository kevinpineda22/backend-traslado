/**
 * cache.js — Caché persistente (memoria + archivo) con TTL
 *
 * Persiste a disco para sobrevivir reinicios del servidor.
 * Los datos se guardan en cache-data/ dentro del proyecto.
 *
 * Uso:
 *   import { getOrSet } from "../config/cache.js";
 *
 *   const data = await getOrSet("productos", async () => {
 *     return await traerDatosLentos();
 *   }, 30 * 60 * 1000);
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(__dirname, "../../cache-data");

// Asegurar que el directorio exista
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

const store = new Map();

// ─── Restaurar desde disco al arrancar ────────────────────────────────────
function restoreFromDisk() {
  try {
    const files = fs.readdirSync(CACHE_DIR);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const key = file.slice(0, -5);
      const raw = fs.readFileSync(path.join(CACHE_DIR, file), "utf-8");
      const entry = JSON.parse(raw);
      if (entry.expiresAt > Date.now()) {
        store.set(key, entry);
      } else {
        fs.unlinkSync(path.join(CACHE_DIR, file));
      }
    }
    if (store.size > 0) {
      console.log(`[cache] Restaurados ${store.size} elementos del disco`);
    }
  } catch {
    // Primer inicio — no hay caché todavía
  }
}

restoreFromDisk();

// ─── Persistir a disco ────────────────────────────────────────────────────
function persist(key, entry) {
  try {
    const filePath = path.join(CACHE_DIR, `${key}.json`);
    fs.writeFileSync(filePath, JSON.stringify(entry), "utf-8");
  } catch (err) {
    console.error(`[cache] Error al persistir ${key}:`, err.message);
  }
}

function removeFromDisk(key) {
  try {
    const filePath = path.join(CACHE_DIR, `${key}.json`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

// ─── API pública ──────────────────────────────────────────────────────────

export function get(key) {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    removeFromDisk(key);
    return undefined;
  }
  return entry.value;
}

export function set(key, value, ttlMs = 30 * 60 * 1000) {
  const entry = { value, expiresAt: Date.now() + ttlMs };
  store.set(key, entry);
  persist(key, entry);
}

export async function getOrSet(key, fn, ttlMs = 30 * 60 * 1000) {
  const cached = get(key);
  if (cached !== undefined) return cached;

  const value = await fn();
  set(key, value, ttlMs);
  return value;
}

export function clear(key) {
  if (key) {
    store.delete(key);
    removeFromDisk(key);
  } else {
    store.clear();
    try {
      const files = fs.readdirSync(CACHE_DIR);
      for (const file of files) {
        if (file.endsWith(".json")) {
          fs.unlinkSync(path.join(CACHE_DIR, file));
        }
      }
    } catch {
      // ignore
    }
  }
}

export function stats() {
  return {
    size: store.size,
    keys: Array.from(store.keys()),
  };
}
