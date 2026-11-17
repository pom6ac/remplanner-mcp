// 122: круг restore → draw нормализатором редактора (анонимно, без save) для сущностей климата:
// warm_floors (кабельный + водяной), климат-предметы, трубы 4 коллекций (plain edges и вент с width/height).
// Вопросы: что дописывает/пересчитывает редактор (комментарий «Внешний блок», length_pipes, width/type/height воздуховодов, vd и т.п.).
import { launch, newAnonProject, buildBase, copyServer, writeOut, OUT_DIR } from "./phase2-lib.ts";
import { writeFileSync } from "node:fs";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);
const base = await copyServer(page);

// комнаты: A (верхняя левая) 0..300 x -300..0, B (верхняя правая) 300..500 x -300..0
const m = structuredClone(base);
const rooms = Object.entries<any>(m.rooms2 ?? {}).map(([rid, r]) => ({ rid, poly: r.polygon, area: r.area }));
// находим комнаты по центрам
const roomAt = (x: number, y: number) => rooms.find((r) => {
  const xs = r.poly.map((p: any) => p.x), ys = r.poly.map((p: any) => p.y);
  return x > Math.min(...xs) && x < Math.max(...xs) && y > Math.min(...ys) && y < Math.max(...ys);
})?.rid;
const roomA = roomAt(150, -150);
const roomB = roomAt(400, -150);
console.log("roomA:", roomA, "roomB:", roomB);

function ring(pts: { x: number; y: number }[]) {
  const n = pts.length;
  const matrix = Array.from({ length: n }, () => Array.from({ length: n }, () => null));
  for (let i = 0; i < n; i++) { matrix[i][(i + 1) % n] = { length: 1 }; matrix[(i + 1) % n][i] = { length: 1 }; }
  return matrix;
}
function wf(id: string, type: string, x1: number, y1: number, x2: number, y2: number, roomId: string, extra: any = {}) {
  const pts = [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }];
  const vertexes = pts.map((p) => ({ id: `_v${id}${p.x}${p.y > 0 ? "a" : "b"}`.slice(0, 8), point: p, type: "node" }));
  return {
    id, polygon: pts, matrix: ring(pts), vertexes,
    items: Object.fromEntries(vertexes.map((v) => [v.id, "node"])),
    type, length: 2 * (x2 - x1 + y2 - y1) / 100, id_room: roomId,
    props: { id, name: type }, area: (x2 - x1) * (y2 - y1) / 10_000, ...extra,
  };
}

m.warm_floors = {};
{
  const pts = [{ x: 60, y: -240 }, { x: 240, y: -240 }, { x: 240, y: -60 }, { x: 60, y: -60 }];
  m.warm_floors["wfcable"] = {
    id: "wfcable", polygon: pts, matrix: ring(pts),
    vertexes: pts.map((p, i) => ({ id: `_cvf${i}`, point: p, type: "node" })),
    items: Object.fromEntries(pts.map((_, i) => [`_cvf${i}`, "node"])),
    type: "warm_floor", length: 2 * (180 + 180) / 100, id_room: roomA, props: { id: "wfcable", name: "warm_floor" }, area: 3.24,
  };
  const ptsB = [{ x: 330, y: -250 }, { x: 470, y: -250 }, { x: 470, y: -110 }, { x: 330, y: -110 }];
  m.warm_floors["wfwater"] = {
    id: "wfwater", polygon: ptsB, matrix: ring(ptsB),
    vertexes: ptsB.map((_, i) => ({ id: `_wvf${i}`, point: ptsB[i]!, type: "node" })),
    items: Object.fromEntries(ptsB.map((_, i) => [`_wvf${i}`, "node"])),
    type: "warm_floor_water", length: 2 * (140 + 140) / 100, id_room: roomB, props: { id: "wfwater", name: "warm_floor_water" }, area: 1.96,
    step: 10, type_water: "spiral", direction: "right", length_pipes: 15.4,
  };
}

// предметы климата «как item_add»
const wallY = -300 + 10; // внутренняя грань верхней стены
const mkItem = (id: string, name: string, pc: { x: number; y: number }, w: number, h: number, planKey: string, extra: any = {}) => ({
  id, name, pc, angle: 0, width: w, height: h, self_height: 0,
  plan: { [planKey]: 1 }, id_room: roomAt(pc.x, pc.y) ?? null, id_wall: null, layer: null,
  comment: { id: "" }, demount: 0, dimensions: { display: true }, rotated: 0, ...extra,
});
m.items = m.items ?? {};
m.items["cond1"] = mkItem("cond1", "conditioner", { x: 120, y: wallY + 12.5 }, 75, 25, "conditioners", { over_floor: { value: 210, display: false } });
m.items["condEng"] = mkItem("condEng", "conditioner_engine", { x: 220, y: wallY + 12.5 }, 60, 25, "conditioners", { over_floor: { value: 20, display: false }, self_height: 40, dimensions: { display: 0, default_value_set: 1 } });
m.items["floorCond"] = mkItem("floorCond", "floor_conditioner", { x: 150, y: -150 }, 27, 48, "conditioners");
m.items["airCurtain"] = mkItem("airCurtain", "air_curtain", { x: 380, y: wallY + 6.5 }, 77, 13, "conditioners", { over_floor: { value: 250, display: false } });
m.items["rad1"] = mkItem("rad1", "radiator_bimetal", { x: 200, y: wallY + 6 }, 80, 12, "radiators", { over_floor: { value: 10, display: false } });
m.items["fan1"] = mkItem("fan1", "fan", { x: 350, y: -150 }, 40, 40, "ventilation");
// терморегулятор — группа socket_group
m.items["thermo1"] = {
  id: "thermo1", name: "socket_group", pc: { x: 100, y: wallY + 7 }, angle: 180, width: 14, height: 14, self_height: 0,
  plan: { warm_floor: 11 }, id_room: roomA, id_wall: null, layer: null, comment: { id: "" }, demount: 0,
  dimensions: { display: true }, rotated: 0, socket_group: [{ name: "socket_thermo", id: "thermo1s", real_center: { x: 100, y: wallY + 7 }, center: { x: 100, y: wallY + 7 }, center_prs: { x: 100, y: wallY + 7 } }],
  legend: "", over_floor: { value: 90, display: true, vd: 90 },
};

// трубы 4 коллекций — plain edges; вентиляция — два варианта (plain и полный)
const pipe = (id: string, type: string, x1: number, y1: number, x2: number, y2: number, edge: any, extra: any = {}) => ({
  id, matrix: [[null, edge], [edge, null]],
  vertexes: [{ id: `_p${id}a`, point: { x: x1, y: y1 }, type: "node" }, { id: `_p${id}b`, point: { x: x2, y: y2 }, type: "node" }],
  items: { [`_p${id}a`]: "node", [`_p${id}b`]: "node" }, type, length: Math.hypot(x2 - x1, y2 - y1) / 100, ...extra,
});
m.pipes_warm_floor = { "p1": pipe("p1", "warm_floor_pipe", 330, -100, 430, -100, { length: 1 }) };
m.pipes_conditioner = { "p2": pipe("p2", "conditioner_drainage", 120, wallY + 5, 260, wallY + 5, { length: 1 }) };
m.pipes_heat = { "p3": pipe("p3", "heat_pipe_hot", 200, wallY + 8, 280, wallY + 8, { length: 1 }) };
m.pipes_ventilation = {
  "p4": pipe("p4", "ventpipe_out", 350, -200, 450, -200, { length: 1 }, { spots: {} }),
  "p5": pipe("p5", "ventpipe_in", 350, -250, 450, -250, { length: 1, width: 20.4, type: "flat", height: 6 }, { spots: {} }),
};

console.log("restore...");
const res = await page.evaluate((mm) => {
  const w: any = window as any;
  const cur = w.project.copy("server");
  mm.id = cur.id; mm.plan_id = cur.plan_id;
  let err: string | null = null;
  try { w.$Project.restore(mm, { reset: 1 }); w.$Project.draw({ rooms: 1 }); w.project.localSave(); } catch (e: any) { err = String(e?.stack || e).slice(0, 800); }
  return { err, model: JSON.parse(JSON.stringify(w.project.copy("server"))) };
}, m);
console.log("restore error:", res.err);

const after = res.model;
const diff: any = {};
for (const k of ["warm_floors", "pipes_warm_floor", "pipes_conditioner", "pipes_heat", "pipes_ventilation", "items", "comments"]) {
  if (JSON.stringify(base[k] ?? {}) !== JSON.stringify(after[k] ?? {})) diff[k] = { before: base[k] ?? null, after: after[k] ?? null };
}
writeOut("122-norm-check", { restore_error: res.err, diff });
writeFileSync(`${OUT_DIR}/122-norm-check-after.json`, JSON.stringify(after2Clean(res.model), null, 1));
function after2Clean(mm: any) { return mm; }

console.log(JSON.stringify(Object.fromEntries(Object.entries(diff).map(([k, v]: any) => [k, v.after])), null, 1).slice(0, 6000));
await browser.close();
process.exit(0);
