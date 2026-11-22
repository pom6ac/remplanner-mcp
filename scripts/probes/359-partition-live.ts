// 359: живая проверка фикса «opening_add на перегородку (plan:c) → save» в dev-объекте.
// Сценарий задания: пробная комната из перегородок → дверь и окно на перегородке через MCP
// → save verified → reopen → render PNG → удаление; бэкап ДО прогона, гарды probe-guard
// (fail-closed план), restore общим probe-restore по захваченным ID, сверка sig,
// контрольный проект — только читается (эталон корневой, без REF_INIT).
// ID — ТОЛЬКО из env командной строки (в файлы и коммиты не писать).
//   node scripts/probes/359-partition-live.ts dev
//   … те же env + REMPLANNER_PROBE_OPENING_IDS/…_WALL_SITE_IDS из журнала \
//   node scripts/probes/359-partition-live.ts cleanup
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { loadModel, type LoadedModel } from "../../src/api.ts";
import { sig } from "./probe-sig.ts";
import { assertEditorPlanMatch, guardedSave } from "./probe-guard.ts";
import { restoreByCaptured, logCaptured, type ProbeCreated } from "./probe-restore.ts";

const phase = process.argv[2] ?? "dev";
const isCleanup = phase === "cleanup";
mkdirSync(".orca-reports/tmp", { recursive: true });
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 14 * 60_000).unref();

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: `359-live-${phase}`, version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);
type TextContent = { content: { type: string; text?: string }[] };
const text = (r: unknown): string => ((r as TextContent).content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  if (process.env["RP_TRACE"]) console.log("CALL", name, JSON.stringify(args).slice(0, 200));
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  if ((res as { isError?: boolean }).isError) {
    writeFileSync(".orca-reports/tmp/359-last-error.json", text(res));
    throw new Error(`${name}: ${text(res).slice(0, 900)}`);
  }
  return JSON.parse(text(res)) as Record<string, unknown>;
};
const tryCall = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown> | null> => {
  try { return await call(name, args); } catch (e) { return { __error: String((e as Error).message).slice(0, 300) }; }
};

let exitCode = 0;
const fails: string[] = [];
const check = (ok: boolean, msg: string): void => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${msg}`);
  if (!ok) { fails.push(msg); exitCode = 1; }
};
const editorOf = (): Parameters<typeof assertEditorPlanMatch>[0] | null =>
  (ctx as unknown as { workspaceOrNull: { editorOrNull: () => Parameters<typeof assertEditorPlanMatch>[0] | null } | null }).workspaceOrNull?.editorOrNull?.() ?? null;

try {
  const { probeWriteEnv, assertTargetPair, readonlyGuard, readonlyRefPath } = await import("./probe-guard.ts");
  const ids = probeWriteEnv();
  await assertTargetPair(ctx.session(), ids.objectId, ids.planId);
  const roGuard = await readonlyGuard(ctx.session(), ids.readonlyId, ids.readonlyPlanId, readonlyRefPath(ids.readonlyId, ids.readonlyPlanId));
  const backupPath = `.orca-reports/backup-${ids.objectId}-359.json`;
  if (isCleanup) {
    // восстановление по захваченным ID предыдущего dev-прогона (env командной строки):
    // opening_delete по каждому ID, свои стены — общим probe-restore (deleteWallsBySiteIds),
    // save, сверка sig с бэкапом. assertUnchanged контрольного проекта ПЕРЕД записью.
    await roGuard.assertUnchanged("cleanup-before");
    await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
    await call("render_plan", {});
    const edC = editorOf();
    await assertEditorPlanMatch(edC, ids.planId);
    const openingIds = (process.env["REMPLANNER_PROBE_OPENING_IDS"] ?? "").split(",").filter(Boolean);
    const wallSiteIds = (process.env["REMPLANNER_PROBE_WALL_SITE_IDS"] ?? "").split(",").filter(Boolean);
    console.log("cleanup: удаляю проёмы по захваченным ID:", JSON.stringify(openingIds));
    for (const oid of openingIds) {
      const r = await tryCall("opening_delete", { opening_id: oid });
      console.log("opening_delete", oid, r && !("__error" in r) ? "ok" : `fail: ${String((r as { __error?: string })?.__error ?? "").slice(0, 120)}`);
    }
    console.log("cleanup: удаляю стены по захваченным site_id:", JSON.stringify(wallSiteIds));
    const created: ProbeCreated[] = wallSiteIds.map((siteId) => ({ kind: "wall", siteId }));
    await restoreByCaptured({
      call,
      created,
      ownRoomIds: [],
      save: async () => {
        const saveR = await call("project_save", {});
        console.log("cleanup save verified:", saveR["verified"]);
        return saveR;
      },
      log: (line) => console.log("restore:", line),
    });
    // печать site_id каждой удалённой стены (ревью 361 №3): после restore в модели
    // не должно остаться ни одной стены из журнала
    const wallsAfterCleanup = ((await call("model_get", {}))["walls"] ?? []) as Array<{ site_id?: string }>;
    const leftWalls = wallSiteIds.filter((sid) => wallsAfterCleanup.some((w) => w.site_id === sid));
    console.log("cleanup: удалены стены:", JSON.stringify(wallSiteIds.filter((sid) => !leftWalls.includes(sid))),
      leftWalls.length ? `ОСТАЛИСЬ: ${JSON.stringify(leftWalls)}` : "(все)");
    const after: LoadedModel = await loadModel(ctx.session(), ids.objectId, ids.planId);
    const ref = JSON.parse(readFileSync(backupPath, "utf8")) as LoadedModel;
    const same = sig(after.model) === sig(ref.model);
    console.log("sig restored == backup:", same);
    if (!same) exitCode = 1;
    await roGuard.checkFinal("finally");
  } else {
  // бэкап ДО прогона: фиксированное имя задания + копия с меткой прогона (minor2 ревью 357:
  // бэкап и журнал — без перезаписи предыдущего прогона)
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stampPath = `.orca-reports/tmp/359-backup-${stamp}.json`;
  const before: LoadedModel = await loadModel(ctx.session(), ids.objectId, ids.planId);
  writeFileSync(backupPath, JSON.stringify(before, null, 1) + "\n");
  writeFileSync(stampPath, JSON.stringify(before, null, 1) + "\n");
  console.log("backup written:", backupPath, "and", stampPath, "sig:", sig(before.model).slice(0, 40));
  await roGuard.assertUnchanged("before");

  await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
  await call("render_plan", {});
  const ed = editorOf();
  console.log("editor:", ed ? "создан" : "НЕТ");
  await assertEditorPlanMatch(ed, ids.planId);
  console.log("гард «план в редакторе == серверу» (fail-closed): OK");

  const created: ProbeCreated[] = [];
  let restored = false;
  // ревью 361 №2: каждая запись через guardedSave (гард контрольного проекта
  // ПЕРЕД каждым project_save, а не только перед частью записей)
  const gsave = (tag: string): Promise<Record<string, unknown>> =>
    guardedSave(roGuard, async () => call("project_save", {}))(tag) as Promise<Record<string, unknown>>;
  // журнал захваченных ID с меткой прогона (ревью 361 №3): не перезаписывает
  // журнал предыдущего прогона
  const capturedPath = `.orca-reports/tmp/359-captured-${stamp}.json`;
  const journal = (): void => {
    logCaptured(capturedPath, created, []);
    console.log("журнал захваченных ID:", capturedPath);
  };
  try {
    // — пробная комната из перегородок правее/ниже всей геометрии —
    const rawWalls = (before.model["walls"] ?? {}) as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>;
    const maxX = Math.max(...Object.values(rawWalls).flatMap((w) => [w.p1.x, w.p2.x]));
    const maxY = Math.max(...Object.values(rawWalls).flatMap((w) => [w.p1.y, w.p2.y]));
    const ox = Math.ceil(maxX) + 300, oy = Math.ceil(maxY) + 300, TW = 300, TH = 240;
    const mm = (p: { x: number; y: number }): { x: number; y: number } => ({ x: Math.round(p.x * 10), y: Math.round(p.y * 10) });
    const rect: [{ x: number; y: number }, { x: number; y: number }][] = [
      [{ x: ox, y: oy }, { x: ox + TW, y: oy }],
      [{ x: ox + TW, y: oy }, { x: ox + TW, y: oy + TH }],
      [{ x: ox + TW, y: oy + TH }, { x: ox, y: oy + TH }],
      [{ x: ox, y: oy + TH }, { x: ox, y: oy }],
    ];
    for (const [s, e] of rect) {
      const r = await call("wall_add", { start: mm(s), end: mm(e), thickness_mm: 100, kind: "partition" });
      created.push({ kind: "wall", siteId: (r["entity"] as { site_id?: string })?.site_id });
    }
    journal();
    const save0 = await gsave("trial-room");
    console.log("save0 (перегородки) verified:", save0["verified"]);
    check(save0["verified"] === true, "save verified (пробная комната из перегородок)");

    // — дверь и окно на перегородке через MCP (то, что падало в 356) —
    const mg = (await call("model_get", {})) as unknown as { walls: Array<{ id: string; site_id?: string; plan?: string }> };
    const partWall1 = mg.walls.find((w) => w.site_id === created[0]!.siteId);
    const partWall3 = mg.walls.find((w) => w.site_id === created[2]!.siteId);
    if (!partWall1 || !partWall3) { console.error("свои перегородки не найдены в model_get — СТОП"); process.exit(1); }
    const door = await call("opening_add", { wall_id: partWall1.id, type: "door", center_mm: 1500 }) as { entity?: Record<string, unknown> };
    console.log("door on partition:", JSON.stringify(door.entity));
    created.push({ kind: "opening", siteId: String(door["entity"]?.id ?? door["entity"]?.site_id ?? "") });
    journal();
    const save1 = await gsave("дверь на перегородке");
    console.log("save1 (дверь на перегородке) verified:", save1["verified"]);
    check(save1["verified"] === true, "save verified (дверь на перегородке — падение 356 исправлено)");

    // окно на соседней перегородке пробной комнаты (на той же стене, что дверь,
    // не помещается по ширине: дверь 110–190 см, окно 100 см)
    const windowAdd = await call("opening_add", { wall_id: partWall3.id, type: "window", center_mm: 1500, width_mm: 1000, sill_height_mm: 850 }) as { entity?: Record<string, unknown> };
    console.log("window on partition:", JSON.stringify(windowAdd.entity));
    created.push({ kind: "opening", siteId: String(windowAdd["entity"]?.id ?? windowAdd["entity"]?.site_id ?? "") });
    journal();
    const save2 = await gsave("окно на перегородке");
    console.log("save2 (окно на перегородке) verified:", save2["verified"]);
    check(save2["verified"] === true, "save verified (окно на перегородке)");

    // doorway (проём без заполнения) на перегородке с дверью: дверь 110–190 см,
    // doorway 210–290 см — на той же стене помещается
    const doorwayAdd = await call("opening_add", { wall_id: partWall1.id, type: "doorway", center_mm: 2500 }) as { entity?: Record<string, unknown> };
    console.log("doorway on partition:", JSON.stringify(doorwayAdd.entity));
    created.push({ kind: "opening", siteId: String(doorwayAdd["entity"]?.id ?? doorwayAdd["entity"]?.site_id ?? "") });
    journal();
    const save3 = await gsave("проём без заполнения");
    console.log("save3 (проём без заполнения) verified:", save3["verified"]);
    check(save3["verified"] === true, "save verified (проём без заполнения на перегородке)");

    // — reopen: план fail-closed; точки граней l1/l2/r1/r2 у проёмов plan:c в модели сервера —
    await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
    const ed2 = editorOf();
    await assertEditorPlanMatch(ed2, ids.planId);
    const after: LoadedModel = await loadModel(ctx.session(), ids.objectId, ids.planId);
    const partWallsAfter = Object.entries(after.model.walls as Record<string, { plan: string; holes?: Record<string, Record<string, unknown>> }>)
      .filter(([, w]) => w.plan === "c");
    let l1Count = 0;
    for (const [, w] of partWallsAfter) for (const h of Object.values(w.holes ?? {})) if (h["l1"] !== undefined) l1Count++;
    console.log(`plan:c holes с l1 после save: ${l1Count}`);
    check(l1Count === 3, "у всех трёх проёмов plan:c в модели сервера есть точки граней l1");
    for (const [, w] of partWallsAfter) {
      for (const [hid, h] of Object.entries(w.holes ?? {})) {
        console.log(`  ${hid}:${h["type"]} l1=${JSON.stringify(h["l1"])} r1=${JSON.stringify(h["r1"])} f0offset=${JSON.stringify(h["f0offset"])}`);
      }
    }

    // — render PNG листа перегородок —
    try {
      const render = await call("render_plan", { sheet: "create_walls" });
      const bytes = Number((render as { bytes?: number })["bytes"] ?? 0);
      console.log("render bytes:", bytes);
      check(bytes > 10000, "render_plan create_walls отдал PNG");
    } catch (e) {
      console.log("render error:", String((e as Error).message).slice(0, 300));
      check(false, "render_plan create_walls отдал PNG");
    }

    // — удаление трёх проёмов —
    await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
    const ed3 = editorOf();
    await assertEditorPlanMatch(ed3, ids.planId);
    const dels: string[] = [];
    for (const c of created) {
      if (c.kind !== "opening" || !c.siteId) continue;
      const del = await call("opening_delete", { opening_id: c.siteId }) as { deleted?: string[] };
      console.log("opening_delete", c.siteId, JSON.stringify(del.deleted ?? []));
      dels.push(...(del["deleted"] ?? []));
    }
    check(dels.length === 3, `удалены все три проёма перегородки: ${dels.length}`);
    const save4 = await gsave("проёмы удалены");
    console.log("save4 (проёмы удалены) verified:", save4["verified"]);
    check(save4["verified"] === true, "save verified (проёмы перегородки удалены)");

  } finally {
    // ревью 361 №1: restore — в finally (при пустом created — no-op); любое
    // исключение после первой записи не оставляет пробные стены/проёмы
    if (!restored) {
      restored = true;
      try {
        await roGuard.assertUnchanged("restore");
        await restoreByCaptured({
          call,
          created,
          ownRoomIds: [],
          save: async () => {
            const saveR = await call("project_save", {});
            console.log("restore save:", saveR["verified"]);
            return saveR;
          },
          log: (line) => console.log("restore:", line),
        });
      } catch (e) {
        console.log("restore error:", String((e as Error).message).slice(0, 250));
        exitCode = 1;
      }
    }
    const after: LoadedModel = await loadModel(ctx.session(), ids.objectId, ids.planId);
    const ref = JSON.parse(readFileSync(backupPath, "utf8")) as LoadedModel;
    const same = sig(after.model) === sig(ref.model);
    console.log("sig restored == backup:", same);
    if (!same) {
      console.error(`модель dev-объекта не совпала с бэкапом ${backupPath} — восстановите cleanup-фазой пробы по захваченным ID`);
      exitCode = 1;
    }
    await roGuard.checkFinal("finally");
  }
  }
} finally {
  await client.close();
  try { await closeBrowser(); } catch { /* */ }
}
if (fails.length > 0) console.log("FAILS:", fails.join(" | "));
process.exit(exitCode);
