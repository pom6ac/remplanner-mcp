// T16: render_plan — запись PNG в каталог renders/, валидация PNG-магии.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPlanToFile } from "../../src/render.ts";
import { McpError } from "../../src/errors.ts";

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const listDir = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir) : []);

test("render: PNG пишется в каталог с именем plan-<object_id>-<stamp>.png", async () => {
  const dir = mkdtempSync(join(tmpdir(), "remplanner-render-"));
  try {
    const res = await renderPlanToFile(
      { objectId: "1234567", renderPng: async () => PNG_HEAD },
      { sheet: "init", widthPx: 1600, dir },
    );
    assert.ok(existsSync(res.path));
    assert.match(res.path, /1234567-.*\.png$/);
    assert.equal(res.mimeType, "image/png");
    assert.equal(res.bytes, PNG_HEAD.length);
    assert.equal(Buffer.from(res.base64, "base64").compare(PNG_HEAD), 0);
    assert.equal(readFileSync(res.path).compare(PNG_HEAD), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("render: не-PNG ответ скриншота → SITE_ERROR, файл не пишется", async () => {
  const dir = mkdtempSync(join(tmpdir(), "remplanner-render-"));
  try {
    await assert.rejects(
      renderPlanToFile({ objectId: "x", renderPng: async () => Buffer.from("<html>") }, { dir }),
      (e: unknown) => e instanceof McpError && e.code === "SITE_ERROR",
    );
    assert.deepEqual(listDir(dir), [], "PNG при ошибке не пишется");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
