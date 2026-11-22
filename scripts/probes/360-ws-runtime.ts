// 360:runtime — карты подключений текущего редактора (анонимный проект): PipingWater
// (waterspots/source_items/is_multi/get_type), поведение Pipe.getTypeItem для предмета
// waterspot_node. Запуск: node scripts/probes/360-ws-runtime.ts
import { launch, newAnonProject, writeOut } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
const info = await page.evaluate(() => {
  const w = window as any;
  const pw = (w as any).$PipingWater;
  const out: Record<string, unknown> = {
    tools: pw?.tools,
    name_object_lines: pw?.name_object_lines,
    names_line_id_by_tool: pw?.names_line_id_by_tool,
    waterspots: pw?.waterspots,
    multi_spots: pw?.multi_spots,
    pipes_by_name: pw?.pipes_by_name,
    water_items: pw?.water_items,
    drainage_items: pw?.drainage_items,
    composite_items: pw?.composite_items,
    legend_items: pw?.legend_items,
    all_items: pw?.all_items,
    offset_point_water_pipe_w: pw?.offset_point_water_pipe_w,
    offset_point_water_pipe_d: pw?.offset_point_water_pipe_d,
    offset_point_drainage_pipe: pw?.offset_point_drainage_pipe,
  };
  // GetTypeItem для фиктивного item-подобного объекта с именем waterspot_node
  const fake = { props: { id: "x1", name: "waterspot_node" } };
  const tree = { nodes: {}, nodesHas: () => false };
  try {
    out.type_item_waterspot_node = pw ? (w as any).PIPES && undefined : undefined;
  } catch { /* */ }
  try {
    // Pipe.getTypeItem живёт на экземпляре класса Pipe; создаём через новый объект нельзя —
    // берём прототип через хранилище
    const PIPES: any = (w as any).PIPES;
    const proto = PIPES && Object.getPrototypeOf(Object.getPrototypeOf(PIPES));
    out.pipe_get_type_item_keys = proto ? Object.getOwnPropertyNames(proto).filter((n: string) => /type/i.test(n)) : null;
  } catch (e) { out.proto_err = String(e); }
  // is_multi и is_node для fake
  try { out.is_node_waterspot_node = pw ? pw.is_node(fake) : null; } catch (e) { out.is_node_err = String(e); }
  try { out.is_multi_waterspot_node = pw ? pw.is_multi(fake) : null; } catch (e) { out.is_multi_err = String(e); }
  try { out.get_name_item = pw ? pw.get_name_item(fake) : null; } catch (e) { /* */ }
  // классы-менеджеры труб: getNameItem/getTypeItem прототипов
  try {
    const storages = ["PIPES", "PIPES_GAS", "PIPES_HEAT", "PIPES_VENTILATION", "PIPES_WARM_FLOOR", "PIPES_CONDITIONER"];
    for (const k of storages) {
      const s: any = (w as any)[k];
      if (!s) continue;
      let p = Object.getPrototypeOf(s);
      let found: string | null = null;
      for (let i = 0; i < 4 && p; i++) {
        const names = Object.getOwnPropertyNames(p);
        if (names.includes("getTypeItem")) {
          found = `depth${i}: ${names.filter((n: string) => /typeItem|isNode|getNameItem/.test(n)).join(",")}`;
          break;
        }
        p = Object.getPrototypeOf(p);
      }
      out[`proto_${k}`] = found;
    }
  } catch (e) { out.proto_err2 = String(e); }
  return out;
});
writeOut("360-ws-runtime", info);
console.log(JSON.stringify(info, null, 1).slice(0, 5000));
await browser.close();
process.exit(0);
