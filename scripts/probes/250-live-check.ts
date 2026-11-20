// 250: живая проверка климата ч.2 в dev-проекте из env (REMPLANNER_PROBE_OBJECT_ID,
// REMPLANNER_PROBE_PLAN_ID, REMPLANNER_PROBE_READONLY_ID). Полная цепочка MCP:
// room_add_rect → item_add (радиатор/кондиционер/внешний блок) → warm_floor_add water →
// pipe_add (heat_hot + heat_cold к радиатору, conditioner_drainage к кондиционеру,
// warm_floor к водяному контуру) → wiring_add conditioner_wire → model_validate →
// project_save (verified) → reopen → сверка коллекций/ссылок по GET →
// split комнаты (wall_split ×2 + перегородка, контур не задевается) → save →
// merge (wall_delete перегородки) → save → render_plan PNG → очистка по захваченным
// site-id → save → сверка data с бэкапом. Контрольный проект — GET до/после.
// Запуск: node --experimental-strip-types scripts/probes/250-live-check.ts run
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadModel, type LoadedModel } from "../../src/api.ts";
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
const client = new Client({ name: "250-live-check", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);

const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const res = await client.callTool({ name, arguments: args });
  if ((res as { isError?: boolean }).isError) throw new Error(`${name}: ${res.content?.map((c) => ("text" in c ? c.text : "")).join("")?.slice(0, 500)}`);
  return JSON.parse(res.content?.find((c) => "text" in c)?.text ?? "{}") as Record<string, unknown>;
};
const entityId = (res: Record<string, unknown>): string => {
  const e = res["entity"] as { id?: string } | undefined;
  if (!e?.id) throw new Error(`в ответе нет entity.id: ${JSON.stringify(res).slice(0, 200)}`);
  return e.id;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pause = () => sleep(6000); // сохранения не чаще раза в 5 с

// ревью 252: путь бэкапа — из env (по умолчанию бэкап этапа 250), чтобы прогон
// сверялся со свежим снимком (backup-<id>-252.json), а не с устаревшим
const backup = JSON.parse(readFileSync(process.env["REMPLANNER_PROBE_BACKUP"] ?? ".orca-reports/backup-dev-250.json", "utf8"));
const strip = (m: unknown) => {
  const c = structuredClone(m as Record<string, unknown>);
  delete c.save_id; delete c.log_plan; delete c.session; delete c.version;
  return JSON.stringify(c);
};
type Raw = { model: Record<string, Record<string, { name?: string } & Record<string, unknown>>> };
const rawGet = async (tag: string): Promise<Raw> => {
  const m = (await loadModel(ctx.session(), OBJECT_ID, PLAN_ID)) as unknown as Raw;
  writeFileSync(`${OUT}/250-get-own-${tag}.json`, JSON.stringify(m, null, 1) + "\n");
  return m;
};

const created = { items: [] as string[], walls: [] as string[], warm_floors: [] as string[], pipes: [] as string[], wiring: [] as string[] };
// ревью 251 №4: список захваченных ID пишется в файл сразу после создания —
// 250-cleanup удаляет только по нему (никакой очистки по коллекции/имени/позиции)
const CREATED_FILE = `${OUT}/250-created.json`;
const writeCreated = (): void => {
  writeFileSync(CREATED_FILE, JSON.stringify(created, null, 1) + "\n");
};

// контрольный проект читается ДО любых записей — с ним сверяем в конце (ревью 251 №5)
const roBefore = await loadModel(ctx.session(), READONLY_ID, "1");
writeFileSync(`${OUT}/250-get-readonly-before.json`, JSON.stringify(roBefore, null, 1) + "\n");

/**
 * Удаление строго по захваченным при создании ID (ревью 251 №4, инцидент 240):
 * перед каждым удалением ID ищется в свежем model_get (метки позиционные), объект
 * с ID вне списка пробы не удаляется никогда. Возвращает число удалённых.
 */
const deleteCreated = async (ids: string[], key: string, tool: string, arg: string): Promise<number> => {
  let n = 0;
  for (const id of [...ids].reverse()) {
    const coll = (await call("model_get", {})) as unknown as Record<string, { id?: string }[]>;
    if (!(coll[key] ?? []).some((o) => o.id === id)) continue; // уже удалён каскадом
    await call(tool, { [arg]: id });
    n++;
  }
  return n;
};
/** Очистка пробы: только created.*, в обратном порядке зависимостей. */
const cleanupCreated = async (): Promise<void> => {
  await deleteCreated(created.wiring, "cables_conditioner", "wiring_delete", "wiring_id");
  await deleteCreated(created.pipes, "pipes_ventilation", "pipe_delete", "pipe_id");
  await deleteCreated(created.pipes, "pipes_warm_floor", "pipe_delete", "pipe_id");
  await deleteCreated(created.pipes, "pipes_conditioner", "pipe_delete", "pipe_id");
  await deleteCreated(created.pipes, "pipes_heat", "pipe_delete", "pipe_id");
  await deleteCreated(created.warm_floors, "warm_floors", "warm_floor_delete", "warm_floor_id");
  await deleteCreated(created.items, "items", "item_delete", "item_id");
  await deleteCreated(created.walls, "walls", "wall_delete", "wall_id");
  writeCreated();
};

try {
  const ownNow = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  if (strip(ownNow.model) !== strip(backup.model)) throw new Error("dev-проект изменился с момента бэкапа — стоп");
  console.log("бэкап актуален, контрольный GET OK");

  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const wallsFull0 = (await call("model_get", {})) as unknown as { walls: { id: string; from: [number, number]; to: [number, number] }[] };
  const wallsBefore = new Set(wallsFull0.walls.map((w) => w.id));
  const maxX = Math.max(...wallsFull0.walls.flatMap((w) => [w.from[0], w.to[0]]));
  const ox = maxX + 1500;
  const oy = 0;

  // 1. пробная комната
  const roomRes = await call("room_add_rect", { origin: { x: ox, y: oy }, width: 4000, depth: 3000, wall_thickness: 200 });
  if (!(roomRes["entity"] as { walls?: unknown[] })?.walls?.length) throw new Error(`room_add_rect: нет стен: ${JSON.stringify(roomRes).slice(0, 200)}`);
  const wallsFull1 = (await call("model_get", {})) as unknown as { walls: { id: string; from: [number, number]; to: [number, number] }[] };
  const newWalls = wallsFull1.walls.filter((w) => !wallsBefore.has(w.id));
  created.walls = newWalls.map((w) => w.id);
  const topWall = newWalls.filter((w) => w.from[1] === w.to[1]).sort((x, y) => x.from[1] - y.from[1])[0]!;
  console.log("room walls:", created.walls.join(" "), "top:", topWall.id);
  const awTop = (offsetMm: number) => ({ against_wall: { wall_id: topWall.id, offset_mm: offsetMm } });

  // 2. предметы и водяной контур
  const radiator = entityId(await call("item_add", { name: "radiator_bimetal", position: awTop(1000) }));
  const cond = entityId(await call("item_add", { name: "conditioner", position: awTop(2500) }));
  const eng = entityId(await call("item_add", { name: "conditioner_engine", position: awTop(3500) }));
  const wf = entityId(await call("warm_floor_add", { kind: "water", corner1: { x: ox + 500, y: 500 }, corner2: { x: ox + 1500, y: 1500 } }));
  created.items = [radiator, cond, eng];
  created.warm_floors = [wf];
  console.log("items:", created.items.join(" "), "wf:", wf);

  // 3. трубы климата и трасса кондиционера
  created.pipes.push(entityId(await call("pipe_add", { kind: "heat_hot", path: [{ item_id: radiator }, { x: ox + 1200, y: oy - 200 }] })));
  created.pipes.push(entityId(await call("pipe_add", { kind: "heat_cold", path: [{ item_id: radiator }, { x: ox + 1400, y: oy - 300 }] })));
  created.pipes.push(entityId(await call("pipe_add", { kind: "conditioner_drainage", path: [{ item_id: cond }, { x: ox + 300, y: oy - 100 }] })));
  created.pipes.push(entityId(await call("pipe_add", { kind: "warm_floor", path: [{ item_id: wf }, { x: ox + 200, y: oy + 200 }] })));
  created.wiring.push(entityId(await call("wiring_add", { kind: "conditioner_wire", path: [{ item_id: cond }, { item_id: eng }] })));
  console.log("pipes:", created.pipes.join(" "), "wiring:", created.wiring.join(" "));
  // 3b. ревью 252: вентилятор + воздуховод (сечение рёбер) и warm_floor_update
  // контура с подключённой магистралью (оба угла, polygon[0] меняется)
  const fan = entityId(await call("item_add", { name: "fan", position: { center: { x: ox + 3500, y: oy + 2500 } } }));
  created.items.push(fan);
  created.pipes.push(entityId(await call("pipe_add", { kind: "vent_out", path: [{ item_id: fan }, { x: ox + 3200, y: oy + 2200 }] })));
  await call("warm_floor_update", { warm_floor_id: wf, corner1: { x: ox + 700, y: 700 }, corner2: { x: ox + 1700, y: 1700 } });
  writeCreated(); // ревью 251 №4: список ID захвачен до любых рискованных шагов
  console.log("fan + vent pipe + warm_floor_update: OK");

  // 4. validate → save
  const v1 = await call("model_validate", {});
  console.log("validate:", JSON.stringify(v1).slice(0, 200));
  await pause();
  const s1 = await call("project_save", {});
  console.log("save#1:", JSON.stringify(s1).slice(0, 240));
  if (s1["verified"] !== true) throw new Error("save#1 не verified");

  // 5. reopen + сверка по GET (raw model)
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const after1 = await rawGet("after-save1");
  const model1 = after1.model;
  const counts = (coll: string): number => Object.keys(model1[coll] ?? {}).length;
  console.log("после save+GET: pipes_heat", counts("pipes_heat"), "pipes_conditioner", counts("pipes_conditioner"), "pipes_warm_floor", counts("pipes_warm_floor"), "cables_conditioner", counts("cables_conditioner"), "warm_floors", counts("warm_floors"));
  if (counts("pipes_heat") < 2 || counts("pipes_conditioner") < 1 || counts("pipes_warm_floor") < 1 || counts("cables_conditioner") < 1) {
    throw new Error("коллекции климата неполны после reopen");
  }
  // предметы в raw-модели ищутся по имени (в компактном выводе items без site_id)
  const findByName = (name: string): Record<string, unknown> => {
    const found = Object.entries(model1.items ?? {}).find(([, v]) => (v as { name?: string }).name === name);
    if (!found) throw new Error(`предмет «${name}» не найден после reopen`);
    return found[1];
  };
  const rad = findByName("radiator_bimetal");
  const condIt = findByName("conditioner");
  const engIt = findByName("conditioner_engine");
  if (!rad.pipes_heat?.heat_pipe_hot_id || !rad.pipes_heat?.heat_pipe_cold_id) throw new Error(`радиатор потерял ссылки: ${JSON.stringify(rad.pipes_heat ?? null)}`);
  if (!condIt.pipes_conditioner?.drainage_pipe_id) throw new Error("кондиционер потерял drainage_pipe_id");
  if (!condIt.cables_conditioner?.conditioner_cable_id) throw new Error("кондиционер потерял conditioner_cable_id");
  if (!engIt.cables_conditioner?.conditioner_cable_id) throw new Error("внешний блок потерял conditioner_cable_id");
  const wfSite = (Object.values(model1.warm_floors ?? {})[0] ?? {}) as { id?: string; props?: { pipes_warm_floor?: Record<string, unknown> }; id_room?: string; polygon?: { x: number; y: number }[] };
  if (!wfSite.props?.pipes_warm_floor?.pipe_warm_floor_id) throw new Error("контур потерял pipe_warm_floor_id");
  // ревью 252: после warm_floor_update + save + reopen ссылка контура цела,
  // вершина-контур магистрали = новый polygon[0]
  const wfPipe = Object.values(model1.pipes_warm_floor ?? {})[0] as { vertexes?: { id: string; point: { x: number; y: number }; type: string }[] } | undefined;
  const wfv = wfPipe?.vertexes?.find((v) => v.type === "warm_floor");
  if (!wfv || !wfSite.polygon) throw new Error("после reopen нет вершины-контура у магистрали");
  if (Math.abs(wfv.point.x - wfSite.polygon[0]!.x) > 0.11 || Math.abs(wfv.point.y - wfSite.polygon[0]!.y) > 0.11) {
    throw new Error(`вершина-контур не равна polygon[0] после warm_floor_update: ${JSON.stringify(wfv.point)} vs ${JSON.stringify(wfSite.polygon[0])}`);
  }
  console.log("warm_floor_update: ссылка контура и вершина-контур на месте (polygon[0] =", JSON.stringify(wfSite.polygon[0]) + ")");
  // ревью 252: сечение рёбер воздуховода как в эталоне ui-ref-climate2-vent-pipe-fan
  const ventPipe = Object.values(model1.pipes_ventilation ?? {})[0] as { matrix?: Array<Array<{ length?: number; width?: number; type?: string; height?: number } | null>>; type?: string } | undefined;
  const ventEdge = ventPipe?.matrix?.[0]?.[1];
  if (!ventEdge || ventEdge.width !== 20.4 || ventEdge.type !== "flat" || ventEdge.height !== 6) {
    throw new Error(`ребро воздуховода после save+reopen без сечения: ${JSON.stringify(ventEdge ?? null)}`);
  }
  console.log("воздуховод: сечение рёбер как в эталоне:", JSON.stringify(ventEdge), "тип:", ventPipe?.type);
  // ревью 251 №6 вживую: точка вершины-предмета = pc предмета (вентилятор)
  const fanIt = Object.values(model1.items ?? {}).find((it) => (it as { name?: string }).name === "fan") as { pc?: { x: number; y: number } } | undefined;
  const ventV = ventPipe && (ventPipe as unknown as { vertexes: { id: string; point: { x: number; y: number }; type: string }[] }).vertexes.find((v) => v.type !== "node");
  if (!fanIt?.pc || !ventV || Math.abs(ventV.point.x - fanIt.pc.x) > 0.11 || Math.abs(ventV.point.y - fanIt.pc.y) > 0.11) {
    throw new Error(`точка вершины-предмета воздуховода != pc вентилятора: ${JSON.stringify(ventV?.point ?? null)} vs ${JSON.stringify(fanIt?.pc ?? null)}`);
  }
  console.log("точка вершины-предмета = pc (вентилятор): OK");

  // 6. split: разрез верхней и нижней стен, перегородка правее контура
  // (после warm_floor_update 3b правая грань контура ox+1700 — перегородка на ox+1900)
  const sx = ox + 1900;
  // ревью 251 №4: split может породить НОВЫЕ id частей — они тоже захватываются
  const knownWalls = (): Set<string> => new Set([...wallsBefore, ...created.walls]);
  const captureNewWalls = async (): Promise<void> => {
    const mgNow = (await call("model_get", {})) as unknown as { walls: { id: string }[] };
    const known = knownWalls();
    for (const w of mgNow.walls) {
      if (w.id && !known.has(w.id)) created.walls.push(w.id);
    }
    writeCreated();
  };
  console.log("split: topWall", JSON.stringify(topWall), "oy", oy);
  const topFrom = Math.min(topWall.from[0], topWall.to[0]);
  await call("wall_split", { wall_id: topWall.id, at_mm: sx - topFrom });
  await captureNewWalls();
  const mg2 = (await call("model_get", {})) as unknown as { walls: { id: string; from: [number, number]; to: [number, number] }[] };
  console.log("split: горизонтальные стены после разреза:", JSON.stringify(mg2.walls.filter((w) => w.from[1] === w.to[1])));
  // нижняя стена пробы: горизонтальная с максимальной y (оси комнатных стен: верх
  // на y = -thickness/2, низ на y = depth + thickness/2)
  const bottom = mg2.walls
    .filter((w) => w.from[1] === w.to[1] && created.walls.includes(w.id))
    .sort((x, y) => y.from[1] - x.from[1])[0]!;
  console.log("split: bottom", bottom.id, JSON.stringify(bottom.from), JSON.stringify(bottom.to));
  const bottomFrom = Math.min(bottom.from[0], bottom.to[0]);
  await call("wall_split", { wall_id: bottom.id, at_mm: sx - bottomFrom });
  await captureNewWalls();
  const partRes = await call("wall_add", { kind: "partition", start: { x: sx, y: topWall.from[1] }, end: { x: sx, y: bottom.from[1] }, thickness_mm: 100 });
  const partId = (partRes["entity"] as { id?: string })?.id ?? (partRes["entity"] as { walls?: { id: string }[] })?.walls?.[0]?.id;
  if (!partId) throw new Error(`wall_add: нет id: ${JSON.stringify(partRes).slice(0, 200)}`);
  created.walls.push(partId);
  console.log("split: перегородка", partId);
  await pause();
  const s2 = await call("project_save", {});
  console.log("save#2 (split):", JSON.stringify(s2).slice(0, 240));
  if (s2["verified"] !== true) throw new Error("save#2 (split) не verified");
  const after2 = await rawGet("after-split");
  const wfSplit = Object.values(after2.model.warm_floors ?? {})[0]!;
  console.log("после split: контур на месте, id_room =", wfSplit.id_room, "pipes_warm_floor:", Object.keys(after2.model.pipes_warm_floor ?? {}).length);
  if (!wfSplit.props?.pipes_warm_floor?.pipe_warm_floor_id) throw new Error("после split контур потерял ссылку на магистраль");

  // 7. merge — удаление перегородки
  await call("wall_delete", { wall_id: partId });
  created.walls = created.walls.filter((w) => w !== partId);
  await pause();
  const s3 = await call("project_save", {});
  console.log("save#3 (merge):", JSON.stringify(s3).slice(0, 240));
  if (s3["verified"] !== true) throw new Error("save#3 (merge) не verified");
  const after3 = await rawGet("after-merge");
  const wfMerge = Object.values(after3.model.warm_floors ?? {})[0]!;
  console.log("после merge: контур на месте, id_room =", wfMerge.id_room, "warm_floors:", Object.keys(after3.model.warm_floors ?? {}).length);
  if (!wfMerge.props?.pipes_warm_floor?.pipe_warm_floor_id) throw new Error("после merge контур потерял ссылку на магистраль");

  // 8. render PNG
  const png = await call("render_plan", { sheet: "init" });
  const renderPath = png["path"] as string | undefined;
  console.log("render:", renderPath ?? JSON.stringify(png).slice(0, 160));

  // 9. очистка по захваченным при создании ID (ревью 251 №4, инцидент 240):
  // никакого удаления по коллекции целиком, по имени или по позиции
  await pause();
  await cleanupCreated();
  await pause();
  const s4 = await call("project_save", {});
  console.log("save#4 (очистка):", JSON.stringify(s4).slice(0, 240));
  if (s4["verified"] !== true) throw new Error("save#4 (очистка) не verified");
  // после очистки в коллекциях пробы не должно остаться созданных объектов
  const left = (await call("model_get", {})) as unknown as Record<string, { id?: string }[]>;
  const leftoverPairs: [string, string[]][] = [
    ["cables_conditioner", created.wiring],
    ["pipes_ventilation", created.pipes],
    ["pipes_heat", created.pipes],
    ["pipes_conditioner", created.pipes],
    ["pipes_warm_floor", created.pipes],
    ["warm_floors", created.warm_floors],
    ["items", created.items],
    ["walls", created.walls],
  ];
  const leftovers = leftoverPairs.flatMap(([coll, ids]) => ids.filter((id) => (left[coll] ?? []).some((o) => o.id === id)));
  if (leftovers.length > 0) throw new Error(`очистка неполна: ${leftovers.join(", ")}`);
} catch (e) {
  console.error("FAIL:", (e as Error).message);
  // ревью 251 №4: восстановление в finally — попытка убрать созданное пробой
  // даже при сбое (best effort; список ID в 250-created.json остаётся для 250-cleanup)
  try {
    await cleanupCreated();
    await call("project_save", {});
    console.error("cleanup после сбоя выполнен");
  } catch (ce) {
    console.error("cleanup после сбоя не удался (объекты останутся в 250-created.json):", (ce as Error).message);
    writeCreated();
  }
  const ro = await loadModel(ctx.session(), READONLY_ID, "1");
  writeFileSync(`${OUT}/250-get-readonly-after-fail.json`, JSON.stringify(ro, null, 1) + "\n");
  await closeBrowser().catch(() => {});
  process.exit(1);
} finally {
  await closeBrowser().catch(() => {});
}

const roAfter = await loadModel(ctx.session(), READONLY_ID, "1");
writeFileSync(`${OUT}/250-get-readonly-after.json`, JSON.stringify(roAfter, null, 1) + "\n");
// ревью 251 №5: сверка с roBefore (GET до пробы), а не с повторным GET того же проекта
console.log("контрольный проект не изменился:", strip(roAfter.model) === strip(roBefore.model) ? "OK" : "ИЗМЕНИЛСЯ");
const ownAfter = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
writeFileSync(`${OUT}/250-get-own-after.json`, JSON.stringify(ownAfter, null, 1) + "\n");
const same = strip(ownAfter.model) === strip(backup.model);
console.log("data dev == бэкап:", same ? "OK — восстановлен" : "РАСХОЖДЕНИЕ (сверить производные пути)");
process.exit(same ? 0 : 2);
