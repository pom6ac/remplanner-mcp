// 78: разведка UI «Сантехника и водоснабжение» — точки воды (waterspots) в анонимном проекте.
// База phase2-lib: стены, клик инструмента, diff project.copy("server"), PRO-ключи, roundtrip.
// Запуск: node scripts/probes/78-plumb-ui.ts
import {
  launch, newAnonProject, buildBase, copyServer, switchSheet, pickTool, clickAt, escape,
  diffModels, writeOut, shot, saveAndReload, proKeys,
} from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
const before = await copyServer(page);
await buildBase(page);
const afterBase = await copyServer(page);
writeOut("78-plumb-base", diffModels(before, afterBase));

// PRO-ключи: что из сантехники закрыто на бесплатном
const pro = await proKeys(page);
const wanted = ["water_pipe", "water_hot_pipe", "drainage_pipe", "waterspot_cold", "waterspot_hot",
  "waterspot_drainage", "waterspot_collector", "waterspot_cold_hot", "waterspot_drainage_cold",
  "waterspot_drainage_cold_hot", "waterspot_drainage_hot", "waterspot_node"];
writeOut("78-plumb-pro", Object.fromEntries(wanted.map((k) => [k, pro.includes(k)])));
console.log("pro:", wanted.map((k) => `${k}=${pro.includes(k) ? "PRO" : "free"}`).join(" "));

// лист водоснабжения
await switchSheet(page, "waterplan");

// сцена 1: комбинированная точка ХВС+ГВС у внутренней грани стены top (y=-300+10=-290)
const spot: any = {};
for (const [name, where] of [
  ["waterspot_cold_hot", { x: 150, y: -280 }],
  ["waterspot_drainage_cold_hot", { x: 350, y: -280 }],
  ["waterspot_drainage_cold", { x: 250, y: -280 }],
] as const) {
  const pick = await pickTool(page, name);
  if (pick !== "ok") { spot[name] = { pick }; continue; }
  await clickAt(page, { x: where.x, y: where.y });
  await escape(page);
  const after = await copyServer(page);
  spot[name] = { pick, diff: diffModels(afterBase, after) };
  console.log(name, "diff keys:", JSON.stringify(Object.keys(spot[name].diff)));
}
writeOut("78-plumb-waterspots", spot);

// панель свойств точки: правый клик → меню
const item = Object.values<any>(spot["waterspot_cold_hot"]?.diff?.items?.added ?? {})[0];
if (item) {
  await clickAt(page, { x: item.pc.x, y: item.pc.y }, "right");
  const menus = await page.evaluate(() =>
    Array.from(document.querySelectorAll("[id^=cm-]"))
      .filter((e: any) => e.offsetParent !== null)
      .map((e: any) => ({ id: e.id, rows: Array.from(e.querySelectorAll("li, .cm_item, input")).slice(0, 12).map((r: any) => r.id || r.textContent?.trim()?.slice(0, 40)) })));
  writeOut("78-plumb-cm-waterspot", menus);
  await escape(page);
}

// roundtrip: save → reload → точка на месте?
const saved = await saveAndReload(page);
console.log("save:", JSON.stringify(saved));
const afterReload = await copyServer(page);
const spotIds = Object.keys(spot["waterspot_cold_hot"]?.diff?.items?.added ?? {});
const kept = Object.keys(afterReload.items ?? {}).filter((id) => spotIds.includes(id));
writeOut("78-plumb-roundtrip", { spotIds, kept, result: saved });
console.log("roundtrip:", spotIds.length, "->", kept.length);

await shot(page, "78-plumb-final");
await browser.close();
process.exit(0);
