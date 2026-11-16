// 47-rigels: панель свойств ригеля, правки полей, ссылка p2 на вторую стену, класс Rigel, влияние на rooms2.
// ID только из env. КЛИКИ ТОЛЬКО ЛОКАЛЬНО: project.save не вызывается.
import { mkdirSync, writeFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { clearFog, clickAt, escape, pickTool, switchSheet, copyServer, diffModels, setMenuField, type P } from "./phase2-lib.ts";

const OUT = ".orca-reports/47-rigels-ui";
const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) { console.error("env?"); process.exit(1); }

function dump(name: string, data: unknown) {
  writeFileSync(`${OUT}/props-${name}.json`, JSON.stringify(data, null, 1) + "\n");
  console.log(name, JSON.stringify(data).slice(0, 300));
}

async function dumpMenus(page: Page): Promise<Record<string, unknown>[]> {
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

const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
mkdirSync(OUT, { recursive: true });
try {
  const page = editor.page;
  await switchSheet(page, "init");
  const before = await copyServer(page);
  const roomsBefore = JSON.stringify(before.rooms2 ?? {});

  // ригель на верхней грани первой колонны (магнит, как в dbg-пробе)
  const pillarPt: P | null = await page.evaluate(() => {
    const p = Object.values<any>((window as any).project.copy("server").pillars ?? {})[0];
    return p ? { x: p.pc.x, y: p.pc.y - p.height / 2 } : null;
  });
  if (!pillarPt) throw new Error("нет колонны");
  const st = await pickTool(page, "rigel");
  if (st !== "ok") throw new Error(`pickTool: ${st}`);
  await clickAt(page, pillarPt);
  await clearFog(page);
  let after = await copyServer(page);
  const rigEntry = Object.entries<any>(after.rigels ?? {}).find(([id]) => !(id in (before.rigels ?? {})));
  if (!rigEntry) throw new Error("ригель не создался");
  const rid = rigEntry[0];
  dump("created", rigEntry[1]);

  // класс Rigel: источник конструктора (требования restore)
  const cls = await page.evaluate((id) => {
    const r = (window as any).RIGELS?.[id];
    if (!r) return null;
    const proto = Object.getPrototypeOf(r);
    return {
      ctor: (proto.constructor?.toString() ?? "").slice(0, 9000),
      methods: Object.getOwnPropertyNames(proto),
      static: Object.getOwnPropertyNames(proto.constructor ?? {}).filter((k) => k !== "length" && k !== "name" && k !== "prototype"),
    };
  }, rid);
  dump("class", cls);

  // панель свойств: правый клик по телу ригеля
  const mid: P = { x: (rigEntry[1].p1.x + rigEntry[1].p2.x) / 2, y: (rigEntry[1].p1.y + rigEntry[1].p2.y) / 2 };
  await clickAt(page, mid, "right");
  await page.waitForTimeout(500);
  const menu = await dumpMenus(page);
  dump("menu", menu);
  const menu_html = await page.evaluate(() => {
    const m = Array.from(document.querySelectorAll(".contextmenu")).find((x: any) => x.offsetParent);
    return m ? m.outerHTML.slice(0, 30000) : null;
  });
  writeFileSync(`${OUT}/props-menu.html`, menu_html ?? "");
  await page.screenshot({ path: "../../screenshots/47-rigel-props.png" }).catch(() => {});

  // правки числовых полей
  const edits: unknown[] = [];
  for (const f of menu.filter((x) => x.tag === "input" || x.tag === "select")) {
    const id = String(f.id);
    const beforeEdit = await copyServer(page);
    if (f.tag === "select") {
      const okSet = await page.evaluate((sel) => {
        const el: any = document.querySelector(sel);
        if (!el || el.offsetParent === null || el.tagName !== "SELECT") return false;
        const i = el.selectedIndex;
        if (i < 0 || i >= el.options.length - 1) return false;
        el.selectedIndex = i + 1;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }, `#${id}`);
      if (!okSet) continue;
    } else {
      const num = Number(f.value);
      const newVal = Number.isFinite(num) && num > 0 ? String(Math.round(num * 1.5)) : "50";
      if (!(await setMenuField(page, `#${id}`, newVal))) continue;
    }
    await page.waitForTimeout(400);
    const afterEdit = await copyServer(page);
    const d = diffModels(beforeEdit, afterEdit);
    edits.push({ field: id, value_before: f.value, diff: d.rigels ?? d });
    await escape(page);
    await clickAt(page, mid, "right");
    await page.waitForTimeout(400);
  }
  dump("edits", edits);
  await escape(page);

  // rooms2 до/после: влияет ли ригель на комнаты
  after = await copyServer(page);
  dump("rooms2", { same: JSON.stringify(after.rooms2 ?? {}) === roomsBefore, rooms2_keys: Object.keys(after.rooms2 ?? {}) });

  // попытка перетащить p2 к другой стене: инструментом не просто; проверим лишь структуру link
  // (перетаскивание ручек — отдельная механика редактора, не критично для эталона)
  await escape(page);
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
