// 399: живая перепроверка находки 2 ревью 397 (мажор A) после фикса — в dev-объекте
// (ID — ТОЛЬКО из env командной строки). В 396 скрытие развёртки записывалось под
// синтетическим ключом derived_N: у комнаты, созданной из стен, edges_prs пуст, и
// редактору нечего переносить. Здесь раскладка развёрток МАТЕРИАЛИЗУЕТСЯ самим
// редактором (пересчёт комнат при wall_move → restorePrsChangeEdges →
// createEdgesPrs — 396-2: edges_prs 0→4), затем:
//   1) prs_set скрывает развёртку НЕТРОНУТОЙ стены (w3) — фикс A: ключ
//      prs_disabled обязан совпасть с oid из edges_prs (не derived_*);
//   2) независимый GET после save — факт ключа;
//   3) сдвиг ДРУГОЙ стены (w2), save, project_open (reopen) + loadModel
//      (независимый GET, не модель рабочей области MCP) — состояние «после»:
//      ключи prs_disabled — по-прежнему oid из edges_prs и на той же стене;
//   4) предупреждение MCP о сбросе prs соответствует факту (сверка состояния
//      «до → после» по стене ребра и стороне, как в sameState фикса D).
// Результат — честно в лог/отчёт, ожидание не подгоняется: критерий —
// НЕПРОТИВОРЕЧИВОСТЬ предупреждения MCP факту и совпадение ключей с oid.
// Гарды (канон 394/396): probe-guard (пара объект/план fail-closed, READONLY-гард
// по корневому эталону БЕЗ REF_INIT, assertEditorPlanMatch), assertUnchanged
// перед каждой записью, бэкап .orca-reports/backup-<OBJECT_ID>-399.json
// (не перезаписывается, пишется непосредственно перед первым прогоном),
// журнал site_id ДО каждой записи (399-captured-<N>-<n>.json, не
// перезаписывается), restore по журналу в finally (стены — deleteWallsBySiteIds
// из probe-restore), cleanup-save в finally проверяет verified, sig в конце и в
// catch по канону probe-sig, итог сверять с бэкапом; ≤30 запросов/мин (лимитер
// MCP), closeBrowser в finally. Любое расхождение READONLY — немедленный стоп
// (process.exit(1) внутри гарда).
//   REMPLANNER_PROBE_OBJECT_ID=… REMPLANNER_PROBE_PLAN_ID=… \
//   REMPLANNER_PROBE_READONLY_ID=… REMPLANNER_PROBE_READONLY_PLAN_ID=… \
//   REMPLANNER_PROBE_RUN_N=1 node scripts/probes/399-unfold-oid-live.ts run
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { loadModel, type LoadedModel } from "../../src/api.ts";
import { sig } from "./probe-sig.ts";
import { assertEditorPlanMatch, probeWriteEnv, assertTargetPair, readonlyGuard } from "./probe-guard.ts";
import { restoreByCaptured, type ProbeCreated } from "./probe-restore.ts";

const phase = process.argv[2] ?? "run";
mkdirSync(".orca-reports/tmp", { recursive: true });
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 14 * 60_000).unref();

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "399-unfold-oid-live", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);
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
  console.error("нужен REMPLANNER_PROBE_RUN_N=<номер прогона> — журнал пробы пишется по номеру (399-captured-<N>.json), не перезаписывается");
  process.exit(1);
}
const capturedPath = (n: number): string => `.orca-reports/tmp/399-captured-${runN}-${n}.json`;
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

type RoomState = {
  siteId: string;
  edges: number;
  edgesPrs: number;
  oids: string[];
  prsHidden: unknown;
  prsFirst: unknown;
  disabledKeys: string[];
  disabledKeysReal: boolean;
  disabledWalls: string[];
  prsSnapshot: string;
  /** pids рёбер и их геометрия (см) — адресация стен prs_set/wall_move. */
  edgePids: Array<{ pid: string; p1: { x: number; y: number }; p2: { x: number; y: number } }>;
};
// prs-состояние и грани комнаты по model_get detail=full (rooms2-ключ); комната
// ищется в границах полигона пробной комнаты (после wall_move id может смениться)
const roomStateOf = (mg: { rooms2?: Record<string, unknown> }): RoomState | null => {
  for (const [rid, rec] of Object.entries(mg["rooms2"] ?? {})) {
    const r = rec as {
      polygon?: Array<{ x: number; y: number }>; edges?: Array<Record<string, unknown>>; edges_prs?: Array<{ oid?: string; edge_index?: number }>;
      prs_disabled?: unknown; prs_first?: unknown; prs_hidden?: unknown;
    };
    const poly = r.polygon ?? [];
    if (poly.length < 3) continue;
    if (!poly.every((p) => p.x >= X0 / 10 - 10 && p.x <= (X0 + 3000) / 10 + 10 && p.y >= Y0 / 10 - 10 && p.y <= (Y0 + 2600) / 10 + 10)) continue;
    const edgesRaw = r.edges ?? [];
    const edges = edgesRaw as Array<{ pid?: string; p1?: { x: number; y: number }; p2?: { x: number; y: number } }>;
    const edgesPrs = r.edges_prs ?? [];
    const oids = edgesPrs.map((e) => (typeof e.oid === "string" ? e.oid : ""));
    const disabled = (r.prs_disabled ?? {}) as Record<string, unknown>;
    const disabledKeys = Object.keys(disabled);
    const disabledWalls: string[] = [];
    for (const k of disabledKeys) {
      const ei = edgesPrs.find((e) => e.oid === k)?.edge_index;
      disabledWalls.push(typeof ei === "number" ? String(edges[ei]?.pid ?? `?edge${ei}`) : "?nooid");
    }
    return {
      siteId: rid,
      edges: edges.length,
      edgesPrs: edgesPrs.length,
      oids,
      prsHidden: r.prs_hidden,
      prsFirst: r.prs_first !== "" && r.prs_first !== 0 ? r.prs_first : null,
      disabledKeys,
      disabledKeysReal: disabledKeys.every((k) => oids.includes(k)),
      disabledWalls,
      prsSnapshot: JSON.stringify({ hidden: r.prs_hidden, first: r.prs_first, disabled: disabledKeys.slice().sort() }),
      edgePids: edges.map((e) => ({
        pid: String(e.pid ?? "?"),
        p1: { x: e.p1?.x ?? NaN, y: e.p1?.y ?? NaN },
        p2: { x: e.p2?.x ?? NaN, y: e.p2?.y ?? NaN },
      })),
    };
  }
  return null;
};
/** pid ребра стены по геометрии (верх/низ пробной комнаты), см. */
const edgePidByY = (st: RoomState, yCm: number): string | null => {
  const e = st.edgePids.find((e) => Math.abs(e.p1.y - yCm) < 1 && Math.abs(e.p2.y - yCm) < 1);
  return e ? e.pid : null;
};

let roGuard: Awaited<ReturnType<typeof readonlyGuard>> | null = null;
let X0 = 0, Y0 = 0;
try {
  const ids = probeWriteEnv();
  await assertTargetPair(ctx.session(), ids.objectId, ids.planId);
  roGuard = await readonlyGuard(ctx.session(), ids.readonlyId, ids.readonlyPlanId, (await import("./probe-guard.ts")).readonlyRefPath(ids.readonlyId, ids.readonlyPlanId));
  const gsave = async (tag: string): Promise<Record<string, unknown>> => {
    journal();
    await roGuard!.assertUnchanged(tag);
    const r = await call("project_save", {}) as { verified?: boolean; warnings?: unknown[] };
    console.log(`save ${tag}: verified=${r["verified"]} warnings=${JSON.stringify((r["warnings"] ?? []).map((w) => String(w).slice(0, 160)))}`);
    if (!r["verified"]) throw new Error(`save ${tag} не verified`);
    await delay(5500);
    return r;
  };
  const backupPath = `.orca-reports/backup-${ids.objectId}-399.json`;
  const before: LoadedModel = await loadModel(ctx.session(), ids.objectId, ids.planId);
  if (existsSync(backupPath)) console.log("backup exists — НЕ перезаписывается:", backupPath);
  else { writeFileSync(backupPath, JSON.stringify(before, null, 1) + "\n"); console.log("backup written:", backupPath); }
  await roGuard!.assertUnchanged("before");

  if (phase === "cleanup") {
    await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
    await call("render_plan", {});
    await assertEditorPlanMatch(editorOf(), ids.planId);
    let cap = { rooms: [] as string[], created: [] as ProbeCreated[] };
    for (let n = 0; existsSync(capturedPath(n)); n++) {
      const j = JSON.parse(readFileSync(capturedPath(n), "utf8")) as { rooms: string[]; created: ProbeCreated[] };
      cap.created.push(...j["created"]);
      cap.rooms.push(...j["rooms"]);
    }
    created.push(...cap.created);
    ownRoomIds.push(...cap.rooms);
    await restoreByCaptured({
      call, created, ownRoomIds,
      save: async () => { await roGuard!.assertUnchanged("cleanup-save"); const r = await call("project_save", {}) as { verified?: boolean }; if (r["verified"] !== true) throw new Error("cleanup save не verified"); await delay(5500); },
      log: (l) => console.error("restore:", l),
    });
    const after = await loadModel(ctx.session(), ids.objectId, ids.planId);
    const { canon } = await import("./probe-sig.ts");
    const same = JSON.stringify(canon(after.model), null, 1) === JSON.stringify(canon(JSON.parse(readFileSync(backupPath, "utf8")).model), null, 1);
    console.log("sig (cleanup) vs backup:", same ? "OK" : "РАСХОЖДЕНИЕ");
    await closeBrowser().catch(() => {});
    console.log("EXIT:", same ? 0 : 1);
    process.exit(same ? 0 : 1);
  }
  if (phase === "check") {
    // read-only диагностика расхождения sig: GET целевого объекта, канон-дифф
    // против бэкапа (без записи), стены пробной зоны по site_id из журналов.
    // Эталон — REMPLANNER_PROBE_CHECK_BACKUP (умолчание — бэкап 399 прогона):
    // сверка с более ранним эталоном (например, backup-…-377.json) допустима,
    // когда все этапы между ними завершались «sig vs backup: OK».
    const backupPath = process.env["REMPLANNER_PROBE_CHECK_BACKUP"] ?? `.orca-reports/backup-${ids.objectId}-399.json`;
    if (!existsSync(backupPath)) { console.error("нет бэкапа", backupPath); process.exit(1); }
    const cur = await loadModel(ctx.session(), ids.objectId, ids.planId);
    const { canon } = await import("./probe-sig.ts");
    const c1 = canon(cur.model) as Record<string, unknown>;
    const c0 = canon(JSON.parse(readFileSync(backupPath, "utf8")).model) as Record<string, unknown>;
    const same = JSON.stringify(c1) === JSON.stringify(c0);
    console.log("sig (check) vs backup:", same ? "OK" : "РАСХОЖДЕНИЕ");
    if (!same) {
      const keys = [...new Set([...Object.keys(c0), ...Object.keys(c1)])].sort();
      for (const k of keys) {
        const a = JSON.stringify(c0[k]), b = JSON.stringify(c1[k]);
        if (a !== b) {
          console.log(`diff ${k}: backup ${a === undefined ? "нет" : a.length > 300 ? `${a.length}b` : a} → текущая ${b === undefined ? "нет" : b.length > 300 ? `${b.length}b` : b}`);
        }
      }
      // комнаты: ключи и полигоны
      const roomsOf = (c: Record<string, unknown>): Record<string, unknown> => ((c["rooms2"] ?? c["rooms1"] ?? {}) as Record<string, unknown>);
      console.log("rooms backup:", Object.keys(roomsOf(c0)).join(","));
      console.log("rooms текущая:", Object.keys(roomsOf(c1)).join(","));
      // детальный дифф коллекций-словарей (items, walls, …)
      for (const k of keys) {
        const a = c0[k], b = c1[k];
        if (a === b) continue;
        if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
          const ao = a as Record<string, unknown>, bo = b as Record<string, unknown>;
          for (const id of [...new Set([...Object.keys(ao), ...Object.keys(bo)])].sort()) {
            const av = JSON.stringify(ao[id]), bv = JSON.stringify(bo[id]);
            if (av !== bv) {
              if (av === undefined) console.log(`diff ${k}.${id}: только в текущей: ${String(bv).slice(0, 400)}`);
              else if (bv === undefined) console.log(`diff ${k}.${id}: только в backup: ${String(av).slice(0, 400)}`);
              else {
                console.log(`diff ${k}.${id}:`);
                console.log(`  backup: ${String(av).slice(0, 500)}`);
                console.log(`  текущая: ${String(bv).slice(0, 500)}`);
              }
            }
          }
        }
      }
    }
    // стены в зоне пробы (только чтение)
    const walls = (cur.model["walls"] ?? {}) as Record<string, { p1?: { x: number; y: number }; p2?: { x: number; y: number } }>;
    for (const [wid, w] of Object.entries(walls)) {
      if (w.p1 && w.p2 && w.p1.x >= 8900 && w.p1.x <= 9400 && w.p1.y >= 8900 && w.p1.y <= 9400) console.log("wall в зоне пробы:", wid, JSON.stringify(w.p1), JSON.stringify(w.p2));
    }
    await closeBrowser().catch(() => {});
    process.exit(0);
  }
  if (phase !== "run") {
    console.error("фаза: run | cleanup | check");
    process.exit(1);
  }

  await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
  await call("render_plan", {});
  await assertEditorPlanMatch(editorOf(), ids.planId);
  check(true, "открытие + render_plan + гард плана");

  // ==== пробная комната: 4 стены 3000×2600 (мм), координаты вне зон прежних проб ====
  X0 = 90000, Y0 = 90000;
  const segs: Array<[Record<string, unknown>, Record<string, unknown>]> = [    [{ x: X0, y: Y0 }, { x: X0 + 3000, y: Y0 }],
    [{ x: X0 + 3000, y: Y0 }, { x: X0 + 3000, y: Y0 + 2600 }],
    [{ x: X0 + 3000, y: Y0 + 2600 }, { x: X0, y: Y0 + 2600 }],
    [{ x: X0, y: Y0 + 2600 }, { x: X0, y: Y0 }],
  ];
  for (const [s, e] of segs) {
    const r = await call("wall_add", { start: s, end: e }) as { entity?: { site_id?: string } | null };
    const site = r["entity"]?.["site_id"];
    check(typeof site === "string" && site.length > 0, `wall_add создал стену (${site ?? "?"})`);
    if (typeof site === "string") { created.push({ kind: "wall", siteId: site }); }
  }
  journal();
  const saveWalls = await gsave("стены пробной комнаты");
  check(saveWalls["verified"] === true, "save стен verified");
  const mgFull0 = await call("model_get", { detail: "full" }) as { rooms2?: Record<string, unknown> };
  const room0 = roomStateOf(mgFull0);
  check(room0 !== null, `пробная комната найдена (${room0?.siteId ?? "?"})`);
  if (!room0) throw new Error("пробная комната не найдена");
  ownRoomIds.push(room0.siteId);
  journal();
  check(room0.edges === 4, `грани до материализации: edges=${room0.edges} edges_prs=${room0.edgesPrs} (${room0.siteId})`);
  const pidBottom0 = edgePidByY(room0, Y0 / 10);
  check(pidBottom0 !== null && pidBottom0 !== "?", `нижняя стена до материализации найдена среди рёбер (${pidBottom0})`);
  if (pidBottom0 === null || pidBottom0 === "?") throw new Error("нижняя стена пробной комнаты не распознана");

  // ==== 1) материализация раскладки: wall_move нижней стены на 20 мм — редактор
  // ==== пересчитывает комнаты (restorePrsChangeEdges → createEdgesPrs) ====
  const moveMat = await call("wall_move", { wall_id: pidBottom0, offset_mm: 20 }) as { warnings?: unknown[] };
  console.log("wall_move (материализация) warnings:", JSON.stringify(((moveMat["warnings"] ?? []) as unknown[]).map(String)));
  await call("model_validate", {});
  const saveMat = await gsave("wall_move нижней +20 (материализация раскладки)");
  check(saveMat["verified"] === true, "save материализации verified");
  // независимый GET — факт
  const gotMat = await loadModel(ctx.session(), ids.objectId, ids.planId);
  const matState = roomStateOf({ rooms2: (gotMat.model["rooms2"] ?? gotMat.model["rooms1"]) as Record<string, unknown> });
  check(matState !== null, `комната найдена после материализации (${matState?.siteId ?? "?"})`);
  if (matState && !ownRoomIds.includes(matState.siteId)) { ownRoomIds.push(matState.siteId); journal(); }
  const oidsReal = matState !== null && matState.edgesPrs > 0 && matState.oids.every((o) => o !== "" && !o.startsWith("derived_"));
  check(
    oidsReal,
    `раскладка материализована: edges=${matState?.edges} edges_prs=${matState?.edgesPrs} oids=${JSON.stringify(matState?.oids)}`,
  );
  if (!oidsReal) throw new Error("раскладка развёрток не материализована — живой путь с реальными oid недоступен");
  // prs_set адресует комнату по site id пробной комнаты (не по общей метке:
  // model_get rooms[] может начаться с чужой комнаты); СКРЫВАЕМАЯ стена и
  // СДВИГАЕМАЯ стена берутся из pids ТЕКУЩИХ рёбер комнаты (редактор при
  // пересчёте может перерезать стены — исходные site_id не обязаны жить):
  // скрытие — НЕТРОНУТАЯ верхняя стена (y = Y0+2600), сдвиг — нижняя (w1)
  const pidTop = edgePidByY(matState, (Y0 + 2600) / 10);
  const pidBottom = edgePidByY(matState, Y0 / 10);
  console.log(`рёбра комнаты: ${JSON.stringify(matState.edgePids)}; скрытие — pidTop=${pidTop}, сдвиг — pidBottom=${pidBottom}`);
  check(pidTop !== null && pidTop !== "?", `верхняя стена найдена среди рёбер (${pidTop})`);
  check(pidBottom !== null && pidBottom !== "?", `нижняя стена найдена среди рёбер (${pidBottom})`);
  if (pidTop === null || pidBottom === null || pidTop === "?" || pidBottom === "?") throw new Error("рёбра пробной комнаты не распознаны");
  const roomLabel2 = matState.siteId;

  // ==== 2) prs_set скрывает развёртку НЕТРОНУТОЙ стены (w3) — ключ обязан ====
  // ==== совпасть с oid из edges_prs (фикс A) ====
  let prsRes: Record<string, unknown>;
  try {
    prsRes = await call("prs_set", { room: roomLabel2, hide_walls: [pidTop] }) as Record<string, unknown>;
  } catch (e) {
    check(false, `prs_set на комнате с edges_prs (${matState!.edgesPrs}) ОТКАЗАЛ: ${String((e as Error).message).slice(0, 300)}`);
    throw e;
  }
  check(prsRes["hidden"] === false, `prs_set скрыл развёртку нетронутой верхней стены ${pidTop} (disabled=${JSON.stringify(prsRes["disabled_edges"])})`);
  journal();
  await call("model_validate", {});
  await gsave("prs_set (скрыта развёртка нетронутой стены)");
  // независимый GET ДО wall_move: факт ключа prs_disabled
  const gotBefore = await loadModel(ctx.session(), ids.objectId, ids.planId);
  const stBefore = roomStateOf({ rooms2: (gotBefore.model["rooms2"] ?? gotBefore.model["rooms1"]) as Record<string, unknown> });
  check(stBefore !== null, `комната найдена после prs_set (${stBefore?.siteId ?? "?"})`);
  check(
    stBefore !== null && stBefore.disabledKeysReal && stBefore.disabledKeys.length === 1,
    `КЛЮЧ prs_disabled — реальный oid из edges_prs: keys=${JSON.stringify(stBefore?.disabledKeys)} oids=${JSON.stringify(stBefore?.oids)} (фикс A)`,
  );
  check(
    stBefore !== null && stBefore.disabledWalls.length === 1 && stBefore.disabledWalls[0] === pidTop,
    `скрытая развёртка на НЕТРОНУТОЙ верхней стене: disabledWalls=${JSON.stringify(stBefore?.disabledWalls)} ожидалось [${pidTop}]`,
  );

  // ==== 3) сдвиг ДРУГОЙ стены (нижняя), save, reopen + независимый GET ====
  const moveRes = await call("wall_move", { wall_id: pidBottom, offset_mm: 20 }) as { warnings?: unknown[] };
  const moveWarn = ((moveRes["warnings"] ?? []) as unknown[]).map(String);
  console.log("wall_move (нижняя) warnings:", JSON.stringify(moveWarn));
  await call("model_validate", {});
  const saveMove = await gsave("wall_move нижней +20 (сдвиг другой стены)");
  check(saveMove["verified"] === true, "save wall_move (сдвиг нижней) verified");
  // состояние «после»: reopen из сервера + независимый loadModel (не модель рабочей области)
  await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
  const gotAfter = await loadModel(ctx.session(), ids.objectId, ids.planId);
  const stAfter = roomStateOf({ rooms2: (gotAfter.model["rooms2"] ?? gotAfter.model["rooms1"]) as Record<string, unknown> });
  check(stAfter !== null, `комната найдена после wall_move нижней (${stAfter?.siteId ?? "?"})`);
  if (stAfter && !ownRoomIds.includes(stAfter.siteId)) { ownRoomIds.push(stAfter.siteId); journal(); }
  console.log(`грани до: edges=${stBefore?.edges} edges_prs=${stBefore?.edgesPrs}; после: edges=${stAfter?.edges} edges_prs=${stAfter?.edgesPrs} (room id: ${stBefore?.siteId} → ${stAfter?.siteId ?? "?"})`);
  console.log(`prs до: keys=${JSON.stringify(stBefore?.disabledKeys)} oids=${JSON.stringify(stBefore?.oids)}; после: keys=${JSON.stringify(stAfter?.disabledKeys)} oids=${JSON.stringify(stAfter?.oids)}`);
  const keysStillReal = stAfter !== null && stAfter.disabledKeysReal && stAfter.disabledKeys.length === stBefore!.disabledKeys.length;
  check(
    keysStillReal,
    `после wall_move (сдвиг нижней) ключи prs_disabled — по-прежнему oid из edges_prs: ${JSON.stringify(stAfter?.disabledKeys)}`,
  );
  // фактический перенос — по стене ребра и СТОРОНЕ (как sameState фикса D):
  // скрытое ребро после пересчёта обязано лежать на верхней стене с той же
  // стороной, что и до (редактор переносит по геометрии — restoreElementPrs)
  const pidTopAfter = stAfter ? edgePidByY(stAfter, (Y0 + 2600) / 10) : null;
  const sameWall = keysStillReal && pidTopAfter !== null && stAfter!.disabledWalls.length === 1 && stAfter!.disabledWalls[0] === pidTopAfter;
  console.log(`disabledWalls после: ${JSON.stringify(stAfter?.disabledWalls)} (до: ${JSON.stringify(stBefore?.disabledWalls)}); pidTop после пересчёта: ${pidTopAfter}`);
  // предупреждение MCP соответствует факту: сверка состояния «до → после»
  // по стене ребра и стороне (как sameState фикса D) — здесь через полную
  // запись prs_disabled/prs_first/prs_hidden и стену скрытого ребра
  const keptFact = sameWall && stBefore!.prsSnapshot === stAfter!.prsSnapshot;
  const prsWarn = moveWarn.filter((w) => /настройки развёрток/.test(w));
  const consistent = keptFact ? prsWarn.length === 0 : prsWarn.length > 0;
  check(
    consistent,
    `находка 2 (нетронутая стена, реальные oid): настройки ${keptFact ? "ПЕРЕЖИЛИ" : "СБРОШЕНЫ редактором"}, предупреждений о prs: ${prsWarn.length} — предупреждение ${consistent ? "СООТВЕТСТВУЕТ факту" : "ПРОТИВОРЕЧИТ факту"} (edges_prs ${stBefore?.edgesPrs} → ${stAfter?.edgesPrs})`,
  );
} catch (e) {
  console.error("ERROR:", String((e as Error).message).slice(0, 400));
  exitCode = 1;
  try {
    const ids = probeWriteEnv();
    const after = await loadModel(ctx.session(), ids.objectId, ids.planId);
    const backupPath = `.orca-reports/backup-${ids.objectId}-399.json`;
    if (existsSync(backupPath)) console.error("sig (catch) vs backup:", sig(after.model) === sig(JSON.parse(readFileSync(backupPath, "utf8")).model) ? "OK" : "РАСХОЖДЕНИЕ");
  } catch (ce) { console.error("sig (catch) недоступен:", String((ce as Error).message).slice(0, 150)); }
} finally {
  try {
    const ids = probeWriteEnv();
    await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
    await assertEditorPlanMatch(editorOf(), ids.planId);
    journal();
    await restoreByCaptured({
      call,
      created,
      ownRoomIds,
      save: async () => {
        await roGuard!.assertUnchanged("cleanup-save");
        const r = await call("project_save", {}) as { verified?: boolean };
        if (r["verified"] !== true) throw new Error("cleanup save (finally) не verified");
        await delay(5500);
      },
      log: (l) => console.error("restore:", l),
    });
    const after = await loadModel(ctx.session(), ids.objectId, ids.planId);
    const backupPath = `.orca-reports/backup-${ids.objectId}-399.json`;
    if (existsSync(backupPath)) {
      const same = sig(after.model) === sig(JSON.parse(readFileSync(backupPath, "utf8")).model);
      console.log("sig (итог) vs backup:", same ? "OK" : "РАСХОЖДЕНИЕ");
      if (!same) exitCode = 1;
    }
  } catch (fe) { console.error("finally НЕ УДАЛСЯ — восстановите по журналу/бэкапу:", String((fe as Error).message).slice(0, 300)); exitCode = 1; }
  await closeBrowser().catch(() => {});
}
console.log("EXIT:", exitCode);
process.exit(exitCode);
