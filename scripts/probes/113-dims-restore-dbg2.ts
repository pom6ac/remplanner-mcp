// 113: отладка restore+draw+copy — какая сущность и на каком шаге роняет редактор.
import { launch, newAnonProject, buildBase, copyServer, writeOut, clearFog } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);
await clearFog(page);

// ставим предмет (диван) через редактор, чтобы был валидный item
await clearFog(page);
await page.evaluate(() => (document.querySelector(".groups_navi_item.plan_furniture") as any)?.click());
await page.waitForTimeout(1000);
await page.evaluate(() => (document.querySelector("#plannertool_sofa") as any)?.click());
await page.waitForTimeout(500);
await page.mouse.move(600, 450);
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(1000);

const res = await page.evaluate(() => {
  const w: any = window as any;
  const out: any = {};
  const itemId = Object.keys(w.ITEMS ?? {})[0] ?? null;
  out.itemId = itemId;
  const item = itemId ? w.ITEMS[itemId].props : null;
  const mkModel = () => JSON.parse(JSON.stringify(w.project.copy("server")));
  const run = (label: string, patch: (m: any) => void) => {
    const m = mkModel();
    patch(m);
    try {
      w.$Project.restore(m);
    } catch (e: any) { out[label] = "restore FAIL: " + String(e?.message ?? e).slice(0, 160); return; }
    try {
      w.$Project.draw({ rooms: 1 });
    } catch (e: any) { out[label] = "draw FAIL: " + String(e?.message ?? e).slice(0, 160); return; }
    try {
      const c = w.project.copy("server");
      out[label] = "OK rulers=" + JSON.stringify(c.rulers).slice(0, 300) + " comments=" + JSON.stringify(c.comments).slice(0, 200);
    } catch (e: any) { out[label] = "copy FAIL: " + String(e?.message ?? e).slice(0, 160); }
  };
  run("attached_ruler", (m) => {
    m.rulers = { ra: { id: "ra", p1: { x: 100, y: 200 }, p2: { x: 300, y: 200 }, offset: { val: 20, side: "a" }, plan: "a", plan_: 0, prs: { room: 0, mode: 1 },
      p1_target: { target_id: itemId, target_name: item.name, target_plan: item.plan, target_angle: item.angle, point_delta_x: item.pc.x - 100, point_delta_y: item.pc.y - 200 }, p2_target: null, color: "#ed143d" } };
  });
  run("free_ruler_offset_l", (m) => {
    m.rulers = { rf: { id: "rf", p1: { x: 100, y: 100 }, p2: { x: 400, y: 100 }, offset: { val: 30, side: "l" }, plan: "a", plan_: 0, prs: { room: 0, mode: 1 }, p2_target: null, color: "#ed143d", show_everywhere: 1 } };
  });
  run("comment_only", (m) => {
    m.comments = { c1: { id: "c1", pc: { x: 200, y: 300 }, points: [{ x: 200, y: 300 }], text: "Проверка MCP 113", label: "free", plan: "a", plan_: 0, prs: { room: 0, mode: 1 }, name_item: "", color: "#000000", font_size: 12, framed: true } };
  });
  run("all_together", (m) => {
    m.rulers = {
      rf: { id: "rf", p1: { x: 100, y: 100 }, p2: { x: 400, y: 100 }, offset: { val: 30, side: "l" }, plan: "a", plan_: 0, prs: { room: 0, mode: 1 }, p2_target: null, color: "#ed143d", show_everywhere: 1 },
      ra: { id: "ra", p1: { x: 100, y: 200 }, p2: { x: 300, y: 200 }, offset: { val: 20, side: "a" }, plan: "a", plan_: 0, prs: { room: 0, mode: 1 },
        p1_target: { target_id: itemId, target_name: item.name, target_plan: item.plan, target_angle: item.angle, point_delta_x: item.pc.x - 100, point_delta_y: item.pc.y - 200 }, p2_target: null, color: "#ed143d" },
    };
    m.comments = { c1: { id: "c1", pc: { x: 200, y: 300 }, points: [{ x: 200, y: 300 }], text: "Проверка MCP 113", label: "free", plan: "a", plan_: 0, prs: { room: 0, mode: 1 }, name_item: "", color: "#000000", font_size: 12, framed: true } };
  });
  return out;
});
writeOut("113-restore-draw-debug", res);
console.log(JSON.stringify(res, null, 1).slice(0, 2500));
await browser.close();
process.exit(0);
