// 88: связь выключатель → светодиодная лента: форма обратной ссылки на полосе
// ( LedStrip.serialize) после save→reload в анонимном проекте.
import {
  launch, newAnonProject, buildBase, copyServer, switchSheet, pickTool, clickAt,
  escape, saveAndReload, writeOut,
} from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);

// лента (PRO — программно, тарифный гейт не влияет на запись модели)
await switchSheet(page, "light");
const pk = await pickTool(page, "led_strip");
console.log("pick led_strip:", pk);
// программно: клик PRO отклоняется; ставим через addNode напрямую
const led = await page.evaluate(() => {
  const w = window as any;
  const c = w.$CablingSwitcher; // led_strip — StripingLed, но записываем вручную классом из хранилища
  // LedStrip класс недоступен; восстанавливаем через LED_STRIPS.restore
  const id = w.LIB.id();
  const obj = { id, matrix: [[null, { length: 1 }], [{ length: 1 }, null]],
    vertexes: [
      { id: w.LIB.id(), point: { x: 150, y: -100 }, type: "node", id_room: "" },
      { id: w.LIB.id(), point: { x: 250, y: -100 }, type: "node", id_room: "" },
    ], items: {}, type: "led_strip", length: 1, props: { id, name: "led_strip" }, on_size: 1 };
  const vertexes = obj.vertexes;
  for (const v of vertexes) obj.items[v.id] = "node";
  w.LED_STRIPS.restore({ [id]: obj });
  return id;
});
console.log("led:", led);

// выключатель
await switchSheet(page, "light_connections");
const pk2 = await pickTool(page, "light_switch");
await clickAt(page, { x: 380, y: -287 });
await escape(page);

// связь методами редактора
const link = await page.evaluate((ledId) => {
  const w = window as any;
  const sw = Object.values<any>(w.ITEMS).find((it: any) => it.props?.name === "socket_group" && (it.props.socket_group ?? []).some((s: any) => s.name === "light_switch"));
  const ledStrip = Object.values<any>(w.LED_STRIPS ?? {}).find((l: any) => l.id === ledId);
  if (!sw || !ledStrip) return { error: "нет объектов" };
  const sub = sw.props.socket_group.find((s: any) => s.name === "light_switch");
  w.tool = "cable";
  w.plan = "light_connections";
  sw.selected_socket_group = w.$SocketsGroup.generateIdSocket(sw, sub.id);
  const r1 = w.$ManagerLining.item_mousedown(sw);
  const c = w.$CablingSwitcher;
  // клик по ленте: vertex внутри габарита — ищем ближайшую вершину ленты
  const v = ledStrip.vertexes[0].point;
  const r2 = c.mousedown(null, null, { center: { x: v.x, y: v.y } });
  const cables: any = {};
  for (const [k, cb] of Object.entries<any>(w.CABLES ?? {})) cables[k] = cb.serialize ? cb.serialize() : cb;
  const ledSer = Object.values<any>(w.LED_STRIPS ?? {}).find((l: any) => l.id === ledId)?.serialize();
  return { r1, r2, cables, ledSer, subSer: JSON.parse(JSON.stringify(sub)) };
}, led);
console.log("link:", JSON.stringify(link).slice(0, 1600));
writeOut("88-strip-link", link);

const sr = await saveAndReload(page);
console.log("save:", JSON.stringify(sr));
const after = await copyServer(page);
writeOut("88-strip-after-reload", { cables: after.cables ?? {}, led: Object.values<any>(after.led_strips ?? {})[0] ?? null, items: Object.values<any>(after.items ?? {}).filter((i: any) => i.name === "socket_group") });
console.log("cables after reload:", JSON.stringify(after.cables ?? {}).slice(0, 800));
console.log("led after reload:", JSON.stringify(Object.values<any>(after.led_strips ?? {})[0] ?? {}).slice(0, 800));
await browser.close();
process.exit(0);
