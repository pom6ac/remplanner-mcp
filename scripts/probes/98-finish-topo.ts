// 98: эталоны наследования отделки при топологических операциях — НАСТОЯЩИЙ headless
// редактор: restore базы с отделкой → правка живых WALLS (как команды UI) →
// $Project.draw({rooms:1}) → project.copy("server"). Синтетическая база
// «коридор + 3 комнаты» (tests/fixtures/editor-corridor-3rooms.json), БЕЗ сохранения
// на сервер. Анонимный проект, аккаунт не используется.
// Запуск: node scripts/probes/98-finish-topo.ts
import { launch, newAnonProject } from "./phase2-lib.ts";
import { PAGE } from "../../src/editor/inject.js";
import { readFileSync } from "node:fs";

type P = { x: number; y: number };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const browser = await launch();
const page = await newAnonProject(browser);

const fixture = JSON.parse(readFileSync("tests/fixtures/editor-corridor-3rooms.json", "utf8")) as Any;
const base0 = fixture.model;
base0.id = "0";
base0.plan_id = "0";

/** restore базы (сброс живого состояния) и возврат нормализованной копии. */
async function restoreBase(model: Any): Promise<Any> {
  await page.evaluate((arg: unknown) => { (window as any).__remplanner_arg = { model: arg, waitMs: 1500 }; }, structuredClone(model));
  const res = (await page.evaluate(PAGE.restoreDrawCopy)) as Any;
  if (res.restoreError) throw new Error("restore: " + res.restoreError);
  return res.copy;
}

/** Правка живых WALLS + перерисовка комнат + копия. Правки осей делаются на активном
 *  листе «a»; комнаты (ROOMS2, план «c») пересчитываются только на листе полов —
 *  переключаем .groups_navi_item.plan_floor → draw({rooms:1}); затем localSave-опрос,
 *  как в restoreDrawCopy (copy("server") без localSave отстаёт от живых WALLS). */
async function mutateWalls(op: (w: Any) => void): Promise<Any> {
  await page.evaluate((arg: unknown) => { (window as any).__remplanner_arg = arg; }, { op: op.toString() });
  const err = await page.evaluate(() => new Promise<string | null>((resolve) => {
    const w: any = window;
    const fail = (e: any): null => { resolve(String(e?.message ?? e)); return null; };
    try {
      const op = eval(`(${w.__remplanner_arg.op})`);
      op(w.WALLS);
      w.$Project.draw({ rooms: 1 });
    } catch (e: any) { return fail(e); }
    // на листе полов комнаты (ROOMS2, plan "c") пересчитываются из стен
    const nav = document.querySelector(".groups_navi_item.plan_floor") as HTMLElement | null;
    if (!nav) { resolve("nav plan_floor не найден"); return; }
    nav.click();
    setTimeout(() => {
      try { w.$Project.draw({ rooms: 1 }); } catch (e: any) { return fail(e); }
      // опрос: localSave → copy, пока copy не совпадёт с живым состоянием (≤ 8 с)
      let tries = 0;
      const poll = () => {
        tries++;
        try { w.project.localSave(); } catch { /* не критично */ }
        let copy: any = null;
        try { copy = JSON.parse(JSON.stringify(w.project.copy("server"))); } catch { /* */ }
        const wantW = Object.keys(w.WALLS || {}).length;
        const gotW = copy ? Object.keys(copy.walls || {}).length : -1;
        const wantR = Object.keys(w.ROOMS2 || {}).length;
        const gotR = copy ? Object.keys(copy.rooms2 || {}).length : -1;
        if ((gotW === wantW && gotR === wantR && gotW >= 0) || tries >= 20) {
          (w as any).__remplanner_copy = copy;
          resolve(null);
          return;
        }
        setTimeout(poll, 400);
      };
      setTimeout(poll, 1500);
    }, 800);
  }));
  if (err) throw new Error("mutate: " + err);
  return page.evaluate(() => (window as any).__remplanner_copy);
}

const baseN = await restoreBase(base0);
const rooms = Object.values<Any>(baseN.rooms2 ?? {});
const pick = (x: number, y: number): Any => {
  const r = rooms.find((r: Any) => (r.polygon ?? []).some((p: P, i: number, a: P[]) => {
    const q = a[(i + 1) % a.length]!;
    return (p.y > y) !== (q.y > y) && x < ((q.x - p.x) * (y - p.y)) / (q.y - p.y) + p.x;
  }));
  if (!r) throw new Error(`нет комнаты в (${x},${y})`);
  return r;
};
const A = pick(150, -150); // верхняя левая 280×280
const B = pick(400, -150); // верхняя средняя 180×280
const C = pick(550, -150); // верхняя правая 80×280
const ids = { A: A.id, B: B.id, C: C.id };
console.log("rooms:", JSON.stringify(ids), "areas:", rooms.map((r: Any) => r.area).join(","));

const polyOf = (room: Any): P[] => room.polygon ?? [];

function floorEntry(room: Any, cover: string): Any {
  return { exist: true, id: `_t98f${cover}`, polygon: structuredClone(polyOf(room)), cover,
    angle: 0, pc: structuredClone(room.pc ?? null), width: 120, height: 18, stitch_width: 0.2, f0offset: 0, type_laying: "1/2" };
}
function ceilingEntry(room: Any, material = "paint_ceiling"): Any {
  return { exist: true, id: "_t98c1", polygon: structuredClone(polyOf(room)), material, level: 0, profile: "standard" };
}
function decorPart(edge: Any, type = "wallpaper"): Any {
  const line = { p1: { ...edge.p1 }, p2: { ...edge.p2 } };
  return { id: `_t98d${edge.pid}`, type, layer: 1, line, line_wall: structuredClone(line),
    distance: edge.length, height: 0, height_from_floor: 0, patch: 4, floor_offset: 0, line_decor: structuredClone(line) };
}
function setFinish(model: Any, roomId: string, opts: { floor?: string; ceiling?: string; decorPids?: string[] }): void {
  const room = Object.values<Any>(model.rooms2).find((r: Any) => r.id === roomId);
  if (opts.floor) room.floors = [floorEntry(room, opts.floor)];
  if (opts.ceiling) room.ceilings = [ceilingEntry(room, opts.ceiling)];
  if (opts.decorPids) {
    const decors = [...(room.decors ?? [])];
    while (decors.length < (room.edges ?? []).length) decors.push({ exist: false });
    for (const pid of opts.decorPids) {
      const idx = (room.edges ?? []).findIndex((e: Any) => e.pid === pid);
      if (idx >= 0) decors[idx] = { exist: true, parts: { [pid]: decorPart((room.edges ?? [])[idx]) } };
    }
    room.decors = decors;
  }
}

/** Сводка отделки комнаты для консоли. */
function info(r: Any): Any {
  return {
    id: r.id, area: Math.round((r.area ?? 0) * 100) / 100,
    floor: (r.floors ?? []).map((f: Any) => f.exist ? f.cover : null),
    ceiling: (r.ceilings ?? []).map((c: Any) => c.exist ? c.material : null),
    decor: (r.decors ?? []).map((d: Any) => d.exist
      ? Object.values<Any>(d.parts ?? {}).map((p: Any) => `${p.type}@${Math.round(p.line.p1.x)},${Math.round(p.line.p1.y)}-${Math.round(p.line.p2.x)},${Math.round(p.line.p2.y)}`).join("+")
      : null),
  };
}

const out: Record<string, Any> = {};

async function run(op: string, finish: (m: Any) => void, wallOp: (w: Any) => void): Promise<void> {
  const prepared = structuredClone(baseN);
  finish(prepared);
  await restoreBase(prepared); // сброс живого состояния редактора + отделка
  const after = await mutateWalls(wallOp);
  const beforeRooms = Object.fromEntries(Object.entries<Any>(prepared.rooms2).map(([k, r]) => [k, info(r)]));
  const afterRooms = Object.values<Any>(after.rooms2 ?? {}).map(info);
  console.log(`\n=== ${op} ===`);
  console.log("after:", JSON.stringify(afterRooms, null, 1));
  out[op] = { before: { rooms: beforeRooms }, after: { rooms2: after.rooms2, walls: after.walls } };
}

// 1. Неравный split A (≈1/4 + 3/4): пол+потолок+обои на верхней стороне (w1)
await run("split-unequal",
  (m) => setFinish(m, A.id, { floor: "laminate", ceiling: "paint_ceiling", decorPids: ["w1"] }),
  (w) => { w._t98sp1 = new Wall({ id: "_t98sp1", p1: { x: 80, y: -290 }, p2: { x: 80, y: -10 }, depth: 20, plan: "a", role: "wall", material: "a_block", color: 0 }); });

// 2. Split A на 3 части: перегородки x=80 и x=180
await run("split-3",
  (m) => setFinish(m, A.id, { floor: "laminate", ceiling: "paint_ceiling", decorPids: ["w1"] }),
  (w) => {
    w._t98sp1 = new Wall({ id: "_t98sp1", p1: { x: 80, y: -290 }, p2: { x: 80, y: -10 }, depth: 20, plan: "a", role: "wall", material: "a_block", color: 0 });
    w._t98sp2 = new Wall({ id: "_t98sp2", p1: { x: 180, y: -290 }, p2: { x: 180, y: -10 }, depth: 20, plan: "a", role: "wall", material: "a_block", color: 0 });
  });

// 3. Merge A+B (стена w6 удаляется), разные полы: laminate и floor_tile
await run("merge-diff-floors",
  (m) => { setFinish(m, A.id, { floor: "laminate" }); setFinish(m, B.id, { floor: "floor_tile" }); },
  (w) => { delete w.w6; });

// 4. Merge A+B, пол и потолок только в A
await run("merge-one-floor",
  (m) => setFinish(m, A.id, { floor: "laminate", ceiling: "paint_ceiling" }),
  (w) => { delete w.w6; });

// 5. Перенос стены w7 (x=500 → x=470): полы в B и C, обои со стороны w7 обеих комнат
await run("wall-move",
  (m) => { setFinish(m, B.id, { floor: "laminate", decorPids: ["w7"] }); setFinish(m, C.id, { floor: "linoleum", decorPids: ["w7"] }); },
  (w) => { w.w7.p1.x = 470; w.w7.p2.x = 470; try { w.w7.calc && w.w7.calc(); } catch { /* */ } });

const summary = Object.fromEntries(Object.entries(out).map(([op, v]) => [op, {
  after: Object.values<Any>(v.after.rooms2).map(info),
}]));
console.log("\nSUMMARY:", JSON.stringify(summary, null, 1));

const { writeFileSync, mkdirSync } = await import("node:fs");
mkdirSync(".orca-reports/phase2-ui-refs", { recursive: true });
writeFileSync(".orca-reports/phase2-ui-refs/98-finish-topo.json", JSON.stringify({ base_ids: ids, ops: out }, null, 1) + "\n");
await browser.close();
process.exit(0);
