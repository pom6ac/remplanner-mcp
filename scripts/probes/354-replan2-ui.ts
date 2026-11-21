// 354: эталоны UI «Перепланировка ч.2» — обшивка ГКЛ (gypsum_cladding), замена
// исходной двери (полная форма замены), демонтаж участка на перегородке (plan:c),
// дверь на перегородке. Анонимный проект, синтетическая база, без save
// (модель читается copy("server")). Запуск: node scripts/probes/354-replan2-ui.ts
import { launch, newAnonProject, buildBase, copyServer, switchSheet, pickTool, clickAt, dragAt, escape, diffModels } from "./phase2-lib.ts";

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

// — наличие кнопки и PRO-статус gypsum_cladding —
const btn = await page.evaluate(() => {
  const el: any = document.querySelector("#plannertool_gypsum_cladding");
  if (!el) return { present: false };
  const group: any = el.closest(".tools_item, .subtools_item");
  return { present: true, is_pro: el.classList.contains("is_pro") || Boolean(group?.classList?.contains("is_pro")) };
});
out["S00_button"] = btn;
console.log("gypsum_cladding button:", JSON.stringify(btn));

// — перегородка для проб демонтажа (лист create_walls) —
await switchSheet(page, "create_walls");
await step("S01_partition", async () => {
  await pickTool(page, "wall_create_pgb");
  await dragAt(page, { x: 500, y: -290 }, { x: 500, y: -10 });
});
const part = await copyServer(page);
const wallsAfterS1 = ((out["S01_partition"] as any).walls?.added ?? {}) as Record<string, any>;
const partId = Object.keys(wallsAfterS1)[0];
console.log("partition id:", partId);

// S02: обшивка ГКЛ — линия внутри левой верхней комнаты
await step("S02_cladding_line", async () => {
  const st = await pickTool(page, "gypsum_cladding");
  console.log("pickTool gypsum_cladding:", st);
  if (st === "ok") {
    await clickAt(page, { x: 100, y: -150 });
    await clickAt(page, { x: 250, y: -150 });
  }
});

// S03: вторая линия, пересекающая первую — редактор должен отказать
await step("S03_cladding_cross", async () => {
  const st = await pickTool(page, "gypsum_cladding");
  if (st === "ok") {
    await clickAt(page, { x: 180, y: -280 });
    await clickAt(page, { x: 180, y: -20 });
  }
});

// S04: замена исходной двери проёмом plan:c — полная форма
await switchSheet(page, "init");
await step("S04_place_door", async () => {
  await pickTool(page, "door");
  await clickAt(page, { x: 350, y: 0 });
});
const doors = await copyServer(page);
const corridorWallId = Object.values<any>(base.walls).find((w: any) => Math.abs(w.p1.y) < 0.01 && Math.abs(w.p2.y) < 0.01)?.id;
const doorHoles = Object.values<any>(doors.walls[corridorWallId!]?.holes ?? {});
console.log("door holes:", doorHoles.length, doorHoles.map((h: any) => `${h.id}:${h.type}:${h.width}x${h.height}`).join(" | "));
await switchSheet(page, "create_walls");
await step("S05_replace_door", async () => {
  await pickTool(page, "doorway");
  await clickAt(page, { x: 350, y: 0 });
});

// S06: демонтаж участка на ПЕРЕГОРОДКЕ (break_part поверх plan:c) — разрешено ли
await switchSheet(page, "break_walls");
await step("S06_break_part_partition", async () => {
  await pickTool(page, "break_part");
  await dragAt(page, { x: 500, y: -250 }, { x: 500, y: -150 });
});

// S07: демонтаж перегородки ЦЕЛИКОМ (break) — ожидаем отказ
await step("S07_break_whole_partition", async () => {
  await pickTool(page, "break");
  await clickAt(page, { x: 500, y: -100 });
});

// S08: дверь на перегородке (лист create_walls)
await switchSheet(page, "create_walls");
await step("S08_door_on_partition", async () => {
  await pickTool(page, "door");
  await clickAt(page, { x: 500, y: -250 });
});

// S09: окно поверх двери — редактор пропускает?
await step("S09_window_over_door", async () => {
  await pickTool(page, "window");
  await clickAt(page, { x: 350, y: 0 });
});

console.log("=== RESULT ===");
const { writeFileSync } = await import("node:fs");
writeFileSync(".orca-reports/tmp/354-ui-result.json", JSON.stringify(out, null, 1));
console.log("written .orca-reports/tmp/354-ui-result.json");
await browser.close();
process.exit(0);
