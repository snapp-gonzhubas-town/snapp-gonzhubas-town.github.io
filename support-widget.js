import {
  buildSupportMeta,
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
  mode: config.apiBase ? 'connecting' : 'demo',
  open: false,
  expanded: false,
  pollTimer: 0,
  autoReplyTimer: 0,
  bootstrapped: false,
  busy: false,
  statusNote: 'Відповідаємо прямо тут. На телефоні чат відкривається на весь екран.'
};

const root = document.createElement('div');
root.className = 'support-root';
root.dataset.open = 'false';
root.innerHTML = `
  <div class="support-backdrop" data-support-action="close"></div>
  <div class="support-dock">
    <div class="support-shell" id="supportShell" aria-hidden="true">
      <section class="support-panel" role="dialog" aria-modal="false" aria-label="${escapeHtml(config.widgetTitle)}">
        <header class="support-header">
          <div class="support-titlebox">
            <div class="support-avatar">П</div>
            <div class="support-heading">
              <strong>${escapeHtml(config.supportName)}</strong>
              <span>${escapeHtml(config.widgetSubtitle)}</span>
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
const modeBadge = root.querySelector('#supportModeBadge');
const visitorBadge = root.querySelector('#supportVisitorBadge');
const statusNote = root.querySelector('#supportStatusNote');
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
}

function bubbleHtml(message) {
  const roleClass = message.role === 'support' ? 'support' : message.role === 'system' ? 'system' : 'visitor';
  const text = escapeHtml(message.text).replace(/\n/g, '<br>');
  return `
    <div class="support-row ${roleClass}">
      <article class="support-bubble">
        <div class="support-bubble-author">${escapeHtml(message.authorLabel)}</div>
        <div class="support-bubble-text">${text}</div>
        <div class="support-bubble-meta">${escapeHtml(formatClock(message.createdAt))}</div>
      </article>
    </div>
  `;
}

function renderMessages() {
  if (!state.messages.length) {
    messagesNode.innerHTML = '<div class="support-empty">Поки що тут порожньо. Напиши повідомлення, і чат одразу почне збирати історію звернення.</div>';
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
      state.statusNote = 'Онлайн-чат активний. Історія синхронізується з операторською Telegram-панеллю.';
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
    const payload = await apiRequest(`/api/support/session/${encodeURIComponent(state.session.sessionId)}/messages`);
    state.session = payload.session || state.session;
    state.messages = sortMessages(payload.messages || []);
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

function startPolling() {
  stopPolling();
  state.pollTimer = window.setInterval(() => {
    if (!state.open) return;
    loadMessages().catch(() => {});
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
  await loadMessages();
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

fab.addEventListener('click', () => setOpen(true));

composeForm.addEventListener('submit', event => {
  event.preventDefault();
  sendMessage(textarea.value);
});

textarea.addEventListener('input', updateTextareaHeight);
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
  if (!document.hidden && state.open) {
    loadMessages().catch(() => {});
  }
});

window.addEventListener('storage', () => {
  if (state.mode !== 'remote' && state.open) {
    loadMessages().catch(() => {});
  }
});

updateStatus();
updateTextareaHeight();
