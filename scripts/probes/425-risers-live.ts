// 425: живая проверка стояков и ввода воды (бэклог 418 §3 п.E) в dev-объекте.
// Ключи: water, water_column_hot, water_column_cold, drainage_column, ceiling_water.
// (ID — ТОЛЬКО из env командной строки, в файл не пишутся; проба открывает
// dev-объект, никаких новых проектов.) Сценарий НА КАЖДЫЙ ключ:
//   item_add against_wall (у стены самой большой комнаты dev-объекта, gap 0) →
//   рабочая модель (id_wall, id_room, план {a:1}, размеры/высота из каталога,
//   dimensions.display, pc на depth/2 от внутренней грани — по эталонам
//   tests/fixtures/ui-ref-comm-*) → model_validate → save → reopen →
//   независимый loadModel (те же поля; projection/wall_line редактора — если
//   есть, инварианты |pc−projection|=depth/2 и |wall_line|=width; эталон
//   ui-ref-comm-water_column_hot снят в промежуточном магнитe — там без
//   wall_line, отсутствие/нестыковка derived-полей не FAIL) → render_plan →
//   item_delete (только предмет пробы, по site_id; пользовательские предметы
//   не трогаются); restore в finally: удалить оставшиеся предметы пробы,
//   save, sig == бэкап (канон probe-sig).
// В dev-объекте УЖЕ есть предметы water/water_column_cold/ceiling_water (этап 57) —
// проба ставит ВТОРОЙ экземпляр того же вида и различает свои предметы по id
// из ответа item_add (site_id), не по имени.
// Гарды (канон 399/404/406/419): probe-guard (пара объект/план fail-closed,
// READONLY-гард по корневому эталону БЕЗ REF_INIT, assertEditorPlanMatch),
// assertUnchanged READONLY перед КАЖДОЙ записью и в конце; бэкап dev-объекта
// fail-closed: <корень репо>/.orca-reports/backup-<OBJECT_ID>-425.json —
// АБСОЛЮТНЫЙ путь через gitRepoRoot, НЕ перезаписывается, пишется ТОЛЬКО фазой
// run с REMPLANNER_PROBE_WRITE_BACKUP=1, при отсутствии — стоп; журнал исходных
// значений (<корень>/.orca-reports/tmp/425-captured-<N>-<n>.json, абсолютный
// путь, до каждой записи); restore в finally; ≤30 запросов/мин (лимитер MCP),
// closeBrowser в finally.
//   REMPLANNER_PROBE_OBJECT_ID=… REMPLANNER_PROBE_PLAN_ID=… \
//   REMPLANNER_PROBE_READONLY_ID=… REMPLANNER_PROBE_READONLY_PLAN_ID=… \
//   REMPLANNER_PROBE_RUN_N=1 [REMPLANNER_PROBE_WRITE_BACKUP=1] \
//   node scripts/probes/425-risers-live.ts run
// RUN_N≥2 — повторный прогон БЕЗ REMPLANNER_PROBE_WRITE_BACKUP и только при
// существующем бэкапе (как в 406/419).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { loadModel, type LoadedModel } from "../../src/api.ts";
import { gitRepoRoot } from "../../src/repo-root.ts";
import { againstWallPlacement } from "../../src/model/items.ts";
import { pointInPolygon } from "../../src/model/geometry.ts";
import type { Model, Point, Wall } from "../../src/model/types.ts";
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
const backupPathOf = (objectId: string): string => join(ROOT_DIR(), ".orca-reports", `backup-${objectId}-425.json`);
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 14 * 60_000).unref();

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "425-risers-live", version: "0.0.0" });
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
const capturedPath = (n: number): string => join(ROOT_DIR(), ".orca-reports/tmp", `425-captured-${runN}-${n}.json`);
let capturedN = 0;
while (existsSync(capturedPath(capturedN))) capturedN++;
const CAPTURED = capturedPath(capturedN);
/** Журнал исходных значений (до мутаций): стена и предметы пробы. */
type Original = { wall_id: string; offset_mm: number; probe_items: { key: string; site_id: string }[] };
let original: Original | null = null;
const journal = (): void => { if (original) writeFileSync(CAPTURED, JSON.stringify(original, null, 1) + "\n"); };

let exitCode = 0;
const check = (ok: boolean, msg: string): void => { console.log(`${ok ? "PASS" : "FAIL"}: ${msg}`); if (!ok) exitCode = 1; };
const editorOf = (): Parameters<typeof assertEditorPlanMatch>[0] | null =>
  (ctx as unknown as { workspaceOrNull: { editorOrNull: () => Parameters<typeof assertEditorPlanMatch>[0] | null } | null }).workspaceOrNull?.editorOrNull?.() ?? null;
/** Рабочая модель MCP (без сети). */
const workspaceModel = (): Model =>
  ((ctx as unknown as { workspaceOrNull: { model: Model } | null }).workspaceOrNull?.model ?? {}) as Model;

const KEYS = ["water", "water_column_hot", "water_column_cold", "drainage_column", "ceiling_water"] as const;
type Ref = { menu_title: string; catalog_defaults_cm: Record<string, unknown>; model_object: Record<string, unknown> };
// эталоны — из worktree пробы (относительно файла, НЕ от корня репо: в worktree
// корень — основной checkout, там фикстур этой ветки нет)
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tests", "fixtures");
const refOf = (key: string): Ref => JSON.parse(readFileSync(join(FIXTURES, `ui-ref-comm-${key}.json`), "utf8")) as Ref;
const distToAxis = (w: { p1: Point; p2: Point }, pc: Point): number => {
  const dx = w.p2.x - w.p1.x, dy = w.p2.y - w.p1.y;
  return Math.abs(dy * (pc.x - w.p1.x) - dx * (pc.y - w.p1.y)) / Math.hypot(dx, dy);
};
const axisAngleNorm = (w: { p1: Point; p2: Point }): number => {
  let a = (Math.atan2(w.p2.y - w.p1.y, w.p2.x - w.p1.x) * 180) / Math.PI;
  if (a > 90) a -= 180;
  if (a <= -90) a += 180;
  return a;
};
const angleDiff = (a: number, b: number): number => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
const near = (a: number, b: number, tol = 0.05): boolean => Math.abs(a - b) <= tol;

/** Стена постановки: самая длинная не-balcony стена, у которой pc предмета
 *  (по формуле againstWallPlacement, максимальные габариты ключей) попадает
 *  в полигон комнаты; предмет — в середине стены. */
const chooseWall = (m: Record<string, unknown>): { wallId: string; offsetMm: number } => {
  const rooms = Object.values((m["rooms2"] ?? {}) as Record<string, Record<string, unknown>>)
    .filter((r) => Array.isArray(r["polygon"]))
    .map((r) => r["polygon"] as Point[]);
  const walls = (m["walls"] ?? {}) as Record<string, Record<string, unknown>>;
  let best: { wallId: string; offsetMm: number; len: number } | null = null;
  for (const [wid, w] of Object.entries(walls)) {
    if (w["role"] === "balcony") continue;
    const wall = { id: wid, p1: w["p1"] as Point, p2: w["p2"] as Point, depth: Number(w["depth"] ?? 10) } as unknown as Wall;
    const len = Math.hypot(wall.p2.x - wall.p1.x, wall.p2.y - wall.p1.y);
    if (len < 100) continue;
    const widthCm = 20, depthCm = 20;
    const offsetMm = Math.max(0, Math.round((len / 2 - widthCm / 2) * 10));
    const placement = againstWallPlacement(wall, { wallId: wid, offsetMm }, widthCm, depthCm, rooms.map((polygon, i) => ({ roomId: String(i), polygon, areaCm2: 0, axisAreaCm2: null })));
    if (!rooms.some((poly) => pointInPolygon(poly, placement.pc))) continue;
    if (!best || len > best.len) best = { wallId: wid, offsetMm, len };
  }
  if (!best) throw new Error("не нашлось стены для постановки (pc вне комнат у всех) — СТОП до записи");
  return { wallId: best.wallId, offsetMm: best.offsetMm };
};

/** Семантические поля предмета пробы: значимая привязка к стене (по эталону). */
const checkItemFields = (tag: string, key: string, it: Record<string, unknown>, ref: Ref, wall: Record<string, unknown>, wallId: string): void => {
  const src = ref.model_object;
  check(it["name"] === src["name"], `${tag} ${key}: name=${String(it["name"])}`);
  check(it["id_wall"] === wallId, `${tag} ${key}: id_wall=${String(it["id_wall"])} (стена постановки)`);
  check(it["id_room"] != null && it["id_room"] !== "", `${tag} ${key}: id_room=${String(it["id_room"])}`);
  check(JSON.stringify(it["plan"]) === JSON.stringify({ a: 1 }), `${tag} ${key}: план ${JSON.stringify(it["plan"])} == {a:1}`);
  check(it["width"] === src["width"] && it["height"] === src["height"], `${tag} ${key}: размеры ${String(it["width"])}×${String(it["height"])} == эталон ${String(src["width"])}×${String(src["height"])}`);
  check(Number(it["self_height"] ?? 0) === Number(src["self_height"] ?? 0), `${tag} ${key}: self_height=${String(it["self_height"])}`);
  check((it["dimensions"] as { display?: boolean } | undefined)?.display === (src["dimensions"] as { display?: boolean }).display, `${tag} ${key}: dimensions.display=${String((it["dimensions"] as { display?: boolean } | undefined)?.display)}`);
  // pc на depth/2 от внутренней грани (= depth_стены/2 + depth/2 от оси)
  const wantDist = Number(wall["depth"] ?? 10) / 2 + Number(src["height"]) / 2;
  const gotDist = distToAxis({ p1: wall["p1"] as Point, p2: wall["p2"] as Point }, it["pc"] as Point);
  check(near(gotDist, wantDist), `${tag} ${key}: pc на ${gotDist.toFixed(2)} см от оси стены (ожидалось ${wantDist})`);
  // угол = угол оси стены (эталон: angle 0/90/180 у примагниченных; 0 и 180 —
  // эквивалентные направления оси, сверка modulo 180)
  if (it["angle"] !== undefined && it["angle"] !== null) {
    const diff = angleDiff(Number(it["angle"]), axisAngleNorm({ p1: wall["p1"] as Point, p2: wall["p2"] as Point }));
    // 0 и 180 — эквивалентные направления оси (эталон water: angle 180 на
    // горизонтальной стене); сверка modulo 180
    check(diff <= 0.05 || Math.abs(diff - 180) <= 0.05, `${tag} ${key}: angle=${String(it["angle"])} по оси стены (${axisAngleNorm({ p1: wall["p1"] as Point, p2: wall["p2"] as Point })})`);
  }
  // derived-поля редактора (кеш UI, пересчитывается при draw): инварианты
  // сверяются только если поля есть; эталон water_column_hot (промежуточный
  // магнит, без wall_line, projection ≠ pc − depth/2) — доказательство, что
  // отсутствие/нестыковка derived-полей не факт о постановке
  const projection = it["projection"] as Point | undefined;
  const wallLine = it["wall_line"] as { p1: Point; p2: Point } | undefined;
  if (projection && wallLine) {
    const d = Math.hypot((it["pc"] as Point).x - projection.x, (it["pc"] as Point).y - projection.y);
    check(near(d, Number(src["height"]) / 2, 0.11), `${tag} ${key}: |pc − projection|=${d.toFixed(2)} == depth/2 (${Number(src["height"]) / 2})`);
    const len = Math.hypot(wallLine.p2.x - wallLine.p1.x, wallLine.p2.y - wallLine.p1.y);
    check(near(len, Number(src["width"]), 0.11), `${tag} ${key}: |wall_line|=${len.toFixed(2)} == width (${String(src["width"])})`);
  } else {
    console.log(`SKIP: ${tag} ${key}: derived-полей нет (projection=${projection ? "есть" : "нет"}, wall_line=${wallLine ? "есть" : "нет"}) — редактор пересчитывает при draw, не факт о постановке (эталон water_column_hot)`);
  }
};

let roGuard: Awaited<ReturnType<typeof readonlyGuard>> | null = null;
/** Модель бэкапа — для страховки restore (предметы, которых нет в бэкапе). */
let bm: Record<string, unknown> = {};
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
    console.error("фаза: run (у пробы 425 нет отдельной cleanup — restore в finally каждого прогона)");
    process.exit(1);
  }

  bm = backup.model as Record<string, unknown>;
  const wall = chooseWall(bm);
  const backupItemNames = new Set(Object.values((bm["items"] ?? {}) as Record<string, Record<string, unknown>>).map((it) => String(it["name"])));
  original = { wall_id: wall.wallId, offset_mm: wall.offsetMm, probe_items: [] };
  journal();
  console.log(`план: стена ${wall.wallId}, offset ${wall.offsetMm} мм; ключи: ${KEYS.join(", ")}`);
  console.log(`в бэкапе уже есть предметы видов: ${[...backupItemNames].filter((n) => (KEYS as readonly string[]).includes(n)).join(", ") || "нет"} (проба различает свои предметы по site_id)`);

  await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
  await call("render_plan", {});
  await assertEditorPlanMatch(editorOf(), ids.planId);
  check(true, "открытие + render_plan + гард плана");

  for (const key of KEYS) {
    console.log(`=== ${key} ===`);
    const ref = refOf(key);
    const addRes = await guardedCall(`add ${key}`, "item_add", {
      name: key,
      position: { against_wall: { wall_id: wall.wallId, offset_mm: wall.offsetMm, gap_mm: 0 } },
    });
    // ответ item_add: {hint, entity: CompactItem | null} — site_id = ключ в model.items
    const entity = addRes["entity"] as Record<string, unknown> | null | undefined;
    const siteId = String((entity as { site_id?: unknown } | null | undefined)?.["site_id"] ?? "");
    if (siteId === "") throw new Error(`item_add ${key}: в ответе нет site_id (${JSON.stringify(addRes).slice(0, 200)}) — СТОП до save (иначе предмет остался бы на сервере)`);
    check(siteId !== "", `item_add ${key}: site_id=${siteId}`);
    original.probe_items.push({ key, site_id: siteId });
    journal();
    const wsItem = (workspaceModel().items ?? {} as Record<string, Record<string, unknown>>)[siteId];
    check(wsItem !== undefined, `рабочая модель: предмет ${siteId} на месте`);
    if (wsItem) checkItemFields("рабочая модель", key, wsItem, ref, (workspaceModel().walls ?? {})[wall.wallId] as Record<string, unknown>, wall.wallId);
    await call("model_validate", {});
    await gsave(`${key}`);
    await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
    await assertEditorPlanMatch(editorOf(), ids.planId);
    const got: LoadedModel = await loadModel(ctx.session(), ids.objectId, ids.planId);
    const gotItem = ((got.model["items"] ?? {}) as Record<string, Record<string, unknown>>)[siteId];
    check(gotItem !== undefined, `независимый loadModel: предмет ${siteId} на месте после save/reopen`);
    if (gotItem) checkItemFields("независимый loadModel", key, gotItem, ref, ((got.model["walls"] ?? {}) as Record<string, Record<string, unknown>>)[wall.wallId] as Record<string, unknown>, wall.wallId);
    const png = await call("render_plan", {});
    check(typeof png["bytes"] === "number" && (png["bytes"] as number) > 1000, `render_plan PNG: ${String(png["bytes"])} байт`);
    await guardedCall(`delete ${key}`, "item_delete", { item_id: siteId });
    check(((workspaceModel().items ?? {}) as Record<string, Record<string, unknown>>)[siteId] === undefined, `рабочая модель: предмет ${siteId} удалён`);
  }
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
      // restore: удалить оставшиеся предметы пробы — по site_id из журнала И
      // страховкой: любой предмет вида KEYS, которого нет в бэкапе (остаток
      // прерванного прогона, напр. 425-2: item_delete упал на пустом id).
      // Пользовательские предметы (есть в бэкапе) не трогаются.
      const backupIds = new Set(Object.keys((bm["items"] ?? {}) as Record<string, unknown>));
      const ws = workspaceModel();
      for (const pi of original?.probe_items ?? []) {
        if ((ws.items ?? {} as Record<string, unknown>)[pi.site_id] !== undefined) {
          journal();
          await roGuard.assertUnchanged(`restore:delete ${pi.key}`);
          await call("item_delete", { item_id: pi.site_id });
          console.log(`restore: item_delete ${pi.key} (${pi.site_id})`);
        }
      }
      for (const [iid, it] of Object.entries((workspaceModel().items ?? {}) as Record<string, Record<string, unknown>>)) {
        if (!backupIds.has(iid) && (KEYS as readonly string[]).includes(String(it["name"]))) {
          journal();
          await roGuard.assertUnchanged(`restore:delete leftover ${iid}`);
          await call("item_delete", { item_id: iid });
          console.log(`restore: item_delete остаток прогона ${String(it["name"])} (${iid})`);
        }
      }
      journal();
      await roGuard.assertUnchanged("restore:save");
      const r = await call("project_save", {}) as { verified?: boolean };
      console.log(`restore save: verified=${r["verified"]}`);
      if (r["verified"] !== true) throw new Error("restore save не verified");
      await delay(5500);
      const after = await loadModel(ctx.session(), ids.objectId, ids.planId);
      const backupPath = backupPathOf(ids.objectId);
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
