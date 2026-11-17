"""Per-request identity; resource ownership follows the immutable session relation."""
from contextvars import ContextVar
from ..services import ServiceError

principal = ContextVar('principal', default=None)
# Fixed SQL identifiers only; never interpolate user-supplied identifiers.
RESOURCES = {
    'session_id': ('sessions', 'id'),
    'model_id': ('models', 'id'),
    'run_id': ('runs', 'run_id'),
    'generation_id': ('codegen_generations', 'generation_id'),
    'test_run_id': ('codegen_test_runs', 'test_run_id'),
    'snapshot_id': ('repository_snapshots', 'id'),
    'source_id': ('sources', 'id'),
    'image_id': ('image_sources', 'id'),
}

def require_owner(store, kind, value, user=None):
    user = user or principal.get()
    if user is None:
        raise ServiceError(401, 'AUTH_REQUIRED', 'Authentication required')
    table, key = RESOURCES[kind]
    join = '' if table == 'sessions' else f' JOIN sessions s ON s.id=r.session_id'
    owner = 'r.owner_id' if table == 'sessions' else 's.owner_id'
    with store.transaction() as c:
        row = c.execute(f'SELECT 1 FROM {table} r{join} WHERE r.{key}=? AND {owner}=?', (value,user['id'])).fetchone()
    if row is None:
        raise ServiceError(404, 'NOT_FOUND', 'Resource not found')


def assign_legacy(store, email):
    """Administrative, explicit one-way assignment of unowned local data."""
    with store.transaction(write=True) as c:
        user = c.execute('SELECT id FROM users WHERE email=?',(email.casefold(),)).fetchone()
        if user is None:
            raise ValueError('Register the target account before assigning legacy data')
        return c.execute('UPDATE sessions SET owner_id=? WHERE owner_id IS NULL',(user[0],)).rowcount
