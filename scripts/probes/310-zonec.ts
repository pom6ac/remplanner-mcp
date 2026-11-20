// 310 (б, разведка zone_c): живой эталон делителя зон листа «Перегородки» —
// кнопка plannertool_zone, drag между рёбрами пробной комнаты, формат записи
// (type/plan), поведение комнат (zones), save verified, очистка по захваченным
// site_id. Гарды полные (285 №3). node scripts/probes/310-zonec-ui.ts run
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadModel, type LoadedModel } from "../../src/api.ts";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";

if (process.argv[2] !== "run") { console.error("запуск: run"); process.exit(0); }
const OBJECT_ID = process.env["REMPLANNER_PROBE_OBJECT_ID"];
const PLAN_ID = process.env["REMPLANNER_PROBE_PLAN_ID"];
const READONLY_ID = process.env["REMPLANNER_PROBE_READONLY_ID"];
const READONLY_PLAN_ID = process.env["REMPLANNER_PROBE_READONLY_PLAN_ID"];
if (!OBJECT_ID || !PLAN_ID || !READONLY_ID || !READONLY_PLAN_ID) { console.error("нужны env"); process.exit(1); }
if (OBJECT_ID === READONLY_ID) { console.error("OBJECT_ID == READONLY_ID — стоп"); process.exit(1); }
mkdirSync(".orca-reports/tmp", { recursive: true });
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 14 * 60_000).unref();

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "310-zonec", version: "0.0.0" });
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
  // делитель zone_c инструментом MCP не удаляется — ластиком на странице
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

const raw = (x: unknown): string => {
  const c = structuredClone(x as Record<string, unknown>);
  for (const k of ["errors", "logs", "log_plan", "session", "version", "drawing", "params", "final", "signals", "smeta_water_pipes", "save_id", "is_forced"]) delete c[k];
  return JSON.stringify(c);
};
/** Канонические оси стен (переносы/разрезы редактора не считаются изменением). */
const wallAxes = (m: Record<string, unknown> | undefined): string => {
  const walls = (m?.["walls"] ?? {}) as Record<string, { p1?: { x: number; y: number }; p2?: { x: number; y: number }; depth?: number; role?: string }>;
  return JSON.stringify(Object.values(walls)
    .filter((w) => w.p1 && w.p2)
    .map((w) => ({ x1: Math.round(w.p1!.x * 2) / 2, y1: Math.round(w.p1!.y * 2) / 2, x2: Math.round(w.p2!.x * 2) / 2, y2: Math.round(w.p2!.y * 2) / 2, d: w.depth ?? null, role: w.role ?? null }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
};
const itemsSig = (m: Record<string, unknown> | undefined): string => {
  const items = (m?.["items"] ?? {}) as Record<string, { name?: string; pc?: { x: number; y: number } }>;
  return JSON.stringify(Object.values(items).map((i) => ({ n: i.name ?? "", x: Math.round(i.pc?.x ?? 0), y: Math.round(i.pc?.y ?? 0) })).sort());
};

try {
  const roBefore = await loadModel(ctx.session(), READONLY_ID, READONLY_PLAN_ID);
  if (roBefore.data_empty) throw new Error("контрольный GET пустой — отказ");
  writeFileSync(".orca-reports/tmp/310-get-readonly-before.json", JSON.stringify(roBefore, null, 1));
  before = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const backupPath = ".orca-reports/backup-".concat(OBJECT_ID, "-310.json");
  if (!existsSync(backupPath)) writeFileSync(backupPath, JSON.stringify(before, null, 1) + "\n");
  else {
    const stored = JSON.parse(readFileSync(backupPath, "utf8")) as { model?: Record<string, unknown> };
    const bm = stored.model as Record<string, unknown> | undefined;
    // производные поля комнат редактор перестраивает при каждом save (этап 310):
    // сверяем оси стен и предметы, производные комнат — не стоп
    if (wallAxes(bm) !== wallAxes(before.model as Record<string, unknown>) || itemsSig(bm) !== itemsSig(before.model as Record<string, unknown>)) {
      throw new Error("модель на сервере не совпадает с бэкапом (оси стен/предметы) — стоп");
    }
  }
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  opened = true;

  // пробная комната (как в m11-цикле)
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

  // UI: лист «Перегородки» → plannertool_zone → drag между рёбрами
  const ed = (ctx.workspaceOrNull?.editorOrNull() ?? null) as unknown as { page?: import("playwright-core").Page } | null;
  const page = ed?.page;
  if (!page) throw new Error("страница недоступна");
  const nav = await page.evaluate(() => Array.from(document.querySelectorAll(".groups_navi_item")).map((e: any) => ({ cls: e.className, id: e.id })).slice(0, 30));
  console.log("nav:", JSON.stringify(nav));
  await page.evaluate(() => {
    const el: any = document.querySelector(".groups_navi_item.plan_c") ??
      Array.from(document.querySelectorAll(".groups_navi_item")).find((e: any) => String(e.className).includes("plan_c") || String(e.className).includes("partition"));
    if (el) el.click();
  });
  await page.waitForTimeout(2500);
  const tools = await page.evaluate(() => Array.from(document.querySelectorAll("[id^=plannertool_]")).filter((e: any) => e.offsetParent !== null).map((e: any) => e.id));
  console.log("видимые инструменты листа:", JSON.stringify(tools));
  const zoneBtn = await page.evaluate(() => {
    const el: any = document.querySelector("#plannertool_zone");
    if (el && el.offsetParent !== null) { el.click(); return true; }
    return false;
  });
  console.log("кнопка plannertool_zone:", zoneBtn);
  if (zoneBtn) {
    // drag от середины левого ребра к середине правого (магнит подберёт рёбра)
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
    const dump = await page.evaluate((rid) => {
      const w: any = window as any;
      const m: any = w.project.copy("server");
      return {
        zoneDelimiters: Object.fromEntries(Object.entries<any>(w.ZONE_DELIMITERS ?? {}).map(([k, v]: any) => [k, v.serialize ? v.serialize() : v])),
        top: m.zone_delimiters ?? null,
        trialZones: m.rooms2?.[rid]?.zones?.map((z: any) => ({ name: z.name ?? null, micro: Boolean(z.is_micro_zone), n: (z.polygon ?? []).length })),
        trialRigels: Object.keys(m.rooms2?.[rid]?.rigels ?? {}).length,
        warnings: (w.__trace ?? []).slice(-5),
      };
    }, roomId);
    writeFileSync(".orca-reports/tmp/310-zonec-etalon.json", JSON.stringify(dump, null, 1));
    console.log("эталон zone_c записан; верхнеуровневых записей:", Object.keys(dump.top ?? {}).length);
    console.log("zones пробной комнаты:", JSON.stringify(dump.trialZones));
    const rec = Object.values<any>(dump.top ?? {})[0];
    if (rec) console.log("запись zone_c:", JSON.stringify(rec).slice(0, 400));
    // чистое сохранение страницей (без MCP-пайплайна): переживает ли zone_c save редактора
    const pageSave = await page.evaluate(async () => {
      const w: any = window as any;
      const ret = await Promise.resolve(w.project.save(false, true)).then((r: unknown) => String(r).slice(0, 60)).catch((e: unknown) => `ERR ${String(e).slice(0, 60)}`);
      const after = w.project.copy("server").zone_delimiters ?? {};
      return { save: ret, liveAfterSave: Object.keys(after).length };
    });
    console.log("page save:", JSON.stringify(pageSave));
    await new Promise((r) => setTimeout(r, 2500));
    const afterPageSave = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
    console.log("GET после page.save: zone_delimiters:", Object.keys((afterPageSave.model["zone_delimiters"] ?? {}) as Record<string, unknown>).length);
    // MCP save (гарды активны)
    const saveRes = await call("project_save", {});
    console.log("save zone_c:", JSON.stringify({ verified: saveRes["verified"], rounds: saveRes["rounds"], warnings: saveRes["warnings"] }));
    if (!saveRes["verified"]) throw new Error("save zone_c не verified");
    const afterSaveGet = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
    console.log("GET сразу после save: zone_delimiters:", Object.keys((afterSaveGet.model["zone_delimiters"] ?? {}) as Record<string, unknown>).length);
    await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
    const after = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
    const zds = Object.values((after.model["zone_delimiters"] ?? {}) as Record<string, Record<string, unknown>>);
    console.log("после reopen: записей zone_delimiters:", zds.length, JSON.stringify(zds[0]?.["plan"]), JSON.stringify(zds[0]?.["type"]));
    writeFileSync(".orca-reports/tmp/310-zonec-server.json", JSON.stringify(zds, null, 1));
  } else {
    console.log("zone_c: кнопку plannertool_zone поставить вживую не удалось — доказательство в дампах инструментов листа");
  }

  await restoreByCaptured();
  const final = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const same = wallAxes(final.model as Record<string, unknown>) === wallAxes(before.model as Record<string, unknown>) && itemsSig(final.model as Record<string, unknown>) === itemsSig(before.model as Record<string, unknown>);
  console.log("сверка с бэкапом (оси стен/предметы):", same ? "OK" : "РАСХОЖДЕНИЕ — требуется разбор");
  const roAfter = await loadModel(ctx.session(), READONLY_ID, READONLY_PLAN_ID);
  console.log("контрольный:", raw(roAfter.model) === raw(roBefore.model) && roAfter.save_id === roBefore.save_id ? "не изменился" : "ИЗМЕНИЛСЯ");
} catch (e) {
  console.error("FAIL:", String((e as Error).message ?? e).slice(0, 1500));
  process.exitCode = 1;
} finally {
  try { await restoreByCaptured(); } catch (ce) { console.error("RESTORE FAIL:", String((ce as Error).message ?? ce).slice(0, 400)); process.exitCode = 1; }
  await closeBrowser();
}
process.exit(process.exitCode ?? 0);
