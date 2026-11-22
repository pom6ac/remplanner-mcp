// 389: живая проверка «Развёртки» в dev-объекте (ID — ТОЛЬКО из env командной
// строки): пробная комната (4 стены) → prs_set (первая/скрытие) → wall_molding_add
// → wall_niche_add → finish_wall_set + finish_wall_anchor_set → validate → save
// verified → reopen → сверка → render PNG. Зачистка — restoreByCaptured (стены,
// отделка своих комнат) + wall_molding_delete/wall_niche_delete по журналу.
// Гарды: probe-guard (пара объект/план, READONLY-гард по корневому эталону без
// REF_INIT, checkEditorPlanMatch fail-closed), assertUnchanged перед каждой
// записью, бэкап .orca-reports/backup-<OBJECT_ID>-389.json (не перезаписывается),
// журнал site_id до каждой записи, restore в finally, sig в конце и в catch,
// ≤30 запросов/мин (лимитер MCP), closeBrowser.
//   node scripts/probes/389-unfold-live.ts run
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { loadModel, type LoadedModel } from "../../src/api.ts";
import { sig } from "./probe-sig.ts";
import { assertEditorPlanMatch, probeWriteEnv, assertTargetPair, readonlyGuard, readonlyRefPath } from "./probe-guard.ts";
import { restoreByCaptured, logCaptured, type ProbeCreated } from "./probe-restore.ts";

const phase = process.argv[2] ?? "run";
const isCleanup = phase === "cleanup";
mkdirSync(".orca-reports/tmp", { recursive: true });
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 14 * 60_000).unref();

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "389-unfold-live", version: "0.0.0" });
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
const CAPTURED = ".orca-reports/tmp/389-captured.json";
const created: ProbeCreated[] = [];
const ownRoomIds: string[] = [];
const journal = (): void => writeFileSync(CAPTURED, JSON.stringify({ rooms: ownRoomIds, created }, null, 1) + "\n");

let exitCode = 0;
const check = (ok: boolean, msg: string): void => { console.log(`${ok ? "PASS" : "FAIL"}: ${msg}`); if (!ok) exitCode = 1; };
const editorOf = (): Parameters<typeof assertEditorPlanMatch>[0] | null =>
  (ctx as unknown as { workspaceOrNull: { editorOrNull: () => Parameters<typeof assertEditorPlanMatch>[0] | null } | null }).workspaceOrNull?.editorOrNull?.() ?? null;

let roGuard: Awaited<ReturnType<typeof readonlyGuard>> | null = null;
try {
  const ids = probeWriteEnv();
  await assertTargetPair(ctx.session(), ids.objectId, ids.planId);
  roGuard = await readonlyGuard(ctx.session(), ids.readonlyId, ids.readonlyPlanId, readonlyRefPath(ids.readonlyId, ids.readonlyPlanId));
  const gsave = async (tag: string): Promise<Record<string, unknown>> => {
    journal();
    await roGuard!.assertUnchanged(tag);
    const r = await call("project_save", {}) as { verified?: boolean; warnings?: unknown[] };
    console.log(`save ${tag}: verified=${r["verified"]} warnings=${(r["warnings"] ?? []).length}`);
    if (!r["verified"]) throw new Error(`save ${tag} не verified`);
    await delay(5500);
    return r;
  };
  const backupPath = `.orca-reports/backup-${ids.objectId}-389.json`;
  const before: LoadedModel = await loadModel(ctx.session(), ids.objectId, ids.planId);
  if (existsSync(backupPath)) console.log("backup exists — НЕ перезаписывается:", backupPath);
  else { writeFileSync(backupPath, JSON.stringify(before, null, 1) + "\n"); console.log("backup written:", backupPath); }
  await roGuard!.assertUnchanged("before");

  if (isCleanup) {
    // зачистка ТОЛЬКО по журналу site_id (не по геометрии)
    await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
    await call("render_plan", {});
    await assertEditorPlanMatch(editorOf(), ids.planId);
    const cap = JSON.parse(readFileSync(CAPTURED, "utf8")) as { rooms: string[]; created: ProbeCreated[] };
    created.push(...cap["created"]);
    ownRoomIds.push(...cap["rooms"]);
    for (const c of [...created].reverse()) {
      try {
        if (c.kind === "wall_molding" && c.siteId) await call("wall_molding_delete", { molding_id: c.siteId });
        else if (c.kind === "wall_niche" && c.siteId) await call("wall_niche_delete", { niche_id: c.siteId });
        else continue;
        console.log(`cleanup ${c.kind} ${c.siteId}: ok`);
      } catch (ce) { console.error(`cleanup ${c.kind} ${c.siteId}: ${String((ce as Error).message).slice(0, 140)}`); }
    }
    // своя комната по стенам из журнала (не по геометрии развёрток)
    const mg = await call("model_get", {}) as { rooms?: Array<{ id?: string; edges?: Array<{ from?: [number, number]; to?: [number, number] }> }> };
    for (const r of mg["rooms"] ?? []) {
      const es = r["edges"] ?? [];
      if (es.length >= 4 && es.every((e) => {
        const [fx, fy] = e["from"] ?? [0, 0];
        const [tx, ty] = e["to"] ?? [0, 0];
        return fx >= 19999 && fx <= 23001 && fy >= 19999 && fy <= 22601 && tx >= 19999 && tx <= 23001 && ty >= 19999 && ty <= 22601;
      })) ownRoomIds.push(String(r["id"]));
    }
    journal();
    await restoreByCaptured({
      call, created, ownRoomIds,
      save: async () => { await roGuard!.assertUnchanged("cleanup-save"); const r = await call("project_save", {}) as { verified?: boolean }; if (r["verified"] !== true) throw new Error("cleanup save не verified"); await delay(5500); },
      log: (l) => console.error("restore:", l),
    });
    const after = await loadModel(ctx.session(), ids.objectId, ids.planId);
    const { canon } = await import("./probe-sig.ts");
    const ca = JSON.stringify(canon(after.model), null, 1);
    const cb = JSON.stringify(canon(JSON.parse(readFileSync(backupPath, "utf8")).model), null, 1);
    writeFileSync(".orca-reports/tmp/389-after-canon.json", ca);
    writeFileSync(".orca-reports/tmp/389-backup-canon.json", cb);
    const same = ca === cb;
    console.log("sig (cleanup) vs backup:", same ? "OK" : "РАСХОЖДЕНИЕ");
    if (!same) {
      // грубый поключевой дифф канона (для диагностики; в лог — только пути)
      const ja = JSON.parse(ca) as Record<string, unknown>;
      const jb = JSON.parse(cb) as Record<string, unknown>;
      for (const k of Object.keys({ ...ja, ...jb })) {
        if (JSON.stringify(ja[k]) !== JSON.stringify(jb[k])) console.error("diff key:", k);
      }
    }
    await closeBrowser().catch(() => {});
    console.log("EXIT:", same ? 0 : 1);
    process.exit(same ? 0 : 1);
  }

  await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
  await call("render_plan", {});
  await assertEditorPlanMatch(editorOf(), ids.planId);
  check(true, "открытие + render_plan + гард плана");

  // ==== пробная комната: 4 стены 3000×2600 (мм) ====
  const x0 = 20000, y0 = 20000;
  const wallIds: string[] = [];
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
  }
  journal();
  const saveWalls = await gsave("стены пробной комнаты");
  check(saveWalls["verified"] === true, "save стен verified");
  const mgRooms = await call("model_get", {}) as { rooms?: Array<{ id?: string; edges?: Array<{ from?: [number, number]; to?: [number, number] }> }> };
  // своя комната — все её рёбра внутри габаритов пробных стен (свои данные пробы)
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

  // ==== prs_set: «назначить первой» + скрыть развёртку ====
  await call("prs_set", { room, first_wall: wallsOfRoom[0], hide_walls: [wallsOfRoom[2]] });
  const mg1 = await call("model_get", {}) as { rooms?: Array<{ id?: string; prs?: Record<string, unknown> }> };
  const st1 = (mg1["rooms"] ?? []).find((r) => r["id"] === room)?.["prs"] as { hidden?: boolean; first_edge?: number | null; disabled_edges?: number[] } | undefined;
  check(st1 !== undefined, `prs_set отражён в model_get: ${JSON.stringify(st1)}`);
  check(st1?.["first_edge"] === 0, `первая развёртка — ребро 0 (${JSON.stringify(st1)})`);
  check((st1?.["disabled_edges"] ?? []).includes(2), `развёртка ребра 2 скрыта (${JSON.stringify(st1)})`);
  await call("model_validate", {});
  await gsave("prs_set");

  // ==== молдинг и ниша развёртки ====
  const mold = await call("wall_molding_add", { room, wall: wallsOfRoom[0], along_mm: 1500, bottom_mm: 1200, width_mm: 800, height_mm: 100 }) as { molding_id?: string; site_id?: string };
  check(typeof mold["molding_id"] === "string", `wall_molding_add → ${mold["molding_id"]}`);
  if (mold["site_id"]) created.push({ kind: "wall_molding", siteId: mold["site_id"] });
  const niche = await call("wall_niche_add", { room, wall: wallsOfRoom[1], along_mm: 1000, bottom_mm: 1200, width_mm: 800, height_mm: 1000, depth_mm: 200 }) as { niche_id?: string; site_id?: string };
  check(typeof niche["niche_id"] === "string", `wall_niche_add → ${niche["niche_id"]}`);
  if (niche["site_id"]) created.push({ kind: "wall_niche", siteId: niche["site_id"] });
  journal();
  await call("model_validate", {});
  const saveFig = await gsave("молдинг+ниша");
  check(saveFig["verified"] === true, "save молдинг+ниша verified");

  // ==== точка укладки плитки на стене (anchor_decor): отделка + якорь ====
  await call("finish_wall_set", { room_id: room, wall_id: wallsOfRoom[3], type: "wall_tile" });
  const anch = await call("finish_wall_anchor_set", { room, wall: wallsOfRoom[3], along_mm: 1000, height_mm: 800 }) as { edge?: number; anchor?: Record<string, unknown> };
  check(typeof anch["edge"] === "number", `finish_wall_anchor_set поставил точку (ребро ${String(anch["edge"])})`);
  journal();
  await call("model_validate", {});
  const saveAnchor = await gsave("точка укладки");
  check(saveAnchor["verified"] === true, "save точка укладки verified");

  // ==== reopen → сверка → render PNG ====
  await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
  await assertEditorPlanMatch(editorOf(), ids.planId);
  const mg2 = await call("model_get", {}) as { wall_moldings?: unknown[]; wall_niches?: unknown[]; rooms?: Array<{ id?: string; prs?: Record<string, unknown> }> };
  check(Array.isArray(mg2["wall_moldings"]) && (mg2["wall_moldings"] as unknown[]).length === 1, `молдинг на сервере после reopen (${JSON.stringify(mg2["wall_moldings"])})`);
  check(Array.isArray(mg2["wall_niches"]) && (mg2["wall_niches"] as unknown[]).length === 1, `ниша на сервере после reopen (${JSON.stringify(mg2["wall_niches"])})`);
  const st2 = (mg2["rooms"] ?? []).find((r) => r["id"] === room)?.["prs"] as { first_edge?: number; disabled_edges?: number[] } | undefined;
  check(st2?.["first_edge"] === 0 && (st2?.["disabled_edges"] ?? []).includes(2), `prs-настройки пережили reopen (${JSON.stringify(st2)})`);
  const png = await call("render_plan", {}) as { png_base64?: string; revision?: unknown };
  check(typeof png["png_base64"] === "string" && (png["png_base64"] as string).length > 1000, "render_plan: PNG построен");
  writeFileSync(".orca-reports/tmp/389-render.png.b64", String(png["png_base64"] ?? ""));
} catch (e) {
  console.error("ERROR:", String((e as Error).message).slice(0, 400));
  exitCode = 1;
  try {
    const after = await loadModel(ctx.session(), (await import("./probe-guard.ts")).probeWriteEnv().objectId, (await import("./probe-guard.ts")).probeWriteEnv().planId);
    const backupPath = `.orca-reports/backup-${(await import("./probe-guard.ts")).probeWriteEnv().objectId}-389.json`;
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
    const backupPath = `.orca-reports/backup-${ids.objectId}-389.json`;
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
