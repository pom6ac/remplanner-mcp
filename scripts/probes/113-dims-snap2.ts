// 113: разведка шаг 6b — снап линейки (мировые → экранные), комментарий через comments.create.
import { launch, newAnonProject, buildBase, copyServer, writeOut, clearFog, toScreen, escape } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
const ids = await buildBase(page);

async function drawRuler(a: { x: number; y: number }, b: { x: number; y: number }) {
  await page.evaluate(() => {
    (document.querySelector("#rulers") as any).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
  await page.waitForTimeout(300);
  const sa = await toScreen(page, a), sb = await toScreen(page, b);
  await page.mouse.move(sa.x, sa.y);
  await page.waitForTimeout(250);
  await page.mouse.down();
  await page.mouse.move(sb.x, sb.y, { steps: 12 });
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(900);
}

const dumpRulers = () => page.evaluate(() => {
  const w: any = window as any;
  const out: any = {};
  for (const id of Object.keys(w.RULERS ?? {})) {
    out[id] = JSON.parse(JSON.stringify(w.RULERS[id], (k, v) => (["GROUP", "VAL", "P1", "P2", "state", "IMAGE", "svg"].includes(k) ? undefined : (typeof v === "function" ? "[fn]" : v))));
  }
  return out;
});

// 1) линейка: от узла стены left/corner (0,-300) вдоль верха к (300,-300) — оба конца на осях стен
await clearFog(page);
await drawRuler({ x: 0, y: -300 }, { x: 300, y: -300 });
const snap = await dumpRulers();
writeOut("113-ruler-snap", snap);
console.log("snap ruler:", JSON.stringify(snap, null, 1).slice(0, 2200));

// 2) перенос стены top на +50 по Y
const beforeMove = await copyServer(page);
await page.evaluate((wallId) => {
  const w: any = window as any;
  const wall = w.WALLS[wallId];
  wall.p1 = { x: wall.p1.x, y: wall.p1.y + 50 };
  wall.p2 = { x: wall.p2.x, y: wall.p2.y + 50 };
  w.$Project.draw({ rooms: 1 });
}, ids.top);
await page.waitForTimeout(800);
const afterMove = await copyServer(page);
console.log("rulers after wall move:", JSON.stringify(afterMove.rulers, null, 1).slice(0, 1800));
writeOut("113-ruler-after-wall-move", { before: beforeMove.rulers, after: afterMove.rulers });

// 3) комментарий через comments.create (тот же путь, что UI после активации инструмента)
await clearFog(page);
const commentInfo = await page.evaluate(async () => {
  const w: any = window as any;
  // активируем инструмент комментария так же, как кнопка (action_tool_comment)
  const btn = document.querySelector(".footer_bar_tool.comment");
  let gate = "none";
  if (btn) { btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); gate = "clicked"; }
  await new Promise((r) => setTimeout(r, 600));
  const st = { tool: w.tool, comments: Object.keys(w.COMMENTS ?? {}).length, gate, btnCls: btn?.className ?? null };
  return st;
});
console.log("comment activation:", JSON.stringify(commentInfo));
await page.waitForTimeout(300);
// точка внутри комнаты
const pt = await toScreen(page, { x: 150, y: -200 });
await page.mouse.move(pt.x, pt.y);
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(1200);
const st2 = await page.evaluate(() => {
  const w: any = window as any;
  const cmInput = document.querySelector("#cm-comment--input") as any;
  return { tool: w.tool, comments: Object.keys(w.COMMENTS ?? {}), inputVisible: !!cmInput && cmInput.offsetParent !== null, cmHtml: document.querySelector("#cm-comment")?.outerHTML?.slice(0, 1500) ?? null };
});
console.log("after click:", JSON.stringify({ tool: st2.tool, comments: st2.comments, inputVisible: st2.inputVisible }));
if (st2.inputVisible) {
  await page.keyboard.type("Проба 113");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
}
const afterComment = await copyServer(page);
console.log("model comments:", JSON.stringify(afterComment.comments, null, 1).slice(0, 2000));
writeOut("113-comment-model", afterComment.comments);
await escape(page);

const cLive = await page.evaluate(() => {
  const w: any = window as any;
  const id = Object.keys(w.COMMENTS ?? {})[0];
  const c = w.COMMENTS?.[id];
  if (!c) return { none: true };
  return {
    id,
    inst: JSON.parse(JSON.stringify(c, (k, v) => (["IMAGE", "state", "bubble", "legend", "image_link", "image_link_rect", "circles", "lines", "SVG", "svg"].includes(k) ? undefined : (typeof v === "function" ? "[fn]" : v)))),
    ser: c.serialize(),
  };
});
writeOut("113-comment-live", cLive);
console.log("comment live:", JSON.stringify(cLive, null, 1).slice(0, 2200));

await browser.close();
process.exit(0);
