"""Read only explicitly selected, non-secret SOP recording columns."""
import json
import sqlite3
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')
database_path, action, argument = sys.argv[1:]
connection = sqlite3.connect(Path(database_path).resolve().as_uri() + '?mode=ro', uri=True)
connection.row_factory = sqlite3.Row
columns = '''recording_id AS recordingId, workspace_id AS workspaceId,
    session_id AS sessionId, sop_id AS sopId, source_message_id AS sourceContextMessageId,
    stop_message_id AS stopMessageId, status, created_at AS createdAt,
    step_info_file_path AS stepInfoFilePath, artifact_completed_at AS artifactCompletedAt,
    terminal_cause_code AS terminalCauseCode'''
try:
    connection.execute('BEGIN')
    if action == 'baseline':
        rows = connection.execute('SELECT recording_id AS id, status FROM recordings').fetchall()
        value = {'ids': [r['id'] for r in rows], 'active': [r['id'] for r in rows if r['status'] == 'active']}
    elif action == 'discover':
        context = json.loads(argument)
        value = [dict(r) for r in connection.execute(
            f'SELECT {columns} FROM recordings WHERE workspace_id = ? AND session_id = ? ORDER BY created_at',
            (context['workspaceId'], context['sessionId']))]
    elif action == 'binding':
        row = connection.execute(f'SELECT {columns} FROM recordings WHERE recording_id = ?', (argument,)).fetchone()
        if row is None:
            raise ValueError('Registered recording is absent from the actual runtime database')
        value = dict(row)
        value['deliveries'] = [dict(r) for r in connection.execute('''SELECT status,
            created_at AS receivedAt, accepted_at AS acceptedAt,
            message_id AS messageId, engine_message_id AS engineMessageId
            FROM recording_event_deliveries WHERE recording_id = ? ORDER BY created_at, rowid''', (argument,))]
    else:
        raise ValueError('Unknown read action')
    print(json.dumps(value, ensure_ascii=False))
finally:
    connection.close()
