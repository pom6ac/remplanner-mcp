// 94: проба — поведение отделки при split комнаты (новая стена) и при удалении стены (merge).
// Анонимный проект. Запуск: node scripts/probes/94-finish-split.ts
import { launch, newAnonProject, buildBase, copyServer, writeOut, switchSheet } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);
await switchSheet(page, "floor");
const base = await copyServer(page);

const rooms = Object.values<any>(base.rooms2 ?? {});
rooms.sort((a: any, b: any) => (b.area ?? 0) - (a.area ?? 0));
const roomA = rooms[0];
const floor = {
  exist: true, id: "_t94fl01", polygon: structuredClone(roomA.polygon), cover: "laminate",
  angle: 0, pc: structuredClone(roomA.pc), width: 120, height: 18, stitch_width: 0.2, f0offset: 0, type_laying: "1/2",
};
const edge0 = roomA.edges[0];
const decorPart = {
  id: "_t94dc01", type: "wallpaper", layer: 1,
  line: structuredClone(edge0.p1 ? { p1: edge0.p1, p2: edge0.p2 } : edge0),
  line_wall: structuredClone(edge0.p1 ? { p1: edge0.p1, p2: edge0.p2 } : edge0),
  distance: edge0.length, height: 0, height_from_floor: 0, patch: 4, floor_offset: 0,
  line_decor: structuredClone(edge0.p1 ? { p1: edge0.p1, p2: edge0.p2 } : edge0),
};
const mutated = structuredClone(base);
const ra = mutated.rooms2[roomA.id];
ra.floors = [floor];
const decors = [...(ra.decors ?? [])];
while (decors.length < ra.edges.length) decors.push({ exist: false });
decors[0] = { exist: true, parts: { [decorPart.id]: decorPart } };
ra.decors = decors;

async function restoreDraw(model: any): Promise<any> {
  await page.evaluate((arg: unknown) => { (window as any).__remplanner_arg = arg; }, { model });
  return page.evaluate(() => new Promise<any>((resolve) => {
    const w: any = window;
    const model = (w as any).__remplanner_arg.model;
    let restoreError: string | null = null;
    try { w.$Project.restore(structuredClone(model), { reset: 1 }); } catch (e: any) { restoreError = String(e?.message ?? e); }
    try { w.$Project.draw({ rooms: 1 }); } catch (e: any) { restoreError = `${restoreError} draw:${e?.message ?? e}`; }
    setTimeout(() => {
      let copy: any = null;
      try { copy = JSON.parse(JSON.stringify(w.project.copy("server"))); } catch (e: any) { restoreError = `${restoreError} copy:${e?.message ?? e}`; }
      resolve({ restoreError, copy });
    }, 1500);
  }));
}

// --- Тест 1: split комнаты A вертикальной стеной x=150 (комната A была 10..290 по x)
const withWall = structuredClone(mutated);
const tpl = Object.values<any>(mutated.walls).find((w: any) => Math.abs(w.p1.x - 500) < 1)!;
const nw = structuredClone(tpl);
nw.id = "_t94spl1";
nw.p1 = { ...nw.p1, x: 150, y: -290 };
nw.p2 = { ...nw.p2, x: 150, y: -10 };
nw.holes = {};
withWall.walls["_t94spl1"] = nw;
const r1 = await restoreDraw(withWall);
console.log("split restoreError:", r1.restoreError);
const after1: any = r1.copy;
const roomsAfter = Object.values<any>(after1.rooms2 ?? {});
const finishInfo = (r: any) => ({
  area: Math.round((r.area ?? 0) * 10) / 10,
  floors: (r.floors ?? []).map((f: any) => f.exist ? f.cover : false),
  ceilings: (r.ceilings ?? []).map((c: any) => c.exist ? c.material : false),
  decors: (r.decors ?? []).map((d: any) => d.exist ? Object.values<any>(d.parts ?? {}).map((p: any) => p.type).join("+") : false),
});
console.log("after split rooms:", JSON.stringify(roomsAfter.map((r: any) => ({ id: r.id, ...finishInfo(r) }))));
writeOut("94-finish-split", { rooms: roomsAfter.map((r: any) => ({ id: r.id, ...finishInfo(r) })) });

// --- Тест 2: merge — удалить перегородку между A и соседней комнатой
const wallIds = Object.keys(after1.walls ?? {});
// найдём внутреннюю перегородку (part1: ось x=300)
const merged0 = structuredClone(mutated);
const part1 = Object.values<any>(merged0.walls).find((w: any) => Math.abs(w.p1.x - 300) < 1 && Math.abs(w.p2.x - 300) < 1);
console.log("part1 found:", part1 ? part1.id : null);
if (part1) {
  const merged = merged0;
  delete merged.walls[part1.id];
  const r2 = await restoreDraw(merged);
  console.log("merge restoreError:", r2.restoreError);
  const after2: any = r2.copy;
  const roomsAfter2 = Object.values<any>(after2.rooms2 ?? {});
  console.log("after merge rooms:", JSON.stringify(roomsAfter2.map((r: any) => ({ id: r.id, ...finishInfo(r) }))));
  writeOut("94-finish-merge", { rooms: roomsAfter2.map((r: any) => ({ id: r.id, ...finishInfo(r) })) });
}

// --- Тест 3: перенос стены (сдвиг перегородки part2 на 10 см)
const part2 = Object.values<any>(mutated.walls).find((w: any) => Math.abs(w.p1.x - 500) < 1);
if (part2) {
  const shifted = structuredClone(mutated);
  shifted.walls[part2.id].p1.x = 490;
  shifted.walls[part2.id].p2.x = 490;
  const r3 = await restoreDraw(shifted);
  console.log("shift restoreError:", r3.restoreError);
  const after3: any = r3.copy;
  const roomsAfter3 = Object.values<any>(after3.rooms2 ?? {});
  console.log("after shift rooms:", JSON.stringify(roomsAfter3.map((r: any) => ({ id: r.id, ...finishInfo(r) }))));
  writeOut("94-finish-shift", { rooms: roomsAfter3.map((r: any) => ({ id: r.id, ...finishInfo(r) })) });
}
await browser.close();
process.exit(0);
