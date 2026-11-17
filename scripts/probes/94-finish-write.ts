// 94: проба феасибилити — запись отделки в модель (rooms2) и приём её редактором
// через restore+draw. Анонимный проект. Запуск: node scripts/probes/94-finish-write.ts
import { launch, newAnonProject, buildBase, copyServer, writeOut, switchSheet } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);
await switchSheet(page, "floor");
const base = await copyServer(page);

// комнаты: найдём самую большую
const rooms = Object.values<any>(base.rooms2 ?? {});
rooms.sort((a: any, b: any) => (b.area ?? 0) - (a.area ?? 0));
const roomA = rooms[0];
console.log("room:", roomA.id, "area", roomA.area, "edges", (roomA.edges ?? []).length, "decors", (roomA.decors ?? []).length);

// 1) пол: каноническая запись в floors[0]
const floor = {
  exist: true,
  id: "_t94fl01",
  polygon: structuredClone(roomA.polygon ?? roomA.points),
  cover: "laminate",
  angle: 0,
  pc: structuredClone(roomA.pc),
  width: 120,
  height: 18,
  stitch_width: 0.2,
  f0offset: 0,
  type_laying: "1/2",
};
// 2) потолок: material в ceilings[0]
const ceiling = {
  exist: true,
  id: "_t94ce01",
  polygon: structuredClone(roomA.polygon ?? roomA.points),
  pc: structuredClone(roomA.pc),
  edges: structuredClone(roomA.edges ?? []),
  level: 0,
  material: "paint_ceiling",
  profile: "standard",
  area_niches: 0,
  complex: false,
  area_childs: {},
  polygons_layout: [],
  polygons_layout_points: [],
  niches: (roomA.edges ?? []).map(() => ({ exist: false })),
  width: 0,
  height: 0,
};
// 3) отделка стены: decor на ребро 0 комнаты
const edge = (roomA.edges ?? [])[0];
const decorPart = {
  id: "_t94dc01",
  type: "wallpaper",
  layer: 1,
  line: { p1: structuredClone(edge.p1), p2: structuredClone(edge.p2) },
  line_wall: { p1: structuredClone(edge.p1), p2: structuredClone(edge.p2) },
  distance: edge.length,
  height: 0,
  height_from_floor: 0,
  patch: 4,
  floor_offset: 0,
  line_decor: { p1: structuredClone(edge.p1), p2: structuredClone(edge.p2) },
};
const decor = { exist: true, parts: { [decorPart.id]: decorPart } };

const mutated = structuredClone(base);
const ra = mutated.rooms2[roomA.id];
ra.floors = [floor, ...((ra.floors ?? []).slice(1))];
ra.ceilings = [ceiling, ...((ra.ceilings ?? []).slice(1))];
const decors = [...(ra.decors ?? [])];
while (decors.length < (ra.edges ?? []).length) decors.push({ exist: false });
decors[0] = decor;
ra.decors = decors;

// restore+draw в странице
await page.evaluate((arg: unknown) => {
  (window as any).__remplanner_arg = arg;
}, { model: mutated });
const out = await page.evaluate(() => new Promise<any>((resolve) => {
  const w: any = window;
  const model = (w as any).__remplanner_arg.model;
  let restoreError: string | null = null;
  try {
    w.$Project.restore(structuredClone(model), { reset: 1 });
  } catch (e: any) {
    restoreError = String(e && e.message || e);
  }
  try { w.$Project.draw({ rooms: 1 }); } catch (e: any) { restoreError = String(restoreError || "") + " draw:" + String(e && e.message || e); }
  setTimeout(() => {
    let copy: any = null;
    try { copy = JSON.parse(JSON.stringify(w.project.copy("server"))); } catch (e: any) { restoreError = String(restoreError || "") + " copy:" + String(e && e.message || e); }
    resolve({ restoreError, copy });
  }, 1500);
}));
console.log("restoreError:", out.restoreError);
const after = out.copy;
const ra2 = after?.rooms2?.[roomA.id];
writeOut("94-finish-write", { after: ra2 });
console.log("floors:", JSON.stringify((ra2?.floors ?? []).map((f: any) => ({ exist: f.exist, cover: f.cover, width: f.width, height: f.height, stitch: f.stitch_width, lay: f.type_laying, angle: f.angle, poly: (f.polygon ?? []).length }))));
console.log("ceilings:", JSON.stringify((ra2?.ceilings ?? []).map((c: any) => ({ exist: c.exist, material: c.material, level: c.level, profile: c.profile }))));
console.log("decors:", JSON.stringify((ra2?.decors ?? []).map((d: any) => d.exist ? Object.keys(d.parts ?? {}) : false)));
const d0 = (ra2?.decors ?? [])[0];
if (d0?.exist) console.log("decor0:", JSON.stringify(d0).slice(0, 700));
await browser.close();
process.exit(0);
