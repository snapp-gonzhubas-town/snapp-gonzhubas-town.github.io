const encoder = new TextEncoder();

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

function sanitizeText(value = '') {
  return String(value)
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .trim()
    .slice(0, 1200);
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

async function listSessions(env) {
  const result = await env.SUPPORT_DB.prepare(`${sessionSelectSql('')} ORDER BY last_message_at DESC`).all();
  return result.results || [];
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
      created_at AS createdAt
    FROM support_messages
    WHERE session_id = ?
    ORDER BY created_at ASC
  `).bind(sessionId).all();
  return result.results || [];
}

async function insertMessage(env, sessionId, role, authorLabel, text, source = 'web') {
  const message = {
    messageId: uid('msg'),
    sessionId,
    role,
    authorLabel,
    text,
    source,
    createdAt: new Date().toISOString()
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

  const timestamp = new Date().toISOString();
  await env.SUPPORT_DB.prepare(sql).bind(timestamp, timestamp, text, sessionId).run();
}

async function markSessionRead(env, sessionId, audience) {
  const sql = audience === 'operator'
    ? 'UPDATE support_sessions SET unread_operator_count = 0 WHERE session_id = ?'
    : 'UPDATE support_sessions SET unread_visitor_count = 0 WHERE session_id = ?';
  await env.SUPPORT_DB.prepare(sql).bind(sessionId).run();
}

async function createOrReuseSession(request, env, identity = {}, meta = {}) {
  if (!identity.visitorId) {
    throw new Error('visitorId is required');
  }

  const existing = await getSessionByVisitor(env, identity.visitorId);
  if (existing) return existing;

  const sessionId = uid('sess');
  const timestamp = new Date().toISOString();
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

  await insertMessage(env, sessionId, 'support', 'Підтримка АКК', 'Вітаю. Оператор уже може відповісти з Telegram-панелі.', 'system');
  return getSessionById(env, sessionId);
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
        const messages = await listMessages(env, sessionId);
        const nextSession = await getSessionById(env, sessionId);
        return withCors(json({ session: nextSession, messages }), env);
      }
      if (supportMessagesMatch && request.method === 'POST') {
        const sessionId = decodeURIComponent(supportMessagesMatch[1]);
        const session = await getSessionById(env, sessionId);
        if (!session) return withCors(json({ error: 'Session not found' }, 404), env);
        const body = await readBody(request);
        const text = sanitizeText(body.text || '');
        if (!text) return withCors(json({ error: 'Message text is required' }, 400), env);
        const message = await insertMessage(env, sessionId, 'visitor', body.identity && body.identity.displayName ? body.identity.displayName : session.displayName, text, 'web');
        await updateSessionAfterMessage(env, sessionId, text, 'visitor');
        const nextSession = await getSessionById(env, sessionId);
        await notifyOperators(env, nextSession, message);
        return withCors(json({ session: nextSession, message }, 201), env);
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
        const messages = await listMessages(env, sessionId);
        const nextSession = await getSessionById(env, sessionId);
        return withCors(json({ session: nextSession, messages }), env);
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
        const authorLabel = body.authorLabel || operator.first_name || 'Оператор';
        const message = await insertMessage(env, sessionId, 'support', authorLabel, text, 'operator');
        await updateSessionAfterMessage(env, sessionId, text, 'support');
        const nextSession = await getSessionById(env, sessionId);
        return withCors(json({ session: nextSession, message }, 201), env);
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
