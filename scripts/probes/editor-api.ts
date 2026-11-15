// Проба T-topology (этап 10): может ли редактор сам строить топологию стен, если Node задаёт только
// геометрию (оси, толщину), без link. Анонимные проекты, аккаунт не используется.
//
// Запуск (нужен браузер вне песочницы):  node scripts/probes/editor-api.ts [--mouse] [--headed]
// Вывод: JSON-сводка в stdout и файл .orca-reports/10-editor-api-probe.json (вне git).
//
// Сценарий (единицы редактора — см, ось Y вниз). Оси: внешний прямоугольник x∈[0,600], y∈[-300,120];
// коридор — полоса y∈[0,120] (оси), над ним три комнаты с осями перегородок x=300 и x=500.
// Толщина всех стен 20 см. Ожидаемые площади «в чистоте» = (ось − 20 см) по каждому измерению:
//   коридор 580×100 = 5.80 м², комнаты 280×280 = 7.84, 180×280 = 5.04, 80×280 = 2.24 м².
// Набор стен — как нарисовал бы человек: 4 внешние стены углами в узлах (общие оси), стена коридора
// и две перегородки — T-примыкания, концы лежат НА ГРАНИ несущей стены (ось ± depth/2).
//
// Сценарии:
//  A  create:  WALLS[id] = new Wall({...}) (как WallCursor.down) → $Project.draw({rooms:1}) → save → reload.
//  B  restore: project.copy('server') + walls без link и без l1..r2 → $Project.restore(m,{reset:1}) → draw → save → reload.
//  C  негатив: как A, но T-концы на ОСИ несущей стены (не на грани) — что сделает редактор.
//  D  move:    после A сдвинуть стену коридора на +20 см вниз средствами редактора
//              (p1.set/p2.set → calc → rebuildEdgeConnectedWalls/rebuildNodeConnectedWalls → draw).
//  E  split:   после A Wall.split(точка) у верхней внешней стены в x=300 (стык перегородки) → draw.
//  M  мышь (--mouse): тот же план мышью (как probe-two-rooms), сравнение связей и комнат.
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";

const BASE = "https://remplanner.ru";
const headed = process.argv.includes("--headed");
const withMouse = process.argv.includes("--mouse");
const D = 20;

type P = { x: number; y: number };
type Spec = { key: string; p1: P; p2: P };

// Вариант «T-концы на грани»
function wallsOnFace(): Spec[] {
  const h = D / 2;
  return [
    { key: "top", p1: { x: 0, y: -300 }, p2: { x: 600, y: -300 } },
    { key: "right", p1: { x: 600, y: -300 }, p2: { x: 600, y: 120 } },
    { key: "bottom", p1: { x: 600, y: 120 }, p2: { x: 0, y: 120 } },
    { key: "left", p1: { x: 0, y: 120 }, p2: { x: 0, y: -300 } },
    { key: "corridor", p1: { x: 0 + h, y: 0 }, p2: { x: 600 - h, y: 0 } },
    { key: "part1", p1: { x: 300, y: -300 + h }, p2: { x: 300, y: 0 - h } },
    { key: "part2", p1: { x: 500, y: -300 + h }, p2: { x: 500, y: 0 - h } },
  ];
}
// Вариант «T-концы на оси несущей» (негатив)
function wallsOnAxis(): Spec[] {
  return [
    ...wallsOnFace().slice(0, 4),
    { key: "corridor", p1: { x: 0, y: 0 }, p2: { x: 600, y: 0 } },
    { key: "part1", p1: { x: 300, y: -300 }, p2: { x: 300, y: 0 } },
    { key: "part2", p1: { x: 500, y: -300 }, p2: { x: 500, y: 0 } },
  ];
}
const EXPECTED_AREAS = [7.84, 5.8, 5.04, 2.24];

async function launch(): Promise<Browser> {
  const shell = process.env.HOME + "/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell";
  const exe = process.env.RP_BROWSER || (existsSync(shell) ? shell : undefined);
  if (exe && !headed) return chromium.launch({ executablePath: exe, headless: true });
  return chromium.launch({ channel: "chrome", headless: !headed });
}

async function clearFog(page: Page) {
  await page.evaluate(() => {
    const f: any = document.querySelector("#planner_ui_message_fog");
    if (f && f.classList.contains("active") && !f.innerHTML.trim()) f.classList.remove("active");
    document.querySelectorAll(".planner_ui_message.active").forEach((e: any) => e.classList.remove("active"));
  });
}

async function newAnonProject(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: "ru-RU" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("[pageerror]", String(e).slice(0, 300)));
  await page.goto(BASE + "/planner/", { waitUntil: "domcontentloaded" });
  await Promise.all([
    page.waitForNavigation({ timeout: 60000 }).catch(() => null),
    page.evaluate(() => (window as any).planner_create_object()),
  ]);
  await page.waitForFunction(() => (window as any).WALLS && (window as any).$Project && (window as any).project, null, { timeout: 60000 });
  await page.waitForTimeout(2500);
  await clearFog(page);
  return page;
}

/** Снимок топологии из живого редактора: стены, связи, комнаты, счётчики ошибок. */
async function snapshot(page: Page) {
  return page.evaluate(() => {
    const w: any = window as any;
    const r1 = (v: number) => Math.round(v * 100) / 100;
    const walls: any[] = [];
    for (const [id, x] of Object.entries<any>(w.WALLS || {})) {
      if (typeof x !== "object" || !x || !x.p1) continue;
      const lk = (l: any) => (l ? { ct: l.ct, id: l.id, z0: l.z0, z1: l.z1 } : null);
      walls.push({
        id, p1: { x: r1(x.p1.x), y: r1(x.p1.y) }, p2: { x: r1(x.p2.x), y: r1(x.p2.y) }, depth: x.depth,
        link1: lk(x.p1.link), link2: lk(x.p2.link),
        len_l: x.length_l !== undefined ? r1(x.length_l) : null, len_r: x.length_r !== undefined ? r1(x.length_r) : null,
        eds2_l: (x.eds2?.l || []).length, eds2_r: (x.eds2?.r || []).length,
        overWall: typeof x.isOverWall === "function" ? (() => { try { return Boolean(x.isOverWall()); } catch { return "err"; } })() : null,
      });
    }
    const area = (poly: any[]) => {
      let s = 0;
      for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; s += a.x * b.y - b.x * a.y; }
      return Math.round((Math.abs(s) / 2 / 10000) * 10000) / 10000;
    };
    const rooms2 = Object.values<any>(w.ROOMS2 || {}).filter((r) => r && Array.isArray(r.polygon))
      .map((r) => ({ area_field: r.area, area_poly: area(r.polygon), n: r.polygon.length }));
    const rooms1 = Object.values<any>(w.ROOMS1 || {}).filter((r) => r && (r.polygon || r.points))
      .map((r) => ({ area_field: r.area, area_poly: area(r.polygon || r.points) }));
    let errors: any = null;
    try { errors = w.project.copy("server").errors ?? null; } catch { /* нет */ }
    return { walls, rooms1, rooms2, errors };
  });
}

function check(name: string, snap: any, expectWalls: number, expectAreas = EXPECTED_AREAS) {
  const areas = ((snap.rooms1.length ? snap.rooms1 : snap.rooms2) as any[])
    .map((r: any) => r.area_poly).sort((a: number, b: number) => b - a);
  const want = [...expectAreas].sort((a, b) => b - a);
  const areasOk = areas.length === want.length && areas.every((a: number, i: number) => Math.abs(a - want[i]) <= 0.01);
  // дубли: две стены на одной прямой с перекрытием проекций > 1 см
  let dup = 0;
  const ws = snap.walls;
  for (let i = 0; i < ws.length; i++) for (let j = i + 1; j < ws.length; j++) {
    const a = ws[i], b = ws[j];
    const horiz = (w: any) => Math.abs(w.p1.y - w.p2.y) < 0.5, vert = (w: any) => Math.abs(w.p1.x - w.p2.x) < 0.5;
    if (horiz(a) && horiz(b) && Math.abs(a.p1.y - b.p1.y) < 0.5) {
      const ov = Math.min(Math.max(a.p1.x, a.p2.x), Math.max(b.p1.x, b.p2.x)) - Math.max(Math.min(a.p1.x, a.p2.x), Math.min(b.p1.x, b.p2.x));
      if (ov > 1) dup++;
    }
    if (vert(a) && vert(b) && Math.abs(a.p1.x - b.p1.x) < 0.5) {
      const ov = Math.min(Math.max(a.p1.y, a.p2.y), Math.max(b.p1.y, b.p2.y)) - Math.max(Math.min(a.p1.y, a.p2.y), Math.min(b.p1.y, b.p2.y));
      if (ov > 1) dup++;
    }
  }
  const edgeEnds = ws.reduce((n: number, w: any) => n + (w.link1?.ct === "edge" ? 1 : 0) + (w.link2?.ct === "edge" ? 1 : 0), 0);
  const nodeEnds = ws.reduce((n: number, w: any) => n + (w.link1?.ct === "node" ? 1 : 0) + (w.link2?.ct === "node" ? 1 : 0), 0);
  const freeEnds = ws.reduce((n: number, w: any) => n + (w.link1 ? 0 : 1) + (w.link2 ? 0 : 1), 0);
  const res = { name, walls: ws.length, wallsOk: ws.length === expectWalls, rooms: areas, areasOk, dup, edgeEnds, nodeEnds, freeEnds, errors: snap.errors };
  console.log(JSON.stringify(res));
  return res;
}

async function shot(page: Page, name: string) {
  mkdirSync("screenshots", { recursive: true });
  await page.screenshot({ path: `screenshots/t24-${name}.png` });
}

/** Создание стен штатным конструктором, как WallCursor.down, затем draw({rooms:1}). */
async function buildCreate(page: Page, specs: Spec[]) {
  await page.evaluate(({ specs, D }) => {
    const w: any = window as any;
    const ids: Record<string, string> = {};
    for (const s of specs) {
      const id = w.LIB.id();
      ids[s.key] = id;
      // Wall — глобальный лексический класс бандла, на window его нет
      w.WALLS[id] = new Wall({ id, p1: { ...s.p1 }, p2: { ...s.p2 }, depth: D, plan: "a", role: "wall",
        material: w.defs?.wall?.material || "a_block", color: w.defs?.wall?.color || 0 });
    }
    w.__ids = ids;
    w.$Project.draw({ rooms: 1 });
    try { w.project.localSave(); } catch { /* */ }
  }, { specs, D });
  await page.waitForTimeout(1500);
}

/** Голая геометрия через restore — путь текущего адаптера, но без link и граней. */
async function buildRestore(page: Page, specs: Spec[]) {
  return page.evaluate(({ specs, D }) => {
    const w: any = window as any;
    const m = JSON.parse(JSON.stringify(w.project.copy("server")));
    m.walls = {};
    const ids: Record<string, string> = {};
    for (const s of specs) {
      const id = w.LIB.id();
      ids[s.key] = id;
      // простые грани (ось ± depth/2, сторона l — слева по ходу при Y вниз), restore их требует
      const dx = s.p2.x - s.p1.x, dy = s.p2.y - s.p1.y, len = Math.hypot(dx, dy);
      const nx = dy / len, ny = -dx / len, h = D / 2;
      m.walls[id] = { id, plan: "a", role: "wall", depth: D, height: 270, material: "a_block", p1: { ...s.p1 }, p2: { ...s.p2 }, holes: {}, sectors: {},
        l1: { x: s.p1.x + nx * h, y: s.p1.y + ny * h }, l2: { x: s.p2.x + nx * h, y: s.p2.y + ny * h },
        r1: { x: s.p1.x - nx * h, y: s.p1.y - ny * h }, r2: { x: s.p2.x - nx * h, y: s.p2.y - ny * h } };
    }
    w.__ids = ids;
    let err = null;
    try { w.$Project.restore(m, { reset: 1 }); w.$Project.draw({ rooms: 1 }); w.project.localSave(); } catch (e: any) { err = String(e?.stack || e).slice(0, 600); }
    return err;
  }, { specs, D });
}

async function saveAndReload(page: Page) {
  const resp = page.waitForResponse((r) => r.url().includes("/save/"), { timeout: 30000 }).catch(() => null);
  await page.evaluate(() => { const w: any = window as any; try { w.project.localSave(); } catch { /* */ } w.project.save(false, true); });
  const r = await resp;
  let saved: any = null;
  try { saved = r ? JSON.parse(await r.text()) : null; } catch { saved = "non-json"; }
  await page.waitForTimeout(5500); // ≥ 5 с между сохранениями
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (window as any).WALLS && (window as any).$Project, null, { timeout: 60000 });
  await page.waitForTimeout(3000);
  await clearFog(page);
  return { result: saved?.result ?? saved };
}

async function toScreen(page: Page, px: number, py: number) {
  const v = await page.evaluate(() => {
    const svg: any = document.querySelector("#main_svg");
    const r = svg.getBoundingClientRect();
    const p = svg.getAttribute("viewBox").trim().split(/[\s,]+/).map(Number);
    return { rx: r.x, ry: r.y, rw: r.width, rh: r.height, mx: p[0], my: p[1], vw: p[2], vh: p[3] };
  });
  return { x: v.rx + ((px - v.mx) * v.rw) / v.vw, y: v.ry + ((py - v.my) * v.rh) / v.vh };
}

async function drawMouse(page: Page, segs: [P, P][]) {
  for (const [p, q] of segs) {
    await clearFog(page);
    const a = await toScreen(page, p.x, p.y), b = await toScreen(page, q.x, q.y);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(1200);
}

async function main() {
  const out: any = { date: new Date().toISOString(), scenarios: {} };
  const browser = await launch();
  try {
    const ver = async (page: Page) => page.evaluate(() => ({ global_version: (window as any).global_version, hasWall: (() => { try { return typeof Wall; } catch { return "undefined"; } })(), hasLIB: typeof (window as any).LIB?.id }));

    // A + D + E — один проект
    {
      const page = await newAnonProject(browser);
      out.version = await ver(page);
      await buildCreate(page, wallsOnFace());
      const live = await snapshot(page);
      await shot(page, "A-live");
      out.scenarios.A_live = { check: check("A create live", live, 7), snap: live };
      const sv = await saveAndReload(page);
      const after = await snapshot(page);
      await shot(page, "A-reload");
      out.scenarios.A_reload = { save: sv, check: check("A create after reload", after, 7), snap: after };

      // D: сдвиг стены коридора на +20 см (вниз) средствами редактора
      const dErr = await page.evaluate(() => {
        const w: any = window as any;
        const c = Object.values<any>(w.WALLS).find((x: any) => x && x.p1 && Math.abs(x.p1.y - x.p2.y) < 0.5 && Math.abs(x.p1.y) < 0.5);
        if (!c) return "corridor wall not found";
        try {
          c.p1.set({ x: c.p1.x, y: c.p1.y + 20 }); c.p2.set({ x: c.p2.x, y: c.p2.y + 20 });
          c.calc(); c.rebuildNodeConnectedWalls(); c.rebuildEdgeConnectedWalls();
          w.$Project.draw({ rooms: 1 }); w.project.localSave();
        } catch (e: any) { return String(e?.stack || e).slice(0, 600); }
        return null;
      });
      await page.waitForTimeout(1200);
      const dSnap = await snapshot(page);
      await shot(page, "D-move");
      // ожидание: коридор 580×80 = 4.64; комнаты 280×300 = 8.40, 180×300 = 5.40, 80×300 = 2.40
      out.scenarios.D_move = { err: dErr, check: check("D move corridor +20", dSnap, 7, [8.4, 4.64, 5.4, 2.4]), snap: dSnap };

      // E: split верхней стены в x=300 (draw отдельно: исключение в split не должно мешать draw)
      const eErr = await page.evaluate(() => {
        const w: any = window as any;
        const t = Object.values<any>(w.WALLS).find((x: any) => x && x.p1 && Math.abs(x.p1.y + 300) < 0.5 && Math.abs(x.p2.y + 300) < 0.5);
        if (!t) return "top wall not found";
        let err: string | null = null;
        try { t.split({ x: 300, y: -300 }); } catch (e: any) { err = String(e?.stack || e).slice(0, 600); }
        try { w.$Project.draw({ rooms: 1 }); w.project.localSave(); } catch (e: any) { err = String(err || "") + " draw: " + String(e?.stack || e).slice(0, 300); }
        return err;
      });
      await page.waitForTimeout(1200);
      const eSnap = await snapshot(page);
      await shot(page, "E-split");
      out.scenarios.E_split = { err: eErr, check: check("E split top at x=300", eSnap, 8, [8.4, 4.64, 5.4, 2.4]), snap: eSnap };
      await page.context().close();
    }

    // B — restore голой геометрии
    {
      const page = await newAnonProject(browser);
      const err = await buildRestore(page, wallsOnFace());
      await page.waitForTimeout(1500);
      const live = await snapshot(page);
      await shot(page, "B-live");
      out.scenarios.B_live = { err, check: check("B restore live", live, 7), snap: live };
      const sv = await saveAndReload(page);
      const after = await snapshot(page);
      await shot(page, "B-reload");
      out.scenarios.B_reload = { save: sv, check: check("B restore after reload", after, 7), snap: after };
      await page.context().close();
    }

    // C — T-концы на оси (негатив, без сохранения)
    {
      const page = await newAnonProject(browser);
      await buildCreate(page, wallsOnAxis());
      const live = await snapshot(page);
      await shot(page, "C-axis");
      out.scenarios.C_axis = { check: check("C T-ends on axis", live, 7), snap: live };
      await page.context().close();
    }

    // M — мышь
    if (withMouse) {
      const page = await newAnonProject(browser);
      // сдвиг +1 см: move() редактора отбрасывает курсор с SVG-координатой ровно 0
      // (if(this.p0.x && this.p0.y)), поэтому сегменты на мировых осях x=0/y=0 мышью не рисуются
      const segs: [P, P][] = wallsOnFace().map((s) => [{ x: s.p1.x + 1, y: s.p1.y + 1 }, { x: s.p2.x + 1, y: s.p2.y + 1 }]);
      await drawMouse(page, segs);
      const live = await snapshot(page);
      await shot(page, "M-mouse");
      out.scenarios.M_mouse = { check: check("M mouse live", live, 7), snap: live };
      await page.context().close();
    }
  } finally {
    await browser.close();
  }
  mkdirSync(".orca-reports", { recursive: true });
  writeFileSync(".orca-reports/10-editor-api-probe.json", JSON.stringify(out, null, 2));
  console.log("written .orca-reports/10-editor-api-probe.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
