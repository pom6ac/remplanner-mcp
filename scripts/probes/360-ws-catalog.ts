// 360: выгрузка записей каталога (window.global_tools) для водоснабжения — анонимный проект.
// Запуск: node scripts/probes/360-ws-catalog.ts
import { launch, newAnonProject, writeOut } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
const tools = await page.evaluate(() => {
  const gt: any = (window as any).global_tools ?? (window as any).tools;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries<any>(gt ?? {})) {
    if (/waterspot|water_pipe|water_hot|drainage_pipe|^water$|water_column|drainage_column|ceiling_water/.test(k)) {
      out[k] = {
        id: v.id, group: v.group, subgroup: v.subgroup, width: v.width, height: v.height,
        self_height: v.self_height, plan: v.plan, anchor: v.anchor, over_floor: v.over_floor,
        offset: v.offset, can_be_outside: v.can_be_outside, is_magnetized: v.is_magnetized,
        title: v.title,
      };
    }
  }
  return { keys: Object.keys(gt ?? {}).length, picked: out };
});
writeOut("360-ws-catalog", tools);
console.log(JSON.stringify(tools.picked, null, 1).slice(0, 4000));
await browser.close();
process.exit(0);
