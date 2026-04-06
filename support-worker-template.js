const encoder = new TextEncoder();
const EFFECT_LOOKBACK_MS = 20000;

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.SUPPORT_SITE_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Telegram-Init-Data',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=UTF-8'
    }
  });
}

function withCors(response, env) {
  const headers = new Headers(response.headers);
  Object.entries(corsHeaders(env)).forEach(([key, value]) => headers.set(key, value));
  return new Response(response.body, {
    status: response.status,
    headers
  });
}

async function readBody(request) {
  try {
    return await request.json();
  } catch (error) {
    return {};
  }
}

function uid(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function nowIso() {
  return new Date().toISOString();
}

function sanitizeText(value = '', maxLength = 1200) {
  return String(value)
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .trim()
    .slice(0, maxLength);
}

function safeJsonParse(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch (error) {
    return fallback;
  }
}

async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function hmacBytes(keyData, message) {
  const rawKey = typeof keyData === 'string' ? encoder.encode(keyData) : keyData;
  const key = await crypto.subtle.importKey('raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

async function hmacHex(keyData, message) {
  const signature = await hmacBytes(keyData, message);
  return [...signature].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function verifyTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return null;

  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  if (!receivedHash) return null;
  params.delete('hash');

  const authDate = Number(params.get('auth_date') || '0');
  if (authDate && Math.abs(Math.floor(Date.now() / 1000) - authDate) > 86400) {
    return null;
  }

  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = await hmacBytes('WebAppData', botToken);
  const calculatedHash = await hmacHex(secretKey, dataCheckString);
  if (calculatedHash !== receivedHash) {
    return null;
  }

  const userJson = params.get('user');
  return userJson ? JSON.parse(userJson) : null;
}

function parseIds(value) {
  return new Set(String(value || '').split(',').map(item => item.trim()).filter(Boolean));
}

async function telegramApi(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`Telegram API ${response.status}`);
  }
  return response.json();
}

async function requireOperator(request, env) {
  const allowedIds = parseIds(env.TELEGRAM_OPERATOR_IDS);
  const bearer = request.headers.get('Authorization') || '';
  if (env.SUPPORT_OPERATOR_TOKEN && bearer === `Bearer ${env.SUPPORT_OPERATOR_TOKEN}`) {
    return { id: 'token', first_name: 'Operator Token' };
  }

  const initData = request.headers.get('X-Telegram-Init-Data');
  const user = await verifyTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN);
  if (user && (!allowedIds.size || allowedIds.has(String(user.id)))) {
    return user;
  }

  return null;
}

function emptyPresence() {
  return { visitor: null, operator: null };
}

function sessionSelectSql(whereClause) {
  return `
    SELECT
      session_id AS sessionId,
      visitor_id AS visitorId,
      display_name AS displayName,
      short_label AS shortLabel,
      fingerprint,
      ip_hash AS ipHash,
      locale,
      user_agent AS userAgent,
      viewport,
      created_at AS createdAt,
      updated_at AS updatedAt,
      last_message_at AS lastMessageAt,
      last_message_preview AS lastMessagePreview,
      unread_operator_count AS unreadOperatorCount,
      unread_visitor_count AS unreadVisitorCount
    FROM support_sessions
    ${whereClause}
  `;
}

async function getSessionByVisitor(env, visitorId) {
  return env.SUPPORT_DB.prepare(sessionSelectSql('WHERE visitor_id = ?')).bind(visitorId).first();
}

async function getSessionById(env, sessionId) {
  return env.SUPPORT_DB.prepare(sessionSelectSql('WHERE session_id = ?')).bind(sessionId).first();
}

async function listMessages(env, sessionId) {
  const result = await env.SUPPORT_DB.prepare(`
    SELECT
      message_id AS messageId,
      session_id AS sessionId,
      role,
      author_label AS authorLabel,
      text,
      source,
      deleted_at AS deletedAt,
      deleted_by_role AS deletedByRole,
      deleted_by_label AS deletedByLabel,
      created_at AS createdAt
    FROM support_messages
    WHERE session_id = ?
    ORDER BY created_at ASC
  `).bind(sessionId).all();
  return result.results || [];
}

async function getPresenceMap(env, sessionIds = []) {
  if (!sessionIds.length) return new Map();

  const placeholders = sessionIds.map(() => '?').join(', ');
  const result = await env.SUPPORT_DB.prepare(`
    SELECT
      session_id AS sessionId,
      audience,
      last_seen_at AS lastSeenAt,
      last_typing_at AS lastTypingAt
    FROM support_presence
    WHERE session_id IN (${placeholders})
  `).bind(...sessionIds).all();

  const map = new Map(sessionIds.map(sessionId => [sessionId, emptyPresence()]));
  (result.results || []).forEach(row => {
    const presence = map.get(row.sessionId) || emptyPresence();
    presence[row.audience] = {
      lastSeenAt: row.lastSeenAt || null,
      lastTypingAt: row.lastTypingAt || null
    };
    map.set(row.sessionId, presence);
  });

  return map;
}

async function getPresenceForSession(env, sessionId) {
  const map = await getPresenceMap(env, [sessionId]);
  return map.get(sessionId) || emptyPresence();
}

async function attachSessionPresence(env, session) {
  if (!session) return null;
  return {
    ...session,
    presence: await getPresenceForSession(env, session.sessionId)
  };
}

async function listSessions(env) {
  const result = await env.SUPPORT_DB.prepare(`${sessionSelectSql('')} ORDER BY last_message_at DESC`).all();
  const sessions = result.results || [];
  const presenceMap = await getPresenceMap(env, sessions.map(session => session.sessionId));
  return sessions.map(session => ({
    ...session,
    presence: presenceMap.get(session.sessionId) || emptyPresence()
  }));
}

function effectAfterCursor(after) {
  return after || new Date(Date.now() - EFFECT_LOOKBACK_MS).toISOString();
}

function effectRowToObject(row) {
  return {
    effectId: row.effectId,
    sessionId: row.sessionId || null,
    scope: row.scope,
    effectType: row.effectType,
    title: row.title || '',
    message: row.message || '',
    payload: safeJsonParse(row.payload, null),
    createdAt: row.createdAt
  };
}

async function listEffectsForSession(env, sessionId, after = '') {
  const result = await env.SUPPORT_DB.prepare(`
    SELECT
      effect_id AS effectId,
      session_id AS sessionId,
      scope,
      effect_type AS effectType,
      title,
      message,
      payload,
      created_at AS createdAt
    FROM support_effects
    WHERE created_at > ?
      AND (scope = 'all' OR session_id = ?)
    ORDER BY created_at ASC
  `).bind(effectAfterCursor(after), sessionId).all();

  return (result.results || []).map(effectRowToObject);
}

async function createEffect(env, scope, sessionId, effectType, title, message, payload) {
  const effect = {
    effectId: uid('fx'),
    sessionId: scope === 'session' ? sessionId : null,
    scope,
    effectType,
    title: title || '',
    message: message || '',
    payload: payload || null,
    createdAt: nowIso()
  };

  await env.SUPPORT_DB.prepare(`
    INSERT INTO support_effects (
      effect_id, session_id, scope, effect_type, title, message, payload, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .bind(
      effect.effectId,
      effect.sessionId,
      effect.scope,
      effect.effectType,
      effect.title,
      effect.message,
      effect.payload ? JSON.stringify(effect.payload) : null,
      effect.createdAt
    )
    .run();

  return effect;
}

async function insertMessage(env, sessionId, role, authorLabel, text, source = 'web') {
  const message = {
    messageId: uid('msg'),
    sessionId,
    role,
    authorLabel,
    text,
    source,
    createdAt: nowIso()
  };

  await env.SUPPORT_DB.prepare(`
    INSERT INTO support_messages (
      message_id, session_id, role, author_label, text, source, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
    .bind(message.messageId, message.sessionId, message.role, message.authorLabel, message.text, message.source, message.createdAt)
    .run();

  return message;
}

async function updateSessionAfterMessage(env, sessionId, text, speaker) {
  const sql = speaker === 'visitor'
    ? `
      UPDATE support_sessions
      SET
        updated_at = ?,
        last_message_at = ?,
        last_message_preview = ?,
        unread_operator_count = unread_operator_count + 1
      WHERE session_id = ?
    `
    : `
      UPDATE support_sessions
      SET
        updated_at = ?,
        last_message_at = ?,
        last_message_preview = ?,
        unread_operator_count = 0,
        unread_visitor_count = unread_visitor_count + 1
      WHERE session_id = ?
    `;

  const timestamp = nowIso();
  await env.SUPPORT_DB.prepare(sql).bind(timestamp, timestamp, text, sessionId).run();
}

async function markSessionRead(env, sessionId, audience) {
  const sql = audience === 'operator'
    ? 'UPDATE support_sessions SET unread_operator_count = 0 WHERE session_id = ?'
    : 'UPDATE support_sessions SET unread_visitor_count = 0 WHERE session_id = ?';
  await env.SUPPORT_DB.prepare(sql).bind(sessionId).run();
}

async function softDeleteMessage(env, sessionId, messageId, actorRole) {
  const message = await env.SUPPORT_DB.prepare(`
    SELECT
      message_id AS messageId,
      role,
      author_label AS authorLabel,
      source,
      deleted_at AS deletedAt
    FROM support_messages
    WHERE session_id = ? AND message_id = ?
  `).bind(sessionId, messageId).first();

  if (!message || message.deletedAt || message.source === 'system') {
    return null;
  }
  if (actorRole === 'visitor' && message.role !== 'visitor') {
    return null;
  }
  if (actorRole === 'support' && message.role !== 'support') {
    return null;
  }

  const deletedAt = nowIso();
  const actorText = message.role === 'visitor' ? 'користувач' : 'админ';
  const deletedText = `${actorText} ${message.authorLabel || 'без імені'} видалив повідомлення`;

  await env.SUPPORT_DB.prepare(`
    UPDATE support_messages
    SET
      text = ?,
      source = 'deleted',
      deleted_at = ?,
      deleted_by_role = ?,
      deleted_by_label = ?
    WHERE session_id = ? AND message_id = ?
  `)
    .bind(deletedText, deletedAt, actorRole, message.authorLabel || '', sessionId, messageId)
    .run();

  await env.SUPPORT_DB.prepare(`
    UPDATE support_sessions
    SET
      updated_at = ?,
      last_message_at = ?,
      last_message_preview = ?
    WHERE session_id = ?
  `)
    .bind(deletedAt, deletedAt, deletedText, sessionId)
    .run();

  return true;
}

async function upsertPresence(env, sessionId, audience, typing = false) {
  const timestamp = nowIso();
  await env.SUPPORT_DB.prepare(`
    INSERT INTO support_presence (
      session_id, audience, last_seen_at, last_typing_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id, audience) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      last_typing_at = CASE
        WHEN excluded.last_typing_at IS NOT NULL THEN excluded.last_typing_at
        ELSE support_presence.last_typing_at
      END,
      updated_at = excluded.updated_at
  `)
    .bind(sessionId, audience, timestamp, typing ? timestamp : null, timestamp)
    .run();

  return getPresenceForSession(env, sessionId);
}

async function createOrReuseSession(request, env, identity = {}, meta = {}) {
  if (!identity.visitorId) {
    throw new Error('visitorId is required');
  }

  const existing = await getSessionByVisitor(env, identity.visitorId);
  if (existing) {
    await upsertPresence(env, existing.sessionId, 'visitor', false);
    return attachSessionPresence(env, existing);
  }

  const sessionId = uid('sess');
  const timestamp = nowIso();
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || '';
  const ipHash = ip ? await sha256Hex(`${env.VISITOR_HASH_SALT || ''}:${ip}`) : null;
  const displayName = identity.displayName || 'Гість';
  const shortLabel = identity.shortLabel || `#${String(identity.visitorId).slice(-4).toUpperCase()}`;

  await env.SUPPORT_DB.prepare(`
    INSERT INTO support_sessions (
      session_id, visitor_id, display_name, short_label, fingerprint, ip_hash,
      locale, user_agent, viewport, created_at, updated_at, last_message_at,
      last_message_preview, unread_operator_count, unread_visitor_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1)
  `)
    .bind(
      sessionId,
      identity.visitorId,
      displayName,
      shortLabel,
      identity.fingerprint || null,
      ipHash,
      meta.locale || null,
      meta.userAgent || null,
      meta.viewport || null,
      timestamp,
      timestamp,
      timestamp,
      'Новий діалог створено'
    )
    .run();

  await insertMessage(env, sessionId, 'support', 'Админ', 'Вітаю. Админ уже може відповісти з Telegram-панелі.', 'system');
  await upsertPresence(env, sessionId, 'visitor', false);
  return attachSessionPresence(env, await getSessionById(env, sessionId));
}

async function notifyOperators(env, session, message) {
  const chatIds = [...parseIds(env.TELEGRAM_OPERATOR_CHAT_IDS)];
  if (!chatIds.length || !env.TELEGRAM_BOT_TOKEN) return;

  const summary = [
    `Нове звернення ${session.shortLabel || ''}`.trim(),
    `Від: ${session.displayName || session.visitorId}`,
    '',
    message.text
  ].join('\n');

  await Promise.all(chatIds.map(chatId => telegramApi(env, 'sendMessage', {
    chat_id: Number(chatId),
    text: summary,
    reply_markup: {
      inline_keyboard: [[{
        text: 'Відкрити панель',
        web_app: { url: env.SUPPORT_WEBAPP_URL }
      }]]
    }
  })));
}

async function handleTelegramWebhook(request, env) {
  if (env.TELEGRAM_WEBHOOK_SECRET && request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TELEGRAM_WEBHOOK_SECRET) {
    return json({ error: 'Unauthorized' }, 401);
  }
  const update = await readBody(request);
  const incomingMessage = update.message;
  if (!incomingMessage) {
    return json({ ok: true });
  }

  const allowedIds = parseIds(env.TELEGRAM_OPERATOR_IDS);
  const fromId = String(incomingMessage.from && incomingMessage.from.id ? incomingMessage.from.id : '');
  if (allowedIds.size && !allowedIds.has(fromId)) {
    return json({ ok: true });
  }

  const text = String(incomingMessage.text || '').trim();
  if (/^\/(start|panel)/i.test(text)) {
    await telegramApi(env, 'sendMessage', {
      chat_id: incomingMessage.chat.id,
      text: 'Панель підтримки готова. Відкрий її кнопкою нижче.',
      reply_markup: {
        inline_keyboard: [[{
          text: 'Відкрити підтримку',
          web_app: { url: env.SUPPORT_WEBAPP_URL }
        }]]
      }
    });
  }

  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { headers: corsHeaders(env) }), env);
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === '/api/support/session' && request.method === 'POST') {
        const body = await readBody(request);
        const session = await createOrReuseSession(request, env, body.identity || {}, body.meta || {});
        return withCors(json({ session }), env);
      }

      const supportMessagesMatch = url.pathname.match(/^\/api\/support\/session\/([^/]+)\/messages$/);
      if (supportMessagesMatch && request.method === 'GET') {
        const sessionId = decodeURIComponent(supportMessagesMatch[1]);
        const session = await getSessionById(env, sessionId);
        if (!session) return withCors(json({ error: 'Session not found' }, 404), env);
        await markSessionRead(env, sessionId, 'visitor');
        const presence = await upsertPresence(env, sessionId, 'visitor', false);
        const messages = await listMessages(env, sessionId);
        const nextSession = await attachSessionPresence(env, await getSessionById(env, sessionId));
        const effects = await listEffectsForSession(env, sessionId, url.searchParams.get('after') || '');
        return withCors(json({ session: nextSession, messages, presence, effects }), env);
      }
      if (supportMessagesMatch && request.method === 'POST') {
        const sessionId = decodeURIComponent(supportMessagesMatch[1]);
        const session = await getSessionById(env, sessionId);
        if (!session) return withCors(json({ error: 'Session not found' }, 404), env);
        const body = await readBody(request);
        const text = sanitizeText(body.text || '');
        if (!text) return withCors(json({ error: 'Message text is required' }, 400), env);
        const authorLabel = body.identity && body.identity.displayName ? body.identity.displayName : session.displayName;
        const message = await insertMessage(env, sessionId, 'visitor', authorLabel, text, 'web');
        await updateSessionAfterMessage(env, sessionId, text, 'visitor');
        await upsertPresence(env, sessionId, 'visitor', false);
        const nextSession = await attachSessionPresence(env, await getSessionById(env, sessionId));
        await notifyOperators(env, nextSession, message);
        return withCors(json({ session: nextSession, message }, 201), env);
      }

      const supportDeleteMatch = url.pathname.match(/^\/api\/support\/session\/([^/]+)\/messages\/([^/]+)\/delete$/);
      if (supportDeleteMatch && request.method === 'POST') {
        const sessionId = decodeURIComponent(supportDeleteMatch[1]);
        const messageId = decodeURIComponent(supportDeleteMatch[2]);
        const session = await getSessionById(env, sessionId);
        if (!session) return withCors(json({ error: 'Session not found' }, 404), env);
        const deleted = await softDeleteMessage(env, sessionId, messageId, 'visitor');
        if (!deleted) return withCors(json({ error: 'Message not found' }, 404), env);
        return withCors(json({ ok: true }), env);
      }

      const supportPresenceMatch = url.pathname.match(/^\/api\/support\/session\/([^/]+)\/presence$/);
      if (supportPresenceMatch && request.method === 'POST') {
        const sessionId = decodeURIComponent(supportPresenceMatch[1]);
        const session = await getSessionById(env, sessionId);
        if (!session) return withCors(json({ error: 'Session not found' }, 404), env);
        const body = await readBody(request);
        const presence = await upsertPresence(env, sessionId, 'visitor', Boolean(body.typing));
        const effects = await listEffectsForSession(env, sessionId, body.lastEffectAt || '');
        return withCors(json({ presence, effects }), env);
      }

      if (url.pathname === '/api/operator/chats' && request.method === 'GET') {
        const operator = await requireOperator(request, env);
        if (!operator) return withCors(json({ error: 'Unauthorized' }, 401), env);
        const chats = await listSessions(env);
        return withCors(json({ chats }), env);
      }

      const operatorMessagesMatch = url.pathname.match(/^\/api\/operator\/chats\/([^/]+)\/messages$/);
      if (operatorMessagesMatch && request.method === 'GET') {
        const operator = await requireOperator(request, env);
        if (!operator) return withCors(json({ error: 'Unauthorized' }, 401), env);
        const sessionId = decodeURIComponent(operatorMessagesMatch[1]);
        const session = await getSessionById(env, sessionId);
        if (!session) return withCors(json({ error: 'Session not found' }, 404), env);
        await markSessionRead(env, sessionId, 'operator');
        const presence = await upsertPresence(env, sessionId, 'operator', false);
        const messages = await listMessages(env, sessionId);
        const nextSession = await attachSessionPresence(env, await getSessionById(env, sessionId));
        return withCors(json({ session: nextSession, messages, presence }), env);
      }

      const operatorReplyMatch = url.pathname.match(/^\/api\/operator\/chats\/([^/]+)\/reply$/);
      if (operatorReplyMatch && request.method === 'POST') {
        const operator = await requireOperator(request, env);
        if (!operator) return withCors(json({ error: 'Unauthorized' }, 401), env);
        const sessionId = decodeURIComponent(operatorReplyMatch[1]);
        const session = await getSessionById(env, sessionId);
        if (!session) return withCors(json({ error: 'Session not found' }, 404), env);
        const body = await readBody(request);
        const text = sanitizeText(body.text || '');
        if (!text) return withCors(json({ error: 'Message text is required' }, 400), env);
        const authorLabel = sanitizeText(body.authorLabel || '', 80) || 'Админ';
        const message = await insertMessage(env, sessionId, 'support', authorLabel, text, 'operator');
        await updateSessionAfterMessage(env, sessionId, text, 'support');
        await upsertPresence(env, sessionId, 'operator', false);
        const nextSession = await attachSessionPresence(env, await getSessionById(env, sessionId));
        return withCors(json({ session: nextSession, message }, 201), env);
      }

      const operatorDeleteMatch = url.pathname.match(/^\/api\/operator\/chats\/([^/]+)\/messages\/([^/]+)\/delete$/);
      if (operatorDeleteMatch && request.method === 'POST') {
        const operator = await requireOperator(request, env);
        if (!operator) return withCors(json({ error: 'Unauthorized' }, 401), env);
        const sessionId = decodeURIComponent(operatorDeleteMatch[1]);
        const messageId = decodeURIComponent(operatorDeleteMatch[2]);
        const session = await getSessionById(env, sessionId);
        if (!session) return withCors(json({ error: 'Session not found' }, 404), env);
        const deleted = await softDeleteMessage(env, sessionId, messageId, 'support');
        if (!deleted) return withCors(json({ error: 'Message not found' }, 404), env);
        return withCors(json({ ok: true }), env);
      }

      if (url.pathname === '/api/operator/presence' && request.method === 'POST') {
        const operator = await requireOperator(request, env);
        if (!operator) return withCors(json({ error: 'Unauthorized' }, 401), env);
        const body = await readBody(request);
        const activeSessionId = String(body.activeSessionId || '').trim();
        if (!activeSessionId) return withCors(json({ error: 'activeSessionId is required' }, 400), env);
        const session = await getSessionById(env, activeSessionId);
        if (!session) return withCors(json({ error: 'Session not found' }, 404), env);
        const presence = await upsertPresence(env, activeSessionId, 'operator', Boolean(body.typing));
        return withCors(json({ presence }), env);
      }

      if (url.pathname === '/api/operator/effects' && request.method === 'POST') {
        const operator = await requireOperator(request, env);
        if (!operator) return withCors(json({ error: 'Unauthorized' }, 401), env);
        const body = await readBody(request);
        const scope = body.scope === 'session' ? 'session' : 'all';
        const sessionId = scope === 'session' ? String(body.sessionId || '').trim() : null;
        if (scope === 'session' && !sessionId) {
          return withCors(json({ error: 'sessionId is required for session scope' }, 400), env);
        }
        if (sessionId) {
          const session = await getSessionById(env, sessionId);
          if (!session) return withCors(json({ error: 'Session not found' }, 404), env);
        }
        const effect = await createEffect(
          env,
          scope,
          sessionId,
          String(body.effectType || '').trim(),
          String(body.title || '').trim(),
          String(body.message || '').trim(),
          body.payload && typeof body.payload === 'object' ? body.payload : null
        );
        return withCors(json({ effect }, 201), env);
      }

      if (url.pathname === '/api/telegram/webhook' && request.method === 'POST') {
        return withCors(await handleTelegramWebhook(request, env), env);
      }

      return withCors(json({ error: 'Not found' }, 404), env);
    } catch (error) {
      return withCors(json({ error: 'Server error', detail: error.message }, 500), env);
    }
  }
};
