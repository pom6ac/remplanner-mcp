// 113: разведка шаг 4b — состояние инструмента линейки и повторные попытки протяжки.
import { launch, newAnonProject, buildBase, copyServer, writeOut, dragAt, clickAt, escape, clearFog } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);

const pick = await page.evaluate(() => {
  const el: any = document.querySelector(".footer_bar_tool.ruler");
  if (!el) return "missing";
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  return "ok";
});
console.log("ruler pick:", pick);
await page.waitForTimeout(500);

const st = await page.evaluate(() => {
  const w: any = window as any;
  return {
    tool: w.tool, plan: w.plan, plan_: w.plan_,
    mode: w.mode ?? null,
    toolClass: typeof w.tool,
  };
});
console.log("state:", JSON.stringify(st));

// попытка 1: от стены до стены по горизонтали (оси стен базы)
await dragAt(page, { x: 100, y: 0 }, { x: 400, y: 0 });
await page.waitForTimeout(500);
let copy = await copyServer(page);
console.log("try1 rulers:", JSON.stringify(copy.rulers));

// попытка 2: внутри комнаты, от пустого места
await dragAt(page, { x: 150, y: -200 }, { x: 450, y: -200 });
await page.waitForTimeout(500);
copy = await copyServer(page);
console.log("try2 rulers:", JSON.stringify(copy.rulers).slice(0, 500));

// попытка 3: mousedown-move-mouseup с задержками (как пользователь)
await clearFog(page);
await page.mouse.move(200, 400);
await page.waitForTimeout(300);
await page.mouse.down();
await page.waitForTimeout(200);
await page.mouse.move(320, 400, { steps: 10 });
await page.waitForTimeout(200);
await page.mouse.up();
await page.waitForTimeout(800);
copy = await copyServer(page);
console.log("try3 rulers:", JSON.stringify(copy.rulers).slice(0, 1500));

const live = await page.evaluate(() => {
  const w: any = window as any;
  const id = Object.keys(w.RULERS ?? {})[0];
  const r = w.RULERS?.[id];
  if (!r) return { none: true, rulers: Object.keys(w.RULERS ?? {}).length, comments: Object.keys(w.COMMENTS ?? {}).length };
  const proto = Object.getPrototypeOf(r);
  return {
    id,
    props: Object.keys(r),
    inst: JSON.parse(JSON.stringify(r, (k, v) => (["GROUP", "VAL", "P1", "P2", "state", "SVG", "svg", "el", "node"].includes(k) ? undefined : (typeof v === "function" ? "[fn]" : v)))),
    serialize: String(proto.serialize).slice(0, 3000),
    checkTarget: String(proto.checkTarget).slice(0, 3000),
  };
});
writeOut("113-ruler-live2", live);
console.log("live:", JSON.stringify(live, null, 1).slice(0, 3000));

await browser.close();
process.exit(0);
