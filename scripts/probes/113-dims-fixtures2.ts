// 113: снятие UI-эталонов (шаг 2): листы (plan), привязка размера к предмету, комментарий.
import { launch, newAnonProject, buildBase, copyServer, writeOut, clearFog, toScreen, escape } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);

// 1) предмет (диван) в комнате через UI
await clearFog(page);
await page.evaluate(() => (document.querySelector(".groups_navi_item.plan_furniture") as any)?.click());
await page.waitForTimeout(1200);
await clearFog(page);
await page.evaluate(() => (document.querySelector("#plannertool_sofa") as any)?.click());
await page.waitForTimeout(700);
const sp = await toScreen(page, { x: 150, y: -150 });
await page.mouse.move(sp.x, sp.y, { steps: 5 });
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(1200);
const sofaId = await page.evaluate(() => Object.keys((window as any).ITEMS ?? {})[0] ?? null);
const sofa = await page.evaluate((sid) => {
  const p = (window as any).ITEMS[sid]?.props;
  return p ? { pc: p.pc, w: p.width, h: p.height, angle: p.angle, name: p.name, plan: p.plan } : null;
}, sofaId);
console.log("sofa:", JSON.stringify(sofa));

// 2) размер на листе furniture: от свободной точки к краю дивана (верхняя грань)
async function drawRuler(a: { x: number; y: number }, b: { x: number; y: number }) {
  await page.evaluate(() => (document.querySelector("#rulers") as any).dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  await page.waitForTimeout(300);
  const sa = await toScreen(page, a), sb = await toScreen(page, b);
  await page.mouse.move(sa.x, sa.y, { steps: 3 });
  await page.waitForTimeout(250);
  await page.mouse.down();
  await page.mouse.move(sb.x, sb.y, { steps: 12 });
  await page.waitForTimeout(200);
  await page.mouse.up();
  await page.waitForTimeout(900);
}
const halfH = (sofa?.h ?? 90) / 2;
await drawRuler({ x: 150, y: -320 }, { x: 150, y: sofa.pc.y - halfH });
await escape(page);
const r1 = await copyServer(page);
writeOut("113-fixtures-rulers2", r1.rulers);
console.log("ruler on furniture sheet:", JSON.stringify(r1.rulers, null, 1).slice(0, 2600));

// 3) перенос дивана (transformDragend) → пересчёт привязанного размера
const beforeMove = await copyServer(page);
await page.evaluate((sid) => {
  const w: any = window as any;
  const it = w.ITEMS[sid];
  it.props.pc = { x: it.props.pc.x + 100, y: it.props.pc.y + 30 };
  it.transformDragend?.();
}, sofaId);
await page.waitForTimeout(900);
const afterMove = await copyServer(page);
writeOut("113-fixtures-after-item-move2", { before: beforeMove.rulers, after: afterMove.rulers });
console.log("attached ruler after move:", JSON.stringify(afterMove.rulers, null, 1).slice(0, 2600));

// 4) комментарий на листе init
await page.evaluate(() => (document.querySelector(".groups_navi_item.plan_init") as any)?.click());
await page.waitForTimeout(1200);
await clearFog(page);
const created = await page.evaluate(() => {
  const w: any = window as any;
  const id = w.COMMENTS?.create ? w.COMMENTS.create({ x: 250, y: -100 }) : null;
  return { id, hasCreate: !!w.COMMENTS?.create };
});
console.log("comment create:", JSON.stringify(created));
await page.waitForTimeout(600);
const inputOk = await page.evaluate(() => {
  const el: any = document.querySelector("#cm-comment--input");
  return !!el && el.offsetParent !== null;
});
console.log("comment input visible:", inputOk);
if (inputOk) {
  await page.keyboard.type("Проба 113");
  await page.evaluate(() => (document.querySelector("#cm-comment--confirm") as any)?.click());
  await page.waitForTimeout(900);
}
const afterComment = await copyServer(page);
writeOut("113-fixtures-comments2", afterComment.comments);
console.log("comments:", JSON.stringify(afterComment.comments, null, 1).slice(0, 2500));

// 5) удаление предмета с привязанным размером
await escape(page);
await page.evaluate((sid) => {
  const w: any = window as any;
  delete w.ITEMS[sid];
  w.$Project.draw({ rooms: 1 });
}, sofaId);
await page.waitForTimeout(800);
const afterDelete = await copyServer(page);
writeOut("113-fixtures-after-item-delete2", { rulers: afterDelete.rulers, comments: afterDelete.comments });
console.log("after delete rulers:", JSON.stringify(afterDelete.rulers, null, 1).slice(0, 1200));

await browser.close();
process.exit(0);
