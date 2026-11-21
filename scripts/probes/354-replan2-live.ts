// 354/356: живая проверка замены исходной двери (setReplacement) — анонимный
// проект (фаза anon) и dev-объект (фаза dev, ID только из env, гарды
// probe-guard, бэкап до прогона, restore общим probe-restore по захваченным
// ID, гард «план в редакторе == серверу» FAIL-CLOSED — №6г ревью 355).
// Обшивка ГКЛ убрана из MCP (фикс 356): проб обшивки здесь больше нет.
//   node scripts/probes/354-replan2-live.ts anon
//   REMPLANNER_PROBE_OBJECT_ID=… REMPLANNER_PROBE_PLAN_ID=… \
//   REMPLANNER_PROBE_READONLY_ID=… REMPLANNER_PROBE_READONLY_PLAN_ID=… \
//   node scripts/probes/354-replan2-live.ts dev
//   … те же env + REMPLANNER_PROBE_OPENING_IDS/…_WALL_SITE_IDS из журнала \
//   node scripts/probes/354-replan2-live.ts cleanup
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { loadModel, type LoadedModel } from "../../src/api.ts";
import { sig } from "./probe-sig.ts";
import { restoreByCaptured, logCaptured, type ProbeCreated } from "./probe-restore.ts";

const phase = process.argv[2] ?? "anon";
mkdirSync(".orca-reports/tmp", { recursive: true });
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 14 * 60_000).unref();

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: `354-live-${phase}`, version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);
type TextContent = { content: { type: string; text?: string }[] };
const text = (r: unknown): string => ((r as TextContent).content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  if (process.env["RP_TRACE"]) console.log("CALL", name, JSON.stringify(args).slice(0, 200));
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  if ((res as { isError?: boolean }).isError) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(".orca-reports/tmp/354-last-error.json", text(res));
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

try {
  if (phase === "anon") {
    const created = await call("project_create", { name: "354 anon" }) as { object_id?: string };
    console.log("anon created:", JSON.stringify(created));
    const W = 4000, H = 3000;
    type Pt = { x: number; y: number };
    const rect: [Pt, Pt][] = [
      [{ x: 0, y: 0 }, { x: W, y: 0 }],
      [{ x: W, y: 0 }, { x: W, y: H }],
      [{ x: W, y: H }, { x: 0, y: H }],
      [{ x: 0, y: H }, { x: 0, y: 0 }],
    ];
    for (const [s, e] of rect) await call("wall_add", { start: s, end: e, thickness_mm: 200 });
    await call("project_save", {});
    const wallsC = (await call("model_get", {})) as unknown as { walls: Array<{ id: string; start?: [number, number]; end?: [number, number]; from?: [number, number]; to?: [number, number]; len_mm?: number }> };
    const top = (wallsC.walls ?? []).find((w) => {
      const a = w.start ?? w.from;
      const z = w.end ?? w.to;
      return a && z && a[1] === 0 && z[1] === 0 && Math.abs(z[0] - W) < 5;
    });
    if (!top) { console.error("верхняя стена не найдена в model_get"); process.exit(1); }
    console.log("top wall:", top.id);
    const door = await call("opening_add", { wall_id: top.id, type: "door", center_mm: 2000 }) as { entity?: { id?: string; site_id?: string; width_mm?: number } };
    await call("project_save", {});
    const doorRef = door["entity"]?.id ?? door["entity"]?.site_id;
    const rep = await call("opening_add", { wall_id: top.id, type: "doorway", replaces: doorRef }) as { entity?: Record<string, unknown> };
    console.log("replacement:", JSON.stringify(rep.entity));
    check(Number(rep["entity"]?.width_mm) === Number(door["entity"]?.width_mm), `замена наследует ширину двери (${rep["entity"]?.width_mm})`);
    check((rep["entity"] as { replacement?: unknown })?.replacement === true, "у замены replacement=true (compact)");
    const repSize = await tryCall("opening_add", { wall_id: top.id, type: "doorway", replaces: doorRef, width_mm: 1200 });
    check(repSize !== null && String((repSize as { __error?: string })["__error"]).includes("INVALID_ARGUMENT"), "повторная замена того же проёма — INVALID_ARGUMENT");
    // №7 ревью 355: замена windoor — честный отказ «MCP строже редактора»
    // (setReplacement редактора windoor не запрещает) — на СВОЕЙ второй двери
    const door2 = await call("opening_add", { wall_id: top.id, type: "door", center_mm: 3400 }) as { entity?: { id?: string; site_id?: string } };
    const repWindoor = await tryCall("opening_add", { wall_id: top.id, type: "window_balcony", replaces: door2["entity"]?.id ?? door2["entity"]?.site_id });
    check(repWindoor !== null && String((repWindoor as { __error?: string })["__error"]).includes("MCP строже редактора"), "замена windoor — отказ «MCP строже редактора» (№7 ревью 355)");
    await call("opening_delete", { opening_id: String(door2["entity"]?.id ?? door2["entity"]?.site_id ?? "") });
    const validate = await call("model_validate", {});
    console.log("validate:", JSON.stringify(validate).slice(0, 300));
    const save1 = await call("project_save", {});
    console.log("save1 verified:", save1["verified"], JSON.stringify(save1["warnings"] ?? []).slice(0, 300));
    check(save1["verified"] === true, "save verified с заменой двери");
    // настоящий plan_id анонимного проекта-known только workspace (compat): берём из него
    const wsAny = (ctx as unknown as { workspaceOrNull: { project: { planId: string; objectId: string } } | null }).workspaceOrNull;
    const realPlan = wsAny?.project?.planId ?? "1";
    console.log("reopen plan:", realPlan);
    await call("project_open", { object_id: created.object_id, plan_id: realPlan });
    // гард «план в редакторе == серверу» — fail-closed (№6г ревью 355)
    const { assertEditorPlanMatch } = await import("./probe-guard.ts");
    const ed = (ctx as unknown as { workspaceOrNull: { editorOrNull: () => { compat?: Record<string, unknown>; compatInfo?: () => Promise<{ plan_id?: unknown }> } | null } | null }).workspaceOrNull?.editorOrNull?.() ?? null;
    await assertEditorPlanMatch(ed, String(realPlan));
    const save2 = await call("project_save", {});
    check(save2["verified"] === true, "повторный save verified после reopen");
    try {
      const render = await call("render_plan", { sheet: "create_walls" });
      const bytes = Number((render as { bytes?: number })["bytes"] ?? 0);
      console.log("render bytes:", bytes, "path:", (render as { path?: string })["path"]);
      check(bytes > 10000, "render_plan create_walls отдал PNG");
    } catch (e) {
      console.log("render error:", String((e as Error).message).slice(0, 300));
      check(false, "render_plan create_walls отдал PNG");
    }
  } else if (phase === "cleanup") {
    // восстановление по захваченным ID предыдущего dev-прогона (env командной строки):
    // opening_delete по каждой паре, свои стены — общим probe-restore (deleteWallsBySiteIds),
    // save, сверка sig с бэкапом backup-<OBJECT_ID>-356.json.
    // №6в ревью 355: assertUnchanged контрольного проекта ПЕРЕД записью.
    const { probeWriteEnv, assertTargetPair, readonlyGuard, readonlyRefPath, assertEditorPlanMatch } = await import("./probe-guard.ts");
    const ids = probeWriteEnv();
    await assertTargetPair(ctx.session(), ids.objectId, ids.planId);
    const roGuard = await readonlyGuard(ctx.session(), ids.readonlyId, ids.readonlyPlanId, readonlyRefPath(ids.readonlyId, ids.readonlyPlanId));
    const backupPath = `.orca-reports/backup-${ids.objectId}-356.json`;
    await roGuard.assertUnchanged("cleanup-before");
    await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
    await call("render_plan", {});
    const edC = (ctx as unknown as { workspaceOrNull: { editorOrNull: () => { compat?: Record<string, unknown>; compatInfo?: () => Promise<{ plan_id?: unknown }> } | null } | null }).workspaceOrNull?.editorOrNull?.() ?? null;
    await assertEditorPlanMatch(edC, ids.planId);
    const openingIds = (process.env["REMPLANNER_PROBE_OPENING_IDS"] ?? "").split(",").filter(Boolean);
    const wallSiteIds = (process.env["REMPLANNER_PROBE_WALL_SITE_IDS"] ?? "").split(",").filter(Boolean);
    for (const oid of openingIds) {
      const r = await tryCall("opening_delete", { opening_id: oid });
      console.log("opening_delete", oid, r ? "ok" : "fail");
    }
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
    const after: LoadedModel = await loadModel(ctx.session(), ids.objectId, ids.planId);
    const ref = JSON.parse(readFileSync(backupPath, "utf8")) as LoadedModel;
    const same = sig(after.model) === sig(ref.model);
    console.log("sig restored == backup:", same);
    if (!same) exitCode = 1;
    await roGuard.checkFinal("finally");
  } else {
    // dev-фаза: гарды до любой записи (ревью 319 №3/№4)
    const { probeWriteEnv, assertTargetPair, readonlyGuard, readonlyRefPath, assertEditorPlanMatch } = await import("./probe-guard.ts");
    const ids = probeWriteEnv();
    await assertTargetPair(ctx.session(), ids.objectId, ids.planId);
    const roGuard = await readonlyGuard(ctx.session(), ids.readonlyId, ids.readonlyPlanId, readonlyRefPath(ids.readonlyId, ids.readonlyPlanId));
    // бэкап ДО прогона (задание 356: .orca-reports/backup-<OBJECT_ID>-356.json)
    const backupPath = `.orca-reports/backup-${ids.objectId}-356.json`;
    const before: LoadedModel = await loadModel(ctx.session(), ids.objectId, ids.planId);
    writeFileSync(backupPath, JSON.stringify(before, null, 1) + "\n");
    console.log("backup written:", backupPath, "sig:", sig(before.model).slice(0, 40));
    await roGuard.assertUnchanged("before");

    // — открыт ли ожидаемый план в редакторе — FAIL-CLOSED (№6г ревью 355):
    // редактор создаётся лениво, render_plan запускает его без изменения модели;
    // если план редактора не определён — отказ ДО записи, а не пропуск сверки
    await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
    await call("render_plan", {});
    const ed = (ctx as unknown as { workspaceOrNull: { editorOrNull: () => { compat?: Record<string, unknown>; compatInfo?: () => Promise<{ plan_id?: unknown }> } | null } | null }).workspaceOrNull?.editorOrNull?.() ?? null;
    console.log("editor:", ed ? "создан" : "НЕТ");
    await assertEditorPlanMatch(ed, ids.planId);
    console.log("гард «план в редакторе == серверу» (fail-closed): OK");

    try {
    // — две пробные комнаты правее/ниже всей геометрии (ревью 319 №5: bbox по X и Y):
    // 1) перегородки (kind=partition, план «Перегородки») — только отказ демонтажа
    //    (замена двери на перегородке не проверяется: живой прогон 356 показал, что
    //    редактор падает на Project.draw при save после opening_add на plan:c);
    // 2) исходные стены — сценарий замены исходной двери (задание 356).
    // Захваченные ID пишутся в журнал после КАЖДОЙ партии (343-captured) —
    // падение позже не теряет capture для cleanup-фазы.
    const rawWalls = (before.model["walls"] ?? {}) as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>;
    const maxX = Math.max(...Object.values(rawWalls).flatMap((w) => [w.p1.x, w.p2.x]));
    const maxY = Math.max(...Object.values(rawWalls).flatMap((w) => [w.p1.y, w.p2.y]));
    const ox = Math.ceil(maxX) + 300, oy = Math.ceil(maxY) + 300, TW = 300, TH = 240;
    const ox2 = ox + TW + 300;
    const created: ProbeCreated[] = [];
    type Pt = { x: number; y: number };
    const rect = (x0: number, y0: number): [Pt, Pt][] => [
      [{ x: x0, y: y0 }, { x: x0 + TW, y: y0 }],
      [{ x: x0 + TW, y: y0 }, { x: x0 + TW, y: y0 + TH }],
      [{ x: x0 + TW, y: y0 + TH }, { x: x0, y: y0 + TH }],
      [{ x: x0, y: y0 + TH }, { x: x0, y: y0 }],
    ];
    const mm = (p: Pt): { x: number; y: number } => ({ x: Math.round(p.x * 10), y: Math.round(p.y * 10) });
    // комната 1: перегородки
    for (const [s, e] of rect(ox, oy)) {
      const r = await call("wall_add", { start: mm(s), end: mm(e), thickness_mm: 100, kind: "partition" });
      created.push({ kind: "wall", siteId: (r["entity"] as { site_id?: string })?.site_id });
    }
    logCaptured(".orca-reports/tmp/356-captured.json", created, []);
    await roGuard.assertUnchanged("trial-room");
    await call("project_save", {});

    // — отказ демонтажа перегородки (demolish_partition) — на СВОЕЙ стене —
    const mgW0 = (await call("model_get", {})) as unknown as { walls: Array<{ id: string; site_id?: string }> };
    const ownWall0 = mgW0.walls.find((w) => w.site_id === created[0]!.siteId);
    if (!ownWall0) { console.error("своя стена пробной комнаты не найдена — СТОП"); process.exit(1); }
    const dem = await tryCall("demolish", { target: "wall", id: ownWall0.id });
    check(dem !== null && String((dem as { __error?: string })["__error"]).includes("INVALID_ARGUMENT"), "демонтаж перегородки — INVALID_ARGUMENT (demolish_partition)");

    // комната 2: исходные стены — сценарий замены исходной двери
    for (const [s, e] of rect(ox2, oy)) {
      const r = await call("wall_add", { start: mm(s), end: mm(e), thickness_mm: 100 });
      created.push({ kind: "wall", siteId: (r["entity"] as { site_id?: string })?.site_id });
    }
    logCaptured(".orca-reports/tmp/356-captured.json", created, []);
    await roGuard.assertUnchanged("trial-room-2");
    await call("project_save", {});

    // дверь на СВОЕЙ исходной стене (метка из model_get по site_id)
    const mgW1 = (await call("model_get", {})) as unknown as { walls: Array<{ id: string; site_id?: string }> };
    const ownWall1 = mgW1.walls.find((w) => w.site_id === created[4]!.siteId);
    if (!ownWall1) { console.error("своя исходная стена пробной комнаты 2 не найдена — СТОП"); process.exit(1); }
    const door = await call("opening_add", { wall_id: ownWall1.id, type: "door", center_mm: 1500 }) as { entity?: { id?: string; site_id?: string; width_mm?: number } };
    created.push({ kind: "opening", siteId: door["entity"]?.id ?? door["entity"]?.site_id });
    logCaptured(".orca-reports/tmp/356-captured.json", created, []);
    await roGuard.assertUnchanged("door");
    const save1 = await call("project_save", {});
    console.log("save1 verified:", save1["verified"]);
    check(save1["verified"] === true, "save verified (дверь в dev-объекте)");

    // reopen и замена исходной двери
    await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
    const ed2 = (ctx as unknown as { workspaceOrNull: { editorOrNull: () => { compat?: Record<string, unknown>; compatInfo?: () => Promise<{ plan_id?: unknown }> } | null } | null }).workspaceOrNull?.editorOrNull?.() ?? null;
    await assertEditorPlanMatch(ed2, ids.planId);
    const mgW = (await call("model_get", {})) as unknown as { walls: Array<{ id: string; site_id?: string }> };
    const ownWall = mgW.walls.find((w) => w.site_id === created[4]!.siteId);
    if (!ownWall) { console.error("своя исходная стена пробной комнаты 2 не найдена после reopen — СТОП"); process.exit(1); }
    const doorRef = door["entity"]?.id ?? door["entity"]?.site_id;
    const rep = await call("opening_add", { wall_id: ownWall.id, type: "doorway", replaces: doorRef }) as { entity?: Record<string, unknown> };
    created.push({ kind: "opening", siteId: String(rep["entity"]?.id ?? rep["entity"]?.site_id ?? "") });
    logCaptured(".orca-reports/tmp/356-captured.json", created, []);
    console.log("replacement:", JSON.stringify(rep.entity));
    check(Number(rep["entity"]?.width_mm) === Number(door["entity"]?.width_mm), "замена наследует ширину двери");
    check((rep["entity"] as { replacement?: unknown })?.replacement === true, "у замены replacement=true (compact)");
    await roGuard.assertUnchanged("replacement");
    const save2 = await call("project_save", {});
    console.log("save2 verified:", save2["verified"]);
    check(save2["verified"] === true, "save verified (замена в dev-объекте)");

    // reopen и удаление пары (сначала замена, затем исходный — исходный каскадом
    // удаляет и замену, deleteOpening возвращает все ID)
    await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
    const ed3 = (ctx as unknown as { workspaceOrNull: { editorOrNull: () => { compat?: Record<string, unknown>; compatInfo?: () => Promise<{ plan_id?: unknown }> } | null } | null }).workspaceOrNull?.editorOrNull?.() ?? null;
    await assertEditorPlanMatch(ed3, ids.planId);
    const repId = String(rep["entity"]?.id ?? rep["entity"]?.site_id ?? "");
    const delRep = await call("opening_delete", { opening_id: repId }) as { deleted?: string[] };
    console.log("opening_delete replacement:", JSON.stringify(delRep));
    const delDoor = await call("opening_delete", { opening_id: doorRef ?? "" }) as { deleted?: string[] };
    console.log("opening_delete door:", JSON.stringify(delDoor));
    check(Array.isArray(delDoor["deleted"]) && (delDoor["deleted"] as string[]).length === 1, `удаление исходного вернуло 1 id (замена уже снята): ${JSON.stringify(delDoor["deleted"])}`);
    await roGuard.assertUnchanged("delete-pair");
    const save3 = await call("project_save", {});
    console.log("save3 verified:", save3["verified"]);
    check(save3["verified"] === true, "save verified (пара удалена)");
    try {
      const render = await call("render_plan", { sheet: "create_walls" });
      const bytes = Number((render as { bytes?: number })["bytes"] ?? 0);
      console.log("render bytes:", bytes);
      check(bytes > 10000, "render_plan create_walls отдал PNG");
    } catch (e) {
      console.log("render error:", String((e as Error).message).slice(0, 300));
      check(false, "render_plan create_walls отдал PNG");
    }

    // — restore ТОЛЬКО общим probe-restore по захваченным ID (№6б ревью 355) —
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
    } finally {
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
