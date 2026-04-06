#!/usr/bin/env python3
import argparse
import json
import os
import re
import sqlite3
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get('SUPPORT_DB_PATH', ROOT / 'support-backend.db'))
SCHEMA_PATH = ROOT / 'support-schema.sql'
SITE_ORIGIN = os.environ.get('SUPPORT_SITE_ORIGIN', 'https://snapp-gonzhubas-town.github.io')
OPERATOR_TOKEN = os.environ.get('SUPPORT_OPERATOR_TOKEN', '').strip()
SYSTEM_AUTHOR = 'Админ'
SYSTEM_TEXT = 'Вітаю. Админ уже може відповісти з Telegram-панелі.'


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def uid(prefix):
    return f'{prefix}_{uuid.uuid4().hex}'


def sanitize_text(value, max_length=1200):
    return str(value or '').replace('\r', '').strip()[:max_length]


def empty_presence():
    return {'visitor': None, 'operator': None}


def connect():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON')
    conn.execute('PRAGMA journal_mode = WAL')
    return conn


def init_db():
    schema = SCHEMA_PATH.read_text(encoding='utf-8')
    with connect() as conn:
        conn.executescript(schema)


def row_to_dict(row):
    return dict(row) if row is not None else None


def session_select_sql(where_clause=''):
    return f'''
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
        {where_clause}
    '''


def get_session_by_id(conn, session_id):
    return row_to_dict(
        conn.execute(session_select_sql('WHERE session_id = ?'), (session_id,)).fetchone()
    )


def get_session_by_visitor(conn, visitor_id):
    return row_to_dict(
        conn.execute(session_select_sql('WHERE visitor_id = ?'), (visitor_id,)).fetchone()
    )


def list_messages(conn, session_id):
    rows = conn.execute(
        '''
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
        ''',
        (session_id,),
    ).fetchall()
    return [dict(row) for row in rows]


def get_presence_map(conn, session_ids):
    if not session_ids:
        return {}
    placeholders = ', '.join('?' for _ in session_ids)
    rows = conn.execute(
        f'''
        SELECT
          session_id AS sessionId,
          audience,
          last_seen_at AS lastSeenAt,
          last_typing_at AS lastTypingAt
        FROM support_presence
        WHERE session_id IN ({placeholders})
        ''',
        tuple(session_ids),
    ).fetchall()
    result = {session_id: empty_presence() for session_id in session_ids}
    for row in rows:
        entry = result.setdefault(row['sessionId'], empty_presence())
        entry[row['audience']] = {
            'lastSeenAt': row['lastSeenAt'],
            'lastTypingAt': row['lastTypingAt'],
        }
    return result


def get_presence_for_session(conn, session_id):
    return get_presence_map(conn, [session_id]).get(session_id, empty_presence())


def attach_session_presence(conn, session):
    if not session:
        return None
    payload = dict(session)
    payload['presence'] = get_presence_for_session(conn, session['sessionId'])
    return payload


def list_sessions(conn):
    rows = conn.execute(f'{session_select_sql()} ORDER BY last_message_at DESC').fetchall()
    sessions = [dict(row) for row in rows]
    presence_map = get_presence_map(conn, [session['sessionId'] for session in sessions])
    for session in sessions:
        session['presence'] = presence_map.get(session['sessionId'], empty_presence())
    return sessions


def list_effects_for_session(conn, session_id, after=''):
    cursor = after or '1970-01-01T00:00:00Z'
    rows = conn.execute(
        '''
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
        ''',
        (cursor, session_id),
    ).fetchall()
    effects = []
    for row in rows:
        effect = dict(row)
        effect['payload'] = json.loads(effect['payload']) if effect['payload'] else None
        effects.append(effect)
    return effects


def upsert_presence(conn, session_id, audience, typing=False):
    timestamp = now_iso()
    conn.execute(
        '''
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
        ''',
        (session_id, audience, timestamp, timestamp if typing else None, timestamp),
    )
    return get_presence_for_session(conn, session_id)


def insert_message(conn, session_id, role, author_label, text, source='web'):
    message = {
        'messageId': uid('msg'),
        'sessionId': session_id,
        'role': role,
        'authorLabel': sanitize_text(author_label, 80) or SYSTEM_AUTHOR,
        'text': sanitize_text(text),
        'source': source,
        'createdAt': now_iso(),
    }
    conn.execute(
        '''
        INSERT INTO support_messages (
          message_id, session_id, role, author_label, text, source, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ''',
        (
            message['messageId'],
            message['sessionId'],
            message['role'],
            message['authorLabel'],
            message['text'],
            message['source'],
            message['createdAt'],
        ),
    )
    return message


def update_session_after_message(conn, session_id, text, speaker):
    timestamp = now_iso()
    preview = sanitize_text(text, 200)
    if speaker == 'visitor':
        unread_sql = 'unread_operator_count = unread_operator_count + 1'
    elif speaker == 'support':
        unread_sql = 'unread_visitor_count = unread_visitor_count + 1, unread_operator_count = 0'
    else:
        unread_sql = 'unread_operator_count = unread_operator_count'
    conn.execute(
        f'''
        UPDATE support_sessions
        SET
          updated_at = ?,
          last_message_at = ?,
          last_message_preview = ?,
          {unread_sql}
        WHERE session_id = ?
        ''',
        (timestamp, timestamp, preview, session_id),
    )


def mark_session_read(conn, session_id, audience):
    column = 'unread_operator_count' if audience == 'operator' else 'unread_visitor_count'
    conn.execute(
        f'UPDATE support_sessions SET {column} = 0, updated_at = ? WHERE session_id = ?',
        (now_iso(), session_id),
    )


def soft_delete_message(conn, session_id, message_id, actor_role):
    row = conn.execute(
        '''
        SELECT
          message_id AS messageId,
          role,
          author_label AS authorLabel,
          source,
          deleted_at AS deletedAt
        FROM support_messages
        WHERE session_id = ? AND message_id = ?
        ''',
        (session_id, message_id),
    ).fetchone()
    if not row or row['deletedAt'] or row['source'] == 'system':
        return False
    if actor_role == 'visitor' and row['role'] != 'visitor':
        return False
    if actor_role == 'support' and row['role'] != 'support':
        return False

    deleted_at = now_iso()
    actor_text = 'користувач' if row['role'] == 'visitor' else 'админ'
    deleted_text = f"{actor_text} {(row['authorLabel'] or 'без імені').strip()} видалив повідомлення"
    conn.execute(
        '''
        UPDATE support_messages
        SET
          text = ?,
          source = 'deleted',
          deleted_at = ?,
          deleted_by_role = ?,
          deleted_by_label = ?
        WHERE session_id = ? AND message_id = ?
        ''',
        (deleted_text, deleted_at, actor_role, row['authorLabel'] or '', session_id, message_id),
    )
    conn.execute(
        '''
        UPDATE support_sessions
        SET
          updated_at = ?,
          last_message_at = ?,
          last_message_preview = ?
        WHERE session_id = ?
        ''',
        (deleted_at, deleted_at, deleted_text, session_id),
    )
    return True


def create_effect(conn, scope, session_id, effect_type, title, message, payload):
    effect = {
        'effectId': uid('fx'),
        'sessionId': session_id if scope == 'session' else None,
        'scope': scope,
        'effectType': sanitize_text(effect_type, 40),
        'title': sanitize_text(title, 120),
        'message': sanitize_text(message, 240),
        'payload': payload if isinstance(payload, dict) else None,
        'createdAt': now_iso(),
    }
    conn.execute(
        '''
        INSERT INTO support_effects (
          effect_id, session_id, scope, effect_type, title, message, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ''',
        (
            effect['effectId'],
            effect['sessionId'],
            effect['scope'],
            effect['effectType'],
            effect['title'],
            effect['message'],
            json.dumps(effect['payload'], ensure_ascii=False) if effect['payload'] else None,
            effect['createdAt'],
        ),
    )
    return effect


def create_or_reuse_session(conn, identity, meta):
    visitor_id = str((identity or {}).get('visitorId') or '').strip()
    if not visitor_id:
        raise ValueError('visitorId is required')

    existing = get_session_by_visitor(conn, visitor_id)
    if existing:
        upsert_presence(conn, existing['sessionId'], 'visitor', False)
        return attach_session_presence(conn, get_session_by_id(conn, existing['sessionId']))

    short_label = str((identity or {}).get('shortLabel') or '').strip()
    if not short_label:
        short_label = f"#{visitor_id[-4:].upper()}"
    display_name = sanitize_text((identity or {}).get('displayName') or '', 80) or f'Гість {short_label.lstrip("#")}'
    timestamp = now_iso()
    session_id = uid('sess')
    conn.execute(
        '''
        INSERT INTO support_sessions (
          session_id, visitor_id, display_name, short_label, fingerprint, ip_hash,
          locale, user_agent, viewport, created_at, updated_at, last_message_at, last_message_preview
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''',
        (
            session_id,
            visitor_id,
            display_name,
            short_label,
            (identity or {}).get('fingerprint') or '',
            '',
            (meta or {}).get('locale') or '',
            (meta or {}).get('userAgent') or '',
            (meta or {}).get('viewport') or '',
            timestamp,
            timestamp,
            timestamp,
            'На сайті зараз · ще не писав',
        ),
    )
    insert_message(conn, session_id, 'support', SYSTEM_AUTHOR, SYSTEM_TEXT, 'system')
    upsert_presence(conn, session_id, 'visitor', False)
    return attach_session_presence(conn, get_session_by_id(conn, session_id))


class SupportHandler(BaseHTTPRequestHandler):
    server_version = 'SupportBackend/0.1'

    def log_message(self, format_str, *args):
        return

    def allowed_origin(self):
        origin = self.headers.get('Origin', '')
        if origin == SITE_ORIGIN:
            return origin
        return SITE_ORIGIN or '*'

    def send_cors_headers(self):
        self.send_header('Access-Control-Allow-Origin', self.allowed_origin())
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Telegram-Init-Data')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')

    def json_response(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_cors_headers()
        self.send_header('Content-Type', 'application/json; charset=UTF-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get('Content-Length', '0') or '0')
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        if not raw:
            return {}
        try:
            return json.loads(raw.decode('utf-8'))
        except json.JSONDecodeError:
            return {}

    def is_operator(self):
        bearer = self.headers.get('Authorization', '').strip()
        if OPERATOR_TOKEN and bearer == f'Bearer {OPERATOR_TOKEN}':
            return True
        return bool(self.headers.get('X-Telegram-Init-Data', '').strip())

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == '/health':
            self.json_response(200, {'ok': True, 'time': now_iso()})
            return

        support_messages_match = re.fullmatch(r'/api/support/session/([^/]+)/messages', parsed.path)
        operator_chat_messages_match = re.fullmatch(r'/api/operator/chats/([^/]+)/messages', parsed.path)

        try:
            with connect() as conn:
                if support_messages_match:
                    session_id = support_messages_match.group(1)
                    session = get_session_by_id(conn, session_id)
                    if not session:
                        self.json_response(404, {'error': 'Session not found'})
                        return
                    mark_session_read(conn, session_id, 'visitor')
                    presence = upsert_presence(conn, session_id, 'visitor', False)
                    messages = list_messages(conn, session_id)
                    session = attach_session_presence(conn, get_session_by_id(conn, session_id))
                    after = parse_qs(parsed.query).get('after', [''])[0]
                    effects = list_effects_for_session(conn, session_id, after)
                    conn.commit()
                    self.json_response(200, {'session': session, 'messages': messages, 'presence': presence, 'effects': effects})
                    return

                if parsed.path == '/api/operator/chats':
                    if not self.is_operator():
                        self.json_response(401, {'error': 'Unauthorized'})
                        return
                    self.json_response(200, {'chats': list_sessions(conn)})
                    return

                if operator_chat_messages_match:
                    if not self.is_operator():
                        self.json_response(401, {'error': 'Unauthorized'})
                        return
                    session_id = operator_chat_messages_match.group(1)
                    session = get_session_by_id(conn, session_id)
                    if not session:
                        self.json_response(404, {'error': 'Session not found'})
                        return
                    mark_session_read(conn, session_id, 'operator')
                    presence = upsert_presence(conn, session_id, 'operator', False)
                    messages = list_messages(conn, session_id)
                    session = attach_session_presence(conn, get_session_by_id(conn, session_id))
                    conn.commit()
                    self.json_response(200, {'session': session, 'messages': messages, 'presence': presence})
                    return

                self.json_response(404, {'error': 'Not found'})
        except Exception as error:
            self.json_response(500, {'error': str(error)})

    def do_POST(self):
        parsed = urlparse(self.path)
        body = self.read_json()

        support_messages_match = re.fullmatch(r'/api/support/session/([^/]+)/messages', parsed.path)
        support_delete_match = re.fullmatch(r'/api/support/session/([^/]+)/messages/([^/]+)/delete', parsed.path)
        support_presence_match = re.fullmatch(r'/api/support/session/([^/]+)/presence', parsed.path)
        operator_reply_match = re.fullmatch(r'/api/operator/chats/([^/]+)/reply', parsed.path)
        operator_delete_match = re.fullmatch(r'/api/operator/chats/([^/]+)/messages/([^/]+)/delete', parsed.path)

        try:
            with connect() as conn:
                if parsed.path == '/api/support/session':
                    session = create_or_reuse_session(conn, body.get('identity') or {}, body.get('meta') or {})
                    conn.commit()
                    self.json_response(200, {'session': session})
                    return

                if support_messages_match:
                    session_id = support_messages_match.group(1)
                    session = get_session_by_id(conn, session_id)
                    if not session:
                        self.json_response(404, {'error': 'Session not found'})
                        return
                    text = sanitize_text(body.get('text') or '')
                    if not text:
                        self.json_response(400, {'error': 'Message text is required'})
                        return
                    author = sanitize_text(((body.get('identity') or {}).get('displayName') or session['displayName']), 80)
                    message = insert_message(conn, session_id, 'visitor', author, text, 'web')
                    update_session_after_message(conn, session_id, text, 'visitor')
                    upsert_presence(conn, session_id, 'visitor', False)
                    session = attach_session_presence(conn, get_session_by_id(conn, session_id))
                    conn.commit()
                    self.json_response(201, {'session': session, 'message': message})
                    return

                if support_delete_match:
                    session_id, message_id = support_delete_match.groups()
                    if not get_session_by_id(conn, session_id):
                        self.json_response(404, {'error': 'Session not found'})
                        return
                    deleted = soft_delete_message(conn, session_id, message_id, 'visitor')
                    if not deleted:
                        self.json_response(404, {'error': 'Message not found'})
                        return
                    conn.commit()
                    self.json_response(200, {'ok': True})
                    return

                if support_presence_match:
                    session_id = support_presence_match.group(1)
                    if not get_session_by_id(conn, session_id):
                        self.json_response(404, {'error': 'Session not found'})
                        return
                    presence = upsert_presence(conn, session_id, 'visitor', bool(body.get('typing')))
                    effects = list_effects_for_session(conn, session_id, body.get('lastEffectAt') or '')
                    conn.commit()
                    self.json_response(200, {'presence': presence, 'effects': effects})
                    return

                if parsed.path == '/api/operator/presence':
                    if not self.is_operator():
                        self.json_response(401, {'error': 'Unauthorized'})
                        return
                    session_id = str(body.get('activeSessionId') or '').strip()
                    if not session_id:
                        self.json_response(400, {'error': 'activeSessionId is required'})
                        return
                    if not get_session_by_id(conn, session_id):
                        self.json_response(404, {'error': 'Session not found'})
                        return
                    presence = upsert_presence(conn, session_id, 'operator', bool(body.get('typing')))
                    conn.commit()
                    self.json_response(200, {'presence': presence})
                    return

                if operator_reply_match:
                    if not self.is_operator():
                        self.json_response(401, {'error': 'Unauthorized'})
                        return
                    session_id = operator_reply_match.group(1)
                    if not get_session_by_id(conn, session_id):
                        self.json_response(404, {'error': 'Session not found'})
                        return
                    text = sanitize_text(body.get('text') or '')
                    if not text:
                        self.json_response(400, {'error': 'Message text is required'})
                        return
                    author = sanitize_text(body.get('authorLabel') or SYSTEM_AUTHOR, 80) or SYSTEM_AUTHOR
                    message = insert_message(conn, session_id, 'support', author, text, 'operator')
                    update_session_after_message(conn, session_id, text, 'support')
                    upsert_presence(conn, session_id, 'operator', False)
                    session = attach_session_presence(conn, get_session_by_id(conn, session_id))
                    conn.commit()
                    self.json_response(201, {'session': session, 'message': message})
                    return

                if operator_delete_match:
                    if not self.is_operator():
                        self.json_response(401, {'error': 'Unauthorized'})
                        return
                    session_id, message_id = operator_delete_match.groups()
                    if not get_session_by_id(conn, session_id):
                        self.json_response(404, {'error': 'Session not found'})
                        return
                    deleted = soft_delete_message(conn, session_id, message_id, 'support')
                    if not deleted:
                        self.json_response(404, {'error': 'Message not found'})
                        return
                    conn.commit()
                    self.json_response(200, {'ok': True})
                    return

                if parsed.path == '/api/operator/effects':
                    if not self.is_operator():
                        self.json_response(401, {'error': 'Unauthorized'})
                        return
                    scope = 'session' if body.get('scope') == 'session' else 'all'
                    session_id = str(body.get('sessionId') or '').strip() if scope == 'session' else None
                    if scope == 'session' and not session_id:
                        self.json_response(400, {'error': 'sessionId is required for session scope'})
                        return
                    if session_id and not get_session_by_id(conn, session_id):
                        self.json_response(404, {'error': 'Session not found'})
                        return
                    effect = create_effect(
                        conn,
                        scope,
                        session_id,
                        body.get('effectType') or '',
                        body.get('title') or '',
                        body.get('message') or '',
                        body.get('payload') if isinstance(body.get('payload'), dict) else None,
                    )
                    conn.commit()
                    self.json_response(201, {'effect': effect})
                    return

                self.json_response(404, {'error': 'Not found'})
        except ValueError as error:
            self.json_response(400, {'error': str(error)})
        except Exception as error:
            self.json_response(500, {'error': str(error)})


def main():
    parser = argparse.ArgumentParser(description='Temporary support backend')
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8788)
    args = parser.parse_args()

    init_db()
    server = ThreadingHTTPServer((args.host, args.port), SupportHandler)
    print(f'support-backend listening on http://{args.host}:{args.port}', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
