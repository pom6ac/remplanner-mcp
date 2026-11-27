// 419: живая проверка project_set_height v2 и demolish target:"item" в dev-объекте
// (ID — ТОЛЬКО из env командной строки, в файл не пишутся; проба открывает
// dev-объект, никаких новых проектов). Сценарий:
//   A) project_set_height (НОВАЯ высота, выше исходной — клампинга нет) → проверка
//      рабочей модели (total_height, rooms2[].height, walls[].height, балкон — без
//      изменений) → save → reopen → независимый loadModel: те же поля;
//   B) demolish target:"item" на подходящем предмете dev-объекта (radiator_old/
//      electric_shield_old, demount≠1 — имя решает; план не проверяется, ревью 420 №1:
//      бандл демонтирует старый фонд при любом props.plan); если такого нет — B
//      пропускается с записью причины, предмет НЕ создаётся (без эталона).
//      → save/reopen → demount=1 →
//      demolish_cancel → save/reopen → demount=0;
//   → render_plan; restore в finally: cancel предмета (если остался), высота назад,
//      save, итоговый sig == бэкап (канон probe-sig).
// Гарды (канон 399/404/406): probe-guard (пара объект/план fail-closed, READONLY-гард
// по корневому эталону БЕЗ REF_INIT, assertEditorPlanMatch), assertUnchanged READONLY
// перед КАЖДОЙ записью и в конце; бэкап dev-объекта fail-closed:
// <корень репо>/.orca-reports/backup-<OBJECT_ID>-419.json — АБСОЛЮТНЫЙ путь через
// gitRepoRoot, НЕ перезаписывается, пишется ТОЛЬКО фазой run с
// REMPLANNER_PROBE_WRITE_BACKUP=1, при отсутствии — стоп; журнал исходных значений
// (<корень>/.orca-reports/tmp/419-captured-<N>-<n>.json, абсолютный путь, до каждой
// записи); restore в finally; ≤30 запросов/мин (лимитер MCP), closeBrowser в finally.
// Предусловия мутации высот (иначе STOP до записи — восстановление было бы неточным):
//   - у всех комнат rooms2 и всех стен не-balcony height присутствует и == total_height
//     (строго, ревью 420 №3: project_set_height пишет height всем — запись в модель
//     без height добавила бы поле, отсутствующее в бэкапе, и сломало бы sig);
//   - исходный total_height < 999 см (новая высота выше — окна/балконные блоки не
//     поджимаются, restore через project_set_height(исходная) точен);
//   - доработка 419: колонны — симуляция веток gypsum бандла в обе стороны
//     идентична исходным значениям; двери — нет дверей выше новой высоты
//     (кламп бандла безвозвратен); раскладок wall_tile/wall_woodbatten нет
//     (MCP сбрасывает их на пересчёт редактором, точность restore не проверяется);
//   - предмет для B (если есть) с demount≠1.
//   REMPLANNER_PROBE_OBJECT_ID=… REMPLANNER_PROBE_PLAN_ID=… \
//   REMPLANNER_PROBE_READONLY_ID=… REMPLANNER_PROBE_READONLY_PLAN_ID=… \
//   REMPLANNER_PROBE_RUN_N=1 [REMPLANNER_PROBE_WRITE_BACKUP=1] \
//   node scripts/probes/419-height-demount-live.ts run
// RUN_N≥2 — повторный прогон БЕЗ REMPLANNER_PROBE_WRITE_BACKUP и только при
// существующем бэкапе (как в 406/этап 410).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { loadModel, type LoadedModel } from "../../src/api.ts";
import { gitRepoRoot } from "../../src/repo-root.ts";
import { DEMOUNTABLE_ITEM_NAMES } from "../../src/model/demolition.ts";
import type { Model } from "../../src/model/types.ts";
import type { Page } from "playwright-core";
import { sig } from "./probe-sig.ts";
import { assertEditorPlanMatch, probeWriteEnv, assertTargetPair, readonlyGuard, readonlyRefPath } from "./probe-guard.ts";

const phase = process.argv[2] ?? "run";
const ROOT_DIR = (): string => {
  const root = gitRepoRoot();
  if (!root) throw new Error("корень репо не найден (git недоступен) — пробы нельзя адресовать");
  return root;
};
mkdirSync(join(ROOT_DIR(), ".orca-reports/tmp"), { recursive: true });
const backupPathOf = (objectId: string): string => join(ROOT_DIR(), ".orca-reports", `backup-${objectId}-419.json`);
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 14 * 60_000).unref();

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "419-height-demount-live", version: "0.0.0" });
const [ta, tb] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(tb), client.connect(ta)]);
type TextContent = { content: { type: string; text?: string }[] };
const text = (r: unknown): string => ((r as TextContent).content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  if ((res as { isError?: boolean }).isError) throw new Error(`${name}: ${text(res).slice(0, 600)}`);
  return JSON.parse(text(res)) as Record<string, unknown>;
};
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const runN = process.env["REMPLANNER_PROBE_RUN_N"] ?? "";
if (!/^\d+$/.test(runN)) {
  console.error("нужен REMPLANNER_PROBE_RUN_N=<номер прогона> — журнал пишется по номеру, не перезаписывается");
  process.exit(1);
}
const capturedPath = (n: number): string => join(ROOT_DIR(), ".orca-reports/tmp", `419-captured-${runN}-${n}.json`);
let capturedN = 0;
while (existsSync(capturedPath(capturedN))) capturedN++;
const CAPTURED = capturedPath(capturedN);
/** Журнал исходных значений (до мутаций): высоты, колонны, двери и предмет. */
type Original = {
  total_height_cm: number;
  new_height_mm: number;
  rooms2_heights: Record<string, number | null>;
  walls_heights: Record<string, number | null>;
  pillars_heights: Record<string, number | null>;
  doors_heights: Record<string, number | null>;
  item: { id: string; demount: number } | null;
};
let original: Original | null = null;
const journal = (): void => { if (original) writeFileSync(CAPTURED, JSON.stringify(original, null, 1) + "\n"); };

let exitCode = 0;
const check = (ok: boolean, msg: string): void => { console.log(`${ok ? "PASS" : "FAIL"}: ${msg}`); if (!ok) exitCode = 1; };
const editorOf = (): Parameters<typeof assertEditorPlanMatch>[0] | null =>
  (ctx as unknown as { workspaceOrNull: { editorOrNull: () => Parameters<typeof assertEditorPlanMatch>[0] | null } | null }).workspaceOrNull?.editorOrNull?.() ?? null;
/** Рабочая модель MCP (без сети). */
const workspaceModel = (): Model =>
  ((ctx as unknown as { workspaceOrNull: { model: Model } | null }).workspaceOrNull?.model ?? {}) as Model;

type HeightSnapshot = { total: unknown; rooms: Record<string, unknown>; walls: Record<string, unknown>; balcony: Record<string, unknown> };
const heightSnapshot = (m: Record<string, unknown>): HeightSnapshot => {
  const rooms: Record<string, unknown> = {};
  for (const [rid, r] of Object.entries((m["rooms2"] ?? {}) as Record<string, Record<string, unknown>>)) rooms[rid] = r["height"];
  const walls: Record<string, unknown> = {};
  const balcony: Record<string, unknown> = {};
  for (const [wid, w] of Object.entries((m["walls"] ?? {}) as Record<string, Record<string, unknown>>)) {
    if (w["role"] === "balcony") balcony[wid] = w["height"];
    else walls[wid] = w["height"];
  }
  return { total: m["total_height"], rooms, walls, balcony };
};
/** Колонны: id → total_height (null, если поля нет). */
const pillarsSnapshot = (m: Record<string, unknown>): Record<string, number | null> =>
  Object.fromEntries(Object.entries((m["pillars"] ?? {}) as Record<string, Record<string, unknown>>)
    .map(([pid, p]) => [pid, typeof p["total_height"] === "number" ? p["total_height"] as number : null]));

/** Двери (группа doors) всех стен не-balcony: "wall/hole" → height. */
const doorsSnapshot = (m: Record<string, unknown>): Record<string, number | null> => {
  const out: Record<string, number | null> = {};
  for (const [wid, w] of Object.entries((m["walls"] ?? {}) as Record<string, Record<string, unknown>>)) {
    if (w["role"] === "balcony") continue;
    for (const [hid, h] of Object.entries((w["holes"] ?? {}) as Record<string, Record<string, unknown>>)) {
      if (h["group"] !== "doors") continue;
      out[`${wid}/${hid}`] = typeof h["height"] === "number" ? h["height"] as number : null;
    }
  }
  return out;
};

/**
 * Модель ветки колонн бандла (setHeigth): возвращает total_height колонны после
 * двух вызовов — новая высота (newCm) и restore к исходной (origCm). Идентичность
 * — предусловие точного restore.
 */
const simulatePillar = (role: unknown, h0: number | null, origCm: number, newCm: number): number | null => {
  const step = (h: number | null, prevTotal: number, e: number): number | null => {
    if (role !== "gypsum") return e;
    if (h === prevTotal || (h !== null && h > e)) return e;
    return h;
  };
  return step(step(h0, origCm, newCm), newCm, origCm);
};

/**
 * Есть ли в decors частей wall_tile/wall_woodbatten с type_laying и заполненной
 * раскладкой (их точность restore раскладки редактором в пробе не проверяется —
 * см. шапку; при наличии — STOP до записи).
 */
const hasPersistentDecorLayouts = (m: Record<string, unknown>): number => {
  let n = 0;
  for (const r of Object.values((m["rooms2"] ?? {}) as Record<string, Record<string, unknown>>)) {
    const decors = r["decors"];
    if (!Array.isArray(decors)) continue;
    for (const d of decors as Array<Record<string, unknown>>) {
      const parts = d?.["parts"];
      if (!d || d["exist"] !== true || !parts || typeof parts !== "object") continue;
      for (const part of Object.values(parts as Record<string, Record<string, unknown>>)) {
        const t = part?.["type"];
        if ((t === "wall_tile" || t === "wall_woodbatten") && part["type_laying"] &&
          part["polygons_layout"] !== undefined && !(Array.isArray(part["polygons_layout"]) && (part["polygons_layout"] as unknown[]).length === 0)) n++;
      }
    }
  }
  return n;
};

/** Предмет для B: имя из DEMOUNTABLE_ITEM_NAMES, demount≠1 (по бэкапу); план не проверяется — ревью 420 №1: бандл демонтирует radiator_old/electric_shield_old при любом props.plan. */
const findDemountable = (m: Record<string, unknown>): { id: string; name: string; demount: number } | null => {
  for (const [id, it] of Object.entries((m["items"] ?? {}) as Record<string, Record<string, unknown>>)) {
    const name = String(it["name"] ?? "");
    if (!DEMOUNTABLE_ITEM_NAMES.has(name)) continue;
    const demount = it["demount"] === 1 ? 1 : 0;
    if (demount === 1) continue;
    return { id, name, demount };
  }
  return null;
};

let roGuard: Awaited<ReturnType<typeof readonlyGuard>> | null = null;
try {
  const ids = probeWriteEnv();
  await assertTargetPair(ctx.session(), ids.objectId, ids.planId);
  roGuard = await readonlyGuard(ctx.session(), ids.readonlyId, ids.readonlyPlanId, readonlyRefPath(ids.readonlyId, ids.readonlyPlanId));
  const gsave = async (tag: string): Promise<Record<string, unknown>> => {
    await roGuard!.assertUnchanged(`save:${tag}`);
    journal();
    const r = await call("project_save", {}) as { verified?: boolean; warnings?: unknown[] };
    console.log(`save ${tag}: verified=${r["verified"]} warnings=${JSON.stringify((r["warnings"] ?? []).map((w) => String(w).slice(0, 160)))}`);
    if (!r["verified"]) throw new Error(`save ${tag} не verified`);
    await delay(5500);
    return r;
  };
  /** Запись через MCP с гардом READONLY до вызова. */
  const guardedCall = async (tag: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    await roGuard!.assertUnchanged(`write:${name}:${tag}`);
    journal();
    return call(name, args);
  };

  const backupPath = backupPathOf(ids.objectId);
  if (runN !== "1" && (process.env["REMPLANNER_PROBE_WRITE_BACKUP"] === "1" || !existsSync(backupPath))) {
    console.error(`RUN_N=${runN}: повторный прогон идёт без записи бэкапа и только при существующем ${backupPath} — уберите REMPLANNER_PROBE_WRITE_BACKUP / проверьте бэкап. СТОП`);
    await closeBrowser().catch(() => {});
    process.exit(1);
  }
  if (existsSync(backupPath)) {
    console.log("backup exists — НЕ перезаписывается:", backupPath);
  } else if (phase === "run" && process.env["REMPLANNER_PROBE_WRITE_BACKUP"] === "1") {
    const before: LoadedModel = await loadModel(ctx.session(), ids.objectId, ids.planId);
    writeFileSync(backupPath, JSON.stringify(before, null, 1) + "\n");
    console.log("backup written (run + REMPLANNER_PROBE_WRITE_BACKUP=1):", backupPath);
  } else {
    console.error(`нет бэкапа ${backupPath} — СТОП (пишется только фазой run с REMPLANNER_PROBE_WRITE_BACKUP=1)`);
    await closeBrowser().catch(() => {});
    process.exit(1);
  }
  const backup = JSON.parse(readFileSync(backupPath, "utf8")) as LoadedModel;
  await roGuard!.assertUnchanged("before");

  if (phase !== "run") {
    console.error("фаза: run (у пробы 419 нет отдельной cleanup — restore в finally каждого прогона)");
    process.exit(1);
  }

  const bm = backup.model;
  const totalCm = typeof bm["total_height"] === "number" ? (bm["total_height"] as number) : 270;
  const roomsSnap = heightSnapshot(bm);
  // предусловия точного восстановления (иначе — STOP до записи).
  // Строго (ревью 420 №3): project_set_height пишет height ВСЕМ комнатам и всем
  // не-balcony стенам безусловно (src/model/height.ts: setHeigth бандла), а канон
  // sig (probe-sig roundDeep) сохраняет поле height записи как есть. Комната/стена
  // без height в бэкапе после restore получила бы поле, которого в бэкапе нет,
  // → sig vs backup «РАСХОЖДЕНИЕ» при семантически точном restore (ложный FAIL).
  // Поэтому требуем height === total_height уже в бэкапе и останавливаемся ДО
  // первой записи — тогда sig vs backup остаётся точным по построению.
  const roomsOk = Object.values(roomsSnap.rooms).every((h) => h === totalCm);
  const wallsOk = Object.values(roomsSnap.walls).every((h) => h === totalCm);
  console.log(`предусловия: total_height=${totalCm} см; комнаты height≠total: ${JSON.stringify(Object.entries(roomsSnap.rooms).filter(([, h]) => h !== totalCm))}; стены height≠total: ${JSON.stringify(Object.entries(roomsSnap.walls).filter(([, h]) => h !== totalCm))}`);
  if (!roomsOk || !wallsOk) {
    throw new Error(`предусловия не выполнены (roomsOk=${roomsOk} wallsOk=${wallsOk}): у каждой комнаты/стены height должен быть равен total_height (restore через project_set_height записывает height всем, запись в модель без height дала бы поле, которого нет в бэкапе, и ложное расхождение sig). СТОП до записи`);
  }
  if (totalCm >= 999) {
    throw new Error(`исходная высота ${totalCm} см — выше максимума новой нет (клампинг окон сделал бы restore неточным). СТОП до записи`);
  }
  const newHeightMm = Math.min(999, totalCm + 30) * 10;
  const newCm = newHeightMm / 10;
  // доработка 419: предусловия колонн, дверей и раскладок обшивки (точность restore)
  const pillars0 = pillarsSnapshot(bm);
  const pillarsRec = (bm["pillars"] ?? {}) as Record<string, Record<string, unknown>>;
  const pillarsBad = Object.entries(pillars0).filter(([pid, h]) => simulatePillar(
    pillarsRec[pid]?.["role"], h, totalCm, newCm) !== h);
  const doors0 = doorsSnapshot(bm);
  const doorsBad = Object.entries(doors0).filter(([, h]) => h !== null && (h as number) > newCm);
  const decorLayouts = hasPersistentDecorLayouts(bm);
  console.log(`предусловия доработки: колонны ${JSON.stringify(pillars0)}; двери ≠null и >new: ${JSON.stringify(doorsBad)}; раскладок wall_tile/wall_woodbatten: ${decorLayouts}`);
  if (pillarsBad.length > 0) {
    throw new Error(`колонны с неточным restore (ветка gypsum бандла): ${JSON.stringify(pillarsBad)} — СТОП до записи`);
  }
  if (doorsBad.length > 0) {
    throw new Error(`двери выше новой высоты ${newCm} см поджались бы безвозвратно (бандл не распрямляет): ${JSON.stringify(doorsBad)} — СТОП до записи`);
  }
  if (decorLayouts > 0) {
    throw new Error(`в dev-объекте ${decorLayouts} раскладок wall_tile/wall_woodbatten — MCP сбросит их на пересчёт редактором, точность restore раскладки в пробе не проверяется — СТОП до записи`);
  }
  const item0 = findDemountable(bm);
  original = {
    total_height_cm: totalCm,
    new_height_mm: newHeightMm,
    rooms2_heights: Object.fromEntries(Object.entries(roomsSnap.rooms).map(([k, v]) => [k, typeof v === "number" ? v : null])),
    walls_heights: {
      ...Object.fromEntries(Object.entries(roomsSnap.walls).map(([k, v]) => [k, typeof v === "number" ? v : null])),
      ...Object.fromEntries(Object.entries(roomsSnap.balcony).map(([k, v]) => [k, typeof v === "number" ? v : null])),
    } as Record<string, number | null>,
    pillars_heights: pillars0,
    doors_heights: doors0,
    item: item0 ? { id: item0.id, demount: item0.demount } : null,
  };
  journal();
  console.log(`план: высота ${totalCm} см → ${newCm} см (${newHeightMm} мм); предмет для B: ${item0 ? `${item0.name} (${item0.id})` : "нет — B пропускается"}`);

  await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
  await call("render_plan", {});
  await assertEditorPlanMatch(editorOf(), ids.planId);
  check(true, "открытие + render_plan + гард плана");

  // ==== A) project_set_height ====
  const setRes = await guardedCall("новая высота", "project_set_height", { height_mm: newHeightMm });
  console.log("project_set_height:", JSON.stringify({ height_mm: setRes["height_mm"], rooms: setRes["rooms"], walls: setRes["walls"], windows_clamped: setRes["windows_clamped"], windoors_clamped: setRes["windoors_clamped"], doors_clamped: setRes["doors_clamped"], pillars: setRes["pillars"], decors_layouts_reset: setRes["decors_layouts_reset"] }));
  check(setRes["height_mm"] === newHeightMm && setRes["windows_clamped"] === 0 && setRes["windoors_clamped"] === 0, `project_set_height: новая высота ${newHeightMm} мм, клампинга окон нет (выше исходной)`);
  check(setRes["doors_clamped"] === 0, `project_set_height: doors_clamped=${String(setRes["doors_clamped"])} (предусловие: двери ≤ ${newCm} см)`);
  check(Number(setRes["pillars"]) === Object.keys(pillars0).length, `project_set_height: колонны обновлены (${String(setRes["pillars"])}/${Object.keys(pillars0).length})`);
  const workA = heightSnapshot(workspaceModel() as unknown as Record<string, unknown>);
  check(workA.total === newCm, `рабочая модель: total_height=${String(workA.total)} см`);
  check(Object.values(workA.rooms).every((h) => h === newCm), `рабочая модель: rooms2[].height=${JSON.stringify(workA.rooms)}`);
  check(Object.values(workA.walls).every((h) => h === newCm), `рабочая модель: walls[].height=${JSON.stringify(workA.walls)}`);
  check(JSON.stringify(workA.balcony) === JSON.stringify(roomsSnap.balcony), `рабочая модель: балкон без изменений ${JSON.stringify(workA.balcony)}`);
  // доработка 419: колонны и двери в рабочей модели (ожидание — ОДИН шаг бандла:
  // после вызова новой высоты; двухшаговая симуляция restore — в предусловии выше)
  const workPillars = pillarsSnapshot(workspaceModel() as unknown as Record<string, unknown>);
  const pillarsExpect = Object.fromEntries(Object.entries(pillars0).map(([pid, h]) => [pid, h === null ? null : (pillarsRec[pid]?.["role"] === "gypsum" ? (h === totalCm || h > newCm ? newCm : h) : newCm)]));
  check(JSON.stringify(workPillars) === JSON.stringify(pillarsExpect), `рабочая модель: колонны ${JSON.stringify(workPillars)} == ожидание веток бандла ${JSON.stringify(pillarsExpect)}`);
  const workDoors = doorsSnapshot(workspaceModel() as unknown as Record<string, unknown>);
  check(JSON.stringify(workDoors) === JSON.stringify(doors0), `рабочая модель: двери без изменений (${Object.keys(workDoors).length} шт.)`);
  await call("model_validate", {});
  await gsave("новая высота");
  await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
  await assertEditorPlanMatch(editorOf(), ids.planId);
  const gotA = await loadModel(ctx.session(), ids.objectId, ids.planId);
  const snapA = heightSnapshot(gotA.model);
  check(snapA.total === newCm, `независимый loadModel: total_height=${String(snapA.total)} см`);
  check(Object.values(snapA.rooms).every((h) => h === newCm), `независимый loadModel: rooms2[].height=${JSON.stringify(snapA.rooms)}`);
  check(Object.values(snapA.walls).every((h) => h === newCm), `независимый loadModel: walls[].height=${JSON.stringify(snapA.walls)}`);
  check(JSON.stringify(snapA.balcony) === JSON.stringify(roomsSnap.balcony), `независимый loadModel: балкон без изменений ${JSON.stringify(snapA.balcony)}`);
  // доработка 419: колонны и двери после save/reopen (независимый loadModel)
  const gotPillars = pillarsSnapshot(gotA.model);
  check(JSON.stringify(gotPillars) === JSON.stringify(pillarsExpect), `независимый loadModel: колонны ${JSON.stringify(gotPillars)} == ожидание ${JSON.stringify(pillarsExpect)}`);
  const gotDoors = doorsSnapshot(gotA.model);
  check(JSON.stringify(gotDoors) === JSON.stringify(doors0), `независимый loadModel: двери без изменений (${JSON.stringify(gotDoors)})`);

  // ==== B) demolish target:"item" ====
  if (item0) {
    const dres = await guardedCall("demolish item", "demolish", { target: "item", id: item0.id });
    check(dres["itemId"] === item0.id, `demolish target:item → itemId=${String(dres["itemId"])}`);
    check((workspaceModel().items?.[item0.id] as Record<string, unknown> | undefined)?.["demount"] === 1, "рабочая модель: props.demount=1");
    await call("model_validate", {});
    await gsave("demolish item");
    await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
    await assertEditorPlanMatch(editorOf(), ids.planId);
    const gotB = await loadModel(ctx.session(), ids.objectId, ids.planId);
    const afterDem = ((gotB.model["items"] ?? {}) as Record<string, Record<string, unknown>>)[item0.id]?.["demount"];
    check(afterDem === 1, `независимый loadModel: demount=${String(afterDem)}`);
    const cres = await guardedCall("cancel item", "demolish_cancel", { target: "item", id: item0.id });
    check(cres["itemId"] === item0.id, `demolish_cancel target:item → itemId=${String(cres["itemId"])}`);
    // бандл 268-app.js, Item.serialize (~2232892): 0===i.demount && delete i.demount —
    // demount=0 (значение по умолчанию) НЕ персистится ни нормализатором в рабочей
    // модели, ни сервером; в бэкапе у предмета поля demount нет вовсе. Отсутствие
    // поля семантически равно demount=0 (доказательство: независимый loadModel 419-3)
    const demAfterCancelWs = (workspaceModel().items?.[item0.id] as Record<string, unknown> | undefined)?.["demount"];
    check(demAfterCancelWs === 0 || demAfterCancelWs === undefined, `рабочая модель: props.demount=${String(demAfterCancelWs)} (0 или поле отсутствует — serialize бандла удаляет 0)`);
    await gsave("demolish_cancel item");
    await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
    await assertEditorPlanMatch(editorOf(), ids.planId);
    const gotB2 = await loadModel(ctx.session(), ids.objectId, ids.planId);
    const demAfterCancel = ((gotB2.model["items"] ?? {}) as Record<string, Record<string, unknown>>)[item0.id]?.["demount"];
    // бандл (~2232892): serialize удаляет demount:0 — после save/reopen поля нет;
    // это и есть demount=0 (независимый loadModel, 419-3)
    check(demAfterCancel === 0 || demAfterCancel === undefined, `независимый loadModel: demount=${String(demAfterCancel)} (0 или поле отсутствует — serialize бандла удаляет 0)`);
  } else {
    console.log("SKIP: B вживую не выполняется — в dev-объекте нет предмета radiator_old/electric_shield_old с demount≠1; предмет не создаётся (без эталона из UI)");
  }

  // ==== render_plan ====
  const png = await call("render_plan", {});
  check(typeof png["bytes"] === "number" && (png["bytes"] as number) > 1000, `render_plan PNG: ${String(png["bytes"])} байт`);
} catch (e) {
  console.error("ERROR:", String((e as Error).message).slice(0, 400));
  exitCode = 1;
  try {
    const ids = probeWriteEnv();
    const after = await loadModel(ctx.session(), ids.objectId, ids.planId);
    const backupPath = backupPathOf(ids.objectId);
    if (existsSync(backupPath)) console.error("sig (catch) vs backup:", sig(after.model) === sig((JSON.parse(readFileSync(backupPath, "utf8")) as LoadedModel).model) ? "OK" : "РАСХОЖДЕНИЕ");
  } catch (ce) { console.error("sig (catch) недоступен:", String((ce as Error).message).slice(0, 150)); }
} finally {
  if (phase === "run" && roGuard !== null) {
    try {
      const ids = probeWriteEnv();
      await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
      await assertEditorPlanMatch(editorOf(), ids.planId);
      // restore: предмет → demount=0 (если остался демонтированным), высота назад
      const ws = workspaceModel();
      if (original?.item && (ws.items?.[original.item.id] as Record<string, unknown> | undefined)?.["demount"] === 1) {
        journal();
        await roGuard.assertUnchanged("restore:cancel");
        await call("demolish_cancel", { target: "item", id: original.item.id });
        console.log("restore: demolish_cancel item");
      }
      if (original) {
        journal();
        await roGuard.assertUnchanged("restore:height");
        await call("project_set_height", { height_mm: original.total_height_cm * 10 });
        console.log(`restore: project_set_height ${original.total_height_cm * 10} мм`);
      }
      journal();
      await roGuard.assertUnchanged("restore:save");
      const r = await call("project_save", {}) as { verified?: boolean };
      console.log(`restore save: verified=${r["verified"]}`);
      if (r["verified"] !== true) throw new Error("restore save не verified");
      await delay(5500);
      const after = await loadModel(ctx.session(), ids.objectId, ids.planId);
      const backupPath = backupPathOf(ids.objectId);
      if (original) {
        check(JSON.stringify(pillarsSnapshot(after.model)) === JSON.stringify(original.pillars_heights), `restore: колонны вернулись к исходным ${JSON.stringify(pillarsSnapshot(after.model))}`);
        check(JSON.stringify(doorsSnapshot(after.model)) === JSON.stringify(original.doors_heights), `restore: двери вернулись к исходным (${Object.keys(doorsSnapshot(after.model)).length} шт.)`);
      }
      if (existsSync(backupPath)) {
        const same = sig(after.model) === sig((JSON.parse(readFileSync(backupPath, "utf8")) as LoadedModel).model);
        console.log("sig (итог) vs backup:", same ? "OK" : "РАСХОЖДЕНИЕ");
        if (!same) exitCode = 1;
      }
      await roGuard.assertUnchanged("итог");
    } catch (fe) { console.error("finally НЕ УДАЛСЯ — восстановите по журналу/бэкапу:", String((fe as Error).message).slice(0, 300)); exitCode = 1; }
  }
  await closeBrowser().catch(() => {});
}
console.log("EXIT:", exitCode);
process.exit(exitCode);
