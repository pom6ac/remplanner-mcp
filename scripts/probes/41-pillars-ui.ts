// 41-pillars: съём эталонов «Несущая колонна» из UI проекта <REMPLANNER_PROBE_OBJECT_ID> (аккаунт).
// КЛИКИ ТОЛЬКО ЛОКАЛЬНО: project.save не вызывается, на сервер ничего не пишется.
// node scripts/probes/41-pillars-ui.ts [variant,...]   варианты: free, wall, round
// Вывод: .orca-reports/41-pillars-ui/<вариант>.json, скриншоты screenshots/41-pillar-*.png
import { mkdirSync, writeFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { clearFog, clickAt, escape, pickTool, switchSheet, toScreen, setMenuField, diffModels, type P } from "./phase2-lib.ts";

const OUT = ".orca-reports/41-pillars-ui";
const SHOTS = "../../screenshots";

function arg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
}

async function copyServer(page: Page) {
  return page.evaluate(() => JSON.parse(JSON.stringify((window as any).project.copy("server"))));
}

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** Все видимые поля контекстных меню: id, значение, тип. */
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

function visible(s: P): boolean {
  return s.x > 250 && s.x < 1350 && s.y > 150 && s.y < 850;
}

/** Свободная точка в комнате: не на стенах, не в проёмах, видимая. */
async function freePoint(page: Page, minDistCm = 60): Promise<P | null> {
  return page.evaluate((d) => {
    const walls = Object.values<any>((window as any).project.copy("server").walls ?? {});
    if (!walls.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const w of walls) {
      for (const p of [w.p1, w.p2]) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    // спираль от центра: точка вдали от всех осей стен
    const dist = (p: P, a: P, b: P) => {
      const dx = b.x - a.x, dy = b.y - a.y;
      const l2 = dx * dx + dy * dy;
      let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
    };
    for (let r = 0; r <= 500; r += 25) {
      for (let ang = 0; ang < 360; ang += 30) {
        const p = { x: cx + r * Math.cos(ang * Math.PI / 180), y: cy + r * Math.sin(ang * Math.PI / 180) };
        if (walls.every((w) => dist(p, w.p1, w.p2) > d)) return p;
      }
    }
    return null;
  }, minDistCm);
}

/** Точка на оси стены (см от p1), вдали от проёмов и концов. */
async function wallPoint(page: Page, marginCm = 60): Promise<{ p: P; wall: string } | null> {
  return page.evaluate((m) => {
    const model = (window as any).project.copy("server");
    for (const [wid, w] of Object.entries<any>(model.walls ?? {})) {
      const len = Math.hypot(w.p2.x - w.p1.x, w.p2.y - w.p1.y);
      if (len < 2 * m + 80) continue;
      const holes = Object.values<any>(w.holes ?? {});
      const t0 = m + 20;
      const dx = w.p2.x - w.p1.x, dy = w.p2.y - w.p1.y;
      for (let s = t0; s <= len - m; s += 20) {
        const ok = holes.every((h) => {
          const t = ((h.pc.x - w.p1.x) * dx + (h.pc.y - w.p1.y) * dy) / (len * len);
          return Math.abs(t * len - s) > h.width / 2 + 40;
        });
        if (ok) return { p: { x: w.p1.x + dx * (s / len), y: w.p1.y + dy * (s / len) }, wall: wid };
      }
    }
    return null;
  }, marginCm);
}

/** Удалить объект через контекстное меню (кнопка «Удалить»). */
async function removeAt(page: Page, pc: P): Promise<boolean> {
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

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) {
  console.error("Задайте REMPLANNER_PROBE_OBJECT_ID и REMPLANNER_PROBE_PLAN_ID: проба открывает указанный проект.");
  process.exit(1);
}

const only = arg("only")?.split(",");
const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
mkdirSync(OUT, { recursive: true });
try {
  const page = editor.page;
  await switchSheet(page, "init");
  const variants = (only ?? ["free", "wall"]) as string[];
  for (const variant of variants) {
    const res: Record<string, unknown> = { variant };
    try {
      const before = await copyServer(page);
      let pt: P | null = null;
      if (variant === "wall") {
        const wp = await wallPoint(page);
        pt = wp?.p ?? null;
        res.wall = wp?.wall ?? null;
      } else {
        pt = await freePoint(page);
      }
      if (!pt) throw new Error("не найдена точка");
      res.point = pt;
      const st = await pickTool(page, "pillar");
      if (st !== "ok") throw new Error(`pickTool: ${st}`);
      await clickAt(page, pt);
      await clearFog(page);
      const after = await copyServer(page);
      const diff = diffModels(before, after);
      res.diff = diff;
      const added = Object.entries<any>((after.pillars ?? {})).find(([id]) => !(id in (before.pillars ?? {})));
      res.added = added ? added[1] : null;
      res.added_id = added ? added[0] : null;
      res.ok = !!added;
      await shot(page, `41-pillar-${variant}-plan`);
      if (added) {
        const target = { x: added[1].pc.x, y: added[1].pc.y };
        await clickAt(page, target, "right");
        await page.waitForTimeout(500);
        res.menu = await dumpMenus(page);
        res.menu_html = await page.evaluate(() => {
          const m = Array.from(document.querySelectorAll(".contextmenu")).find((x: any) => x.offsetParent);
          return m ? m.outerHTML.slice(0, 20000) : null;
        });
        await shot(page, `41-pillar-${variant}-props`);
        // панельные поля: меняем каждое числовое поле и фиксируем изменение модели
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
            const okSet = await setMenuField(page, `#${id}`, newVal);
            if (!okSet) continue;
          }
          await page.waitForTimeout(400);
          const afterEdit = await copyServer(page);
          const d = diffModels(beforeEdit, afterEdit);
          (res.panel_edits as unknown[]).push({ field: id, value_before: f.value, diff: d.pillars ?? d });
          // вернуть модель обратно: undo не используем — повторная правка только для наблюдения;
          // эталон снимаем ДО правок, поэтому здесь просто продолжаем
        }
        await escape(page);
        res.removed = await removeAt(page, target);
      }
    } catch (e: any) {
      res.ok = false;
      res.error = String(e?.stack || e).slice(0, 400);
      await escape(page).catch(() => {});
    }
    writeFileSync(`${OUT}/${variant}.json`, JSON.stringify(res, null, 1) + "\n");
    console.log(variant, JSON.stringify({ ok: res.ok, added: res.added, error: res.error }));
  }
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
