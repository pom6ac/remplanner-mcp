// 94: разведка «Отделка» — шаг 2: применение покрытий (пол/стена/потолок) и куда пишется модель.
// Анонимный проект. Запуск: node scripts/probes/94-finish-apply.ts
import { launch, newAnonProject, buildBase, copyServer, switchSheet, pickTool, clickAt, diffModels, writeOut, escape, shot } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);
const base = await copyServer(page);

const res: any = {};

// --- пол: laminate в комнату A (0..300, -300..0)
await switchSheet(page, "floor");
res.laminate_pick = await pickTool(page, "laminate");
// панель выбора материала может открыться — снимем её состав
res.laminate_panel = await page.evaluate(() => {
  const panel: any = document.querySelector(".tools_panel .subtools, .subtools, .finish_panel, .material_panel");
  const items = Array.from(document.querySelectorAll('[id^="plannertool_"]'))
    .filter((e: any) => e.offsetParent !== null)
    .map((e: any) => ({ id: e.id.replace(/^plannertool_/, ""), cls: e.className }));
  return { visible: items.slice(0, 40), panelHtmlLen: panel ? panel.innerHTML.length : 0 };
});
await clickAt(page, { x: 150, y: -150 });
await escape(page);
let after = await copyServer(page);
res.laminate_diff = diffModels(base, after);
writeOut("94-laminate-diff", res.laminate_diff);
console.log("laminate diff keys:", JSON.stringify(Object.keys(res.laminate_diff)));

// --- стена: wallpaper на верхнюю наружную стену (клик у середины стены top)
await switchSheet(page, "walls");
res.wallpaper_pick = await pickTool(page, "wallpaper");
await clickAt(page, { x: 300, y: -285 });
await escape(page);
after = await copyServer(page);
res.wallpaper_diff = diffModels(base, after);
writeOut("94-wallpaper-diff", res.wallpaper_diff);
console.log("wallpaper diff keys:", JSON.stringify(Object.keys(res.wallpaper_diff)));

// --- потолок: paint_ceiling в комнату B
await switchSheet(page, "ceiling");
res.paint_ceiling_pick = await pickTool(page, "paint_ceiling");
await clickAt(page, { x: 400, y: -150 });
await escape(page);
after = await copyServer(page);
res.paint_ceiling_diff = diffModels(base, after);
writeOut("94-paint-ceiling-diff", res.paint_ceiling_diff);
console.log("paint_ceiling diff keys:", JSON.stringify(Object.keys(res.paint_ceiling_diff)));

// полные комнаты и стена top после всех применений
const final = await copyServer(page);
const topWallId = await page.evaluate(() => {
  const w: any = window as any;
  const walls = w.project?.copy ? null : null;
  return walls;
});
res.rooms_final = final.rooms2;
const wallIds = Object.keys(final.walls ?? {});
res.walls_final_sample = {};
for (const id of wallIds) {
  const w: any = final.walls[id];
  res.walls_final_sample[id] = { sectors: w.sectors, claddings: w.claddings, material: w.material, color: w.color };
}
writeOut("94-finish-final", { rooms: res.rooms_final, walls: res.walls_final_sample });
await shot(page, "94-finish-after");
await browser.close();
process.exit(0);
