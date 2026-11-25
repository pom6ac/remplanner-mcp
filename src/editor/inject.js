// Функции, исполняемые ВНУТРИ страницы редактора (page.evaluate). Только строки.
// Контракт с редактором — 6 точек входа (design §3):
// window.WALLS, window.ROOMS2, window.$Project.restore, window.$Project.draw,
// window.project.copy, window.project.save + элемент холста #canvas_v2_wrapper.

export const PAGE = {
  /** Снять пустой startup-фог и обучающие попапы (глотают клики, 02-feasibility). */
  clearFog: `(() => {
    const f = document.querySelector('#planner_ui_message_fog');
    if (f && f.classList.contains('active') && !f.innerHTML.trim()) f.classList.remove('active');
    document.querySelectorAll('.planner_ui_message.active').forEach((e) => e.classList.remove('active'));
    return true;
  })()`,

  /** Готовность редактора и наличие всех точек входа контракта. */
  readyCheck: `(() => {
    const w = window;
    return Boolean(
      w.WALLS && w.ROOMS2 !== undefined && w.$Project &&
      typeof w.$Project.restore === 'function' &&
      typeof w.$Project.draw === 'function' &&
      w.project && typeof w.project.copy === 'function' && typeof w.project.save === 'function' &&
      document.querySelector('#canvas_v2_wrapper')
    );
  })()`,

  /** Информация о версии: global_version, бандлы со страницы, id проекта из body. */
  compatInfo: `(() => {
    const w = window;
    const bundles = [...document.querySelectorAll('script[src]')]
      .map((s) => s.getAttribute('src'))
      .filter((s) => s && s.includes('/files/js/'));
    // класс Wall — глобальная лексическая привязка бандла, на window его нет:
    // проверяем оба пути (T25: draw строит связи через Wall.prototype.link1/link2/calc)
    let wallProto = null;
    try {
      const C = (typeof Wall === 'function') ? Wall : (typeof w.Wall === 'function' ? w.Wall : null);
      wallProto = C ? C.prototype : null;
    } catch (e) { wallProto = null; }
    return {
      global_version: w.global_version !== undefined ? String(w.global_version) : null,
      planner_version: w.planner_version !== undefined ? String(w.planner_version) : null,
      bundles,
      object_id: document.body ? (document.body.dataset.objectId || null) : null,
      plan_id: document.body ? (document.body.dataset.plan_id || null) : null,
      present: {
        WALLS: Boolean(w.WALLS),
        ROOMS2: w.ROOMS2 !== undefined,
        restore: Boolean(w.$Project && typeof w.$Project.restore === 'function'),
        draw: Boolean(w.$Project && typeof w.$Project.draw === 'function'),
        copy: Boolean(w.project && typeof w.project.copy === 'function'),
        save: Boolean(w.project && typeof w.project.save === 'function'),
        canvas: Boolean(document.querySelector('#canvas_v2_wrapper')),
        wall_link1: Boolean(wallProto && typeof wallProto.link1 === 'function'),
        wall_link2: Boolean(wallProto && typeof wallProto.link2 === 'function'),
        wall_calc: Boolean(wallProto && typeof wallProto.calc === 'function'),
      },
    };
  })()`,

  /**
   * Нормализация: $Project.restore(model) → $Project.draw({rooms:1}) → project.copy('server').
   * Возвращает копию, комнаты из ROOMS2 и счётчики «до/после» для детекта удалений.
   */
  // Аргумент передаётся через window.__remplanner_arg = {model, waitMs} (Playwright не вызывает
  // строковые функции с аргументами).
  restoreDrawCopy: `(() => new Promise((resolve) => {
    const w = window;
    const arg = w.__remplanner_arg || {};
    const model = arg.model;
    const waitMs = arg.waitMs || 1200;
    const countHoles = (walls) => Object.values(walls || {}).reduce((n, x) => n + Object.keys((x && x.holes) || {}).length, 0);
    const before = {
      walls: Object.keys(w.WALLS || {}).length,
      holes: countHoles(w.WALLS),
      items: Object.keys(w.ITEMS || {}).length,
      pillars: Object.keys(w.PILLARS || {}).length,
      rigels: Object.keys(w.RIGELS || {}).length,
    };
    let restoreError = null;
    try {
      // reset:1 — переинициализация данных плана: без неё повторный restore на той же
      // странице не попадает в save-пайплайн редактора (план "a" остаётся со старыми данными)
      w.$Project.restore(model, { reset: 1 });
    } catch (e) {
      restoreError = String(e && e.message ? e.message : e);
    }
    if (restoreError) { resolve({ restoreError }); return; }
    w.$Project.draw({ rooms: 1 });
    setTimeout(() => {
      const wallsNow = w.WALLS || {};
      const copyOf = () => {
        try { return JSON.parse(JSON.stringify(w.project.copy('server'))); } catch (e) { return null; }
      };
      const collect = (copy, rebuildError) => {
        // комнаты списка: из итоговой копии (перестроенные rooms2), при пустой —
        // живые ROOMS2 (зоны с именами), при пустых — ROOMS1 (points без area)
        const copyRooms = (copy || {}).rooms2 && Object.keys(copy.rooms2).length > 0 ? copy.rooms2 : null;
        const roomSource = copyRooms || (w.ROOMS2 && Object.keys(w.ROOMS2).length > 0 ? w.ROOMS2 : w.ROOMS1);
        const rooms = Object.entries(roomSource || {}).map(([id, r]) => {
          const poly = r && Array.isArray(r.polygon) ? r.polygon : (r && Array.isArray(r.points) ? r.points : []);
          let areaCm2 = null;
          if (poly.length >= 3) {
            let s = 0;
            for (let i = 0; i < poly.length; i++) {
              const a = poly[i], b = poly[(i + 1) % poly.length];
              s += a.x * b.y - b.x * a.y;
            }
            areaCm2 = Math.abs(s) / 2;
          }
          return {
            id,
            name: r && r.zones && r.zones[0] && r.zones[0].name !== undefined ? r.zones[0].name : null,
            area: r && typeof r.area === 'number' ? r.area : null,
            area_m2: areaCm2 !== null ? Math.round(areaCm2) / 10000 : null,
            height: r && typeof r.height === 'number' ? r.height : null,
            polygon: poly,
          };
        });
        const after = {
          walls: Object.keys(wallsNow).length,
          holes: countHoles(wallsNow),
          items: Object.keys(w.ITEMS || {}).length,
          pillars: Object.keys(w.PILLARS || {}).length,
          rigels: Object.keys(w.RIGELS || {}).length,
        };
        // связи концов и наложение каждой стены (design §12.4): проверка результата draw
        const linkOf = (l) => (l ? { ct: l.ct, id: l.id, z0: l.z0, z1: l.z1, pos: l.pos } : null);
        const wallsOut = Object.values(wallsNow).map((x) => ({
          id: x.id,
          p1: { x: x.p1.x, y: x.p1.y },
          p2: { x: x.p2.x, y: x.p2.y },
          depth: x.depth,
          link1: linkOf(x.p1.link),
          link2: linkOf(x.p2.link),
          overWall: typeof x.isOverWall === 'function' ? (() => { try { return Boolean(x.isOverWall()); } catch (e) { return null; } })() : null,
        }));
        resolve({ copy: copy || {}, rooms, before, after, walls: wallsOut, errors: (copy || {}).errors || null, roomsRebuild: rebuildError || "ok" });
      };
      // Сразу после draw copy('server') может отставать от живых WALLS (редактор
      // достраивает стены/комнаты асинхронно) — опрашиваем до совпадения (≤ 8 с).
      let tries = 0;
      const poll = () => {
        tries++;
        try { w.project.localSave(); } catch (e) { /* не критично */ }
        const copy = copyOf();
        const want = Object.keys(wallsNow).length;
        const got = copy ? Object.keys(copy.walls || {}).length : -1;
        if (want === 0 || (got === want && got >= 0) || tries >= 20) {
          // Пересчёт комнат, который делает штатное сохранение: редактор перестраивает rooms2
          // только внутри save-пайплайна (план "a" → copyRooms1 → план "c" → draw),
          // поэтому copy('server') после простого draw несёт СТАРЫЕ комнаты (проба 137:
          // split/merge/перенос стены — сервер после save имел другие комнаты, копия — старые,
          // строгая сверка после save давала ложный SITE_ERROR). Повторяем ТУ ЖЕ
          // последовательность ТЕХ ЖЕ функций редактора, что в начале штатного сохранения
          // (probe 137 p137-page4: копия получает перестроенные комнаты, идущие на сервер).
          let finalCopy = copy || {};
          let rebuildError = null;
          let backedUp = false;
          try {
            w.$Project.backupPlan();
            backedUp = true;
            w.$Project.setPlanName('a'); w.plan_ = 0; w.$Project.draw({ for3d: 1, rooms: 1 });
            w.$Project.copyRooms1();
            w.$Project.setPlanName('c'); w.plan_ = 0; w.$Project.draw({ for3d: 1, rooms: 1 });
            const rebuilt = copyOf();
            // страница возвращается в то же состояние, что до пересчёта: та же модель,
            // тот же restore, который и так делает следующий круг normalize.
            // Замечание: подготовка плана "c" может резать стены по проёмам
            // (split_by_holes) — число стен копии может отличаться от живых WALLS,
            // это ровно то, что редактор отправляет на save (проверки потерь —
            // в адаптере normalize: эквивалентность осей, счётчики, ошибки).
            if (rebuilt && rebuilt.walls && Object.keys(rebuilt.walls).length > 0) {
              finalCopy = rebuilt;
            }
          } catch (e) {
            // ревью 139 m2: сбой пересчёта не откатывается молча — краткий код
            // ошибки (без пользовательских данных) идёт в результат normalize.
            // ревью 147 №4: только имя исключения/код, текст исключения наружу не идёт
            const label = e && (e.name || e.code) ? String(e.name || "error") : "";
            rebuildError = label
              ? (e && e.code !== undefined ? label + " (" + String(e.code) + ")" : label).slice(0, 200)
              : String(e).slice(0, 200);
          } finally {
            // ревью 139 m1: при любом исключении лист редактора возвращается
            // в исходный (restorePlan), модель — в состояние до пересчёта
            if (backedUp) {
              try { w.$Project.restorePlan(); } catch (e) { /* лист уже исходный */ }
            }
            try {
              w.$Project.restore(model, { reset: 1 });
              w.$Project.draw({ rooms: 1 });
            } catch (e) { /* восстановление не должно маскировать причину сбоя */ }
          }
          collect(finalCopy, rebuildError);
          return;
        }
        setTimeout(poll, 400);
      };
      poll();
    }, waitMs);
  }))()`,

  /**
   * Раскладка развёрток комнаты (этап 406): $Project.restore(model) → draw({rooms:1})
   * → ROOMS2[roomId].createEdgesPrs() → id_of_edges[e]=edges_prs[e].oid — тот же
   * код редактора, что при открытии листа «Развёртки» (Projections.get:
   * createEdgesPrs(getLines()) и id_of_edges[e]=lines[e].oid) и в serialize_room.
   * Аргумент — window.__remplanner_arg = {model, roomId}: roomId — ключ rooms2
   * модели, проверенный на стороне Node (данные, не код). Возвращает только
   * edges_prs/id_of_edges комнаты; страница после вызова восстанавливается тем
   * же restore (следующий normalize всё равно делает restore с reset).
   */
  prsLayout: `(() => {
    const w = window;
    const arg = w.__remplanner_arg || {};
    const model = arg.model;
    const roomId = arg.roomId;
    try {
      w.$Project.restore(model, { reset: 1 });
      w.$Project.draw({ rooms: 1 });
    } catch (e) {
      return { layoutError: "restore", name: String((e && e.name) || "error").slice(0, 100) };
    }
    const rooms = w.ROOMS2 || {};
    if (typeof roomId !== "string" || !Object.prototype.hasOwnProperty.call(rooms, roomId)) {
      return { missing: true };
    }
    const room = rooms[roomId];
    let out;
    try {
      room.createEdgesPrs();
      room.id_of_edges = [];
      for (let e = 0; e < room.edges_prs.length; e++) room.id_of_edges[e] = room.edges_prs[e].oid;
      out = JSON.parse(JSON.stringify({ edges_prs: room.edges_prs, id_of_edges: room.id_of_edges }));
    } catch (e) {
      return { layoutError: "createEdgesPrs", name: String((e && e.name) || "error").slice(0, 100) };
    }
    try {
      w.$Project.restore(model, { reset: 1 });
      w.$Project.draw({ rooms: 1 });
    } catch (e) { /* страница всё равно перезагрузит модель в следующем normalize */ }
    return out;
  })()`,

  /** Сохранение штатным project.save(false, true); ответ ловит адаптер по network. */
  savePlan: `(() => {
    const w = window;
    try {
      // синхронизировать состояние редактора перед сохранением
      try { w.project.localSave(); } catch (e) { /* не критично */ }
      w.project.save(false, true);
      return { started: true };
    } catch (e) {
      return { started: false, error: String(e && e.message ? e.message : e) };
    }
  })()`,

  /** Текущие id проекта на странице (data-атрибуты body) — сверка перед save. */
  currentIds: `(() => {
    const b = document.body;
    return {
      object_id: b && b.dataset.objectId ? String(b.dataset.objectId) : null,
      plan_id: b && b.dataset.plan_id ? String(b.dataset.plan_id) : null,
    };
  })()`,

  /** Хеши бандлов (содержимое уже скачано адаптером; здесь — только список). */
  bundleNames: `(() => [...document.querySelectorAll('script[src]')]
    .map((s) => s.getAttribute('src'))
    .filter((s) => s && s.includes('/files/js/')))()`,
};
