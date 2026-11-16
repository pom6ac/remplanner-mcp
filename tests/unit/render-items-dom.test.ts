// Ревью v0.1.1 раунд 2 R2-2: DOM-предикат renderPlan сопоставлял id подстрокой —
// видимый sofa10 закрывал ожидание отсутствующего sofa1. Здесь исполняется НАСТОЯЩИЙ
// предикат (itemsRenderedInSvg из adapter.ts) на DOM-фрагменте: id обязан совпадать
// точно (атрибут id/data-id или точный токен класса), у каждого ожидаемого id —
// свой видимый элемент.
import test from "node:test";
import assert from "node:assert/strict";
import { itemsRenderedInSvg } from "../../src/editor/adapter.ts";

type FakeEl = {
  id?: string;
  dataId?: string;
  cls?: string;
  w?: number;
  h?: number;
  display?: string;
  visibility?: string;
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
