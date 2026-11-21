// 360: разведка UI «Узел» (waterspot_node) на листе «Водоснабжение» — анонимный проект
// (без cookies аккаунта, без save в чужие объекты). Формат узла, контекстное меню,
// доступность инструмента. Запуск: node scripts/probes/360-ws-node.ts
import {
  launch, newAnonProject, buildBase, copyServer, switchSheet, pickTool, clickAt, escape,
  diffModels, writeOut, shot,
} from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
const before = await copyServer(page);
await buildBase(page);
const afterBase = await copyServer(page);
await switchSheet(page, "waterplan");

// 1. разметка листа: какие инструменты waterspot* видны и их is_pro
const tools = await page.evaluate(() => {
  const out: Record<string, string> = {};
  for (const el of Array.from(document.querySelectorAll("[id^=plannertool_]"))) {
    const id = el.id.replace("plannertool_", "");
    if (/waterspot|water_|drainage/.test(id)) {
      const group = el.closest(".tools_item, .subtools_item");
      out[id] = el.classList.contains("is_pro") || (group && group.classList.contains("is_pro")) ? "PRO" : "free";
    }
  }
  return out;
});
writeOut("360-ws-tools", tools);
console.log("tools:", JSON.stringify(tools));

// 2. клик «Узел» в комнате
const pick = await pickTool(page, "waterspot_node");
console.log("pick waterspot_node:", pick);
if (pick === "ok") {
  await clickAt(page, { x: 150, y: -250 });
  await escape(page);
  const after = await copyServer(page);
  const diff = diffModels(afterBase, after);
  writeOut("360-ws-node-click", diff);
  console.log("node click diff keys:", JSON.stringify(Object.keys(diff)));
  for (const k of Object.keys(diff)) {
    const d = (diff as any)[k];
    if (d && (d.added || d.changed || d.removed)) {
      console.log(k, "added:", JSON.stringify(d.added), "changed:", JSON.stringify(d.changed)?.slice(0, 400));
    }
  }
  // контекстное меню узла
  await clickAt(page, { x: 150, y: -250 }, "right");
  const menus = await page.evaluate(() =>
    Array.from(document.querySelectorAll("[id^=cm-]"))
      .filter((e: any) => e.offsetParent !== null)
      .map((e: any) => ({ id: e.id, rows: Array.from(e.querySelectorAll("li, .cm_item, input")).slice(0, 12).map((r: any) => r.id || r.getAttribute("action") || r.textContent?.trim()?.slice(0, 40)) })));
  writeOut("360-ws-node-cm", menus);
  console.log("menus:", JSON.stringify(menus).slice(0, 1200));
  await escape(page);
}

// 3. второй узел рядом + roundtrip save→reload (анонимный проект)
if (pick === "ok") {
  await pickTool(page, "waterspot_node");
  await clickAt(page, { x: 250, y: -250 });
  await escape(page);
  const saved = await saveAndReload(page);
  console.log("save:", JSON.stringify(saved));
  const afterReload = await copyServer(page);
  writeOut("360-ws-node-roundtrip", { afterReload: afterReload, saved });
  const items = afterReload.items ?? {};
  const nodes = Object.entries<any>(items).filter(([, v]) => /node/.test(String(v?.name)));
  console.log("node items after reload:", JSON.stringify(nodes).slice(0, 600));
  const pipes = afterReload.pipes ?? {};
  console.log("pipes after reload:", JSON.stringify(pipes).slice(0, 600));
}

await shot(page, "360-ws-node-final");
await browser.close();
process.exit(0);
