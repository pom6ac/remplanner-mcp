// 113: отладка — порядок restore в Project.restore и состояние ITEMS при падении.
import { launch, newAnonProject, buildBase, writeOut, clearFog } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);
await clearFog(page);
await page.evaluate(() => (document.querySelector(".groups_navi_item.plan_furniture") as any)?.click());
await page.waitForTimeout(1000);
await page.evaluate(() => (document.querySelector("#plannertool_sofa") as any)?.click());
await page.waitForTimeout(500);
await page.mouse.move(600, 450);
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(1000);

const res = await page.evaluate(async () => {
  const w: any = window as any;
  const out: any = {};
  const itemId = Object.keys(w.ITEMS ?? {})[0];
  const item = w.ITEMS[itemId].props;
  const m = JSON.parse(JSON.stringify(w.project.copy("server")));
  m.rulers = { ra: { id: "ra", p1: { x: 100, y: 200 }, p2: { x: 300, y: 200 }, offset: { val: 20, side: "a" }, plan: "a", plan_: 0, prs: { room: 0, mode: 1 },
    p1_target: { target_id: itemId, target_name: item.name, target_plan: item.plan, target_angle: item.angle, point_delta_x: item.pc.x - 100, point_delta_y: item.pc.y - 200 }, p2_target: null, color: "#ed143d" } };
  // перехват: сколько предметов в ITEMS в момент Rulers.restore
  const origRestore = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(w.project), "restore")?.value ?? w.project.restore;
  try {
    w.$Project.restore(m);
    out.ok = true;
  } catch (e: any) {
    out.msg = String(e?.message ?? e).slice(0, 120);
    out.itemsAtFail = Object.keys(w.ITEMS ?? {}).length;
    out.itemsKeys = Object.keys(m.items ?? {}).length;
  }
  // восстановим страницу: перезагрузить не хочется; проверим ручной порядок:
  // 1) Items.restore из модели, 2) затем Rulers.restore
  try {
    w.ITEMS.restore(m.items);
    w.RULERS.restore(m.rulers);
    out.manual = "OK rulers=" + JSON.stringify(w.RULERS.copy("server")).slice(0, 300);
  } catch (e: any) {
    out.manual = "FAIL: " + String(e?.message ?? e).slice(0, 160);
  }
  return out;
});
writeOut("113-restore-order", res);
console.log(JSON.stringify(res, null, 1).slice(0, 1500));
await browser.close();
process.exit(0);
