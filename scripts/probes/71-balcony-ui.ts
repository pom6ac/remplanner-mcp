// 71-balcony: съём эталона «Нарисовать балкон» из UI анонимного проекта.
// Клики только локально: project.save не вызывается, на сервер ничего не пишется.
// node scripts/probes/71-balcony-ui.ts [--headed]
// Вывод: .orca-reports/71-balcony-ui/*.json, скриншоты .orca-reports/71-balcony-ui/*.png
import { mkdirSync, writeFileSync } from "node:fs";
import type { Page } from "playwright-core";
import {
  launch, newAnonProject, buildBase, copyServer, pickTool, clickAt, dragAt, escape,
  clearFog, toScreen, diffModels, switchSheet, shot,
} from "./phase2-lib.ts";

const OUT = ".orca-reports/71-balcony-ui";
mkdirSync(OUT, { recursive: true });
const browser = await launch();
const j = (name: string, data: unknown) => writeFileSync(`${OUT}/${name}.json`, JSON.stringify(data, null, 1) + "\n");

try {
  const page = await newAnonProject(browser);
  await buildBase(page);
  await switchSheet(page, "init");
  const before = await copyServer(page);

  // --- вариант A: U-образный балкон, приставший к нижней стене (3 сегмента, мышь) ---
  await pickTool(page, "balcony");
  // сегмент — mousedown → move → mouseup (проба 1: клик без протяжки дал заглушку 10 см)
  await dragAt(page, { x: 150, y: 120 }, { x: 150, y: 320 });
  await dragAt(page, { x: 150, y: 320 }, { x: 420, y: 320 });
  await dragAt(page, { x: 420, y: 320 }, { x: 420, y: 120 });
  await escape(page);
  await page.waitForTimeout(800);
  await clearFog(page);

  const afterA = await copyServer(page);
  j("balcony-raw", { mouse: { start: [150, 120], pts: [[150, 320], [420, 320], [420, 120]] }, after: afterA });
  j("balcony-diff", diffModels(before, afterA));
  const rooms = await page.evaluate(() => {
    const m: any = (window as any).project.copy("server");
    return {
      rooms1: m.rooms1 ?? null,
      rooms2_names: Object.fromEntries(Object.entries<any>(m.rooms2 ?? {}).map(([k, v]: any) => [k, { area: v.area, name: v.name, zones: v.zones?.map((z: any) => z.name) }])),
      errors: m.errors ?? null,
    };
  });
  j("balcony-rooms", rooms);
  await shot(page, "balcony-A");

  // --- попробуем поставить дверь на балконную стену (ожидаем отказ редактора) ---
  const balcWall = Object.values<any>(afterA.walls ?? {}).find((w: any) => w.role === "balcony");
  if (balcWall) {
    const mid = { x: (balcWall.p1.x + balcWall.p2.x) / 2, y: (balcWall.p1.y + balcWall.p2.y) / 2 };
    const t1 = await pickTool(page, "door");
    await clickAt(page, mid, "left");
    const fog = await page.evaluate(() => {
      const el: any = document.querySelector(".planner_ui_message.active") ?? document.querySelector("#planner_ui_message_fog.active");
      return el ? (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200) : null;
    });
    j("opening-on-balcony", { tool: t1, clicked: mid, fog });
    await escape(page);
    await escape(page);
  }
  await page.waitForTimeout(500);
} finally {
  await browser.close();
}
