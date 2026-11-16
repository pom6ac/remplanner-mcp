// 47-rigels: съём эталонов «Потолочный ригель» из UI проекта <REMPLANNER_PROBE_OBJECT_ID> (аккаунт).
// КЛИКИ ТОЛЬКО ЛОКАЛЬНО: project.save не вызывается, на сервер ничего не пишется.
// Варианты: free (свободно), wall (вдоль стены), between (между двумя стенами), pillar (к краю колонны).
// Вывод: .orca-reports/47-rigels-ui/<вариант>.json, скриншоты screenshots/47-rigel-*.png
import { mkdirSync, writeFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { clearFog, clickAt, dragAt, escape, pickTool, switchSheet, copyServer, diffModels, type P } from "./phase2-lib.ts";

const OUT = ".orca-reports/47-rigels-ui";
const SHOTS = "../../screenshots";

function arg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
}

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

function dumpMenus(page: Page): Promise<Record<string, unknown>[]> {
  return page.evaluate(() => {
    const out: Record<string, unknown>[] = [];
    for (const el of Array.from(document.querySelectorAll("[id^='cm-']")) as HTMLElement[]) {
      if (!el.offsetParent && (el as HTMLInputElement).type !== "hidden") continue;
      const tag = el.tagName.toLowerCase();
      const rec: Record<string, unknown> = { id: el.id, tag, value: (el as HTMLInputElement).value ?? el.textContent?.trim() };
      if (tag === "select") rec.options = Array.from((el as HTMLSelectElement).options).map((o) => ({ v: o.value, t: o.textContent?.trim() }));
      out.push(rec);
    }
    return out;
  });
}

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) {
  console.error("Задайте REMPLANNER_PROBE_OBJECT_ID и REMPLANNER_PROBE_PLAN_ID.");
  process.exit(1);
}

const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
mkdirSync(OUT, { recursive: true });
try {
  const page = editor.page;
  await switchSheet(page, "init");

  // геометрия плана: комнаты, стены, колонны
  const geo = await page.evaluate(() => {
    const m = (window as any).project.copy("server");
    const walls = Object.values<any>(m.walls ?? {});
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const w of walls) {
      minX = Math.min(minX, w.p1.x, w.p2.x); maxX = Math.max(maxX, w.p1.x, w.p2.x);
      minY = Math.min(minY, w.p1.y, w.p2.y); maxY = Math.max(maxY, w.p1.y, w.p2.y);
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const distSeg = (p: P, a: P, b: P) => {
      const dx = b.x - a.x, dy = b.y - a.y; const l2 = dx * dx + dy * dy;
      let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
    };
    const pillars = Object.values<any>(m.pillars ?? {}).map((p) => ({ id: p.id, pc: p.pc, w: p.width, h: p.height }));
    const distPillarEdges = (p: P) => Math.min(...pillars.map((pi) => {
      // расстояние до границы прямоугольника колонны (центр в pc)
      const dx = Math.abs(p.x - pi.pc.x) - pi.w / 2;
      const dy = Math.abs(p.y - pi.pc.y) - pi.h / 2;
      return Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
    }));
    // свободная точка: вдали от стен (>80) и граней колонн (>80) — свободный ригель не прилипает
    let free: P | null = null;
    outer: for (let r = 0; r <= 600; r += 25) {
      for (let ang = 0; ang < 360; ang += 10) {
        const p = { x: cx + r * Math.cos(ang * Math.PI / 180), y: cy + r * Math.sin(ang * Math.PI / 180) };
        if (!walls.every((w) => distSeg(p, w.p1, w.p2) > 80)) continue;
        if (distPillarEdges(p) <= 80) continue;
        free = p; break outer;
      }
    }
    // точка на грани колонны (магнит как в dbg-пробе): край колонны + 1 см
    let pillarPt: P | null = null;
    if (pillars[0]) {
      const pi = pillars[0]!;
      pillarPt = { x: pi.pc.x, y: pi.pc.y - pi.h / 2 };
    }
    // длинная стена без проёмов: две точки на оси
    const wallList = walls
      .map((w) => ({ id: w.id, p1: w.p1, p2: w.p2, len: Math.hypot(w.p2.x - w.p1.x, w.p2.y - w.p1.y), holes: Object.values<any>(w.holes ?? {}), depth: w.depth }))
      .filter((w) => w.len >= 200 && w.holes.length === 0);
    wallList.sort((a, b) => b.len - a.len);
    const wall = wallList[0] ?? null;
    let wallA: P | null = null, wallB: P | null = null;
    if (wall) {
      const dx = (wall.p2.x - wall.p1.x) / wall.len, dy = (wall.p2.y - wall.p1.y) / wall.len;
      wallA = { x: wall.p1.x + dx * (wall.len * 0.3), y: wall.p1.y + dy * (wall.len * 0.3) };
      wallB = { x: wall.p1.x + dx * (wall.len * 0.7), y: wall.p1.y + dy * (wall.len * 0.7) };
    }
    // между стенами: две параллельные стены (расстояние 150..400), точки на внутренних гранях
    let between: { a: P; b: P } | null = null;
    for (const w1 of wallList) {
      const dx = (w1.p2.x - w1.p1.x) / w1.len, dy = (w1.p2.y - w1.p1.y) / w1.len;
      const mid = { x: (w1.p1.x + w1.p2.x) / 2, y: (w1.p1.y + w1.p2.y) / 2 };
      for (const w2 of wallList) {
        if (w2.id === w1.id) continue;
        const d = distSeg(mid, w2.p1, w2.p2);
        if (d < 150 || d > 450) continue;
        // направление от mid к ближайшей точке w2
        const dirx = dx, diry = dy;
        const t = ((w2.p1.x - mid.x) * dirx + (w2.p1.y - mid.y) * diry);
        const sgn = Math.sign(t) || 1;
        // точки на гранях: смещение внутрь от оси на depth/2
        between = {
          a: { x: mid.x + dx * (w1.depth / 2) * sgn, y: mid.y + dy * (w1.depth / 2) * sgn },
          b: { x: mid.x + dirx * d * sgn - dx * (w2.depth / 2) * sgn, y: mid.y + diry * d * sgn - dy * (w2.depth / 2) * sgn },
        };
        break;
      }
      if (between) break;
    }
    return { free, pillarPt, wall, wallA, wallB, between, rigelsBefore: m.rigels ?? {} };
  });
  writeFileSync(`${OUT}/geo.json`, JSON.stringify(geo, null, 1) + "\n");
  console.log("geo:", JSON.stringify(geo));

  // источник класса Rigel для требований restore
  const rigelClass = await page.evaluate(() => {
    const w = window as any;
    const first = Object.values<any>(w.RIGELS ?? {})[0];
    let src: string | null = null;
    if (first) {
      const proto = Object.getPrototypeOf(first);
      src = (proto.constructor?.toString() ?? "").slice(0, 6000);
    }
    return { count: Object.keys(w.RIGELS ?? {}).length, class_src: src, defs: w.defs?.rigel ?? null };
  });
  writeFileSync(`${OUT}/class.json`, JSON.stringify(rigelClass, null, 1) + "\n");

  const st = await pickTool(page, "rigel");
  console.log("pickTool:", st);
  if (st !== "ok") throw new Error(`pickTool: ${st}`);

  const variants = (arg("only")?.split(",") ?? ["free", "wall", "between", "pillar"]) as string[];
  const before0 = await copyServer(page);
  for (const variant of variants) {
    const res: Record<string, unknown> = { variant };
    try {
      if (variant === "free" && geo.free) {
        await clickAt(page, geo.free);
      } else if (variant === "wall" && geo.wallA && geo.wallB) {
        // ригель вдоль стены: тянем от точки A к точке B по оси стены
        await dragAt(page, geo.wallA, geo.wallB);
      } else if (variant === "between" && geo.between) {
        await dragAt(page, geo.between.a, geo.between.b);
      } else if (variant === "pillar" && geo.pillarPt) {
        await clickAt(page, geo.pillarPt);
      } else {
        throw new Error("нет геометрии для варианта");
      }
      await clearFog(page);
      const after = await copyServer(page);
      const diff = diffModels(before0, after);
      res.diff = diff;
      const added = Object.entries<any>((after.rigels ?? {})).find(([id]) => !(id in ((before0.rigels as Record<string, unknown>) ?? {})));
      res.added = added ? added[1] : null;
      res.added_id = added ? added[0] : null;
      res.ok = !!added;
      await shot(page, `47-rigel-${variant}-plan`);
      if (added) {
        const rig = added[1];
        // панель свойств: правый клик по телу ригеля (середина оси)
        const mid = { x: (rig.p1.x + rig.p2.x) / 2, y: (rig.p1.y + rig.p2.y) / 2 };
        await clickAt(page, mid, "right");
        await page.waitForTimeout(500);
        res.menu = await dumpMenus(page);
        res.menu_html = await page.evaluate(() => {
          const m = Array.from(document.querySelectorAll(".contextmenu")).find((x: any) => x.offsetParent);
          return m ? m.outerHTML.slice(0, 20000) : null;
        });
        await shot(page, `47-rigel-${variant}-props`);
        // правки панельных полей: меняем каждое числовое поле и фиксируем изменение модели
        res.panel_edits = [];
        const fields = (res.menu as Record<string, unknown>[]).filter((f) => (f.tag === "input" || f.tag === "select") && f.id);
        for (const f of fields) {
          const id = String(f.id);
          const beforeEdit = await copyServer(page);
          if (f.tag === "select") {
            const sel = await page.evaluate((sel) => {
              const el: any = document.querySelector(sel);
              if (!el || el.offsetParent === null || el.tagName !== "SELECT") return false;
              const i = el.selectedIndex;
              if (i < 0 || i >= el.options.length - 1) return false;
              el.selectedIndex = i + 1;
              el.dispatchEvent(new Event("change", { bubbles: true }));
              return true;
            }, `#${id}`);
            if (!sel) continue;
          } else {
            const num = Number(f.value);
            const newVal = Number.isFinite(num) && num > 0 ? String(Math.round(num * 1.5)) : "50";
            const okSet = await (await import("./phase2-lib.ts")).setMenuField(page, `#${id}`, newVal);
            if (!okSet) continue;
          }
          await page.waitForTimeout(400);
          const afterEdit = await copyServer(page);
          const d = diffModels(beforeEdit, afterEdit);
          (res.panel_edits as unknown[]).push({ field: id, value_before: f.value, diff: d.rigels ?? d });
        }
        await escape(page);
      }
    } catch (e: any) {
      res.ok = false;
      res.error = String(e?.stack || e).slice(0, 400);
      await escape(page).catch(() => {});
    }
    writeFileSync(`${OUT}/${variant}.json`, JSON.stringify(res, null, 1) + "\n");
    console.log(variant, JSON.stringify({ ok: res.ok, error: res.error ?? null }));
  }
  // итог: сколько ригелей появилось (всё локально, не сохраняем)
  const fin = await page.evaluate(() => Object.keys((window as any).project.copy("server").rigels ?? {}).length);
  console.log("rigels_total_local:", fin);
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
