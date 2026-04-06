const SUPPORT_IDENTITY_KEY = 'gandj-support-identity-v1';
const SUPPORT_DEMO_DB_KEY = 'gandj-support-demo-db-v1';
const SUPPORT_GREETING = 'Вітаю. Це підтримка АКК. Напишіть, що сталося, і ми продовжимо прямо в цьому чаті.';
const SUPPORT_AUTO_REPLIES = [
  'Повідомлення збережено. Оператор побачить його у Telegram-панелі підтримки.',
  'Прийняли. Якщо треба, уточнення можна просто дописати наступним повідомленням.',
  'Бачимо запит. Історія діалогу збережена, відповідь можна дати з адмінки.'
];

function readJSON(key, fallback) {
  try {
    const value = window.localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch (error) {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    // Ignore storage quota issues in demo mode.
  }
  return value;
}

function sortSessions(sessions) {
  return sessions
    .slice()
    .sort((left, right) => new Date(right.lastMessageAt).getTime() - new Date(left.lastMessageAt).getTime());
}

export function nowIso() {
  return new Date().toISOString();
}

export function uid(prefix = 'id') {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return `${prefix}_${window.crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function hashString(input = '') {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[character] || character));
}

export function sanitizeText(value = '', maxLength = 1200) {
  return String(value)
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .trim()
    .slice(0, maxLength);
}

function buildFingerprintSeed() {
  const screenSize = window.screen ? `${window.screen.width}x${window.screen.height}` : 'unknown';
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
  return [
    navigator.userAgent || 'ua',
    navigator.language || 'lang',
    screenSize,
    timezone,
    navigator.platform || 'platform'
  ].join('|');
}

export function buildSupportMeta() {
  const viewport = `${window.innerWidth || 0}x${window.innerHeight || 0}`;
  const screenSize = window.screen ? `${window.screen.width}x${window.screen.height}` : 'unknown';
  return {
    locale: navigator.language || 'uk-UA',
    userAgent: navigator.userAgent || '',
    viewport,
    screen: screenSize,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    referrer: document.referrer || ''
  };
}

export function getSupportIdentity() {
  const existing = readJSON(SUPPORT_IDENTITY_KEY, null);
  if (existing && existing.visitorId && existing.installId) {
    return existing;
  }

  const fingerprint = hashString(buildFingerprintSeed());
  const visitorId = uid('visitor');
  const shortCode = fingerprint.slice(0, 4).toUpperCase();
  const identity = {
    visitorId,
    installId: uid('install'),
    fingerprint,
    displayName: `Гість ${shortCode}`,
    shortLabel: `#${shortCode}`,
    createdAt: nowIso()
  };
  return writeJSON(SUPPORT_IDENTITY_KEY, identity);
}

export function formatClock(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('uk-UA', {
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

export function formatDayLabel(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('uk-UA', {
    day: 'numeric',
    month: 'long'
  }).format(new Date(value));
}

export function normalizeMessage(message) {
  return {
    messageId: message.messageId || uid('msg'),
    role: message.role || 'visitor',
    authorLabel: message.authorLabel || 'Гість',
    text: sanitizeText(message.text || ''),
    source: message.source || 'web',
    deletedAt: message.deletedAt || null,
    deletedByRole: message.deletedByRole || null,
    deletedByLabel: message.deletedByLabel || null,
    createdAt: message.createdAt || nowIso()
  };
}

export function sortMessages(messages = []) {
  return messages
    .slice()
    .map(normalizeMessage)
    .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
}

function createDefaultSession(identity) {
  const createdAt = nowIso();
  return {
    sessionId: uid('sess'),
    visitorId: identity.visitorId,
    displayName: identity.displayName,
    shortLabel: identity.shortLabel,
    fingerprint: identity.fingerprint,
    createdAt,
    updatedAt: createdAt,
    lastMessageAt: createdAt,
    lastMessagePreview: SUPPORT_GREETING,
    unreadOperatorCount: 0,
    unreadVisitorCount: 1,
    meta: buildSupportMeta(),
    messages: [
      {
        messageId: uid('msg'),
        role: 'support',
        authorLabel: 'Підтримка АКК',
        text: SUPPORT_GREETING,
        source: 'demo',
        createdAt
      }
    ]
  };
}

export function readLocalDemoStore() {
  const store = readJSON(SUPPORT_DEMO_DB_KEY, { sessions: [] });
  if (!Array.isArray(store.sessions)) {
    store.sessions = [];
  }
  return store;
}

export function writeLocalDemoStore(store) {
  return writeJSON(SUPPORT_DEMO_DB_KEY, {
    sessions: sortSessions(store.sessions || [])
  });
}

export function ensureLocalDemoSession(identity = getSupportIdentity()) {
  const store = readLocalDemoStore();
  let session = store.sessions.find(item => item.visitorId === identity.visitorId);

  if (!session) {
    session = createDefaultSession(identity);
    store.sessions.unshift(session);
    writeLocalDemoStore(store);
  }

  return session;
}

export function getLocalSession(sessionId) {
  const store = readLocalDemoStore();
  return store.sessions.find(session => session.sessionId === sessionId) || null;
}

export function listLocalSessions() {
  return sortSessions(readLocalDemoStore().sessions || []);
}

export function saveLocalSession(session) {
  const store = readLocalDemoStore();
  const nextSession = {
    ...session,
    messages: sortMessages(session.messages || [])
  };
  const index = store.sessions.findIndex(item => item.sessionId === nextSession.sessionId);
  if (index === -1) {
    store.sessions.unshift(nextSession);
  } else {
    store.sessions[index] = nextSession;
  }
  writeLocalDemoStore(store);
  return nextSession;
}

export function appendLocalMessage(sessionId, message) {
  const store = readLocalDemoStore();
  const session = store.sessions.find(item => item.sessionId === sessionId);
  if (!session) {
    throw new Error('Session not found');
  }

  const nextMessage = normalizeMessage(message);
  session.messages = sortMessages([...(session.messages || []), nextMessage]);
  session.updatedAt = nextMessage.createdAt;
  session.lastMessageAt = nextMessage.createdAt;
  session.lastMessagePreview = nextMessage.text;

  if (nextMessage.role === 'visitor') {
    session.unreadOperatorCount = (session.unreadOperatorCount || 0) + 1;
  }
  if (nextMessage.role === 'support') {
    session.unreadVisitorCount = (session.unreadVisitorCount || 0) + 1;
  }

  writeLocalDemoStore(store);
  return {
    session,
    message: nextMessage
  };
}

export function deleteLocalMessage(sessionId, messageId, actorRole = 'visitor') {
  const store = readLocalDemoStore();
  const session = store.sessions.find(item => item.sessionId === sessionId);
  if (!session) return null;
  const message = (session.messages || []).find(item => item.messageId === messageId);
  if (!message || message.source === 'system' || message.deletedAt) return null;
  if (actorRole === 'visitor' && message.role !== 'visitor') return null;
  if (actorRole === 'support' && message.role !== 'support') return null;

  const actor = message.role === 'visitor' ? 'користувач' : 'оператор';
  message.text = `${actor} ${message.authorLabel || 'без імені'} видалив повідомлення`;
  message.source = 'deleted';
  message.deletedAt = nowIso();
  message.deletedByRole = actorRole;
  message.deletedByLabel = message.authorLabel || '';
  session.updatedAt = message.deletedAt;
  session.lastMessageAt = message.deletedAt;
  session.lastMessagePreview = message.text;
  writeLocalDemoStore(store);
  return { session, message };
}

export function markLocalSessionRead(sessionId, audience = 'visitor') {
  const store = readLocalDemoStore();
  const session = store.sessions.find(item => item.sessionId === sessionId);
  if (!session) return null;
  if (audience === 'operator') {
    session.unreadOperatorCount = 0;
  } else {
    session.unreadVisitorCount = 0;
  }
  writeLocalDemoStore(store);
  return session;
}

export function maybeCreateLocalAutoReply(sessionId) {
  const response = SUPPORT_AUTO_REPLIES[Math.floor(Math.random() * SUPPORT_AUTO_REPLIES.length)];
  return appendLocalMessage(sessionId, {
    role: 'support',
    authorLabel: 'Підтримка АКК',
    text: response,
    source: 'demo'
  });
}
