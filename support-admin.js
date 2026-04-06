import {
  appendLocalMessage,
  deleteLocalMessage,
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
  presence: { visitor: null, operator: null },
  search: '',
  mode: config.apiBase ? 'connecting' : 'demo',
  syncLabel: telegramApp ? 'Telegram Mini App' : 'Браузер',
  pollTimer: 0,
  typingTimer: 0,
  flashTimer: 0,
  busy: false
};

const EFFECT_PRESETS = [
  {
    effectType: 'snoop',
    label: 'Режим Snoop',
    blurb: 'GIF зі Snoop Dogg і фоновий трек',
    title: 'Режим Snoop',
    message: 'Snoop Dogg уже в ефірі.'
  }
];

const chatList = document.getElementById('adminChatList');
const stream = document.getElementById('adminStream');
const emptyState = document.getElementById('adminEmptyState');
const searchInput = document.getElementById('adminSearch');
const modeBadge = document.getElementById('adminModeBadge');
const syncBadge = document.getElementById('adminSyncBadge');
const visitorsBadge = document.getElementById('adminVisitorsBadge');
const titleNode = document.getElementById('adminChatTitle');
const metaNode = document.getElementById('adminChatMeta');
const presenceNode = document.getElementById('adminPresenceMeta');
const targetHintNode = document.getElementById('adminTargetHint');
const backButton = document.getElementById('adminBackButton');
const expandButton = document.getElementById('adminExpandButton');
const globalActions = document.getElementById('adminGlobalActions');
const targetActions = document.getElementById('adminTargetActions');
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
    remote: 'API онлайн',
    demo: 'Локальний демо',
    degraded: 'Локальний резерв'
  };
  state.mode = mode;
  state.syncLabel = syncLabel || state.syncLabel;
  modeBadge.textContent = labels[mode] || 'Панель';
  syncBadge.textContent = state.syncLabel;
}

function flashSyncLabel(text, timeout = 2600) {
  syncBadge.textContent = text;
  window.clearTimeout(state.flashTimer);
  state.flashTimer = window.setTimeout(() => {
    syncBadge.textContent = state.syncLabel;
  }, timeout);
}

function presenceTimestamp(chat) {
  return chat && chat.presence && chat.presence.visitor && chat.presence.visitor.lastSeenAt
    ? new Date(chat.presence.visitor.lastSeenAt).getTime()
    : 0;
}

function isChatOnline(chat) {
  const lastSeen = presenceTimestamp(chat);
  return Boolean(lastSeen) && Date.now() - lastSeen < 70000;
}

function sortChats(chats = []) {
  return chats.slice().sort((left, right) => {
    const onlineDelta = Number(isChatOnline(right)) - Number(isChatOnline(left));
    if (onlineDelta) return onlineDelta;
    const unreadDelta = Number(right.unreadOperatorCount || 0) - Number(left.unreadOperatorCount || 0);
    if (unreadDelta) return unreadDelta;
    return Math.max(
      presenceTimestamp(right),
      new Date(right.lastMessageAt || 0).getTime()
    ) - Math.max(
      presenceTimestamp(left),
      new Date(left.lastMessageAt || 0).getTime()
    );
  });
}

function updateVisitorBadge() {
  if (!visitorsBadge) return;
  const total = state.chats.length;
  const online = state.chats.filter(chat => isChatOnline(chat)).length;
  visitorsBadge.textContent = `${online} на сайті · ${total} всього`;
}

function renderPrankButtons(targetNode, scope) {
  if (!targetNode) return;
  const disabled = state.mode !== 'remote' || (scope === 'session' && !state.currentSession);
  targetNode.innerHTML = EFFECT_PRESETS.map(effect => `
    <button
      type="button"
      class="admin-prank-button"
      data-effect-scope="${scope}"
      data-effect-type="${escapeHtml(effect.effectType)}"
      ${disabled ? 'disabled' : ''}
    >
      <strong>${escapeHtml(effect.label)}</strong>
      <span>${escapeHtml(effect.blurb)}</span>
    </button>
  `).join('');
}

function updatePrankTargets() {
  renderPrankButtons(globalActions, 'all');
  renderPrankButtons(targetActions, 'session');
  if (targetHintNode) {
    targetHintNode.textContent = state.currentSession
      ? `Цілиться в ${state.currentSession.displayName || state.currentSession.shortLabel || 'відвідувача'} ${state.currentSession.shortLabel || ''}`.trim()
      : 'Оберіть людину в списку, щоб запускати адресно.';
  }
}

function relativePresence(value) {
  if (!value) return { text: 'не в мережі', className: '' };
  const diffMs = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.round(diffMs / 60000));
  if (minutes <= 1) return { text: 'у мережі', className: 'online' };
  if (minutes < 60) return { text: `у мережі ${minutes} хв тому`, className: '' };
  const hours = Math.round(minutes / 60);
  return { text: `був у мережі ${hours} год тому`, className: '' };
}

function currentVisitorPresenceLabel() {
  const visitor = state.presence && state.presence.visitor;
  if (!visitor) {
    return { text: 'Відкрий чат, щоб побачити статус.', className: '' };
  }
  if (visitor.lastTypingAt && Date.now() - new Date(visitor.lastTypingAt).getTime() < 6500) {
    return { text: 'друкує...', className: 'typing' };
  }
  return relativePresence(visitor.lastSeenAt);
}

function canDeleteOperatorMessage(message) {
  return Boolean(message)
    && message.role === 'support'
    && message.source !== 'system'
    && !message.deletedAt;
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
  updateVisitorBadge();
  const chats = filteredChats();
  if (!chats.length) {
    chatList.innerHTML = '<div class="admin-empty">Нікого не видно або фільтр нічого не знайшов.</div>';
    return;
  }

  chatList.innerHTML = chats.map(chat => {
    const preview = escapeHtml((chat.lastMessagePreview || 'На сайті зараз · ще не писав').slice(0, 96));
    const unread = Number(chat.unreadOperatorCount || 0);
    const active = state.currentSession && state.currentSession.sessionId === chat.sessionId ? ' active' : '';
    const visitorPresence = chat.presence && chat.presence.visitor ? chat.presence.visitor : null;
    const visitorTypingFresh = visitorPresence && visitorPresence.lastTypingAt && Date.now() - new Date(visitorPresence.lastTypingAt).getTime() < 6500;
    const presence = visitorTypingFresh
      ? { text: 'друкує...', className: 'typing' }
      : relativePresence(visitorPresence && visitorPresence.lastSeenAt);
    return `
      <button type="button" class="admin-chat-card${active}" data-chat-id="${escapeHtml(chat.sessionId)}">
        <div class="admin-chat-row">
          <strong>${escapeHtml(chat.displayName || chat.shortLabel || 'Гість')}</strong>
          <span>${escapeHtml(formatClock(chat.lastMessageAt))}</span>
        </div>
        <div class="admin-chat-preview">${preview}</div>
        <div class="admin-chat-meta">
          <span class="admin-chat-status ${presence.className}">${escapeHtml(presence.text)}</span>
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
    if (presenceNode) {
      presenceNode.textContent = 'Відкрий чат, щоб побачити статус.';
      presenceNode.className = 'admin-chat-presence';
    }
    return;
  }

  emptyState.hidden = true;
  titleNode.textContent = state.currentSession.displayName || state.currentSession.shortLabel || 'Гість';
  metaNode.textContent = `${state.currentSession.shortLabel || ''} · ${state.currentSession.visitorId || ''}`;
  if (presenceNode) {
    const presence = currentVisitorPresenceLabel();
    presenceNode.textContent = presence.text;
    presenceNode.className = `admin-chat-presence ${presence.className}`.trim();
  }

  if (!state.messages.length) {
    stream.innerHTML = `
      <div class="admin-empty">
        ${escapeHtml(state.currentSession.displayName || 'Відвідувач')} зараз на сайті, але ще нічого не написав.
        Можна дати перше повідомлення або вистрілити приколом прямо звідси.
      </div>
    `;
    return;
  }

  let previousDay = '';
  stream.innerHTML = state.messages.map(message => {
    const dayKey = new Date(message.createdAt).toDateString();
    const divider = dayKey === previousDay ? '' : `<div class="admin-day">${escapeHtml(formatDayLabel(message.createdAt))}</div>`;
    previousDay = dayKey;
    const roleClass = message.role === 'support' ? 'support' : 'visitor';
    const text = escapeHtml(message.text).replace(/\n/g, '<br>');
    const deletedClass = message.deletedAt ? ' deleted' : '';
    const deleteButton = canDeleteOperatorMessage(message)
      ? `<button type="button" class="admin-message-delete" data-message-delete="${escapeHtml(message.messageId)}">Видалити</button>`
      : '';
    return `${divider}
      <div class="admin-message-row ${roleClass}">
        <article class="admin-message-bubble${deletedClass}">
          <div class="admin-message-author">${escapeHtml(message.authorLabel)}</div>
          <div class="admin-message-text">${text}</div>
          <div class="admin-message-actions">
            <div class="admin-message-time">${escapeHtml(formatClock(message.createdAt))}</div>
            ${deleteButton}
          </div>
        </article>
      </div>`;
  }).join('');

  const visitor = state.presence && state.presence.visitor;
  if (visitor && visitor.lastTypingAt && Date.now() - new Date(visitor.lastTypingAt).getTime() < 6500) {
    stream.insertAdjacentHTML(
      'beforeend',
      `
        <div class="admin-message-row visitor">
          <article class="admin-message-bubble admin-message-bubble-typing">
            <div class="admin-message-author">${escapeHtml(state.currentSession.displayName || 'Гість')}</div>
            <div class="admin-typing-dots" aria-label="Друкує">
              <span></span><span></span><span></span>
            </div>
          </article>
        </div>
      `
    );
  }

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
      state.chats = sortChats(payload.chats || []);
      setMode('remote', telegramApp ? 'Telegram Mini App' : 'Браузер');
    } else {
      state.chats = sortChats(listLocalSessions());
      setMode('demo', telegramApp ? 'Telegram Mini App' : 'Браузер');
    }
  } catch (error) {
    state.chats = sortChats(listLocalSessions());
    setMode('degraded', 'Резерв');
  }

  renderChatList();
  updatePrankTargets();

  if (!state.currentSession && state.chats.length) {
    await openChat(state.chats[0].sessionId);
    return;
  }

  if (state.currentSession) {
    const freshCurrent = state.chats.find(chat => chat.sessionId === state.currentSession.sessionId);
    if (freshCurrent) {
      state.currentSession = freshCurrent;
      updatePrankTargets();
    }
  }
}

async function openChat(sessionId) {
  try {
    if (state.mode === 'remote') {
      const payload = await apiRequest(`/api/operator/chats/${encodeURIComponent(sessionId)}/messages`);
      state.currentSession = payload.session;
      state.messages = sortMessages(payload.messages || []);
      state.presence = payload.presence || state.presence;
      await sendOperatorPresence(false, sessionId);
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
  updatePrankTargets();
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
      await sendOperatorPresence(false, state.currentSession.sessionId);
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

async function deleteMessage(messageId) {
  if (!state.currentSession || !messageId) return;
  try {
    if (state.mode === 'remote') {
      await apiRequest(`/api/operator/chats/${encodeURIComponent(state.currentSession.sessionId)}/messages/${encodeURIComponent(messageId)}/delete`, {
        method: 'POST'
      });
      flashSyncLabel('Повідомлення видалено');
    } else {
      deleteLocalMessage(state.currentSession.sessionId, messageId, 'support');
    }
    await loadChats();
    await openChat(state.currentSession.sessionId);
  } catch (error) {
    flashSyncLabel('Не вдалося видалити', 3200);
  }
}

async function triggerEffect(effectType, scope) {
  const preset = EFFECT_PRESETS.find(item => item.effectType === effectType);
  if (!preset || state.mode !== 'remote') {
    flashSyncLabel('Режим працює лише онлайн', 3200);
    return;
  }
  if (scope === 'session' && !state.currentSession) {
    flashSyncLabel('Оберіть відвідувача', 3200);
    return;
  }
  try {
    await apiRequest('/api/operator/effects', {
      method: 'POST',
      body: {
        scope,
        sessionId: scope === 'session' ? state.currentSession.sessionId : null,
        effectType: preset.effectType,
        title: preset.title,
        message: preset.message,
        payload: {
          label: preset.label
        }
      }
    });
    flashSyncLabel(scope === 'all' ? 'Режим Snoop увімкнено для всіх' : 'Режим Snoop увімкнено адресно');
  } catch (error) {
    flashSyncLabel('Не вдалося ввімкнути режим', 3200);
  }
}

async function sendOperatorPresence(typing = false, sessionId = null) {
  if (!config.apiBase) return;
  const activeSessionId = sessionId === null
    ? (state.currentSession && state.currentSession.sessionId) || ''
    : sessionId;
  if (!activeSessionId) return;
  try {
    const payload = await apiRequest('/api/operator/presence', {
      method: 'POST',
      body: {
        activeSessionId,
        typing
      }
    });
    if (payload && payload.presence) {
      state.presence = payload.presence;
      renderMessages();
    }
  } catch (error) {
    // Ignore transient presence failures.
  }
}

function startPolling() {
  window.clearInterval(state.pollTimer);
  state.pollTimer = window.setInterval(async () => {
    if (state.currentSession && state.mode === 'remote') {
      await sendOperatorPresence(false, state.currentSession.sessionId);
    }
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

stream.addEventListener('click', event => {
  const deleteButton = event.target.closest('[data-message-delete]');
  if (!deleteButton) return;
  deleteMessage(deleteButton.getAttribute('data-message-delete'));
});

[globalActions, targetActions].forEach(node => {
  if (!node) return;
  node.addEventListener('click', event => {
    const button = event.target.closest('[data-effect-type]');
    if (!button) return;
    triggerEffect(
      button.getAttribute('data-effect-type'),
      button.getAttribute('data-effect-scope') || 'all'
    );
  });
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
composeInput.addEventListener('input', () => {
  if (state.mode !== 'remote' || !state.currentSession) return;
  window.clearTimeout(state.typingTimer);
  sendOperatorPresence(Boolean(composeInput.value.trim()), state.currentSession.sessionId);
  state.typingTimer = window.setTimeout(() => {
    sendOperatorPresence(false, state.currentSession && state.currentSession.sessionId);
  }, 1800);
});
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
  updatePrankTargets();
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
    if (state.currentSession && state.mode === 'remote') {
      sendOperatorPresence(false, state.currentSession.sessionId);
    }
    loadChats();
    if (state.currentSession) openChat(state.currentSession.sessionId);
  }
});

updateComposerHeight();
updatePrankTargets();
renderMessages();
loadChats();
startPolling();
