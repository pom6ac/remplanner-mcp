// 88: эмпирическая сборка связи выключатель→светильник: socket_group с light_switch,
// chandelier, ручной Cable (вершины: "<groupId>|s|<subId>" + item id), backrefs,
// copy("server") + save→reload → что нормализует редактор.
import {
  launch, newAnonProject, buildBase, copyServer, switchSheet, pickTool, clickAt,
  writeOut, escape, saveAndReload, diffModels,
} from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);

// 1. выключатель (правая стена, x=583) и розетка (левая стена, x=7)
await switchSheet(page, "light_connections");
const pick = await pickTool(page, "light_switch");
console.log("pick light_switch:", pick);
await clickAt(page, { x: 430, y: -287 });
await escape(page);
await switchSheet(page, "sockets");
const pick2 = await pickTool(page, "socket");
console.log("pick socket:", pick2);
await clickAt(page, { x: 480, y: -287 });
await escape(page);
await switchSheet(page, "light");
const pick3 = await pickTool(page, "chandelier");
console.log("pick chandelier:", pick3);
await clickAt(page, { x: 150, y: -150 });
await escape(page);

const model = await copyServer(page);
const sw = Object.values<any>(model.items ?? {}).find((it: any) =>
  it.name === "socket_group" && (it.socket_group ?? []).some((s: any) => s.name === "light_switch"));
const sock = Object.values<any>(model.items ?? {}).find((it: any) =>
  it.name === "socket_group" && (it.socket_group ?? []).some((s: any) => s.name === "socket"));
const ch = Object.values<any>(model.items ?? {}).find((it: any) => it.name === "chandelier");
console.log("sw:", sw ? sw.id : "NO", "sock:", sock ? sock.id : "NO", "ch:", ch ? ch.id : "NO");
writeOut("88-elec-formats3-items", { sw, sock, ch });
if (!sw || !ch) { console.log("FAIL: предметы не размещены"); await browser.close(); process.exit(1); }

// 2. ручной Cable: выключатель → люстра
const built = await page.evaluate(() => {
  const w: any = window as any;
  const items = Object.values<any>(w.ITEMS ?? {});
  const sw = items.find((it: any) => it.props?.name === "socket_group" && (it.props.socket_group ?? []).some((s: any) => s.name === "light_switch"));
  const ch = items.find((it: any) => it.props?.name === "chandelier");
  if (!sw || !ch) return { error: "нет предметов", n: items.length };
  const sub = sw.props.socket_group.find((s: any) => s.name === "light_switch");
  const Ctor = (globalThis as any).Cable ?? (w as any).Cable;
  if (typeof Ctor !== "function") {
    // класс не в глобале — ищем через существующую коллекцию (пусто) — берём из бандла нельзя;
    // собираем Plain-объект и кладём в CABLES: редактор при load создаёт класс из данных
    const id = w.LIB.id();
    const vSw = { id: w.$SocketsGroup.generateIdSocket(sw, sub.id), point: { x: sub.center.x, y: sub.center.y }, type: "switch", id_room: "" };
    const vCh = { id: ch.id, point: { x: ch.props.pc.x, y: ch.props.pc.y }, type: "lamp", id_room: "" };
    const lengthM = Math.round(Math.hypot(vSw.point.x - vCh.point.x, vSw.point.y - vCh.point.y)) / 100;
    const obj = { id, matrix: [[null, { length: 1 }], [{ length: 1 }, null]],
      vertexes: [vSw, vCh], items: { [vSw.id]: "switch", [vCh.id]: "lamp" },
      type: "cable", color_custom: "", length: lengthM, on_arc: 1 };
    w.CABLES.restore({ [id]: obj });
    sub.cables = { cable_id: id };
    ch.props.cables = { cable_id: id };
    try { w.project.localSave(); } catch { /* */ }
    return { ok: true, id, plain: true, swId: sw.id, subId: sub.id, chId: ch.id };
  }
  return { error: "ctor найден, но не ждали" };
});
console.log("built:", JSON.stringify(built));
writeOut("88-elec-formats3-built", built);

const dbgDump = await page.evaluate(() => {
  const w = window;
  const out = {};
  for (const [k, c] of Object.entries(w.CABLES ?? {})) {
    if (c && c.serialize) out[k] = { isInstance: true, vertexes: c.vertexes, items: c.items };
    else out[k] = { raw: c };
  }
  return out;
});
console.log("CABLES dump:", JSON.stringify(dbgDump).slice(0, 900));
const after = await copyServer(page);
const cableAfter = after.cables ?? {};
console.log("cable in server copy:", JSON.stringify(cableAfter).slice(0, 900));
writeOut("88-elec-formats3-after", cableAfter);

// 3. save → reload
const sr = await saveAndReload(page);
console.log("save:", JSON.stringify(sr));
const m2 = await copyServer(page);
const items2 = m2.items ?? {};
const sw2 = Object.values<any>(items2).find((it: any) =>
  it.name === "socket_group" && (it.socket_group ?? []).some((s: any) => s.name === "light_switch"));
const ch2 = Object.values<any>(items2).find((it: any) => it.name === "chandelier");
console.log("cables after reload:", JSON.stringify(m2.cables ?? {}).slice(0, 1000));
console.log("switch sub after reload:", JSON.stringify(sw2?.socket_group ?? []).slice(0, 600));
console.log("chandelier cables after reload:", JSON.stringify(ch2?.cables ?? null));
writeOut("88-elec-formats3-reload", { cables: m2.cables ?? {}, sw: sw2 ?? null, ch: ch2 ?? null });
await browser.close();
process.exit(0);
