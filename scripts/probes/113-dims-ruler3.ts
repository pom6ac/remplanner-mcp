// 113: разведка шаг 5 — активация линейки через $("#rulers").mousedown, дамп serialize.
import { launch, newAnonProject, buildBase, copyServer, writeOut, clearFog } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);

await clearFog(page);
const st1 = await page.evaluate(() => {
  const w: any = window as any;
  (document.querySelector("#rulers") as any).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  return { tool: w.tool };
});
console.log("after mousedown:", JSON.stringify(st1));
await page.waitForTimeout(400);

// протяжка внутри комнаты (снап к стенам не нужен сначала)
await page.mouse.move(200, 400);
await page.waitForTimeout(250);
await page.mouse.down();
await page.mouse.move(360, 400, { steps: 10 });
await page.waitForTimeout(150);
await page.mouse.up();
await page.waitForTimeout(900);

const live = await page.evaluate(() => {
  const w: any = window as any;
  const id = Object.keys(w.RULERS ?? {})[0];
  const r = w.RULERS?.[id];
  const out: any = { tool: w.tool, rulers: Object.keys(w.RULERS ?? {}).length, created: w.created?.ruler ?? null };
  if (r) {
    const proto = Object.getPrototypeOf(r);
    out.id = id;
    out.inst = JSON.parse(JSON.stringify(r, (k, v) => (["GROUP", "VAL", "P1", "P2", "state", "SVG", "svg", "IMAGE"].includes(k) ? undefined : (typeof v === "function" ? "[fn]" : v))));
    out.serSrc = String(proto.serialize);
    out.serOut = r.serialize();
  }
  return out;
});
writeOut("113-ruler-live3", live);
console.log("live:", JSON.stringify(live, null, 1).slice(0, 1200));
console.log("serialize OUT:", JSON.stringify(live.serOut));
console.log("serialize SRC:", String(live.serSrc).slice(0, 2500));

const copy = await copyServer(page);
console.log("model rulers:", JSON.stringify(copy.rulers, null, 1).slice(0, 2000));

await browser.close();
process.exit(0);
