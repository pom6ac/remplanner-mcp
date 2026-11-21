// 354 #4: модельный раунд-трип — сектор на перегородке, линия обшивки ГКЛ,
// наследование геометрии замены (replacement=1) при restore/save.
import { launch, newAnonProject, buildBase, copyServer, switchSheet, pickTool, clickAt, dragAt, escape, saveAndReload } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);
const out: Record<string, unknown> = {};

// перегородка внутри верхней левой комнаты
await switchSheet(page, "create_walls");
await pickTool(page, "wall_create_pgb");
await dragAt(page, { x: 150, y: -290 }, { x: 150, y: -10 });
await escape(page);
let m = await copyServer(page);
const partId = Object.values<any>(m.walls).find((w: any) => w.plan === "c" && Math.abs(w.p1.x - 150) < 1)?.id;
console.log("partition:", partId);

// дверь на перегородке
await pickTool(page, "door");
await clickAt(page, { x: 150, y: -60 });
await escape(page);
m = await copyServer(page);
const partHoles = Object.values<any>(m.walls[partId!]?.holes ?? {});
console.log("door on partition:", partHoles.map((h: any) => `${h.id}:${h.type}:${h.width}x${h.height}`).join(" | "));
const doorId = partHoles[0]?.id;

// дверь 90 шириной на коридорной стене (для теста наследования)
await switchSheet(page, "init");
await pickTool(page, "door");
await clickAt(page, { x: 350, y: 0 });
await escape(page);
m = await copyServer(page);
const corrId = Object.values<any>(m.walls).find((w: any) => Math.abs(w.p1.y) < 0.01 && Math.abs(w.p2.y) < 0.01)?.id;
const door90 = Object.values<any>(m.walls[corrId!]?.holes ?? {}).find((h: any) => Math.abs(h.pc.x - 350) < 2);
// расширить до 90
await page.evaluate((hid: string) => {
  const w: any = window as any;
  const wall = Object.values<any>(w.WALLS).find((wl: any) => wl.holes && wl.holes[hid]);
  const h = wall.holes[hid];
  h.width = 90;
  wall.draw();
  w.$Project.draw({ rooms: 1 });
}, door90.id);
m = await copyServer(page);
const door90b = Object.values<any>(m.walls[corrId!]?.holes ?? {}).find((h: any) => h.id === door90.id);
console.log("door90 width now:", door90b?.width, door90b?.p1, door90b?.p2);

// doorway plan:c по центру двери (ширина 80 — меньше исходной) c replacement=1
await page.evaluate((hid: string) => {
  const w: any = window as any;
  const wall = Object.values<any>(w.WALLS).find((wl: any) => wl.holes && wl.holes[hid]);
  const orig = wall.holes[hid];
  const id = w.LIB.id();
  const pc = { x: (orig.p1.x + orig.p2.x) / 2, y: orig.pc.y };
  const hole: any = {
    id, plan: "c", type: "doorway", group: "doors", pc, width: 80, height: 210, depth: 4,
    position: "c", offset: 0, parent: wall.id, parent_depth: wall.depth, dls_prs: {},
    slope_angle: 0, casing: 0, casements: 1, replacement: 1,
  };
  const p1 = { x: pc.x - 40, y: pc.y }, p2 = { x: pc.x + 40, y: pc.y };
  hole.p1 = p1; hole.p2 = p2;
  hole.pcb = { x: pc.x, y: pc.y + wall.depth / 2 };
  hole.p1b = { x: p1.x, y: pc.y + wall.depth / 2 };
  hole.p2b = { x: p2.x, y: pc.y + wall.depth / 2 };
  orig.hasReplacement = 1;
  wall.holes[id] = hole;
  wall.draw();
  w.$Project.draw({ rooms: 1 });
}, door90.id);
m = await copyServer(page);
const afterAdd = Object.values<any>(m.walls[corrId!]?.holes ?? {}).map((h: any) => ({ id: h.id, plan: h.plan, type: h.type, w: h.width, h: h.height, repl: h.replacement, hasRepl: h.hasReplacement }));
console.log("holes after add:", JSON.stringify(afterAdd));
out["holes_after_add"] = afterAdd;

// сектор на перегородке + линия обшивки (прямая запись, как UI делает)
await page.evaluate((partId: string) => {
  const w: any = window as any;
  const wall = w.WALLS[partId];
  const sid = w.LIB.id();
  const p1 = wall.p1, p2 = wall.p2;
  const t = 0.3; // 30% вдоль оси (юнит оси — см от p1)
  const pc = { x: p1.x + (p2.x - p1.x) * t, y: p1.y + (p2.y - p1.y) * t };
  wall.sectors[sid] = { id: sid, pc, width: 50 };
  w.$Claddings.addLine({ id: w.LIB.id(), p1: { x: 60, y: 60 }, p2: { x: 200, y: 60 } });
  w.$Project.draw({ rooms: 1, save: 1 });
}, partId);
m = await copyServer(page);
console.log("partition sectors after:", JSON.stringify(m.walls[partId!]?.sectors ?? null));
console.log("claddings after:", JSON.stringify(m.claddings ?? null));
out["sectors_on_partition"] = m.walls[partId!]?.sectors ?? null;
out["claddings"] = m.claddings ?? null;

// — save → reload → сверка —
const before = await copyServer(page);
const sv = await saveAndReload(page);
out["save"] = { result: sv.result };
const after = await copyServer(page);
out["persist"] = {
  sectors: { before: before.walls[partId!]?.sectors ?? null, after: after.walls[partId!]?.sectors ?? null },
  claddings: { before: before.claddings ?? null, after: after.claddings ?? null },
  holes: {
    before: Object.values<any>(before.walls[corrId!]?.holes ?? {}).map((h: any) => ({ plan: h.plan, type: h.type, w: h.width, h: h.height, repl: h.replacement ?? null, hasRepl: h.hasReplacement ?? null })),
    after: Object.values<any>(after.walls[corrId!]?.holes ?? {}).map((h: any) => ({ plan: h.plan, type: h.type, w: h.width, h: h.height, repl: h.replacement ?? null, hasRepl: h.hasReplacement ?? null })),
  },
};
console.log("PERSIST:", JSON.stringify(out["persist"], null, 1).slice(0, 2500));
const { writeFileSync } = await import("node:fs");
writeFileSync(".orca-reports/tmp/354-ui4-result.json", JSON.stringify(out, null, 1));
await browser.close();
process.exit(0);
