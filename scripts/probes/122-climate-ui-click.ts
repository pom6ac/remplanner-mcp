// 122: клики UI — тёплый пол (drag в комнате), терморегулятор, кондиционеры. Формат записи.
import { launch, newAnonProject, buildBase, copyServer, switchSheet, pickTool, clickAt,
  writeOut, escape, diffModels, D } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);

// комната A: оси 0..300 x -300..0 (Y вниз), внутренняя грань top: y=-290
const center = { x: 150, y: -150 };
const wallSpot = { x: 150, y: -290 + 3 };

const steps: { sheet: string; tool: string; kind: "click" | "drag"; note: string }[] = [
  { sheet: "warm_floor", tool: "warm_floor", kind: "drag", note: "кабельный тёплый пол — протяжка в комнате" },
  { sheet: "warm_floor", tool: "warm_floor_ir", kind: "drag", note: "инфракрасный тёплый пол" },
  { sheet: "warm_floor", tool: "socket_thermo", kind: "click", note: "терморегулятор у стены" },
  { sheet: "conditioners", tool: "conditioner", kind: "click", note: "внутренний блок у стены" },
  { sheet: "conditioners", tool: "conditioner_engine", kind: "click", note: "внешний блок у стены" },
];

const out: any = {};
for (const st of steps) {
  await switchSheet(page, st.sheet);
  const pick = await pickTool(page, st.tool);
  if (pick !== "ok") { console.log(st.tool, pick); out[st.tool] = { pick }; continue; }
  const b = await copyServer(page);
  if (st.kind === "drag") {
    // протяжка внутри комнаты A: от (60,-240) до (240,-60)
    const { dragAt } = await import("./phase2-lib.ts");
    await dragAt(page, { x: 60, y: -240 }, { x: 240, y: -60 });
  } else {
    await clickAt(page, wallSpot);
  }
  await escape(page);
  const a = await copyServer(page);
  const diff = diffModels(b, a);
  out[st.tool] = { pick: st.kind, diff };
  console.log(`\n=== ${st.tool} (${st.note})`);
  console.log(JSON.stringify(diff, null, 1).slice(0, 3000));
}
writeOut("122-climate-ui-clicks", out);
await browser.close();
process.exit(0);
