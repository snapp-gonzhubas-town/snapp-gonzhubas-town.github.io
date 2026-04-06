import {
  buildSupportMeta,
  deleteLocalMessage,
  ensureLocalDemoSession,
  escapeHtml,
  formatClock,
  formatDayLabel,
  getLocalSession,
  getSupportIdentity,
  markLocalSessionRead,
  maybeCreateLocalAutoReply,
  sanitizeText,
  sortMessages,
  appendLocalMessage
} from './support-shared.js';

const config = Object.assign(
  {
    apiBase: '',
    adminUrl: 'support-admin.html',
    widgetTitle: 'Підтримка',
    widgetSubtitle: 'АКК / Ганжубасик Таун',
    siteName: 'Ганжубасик Таун',
    supportName: 'Підтримка АКК',
    pollInterval: 12000,
    maxMessageLength: 1200
  },
  window.GandjSupportConfig || {}
);

const state = {
  identity: getSupportIdentity(),
  session: null,
  messages: [],
  presence: { operator: null, visitor: null },
  mode: config.apiBase ? 'connecting' : 'demo',
  open: false,
  expanded: false,
  pollTimer: 0,
  presenceTimer: 0,
  autoReplyTimer: 0,
  typingTimer: 0,
  lastEffectAt: '',
  seenEffects: new Set(),
  bootstrapped: false,
  busy: false,
  statusNote: 'Відповідаємо прямо тут. На телефоні чат відкривається на весь екран.'
};

const root = document.createElement('div');
root.className = 'support-root';
root.dataset.open = 'false';
root.innerHTML = `
  <div class="support-livefx" id="supportLiveFx" aria-hidden="true"></div>
  <div class="support-backdrop" data-support-action="close"></div>
  <div class="support-dock">
    <div class="support-shell" id="supportShell" aria-hidden="true">
      <section class="support-panel" role="dialog" aria-modal="false" aria-label="${escapeHtml(config.widgetTitle)}">
        <header class="support-header">
          <div class="support-titlebox">
            <div class="support-avatar">П</div>
            <div class="support-heading">
              <strong>${escapeHtml(config.supportName)}</strong>
              <span id="supportPresenceLine">${escapeHtml(config.widgetSubtitle)}</span>
            </div>
          </div>
          <div class="support-toolbar">
            <button type="button" class="support-action" data-support-action="expand" aria-label="Розгорнути">⤢</button>
            <button type="button" class="support-action" data-support-action="close" aria-label="Закрити">✕</button>
          </div>
        </header>
        <div class="support-status">
          <div class="support-status-badges">
            <span class="support-pill" id="supportModeBadge">Демо</span>
            <span class="support-pill support-pill-muted" id="supportVisitorBadge"></span>
          </div>
          <div class="support-status-note" id="supportStatusNote"></div>
        </div>
        <div class="support-messages" id="supportMessages"></div>
        <form class="support-compose" id="supportComposeForm">
          <textarea
            class="support-textarea"
            id="supportTextarea"
            placeholder="Опиши проблему або запит..."
            maxlength="${Number(config.maxMessageLength) || 1200}"
          ></textarea>
          <div class="support-compose-row">
            <div class="support-hint">Оператор бачить цей діалог у окремій Telegram-панелі. Номер відвідувача: ${escapeHtml(state.identity.shortLabel)}</div>
            <button type="submit" class="support-send" id="supportSendButton">Надіслати</button>
          </div>
        </form>
      </section>
    </div>
    <button type="button" class="support-fab" id="supportFab" aria-label="Відкрити підтримку">
      <span class="support-fab-dot"></span>
      <span class="support-fab-label">${escapeHtml(config.widgetTitle)}</span>
    </button>
  </div>
`;
document.body.appendChild(root);

const shell = root.querySelector('#supportShell');
const fab = root.querySelector('#supportFab');
const liveFx = root.querySelector('#supportLiveFx');
const modeBadge = root.querySelector('#supportModeBadge');
const visitorBadge = root.querySelector('#supportVisitorBadge');
const statusNote = root.querySelector('#supportStatusNote');
const presenceLine = root.querySelector('#supportPresenceLine');
const messagesNode = root.querySelector('#supportMessages');
const composeForm = root.querySelector('#supportComposeForm');
const textarea = root.querySelector('#supportTextarea');
const sendButton = root.querySelector('#supportSendButton');

function isMobileLayout() {
  return window.matchMedia('(max-width: 720px)').matches;
}

function updateTextareaHeight() {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 156)}px`;
}

function scrollMessagesToBottom() {
  requestAnimationFrame(() => {
    messagesNode.scrollTop = messagesNode.scrollHeight;
  });
}

function updateStatus() {
  const labels = {
    connecting: 'Підключення',
    remote: 'Онлайн API',
    demo: 'Локальний демо',
    degraded: 'Локальний fallback'
  };
  modeBadge.textContent = labels[state.mode] || 'Підтримка';
  visitorBadge.textContent = state.identity.shortLabel;
  statusNote.textContent = state.statusNote;
  if (presenceLine) {
    presenceLine.textContent = formatOperatorPresence();
  }
}

function minutesAgo(value) {
  if (!value) return null;
  const diffMs = Date.now() - new Date(value).getTime();
  if (Number.isNaN(diffMs) || diffMs < 0) return 0;
  return Math.round(diffMs / 60000);
}

function formatOperatorPresence() {
  const operator = state.presence && state.presence.operator;
  if (!operator) return config.widgetSubtitle;
  if (operator.lastTypingAt && Date.now() - new Date(operator.lastTypingAt).getTime() < 6500) {
    return 'Печатает...';
  }
  const minutes = minutesAgo(operator.lastSeenAt);
  if (minutes === null) return 'Не в мережі';
  if (minutes <= 1) return 'В мережі';
  if (minutes < 60) return `В мережі ${minutes} хв тому`;
  const hours = Math.round(minutes / 60);
  return `Був у мережі ${hours} год тому`;
}

function canDeleteVisitorMessage(message) {
  return Boolean(message)
    && message.role === 'visitor'
    && message.source !== 'system'
    && !message.deletedAt;
}

function markLatestEffect(effect) {
  if (!effect || !effect.createdAt) return;
  if (!state.lastEffectAt || new Date(effect.createdAt).getTime() > new Date(state.lastEffectAt).getTime()) {
    state.lastEffectAt = effect.createdAt;
  }
}

function effectCardHtml(effect) {
  const title = escapeHtml(effect.title || 'Показ почався');
  const message = escapeHtml(effect.message || 'На екрані зараз буде прикол.');
  return `
    <div class="support-livefx-card">
      <strong>${title}</strong>
      <span>${message}</span>
    </div>
  `;
}

function spawnFloatingPieces(className, glyphs) {
  const layer = document.createElement('div');
  layer.className = `support-livefx-layer ${className}`;
  for (let index = 0; index < 28; index += 1) {
    const piece = document.createElement('span');
    piece.textContent = glyphs[index % glyphs.length];
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.animationDelay = `${Math.random() * 1.2}s`;
    piece.style.animationDuration = `${5 + Math.random() * 4}s`;
    piece.style.fontSize = `${18 + Math.random() * 20}px`;
    layer.appendChild(piece);
  }
  liveFx.appendChild(layer);
  window.setTimeout(() => layer.remove(), 9000);
}

function spawnSpotlight(effect) {
  const layer = document.createElement('div');
  layer.className = 'support-livefx-layer support-livefx-layer-spotlight';
  layer.innerHTML = effectCardHtml(effect);
  liveFx.appendChild(layer);
  window.setTimeout(() => layer.remove(), 9000);
}

function spawnAlarm(effect) {
  const layer = document.createElement('div');
  layer.className = 'support-livefx-layer support-livefx-layer-alarm';
  layer.innerHTML = effectCardHtml(effect);
  liveFx.appendChild(layer);
  if (navigator.vibrate) {
    navigator.vibrate([90, 80, 90]);
  }
  window.setTimeout(() => layer.remove(), 7000);
}

function spawnMatrix(effect) {
  const layer = document.createElement('div');
  layer.className = 'support-livefx-layer support-livefx-layer-matrix';
  const phrases = ['ЖМИ-ЖМИ-ЖМИ', 'ГАНЖУБАС', 'СЮДИ ДИВИСЬ', 'ПОКАЗ ЙДЕ', effect.title || 'МАТРИЦЯ'];
  layer.innerHTML = `
    <div class="support-livefx-matrix-grid">
      ${phrases.map(item => `<span>${escapeHtml(item)}</span>`).join('')}
    </div>
    ${effectCardHtml(effect)}
  `;
  liveFx.appendChild(layer);
  window.setTimeout(() => layer.remove(), 9000);
}

function spawnToast(effect) {
  const layer = document.createElement('div');
  layer.className = 'support-livefx-layer support-livefx-layer-toast';
  layer.innerHTML = effectCardHtml(effect);
  liveFx.appendChild(layer);
  window.setTimeout(() => layer.remove(), 6000);
}

function playEffect(effect) {
  if (!effect || !effect.effectId || state.seenEffects.has(effect.effectId)) return;
  state.seenEffects.add(effect.effectId);
  markLatestEffect(effect);
  switch (effect.effectType) {
    case 'burst':
      spawnToast(effect);
      spawnFloatingPieces('support-livefx-layer-burst', ['✦', '✷', '❋', '✺', '🍃', '⚡']);
      break;
    case 'alarm':
      spawnAlarm(effect);
      break;
    case 'matrix':
      spawnMatrix(effect);
      break;
    case 'spotlight':
      spawnSpotlight(effect);
      break;
    default:
      spawnToast(effect);
      break;
  }
}

function processEffects(effects = []) {
  effects.forEach(effect => {
    playEffect(effect);
    markLatestEffect(effect);
  });
}

function bubbleHtml(message) {
  const roleClass = message.role === 'support' ? 'support' : message.role === 'system' ? 'system' : 'visitor';
  const text = escapeHtml(message.text).replace(/\n/g, '<br>');
  const deletedClass = message.deletedAt ? ' support-bubble-deleted' : '';
  const deleteButton = canDeleteVisitorMessage(message)
    ? `<button type="button" class="support-message-delete" data-message-delete="${escapeHtml(message.messageId)}">Удалить</button>`
    : '';
  return `
    <div class="support-row ${roleClass}">
      <article class="support-bubble${deletedClass}">
        <div class="support-bubble-author">${escapeHtml(message.authorLabel)}</div>
        <div class="support-bubble-text">${text}</div>
        <div class="support-bubble-actions">
          <div class="support-bubble-meta">${escapeHtml(formatClock(message.createdAt))}</div>
          ${deleteButton}
        </div>
      </article>
    </div>
  `;
}

function renderMessages() {
  if (!state.messages.length) {
    messagesNode.innerHTML = '<div class="support-empty">Ти вже в онлайн-списку для оператора. Якщо треба, напиши сюди або просто чекай відповіді прямо в цьому чаті.</div>';
    return;
  }

  let previousDay = '';
  messagesNode.innerHTML = state.messages
    .map(message => {
      const currentDay = new Date(message.createdAt).toDateString();
      const dayDivider = currentDay === previousDay
        ? ''
        : `<div class="support-day">${escapeHtml(formatDayLabel(message.createdAt))}</div>`;
      previousDay = currentDay;
      return `${dayDivider}${bubbleHtml(message)}`;
    })
    .join('');

  if (state.presence && state.presence.operator && state.presence.operator.lastTypingAt) {
    const typingMs = Date.now() - new Date(state.presence.operator.lastTypingAt).getTime();
    if (typingMs >= 0 && typingMs < 6500) {
      messagesNode.insertAdjacentHTML(
        'beforeend',
        `
          <div class="support-row support support-row-typing">
            <article class="support-bubble support-bubble-typing">
              <div class="support-bubble-author">${escapeHtml(config.supportName)}</div>
              <div class="support-typing-dots" aria-label="Печатает">
                <span></span><span></span><span></span>
              </div>
            </article>
          </div>
        `
      );
    }
  }
  scrollMessagesToBottom();
}

function syncExpandedState() {
  if (isMobileLayout()) {
    state.expanded = true;
    shell.classList.remove('expanded');
    return;
  }
  shell.classList.toggle('expanded', state.expanded);
}

function setOpen(nextOpen) {
  state.open = nextOpen;
  root.dataset.open = String(nextOpen);
  shell.classList.toggle('open', nextOpen);
  shell.setAttribute('aria-hidden', nextOpen ? 'false' : 'true');
  document.body.classList.toggle('support-chat-open', nextOpen);

  if (nextOpen) {
    syncExpandedState();
    bootstrapWidget();
    startPolling();
    requestAnimationFrame(() => textarea.focus({ preventScroll: true }));
  } else {
    stopPolling();
  }
}

function toggleExpanded() {
  if (isMobileLayout()) return;
  state.expanded = !state.expanded;
  syncExpandedState();
}

async function apiRequest(path, options = {}) {
  if (!config.apiBase) {
    throw new Error('API is not configured');
  }

  const url = new URL(path, config.apiBase);
  const init = {
    method: options.method || 'GET',
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: 'omit'
  };

  const response = await fetch(url.toString(), init);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

async function sendPresence(typing) {
  if (!config.apiBase) return;
  await ensureSession();
  if (!state.session) return;
  try {
    const payload = await apiRequest(`/api/support/session/${encodeURIComponent(state.session.sessionId)}/presence`, {
      method: 'POST',
      body: {
        typing,
        lastEffectAt: state.lastEffectAt || ''
      }
    });
    state.presence = payload.presence || state.presence;
    processEffects(payload.effects || []);
    updateStatus();
  } catch (error) {
    // Ignore transient presence failures.
  }
}

async function ensureSession() {
  if (state.session) return state.session;

  if (config.apiBase) {
    try {
      const payload = await apiRequest('/api/support/session', {
        method: 'POST',
        body: {
          identity: state.identity,
          meta: buildSupportMeta()
        }
      });
      state.mode = 'remote';
      state.session = payload.session || payload;
      state.statusNote = 'Тебе видно оператору навіть до першого повідомлення. Історія синхронізується з Telegram-панеллю.';
      updateStatus();
      return state.session;
    } catch (error) {
      state.mode = 'degraded';
      state.statusNote = 'API поки недоступне. Віджет працює локально, щоб можна було тестувати інтерфейс.';
    }
  }

  state.mode = state.mode === 'degraded' ? 'degraded' : 'demo';
  state.session = ensureLocalDemoSession(state.identity);
  updateStatus();
  return state.session;
}

async function loadMessages() {
  await ensureSession();

  if (state.mode === 'remote') {
    const payload = await apiRequest(`/api/support/session/${encodeURIComponent(state.session.sessionId)}/messages?after=${encodeURIComponent(state.lastEffectAt || '')}`);
    state.session = payload.session || state.session;
    state.messages = sortMessages(payload.messages || []);
    state.presence = payload.presence || state.presence;
    processEffects(payload.effects || []);
  } else {
    markLocalSessionRead(state.session.sessionId, 'visitor');
    state.session = getLocalSession(state.session.sessionId) || ensureLocalDemoSession(state.identity);
    state.messages = sortMessages(state.session.messages || []);
  }

  updateStatus();
  renderMessages();
}

function scheduleLocalReply() {
  window.clearTimeout(state.autoReplyTimer);
  state.autoReplyTimer = window.setTimeout(async () => {
    try {
      maybeCreateLocalAutoReply(state.session.sessionId);
      await loadMessages();
    } catch (error) {
      // Ignore demo reply failures.
    }
  }, 900);
}

async function sendMessage(rawText) {
  const text = sanitizeText(rawText, Number(config.maxMessageLength) || 1200);
  if (!text || state.busy) return;

  state.busy = true;
  sendButton.disabled = true;

  try {
    await ensureSession();

    if (state.mode === 'remote') {
      await apiRequest(`/api/support/session/${encodeURIComponent(state.session.sessionId)}/messages`, {
        method: 'POST',
        body: {
          text,
          identity: state.identity,
          meta: buildSupportMeta()
        }
      });
      state.statusNote = 'Повідомлення надіслано. Чекаємо відповідь оператора.';
    } else {
      appendLocalMessage(state.session.sessionId, {
        role: 'visitor',
        authorLabel: state.identity.displayName,
        text,
        source: 'web'
      });
      scheduleLocalReply();
    }

    textarea.value = '';
    updateTextareaHeight();
    await loadMessages();
  } catch (error) {
    state.statusNote = 'Не вдалося надіслати повідомлення. Спробуй ще раз або перевір API.';
    updateStatus();
  } finally {
    state.busy = false;
    sendButton.disabled = false;
  }
}

async function deleteMessage(messageId) {
  if (!state.session || !messageId) return;
  try {
    if (state.mode === 'remote') {
      await apiRequest(`/api/support/session/${encodeURIComponent(state.session.sessionId)}/messages/${encodeURIComponent(messageId)}/delete`, {
        method: 'POST'
      });
      state.statusNote = 'Повідомлення мʼяко видалено, історія не розсипалася.';
    } else {
      deleteLocalMessage(state.session.sessionId, messageId, 'visitor');
    }
    updateStatus();
    await loadMessages();
  } catch (error) {
    state.statusNote = 'Не вдалося видалити повідомлення.';
    updateStatus();
  }
}

async function backgroundHeartbeat() {
  try {
    await ensureSession();
    if (state.mode === 'remote') {
      const typingNow = state.open && document.activeElement === textarea && Boolean(textarea.value.trim());
      await sendPresence(typingNow);
      if (state.open) {
        await loadMessages();
      }
      return;
    }
    if (state.open) {
      await loadMessages();
    }
  } catch (error) {
    // Ignore transient background sync failures.
  }
}

function startPolling() {
  stopPolling();
  state.pollTimer = window.setInterval(() => {
    if (!state.open) return;
    backgroundHeartbeat().catch(() => {});
  }, Number(config.pollInterval) || 12000);
}

function stopPolling() {
  if (state.pollTimer) {
    window.clearInterval(state.pollTimer);
    state.pollTimer = 0;
  }
}

async function bootstrapWidget() {
  if (!state.bootstrapped) {
    state.bootstrapped = true;
    updateStatus();
  }
  if (state.mode === 'remote') {
    await sendPresence(false);
  }
  await loadMessages();
}

function startPresenceLoop() {
  if (state.presenceTimer) return;
  state.presenceTimer = window.setInterval(() => {
    backgroundHeartbeat().catch(() => {});
  }, Number(config.pollInterval) || 12000);
}

root.addEventListener('click', event => {
  const action = event.target.closest('[data-support-action]');
  if (!action) return;
  const actionName = action.getAttribute('data-support-action');
  if (actionName === 'close') {
    setOpen(false);
  }
  if (actionName === 'expand') {
    toggleExpanded();
  }
});

messagesNode.addEventListener('click', event => {
  const deleteButton = event.target.closest('[data-message-delete]');
  if (!deleteButton) return;
  deleteMessage(deleteButton.getAttribute('data-message-delete'));
});

fab.addEventListener('click', () => setOpen(true));

composeForm.addEventListener('submit', event => {
  event.preventDefault();
  sendMessage(textarea.value);
});

textarea.addEventListener('input', updateTextareaHeight);
textarea.addEventListener('input', () => {
  if (state.mode !== 'remote') return;
  window.clearTimeout(state.typingTimer);
  sendPresence(Boolean(textarea.value.trim())).catch(() => {});
  state.typingTimer = window.setTimeout(() => {
    sendPresence(false).catch(() => {});
  }, 1800);
});
textarea.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage(textarea.value);
  }
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && state.open) {
    setOpen(false);
  }
});

window.addEventListener('resize', () => {
  if (isMobileLayout()) {
    state.expanded = true;
  }
  syncExpandedState();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    backgroundHeartbeat().catch(() => {});
  }
});

window.addEventListener('storage', () => {
  if (state.mode !== 'remote' && state.open) {
    loadMessages().catch(() => {});
  }
});

updateStatus();
updateTextareaHeight();
ensureSession().then(() => {
  backgroundHeartbeat().catch(() => {});
}).catch(() => {});
startPresenceLoop();
