// Ревью v0.1.1 раунд 2 R2-2: DOM-предикат renderPlan сопоставлял id подстрокой —
// видимый sofa10 закрывал ожидание отсутствующего sofa1. Здесь исполняется НАСТОЯЩИЙ
// предикат (itemsRenderedInSvg из adapter.ts) на DOM-фрагменте: id обязан совпадать
// точно (атрибут id/data-id или точный токен класса), у каждого ожидаемого id —
// свой видимый элемент.
import test from "node:test";
import assert from "node:assert/strict";
import { itemsRenderDiagInPage, itemsRenderedInSvg } from "../../src/editor/adapter.ts";

type FakeEl = {
  id?: string;
  dataId?: string;
  cls?: string;
  w?: number;
  h?: number;
  display?: string;
  visibility?: string;
  /** этап 411: getBBox в координатах SVG; undefined — метода нет */
  bbox?: { w: number; h: number };
  /** этап 411: getScreenCTM().a */
  ctmA?: number;
};

type Dom = { restore: () => void };

/** Минимальный DOM-фрагмент: svg внутри #canvas_v2_wrapper + дочерние элементы. */
function installDom(children: FakeEl[]): Dom {
  const byEl = new Map<unknown, FakeEl>();
  const make = (e: FakeEl) => {
    const el = {
      getAttribute: (name: string) =>
        name === "id" ? (e.id ?? null) : name === "data-id" ? (e.dataId ?? null) : name === "class" ? (e.cls ?? null) : null,
      getBoundingClientRect: () => ({ width: e.w ?? 10, height: e.h ?? 10 }),
      ...(e.bbox ? { getBBox: () => ({ width: e.bbox!.w, height: e.bbox!.h }) } : {}),
      ...(e.ctmA !== undefined ? { getScreenCTM: () => ({ a: e.ctmA! }) } : {}),
    };
    byEl.set(el, e);
    return el;
  };
  const els = children.map(make);
  const svg = { querySelectorAll: (_s: string) => els };
  const g = globalThis as Record<string, unknown>;
  const prevDoc = g["document"];
  const prevCS = g["getComputedStyle"];
  g["document"] = { querySelector: (sel: string) => (sel === "#canvas_v2_wrapper svg" ? svg : null) };
  g["getComputedStyle"] = (el: unknown) => {
    const e = byEl.get(el) as FakeEl | undefined;
    return { display: e?.display ?? "block", visibility: e?.visibility ?? "visible" };
  };
  return {
    restore: () => {
      if (prevDoc === undefined) delete g["document"];
      else g["document"] = prevDoc;
      if (prevCS === undefined) delete g["getComputedStyle"];
      else g["getComputedStyle"] = prevCS;
    },
  };
}

function withDom(children: FakeEl[], fn: () => void): () => void {
  return () => {
    const dom = installDom(children);
    try {
      fn();
    } finally {
      dom.restore();
    }
  };
}

test(
  "render-items-dom: sofa10 виден, sofa1 отсутствует — предикат false (подстрока не совпадает)",
  withDom([{ id: "sofa10", w: 20, h: 20 }], () => {
    assert.equal(itemsRenderedInSvg(["sofa1", "sofa10"]), false, "sofa10 не должен закрывать sofa1");
  }),
);

test(
  "render-items-dom: у каждого id свой видимый элемент — предикат true",
  withDom([{ id: "sofa1" }, { cls: "item sofa10 icon" }], () => {
    assert.equal(itemsRenderedInSvg(["sofa1", "sofa10"]), true);
  }),
);

test(
  "render-items-dom: класс-подстрока не считается, точный токен класса — считается",
  withDom([{ cls: "item sofa10x" }], () => {
    assert.equal(itemsRenderedInSvg(["sofa10"]), false, "sofa10x не матчится с sofa10");
  }),
);

test(
  "render-items-dom: разметка редактора (глобал 757) item_x_<id> — считается видимой",
  withDom([{ cls: "item_x__ladder1" }, { cls: "item_x__windoor2" }], () => {
    assert.equal(itemsRenderedInSvg(["_ladder1", "_windoor2"]), true);
  }),
);

test(
  "render-items-dom: точный токен item_x_<id> — чужой id с тем же суффиксом не матчится (этап 55, ревью №5)",
  withDom([{ cls: "item_x_notsofa1" }], () => {
    assert.equal(itemsRenderedInSvg(["sofa1"]), false, "item_x_notsofa1 не закрывает sofa1");
    assert.equal(itemsRenderedInSvg(["notsofa1"]), true, "свой id матчится точно");
  }),
);

test(
  "render-items-dom: суффикс ровно id — item_x__ladder10 не закрывает _ladder1",
  withDom([{ cls: "item_x__ladder10" }], () => {
    assert.equal(itemsRenderedInSvg(["_ladder1"]), false);
    assert.equal(itemsRenderedInSvg(["_ladder10"]), true);
  }),
);

test(
  "render-items-dom: data-id матчится точно",
  withDom([{ dataId: "chair2" }], () => {
    assert.equal(itemsRenderedInSvg(["chair2"]), true);
    assert.equal(itemsRenderedInSvg(["chair"]), false);
  }),
);

test(
  "render-items-dom: невидимый или нулевой элемент не закрывает ожидание",
  withDom([{ id: "lamp1", w: 0, h: 0 }, { id: "lamp2", display: "none" }, { id: "lamp3", visibility: "hidden" }], () => {
    assert.equal(itemsRenderedInSvg(["lamp1"]), false);
    assert.equal(itemsRenderedInSvg(["lamp2"]), false);
    assert.equal(itemsRenderedInSvg(["lamp3"]), false);
  }),
);

test("render-items-dom: нет svg — false", () => {
  const g = globalThis as Record<string, unknown>;
  const prevDoc = g["document"];
  g["document"] = { querySelector: () => null };
  try {
    assert.equal(itemsRenderedInSvg(["sofa1"]), false);
  } finally {
    if (prevDoc === undefined) delete g["document"];
    else g["document"] = prevDoc;
  }
});

// Этап 410: диагностика itemsRenderDiagInPage — та же логика сопоставления и
// видимости, что предикат ожидания; по каждому id — причина.
test(
  "render-items-dom (410): диагностика по каждому id совпадает с предикатом ожидания",
  withDom([
    { id: "ok1" }, { cls: "item_x__ok2" }, { id: "z1", w: 0, h: 0 }, { id: "h1", display: "none" },
    { id: "h2", visibility: "hidden" }, { cls: "item_x_notabs1" }, { id: "sofa10" },
  ], () => {
    const ids = ["ok1", "_ok2", "z1", "h1", "h2", "abs1", "sofa1"];
    const d = itemsRenderDiagInPage(ids);
    assert.deepEqual(d.statuses, { ok1: "ok", _ok2: "ok", z1: "zero_size", h1: "hidden", h2: "hidden", abs1: "absent", sofa1: "absent" });
    assert.equal(d.svg, true);
    for (const id of ids) {
      assert.equal(d.statuses[id] === "ok", itemsRenderedInSvg([id]), `согласованность с предикатом: ${id}`);
    }
  }),
);

test("render-items-dom (410): нет svg — все absent, svg=false", () => {
  const g = globalThis as Record<string, unknown>;
  const prevDoc = g["document"];
  g["document"] = { querySelector: () => null };
  try {
    const d = itemsRenderDiagInPage(["a"]);
    assert.deepEqual(d.statuses, { a: "absent" });
    assert.equal(d.svg, false);
    assert.equal(d.activeSheet, null);
  } finally {
    if (prevDoc === undefined) delete g["document"];
    else g["document"] = prevDoc;
  }
});

// Этап 411 (лог 406-2): стояк water_column_cold 10×10 см стабильно zero_size после
// того, как проба добавила комнату за ~96 м от плана — редактор вписывает весь план
// в окно, масштаб падает, и 10 см на экране < 1 px. Предмет нарисован (геометрия
// SVG ненулевая) — это не рассинхрон. Проверка: субпиксель при ненулевом getBBox — ok;
// без геометрии / 0×0 на экране / без getBBox — по-прежнему zero_size.
test(
  "render-items-dom (411): субпиксельный предмет с ненулевой геометрией SVG — нарисован",
  withDom([{ id: "riser", w: 0.87, h: 0.87, bbox: { w: 10, h: 10 }, ctmA: 0.087 }], () => {
    assert.equal(itemsRenderedInSvg(["riser"]), true);
    const d = itemsRenderDiagInPage(["riser"]);
    assert.deepEqual(d.statuses, { riser: "ok" });
    assert.deepEqual(d.sizes, { riser: { rect: [0.87, 0.87], bbox: [10, 10], scale: 0.087 } });
  }),
);

test(
  "render-items-dom (411): без геометрии, 0×0 на экране или без getBBox — по-прежнему zero_size",
  withDom([
    { id: "empty", w: 0.5, h: 0.5, bbox: { w: 0, h: 0 } },
    { id: "zero", w: 0, h: 0, bbox: { w: 10, h: 10 } },
    { id: "nobbox", w: 0.5, h: 0.5 },
    { id: "flat", w: 0.5, h: 0, bbox: { w: 10, h: 0 } },
    { id: "hid", w: 0.5, h: 0.5, bbox: { w: 10, h: 10 }, display: "none" },
  ], () => {
    for (const id of ["empty", "zero", "nobbox", "flat"]) {
      assert.equal(itemsRenderedInSvg([id]), false, id);
    }
    assert.equal(itemsRenderedInSvg(["hid"]), false, "скрытый субпиксельный — не виден");
    const d = itemsRenderDiagInPage(["empty", "zero", "nobbox", "flat", "hid"]);
    assert.deepEqual(d.statuses, { empty: "zero_size", zero: "zero_size", nobbox: "zero_size", flat: "zero_size", hid: "hidden" });
    assert.deepEqual(d.sizes?.["nobbox"], { rect: [0.5, 0.5], bbox: null, scale: null });
  }),
);
