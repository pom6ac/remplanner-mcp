// 318 (временная разведочная проба — удаляется до коммита): zone_c и имя комнаты.
// 1) пробная комната получает имя (как руками, проба 43) → page save;
// 2) drag plannertool_zone (лист «Перегородки») → зоны комнаты делятся;
// 3) page save → GET: зоны/имя/делитель на сервере;
// 4) MCP project_open (ингест) → model_get;
// 5) MCP project_save → verified? зоны/имя/делитель после save?
// Гарды полные (285 №3): ID из env, OBJECT_ID != READONLY_ID, план в редакторе ==
// серверу (compat), бэкап + семантическая сверка, контрольный GET read-only до/после
// (канон + save_id), restore в finally по захваченным ID, closeBrowser.
// node scripts/probes/318-zonec-name.ts run
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadModel, type LoadedModel } from "../../src/api.ts";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { sig } from "./probe-sig.ts";

if (process.argv[2] !== "run") { console.error("запуск: run"); process.exit(0); }
const OBJECT_ID = process.env["REMPLANNER_PROBE_OBJECT_ID"];
const PLAN_ID = process.env["REMPLANNER_PROBE_PLAN_ID"];
const READONLY_ID = process.env["REMPLANNER_PROBE_READONLY_ID"];
const READONLY_PLAN_ID = process.env["REMPLANNER_PROBE_READONLY_PLAN_ID"];
if (!OBJECT_ID || !PLAN_ID || !READONLY_ID || !READONLY_PLAN_ID) { console.error("нужны env"); process.exit(1); }
if (OBJECT_ID === READONLY_ID) { console.error("OBJECT_ID == READONLY_ID — стоп"); process.exit(1); }
const RO_ID: string = READONLY_ID;
const RO_PLAN_ID: string = READONLY_PLAN_ID;
mkdirSync(".orca-reports/tmp", { recursive: true });
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 14 * 60_000).unref();

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "318-zonec-name", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);
type TextContent = { content: { type: string; text?: string }[] };
const text = (r: unknown): string => {
  const contents = (r as TextContent).content ?? [];
  return contents.map((c) => (c.type === "text" ? c.text : "")).join("");
};
const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  if ((res as { isError?: boolean }).isError) throw new Error(`${name}: ${text(res).slice(0, 900)}`);
  return JSON.parse(text(res)) as Record<string, unknown>;
};

let created: Array<{ kind: string; siteId?: string }> = [];
let opened = false;
let restoredFlag = false;
let before: LoadedModel | null = null;
async function restoreByCaptured(): Promise<void> {
  if (restoredFlag || !opened) return;
  restoredFlag = true;
  const page = (ctx.workspaceOrNull?.editorOrNull() ?? null) as unknown as { page?: import("playwright-core").Page } | null;
  if (page?.page && created.some((c) => c.kind === "delimiter")) {
    await page.page.evaluate((ids: string[]) => {
      const w: any = window as any;
      for (const id of ids) {
        const d: any = w.ZONE_DELIMITERS?.[id];
        if (d) { try { d.deleteFull(); } catch { try { d.delete(); } catch { /* уже нет */ } } }
      }
    }, created.filter((c) => c.kind === "delimiter").map((c) => c.siteId!));
    try { await call("project_save", {}); } catch (e) { console.log("restore save:", String((e as Error).message).slice(0, 200)); }
  }
  const mg2 = await call("model_get", {});
  const walls = (mg2["walls"] ?? []) as Array<{ id: string; site_id: string }>;
  const want = new Set(created.filter((x) => x.kind === "wall" && x.siteId).map((x) => x.siteId!));
  for (let guard = 0; guard < 40 && want.size > 0; guard++) {
    const hit = walls.find((wl) => want.has(wl.site_id));
    if (!hit) break;
    want.delete(hit.site_id);
    try { await call("wall_delete", { wall_id: hit.id }); } catch (e) { console.log(`restore: wall_delete ${hit.id}:`, String((e as Error).message).slice(0, 200)); }
    const fresh = await call("model_get", {});
    const fw = (fresh["walls"] ?? []) as Array<{ id: string; site_id: string }>;
    walls.length = 0;
    walls.push(...fw);
  }
  const saveRes = await call("project_save", {});
  console.log("restore save:", JSON.stringify({ verified: saveRes["verified"] }));
  created = [];
  opened = false;
}

let roBefore: LoadedModel | null = null;
async function checkReadonly(): Promise<void> {
  if (!roBefore) return;
  try {
    const roAfter = await loadModel(ctx.session(), RO_ID, RO_PLAN_ID);
    if (roAfter.data_empty) { console.error("контрольный GET после — пустой (data_empty)"); process.exitCode = 1; return; }
    const ok = sig(roAfter.model) === sig(roBefore.model) && roAfter.save_id === roBefore.save_id;
    console.log("контрольный (finally):", ok ? "не изменился (канон + save_id)" : "ИЗМЕНИЛСЯ — СТОП");
    if (!ok) process.exitCode = 1;
  } catch (e) {
    console.error("контрольный GET после не удался:", String((e as Error).message ?? e).slice(0, 300));
    process.exitCode = 1;
  }
}

try {
  const roBeforeLocal = await loadModel(ctx.session(), READONLY_ID, READONLY_PLAN_ID);
  if (roBeforeLocal.data_empty) throw new Error("контрольный GET пустой — отказ");
  roBefore = roBeforeLocal;
  before = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const backupPath = ".orca-reports/backup-".concat(OBJECT_ID, "-318.json");
  if (!existsSync(backupPath)) writeFileSync(backupPath, JSON.stringify(before, null, 1) + "\n");
  else {
    const stored = JSON.parse(readFileSync(backupPath, "utf8")) as { model?: Record<string, unknown> };
    if (sig(stored.model as Record<string, unknown>) !== sig(before.model as Record<string, unknown>)) {
      throw new Error("модель на сервере не совпадает с бэкапом (семантический канон) — стоп");
    }
  }
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  opened = true;
  await call("render_plan", {});
  const editorGuard = (ctx.workspaceOrNull?.editorOrNull() ?? null) as unknown as { compatInfo(): Promise<{ plan_id?: unknown }> } | null;
  const compat = editorGuard ? await editorGuard.compatInfo() : null;
  const planInEditor = compat?.plan_id == null ? "" : String(compat.plan_id);
  if (!planInEditor) throw new Error("compat.plan_id пуст — стоп");
  if (planInEditor !== String(PLAN_ID)) throw new Error(`план в редакторе ${planInEditor} != серверу ${PLAN_ID}`);
  console.log("гард «план в редакторе == серверу»: OK");

  // пробная комната
  const rawWalls = (before.model["walls"] ?? {}) as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>;
  const maxX = Math.max(...Object.values(rawWalls).filter((w) => w.p1.x < 1400 && w.p2.x < 1400).flatMap((w) => [w.p1.x, w.p2.x]));
  const ox = Math.ceil(maxX) + 300, oy = 0, w = 220, h = 160;
  type Pt = { x: number; y: number };
  for (const [p1, p2] of [
    [{ x: ox, y: oy }, { x: ox + w, y: oy }],
    [{ x: ox + w, y: oy }, { x: ox + w, y: oy + h }],
    [{ x: ox + w, y: oy + h }, { x: ox, y: oy + h }],
    [{ x: ox, y: oy + h }, { x: ox, y: oy }],
  ] as [Pt, Pt][]) {
    const res = await call("wall_add", { start: { x: Math.round(p1.x * 10), y: Math.round(p1.y * 10) }, end: { x: Math.round(p2.x * 10), y: Math.round(p2.y * 10) }, thickness_mm: 100 });
    const sid = (res as { entity?: { site_id?: string } }).entity?.site_id;
    if (!sid) throw new Error("wall_add без site_id");
    created.push({ kind: "wall", siteId: sid });
  }
  await call("project_save", {});
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const afterRoom = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const roomsAfter = (afterRoom.model["rooms2"] ?? {}) as Record<string, { polygon?: Array<{ x: number; y: number }> }>;
  const entry = Object.entries(roomsAfter).find(([, r]) => (r.polygon ?? []).length >= 3 && (r.polygon ?? []).every((q) => q.x >= ox - 1 && q.x <= ox + w + 1));
  if (!entry) throw new Error("пробная комната не появилась");
  const [roomId] = entry;
  const poly = entry[1]!.polygon!;
  console.log("пробная комната:", roomId);

  const ed = (ctx.workspaceOrNull?.editorOrNull() ?? null) as unknown as { page?: import("playwright-core").Page } | null;
  const page = ed?.page;
  if (!page) throw new Error("страница недоступна");

  // 1) имя комнаты как руками (проба 43): ROOMS2[rid].name + zones[0].name/zone_name
  const named = await page.evaluate((rid: string) => {
    const w: any = window as any;
    const r = w.ROOMS2?.[rid];
    if (!r) return { err: "нет ROOMS2[rid]" };
    const z = (r.zones ?? [])[0];
    if (!z) return { err: "нет зоны" };
    r.name = "Пробная";
    z.name = "Пробная";
    z.zone_name = "Пробная";
    try { z.draw?.(); } catch { /* ignore */ }
    w.project.localSave();
    return { ok: true, zones: (r.zones ?? []).map((zz: any) => zz.name) };
  }, roomId);
  console.log("имя задано:", JSON.stringify(named));
  const pageSave1 = await page.evaluate(async () => {
    const w: any = window as any;
    return await Promise.resolve(w.project.save(false, true)).then((r: unknown) => String(r).slice(0, 40)).catch((e: unknown) => `ERR ${String(e).slice(0, 40)}`);
  });
  console.log("page save 1:", JSON.stringify(pageSave1));
  await new Promise((r) => setTimeout(r, 2500));
  const afterName = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const rNamed = ((afterName.model["rooms2"] ?? {}) as Record<string, any>)[roomId];
  console.log("GET после имени:", JSON.stringify({ name: rNamed?.name, zones: (rNamed?.zones ?? []).map((z: any) => z.name) }));

  // 2) MCP project_open: ингест имени в рабочую копию
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const mg = await call("model_get", {});
  const mgRoom = ((mg["rooms2"] ?? {}) as Record<string, any>)[roomId] ?? ((mg["rooms"] ?? []) as unknown[]).find((r: any) => r?.site_id !== undefined);
  console.log("model_get после open: name зоны комнаты:", JSON.stringify((mgRoom?.zones ?? mgRoom?.zone_names ?? null)));

  // 3) UI drag zone_c
  await page.evaluate(() => {
    const el: any = document.querySelector(".groups_navi_item.plan_create_walls") ??
      Array.from(document.querySelectorAll(".groups_navi_item")).find((e: any) => String(e.className).includes("plan_c") || String(e.className).includes("partition"));
    if (el) el.click();
  });
  await page.waitForTimeout(2500);
  const zoneBtn = await page.evaluate(() => {
    const el: any = document.querySelector("#plannertool_zone");
    if (el && el.offsetParent !== null) { el.click(); return true; }
    return false;
  });
  if (!zoneBtn) throw new Error("plannertool_zone не найден");
  const toScreen = (p: { x: number; y: number }) => page.evaluate((pp) => {
    const svg: any = document.querySelector("#main_svg");
    const r = svg.getBoundingClientRect();
    const q = svg.getAttribute("viewBox").trim().split(/[\s,]+/).map(Number);
    return { x: r.x + ((pp.x - q[0]) * r.width) / q[2], y: r.y + ((pp.y - q[1]) * r.height) / q[3] };
  }, p);
  const a = { x: poly[3]!.x + 3, y: (poly[3]!.y + poly[2]!.y) / 2 };
  const bpt = { x: poly[0]!.x - 3, y: (poly[0]!.y + poly[1]!.y) / 2 };
  const sa = await toScreen(a), sb = await toScreen(bpt);
  await page.mouse.move(sa.x, sa.y, { steps: 5 });
  await page.waitForTimeout(300);
  await page.mouse.down();
  await page.waitForTimeout(200);
  await page.mouse.move(sb.x, sb.y, { steps: 15 });
  await page.waitForTimeout(300);
  await page.mouse.up();
  await page.waitForTimeout(1200);
  const dump = await page.evaluate((rid: string) => {
    const w: any = window as any;
    const m: any = w.project.copy("server");
    const r = m.rooms2?.[rid] ?? {};
    const delims = Object.fromEntries(Object.entries<any>(m.zone_delimiters ?? {}).map(([k, v]: any) => [k, v]));
    return {
      zoneDelimiters: delims,
      roomName: r.name,
      zones: (r.zones ?? []).map((z: any) => ({ name: z.name ?? null, zone_name: z.zone_name ?? null, micro: Boolean(z.is_micro_zone), exist: Boolean(z.exist) })),
    };
  }, roomId);
  // захват id делителя для restore — из дампа
  const delimIds = Object.keys(dump.zoneDelimiters ?? {});
  for (const id of delimIds) created.push({ kind: "delimiter", siteId: id });
  console.log("после drag:", JSON.stringify({ roomName: dump.roomName, zones: dump.zones, nDelims: delimIds.length }));
  writeFileSync(".orca-reports/tmp/318-zonec-named-etalon.json", JSON.stringify(dump, null, 1));

  // 4) page save → GET
  const pageSave2 = await page.evaluate(async () => {
    const w: any = window as any;
    return await Promise.resolve(w.project.save(false, true)).then((r: unknown) => String(r).slice(0, 40)).catch((e: unknown) => `ERR ${String(e).slice(0, 40)}`);
  });
  console.log("page save 2:", JSON.stringify(pageSave2));
  await new Promise((r) => setTimeout(r, 2500));
  const afterDrag = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const rDrag = ((afterDrag.model["rooms2"] ?? {}) as Record<string, any>)[roomId];
  console.log("GET после drag+page.save:", JSON.stringify({
    zoneDelims: Object.keys((afterDrag.model["zone_delimiters"] ?? {}) as Record<string, unknown>).length,
    roomName: rDrag?.name,
    zones: (rDrag?.zones ?? []).map((z: any) => ({ name: z.name ?? null, zone_name: z.zone_name ?? null, micro: Boolean(z.is_micro_zone) })),
  }));

  // 5) MCP project_open (ингест делителя и зон) → project_save
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const mg2 = await call("model_get", {});
  console.log("model_get после reopen: zone_delimiters:", JSON.stringify((mg2["zone_delimiters"] ?? null))?.slice(0, 200));
  const wsModel = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const rWs = ((wsModel.model["rooms2"] ?? {}) as Record<string, any>)[roomId];
  console.log("workspace (GET): zone_delimiters:", Object.keys((wsModel.model["zone_delimiters"] ?? {}) as Record<string, unknown>).length,
    "zones:", JSON.stringify((rWs?.zones ?? []).map((z: any) => z.name)));
  const saveRes = await call("project_save", {});
  console.log("MCP save:", JSON.stringify({ verified: saveRes["verified"], warnings: saveRes["warnings"] }));
  const afterMcp = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const rMcp = ((afterMcp.model["rooms2"] ?? {}) as Record<string, any>)[roomId];
  console.log("GET после MCP save:", JSON.stringify({
    zoneDelims: Object.keys((afterMcp.model["zone_delimiters"] ?? {}) as Record<string, unknown>).length,
    roomName: rMcp?.name,
    zones: (rMcp?.zones ?? []).map((z: any) => ({ name: z.name ?? null, zone_name: z.zone_name ?? null, micro: Boolean(z.is_micro_zone) })),
  }));

  await restoreByCaptured();
  const final = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const same = sig(final.model) === sig(before!.model);
  console.log("семантическая сверка с бэкапом:", same ? "OK" : "РАСХОЖДЕНИЕ — требуется разбор");
  if (!same) {
    process.exitCode = 1;
    throw new Error("модель после restore не совпала с бэкапом");
  }
} catch (e) {
  console.error("FAIL:", String((e as Error).message ?? e).slice(0, 1500));
  process.exitCode = 1;
} finally {
  try { await restoreByCaptured(); } catch (ce) { console.error("RESTORE FAIL:", String((ce as Error).message ?? ce).slice(0, 400)); process.exitCode = 1; }
  await checkReadonly();
  await closeBrowser();
}
process.exit(process.exitCode ?? 0);
