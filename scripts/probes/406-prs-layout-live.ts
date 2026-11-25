// 406: живая проверка room_prs_layout в dev-объекте (ID — ТОЛЬКО из env
// командной строки, в файл не пишутся). Сценарий:
//   0) пробная комната из 4 стен (своя зона координат) → save → комната с
//      ПУСТЫМ edges_prs (независимый loadModel — факт «до»);
//   1) room_prs_layout по site id комнаты → created:true, линии в мм/W<n>;
//      повторный вызов — no-op (created:false);
//   2) prs_set скрывает развёртку НЕТРОНУТОЙ стены (верхней) — до раскладки
//      prs_set отказал бы (проверяется тем же вызовом ДО шага 1);
//   3) project_save verified → project_open (reopen) → независимый loadModel:
//      edges_prs не пуст, id_of_edges == oid edges_prs, ключ prs_disabled —
//      oid из edges_prs и лежит на верхней стене;
//   4) render_plan — PNG > 1000 байт.
// Ревью 407 №2 (createEdgesPrs синхронно после restore): лог «407-№2 …» —
// edges_prs не пуст и id_of_edges == oid сразу после room_prs_layout
// (рабочая модель), после save и после save/reopen (независимый loadModel).
// Гарды (канон 399/404): probe-guard (пара объект/план fail-closed,
// READONLY-гард по корневому эталону БЕЗ REF_INIT, assertEditorPlanMatch),
// assertUnchanged перед каждой записью; бэкап <корень репо>/.orca-reports/
// backup-<OBJECT_ID>-406.json — АБСОЛЮТНЫЙ путь через gitRepoRoot, НЕ
// перезаписывается, пишется ТОЛЬКО фазой run с REMPLANNER_PROBE_WRITE_BACKUP=1,
// при отсутствии — стоп; журнал site_id ДО каждой записи (<корень>/.orca-reports/
// tmp/406-captured-<N>-<n>.json, абсолютный путь); restore в finally
// (restoreByCaptured: удаление своих стен по site_id; существующие стены проба
// не двигает — probe-wall-restore не нужен); sig в конце и в catch по канону
// probe-sig, итог сверяется с бэкапом; ≤30 запросов/мин (лимитер MCP),
// closeBrowser в finally. Любое расхождение READONLY — немедленный стоп.
//   REMPLANNER_PROBE_OBJECT_ID=… REMPLANNER_PROBE_PLAN_ID=… \
//   REMPLANNER_PROBE_READONLY_ID=… REMPLANNER_PROBE_READONLY_PLAN_ID=… \
//   REMPLANNER_PROBE_RUN_N=1 [REMPLANNER_PROBE_WRITE_BACKUP=1] \
//   node scripts/probes/406-prs-layout-live.ts run|cleanup
// Этап 410: RUN_N≥2 — повторный прогон БЕЗ REMPLANNER_PROBE_WRITE_BACKUP и только
// при существующем бэкапе (иначе стоп до записи); перед финальным render_plan —
// лог «410 …»: plan/plan_, активный лист, ITEMS, статус каждого предмета init;
// при RENDER_OUT_OF_SYNC — причина, пауза 5 с и один повтор (PNG по-прежнему обязателен).
// Этап 411: диагностика «410» ещё в трёх точках ДО раскладки (после открытия, после
// save стен, после reopen перед room_prs_layout) + размеры субпиксельных предметов
// (экран, getBBox, масштаб) — отделяет масштаб вида/стены от room_prs_layout.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { loadModel, type LoadedModel } from "../../src/api.ts";
import { gitRepoRoot } from "../../src/repo-root.ts";
import { itemsRenderDiagInPage } from "../../src/editor/adapter.ts";
import { itemIdsForSheet } from "../../src/workspace.ts";
import type { Model } from "../../src/model/types.ts";
import type { Page } from "playwright-core";
import { sig } from "./probe-sig.ts";
import { assertEditorPlanMatch, probeWriteEnv, assertTargetPair, readonlyGuard, readonlyRefPath } from "./probe-guard.ts";
import { restoreByCaptured, type ProbeCreated } from "./probe-restore.ts";

const phase = process.argv[2] ?? "run";
const ROOT_DIR = (): string => {
  const root = gitRepoRoot();
  if (!root) throw new Error("корень репо не найден (git недоступен) — пробы нельзя адресовать");
  return root;
};
mkdirSync(join(ROOT_DIR(), ".orca-reports/tmp"), { recursive: true });
const backupPathOf = (objectId: string): string => join(ROOT_DIR(), ".orca-reports", `backup-${objectId}-406.json`);
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 14 * 60_000).unref();

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "406-prs-layout-live", version: "0.0.0" });
const [ta, tb] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(tb), client.connect(ta)]);
type TextContent = { content: { type: string; text?: string }[] };
const text = (r: unknown): string => ((r as TextContent).content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  if ((res as { isError?: boolean }).isError) throw new Error(`${name}: ${text(res).slice(0, 600)}`);
  return JSON.parse(text(res)) as Record<string, unknown>;
};
/** Вызов, который ОБЯЗАН отказать: текст ошибки или null, если отказа не было. */
const callExpectError = async (name: string, args: Record<string, unknown>): Promise<string | null> => {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  return (res as { isError?: boolean }).isError ? text(res) : null;
};
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const runN = process.env["REMPLANNER_PROBE_RUN_N"] ?? "";
if (!/^\d+$/.test(runN)) {
  console.error("нужен REMPLANNER_PROBE_RUN_N=<номер прогона> — журнал пишется по номеру, не перезаписывается");
  process.exit(1);
}
const capturedPath = (n: number): string => join(ROOT_DIR(), ".orca-reports/tmp", `406-captured-${runN}-${n}.json`);
let capturedN = 0;
while (existsSync(capturedPath(capturedN))) capturedN++;
const CAPTURED = capturedPath(capturedN);
const created: ProbeCreated[] = [];
const ownRoomIds: string[] = [];
const journal = (): void => writeFileSync(CAPTURED, JSON.stringify({ run: runN, rooms: ownRoomIds, created }, null, 1) + "\n");

let exitCode = 0;
const check = (ok: boolean, msg: string): void => { console.log(`${ok ? "PASS" : "FAIL"}: ${msg}`); if (!ok) exitCode = 1; };
const editorOf = (): Parameters<typeof assertEditorPlanMatch>[0] | null =>
  (ctx as unknown as { workspaceOrNull: { editorOrNull: () => Parameters<typeof assertEditorPlanMatch>[0] | null } | null }).workspaceOrNull?.editorOrNull?.() ?? null;

// пробная зона (мм) — вне зон прежних проб (399: 90000)
const X0 = 96000, Y0 = 96000, W = 3000, H = 2600;

type RoomState = {
  siteId: string;
  edges: Array<{ pid: string; side: string; p1: { x: number; y: number }; p2: { x: number; y: number } }>;
  oids: string[];
  idOfEdges: unknown;
  disabledKeys: string[];
  /** Стены|стороны скрытых развёрток (по edge_index ключа). */
  disabledWalls: string[];
};
const roomStateOf = (rooms: Record<string, unknown> | undefined): RoomState | null => {
  for (const [rid, rec] of Object.entries(rooms ?? {})) {
    const r = rec as { polygon?: Array<{ x: number; y: number }>; edges?: Array<Record<string, unknown>>; edges_prs?: Array<{ oid?: unknown; edge_index?: unknown }>; id_of_edges?: unknown; prs_disabled?: unknown };
    const poly = r.polygon ?? [];
    if (poly.length < 3) continue;
    if (!poly.every((p) => p.x >= X0 / 10 - 10 && p.x <= (X0 + W) / 10 + 10 && p.y >= Y0 / 10 - 10 && p.y <= (Y0 + H) / 10 + 10)) continue;
    const edges = (r.edges ?? []).map((e) => ({
      pid: String(e["pid"] ?? "?"),
      side: String(e["room_side"] ?? "?"),
      p1: (e["p1"] ?? { x: NaN, y: NaN }) as { x: number; y: number },
      p2: (e["p2"] ?? { x: NaN, y: NaN }) as { x: number; y: number },
    }));
    const edgesPrs = Array.isArray(r.edges_prs) ? r.edges_prs : [];
    const oids = edgesPrs.map((e) => (typeof e.oid === "string" ? e.oid : ""));
    const disabled = (r.prs_disabled && typeof r.prs_disabled === "object" ? r.prs_disabled : {}) as Record<string, unknown>;
    const disabledKeys = Object.keys(disabled);
    const disabledWalls = disabledKeys.map((k) => {
      const ei = edgesPrs.find((e) => e.oid === k)?.edge_index;
      return typeof ei === "number" && edges[ei] ? `${edges[ei]!.pid}|${edges[ei]!.side}` : "?nooid";
    });
    return { siteId: rid, edges, oids, idOfEdges: r.id_of_edges, disabledKeys, disabledWalls };
  }
  return null;
};
/** pid верхней стены по геометрии рёбер (внутренняя грань, допуск 3 см). */
const topPidOf = (st: RoomState): string | null => {
  const yCm = (Y0 + H) / 10 - 10;
  const e = st.edges.find((e) => Math.abs(e.p1.y - yCm) < 3 && Math.abs(e.p2.y - yCm) < 3);
  return e ? e.pid : null;
};
const roomsOfModel = (m: Record<string, unknown>): Record<string, unknown> => (m["rooms2"] ?? m["rooms1"] ?? {}) as Record<string, unknown>;
/** Рабочая модель MCP (без сети) — для проверки ревью 407 №2 сразу после вызова. */
const workspaceRooms = (): Record<string, unknown> =>
  roomsOfModel(((ctx as unknown as { workspaceOrNull: { model: Record<string, unknown> } | null }).workspaceOrNull?.model ?? {}));
/** Ревью 407 №2: createEdgesPrs синхронно после restore — edges_prs не пуст в каждой точке. */
const checkPrsNonEmpty = (where: string, st: RoomState | null): void => {
  console.log(`407-№2 ${where}: edges_prs=${st?.oids.length ?? "нет комнаты"} id_of_edges=${JSON.stringify(st?.idOfEdges)}`);
  check(st !== null && st.oids.length > 0 && JSON.stringify(st.idOfEdges) === JSON.stringify(st.oids), `407-№2 ${where}: edges_prs не пуст, id_of_edges == oid`);
};

/**
 * Этап 410: состояние страницы редактора перед render (ТОЛЬКО чтение): глобалы
 * plan/plan_, активный лист навигации, число ITEMS и статус каждого предмета листа
 * init из рабочей модели (itemsRenderDiagInPage — та же проверка, что ожидание
 * render). Ошибка чтения — в лог, сценарий не прерывает.
 */
const logRenderState = async (where: string): Promise<void> => {
  try {
    const ws = (ctx as unknown as { workspaceOrNull: { model: Model } | null }).workspaceOrNull;
    const expected = ws ? itemIdsForSheet(ws.model, "init") : [];
    const page = (editorOf() as unknown as { page?: Page } | null)?.page;
    if (!page) { console.log(`410 ${where}: редактор не запущен; предметов init в модели ${expected.length}`); return; }
    const globals = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const s = (v: unknown): string | null => (typeof v === "string" || typeof v === "number" ? String(v).slice(0, 40) : null);
      return { plan: s(w["plan"]), plan_: s(w["plan_"]) };
    }).catch(() => null);
    const diag = await page.evaluate(itemsRenderDiagInPage, expected).catch(() => null);
    const notOk = diag ? Object.entries(diag.statuses).filter(([, st]) => st !== "ok") : [];
    console.log(`410 ${where}: plan=${globals?.plan ?? "?"} plan_=${globals?.plan_ ?? "?"} активный лист=${diag?.activeSheet ?? "?"} ITEMS=${diag?.itemsInEditor ?? "?"} svg=${diag?.svg ?? "?"} предметов init в модели=${expected.length} видны=${diag ? expected.length - notOk.length : "?"} не видны=${JSON.stringify(notOk)} субпиксель(411)=${JSON.stringify(diag?.sizes ?? null)}`);
  } catch (e) {
    console.log(`410 ${where}: диагностика недоступна (${String((e as Error).message).slice(0, 120)})`);
  }
};

let roGuard: Awaited<ReturnType<typeof readonlyGuard>> | null = null;
try {
  const ids = probeWriteEnv();
  await assertTargetPair(ctx.session(), ids.objectId, ids.planId);
  roGuard = await readonlyGuard(ctx.session(), ids.readonlyId, ids.readonlyPlanId, readonlyRefPath(ids.readonlyId, ids.readonlyPlanId));
  const gsave = async (tag: string): Promise<Record<string, unknown>> => {
    journal();
    await roGuard!.assertUnchanged(tag);
    const r = await call("project_save", {}) as { verified?: boolean; warnings?: unknown[] };
    console.log(`save ${tag}: verified=${r["verified"]} warnings=${JSON.stringify((r["warnings"] ?? []).map((w) => String(w).slice(0, 160)))}`);
    if (!r["verified"]) throw new Error(`save ${tag} не verified`);
    await delay(5500);
    return r;
  };
  const backupPath = backupPathOf(ids.objectId);
  // этап 410: повторные прогоны (RUN_N≥2) — только с УЖЕ существующим бэкапом и
  // без REMPLANNER_PROBE_WRITE_BACKUP (перезапись/подмена эталона запрещена):
  // иначе стоп ДО любой записи
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
  await roGuard!.assertUnchanged("before");

  if (phase === "cleanup") {
    await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
    await call("render_plan", {});
    await assertEditorPlanMatch(editorOf(), ids.planId);
    for (let n = 0; existsSync(capturedPath(n)); n++) {
      const j = JSON.parse(readFileSync(capturedPath(n), "utf8")) as { rooms: string[]; created: ProbeCreated[] };
      created.push(...j["created"]);
      ownRoomIds.push(...j["rooms"]);
    }
    await restoreByCaptured({
      call, created, ownRoomIds,
      save: async () => { await roGuard!.assertUnchanged("cleanup-save"); const r = await call("project_save", {}) as { verified?: boolean }; if (r["verified"] !== true) throw new Error("cleanup save не verified"); await delay(5500); },
      log: (l) => console.error("restore:", l),
    });
    const after = await loadModel(ctx.session(), ids.objectId, ids.planId);
    const same = sig(after.model) === sig(JSON.parse(readFileSync(backupPath, "utf8")).model);
    console.log("sig (cleanup) vs backup:", same ? "OK" : "РАСХОЖДЕНИЕ");
    await closeBrowser().catch(() => {});
    console.log("EXIT:", same ? 0 : 1);
    process.exit(same ? 0 : 1);
  }
  if (phase !== "run") {
    console.error("фаза: run | cleanup");
    process.exit(1);
  }

  await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
  await call("render_plan", {});
  await assertEditorPlanMatch(editorOf(), ids.planId);
  check(true, "открытие + render_plan + гард плана");
  // этап 411: точка 1 — сразу после открытия (до записей; масштаб вида — по исходному плану)
  await logRenderState("411 сразу после открытия");

  // ==== 0) пробная комната с пустым edges_prs ====
  const segs: Array<[Record<string, number>, Record<string, number>]> = [
    [{ x: X0, y: Y0 }, { x: X0 + W, y: Y0 }],
    [{ x: X0 + W, y: Y0 }, { x: X0 + W, y: Y0 + H }],
    [{ x: X0 + W, y: Y0 + H }, { x: X0, y: Y0 + H }],
    [{ x: X0, y: Y0 + H }, { x: X0, y: Y0 }],
  ];
  for (const [s, e] of segs) {
    // ревью 413 F2: гард READONLY перед каждой записью, как заявлено в шапке пробы —
    // wall_add в цикле шёл без assertUnchanged (поведение 45e504c)
    await roGuard!.assertUnchanged("wall_add");
    journal();
    const r = await call("wall_add", { start: s, end: e }) as { entity?: { site_id?: string } | null };
    const site = r["entity"]?.["site_id"];
    check(typeof site === "string" && site.length > 0, `wall_add создал стену (${site ?? "?"})`);
    if (typeof site === "string") created.push({ kind: "wall", siteId: site });
  }
  journal();
  await gsave("стены пробной комнаты");
  // этап 411: точка 2 — после save стен (дальняя комната уже в плане; раскладки ещё нет)
  await logRenderState("411 после save стен");
  const got0 = await loadModel(ctx.session(), ids.objectId, ids.planId);
  const st0 = roomStateOf(roomsOfModel(got0.model));
  check(st0 !== null, `пробная комната найдена (${st0?.siteId ?? "?"})`);
  if (!st0) throw new Error("пробная комната не найдена");
  ownRoomIds.push(st0.siteId);
  journal();
  console.log(`edges_prs ДО: ${st0.oids.length} (oids=${JSON.stringify(st0.oids)}), рёбра=${JSON.stringify(st0.edges.map((e) => `${e.pid}|${e.side}`))}`);
  check(st0.oids.length === 0, `комната с ПУСТЫМ edges_prs (${st0.oids.length} линий)`);
  if (st0.oids.length !== 0) throw new Error("у пробной комнаты уже есть раскладка — сценарий «пустой edges_prs» недоступен");
  const pidTop = topPidOf(st0);
  check(pidTop !== null && pidTop !== "?", `верхняя (нетронутая) стена найдена (${pidTop})`);
  if (!pidTop || pidTop === "?") throw new Error("верхняя стена не распознана");

  // prs_set до раскладки — отказ с указанием на room_prs_layout
  const refusal = await callExpectError("prs_set", { room: st0.siteId, hide_walls: [pidTop] });
  check(refusal !== null && /room_prs_layout/.test(refusal), `prs_set без раскладки — отказ с указанием на room_prs_layout: ${String(refusal).slice(0, 200)}`);

  // ==== 1) room_prs_layout ====
  // этап 411: точка 3 — reopen (страница/модель с сервера) и диагностика ДО раскладки:
  // если стояк уже zero_size/субпиксель здесь — раскладка ни при чём
  await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
  await assertEditorPlanMatch(editorOf(), ids.planId);
  await logRenderState("411 после reopen перед room_prs_layout");
  journal();
  const lay = await call("room_prs_layout", { room: st0.siteId });
  console.log("room_prs_layout:", JSON.stringify({ ...lay, hint: undefined }));
  const lines = (lay["lines"] ?? []) as Array<Record<string, unknown>>;
  check(lay["created"] === true && lines.length === st0.edges.length, `раскладка создана: ${lines.length} линий`);
  check(!JSON.stringify(lay).includes("oid") && lines.every((l) => Number.isInteger(l["length_mm"]) && /^W\d+$/.test(String(l["wall"]))), "ответ — формат API (мм, W<n>, без oid)");
  // ревью 407 №2: сразу после вызова (без пауз) — раскладка в рабочей модели
  checkPrsNonEmpty("сразу после room_prs_layout (рабочая модель)", roomStateOf(workspaceRooms()));
  await logRenderState("сразу после room_prs_layout (гипотеза А: состояние страницы)");
  const again = await call("room_prs_layout", { room: st0.siteId });
  check(again["created"] === false, "повторный вызов — no-op (created:false)");

  // ==== 2) prs_set скрывает развёртку нетронутой верхней стены ====
  const prs = await call("prs_set", { room: st0.siteId, hide_walls: [pidTop] });
  check(Array.isArray(prs["disabled_edges"]) && (prs["disabled_edges"] as unknown[]).length === 1, `prs_set: disabled_edges=${JSON.stringify(prs["disabled_edges"])}`);
  await call("model_validate", {});

  // ==== 3) save → reopen → независимый loadModel ====
  await gsave("room_prs_layout + prs_set");
  checkPrsNonEmpty("после save (рабочая модель, до reopen)", roomStateOf(workspaceRooms()));
  await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
  await assertEditorPlanMatch(editorOf(), ids.planId);
  const got1 = await loadModel(ctx.session(), ids.objectId, ids.planId);
  const st1 = roomStateOf(roomsOfModel(got1.model));
  checkPrsNonEmpty("после save/reopen (независимый loadModel)", st1);
  check(st1 !== null, `комната найдена после reopen (${st1?.siteId ?? "?"})`);
  if (st1 && !ownRoomIds.includes(st1.siteId)) { ownRoomIds.push(st1.siteId); journal(); }
  console.log(`edges_prs ПОСЛЕ: ${st1?.oids.length} oids=${JSON.stringify(st1?.oids)} id_of_edges=${JSON.stringify(st1?.idOfEdges)}`);
  console.log(`prs_disabled ПОСЛЕ: keys=${JSON.stringify(st1?.disabledKeys)} walls=${JSON.stringify(st1?.disabledWalls)}`);
  check(st1 !== null && st1.oids.length > 0 && st1.oids.every((o) => o !== "" && !o.startsWith("derived_")), "edges_prs не пуст, oid редактора");
  check(st1 !== null && JSON.stringify(st1.idOfEdges) === JSON.stringify(st1.oids), "id_of_edges == oid edges_prs");
  check(st1 !== null && st1.disabledKeys.length === 1 && st1.oids.includes(st1.disabledKeys[0]!), "ключ prs_disabled == oid из edges_prs");
  check(st1 !== null && st1.disabledWalls.length === 1 && st1.disabledWalls[0]!.startsWith(`${pidTop}|`), `скрыта развёртка верхней стены (${JSON.stringify(st1?.disabledWalls)})`);

  // ==== 4) render PNG ====
  // этап 410: перед финальным render — активный лист/план и предметы, видимые
  // редактором (только чтение страницы); model_validate; при RENDER_OUT_OF_SYNC —
  // причина в лог, пауза, ОДИН повтор. Ожидание PNG не ослаблено: повтор тоже
  // обязан вернуть PNG > 1000 байт, иначе FAIL.
  await logRenderState("перед финальным render_plan");
  const validate = await call("model_validate", {});
  console.log("410 model_validate перед render:", JSON.stringify(validate).slice(0, 400));
  let png: Record<string, unknown> | null = null;
  try {
    png = await call("render_plan", {});
  } catch (re) {
    const msg = String((re as Error).message);
    if (!/RENDER_OUT_OF_SYNC/.test(msg)) throw re;
    console.log("410 render_plan №1: RENDER_OUT_OF_SYNC —", msg.slice(0, 600));
    await logRenderState("после отказа render_plan №1");
    await delay(5000);
    try {
      png = await call("render_plan", {});
      console.log("410 причина: повтор через 5 с прошёл — тайминг отрисовки (Б), не состояние страницы");
    } catch (re2) {
      console.log("410 render_plan №2 (через 5 с):", String((re2 as Error).message).slice(0, 600));
      await logRenderState("после отказа render_plan №2");
      console.log("410 причина: повтор не помог — устойчивое состояние страницы/модели; см. statuses/active_sheet выше");
      throw re2;
    }
  }
  check(png !== null && typeof png["bytes"] === "number" && (png["bytes"] as number) > 1000, `render_plan PNG: ${String(png?.["bytes"])} байт`);
} catch (e) {
  console.error("ERROR:", String((e as Error).message).slice(0, 400));
  exitCode = 1;
  try {
    const ids = probeWriteEnv();
    const after = await loadModel(ctx.session(), ids.objectId, ids.planId);
    const backupPath = backupPathOf(ids.objectId);
    if (existsSync(backupPath)) console.error("sig (catch) vs backup:", sig(after.model) === sig(JSON.parse(readFileSync(backupPath, "utf8")).model) ? "OK" : "РАСХОЖДЕНИЕ");
  } catch (ce) { console.error("sig (catch) недоступен:", String((ce as Error).message).slice(0, 150)); }
} finally {
  if (phase === "run" && roGuard !== null) {
    try {
      const ids = probeWriteEnv();
      await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
      await assertEditorPlanMatch(editorOf(), ids.planId);
      journal();
      await restoreByCaptured({
        call, created, ownRoomIds,
        save: async () => {
          await roGuard!.assertUnchanged("cleanup-save");
          const r = await call("project_save", {}) as { verified?: boolean };
          if (r["verified"] !== true) throw new Error("cleanup save (finally) не verified");
          await delay(5500);
        },
        log: (l) => console.error("restore:", l),
      });
      const after = await loadModel(ctx.session(), ids.objectId, ids.planId);
      const backupPath = backupPathOf(ids.objectId);
      if (existsSync(backupPath)) {
        const same = sig(after.model) === sig(JSON.parse(readFileSync(backupPath, "utf8")).model);
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
