// 268: живая проверка климата ч.3 в dev-проекте из env (REMPLANNER_PROBE_OBJECT_ID,
// REMPLANNER_PROBE_PLAN_ID, REMPLANNER_PROBE_READONLY_ID). Полная цепочка MCP:
// room_add_rect ×2 → item_add (socket_thermo, коллекторные узлы radiator_collector/
// ext_manifold_box/int_manifold_box) → warm_floor_add cable + water →
// wiring_add warm_floor_wire (терморегулятор → кабельный контур) →
// pipe_add warm_floor (водяной контур → коллектор) → model_validate →
// project_save (verified) → reopen → сверка ссылок по GET (site_id) →
// warm_floor_update (вершина-контур кабеля следует) → save → split/merge →
// render_plan PNG → очистка по захваченным site_id → save → сверка data с бэкапом.
// Контрольный проект — GET до/после. Запуск: node --experimental-strip-types scripts/probes/268-live-check.ts run
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
if (!READONLY_PLAN) {
  console.error("нужен REMPLANNER_PROBE_READONLY_PLAN (план контрольного проекта)");
  process.exit(1);
}
if (!OBJECT_ID || !PLAN_ID || !READONLY_ID) {
  console.error("нужны REMPLANNER_PROBE_OBJECT_ID, REMPLANNER_PROBE_PLAN_ID, REMPLANNER_PROBE_READONLY_ID");
  process.exit(1);
}
if (OBJECT_ID === READONLY_ID) {
  console.error("OBJECT_ID === READONLY_ID — отказ до любой записи");
  process.exit(1);
}
const OUT = ".orca-reports/tmp";
mkdirSync(OUT, { recursive: true });
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 14 * 60_000).unref();

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "268-live-check", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);

const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const res = await client.callTool({ name, arguments: args });
  if ((res as { isError?: boolean }).isError) throw new Error(`${name}: ${res.content?.map((c) => ("text" in c ? c.text : "")).join("")?.slice(0, 500)}`);
  return JSON.parse(res.content?.find((c) => "text" in c)?.text ?? "{}") as Record<string, unknown>;
};
const entitySiteId = (res: Record<string, unknown>, what: string): string => {
  const e = res["entity"] as { site_id?: string } | undefined;
  if (!e?.site_id) throw new Error(`в ответе нет entity.site_id (${what}): ${JSON.stringify(res).slice(0, 200)}`);
  return e.site_id;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pause = () => sleep(6000);

const backupPath = process.env["REMPLANNER_PROBE_BACKUP"];
if (!backupPath) {
  console.error("нужен REMPLANNER_PROBE_BACKUP (путь к бэкапу dev-проекта перед прогоном)");
  process.exit(1);
}
const backup = JSON.parse(readFileSync(backupPath, "utf8"));
const strip = (m: unknown) => {
  const c = structuredClone(m as Record<string, unknown>);
  delete c.save_id; delete c.log_plan; delete c.session; delete c.version;
  return JSON.stringify(c);
};
type Raw = { model: Record<string, Record<string, Record<string, unknown>>> };
const rawGet = async (tag: string): Promise<Raw> => {
  const m = (await loadModel(ctx.session(), OBJECT_ID, PLAN_ID)) as unknown as Raw;
  writeFileSync(`${OUT}/268-get-own-${tag}.json`, JSON.stringify(m, null, 1) + "\n");
  return m;
};

const created = {
  items: [] as string[],
  walls: [] as string[],
  warm_floors: [] as string[],
  pipes: [] as { coll: string; site_id: string }[],
  wiring: [] as { coll: string; site_id: string }[],
};
const CREATED_FILE = `${OUT}/268-created.json`;
const writeCreated = (): void => {
  writeFileSync(CREATED_FILE, JSON.stringify(created, null, 1) + "\n");
};

const roBefore = await loadModel(ctx.session(), READONLY_ID, READONLY_PLAN);
writeFileSync(`${OUT}/268-get-readonly-before.json`, JSON.stringify(roBefore, null, 1) + "\n");

const deleteCreated = async (entries: { coll: string; site_id: string }[], tool: string, arg: string): Promise<number> => {
  let n = 0;
  for (const { coll, site_id } of [...entries].reverse()) {
    if (coll === "items") {
      const raw = ((await loadModel(ctx.session(), OBJECT_ID, PLAN_ID)) as unknown as Raw).model;
      const idx = Object.keys(raw.items ?? {}).indexOf(site_id);
      if (idx < 0) {
        console.log(`пропуск: item ${site_id} не найден в свежей модели — ничего не удалено`);
        continue;
      }
      await call(tool, { [arg]: `I${idx + 1}` });
    } else {
      const mgNow = (await call("model_get", {})) as unknown as Record<string, { id?: string; site_id?: string }[]>;
      const found = (mgNow[coll] ?? []).find((o) => o.site_id === site_id);
      if (!found?.id) {
        console.log(`пропуск: ${coll} ${site_id} не найден в свежей модели — ничего не удалено`);
        continue;
      }
      await call(tool, { [arg]: found.id });
    }
    n++;
  }
  return n;
};
const PIPE_COLLS = ["pipes_warm_floor"] as const;
const cleanupCreated = async (): Promise<void> => {
  await deleteCreated(created.wiring.map((w) => ({ coll: w.coll, site_id: w.site_id })), "wiring_delete", "wiring_id");
  for (const coll of PIPE_COLLS) {
    await deleteCreated(created.pipes.filter((p) => p.coll === coll), "pipe_delete", "pipe_id");
  }
  await deleteCreated(created.warm_floors.map((site_id) => ({ coll: "warm_floors", site_id })), "warm_floor_delete", "warm_floor_id");
  await deleteCreated(created.items.map((site_id) => ({ coll: "items", site_id })), "item_delete", "item_id");
  await deleteCreated(created.walls.map((site_id) => ({ coll: "walls", site_id })), "wall_delete", "wall_id");
  writeCreated();
};

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

  // 1. две пробные комнаты (во второй — водяной контур)
  await call("room_add_rect", { origin: { x: ox, y: oy }, width: 4000, depth: 3000, wall_thickness: 200 });
  await call("room_add_rect", { origin: { x: ox + 4400, y: oy }, width: 4000, depth: 3000, wall_thickness: 200 });
  const wallsFull1 = (await call("model_get", {})) as unknown as { walls: { site_id: string; from: [number, number]; to: [number, number] }[] };
  const newWalls = wallsFull1.walls.filter((w) => !wallsBefore.has(w.site_id));
  created.walls = newWalls.map((w) => w.site_id);
  const topWall = newWalls.filter((w) => w.from[1] === w.to[1]).sort((x, y) => x.from[1] - y.from[1])[0]!;
  console.log("room walls (site_id):", created.walls.join(" "), "top:", topWall.site_id);

  // 2. терморегулятор + коллекторные узлы (климат ч.3: item_add against_wall)
  const thermoLabel = ((await call("item_add", { name: "socket_thermo", position: { against_wall: { wall_id: topWall.site_id, offset_mm: 1000 } } }))["entity"] as { id: string }).id;
  const colLabel = ((await call("item_add", { name: "radiator_collector", position: { against_wall: { wall_id: topWall.site_id, offset_mm: 2200 } } }))["entity"] as { id: string }).id;
  const extLabel = ((await call("item_add", { name: "ext_manifold_box", position: { against_wall: { wall_id: topWall.site_id, offset_mm: 2800 } } }))["entity"] as { id: string }).id;
  const intLabel = ((await call("item_add", { name: "int_manifold_box", position: { against_wall: { wall_id: topWall.site_id, offset_mm: 3400 } } }))["entity"] as { id: string }).id;
  console.log("items добавлены:", thermoLabel, colLabel, extLabel, intLabel);

  // 3. контуры: кабельный (комната 1) и водяной (комната 2)
  const wfc = entitySiteId(await call("warm_floor_add", { kind: "cable", corner1: { x: ox + 500, y: 500 }, corner2: { x: ox + 1500, y: 1500 } }), "warm_floor_add cable");
  const wfw = entitySiteId(await call("warm_floor_add", { kind: "water", corner1: { x: ox + 4500, y: 500 }, corner2: { x: ox + 5500, y: 1500 } }), "warm_floor_add water");
  created.warm_floors = [wfc, wfw];
  writeCreated();
  console.log("контуры:", wfc, wfw);

  // 4. кабель тёплого пола: терморегулятор → кабельный контур (климат ч.3)
  created.wiring.push({ coll: "cables_warm_floor", site_id: entitySiteId(await call("wiring_add", { kind: "warm_floor_wire", path: [{ item_id: thermoLabel }, { item_id: wfc }] }), "wiring_add warm_floor_wire") });
  // магистраль тёплого пола: водяной контур → коллекторный узел (multi)
  created.pipes.push({ coll: "pipes_warm_floor", site_id: entitySiteId(await call("pipe_add", { kind: "warm_floor", path: [{ item_id: wfw }, { item_id: colLabel }] }), "pipe_add warm_floor") });
  console.log("wiring:", JSON.stringify(created.wiring), "pipes:", JSON.stringify(created.pipes));

  // 5. validate → save
  const v1 = await call("model_validate", {});
  console.log("validate:", JSON.stringify(v1).slice(0, 240));
  await pause();
  const s1 = await call("project_save", {});
  console.log("save#1:", JSON.stringify(s1).slice(0, 240));
  if (s1["verified"] !== true) throw new Error("save#1 не verified");

  // 6. reopen + сверка по GET
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const after1 = await rawGet("after-save1");
  const model1 = after1.model;
  const counts = (coll: string): number => Object.keys(model1[coll] ?? {}).length;
  console.log("после save+GET: cables_warm_floor", counts("cables_warm_floor"), "pipes_warm_floor", counts("pipes_warm_floor"), "warm_floors", counts("warm_floors"));
  if (counts("cables_warm_floor") < 1 || counts("pipes_warm_floor") < 1) throw new Error("коллекции климата ч.3 неполны после reopen");
  // site_id предметов — из сырой модели после save (item_add попадает на сервер
  // только с project_save), зона пробы x > ox - 600; терморегулятор пишется
  // группой socket_group с под-розеткой socket_thermo
  // pc предметов — в см модели, ox — в мм публичного API: зона в см
  const inZone = (v: Record<string, unknown>): boolean =>
    (v as { pc?: { x: number } }).pc !== undefined && (v as { pc: { x: number } }).pc.x > ox / 10 - 60;
  const findIn = (rawItems: Raw["model"], name: string): string => {
    const found = Object.entries(rawItems.items ?? {}).find(([, v]) => {
      const it = v as { name?: string; socket_group?: Array<{ name?: string }> };
      if (!inZone(v as Record<string, unknown>)) return false;
      if (it.name === name) return true;
      return name === "socket_thermo" && it.name === "socket_group" && Array.isArray(it.socket_group) && it.socket_group.some((sub) => sub.name === name);
    });
    if (!found) throw new Error(`предмет «${name}» не найден в зоне пробы — site_id не захвачен`);
    return found[0];
  };
  created.items = ["socket_thermo", "radiator_collector", "ext_manifold_box", "int_manifold_box"].map((n) => findIn(model1, n));
  writeCreated(); // ревью 251 №4: список site_id захвачен до рискованных шагов (split/merge)
  console.log("items (site_id):", created.items.join(" "));
  const rawByIdIn = (raw: Raw["model"], coll: string, siteId: string | undefined, what: string): Record<string, unknown> => {
    if (!siteId) throw new Error(`${what}: site_id не захвачен`);
    const o = (raw[coll] ?? {})[siteId] as Record<string, unknown> | undefined;
    if (!o) throw new Error(`${what}: объект ${siteId} не найден после reopen`);
    return o;
  };
  const rawById = (coll: string, siteId: string | undefined, what: string): Record<string, unknown> => rawByIdIn(model1, coll, siteId, what);
  // ссылки после save+reopen: терморегулятор, оба контура, коллектор
  const [thermoSite, , extSite, intSite] = created.items;
  const thermoIt = rawById("items", thermoSite, "терморегулятор") as { socket_group?: Array<{ name?: string } & Record<string, unknown>> };
  const sub = (thermoIt.socket_group ?? []).find((s) => s.name === "socket_thermo") as Record<string, unknown> | undefined;
  if (!sub || (sub.cables_warm_floor as Record<string, unknown> | undefined)?.cable_warm_floor_id !== created.wiring[0]!.site_id) {
    throw new Error(`терморегулятор потерял cable_warm_floor_id: ${JSON.stringify(sub ?? null)}`);
  }
  const wfC = rawById("warm_floors", wfc, "кабельный контур") as { props?: { cables_warm_floor?: { cable_warm_floor_id?: unknown } }; polygon?: { x: number; y: number }[] };
  if (wfC.props?.cables_warm_floor?.cable_warm_floor_id !== created.wiring[0]!.site_id) throw new Error("кабельный контур потерял cable_warm_floor_id");
  const wfW = rawById("warm_floors", wfw, "водяной контур") as { props?: { pipes_warm_floor?: Record<string, unknown> } };
  if (!wfW.props?.pipes_warm_floor?.pipe_warm_floor_id) throw new Error("водяной контур потерял pipe_warm_floor_id");
  const wire = rawById("cables_warm_floor", created.wiring[0]!.site_id, "кабель тёплого пола") as { vertexes?: { id: string; point: { x: number; y: number }; type: string }[]; type?: string; items?: Record<string, string> };
  const wfv = wire.vertexes?.find((v) => v.type === "warm_floor");
  if (!wfv || wfv.id !== wfc) throw new Error("у кабеля нет вершины-контура с id контура");
  if (!wfC.polygon || Math.abs(wfv.point.x - wfC.polygon[0]!.x) > 0.11 || Math.abs(wfv.point.y - wfC.polygon[0]!.y) > 0.11) {
    throw new Error(`вершина-контур != polygon[0]: ${JSON.stringify(wfv?.point)} vs ${JSON.stringify(wfC.polygon?.[0])}`);
  }
  if (wire.items?.[wfc] !== "warm_floor") throw new Error(`items вершины-контура: ${JSON.stringify(wire.items ?? null)}`);
  // коллекторные узлы на месте (site_id), у коллектора — ссылка на магистраль (массив)
  rawById("items", extSite, "коллекторный шкаф внешний");
  rawById("items", intSite, "коллекторный шкаф встроенный");
  const colIt = rawById("items", created.items[1]!, "коллектор") as { pipes_warm_floor?: { pipe_warm_floor_id?: unknown } };
  if (!Array.isArray(colIt.pipes_warm_floor?.pipe_warm_floor_id) || (colIt.pipes_warm_floor!.pipe_warm_floor_id as string[]).length < 1) {
    throw new Error(`коллектор потерял массив pipe_warm_floor_id: ${JSON.stringify(colIt.pipes_warm_floor ?? null)}`);
  }
  console.log("ссылки после reopen: кабель↔контур, водяной контур↔магистраль, коллектор (multi) — OK");

  // 7. warm_floor_update: вершина-контур кабеля следует за новым polygon[0]
  await call("warm_floor_update", { warm_floor_id: wfc, corner1: { x: ox + 700, y: 700 }, corner2: { x: ox + 1700, y: 1700 } });
  await pause();
  const s2 = await call("project_save", {});
  console.log("save#2 (warm_floor_update):", JSON.stringify(s2).slice(0, 240));
  if (s2["verified"] !== true) throw new Error("save#2 не verified");
  const after2 = await rawGet("after-wf-update");
  const wfC2 = rawByIdIn(after2.model, "warm_floors", wfc, "контур после update") as { polygon?: { x: number; y: number }[]; props?: { cables_warm_floor?: Record<string, unknown> } };
  const wire2 = rawByIdIn(after2.model, "cables_warm_floor", created.wiring[0]!.site_id, "кабель после update") as { vertexes?: { id: string; point: { x: number; y: number }; type: string }[] };
  const wfv2 = wire2.vertexes?.find((v) => v.type === "warm_floor");
  if (!wfv2 || !wfC2.polygon || Math.abs(wfv2.point.x - wfC2.polygon[0]!.x) > 0.11 || Math.abs(wfv2.point.y - wfC2.polygon[0]!.y) > 0.11) {
    throw new Error(`после warm_floor_update вершина-контур не polygon[0]: ${JSON.stringify(wfv2?.point)} vs ${JSON.stringify(wfC2.polygon?.[0])}`);
  }
  if (wfC2.props?.cables_warm_floor?.cable_warm_floor_id !== created.wiring[0]!.site_id) throw new Error("после update контур потерял ссылку на кабель");
  console.log("warm_floor_update: вершина-контур кабеля = новый polygon[0], ссылка цела — OK");

  // 8. split: разрез стен пробной комнаты + перегородка правее контура (после update — грань ox+1700)
  const sx = ox + 1900;
  const knownWalls = (): Set<string> => new Set([...wallsBefore, ...created.walls]);
  const captureNewWalls = async (): Promise<void> => {
    const mgNow = (await call("model_get", {})) as unknown as { walls: { site_id?: string }[] };
    const known = knownWalls();
    for (const w of mgNow.walls) {
      if (w.site_id && !known.has(w.site_id)) created.walls.push(w.site_id);
    }
    writeCreated();
  };
  const topFrom = Math.min(topWall.from[0], topWall.to[0]);
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
  const s3 = await call("project_save", {});
  console.log("save#3 (split):", JSON.stringify(s3).slice(0, 240));
  if (s3["verified"] !== true) throw new Error("save#3 (split) не verified");
  const after3 = await rawGet("after-split");
  const wfC3 = rawByIdIn(after3.model, "warm_floors", wfc, "контур после split") as { props?: { cables_warm_floor?: Record<string, unknown> } };
  if (wfC3.props?.cables_warm_floor?.cable_warm_floor_id !== created.wiring[0]!.site_id) throw new Error("после split контур потерял ссылку на кабель");
  console.log("после split: контур и ссылка на кабель целы");

  // 9. merge — удаление перегородки
  await call("wall_delete", { wall_id: partSite });
  created.walls = created.walls.filter((w) => w !== partSite);
  await pause();
  const s4 = await call("project_save", {});
  console.log("save#4 (merge):", JSON.stringify(s4).slice(0, 240));
  if (s4["verified"] !== true) throw new Error("save#4 (merge) не verified");
  const after4 = await rawGet("after-merge");
  const wfC4 = rawByIdIn(after4.model, "warm_floors", wfc, "контур после merge") as { props?: { cables_warm_floor?: Record<string, unknown> } };
  if (wfC4.props?.cables_warm_floor?.cable_warm_floor_id !== created.wiring[0]!.site_id) throw new Error("после merge контур потерял ссылку на кабель");
  console.log("после merge: контур и ссылка целы");

  // 10. render PNG
  const png = await call("render_plan", { sheet: "init" });
  console.log("render:", (png["path"] as string) ?? JSON.stringify(png).slice(0, 160));

  // 11. очистка по захваченным site_id
  await pause();
  await cleanupCreated();
  await pause();
  const s5 = await call("project_save", {});
  console.log("save#5 (очистка):", JSON.stringify(s5).slice(0, 240));
  if (s5["verified"] !== true) throw new Error("save#5 (очистка) не verified");
  const rawLeft = ((await loadModel(ctx.session(), OBJECT_ID, PLAN_ID)) as unknown as Raw).model;
  const leftoverPairs: [string, string][] = [
    ...created.wiring.map((w) => [w.coll, w.site_id] as [string, string]),
    ...created.pipes.map((p) => [p.coll, p.site_id] as [string, string]),
    ...created.warm_floors.map((s) => ["warm_floors", s] as [string, string]),
    ...created.items.map((s) => ["items", s] as [string, string]),
    ...created.walls.map((s) => ["walls", s] as [string, string]),
  ];
  const leftovers = leftoverPairs.filter(([coll, s]) => Object.keys(rawLeft[coll] ?? {}).includes(s));
  if (leftovers.length > 0) throw new Error(`очистка неполна: ${leftovers.map(([c, s]) => `${c}:${s}`).join(", ")}`);
} catch (e) {
  console.error("FAIL:", (e as Error).message);
  try {
    // item_add живёт в workspace до project_save — сброс, чтобы очистка видела объекты
    try { await call("project_save", {}); } catch { /* проект мог не открыться */ }
    await cleanupCreated();
    await call("project_save", {});
    console.error("cleanup после сбоя выполнен");
  } catch (ce) {
    console.error("cleanup после сбоя не удался (объекты в 268-created.json):", (ce as Error).message);
    writeCreated();
  }
  const ro = await loadModel(ctx.session(), READONLY_ID, READONLY_PLAN);
  writeFileSync(`${OUT}/268-get-readonly-after-fail.json`, JSON.stringify(ro, null, 1) + "\n");
  await closeBrowser().catch(() => {});
  process.exit(1);
} finally {
  await closeBrowser().catch(() => {});
}

const roAfter = await loadModel(ctx.session(), READONLY_ID, READONLY_PLAN);
writeFileSync(`${OUT}/268-get-readonly-after.json`, JSON.stringify(roAfter, null, 1) + "\n");
console.log("контрольный проект не изменился:", strip(roAfter.model) === strip(roBefore.model) ? "OK" : "ИЗМЕНИЛСЯ");
const ownAfter = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
writeFileSync(`${OUT}/268-get-own-after.json`, JSON.stringify(ownAfter, null, 1) + "\n");
const same = strip(ownAfter.model) === strip(backup.model);
console.log("data dev == бэкап:", same ? "OK — восстановлен" : "РАСХОЖДЕНИЕ (сверить производные пути)");
process.exit(same ? 0 : 2);
