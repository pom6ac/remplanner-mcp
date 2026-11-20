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
import { assertNoReadonlyCollision, assertTargetPair, readonlyGuard, readonlyRefPath } from "./probe-guard.ts";

if (process.argv[2] !== "run") {
  console.error("запуск по явному аргументу run (ID из env)");
  process.exit(0);
}
const OBJECT_ID = process.env["REMPLANNER_PROBE_OBJECT_ID"];
const PLAN_ID = process.env["REMPLANNER_PROBE_PLAN_ID"];
const READONLY_ID = process.env["REMPLANNER_PROBE_READONLY_ID"];
const READONLY_PLAN_ID = process.env["REMPLANNER_PROBE_READONLY_PLAN_ID"];
if (!OBJECT_ID || !PLAN_ID || !READONLY_ID || !READONLY_PLAN_ID) {
  console.error("нужны REMPLANNER_PROBE_OBJECT_ID, REMPLANNER_PROBE_PLAN_ID, REMPLANNER_PROBE_READONLY_ID и REMPLANNER_PROBE_READONLY_PLAN_ID (322 N3б)");
  process.exit(1);
}
assertNoReadonlyCollision(OBJECT_ID, PLAN_ID, READONLY_ID, READONLY_PLAN_ID);
const OUT = ".orca-reports/tmp";
mkdirSync(OUT, { recursive: true });
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 14 * 60_000).unref();

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "250-live-check", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);

const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content?: { type: string; text?: string }[] };
  if (res.isError) throw new Error(`${name}: ${(res.content ?? []).map((c) => c.text ?? "").join("").slice(0, 500)}`);
  return JSON.parse((res.content ?? []).find((c) => typeof c.text === "string")?.text ?? "{}") as Record<string, unknown>;
};
const entitySiteId = (res: Record<string, unknown>, what: string): string => {
  // ревью 253 Н1: захватываем site_id (id сайта), а не позиционную метку компакта
  const e = res["entity"] as { site_id?: string } | undefined;
  if (!e?.site_id) throw new Error(`в ответе нет entity.site_id (${what}): ${JSON.stringify(res).slice(0, 200)}`);
  return e.site_id;
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

// ревью 253 Н1: в created — только site_id (id сайта); у труб — ещё тип коллекции
// (pipes_heat/pipes_conditioner/pipes_warm_floor/pipes_ventilation), остальные
// коллекции однозначно задаёт ключ файла. Метки I/W/PH компакта не сохраняются.
const created = {
  items: [] as string[],
  walls: [] as string[],
  warm_floors: [] as string[],
  pipes: [] as { coll: string; site_id: string }[],
  wiring: [] as string[],
};
// ревью 251 №4: список захваченных site_id пишется в файл сразу после создания —
// 250-cleanup удаляет только по нему (никакой очистки по коллекции/имени/позиции)
const CREATED_FILE = `${OUT}/250-created.json`;
const writeCreated = (): void => {
  writeFileSync(CREATED_FILE, JSON.stringify(created, null, 1) + "\n");
};

// ревью 319 №4: эталон контрольного проекта фиксированный (файл не перезаписывается),
// сверка перед записями и в конце; пара объект/план из env — ревью 319 №3
await assertTargetPair(ctx.session(), OBJECT_ID, PLAN_ID);
const roGuard = await readonlyGuard(ctx.session(), READONLY_ID, READONLY_PLAN_ID, readonlyRefPath(READONLY_ID, READONLY_PLAN_ID));
await roGuard.assertUnchanged("перед записями");

/**
 * Удаление строго по захваченным при создании site_id (ревью 251 №4, 253 Н1,
 * инцидент 240): перед каждым удалением объект ищется в свежей модели по
 * site_id, удаляется по свежеразрешённой метке. Объекта с site_id нет — ничего
 * не удаляется, пропуск сообщается. Возвращает число удалённых.
 */
const deleteCreated = async (entries: { coll: string; site_id: string }[], tool: string, arg: string): Promise<number> => {
  let n = 0;
  for (const { coll, site_id } of [...entries].reverse()) {
    if (coll === "items") {
      // в компактном model_get у items нет site_id — существование и метка
      // берутся из свежей сырой модели (ключ items = site_id)
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
/** Очистка пробы: только created.*, в обратном порядке зависимостей. */
const PIPE_COLLS = ["pipes_ventilation", "pipes_warm_floor", "pipes_conditioner", "pipes_heat"] as const;
const cleanupCreated = async (): Promise<void> => {
  await deleteCreated(created.wiring.map((site_id) => ({ coll: "cables_conditioner", site_id })), "wiring_delete", "wiring_id");
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
  // ревью 253 Н1: до пробы — множество site_id стен, а не позиционных меток
  const wallsBefore = new Set(wallsFull0.walls.map((w) => w.site_id));
  const maxX = Math.max(...wallsFull0.walls.flatMap((w) => [w.from[0], w.to[0]]));
  const ox = maxX + 1500;
  const oy = 0;

  // 1. пробная комната
  await call("room_add_rect", { origin: { x: ox, y: oy }, width: 4000, depth: 3000, wall_thickness: 200 });
  const wallsFull1 = (await call("model_get", {})) as unknown as { walls: { site_id: string; from: [number, number]; to: [number, number] }[] };
  const newWalls = wallsFull1.walls.filter((w) => !wallsBefore.has(w.site_id));
  created.walls = newWalls.map((w) => w.site_id);
  const topWall = newWalls.filter((w) => w.from[1] === w.to[1]).sort((x, y) => x.from[1] - y.from[1])[0]!;
  console.log("room walls (site_id):", created.walls.join(" "), "top:", topWall.site_id);
  const awTop = (offsetMm: number) => ({ against_wall: { wall_id: topWall.site_id, offset_mm: offsetMm } });

  // 2. предметы и водяной контур (метки из ответов — только для немедленных
  // ссылок в path; в created идут site_id, резолвимые после 3b по сырой модели)
  const radiator = ((await call("item_add", { name: "radiator_bimetal", position: awTop(1000) }))["entity"] as { id: string }).id;
  const cond = ((await call("item_add", { name: "conditioner", position: awTop(2500) }))["entity"] as { id: string }).id;
  const eng = ((await call("item_add", { name: "conditioner_engine", position: awTop(3500) }))["entity"] as { id: string }).id;
  const wf = entitySiteId(await call("warm_floor_add", { kind: "water", corner1: { x: ox + 500, y: 500 }, corner2: { x: ox + 1500, y: 1500 } }), "warm_floor_add");
  created.warm_floors = [wf];
  console.log("item labels (только для path):", radiator, cond, eng, "wf:", wf);

  // 3. трубы климата и трасса кондиционера
  created.pipes.push({ coll: "pipes_heat", site_id: entitySiteId(await call("pipe_add", { kind: "heat_hot", path: [{ item_id: radiator }, { x: ox + 1200, y: oy - 200 }] }), "pipe_add heat_hot") });
  created.pipes.push({ coll: "pipes_heat", site_id: entitySiteId(await call("pipe_add", { kind: "heat_cold", path: [{ item_id: radiator }, { x: ox + 1400, y: oy - 300 }] }), "pipe_add heat_cold") });
  created.pipes.push({ coll: "pipes_conditioner", site_id: entitySiteId(await call("pipe_add", { kind: "conditioner_drainage", path: [{ item_id: cond }, { x: ox + 300, y: oy - 100 }] }), "pipe_add conditioner_drainage") });
  created.pipes.push({ coll: "pipes_warm_floor", site_id: entitySiteId(await call("pipe_add", { kind: "warm_floor", path: [{ item_id: wf }, { x: ox + 200, y: oy + 200 }] }), "pipe_add warm_floor") });
  created.wiring.push(entitySiteId(await call("wiring_add", { kind: "conditioner_wire", path: [{ item_id: cond }, { item_id: eng }] }), "wiring_add"));
  console.log("pipes:", JSON.stringify(created.pipes), "wiring:", created.wiring.join(" "));
  // 3b. ревью 252: вентилятор + воздуховод (сечение рёбер) и warm_floor_update
  // контура с подключённой магистралью (оба угла, polygon[0] меняется)
  const fanLabel = ((await call("item_add", { name: "fan", position: { center: { x: ox + 3500, y: oy + 2500 } } }))["entity"] as { id: string }).id;
  created.pipes.push({ coll: "pipes_ventilation", site_id: entitySiteId(await call("pipe_add", { kind: "vent_out", path: [{ item_id: fanLabel }, { x: ox + 3200, y: oy + 2200 }] }), "pipe_add vent_out") });
  await call("warm_floor_update", { warm_floor_id: wf, corner1: { x: ox + 700, y: 700 }, corner2: { x: ox + 1700, y: 1700 } });
  // ревью 253 Н1: site_id предметов резолвится в сырой модели (ключ items = site_id)
  // по имени внутри зоны пробы (x > ox - 600) — до save и любых перетасовок
  const rawItems = ((await loadModel(ctx.session(), OBJECT_ID, PLAN_ID)) as unknown as Raw).model;
  const siteOfItem = (name: string): string => {
    const found = Object.entries(rawItems.items ?? {}).find(
      ([, v]) => (v as { name?: string }).name === name && (v as { pc?: { x: number } }).pc !== undefined && (v as { pc: { x: number } }).pc.x > ox - 600,
    );
    if (!found) throw new Error(`предмет «${name}» не найден в зоне пробы — site_id не захвачен`);
    return found[0];
  };
  created.items = [siteOfItem("radiator_bimetal"), siteOfItem("conditioner"), siteOfItem("conditioner_engine"), siteOfItem("fan")];
  writeCreated(); // ревью 251 №4/253 Н1: список site_id захвачен до любых рискованных шагов
  console.log("items (site_id):", created.items.join(" "), "— fan + vent pipe + warm_floor_update: OK");

  // 4. validate → save
  const v1 = await call("model_validate", {});
  console.log("validate:", JSON.stringify(v1).slice(0, 200));
  await pause();
  await roGuard.assertUnchanged("{tag}");
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
  // ревью 253 Н1/Н4: объекты после reopen ищутся по захваченным site_id
  // (в сырой модели ключ коллекции = site_id), а не по имени/первому в коллекции
  const [radSite, condSite, engSite, fanSite] = created.items;
  const wfPipeSite = created.pipes.find((p) => p.coll === "pipes_warm_floor")?.site_id;
  const ventSite = created.pipes.find((p) => p.coll === "pipes_ventilation")?.site_id;
  const rawByIdIn = (raw: Raw["model"], coll: string, siteId: string | undefined, what: string): Record<string, unknown> => {
    if (!siteId) throw new Error(`${what}: site_id не захвачен`);
    const o = (raw[coll] ?? {})[siteId] as Record<string, unknown> | undefined;
    if (!o) throw new Error(`${what}: объект ${siteId} не найден после reopen`);
    return o;
  };
  const rawById = (coll: string, siteId: string | undefined, what: string): Record<string, unknown> => rawByIdIn(model1, coll, siteId, what);
  const rad = rawById("items", radSite, "радиатор") as { pipes_heat?: { heat_pipe_hot_id?: unknown; heat_pipe_cold_id?: unknown } };
  const condIt = rawById("items", condSite, "кондиционер") as { pipes_conditioner?: { drainage_pipe_id?: unknown }; cables_conditioner?: { conditioner_cable_id?: unknown } };
  const engIt = rawById("items", engSite, "внешний блок") as { cables_conditioner?: { conditioner_cable_id?: unknown } };
  if (!rad.pipes_heat?.heat_pipe_hot_id || !rad.pipes_heat?.heat_pipe_cold_id) throw new Error(`радиатор потерял ссылки: ${JSON.stringify(rad.pipes_heat ?? null)}`);
  if (!condIt.pipes_conditioner?.drainage_pipe_id) throw new Error("кондиционер потерял drainage_pipe_id");
  if (!condIt.cables_conditioner?.conditioner_cable_id) throw new Error("кондиционер потерял conditioner_cable_id");
  if (!engIt.cables_conditioner?.conditioner_cable_id) throw new Error("внешний блок потерял conditioner_cable_id");
  const wfSite = rawById("warm_floors", wf, "контур тёплого пола") as { props?: { pipes_warm_floor?: Record<string, unknown> }; id_room?: string; polygon?: { x: number; y: number }[] };
  if (!wfSite.props?.pipes_warm_floor?.pipe_warm_floor_id) throw new Error("контур потерял pipe_warm_floor_id");
  // ревью 252: после warm_floor_update + save + reopen ссылка контура цела,
  // вершина-контур магистрали = новый polygon[0]
  const wfPipe = rawById("pipes_warm_floor", wfPipeSite, "магистраль тёплого пола") as { vertexes?: { id: string; point: { x: number; y: number }; type: string }[] };
  const wfv = wfPipe?.vertexes?.find((v) => v.type === "warm_floor");
  if (!wfv || !wfSite.polygon) throw new Error("после reopen нет вершины-контура у магистрали");
  if (Math.abs(wfv.point.x - wfSite.polygon[0]!.x) > 0.11 || Math.abs(wfv.point.y - wfSite.polygon[0]!.y) > 0.11) {
    throw new Error(`вершина-контур не равна polygon[0] после warm_floor_update: ${JSON.stringify(wfv.point)} vs ${JSON.stringify(wfSite.polygon[0])}`);
  }
  console.log("warm_floor_update: ссылка контура и вершина-контур на месте (polygon[0] =", JSON.stringify(wfSite.polygon[0]) + ")");
  // ревью 252: сечение рёбер воздуховода как в эталоне ui-ref-climate2-vent-pipe-fan
  const ventPipe = rawById("pipes_ventilation", ventSite, "воздуховод") as { matrix?: Array<Array<{ length?: number; width?: number; type?: string; height?: number } | null>>; type?: string; vertexes: { id: string; point: { x: number; y: number }; type: string }[] };
  const ventEdge = ventPipe?.matrix?.[0]?.[1];
  if (!ventEdge || ventEdge.width !== 20.4 || ventEdge.type !== "flat" || ventEdge.height !== 6) {
    throw new Error(`ребро воздуховода после save+reopen без сечения: ${JSON.stringify(ventEdge ?? null)}`);
  }
  console.log("воздуховод: сечение рёбер как в эталоне:", JSON.stringify(ventEdge), "тип:", ventPipe?.type);
  // ревью 251 №6 вживую: точка вершины-предмета = pc предмета (вентилятор)
  const fanIt = rawById("items", fanSite, "вентилятор") as { pc?: { x: number; y: number } };
  const ventV = ventPipe.vertexes.find((v) => v.type !== "node");
  if (!fanIt?.pc || !ventV || Math.abs(ventV.point.x - fanIt.pc.x) > 0.11 || Math.abs(ventV.point.y - fanIt.pc.y) > 0.11) {
    throw new Error(`точка вершины-предмета воздуховода != pc вентилятора: ${JSON.stringify(ventV?.point ?? null)} vs ${JSON.stringify(fanIt?.pc ?? null)}`);
  }
  console.log("точка вершины-предмета = pc (вентилятор): OK");

  // 6. split: разрез верхней и нижней стен, перегородка правее контура
  // (после warm_floor_update 3b правая грань контура ox+1700 — перегородка на ox+1900)
  const sx = ox + 1900;
  // ревью 253 Н1: split может породить НОВЫЕ стены — определяются по site_id,
  // которого нет в множестве site_id до пробы (не по позиционным меткам)
  const knownWalls = (): Set<string> => new Set([...wallsBefore, ...created.walls]);
  const captureNewWalls = async (): Promise<void> => {
    const mgNow = (await call("model_get", {})) as unknown as { walls: { site_id?: string }[] };
    const known = knownWalls();
    for (const w of mgNow.walls) {
      if (w.site_id && !known.has(w.site_id)) created.walls.push(w.site_id);
    }
    writeCreated();
  };
  console.log("split: topWall", topWall.site_id, JSON.stringify(topWall.from), "oy", oy);
  const topFrom = Math.min(topWall.from[0], topWall.to[0]);
  await call("wall_split", { wall_id: topWall.site_id, at_mm: sx - topFrom });
  await captureNewWalls();
  const mg2 = (await call("model_get", {})) as unknown as { walls: { site_id: string; from: [number, number]; to: [number, number] }[] };
  console.log("split: горизонтальные стены после разреза:", JSON.stringify(mg2.walls.filter((w) => w.from[1] === w.to[1])));
  // нижняя стена пробы: горизонтальная с максимальной y (оси комнатных стен: верх
  // на y = -thickness/2, низ на y = depth + thickness/2)
  const bottom = mg2.walls
    .filter((w) => w.from[1] === w.to[1] && created.walls.includes(w.site_id))
    .sort((x, y) => y.from[1] - x.from[1])[0]!;
  console.log("split: bottom", bottom.site_id, JSON.stringify(bottom.from), JSON.stringify(bottom.to));
  const bottomFrom = Math.min(bottom.from[0], bottom.to[0]);
  await call("wall_split", { wall_id: bottom.site_id, at_mm: sx - bottomFrom });
  await captureNewWalls();
  const partRes = await call("wall_add", { kind: "partition", start: { x: sx, y: topWall.from[1] }, end: { x: sx, y: bottom.from[1] }, thickness_mm: 100 });
  // ревью 253 Н1: перегородка — по site_id
  const partSite = (partRes["entity"] as { site_id?: string })?.site_id ?? (partRes["entity"] as { walls?: { site_id?: string }[] })?.walls?.[0]?.site_id;
  if (!partSite) throw new Error(`wall_add: нет site_id: ${JSON.stringify(partRes).slice(0, 200)}`);
  created.walls.push(partSite);
  console.log("split: перегородка", partSite);
  await pause();
  await roGuard.assertUnchanged("{tag}");
  const s2 = await call("project_save", {});
  console.log("save#2 (split):", JSON.stringify(s2).slice(0, 240));
  if (s2["verified"] !== true) throw new Error("save#2 (split) не verified");
  const after2 = await rawGet("after-split");
  const wfSplit = rawByIdIn(after2.model, "warm_floors", wf, "контур после split");
  console.log("после split: контур на месте, id_room =", (wfSplit as { id_room?: string }).id_room, "pipes_warm_floor:", Object.keys(after2.model.pipes_warm_floor ?? {}).length);
  if (!(wfSplit as { props?: { pipes_warm_floor?: Record<string, unknown> } }).props?.pipes_warm_floor?.pipe_warm_floor_id) throw new Error("после split контур потерял ссылку на магистраль");

  // 7. merge — удаление перегородки
  await call("wall_delete", { wall_id: partSite });
  created.walls = created.walls.filter((w) => w !== partSite);
  await pause();
  await roGuard.assertUnchanged("{tag}");
  const s3 = await call("project_save", {});
  console.log("save#3 (merge):", JSON.stringify(s3).slice(0, 240));
  if (s3["verified"] !== true) throw new Error("save#3 (merge) не verified");
  const after3 = await rawGet("after-merge");
  const wfMerge = rawByIdIn(after3.model, "warm_floors", wf, "контур после merge") as { id_room?: string; props?: { pipes_warm_floor?: Record<string, unknown> } };
  console.log("после merge: контур на месте, id_room =", wfMerge.id_room, "warm_floors:", Object.keys(after3.model.warm_floors ?? {}).length);
  if (!wfMerge.props?.pipes_warm_floor?.pipe_warm_floor_id) throw new Error("после merge контур потерял ссылку на магистраль");

  // 8. render PNG
  const png = await call("render_plan", { sheet: "init" });
  const renderPath = png["path"] as string | undefined;
  console.log("render:", renderPath ?? JSON.stringify(png).slice(0, 160));

  // 9. очистка по захваченным при создании site_id (ревью 251 №4, 253 Н1,
  // инцидент 240): никакого удаления по коллекции целиком, по имени или по позиции
  await pause();
  await cleanupCreated();
  await pause();
  await roGuard.assertUnchanged("{tag}");
  const s4 = await call("project_save", {});
  console.log("save#4 (очистка):", JSON.stringify(s4).slice(0, 240));
  if (s4["verified"] !== true) throw new Error("save#4 (очистка) не verified");
  // после очистки ни один созданный site_id не должен остаться в коллекциях
  // (ревью 253 Н1: проверка существования — по site_id в свежей сырой модели)
  const rawLeft = ((await loadModel(ctx.session(), OBJECT_ID, PLAN_ID)) as unknown as Raw).model;
  const leftoverPairs: [string, string][] = [
    ...created.wiring.map((s) => ["cables_conditioner", s] as [string, string]),
    ...created.pipes.map((p) => [p.coll, p.site_id] as [string, string]),
    ...created.warm_floors.map((s) => ["warm_floors", s] as [string, string]),
    ...created.items.map((s) => ["items", s] as [string, string]),
    ...created.walls.map((s) => ["walls", s] as [string, string]),
  ];
  const leftovers = leftoverPairs.filter(([coll, s]) => Object.keys(rawLeft[coll] ?? {}).includes(s));
  if (leftovers.length > 0) throw new Error(`очистка неполна: ${leftovers.map(([c, s]) => `${c}:${s}`).join(", ")}`);
} catch (e) {
  console.error("FAIL:", (e as Error).message);
  // ревью 251 №4: восстановление в finally — попытка убрать созданное пробой
  // даже при сбое (best effort; список ID в 250-created.json остаётся для 250-cleanup)
  try {
    await cleanupCreated();
    await roGuard.assertUnchanged("{tag}");
    await call("project_save", {});
    console.error("cleanup после сбоя выполнен");
  } catch (ce) {
    console.error("cleanup после сбоя не удался (объекты останутся в 250-created.json):", (ce as Error).message);
    writeCreated();
  }
  if (roGuard) await roGuard.checkFinal("после сбоя");
  await closeBrowser().catch(() => {});
  process.exit(1);
} finally {
  await closeBrowser().catch(() => {});
}

// ревью 319 №4: сверка контрольного проекта с фиксированным эталоном в конце
const roChangedEnd = await roGuard.checkFinal("в конце");
console.log("контрольный проект не изменился:", roChangedEnd ? "ИЗМЕНИЛСЯ — СТОП" : "OK");
const ownAfter = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
writeFileSync(`${OUT}/250-get-own-after.json`, JSON.stringify(ownAfter, null, 1) + "\n");
const same = strip(ownAfter.model) === strip(backup.model);
console.log("data dev == бэкап:", same ? "OK — восстановлен" : "РАСХОЖДЕНИЕ (сверить производные пути)");
process.exit(same ? 0 : 2);
