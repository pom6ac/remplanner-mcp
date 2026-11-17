// 122: цепочка предков plannertool_conditioner на листе conditioners vs furniture (sofa).
import { launch, newAnonProject, buildBase, switchSheet } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);

for (const [sheet, tool] of [["furniture", "sofa"], ["conditioners", "conditioner"], ["ventilation", "ventilation_gate"]] as const) {
  await switchSheet(page, sheet);
  const chain = await page.evaluate((toolId) => {
    const el: any = document.querySelector(`#plannertool_${toolId}`);
    if (!el) return null;
    const out: any[] = [];
    let cur: HTMLElement | null = el;
    for (let i = 0; i < 8 && cur; i++) {
      out.push({
        tag: cur.tagName, id: cur.id, cls: String(cur.className).slice(0, 90),
        vis: (cur as any).offsetParent !== null,
        styleDisplay: (cur as any).style?.display || null,
        dataPlan: cur.getAttribute?.("data-plan"),
      });
      cur = cur.parentElement;
    }
    return out;
  }, tool);
  console.log(`--- ${sheet} / ${tool}:`);
  console.log(JSON.stringify(chain, null, 1));
}
await browser.close();
process.exit(0);
