# Карта покрытия редактора remplanner для MCP (фаза 2)

Дата: 16.11.2026. Редактор `planner_version=3`, `global_version=757`, бандлы `app.3.0___683___1794385633.min.js`,
`planner.tools___94___1794473554.js` (каталог `global_tools`, 1616 позиций), `planner.l10n___23___1793608030.js`,
разметка редактора `/planner/` (анонимная сессия). Отчёт — `.orca-reports/15-phase2-research.md`,
проект — [phase2-design.md](phase2-design.md), задачи — [phase2-tasks.md](phase2-tasks.md).

Пометки: **[код]** — прочитано в бандле; **[разметка]** — разметка редактора (`#plannertool_<ключ>`, классы
`is_pro`); **[док]** — пошаговое руководство, текстовые версии видеоуроков, анонсы обновлений; **[проверить]** —
нужна живая проба (`scripts/probes/phase2-*.ts`, задача F2-01).

## 1. Источники

| Источник | URL | Что взято |
|---|---|---|
| Пошаговое руководство | https://remplanner.ru/planner/support/ | шаги 1–5: интерфейс, стены, отображение, проёмы, мебель |
| Вопросы и ответы (26 разделов, ~330 вопросов) | https://remplanner.ru/planner/support/faq/ | разобраны в `docs/remplanner-features.md` |
| Видеоуроки, 12 шт. (у каждого текстовая версия и таймкоды) | https://remplanner.ru/planner/support/video/ | см. таблицу ниже |
| История обновлений (29 анонсов, 16 функциональных прочитаны полностью) | https://remplanner.ru/planner/support/changelog/ | новые инструменты, PRO-ограничения (DXF, щиток) |
| Канал YouTube | https://www.youtube.com/c/RemPlanner/videos | ссылки на ролики; описания не скачивались (видео самохостинговые, тексты уроков полнее) |
| Подсказки интерфейса | разметка `/planner/` (`.tools_item_about[data-text]`, контекстные меню `#cm-*`), `planner.l10n` (392 строки) | поля контекстных меню, PRO-метки, тексты ошибок |

Видео лежат на сайте (`/files/video/<урок>.mp4|webm`), субтитров (`<track>`) нет. Зеркала: YouTube, VK Видео, Дзен.

| Урок | Страница (текст + таймкоды) | YouTube | Таймкоды, относящиеся к фазе 2 |
|---|---|---|---|
| 1. Обзор возможностей | `/planner/support/video/overview/` | https://www.youtube.com/watch?v=wfZ7DkVtq8k | — |
| 2. Построение помещений | `/planner/support/video/rooms/` | https://www.youtube.com/watch?v=OMmfbjysQhg | Демонтаж 09:46, Перегородки 11:12, ГКЛ-короба 12:33, Зонирование 14:11 |
| 3. Планировка мебели | `/planner/support/video/furniture/` | https://www.youtube.com/watch?v=T5BBZKmwvYc | — |
| 4. Электрика и освещение | `/planner/support/video/electrics/` | https://www.youtube.com/watch?v=OTBw7bCrv-o | Розетки 00:26, Выводы 05:36, Освещение 06:24, Выключатели 10:19, Проводка 11:54, Метраж 13:32, Распред. коробки 16:35 |
| 5. Чистовая отделка | `/planner/support/video/facings/` | https://www.youtube.com/watch?v=XZVP-aCcyPw | Полы 00:10, Зонирование 02:44, Подъём пола 03:36, Плинтусы 04:43, Потолки 05:33, Короб 07:43, Закарнизные ниши 09:00, Стены 10:40, Плитка 13:45 |
| 6. 3D-визуализация | `/planner/support/video/visual/` | https://www.youtube.com/watch?v=15adx2qg6wE | — (PRO) |
| 7. Развёртки стен | `/planner/support/video/projections/` | https://www.youtube.com/watch?v=sHqHKfm6Puc | нумерация 02:10, режимы 03:20, плитка 05:01, молдинги 06:18, ниши 07:15 |
| 8. Инженерные системы | `/planner/support/video/engineer/` | https://www.youtube.com/watch?v=qaMF-CA_Lew | Водоснабжение 02:27, Автопостроение 06:33 |
| 9. Дополнительные инструменты | `/planner/support/video/tools/` | https://www.youtube.com/watch?v=DLECjUlqX5M | Размеры 00:52, Комментарии 03:30 |
| 10. Фигуры и предметы | `/planner/support/video/figures/` | https://www.youtube.com/watch?v=6EHllJTuQDM | — |
| 11. Частые вопросы | `/planner/support/video/answers/` | https://www.youtube.com/watch?v=9vpz018rFu8 | — |
| 12. План по картинке | `/planner/support/video/picture/` | https://www.youtube.com/watch?v=YtRwGjs87Sw | — |

## 2. Где что хранится в модели `project.copy("server")` [код]

Единицы — сантиметры, ось Y вниз (как в MVP). Коллекции верхнего уровня, относящиеся к фазе 2:

| Коллекция | Класс редактора | Формат |
|---|---|---|
| `walls[id]` (`plan:"a"`) | `Wall` | демонтаж: `demount:1` (+ `p1.demount`, `p2.demount`; `setDemount()` очищает `sectors`); участок — `sectors[sid] = {id, pc, width}` на оси; проём — `holes[hid].demount:1` |
| `walls[id]` (`plan:"c"`) | `Wall` | перегородка; материалы `c_*` (ПГБ, пеноблок, кирпич, ГКЛ, стекло, рейки); проём поверх исходного — `holes` с `plan:"c"` и признаком замены (`hasReplacement`) |
| `pillars[id]` | `Pillar` | ГКЛ-короб на листе «Перегородки»: `plan:"c"`, `role_: "gypsum"\|"gypsum_sm"`, высота |
| `claddings` | `$Claddings` | обшивка ГКЛ (`gypsum_cladding`) |
| `zone_delimiters[]` | `ZoneDelimiter extends GraphLines` | линии зонирования: `type: zone_c\|zone_floor\|zone_ceiling\|zone_hydroisolation\|zone_floor_cap`, `id_room`, граф `vertexes/matrix/items` |
| `items[id].props` | `Item` | розетки, выключатели, выводы проводов и воды, светильники, щитки, коробки, стояки, коллектор — **все это предметы**. Розетки и выключатели хранятся как `name:"socket_group"` + `socket_group:[{name, id, …}]` (конструктор `Item` сам превращает `socket` → `socket_group`). Привязка к стене выводится из геометрии: `id_wall`, `wall_direction` (`l\|r`), `wall_line`; высота — `over_floor` (до центра), группа «друг над другом» — `layer`, `is_vertical_group` |
| `groups_items` | `GroupItems` | ручные группы предметов (замок) |
| `cables[]` | `Cable extends GraphLines` | соединительные линии «выключатель → светильник» (`type:"cable"`), `color_custom`, `on_arc` |
| `cables_socket[]` | `CableSocket extends GraphLines` | электропроводка: `type` = ключ кабеля (`wire_3_25`, …), `length` |
| `pipes[]` | `Pipe extends GraphLines` | трубы ХВС/ГВС/канализации (`water_pipe`, `water_hot_pipe`, `drainage_pipe`); `smeta_water_pipes` редактор считает при сохранении |
| `led_strips[]`, `stripes_light[]`, `line_strips[]` | `LedStrip`, `StripLight`, `LineStrip` | светодиодная подсветка, трековые шины (`height_lowering`, `spots`), линейный свет (в т.ч. на развёртках, `plan:"projections"`) |
| `shields{}` | `Shield` | содержимое щитка (рейки, шины, модули, провода) по `shield_id` предмета-щитка |
| `rulers[]` | `Ruler` | `{id, p1, p2, offset, plan, plan_, prs, p1_target, p2_target, show_everywhere, color}` |
| `comments[]` | `Comment` | `{id, pc, points[], text, url, font_size, color, label, plan, show_everywhere, id_item}` |
| `wall_moldings`, `wall_niches` | `WallMolding`, `WallNiche` | развёртки: `{id, type, pc, width, height, plan, prs, width_line \| depth}` |
| `level_holes[]` | `LevelHole` | проём в полу или потолке (`floor_hole`, `ceiling_hole`) |
| `custom_plans` | `CustomPlan` | пользовательские листы (`name`, `after_plan`, `content`) |
| **`rooms2[rid]`** | `Room2` | **вся отделка хранится внутри комнаты**: `zones[]` (имя, цвет, номер), `floors[]`, `ceilings[]`, `decors` (отделка стен), `floorMoldings`, `ceilingMoldings`, `edges_decors`, `hydroisolations`, `plasters*`, `prs_*` (развёртки), `delimiters` (устаревший формат, патчится в `zone_delimiters`) |

Все линейные сущности наследуют `GraphLines`: `{id, type, length, vertexes:[{id, point, type, pp?}], matrix:[[null|{length:1,…}]], items:{vertexId: "node"|"electrospot"|"waterspot"|…}}`.
Вершина — это id предмета (розетки, щитка, коллектора) или узла (`electrospot_node`, `waterspot_node`).
Предмет хранит обратные ссылки на деревья линий в своих `props` (`updateData` чистит висячие) [код].

Формат отделки внутри `rooms2[rid]` [код]:
- `floors[i] = {exist, id, polygon, cover, angle, custom_angle, pc, width, height, stitch_width, f0offset, anchor, type_laying, polygons_layout…, patch}`;
  `f0offset` — **подъём пола** (контекстное меню `#cm-floor--floor0-offset`), `width/height` — размер плашки, `type_laying` — укладка;
- `ceilings[i] = {exist, id, polygon, level, level2, material, material2, type, profile, radius, offset, niches[…], …}`;
  `level` — **опуск** (`#cm-ceiling--level`), `profile` — стандартный, теневой, парящий;
- `decors` — участки отделки стен: `{id, type, layer, line, line_wall, distance, height, height_from_floor, props}`
  (для плитки ещё `lamel_width/height`, `stitch_width`, `type_laying`); второй контур (`layer`) — фартук и комбинированная отделка;
- `zones[i] = {id, polygon, pc, area, name, color, number_by_area}` — имя помещения и цвет.

**Как отделка переживает пересчёт комнат [код].** `$Project.restore` создаёт `Room2` из `rooms2` модели; `draw({rooms:1})` →
`ROOMS2.get()` сохраняет комнату, если её контур совпал (`arePolygonsEqual`), и создаёт новую при изменении. Для новых комнат
`$Restorer.restore_rooms` переносит отделку со старой комнаты (`RoomRestorer.restoreOneToOne/restoreTotal`: по совпадению
контура, по похожести, «тотально»). Поэтому id комнат стабильны, пока не меняются стены, а при перепланировке отделка
переносится эвристикой и может сброситься. Это подтверждает урок 5: «при значительном изменении конфигурации комнат отделка
в них будет сбрасываться».

**Как инструмент назначает покрытие пола [код].** Клик по комнате на листе `floor`: находится `ROOMS2[rid].floors[t]`, внутри
контура которого курсор, и ставятся `exist=true, cover=tool, type_laying, width, height, stitch_width=0.5`, затем
`room.draw()` и `project.localSave()`. Потолки и отделка стен устроены так же (поля на объекте комнаты), поэтому MCP может
менять поля существующих элементов `rooms2`, не создавая структуру с нуля.

## 3. Ограничения тарифа [разметка, док]

PRO-инструменты помечены в разметке редактора классом `is_pro` у `#plannertool_<ключ>` и у групп; клик открывает окно
«Данный инструмент доступен в PRO-версии программы». Актуальный замер (этап 328, анонимный редактор = бесплатный тариф,
эталон `.orca-reports/tmp/328-pro-anon.json` вне git): **is_pro у 792 из 1699** `plannertool_*`; обход листов —
`.orca-reports/tmp/328-pro-sheets.json`. Сервер модель не проверяет (design §2), поэтому PRO-сущность технически можно
записать в модель. **Это обход тарифа (AGENTS.md, правило 5), MCP так не делает:** на бесплатном тарифе PRO-инструмент
возвращает `NOT_AVAILABLE_ON_TARIFF`.

Факты 328 по ключам потолка/зонирования: `ceiling_rigel`, `ceiling_hole`, `floor_hole`, `complex_ceiling`, `zone_c`,
`stretch_ceiling*` — **НЕ PRO**; `zone_floor`, `zone_ceiling`, `ceiling_niche`, `molding` (потолочный плинтус), все
`floor_molding_*`, `anchor_floor`, `line_light`, `led_strip`, шины (`surface/recessed/pendent_strip`), кабели `wire_*`,
трубы (`water_pipe`, `warm_floor_pipe`, `heat_pipe_*`, `ventpipe_*`, `conditioner_drainage`), `warm_floor_wire/water`,
`wall_create_glass/bar` — **PRO**. Ключ делителя зон на листах «Гидроизоляция» и «Стяжка» — тот же `zone_floor` (PRO).

Единый гейт MCP (этап 328): реестр `PRO_TOOL_GROUPS` (`src/server/pro.ts`) + одна функция `assertProToolAllowed`;
анонимный проект равен бесплатному тарифу (design §4), неизвестный тариф — бесплатный; add/update гейтятся, delete/remove —
нет (ластик и «Удалить» в редакторе не помечены is_pro). Исключение — `shield_*` (весь лист «Электрощиток» — «старшие
тарифы PRO», анонс 24.12.2025; гейтятся все, включая delete). На каждый инструмент реестра — тест с моком тарифа free
(`tests/unit/pro-gate.test.ts`).

Частичные гейты по ключу (ревью 331 Н1/Н2): `item_add` (полный список is_pro-ключей каталога), `opening_add` (13 PRO-типов
дверей: `door_roto/_double`, `door_book/_double`, `door_bellows`, `door_glass`, `door_garage`, `door_system_x2/x3/x4`,
`door_system_penal_x2/x3/x4`; купе, пенал, doorway/door/двустворчатые — не PRO), `finish_floor_set`/`finish_wall_set`
(PRO-покрытия), `wall_add` (`c_glass`/`c_bar` → `wall_create_glass/bar`), `finish_floor_anchor_set` (ключ `anchor_floor`,
этап 347) — через `assertProPartialAllowed`. Единый источник
ключей — сгенерированный полный список `PRO_EDITOR_KEYS` (727 уникальных ключей эталона;
`src/server/pro-editor-keys.generated.ts`, генератор
`scripts/gen-pro-editor-keys.ts`, эталон `328-pro-anon.json`); сторож `tests/unit/pro-keys.test.ts` проверяет: каждый ключ
эталона, принимаемый каким-либо инструментом MCP, на free даёт `NOT_AVAILABLE_ON_TARIFF`, на pro — проходит. Ключи эталона
без частичного гейта инструмента (инструменты листов «Стяжка» — `cap_*`, «Изоляция» — `isolation_*`,
«Штукатурка» — `plaster_*`, а также элементы «Нарисовать элемент»/изображения и прочее вне модели MCP) гейтом не
проверяются — их в MCP не поставить.

Кроме инструментов, за PRO закрыты: комментарии, «Нарисовать элемент» (фигуры и линии — кнопка `#freelines_opener`
нижней панели с is_pro, проба 375-sheets-ui; гейтятся `freeline_*`/`thick_line_*`/`figure_*`), PDF/PNG/SVG,
DXF (старшие тарифы), 3D, «Построить автоматически» (водоснабжение и щиток). Уточнение этапа 375 по свежей
разметке: кнопка «Изображение» (`#addimage_opener`) на бесплатном тарифе БЕЗ is_pro — загрузка/постановка
изображений гейтом не закрыта (живая проверка в dev-объекте — проба 375-4). На dev-аккаунте («Расширенный») конструктор
щитка доступен (проба 255-shield-scout). Живой проверки гейта на бесплатном аккаунте не было — открытый вопрос (dev-объект
с платным тарифом; правило new-entity-section: не заявлять, что поведение free проверено).

## 4. Карта покрытия

Актуализировано по фактическому `src` на этапе 375 (2026-11-22): столбец MCP — да/частично/нет с именами инструментов;
снапшот контракта — 161 инструмент (`tests/unit/snapshots/c4-contract-snapshot.json`).

Столбцы: **MCP** — покрыто ли существующими инструментами (design §7): да / нет / частично. **Эталон** — нужен ли снимок из UI
до реализации (F2-01). **PRO** — инструмент закрыт на бесплатном тарифе. Ключи — `global_tools`.

### 4.1 Перепланировка

| Лист | Инструмент UI (ключ) | Сущность и поля модели | MCP | Эталон | PRO |
|---|---|---|---|---|---|
| Демонтаж (`break_walls`, `b`) | Демонтаж стены целиком (`break`) | `walls[id].demount=1`, `p1/p2.demount=1`, `sectors={}` (`Wall.setDemount`) | **да**: `demolish`/`demolish_cancel` (этап 103, эталон `ui-ref-demolish*`) | да | нет |
| Демонтаж | Демонтировать участок стены (`break_part`) | `walls[id].sectors[sid]={id, pc (на оси), width}`; на листе `c` редактор режет стену на дочерние (`child`) | частично: `demolish` с `range` — участок по оси; дочерние стены листа `c` — `wall_split`. На перегородки (`plan:c`) break_part не действует (курсор не строит секторы — пробы 354-replan2-ui/ui3): `demolish` отказывает, как редактор | да | нет |
| Демонтаж | Демонтировать проём (`break_door`) | `walls[id].holes[hid].demount=1`; нельзя, если проём уже заменён на «Перегородках» | частично: `demolish` (`opening` в составе демонтажа стены); отдельного инструмента нет | да | нет |
| Демонтаж | Демонтировать радиатор / электрощиток (`break_radiator`, `break_electric_shield`) | `items[id].props.demount` у предметов исходного плана | частично: `demolish` по предмету | да | нет |
| Демонтаж | Отменить демонтаж (`remove_break`) | обнуление тех же полей | **да**: `demolish_cancel` | нет | нет |
| Перегородки (`create_walls`, `c`) | Стена из ПГБ / пеноблоков / кирпича / ГКЛ (`wall_create_pgb\|blocks\|bricks\|gypsum`) | `walls[id]` с `plan:"c"`, материал `c_*` | частично: `wall_add kind=partition` ставит `plan:c`, материал не выбирается | да (материалы `c_*`) | нет |
| Перегородки | Стеклянная, реечная перегородка (`wall_create_glass`, `wall_create_bar`) | то же, `c_glass`, `c_bar` | **да**: `wall_add` материалами glass/bar (PRO-гейт `src/server/pro.ts`, `NOT_AVAILABLE_ON_TARIFF` на free) | да | **да** |
| Перегородки | Гипсокартонный короб (`gypsum_box`) | `pillars[id]` с `plan:"c"`, `role_:"gypsum"`, высота | **да**: `pillar_add` (этап 43, роль gypsum) | да | нет |
| Перегородки | Обшивка ГКЛ (`gypsum_cladding`) | `claddings` | нет: обшивка ГКЛ — нет в UI редактора (FAQ 2.19), MCP не создаёт (`cladding_add`/`cladding_remove` убраны фикс 356 по ревью 355); существующие записи `model.claddings` при save сохраняются без изменений (passthrough) | нет | нет |
| Перегородки | Зонировать помещение (`zone`) | верхнеуровневый `zone_delimiters` `zone_c`, plan `c` (этап 318); деление зон — `rooms2[].zones` на безымянных наследников (имя помещения — `room.name`, не теряется; имена/флаги зон-родителей редактор при делении сбрасывает — живой эталон 318) | **да**: `zone_c_add/remove` (эталон `ui-ref-zonec-delimiter`, привязка узлов к рёбрам — type `room`), список — `finish_get`/compact `zone_delimiters` (ZD<n>); ингест делителей из GET при `project_open`/импорте, save MCP делители UI не теряет | да | нет |
| Перегородки | Двери и окна на перегородках, замена исходной двери | `walls[id].holes[hid]` с `plan:"c"`; у проёма на `plan:c` MCP пишет точки граней `l1/l2/r1/r2` (holes_get редактора считает их только на доступном листе, без них save падал — фикс 359); замена — проём `c` поверх проёма `a` (`hasReplacement` у исходного, `replacement=1` у замены, габарит наследуется) | **да**: `opening_add` c `replaces` (этап 103 + семантика setReplacement — этап 354); дверь/окно/проём без заполнения на перегородке — `opening_add` на стене `plan:c` (фикс 359, живая проба 354-replan2-ui4) | да | как у проёмов (13 PRO-типов дверей гейтятся `opening_add`, ревью 331 Н1) |
| Исходный план | Силуэт перегородок на исходном плане | настройка видимости | не нужно | нет | нет |

### 4.2 Сантехника и вода

| Лист | Инструмент UI (ключ) | Сущность и поля модели | MCP | Эталон | PRO |
|---|---|---|---|---|---|
| Исходный план → «Коммуникации» | Сантехнический стояк, стояки ГВС/ХВС, канализационный (`water`, `water_column_hot\|cold`, `drainage_column`) | `items` («шахты»: `items_mines`, `items_on_walls` — ставятся у стены) | частично: `item_add` требует точку внутри комнаты, привязка к стене не проверялась | да | да | нет |
| Исходный план | Ввод водоснабжения (`ceiling_water`) | `items` | частично: `item_add` (эталон `ui-ref-comm-ceiling_water`) | да | нет |
| Сантехника (`santeh`) | 176 позиций (`santeh_furniture` 136 + `furniture` 40) | `items` с `plan.santeh` | **да** (`item_add`, `catalog_search`) | нет (эталон ванны/унитаза есть в T1) | 23 группы PRO (поддоны, уголки, накладные раковины…) |
| Водоснабжение (`waterplan`) | Выводы: ХВС+ГВС, ХВС+канализация, ХВС+ГВС+канализация, ГВС+канализация (`waterspot_cold_hot`, `waterspot_drainage_cold`, `waterspot_drainage_cold_hot`, `waterspot_drainage_hot`) | `items` (`waterspots`), высота `over_floor` 50 см, у канализации своя высота (`#cm-waterspot--drainage-over-floor`), группа (`GroupWaterSpots`) | **да**: `item_add` (высота из каталога) + `waterspot_merge`/`waterspot_unset` (объединение/снятие части, переименование, габариты и высоты как в редакторе, каскад труб; этап 360, эталоны `ui-ref-plumb3-*`) | да | нет |
| Водоснабжение | Одиночные выводы ХВС, ГВС, канализации (`waterspot_cold\|hot\|drainage`) | `items` | **да**: `item_add` (PRO-гейт по единому списку is_pro-ключей, `src/server/pro-editor-keys.generated.ts`; ревью 329 №2, 331 Н2); `waterspot_merge`/`waterspot_unset` — PRO-гейт по `part` (этап 360) | да (`ui-ref-plumb3-*`) | **да** |
| Водоснабжение | Коллекторный узел (`waterspot_collector`) | `items`, `anchor: wall`, h 150 | частично: `item_add` against_wall | да | **да** |
| Водоснабжение | Узел (`waterspot_node`) | `items` (предмет 4×4, группа waterspots) + вершина трубы | **да**: `item_add` (предмет, эталон `ui-ref-plumb3-waterspot-node`), подключение через `pipe_add {item_id}` — вершина `node` в точке предмета (эталон `ui-ref-plumb3-node-pipe`); удаление с каскадом через `item_delete` | да | нет |
| Водоснабжение | Трубы ХВС, ГВС, канализации (`water_pipe`, `water_hot_pipe`, `drainage_pipe`) | `pipes[]` (граф); метраж для сметы — вдоль стен, не по линии | **да**: `pipe_add kind=water/hot/drainage` + `pipe_update/delete` (этап 78, эталон `ui-ref-plumb-pipe`); `pipe_node_delete` — удаление вершины с каскадом split/shrink как в редакторе (этап 360); PRO-гейт 328 | да (`ui-ref-plumb3-node-pipe`) | **да** |
| Водоснабжение | Построить автоматически | мастера UI: «Построить узлы» (`#build_node_santeh_button`) и «Построить трубы» (`#build_pipe_santeh_button`, `load_v2_modal('santeh_pipes')`) | нет (этап 370/372: в бандле три мастера «Построить автоматически» — щиток, узлы и трубы воды, все не эмулируются; водяные опираются на производную геометрию редактора — `ROOMS2.edges`, `polygon_wo_gypsum`, вырезы дверей) | нет | **да** (по бандлу не проверяется: `is_pro` — разметка UI, в бандле не ищется) |

### 4.3 Электрика и свет

| Лист | Инструмент UI (ключ) | Сущность и поля модели | MCP | Эталон | PRO |
|---|---|---|---|---|---|
| Розетки (`sockets`) | Стандартная, группа, IP44, силовая, 380 В (`socket`, `socket_group`, `socket_ip44`, `socket_power`, `socket_380`) | `items` `name:"socket_group"`, `socket_group:[…]`, `id_wall`, `wall_direction`, `over_floor` 30 (до центра), `layer` | да: `item_add`/`item_update`/`item_delete` (этап 88); вертикальные блоки «друг над другом» — `item_update layer` 2/3 (этап 370, правило `get_offset_layer2` бандла; связь слоёв — производная, не хранится) | да | нет |
| Розетки | Слаботочные (ТВ, интернет, USB, HDMI, телефон, аудио), мебельная, напольная, потолочная | `items` | да: `item_add` (этап 88) | да | **да** |
| Розетки | Выводы провода 220 В, под освещение, духовку, варочную панель, кондиционер (`wire`, `wire_light`, `wire_oven`, `wire_stove`, `wire_conditioner`) | `items` (`wires`), h 30 / 230 | да: `item_add` (часть 2); подключение кабелем — `wiring_add` | да | нет |
| Розетки | Слаботочный, напольный, потолочный вывод | `items` | да: `item_add` (часть 2) | да | **да** |
| Розетки / Электропроводка | Электрощиток накладной, встроенный, слаботочный (`electric_shield`, `electric_shield_internal`, `lowcurrent_shield*`) | `items`, `anchor: wall`, h 120/170 | да: `item_add` (часть 2); конструктор щитка — нет | да | нет |
| Розетки | Домофон, видеодомофон, Wi-Fi роутер | `items` | частично: `item_add` по каталогу (PRO-гейт по единому списку is_pro-ключей, `src/server/pro-editor-keys.generated.ts`; ревью 329 №2, 331 Н2) | нет | **да** |
| Выключатели (`light_connections`) | 1- и 2-клавишный (`light_switch`, `light_switch_double`) | `items` (группы, как розетки), h 90 | да: `item_add` (этап 88) | да | нет |
| Выключатели | 3-клавишный, диммер, проходные, перекрёстные, мастер | `items` | да: `item_add` (этап 88, каталог) | да | **да** |
| Выключатели | Соединительная линия (`cable`) | `cables[]` (`Cable`), вершины — выключатель (клавиша) и светильники/световые линии | да: `cable_add`/`cable_delete` (этап 88; часть 2 — цель-линия led_strip/line_light/трековые, вершина `<lineId>\|t\|<vid>`) | да | **да** |
| Освещение (`light`) | Люстры, потолочные и встраиваемые светильники (32 позиции без PRO) | `items` (`anchor: ceiling`), размер до центра, «центр комнаты = ½» | частично: `item_add center` | да (центр комнаты) | нет |
| Освещение | Бра и настенные (`bra`, `bra_shades`, `led_lamp`, `light_stick`, `wall_spot`, `wall_lamp`, `painting_lighting`) | `items` (`anchor: wall`), h 120–220 | частично | да | нет |
| Освещение | Трековые шины, споты, линейный свет, LED-подсветка (`*_strip`, `track_*`, `line_light`, `led_strip`) | `stripes_light`, `line_strips`, `led_strips` | **да**: `led_strip_add/update/delete`, `stripe_add/update/delete`, `line_light_add/update/delete` (этап 84/85; PRO-гейт 328) | да | **да** |
| Освещение | Двойные и тройные встраиваемые и накладные, банные, уличные, подсветка пола | `items` | частично: `item_add` по каталогу (PRO-гейт по единому списку is_pro-ключей, `src/server/pro-editor-keys.generated.ts`; ревью 329 №2, 331 Н2) | нет | **да** |
| Электропроводка (`cables`) | Кабели 2–5 жил, заземление, слаботочные (31 тип `wire_*`); warm_floor_wire, conditioner_wire | `cables_socket[]` / `cables_warm_floor[]` / `cables_conditioner[]` (`ElecCable`, граф как трубы), длина с опусками до точек (производная); плоскость расчёта — в меню щитка | да: `wiring_add`/`wiring_update`/`wiring_delete` (часть 2) | да | **да** |
| Электропроводка | Распред. короб потолочный, в стене; КУП (`electric_box`, `electric_box_wall`, `electric_kup`) | `items` | да: `item_add` (часть 2) | да | **да** |
| Электропроводка | Узел (`electrospot_node`) | вершина графа | да: `item_add` (часть 2) | да | нет |
| Электрощиток (`shield`) | 43 модуля: DIN-рейки, автоматы, УЗО, шины, провода, «Построить автоматически» | `shields[shield_id]` (рейки, шины, модули, провода) | частично: рейки, модули, провода между портами (shield_wire_add/delete, порт шины адресуется {bus, port}), перенос модулей между рейками и порядок (shield_module_update rail/index), шины над/под щитком (shield_bus_add/update/delete: T/B + L/C/R, 4..25 гнёзд, distance), коллекторы (shield_collector_add/update/delete: подряд на одной рейке, одна ширина, ≥2 — validate_collectors), каскады удаления как в редакторе (этапы 255, 284, 291); «Построить автоматически» — не эмулируется (этап 370/372: в бандле три мастера «Построить автоматически» — щиток `$ShieldBuilder.build` (кнопка `#build_electric_shield_button`), узлы водоснабжения (`#build_node_santeh_button`) и трубы водоснабжения (`#build_pipe_santeh_button`) — все три не эмулируются; правило щитка детерминировано, но зависит от DOM-настроек диалога (checkboxes voltage/socket/counter, `#electric_shield_type_build`) и l10n-строк комментариев модулей (`l10n.shield__auto__*`), которых в бандле нет; мастер деструктивен — `r.clear()` стирает текущие рейки/модули; водяные мастера опираются на производную геометрию редактора (`ROOMS2.edges`, `polygon_wo_gypsum`, вырезы дверей); только однофазная схема — FAQ) | да (`ui-ref-shield-*`) | **да** (старшие тарифы, анонс 24.12.2025; на dev-аккаунте лист доступен — пробы 255, 284) |

### 4.3b Климат (тёплый пол, кондиционеры, вентиляция, радиаторы)

Этап 122 (ядро) и этап 250 (подключения). Листы «Тёплые полы», «Кондиционеры»,
«Вентиляция», «Радиаторы»; подробности — [remplanner-features.md](remplanner-features.md) §7.10.

| Лист | Инструмент UI (ключ) | Сущность и поля модели | MCP | Эталон | PRO |
|---|---|---|---|---|---|
| Тёплые полы | Кабельный/ИК/водяной контур (`warm_floor`, `warm_floor_ir`, `warm_floor_water`) | `warm_floors` — граф-кольцо (polygon, matrix 4×4, length/area, id_room, props; у водяного step/type_water/direction/length_pipes) | **да**: `warm_floor_add`/`warm_floor_update`/`warm_floor_delete` | да (`ui-ref-climate-wf-*`) | водяной **да** |
| Тёплые полы | Терморегулятор (`socket_thermo`) | `items` (socket_group, план `{warm_floor:11}`, h 90) | **да**: `item_add` | да | нет |
| Тёплые полы | Соединительный провод (`warm_floor_wire`) | `cables_warm_floor` — вершина терморегулятора `"<id>\|s\|<sub>"` type socket_thermo; вершина-контур (кабельный/ИК) `{id: id контура, point: polygon[0], type: "warm_floor"}`, ссылка в props контура (`cable_warm_floor_id`); водяной контур не подключается | **да**: `wiring_add kind=warm_floor_wire` (терморегулятор + контур, климат ч.3; эталон `ui-ref-climate3-wire-wf-contour`) | да (`ui-ref-elec2-warm-floor`, `ui-ref-climate3-*`) | **да** |
| Тёплые полы | Соединительные магистрали (`warm_floor_pipe`) | `pipes_warm_floor` — граф; вершины-коллекторы type "collector", водяной контур type "warm_floor" (point polygon[0], ссылка в props контура) | **да**: `pipe_add kind=warm_floor` (узлы, коллекторы, контур) | да (`ui-ref-climate2-warm-floor-pipe-contour`) | **да** |
| Тёплые полы | Кабельная тёплая стена (`warm_wall_cable`) | per-room `rooms2[rid].warms_walls[edge].parts` (WarmLine: line на демолинии ребра + 5 см внутрь, line_wall, height 135, height_from_floor 15, props; расстояние — производная подпись) + кабель в `cables_warm_floor` (вершина type "warm_wall", point = центр линии, pp {i:0,d} — производное протяжки, MCP не пишет); ссылка в props части (`cable_warm_floor_id`, скаляр — у стены одно подключение, l10n cabling_warm_floor_not_connect_same_wall) | **да**: `warm_wall_add`/`warm_wall_list`/`warm_wall_update`/`warm_wall_delete` + `wiring_add warm_floor_wire` (терморегулятор → тёплая стена; этап 273) | да (`ui-ref-warmwall-line`, `ui-ref-warmwall-wire`) | **да** («Расширенный» на dev-аккаунте; поведение на бесплатном — открытый вопрос; открытые вопросы ревью 276 N1/N3: подрезка демолинии в углах — MCP не подрезает, участок может доходить до грани угла; перенос/удаление стены ребра части и перегородка поперёк части вживую не проверены) |
| Кондиционеры | Внутренний/внешний блок, напольный, завеса (`conditioner`, `conditioner_engine`, `floor_conditioner`, `air_curtain`) | `items` (у стены, over_floor из каталога) | **да**: `item_add` | да (`ui-ref-climate-*`) | нет |
| Кондиционеры | Трасса (`conditioner_wire`) | `cables_conditioner` — вершины electrospot (point = pc), ссылка `props.cables_conditioner.conditioner_cable_id` | **да**: `wiring_add kind=conditioner_wire` (климат ч.2: кондиционер ↔ внешний блок) | да (`ui-ref-elec2-conditioner`, живой) | **да** |
| Кондиционеры | Дренаж (`conditioner_drainage`) | `pipes_conditioner` — граф; вершины блоков кондиционера type "waterspot", ссылка `props.pipes_conditioner.drainage_pipe_id` | **да**: `pipe_add kind=conditioner_drainage` (климат ч.2) | да (`ui-ref-climate2-conditioner-drainage`) | **да** |
| Вентиляция | Вентиляторы (free) | `items` | **да**: `item_add` | да | нет |
| Вентиляция | Решётки/диффузоры/вентустановка (PRO) | `items` — клик в dev-проекте не создал объект (2 попытки, этап 122) | нет | нет | **да** |
| Вентиляция | Воздуховоды (`ventpipe_out`, `ventpipe_in`) | `pipes_ventilation` — граф с сечением рёбер (width/type/height) и spots {}; вершины вентиляторов/установки, ссылка `props.pipes_ventilation.ventpipe_*_id` | **да**: `pipe_add kind=vent_out/vent_in` (климат ч.2) | да (`ui-ref-climate2-vent-pipe-fan`) | **да** |
| Радиаторы | 9 радиаторов/конвекторов | `items` (у стены) | **да**: `item_add` | да | нет |
| Радиаторы | Магистрали отопления (`heat_pipe_hot`, `heat_pipe_cold`) | `pipes_heat` — граф; вершины радиаторов type "waterspot" (point = pc), ссылки `props.pipes_heat.heat_pipe_hot_id/heat_pipe_cold_id`; коллекторы multi | **да**: `pipe_add kind=heat_hot/heat_cold` (климат ч.2: радиатор к подаче и обратке) | да (`ui-ref-climate2-heat-pipe`) | **да** |
| Радиаторы | Коллекторные узлы (`radiator_collector`, `ext_manifold_box`, `int_manifold_box` — группа меню «Коллекторные узлы») | `items` (multi; anchor wall, plan {radiators, warm_floor}, у шкафов self_height 65; pc по виду: ext вплотную, int утоплен в стену (−5.5 от грани), collector 4.55 от грани — ревью 269 М1) | **да**: `item_add` against_wall (климат ч.3, эталон `ui-ref-climate3-manifold-*`); подключение к магистралям — `pipe_add` (multi) | да (`ui-ref-climate3-manifold-*`) | **да** |

### 4.4 Отделка, размеры, подписи, развёртки

| Лист | Инструмент UI (ключ) | Сущность и поля модели | MCP | Эталон | PRO |
|---|---|---|---|---|---|
| Помещения (`rooms`) | Название помещения (меню маркера площади) | `rooms2[rid].zones[i].name` | **да**: `room_set_name` (этап 347, эталон `ui-ref-finish9-room-fields`: null/""/"?" — «без имени», длина ≤ 100, управляющие символы запрещены; имя со спецсимволами `Комната "9" <тест> \` пережило save/reopen вживую) | нет (эталон `ui-ref-roomname.json` есть) | нет |
| Помещения | Номер (авто по площади), цвет фона | `zones[i].number_by_area` (авто: зоны всех помещений по убыванию площади — ROOMS2.draw, без микрокомнат < 1 м² без проёмов и записей зон без is_class — m2 ревью 348), `zones[i].color` | номер — **читается** в compact `rooms_list`/`model_get` (поле `number`, пересчитывается правилом редактора; производное, при save не сверяется); цвет — **да**: `room_set_color` (этап 347, hex #rrggbb, белый/#ffffff/null снимает — как палитра #cm-room2; сохранение цвета сверяется при save как пользовательское поле зоны); **отличия от редактора**: цвет — любой hex, в UI только палитра (n2 ревью 348); имя и цвет пишутся только в zones[0] — комнату после zone_c-деления UI именует по каждой зоне (n3 ревью 348); отметки правок полей переживают смену id комнаты редактором (M2 ревью 348) | да (цвет) | нет |
| Перегородки | Высота помещения (`#cm-room2--zone-height`) | высота зоны | частично: `project_set_height` — одна на проект | да | нет |
| Напольные покрытия (`floor`) | 22 покрытия без PRO (ламинат, паркет, доска, плитка, линолеум, ковролин…) | `rooms2[rid].floors[i].cover`, `type_laying`, `width/height` плашки, `stitch_width`, `angle` | **да**: `finish_floor_set` (этап 94, параметры раскладки; смена покрытия не стирает f0offset/anchor/angle/custom_angle/id — запись мутируется in place, как в редакторе — M1 ревью 348; панельные параметры width/height/stitch_width/type_laying при смене покрытия НЕ наследуются — в редакторе они из настроек нового инструмента, остаются конструктору Floor — M1-R ревью 350; при том же покрытии незаданные панельные параметры переносятся из записи — m1-R) | да | нет |
| Напольные покрытия | Керамогранит, метлах, мозаика, шестигранная плитка | то же | частично: `finish_floor_set` принимает (PRO-гейт по материалу, ревью 329 №2) | да | **да** |
| Напольные покрытия | Подъём пола (меню покрытия) | `floors[i].f0offset` (0..100 см, `#cm-floor--floor0-offset`; при ненулевом подъёме редактор предлагает «Применить ко всем» полам с нулевым — `cm-floor--modal`) | **да**: `finish_floor_offset_set` (этап 347, мм 0..1000, 0 — сброс; `apply_to_all_zero` — кнопка «Применить ко всем»: значение ставится ВСЕМ полам с f0offset==0, включая записи без покрытия — порт обработчика `#cm-floor--floor0-offset--confirm`, m3 ревью 348); сохранение подъёма сверяется при save как явно заданное поле (снят с пометки «производное»); точка укладки/подъём переживают деление комнаты стеной (restoreTotal копирует поля по совпадению контура зон — живая проба 347) и смену покрытия (M1 ревью 348); **отличие от редактора**: подъём больших `correctValue(0..100 см)` отклоняется, редактор обрезает; свободные фигуры/линии редактор пересчитывает при подъёме, MCP — нет (m4 ревью 348) | да | нет |
| Напольные покрытия | Точка начала укладки (`anchor_floor`) | `floors[i].anchor` (`{p:{x,y}}`; клик инструмента сбрасывает угол раскладки в 0, угол с якорем — меню `#cm-floor-anchor--angle`; снятие — ластик) | **да**: `finish_floor_anchor_set` (этап 347, эталон `ui-ref-finish9-anchor`; точка внутри полигона пола в мм; PRO — ключ `anchor_floor` через единый частичный гейт, снятие якоря не гейтится — ластик; состояние — `finish_get` `floor.anchor`/`offset_mm`) | да | **да** |
| Напольные покрытия | Зонирование пола (`zone_floor`) | верхнеуровневый `zone_delimiters` `zone_floor`, plan `floor` (этап 296) | **да**: `zone_floor_add/remove` (эталон `ui-ref-floorzone-delimiter`), список — `finish_get`/compact `zone_delimiters` (ZD<n>) | да | **да** |
| Напольные покрытия | Плинтусы, 7 видов (`floor_molding_*`) | `rooms2[rid].floorMoldings` (этап 245) | **да**: `finish_floor_molding_set/remove` (эталон `ui-ref-finish2-floor-molding`) | да | **да** |
| Потолки (`ceiling`) | 10 типов (натяжной ПВХ/ткань, покраска, ГКЛ, реечный, рейки, ПВХ-панели, побелка, Армстронг, Грильято) | `rooms2[rid].ceilings[i].type`, `level` (опуск), `profile` | **да**: `finish_ceiling_set` (этап 94, эталон `ui-ref-finish-ceiling`) | да | нет |
| Потолки | Двухуровневый потолок (`complex_ceiling`) | `ceilings[i].complex`, `radius`, `offset`, `material2` | **да**: `finish_ceiling_complex_set` (этап 328, эталон `ui-ref-ceiling-complex`: offset 40, radius 10, level 15/7.5, material gypsum_ceiling, material2 stretch_ceiling, type closed; проверки редактора: площадь ≥ 4 м², внутренний контур без самопересечений — коллинеарные рёбра сливаются перед отступом (T-узел, ревью 329 №3); нет-op на повторном вызове; в террасе отказ. Снятие: ластик complex не снимает, но снятие покрытия (`finish_ceiling_remove`) или смена материала (`finish_ceiling_set`) убирают complex с warning `complex_removed` (как в редакторе, ревью 329 №5); состояние — `finish_get` (complex/level2/material2) | да | нет |
| Потолки | Зонирование потолка (`zone_ceiling`) | верхнеуровневый `zone_delimiters` (граф GraphLines: vertexes/matrix, type zone_ceiling, plan ceiling; per-room `rooms2[rid].delimiters` — legacy, редактор мигрирует при restore; привязка узлов zone — производное редактора, конец на грани закладной — type `rigel_ceiling`, эталон `ui-ref-ceilzone-delimiter-rigel`) | **да**: `zone_ceiling_add/remove` (эталоны `ui-ref-ceilzone-delimiter`, `ui-ref-ceilzone-delimiter-rigel`), список — `finish_get`/compact `zone_delimiters` (ZD<n>) | да | **да** |
| Потолки | Закарнизная ниша (`ceiling_niche`), потолочный плинтус (`molding`) | `ceilings[0].niches`, `ceilingMoldings` (этап 245) | **да**: `finish_ceiling_niche_add/remove`, `finish_ceiling_molding_set/remove` (эталоны `ui-ref-finish2-ceiling-*`) | да | **да** |
| Потолки | Потолочная закладная (`ceiling_rigel`) | `rooms2[rid].rigels` (класс CeilingRigel: `{id, id_room, p1/p2 (link к боковым граням стен l/r или граням колонн), width 10 (панель 10..100 см), ceiling_type, polygon}` — этап 303) | **да**: `ceiling_rigel_add/update/delete` (эталон `ui-ref-zones3-ceiling-rigel`), список — `finish_get`/compact `ceiling_rigels` (CR<n>); перенос закладной редактором не поддержан (контекстное меню: ширина/удалить/сбросить отделку) — update меняет только width/ceiling_type; зоны потолка (`ceilings[]` по зонам) пересчитываются при операциях с закладными/делителями, отделка всех зон сверяется при save (этап 310, эталон `ui-ref-zones4-ceiling-zones`); изменение ширины перепривязывает узлы делителей на грани закладной к новой грани (restoreDelimiters, ревью 311 №3); ниши при пересчёте зон переносятся по геометрии (restoreCeilingNiches) или операция отказывает с подсказкой finish_ceiling_niche_remove | да | **да** |
| Потолки | Проём в потолке (`ceiling_hole`) | `level_holes` — та же коллекция, что у пола: `{type:"ceiling_hole", plan:"ceiling", polygon 4 угла, matrix-кольцо, vertexes/items, length (периметр, м), area (м²), pc, id_room}` (этап 328, эталон `ui-ref-ceiling-hole`) | **да**: `ceiling_hole_add/update/delete` (метки CH<n>); пересечение — в пределах вида (пол и потолок — разные листы); стена через проём: редактор молча теряет проём — MCP отказывает до записи (живая проба 328-live) | да | нет |
| Отделка стен (`walls`) | 11 видов без PRO (обои, покраска, побелка, плитка, мозаика, вагонка, панели, штукатурки) | `rooms2[rid].decors`: `{type, layer, line, line_wall, height, height_from_floor}` | **да**: `finish_wall_set` (этап 94, сторона стены по комнате) | да | нет |
| Отделка стен | Фартук, комбинированные (покраска+плитка, обои+плитка), меловая покраска, рейки, клинкер, камень, листовые/плиточные панели | то же | **да**: `finish_wall_set` — двухслойные painting_tile/wallpaper_tiles и фартук wall_apron (этап 245, эталон `ui-ref-finish2-wall-layers`); меловая покраска, рейки, клинкер, камень, листовые/плиточные панели — обычными покрытиями `finish_wall_set` (PRO-виды — гейт по материалу, ревью 329 №2) | да | **да** |
| Нижняя панель | Добавить размер (линейка) | `rulers[]` `{p1, p2, offset, plan, show_everywhere, p1_target, p2_target}`; точное значение задаётся в меню (анонс 25.08.2026) | **да**: `dim_add/update/delete`, `dims_list` (этап 113) | да | нет |
| Нижняя панель | Текстовый комментарий | `comments[]` | **да**: `comment_add/update/delete`, `comments_list` (этап 113; экранирование текста, лимиты; PRO-гейт 329 №2) | да | **да** |
| Нижняя панель | Нарисовать элемент: фигуры (`free_figures`: rect/rect_2/rect_round/rect_round_2/round/round_2/hexagon/octagon/triangle/triangle_2/semicircle/anticircle/quartercircle/roof), линии (`freelines`), толстые линии (`thick_lines`, ширина в ячейках matrix `{length, width}`) | serialize классов FreeFigure/FreeLine/ThickLine бандла (этап 375, эталоны `ui-ref-draw-*` синтетические по бандлу; живая проба 375-4 в dev-объекте: save verified → reopen → сверка) | **да**: `figure_add/update/delete`, `freeline_add/update/delete`, `thick_line_add/update/delete` (свободная геометрия, план — встроенный лист или custom_<id>, мм) | синтетические (по бандлу) | **да** (кнопка `#freelines_opener` — is_pro, проба 375-sheets-ui; гейт реестра pro.ts) |
| Нижняя панель | Изображение на плане (кнопка «Изображение», `#addimage_opener` — БЕЗ is_pro в разметке бесплатного тарифа, проба 375-sheets-ui — уточнение §3) | `pictures[]` `{url (хранилище, POST /setup/api/load_picture/), pc, width/height (вписано в 200×200), width_original/height_original, text, font_size, plan, type:"user"}` (этап 375, эталон `ui-ref-picture` синтетический; живая проба 375-4: загрузка → постановка → save verified → reopen) | **да**: `image_upload` (base64, только jpeg/png по сигнатуре, лимит 5 242 880 байт как в редакторе, MCP не читает локальные файлы), `image_add/update/delete` (метки PIC<n>) | синтетический (по бандлу) | нет (по разметке 375) |
| Пользовательские листы | «Добавить лист» (#groups_navi .add — без is_pro, проба 375-sheets-ui) | `custom_plans[]` `{id, name, after_plan, content, date}`; объекты привязываются планом `custom_<id>` (этап 375, эталон `ui-ref-sheet-custom` синтетический; живая проба 375-4) | **да**: `sheet_add/update/delete` (удаление — каскад объектов листа, как CustomPlan.delete: comments/free_figures/pictures/freelines/thick_lines/rulers); model_get → `custom_plans` | синтетический (по бандлу) | нет |
| Развёртки (режим «Стены») | Автоматические развёртки, нумерация стен, «назначить первой», «скрыть стену» | `rooms2[rid].prs_first`, `prs_disabled`, `prs_hidden`, `edges_prs` | **да**: `prs_set` (этап 389; hidden — «скрыть развёртки» + все oid в prs_disabled, first_wall — «назначить первой», hide_walls/show_walls — знак развёртки; состояние — model_get rooms[].prs; записи под oid (hidden:true, first_wall со стеной, hide_walls) требуют раскладки развёрток (edges_prs с реальными oid редактора — при пустом edges_prs отказ с указанием на `room_prs_layout`, находка A ревью 397; этап 406: `room_prs_layout` создаёт раскладку кодом редактора — ROOMS2[id].createEdgesPrs() через адаптер, no-op при готовой раскладке, ответ в мм/W<n>; очистка hidden:false/show_walls/first_wall:null работает и без раскладки — находка 5 ревью 400); настройки переносятся редактором при wall-операциях — сверка save и предупреждение о сбросе по стене ребра с порядком (мультимножество), при изменении нарезки — skip; ключ prs_disabled/prs_first вне oid edges_prs — ошибка/предупреждение (унаследованный); живая проба 399: настройки с реальными oid переживают wall_move нетронутой стены) | синтетические (по бандлу, synthetic-prs-layout.json) + живые пробы 389-12, 396, 399; `room_prs_layout`: живая проверка — проба scripts/probes/406-prs-layout-live.ts, прогон ожидается | нет (просмотр); экспорт — PDF, PRO |
| Развёртки | Молдинги, ниши, профили, линейный свет, точка укладки плитки (`wall_molding`, `wall_niche`, `wall_profile`, `line_light`, `anchor_decor`) | `wall_moldings`, `wall_niches` (serialize WallMolding/WallNiche бандла: pc/width/height/plan/prs{room,edge_index,pc_xd,pc_yd}/width_line|depth/on_size), `line_strips` (`plan:"projections"`), `decors[].anchor` | **да**: `wall_molding_add/update/delete` + `wall_niche_add/update/delete` (этап 389, метки WM<n>/WN<n>, рамка развёрток детерминирована — getPolygons, slim-типы как в draw бандла, ниша не на стекле/балконе и без пересечений), `finish_wall_anchor_set` (anchor_decor: along_mm/height_mm семантически, angle=0, wall_woodbatten→90, custom_angle снимается; рамка части — xMin/xMax из part.line, части, нарезанные по длине, адресуются по along без layer — follow-up 392 №16), `line_light` — line_light_add; `wall_profile` — свободная линия freelines type="wall_profile" (freeline_add) | синтетические `ui-ref-unfold-*` (по сериализации бандла) + живая проба 389-12 (validate → save verified → reopen → сверка → render PNG) | нет (wall_molding/wall_niche/wall_profile/anchor_decor без is_pro в разметке, эталон 328-pro-anon; в отличие от anchor_floor) |
| Гидроизоляция, изоляция, штукатурка, стяжка | схемы для бригады (вне 4 областей) | `rooms2[rid].hydroisolations`, `isolations`, `plasters*`, `caps`; зонирование гидроизоляции/стяжки — `zone_delimiters` `zone_hydroisolation` (plan `hydroisolation`) / `zone_floor_cap` (plan `floor_cap`) (этап 296) | **да**: `zone_hydroisolation_add/remove`, `zone_floor_cap_add/remove` (эталоны `ui-ref-hydrozone-delimiter`, `ui-ref-capzone-delimiter`) | — | частично |

## 5. Сводка по областям

Инструмент UI здесь — позиция панели слева, кнопка нижней панели или действие контекстного меню, которое создаёт или
меняет сущность. Предметы сантехники посчитаны одной строкой (их покрывает `item_add`).

| Область | Инструментов UI | Из них PRO | Покрыто MCP сейчас | Предлагается в фазе 2 (инструментов MCP) |
|---|---|---|---|---|
| 1. Перепланировка | 16 (демонтаж 6, перегородки 9, проёмы на перегородках 1) | 2 | 1 частично (`wall_add kind=partition`) | 4 новых: `demolish`, `demolish_cancel`, `pillar_add` (ГКЛ-короб), `zone_line_add`; расширение `wall_add` (материал), `opening_add` (замена проёма) |
| 2. Сантехника и вода | 19 (стояки и ввод 5, сантехника 1 группа, водоснабжение 12, автопостроение 1) | 8 | 1 да (сантехника), 5 частично | 2 новых, общих с электрикой: `fixture_add` (стояки, выводы), `network_add` (трубы — PRO); расширение `item_add` |
| 3. Электрика и свет | 169 позиций: розетки 31, выключатели 10, свет 49, проводка 40, щиток 43 модуля и «Построить автоматически»; без повторов щитков — 168 + мастер. По механике это 12 видов: настенная точка, потолочная или напольная точка, светильник, линия-граф ×4 (кабель, связь выключателя, шина, LED), щиток, модуль, мастер | 119 (75 помечены `is_pro` + 43 модуля и мастер листа «Электрощиток») | 0 да, 2 частично (светильники через `item_add`) | те же `fixture_add`, `network_add` (виды `cable`, `switch_link`, `led`, `track`; все PRO); щиток не предлагается |
| 4. Отделка и размеры | 89: полы 35 + зонирование пола 1, потолки 16, стены 20, помещения 4, нижняя панель 4, развёртки 7, проёмы пола и потолка 2 | 30 | 0 | `room_set_name`, `floor_finish_set`, `ceiling_set`, `wall_finish_set`, `dimension_add`, `comment_add` (PRO) |

Итого в фазе 2 — **13 новых инструментов MCP** (4 + 2 + 6 по областям и общий `entity_delete`) и расширение 4 существующих
(`wall_add`, `opening_add`, `item_add`, `model_get`), а также новые проверки `model_validate`.
Состав — в [phase2-design.md §3](phase2-design.md).

## 6. Расхождения модели и интерфейса

### 6.1 В модели есть, в UI недоступно или скрыто

| Что | Где видно | Комментарий |
|---|---|---|
| PRO-инструменты на бесплатном тарифе | сервер принимает любую модель | технически пишется, но это обход тарифа — MCP запрещает |
| Типы покрытий `laminate_edged`, `parquet_board_edged`, `engineer_board_edged`, `wood_board_edged`, `floor_tile_20`, `floor_tile_30` | каталог, нет кнопок | устаревшие ключи: конструктор `Floor` переводит их в `cover` + `type_laying:"fir_en"` или `tile` |
| `electric_shield_old`, `territory_fence`, `territory_column`, `hanging_light_double/triple`, `hanging_lightspot*` | каталог, нет кнопок | устаревшие или скрытые позиции; MCP их не предлагает |
| `rooms2[rid].delimiters` | старые модели | редактор переносит в `zone_delimiters` (`Rooms2.patch`) |
| Высота стены `walls[id].height` у каждой стены | модель | в UI высота одна на проект (`total_height`) и на зону |
| `smeta_water_pipes`, `length` у линий, `area` у зон | модель | производные, их считает редактор при сохранении; MCP их не пишет |
| Привязка к стене `id_wall`, `wall_direction`, `wall_line` | `items[].props` | производные от геометрии (`Item.findWall`), MCP их не пишет |

### 6.2 В UI есть, в модели нет отдельной сущности

| Что | Комментарий |
|---|---|
| Развёртки стен | строятся автоматически из 2D-листов; в модели только настройки `prs_*`, молдинги, ниши, линейный свет |
| Метраж кабелей и труб, сметы | считается на клиенте (`/client/smeta/`) |
| Временная линейка (Alt/Ctrl) | не сохраняется |
| «Построить автоматически» (вода, щиток) | мастер в UI, результат — обычные `pipes`, `items`, `shields` (PRO) |
| Нумерация помещений | вычисляется по убыванию площади (`number_by_area`) |
| Видимость элементов, магниты, единицы | настройки отображения (`settings`, `pagesVisibilitySettings`) |
