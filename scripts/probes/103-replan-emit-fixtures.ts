// 103: сборка обезличенных эталонов ui-ref-replan-*.json из дампов проб.
// Запуск: node scripts/probes/103-replan-emit-fixtures.ts
import { readFileSync, writeFileSync } from "node:fs";

const dir = ".orca-reports/phase2-ui-refs/";
const load = (n: string) => JSON.parse(readFileSync(`${dir}${n}.json`, "utf8"));

// словарь обезличивания: случайные id сайта → смысловые метки
const map = new Map<string, string>();
let n = 0;
const isId = (s: string) => /^_[a-z0-9]{5}(_\d+)?$/.test(s);
const keyId = (k: string): string => {
  if (!isId(k)) return k;
  if (!map.has(k)) map.set(k, `id${++n}`);
  return map.get(k)!;
};
const anon = (v: unknown): unknown => {
  if (typeof v === "string") return map.get(v) ?? v;
  if (Array.isArray(v)) return v.map(anon);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[keyId(k)] = anon(val);
    }
    return out;
  }
  return v;
};
const register = (v: unknown): void => {
  if (typeof v === "string") {
    if (isId(v) && !map.has(v)) map.set(v, `id${++n}`);
    return;
  }
  if (Array.isArray(v)) return v.forEach(register);
  if (v && typeof v === "object") for (const val of Object.values(v)) register(val);
};

const SOURCE = "клики UI в анонимном проекте на синтетической базе «коридор + 3 комнаты» (проба 103-replan-fixtures2/zone/extra, без save); id объектов обезличены, координаты — синтетическая база, см (модель редактора)";

const d2 = load("103-replan-diffs2");
const d1 = load("103-replan-diffs");
const box = load("103-box-clean");
const zone = load("103-zone-diff");

// регистрируем id до обезличивания
register(d2); register(d1); register(box); register(zone);
// осмысленные метки для ключевых объектов
const named: Array<[string, string]> = [];
for (const [site, label] of Object.entries({
  // стены базы синтетические — их id тоже обезличены словарём idN
})) named.push([site, label]);

const strip = (o: any) => {
  const c = JSON.parse(JSON.stringify(o));
  const walk = (x: any): any => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      const r: any = {};
      for (const [k, v] of Object.entries(x)) {
        if (k === "eds2" || k === "bak") continue;
        r[k] = walk(v);
      }
      return r;
    }
    return x;
  };
  return walk(c);
};

// семантическое ядро демонтажа: только значимые поля (без производной геометрии редактора)
const wallCore = (ch: any): unknown => {
  const out: any = {};
  if (ch.demount !== undefined) out.demount = ch.demount;
  for (const p of ["p1", "p2"]) if (ch[p]?.demount !== undefined) out[p] = { demount: ch[p].demount };
  if (ch.sectors !== undefined) out.sectors = ch.sectors;
  if (ch.holes !== undefined) {
    out.holes = Object.fromEntries(Object.entries(ch.holes).map(([k, h]: any) => [k, {
      plan: h.plan, type: h.type, demount: h.demount, hasReplacement: h.hasReplacement,
    }]));
  }
  return out;
};
const addedWallCore = (added: Record<string, any>): unknown => Object.fromEntries(
  Object.entries(added).map(([k, w]) => [k, {
    plan: w.plan, role: w.role, material: w.material, depth: w.depth, height: w.height,
    child: w.child, p1: w.p1, p2: w.p2,
  }]),
);

writeFileSync("tests/fixtures/ui-ref-replan-demolition.json", JSON.stringify({
  _source: SOURCE,
  break_whole: anon(strip(Object.entries(d2.diffs.S01_break_whole.walls.changed).filter(([, ch]: any) => ch.demount !== undefined).map(([, ch]: any) => wallCore(ch))[0])),
  break_part: anon(wallCore(strip(Object.values(d2.diffs.S02_break_part.walls.changed).find((ch: any) => ch.sectors !== undefined)))),
  break_door: anon(wallCore(strip(Object.values(d2.diffs.S03_break_door.walls.changed).find((ch: any) => ch.holes !== undefined)))),
  remove_break: anon(wallCore(strip(Object.values(d2.diffs.S04_remove_break.walls.changed).find((ch: any) => ch.demount !== undefined)))),
}, null, 1) + "\n");

writeFileSync("tests/fixtures/ui-ref-replan-partitions.json", JSON.stringify({
  _source: SOURCE,
  c_gypsum: anon(addedWallCore(strip(d2.diffs.S05a_wall_gypsum.walls.added))),
  c_pgb: anon(addedWallCore(strip(d2.diffs.S05b_wall_pgb.walls.added))),
  c_block: anon(addedWallCore(strip(d2.diffs.S05c_wall_blocks.walls.added))),
  c_brick: anon(addedWallCore(strip(d2.diffs.S05d_wall_bricks.walls.added))),
}, null, 1) + "\n");

// замена двери из первого прогона (там doorway поставлен на не демонтированную дверь)
const s08 = d1.diffs.S08_doorway_replace;
const s08Holes = Object.values(s08.walls.changed).map((w: any) => w.holes).filter(Boolean);
const replaced = s08Holes.map((h: any) => Object.values(h)).flat().filter((h: any) => h.hasReplacement);
const newC = s08Holes.map((h: any) => Object.values(h)).flat().filter((h: any) => h.plan === "c");
writeFileSync("tests/fixtures/ui-ref-replan-replacement.json", JSON.stringify({
  _source: SOURCE.replace("103-replan-fixtures2/zone/extra", "103-replan-fixtures"),
  original_hole: anon(strip(replaced).map((h: any) => ({
    plan: h.plan, type: h.type, hasReplacement: h.hasReplacement, pc: h.pc, width: h.width,
  }))[0]),
  new_hole: anon(strip(newC).map((h: any) => ({
    plan: h.plan, type: h.type, group: h.group, position: h.position, casing: h.casing,
    pc: h.pc, width: h.width, height: h.height, parent: h.parent, parent_depth: h.parent_depth,
  }))[0]),
}, null, 1) + "\n");

writeFileSync("tests/fixtures/ui-ref-replan-gypsum-box.json", JSON.stringify({
  _source: "клики UI в анонимном проекте на синтетической базе «коридор + 3 комнаты» (проба 103-replan-zone, без save); id обезличены, координаты — синтетическая база, см",
  pillar: anon(strip(Object.values(box.pillars)[0])),
}, null, 1) + "\n");

writeFileSync("tests/fixtures/ui-ref-replan-zone.json", JSON.stringify({
  _source: "клики UI в анонимном проекте на синтетической базе «коридор + 3 комнаты» (проба 103-replan-zone, без save); id обезличены, координаты — синтетическая база, см; эталон для zone_line_add (следующий PR)",
  zone_delimiter: anon(strip(Object.values(zone.zone_delimiters)[0])),
  room_zones_changed: anon(strip(zone.rooms2?.changed ?? {})),
}, null, 1) + "\n");

console.log("fixtures written; id map size:", map.size);
