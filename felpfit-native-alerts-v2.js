/*
 * FelpFit Native Alerts UI v2
 * Cloudflare-side enhancement for the already-installed iOS native engine (build 145+).
 * IMPORTANT: This file contains NO copy of the FelpFit HTML. It reads the live page's
 * current functions/data and sends normalized alert commands to the installed native bridge.
 */
(() => {
  'use strict';

  if (window.__felpfitAlertsV2Bootstrapped) return;
  // Native-only enhancement: regular Safari/PWA keeps the existing web-push UI untouched.
  if (!window.webkit?.messageHandlers?.felpfitNative) return;
  window.__felpfitAlertsV2Bootstrapped = true;

  // The build-145 bridge owns a one-minute automatic sync. For remote ownership of the
  // schedule, intercept only that exact bridge timer while the WKUserScript is being injected
  // at documentEnd. This wrapper restores the original setInterval immediately afterwards.
  const originalSetInterval = window.setInterval.bind(window);
  let interceptedNativeTimer = false;
  if (!window.__felpfitNativeBridgeInstalled) {
    window.setInterval = function (fn, delay, ...args) {
      const source = typeof fn === 'function' ? Function.prototype.toString.call(fn) : String(fn || '');
      if (!interceptedNativeTimer && Number(delay) === 60000 && source.includes('sync(false)')) {
        interceptedNativeTimer = true;
        window.setInterval = originalSetInterval;
        return 0;
      }
      return originalSetInterval(fn, delay, ...args);
    };
  }

  const DAY_NAMES = { 1: 'Domingo', 2: 'Segunda', 3: 'Terça', 4: 'Quarta', 5: 'Quinta', 6: 'Sexta', 7: 'Sábado' };
  const DAY_ORDER = [2, 3, 4, 5, 6, 7, 1];
  const DAY_ICONS = { 1: '🌊', 2: '🫀', 3: '💪', 4: '🦵', 5: '🪽', 6: '⚡', 7: '🏃' };
  const ICONS = {
    wake: '⏰', creatine: '💊', school_exit: '🏫', lunch: '🍽️', pre_gym: '🏋️',
    post_gym: '✅', cardio: '🏃', day_status: '⚡', daily_close: '🌙', walk_plan: '🌊',
    walk_done: '✅', energy: '⚡', pre_cardio: '⚡', cardio1: '🏃', cardio2: '🏃',
    food: '🍽️', recovery: '🛌'
  };
  const LABELS = {
    wake: 'Acordar', creatine: 'Creatina', school_exit: 'Saída da escola', lunch: 'Almoço',
    pre_gym: 'Pré-treino', post_gym: 'Treino concluído', cardio: 'Cardio', day_status: 'Check-in do dia',
    daily_close: 'Fechar o dia', walk_plan: 'Plano de atividade', walk_done: 'Atividade concluída',
    energy: 'Energia', pre_cardio: 'Energia pré-cardio', cardio1: 'Cardio • bloco 1',
    cardio2: 'Cardio • bloco 2', food: 'Alimentação pós-cardio', recovery: 'Recuperação'
  };
  const ALARM_ACTION = {
    wake: 'levanta e abre o FelpFit',
    creatine: 'confira e registre sua rotina',
    school_exit: 'abra o FelpFit e confirme sua saída',
    lunch: 'registre como ficou seu almoço',
    pre_gym: 'confirme se o treino vai rolar',
    post_gym: 'registre como terminou o treino',
    cardio: 'registre o cardio de hoje',
    day_status: 'confira sua energia e recuperação',
    daily_close: 'abra o FelpFit e finalize o dia',
    walk_plan: 'confira água, energia e o plano de hoje',
    walk_done: 'registre como foi sua atividade',
    energy: 'confira como está sua energia',
    pre_cardio: 'confira sua energia antes do cardio',
    cardio1: 'registre o primeiro bloco de cardio',
    cardio2: 'registre o segundo bloco de cardio',
    food: 'registre sua alimentação pós-cardio',
    recovery: 'registre sua recuperação'
  };

  let nativeState = {
    masterEnabled: true,
    notificationStatus: 'notDetermined',
    alarmStatus: 'notDetermined',
    preferences: {},
    scheduledAlarmCount: 0,
    scheduledNotificationCount: 0,
    fallbackCount: 0
  };
  let currentItems = [];
  let installed = false;
  let lastScheduleSignature = "";
  let initialRemoteSyncPending = true;
  let initialRemoteSyncStarted = false;
  let testGuardUntil = 0;
  const pendingPreferences = new Map();

  function postNative(payload) {
    try { window.webkit?.messageHandlers?.felpfitNative?.postMessage(payload); }
    catch (error) { console.warn('FelpFit alerts v2:', error); }
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[ch]));
  }

  function hashString(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function dateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function parseClock(clock) {
    const match = String(clock || '').match(/^(\d{2}):(\d{2})$/);
    if (!match) return null;
    return { hour: Number(match[1]), minute: Number(match[2]) };
  }

  function labelFor(question) {
    if (String(question.id || '').startsWith('water_')) return 'Hidratação';
    return LABELS[question.id] || String(question.text || 'Lembrete').slice(0, 32);
  }

  function iconFor(question) {
    if (String(question.id || '').startsWith('water_')) return '💧';
    return ICONS[question.id] || '🔔';
  }

  function actionFor(question) {
    if (String(question.id || '').startsWith('water_')) return 'registre seu bloco de água no FelpFit';
    return ALARM_ACTION[question.id] || 'abra o FelpFit e confira esta missão';
  }

  function alarmTitle(question) {
    const label = labelFor(question);
    const action = actionFor(question);
    return `${iconFor(question)} ${label} — ${action}`.slice(0, 92);
  }

  function notificationBody(question) {
    return [question.text, question.context, 'Abra o FelpFit para responder.'].filter(Boolean).join(' • ').slice(0, 260);
  }

  function localDateFromKeyAndTime(key, time) {
    const [y, m, d] = String(key).split('-').map(Number);
    const clock = parseClock(time);
    if (!y || !m || !d || !clock) return null;
    return new Date(y, m - 1, d, clock.hour, clock.minute, 0, 0);
  }

  function getQuestionsForCalendarWeekday(calendarWeekday) {
    if (typeof window.getScheduledQuestionsForDate !== 'function') return [];
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    for (let offset = 0; offset < 14; offset++) {
      const day = new Date(today);
      day.setDate(today.getDate() + offset);
      if (day.getDay() + 1 !== calendarWeekday) continue;
      try { return window.getScheduledQuestionsForDate(day) || []; } catch { return []; }
    }
    return [];
  }

  function collectWeeklyItems() {
    const result = [];
    for (const weekday of DAY_ORDER) {
      const questions = getQuestionsForCalendarWeekday(weekday);
      for (const q of questions) {
        const clock = parseClock(q.time);
        if (!clock) continue;
        const hydration = String(q.id || '').startsWith('water_');
        const id = String(q.id || 'mission');
        const source = [weekday, id, q.time, q.text || '', q.context || ''].join('|');
        const key = `remote:v2:${hydration ? 'hydration' : 'mission'}:${weekday}:${id}:${q.time}:${hashString(source)}`;
        result.push({
          key,
          preferenceKey: key,
          kind: 'weekly',
          title: alarmTitle(q),
          body: notificationBody(q),
          hour: clock.hour,
          minute: clock.minute,
          weekdays: [weekday],
          questionID: id,
          dateKey: '',
          calendarDate: '',
          category: hydration ? 'hydration' : 'mission',
          remoteDay: weekday,
          displayTitle: `${iconFor(q)} ${labelFor(q)}`,
          sourceText: String(q.text || ''),
          contextText: String(q.context || ''),
          time: String(q.time || '')
        });
      }
    }
    return result;
  }

  function collectHoldItems(baseItems) {
    if (typeof window.getTodayScheduledEntry !== 'function' || typeof window.getTodayScheduledQuestions !== 'function') return [];
    let entry = {}, questions = [];
    try {
      entry = window.getTodayScheduledEntry() || {};
      questions = window.getTodayScheduledQuestions() || [];
    } catch { return []; }

    const today = new Date();
    const weekday = today.getDay() + 1;
    const todayKey = dateKey(today);
    const byId = new Map(questions.map(q => [String(q.id || ''), q]));
    const now = Date.now();
    const result = [];

    const add = (bucket, prefix) => {
      if (!bucket || typeof bucket !== 'object') return;
      Object.entries(bucket).forEach(([id, hold]) => {
        const q = byId.get(String(id));
        if (!q || !hold?.expiresAt) return;
        const expires = new Date(hold.expiresAt).getTime();
        if (!Number.isFinite(expires) || expires <= now) return;
        const step = Math.max(1, Number(hold.reminderMinutes || 5)) * 60000;
        let next = new Date(hold.nextPromptAt || now + step).getTime();
        if (!Number.isFinite(next)) next = now + step;
        next = Math.max(next, now + 3000);
        const parent = baseItems.find(item => item.remoteDay === weekday && item.questionID === String(id));
        const preferenceKey = parent?.preferenceKey || `remote:v2:mission:${weekday}:${id}`;
        let count = 0;
        for (let fire = next; fire <= expires && count < 24; fire += step, count++) {
          const d = new Date(fire);
          result.push({
            key: `remote:v2:hold:${todayKey}:${id}:${Math.round(fire)}`,
            preferenceKey,
            kind: 'fixed',
            title: `${iconFor(q)} ${labelFor(q)} — ${prefix}`.slice(0, 92),
            body: notificationBody(q),
            hour: d.getHours(), minute: d.getMinutes(), weekdays: [], fireAtMs: fire,
            questionID: String(id), dateKey: todayKey, calendarDate: '', category: 'mission', hiddenUI: true,
            remoteDay: weekday, displayTitle: `${iconFor(q)} ${labelFor(q)}`, sourceText: String(q.text || ''), time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
          });
        }
      });
    };

    add(entry.deferred, 'missão adiada — volte ao FelpFit');
    add(entry.inProgress, 'confira a missão em andamento');
    return result;
  }

  function collectCalendarItems() {
    if (typeof window.getCalendarCustomState !== 'function') return [];
    let custom = {};
    try { custom = window.getCalendarCustomState() || {}; } catch { return []; }
    const now = Date.now();
    const max = now + 180 * 24 * 60 * 60 * 1000;
    const result = [];

    Object.entries(custom).sort(([a], [b]) => a.localeCompare(b)).forEach(([key, cfg]) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !cfg || typeof cfg !== 'object') return;

      const eventMinutes = Number(cfg.eventReminderMinutes || 0);
      if (cfg.startTime && eventMinutes > 0) {
        const start = localDateFromKeyAndTime(key, cfg.startTime);
        const fire = start ? start.getTime() - eventMinutes * 60000 : 0;
        if (fire > now + 3000 && fire < max) {
          const title = String(cfg.title || 'Evento do calendário');
          result.push({
            key: `remote:v2:calendar:event:${key}:${hashString(title + '|' + cfg.startTime)}`,
            kind: 'fixed', title: `📅 ${title} — confira o FelpFit`.slice(0, 92),
            body: `Seu evento começa às ${cfg.startTime}. Aviso configurado para ${eventMinutes} min antes.`,
            hour: new Date(fire).getHours(), minute: new Date(fire).getMinutes(), weekdays: [], fireAtMs: fire,
            questionID: '', dateKey: key, calendarDate: key, category: 'calendar',
            displayTitle: `📅 ${title}`, sourceText: title, time: cfg.startTime
          });
        }
      }

      const routine = Array.isArray(cfg.routineItems) ? cfg.routineItems : [];
      routine.forEach((entry, index) => {
        const reminder = Number(entry?.reminderMinutes || 0);
        if (!entry?.time || !entry?.action || reminder <= 0) return;
        const start = localDateFromKeyAndTime(key, entry.time);
        const fire = start ? start.getTime() - reminder * 60000 : 0;
        if (fire <= now + 3000 || fire >= max) return;
        const action = String(entry.action);
        result.push({
          key: `remote:v2:calendar:routine:${key}:${String(entry.id || index)}:${hashString(action + '|' + entry.time)}`,
          kind: 'fixed', title: `📌 ${action}`.slice(0, 92),
          body: `Bloco marcado para ${entry.time}. Abra o FelpFit para conferir.`,
          hour: new Date(fire).getHours(), minute: new Date(fire).getMinutes(), weekdays: [], fireAtMs: fire,
          questionID: '', dateKey: key, calendarDate: key, category: 'calendar',
          displayTitle: `📌 ${action}`, sourceText: action, time: entry.time
        });
      });
    });
    return result;
  }

  function collectSchedule() {
    const base = collectWeeklyItems();
    return [...base, ...collectHoldItems(base), ...collectCalendarItems()];
  }

  function scheduleSignature(items) {
    return JSON.stringify(items.map(item => [
      item.key, item.preferenceKey || '', item.kind, item.hour, item.minute,
      item.weekdays || [], Number(item.fireAtMs || 0), item.category || ''
    ]));
  }

  function syncRemote(force = true) {
    if (Date.now() < testGuardUntil) {
      postNative({ command: 'getState' });
      return false;
    }

    const next = collectSchedule();
    const signature = scheduleSignature(next);
    currentItems = next;

    if (!force && signature === lastScheduleSignature) {
      postNative({ command: 'getState' });
      return false;
    }

    lastScheduleSignature = signature;
    postNative({ command: 'sync', items: currentItems, force: Boolean(force) });
    return true;
  }

  function preferenceFor(item) {
    const key = item.preferenceKey || item.key;
    return pendingPreferences.get(key)
      || nativeState.preferences?.[key]
      || { enabled: true, urgent: true };
  }

  function optimisticPreference(key, patch) {
    const current = preferenceFor({ key, preferenceKey: key });
    const next = { ...current, ...patch };
    pendingPreferences.set(key, next);
    nativeState = {
      ...nativeState,
      preferences: { ...(nativeState.preferences || {}), [key]: next }
    };
    render();
    return next;
  }

  function statusText(value, type) {
    if (['authorized', 'provisional', 'ephemeral'].includes(value)) return type === 'alarm' ? 'Alarmes autorizados' : 'Notificações autorizadas';
    if (value === 'denied') return type === 'alarm' ? 'Alarmes bloqueados' : 'Notificações bloqueadas';
    if (value === 'unsupported') return 'AlarmKit indisponível';
    return type === 'alarm' ? 'Aguardando permissão de alarmes' : 'Aguardando permissão de notificações';
  }

  function statusClass(value) {
    if (['authorized', 'provisional', 'ephemeral'].includes(value)) return 'ok';
    if (['denied', 'unsupported'].includes(value)) return 'bad';
    return 'wait';
  }

  function ensureStyles() {
    if (document.getElementById('felpfit-alerts-v2-style')) return;
    const style = document.createElement('style');
    style.id = 'felpfit-alerts-v2-style';
    style.textContent = `
      #notificationModal .modal.ff2-modal{width:min(100%,570px);max-height:min(91dvh,900px);overflow:auto;padding:0;background:linear-gradient(180deg,color-mix(in srgb,var(--panel) 97%,#8b5cf6 3%),var(--panel));}
      .ff2-head{position:sticky;top:0;z-index:4;padding:18px 18px 14px;border-bottom:1px solid var(--line);background:linear-gradient(180deg,var(--panel) 82%,color-mix(in srgb,var(--panel) 90%,transparent));backdrop-filter:blur(18px)}
      .ff2-head-row{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.ff2-head h2{margin:5px 0 5px;font-size:25px}.ff2-head p{margin:0;color:var(--muted);font-size:11px;line-height:1.5}.ff2-close{width:38px;height:38px;flex:none;border:1px solid var(--line);border-radius:13px;background:var(--panel3);color:var(--text);font-size:18px;font-weight:900}
      .ff2-status{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px}.ff2-chip{padding:7px 9px;border:1px solid var(--line);border-radius:999px;font-size:10px;font-weight:900}.ff2-chip.ok{color:#9bf6c9;border-color:rgba(66,211,146,.35);background:rgba(66,211,146,.08)}.ff2-chip.bad{color:#ffabb4;border-color:rgba(255,90,110,.35);background:rgba(255,90,110,.08)}.ff2-chip.wait{color:#ffe49c;border-color:rgba(245,190,70,.35);background:rgba(245,190,70,.08)}
      .ff2-body{display:grid;gap:12px;padding:13px 13px 22px}.ff2-card{padding:14px;border:1px solid var(--line);border-radius:18px;background:var(--panel2)}.ff2-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.ff2-card-head b{font-size:13px}.ff2-card p{margin:5px 0 0;color:var(--muted);font-size:10px;line-height:1.5}
      .ff2-btn{margin-top:10px;width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:13px;background:var(--panel3);color:var(--text);font-size:11px;font-weight:900}.ff2-btn.primary{border-color:transparent;background:linear-gradient(135deg,var(--accent),#5d3fc4);color:#fff}
      .ff2-master{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:15px;border:1px solid color-mix(in srgb,var(--accent) 32%,var(--line));border-radius:18px;background:radial-gradient(circle at 100% 0%,rgba(139,92,246,.17),transparent 42%),var(--panel3)}.ff2-master b{display:block;font-size:13px}.ff2-master small{display:block;margin-top:4px;color:var(--muted);font-size:10px;line-height:1.4}
      .ff2-section{border:1px solid var(--line);border-radius:18px;background:var(--panel2);overflow:hidden}.ff2-section>summary,.ff2-day>summary{cursor:pointer;list-style:none;display:flex;align-items:center;justify-content:space-between;gap:12px}.ff2-section>summary::-webkit-details-marker,.ff2-day>summary::-webkit-details-marker{display:none}.ff2-section>summary{padding:14px}.ff2-section>summary span,.ff2-day>summary span{display:grid;gap:3px}.ff2-section>summary b{font-size:13px}.ff2-section>summary small,.ff2-day>summary small{color:var(--muted);font-size:9px}.ff2-count{font-style:normal;padding:5px 7px;border:1px solid var(--line);border-radius:999px;color:var(--accent2);font-size:9px;font-weight:900}
      .ff2-days{display:grid;border-top:1px solid var(--line)}.ff2-day{border-bottom:1px solid rgba(255,255,255,.055)}.ff2-day:last-child{border-bottom:0}.ff2-day>summary{padding:12px 13px;background:color-mix(in srgb,var(--panel3) 65%,transparent)}.ff2-day>summary b{font-size:11px}.ff2-list{display:grid;border-top:1px solid rgba(255,255,255,.05)}
      .ff2-row{display:grid;gap:9px;padding:12px 13px;border-bottom:1px solid rgba(255,255,255,.05);transition:.18s ease}.ff2-row:last-child{border-bottom:0}.ff2-row.off{opacity:.52}.ff2-row-top{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.ff2-copy{min-width:0;display:grid;gap:3px}.ff2-copy b{font-size:11px;line-height:1.35}.ff2-copy span{font-size:10px;color:var(--accent2);font-weight:900}.ff2-copy small{font-size:9px;color:var(--muted);line-height:1.4}.ff2-actions{display:grid;grid-template-columns:1fr 1fr;gap:7px}.ff2-toggle,.ff2-urgent{min-height:35px;padding:8px 10px;border:1px solid var(--line);border-radius:12px;background:var(--panel3);color:var(--text);font-size:9px;font-weight:900}.ff2-toggle.on{color:#9bf6c9;border-color:rgba(66,211,146,.38);background:rgba(66,211,146,.08)}.ff2-urgent.on{color:#ffb3a8;border-color:rgba(255,90,70,.4);background:rgba(255,90,70,.08)}.ff2-urgent.normal{color:#b8c7ff;border-color:rgba(120,145,255,.35);background:rgba(120,145,255,.07)}.ff2-urgent:disabled{opacity:.35}.ff2-help{padding:11px 12px;border:1px solid var(--line);border-radius:15px;background:var(--panel3);color:var(--muted);font-size:10px;line-height:1.55}.ff2-help strong{color:var(--text)}
      .ff2-empty{padding:13px;color:var(--muted);font-size:10px}.ff2-stats{text-align:center;color:var(--muted);font-size:9px}.ff2-stats strong{color:var(--text)}
      @media(max-width:520px){#notificationModal .modal.ff2-modal{max-height:94dvh}.ff2-head{padding:15px 14px 12px}.ff2-body{padding:11px}.ff2-actions{grid-template-columns:1fr}.ff2-row-top{display:grid}.ff2-actions{grid-template-columns:1fr 1fr}}
    `;
    document.head.appendChild(style);
  }

  function itemRow(item) {
    const pref = preferenceFor(item);
    const enabled = pref.enabled !== false;
    const urgent = pref.urgent !== false;
    return `<div class="ff2-row ${enabled ? '' : 'off'}">
      <div class="ff2-row-top">
        <div class="ff2-copy"><b>${escapeHtml(item.displayTitle || item.title)}</b><span>${escapeHtml(item.time)}</span><small>${escapeHtml(item.sourceText || item.body || '')}</small></div>
      </div>
      <div class="ff2-actions">
        <button type="button" class="ff2-toggle ${enabled ? 'on' : ''}" data-ff2-action="enabled" data-ff2-key="${escapeHtml(item.preferenceKey || item.key)}">${enabled ? '✓ Alarme ativo' : '○ Alarme desativado'}</button>
        <button type="button" class="ff2-urgent ${enabled && urgent ? 'on' : 'normal'}" data-ff2-action="urgent" data-ff2-key="${escapeHtml(item.preferenceKey || item.key)}" ${enabled ? '' : 'disabled'}>${urgent ? '🚨 Modo urgente' : '🔔 Notificação normal'}</button>
      </div>
    </div>`;
  }

  function dayGroupHtml(weekday, category) {
    const rows = currentItems.filter(item => !item.hiddenUI && item.category === category && item.remoteDay === weekday);
    return `<details class="ff2-day" data-ff2-detail="day:${category}:${weekday}" ${weekday === new Date().getDay() + 1 ? 'open' : ''}>
      <summary><span><b>${DAY_ICONS[weekday] || '📆'} ${DAY_NAMES[weekday]}</b><small>${rows.length ? `${rows.length} alerta(s)` : 'sem alertas'}</small></span><em class="ff2-count">${rows.length}</em></summary>
      ${rows.length ? `<div class="ff2-list">${rows.map(itemRow).join('')}</div>` : '<div class="ff2-empty">Nenhum alerta deste tipo neste dia.</div>'}
    </details>`;
  }

  function weekSection(title, subtitle, category, open) {
    const count = currentItems.filter(item => !item.hiddenUI && item.category === category).length;
    return `<details class="ff2-section" data-ff2-detail="section:${category}" ${open ? 'open' : ''}>
      <summary><span><b>${title}</b><small>${subtitle}</small></span><em class="ff2-count">${count}</em></summary>
      <div class="ff2-days">${DAY_ORDER.map(day => dayGroupHtml(day, category)).join('')}</div>
    </details>`;
  }

  function calendarSection() {
    const rows = currentItems.filter(item => !item.hiddenUI && item.category === 'calendar');
    return `<details class="ff2-section" data-ff2-detail="section:calendar">
      <summary><span><b>📅 Calendário</b><small>Somente lembretes que você ativou manualmente.</small></span><em class="ff2-count">${rows.length}</em></summary>
      ${rows.length ? `<div class="ff2-list">${rows.map(itemRow).join('')}</div>` : '<div class="ff2-empty">Nenhum lembrete do calendário agendado agora.</div>'}
    </details>`;
  }

  function render() {
    const overlay = document.getElementById('notificationModal');
    if (!overlay) return;
    const modal = overlay.querySelector('.modal');
    if (!modal) return;
    ensureStyles();

    // Renderizar o estado otimista não pode fechar a categoria que o usuário
    // está usando. Guarda os details abertos e a posição antes de redesenhar.
    const hadRenderedCenter = Boolean(modal.querySelector('[data-ff2-detail]'));
    const openDetails = new Set(
      [...modal.querySelectorAll('details[data-ff2-detail][open]')]
        .map(node => node.dataset.ff2Detail)
        .filter(Boolean)
    );
    const previousScrollTop = modal.scrollTop;

    modal.className = `${modal.className.replace(/\bff-native-modal\b/g, '').trim()} ff2-modal`;

    modal.innerHTML = `<div class="ff2-head">
      <div class="ff2-head-row"><div><div class="eyebrow">CENTRAL DE ALERTAS</div><h2>Organizado do seu jeito.</h2><p>Cada dia tem sua própria categoria. Cada missão pode ser desligada ou alternada entre alarme urgente e notificação normal.</p></div><button class="ff2-close" type="button" data-ff2-close>✕</button></div>
      <div class="ff2-status"><span class="ff2-chip ${statusClass(nativeState.alarmStatus)}">🚨 ${escapeHtml(statusText(nativeState.alarmStatus, 'alarm'))}</span><span class="ff2-chip ${statusClass(nativeState.notificationStatus)}">🔔 ${escapeHtml(statusText(nativeState.notificationStatus, 'notification'))}</span></div>
    </div>
    <div class="ff2-body">
      <div class="ff2-master"><div><b>Alertas do FelpFit neste iPhone</b><small>Desliga ou liga todos os alarmes sem mexer nas preferências individuais.</small></div><button type="button" class="ff2-toggle ${nativeState.masterEnabled !== false ? 'on' : ''}" data-ff2-master>${nativeState.masterEnabled !== false ? '✓ ATIVOS' : '○ PAUSADOS'}</button></div>

      <div class="ff2-card"><div class="ff2-card-head"><b>🔐 Permissões do iPhone</b><span>iOS</span></div><p>Gerencia a autorização para o AlarmKit e para notificações normais.</p><button type="button" class="ff2-btn primary" data-ff2-permissions>Solicitar / atualizar permissões</button></div>
      <div class="ff2-card"><div class="ff2-card-head"><b>🧪 Teste do alarme</b><span>30 s</span></div><p>Agenda um teste urgente para confirmar que o iPhone realmente toca com o app fechado.</p><button type="button" class="ff2-btn" data-ff2-test ${initialRemoteSyncPending ? 'disabled' : ''}>${initialRemoteSyncPending ? 'Preparando agenda nativa…' : Date.now() < testGuardUntil ? 'Teste agendado — aguarde tocar' : 'Testar alarme urgente em 30 segundos'}</button></div>
      <div class="ff2-card"><div class="ff2-card-head"><b>🚀 Atualizações do FelpFit</b><span>Cloudflare</span></div><p>Verifica se existe uma interface nova no site e recarrega sem trocar a IPA.</p><button type="button" class="ff2-btn" data-ff2-update>Buscar atualização agora</button></div>

      <div class="ff2-help"><strong>🚨 Modo urgente</strong> usa AlarmKit e é o modo para alarmes que precisam chamar sua atenção. <strong>🔔 Notificação normal</strong> usa um aviso comum do iOS. O botão <strong>Alarme ativo/desativado</strong> controla somente aquela missão e aquele dia.</div>
      ${weekSection('🎯 Missões da semana', 'Segunda, terça, quarta… tudo separado para não virar bagunça.', 'mission', true)}
      ${weekSection('💧 Hidratação', 'Os blocos de água também ficam separados por dia.', 'hydration', false)}
      ${calendarSection()}
      <div class="ff2-stats">Agendados agora: <strong>${Number(nativeState.scheduledAlarmCount || 0)} urgentes</strong> • <strong>${Number(nativeState.scheduledNotificationCount || 0)} normais</strong>${Number(nativeState.fallbackCount || 0) ? ` • <strong>${Number(nativeState.fallbackCount)} fallback</strong>` : ''}</div>
    </div>`;

    if (hadRenderedCenter) {
      modal.querySelectorAll('details[data-ff2-detail]').forEach(node => {
        node.open = openDetails.has(node.dataset.ff2Detail);
      });
      modal.scrollTop = previousScrollTop;
    }

    modal.querySelector('[data-ff2-close]')?.addEventListener('click', () => overlay.classList.add('hidden'));
    modal.querySelector('[data-ff2-master]')?.addEventListener('click', () => {
      if (Date.now() < testGuardUntil) return;
      const enabled = !(nativeState.masterEnabled !== false);
      nativeState = { ...nativeState, masterEnabled: enabled };
      render();
      postNative({ command: 'toggleMaster', enabled });
    });
    modal.querySelector('[data-ff2-permissions]')?.addEventListener('click', () => postNative({ command: 'requestPermissions' }));
    modal.querySelector('[data-ff2-test]')?.addEventListener('click', () => {
      if (initialRemoteSyncPending || Date.now() < testGuardUntil) return;
      testGuardUntil = Date.now() + 40000;
      render();
      postNative({ command: 'testAlert' });
      setTimeout(() => render(), 40500);
    });
    modal.querySelector('[data-ff2-update]')?.addEventListener('click', () => postNative({ command: 'checkWebUpdate' }));
    modal.querySelectorAll('[data-ff2-action][data-ff2-key]').forEach(button => {
      button.addEventListener('click', () => {
        if (Date.now() < testGuardUntil) return;
        const key = button.dataset.ff2Key;
        const pref = preferenceFor({ key, preferenceKey: key });
        if (button.dataset.ff2Action === 'enabled') {
          const enabled = !(pref.enabled !== false);
          optimisticPreference(key, { enabled });
          postNative({ command: 'toggleEnabled', key, enabled });
        } else {
          const urgent = !(pref.urgent !== false);
          optimisticPreference(key, { urgent });
          postNative({ command: 'toggleUrgent', key, urgent });
        }
      });
    });
  }

  function installAfterNativeBridge() {
    if (installed) return;
    if (!window.__felpfitNativeBridgeInstalled || !window.webkit?.messageHandlers?.felpfitNative) {
      return setTimeout(installAfterNativeBridge, 25);
    }
    installed = true;

    const originalReceive = window.__felpfitNativeReceive;
    window.__felpfitNativeReceive = payload => {
      try { originalReceive?.(payload); } catch {}

      if (payload && typeof payload === 'object') {
        nativeState = { ...nativeState, ...payload };

        if (payload.type === 'state') {
          initialRemoteSyncPending = false;

          for (const [key, wanted] of pendingPreferences.entries()) {
            const confirmed = payload.preferences?.[key];
            if (confirmed
                && confirmed.enabled === wanted.enabled
                && confirmed.urgent === wanted.urgent) {
              pendingPreferences.delete(key);
            }
          }
        }
      }

      if (!document.getElementById('notificationModal')?.classList.contains('hidden')) render();
    };

    function startInitialRemoteSync() {
      if (initialRemoteSyncStarted) return;
      initialRemoteSyncStarted = true;
      initialRemoteSyncPending = true;
      syncRemote(true);
      postNative({ command: 'getCapabilities' });
    }

    // O build nativo antigo fazia um sync próprio no kick. Aqui o site assume a
    // agenda antes desse sync para não reintroduzir itens antigos nem duplicar trabalho.
    window.__felpfitNativeKick = () => {
      try {
        const version = typeof window.APP_VERSION !== 'undefined'
          ? String(window.APP_VERSION)
          : String(document.documentElement?.dataset?.appVersion || '');
        postNative({ command: 'webVersion', version });
      } catch {}
      startInitialRemoteSync();
    };

    window.openNotificationSettings = () => {
      try { if (typeof window.closeMenu === 'function') window.closeMenu(); } catch {}
      const overlay = document.getElementById('notificationModal');
      if (!overlay) return;
      overlay.classList.remove('hidden');
      render();

      // Abrir a Central agora é leitura, não reagendamento completo.
      postNative({ command: 'getState' });
    };
    window.closeNotificationSettings = () => document.getElementById('notificationModal')?.classList.add('hidden');

    window.__felpfitNativeSync = () => syncRemote(false);

    // Fallback se o didFinish do WKWebView tiver acontecido muito cedo.
    setTimeout(startInitialRemoteSync, 700);
    originalSetInterval(() => syncRemote(false), 5 * 60 * 1000);
  }

  installAfterNativeBridge();
})();
