// 239: разведка «Электропроводка», часть 2 (анонимный проект): каталог (global_tools)
// групп cables/wires/shield*, defs-ключи кабелей/щитка, классы бандла (CableSocket и др.),
// сериализация пустых коллекций. Без сохранения.
import { launch, newAnonProject, buildBase, writeOut } from "./phase2-lib.ts";

// Запуск только по явному аргументу (ID проекта/плана — из env):
// node --experimental-strip-types scripts/probes/239-elec2-scout.ts run
if (process.argv[2] !== "run") {
  console.error("запуск по явному аргументу: … " + process.argv[1] + " run (RP_OID/RP_PLAN или REMPLANNER_PROBE_* из env)");
  process.exit(0);
}

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);

const dump = await page.evaluate(() => {
  const w: any = window as any;
  const out: Record<string, any> = {};

  // 1. каталог: пункты групп электрики ч.2
  const groups = ["cables", "wires", "shield", "shield_module", "shield_cables", "wall_elements", "sockets"];
  const tools: Record<string, any> = {};
  for (const [k, v] of Object.entries<any>(w.global_tools ?? {})) {
    if (v && groups.includes(v.group)) {
      tools[k] = {
        group: v.group, plan: v.plan, anchor: v.anchor ?? null, width: v.width, height: v.height,
        self_height: v.self_height, over_floor: v.over_floor ?? null, subgroup: v.subgroup ?? null,
        title: v.title ?? null, multi: v.multi ?? null, is_pro: v.is_pro ?? null,
      };
    }
  }
  out.tools = tools;

  // 2. PRO-разметка инструментов этих групп
  const pro: string[] = [];
  for (const k of Object.keys(tools)) {
    const el: any = document.querySelector(`#plannertool_${k}`);
    const grp: any = el?.closest(".tools_item, .subtools_item");
    if (el?.classList.contains("is_pro") || grp?.classList.contains("is_pro")) pro.push(k);
  }
  out.pro_keys = pro;

  // 3. defs: ключи с cable/wire/shield/kup
  const defs: Record<string, unknown> = {};
  const scan = (obj: any, path: string, depth: number) => {
    if (depth > 3 || obj === null || typeof obj !== "object") return;
    for (const [k, v] of Object.entries<any>(obj)) {
      const p = `${path}.${k}`;
      if (/cable|wire|shield|kup/i.test(k)) defs[p] = depth <= 1 ? v : Array.isArray(v) ? v.slice(0, 40) : (typeof v === "object" ? Object.keys(v).slice(0, 60) : v);
      else if (typeof v === "object" && v !== null) scan(v, p, depth + 1);
    }
  };
  scan(w.defs ?? {}, "defs", 0);
  out.defs = defs;

  // 4. классы бандла
  const classes = ["Cable", "CableSocket", "CableWarnFloor", "CableConditioner", "Cabling", "Electro",
    "Shield", "Shields", "TreeLining", "GraphLines", "SocketsGroup"];
  out.classes = classes.map((c) => {
    const C = w[c];
    if (!C) return { name: c, exists: false };
    const proto = C.prototype ?? {};
    return {
      name: c, exists: true,
      methods: Object.getOwnPropertyNames(proto).slice(0, 60),
      statics: Object.getOwnPropertyNames(C).filter((s) => s !== "prototype" && s !== "length" && s !== "name").slice(0, 20),
    };
  });

  // 5. сериализация модели: ключи-коллекции электрики в copy("server") пустого проекта
  const srv = JSON.parse(JSON.stringify(w.project.copy("server")));
  out.model_keys = Object.keys(srv).sort();
  out.model_elec = Object.fromEntries(Object.entries(srv).filter(([k]) => /cable|shield|wire|electro/i.test(k)).map(([k, v]) => [k, v]));

  // 6. конструктор щитка: глобальные классы/модалки и тариф
  out.shield_globals = Object.keys(w).filter((k) => /shield/i.test(k));
  const sm = document.querySelector("#plannertool_electric_shield, [id*='shield']");
  out.shield_tool_dom = sm ? { id: sm.id, cls: sm.className } : null;

  return out;
});
writeOut("239-elec2-scout", dump);
console.log("tools:", Object.keys(dump.tools ?? {}).length, "pro:", (dump.pro_keys ?? []).length, "classes:", (dump.classes ?? []).filter((c: any) => c.exists).map((c: any) => c.name).join(","));
console.log("model elec keys:", JSON.stringify(dump.model_elec).slice(0, 400));

await browser.close();
process.exit(0);
