// 354: живая проверка обшивки ГКЛ (claddings) и замены двери — анонимный проект
// (фаза anon) и dev-объект (фаза dev, ID только из env, гарды probe-guard,
// бэкап до прогона, restore в finally по захваченным site_id).
//   node scripts/probes/354-replan2-live.ts anon
//   REMPLANNER_PROBE_OBJECT_ID=… REMPLANNER_PROBE_PLAN_ID=… \
//   REMPLANNER_PROBE_READONLY_ID=… REMPLANNER_PROBE_READONLY_PLAN_ID=… \
//   node scripts/probes/354-replan2-live.ts dev
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { loadModel, type LoadedModel } from "../../src/api.ts";
import { sig } from "./probe-sig.ts";

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
    if (process.env["RP_DEBUG_MG"]) console.log("model_get walls[0]:", JSON.stringify((wallsC.walls ?? [])[0]));
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
    const cl = await call("cladding_add", { from_mm: { x: 500, y: 500 }, to_mm: { x: 2000, y: 500 } }) as Record<string, unknown>;
    console.log("cladding_add:", JSON.stringify(cl));
    check(String(cl["site_id"] ?? "") !== "", "cladding_add вернул site_id");
    const cross = await tryCall("cladding_add", { from_mm: { x: 1000, y: 200 }, to_mm: { x: 1000, y: 2000 } });
    check(cross !== null && String((cross as { __error?: string })["__error"]).includes("пересекает"), "пересечение другой линии обшивки — INVALID_ARGUMENT");
    const out = await tryCall("cladding_add", { from_mm: { x: -2000, y: -2000 }, to_mm: { x: -1000, y: -2000 } });
    check(out !== null && String((out as { __error?: string })["__error"]).includes("внутри одной комнаты"), "линия вне комнаты — INVALID_ARGUMENT");
    const shortL = await tryCall("cladding_add", { from_mm: { x: 2500, y: 2000 }, to_mm: { x: 2520, y: 2000 } });
    check(shortL !== null && String((shortL as { __error?: string })["__error"]).includes("короче"), "короткая линия (20 мм) — INVALID_ARGUMENT");
    const rooms = (await call("rooms_list", {})) as unknown as Array<{ area_m2?: number }>;
    console.log("rooms:", JSON.stringify(rooms));
    const validate = await call("model_validate", {});
    console.log("validate:", JSON.stringify(validate).slice(0, 300));
    const save1 = await call("project_save", {});
    console.log("save1 verified:", save1["verified"], JSON.stringify(save1["warnings"] ?? []).slice(0, 300));
    check(save1["verified"] === true, "save verified с обшивкой и заменой");
    // настоящий plan_id анонимного проекта-known только workspace (compat): берём из него
    const wsAny = (ctx as unknown as { workspaceOrNull: { project: { planId: string; objectId: string } } | null }).workspaceOrNull;
    const realPlan = wsAny?.project?.planId ?? "1";
    console.log("reopen plan:", realPlan);
    await call("project_open", { object_id: created.object_id, plan_id: realPlan });
    const mg = (await call("model_get", {})) as { claddings?: unknown[] };
    console.log("claddings after reopen:", JSON.stringify(mg["claddings"]));
    check(Array.isArray(mg["claddings"]) && mg["claddings"]!.length === 1, "линия обшивки пережила reopen");
    const save2 = await call("project_save", {});
    check(save2["verified"] === true, "повторный save verified");
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
    // cladding_remove по каждому site_id, opening_delete по каждой паре, wall_delete
    // по своим стенам, save, сверка sig с бэкапом backup-354.json
    const { probeWriteEnv, assertTargetPair, readonlyGuard, readonlyRefPath } = await import("./probe-guard.ts");
    const ids = probeWriteEnv();
    await assertTargetPair(ctx.session(), ids.objectId, ids.planId);
    const roGuard = await readonlyGuard(ctx.session(), ids.readonlyId, ids.readonlyPlanId, readonlyRefPath(ids.readonlyId, ids.readonlyPlanId));
    await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
    const clIds = (process.env["REMPLANNER_PROBE_CLADDING_IDS"] ?? "").split(",").filter(Boolean);
    const openingIds = (process.env["REMPLANNER_PROBE_OPENING_IDS"] ?? "").split(",").filter(Boolean);
    const wallSiteIds = (process.env["REMPLANNER_PROBE_WALL_SITE_IDS"] ?? "").split(",").filter(Boolean);
    for (const cid of clIds) {
      const r = await tryCall("cladding_remove", { cladding_id: cid });
      console.log("cladding_remove", cid, r ? "ok" : "fail");
    }
    for (const oid of openingIds) {
      const r = await tryCall("opening_delete", { opening_id: oid });
      console.log("opening_delete", oid, r ? "ok" : "fail");
    }
    const want = new Set(wallSiteIds);
    for (let guard = 0; guard < 20 && want.size > 0; guard++) {
      const walls = ((await call("model_get", {}))["walls"] ?? []) as Array<{ id: string; site_id: string }>;
      const hit = walls.find((w) => want.has(w.site_id));
      if (!hit) break;
      want.delete(hit.site_id);
      const r = await tryCall("wall_delete", { wall_id: hit.id });
      console.log("wall_delete", hit.site_id, r ? "ok" : "fail");
    }
    const saveR = await call("project_save", {});
    console.log("cleanup save verified:", saveR["verified"]);
    const { loadModel } = await import("../../src/api.ts");
    const after = await loadModel(ctx.session(), ids.objectId, ids.planId);
    const ref = JSON.parse(readFileSync(".orca-reports/backup-354.json", "utf8")) as LoadedModel;
    const same = sig(after.model) === sig(ref.model);
    console.log("sig restored == backup:", same);
    if (!same) exitCode = 1;
    await roGuard.checkFinal("finally");
  } else {
    // dev-фаза: гарды до любой записи (ревью 319 №3/№4)
    const { probeWriteEnv, assertTargetPair, readonlyGuard, readonlyRefPath } = await import("./probe-guard.ts");
    const { probeWriteEnv: envIds } = { probeWriteEnv };
    const ids = envIds();
    await assertTargetPair(ctx.session(), ids.objectId, ids.planId);
    const roGuard = await readonlyGuard(ctx.session(), ids.readonlyId, ids.readonlyPlanId, readonlyRefPath(ids.readonlyId, ids.readonlyPlanId));
    // бэкап ДО прогона
    const before: LoadedModel = await loadModel(ctx.session(), ids.objectId, ids.planId);
    writeFileSync(".orca-reports/backup-354.json", JSON.stringify(before, null, 1) + "\n");
    console.log("backup written, sig:", sig(before.model).slice(0, 40));
    await roGuard.assertUnchanged("before");

    // — открыт ли ожидаемый план в редакторе (совпадение плана редактора и сервера) —
    await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
    const ed = (ctx as unknown as { workspaceOrNull: { editorOrNull: () => { compat?: Record<string, unknown> } | null } | null }).workspaceOrNull?.editorOrNull?.();
    const openedPlan = ed?.compat ? String(ed.compat["plan_id"] ?? "") : undefined;
    console.log("editor plan:", openedPlan, "object:", ed?.compat ? String(ed.compat["object_id"] ?? "") : undefined);
    if (openedPlan !== undefined && openedPlan !== ids.planId) {
      console.error("план в редакторе не совпал с серверным — СТОП");
      process.exit(1);
    }

    try {
    // — пробная комната правее/ниже всей геометрии (ревью 319 №5: bbox по X и Y) —
    const rawWalls = (before.model["walls"] ?? {}) as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>;
    const maxX = Math.max(...Object.values(rawWalls).flatMap((w) => [w.p1.x, w.p2.x]));
    const maxY = Math.max(...Object.values(rawWalls).flatMap((w) => [w.p1.y, w.p2.y]));
    const ox = Math.ceil(maxX) + 300, oy = Math.ceil(maxY) + 300, TW = 300, TH = 240;
    const created: Array<{ kind: string; siteId?: string }> = [];
    type Pt = { x: number; y: number };
    const trialRect: [Pt, Pt][] = [
      [{ x: ox, y: oy }, { x: ox + TW, y: oy }],
      [{ x: ox + TW, y: oy }, { x: ox + TW, y: oy + TH }],
      [{ x: ox + TW, y: oy + TH }, { x: ox, y: oy + TH }],
      [{ x: ox, y: oy + TH }, { x: ox, y: oy }],
    ];
    for (const [s, e] of trialRect) {
      const r = await call("wall_add", { start: { x: Math.round(s.x * 10), y: Math.round(s.y * 10) }, end: { x: Math.round(e.x * 10), y: Math.round(e.y * 10) }, thickness_mm: 100 });
      created.push({ kind: "wall", siteId: (r["entity"] as { site_id?: string })?.site_id });
    }
    await roGuard.assertUnchanged("trial-room");
    await call("project_save", {});

    // дверь + замена — только на СВОЕЙ стене пробной комнаты (метка из model_get по site_id)
    const mgW = (await call("model_get", {})) as unknown as { walls: Array<{ id: string; site_id?: string }> };
    const ownWall = mgW.walls.find((w) => w.site_id === created[0]!.siteId);
    if (!ownWall) { console.error("своя стена пробной комнаты не найдена — СТОП"); process.exit(1); }
    const door = await call("opening_add", { wall_id: ownWall.id, type: "door", center_mm: 1500 }) as { entity?: { id?: string; site_id?: string; width_mm?: number } };
    await call("project_save", {});
    const rep = await call("opening_add", { wall_id: ownWall.id, type: "doorway", replaces: door["entity"]?.id ?? door["entity"]?.site_id }) as { entity?: Record<string, unknown> };
    console.log("replacement:", JSON.stringify(rep.entity));
    check(Number(rep["entity"]?.width_mm) === Number(door["entity"]?.width_mm), "замена наследует ширину двери");

    // обшивка внутри пробной комнаты
    const cl = await call("cladding_add", { from_mm: { x: Math.round((ox + 50) * 10), y: Math.round((oy + 50) * 10) }, to_mm: { x: Math.round((ox + 250) * 10), y: Math.round((oy + 50) * 10) } }) as Record<string, unknown>;
    console.log("cladding_add:", JSON.stringify(cl));
    created.push({ kind: "cladding", siteId: String(cl["site_id"] ?? "") });
    await roGuard.assertUnchanged("cladding");
    const save1 = await call("project_save", {});
    console.log("save verified:", save1["verified"]);
    check(save1["verified"] === true, "save verified (обшивка + замена в dev-объекте)");

    // reopen и сверка
    await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
    const mg = (await call("model_get", {})) as { claddings?: Array<{ site_id?: string }> };
    console.log("claddings after reopen:", JSON.stringify(mg["claddings"]));
    check((mg["claddings"] ?? []).some((c) => c.site_id === cl["site_id"]), "линия обшивки пережила reopen");
    const save2 = await call("project_save", {});
    check(save2["verified"] === true, "повторный save verified");
    try {
      const render = await call("render_plan", { sheet: "create_walls" });
      const bytes = Number((render as { bytes?: number })["bytes"] ?? 0);
      console.log("render bytes:", bytes);
      check(bytes > 10000, "render_plan create_walls отдал PNG");
    } catch (e) {
      console.log("render error:", String((e as Error).message).slice(0, 300));
      check(false, "render_plan create_walls отдал PNG");
    }

    // — restore: обшивка (все куски после реза у проёма), пара замены, стены —
    const mgCl = (await call("model_get", {})) as unknown as { claddings: Array<{ site_id?: string }> };
    for (const c of mgCl.claddings ?? []) {
      if (c.site_id) await tryCall("cladding_remove", { cladding_id: c.site_id });
    }
    await call("cladding_remove", { cladding_id: String(cl["site_id"]) }).catch(() => null);
    await call("opening_delete", { opening_id: String(rep["entity"]?.id ?? rep["entity"]?.site_id ?? "") }).catch(() => null);
    await call("opening_delete", { opening_id: String(door["entity"]?.id ?? door["entity"]?.site_id ?? "") }).catch(() => null);
    const want = new Set(created.filter((c) => c.kind === "wall" && c.siteId).map((c) => c.siteId!));
    for (let guard = 0; guard < 20 && want.size > 0; guard++) {
      const walls = ((await call("model_get", {}))["walls"] ?? []) as Array<{ id: string; site_id: string }>;
      const hit = walls.find((w) => want.has(w.site_id));
      if (!hit) break;
      want.delete(hit.site_id);
      await tryCall("wall_delete", { wall_id: hit.id });
    }
    await roGuard.assertUnchanged("restore");
    const saveR = await call("project_save", {});
    console.log("restore save:", saveR["verified"]);
    } finally {
      const after: LoadedModel = await loadModel(ctx.session(), ids.objectId, ids.planId);
      const ref = JSON.parse(readFileSync(".orca-reports/backup-354.json", "utf8")) as LoadedModel;
      const same = sig(after.model) === sig(ref.model);
      console.log("sig restored == backup:", same);
      if (!same) {
        console.error("модель dev-объекта не совпала с бэкапом — восстановите cleanup-фазой пробы по захваченным ID");
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
