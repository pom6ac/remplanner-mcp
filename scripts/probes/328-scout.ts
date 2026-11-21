// 328 (разведка, БЕЗ записи на сервер): проём в потолке (ceiling_hole),
// двухуровневый потолок (complex_ceiling), PRO-метки is_pro в разметке.
// Гарды полные (285 №3 + ревью 319 №3/№4), но проба НЕ пишет на сервер и НЕ
// сохраняет страницу (project.save не вызывается): UI-действия меняют только
// состояние страницы, в finally — сверка канона серверной модели с бэкапом и
// closeBrowser. ID — только из env.
// node scripts/probes/328-scout.ts run
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadModel, type LoadedModel } from "../../src/api.ts";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { sig } from "./probe-sig.ts";
import { assertNoReadonlyCollision, assertTargetPair, readonlyGuard, readonlyRefPath, type ReadonlyGuard } from "./probe-guard.ts";

if (process.argv[2] !== "run") { console.error("запуск: run"); process.exit(0); }
const OBJECT_ID = process.env["REMPLANNER_PROBE_OBJECT_ID"];
const PLAN_ID = process.env["REMPLANNER_PROBE_PLAN_ID"];
const READONLY_ID = process.env["REMPLANNER_PROBE_READONLY_ID"];
const READONLY_PLAN_ID = process.env["REMPLANNER_PROBE_READONLY_PLAN_ID"];
if (!OBJECT_ID || !PLAN_ID || !READONLY_ID || !READONLY_PLAN_ID) { console.error("нужны env"); process.exit(1); }
assertNoReadonlyCollision(OBJECT_ID, PLAN_ID, READONLY_ID, READONLY_PLAN_ID);
mkdirSync(".orca-reports/tmp", { recursive: true });
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 12 * 60_000).unref();

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "328-scout", version: "0.0.0" });
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

let roGuard: ReadonlyGuard | null = null;
let before: LoadedModel | null = null;

function pageOf(): import("playwright-core").Page | null {
  const ed = (ctx.workspaceOrNull?.editorOrNull() ?? null) as unknown as { page?: import("playwright-core").Page } | null;
  return ed?.page ?? null;
}

/** Гард «план в редакторе == серверу». */
async function planGuard(): Promise<void> {
  const ed = (ctx.workspaceOrNull?.editorOrNull() ?? null) as unknown as { compatInfo(): Promise<{ plan_id?: unknown }> } | null;
  const compat = ed ? await ed.compatInfo() : null;
  const planInEditor = compat?.plan_id == null ? "" : String(compat.plan_id);
  if (!planInEditor) throw new Error("compat.plan_id пуст — стоп");
  if (planInEditor !== String(PLAN_ID)) throw new Error(`план в редакторе ${planInEditor} != серверу ${PLAN_ID}`);
  console.log("гард «план в редакторе == серверу»: OK");
}

try {
  roGuard = await readonlyGuard(ctx.session(), READONLY_ID, READONLY_PLAN_ID, readonlyRefPath(READONLY_ID, READONLY_PLAN_ID));
  await assertTargetPair(ctx.session(), OBJECT_ID, PLAN_ID);
  before = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const backupPath = `.orca-reports/backup-${OBJECT_ID}-328.json`;
  if (!existsSync(backupPath)) writeFileSync(backupPath, JSON.stringify(before, null, 1) + "\n");
  else {
    const stored = JSON.parse(readFileSync(backupPath, "utf8")) as { model?: Record<string, unknown> };
    if (sig(stored.model as Record<string, unknown>) !== sig(before.model as Record<string, unknown>)) {
      throw new Error("модель на сервере не совпадает с бэкапом — стоп");
    }
  }
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  await call("render_plan", {});
  await planGuard();
  const page = pageOf();
  if (!page) throw new Error("страница недоступна");

  // ---- 1. навигация: список листов, переход на «Потолки» ----
  const nav = await page.evaluate(() => {
    const out: Array<{ cls: string; text: string }> = [];
    for (const el of Array.from(document.querySelectorAll(".groups_navi_item"))) {
      out.push({ cls: String(el.className), text: (el.textContent ?? "").trim().slice(0, 40) });
    }
    return out;
  });
  console.log("NAV:", JSON.stringify(nav));
  // перейти на лист потолков: элемент класса plan_ceiling (или по тексту)
  await page.evaluate(() => {
    const el: any = document.querySelector(".groups_navi_item.plan_ceiling") ??
      Array.from(document.querySelectorAll(".groups_navi_item")).find((e: any) => /ceiling/.test(String(e.className)));
    if (el) el.click();
  });
  await page.waitForTimeout(2500);

  // ---- 2. PRO-метки: все #plannertool_* с классом is_pro ----
  const pro = await page.evaluate(() => {
    const out: string[] = [];
    const plain: string[] = [];
    for (const el of Array.from(document.querySelectorAll("[id^=plannertool_]"))) {
      const key = String(el.id).replace("plannertool_", "");
      if (String(el.className).includes("is_pro")) out.push(key); else plain.push(key);
    }
    return { pro: out.sort(), plain: plain.sort(), total: out.length + plain.length };
  });
  writeFileSync(".orca-reports/tmp/328-pro-tools.json", JSON.stringify(pro, null, 1) + "\n");
  console.log("PRO tools:", pro.pro.length, "из", pro.total, "— записано в .orca-reports/tmp/328-pro-tools.json");

  // ---- 3. поиск кнопок проёма в потолке / двухуровневого ----
  const tools = await page.evaluate(() => {
    const want = ["ceiling_hole", "floor_hole", "complex_ceiling", "ceiling_niche", "ceiling_rigel", "molding", "zone_ceiling"];
    const out: Record<string, { present: boolean; pro: boolean; visible: boolean }> = {};
    for (const k of want) {
      const el: any = document.querySelector(`#plannertool_${k}`);
      out[k] = el ? { present: true, pro: String(el.className).includes("is_pro"), visible: el.offsetParent !== null } : { present: false, pro: false, visible: false };
    }
    // прочие элементы, в тексте/ id которых есть hole
    const holes: string[] = [];
    for (const el of Array.from(document.querySelectorAll("[id*=hole], [id*=Hole]"))) holes.push(String(el.id));
    return { out, holes: holes.slice(0, 40) };
  });
  console.log("TOOLS:", JSON.stringify(tools));

  // ---- 4. UI: проём в потолке — перетащить прямоугольник в комнате, БЕЗ save ----
  // комнаты из состояния страницы
  const rooms = await page.evaluate(() => {
    const w: any = window as any;
    const r2 = w.project?.copy("server")?.rooms2 ?? {};
    const out: Array<{ id: string; poly: Array<{ x: number; y: number }>; area: number }> = [];
    for (const [id, r] of Object.entries(r2 as Record<string, any>)) {
      const poly = r?.polygon ?? [];
      if (poly.length < 3) continue;
      const area = Math.abs(poly.reduce((s: number, p: any, i: number) => {
        const q = poly[(i + 1) % poly.length];
        return s + (p.x * q.y - q.x * p.y);
      }, 0)) / 2 / 10000;
      out.push({ id, poly, area });
    }
    return out;
  });
  console.log("ROOMS:", rooms.length, JSON.stringify(rooms.map((r) => ({ id: r.id.slice(0, 6), area: Math.round(r.area * 10) / 10 }))));
  const toScreen = (p: { x: number; y: number }) => page.evaluate((pp) => {
    const svg: any = document.querySelector("#main_svg");
    const r = svg.getBoundingClientRect();
    const q = svg.getAttribute("viewBox").trim().split(/[\s,]+/).map(Number);
    return { x: r.x + ((pp.x - q[0]) * r.width) / q[2], y: r.y + ((pp.y - q[1]) * r.height) / q[3] };
  }, p);
  // комната: большая, без существующих level_holes рядом; прямоугольник в центре
  const target = rooms.filter((r) => r.area >= 6).sort((x, y) => y.area - x.area)[0];
  if (!target) throw new Error("нет комнаты ≥ 6 м² для пробы");
  const xs = target.poly.map((p) => p.x), ys = target.poly.map((p) => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const half = 30; // 60×60 см в модели (см)
  const holesBefore = await page.evaluate(() => Object.keys((window as any).project?.copy("server")?.level_holes ?? {}));
  // клик по инструменту
  const holeBtn = await page.evaluate(() => {
    const el: any = document.querySelector("#plannertool_ceiling_hole");
    if (el && el.offsetParent !== null) { el.click(); return "plannertool_ceiling_hole"; }
    return null;
  });
  console.log("ceiling_hole кнопка:", holeBtn);
  if (holeBtn) {
    const p1 = await toScreen({ x: cx - half, y: cy - half });
    const p2 = await toScreen({ x: cx + half, y: cy + half });
    await page.mouse.move(p1.x, p1.y, { steps: 5 });
    await page.waitForTimeout(300);
    await page.mouse.down();
    await page.waitForTimeout(200);
    await page.mouse.move(p2.x, p2.y, { steps: 12 });
    await page.waitForTimeout(300);
    await page.mouse.up();
    await page.waitForTimeout(1200);
    const holesAfter = await page.evaluate(() => (window as any).project?.copy("server")?.level_holes ?? {});
    // снять дамп всех level_holes (новый — с type ceiling_hole)
    writeFileSync(".orca-reports/tmp/328-ceilinghole-etalon.json", JSON.stringify({
      _source: "UI drag на листе «Потолки» dev-объекта из env, БЕЗ save; scripts/probes/328-scout.ts; координаты синтетические, id редактора",
      level_holes: holesAfter,
    }, null, 1) + "\n");
    const entries = Object.values(holesAfter as Record<string, any>);
    console.log("level_holes после drag:", entries.length, JSON.stringify(entries.map((h) => ({ type: h.type, plan: h.plan, area: h.area }))));
  }

  // ---- 5. UI: двухуровневый потолок — клик инструментом по комнате, БЕЗ save ----
  const complexBtn = await page.evaluate(() => {
    const el: any = document.querySelector("#plannertool_complex_ceiling");
    if (el && el.offsetParent !== null) { el.click(); return true; }
    return false;
  });
  console.log("complex_ceiling кнопка:", complexBtn);
  if (complexBtn) {
    const sc = await toScreen({ x: cx, y: cy });
    await page.mouse.move(sc.x, sc.y, { steps: 5 });
    await page.waitForTimeout(400);
    await page.mouse.click(sc.x, sc.y);
    await page.waitForTimeout(1200);
    const ceilings = await page.evaluate((rid: string) => {
      const w: any = window as any;
      const room = (w.project?.copy("server")?.rooms2 ?? {})[rid] ?? {};
      return { ceilings: room.ceilings ?? [], rigels: room.rigels ?? {}, zones: room.zones ?? [] };
    }, target.id);
    writeFileSync(".orca-reports/tmp/328-complex-etalon.json", JSON.stringify({
      _source: "UI клик complex_ceiling на листе «Потолки» dev-объекта из env, БЕЗ save; scripts/probes/328-scout.ts",
      ceilings: ceilings.ceilings,
    }, null, 1) + "\n");
    console.log("ceilings после клика:", JSON.stringify(ceilings.ceilings.map((c: any) => ({ exist: c.exist, complex: c.complex, level: c.level, level2: c.level2, material: c.material, material2: c.material2, type: c.type, offset: c.offset, radius: c.radius, poly: (c.polygon ?? []).length }))));
  }

  // ---- 6. defs dump ----
  const defs = await page.evaluate(() => {
    const w: any = window as any;
    return { complex_ceiling: w.defs?.complex_ceiling ?? null, level_hole: w.defs?.level_hole ?? null, floor_hole: w.defs?.floor_hole ?? null };
  });
  writeFileSync(".orca-reports/tmp/328-defs.json", JSON.stringify(defs, null, 1) + "\n");
  console.log("DEFS:", JSON.stringify(defs));

  console.log("DONE-DUMP");
} catch (e) {
  console.error("FAIL:", String((e as Error).message ?? e).slice(0, 1500));
  process.exitCode = 1;
} finally {
  try {
    if (before) {
      const final = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
      const same = sig(final.model) === sig(before.model) && final.save_id === before.save_id;
      console.log("сервер не изменился:", same ? "OK" : "РАСХОЖДЕНИЕ");
      if (!same) process.exitCode = 1;
    }
  } catch (ce) { console.error("final check:", String((ce as Error).message ?? ce).slice(0, 300)); }
  try { await roGuard?.checkFinal("finally"); } catch (ce) { console.error("ro:", String((ce as Error).message ?? ce).slice(0, 200)); }
  await closeBrowser();
}
process.exit(process.exitCode ?? 0);
