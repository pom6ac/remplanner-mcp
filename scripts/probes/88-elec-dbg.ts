// 88: отладка размещения и классов связи: ITEM-глобалы, $CablingSwitcher, поиск
// конструктора кабеля в бандле через instance существующих коллекций.
import {
  launch, newAnonProject, buildBase, copyServer, switchSheet, pickTool, clickAt,
  writeOut, escape, shot,
} from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);

// сколько предметов после каждого шага
const count = () => page.evaluate(() => {
  const w: any = window as any;
  return { ITEMS: Object.keys(w.ITEMS ?? {}).length, CABLES: Object.keys(w.CABLES ?? {}).length,
    projectItems: w.project?.items ? Object.keys(w.project.items).length : null };
});

await switchSheet(page, "light_connections");
console.log("after sheet switch:", JSON.stringify(await count()));
const pick = await pickTool(page, "light_switch");
console.log("pick light_switch:", pick, JSON.stringify(await count()));
// правая стена: внутренняя грань x=590, клик на 7 см внутрь
await clickAt(page, { x: 583, y: -200 });
await escape(page);
console.log("after click:", JSON.stringify(await count()));
await shot(page, "88-dbg-switch");

const a = await copyServer(page);
console.log("model items:", Object.values<any>(a.items ?? {}).map((i: any) => i.name).join(","));
writeOut("88-dbg-items", a);

// классы
const api = await page.evaluate(() => {
  const w: any = window as any;
  const out: Record<string, unknown> = {};
  out.cablingSwitcherKeys = Object.keys(w.$CablingSwitcher ?? {});
  for (const k of Object.keys(w.$CablingSwitcher ?? {})) {
    const v = (w.$CablingSwitcher as any)[k];
    if (typeof v === "function") (out as any)["fn_" + k] = v.toString().slice(0, 2500);
  }
  out.cableProto = (() => {
    const c = Object.values<any>(w.CABLES ?? {})[0];
    if (!c) return null;
    return Object.getOwnPropertyNames(Object.getPrototypeOf(c));
  })();
  // ищем конструктор GraphLines-подобных классов в бандле
  out.bundleUrls = performance.getEntriesByType("resource").map((r: any) => r.name).filter((u: string) => /app|bundle|chunk/.test(u)).slice(0, 10);
  return out;
});
writeOut("88-dbg-cabling", api);
console.log("cabling keys:", JSON.stringify(api.cablingSwitcherKeys));
console.log("bundleUrls:", JSON.stringify(api.bundleUrls));

await browser.close();
process.exit(0);
