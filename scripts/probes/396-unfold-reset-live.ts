// 396: живая перепроверка находки 2 ревью 395 (№17 follow-up 392) в dev-объекте
// (ID — ТОЛЬКО из env командной строки). В 394 проба скрывала развёртку ТОЙ ЖЕ
// стены, которую сдвигала (hide_walls:[wallIds[0]] → wall_move wallIds[0]) —
// самый неблагоприятный для переноса случай, ветка «настройки пережили» вживую
// не выполнялась ни разу. Здесь развёртка скрывается на НЕТРОНУТОЙ стене
// (противоположной), сдвигается другая стена:
//   1) число граней комнаты до/после wall_move (edges_prs/edges);
//   2) независимый model_get — сохранились ли настройки развёрток (prs);
//   3) соответствие предупреждения MCP факту: настройки пережили → 0
//      предупреждений о сбросе; сброшены → предупреждение есть.
// Результат — честно в лог/отчёт, ожидание не подгоняется: критерий —
// НЕПРОТИВОРЕЧИВОСТЬ (как в 394 после правки критерия по независимому
// model_get), а не конкретный исход.
// Гарды (канон 394): probe-guard (пара объект/план fail-closed, READONLY-гард
// по корневому эталону БЕЗ REF_INIT, assertEditorPlanMatch), assertUnchanged
// перед каждой записью, бэкап .orca-reports/backup-<OBJECT_ID>-396.json
// (не перезаписывается, пишется непосредственно перед первым прогоном),
// журнал site_id ДО каждой записи (396-captured-<N>-<n>.json, не
// перезаписывается), restore по журналу в finally (стены — restoreByCaptured),
// cleanup-save в finally проверяет verified, sig в конце и в catch по канону
// probe-sig, итог сверять с бэкапом; ≤30 запросов/мин (лимитер MCP),
// closeBrowser в finally. Любое расхождение READONLY — немедленный стоп
// (process.exit(1) внутри гарда).
//   REMPLANNER_PROBE_OBJECT_ID=… REMPLANNER_PROBE_PLAN_ID=… \
//   REMPLANNER_PROBE_READONLY_ID=… REMPLANNER_PROBE_READONLY_PLAN_ID=… \
//   REMPLANNER_PROBE_RUN_N=1 node scripts/probes/396-unfold-reset-live.ts run
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
const client = new Client({ name: "396-unfold-reset-live", version: "0.0.0" });
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
  console.error("нужен REMPLANNER_PROBE_RUN_N=<номер прогона> — журнал пробы пишется по номеру (396-captured-<N>.json), не перезаписывается");
  process.exit(1);
}
const capturedPath = (n: number): string => `.orca-reports/tmp/396-captured-${runN}-${n}.json`;
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

let roGuard: Awaited<ReturnType<typeof readonlyGuard>> | null = null;
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
  const backupPath = `.orca-reports/backup-${ids.objectId}-396.json`;
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
  if (phase !== "run") {
    console.error("фаза: run | cleanup");
    process.exit(1);
  }

  await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
  await call("render_plan", {});
  await assertEditorPlanMatch(editorOf(), ids.planId);
  check(true, "открытие + render_plan + гард плана");

  // ==== пробная комната: 4 стены 3000×2600 (мм) ====
  const x0 = 60000, y0 = 60000;
  const wallIds: string[] = [];
  const segs: Array<[Record<string, unknown>, Record<string, unknown>]> = [
    [{ x: x0, y: y0 }, { x: x0 + 3000, y: y0 }],
    [{ x: x0 + 3000, y: y0 }, { x: x0 + 3000, y: y0 + 2600 }],
    [{ x: x0 + 3000, y: y0 + 2600 }, { x: x0, y: y0 + 2600 }],
    [{ x: x0, y: y0 + 2600 }, { x: x0, y: y0 }],
  ];
  for (const [s, e] of segs) {
    const r = await call("wall_add", { start: s, end: e }) as { entity?: { site_id?: string } | null };
    const site = r["entity"]?.["site_id"];
    check(typeof site === "string" && site.length > 0, `wall_add создал стену (${site ?? "?"})`);
    if (typeof site === "string") { wallIds.push(site); created.push({ kind: "wall", siteId: site }); }
  }
  journal();
  const saveWalls = await gsave("стены пробной комнаты");
  check(saveWalls["verified"] === true, "save стен verified");
  const mgRooms = await call("model_get", {}) as { rooms?: Array<{ id?: string; edges?: Array<{ from?: [number, number]; to?: [number, number] }> }> };
  const mine = (mgRooms["rooms"] ?? []).find((r) => {
    const es = r["edges"] ?? [];
    return es.length >= 4 && es.every((e) => {
      const [fx, fy] = e["from"] ?? [0, 0];
      const [tx, ty] = e["to"] ?? [0, 0];
      return fx >= x0 - 1 && fx <= x0 + 3000 + 1 && fy >= y0 - 1 && fy <= y0 + 2600 + 1 &&
             tx >= x0 - 1 && tx <= x0 + 3000 + 1 && ty >= y0 - 1 && ty <= y0 + 2600 + 1;
    });
  });
  check(typeof mine?.["id"] === "string", `пробная комната найдена (${mine?.id ?? "?"})`);
  if (!mine || typeof mine["id"] !== "string") throw new Error("пробная комната не найдена");
  const room = mine["id"];
  const mgFull = await call("model_get", { detail: "full" }) as { rooms2?: Record<string, unknown> };
  const roomSiteId = Object.keys(mgFull["rooms2"] ?? {}).find((rid) => {
    const poly = ((mgFull["rooms2"] ?? {})[rid] as { polygon?: Array<{ x: number; y: number }> } | undefined)?.polygon ?? [];
    return poly.length >= 3 && poly.every((p) => p.x >= x0 / 10 - 1 && p.x <= (x0 + 3000) / 10 + 1 && p.y >= y0 / 10 - 1 && p.y <= (y0 + 2600) / 10 + 1);
  }) ?? room;
  ownRoomIds.push(roomSiteId);
  journal();

  // ==== №17 (находка 2 ревью 395): скрыть развёртку НЕТРОНУТОЙ стены (w3,
  // ==== противоположной), сдвинуть другую (w1) ====
  // prs-состояние и грани комнаты по model_get detail=full (rooms2-ключ);
  // после wall_move комната пересоздаётся с новым id — ищется заново в границах
  const roomFullOf = (mg: { rooms2?: Record<string, unknown> }): { siteId: string; edges: number; edgesPrs: number; prs: unknown } | null => {
    for (const [rid, rec] of Object.entries(mg["rooms2"] ?? {})) {
      const r = rec as { polygon?: Array<{ x: number; y: number }>; edges?: unknown[]; edges_prs?: unknown[]; prs_disabled?: unknown; prs_first?: unknown; prs_hidden?: unknown };
      const poly = r.polygon ?? [];
      if (poly.length < 3) continue;
      if (!poly.every((p) => p.x >= x0 / 10 - 10 && p.x <= (x0 + 3000) / 10 + 10 && p.y >= y0 / 10 - 10 && p.y <= (y0 + 2600) / 10 + 10)) continue;
      return {
        siteId: rid,
        edges: (r.edges as unknown[] | undefined)?.length ?? -1,
        edgesPrs: (r.edges_prs as unknown[] | undefined)?.length ?? -1,
        prs: { hidden: r.prs_hidden, first: r.prs_first !== "" ? r.prs_first : null, disabled_count: Object.keys((r.prs_disabled as Record<string, unknown>) ?? {}).length },
      };
    }
    return null;
  };
  const facesBefore = roomFullOf(mgFull);
  check(facesBefore !== null && facesBefore.edges === 4 && facesBefore.edgesPrs === 4, `число граней до: edges=${facesBefore?.edges} edges_prs=${facesBefore?.edgesPrs} (${roomSiteId})`);
  const prsRes = await call("prs_set", { room, hide_walls: [wallIds[2]] }) as { hidden?: boolean; disabled_edges?: unknown[] };
  check(prsRes["hidden"] === false, `prs_set скрыл развёртку НЕТРОНУТОЙ стены w3 (hidden=false, disabled=${JSON.stringify(prsRes["disabled_edges"])})`);
  journal();
  await call("model_validate", {});
  await gsave("prs_set (скрыта развёртка нетронутой стены)");
  // независимый model_get ДО wall_move — факт prs-состояния
  const mgBefore = await call("model_get", { detail: "full" }) as { rooms2?: Record<string, unknown> };
  const stBefore = roomFullOf(mgBefore);
  check(stBefore !== null && stBefore.prs !== null, `prs до wall_move (независимый model_get): ${JSON.stringify(stBefore?.prs)}`);
  const moveRes = await call("wall_move", { wall_id: wallIds[0], offset_mm: 20 }) as { warnings?: unknown[] };
  const moveWarn = ((moveRes["warnings"] ?? []) as unknown[]).map(String);
  console.log("wall_move warnings:", JSON.stringify(moveWarn));
  await call("model_validate", {});
  // независимый model_get ПОСЛЕ wall_move: факт (id комнаты мог смениться)
  const mgAfter = await call("model_get", { detail: "full" }) as { rooms2?: Record<string, unknown> };
  const stAfter = roomFullOf(mgAfter);
  check(stAfter !== null, `комната найдена после wall_move (${stAfter?.siteId ?? "?"})`);
  if (stAfter && !ownRoomIds.includes(stAfter.siteId)) { ownRoomIds.push(stAfter.siteId); journal(); }
  console.log(`грани до: edges=${facesBefore?.edges} edges_prs=${facesBefore?.edgesPrs}; после: edges=${stAfter?.edges} edges_prs=${stAfter?.edgesPrs} (room id: ${roomSiteId} → ${stAfter?.siteId ?? "?"})`);
  console.log(`prs до: ${JSON.stringify(stBefore?.prs)}; после (независимый model_get): ${JSON.stringify(stAfter?.prs)}`);
  const prsWarn = moveWarn.filter((w) => /настройки развёрток/.test(w));
  // факт по независимому model_get: prs-состояние «до → после» совпало —
  // настройки пережили; иначе — сброшены редактором
  const keptFact = stBefore !== null && stAfter !== null && JSON.stringify(stBefore.prs) === JSON.stringify(stAfter.prs);
  const noFalseWarning = keptFact ? prsWarn.length === 0 : prsWarn.length > 0;
  check(
    noFalseWarning,
    `№17 (нетронутая стена): настройки ${keptFact ? "ПЕРЕЖИЛИ" : "СБРОШЕНЫ редактором"}, предупреждений о prs: ${prsWarn.length} — предупреждение ${noFalseWarning ? "СООТВЕТСТВУЕТ факту" : "ПРОТИВОРЕЧИТ факту"} (грани до edges=${facesBefore?.edges}/prs=${facesBefore?.edgesPrs}, после edges=${stAfter?.edges}/prs=${stAfter?.edgesPrs})`,
  );
  const saveMove = await gsave("wall_move (сдвиг другой стены)");
  check(saveMove["verified"] === true, "save wall_move verified");
} catch (e) {
  console.error("ERROR:", String((e as Error).message).slice(0, 400));
  exitCode = 1;
  try {
    const ids = probeWriteEnv();
    const after = await loadModel(ctx.session(), ids.objectId, ids.planId);
    const backupPath = `.orca-reports/backup-${ids.objectId}-396.json`;
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
    const backupPath = `.orca-reports/backup-${ids.objectId}-396.json`;
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
