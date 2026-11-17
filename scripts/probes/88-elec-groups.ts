// 88: розеточные группы в UI: socket_group tool, слияние соседних розеток,
// добавление под-розетки в существующую группу, панель свойств.
import {
  launch, newAnonProject, buildBase, copyServer, switchSheet, pickTool, clickAt,
  writeOut, escape,
} from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);
await switchSheet(page, "sockets");

// все tools_item/subtools_item на листе + их видимость
const ui = await page.evaluate(() => {
  const out: any[] = [];
  for (const el of Array.from(document.querySelectorAll(".tools_item, .subtools_item, [id^='plannertool_']"))) {
    const anyEl = el as any;
    out.push({ tag: el.className, id: el.id ?? "", visible: anyEl.offsetParent !== null,
      pro: el.classList.contains("is_pro"), title: anyEl.title || "" });
  }
  return out;
});
writeOut("88-elec-sockets-dom", ui);

const dumpItems = async (label: string) => {
  const m = await copyServer(page);
  const items = Object.values<any>(m.items ?? {}).filter((it: any) => it.name === "socket_group" || String(it.name).startsWith("socket"));
  console.log(label, JSON.stringify(items.map((it: any) => ({
    id: it.id, name: it.name, pc: it.pc,
    subs: (it.socket_group ?? []).map((s: any) => s.name),
  }))));
  return m;
};

// 1. две розетки рядом (20 см) — сольются ли в одну группу?
await pickTool(page, "socket");
await clickAt(page, { x: 100, y: -287 });
await escape(page);
await pickTool(page, "socket");
await clickAt(page, { x: 120, y: -287 });
await escape(page);
await dumpItems("после двух розеток (20 см):");

// 2. розетка у существующей группы (клик возле первой)
await pickTool(page, "socket");
await clickAt(page, { x: 105, y: -287 });
await escape(page);
await dumpItems("после третьей (клик возле первой):");

// 3. выключатель рядом с розеткой — общая группа?
await switchSheet(page, "light_connections");
const pk = await pickTool(page, "light_switch");
console.log("pick light_switch:", pk);
await clickAt(page, { x: 140, y: -287 });
await escape(page);
const m3 = await dumpItems("после выключателя возле розетки:");

writeOut("88-elec-groups", m3.items ?? {});
await browser.close();
process.exit(0);
