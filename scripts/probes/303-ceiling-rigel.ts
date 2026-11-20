// 303: живая разведка потолочных закладных (ceiling_rigel) и zone_c (этап 303) в
// dev-проекте БЕЗ записи на сервер: создать закладную кликами UI, снять формат
// (rooms2[rid].rigels + runtime CeilingRigel), создать zone_ceiling с концом на грани
// закладной, удалить закладную и посмотреть судьбу разделителя (каскад/перепривязка),
// проверить наличие кнопки зонирования на листе «Перегородки» (zone_c). Локальное
// состояние откатывается перезагрузкой страницы; серверный GET сверяется с бэкапом
// до/после. Гарды (ревью 285 №3): ID только из env, OBJECT_ID != READONLY_ID, план в
// редакторе == серверу, контрольный GET по реальному plan_id (непустой), finally с
// browser.close, восстановление. node scripts/probes/303-ceiling-rigel.ts run
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { loadModel, type LoadedModel } from "../../src/api.ts";

if (process.argv[2] !== "run") { console.error("запуск: run (ID из env)"); process.exit(0); }
const OBJECT_ID = process.env["REMPLANNER_PROBE_OBJECT_ID"];
const PLAN_ID = process.env["REMPLANNER_PROBE_PLAN_ID"];
const READONLY_ID = process.env["REMPLANNER_PROBE_READONLY_ID"];
const READONLY_PLAN_ID = process.env["REMPLANNER_PROBE_READONLY_PLAN_ID"];
if (!OBJECT_ID || !PLAN_ID || !READONLY_ID || !READONLY_PLAN_ID) {
  console.error("нужны REMPLANNER_PROBE_OBJECT_ID/PLAN_ID/READONLY_ID/READONLY_PLAN_ID");
  process.exit(1);
}
if (OBJECT_ID === READONLY_ID) { console.error("OBJECT_ID == READONLY_ID — стоп"); process.exit(1); }
mkdirSync(".orca-reports/tmp", { recursive: true });
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 9 * 60_000).unref();

const session = { ...loadSession(STATE_PATH), account: true } as const;
const strip = (m: unknown) => {
  const c = structuredClone(m as Record<string, unknown>);
  for (const k of ["save_id", "session", "log_plan", "version", "errors", "logs", "final", "drawing", "params"]) delete c[k];
  return JSON.stringify(c);
};
const roSnap = async (tag: string): Promise<LoadedModel> => {
  const m = await loadModel(session, READONLY_ID, READONLY_PLAN_ID);
  if (m.data_empty) throw new Error(`контрольный GET ${tag} пустой (data_empty) — отказ`);
  writeFileSync(`.orca-reports/tmp/303-get-readonly-${tag}.json`, JSON.stringify(m, null, 1));
  return m;
};

const roBefore = await roSnap("before");
const beforeModel = await loadModel(session, OBJECT_ID, PLAN_ID);
const backupPath = `.orca-reports/backup-${OBJECT_ID}-303.json`;
if (!existsSync(backupPath)) {
  writeFileSync(backupPath, JSON.stringify(beforeModel, null, 1) + "\n");
  console.log("бэкап:", backupPath);
} else {
  const stored = JSON.parse(readFileSync(backupPath, "utf8")) as { model?: unknown };
  if (strip(stored.model) !== strip(beforeModel.model)) {
    throw new Error("модель на сервере не совпадает с бэкапом — стоп");
  }
  console.log("бэкап существует; сверка с текущим GET: совпадает");
}

const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
const page = editor.page;
let devUnchanged = false;
try {
  const planInEditor = await page.evaluate(() => String((window as any).project?.copy("server")?.plan_id ?? ""));
  if (planInEditor !== String(beforeModel.plan_id)) {
    throw new Error(`план в редакторе ${planInEditor} != серверу ${beforeModel.plan_id}`);
  }
  const log = (...a: unknown[]) => console.log(...a);
  await page.evaluate(() => {
    const w: any = window as any;
    w.__trace = [];
    const t = (m: string) => w.__trace.push(m);
    if (w.warning?.show) {
      const orig = w.warning.show.bind(w.warning);
      w.warning.show = (ty: string, m: string) => { t(`WARN ${ty}: ${m}`); return orig(ty, m); };
    }
  });
  const clearFog = () => page.evaluate(() => {
    const f: any = document.querySelector("#planner_ui_message_fog");
    if (f && f.classList.contains("active") && !f.innerHTML.trim()) f.classList.remove("active");
    document.querySelectorAll(".planner_ui_message.active").forEach((e: any) => e.classList.remove("active"));
  });
  const toScreen = (p: { x: number; y: number }) => page.evaluate((pp) => {
    const svg: any = document.querySelector("#main_svg");
    const r = svg.getBoundingClientRect();
    const q = svg.getAttribute("viewBox").trim().split(/[\s,]+/).map(Number);
    return { x: r.x + ((pp.x - q[0]) * r.width) / q[2], y: r.y + ((pp.y - q[1]) * r.height) / q[3] };
  }, p);
  const drag = async (a: { x: number; y: number }, b: { x: number; y: number }) => {
    await clearFog();
    const s = await toScreen(a), e = await toScreen(b);
    await page.mouse.move(s.x, s.y, { steps: 5 });
    await page.waitForTimeout(300);
    await page.mouse.down();
    await page.waitForTimeout(200);
    await page.mouse.move(e.x, e.y, { steps: 15 });
    await page.waitForTimeout(300);
    await page.mouse.up();
    await page.waitForTimeout(900);
  };
  const trace = async (tag: string) => {
    const tr: string[] = await page.evaluate(() => (window as any).__trace.splice(0));
    log(tag, JSON.stringify(tr));
  };
  const clickNav = async (planClass: string, toolId: string): Promise<boolean> => {
    await page.evaluate((pc) => {
      const el: any = document.querySelector(`.groups_navi_item.plan_${pc}`) ?? Array.from(document.querySelectorAll(".groups_navi_item")).find((e: any) => String(e.className).includes(`plan_${pc}`));
      if (el) el.click();
    }, planClass);
    await page.waitForTimeout(2000);
    for (let attempt = 0; attempt < 3; attempt++) {
      const okTool = await page.evaluate((tid) => {
        const el: any = document.querySelector(`#${tid}`);
        if (el && (el as any).offsetParent !== null) { el.click(); return true; }
        return false;
      }, toolId);
      if (okTool) {
        await page.waitForTimeout(600);
        return true;
      }
      await page.waitForTimeout(1000);
    }
    const visible = await page.evaluate(() => Array.from(document.querySelectorAll("[id^=plannertool_]")).filter((e: any) => e.offsetParent !== null).map((e: any) => e.id));
    log(`видимые инструменты на листе ${planClass}:`, JSON.stringify(visible));
    return false;
  };
  const results: Record<string, unknown> = {};

  // 0. defs и tool-определение закладной
  results.defs = await page.evaluate(() => {
    const w: any = window as any;
    return { ceiling_rigel: w.defs?.ceiling_rigel ?? null, tool: w.tools?.ceiling_rigel ?? null };
  });

  // выбор комнаты: 4 вершины, без закладных/ригелей внутри, >=2 внешних ребра
  const model0: any = await page.evaluate(() => (window as any).project.copy("server"));
  const isOverPoly = (pt: { x: number; y: number }, poly: Array<{ x: number; y: number }>) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i]!.x, yi = poly[i]!.y, xj = poly[j]!.x, yj = poly[j]!.y;
      if (((yi > pt.y) !== (yj > pt.y)) && (pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  };
  const rooms = Object.entries<any>(model0.rooms2 ?? {});
  type ExtEdge = { p1: { x: number; y: number }; p2: { x: number; y: number }; inPt: { x: number; y: number } };
  let room: { rid: string; poly: Array<{ x: number; y: number }>; edges: Array<{ p1: { x: number; y: number }; p2: { x: number; y: number } }>; external: ExtEdge[] } | null = null;
  for (const [rid, r] of rooms) {
    const poly: Array<{ x: number; y: number }> = r.polygon;
    if (poly.length !== 4) continue;
    if (Object.keys(r.rigels ?? {}).length > 0) continue;
    const inPt = (mx: number, my: number, len: number, ax: number, ay: number, bx: number, by: number) => {
      const nx = (by - ay) / len, ny = -(bx - ax) / len;
      return isOverPoly({ x: mx + nx * 5, y: my + ny * 5 }, poly) ? { x: mx + nx * 5, y: my + ny * 5 } : { x: mx - nx * 5, y: my - ny * 5 };
    };
    const external: ExtEdge[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 200) continue;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      let neighbor = false;
      for (const [, other] of rooms) {
        if (other === r) continue;
        const o = inPt(mx, my, len, a.x, a.y, b.x, b.y);
        if (isOverPoly({ x: 2 * mx - o.x, y: 2 * my - o.y }, (other as any).polygon)) { neighbor = true; break; }
      }
      if (!neighbor) external.push({ p1: a, p2: b, inPt: inPt(mx, my, len, a.x, a.y, b.x, b.y) });
    }
    if (external.length >= 2) { room = { rid, poly, edges: external.map((e) => ({ p1: e.p1, p2: e.p2 })), external }; break; }
  }
  if (!room) throw new Error("нет подходящей комнаты");
  const ext: ExtEdge[] = room.external;
  log("комната:", room.rid, "внешних рёбер:", ext.length);
  const shift = (p: { x: number; y: number }, poly: Array<{ x: number; y: number }>): { x: number; y: number } => {
    const cx = poly.reduce((s, q) => s + q.x, 0) / poly.length, cy = poly.reduce((s, q) => s + q.y, 0) / poly.length;
    const l = Math.hypot(cx - p.x, cy - p.y) || 1;
    return { x: p.x + ((cx - p.x) / l) * 3, y: p.y + ((cy - p.y) / l) * 3 };
  };
  const snap = async (tag: string) => {
    const data = await page.evaluate((rid) => {
      const w: any = window as any;
      const m: any = w.project.copy("server");
      return {
        top_zone_delimiters: m.zone_delimiters ?? {},
        room: m.rooms2?.[rid] ?? null,
        runtimeRoomRigels: Object.fromEntries(Object.entries<any>(w.ROOMS2?.[rid]?.rigels ?? {}).map(([k, v]: any) => [k, v?.serialize ? v.serialize() : "nonclass"])),
        runtimeZonesCount: Object.keys(w.ROOMS2?.[rid]?.zones ?? {}).length,
      };
    }, room!.rid);
    writeFileSync(`.orca-reports/tmp/303-${tag}.json`, JSON.stringify(data, null, 1));
    return data;
  };

  // 1. закладная: drag между серединами противоположных внешних рёбер (лист потолка)
  results.ceilTool = await clickNav("ceiling", "plannertool_ceiling_rigel");
  results.toolAfterSelect = await page.evaluate(() => ({ tool: (window as any).tool, mode: (window as any).CURSOR?.mode ?? null }));
  const midOf = (e: { p1: { x: number; y: number }; p2: { x: number; y: number } }) => ({ x: (e.p1.x + e.p2.x) / 2, y: (e.p1.y + e.p2.y) / 2 });
  const a0 = room!.edges[0]!, a2 = room!.edges[2] ?? room!.edges[1]!;
  const m0 = midOf(a0), m2 = midOf(a2);
  const cxd = room!.poly.reduce((s, q) => s + q.x, 0) / room!.poly.length, cyd = room!.poly.reduce((s, q) => s + q.y, 0) / room!.poly.length;
  const toward = (p: { x: number; y: number }, d: number) => {
    const l = Math.hypot(cxd - p.x, cyd - p.y) || 1;
    return { x: p.x + ((cxd - p.x) / l) * d, y: p.y + ((cyd - p.y) / l) * d };
  };
  await drag(toward(m0, 2), toward(m2, 2));
  await trace("303 rigel create:");
  results.afterCreate = await snap("after-create");

  // 2. zone_ceiling с концом на грани закладной
  const rigelRec = Object.values<any>((results.afterCreate as any)?.room?.rigels ?? {})[0];
  let rigelFace: { x: number; y: number } | null = null;
  if (rigelRec && rigelRec.p1 && rigelRec.p2) {
    const p1 = rigelRec.p1, p2 = rigelRec.p2, wdt = Number(rigelRec.width ?? 10) / 2;
    const len = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
    const nx = -(p2.y - p1.y) / len, ny = (p2.x - p1.x) / len;
    const faces = [
      { p1: { x: p1.x + nx * wdt, y: p1.y + ny * wdt }, p2: { x: p2.x + nx * wdt, y: p2.y + ny * wdt } },
      { p1: { x: p1.x - nx * wdt, y: p1.y - ny * wdt }, p2: { x: p2.x - nx * wdt, y: p2.y - ny * wdt } },
    ];
    const distToSeg = (pt: { x: number; y: number }, s: { p1: { x: number; y: number }; p2: { x: number; y: number } }) => {
      const vx = s.p2.x - s.p1.x, vy = s.p2.y - s.p1.y;
      const l2 = vx * vx + vy * vy;
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((pt.x - s.p1.x) * vx + (pt.y - s.p1.y) * vy) / l2));
      return Math.hypot(pt.x - (s.p1.x + t * vx), pt.y - (s.p1.y + t * vy));
    };
    // грань закладной, БЛИЖАЯ к ребру 3 (ребро поперёк закладной — линия «в торец»)
    const e3 = shift(ext[3] ? ext[3].inPt : ext[1]!.inPt, room!.poly);
    const face = faces.sort((f, g) => distToSeg(e3, f) - distToSeg(e3, g))[0]!;
    rigelFace = { x: (face.p1.x + face.p2.x) / 2, y: (face.p1.y + face.p2.y) / 2 };
  }
  results.ceilZoneTool = await clickNav("ceiling", "plannertool_zone_ceiling");
  if (rigelFace) {
    await drag(shift(ext[3] ? ext[3].inPt : ext[1]!.inPt, room!.poly), rigelFace);
    await trace("303 ceilzone→rigel:");
    results.afterZone = await snap("after-zone");
  } else {
    log("FAIL: закладная не создалась");
  }

  // 3. удалить закладную (как #cm-ceiling-rigel--remove) и посмотреть разделитель
  results.afterDelete = await page.evaluate((rid) => {
    const w: any = window as any;
    const room = w.ROOMS2?.[rid];
    const rg = room?.rigels ? Object.values<any>(room.rigels)[0] : null;
    if (!rg) return { error: "нет закладной в runtime" };
    const before = {
      zones: w.project.copy("server").zone_delimiters ? Object.keys(w.project.copy("server").zone_delimiters).length : 0,
    };
    if (typeof rg.delete === "function") rg.delete();
    if (room) { room.draw?.(); room.restorer?.restoreCeilingsAfterChangeRigel?.(room.serialize?.()); }
    w.$Project.draw({ rooms: 1, save: 1, reset: 0, inWall: 1 });
    const m: any = w.project.copy("server");
    return {
      before,
      roomRigels: m.rooms2?.[rid]?.rigels ?? null,
      zoneDelimiters: m.zone_delimiters ?? null,
      trace: w.__trace.splice(0),
    };
  }, room!.rid);
  await trace("303 rigel delete:");
  results.afterDeleteSnap = await snap("after-delete");

  // 4. zone_c: есть ли кнопка зонирования на листе «Перегородки»
  results.partitionTools = await page.evaluate(() => {
    const el: any = document.querySelector(".groups_navi_item.plan_c") ?? Array.from(document.querySelectorAll(".groups_navi_item")).find((e: any) => String(e.className).includes("plan_c"));
    if (el) el.click();
    return null;
  });
  await page.waitForTimeout(2500);
  results.partitionTools = await page.evaluate(() => Array.from(document.querySelectorAll("[id^=plannertool_]")).filter((e: any) => e.offsetParent !== null).map((e: any) => e.id));
  results.partitionPlan = await page.evaluate(() => (window as any).plan);
  log("лист «Перегородки» инструменты:", JSON.stringify(results.partitionTools), "plan:", results.partitionPlan);

  // откат локального состояния
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4000);
} catch (e) {
  console.error("FAIL:", String((e as Error).message ?? e).slice(0, 900));
  process.exitCode = 1;
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
const after = await loadModel(session, OBJECT_ID, PLAN_ID);
devUnchanged = strip(after.model) === strip(beforeModel.model);
console.log("GET dev после пробы == бэкап:", devUnchanged ? "OK — не изменился" : "РАСХОЖДЕНИЕ");
const roAfter = await roSnap("after");
const roUnchanged = strip(roAfter.model) === strip(roBefore.model) && roAfter.save_id === roBefore.save_id;
console.log("контрольный проект:", roUnchanged ? "не изменился (канон + save_id)" : "ИЗМЕНИЛСЯ — СТОП");
if (!devUnchanged) process.exitCode = 1;
if (!roUnchanged) process.exitCode = 1;
process.exit(process.exitCode ?? 0);
