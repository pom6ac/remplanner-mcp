// 88: форматы электрики в анонимном проекте: розетки/выключатели (UI-клики free),
// socket_group (поиск в DOM), связь выключатель→светильник через класс Cable
// (программно, тарифный гейт UI не мешает записи модели), save→reload-нормализация.
import {
  launch, newAnonProject, buildBase, copyServer, switchSheet, pickTool, clickAt,
  writeOut, escape, saveAndReload, D, diffModels,
} from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);
await switchSheet(page, "sockets");

// 1. каталог: все пункты электрических групп с полными полями
const catalog = await page.evaluate(() => {
  const gt: any = (window as any).global_tools ?? {};
  const groups = ["sockets", "switches", "cables", "wires", "shield_module", "shield_cables", "wall_elements"];
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries<any>(gt)) {
    if (v && groups.includes(v.group)) {
      out[k] = { group: v.group, plan: v.plan, anchor: v.anchor, width: v.width, height: v.height,
        self_height: v.self_height, over_floor: v.over_floor, subgroup: v.subgroup ?? null,
        title: v.title ?? null, multi: v.multi ?? null };
    }
  }
  return out;
});
writeOut("88-elec-catalog", catalog);
console.log("catalog electric:", Object.keys(catalog).length);

// 2. розетка у стены (free): клик на внутренней грани стены top
const center = { x: 150, y: -150 };
const wallSpot = { x: 150, y: -290 + 3 };
const res: any = {};
const b0 = await copyServer(page);
for (const name of ["socket", "socket_ip44", "socket_power", "socket_380"]) {
  const pick = await pickTool(page, name);
  if (pick !== "ok") { res[name] = { pick }; console.log(name, pick); continue; }
  await clickAt(page, { x: center.x + (name.length % 4) * 40, y: wallSpot.y });
  await escape(page);
  const a = await copyServer(page);
  const added = Object.values<any>(a.items ?? {}).filter((it: any) => !Object.keys(b0.items ?? {}).includes(it.id));
  const item = added.find((it: any) => it.name === name);
  res[name] = item ? { item } : { pick, added: added.map((x: any) => x.name) };
  console.log(name, item ? "OK" : "NO ITEM");
}

// 3. выключатель на листе выключателей
await switchSheet(page, "light_connections");
const b1 = await copyServer(page);
for (const name of ["light_switch", "light_switch_double"]) {
  const pick = await pickTool(page, name);
  if (pick !== "ok") { res[name] = { pick }; console.log(name, pick); continue; }
  await clickAt(page, { x: 260 + (name.length % 3) * 30, y: wallSpot.y });
  await escape(page);
  const a = await copyServer(page);
  const added = Object.values<any>(a.items ?? {}).filter((it: any) => !Object.keys(b1.items ?? {}).includes(it.id));
  const item = added.find((it: any) => it.name === name);
  res[name] = item ? { item } : { pick, added: added.map((x: any) => x.name) };
  console.log(name, item ? "OK" : "NO ITEM");
}

// 4. светильник на листе света (потолочный)
await switchSheet(page, "light");
const b2 = await copyServer(page);
const pickL = await pickTool(page, "chandelier");
await clickAt(page, { x: 150, y: -150 });
await escape(page);
const a2 = await copyServer(page);
const chandelier = Object.values<any>(a2.items ?? {}).find((it: any) => it.name === "chandelier");
res["chandelier"] = chandelier ?? { pick: pickL };
console.log("chandelier", chandelier ? "OK" : "NO ITEM");

// 5. связь выключатель→светильник: класс Cable программно
const cableDump = await page.evaluate(() => {
  const w: any = window as any;
  const switchItem = Object.values<any>(w.WALLS).find?.((x: any) => false) ?? null;
  // найти предметы
  const items = Object.values<any>(w.project?.items ?? w.ITEMS ?? {});
  const sw = items.find((i: any) => i.name === "light_switch");
  const ch = items.find((i: any) => i.name === "chandelier");
  if (!sw || !ch) return { error: "нет предметов", itemsKeys: Object.keys(w).filter(k => /ITEM|SWITCH|CABLE/i.test(k)) };
  const cableId = w.LIB.id();
  const cable = new w.Cable
    ? null : null;
  const Ctor = (w as any).Cable ?? (globalThis as any).Cable;
  if (!Ctor) return { error: "нет класса Cable в глобале", itemSwitch: sw, chandelier: ch };
  const obj = new Ctor({ id: cableId, type: "cable", items: {}, vertexes: [
    { id: w.LIB.id(), point: { x: sw.pc.x, y: sw.pc.y }, type: "node", id_room: "" },
    { id: w.LIB.id(), point: { x: ch.pc.x, y: ch.pc.y }, type: "node", id_room: "" },
  ], matrix: [[null, { length: 1 }], [{ length: 1 }, null]], props: {}, on_size: 0 });
  // привязка концов к предметам — как делает редактор: узел ссылается на предмет
  try { obj.items[obj.vertexes[0].id] = sw.id; } catch (e) { return { error: "attach1 " + String(e) }; }
  try { obj.items[obj.vertexes[1].id] = ch.id; } catch (e) { return { error: "attach2 " + String(e) }; }
  const coll = w.project.cables ?? (w.CABLES ?? null);
  if (coll) coll[cableId] = obj;
  else if (w.project.cables) w.project.cables[cableId] = obj;
  else return { error: "нет коллекции cables", projectKeys: Object.keys(w.project) };
  try { w.project.localSave(); } catch { /* */ }
  return { ok: true, itemSwitch: sw, chandelier: ch, cable: JSON.parse(JSON.stringify(obj)) };
});
writeOut("88-elec-cable", cableDump);
console.log("cable:", JSON.stringify(cableDump).slice(0, 600));

// 6. copy("server") после связи + нормализация save→reload
const afterCable = await copyServer(page);
writeOut("88-elec-after-cable", { sockets: res, diff: diffModels(b0, afterCable) });
const sr = await saveAndReload(page);
console.log("save:", JSON.stringify(sr));
const afterReload = await copyServer(page);
writeOut("88-elec-after-reload", afterReload);
const keys = Object.keys(afterReload).filter((k) => /cable|switch|socket|shield/i.test(k));
console.log("elec keys after reload:", keys.map((k) => `${k}:${JSON.stringify(afterReload[k]).slice(0, 200)}`).join("\n"));

await browser.close();
process.exit(0);
