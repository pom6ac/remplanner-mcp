// 25-windows: съём эталонов 7 типов окон из UI проекта <REMPLANNER_PROBE_OBJECT_ID> (аккаунт, по разрешению).
// КЛИКИ ТОЛЬКО ЛОКАЛЬНО: project.save не вызывается, на сервер ничего не пишется.
// node scripts/probes/25-windows-ui.ts [--only=window,windowway,...]
// Вывод: .orca-reports/25-windows-ui/<key>.json, скриншоты screenshots/25-win-*.png
import { mkdirSync, writeFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { clearFog, clickAt, escape, pickTool, switchSheet, toScreen, arg, type P } from "./phase2-lib.ts";

const OUT = ".orca-reports/25-windows-ui";
const SHOTS = "screenshots";
const TYPES = ["windowway", "window", "window_balcony", "window_door", "french_window", "french_window_coupe", "french_window_double"] as const;
// стены с запасом длины; позицию под каждый тип ищем свободную
const WALL_KEYS = ["mum46g7h3k", "e83g72t0rs"];

async function copyServer(page: Page) {
  return page.evaluate(() => JSON.parse(JSON.stringify((window as any).project.copy("server"))));
}

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** Свободный центр (см от p1) для проёма заданной ширины: margin=d/2+5, зазор 5. */
function freeCenter(wall: any, width: number): number | null {
  const len = Math.hypot(wall.p2.x - wall.p1.x, wall.p2.y - wall.p1.y);
  const margin = wall.depth / 2 + 5;
  const axis = { x: wall.p2.x - wall.p1.x, y: wall.p2.y - wall.p1.y };
  const ranges: [number, number][] = [];
  for (const h of Object.values<any>(wall.holes ?? {})) {
    const t = ((h.pc.x - wall.p1.x) * axis.x + (h.pc.y - wall.p1.y) * axis.y) / (len * len);
    const c = t * len;
    ranges.push([c - h.width / 2, c + h.width / 2]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let cursor = margin;
  for (const [a, b] of ranges) {
    if (cursor + width + 5 <= a - 5) return cursor + width / 2;
    cursor = Math.max(cursor, b + 5);
  }
  if (cursor + width <= len - margin) return cursor + width / 2;
  return null;
}

function pointOn(wall: any, centerCm: number): P {
  const len = Math.hypot(wall.p2.x - wall.p1.x, wall.p2.y - wall.p1.y);
  const t = centerCm / len;
  return { x: wall.p1.x + (wall.p2.x - wall.p1.x) * t, y: wall.p1.y + (wall.p2.y - wall.p1.y) * t };
}

/** Все видимые поля контекстных меню: id, значение, тип. */
function dumpMenus(page: Page): Promise<Record<string, unknown>[]> {
  return page.evaluate(() => {
    const out: Record<string, unknown>[] = [];
    for (const el of Array.from(document.querySelectorAll("[id^='cm-']")) as HTMLElement[]) {
      if (!el.offsetParent && el.type !== "hidden") continue;
      const tag = el.tagName.toLowerCase();
      const rec: Record<string, unknown> = { id: el.id, tag, value: (el as HTMLInputElement).value ?? el.textContent?.trim() };
      if (tag === "select") rec.options = Array.from((el as HTMLSelectElement).options).map((o) => ({ v: o.value, t: o.textContent?.trim() }));
      out.push(rec);
    }
    return out;
  });
}

// Проект для пробы задаётся env: проба открывает указанный проект, а 25-live-check
// ещё и сохраняет в него (project_save). Без env — отказ (ревью 26, №5).
const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) {
  console.error("Задайте REMPLANNER_PROBE_OBJECT_ID и REMPLANNER_PROBE_PLAN_ID: проба открывает (25-live-check — и сохраняет в) указанный проект.");
  process.exit(1);
}

const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
mkdirSync(OUT, { recursive: true });
const only = arg("only")?.split(",");
try {
  const page = editor.page;
  await switchSheet(page, "init");
  const base = await copyServer(page);
  const done: string[] = [];
  for (const key of TYPES) {
    if (only && !only.includes(key)) continue;
    const res: Record<string, unknown> = { key };
    try {
      // выбор стены со свободным местом
      const cur = await copyServer(page);
      let wallKey: string | null = null, center = 0;
      for (const wk of WALL_KEYS) {
        const wall = cur.walls[wk];
        const c = freeCenter(wall, 185);
        if (c !== null) { wallKey = wk; center = c; break; }
      }
      if (!wallKey) throw new Error("нет свободного места на выбранных стенах");
      const beforeWall = structuredClone(cur.walls[wallKey]);
      const pt = pointOn(cur.walls[wallKey], center);
      const st = await pickTool(page, key);
      if (st !== "ok") throw new Error(`pickTool: ${st}`);
      await clickAt(page, pt);
      await clearFog(page);
      const after = await copyServer(page);
      // добавленный проём
      let added: Record<string, unknown> | null = null;
      const wallAfter = after.walls[wallKey];
      for (const [hid, h] of Object.entries<any>(wallAfter?.holes ?? {})) {
        if (!(hid in (beforeWall?.holes ?? {}))) added = { ...h, _wall: wallKey };
      }
      res.hole = added;
      res.wall_changed_fields = added ? null : "проём не добавился";
      await shot(page, `25-win-${key}-plan`);
      // панель свойств: правый клик по центру проёма
      if (added) {
        const hp = { x: added.pc.x as number, y: added.pc.y as number };
        await clickAt(page, hp, "right");
        await page.waitForTimeout(500);
        res.menu = await dumpMenus(page);
        await shot(page, `25-win-${key}-props`);
        await escape(page);
      }
      res.ok = !!added;
    } catch (e: any) {
      res.ok = false;
      res.error = String(e?.stack || e).slice(0, 400);
      await escape(page).catch(() => {});
    }
    writeFileSync(`${OUT}/${key}.json`, JSON.stringify(res, null, 1) + "\n");
    console.log(key, JSON.stringify({ ok: res.ok, type: (res.hole as any)?.type, width: (res.hole as any)?.width, error: res.error }));
    done.push(key);
  }
  console.log("done:", done.join(","));
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
