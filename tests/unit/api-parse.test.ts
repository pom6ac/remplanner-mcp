import test from "node:test";
import assert from "node:assert/strict";
import { parseClientPage, isReloadResponse } from "../../src/api.ts";
import { detectCaptcha } from "../../src/login.ts";

const LOGGED_HTML = `
<div id="clientline" class="is_logged">user</div>
Вам доступен 1 проект в бесплатной версии
<table id="user_cabinet_objects">
<tr id="object1234567" data-object_id="1234567">
  <td>1</td><td>v3.0</td>
  <td><input class="input_object_edit_name" name="oname[1234567]" value="Квартира" /></td>
  <td>24,5 м²</td>
  <td>Этажи: 1</td><td>Планировки: 1</td><td>Резервные копии: 2</td>
  <td>Сохранено 5 мин. назад</td>
</tr>
</table>`;

const ANON_HTML = `<form action="" class="pre_form" method="post"><input class="pre_trigger" name="auth_trigger"/><input type="text" name="email"/></form>`;

test("parseClientPage: вошли, тариф free, проект разобран", () => {
  const info = parseClientPage(LOGGED_HTML);
  assert.equal(info.logged_in, true);
  assert.equal(info.tariff, "free");
  assert.equal(info.projects.length, 1);
  const p = info.projects[0]!;
  assert.equal(p.object_id, "1234567");
  assert.equal(p.title, "Квартира");
  assert.equal(p.version, "v3.0");
  assert.equal(p.floors, 1);
  assert.equal(p.plans, 1);
  assert.equal(p.backups, 2);
});

test("parseClientPage: аноним — не вошли", () => {
  const info = parseClientPage(ANON_HTML);

  assert.equal(info.logged_in, false);
  assert.equal(info.projects.length, 0);
  assert.equal(info.tariff, "unknown");
});

test("parseClientPage: ошибка входа", () => {
  const html = `<div class="pre_error">Неверный email или пароль</div>`;
  assert.equal(parseClientPage(html).login_error, true);
});

// Этап 255: ЛК показывает активный PRO блоком user_cabinet_pro_status_item
// («Расширенный тариф» — старший тариф; прежнего текста «Версия PRO: подключена» нет)
test("parseClientPage: старший тариф PRO — блок pro_status_item active", () => {
  const html = `
<div id="clientline" class="is_logged">user</div>
<div class="user_cabinet_settings_title">Версия PRO</div>
<div class="user_cabinet_pro_status">
  <div class="user_cabinet_pro_status_item active color-green">Расширенный тариф</div>
</div>`;
  assert.equal(parseClientPage(html).tariff, "pro");
});

test("parseClientPage: free-маркер рядом с pro-блоком — free (порядок проверок)", () => {
  const html = `
<div id="clientline" class="is_logged">user</div>
в бесплатной версии доступен 1 проект
<div class="user_cabinet_pro_status_item">Расширенный тариф</div>`;
  assert.equal(parseClientPage(html).tariff, "free");
});

test("isReloadResponse: reload:101", () => {
  assert.equal(isReloadResponse({ reload: 101 }), true);
  assert.equal(isReloadResponse({ result: "success" }), false);
  assert.equal(isReloadResponse(null), false);
  assert.equal(isReloadResponse("x"), false);
});

test("detectCaptcha находит маркеры капчи", () => {
  assert.equal(detectCaptcha('<div id="captcha" class="x"></div>'), true);
  assert.equal(detectCaptcha('<div class="g-recaptcha"></div>'), true);
  assert.equal(detectCaptcha("<p>Введите email</p>"), false);
});

test("№18: parseLoadResponse нормализует числовые plan_id/save_id в строки (как в живом дампе)", async () => {
  const { parseLoadResponse } = await import("../../src/api.ts");
  const parsed = parseLoadResponse({
    object_id: 1234567 as unknown as string,
    plan_id: 999586 as unknown as string,
    save_id: 3 as unknown as string,
    data: JSON.stringify({ v: 3, walls: {} }),
  });
  assert.equal(parsed.plan_id, "999586");
  assert.equal(parsed.object_id, "1234567");
  assert.equal(parsed.save_id, "3");
});
