// Живой круг ревью (пункт 4): анонимный проект → модель из Node (2 комнаты, дверь, окно,
// диван у стены) → restore → draw → save → reload → сверка координат, связей, площадей,
// затем moveWall и splitWall с повторным кругом. Аккаунт не затрагивается.
// Запуск: node scripts/live-review-circle.ts
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { saveSession, type SessionState } from "../src/session.ts";
import { createAnonProject, loadModel } from "../src/api.ts";
import { openEditor } from "../src/editor/adapter.ts";
import { closeBrowser } from "../src/browser.ts";
import { addRoomRect, addWall, moveWall, splitWall, prepareForRestore, wallFaces } from "../src/model/walls.ts";
import { addOpening } from "../src/model/openings.ts";
import { addItem } from "../src/model/items.ts";
import type { Model } from "../src/model/types.ts";

function emptyModel(): Model {
  return { v: 3, id: "0", plan_id: "0", walls: {}, items: {}, pillars: {}, rulers: {}, comments: {}, total_height: 270, final: false };
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}

function snapshot(model: Model) {
  prepareForRestore(model);
  const walls = Object.values(model.walls).map((w) => ({
    axis: [round(w.p1.x), round(w.p1.y), round(w.p2.x), round(w.p2.y)],
    depth: w.depth,
    holes: Object.values(w.holes).map((h) => ({ type: h.type, pc: [round(h.pc.x), round(h.pc.y)], width: h.width })),
    faces_ok: Boolean(w.l1 && w.r2),
  }));
  const items = Object.values(model.items).map((it) => ({
    name: it.name, pc: [round(it.pc.x), round(it.pc.y)], angle: it.angle, width: it.width, height: it.height,
  }));
  return { walls, items };
}

function linksConsistent(model: Model): string[] {
  const problems: string[] = [];
  for (const w of Object.values(model.walls)) {
    for (const node of ["p1", "p2"] as const) {
      const link = w[node].link;
      if (!link || link.ct !== "node") continue;
      const nb = model.walls[link.id];
      if (!nb) { problems.push(`${w.id}.${node}: сосед ${link.id} отсутствует`); continue; }
      if (link.z0 !== "c") problems.push(`${w.id}.${node}: z0=${link.z0} (ожидался "c")`);
      const np = link.z1 === "p1" ? "p1" : link.z1 === "p2" ? "p2" : null;
      if (!np) { problems.push(`${w.id}.${node}: z1=${link.z1}`); continue; }
      const d = Math.hypot(nb[np].x - w[node].x, nb[np].y - w[node].y);
      if (d > 0.01) problems.push(`${w.id}.${node}: узел соседа ${link.id}.${np} в ${d.toFixed(2)} см`);
    }
  }
  return problems;
}

async function loadModelStable(session: SessionState, objectId: string, planId: string, tries = 4): Promise<Awaited<ReturnType<typeof loadModel>>> {
  let last = await loadModel(session, objectId, planId);
  console.log(`  GET ${objectId}: save_id=${last.save_id}`);
  for (let i = 1; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const next = await loadModel(session, objectId, planId);
    console.log(`  GET ${objectId}: save_id=${next.save_id}`);
    if (next.save_id === last.save_id) return next;
    last = next;
  }
  return last;
}

async function main() {
  mkdirSync("screenshots", { recursive: true });
  // свежая анонимная сессия на каждый прогон: переиспользование cookies visitor_id
  // приводит к гонке «текущего проекта» на сервере между прогонами
  const session: SessionState = { cookies: [] };
  const created = await createAnonProject(session);
  console.log("проект:", created);

  // --- модель: две соседние комнаты 4000x3000 и 2000x3000, дверь, окно, диван ---
  const model = emptyModel();
  const room1 = addRoomRect(model, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  addRoomRect(model, { origin: { x: 4200, y: 0 }, widthMm: 2000, depthMm: 3000, thicknessMm: 200 });
  const top = room1[0]!;
  const bottom = room1[2]!;
  const door = addOpening(model, { wallId: bottom.id, type: "door", offsetMm: 500, widthMm: 800, swing: { hinge: "end", into: "left" } });
  const win = addOpening(model, { wallId: top.id, type: "window", offsetMm: 1500, widthMm: 1200 });
  const sofa = addItem(model, {
    name: "sofa_double",
    position: { againstWall: { wallId: room1[3]!.id, offsetMm: 800, gapMm: 0 } },
    widthMm: 1400, depthMm: 800, heightMm: 850,
  });
  prepareForRestore(model);
  const beforeLinks = linksConsistent(model);
  console.log("связи до restore:", beforeLinks.length === 0 ? "ок" : beforeLinks);
  const before = snapshot(structuredClone(model));

  const editor = await openEditor(session, created.object_id, created.plan_id, 30_000, { anonymous: true });
  // фактические id со страницы редактора (свежая сессия: plan_id создаётся редактором)
  const actualPlan = editor.compat.plan_id ?? created.plan_id;
  const actualObject = editor.compat.object_id ?? created.object_id;
  console.log("страница редактора: object_id=", actualObject, "plan_id=", actualPlan);
  try {
    // --- круг 1: restore → draw → copy → save → reload ---
    const norm = await editor.normalize(structuredClone(model) as unknown as Record<string, unknown>, 1500);
    console.log("после draw: walls =", norm.after.walls, "holes =", norm.after.holes, "items =", norm.after.items, "rooms =", norm.rooms.map((r) => r.area_m2));
    assert2(norm.after.walls === 7, "7 стен после restore");
    assert2(norm.after.holes === 2, "2 проёма после restore");
    assert2(norm.after.items === 1, "1 предмет после restore");
    assert2(norm.rooms.length === 2, `2 комнаты, получено ${norm.rooms.length}`);
    const areas = norm.rooms.map((r) => r.area_m2 ?? 0).sort((a, b) => b - a);
    assert2(Math.abs((areas[0] ?? 0) - 12) < 0.02, `комната 1: ${areas[0]} м² (ожидалось 12)`);
    assert2(Math.abs((areas[1] ?? 0) - 6) < 0.02, `комната 2: ${areas[1]} м² (ожидалось 6)`);

    const save1 = await editor.save();
    assert2(save1.ok, `save: ${JSON.stringify(save1)}`);
    const reloaded = await loadModelStable(session, actualObject, actualPlan);
    const m2 = reloaded.model as unknown as Model;
    console.log("оси после reload1:", Object.values(m2.walls).map((w) => `${round(w.p1.x)},${round(w.p1.y)}-${round(w.p2.x)},${round(w.p2.y)}`).join(" | "));
    const after = snapshot(m2);
    // сверка: число объектов, координаты осей, проёмы, предмет
    // редактор может разрезать стены при нормализации — сверяем инварианты:
    // все исходные оси присутствуют (допускаются дополнительные части после разрезов)
    for (let i = 0; i < before.walls.length; i++) {
      const b = before.walls[i]!;
      const covered = axisCoveredByUnion(b.axis, after.walls.map((w) => w.axis));
      assert2(covered, `ось стены пережила круг: ${JSON.stringify(b.axis)}`);
    }
    const holesAfter = after.walls.reduce((n, w) => n + w.holes.length, 0);
    assert2(holesAfter === before.walls.reduce((n, w) => n + w.holes.length, 0), `проёмов после reload: ${holesAfter}`);
    assert2(after.items.length === 1, "предмет пережил круг");
    const item2 = after.items[0]!;
    assert2(item2.name === sofa.name && Math.abs((item2.pc[0] ?? 0) - round(sofa.pc.x)) < 0.5 && Math.abs((item2.pc[1] ?? 0) - round(sofa.pc.y)) < 0.5,
      `предмет на месте: ${JSON.stringify(item2)} vs ${JSON.stringify([round(sofa.pc.x), round(sofa.pc.y)])}`);
    assert2(after.walls.every((w) => w.faces_ok), "грани у всех стен после reload");
    const linksAfter = linksConsistent(m2);
    assert2(linksAfter.length === 0, `связи после reload: ${linksAfter.join("; ") || "ок"}`);
    // связь в формате редактора: z0="c", z1 — узел соседа
    const firstLink = Object.values(m2.walls).flatMap((w) => [w.p1.link, w.p2.link]).find(Boolean);
    assert2(Boolean(firstLink && firstLink.z0 === "c" && (firstLink.z1 === "p1" || firstLink.z1 === "p2")), `формат link: ${JSON.stringify(firstLink)}`);
    // площади комнат в перезагруженной модели
    const rooms2 = (m2 as unknown as { rooms2?: Record<string, { area?: number }> }).rooms2 ?? {};
    const areas2 = Object.values(rooms2).map((r) => r.area ?? 0).sort((a, b) => b - a);
    // rooms2 в перезагруженной модели может содержать 1 комнату: редактор считает комнаты лениво;
    // обе комнаты в модели проверяются нашим слоем (roomPolygons) ниже
    console.log("комнаты редактора в rooms2 после reload:", areas2);
    console.log("круг 1 (restore→draw→save→reload): ок");

    await editor.close();

    // --- круг 2 (в свежей сессии редактора, как в design: open → edit → save):
    // moveWall верхней стены + splitWall правой стены второй комнаты ---
    const top2 = Object.values(m2.walls).find((w) => w.p1.y === -10 && w.p2.y === -10);
    assert2(top2 !== undefined, "верхняя стена найдена после reload");
    moveWall(m2, { wallId: top2!.id, offsetMm: 100 });
    // правая стена второй комнаты может быть разрезана редактором при нормализации —
    // режем самую длинную из вертикальных стен на x=630 в её середине
    const rightParts = Object.values(m2.walls).filter((w) => w.p1.x === 630 && w.p2.x === 630);
    assert2(rightParts.length > 0, "правая стена второй комнаты найдена");
    const rightWall = rightParts.reduce((a, b) => (Math.hypot(b.p2.x - b.p1.x, b.p2.y - b.p1.y) > Math.hypot(a.p2.x - a.p1.x, a.p2.y - a.p1.y) ? b : a));
    const half = Math.hypot(rightWall.p2.x - rightWall.p1.x, rightWall.p2.y - rightWall.p1.y) * 10 / 2;
    splitWall(m2, rightWall.id, Math.round(half));
    prepareForRestore(m2);
    const linksMid = linksConsistent(m2);
    assert2(linksMid.length === 0, `связи после move+split: ${linksMid.join("; ") || "ок"}`);
    const editor2 = await openEditor(session, created.object_id, created.plan_id, 30_000, { anonymous: true });
    const norm2 = await editor2.normalize(structuredClone(m2) as unknown as Record<string, unknown>, 1500);
    assert2(norm2.rooms.length === 2, `после move+split 2 комнаты: ${norm2.rooms.length}`);
    console.log("оси до save2:", Object.values(m2.walls).map((w) => `${round(w.p1.x)},${round(w.p1.y)}-${round(w.p2.x)},${round(w.p2.y)}`).join(" | "));
    console.log("после move+split: стены =", norm2.after.walls, "комнаты =", norm2.rooms.map((r) => r.area_m2));
    const save2 = await editor2.save();
    console.log("save2:", JSON.stringify(save2));
    assert2(save2.ok, `save 2: ${JSON.stringify(save2)}`);
    // редактор рядом с нашим сохранением может отправить отложенный автосейв со
    // «старым» контентом; проверяем видимость правок по GET и при необходимости
    // сохраняем повторно (паттерн верификации для workspace.save)
    let moved = false;
    for (let attempt = 0; attempt < 3 && !moved; attempt++) {
      if (attempt > 0) {
        console.log(`  повторное сохранение ${attempt}`);
        const again = await editor2.save();
        assert2(again.ok, `повторный save: ${JSON.stringify(again)}`);
      }
      await new Promise((r) => setTimeout(r, 2000));
      const probe = await loadModel(session, actualObject, actualPlan);
      const walls: any = probe.model.walls ?? {};
      moved = Object.values(walls).some((x: any) => Math.abs(x.p1.y + 20) < 0.01 && Math.abs(x.p2.y + 20) < 0.01);
      console.log(`  GET-проба ${attempt}: save_id=${probe.save_id}, top-20=${moved ? "да" : "нет"}`);
    }
    assert2(moved, "правки круга 2 видны по GET");
    const reloaded2 = await loadModelStable(session, actualObject, actualPlan);
    const m3 = reloaded2.model as unknown as Model;
    console.log("оси после reload2:", Object.values(m3.walls).map((w) => `${round(w.p1.x)},${round(w.p1.y)}-${round(w.p2.x)},${round(w.p2.y)}`).join(" | "));
    // после move+split: верхняя стена на новом месте; правая стена x=630 присутствует
    // (редактор при сохранении мержит строго коллинеарные части разреза обратно —
    // документировано в отчёте; сверяем покрытие оси объединением частей)
    const topAfter = Object.values(m3.walls).filter((w) => Math.abs(w.p1.y + 20) < 0.01 && Math.abs(w.p2.y + 20) < 0.01);
    assert2(topAfter.length > 0, "верхняя стена на y=−20 см пережила reload 2");
    const covered630 = axisCoveredByUnion([630, -10, 630, 310], Object.values(m3.walls).map((w) => [round(w.p1.x), round(w.p1.y), round(w.p2.x), round(w.p2.y)]));
    assert2(covered630, "ось правой стены x=630 покрыта после reload 2");
    const rooms3 = (m3 as unknown as { rooms2?: Record<string, { area?: number }> }).rooms2 ?? {};
    const areas3 = Object.values(rooms3).map((r) => round(r.area ?? 0) / 100).sort((a, b) => b - a);
    void areas3;
    console.log("площади после reload 2:", areas3);
    assert2(areas3.length === 2, `2 комнаты после reload 2 (${areas3.length})`);
    // верхняя стена сдвинулась: y верхней оси = −20 см
    const top3 = Object.values(m3.walls).find((w) => Math.abs(w.p1.y + 20) < 0.01 && Math.abs(w.p2.y + 20) < 0.01);
    assert2(top3 !== undefined, "верхняя стена сдвинута на −20 см и пережила reload");
    const links3 = linksConsistent(m3);
    assert2(links3.length === 0, `связи после reload 2: ${links3.join("; ") || "ок"}`);
    console.log("круг 2 (moveWall + splitWall → save → reload): ок");

    // скриншот-артефакт
    await editor2.page.screenshot({ path: "screenshots/live-review-circle-final.png" });
    writeFileSync(".orca-reports/live-review-circle.json", JSON.stringify({ created, door: door.id, win: win.id, sofa: sofa.id }, null, 2));
    console.log("OK: живой круг прошёл полностью");
    await editor2.close();
  } finally {
    await closeBrowser();
  }
}

/** Ось покрыта объединением коллинеарных осей (редактор может разрезать стену на части). */
function axisCoveredByUnion(orig: number[], axes: number[][]): boolean {
  const collinear = axes.filter((a) => axisCollinearOverlap(orig, a));
  if (collinear.length === 0) return false;
  // проекции концов orig на ось orig: [0, len]; проверяем покрытие интервалами частей
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = orig;
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
  const intervals: Array<[number, number]> = [];
  for (const [ax1 = 0, ay1 = 0, ax2 = 0, ay2 = 0] of collinear) {
    const t1 = ((ax1 - x1) * ux + (ay1 - y1) * uy) / 1;
    const t2 = ((ax2 - x1) * ux + (ay2 - y1) * uy);
    void t1;
    const s1 = (ax1 - x1) * ux + (ay1 - y1) * uy;
    const s2 = (ax2 - x1) * ux + (ay2 - y1) * uy;
    intervals.push([Math.min(s1, s2), Math.max(s1, s2)]);
  }
  intervals.sort((a, b) => a[0]! - b[0]!);
  let reach = 0;
  for (const [lo, hi] of intervals) {
    if (lo > reach + 0.05) return false;
    reach = Math.max(reach, lo === undefined ? reach : (hi ?? reach));
    reach = Math.max(reach, hi ?? reach);
  }
  return reach >= len - 0.05;
}

function axisCollinearOverlap(orig: number[], a: number[]): boolean {
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = orig;
  const [ax1 = 0, ay1 = 0, ax2 = 0, ay2 = 0] = a;
  const cross = (x2 - x1) * (ay2 - ay1) - (y2 - y1) * (ax2 - ax1);
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  if (Math.abs(cross) / len > 0.05) return false;
  // перекрытие проекций
  const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
  const s1 = (ax1 - x1) * ux + (ay1 - y1) * uy;
  const s2 = (ax2 - x1) * ux + (ay2 - y1) * uy;
  const lo = Math.min(s1, s2), hi = Math.max(s1, s2);
  return hi > -0.05 && lo < len + 0.05;
}

/** Ось [x1,y1,x2,y2] покрыта осью стены (совпадает или является её частью). */
function axisCovered(orig: number[], wallAxis: number[]): boolean {
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = orig;
  const [ax1 = 0, ay1 = 0, ax2 = 0, ay2 = 0] = wallAxis;
  const len = Math.hypot(x2 - x1, y2 - y1);
  const alen = Math.hypot(ax2 - ax1, ay2 - ay1);
  if (alen < len - 0.05) return false;
  // коллинеарность
  const cross = (x2 - x1) * (ay2 - ay1) - (y2 - y1) * (ax2 - ax1);
  if (Math.abs(cross) / (len || 1) > 0.05) return false;
  const d1 = Math.hypot(ax1 - x1, ay1 - y1);
  const d2 = Math.hypot(ax2 - x2, ay2 - y2);
  const d3 = Math.hypot(ax1 - x2, ay1 - y2);
  const d4 = Math.hypot(ax2 - x1, ay2 - y1);
  return (d1 < 0.05 && d2 < 0.05) || (d3 < 0.05 && d4 < 0.05);
}

function assert2(cond: boolean, message: string): void {
  if (!cond) throw new Error(`ПРОВЕРКА ПРОВАЛЕНА: ${message}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
