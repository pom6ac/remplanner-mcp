// 113: снятие UI-эталонов размеров и комментариев + поведение привязок (анонимный проект).
// Запуск: node scripts/probes/113-dims-fixtures.ts
import { launch, newAnonProject, buildBase, copyServer, writeOut, clearFog, toScreen, escape } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);

// 1) предмет (диван) в комнате через UI
await clearFog(page);
await page.evaluate(() => {
  const nav: any = document.querySelector(".groups_navi_item.plan_furniture");
  nav?.click();
});
await page.waitForTimeout(1200);
await clearFog(page);
await page.evaluate(() => {
  const t: any = document.querySelector("#plannertool_sofa");
  t?.click();
});
await page.waitForTimeout(600);
const sp = await toScreen(page, { x: 150, y: -150 });
await page.mouse.move(sp.x, sp.y, { steps: 5 });
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(1200);
const sofaId = await page.evaluate(() => Object.keys((window as any).ITEMS ?? {})[0] ?? null);
console.log("sofa id:", sofaId);

// 2) размер: свободный (внутри комнаты)
async function drawRuler(a: { x: number; y: number }, b: { x: number; y: number }) {
  await page.evaluate(() => {
    (document.querySelector("#rulers") as any).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
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
await drawRuler({ x: 150, y: -260 }, { x: 450, y: -260 });
await escape(page);

// 3) размер с привязкой концов к дивану: протяжка от точки на границе дивана к его центру
await drawRuler({ x: 150, y: -150 }, { x: 150, y: -150 + 1 });
// вторая попытка: точно через центр дивана
await drawRuler({ x: 60, y: -60 }, { x: 150, y: -150 });

const afterRulers = await copyServer(page);
writeOut("113-fixtures-rulers", afterRulers.rulers);
console.log("rulers:", JSON.stringify(afterRulers.rulers, null, 1).slice(0, 3000));

// 4) перенос дивана средствами редактора → пересчитался ли размер с target
const beforeMove = await copyServer(page);
await page.evaluate((sid) => {
  const w: any = window as any;
  const it = w.ITEMS[sid];
  it.props.pc = { x: it.props.pc.x + 100, y: it.props.pc.y };
  it.transformDragend?.();
}, sofaId);
await page.waitForTimeout(900);
const afterMove = await copyServer(page);
writeOut("113-fixtures-after-item-move", { before: beforeMove.rulers, after: afterMove.rulers });
console.log("rulers after sofa move:", JSON.stringify(afterMove.rulers, null, 1).slice(0, 2200));

// 5) комментарий через Comments.create (тот же путь, что UI; PRO-гейт — только кнопка)
await clearFog(page);
await page.evaluate(() => (window as any).project.comments.create({ x: 250, y: -100 }));
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
writeOut("113-fixtures-comments", afterComment.comments);
console.log("comments:", JSON.stringify(afterComment.comments, null, 1).slice(0, 2500));

// 6) удаление предмета с привязанным размером и комментарием
await escape(page);
await page.evaluate((sid) => {
  const w: any = window as any;
  delete w.ITEMS[sid];
  w.$Project.draw({ rooms: 1 });
}, sofaId);
await page.waitForTimeout(800);
const afterDelete = await copyServer(page);
writeOut("113-fixtures-after-item-delete", afterDelete);
console.log("after delete — rulers:", JSON.stringify(afterDelete.rulers, null, 1).slice(0, 1600), "comments:", Object.keys(afterDelete.comments ?? {}));

await browser.close();
process.exit(0);
