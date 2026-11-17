// 103: дозаправка эталонов — break_radiator (предмет), break_part поверх двери, doorway поверх демонтированного проёма.
// Запуск: node scripts/probes/103-replan-extra.ts
import { launch, newAnonProject, buildBase, copyServer, switchSheet, pickTool, clickAt, dragAt, writeOut, diffModels, escape } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);
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

// E1: радиатор у стены (лист init, инструмент radiator_old — предмет исходного плана)
await switchSheet(page, "init");
await pickTool(page, "radiator_old");
await clickAt(page, { x: 100, y: -280 });
await escape(page);
const items1 = await copyServer(page);
const radiatorId = Object.entries<any>(items1.items ?? {}).find(([, it]: any) => it.name?.includes("radiator"))?.[0];
console.log("radiator item:", radiatorId);

// E2: демонтаж радиатора (лист break_walls, break_radiator)
await switchSheet(page, "break_walls");
if (radiatorId) {
  await step("E2_break_radiator", async () => {
    await pickTool(page, "break_radiator");
    await clickAt(page, { x: 100, y: -280 });
  });
}

// E3: break_part поверх двери (дверь на верхней стене x=400, сектор над ней)
await pickTool(page, "door");
await clickAt(page, { x: 400, y: -300 });
await escape(page);
await step("E3_break_part_over_door", async () => {
  await pickTool(page, "break_part");
  await dragAt(page, { x: 370, y: -300 }, { x: 430, y: -300 });
});

// E4: doorway поверх демонтированного проёма (дверь x=150 → break_door → doorway)
await pickTool(page, "door");
await clickAt(page, { x: 150, y: 0 });
await escape(page);
await pickTool(page, "break_door");
await clickAt(page, { x: 150, y: 0 });
await escape(page);
const mid = await copyServer(page);
const cw = Object.entries<any>(mid.walls).find(([, w]: any) => Math.abs(w.p1.y) < 1 && Math.abs(w.p2.y) < 1);
const doorHole = Object.values<any>(cw![1].holes ?? {}).find((h: any) => h.group === "doors" && Math.abs(h.pc.x - 150) < 5);
console.log("demounted door:", doorHole?.id, "demount=", doorHole?.demount);
await switchSheet(page, "create_walls");
await step("E4_doorway_over_demounted", async () => {
  await pickTool(page, "doorway");
  await clickAt(page, { x: 150, y: 0 });
});

writeOut("103-replan-extra", out);
await browser.close();
process.exit(0);
