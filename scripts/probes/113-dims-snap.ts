// 113: разведка шаг 6 — снап линейки к стене (p*_target), поведение при переносе/удалении стены,
// комментарий через конструктор (PRO-гейт UI не задействуем), serialize Comment.
import { launch, newAnonProject, buildBase, copyServer, writeOut, clearFog } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
const ids = await buildBase(page);

async function drawRuler(a: { x: number; y: number }, b: { x: number; y: number }) {
  await page.evaluate(() => {
    (document.querySelector("#rulers") as any).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
  await page.waitForTimeout(300);
  await page.mouse.move(a.x, a.y);
  await page.waitForTimeout(250);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 12 });
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(800);
}

// линейка вдоль оси стены top (y=-300), от x=100 до x=400 — конец на оси стены
await drawRuler({ x: 100, y: -300 }, { x: 400, y: -300 });
const snap = await page.evaluate(() => {
  const w: any = window as any;
  const out: any = {};
  for (const id of Object.keys(w.RULERS ?? {})) {
    const r = w.RULERS[id];
    out[id] = JSON.parse(JSON.stringify(r, (k, v) => (["GROUP", "VAL", "P1", "P2", "state", "IMAGE", "svg"].includes(k) ? undefined : (typeof v === "function" ? "[fn]" : v))));
  }
  return out;
});
writeOut("113-ruler-snap", snap);
console.log("snap ruler:", JSON.stringify(snap, null, 1).slice(0, 2000));

// перенос стены top на +50 по Y средствами редактора (как делает move_wall в UI)
const beforeMove = await copyServer(page);
await page.evaluate((wallId) => {
  const w: any = window as any;
  const wall = w.WALLS[wallId];
  const dy = 50;
  wall.p1 = { x: wall.p1.x, y: wall.p1.y + dy };
  wall.p2 = { x: wall.p2.x, y: wall.p2.y + dy };
  w.$Project.draw({ rooms: 1 });
}, ids.top);
await page.waitForTimeout(800);
const afterMove = await copyServer(page);
console.log("rulers after wall move:", JSON.stringify(afterMove.rulers, null, 1).slice(0, 1800));
writeOut("113-ruler-after-wall-move", { before: beforeMove.rulers, after: afterMove.rulers });

// комментарий: напрямую конструктором (PRO-гейт кнопки не задействуем)
const commentInfo = await page.evaluate(() => {
  const w: any = window as any;
  const c = new w.Comment({ points: [{ x: 150, y: -200 }], text: "Проба 113", label: "free", plan: "a", plan_: 0, prs: { room: 0, mode: 1 }, font_size: w.defs?.comments?.defaultFontSize ?? 10, framed: true });
  w.COMMENTS[c.id] = c;
  const proto = Object.getPrototypeOf(c);
  const keys = Object.keys(c).filter((k) => !["IMAGE", "state", "bubble", "legend", "image_link", "image_link_rect", "circles", "lines"].includes(k));
  const inst: Record<string, unknown> = {};
  for (const k of keys) { try { inst[k] = JSON.parse(JSON.stringify(c[k], (kk, vv) => (typeof vv === "function" ? "[fn]" : vv))); } catch { inst[k] = "[unser]"; } }
  return { id: c.id, inst, ser: c.serialize?.() ?? null, serSrc: String(proto.serialize ?? "").slice(0, 2500) };
});
writeOut("113-comment-probe", commentInfo);
console.log("comment inst:", JSON.stringify(commentInfo.inst, null, 1).slice(0, 1800));
console.log("comment ser:", JSON.stringify(commentInfo.ser));
console.log("comment serSrc:", String(commentInfo.serSrc).slice(0, 2200));

const withComment = await copyServer(page);
console.log("model comments:", JSON.stringify(withComment.comments, null, 1).slice(0, 1500));
writeOut("113-comment-model", withComment.comments);

await browser.close();
process.exit(0);
