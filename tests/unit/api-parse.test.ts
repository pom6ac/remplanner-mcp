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

// Ревью 256 №2: «active» — отдельный токен внутри class того же элемента,
// текст активного пункта сверяется со списком старших тарифов; всё остальное —
// unknown (безопасный отказ гейта), а не ложное «pro»/«free».
test("256 №2: pro_status_item inactive — не PRO (unknown)", () => {
  const html = `
<div id="clientline" class="is_logged">user</div>
<div class="user_cabinet_pro_status">
  <div class="user_cabinet_pro_status_item inactive color-red">Расширенный тариф</div>
</div>`;
  assert.equal(parseClientPage(html).tariff, "unknown");
});

test("256 №2: data-state notactive — не PRO (unknown)", () => {
  const html = `
<div id="clientline" class="is_logged">user</div>
<div class="user_cabinet_pro_status_item" data-state="notactive">Расширенный тариф</div>`;
  assert.equal(parseClientPage(html).tariff, "unknown");
});

test("256 №2: список пунктов тарифа — active у бесплатного пункта — не PRO (unknown)", () => {
  const html = `
<div id="clientline" class="is_logged">user</div>
<div class="user_cabinet_pro_status">
  <div class="user_cabinet_pro_status_item">Базовый</div>
  <div class="user_cabinet_pro_status_item active">Бесплатный</div>
</div>`;
  assert.equal(parseClientPage(html).tariff, "unknown");
});

test("256 №2: PRO-блок рядом с текстом «в бесплатной версии» — pro, а не free", () => {
  const html = `
<div id="clientline" class="is_logged">user</div>
Проектов в бесплатной версии: 1
<div class="user_cabinet_pro_status">
  <div class="user_cabinet_pro_status_item active color-green">Расширенный тариф</div>
</div>`;
  assert.equal(parseClientPage(html).tariff, "pro");
});

test("256 №2: пустой/незнакомый pro-блок — unknown", () => {
  const html = `
<div id="clientline" class="is_logged">user</div>
<div class="user_cabinet_pro_status">
  <div class="user_cabinet_pro_status_item active">Какой-то новый тариф</div>
</div>`;
  assert.equal(parseClientPage(html).tariff, "unknown");
  assert.equal(parseClientPage(`<div id="clientline" class="is_logged">x</div><div class="user_cabinet_pro_status"></div>`).tariff, "unknown");
  assert.equal(parseClientPage(`<div id="clientline" class="is_logged">x</div>`).tariff, "unknown");
});

// Ревью 258 №3: разбор тарифа устойчив к новой разметке и отрицаниям.
// (а) free-маркеры и явные отрицания — не «pro» на фразах-описаниях;
// при одновременном наличии free-маркера и признака страницы — unknown.
test("258 №3а: free-маркер и фраза-описание «Когда PRO активен…» — не pro (unknown)", () => {
  const html = `
<div id="clientline" class="is_logged">user</div>
в бесплатной версии доступен 1 проект
<p>Подробнее о том, когда PRO активен и что он даёт, читайте в разделе «Тарифы».</p>`;
  assert.equal(parseClientPage(html).tariff, "unknown");
});

test("258 №3а: явное «PRO не активен» — free, а не pro", () => {
  assert.equal(parseClientPage(`<div id="clientline" class="is_logged">x</div><p>Сейчас PRO не активен.</p>`).tariff, "free");
  assert.equal(parseClientPage(`<div id="clientline" class="is_logged">x</div><p>Сейчас PRO активен.</p>`).tariff, "pro");
});

// (б) data-class — не атрибут class: токен active в нём не признак активного пункта
test("258 №3б: data-class с токеном active — не признак активного пункта (unknown)", () => {
  const html = `
<div id="clientline" class="is_logged">user</div>
<div data-class="user_cabinet_pro_status_item active">Расширенный тариф</div>`;
  assert.equal(parseClientPage(html).tariff, "unknown");
});

// (в) текст активного пункта сравнивается целиком: «Расширенный тариф не
// подключён» — не pro (явное отрицание — free)
test("258 №3в: активный пункт «Расширенный тариф не подключён» — free, не pro", () => {
  const html = `
<div id="clientline" class="is_logged">user</div>
<div class="user_cabinet_pro_status_item active">Расширенный тариф не подключён</div>`;
  assert.equal(parseClientPage(html).tariff, "free");
});

// обратная сторона: вложенная разметка активного пункта — тоже pro
test("258 №3: активный пункт с вложенной разметкой (span) — pro", () => {
  const html = `
<div id="clientline" class="is_logged">user</div>
<div class="user_cabinet_pro_status">
  <div class="user_cabinet_pro_status_item active color-green"><span>Расширенный тариф</span></div>
</div>`;
  assert.equal(parseClientPage(html).tariff, "pro");
});

// Шаг 260: живая разметка ЛК — активный пункт содержит ссылку «сменить»
// (user_cabinet_pro_status_upgrade); её подпись не ломает распознавание PRO.
// Фикстура — обезличенный фрагмент реальной страницы /client/ (без email/имени/ID).
test("260: живой фрагмент ЛК с ссылкой «сменить» в активном пункте — pro", async () => {
  const { readFileSync } = await import("node:fs");
  const fixture = readFileSync(new URL("../../tests/fixtures/client-page-pro-fragment.html", import.meta.url), "utf8");
  const html = `<div id="clientline" class="is_logged">user</div>\n${fixture}`;
  assert.equal(parseClientPage(html).tariff, "pro");
  // то же без оболочки clientline: тариф по блоку pro_status определяется и так
  assert.equal(parseClientPage(fixture).tariff, "pro");
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
