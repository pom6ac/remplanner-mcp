// 359: живой эталон — дверь/окно/проём без заполнения, поставленные руками в UI
// на перегородку (лист create_walls): какие поля редактор пишет у такого проёма.
// Плюс живое воспроизведение падения 356: у проёма, записанного как пишет MCP
// (без l1/l2/r1/r2), $Project.draw падает в Wall.setHolesFloor0Offset → LIB.center.
// Анонимный проект, аккаунт не используется.
//   node scripts/probes/359-partition-ui-ref.ts
import { writeFileSync, mkdirSync } from "node:fs";
import { launch, newAnonProject, buildBase, copyServer, switchSheet, pickTool, clickAt, dragAt, escape, saveAndReload } from "./phase2-lib.ts";

mkdirSync(".orca-reports/tmp", { recursive: true });
const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);
const out: Record<string, unknown> = {};

// перегородка внутри комнаты (та же геометрия, что у проб 354)
await switchSheet(page, "create_walls");
await pickTool(page, "wall_create_pgb");
await dragAt(page, { x: 150, y: -290 }, { x: 150, y: -10 });
await escape(page);
let m = await copyServer(page);
const partId = Object.values<any>(m.walls).find((w: any) => w.plan === "c" && Math.abs(w.p1.x - 150) < 1)?.id;
console.log("partition:", partId, partId ? `depth ${m.walls[partId].depth}` : "");
if (!partId) { console.error("перегородка не создана"); process.exit(1); }

// дверь руками в UI на перегородке
await pickTool(page, "door");
await clickAt(page, { x: 150, y: -60 });
await escape(page);
m = await copyServer(page);
const doorUi = Object.values<any>(m.walls[partId].holes ?? {})[0];
console.log("UI door on partition:", doorUi ? `${doorUi.id}:${doorUi.type}:${doorUi.width}x${doorUi.height}` : "НЕТ");
out["ui_door"] = doorUi ?? null;

// окно руками в UI на перегородке
await pickTool(page, "window");
await clickAt(page, { x: 150, y: -230 });
await escape(page);
m = await copyServer(page);
const windowUi = Object.values<any>(m.walls[partId].holes ?? {}).find((h: any) => h.id !== doorUi?.id);
console.log("UI window on partition:", windowUi ? `${windowUi.id}:${windowUi.type}:${windowUi.width}x${windowUi.height}` : "НЕТ");
out["ui_window"] = windowUi ?? null;

// doorway (проём без заполнения) руками в UI на перегородке
const toolDoorway = await pickTool(page, "doorway");
console.log("doorway tool:", toolDoorway);
if (toolDoorway === "ok") {
  await clickAt(page, { x: 150, y: -160 });
  await escape(page);
  m = await copyServer(page);
  const doorwayUi = Object.values<any>(m.walls[partId].holes ?? {}).find((h: any) => h.id !== doorUi?.id && h.id !== windowUi?.id);
  console.log("UI doorway on partition:", doorwayUi ? `${doorwayUi.id}:${doorwayUi.type}:${doorwayUi.width}` : "НЕТ");
  out["ui_doorway"] = doorwayUi ?? null;
}

// список полей, которые редактор сохранил у проёмов перегородки
m = await copyServer(page);
const holes = Object.values<any>(m.walls[partId].holes ?? {});
out["ui_hole_keys"] = holes.map((h) => ({ type: h.type, keys: Object.keys(h) }));
for (const h of holes) {
  console.log(`UI ${h.type} fields: ${Object.keys(h).join(",")}`);
  console.log(`  l1=${JSON.stringify(h.l1)} r1=${JSON.stringify(h.r1)} f0offset=${JSON.stringify(h.f0offset)} at=${JSON.stringify(h.at)}`);
}

// штатный save/reload UI-проекта с дверью и окном на перегородке — эталонround-trip
const saved = await saveAndReload(page);
console.log("save result:", JSON.stringify(saved.result));
m = await copyServer(page);
const holesAfterReload = Object.values<any>(m.walls[partId]?.holes ?? {});
console.log("holes after save+reload:", holesAfterReload.map((h: any) => `${h.id}:${h.type}`).join(" | "));
out["holes_after_reload"] = holesAfterReload;

// — живое воспроизведение падения 356: проём, записанный как пишет MCP (без точек) —
// та же форма, которую кладёт addOpening на plan:c (pc/p1/p2/width/height/depth/…, без l1).
// ВАЖНО: holes_get выполняется только для стен, доступных на текущем листе, поэтому
// падение ловим с листа plan:"a" (init), как при save MCP — в 356 страница была не на
// листе «Перегородки», и setHolesFloor0Offset обошёл перегородку с проёмом без точек.
const crash = await page.evaluate((partId: string) => {
  const w: any = window as any;
  const wall = w.WALLS[partId];
  const id = w.LIB.id();
  const pc = { x: 150, y: -190 };
  const hole: any = {
    id, plan: "c", type: "single", group: "doors", pc, width: 80, height: 210, depth: 4,
    at: 110, opening: "r-l", casing: 1, casements: 1, slope_angle: 0,
    p1: { x: 150, y: -180 }, p2: { x: 150, y: -100 },
  };
  wall.holes[id] = hole;
  return id;
}, partId);
await switchSheet(page, "init");
const crashResult = await page.evaluate(() => {
  const w: any = window as any;
  try {
    w.$Project.draw({ rooms: 1 });
    return { crashed: false };
  } catch (e: any) {
    return { crashed: true, name: e?.name, message: e?.message, stack: String(e?.stack ?? "").split("\n").slice(0, 4).join(" | ") };
  }
});
console.log("MCP-shaped hole on plan a, draw:", JSON.stringify(crashResult));
out["mcp_shaped_hole"] = { crashed: crashResult.crashed, name: crashResult.name, message: crashResult.message, stack: crashResult.stack };

// и тот же проём после дописывания точек (как после фикса) — draw проходит
const fixed = await page.evaluate((holeId: string) => {
  const w: any = window as any;
  const wall = Object.values<any>(w.WALLS).find((wl: any) => wl.holes && wl.holes[holeId]);
  const h = wall.holes[holeId];
  const dx = h.p2.x - h.p1.x, dy = h.p2.y - h.p1.y;
  const len = Math.hypot(dx, dy);
  const ox = (wall.depth / 2) * dy / len, oy = -(wall.depth / 2) * dx / len;
  h.l1 = { x: h.p1.x + ox, y: h.p1.y + oy };
  h.l2 = { x: h.p2.x + ox, y: h.p2.y + oy };
  h.r1 = { x: h.p1.x - ox, y: h.p1.y - oy };
  h.r2 = { x: h.p2.x - ox, y: h.p2.y - oy };
  try {
    w.$Project.draw({ rooms: 1 });
    return { crashed: false };
  } catch (e: any) {
    return { crashed: true, message: e?.message };
  }
}, crash);
console.log("MCP-shaped hole + edge points draw:", JSON.stringify(fixed));
out["fixed_draw"] = fixed;

writeFileSync(".orca-reports/tmp/359-ui-ref-partition-holes.json", JSON.stringify(out, null, 1) + "\n");
console.log("written: .orca-reports/tmp/359-ui-ref-partition-holes.json");
await browser.close();
process.exit(fixed.crashed || !out["ui_door"] ? 1 : 0);
