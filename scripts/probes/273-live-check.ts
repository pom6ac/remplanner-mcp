// 273: живая проверка тёплой стены в dev-проекте из env (REMPLANNER_PROBE_OBJECT_ID,
// REMPLANNER_PROBE_PLAN_ID, REMPLANNER_PROBE_READONLY_ID, REMPLANNER_PROBE_READONLY_PLAN,
// REMPLANNER_PROBE_BACKUP). Полная цепочка MCP:
// room_add_rect ×2 → item_add socket_thermo → save#1 →
// warm_wall_add (ребро верхней стены комнаты 1) → wiring_add warm_floor_wire
// (терморегулятор → тёплая стена) → save#2 (verified) → reopen → сверка по GET
// (site_id: part в rooms2.warms_walls, ссылка props части ↔ кабель, вершина
// warm_wall = центр линии) → warm_wall_update → save#3 → split (wall_split +
// перегородка) → save#4 → wall_update (перенос стены) → save#5 → merge
// (wall_delete перегородки) → save#6 → render_plan PNG → очистка по захваченным
// site_id → save#7 → сверка data с бэкапом. Контрольный проект — GET до/после.
// Запуск: node --experimental-strip-types scripts/probes/273-live-check.ts run
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadModel } from "../../src/api.ts";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";

if (process.argv[2] !== "run") {
  console.error("запуск по явному аргументу run (ID из env)");
  process.exit(0);
}
const OBJECT_ID = process.env["REMPLANNER_PROBE_OBJECT_ID"];
const PLAN_ID = process.env["REMPLANNER_PROBE_PLAN_ID"];
const READONLY_ID = process.env["REMPLANNER_PROBE_READONLY_ID"];
const READONLY_PLAN = process.env["REMPLANNER_PROBE_READONLY_PLAN"];
if (!OBJECT_ID || !PLAN_ID || !READONLY_ID || !READONLY_PLAN) {
  console.error("нужны REMPLANNER_PROBE_OBJECT_ID, REMPLANNER_PROBE_PLAN_ID, REMPLANNER_PROBE_READONLY_ID, REMPLANNER_PROBE_READONLY_PLAN");
  process.exit(1);
}
if (OBJECT_ID === READONLY_ID) {
  console.error("OBJECT_ID === READONLY_ID — отказ до любой записи");
  process.exit(1);
}
const OUT = ".orca-reports/tmp";
mkdirSync(OUT, { recursive: true });
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 20 * 60_000).unref();

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "273-live-check", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);

type ToolCallResult = { isError?: boolean; content?: { type: string; text?: string }[] };
const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const res = (await client.callTool({ name, arguments: args })) as ToolCallResult;
  if (res.isError) throw new Error(`${name}: ${(res.content ?? []).map((c) => c.text ?? "").join("").slice(0, 500)}`);
  return JSON.parse((res.content ?? []).find((c) => typeof c.text === "string")?.text ?? "{}") as Record<string, unknown>;
};
const entitySiteId = (res: Record<string, unknown>, what: string): string => {
  const e = res["entity"] as { site_id?: string } | undefined;
  if (!e?.site_id) throw new Error(`в ответе нет entity.site_id (${what}): ${JSON.stringify(res).slice(0, 200)}`);
  return e.site_id;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pause = () => sleep(6000);

const backupPath = process.env["REMPLANNER_PROBE_BACKUP"];
if (!backupPath) { console.error("нужен REMPLANNER_PROBE_BACKUP"); process.exit(1); }
const backup = JSON.parse(readFileSync(backupPath, "utf8"));
const strip = (m: unknown) => {
  const c = structuredClone(m as Record<string, unknown>);
  delete c.save_id; delete c.log_plan; delete c.session; delete c.version;
  return JSON.stringify(c);
};
type Raw = { model: Record<string, Record<string, Record<string, unknown>>> };
const rawGet = async (tag: string): Promise<Raw> => {
  const m = (await loadModel(ctx.session(), OBJECT_ID, PLAN_ID)) as unknown as Raw;
  writeFileSync(`${OUT}/273-get-own-${tag}.json`, JSON.stringify(m, null, 1) + "\n");
  return m;
};

const created = {
  items: [] as string[],
  walls: [] as string[],
  warm_walls: [] as { site_id: string; room_id: string; edge: number }[],
  wiring: [] as { coll: string; site_id: string }[],
};
const CREATED_FILE = `${OUT}/273-created.json`;
const writeCreated = (): void => {
  writeFileSync(CREATED_FILE, JSON.stringify(created, null, 1) + "\n");
};

const roBefore = await loadModel(ctx.session(), READONLY_ID, READONLY_PLAN);
writeFileSync(`${OUT}/273-get-readonly-before.json`, JSON.stringify(roBefore, null, 1) + "\n");

const cleanupCreated = async (): Promise<void> => {
  await deleteBySite(created.wiring, "wiring_delete", "wiring_id");
  // тёплые стены: метка резолвится из свежей рабочей модели по site_id (warm_wall_list)
  for (const w of [...created.warm_walls].reverse()) {
    const listRes = (await call("warm_wall_list", {})) as unknown as { warm_walls?: Array<{ id: string; label: string; room_id: string }> };
    const found = (listRes.warm_walls ?? []).find((x) => x.id === w.site_id || x.room_id === w.room_id);
    if (!found) { console.log(`пропуск: тёплая стена ${w.site_id} не найдена — ничего не удалено`); continue; }
    await call("warm_wall_delete", { warm_wall_id: found.label });
  }
  await deleteBySite(created.items, "item_delete", "item_id");
  await deleteBySite(created.walls, "wall_delete", "wall_id");
  writeCreated();
};
const deleteBySite = async (entries: (string | { coll: string; site_id: string })[], tool: string, arg: string): Promise<void> => {
  for (const entry of [...entries].reverse()) {
    const coll = typeof entry === "string" ? guessColl(tool) : entry.coll;
    const siteId = typeof entry === "string" ? entry : entry.site_id;
    const mgNow = (await call("model_get", {})) as unknown as Record<string, Array<{ id?: string; site_id?: string }>>;
    const found = (mgNow[coll] ?? []).find((o) => o.site_id === siteId);
    if (!found?.id) { console.log(`пропуск: ${coll} ${siteId} не найден в рабочей модели — ничего не удалено`); continue; }
    await call(tool, { [arg]: found.id });
  }
};
const guessColl = (tool: string): string =>
  tool === "wiring_delete" ? "cables_warm_floor" : tool === "item_delete" ? "items" : "walls";

let failed: Error | null = null;
let readonlyUnchanged = false;

try {
  const ownNow = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  if (strip(ownNow.model) !== strip(backup.model)) throw new Error("dev-проект изменился с момента бэкапа — стоп");
  console.log("бэкап актуален, контрольный GET OK");

  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const wallsFull0 = (await call("model_get", {})) as unknown as { walls: { site_id: string; from: [number, number]; to: [number, number] }[] };
  const wallsBefore = new Set(wallsFull0.walls.map((w) => w.site_id));
  const maxX = Math.max(...wallsFull0.walls.flatMap((w) => [w.from[0], w.to[0]]));
  const ox = maxX + 1500;
  const oy = 0;

  // 1. две пробные комнаты + терморегулятор
  await call("room_add_rect", { origin: { x: ox, y: oy }, width: 4000, depth: 3000, wall_thickness: 200 });
  await call("room_add_rect", { origin: { x: ox + 4400, y: oy }, width: 4000, depth: 3000, wall_thickness: 200 });
  const wallsFull1 = (await call("model_get", {})) as unknown as { walls: { site_id: string; from: [number, number]; to: [number, number] }[] };
  const newWalls = wallsFull1.walls.filter((w) => !wallsBefore.has(w.site_id));
  created.walls = newWalls.map((w) => w.site_id);
  const topWall = newWalls.filter((w) => w.from[1] === w.to[1]).sort((x, y) => x.from[1] - y.from[1])[0]!;
  console.log("room walls (site_id):", created.walls.join(" "), "top:", topWall.site_id);
  await call("item_add", { name: "socket_thermo", position: { against_wall: { wall_id: topWall.site_id, offset_mm: 1000 } } });
  await pause();
  const s1 = await call("project_save", {});
  console.log("save#1 (комнаты+терморегулятор):", JSON.stringify(s1).slice(0, 200));
  if (s1["verified"] !== true) throw new Error("save#1 не verified");

  // 2. тёплая стена на верхнем ребре комнаты 1 (индекс ребра — из сырой модели)
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const base1 = (await rawGet("rooms")).model;
  const inZoneRoom = (rid: string): boolean => {
    const poly = ((base1.rooms2 ?? base1.rooms1 ?? {})[rid] as { polygon?: { x: number; y: number }[] } | undefined)?.polygon;
    if (!poly || poly.length === 0) return false;
    return Math.min(...poly.map((p) => p.x)) > ox / 10 - 60;
  };
  const trialRid = Object.keys(base1.rooms2 ?? base1.rooms1 ?? {}).find(inZoneRoom);
  if (!trialRid) throw new Error("пробная комната не найдена в rooms2");
  const trialRoom = (base1.rooms2 ?? base1.rooms1 ?? {})[trialRid] as { polygon: { x: number; y: number }[]; edges?: { p1: { x: number; y: number }; p2: { x: number; y: number } }[]; warms_walls?: unknown[] };
  const edges = trialRoom.edges ?? [];
  if (edges.length === 0) throw new Error("у пробной комнаты нет edges");
  const minY = Math.min(...edges.map((e) => e.p1.y));
  const topEdge = edges.findIndex((e) => e.p1.y === e.p2.y && e.p1.y === minY);
  if (topEdge < 0) throw new Error("верхнее ребро не найдено");
  console.log(`пробная комната ${trialRid}: edges=${edges.length}, верхнее ребро index=${topEdge}, warms_walls=${Array.isArray(trialRoom.warms_walls) ? trialRoom.warms_walls.length : "нет"}`);
  const topFrom = Math.min(topWall.from[0], topWall.to[0]);
  const wwStart = 2000, wwEnd = 3200; // мм от начала ребра (ребро = верхняя стена)
  const wwRes = await call("warm_wall_add", { room_id: trialRid, edge: topEdge, start_mm: wwStart, end_mm: wwEnd });
  const wwId = (wwRes["id"] as string) ?? "";
  if (!wwId) throw new Error(`warm_wall_add: нет id: ${JSON.stringify(wwRes).slice(0, 200)}`);
  created.warm_walls.push({ site_id: wwId, room_id: trialRid, edge: topEdge });
  writeCreated();
  console.log("warm_wall_add:", wwId, JSON.stringify(wwRes));

  // 3. терморегулятор → тёплая стена (кабель warm_floor_wire);
  // терморегулятор резолвится по site_id из сырой модели (items[0] — чужой предмет)
  const raw1 = await rawGet("before-wire");
  const thermoSite1 = Object.entries(raw1.model.items ?? {}).find(([, v]) => {
    const it = v as { name?: string; socket_group?: Array<{ name?: string }>; pc?: { x: number } };
    return it.pc !== undefined && it.pc.x > ox / 10 - 60 && it.name === "socket_group" && Array.isArray(it.socket_group) && it.socket_group.some((s) => s.name === "socket_thermo");
  })?.[0];
  if (!thermoSite1) throw new Error("терморегулятор не найден в зоне пробы");
  const thermoMg = (await call("model_get", {})) as unknown as { items: Array<{ id: string; site_id?: string }> };
  const thermoLabel = (thermoMg.items ?? []).find((o) => o.site_id === thermoSite1)?.id;
  if (!thermoLabel) throw new Error(`метка терморегулятора ${thermoSite1} не найдена в model_get`);
  created.items = [thermoSite1];
  writeCreated();
  const wireRes = await call("wiring_add", { kind: "warm_floor_wire", path: [{ item_id: thermoLabel }, { item_id: wwId }] });
  const wireSite = entitySiteId(wireRes, "wiring_add");
  created.wiring.push({ coll: "cables_warm_floor", site_id: wireSite });
  writeCreated();
  console.log("wiring_add:", wireSite, JSON.stringify(wireRes).slice(0, 300));

  const v1 = await call("model_validate", {});
  console.log("validate:", JSON.stringify(v1).slice(0, 200));
  await pause();
  const s2 = await call("project_save", {});
  console.log("save#2 (тёплая стена+кабель):", JSON.stringify(s2).slice(0, 240));
  if (s2["verified"] !== true) throw new Error("save#2 не verified");

  // 4. reopen + сверка по GET
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const after2 = await rawGet("after-save2");
  const model2 = after2.model;
  const rooms2 = (model2.rooms2 ?? {}) as Record<string, { polygon?: { x: number; y: number }[]; edges?: { p1: { x: number; y: number }; p2: { x: number; y: number } }[]; warms_walls?: Array<{ exist?: boolean; parts?: Record<string, Record<string, unknown>> }> }>;
  const rid2 = Object.keys(rooms2).find(inZoneRoom);
  if (rid2 === undefined) throw new Error("пробная комната потеряна после save#2");
  const foundParts: Record<string, Record<string, unknown>> = {};
  for (const [rid, room] of Object.entries(rooms2)) {
    for (const g of room.warms_walls ?? []) {
      for (const [pid, part] of Object.entries(g.parts ?? {})) foundParts[pid] = part;
    }
  }
  const partEntry = Object.entries(foundParts).find(([, p]) => String((p as { props?: { id?: string } }).props?.id ?? "") === wwId || String(p.id ?? "") === wwId);
  if (!partEntry) throw new Error(`тёплая стена ${wwId} не найдена в rooms2 после save#2: ${JSON.stringify(Object.keys(foundParts))}`);
  const part = partEntry[1] as { id: string; type: string; line: { p1: { x: number; y: number }; p2: { x: number; y: number } }; height: number; height_from_floor: number; props?: { cables_warm_floor?: { cable_warm_floor_id?: string } } };
  console.log("part после save#2:", JSON.stringify({ id: part.id, type: part.type, line: part.line, height: part.height, hff: part.height_from_floor, props: part.props }));
  if (part.id !== wwId) throw new Error(`id части изменился: ${part.id} != ${wwId}`);
  if (part.props?.cables_warm_floor?.cable_warm_floor_id !== wireSite) throw new Error(`часть потеряла ссылку на кабель: ${JSON.stringify(part.props ?? null)}`);
  const wire2 = ((model2.cables_warm_floor ?? {})[wireSite] ?? {}) as { vertexes?: { id: string; point: { x: number; y: number }; type: string; pp?: unknown }[]; items?: Record<string, string>; type?: string };
  const wwp = wire2.vertexes?.find((v) => v.type === "warm_wall");
  if (!wwp || wwp.id !== part.id) throw new Error(`у кабеля нет вершины тёплой стены: ${JSON.stringify(wire2.vertexes ?? null)}`);
  const center = { x: Math.round(((part.line.p1.x + part.line.p2.x) / 2) * 100) / 100, y: Math.round(((part.line.p1.y + part.line.p2.y) / 2) * 100) / 100 };
  if (Math.abs(wwp.point.x - center.x) > 0.11 || Math.abs(wwp.point.y - center.y) > 0.11) {
    throw new Error(`вершина warm_wall != центр линии: ${JSON.stringify(wwp.point)} vs ${JSON.stringify(center)}`);
  }
  if (wire2.items?.[part.id] !== "warm_wall") throw new Error(`items вершины тёплой стены: ${JSON.stringify(wire2.items ?? null)}`);
  // терморегулятор: ссылка под-розетки
  const thermoSite = Object.entries(model2.items ?? {}).find(([, v]) => {
    const it = v as { name?: string; socket_group?: Array<{ name?: string }>; pc?: { x: number } };
    return it.pc !== undefined && it.pc.x > ox / 10 - 60 && it.name === "socket_group" && Array.isArray(it.socket_group) && it.socket_group.some((s) => s.name === "socket_thermo");
  })?.[0];
  if (!thermoSite) throw new Error("терморегулятор не найден в зоне пробы");
  created.items = [thermoSite];
  writeCreated();
  const thermoIt = model2.items![thermoSite] as { socket_group?: Array<{ name?: string; cables_warm_floor?: { cable_warm_floor_id?: string } }> };
  const sub = thermoIt.socket_group?.find((s) => s.name === "socket_thermo");
  if (sub?.cables_warm_floor?.cable_warm_floor_id !== wireSite) throw new Error(`терморегулятор потерял cable_warm_floor_id: ${JSON.stringify(sub ?? null)}`);
  console.log("ссылки после reopen: часть↔кабель (props части), терморегулятор↔кабель, вершина warm_wall = центр линии — OK");

  // 5. warm_wall_update: границы и высоты; вершина кабеля следует
  await call("warm_wall_update", { warm_wall_id: wwId, start_mm: 2200, end_mm: 3600, height_mm: 1200, height_from_floor_mm: 100 });
  await pause();
  const s3 = await call("project_save", {});
  console.log("save#3 (warm_wall_update):", JSON.stringify(s3).slice(0, 240));
  if (s3["verified"] !== true) throw new Error("save#3 не verified");
  const after3 = await rawGet("after-update");
  const part3 = findPartIn(after3.model, wwId);
  if (!part3) throw new Error("тёплая стена потеряна после update");
  const wire3 = ((after3.model.cables_warm_floor ?? {})[wireSite] ?? {}) as { vertexes?: { id: string; point: { x: number; y: number }; type: string }[] };
  const wwp3 = wire3.vertexes?.find((v) => v.type === "warm_wall");
  const center3 = { x: Math.round(((part3.line.p1.x + part3.line.p2.x) / 2) * 100) / 100, y: Math.round(((part3.line.p1.y + part3.line.p2.y) / 2) * 100) / 100 };
  if (!wwp3 || Math.abs(wwp3.point.x - center3.x) > 0.11 || Math.abs(wwp3.point.y - center3.y) > 0.11) {
    throw new Error(`после update вершина != центр линии: ${JSON.stringify(wwp3?.point)} vs ${JSON.stringify(center3)}`);
  }
  if (part3.height !== 120 || part3.height_from_floor !== 10) throw new Error(`высоты после update: ${part3.height}/${part3.height_from_floor}`);
  console.log("warm_wall_update: линия/высоты обновлены, вершина кабеля = новый центр — OK");

  // 6. split: разрез верхней/нижней стен ПРАВЕЕ тёплой стены (граница ox+3600+200) + перегородка
  const sx = ox + 3900;
  const knownWalls = (): Set<string> => new Set([...wallsBefore, ...created.walls]);
  const captureNewWalls = async (): Promise<void> => {
    const mgNow = (await call("model_get", {})) as unknown as { walls: { site_id?: string }[] };
    const known = knownWalls();
    for (const w of mgNow.walls) {
      if (w.site_id && !known.has(w.site_id)) created.walls.push(w.site_id);
    }
    writeCreated();
  };
  await call("wall_split", { wall_id: topWall.site_id, at_mm: sx - topFrom });
  await captureNewWalls();
  const mg2 = (await call("model_get", {})) as unknown as { walls: { site_id: string; from: [number, number]; to: [number, number] }[] };
  const bottom = mg2.walls
    .filter((w) => w.from[1] === w.to[1] && created.walls.includes(w.site_id) && w.site_id !== topWall.site_id)
    .sort((x, y) => y.from[1] - x.from[1])[0]!;
  const bottomFrom = Math.min(bottom.from[0], bottom.to[0]);
  await call("wall_split", { wall_id: bottom.site_id, at_mm: sx - bottomFrom });
  await captureNewWalls();
  const partRes = await call("wall_add", { kind: "partition", start: { x: sx, y: topWall.from[1] }, end: { x: sx, y: bottom.from[1] }, thickness_mm: 100 });
  const partSite = (partRes["entity"] as { site_id?: string })?.site_id ?? (partRes["entity"] as { walls?: { site_id?: string }[] })?.walls?.[0]?.site_id;
  if (!partSite) throw new Error(`wall_add: нет site_id: ${JSON.stringify(partRes).slice(0, 200)}`);
  created.walls.push(partSite);
  await pause();
  const s4 = await call("project_save", {});
  console.log("save#4 (split):", JSON.stringify(s4).slice(0, 240));
  if (s4["verified"] !== true) throw new Error("save#4 (split) не verified");
  const after4 = await rawGet("after-split");
  const part4 = findPartIn(after4.model, wwId) ?? findPartByGeometry(after4.model, part3);
  if (!part4) throw new Error("тёплая стена потеряна после split (ни по id, ни по геометрии)");
  if (part4.props?.cables_warm_floor?.cable_warm_floor_id !== wireSite) throw new Error(`после split часть потеряла ссылку на кабель: ${JSON.stringify(part4.props ?? null)}`);
  const wire4 = ((after4.model.cables_warm_floor ?? {})[wireSite] ?? {}) as { vertexes?: { id: string; type: string }[] };
  const wwp4 = wire4.vertexes?.find((v) => v.type === "warm_wall");
  if (!wwp4 || wwp4.id !== part4.id) throw new Error(`после split кабель не ссылается на часть: ${JSON.stringify(wire4.vertexes ?? null)} vs ${part4.id}`);
  console.log(`после split: часть ${part4.id === wwId ? "сохранила id" : `пересоздана (${wwId} → ${part4.id}, миграция id_old)`}, ссылка и вершина кабеля целы`);

  // 7. перенос стены: нижняя стена пробной комнаты вниз на 200 мм (wall_update)
  const mg5 = (await call("model_get", {})) as unknown as { walls: { id: string; site_id: string; from: [number, number]; to: [number, number] }[] };
  const bottomNow = mg5.walls.find((w) => w.site_id === bottom.site_id)!;
  await call("wall_update", { wall_id: bottomNow.id, to: { x: bottomNow.to[0], y: bottomNow.to[1] + 200 } });
  await pause();
  const s5 = await call("project_save", {});
  console.log("save#5 (перенос стены):", JSON.stringify(s5).slice(0, 240));
  if (s5["verified"] !== true) throw new Error("save#5 (перенос) не verified");
  const after5 = await rawGet("after-wall-move");
  const part5 = findPartIn(after5.model, wwId) ?? findPartIn(after5.model, part4.id);
  if (!part5) throw new Error("тёплая стена потеряна после переноса стены");
  if (part5.props?.cables_warm_floor?.cable_warm_floor_id !== wireSite) throw new Error("после переноса стены часть потеряла ссылку на кабель");
  console.log("после переноса стены: тёплая стена и ссылка целы");

  // 8. merge — удаление перегородки
  await call("wall_delete", { wall_id: partSite });
  created.walls = created.walls.filter((w) => w !== partSite);
  await pause();
  const s6 = await call("project_save", {});
  console.log("save#6 (merge):", JSON.stringify(s6).slice(0, 240));
  if (s6["verified"] !== true) throw new Error("save#6 (merge) не verified");
  const after6 = await rawGet("after-merge");
  const part6 = findPartIn(after6.model, wwId) ?? findPartIn(after6.model, part4.id) ?? findPartByGeometry(after6.model, part5);
  if (!part6) throw new Error("тёплая стена потеряна после merge");
  if (part6.props?.cables_warm_floor?.cable_warm_floor_id !== wireSite) throw new Error("после merge часть потеряла ссылку на кабель");
  console.log("после merge: тёплая стена и ссылка целы");

  // 9. render PNG
  const png = await call("render_plan", { sheet: "warm_floor" });
  console.log("render:", (png["path"] as string) ?? JSON.stringify(png).slice(0, 160));
} catch (e) {
  failed = e as Error;
  console.error("FAIL:", failed.message);
} finally {
  try {
    if (failed) {
      try { await call("project_save", {}); } catch { /* проект мог не открыться */ }
    }
    await pause();
    await cleanupCreated();
    await pause();
    const s7 = await call("project_save", {});
    console.log("save#7 (очистка):", JSON.stringify(s7).slice(0, 240));
    if (s7["verified"] !== true) throw new Error("save#7 (очистка) не verified");
    if (!failed) {
      const rawLeft = ((await loadModel(ctx.session(), OBJECT_ID, PLAN_ID)) as unknown as Raw).model;
      const leftoverPairs: [string, string][] = [
        ...created.wiring.map((w) => [w.coll, w.site_id] as [string, string]),
        ...created.items.map((s) => ["items", s] as [string, string]),
        ...created.walls.map((s) => ["walls", s] as [string, string]),
      ];
      const leftovers = leftoverPairs.filter(([coll, s]) => Object.keys(rawLeft[coll] ?? {}).includes(s));
      const wwLeft = Object.values(rawLeft.rooms2 ?? {}).some((r) =>
        Object.values((r as { warms_walls?: Array<{ parts?: Record<string, unknown> }> }).warms_walls ?? []).some((g) => Object.keys(g.parts ?? {}).some((pid) => created.warm_walls.some((w) => w.site_id === pid))),
      );
      if (leftovers.length > 0 || wwLeft) throw new Error(`очистка неполна: ${leftovers.map(([c, s]) => `${c}:${s}`).join(", ")}${wwLeft ? " + warms_walls" : ""}`);
    } else {
      console.error("cleanup после сбоя выполнен");
    }
  } catch (ce) {
    console.error("cleanup не удался (объекты в 273-created.json):", (ce as Error).message);
    writeCreated();
  }
  try {
    const ro = await loadModel(ctx.session(), READONLY_ID, READONLY_PLAN);
    writeFileSync(`${OUT}/273-get-readonly-${failed ? "after-fail" : "after"}.json`, JSON.stringify(ro, null, 1) + "\n");
    const roSame = strip(ro.model) === strip(roBefore.model);
    console.log(failed ? "контрольный проект после сбоя" : "контрольный проект", "не изменился:", roSame ? "OK" : "ИЗМЕНИЛСЯ");
    readonlyUnchanged = roSame;
  } catch (ce) {
    console.error("контрольный GET после прогона не удался:", (ce as Error).message);
  }
  await closeBrowser().catch(() => {});
}

const ownAfter = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
writeFileSync(`${OUT}/273-get-own-after.json`, JSON.stringify(ownAfter, null, 1) + "\n");
const same = strip(ownAfter.model) === strip(backup.model);
console.log("data dev == бэкап:", same ? "OK — восстановлен" : "РАСХОЖДЕНИЕ (сверить производные пути)");
process.exit(failed || !readonlyUnchanged || !same ? 1 : 0);

// ---------- helpers ----------

type PartRec = { id: string; type: string; line: { p1: { x: number; y: number }; p2: { x: number; y: number } }; height: number; height_from_floor: number; props?: { cables_warm_floor?: { cable_warm_floor_id?: string } } };

function allParts(model: Raw["model"]): Array<{ roomId: string; id: string; part: PartRec }> {
  const rooms2 = (model.rooms2 ?? model.rooms1 ?? {}) as Record<string, { warms_walls?: Array<{ parts?: Record<string, Record<string, unknown>> }> }>;
  const out: Array<{ roomId: string; id: string; part: PartRec }> = [];
  for (const [rid, room] of Object.entries(rooms2)) {
    for (const g of room.warms_walls ?? []) {
      for (const [pid, raw] of Object.entries(g.parts ?? {})) {
        out.push({ roomId: rid, id: pid, part: raw as unknown as PartRec });
      }
    }
  }
  return out;
}

function findPartIn(model: Raw["model"], partId: string): PartRec | null {
  return allParts(model).find((p) => p.id === partId)?.part ?? null;
}

function findPartByGeometry(model: Raw["model"], ref: PartRec): PartRec | null {
  const hit = allParts(model).find((p) =>
    p.part.type === ref.type
    && Math.abs(p.part.line.p1.x - ref.line.p1.x) <= 0.51 && Math.abs(p.part.line.p1.y - ref.line.p1.y) <= 0.51
    && Math.abs(p.part.line.p2.x - ref.line.p2.x) <= 0.51 && Math.abs(p.part.line.p2.y - ref.line.p2.y) <= 0.51);
  return hit?.part ?? null;
}
