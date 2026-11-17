// 113: разведка шаг 7 — p*_target (узлы/предметы), комментарий через tool="comment" вручную.
import { launch, newAnonProject, buildBase, copyServer, writeOut, clearFog, toScreen, escape } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);

const dumpRulers = () => page.evaluate(() => {
  const w: any = window as any;
  const out: any = {};
  for (const id of Object.keys(w.RULERS ?? {})) {
    out[id] = JSON.parse(JSON.stringify(w.RULERS[id], (k, v) => (["GROUP", "VAL", "P1", "P2", "state", "IMAGE", "svg"].includes(k) ? undefined : (typeof v === "function" ? "[fn]" : v))));
  }
  return out;
});

// 1) инструмент комментария вручную (без кнопки): tool="comment" + клик
await clearFog(page);
const act = await page.evaluate(() => { (window as any).tool = "comment"; return (window as any).tool; });
console.log("tool set:", act);
const pt = await toScreen(page, { x: 150, y: -200 });
await page.mouse.move(pt.x, pt.y);
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(1200);
const st2 = await page.evaluate(() => {
  const w: any = window as any;
  const cmInput = document.querySelector("#cm-comment--input") as any;
  return { tool: w.tool, comments: Object.keys(w.COMMENTS ?? {}), inputVisible: !!cmInput && cmInput.offsetParent !== null };
});
console.log("after comment click:", JSON.stringify(st2));
if (st2.inputVisible) {
  await page.keyboard.type("Проба 113");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
}
const afterComment = await copyServer(page);
console.log("model comments:", JSON.stringify(afterComment.comments, null, 1).slice(0, 2200));
writeOut("113-comment-model2", afterComment.comments);

const cLive = await page.evaluate(() => {
  const w: any = window as any;
  const id = Object.keys(w.COMMENTS ?? {})[0];
  const c = w.COMMENTS?.[id];
  if (!c) return { none: true };
  const proto = Object.getPrototypeOf(c);
  return {
    id,
    inst: JSON.parse(JSON.stringify(c, (k, v) => (["IMAGE", "state", "bubble", "legend", "image_link", "image_link_rect", "circles", "lines", "SVG", "svg"].includes(k) ? undefined : (typeof v === "function" ? "[fn]" : v)))),
    ser: c.serialize?.() ?? null,
    serSrc: String(proto.serialize ?? "").slice(0, 1500),
  };
});
writeOut("113-comment-live2", cLive);
console.log("comment live:", JSON.stringify(cLive, null, 1).slice(0, 2500));
await escape(page);

// 2) линейка с магнитом: включить магниты? Снап к узлу — проведём от угла (0,120) — узел bottom/left
await clearFog(page);
await page.evaluate(() => {
  (document.querySelector("#rulers") as any).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
});
await page.waitForTimeout(300);
// сначала mousemove рядом с узлом (0,120) — магнит
const p1 = await toScreen(page, { x: 0, y: 120 });
const p2 = await toScreen(page, { x: 300, y: 120 });
await page.mouse.move(p1.x + 2, p1.y + 2, { steps: 4 });
await page.waitForTimeout(400);
await page.mouse.down();
await page.mouse.move(p2.x, p2.y, { steps: 14 });
await page.waitForTimeout(200);
await page.mouse.up();
await page.waitForTimeout(900);
const snap2 = await dumpRulers();
writeOut("113-ruler-snap2", snap2);
console.log("snap2:", JSON.stringify(snap2, null, 1).slice(0, 2400));

await browser.close();
process.exit(0);
