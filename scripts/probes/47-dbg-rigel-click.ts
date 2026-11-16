// 47-rigels: разведка кликов «Потолочный ригель» — как рождается объект model.rigels.
// ID только из env. КЛИКИ ТОЛЬКО ЛОКАЛЬНО: project.save не вызывается.
import { mkdirSync, writeFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { clearFog, clickAt, escape, pickTool, switchSheet, toScreen, copyServer, diffModels, type P } from "./phase2-lib.ts";

const OUT = ".orca-reports/47-rigels-ui";
const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) { console.error("env?"); process.exit(1); }

async function dump(page: Page, tag: string, data: unknown) {
  writeFileSync(`${OUT}/dbg-${tag}.json`, JSON.stringify(data, null, 1) + "\n");
  console.log(tag, JSON.stringify(data).slice(0, 300));
}

const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
mkdirSync(OUT, { recursive: true });
try {
  const page = editor.page;
  await switchSheet(page, "init");

  // геометрия: свободная точка в комнате и точка на оси стены
  const geo = await page.evaluate(() => {
    const model = (window as any).project.copy("server");
    const walls = Object.values<any>(model.walls ?? {});
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const list: { id: string; p1: P; p2: P; len: number; holes: number }[] = [];
    for (const w of walls) {
      minX = Math.min(minX, w.p1.x, w.p2.x); maxX = Math.max(maxX, w.p1.x, w.p2.x);
      minY = Math.min(minY, w.p1.y, w.p2.y); maxY = Math.max(maxY, w.p1.y, w.p2.y);
      list.push({ id: w.id, p1: w.p1, p2: w.p2, len: Math.hypot(w.p2.x - w.p1.x, w.p2.y - w.p1.y), holes: Object.keys(w.holes ?? {}).length });
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const dist = (p: P, a: P, b: P) => {
      const dx = b.x - a.x, dy = b.y - a.y; const l2 = dx * dx + dy * dy;
      let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
    };
    let free: P | null = null;
    outer: for (let r = 0; r <= 500; r += 25) {
      for (let ang = 0; ang < 360; ang += 15) {
        const p = { x: cx + r * Math.cos(ang * Math.PI / 180), y: cy + r * Math.sin(ang * Math.PI / 180) };
        if (walls.every((w) => dist(p, w.p1, w.p2) > 80)) { free = p; break outer; }
      }
    }
    // самая длинная стена без проёмов
    list.sort((a, b) => b.len - a.len);
    const wall = list.find((w) => w.len > 200 && w.holes === 0) ?? null;
    let wallPt: P | null = null;
    if (wall) {
      const t = 0.5;
      wallPt = { x: wall.p1.x + (wall.p2.x - wall.p1.x) * t, y: wall.p1.y + (wall.p2.y - wall.p1.y) * t };
    }
    // точка рядом со стеной (внутри комнаты, в 30 см от оси)
    let nearWall: P | null = null;
    if (wall) {
      const dx = (wall.p2.x - wall.p1.x) / wall.len, dy = (wall.p2.y - wall.p1.y) / wall.len;
      nearWall = { x: wallPt!.x - dy * 30, y: wallPt!.y + dx * 30 };
    }
    return { free, wall, wallPt, nearWall, wallsCount: walls.length, rigelsBefore: model.rigels ?? null };
  });
  await dump(page, "geo", geo);

  const st = await pickTool(page, "rigel");
  console.log("pickTool:", st);
  if (st !== "ok") throw new Error(`pickTool: ${st}`);

  // состояние после выбора инструмента
  const toolState = await page.evaluate(() => {
    const w = window as any;
    return {
      RIGELS_keys: Object.keys(w.RIGELS ?? {}),
      RIGELS_sample: JSON.parse(JSON.stringify(Object.values<any>(w.RIGELS ?? {})[0] ?? null)),
      cursor: !!w.$RigelCursor,
      mode: (w.planner_mode ?? w.project?.mode ?? null),
    };
  });
  await dump(page, "tool-state", toolState);

  const before = await copyServer(page);

  // попытка 1: одиночный клик в свободной точке
  if (geo.free) {
    await clickAt(page, geo.free);
    const after1 = await copyServer(page);
    const d1 = diffModels(before, after1);
    await dump(page, "click-free-1", { diff: d1, rigels: after1.rigels ?? null });
    // попытка 2: второй клик рядом (если инструмент рисует по двум точкам)
    const p2 = { x: geo.free.x + 80, y: geo.free.y };
    await clickAt(page, p2);
    const after2 = await copyServer(page);
    const d2 = diffModels(before, after2);
    await dump(page, "click-free-2", { diff: d2, rigels: after2.rigels ?? null });
    // третий клик — замыкание?
    await clickAt(page, { x: geo.free.x + 80, y: geo.free.y + 50 });
    const after3 = await copyServer(page);
    await dump(page, "click-free-3", { diff: diffModels(before, after3), rigels: after3.rigels ?? null });
  }

  // если ригель появился — снять его объект
  const rigelNow = await page.evaluate(() => {
    const m = (window as any).project.copy("server");
    const rig = m.rigels ?? {};
    const out: any = { count: Object.keys(rig).length };
    const first = Object.values<any>(rig)[0];
    if (first) out.first = JSON.parse(JSON.stringify(first));
    return out;
  });
  await dump(page, "rigel-now", rigelNow);
  await escape(page);
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
