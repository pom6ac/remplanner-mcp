// 88: источник $CablingSwitcher: полные исходники методов связи.
import { launch, newAnonProject, buildBase, writeOut } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);
const api = await page.evaluate(() => {
  const w: any = window as any;
  const cs = w.$CablingSwitcher ?? {};
  const out: Record<string, unknown> = {};
  const seen = new WeakSet();
  const safe = (v: any): any => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return "<circular>";
    seen.add(v);
    if (Array.isArray(v)) return v.map(safe);
    const o: any = {};
    for (const k2 of Object.keys(v)) o[k2] = safe(v[k2]);
    return o;
  };
  for (const k of Object.keys(cs)) {
    const v = (cs as any)[k];
    if (typeof v === "function") (out as any)[k] = v.toString();
    else { try { (out as any)[k] = safe(v); } catch { (out as any)[k] = String(v); } }
  }
  return out;
});
writeOut("88-elec-cabling-full", api);
console.log("keys:", Object.keys(api).join(","));
console.log("class_name:", JSON.stringify(api.class_name), "type_line:", JSON.stringify(api.type_line),
  "props_link:", JSON.stringify(api.props_link), "name_line_id:", JSON.stringify(api.name_line_id),
  "plan:", JSON.stringify(api.plan).slice(0, 200));
await browser.close();
process.exit(0);
