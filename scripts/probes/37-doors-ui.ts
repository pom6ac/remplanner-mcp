// 37-doors: съём эталонов типов дверей из UI проекта <REMPLANNER_PROBE_OBJECT_ID> (аккаунт, по разрешению).
// КЛИКИ ТОЛЬКО ЛОКАЛЬНО: project.save не вызывается, на сервер ничего не пишется.
// node scripts/probes/37-doors-ui.ts [--only=door,doorway,...]
// Вывод: .orca-reports/37-doors-ui/<key>.json, скриншоты screenshots/37-door-*.png
import { mkdirSync, writeFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { clearFog, clickAt, escape, pickTool, switchSheet, toScreen, dragAt, arg, type P } from "./phase2-lib.ts";

const OUT = ".orca-reports/37-doors-ui";
const SHOTS = "screenshots";
const TYPES = [
  "doorway", "door", "door_double", "door_coupe", "door_coupe_double",
  "door_penal", "door_penal_double", "door_roto", "door_roto_double",
  "door_book", "door_book_double", "door_bellows", "door_glass", "door_garage",
  "door_system_x2", "door_system_x3", "door_system_x4",
  "door_system_penal_x2", "door_system_penal_x3", "door_system_penal_x4",
  "doors_coupe_2x", "doors_coupe_3x", "doors_coupe_4x", "door_remote", "door_videoremote",
] as const;
// запас ширины под клик (см): дефолты типов (x3 240, x4 ~320, garage 300, coupe-системы шире)
const NEED_CM: Record<string, number> = {
  door_garage: 315, door_system_x3: 255, door_system_x4: 335,
  door_system_penal_x3: 255, door_system_penal_x4: 335,
  doors_coupe_2x: 185, doors_coupe_3x: 275, doors_coupe_4x: 345,
};
// стены с запасом длины; позицию под каждый тип ищем свободную
const WALL_KEYS = ["smmfs1i0hh", "zrslo37ysb", "88wyg3rhy5", "o1kqv7m7ih", "3d23j4gk9h", "7kmwa9hpxx", "e83g72t0rs", "mum46g7h3k", "pbtbrtri2s", "776f8ztw39", "aymj6bgh2v"];

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

/** Сдвинуть план так, чтобы точка попала в видимую зону экрана (панорама ЛКМ по пустому месту). */
async function panToPoint(page: Page, p: P): Promise<boolean> {
  const s = await toScreen(page, p);
  const dx = 800 - s.x, dy = 500 - s.y;
  if (Math.abs(dx) < 30 && Math.abs(dy) < 30) return true;
  // панорама: протянуть от пустого места центра экрана
  await dragAt(page, { x: 800, y: 480 }, { x: 800 + dx, y: 480 + dy });
  await clearFog(page);
  const s2 = await toScreen(page, p);
  return s2.x > 250 && s2.x < 1350 && s2.y > 150 && s2.y < 850;
}

function visible(s: P): boolean {
  return s.x > 250 && s.x < 1350 && s.y > 150 && s.y < 850;
}

/** Удалить проём через контекстное меню (кнопка «Удалить»), освободив место на стене. */
async function removeHole(page: Page, pc: P): Promise<boolean> {
  await clickAt(page, pc, "right");
  await page.waitForTimeout(400);
  const ok = await page.evaluate(() => {
    const m = Array.from(document.querySelectorAll(".contextmenu")).find((x: any) => x.offsetParent);
    if (!m) return false;
    const items = Array.from(m.querySelectorAll("[data-button], .contextmenu_item, li, div")) as HTMLElement[];
    const b = items.find((e) =>
      ["remove", "delete", "del"].includes(e.getAttribute("data-button") ?? "") ||
      /^Удалить/.test((e.textContent ?? "").trim()));
    if (!b) return false;
    b.click();
    return true;
  });
  await page.waitForTimeout(600);
  await escape(page);
  return ok;
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

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) {
  console.error("Задайте REMPLANNER_PROBE_OBJECT_ID и REMPLANNER_PROBE_PLAN_ID: проба открывает указанный проект.");
  process.exit(1);
}

const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
mkdirSync(OUT, { recursive: true });
const only = arg("only")?.split(",");
try {
  const page = editor.page;
  await switchSheet(page, "init");
  for (const key of TYPES) {
    if (only && !only.includes(key)) continue;
    const res: Record<string, unknown> = { key };
    try {
      const cur = await copyServer(page);
      const need = NEED_CM[key] ?? 160;
      // выбор стены со свободным местом и видимой точкой
      let wallKey: string | null = null, pt: P | null = null;
      for (const wk of WALL_KEYS) {
        const wall = cur.walls[wk];
        if (!wall) continue;
        const c = freeCenter(wall, need);
        if (c === null) continue;
        const cand = pointOn(wall, c);
        if (visible(await toScreen(page, cand))) { wallKey = wk; pt = cand; break; }
      }
      if (!wallKey || !pt) {
        // панорамируем к первой стене со свободным местом
        for (const wk of WALL_KEYS) {
          const wall = cur.walls[wk];
          if (!wall) continue;
          const c = freeCenter(wall, need);
          if (c === null) continue;
          const cand = pointOn(wall, c);
          if (await panToPoint(page, cand)) { wallKey = wk; pt = cand; break; }
        }
      }
      if (!wallKey || !pt) throw new Error("нет свободного видимого места на стенах");
      const before = await copyServer(page);
      const beforeWall = structuredClone(before.walls[wallKey]);
      const beforeItems = structuredClone(before.items ?? {});
      const st = await pickTool(page, key);
      if (st !== "ok") throw new Error(`pickTool: ${st}`);
      await clickAt(page, pt);
      await clearFog(page);
      const after = await copyServer(page);
      let added: Record<string, unknown> | null = null;
      const wallAfter = after.walls[wallKey];
      for (const [hid, h] of Object.entries<any>(wallAfter?.holes ?? {})) {
        if (!(hid in (beforeWall?.holes ?? {}))) added = { ...h, _wall: wallKey };
      }
      // remote-типы могут ставить предмет, а не проём
      const addedItem = Object.entries<any>(after.items ?? {}).find(([iid]) => !(iid in (beforeItems ?? {})));
      if (addedItem) res.item = addedItem[1];
      res.hole = added;
      res.wall_changed_fields = (added || addedItem) ? null : "проём не добавился";
      await shot(page, `37-door-${key}-plan`);
      const target: P | null = added
        ? { x: added.pc.x as number, y: added.pc.y as number }
        : addedItem ? { x: addedItem[1].pc.x, y: addedItem[1].pc.y } : null;
      if (target) {
        await clickAt(page, target, "right");
        await page.waitForTimeout(500);
        res.menu = await dumpMenus(page);
        res.menu_html = await page.evaluate(() => {
          const m = Array.from(document.querySelectorAll(".contextmenu")).find((x: any) => x.offsetParent);
          return m ? m.outerHTML.slice(0, 20000) : null;
        });
        await shot(page, `37-door-${key}-props`);
        await escape(page);
        // освобождаем место: проём удалён после фиксации эталона
        res.removed = await removeHole(page, target);
      }
      res.ok = !!(added || addedItem);
    } catch (e: any) {
      res.ok = false;
      res.error = String(e?.stack || e).slice(0, 400);
      await escape(page).catch(() => {});
    }
    writeFileSync(`${OUT}/${key}.json`, JSON.stringify(res, null, 1) + "\n");
    console.log(key, JSON.stringify({ ok: res.ok, type: (res.hole as any)?.type, width: (res.hole as any)?.width, item: !!(res as any).item, error: res.error }));
  }
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
