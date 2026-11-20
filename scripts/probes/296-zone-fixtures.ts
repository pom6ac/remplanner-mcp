// 296: сборка обезличенных эталонов-фикстур из живых дампов scripts/probes/296-zone-ui.ts
// (.orca-reports/tmp/296-*.json). Координаты аффинно переносятся на синтетическую
// комнату 10..390 × 10..310 (как в ui-ref-ceilzone-delimiter.json), ID заменяются на
// синтетические (zd1/fz1/hz1/cz1/rg1/room1/wall1..4, v1/v2). node scripts/probes/296-zone-fixtures.ts run
import { readFileSync, writeFileSync } from "node:fs";
import { anonymizeEditorIds } from "../anonymize.ts";

if (process.argv[2] !== "run") { console.error("запуск: run"); process.exit(0); }

type P = { x: number; y: number };
const SRC_ROOM = { x0: 47.7, y0: 113, x1: 367.3, y1: 542.8 };
const DST_ROOM = { x0: 10, y0: 10, x1: 390, y1: 310 };
const sx = (x: number): number => Math.round((DST_ROOM.x0 + ((x - SRC_ROOM.x0) * (DST_ROOM.x1 - DST_ROOM.x0)) / (SRC_ROOM.x1 - SRC_ROOM.x0)) * 10) / 10;
const sy = (y: number): number => Math.round((DST_ROOM.y0 + ((y - SRC_ROOM.y0) * (DST_ROOM.y1 - DST_ROOM.y0)) / (SRC_ROOM.y1 - SRC_ROOM.y0)) * 10) / 10;
const pt = (p: P): P => ({ x: sx(p.x), y: sy(p.y) });

// синтетическая комната и рёбра — как в ui-ref-ceilzone-delimiter.json (этап 260)
const SYNTH_ROOM = JSON.parse(readFileSync("tests/fixtures/ui-ref-ceilzone-delimiter.json", "utf8")) as {
  room: { polygon: P[]; edges: Array<Record<string, unknown>> };
};
const SYNTH_EDGES = SYNTH_ROOM.room.edges as Array<{ p1: P; p2: P; side: string; pid: string; pids: Record<string, string>; c?: P; length?: number; parent?: string; room_side?: string; inRoom?: number }>;

/** Реальное ребро (по orientation) → индекс синтетического ребра. */
function synthEdgeIndex(edge: { p1: P; p2: P }): number {
  const horizontal = Math.abs(edge.p2.x - edge.p1.x) >= Math.abs(edge.p2.y - edge.p1.y);
  if (horizontal) {
    const y = (edge.p1.y + edge.p2.y) / 2;
    return y < (SRC_ROOM.y0 + SRC_ROOM.y1) / 2 ? 3 : 1;
  }
  const x = (edge.p1.x + edge.p2.x) / 2;
  return x < (SRC_ROOM.x0 + SRC_ROOM.x1) / 2 ? 2 : 0;
}

const ID_MAP = new Map<string, string>();
const rid = (raw: string): string => {
  if (!ID_MAP.has(raw)) ID_MAP.set(raw, `id${ID_MAP.size + 1}`);
  return ID_MAP.get(raw)!;
};

/** Перенос vertex-zone привязки: ребро комнаты → синтетическое, ригель → rg1. */
function remapZone(z: Record<string, unknown>): Record<string, unknown> {
  const out = structuredClone(z);
  out["room_id"] = "room1";
  if (out["type"] === "room" && out["edge"]) {
    const idx = synthEdgeIndex(out["edge"] as { p1: P; p2: P });
    const e = SYNTH_EDGES[idx]!;
    out["edge"] = { p1: { ...e.p1 }, p2: { ...e.p2 } };
    out["edge_index"] = idx;
    out["edge_side"] = e.side;
    out["edge_pid"] = e.pid;
    out["edge_pids"] = { [e.pid]: e.side };
    out["room_id"] = "room1";
  }
  if (typeof out["rigel_id"] === "string") out["rigel_id"] = "rg1";
  if (out["edge"] && out["type"] === "rigel_ceiling") {
    const e = out["edge"] as { p1: P; p2: P };
    out["edge"] = { p1: pt(e.p1), p2: pt(e.p2) };
  }
  return out;
}

function remapDelimiter(rec: Record<string, unknown>, name: string): Record<string, unknown> {
  const out = structuredClone(rec);
  out["id"] = name;
  out["id_room"] = "room1";
  const vertexes = (out["vertexes"] ?? []) as Array<Record<string, unknown>>;
  const idOfVertex = new Map<string, string>();
  vertexes.forEach((v, i) => {
    const old = String(v["id"] ?? "");
    const nid = `v${i + 1}`;
    idOfVertex.set(old, nid);
    v["id"] = nid;
    v["point"] = pt(v["point"] as P);
    if (v["zone"]) v["zone"] = remapZone(v["zone"] as Record<string, unknown>);
  });
  const items = (out["items"] ?? {}) as Record<string, string>;
  out["items"] = Object.fromEntries(Object.entries(items).map(([k, t]) => [idOfVertex.get(k) ?? k, String(t)]));
  // синтетические координаты: длина пересчитывается по ним (анеизотропный перенос
  // масштабов не сохраняет); редактор пишет length по геометрии
  const vs = out["vertexes"] as Array<{ point: P }>;
  const a = vs[0]!.point, b = vs[vs.length - 1]!.point;
  out["length"] = Math.round((Math.hypot(b.x - a.x, b.y - a.y) / 100) * 100) / 100;
  return out;
}

/** Закладная: p1/p2 (+link к стене), polygon, width. */
function remapRigel(rec: Record<string, unknown>): Record<string, unknown> {
  const out = structuredClone(rec);
  out["id"] = "rg1";
  out["id_room"] = "room1";
  for (const key of ["p1", "p2"] as const) {
    const rawP = { ...(out[key] as Record<string, unknown>) };
    const link = rawP["link"] as { ot?: string; id?: string; z1?: string } | undefined;
    delete rawP["link"];
    const np = pt(rawP as unknown as P) as P & Record<string, unknown>;
    if (link && typeof link.id === "string" && link.id in WALL_PID) np["link"] = { ot: link.ot ?? "wall", id: WALL_PID[link.id]!, z1: link.z1 ?? null };
    out[key] = np;
  }
  out["polygon"] = ((out["polygon"] ?? []) as P[]).map(pt);
  return out;
}

// pid реальных рёбер → wall1..4 (по синтетическим рёбрам)
const WALL_PID: Record<string, string> = {};
{
  const raw = JSON.parse(readFileSync(".orca-reports/tmp/296-ui-etalons-raw.json", "utf8")) as Record<string, unknown>;
  const model = JSON.parse(readFileSync(".orca-reports/tmp/296-ui-etalons-model.json", "utf8")) as {
    zone_delimiters_runtime: Record<string, Record<string, unknown>>;
  };
  // собираем pid рёбер из zone-привязок всех записей
  for (const rec of Object.values(model.zone_delimiters_runtime)) {
    for (const v of (rec["vertexes"] ?? []) as Array<Record<string, unknown>>) {
      const z = v["zone"] as Record<string, unknown> | undefined;
      if (!z) continue;
      const pid = z["edge_pid"];
      if (typeof pid === "string" && !(pid in WALL_PID)) {
        const idx = synthEdgeIndex(z["edge"] as { p1: P; p2: P });
        WALL_PID[pid] = SYNTH_EDGES[idx]!.pid;
      }
    }
  }
  void raw;
}

const model = JSON.parse(readFileSync(".orca-reports/tmp/296-ui-etalons-model.json", "utf8")) as {
  zone_delimiters_runtime: Record<string, Record<string, Record<string, unknown>>>;
  rooms2_zone_bearing: Record<string, { rigels?: Record<string, Record<string, unknown>> }>;
};
const floorRun = JSON.parse(readFileSync(".orca-reports/tmp/296-floor.json", "utf8")) as {
  runtime: Record<string, Record<string, Record<string, unknown>>>;
};

const byType = new Map<string, Record<string, unknown>>();
for (const rec of Object.values(model.zone_delimiters_runtime)) byType.set(String(rec["type"]), rec);
for (const rec of Object.values(floorRun.runtime)) if (!byType.has(String(rec["type"]))) byType.set(String(rec["type"]), rec);

const roomBlock = () => ({
  polygon: structuredClone(SYNTH_ROOM.room.polygon),
  edges: structuredClone(SYNTH_ROOM.room.edges),
});

const fixtures: Array<{ file: string; source: string; body: Record<string, unknown> }> = [];

{
  const rec = byType.get("zone_floor");
  if (!rec) throw new Error("zone_floor эталон не найден в дампах");
  fixtures.push({
    file: "ui-ref-floorzone-delimiter.json",
    source: "Эталон зонирования пола (этап 296, 2026-11-20): линия-delimiter снята drag'ом UI (инструмент «Зонирование» листа «Напольные покрытия», кнопка plannertool_zone_floor) в dev-проекте пробой scripts/probes/296-zone-ui.ts; записи на сервер не было (локальное состояние откатано перезагрузкой, GET сверён с бэкапом). Запись совпадает по форме с zone_ceiling (этап 260): type zone_floor, plan floor (лист «Напольные покрытия»), длина в м, on_size 1. Координаты аффинно перенесены на синтетическую комнату 10..390 × 10..310 (пропорции сохранены), внутренние ID заменены на fz1/v1/v2/room1/wall1..4; длина пересчитана по синтетическим координатам (анеизотропный перенос). Привязка узлов zone (ребро комнаты, type room) — производное редактора (calc() при restore), в записи MCP не пишется. После создания делителя floors комнаты делятся на зоны (floors: 2).",
    body: { room: roomBlock(), zone_delimiters: { fz1: remapDelimiter(rec, "fz1") } },
  });
}
{
  const rec = byType.get("zone_hydroisolation");
  if (!rec) throw new Error("zone_hydroisolation эталон не найден");
  fixtures.push({
    file: "ui-ref-hydrozone-delimiter.json",
    source: "Эталон зонирования гидроизоляции (этап 296, 2026-11-20): линия-delimiter снята drag'ом UI (инструмент «Зонирование» листа «Гидроизоляция», та же кнопка plannertool_zone_floor — тип записи задаётся листом) в dev-проекте пробой scripts/probes/296-zone-ui.ts; записи на сервер не было. type zone_hydroisolation, plan hydroisolation. Координаты — та же синтетическая комната 10..390 × 10..310, ID — hz1/v1/v2/room1/wall1..4; длина пересчитана по синтетическим координатам. Привязка zone — производное редактора.",
    body: { room: roomBlock(), zone_delimiters: { hz1: remapDelimiter(rec, "hz1") } },
  });
}
{
  const rec = byType.get("zone_floor_cap");
  if (!rec) throw new Error("zone_floor_cap эталон не найден");
  fixtures.push({
    file: "ui-ref-capzone-delimiter.json",
    source: "Эталон зонирования стяжки (этап 296, 2026-11-20): линия-delimiter снята drag'ом UI (инструмент «Зонирование» листа «Стяжка», та же кнопка plannertool_zone_floor — тип записи задаётся листом) в dev-проекте пробой scripts/probes/296-zone-ui.ts; записи на сервер не было. type zone_floor_cap, plan floor_cap. Координаты — та же синтетическая комната 10..390 × 10..310, ID — cz1/v1/v2/room1/wall1..4; длина пересчитана по синтетическим координатам. Привязка zone — производное редактора.",
    body: { room: roomBlock(), zone_delimiters: { cz1: remapDelimiter(rec, "cz1") } },
  });
}
{
  const rec = byType.get("zone_ceiling");
  if (!rec) throw new Error("zone_ceiling (конец на закладной) эталон не найден");
  const bearing = Object.values(model.rooms2_zone_bearing)[0];
  const rigels = bearing?.rigels ?? {};
  const rgRec = Object.values(rigels)[0];
  if (!rgRec) throw new Error("закладная не найдена в дампе");
  fixtures.push({
    file: "ui-ref-ceilzone-delimiter-rigel.json",
    source: "Эталон конца разделителя зон потолка на грани потолочной закладной (этап 296, 2026-11-20; закрывает хвост 260 «живой эталон конца на ригеле/закладной не снят»): закладная создана drag'ом UI (инструмент ceiling_rigel листа «Потолки», от стены до стены, width 10 см), затем разделитель — drag от внешнего ребра к грани закладной (магнит 10 см); проба scripts/probes/296-zone-ui.ts, записи на сервер не было. Конец на закладной получает zone-привязку {rigel_id, edge — грань закладной, type rigel_ceiling} — производное редактора (calc()/Room.patch при restore), в записи MCP не пишется. Закладная: {id, id_room, p1/p2 (link к стене), width, ceiling_type, polygon}. Координаты — та же синтетическая комната 10..390 × 10..310, ID — zd1/rg1/v1/v2/room1/wall1..4; длина пересчитана по синтетическим координатам.",
    body: { room: roomBlock(), rigels: { rg1: remapRigel(rgRec) }, zone_delimiters: { zd1: remapDelimiter(rec, "zd1") } },
  });
}

for (const f of fixtures) {
  const anon = anonymizeEditorIds(f.body, "id");
  const out = { _source: f.source, ...anon.data as Record<string, unknown> };
  writeFileSync(`tests/fixtures/${f.file}`, JSON.stringify(out, null, 1) + "\n");
  console.log(f.file, "→ id map:", [...anon.map.entries()].map(([k, v]) => `${k}→${v}`).join(", "));
}
console.log("готово:", fixtures.length, "фикстур; WALL_PID:", JSON.stringify(WALL_PID));
