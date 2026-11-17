// 88: форматы связи выключатель→светильник: размещаем выключатель (чистая стена),
// люстру, строим Cable программно через глобал редактора, смотрим copy("server")
// и обратные ссылки, затем save→reload.
import {
  launch, newAnonProject, buildBase, copyServer, switchSheet, pickTool, clickAt,
  writeOut, escape, saveAndReload, diffModels,
} from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);
await switchSheet(page, "light_connections");

const res: any = {};
const b0 = await copyServer(page);
// выключатель — правая стена (x=590+3 внутрь), чистое место
for (const name of ["light_switch", "light_switch_double"]) {
  const pick = await pickTool(page, name);
  if (pick !== "ok") { res[name] = { pick }; console.log(name, pick); continue; }
  await clickAt(page, { x: 597, y: -200 - (name === "light_switch_double" ? 60 : 0) });
  await escape(page);
}
const a0 = await copyServer(page);
const switches = Object.values<any>(a0.items ?? {}).filter((it: any) => it.name.startsWith("light_switch"));
console.log("switches placed:", switches.map((s: any) => s.name).join(","));
res.switches = switches;

// люстра
await switchSheet(page, "light");
const pickL = await pickTool(page, "chandelier");
await clickAt(page, { x: 300, y: -150 });
await escape(page);
const a1 = await copyServer(page);
const ch = Object.values<any>(a1.items ?? {}).find((it: any) => it.name === "chandelier");
console.log("chandelier:", ch ? ch.id : "NO");
res.chandelier = ch ?? null;

// классы и помощники связи
const api = await page.evaluate(() => {
  const w: any = window as any;
  const names = ["Cable", "CablesSocket", "$CablingSwitcher", "CablingSwitcher"];
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = (w as any)[n] ?? (globalThis as any)[n];
    out[n] = typeof v === "function" ? v.toString().slice(0, 3000) : String(typeof v);
  }
  return out;
});
writeOut("88-elec-cable-class", api);
console.log("Cable class head:", api.Cable.slice(0, 200));
console.log("CablingSwitcher:", api.$CablingSwitcher.slice(0, 300));

// строим связь программно: узлы кабеля ссылаются на предметы
const link = await page.evaluate(() => {
  const w: any = window as any;
  const items = Object.values<any>(w.ITEMS ?? {});
  const sw = items.find((i: any) => i.name === "light_switch");
  const ch = items.find((i: any) => i.name === "chandelier");
  if (!sw || !ch) return { error: "нет предметов", count: items.length };
  const Ctor = (w as any).Cable ?? (globalThis as any).Cable;
  if (typeof Ctor !== "function") return { error: "нет класса Cable" };
  const id = w.LIB.id();
  const v1 = { id: w.LIB.id(), point: { x: sw.pc.x, y: sw.pc.y }, type: "node", id_room: "" };
  const v2 = { id: w.LIB.id(), point: { x: ch.pc.x, y: ch.pc.y }, type: "node", id_room: "" };
  const obj = new Ctor({ id, type: "cable", items: {}, vertexes: [v1, v2],
    matrix: [[null, { length: 1 }], [{ length: 1 }, null]], props: {}, on_size: 0 });
  obj.items[v1.id] = sw.id;
  obj.items[v2.id] = ch.id;
  w.CABLES[id] = obj;
  try { w.project.localSave(); } catch { /* */ }
  return {
    ok: true, switch: JSON.parse(JSON.stringify(sw)), chandelier: { id: ch.id, name: ch.name },
    cable: JSON.parse(JSON.stringify(obj)),
  };
});
writeOut("88-elec-link", link);
console.log("link:", JSON.stringify(link).slice(0, 1500));

const a2 = await copyServer(page);
writeOut("88-elec-after-link", diffModels(b0, a2));
const sr = await saveAndReload(page);
console.log("save:", JSON.stringify(sr));
const a3 = await copyServer(page);
const cables = a3.cables ?? {};
console.log("cables after reload:", JSON.stringify(cables).slice(0, 1200));
const swAfter = Object.values<any>(a3.items ?? {}).filter((it: any) => it.name.startsWith("light_switch") || it.name === "chandelier");
for (const s of swAfter) console.log("item", s.name, JSON.stringify(Object.keys(s)), "keys/conn:", JSON.stringify({ keys: (s as any).keys ?? null, lights: (s as any).lights ?? null, id_cable: (s as any).id_cable ?? null }));
writeOut("88-elec-after-link-reload", { cables, items: swAfter });
await browser.close();
process.exit(0);
