import {
  appendLocalMessage,
  escapeHtml,
  formatClock,
  formatDayLabel,
  getLocalSession,
  listLocalSessions,
  markLocalSessionRead,
  sanitizeText,
  sortMessages
} from './support-shared.js';

const config = Object.assign(
  {
    apiBase: '',
    pollInterval: 12000,
    adminToken: '',
    supportName: 'Підтримка АКК'
  },
  window.GandjSupportConfig || {}
);

const tokenFromQuery = new URLSearchParams(window.location.search).get('token');
const tokenFromHash = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
const urlAdminToken = tokenFromQuery || tokenFromHash || '';
const telegramApp = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
if (telegramApp) {
  telegramApp.ready();
  telegramApp.expand();
}

const state = {
  chats: [],
  currentSession: null,
  messages: [],
  search: '',
  mode: config.apiBase ? 'connecting' : 'demo',
  syncLabel: telegramApp ? 'Telegram Mini App' : 'Браузер',
  pollTimer: 0,
  busy: false
};

const chatList = document.getElementById('adminChatList');
const stream = document.getElementById('adminStream');
const emptyState = document.getElementById('adminEmptyState');
const searchInput = document.getElementById('adminSearch');
const modeBadge = document.getElementById('adminModeBadge');
const syncBadge = document.getElementById('adminSyncBadge');
const titleNode = document.getElementById('adminChatTitle');
const metaNode = document.getElementById('adminChatMeta');
const backButton = document.getElementById('adminBackButton');
const expandButton = document.getElementById('adminExpandButton');
const composeForm = document.getElementById('adminComposeForm');
const composeInput = document.getElementById('adminComposeInput');
const sendButton = document.getElementById('adminSendButton');

function updateComposerHeight() {
  composeInput.style.height = 'auto';
  composeInput.style.height = `${Math.min(composeInput.scrollHeight, 180)}px`;
}

function setMode(mode, syncLabel) {
  const labels = {
    connecting: 'Підключення',
    remote: 'Онлайн API',
    demo: 'Локальний демо',
    degraded: 'Локальний fallback'
  };
  state.mode = mode;
  modeBadge.textContent = labels[mode] || 'Панель';
  syncBadge.textContent = syncLabel || state.syncLabel;
}

function operatorHeaders() {
  const headers = { Accept: 'application/json' };
  if (telegramApp && telegramApp.initData) {
    headers['X-Telegram-Init-Data'] = telegramApp.initData;
  }
  const bearerToken = urlAdminToken || config.adminToken;
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }
  return headers;
}

async function apiRequest(path, options = {}) {
  if (!config.apiBase) {
    throw new Error('API is not configured');
  }
  const url = new URL(path, config.apiBase);
  const response = await fetch(url.toString(), {
    method: options.method || 'GET',
    headers: {
      ...operatorHeaders(),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: 'omit'
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

function filteredChats() {
  const query = state.search.trim().toLowerCase();
  if (!query) return state.chats;
  return state.chats.filter(chat => {
    const haystack = [
      chat.displayName,
      chat.shortLabel,
      chat.lastMessagePreview,
      chat.visitorId
    ].join(' ').toLowerCase();
    return haystack.includes(query);
  });
}

function renderChatList() {
  const chats = filteredChats();
  if (!chats.length) {
    chatList.innerHTML = '<div class="admin-empty">Чатів поки немає або фільтр нічого не знайшов.</div>';
    return;
  }

  chatList.innerHTML = chats.map(chat => {
    const preview = escapeHtml((chat.lastMessagePreview || 'Без повідомлень').slice(0, 96));
    const unread = Number(chat.unreadOperatorCount || 0);
    const active = state.currentSession && state.currentSession.sessionId === chat.sessionId ? ' active' : '';
    return `
      <button type="button" class="admin-chat-card${active}" data-chat-id="${escapeHtml(chat.sessionId)}">
        <div class="admin-chat-row">
          <strong>${escapeHtml(chat.displayName || chat.shortLabel || 'Гість')}</strong>
          <span>${escapeHtml(formatClock(chat.lastMessageAt))}</span>
        </div>
        <div class="admin-chat-preview">${preview}</div>
        <div class="admin-chat-meta">
          <span>${escapeHtml(chat.shortLabel || chat.visitorId || '')}</span>
          ${unread ? `<span class="admin-unread">${unread}</span>` : '<span></span>'}
        </div>
      </button>
    `;
  }).join('');
}

function renderMessages() {
  if (!state.currentSession) {
    emptyState.hidden = false;
    stream.innerHTML = '';
    stream.appendChild(emptyState);
    titleNode.textContent = 'Оберіть чат';
    metaNode.textContent = 'Тут з\'являться звернення з сайту.';
    return;
  }

  emptyState.hidden = true;
  titleNode.textContent = state.currentSession.displayName || state.currentSession.shortLabel || 'Гість';
  metaNode.textContent = `${state.currentSession.shortLabel || ''} · ${state.currentSession.visitorId || ''}`;

  let previousDay = '';
  stream.innerHTML = state.messages.map(message => {
    const dayKey = new Date(message.createdAt).toDateString();
    const divider = dayKey === previousDay ? '' : `<div class="admin-day">${escapeHtml(formatDayLabel(message.createdAt))}</div>`;
    previousDay = dayKey;
    const roleClass = message.role === 'support' ? 'support' : 'visitor';
    const text = escapeHtml(message.text).replace(/\n/g, '<br>');
    return `${divider}
      <div class="admin-message-row ${roleClass}">
        <article class="admin-message-bubble">
          <div class="admin-message-author">${escapeHtml(message.authorLabel)}</div>
          <div class="admin-message-text">${text}</div>
          <div class="admin-message-time">${escapeHtml(formatClock(message.createdAt))}</div>
        </article>
      </div>`;
  }).join('');

  requestAnimationFrame(() => {
    stream.scrollTop = stream.scrollHeight;
  });
}

function updateLayoutState() {
  document.body.classList.toggle('admin-chat-open', Boolean(state.currentSession));
}

async function loadChats() {
  try {
    if (config.apiBase) {
      const payload = await apiRequest('/api/operator/chats');
      state.chats = payload.chats || [];
      setMode('remote', telegramApp ? 'Telegram Mini App' : 'Браузер');
    } else {
      state.chats = listLocalSessions();
      setMode('demo', telegramApp ? 'Telegram Mini App' : 'Браузер');
    }
  } catch (error) {
    state.chats = listLocalSessions();
    setMode('degraded', 'Fallback');
  }

  renderChatList();

  if (!state.currentSession && state.chats.length) {
    await openChat(state.chats[0].sessionId);
  }
}

async function openChat(sessionId) {
  try {
    if (state.mode === 'remote') {
      const payload = await apiRequest(`/api/operator/chats/${encodeURIComponent(sessionId)}/messages`);
      state.currentSession = payload.session;
      state.messages = sortMessages(payload.messages || []);
    } else {
      markLocalSessionRead(sessionId, 'operator');
      state.currentSession = getLocalSession(sessionId);
      state.messages = sortMessages((state.currentSession && state.currentSession.messages) || []);
    }
  } catch (error) {
    state.currentSession = getLocalSession(sessionId);
    state.messages = sortMessages((state.currentSession && state.currentSession.messages) || []);
  }

  updateLayoutState();
  renderChatList();
  renderMessages();
}

async function sendReply(rawText) {
  const text = sanitizeText(rawText, 1200);
  if (!text || !state.currentSession || state.busy) return;

  state.busy = true;
  sendButton.disabled = true;

  try {
    if (state.mode === 'remote') {
      await apiRequest(`/api/operator/chats/${encodeURIComponent(state.currentSession.sessionId)}/reply`, {
        method: 'POST',
        body: {
          text,
          authorLabel: telegramApp && telegramApp.initDataUnsafe && telegramApp.initDataUnsafe.user
            ? telegramApp.initDataUnsafe.user.first_name || 'Оператор'
            : 'Оператор'
        }
      });
    } else {
      appendLocalMessage(state.currentSession.sessionId, {
        role: 'support',
        authorLabel: 'Оператор',
        text,
        source: 'webapp'
      });
      markLocalSessionRead(state.currentSession.sessionId, 'operator');
    }

    composeInput.value = '';
    updateComposerHeight();
    await loadChats();
    await openChat(state.currentSession.sessionId);
  } finally {
    state.busy = false;
    sendButton.disabled = false;
  }
}

function startPolling() {
  window.clearInterval(state.pollTimer);
  state.pollTimer = window.setInterval(async () => {
    await loadChats();
    if (state.currentSession) {
      await openChat(state.currentSession.sessionId);
    }
  }, Number(config.pollInterval) || 12000);
}

chatList.addEventListener('click', event => {
  const button = event.target.closest('[data-chat-id]');
  if (!button) return;
  openChat(button.getAttribute('data-chat-id'));
});

searchInput.addEventListener('input', event => {
  state.search = event.target.value || '';
  renderChatList();
});

composeForm.addEventListener('submit', event => {
  event.preventDefault();
  sendReply(composeInput.value);
});

composeInput.addEventListener('input', updateComposerHeight);
composeInput.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendReply(composeInput.value);
  }
});

backButton.addEventListener('click', () => {
  state.currentSession = null;
  state.messages = [];
  updateLayoutState();
  renderChatList();
  renderMessages();
});

expandButton.addEventListener('click', async () => {
  if (telegramApp) {
    if (typeof telegramApp.requestFullscreen === 'function') {
      telegramApp.requestFullscreen();
    } else {
      telegramApp.expand();
    }
    return;
  }
  if (document.documentElement.requestFullscreen) {
    try {
      await document.documentElement.requestFullscreen();
    } catch (error) {
      // Ignore fullscreen denial.
    }
  }
});

window.addEventListener('storage', () => {
  if (state.mode !== 'remote') {
    loadChats();
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    loadChats();
    if (state.currentSession) openChat(state.currentSession.sessionId);
  }
});

updateComposerHeight();
renderMessages();
loadChats();
startPolling();
