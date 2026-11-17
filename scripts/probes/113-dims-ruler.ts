// 113: разведка шаг 4 — рисование линейки через .footer_bar_tool.ruler, формат serialize.
import { launch, newAnonProject, buildBase, copyServer, writeOut, dragAt, escape } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);

// 1) клик по инструменту-линейке
const pick = await page.evaluate(() => {
  const el: any = document.querySelector(".footer_bar_tool.ruler");
  if (!el) return "missing";
  el.click();
  return "ok";
});
console.log("ruler pick:", pick);
await page.waitForTimeout(500);

// 2) протяжка внутри комнаты
await dragAt(page, { x: 100, y: -150 }, { x: 500, y: -150 });
await escape(page);

const copy = await copyServer(page);
writeOut("113-ruler-ui-model", copy.rulers);
console.log("model rulers:", JSON.stringify(copy.rulers, null, 1).slice(0, 3000));

const live = await page.evaluate(() => {
  const w: any = window as any;
  const id = Object.keys(w.RULERS ?? {})[0];
  const r = w.RULERS?.[id];
  if (!r) return { none: true };
  const proto = Object.getPrototypeOf(r);
  return {
    id,
    props: Object.keys(r),
    values: JSON.parse(JSON.stringify(r, (k, v) => (k === "GROUP" || k === "VAL" || k === "P1" || k === "P2" || k === "state" ? undefined : (typeof v === "function" ? "[fn]" : v)))),
    serialize: String(proto.serialize).slice(0, 3000),
    checkTarget: String(proto.checkTarget).slice(0, 3000),
    update: String(proto.update).slice(0, 3000),
    checkLinkedRulers: String(proto.checkLinkedRulers).slice(0, 2000),
    is_allow_plan: String(proto.is_allow_plan).slice(0, 800),
    contextmenu: document.querySelector("#cm-ruler")?.outerHTML?.slice(0, 2500) ?? null,
  };
});
writeOut("113-ruler-live", live);
console.log("ruler values:", JSON.stringify(live.values ?? live, null, 1).slice(0, 2500));
console.log("serialize:", (live as any).serialize?.slice(0, 2000));

await browser.close();
process.exit(0);
