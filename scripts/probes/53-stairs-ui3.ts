// 53-stairs, проба 3: оставшиеся 6 пунктов меню «Лестницы» (эскалатор, лифт, люк напольный,
// ladder_2march_console-fan, ladder_fan_2march, ladder_3march_fan) + изменение размеров
// лестницы через панель (cm-furniture--width/depth). КЛИКИ ТОЛЬКО ЛОКАЛЬНО.
// node scripts/probes/53-stairs-ui3.ts
import { mkdirSync, writeFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { clearFog, clickAt, escape, pickTool, switchSheet, copyServer, diffModels, setMenuField, type P } from "./phase2-lib.ts";

const OUT = ".orca-reports/53-stairs-ui";
const SHOTS = "../../screenshots";

const TOOLS = ["ladder_2march_console-fan", "ladder_fan_2march", "ladder_3march_fan", "escalator", "elevator", "floor_hatch"];

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
if (!OBJECT_ID || !PLAN_ID) { console.error("env?"); process.exit(1); }

const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
mkdirSync(OUT, { recursive: true });
try {
  const page = editor.page;
  await switchSheet(page, "init");
  const centers = await page.evaluate(() => {
    const m = (window as any).project.copy("server");
    const rooms = Object.values<any>((m as any).rooms2 ?? {});
    return rooms.map((r) => ({ x: Math.round(r.pc.x), y: Math.round(r.pc.y), area: r.area }));
  }).then((rs: { x: number; y: number; area: number }[]) => rs.sort((a, b) => b.area - a.area));
  const big = { x: centers[0]!.x, y: centers[0]!.y };
  console.log("комнаты:", JSON.stringify(centers));

  for (let i = 0; i < TOOLS.length; i++) {
    const key = TOOLS[i]!;
    const p: P = { x: big.x + (i % 2) * 10, y: big.y + Math.floor(i / 2) * 8 };
    const st = await pickTool(page, key);
    const rec: Record<string, unknown> = { pick: st, spot: p };
    if (st === "ok") {
      const b = await copyServer(page);
      await clickAt(page, p);
      const a = await copyServer(page);
      const diff = diffModels(b, a);
      const added: Record<string, any> = {};
      for (const [coll, dv] of Object.entries(diff)) {
        for (const [id, o] of Object.entries<any>((dv as any).added ?? {})) added[`${coll}/${id}`] = o;
      }
      rec.diff_keys = Object.keys(diff);
      rec.added = added;
      await page.screenshot({ path: `${SHOTS}/53-${key}.png` });
    }
    writeFileSync(`${OUT}/${key}.json`, JSON.stringify(rec, null, 1) + "\n");
    console.log(key, st, "diff:", JSON.stringify(rec.diff_keys ?? []));
    await escape(page);
  }

  // изменение размеров лестницы через панель: ставим ladder_march и меняем ширину/глубину
  {
    const key = "ladder_march";
    await pickTool(page, key);
    const b = await copyServer(page);
    const p: P = { x: big.x, y: big.y - 30 };
    await clickAt(page, p);
    const a1 = await copyServer(page);
    const diff1 = diffModels(b, a1);
    let item: any = null;
    for (const dv of Object.values<any>(diff1)) for (const o of Object.values<any>(dv.added ?? {})) item = o;
    const rec: Record<string, unknown> = { placed: item };
    if (item) {
      await clickAt(page, { x: item.pc.x, y: item.pc.y }, "right");
      // панель cm-furniture: поля Ширина/Глубина (см)
      const before = await copyServer(page);
      const w = await setMenuField(page, "#cm-furniture--width", "300");
      const d = await setMenuField(page, "#cm-furniture--depth", "100");
      await escape(page);
      const after = await copyServer(page);
      const diff2 = diffModels(before, after);
      rec.panel = { width_set: w, depth_set: d, diff: diff2 };
      await page.screenshot({ path: `${SHOTS}/53-ladder_march-resize.png` });
    }
    writeFileSync(`${OUT}/${key}-resize.json`, JSON.stringify(rec, null, 1) + "\n");
    console.log(key, "resize:", JSON.stringify((rec.panel as any)?.diff ?? null).slice(0, 400));
    await escape(page);
  }
  console.log("done");
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
