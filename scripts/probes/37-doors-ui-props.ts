// 37-doors: проба свойств — пресет панели (левый клик), контекстное меню (правый клик),
// маппинг полей → модель для всех 20 типов дверей. Временная стена удаляется в конце.
// КЛИКИ ЛОКАЛЬНЫЕ, без save. node scripts/probes/37-doors-ui-props.ts [--only=...]
import { mkdirSync, writeFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { clearFog, clickAt, escape, pickTool, switchSheet, toScreen, arg } from "./phase2-lib.ts";

const OUT = ".orca-reports/37-doors-ui";
const TYPES = [
  "doorway", "door", "door_double", "door_coupe", "door_coupe_double",
  "door_penal", "door_penal_double", "door_roto", "door_roto_double",
  "door_book", "door_book_double", "door_bellows", "door_glass", "door_garage",
  "door_system_x2", "door_system_x3", "door_system_x4",
  "door_system_penal_x2", "door_system_penal_x3", "door_system_penal_x4",
];
const copyS = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((window as any).project.copy("server"))));
const visible = (s: { x: number; y: number }) => s.x > 250 && s.x < 1350 && s.y > 150 && s.y < 850;

/** Видимый пресет панели параметров (options_preset при выделении проёма). */
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
            value: f.tagName === "SELECT" ? (f as HTMLSelectElement).value : (f as HTMLInputElement).value,
            tag: f.tagName.toLowerCase(),
            options: f.tagName === "SELECT" ? Array.from((f as HTMLSelectElement).options).map((o) => o.value) : undefined,
          });
        }
        const extras = Array.from(p.querySelectorAll("a, .opt_preset_buttons span, [id], .switcher"))
          .map((e: any) => ({ id: e.id, cls: String(e.className).slice(0, 60), text: e.textContent?.trim().slice(0, 30) }))
          .filter((x: any) => x.id);
        return { preset: p.id, fields, extras };
      }
    }
    return null;
  });
}

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) { console.error("Задайте REMPLANNER_PROBE_OBJECT_ID и REMPLANNER_PROBE_PLAN_ID."); process.exit(1); }

const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
mkdirSync(OUT, { recursive: true });
const only = arg("only")?.split(",");
let wallId: string | null = null;
try {
  const page = editor.page;
  await switchSheet(page, "init");
  // временная стена 800 см
  const tmp = await page.evaluate(() => {
    const w: any = window as any;
    const id = w.LIB.id();
    const model = w.project.copy("server");
    const ys = Object.values<any>(model.walls).map((x) => Math.max(x.p1.y, x.p2.y));
    const y = Math.max(...ys) + 200;
    // @ts-ignore Wall — лексический класс бандла
    w.WALLS[id] = new Wall({ id, p1: { x: 0, y }, p2: { x: 800, y }, depth: 20, plan: "a", role: "wall",
      material: w.defs?.wall?.material || "a_block", color: w.defs?.wall?.color || 0 });
    w.$Project.draw({ rooms: 1 });
    return { id, y };
  });
  wallId = tmp.id;
  for (const key of TYPES) {
    if (only && !only.includes(key)) continue;
    const res: Record<string, unknown> = { key };
    try {
      const cur = await copyS(page);
      const wall = cur.walls[wallId!];
      const len = Math.hypot(wall.p2.x - wall.p1.x, wall.p2.y - wall.p1.y);
      // каждый тип на своей позиции (шаг 150 см), места хватает: 20 × 150 = 3000 > 800...
      // поэтому размещаем по кругу на 4 позициях с удалением; позиция — центр 400
      const pt = { x: wall.p1.x + len / 2, y: wall.p1.y };
      let s = await toScreen(page, pt);
      if (!visible(s)) {
        await import("./phase2-lib.ts").then(({ dragAt }) => dragAt(page, { x: 800, y: 480 }, { x: 800 - (s.x - 800), y: 480 - (s.y - 500) }));
        await clearFog(page);
        s = await toScreen(page, pt);
        if (!visible(s)) throw new Error("временная стена не видна");
      }
      const st = await pickTool(page, key);
      if (st !== "ok") throw new Error(`pickTool: ${st}`);
      await clickAt(page, pt);
      await clearFog(page);
      const after = await copyS(page);
      const w2 = after.walls[wallId!];
      const hid = Object.keys(w2.holes ?? {}).find((k) => !(k in (wall.holes ?? {})));
      if (!hid) throw new Error("проём не добавился");
      res.hole_defaults = w2.holes[hid];
      await escape(page); // снять инструмент, иначе правый клик гасится
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
        return menus.filter((m) => m.offsetParent).map((m) => ({ id: m.id, html: m.outerHTML.slice(0, 14000) }));
      });
      await escape(page);
      // маппинг полей контекстного меню → модель
      const map: Record<string, unknown>[] = [];
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
        const v = inp.dataInput === "angle" ? "15" : inp.dataInput === "parts" ? "2" : inp.dataInput === "height" ? "190" : "130";
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
          const curNow = await copyS(page);
          const h = curNow.walls[wallId!].holes[hid];
          map.push({ field: inp.dataInput, value: v, hole_after: h ? (({ l1, r1, l2, r2, l1b, r1b, l2b, r2b, l1c, l2c, r1c, r2c, p1fact, p2fact, pcfact, bg_polygon, eds, polygon, pcb, p1b, p2b, p1corner, p2corner, pc1h, f0offset, room_l, room_r, parent, parent_depth, dls_prs, p1, p2, pc, ...rest }) => rest)(h) : null });
        }
      }
      res.field_map = map;
      await escape(page);
      // удалить проём (освободить позицию)
      await clickAt(page, w2.holes[hid].pc, "right");
      await page.waitForTimeout(400);
      res.removed = await page.evaluate(() => {
        const m = Array.from(document.querySelectorAll(".contextmenu")).find((x: any) => x.offsetParent);
        if (!m) return false;
        const items = Array.from(m.querySelectorAll("[data-button], .contextmenu_item, li, div")) as HTMLElement[];
        const b = items.find((e) => ["remove", "delete", "del"].includes(e.getAttribute("data-button") ?? "") || /^Удалить/.test((e.textContent ?? "").trim()));
        if (!b) return false;
        b.click();
        return true;
      });
      await page.waitForTimeout(500);
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
  // удалить временную стену
  await page.evaluate((wid) => {
    const w: any = window as any;
    delete w.WALLS[wid];
    w.$Project.draw({ rooms: 1 });
  }, wallId!);
  const fin = await copyS(page);
  console.log("tmp wall removed:", !fin.walls[wallId!]);
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
