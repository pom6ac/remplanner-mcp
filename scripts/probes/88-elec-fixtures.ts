// 88: UI-эталоны электрики — клики по бесплатным пунктам розеток/выключателей
// в анонимном проекте (эталоны ui-ref-elec-*.json). PRO-пункты не кликаются —
// умолчания из каталога (проба 88-elec-live в PRO-проекте, без записи).
import { launch, newAnonProject, buildBase, copyServer, switchSheet, pickTool, clickAt,
  writeOut, escape, D } from "./phase2-lib.ts";
import { writeFileSync, mkdirSync } from "node:fs";

const SOCKETS = ["socket", "socket_ip44", "socket_power", "socket_380"];
const SWITCHES = ["light_switch", "light_switch_double"];
const FREE_STANDING = ["ceiling_socket"];

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);

const catalog: Record<string, any> = await page.evaluate(() => {
  const gt: any = (window as any).global_tools ?? {};
  const groups = ["sockets", "switches"];
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries<any>(gt)) {
    if (v && groups.includes(v.group)) {
      out[k] = { id: v.id, group: v.group, width: v.width, height: v.height, self_height: v.self_height, plan: v.plan, anchor: v.anchor, over_floor: v.over_floor, title: v.title };
    }
  }
  return out;
});
writeOut("88-elec-catalog-full", catalog);
console.log("catalog:", Object.keys(catalog).join(","));

mkdirSync("tests/fixtures", { recursive: true });
const center = { x: 150, y: -150 };
const wallSpot = { x: 150, y: -290 + D / 2 + 7 - D / 2 }; // y = -287: 7 см от внутренней грани top (клик строго внутри)
let ok = 0;
const fail: string[] = [];
let i = 0;
const place = async (name: string, sheet: string, wall: boolean) => {
  await switchSheet(page, sheet);
  const pick = await pickTool(page, name);
  if (pick !== "ok") { console.log(name, pick); fail.push(`${name}:${pick}`); return; }
  const b = await copyServer(page);
  const p = wall
    ? { x: center.x - 90 + i * 35, y: wallSpot.y }
    : { x: center.x + 60, y: center.y };
  await clickAt(page, p);
  await escape(page);
  const a = await copyServer(page);
  const added = Object.values<any>(a.items ?? {}).filter((it: any) => !Object.keys(b.items ?? {}).includes(it.id));
  const item = added.find((it: any) => it.name === name) ?? added.find((it: any) => it.name === "socket_group");
  if (!item) { console.log(name, "NO ITEM; added:", added.map((x: any) => x.name).join(",")); fail.push(`${name}:no_item`); return; }
  // обезличивание: id предмета и под-розетки, id стены/комнаты → "0"; wall_line удалён
  const clean = JSON.parse(JSON.stringify(item));
  clean.id = "0";
  if (clean.id_wall !== undefined) clean.id_wall = typeof clean.id_wall === "string" && clean.id_wall ? "0" : clean.id_wall;
  if (clean.id_wall_old !== undefined) clean.id_wall_old = typeof clean.id_wall_old === "string" && clean.id_wall_old ? "0" : clean.id_wall_old;
  if (clean.id_room !== undefined) clean.id_room = typeof clean.id_room === "string" && clean.id_room ? "0" : clean.id_room;
  if (clean.id_room_zone !== undefined) clean.id_room_zone = typeof clean.id_room_zone === "string" && clean.id_room_zone ? "0" : clean.id_room_zone;
  if (clean.wall_line) delete clean.wall_line;
  for (const s of clean.socket_group ?? []) {
    s.id = "0";
    if (s.cables) delete s.cables;
  }
  const entry = catalog[name] ?? {};
  const fixture = {
    _source: `клик по UI анонимного проекта (headless Chromium, ID проекта/плана обезличены), проба 88-elec-fixtures, model project.copy("server"), без сохранения; id предмета, под-розетки, id_wall/id_wall_old/id_room/id_room_zone обезличены ("0"); wall_line удалён; координаты — точки листа базы «коридор + 3 комнаты» (не идентифицируют)`,
    menu_title: entry.title ?? name,
    tool_id: `plannertool_${name}`,
    catalog_defaults_cm: entry,
    model_object: clean,
  };
  writeFileSync(`tests/fixtures/ui-ref-elec-${name}.json`, JSON.stringify(fixture, null, 1) + "\n");
  ok++;
  console.log(name, "OK", JSON.stringify({ name: clean.name, w: clean.width, h: clean.height, of: JSON.stringify(clean.over_floor), subs: (clean.socket_group ?? []).map((s: any) => s.name) }));
  i++;
};

for (const name of SOCKETS) await place(name, "sockets", true);
for (const name of SWITCHES) await place(name, "light_connections", true);
for (const name of FREE_STANDING) await place(name, "sockets", false);
console.log(`done: ${ok} ok, fail: ${fail.join(", ") || "нет"}`);
writeOut("88-elec-fixtures-summary", { ok, fail });
await browser.close();
process.exit(fail.length > 0 ? 1 : 0);
