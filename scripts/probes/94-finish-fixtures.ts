// 94: эталоны UI раздела «Отделка» — покрытие пола, потолка и отделка стены кликами UI.
// Анонимный проект, синтетическая база. Запуск: node scripts/probes/94-finish-fixtures.ts
import { launch, newAnonProject, buildBase, copyServer, switchSheet, pickTool, clickAt, writeOut, escape } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);
await switchSheet(page, "floor");
const base = await copyServer(page);

const inPoly = (poly: { x: number; y: number }[], p: { x: number; y: number }): boolean => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i]!.x, yi = poly[i]!.y, xj = poly[j]!.x, yj = poly[j]!.y;
    if ((yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
const roomAt = (m: any, p: { x: number; y: number }): any =>
  Object.values<any>(m.rooms2 ?? {}).find((r: any) => inPoly(r.polygon ?? r.points ?? [], p));

// 1) пол: laminate в комнату A (клик в центре комнаты)
await pickTool(page, "laminate");
await clickAt(page, { x: 150, y: -150 });
await escape(page);
let mid = await copyServer(page);
const floorRoom = roomAt(mid, { x: 150, y: -150 });

// 2) потолок: paint_ceiling в комнату B
await switchSheet(page, "ceiling");
await pickTool(page, "paint_ceiling");
await clickAt(page, { x: 400, y: -150 });
await escape(page);
mid = await copyServer(page);
const ceilingRoom = roomAt(mid, { x: 400, y: -150 });

// 3) стена: wallpaper на сторону верхней несущей стены из комнаты A (клик в комнате у ребра)
await switchSheet(page, "walls");
await pickTool(page, "wallpaper");
await clickAt(page, { x: 150, y: -260 });
await escape(page);
const fin = await copyServer(page);
const decorRoom = roomAt(fin, { x: 150, y: -150 });

// идём по рёбрам комнаты A: какой decor появился
const decors = (decorRoom.decors ?? []).map((d: any, i: number) => ({ i, exist: d.exist, parts: d.exist ? d.parts : null }));
const edgeIdx = decors.findIndex((d: any) => d.exist);
console.log("decor on edge", edgeIdx, "of", (decorRoom.edges ?? []).length);

// обезличивание: id → подстановки, pid стены → "0", room id → "0"
const wallPidTop = (decorRoom.edges ?? [])[edgeIdx]?.pid;
writeOut("94-finish-fixtures", {
  floor: floorRoom.floors?.[0],
  ceiling: ceilingRoom.ceilings?.[0],
  decor: edgeIdx >= 0 ? decorRoom.decors?.[edgeIdx] : null,
  roomPolygon: floorRoom.polygon,
  wallPidTop,
});
console.log("fixtures captured; wallPidTop:", wallPidTop);
await browser.close();
process.exit(0);
