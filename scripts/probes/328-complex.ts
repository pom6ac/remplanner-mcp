// 328 (разведка complex_ceiling, БЕЗ записи на сервер): в dev-объекте из env —
// клик paint_ceiling по комнате, затем complex_ceiling, затем ластик; дамп
// записей ceilings после каждого шага (эталон полей двухуровневого потолка).
// Гарды полные (probe-guard), page.save не вызывается.
// node scripts/probes/328-complex.ts run
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
const client = new Client({ name: "328-complex", version: "0.0.0" });
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

const dumpCeilings = (page: import("playwright-core").Page, tag: string, rid: string): Promise<void> =>
  page.evaluate((roomId: string) => {
    const w: any = window as any;
    const room = (w.project?.copy("server")?.rooms2 ?? {})[roomId] ?? {};
    return (room.ceilings ?? []).map((c: any) => ({
      exist: c.exist, complex: c.complex, level: c.level, level2: c.level2,
      material: c.material, material2: c.material2, type: c.type, offset: c.offset,
      radius: c.radius, poly: (c.polygon ?? []).length, anchor: c.anchor,
      type_laying: c.type_laying, area: c.area,
    }));
  }, rid).then((v) => console.log(tag, JSON.stringify(v)));

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
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  await call("render_plan", {});
  await planGuard();
  const page = pageOf();
  if (!page) throw new Error("страница недоступна");

  // лист «Потолки»
  await page.evaluate(() => {
    const el: any = document.querySelector(".groups_navi_item.plan_ceiling");
    if (el) el.click();
  });
  await page.waitForTimeout(2500);

  // комната для пробы: самая большая
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
    return out.sort((x, y) => y.area - x.area);
  });
  const target = rooms[0]!;
  console.log("target room area:", Math.round(target.area * 10) / 10);
  const xs = target.poly.map((p) => p.x), ys = target.poly.map((p) => p.y);
  // внутренняя точка комнаты: сетка по bbox (полигон может быть Г-/П-образным)
  const insidePoint = (poly: Array<{ x: number; y: number }>): { x: number; y: number } => {
    const x0 = Math.min(...poly.map((p) => p.x)), x1 = Math.max(...poly.map((p) => p.x));
    const y0 = Math.min(...poly.map((p) => p.y)), y1 = Math.max(...poly.map((p) => p.y));
    for (let i = 1; i < 24; i++) {
      for (let j = 1; j < 24; j++) {
        const p = { x: x0 + ((x1 - x0) * i) / 24, y: y0 + ((y1 - y0) * j) / 24 };
        let inside = false;
        for (let k = 0, n = poly.length; k < n; k++) {
          const a = poly[k]!, b = poly[(k + 1) % n]!;
          if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
        }
        if (inside) return p;
      }
    }
    return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
  };
  const inner = insidePoint(target.poly);
  const cx = inner.x, cy = inner.y;
  const toScreen = (p: { x: number; y: number }) => page.evaluate((pp) => {
    const svg: any = document.querySelector("#main_svg");
    const r = svg.getBoundingClientRect();
    const q = svg.getAttribute("viewBox").trim().split(/[\s,]+/).map(Number);
    return { x: r.x + ((pp.x - q[0]) * r.width) / q[2], y: r.y + ((pp.y - q[1]) * r.height) / q[3] };
  }, p);

  const clickTool = async (key: string): Promise<string> =>
    page.evaluate((k: string) => {
      const el: any = document.querySelector(`#plannertool_${k}`);
      if (!el) return "missing";
      const group = el.closest(".tools_item, .subtools_item");
      if (el.classList.contains("is_pro") || (group && group.classList.contains("is_pro"))) return "pro";
      const parent: any = el.closest(".subtools");
      if (parent && parent.id) {
        const opener: any = document.querySelector(`[data-target="${parent.id}"]`);
        opener?.click();
      }
      el.click();
      return "ok";
    }, key);

  // 1. покраска потолка
  console.log("paint:", await clickTool("paint_ceiling"));
  let sc = await toScreen({ x: cx, y: cy });
  await page.mouse.move(sc.x, sc.y, { steps: 5 });
  await page.waitForTimeout(400);
  await page.mouse.click(sc.x, sc.y);
  await page.waitForTimeout(1000);
  console.log("state:", await page.evaluate(() => {
    const w: any = window as any;
    return {
      plan: w.plan ?? w.PLAN ?? null,
      tool: w.tool ?? null,
      activeNav: document.querySelector(".groups_navi_item.active")?.className ?? null,
      warning: document.querySelector(".warning, #warning")?.textContent?.slice(0, 200) ?? null,
      overObject: w.customCursor?.overObject ?? null,
    };
  }));
  await dumpCeilings(page, "after paint:", target.id);

  // 2. двухуровневый потолок
  console.log("complex:", await clickTool("complex_ceiling"));
  sc = await toScreen({ x: cx, y: cy });
  await page.mouse.move(sc.x, sc.y, { steps: 5 });
  await page.waitForTimeout(400);
  await page.mouse.click(sc.x, sc.y);
  await page.waitForTimeout(1500);
  await dumpCeilings(page, "after complex:", target.id);
  const complexDump = await page.evaluate((roomId: string) => {
    const w: any = window as any;
    const room = (w.project?.copy("server")?.rooms2 ?? {})[roomId] ?? {};
    return room.ceilings ?? [];
  }, target.id);
  writeFileSync(".orca-reports/tmp/328-complex-etalon.json", JSON.stringify({
    _source: "UI: paint_ceiling + complex_ceiling на листе «Потолки» dev-объекта из env, БЕЗ save; scripts/probes/328-complex.ts",
    ceilings: complexDump,
  }, null, 1) + "\n");

  // 3. ластик по двухуровневому потолку (поведение удаления)
  console.log("eraser:", await clickTool("ceiling_remove"));
  sc = await toScreen({ x: cx, y: cy });
  await page.mouse.move(sc.x, sc.y, { steps: 5 });
  await page.waitForTimeout(400);
  await page.mouse.click(sc.x, sc.y);
  await page.waitForTimeout(1200);
  await dumpCeilings(page, "after eraser:", target.id);
  console.log("DONE");
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
