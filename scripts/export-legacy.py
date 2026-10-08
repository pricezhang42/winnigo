"""Read-only D1 SQLite export. Operate on an authorized downloaded/local copy."""

import argparse, json, pathlib, sqlite3, hashlib

parser = argparse.ArgumentParser()
parser.add_argument('--database', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--photos-dir')
args = parser.parse_args()
out = pathlib.Path(args.output)
out.mkdir(parents=True, exist_ok=True, mode=0o700)
if (out / 'manifest.json').exists():
    raise SystemExit('Choose a new export directory; existing export will not be overwritten.')
conn = sqlite3.connect(pathlib.Path(args.database).resolve().as_uri() + '?mode=ro', uri=True)
conn.row_factory = sqlite3.Row
records = [
    {
        'id': row['id'],
        'source': row['source'],
        'payload': json.loads(row['payload']),
        'hidden': bool(row['hidden']),
        'override': json.loads(row['override']) if row['override'] else {},
    }
    for row in conn.execute('SELECT * FROM listings')
]
sources = [
    {
        'id': row['id'],
        'checkedAt': row['checked_at'],
        'attemptedAt': row['attempted_at'],
        'count': row['count'],
        'status': row['status'],
        'error': row['error'],
    }
    for row in conn.execute('SELECT * FROM sources')
]
conn.close()
media = {}
for row in records:
    for url in (
        (row['payload'].get('images') or [])
        + [row['payload'].get('image', '')]
        + (row['override'].get('images') or [])
        + [row['override'].get('image', '')]
    ):
        if not url.startswith('/api/photos/'):
            continue
        id = url.split('/')[-1]
        if len(id) != 64 or any(char not in '0123456789abcdef' for char in id):
            raise SystemExit('Invalid stored photo ID')
        media[id] = {'id': id, 'file': 'photos/' + id}
if args.photos_dir:
    (out / 'photos').mkdir(exist_ok=True, mode=0o700)
    for photo in media.values():
        data = (pathlib.Path(args.photos_dir) / photo['id']).read_bytes()
        if hashlib.sha256(data).hexdigest() != photo['id']:
            raise SystemExit('Photo hash mismatch')
        mime = (
            'image/png'
            if data.startswith(b'\x89PNG')
            else 'image/jpeg'
            if data.startswith(b'\xff\xd8\xff')
            else 'image/webp'
            if data[:4] == b'RIFF' and data[8:12] == b'WEBP'
            else None
        )
        if mime is None:
            raise SystemExit('Unsupported legacy photo format')
        (out / photo['file']).write_bytes(data)
        (out / photo['file']).chmod(0o600)
        photo.update(size=len(data), contentType=mime)
manifest = {'version': 1, 'listings': records, 'sources': sources, 'media': list(media.values())}
(out / 'manifest.json').write_text(json.dumps(manifest))
(out / 'manifest.json').chmod(0o600)
print(
    json.dumps(
        {
            'listings': len(records),
            'sources': len(sources),
            'photos': len(media),
            'photosComplete': bool(args.photos_dir) or not media,
        }
    )
)
