/* =============================================================================
   Supabase EN MEMORIA para tests de integridad de datos.

   A diferencia de los mocks de "builder que siempre responde lo mismo", esta
   base FILTRA de verdad: un UPDATE con `.eq("despacho_id", X)` solo toca las filas
   de X, un `.or("a.is.null,a.eq.0")` se evalúa fila por fila. Es lo que hace falta
   para probar lo que importa acá — que una escritura condicional NO toque la fila
   cuando la condición dejó de cumplirse.

   `hooks.antesDe(tabla, op, consulta)` corre ANTES de cada operación y puede ser
   async: es la forma de meter "otro celular" en el medio de una operación y
   reproducir una carrera de forma determinista. Si devuelve `{ error }`, esa
   operación falla como fallaría en PostgREST.

   Cubre solo el subconjunto de PostgREST que usa el código bajo prueba.
   ============================================================================= */

import { randomUUID } from "node:crypto";

const clonar = (x) => (x == null ? x : structuredClone(x));

/** Valor de un literal de PostgREST en un `.or()` ("null", "true", "0", "abc"). */
function literal(v) {
  if (v === "null") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  if (v !== "" && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

const igual = (a, b) => {
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return a === b;
};

/** `a.is.null,a.eq.0` → predicado. Solo operadores simples, sin anidar. */
function parsearOr(expr) {
  const partes = expr.split(",").map((p) => {
    const [col, op, ...resto] = p.split(".");
    const v = literal(resto.join("."));
    if (op === "is") return (r) => (v === null ? r[col] == null : r[col] === v);
    if (op === "eq") return (r) => igual(r[col], v);
    if (op === "lt") return (r) => r[col] != null && r[col] < v;
    throw new Error(`fakeSupabase: operador .or() no soportado: ${op}`);
  });
  return (r) => partes.some((p) => p(r));
}

class Consulta {
  constructor(bd, tabla) {
    this.bd = bd;
    this.tabla = tabla;
    this.op = "select";
    this.cols = "*";
    this.devolver = false;
    this.filtros = [];
    this.modo = "lista";
  }

  select(cols = "*") {
    if (this.op === "select") this.cols = cols;
    else this.devolver = true;
    this.colsDevueltas = cols;
    return this;
  }
  update(patch) {
    this.op = "update";
    this.patch = patch;
    return this;
  }
  insert(filas) {
    this.op = "insert";
    this.filas = Array.isArray(filas) ? filas : [filas];
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }

  eq(c, v) {
    this.filtros.push((r) => igual(r[c], v));
    return this;
  }
  neq(c, v) {
    this.filtros.push((r) => !igual(r[c], v));
    return this;
  }
  is(c, v) {
    this.filtros.push((r) => (v === null ? r[c] == null : r[c] === v));
    return this;
  }
  in(c, arr) {
    this.filtros.push((r) => arr.some((v) => igual(r[c], v)));
    return this;
  }
  not(c, op, v) {
    if (op === "is") this.filtros.push((r) => !(v === null ? r[c] == null : r[c] === v));
    else if (op === "in") {
      const lista = String(v).replace(/[()]/g, "").split(",");
      this.filtros.push((r) => !lista.includes(String(r[c])));
    } else throw new Error(`fakeSupabase: .not(${op}) no soportado`);
    return this;
  }
  or(expr) {
    this.filtros.push(parsearOr(expr));
    return this;
  }
  lt(c, v) {
    this.filtros.push((r) => r[c] != null && r[c] < v);
    return this;
  }
  gte(c, v) {
    this.filtros.push((r) => r[c] != null && r[c] >= v);
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }
  range() {
    return this;
  }

  single() {
    this.modo = "single";
    return this.ejecutar();
  }
  maybeSingle() {
    this.modo = "maybe";
    return this.ejecutar();
  }
  then(ok, falla) {
    return this.ejecutar().then(ok, falla);
  }

  filasDeTabla() {
    if (!this.bd.tablas[this.tabla]) this.bd.tablas[this.tabla] = [];
    return this.bd.tablas[this.tabla];
  }

  coincide(r) {
    return this.filtros.every((f) => f(r));
  }

  /** Embebidos del estilo `*, traslados_items(*), traslados_firmas(*)`. */
  conEmbebidos(fila, cols) {
    const out = clonar(fila);
    if (this.tabla === "traslados_despachos" && /traslados_items\(/.test(cols || "")) {
      out.traslados_items = (this.bd.tablas.traslados_items || [])
        .filter((it) => it.despacho_id === fila.id)
        .map(clonar);
    }
    if (this.tabla === "traslados_despachos" && /traslados_firmas\(/.test(cols || "")) {
      out.traslados_firmas = (this.bd.tablas.traslados_firmas || [])
        .filter((f) => f.despacho_id === fila.id)
        .map(clonar);
    }
    return out;
  }

  async ejecutar() {
    if (this.bd.hooks.antesDe) {
      // Un hook que devuelve `{ error }` simula una falla de la base en ESTA
      // operación (red caída, constraint): responde como PostgREST, sin lanzar.
      const corto = await this.bd.hooks.antesDe(this.tabla, this.op, this);
      if (corto?.error) return { data: null, error: corto.error };
    }
    this.bd.log.push({ tabla: this.tabla, op: this.op, patch: this.patch });

    const tabla = this.filasDeTabla();
    let salida = [];

    if (this.op === "select") {
      salida = tabla.filter((r) => this.coincide(r)).map((r) => this.conEmbebidos(r, this.cols));
    } else if (this.op === "update") {
      for (const r of tabla) {
        if (this.coincide(r)) {
          Object.assign(r, clonar(this.patch));
          salida.push(clonar(r));
        }
      }
    } else if (this.op === "insert") {
      for (const f of this.filas) {
        const fila = { id: randomUUID(), ...(this.bd.defaults[this.tabla] || {}), ...clonar(f) };
        tabla.push(fila);
        salida.push(clonar(fila));
      }
    } else if (this.op === "delete") {
      const quedan = [];
      for (const r of tabla) {
        if (this.coincide(r)) salida.push(clonar(r));
        else quedan.push(r);
      }
      this.bd.tablas[this.tabla] = quedan;
      // Cascade de despachos → ítems y firmas, como la FK real.
      if (this.tabla === "traslados_despachos") {
        const borrados = new Set(salida.map((r) => r.id));
        for (const hija of ["traslados_items", "traslados_firmas"]) {
          this.bd.tablas[hija] = (this.bd.tablas[hija] || []).filter(
            (x) => !borrados.has(x.despacho_id),
          );
        }
      }
    }

    const devuelveFilas = this.op === "select" || this.devolver;
    if (this.modo === "single") {
      if (salida.length !== 1) {
        return { data: null, error: { code: "PGRST116", message: `se esperaba 1 fila, hubo ${salida.length}` } };
      }
      return { data: devuelveFilas ? salida[0] : null, error: null };
    }
    if (this.modo === "maybe") {
      if (salida.length > 1) {
        return { data: null, error: { code: "PGRST116", message: `se esperaba 0 o 1 fila, hubo ${salida.length}` } };
      }
      return { data: devuelveFilas ? (salida[0] ?? null) : null, error: null };
    }
    return { data: devuelveFilas ? salida : null, error: null };
  }
}

/**
 * Crea una base en memoria.
 * @param {object} tablas - { traslados_despachos: [...], traslados_items: [...] }
 */
export function crearBD(tablas = {}) {
  const bd = {
    tablas: clonar(tablas),
    hooks: { antesDe: null },
    log: [],
    defaults: {
      traslados_despachos: { inactivo: false, parte_de: null, parte_num: null },
      traslados_items: {
        cantidad_despachador: null,
        cantidad_auditor: null,
        agotado: false,
        motivo: null,
        recolectado_por: null,
        no_recibido: false,
        factor: 1,
      },
    },
  };
  bd.supabase = { from: (tabla) => new Consulta(bd, tabla) };
  return bd;
}
