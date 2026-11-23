// 394: живая перепроверка follow-up 392 в dev-объекте (ID — ТОЛЬКО из env
// командной строки). Проверяется только то, что офлайн не доказать:
//   1) НЕТ ЛОЖНОГО предупреждения о сбросе настроек развёрток при wall_move
//      БЕЗ смены нарезки (№17): prs_set (скрыть одну развёртку) → save →
//      wall_move offset 20 мм → сравнение prs-состояния комнаты до/после и
//      предупреждений applyWalls. Критерий — непротиворечивость: настройки
//      пережили → предупреждений 0; настройки сброшены редактором →
//      предупреждение есть (живой прогон 394-1: редактор сбрасывает prs и
//      при wall_move без смены нарезки, как в 391-1 — предупреждение
//      правдивое, а не ложное).
//   2) update ниши ПОСЛЕ уменьшения толщины стены (№19): ниша с depth 200 мм
//      на стене 20 см → wall_update thickness 100 мм → wall_niche_update
//      along_mm — унаследованная глубина обрезается до предела (ответ
//      depth_mm ≤ 100), не INVALID_ARGUMENT; save verified.
//   3) anchor на части стороны, нарезанной по длине (№16) — через MCP нарезку
//      частей создать нельзя (нет инструмента split части отделки) —
//      доказывается офлайн по фикстуре (тест 392 №16); здесь НЕ проверяется.
// Гарды: probe-guard (пара объект/план fail-closed, READONLY-гард по корневому
// эталону БЕЗ REF_INIT, checkEditorPlanMatch), assertUnchanged перед каждой
// записью, бэкап .orca-reports/backup-<OBJECT_ID>-394.json (не перезаписывается,
// пишется непосредственно перед первым прогоном), журнал site_id ДО каждой
// записи (394-captured-<N>-<n>.json, не перезаписывается), restore по журналу
// в finally (стены — deleteWallsBySiteIds внутри restoreByCaptured), cleanup-save
// в finally проверяет verified (№20), sig в конце и в catch по текущему канону
// probe-sig, итог сверять с бэкапом; ≤30 запросов/мин (лимитер MCP), closeBrowser.
//   REMPLANNER_PROBE_OBJECT_ID=… REMPLANNER_PROBE_PLAN_ID=… \
//   REMPLANNER_PROBE_READONLY_ID=… REMPLANNER_PROBE_READONLY_PLAN_ID=… \
//   REMPLANNER_PROBE_RUN_N=1 node scripts/probes/394-unfold-followup-live.ts run
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
const client = new Client({ name: "394-unfold-followup-live", version: "0.0.0" });
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

/** Журнал по номеру прогона: не перезаписывается (minor 10 ревью 390). */
const runN = process.env["REMPLANNER_PROBE_RUN_N"] ?? "";
if (!/^\d+$/.test(runN)) {
  console.error("нужен REMPLANNER_PROBE_RUN_N=<номер прогона> — журнал пробы пишется по номеру (394-captured-<N>.json), не перезаписывается");
  process.exit(1);
}
const capturedPath = (n: number): string => `.orca-reports/tmp/394-captured-${runN}-${n}.json`;
let capturedN = 0;
while (existsSync(capturedPath(capturedN))) capturedN++;
const CAPTURED = capturedPath(capturedN);
const created: ProbeCreated[] = [];
const ownRoomIds: string[] = [];
const journal = (): void => writeFileSync(CAPTURED, JSON.stringify({ run: runN, rooms: ownRoomIds, created }, null, 1) + "\n");
const dropGoneRooms = async (): Promise<void> => {
  if (ownRoomIds.length === 0) return;
  const full = (await call("model_get", { detail: "full" })) as { rooms2?: Record<string, unknown> };
  const rooms2 = full["rooms2"] ?? {};
  for (let i = ownRoomIds.length - 1; i >= 0; i--) {
    const rid = ownRoomIds[i]!;
    if (rooms2[rid] === undefined) {
      console.log(`комната ${rid} больше не существует — снятие отделки пропущено`);
      ownRoomIds.splice(i, 1);
    }
  }
};

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
  const backupPath = `.orca-reports/backup-${ids.objectId}-394.json`;
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
    for (const c of [...created].reverse()) {
      try {
        if (c.kind === "wall_niche" && c.siteId) await call("wall_niche_delete", { niche_id: c.siteId });
        else continue;
        console.log(`cleanup ${c.kind} ${c.siteId}: ok`);
      } catch (ce) { console.error(`cleanup ${c.kind} ${c.siteId}: ${String((ce as Error).message).slice(0, 140)}`); }
    }
    await dropGoneRooms();
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
  const x0 = 30000, y0 = 30000;
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
  // №20 follow-up 392: комната ОБЯЗАНА найтись (undefined = FAIL)
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

  // ==== №17: wall_move БЕЗ смены нарезки — нет ложного предупреждения о сбросе prs ====
  const prsRes = await call("prs_set", { room, hide_walls: [wallIds[0]] }) as { hidden?: boolean; disabled_edges?: unknown[] };
  check(prsRes["hidden"] === false, `prs_set скрыл одну развёртку (hidden=false, disabled=${JSON.stringify(prsRes["disabled_edges"])})`);
  journal();
  await call("model_validate", {});
  await gsave("prs_set (скрыта одна развёртка)");
  const roomPrsOf = async (): Promise<unknown> => {
    const mg = await call("model_get", {}) as { rooms?: Array<{ id?: string; prs?: unknown }> };
    return (mg["rooms"] ?? []).find((r) => r["id"] === room)?.["prs"] ?? null;
  };
  const stBefore = await roomPrsOf();
  const moveRes = await call("wall_move", { wall_id: wallIds[0], offset_mm: 20 }) as { warnings?: unknown[] };
  const moveWarn = ((moveRes["warnings"] ?? []) as unknown[]).map(String);
  console.log("wall_move warnings:", JSON.stringify(moveWarn));
  await call("model_validate", {});
  const saveMove = await gsave("wall_move без смены нарезки");
  check(saveMove["verified"] === true, "save wall_move verified");
  const stAfter = await roomPrsOf();
  const settingsKept = JSON.stringify(stBefore) === JSON.stringify(stAfter);
  const prsWarn = moveWarn.filter((w) => /настройки развёрток/.test(w));
  // Ложного предупреждения нет = непротиворечивость: настройки пережили —
  // предупреждений 0; настройки сброшены редактором — предупреждение есть
  // (живое доказательство 394-1: редактор сбрасывает prs и при wall_move без
  // смены нарезки, как в 391-1 — предупреждение правдивое, не ложное)
  const noFalseWarning = settingsKept ? prsWarn.length === 0 : prsWarn.length > 0;
  check(
    noFalseWarning,
    `№17 wall_move без смены нарезки: настройки ${settingsKept ? "ПЕРЕЖИЛИ (без ложного предупреждения)" : "сброшены редактором (предупреждение о фактическом сбросе есть)"}, предупреждений о prs: ${prsWarn.length} (${JSON.stringify(stAfter)})`,
  );

  // ==== №19: update ниши после уменьшения толщины стены ====
  const niche = await call("wall_niche_add", { room, wall: wallIds[1], along_mm: 1500, bottom_mm: 1200, width_mm: 800, height_mm: 1000 }) as Record<string, unknown>;
  check(niche["depth_mm"] === 200, `ниша создана: depth_mm=${String(niche["depth_mm"])} (умолчание 200 на стене 20 см)`);
  if (niche["site_id"]) created.push({ kind: "wall_niche", siteId: String(niche["site_id"]) });
  journal();
  await call("model_validate", {});
  const saveNiche = await gsave("ниша");
  check(saveNiche["verified"] === true, "save ниши verified");
  // толщина стены w2: 200 мм → 100 мм
  await call("wall_update", { wall_id: wallIds[1], thickness_mm: 100 });
  await call("model_validate", {});
  const saveThin = await gsave("утоньшение стены с нишей");
  check(saveThin["verified"] === true, "save утоньшения verified");
  // update ниши: унаследованная глубина 200 мм обрезается до 100, не отказ
  const nicheUpd = await call("wall_niche_update", { niche_id: niche["niche_id"], along_mm: 1500 }) as Record<string, unknown>;
  check(typeof nicheUpd["depth_mm"] === "number" && (nicheUpd["depth_mm"] as number) <= 100 && (nicheUpd["depth_mm"] as number) >= 50,
    `№19 update ниши после утоньшения: depth_mm=${String(nicheUpd["depth_mm"])} (обрезана до предела, не INVALID_ARGUMENT)`);
  await call("model_validate", {});
  const saveUpd = await gsave("update ниши после утоньшения");
  check(saveUpd["verified"] === true, "save update ниши verified");
} catch (e) {
  console.error("ERROR:", String((e as Error).message).slice(0, 400));
  exitCode = 1;
  try {
    const ids = probeWriteEnv();
    const after = await loadModel(ctx.session(), ids.objectId, ids.planId);
    const backupPath = `.orca-reports/backup-${ids.objectId}-394.json`;
    if (existsSync(backupPath)) console.error("sig (catch) vs backup:", sig(after.model) === sig(JSON.parse(readFileSync(backupPath, "utf8")).model) ? "OK" : "РАСХОЖДЕНИЕ");
  } catch (ce) { console.error("sig (catch) недоступен:", String((ce as Error).message).slice(0, 150)); }
} finally {
  try {
    const ids = probeWriteEnv();
    await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
    await assertEditorPlanMatch(editorOf(), ids.planId);
    for (const c of [...created].reverse()) {
      try {
        if (c.kind === "wall_niche" && c.siteId) await call("wall_niche_delete", { niche_id: c.siteId });
        else continue;
        const i = created.indexOf(c); created.splice(i, 1);
        console.log(`cleanup ${c.kind} ${c.siteId}: ok`);
      } catch (ce) { console.error(`cleanup ${c.kind} ${c.siteId}: ${String((ce as Error).message).slice(0, 120)}`); }
    }
    journal();
    await dropGoneRooms();
    await restoreByCaptured({
      call,
      created,
      ownRoomIds,
      save: async () => {
        await roGuard!.assertUnchanged("cleanup-save");
        // №20 follow-up 392: cleanup-save в finally проверяет verified
        const r = await call("project_save", {}) as { verified?: boolean };
        if (r["verified"] !== true) throw new Error("cleanup save (finally) не verified");
        await delay(5500);
      },
      log: (l) => console.error("restore:", l),
    });
    const after = await loadModel(ctx.session(), ids.objectId, ids.planId);
    const backupPath = `.orca-reports/backup-${ids.objectId}-394.json`;
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
