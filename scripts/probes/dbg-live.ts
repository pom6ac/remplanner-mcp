// Диагностика круга 2: правки перезагруженной модели + restore {reset:1} → save.
// Вариант B: с окном и диваном (как в полном живом круге).
import { STATE_ANON_PATH } from "../../src/config.ts";
import { saveSession, type SessionState } from "../../src/session.ts";
import { createAnonProject, loadModel } from "../../src/api.ts";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { addRoomRect, prepareForRestore, moveWall, splitWall } from "../../src/model/walls.ts";
import { addOpening } from "../../src/model/openings.ts";
import { addItem } from "../../src/model/items.ts";
import type { Model } from "../../src/model/types.ts";

const model0: Model = { v: 3, id: "0", plan_id: "0", walls: {}, items: {}, pillars: {}, rulers: {}, comments: {}, total_height: 270, final: false };
const room1 = addRoomRect(model0, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
addRoomRect(model0, { origin: { x: 4200, y: 0 }, widthMm: 2000, depthMm: 3000, thicknessMm: 200 });
addOpening(model0, { wallId: room1[2]!.id, type: "door", offsetMm: 500, widthMm: 800 });
addOpening(model0, { wallId: room1[0]!.id, type: "window", offsetMm: 1500, widthMm: 1200 });
addItem(model0, { name: "sofa_double", position: { againstWall: { wallId: room1[3]!.id, offsetMm: 800, gapMm: 0 } }, widthMm: 1400, depthMm: 800, heightMm: 850 });
prepareForRestore(model0);
const session: SessionState = { cookies: [] };
const created = await createAnonProject(session);
saveSession(STATE_ANON_PATH, session);
const editor = await openEditor(session, created.object_id, created.plan_id);
const planId = editor.compat.plan_id ?? created.plan_id;
const objId = editor.compat.object_id ?? created.object_id;
await editor.normalize(structuredClone(model0) as unknown as Record<string, unknown>, 1500);
console.log("save1:", JSON.stringify(await editor.save()));
await new Promise((r) => setTimeout(r, 2000));
const reloaded = await loadModel(session, objId, planId);
const m2 = reloaded.model as unknown as Model;
for (const w of Object.values(m2.walls ?? {})) (w as any).holes ??= {};
const top = Object.values(m2.walls).find((w) => w.p1.y === -10 && w.p2.y === -10)!;
console.log("top до move:", top.p1, top.p2);
moveWall(m2, { wallId: top.id, offsetMm: 100 });
console.log("top после move:", top.p1, top.p2);
console.log("все оси m2:", Object.values(m2.walls).map((w) => `${w.p1.x},${w.p1.y}-${w.p2.x},${w.p2.y}`).join(" | "));
const rightParts = Object.values(m2.walls).filter((w) => w.p1.x === 630 && w.p2.x === 630);
const rightWall = rightParts.reduce((a, b) => (Math.hypot(b.p2.x - b.p1.x, b.p2.y - b.p1.y) > Math.hypot(a.p2.x - a.p1.x, a.p2.y - a.p1.y) ? b : a));
splitWall(m2, rightWall.id, Math.round(Math.hypot(rightWall.p2.x - rightWall.p1.x, rightWall.p2.y - rightWall.p1.y) * 10 / 2));
const m2minimal: Record<string, unknown> = {
  v: 3, id: "0", plan_id: "0", walls: m2.walls, items: m2.items, pillars: m2.pillars,
  rulers: m2.rulers, comments: m2.comments, total_height: m2.total_height, final: false,
};
prepareForRestore(m2 as unknown as Model);
// bak узлов (серверные бэкапы позиций) может возвращать узлы на старые места при restore
for (const w of Object.values(m2.walls)) { delete (w as any).p1.bak; delete (w as any).p2.bak; }
const res = await editor.page.evaluate((arg: any) => {
  const w: any = window as any;
  try { w.$Project.restore(arg.model); } catch (e) { return { err: String(e) }; }
  w.$Project.draw({ rooms: 1 });
  return new Promise((r) => setTimeout(() => {
    const copy = w.project.copy("server");
    const walls: any = copy.walls || {};
    r({ walls: Object.keys(walls).length, top20: Object.values(walls).filter((x: any) => Math.abs(x.p1.y + 20) < 0.01).length, items: Object.keys(w.ITEMS || {}).length });
  }, 1500));
}, { model: m2minimal });
console.log("после restore(reset):", JSON.stringify(res));
console.log("save2:", JSON.stringify(await editor.save()));
for (let i = 0; i < 3; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const g = await loadModel(session, objId, planId);
  const ws: any = g.model.walls ?? {};
  console.log(`GET ${i}: save_id=${g.save_id} walls=${Object.keys(ws).length} top-20=${Object.values(ws).filter((x: any) => Math.abs(x.p1.y + 20) < 0.01).length}`);
}
await editor.close();
await closeBrowser();
process.exit(0);
