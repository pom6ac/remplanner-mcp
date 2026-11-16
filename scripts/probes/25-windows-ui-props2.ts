// 25-windows: проба 3 — полная карта свойств по каждому из 7 типов:
// пресет панели, реакция модели на значения полей, контекстное меню (правый клик), «глаз» инструмента.
// КЛИКИ ЛОКАЛЬНЫЕ, без save. node scripts/probes/25-windows-ui-props2.ts [--only=...]
import { writeFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { clearFog, clickAt, escape, pickTool, switchSheet, arg } from "./phase2-lib.ts";

const TYPES = ["windowway", "window", "window_balcony", "window_door", "french_window", "french_window_coupe", "french_window_double"];
const OUT = ".orca-reports/25-windows-ui";

const copyS = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((window as any).project.copy("server"))));

/** Видимый пресет панели параметров (pm-…/set-…). */
function visiblePreset(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const root = document.querySelector("#planner_ui_options");
    if (!root) return null;
    for (const p of Array.from((root as HTMLElement).querySelectorAll(".options_preset")) as HTMLElement[]) {
      if (p.offsetParent) {
        const fields: Record<string, unknown>[] = [];
        for (const f of Array.from(p.querySelectorAll("input[type=text], select")) as (HTMLInputElement | HTMLSelectElement)[]) {
          fields.push({
            id: f.id || f.getAttribute("data-param") || "",
            label: f.closest(".opt_input")?.querySelector("label")?.textContent?.trim() ?? "",
            placeholder: (f as HTMLInputElement).placeholder ?? null,
            tag: f.tagName.toLowerCase(),
            options: f.tagName === "SELECT" ? Array.from((f as HTMLSelectElement).options).map((o) => o.value) : undefined,
          });
        }
        // прочие управляющие элементы пресета (кнопки, иконки)
        const extras = Array.from(p.querySelectorAll("a, .opt_preset_buttons span, [id]"))
          .map((e: any) => ({ id: e.id, cls: String(e.className), text: e.textContent?.trim().slice(0, 30) }))
          .filter((x: any) => x.id);
        return { preset: p.id, fields, extras };
      }
    }
    return null;
  });
}

/** Задать поле пресета и подтвердить Enter. */
async function setField(page: Page, id: string, value: string): Promise<boolean> {
  const ok = await page.evaluate(({ id, value }) => {
    const el: any = document.querySelector(`#${id}`);
    if (!el || !el.offsetParent) return false;
    el.focus();
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, { id, value });
  if (ok) { await page.keyboard.press("Enter"); await page.waitForTimeout(600); await clearFog(page); }
  return ok;
}

async function setSelect(page: Page, id: string, value: string): Promise<boolean> {
  const ok = await page.evaluate(({ id, value }) => {
    const el: any = document.querySelector(`#${id}`);
    if (!el || !el.offsetParent) return false;
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, { id, value });
  if (ok) await page.waitForTimeout(600);
  return ok;
}

/** Текст/пункты активного контекстного меню после правого клика. */
function activeMenu(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const m = Array.from(document.querySelectorAll(".planner_ui_menu.active, [class*='menuid'].active")) as HTMLElement[];
    return m.map((el) => ({
      id: el.id, cls: el.className,
      items: Array.from(el.querySelectorAll("li, .contextmenu_item, a")).map((i) => ({ id: i.id || null, text: i.textContent?.trim().slice(0, 40), cls: String(i.className).slice(0, 50) })).filter((x: any) => x.text),
    }));
  });
}

const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, "7887657", "1001798", 60_000, { anonymous: false });
const only = arg("only")?.split(",");
try {
  const page = editor.page;
  await switchSheet(page, "init");
  for (const key of TYPES) {
    if (only && !only.includes(key)) continue;
    const res: Record<string, unknown> = { key };
    try {
      const before = await copyS(page);
      // свободный центр на mum46g7h3k
      const wall = before.walls["mum46g7h3k"];
      const axis = { x: wall.p2.x - wall.p1.x, y: wall.p2.y - wall.p1.y };
      const len = Math.hypot(axis.x, axis.y);
      let cursor = wall.depth / 2 + 5;
      for (const h of Object.values<any>(wall.holes ?? {})) {
        const t = ((h.pc.x - wall.p1.x) * axis.x + (h.pc.y - wall.p1.y) * axis.y) / (len * len);
        cursor = Math.max(cursor, t * len + h.width / 2 + 5);
      }
      const center = cursor + 100;
      if (center + 90 > len - wall.depth / 2) throw new Error("стена кончилась");
      const pt = { x: wall.p1.x + (center / len) * axis.x, y: wall.p1.y + (center / len) * axis.y };
      const st = await pickTool(page, key);
      if (st !== "ok") throw new Error(`pickTool: ${st}`);
      await clickAt(page, pt);
      await clearFog(page);
      const after = await copyS(page);
      const w2 = after.walls["mum46g7h3k"];
      const hid = Object.keys(w2.holes ?? {}).find((k) => !(k in (wall.holes ?? {})));
      if (!hid) throw new Error("проём не добавился");
      res.hole_defaults = w2.holes[hid];
      await escape(page); // снять инструмент, как в фазе 2 (иначе правый клик гасится)
      // выделить и снять пресет
      await clickAt(page, w2.holes[hid].pc);
      await page.waitForTimeout(500);
      res.preset = await visiblePreset(page);
      await escape(page);
      // правый клик — контекстное меню
      await clickAt(page, w2.holes[hid].pc, "right");
      await page.waitForTimeout(600);
      res.context_menu = await page.evaluate(() => {
        const menus = Array.from(document.querySelectorAll(".contextmenu")) as HTMLElement[];
        const vis = menus.filter((m) => m.offsetParent);
        return vis.map((m) => ({
          id: m.id,
          html: m.outerHTML.slice(0, 12000),
        }));
      });
      await escape(page);
      // маппинг полей → модель: ставим значения через контекстное меню и снимаем диф
      const map: Record<string, string>[] = [];
      await clickAt(page, w2.holes[hid].pc, "right");
      await page.waitForTimeout(500);
      const inputs = await page.evaluate(() => {
        const m = Array.from(document.querySelectorAll(".contextmenu")).find((x: any) => x.offsetParent) as HTMLElement | undefined;
        if (!m) return [];
        return Array.from(m.querySelectorAll("input.numeric")).map((i: any) => ({
          dataInput: i.getAttribute("data-input") ?? i.getAttribute("action") ?? "",
          ph: i.placeholder,
        }));
      });
      for (const inp of inputs) {
        if (!inp.dataInput) continue;
        const v = inp.dataInput === "angle" ? "15" : inp.dataInput === "parts" ? "2" : inp.dataInput.startsWith("sill") ? "6" : inp.dataInput === "floor-height" ? "90" : inp.dataInput === "height" ? "160" : "140";
        const okSet = await page.evaluate(({ v, di }) => {
          const m = Array.from(document.querySelectorAll(".contextmenu")).find((x: any) => x.offsetParent) as HTMLElement | undefined;
          const el = m?.querySelector(`input[data-input="${di}"], input[action="${di}"]`) as HTMLInputElement | null;
          if (!el) return false;
          el.focus(); el.value = v;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          const okBtn = el.parentElement?.querySelector("span");
          (okBtn ?? el).dispatchEvent(new MouseEvent("click", { bubbles: true }));
          return true;
        }, { v, di: inp.dataInput });
        await page.waitForTimeout(400);
        if (okSet) {
          const cur = await copyS(page);
          map.push({ field: inp.dataInput, value: v, hole_after: cur.walls["mum46g7h3k"].holes[hid] ?? null });
        }
      }
      res.field_map = map;
      await escape(page);
      res.ok = true;
    } catch (e: any) {
      res.ok = false;
      res.error = String(e?.stack || e).slice(0, 300);
      await escape(page).catch(() => {});
    }
    writeFileSync(`${OUT}/props-${key}.json`, JSON.stringify(res, null, 1) + "\n");
    console.log(key, res.ok ? "ok" : `ERR ${res.error}`);
  }
  console.log("done");
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
