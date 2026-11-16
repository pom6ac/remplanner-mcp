// Сверка бэкапа и текущего GET: различия вне eds2-id (перегенерируемых редактором).
import { readFileSync } from "node:fs";

type Any = Record<string, unknown>;
const before = (JSON.parse(readFileSync(process.argv[2]!, "utf8")) as { model: Any }).model;
const after = (JSON.parse(readFileSync(process.argv[3]!, "utf8")) as { model: Any }).model;

// нормализация: id внутри eds2 → константа (редактор перегенерирует их при каждом restore)
function normalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalize);
  if (v !== null && typeof v === "object") {
    const out: Any = {};
    for (const [k, val] of Object.entries(v as Any)) {
      out[k] = k === "eds2" ? normalizeEds2(val) : normalize(val);
    }
    return out;
  }
  return v;
}
function normalizeEds2(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalizeEds2);
  if (v !== null && typeof v === "object") {
    const out: Any = {};
    for (const [k, val] of Object.entries(v as Any)) {
      out[k] = k === "id" && typeof val === "string" ? "<regen>" : normalizeEds2(val);
    }
    return out;
  }
  return v;
}

const strip = (m: Any): string => {
  const c = structuredClone(m) as Any;
  for (const k of ["errors", "logs", "session", "version", "drawing", "params", "settings", "final", "signals", "smeta_water_pipes", "rooms2", "rooms1", "save_id"]) delete c[k];
  return JSON.stringify(normalize(c));
};
const a = strip(before);
const b = strip(after);
console.log(a === b ? "OK — модели совпадают (с учётом перегенерации eds2.id)" : "РАСХОЖДЕНИЕ");
if (a !== b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      console.log("первое расхождение на", i, ":", a.slice(Math.max(0, i - 150), i + 150), "|||", b.slice(Math.max(0, i - 150), i + 150));
      break;
    }
  }
}
