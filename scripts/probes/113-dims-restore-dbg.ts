// 113: отладка restore — какая сущность размера/комментария роняет редактор.
import { launch, newAnonProject, buildBase, copyServer, writeOut, clearFog } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);
await clearFog(page);

const res = await page.evaluate(() => {
  const w: any = window as any;
  const out: any = {};
  const model = JSON.parse(JSON.stringify(w.project.copy("server")));
  model.rulers = {
    r1: { id: "r1", p1: { x: 100, y: 100 }, p2: { x: 400, y: 100 }, offset: { val: 30, side: "l" }, plan: "a", plan_: 0, prs: { room: 0, mode: 1 }, p2_target: null, color: "#ed143d", show_everywhere: 1 },
  };
  try {
    w.$Project.restore(model);
    out.rulerOnly = "OK";
  } catch (e: any) { out.rulerOnly = "FAIL: " + String(e?.message ?? e).slice(0, 200); return out; }
  const model2 = JSON.parse(JSON.stringify(w.project.copy("server")));
  model2.rulers = {
    r2: { id: "r2", p1: { x: 100, y: 200 }, p2: { x: 300, y: 200 }, offset: { val: 0, side: "a" }, plan: "a", plan_: 0, prs: { room: 0, mode: 1 }, p2_target: null, color: "#ed143d" },
  };
  try {
    w.$Project.restore(model2);
    out.rulerPlain = "OK";
  } catch (e: any) { out.rulerPlain = "FAIL: " + String(e?.message ?? e).slice(0, 200); }
  const model3 = JSON.parse(JSON.stringify(w.project.copy("server")));
  model3.comments = {
    c1: { id: "c1", pc: { x: 200, y: 300 }, points: [{ x: 200, y: 300 }], text: "Проверка 113", label: "free", plan: "a", plan_: 0, prs: { room: 0, mode: 1 }, name_item: "", color: "#000000", font_size: 12, framed: true },
  };
  try {
    w.$Project.restore(model3);
    out.comment = "OK";
  } catch (e: any) { out.comment = "FAIL: " + String(e?.message ?? e).slice(0, 200); }
  const model4 = JSON.parse(JSON.stringify(w.project.copy("server")));
  model4.comments = {
    c2: { id: "c2", pc: { x: 200, y: 300 }, points: [{ x: 200, y: 300 }], text: "т", label: "free", plan: "a", plan_: 0, prs: { room: 0, mode: 1 }, name_item: "", color: "#000000", font_size: 12, framed: true, show_everywhere: 1 },
  };
  try {
    w.$Project.restore(model4);
    out.commentShowEverywhere = "OK";
  } catch (e: any) { out.commentShowEverywhere = "FAIL: " + String(e?.message ?? e).slice(0, 200); }
  return out;
});
writeOut("113-restore-debug", res);
console.log(JSON.stringify(res, null, 1));
await browser.close();
process.exit(0);
