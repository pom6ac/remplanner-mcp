// 391: живая перепроверка фиксов по ревью 390 в dev-объекте (ID — ТОЛЬКО из env
// командной строки). Пути (major 1–3, minor 6/9/10 ревью 390):
//   1) prs_set → скрытие по одной (prs_hidden при всех скрытых);
//   2) slim-молдинг (height_mm 100 → type wall_molding_slim, height=width_line)
//      и ниша на стене, несущей фигуры;
//   3) wall_move/wall_split/wall_delete со стеной, несущей молдинг и нишу —
//      затронутость фигур (предупреждения applyWalls), save verified;
//   4) anchor_decor в часть стороны (finish_wall_anchor_set, ответ в мм);
//   5) render_plan — PNG реальный (bytes > 1000 из JSON-ответа, minor 8);
//   6) строгие ожидания prs: ребро молдинга сверяется с rooms[].edges[i] из
//      model_get по координатам стены wallsOfRoom[0] (minor 9, независимо от
//      edgeByWall MCP);
// лимит глубины ниши проверяется офлайн-тестами (юнит 391 major 4) — не здесь.
// Гарды: probe-guard (пара объект/план fail-closed, READONLY-гард по корневому
// эталону БЕЗ REF_INIT, checkEditorPlanMatch), assertUnchanged перед каждой
// записью, бэкап .orca-reports/backup-<OBJECT_ID>-391.json (не перезаписывается,
// пишется непосредственно перед первым прогоном), журнал site_id ДО каждой
// записи в файл по номеру прогона (не перезаписывается, minor 10), restore по
// журналу в finally (стены — deleteWallsBySiteIds), sig в конце и в catch по
// текущему канону probe-sig, ≤30 запросов/мин (лимитер MCP), closeBrowser.
//   REMPLANNER_PROBE_OBJECT_ID=… REMPLANNER_PROBE_PLAN_ID=… \
//   REMPLANNER_PROBE_READONLY_ID=… REMPLANNER_PROBE_READONLY_PLAN_ID=… \
//   REMPLANNER_PROBE_RUN_N=1 node scripts/probes/391-unfold-fix-live.ts run
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
const client = new Client({ name: "391-unfold-fix-live", version: "0.0.0" });
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

/** Журнал по номеру прогона (minor 10 ревью 390): не перезаписывается. */
const runN = process.env["REMPLANNER_PROBE_RUN_N"] ?? "";
if (!/^\d+$/.test(runN)) {
  console.error("нужен REMPLANNER_PROBE_RUN_N=<номер прогона> — журнал пробы пишется по номеру (391-captured-<N>.json), не перезаписывается");
  process.exit(1);
}
const capturedPath = (n: number): string => `.orca-reports/tmp/391-captured-${runN}-${n}.json`;
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
  const backupPath = `.orca-reports/backup-${ids.objectId}-391.json`;
  const before: LoadedModel = await loadModel(ctx.session(), ids.objectId, ids.planId);
  if (existsSync(backupPath)) console.log("backup exists — НЕ перезаписывается:", backupPath);
  else { writeFileSync(backupPath, JSON.stringify(before, null, 1) + "\n"); console.log("backup written:", backupPath); }
  await roGuard!.assertUnchanged("before");

  if (phase === "cleanup") {
    // зачистка ТОЛЬКО по журналу site_id (не по геометрии)
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
        if (c.kind === "wall_molding" && c.siteId) await call("wall_molding_delete", { molding_id: c.siteId });
        else if (c.kind === "wall_niche" && c.siteId) await call("wall_niche_delete", { niche_id: c.siteId });
        else continue;
        console.log(`cleanup ${c.kind} ${c.siteId}: ok`);
      } catch (ce) { console.error(`cleanup ${c.kind} ${c.siteId}: ${String((ce as Error).message).slice(0, 140)}`); }
    }
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
  const x0 = 20000, y0 = 20000;
  const wallIds: string[] = [];
  const wallSegs: Array<{ from: [number, number]; to: [number, number] }> = [];
  const segs: Array<[Record<string, unknown>, Record<string, unknown>]> = [
    [{ x: x0, y: y0 }, { x: x0 + 3000, y: y0 }],
    [{ x: x0 + 3000, y: y0 }, { x: x0 + 3000, y: y0 + 2600 }],
    [{ x: x0 + 3000, y: y0 + 2600 }, { x: x0, y: y0 + 2600 }],
    [{ x: x0, y: y0 + 2600 }, { x: x0, y: y0 }],
  ];
  for (const [s, e] of segs) {
    const r = await call("wall_add", { start: s, end: e }) as { entity?: { id?: string; site_id?: string } | null };
    const site = r["entity"]?.["site_id"];
    check(typeof site === "string" && site.length > 0, `wall_add создал стену (${site ?? "?"})`);
    if (typeof site === "string") { wallIds.push(site); created.push({ kind: "wall", siteId: site }); }
    wallSegs.push({ from: [Number(s["x"]), Number(s["y"])], to: [Number(e["x"]), Number(e["y"])] });
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
  ownRoomIds.push(room);
  journal();
  const wallsOfRoom = wallIds;
  /** Независимое ребро стены в model_get rooms[].edges (по координатам оси, minor 9). */
  const edgeOfWallInRoom = (wallIdx: number): number | null => {
    const seg = wallSegs[wallIdx]!;
    const es = mine!["edges"] ?? [];
    const idx = es.findIndex((e) => {
      const [fx, fy] = e["from"] ?? [0, 0];
      const [tx, ty] = e["to"] ?? [0, 0];
      const fwd = Math.abs(fx - seg.from[0]) <= 1 && Math.abs(fy - seg.from[1]) <= 1 && Math.abs(tx - seg.to[0]) <= 1 && Math.abs(ty - seg.to[1]) <= 1;
      const rev = Math.abs(fx - seg.to[0]) <= 1 && Math.abs(fy - seg.to[1]) <= 1 && Math.abs(tx - seg.from[0]) <= 1 && Math.abs(ty - seg.from[1]) <= 1;
      return fwd || rev;
    });
    return idx >= 0 ? idx : null;
  };

  // ==== prs_set: скрытие по одной → все скрыты → prs_hidden=true (minor 6) ====
  const prsRes = await call("prs_set", { room, hide_walls: wallsOfRoom }) as { room?: string; hidden?: boolean; first_edge?: unknown; disabled_edges?: unknown[] };
  check(prsRes["hidden"] === true, `prs_set скрыл все по одной → hidden=true (${JSON.stringify(prsRes)})`);
  check(!("firstEdge" in prsRes) && !("disabledEdges" in prsRes), `prs_set ответ в snake_case (${JSON.stringify(Object.keys(prsRes))})`);
  const mg1 = await call("model_get", {}) as { rooms?: Array<{ id?: string; prs?: Record<string, unknown> }> };
  const st1 = (mg1["rooms"] ?? []).find((r) => r["id"] === room)?.["prs"] as { hidden?: boolean; first_edge?: number | null; disabled_edges?: number[] } | undefined;
  check(st1?.["hidden"] === true, `prs_hidden в model_get: ${JSON.stringify(st1)}`);
  await call("model_validate", {});
  await gsave("prs_set");

  // ==== slim-молдинг (major 3) и ниша на стене с фигурами ====
  const mold = await call("wall_molding_add", { room, wall: wallsOfRoom[0], along_mm: 1500, bottom_mm: 1200, width_mm: 800, height_mm: 100 }) as Record<string, unknown>;
  check(mold["type"] === "wall_molding_slim", `slim-тип: ${String(mold["type"])}`);
  check(mold["height_mm"] === mold["width_line_mm"], `высота slim = толщине линии (${String(mold["height_mm"])} = ${String(mold["width_line_mm"])})`);
  check(typeof mold["molding_id"] === "string" && typeof mold["site_id"] === "string", `wall_molding_add → ${String(mold["molding_id"])}`);
  check(!("pc" in mold) && !("pc_xd" in mold) && !("prs" in mold), `ответ без формата редактора (${JSON.stringify(Object.keys(mold))})`);
  check(mold["along_mm"] === 1500 && mold["width_mm"] === 800, `позиция/размер в мм: ${JSON.stringify({ along_mm: mold["along_mm"], from_floor_mm: mold["from_floor_mm"] })}`);
  if (mold["site_id"]) created.push({ kind: "wall_molding", siteId: String(mold["site_id"]) });
  const moldEdgeExpected = edgeOfWallInRoom(0);
  check(mold["edge_index"] === moldEdgeExpected, `ребро молдинга = ребру стены из rooms[].edges (${String(mold["edge_index"])} == ${String(moldEdgeExpected)}, minor 9)`);
  journal();
  await call("model_validate", {});
  const saveMold = await gsave("slim-молдинг");
  check(saveMold["verified"] === true, "save slim-молдинг verified");

  const niche = await call("wall_niche_add", { room, wall: wallsOfRoom[1], along_mm: 1000, bottom_mm: 1200, width_mm: 800, height_mm: 1000 }) as Record<string, unknown>;
  check(typeof niche["niche_id"] === "string", `wall_niche_add → ${String(niche["niche_id"])}`);
  check(!("pc" in niche) && !("prs" in niche), `ответ ниши без формата редактора (${JSON.stringify(Object.keys(niche))})`);
  if (niche["site_id"]) created.push({ kind: "wall_niche", siteId: String(niche["site_id"]) });
  journal();
  await call("model_validate", {});
  const saveFig = await gsave("молдинг+ниша");
  check(saveFig["verified"] === true, "save молдинг+ниша verified");

  // ==== anchor_decor в часть стороны (major 2, ответ в мм — major 5) ====
  await call("finish_wall_set", { room_id: room, wall_id: wallsOfRoom[3], type: "wall_tile" });
  const anch = await call("finish_wall_anchor_set", { room, wall: wallsOfRoom[3], along_mm: 1000, height_mm: 800 }) as Record<string, unknown>;
  check(typeof anch["edge"] === "number", `finish_wall_anchor_set: ребро ${String(anch["edge"])}`);
  check(anch["along_mm"] === 1000 && anch["height_mm"] === 800, `ответ в мм: ${JSON.stringify({ along_mm: anch["along_mm"], height_mm: anch["height_mm"] })}`);
  check(!("anchor" in anch) && !("p" in anch), `ответ без p/pc-структур редактора (${JSON.stringify(Object.keys(anch))})`);
  check(anch["layer"] === 1, `часть стороны: part=${String(anch["part"])} layer=${String(anch["layer"])}`);
  journal();
  await call("model_validate", {});
  const saveAnchor = await gsave("точка укладки");
  check(saveAnchor["verified"] === true, "save точка укладки verified");

  // ==== wall_move стены с молдингом и нишей (major 1) ====
  const moveRes = await call("wall_move", { wall_id: wallsOfRoom[0], offset_mm: 20 }) as { warnings?: unknown[] } | Record<string, unknown>;
  const moveWarn = ((moveRes["warnings"] ?? []) as unknown[]).map((w) => String(w));
  console.log("wall_move warnings:", JSON.stringify(moveWarn));
  await call("model_validate", {});
  const saveMove = await gsave("wall_move с фигурами");
  check(saveMove["verified"] === true, "save wall_move verified");
  const mgMove = await call("model_get", {}) as { wall_moldings?: unknown[]; wall_niches?: unknown[] };
  check((mgMove["wall_moldings"] ?? []).length === 1 && (mgMove["wall_niches"] ?? []).length === 1, `фигуры пережили wall_move (${JSON.stringify({ m: (mgMove["wall_moldings"] ?? []).length, n: (mgMove["wall_niches"] ?? []).length })})`);

  // ==== wall_split стены с точкой укладки (major 1) ====
  const splitRes = await call("wall_split", { wall_id: wallsOfRoom[3], at_mm: 1500 }) as Record<string, unknown>;
  const splitWarn = ((splitRes["warnings"] ?? []) as unknown[]).map((w) => String(w));
  console.log("wall_split warnings:", JSON.stringify(splitWarn));
  await call("model_validate", {});
  const saveSplit = await gsave("wall_split с точкой укладки");
  check(saveSplit["verified"] === true, "save wall_split verified");

  // ==== reopen → сверка → render PNG (minor 8: bytes > 1000) ====
  await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
  await assertEditorPlanMatch(editorOf(), ids.planId);
  const mg2 = await call("model_get", {}) as { wall_moldings?: unknown[]; wall_niches?: unknown[]; rooms?: Array<{ id?: string; prs?: Record<string, unknown> }> };
  check((mg2["wall_moldings"] ?? []).length === 1, `молдинг на сервере после reopen (${JSON.stringify(mg2["wall_moldings"])})`);
  check((mg2["wall_niches"] ?? []).length === 1, `ниша на сервере после reopen (${JSON.stringify(mg2["wall_niches"])})`);
  const st2 = (mg2["rooms"] ?? []).find((r) => r["id"] === room)?.["prs"] as { hidden?: boolean; disabled_edges?: number[] } | undefined;
  check(st2?.["hidden"] === true, `prs-настройки пережили reopen (${JSON.stringify(st2)})`);
  const render = await call("render_plan", {}) as { bytes?: number; path?: string };
  check(typeof render["bytes"] === "number" && render["bytes"] > 1000, `render_plan: PNG реальный, bytes=${String(render["bytes"])} (minor 8)`);
} catch (e) {
  console.error("ERROR:", String((e as Error).message).slice(0, 400));
  exitCode = 1;
  try {
    const ids = probeWriteEnv();
    const after = await loadModel(ctx.session(), ids.objectId, ids.planId);
    const backupPath = `.orca-reports/backup-${ids.objectId}-391.json`;
    if (existsSync(backupPath)) console.error("sig (catch) vs backup:", sig(after.model) === sig(JSON.parse(readFileSync(backupPath, "utf8")).model) ? "OK" : "РАСХОЖДЕНИЕ");
  } catch (ce) { console.error("sig (catch) недоступен:", String((ce as Error).message).slice(0, 150)); }
} finally {
  // зачистка: развёртки/отделка по журналу, стены и комнаты — restoreByCaptured
  try {
    const ids = probeWriteEnv();
    await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
    await assertEditorPlanMatch(editorOf(), ids.planId);
    for (const c of [...created].reverse()) {
      try {
        if (c.kind === "wall_molding" && c.siteId) await call("wall_molding_delete", { molding_id: c.siteId });
        else if (c.kind === "wall_niche" && c.siteId) await call("wall_niche_delete", { niche_id: c.siteId });
        else continue;
        const i = created.indexOf(c); created.splice(i, 1);
        console.log(`cleanup ${c.kind} ${c.siteId}: ok`);
      } catch (ce) { console.error(`cleanup ${c.kind} ${c.siteId}: ${String((ce as Error).message).slice(0, 120)}`); }
    }
    journal();
    await restoreByCaptured({
      call,
      created,
      ownRoomIds,
      save: async () => { await roGuard!.assertUnchanged("cleanup-save"); await call("project_save", {}); await delay(5500); },
      log: (l) => console.error("restore:", l),
    });
    const after = await loadModel(ctx.session(), ids.objectId, ids.planId);
    const backupPath = `.orca-reports/backup-${ids.objectId}-391.json`;
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
