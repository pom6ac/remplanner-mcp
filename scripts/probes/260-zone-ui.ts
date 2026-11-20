// 260: разведка зонирования потолка кликами в dev-проекте (env). КЛИКИ БЕЗ СОХРАНЕНИЯ:
// инструмент zone_ceiling, концы на рёбрах комнаты; снимок room-данных (delimiters,
// ceilings, zones) и ZONE_DELIMITERS после каждого шага. Откат — перезагрузкой;
// GET-сверка с бэкапом .orca-reports/backup-7887657-260.json (создаётся при отсутствии).
// node scripts/probes/260-zone-ui.ts run
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { loadModel } from "../../src/api.ts";

if (process.argv[2] !== "run") {
  console.error("запуск по явному аргументу run (ID из env)");
  process.exit(0);
}
const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
const READONLY_ID = process.env.REMPLANNER_PROBE_READONLY_ID;
if (!OBJECT_ID || !PLAN_ID || !READONLY_ID) { console.error("нужны REMPLANNER_PROBE_OBJECT_ID, REMPLANNER_PROBE_PLAN_ID, REMPLANNER_PROBE_READONLY_ID"); process.exit(1); }
if (OBJECT_ID === READONLY_ID) { console.error("OBJECT_ID == READONLY_ID — стоп"); process.exit(1); }
mkdirSync(".orca-reports/tmp", { recursive: true });
const OUT = ".orca-reports/tmp";
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 9 * 60_000).unref();

const session = { ...loadSession(STATE_PATH), account: true } as const;

// бэкап до пробы
const beforeModel = await loadModel(session, OBJECT_ID, PLAN_ID);
const backupPath = `.orca-reports/backup-${OBJECT_ID}-260.json`;
if (!existsSync(backupPath)) {
  writeFileSync(backupPath, JSON.stringify(beforeModel, null, 1) + "\n");
  console.log("бэкап:", backupPath);
}
const strip = (m: unknown) => { const c = structuredClone(m as Record<string, unknown>); for (const k of ["save_id", "session", "log_plan", "version"]) delete c[k]; return JSON.stringify(c); };

const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
const page = editor.page;
try {
  // гард: план в редакторе == серверу
  const planInEditor = await page.evaluate(() => String((window as any).project?.copy("server")?.plan_id ?? ""));
  if (planInEditor !== String(beforeModel.plan_id)) {
    console.log("FAIL: план в редакторе", planInEditor, "!= серверу", beforeModel.plan_id); process.exit(1);
  }
  const snapRoom = async (tag: string) => {
    const data = await page.evaluate(() => {
      const w: any = window as any;
      const m: any = w.project.copy("server");
      const res: any = { zone_delimiters_top: m.zone_delimiters ?? null, rooms: {} };
      const zds: any = w.ZONE_DELIMITERS ?? {};
      res.runtime_zone_delimiters = Object.fromEntries(Object.entries<any>(zds).map(([k, v]: any) => [k, v.serialize ? v.serialize() : v]));
      for (const [rid, r] of Object.entries<any>(m.rooms2 ?? {})) {
        res.rooms[rid] = {
          delimiters: r.delimiters ?? null,
          rigels: r.rigels ?? null,
          ceilings_count: (r.ceilings ?? []).length,
          ceilings: (r.ceilings ?? []).map((c: any) => ({ exist: c.exist, material: c.material, level: c.level, poly_n: (c.polygon ?? []).length })),
          zones: (r.zones ?? []).length,
        };
      }
      return res;
    });
    writeFileSync(`${OUT}/260-ui-${tag}.json`, JSON.stringify(data, null, 1) + "\n");
    return data;
  };
  const log = (...a: unknown[]) => console.log(...a);
  const model: any = await page.evaluate(() => (window as any).project.copy("server"));
  const rooms = Object.entries<any>(model.rooms2 ?? {});
  // самая большая комната
  let best: [string, any] = ["", null];
  for (const [rid, r] of rooms) {
    const a = (r as any).area ?? 0;
    if (!best[1] || a > best[1].area) best = [rid, r];
  }
  const [rid, room] = best;
  const poly: Array<{ x: number; y: number }> = room.polygon;
  log("комната:", rid, "poly_n:", poly.length, "area:", room.area);
  // точки кликов: середины двух разных рёбер, сдвинутые внутрь комнаты на 8 см
  const inward = (i: number, d: number) => {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    // нормаль внутрь: против часовой стрелки полигона?
    const nx = (b.y - a.y) / len, ny = -(b.x - a.x) / len;
    // проверим обе стороны: какая ближе к центроиду
    const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length, cy = poly.reduce((s, p) => s + p.y, 0) / poly.length;
    const p1 = { x: mx + nx * d, y: my + ny * d };
    const p2 = { x: mx - nx * d, y: my - ny * d };
    const d1 = Math.hypot(p1.x - cx, p1.y - cy), d2 = Math.hypot(p2.x - cx, p2.y - cy);
    return d1 < d2 ? p1 : p2;
  };
  const ptA = inward(0, 8);
  const ptB = inward(2 % poly.length, 8);

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
  const clickAt = async (p: { x: number; y: number }) => {
    await clearFog();
    const s = await toScreen(p);
    await page.mouse.move(s.x - 6, s.y - 6);
    await page.mouse.move(s.x, s.y, { steps: 6 });
    await page.waitForTimeout(300);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(700);
  };
  const dragAt = async (a: { x: number; y: number }, b: { x: number; y: number }) => {
    await clearFog();
    const s = await toScreen(a), e = await toScreen(b);
    await page.mouse.move(s.x, s.y, { steps: 4 });
    await page.waitForTimeout(200);
    await page.mouse.down();
    await page.mouse.move(e.x, e.y, { steps: 14 });
    await page.waitForTimeout(200);
    await page.mouse.up();
    await page.waitForTimeout(800);
  };
  const pickTool = async (key: string) => {
    const r = await page.evaluate((k) => {
      const el: any = document.querySelector(`#plannertool_${k}`);
      if (!el) return "missing";
      el.click();
      return "ok";
    }, key);
    await page.waitForTimeout(600);
    return r;
  };
  const warnings = () => page.evaluate(() => {
    const out: string[] = [];
    document.querySelectorAll(".planner_ui_message.active").forEach((e) => out.push((e.textContent ?? "").trim().slice(0, 120)));
    const fog: any = document.querySelector("#planner_ui_message_fog");
    if (fog && fog.classList.contains("active") && fog.innerHTML.trim()) out.push("FOG: " + fog.innerHTML.trim().slice(0, 120));
    return out;
  });
  const esc = () => page.keyboard.press("Escape");

  // текущий план: потолочный лист?
  const curPlan = await page.evaluate(() => (window as any).plan);
  log("текущий план:", curPlan);
  await snapRoom("initial");

  log("pick zone_ceiling:", await pickTool("zone_ceiling"));
  // клик 1 — источник
  await clickAt(ptA);
  log("после клика 1, warnings:", JSON.stringify(await warnings()));
  await snapRoom("after-click1");
  // клик 2 — конец линии
  await clickAt(ptB);
  log("после клика 2, warnings:", JSON.stringify(await warnings()));
  await snapRoom("after-click2");
  await esc();

  // второй вариант: drag от ребра к ребру
  log("pick zone_ceiling (drag):", await pickTool("zone_ceiling"));
  const ptC = inward(1 % poly.length, 8);
  await dragAt(ptB, ptC);
  log("после drag, warnings:", JSON.stringify(await warnings()));
  await snapRoom("after-drag");
  await esc();

  // откат без save
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4000);
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
const after = await loadModel(session, OBJECT_ID, PLAN_ID);
const backup = JSON.parse(readFileSync(backupPath, "utf8"));
console.log("GET после пробы == бэкап:", strip(after.model) === strip(backup.model) ? "OK — не изменился" : "РАСХОЖДЕНИЕ");
process.exit(0);
