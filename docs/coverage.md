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
«Данный инструмент доступен в PRO-версии программы». В анонимном редакторе помечено 727 из 1563 инструментов. Сервер
модель не проверяет (design §2), поэтому PRO-сущность технически можно записать в модель. **Это обход тарифа (AGENTS.md,
правило 5), MCP так не делает:** на бесплатном тарифе PRO-инструмент возвращает `NOT_AVAILABLE_ON_TARIFF`.

Кроме инструментов, за PRO закрыты: комментарии, «Нарисовать элемент» (фигуры и линии), изображения на плане, PDF/PNG/SVG,
DXF (старшие тарифы), 3D, «Построить автоматически» (водоснабжение и щиток), лист «Электрощиток» (конструктор щитка —
«старшие тарифы PRO», анонс 24.12.2025; вкладка листа в анонимном редакторе не помечена — [проверить] на бесплатном аккаунте).

## 4. Карта покрытия

Столбцы: **MCP** — покрыто ли существующими инструментами (design §7): да / нет / частично. **Эталон** — нужен ли снимок из UI
до реализации (F2-01). **PRO** — инструмент закрыт на бесплатном тарифе. Ключи — `global_tools`.

### 4.1 Перепланировка

| Лист | Инструмент UI (ключ) | Сущность и поля модели | MCP | Эталон | PRO |
|---|---|---|---|---|---|
| Демонтаж (`break_walls`, `b`) | Демонтаж стены целиком (`break`) | `walls[id].demount=1`, `p1/p2.demount=1`, `sectors={}` (`Wall.setDemount`) | нет | да | нет |
| Демонтаж | Демонтировать участок стены (`break_part`) | `walls[id].sectors[sid]={id, pc (на оси), width}`; на листе `c` редактор режет стену на дочерние (`child`) | нет | да | нет |
| Демонтаж | Демонтировать проём (`break_door`) | `walls[id].holes[hid].demount=1`; нельзя, если проём уже заменён на «Перегородках» | нет | да | нет |
| Демонтаж | Демонтировать радиатор / электрощиток (`break_radiator`, `break_electric_shield`) | `items[id].props.demount` у предметов исходного плана | нет | да | нет |
| Демонтаж | Отменить демонтаж (`remove_break`) | обнуление тех же полей | нет | нет | нет |
| Перегородки (`create_walls`, `c`) | Стена из ПГБ / пеноблоков / кирпича / ГКЛ (`wall_create_pgb\|blocks\|bricks\|gypsum`) | `walls[id]` с `plan:"c"`, материал `c_*` | частично: `wall_add kind=partition` ставит `plan:c`, материал не выбирается | да (материалы `c_*`) | нет |
| Перегородки | Стеклянная, реечная перегородка (`wall_create_glass`, `wall_create_bar`) | то же, `c_glass`, `c_bar` | нет | да | **да** |
| Перегородки | Гипсокартонный короб (`gypsum_box`) | `pillars[id]` с `plan:"c"`, `role_:"gypsum"`, высота | нет | да | нет |
| Перегородки | Обшивка ГКЛ (`gypsum_cladding`) | `claddings` | нет | да | нет (в разметке нет кнопки — [проверить]) |
| Перегородки | Зонировать помещение (`zone`) | `zone_delimiters[]` `type:"zone_c"` → новые `rooms2[].zones` со своей площадью | нет | да | нет |
| Перегородки | Двери и окна на перегородках, замена исходной двери | `walls[id].holes[hid]` с `plan:"c"`; замена — проём `c` поверх проёма `a` | частично: `opening_add` на стене `plan:c` [проверить]; замены нет | да | как у проёмов (13 типов дверей PRO) |
| Исходный план | Силуэт перегородок на исходном плане | настройка видимости | не нужно | нет | нет |

### 4.2 Сантехника и вода

| Лист | Инструмент UI (ключ) | Сущность и поля модели | MCP | Эталон | PRO |
|---|---|---|---|---|---|
| Исходный план → «Коммуникации» | Сантехнический стояк, стояки ГВС/ХВС, канализационный (`water`, `water_column_hot\|cold`, `drainage_column`) | `items` («шахты»: `items_mines`, `items_on_walls` — ставятся у стены) | частично: `item_add` требует точку внутри комнаты, привязка к стене не проверялась | да | нет |
| Исходный план | Ввод водоснабжения (`ceiling_water`) | `items` | частично | да | нет |
| Сантехника (`santeh`) | 176 позиций (`santeh_furniture` 136 + `furniture` 40) | `items` с `plan.santeh` | **да** (`item_add`, `catalog_search`) | нет (эталон ванны/унитаза есть в T1) | 23 группы PRO (поддоны, уголки, накладные раковины…) |
| Водоснабжение (`waterplan`) | Выводы: ХВС+ГВС, ХВС+канализация, ХВС+ГВС+канализация, ГВС+канализация (`waterspot_cold_hot`, `waterspot_drainage_cold`, `waterspot_drainage_cold_hot`, `waterspot_drainage_hot`) | `items` (`waterspots`), высота `over_floor` 50 см, у канализации своя высота (`#cm-waterspot--drainage-over-floor`), группа (`GroupWaterSpots`) | нет | да | нет |
| Водоснабжение | Одиночные выводы ХВС, ГВС, канализации (`waterspot_cold\|hot\|drainage`) | `items` | нет | да | **да** |
| Водоснабжение | Коллекторный узел (`waterspot_collector`) | `items`, `anchor: wall`, h 150 | нет | да | **да** |
| Водоснабжение | Узел (`waterspot_node`) | вершина графа труб | нет | да | нет |
| Водоснабжение | Трубы ХВС, ГВС, канализации (`water_pipe`, `water_hot_pipe`, `drainage_pipe`) | `pipes[]` (граф); метраж для сметы — вдоль стен, не по линии | нет | да | **да** |
| Водоснабжение | Построить автоматически | мастер (`load_v2_modal('santeh_pipes')`) | нет | нет | **да** |

### 4.3 Электрика и свет

| Лист | Инструмент UI (ключ) | Сущность и поля модели | MCP | Эталон | PRO |
|---|---|---|---|---|---|
| Розетки (`sockets`) | Стандартная, группа, IP44, силовая, 380 В (`socket`, `socket_group`, `socket_ip44`, `socket_power`, `socket_380`) | `items` `name:"socket_group"`, `socket_group:[…]`, `id_wall`, `wall_direction`, `over_floor` 30 (до центра), `layer` | да: `item_add`/`item_update`/`item_delete` (этап 88) | да | нет |
| Розетки | Слаботочные (ТВ, интернет, USB, HDMI, телефон, аудио), мебельная, напольная, потолочная | `items` | да: `item_add` (этап 88) | да | **да** |
| Розетки | Выводы провода 220 В, под освещение, духовку, варочную панель, кондиционер (`wire`, `wire_light`, `wire_oven`, `wire_stove`, `wire_conditioner`) | `items` (`wires`), h 30 / 230 | да: `item_add` (часть 2); подключение кабелем — `wiring_add` | да | нет |
| Розетки | Слаботочный, напольный, потолочный вывод | `items` | да: `item_add` (часть 2) | да | **да** |
| Розетки / Электропроводка | Электрощиток накладной, встроенный, слаботочный (`electric_shield`, `electric_shield_internal`, `lowcurrent_shield*`) | `items`, `anchor: wall`, h 120/170 | да: `item_add` (часть 2); конструктор щитка — нет | да | нет |
| Розетки | Домофон, видеодомофон, Wi-Fi роутер | `items` | нет | нет | **да** |
| Выключатели (`light_connections`) | 1- и 2-клавишный (`light_switch`, `light_switch_double`) | `items` (группы, как розетки), h 90 | да: `item_add` (этап 88) | да | нет |
| Выключатели | 3-клавишный, диммер, проходные, перекрёстные, мастер | `items` | да: `item_add` (этап 88, каталог) | да | **да** |
| Выключатели | Соединительная линия (`cable`) | `cables[]` (`Cable`), вершины — выключатель (клавиша) и светильники/световые линии | да: `cable_add`/`cable_delete` (этап 88; часть 2 — цель-линия led_strip/line_light/трековые, вершина `<lineId>\|t\|<vid>`) | да | **да** |
| Освещение (`light`) | Люстры, потолочные и встраиваемые светильники (32 позиции без PRO) | `items` (`anchor: ceiling`), размер до центра, «центр комнаты = ½» | частично: `item_add center` | да (центр комнаты) | нет |
| Освещение | Бра и настенные (`bra`, `bra_shades`, `led_lamp`, `light_stick`, `wall_spot`, `wall_lamp`, `painting_lighting`) | `items` (`anchor: wall`), h 120–220 | частично | да | нет |
| Освещение | Трековые шины, споты, линейный свет, LED-подсветка (`*_strip`, `track_*`, `line_light`, `led_strip`) | `stripes_light`, `line_strips`, `led_strips` | нет | да | **да** |
| Освещение | Двойные и тройные встраиваемые и накладные, банные, уличные, подсветка пола | `items` | нет | нет | **да** |
| Электропроводка (`cables`) | Кабели 2–5 жил, заземление, слаботочные (31 тип `wire_*`); warm_floor_wire, conditioner_wire | `cables_socket[]` / `cables_warm_floor[]` / `cables_conditioner[]` (`ElecCable`, граф как трубы), длина с опусками до точек (производная); плоскость расчёта — в меню щитка | да: `wiring_add`/`wiring_update`/`wiring_delete` (часть 2) | да | **да** |
| Электропроводка | Распред. короб потолочный, в стене; КУП (`electric_box`, `electric_box_wall`, `electric_kup`) | `items` | да: `item_add` (часть 2) | да | **да** |
| Электропроводка | Узел (`electrospot_node`) | вершина графа | да: `item_add` (часть 2) | да | нет |
| Электрощиток (`shield`) | 43 модуля: DIN-рейки, автоматы, УЗО, шины, провода, «Построить автоматически» | `shields[shield_id]` (рейки, шины, модули, провода) | нет | да | **да** (старшие тарифы, по анонсу) |

### 4.4 Отделка, размеры, подписи, развёртки

| Лист | Инструмент UI (ключ) | Сущность и поля модели | MCP | Эталон | PRO |
|---|---|---|---|---|---|
| Помещения (`rooms`) | Название помещения (меню маркера площади) | `rooms2[rid].zones[i].name` | нет (параметр `name` у `room_add_*` игнорируется; `room_set_name` в design §7.2, не реализован) | нет (эталон `ui-ref-roomname.json` есть) | нет |
| Помещения | Номер (авто по площади), цвет фона | `zones[i].number_by_area` (авто), `zones[i].color` | нет | да (цвет) | нет |
| Перегородки | Высота помещения (`#cm-room2--zone-height`) | высота зоны | частично: `project_set_height` — одна на проект | да | нет |
| Напольные покрытия (`floor`) | 22 покрытия без PRO (ламинат, паркет, доска, плитка, линолеум, ковролин…) | `rooms2[rid].floors[i].cover`, `type_laying`, `width/height` плашки, `stitch_width`, `angle` | нет | да | нет |
| Напольные покрытия | Керамогранит, метлах, мозаика, шестигранная плитка | то же | нет | да | **да** |
| Напольные покрытия | Подъём пола (меню покрытия) | `floors[i].f0offset` | нет | да | нет |
| Напольные покрытия | Точка начала укладки (`anchor_floor`) | `floors[i].anchor` | нет | да | **да** |
| Напольные покрытия | Зонирование пола (`zone_floor`) | `zone_delimiters` `zone_floor` | нет | да | **да** |
| Напольные покрытия | Плинтусы, 7 видов (`floor_molding_*`) | `rooms2[rid].floorMoldings` | нет | да | **да** |
| Потолки (`ceiling`) | 10 типов (натяжной ПВХ/ткань, покраска, ГКЛ, реечный, рейки, ПВХ-панели, побелка, Армстронг, Грильято) | `rooms2[rid].ceilings[i].type`, `level` (опуск), `profile` | нет | да | нет |
| Потолки | Двухуровневый потолок (`complex_ceiling`) | `ceilings[i].complex`, `radius`, `offset`, `material2` | нет | да | нет |
| Потолки | Зонирование потолка, закарнизная ниша, потолочный плинтус | `zone_delimiters` `zone_ceiling`, `ceilings[i].niches`, `ceilingMoldings` | нет | да | **да** |
| Потолки | Потолочная закладная (`ceiling_rigel`), проём в потолке (`ceiling_hole`) | `rooms2[rid].rigels`, `level_holes` | нет | да | нет |
| Отделка стен (`walls`) | 11 видов без PRO (обои, покраска, побелка, плитка, мозаика, вагонка, панели, штукатурки) | `rooms2[rid].decors`: `{type, layer, line, line_wall, height, height_from_floor}` | нет | да | нет |
| Отделка стен | Фартук, комбинированные (покраска+плитка, обои+плитка), меловая покраска, рейки, клинкер, камень, листовые/плиточные панели | то же | нет | да | **да** |
| Нижняя панель | Добавить размер (линейка) | `rulers[]` `{p1, p2, offset, plan, show_everywhere, p1_target, p2_target}`; точное значение задаётся в меню (анонс 25.08.2026) | нет | да | нет |
| Нижняя панель | Текстовый комментарий | `comments[]` | нет | да | **да** |
| Нижняя панель | Нарисовать элемент (фигуры, линии, толстые линии), изображение | `free_figures`, `freelines`, `thick_lines`, `pictures` | нет | нет | **да** |
| Пользовательские листы | Добавить лист | `custom_plans` | нет | нет | [проверить] |
| Развёртки (режим «Стены») | Автоматические развёртки, нумерация стен, «назначить первой», «скрыть стену» | `rooms2[rid].prs_first`, `prs_disabled`, `prs_hidden`, `edges_prs` | нет | да | нет (просмотр); экспорт — PDF, PRO |
| Развёртки | Молдинги, ниши, профили, линейный свет, точка укладки плитки (`wall_molding`, `wall_niche`, `wall_profile`, `line_light`, `anchor_decor`) | `wall_moldings`, `wall_niches`, `line_strips` (`plan:"projections"`), `decors[].anchor` | нет | да | `line_light` — **да**; остальное [проверить] |
| Гидроизоляция, изоляция, штукатурка, стяжка | схемы для бригады (вне 4 областей) | `rooms2[rid].hydroisolations`, `isolations`, `plasters*`, `caps` | нет | — | частично |

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
