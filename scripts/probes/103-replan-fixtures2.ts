// 103: эталоны UI «Перепланировка», v2 — все сценарии с исправленными кликами.
// Запуск: node scripts/probes/103-replan-fixtures2.ts
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

// S00: дверь на стене коридора y=0, x=150
await switchSheet(page, "init");
await pickTool(page, "door");
await clickAt(page, { x: 150, y: 0 });
await escape(page);
const doors = await copyServer(page);
const corridorWallId = Object.entries<any>(base.walls).find(([, w]) => Math.abs(w.p1.y) < 1 && Math.abs(w.p2.y) < 1)![0];
const door1 = Object.keys(doors.walls[corridorWallId].holes ?? {})[0];
console.log("door:", corridorWallId, door1);

// S03: демонтаж проёма
await switchSheet(page, "break_walls");
await step("S03_break_door", async () => {
  await pickTool(page, "break_door");
  await clickAt(page, { x: 150, y: 0 });
});

// S01: демонтаж стены целиком (перегородка x=500)
await step("S01_break_whole", async () => {
  await pickTool(page, "break");
  await clickAt(page, { x: 500, y: -150 });
});

// S02: демонтаж участка верхней стены
await step("S02_break_part", async () => {
  await pickTool(page, "break_part");
  await dragAt(page, { x: 50, y: -300 }, { x: 150, y: -300 });
});

// S04: отмена демонтажа перегородки
await step("S04_remove_break", async () => {
  await pickTool(page, "remove_break");
  await clickAt(page, { x: 500, y: -150 });
});

// S08: замена исходной двери проёмом doorway (поверх двери S00)
await switchSheet(page, "create_walls");
await step("S08_doorway_replace", async () => {
  await pickTool(page, "doorway");
  await clickAt(page, { x: 150, y: 0 });
});

// S05: перегородки из четырёх материалов
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

// S06: ГКЛ-короб — варианты: drag из угла, click+click
await step("S06a_box_drag", async () => {
  await pickTool(page, "gypsum_box");
  await dragAt(page, { x: 520, y: -285 }, { x: 570, y: -240 });
});
{
  const m = await copyServer(page);
  if (Object.keys(m.pillars ?? {}).length === 0) {
    await step("S06b_box_clickclick", async () => {
      await pickTool(page, "gypsum_box");
      await clickAt(page, { x: 520, y: -285 });
      await clickAt(page, { x: 570, y: -240 });
    });
  }
}

// S07: зонирование коридора
await step("S07_zone", async () => {
  await pickTool(page, "zone");
  await dragAt(page, { x: 300, y: 12 }, { x: 300, y: 108 });
});

const final = await copyServer(page);
writeOut("103-replan-diffs2", {
  baseWalls: Object.fromEntries(Object.entries(base.walls as Record<string, any>).map(([k, w]) => [k, { p1: w.p1, p2: w.p2, plan: w.plan, material: w.material }])),
  corridorWallId, door1,
  diffs: out,
});
writeOut("103-replan-final-model2", final);
await browser.close();
process.exit(0);
