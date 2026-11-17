// 103: эталоны UI раздела «Перепланировка» — демонтаж и перегородки кликами UI.
// Анонимный проект, синтетическая база «коридор + 3 комнаты». Без save (модель читается copy("server")).
// Запуск: node scripts/probes/103-replan-fixtures.ts
import { launch, newAnonProject, buildBase, copyServer, switchSheet, pickTool, clickAt, dragAt, writeOut, diffModels, escape } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);
await switchSheet(page, "break_walls");
const base = await copyServer(page);
const out: Record<string, unknown> = {};
const step = async (name: string, fn: () => Promise<void>) => {
  const before = await copyServer(page);
  await fn();
  await escape(page);
  const after = await copyServer(page);
  const d = diffModels(before, after);
  out[name] = d;
  console.log(name, "diff keys:", Object.keys(d).join(",") || "(none)");
  return d;
};

// S00: две двери на стене коридора y=0 (x=150 и x=350)
await switchSheet(page, "init");
await pickTool(page, "door");
await clickAt(page, { x: 150, y: 0 });
await clickAt(page, { x: 350, y: 0 });
await escape(page);
const doors = await copyServer(page);
// найти id проёмов на стене коридора
const corridorWallId = Object.values<any>(base.walls).find((w: any) =>
  Math.abs(w.p1.y - 0) < 0.01 && Math.abs(w.p2.y - 0) < 0.01)?.id;
const doorHoles = Object.values<any>(doors.walls[corridorWallId!]?.holes ?? {});
console.log("door holes on corridor wall:", doorHoles.length, doorHoles.map((h: any) => h.id).join(","));
const door1 = doorHoles[0]?.id, door2 = doorHoles[1]?.id;

// S08: замена исходной двери — инструмент doorway поверх второй двери (лист create_walls)
await switchSheet(page, "create_walls");
await step("S08_doorway_replace", async () => {
  await pickTool(page, "doorway");
  await clickAt(page, { x: 350, y: 0 });
});

// S03: демонтаж проёма — break_door поверх первой двери
await switchSheet(page, "break_walls");
await step("S03_break_door", async () => {
  await pickTool(page, "break_door");
  await clickAt(page, { x: 150, y: 0 });
});

// S01: демонтаж стены целиком — break по перегородке part2 (x=500)
await step("S01_break_whole", async () => {
  await pickTool(page, "break");
  await clickAt(page, { x: 500, y: -150 });
});

// S02: демонтаж участка — break_part протяжкой по верхней стене y=-300 от x=50 до x=150
await step("S02_break_part", async () => {
  await pickTool(page, "break_part");
  await dragAt(page, { x: 50, y: -300 }, { x: 150, y: -300 });
});

// S04: отмена демонтажа — remove_break по перегородке part2
await step("S04_remove_break", async () => {
  await pickTool(page, "remove_break");
  await clickAt(page, { x: 500, y: -150 });
});

// S05: перегородки из разных материалов (лист create_walls)
await switchSheet(page, "create_walls");
await step("S05a_wall_gypsum", async () => {
  await pickTool(page, "wall_create_gypsum");
  await dragAt(page, { x: 150, y: -290 }, { x: 150, y: -10 });
});
await step("S05b_wall_pgb", async () => {
  await pickTool(page, "wall_create_pgb");
  await dragAt(page, { x: 400, y: -290 }, { x: 400, y: -10 });
});
await step("S05c_wall_blocks", async () => {
  await pickTool(page, "wall_create_blocks");
  await dragAt(page, { x: 50, y: -150 }, { x: 250, y: -150 });
});
await step("S05d_wall_bricks", async () => {
  await pickTool(page, "wall_create_bricks");
  await dragAt(page, { x: 200, y: 60 }, { x: 400, y: 60 });
});

// S06: ГКЛ-короб в углу комнаты C
await step("S06_gypsum_box", async () => {
  await pickTool(page, "gypsum_box");
  await clickAt(page, { x: 545, y: -280 });
});

// S07: зонирование коридора — линия zone от (300,10) до (300,110)
await step("S07_zone", async () => {
  await pickTool(page, "zone");
  await dragAt(page, { x: 300, y: 10 }, { x: 300, y: 110 });
});

// Влияние демонтажа перегородки на комнаты плана c: повторный break по part2
const beforeFinal = await copyServer(page);
await step("S09_break_part2_again", async () => {
  await pickTool(page, "break");
  await clickAt(page, { x: 500, y: -150 });
});
const final = await copyServer(page);

writeOut("103-replan-diffs", {
  baseWalls: Object.fromEntries(Object.entries(base.walls as Record<string, any>).map(([k, w]) => [k, { p1: w.p1, p2: w.p2, plan: w.plan, material: w.material }])),
  corridorWallId, door1, door2,
  doorHole: doorHoles[0] ?? null,
  diffs: out,
});
writeOut("103-replan-final-model", final);
await browser.close();
process.exit(0);
