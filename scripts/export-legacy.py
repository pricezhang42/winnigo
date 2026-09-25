"""Read-only D1 SQLite export. Operate on an authorized downloaded/local copy."""
import argparse,json,pathlib,sqlite3,hashlib
p=argparse.ArgumentParser();p.add_argument('--database',required=True);p.add_argument('--output',required=True);p.add_argument('--photos-dir');a=p.parse_args()
out=pathlib.Path(a.output);out.mkdir(parents=True,exist_ok=True,mode=0o700)
if (out/'manifest.json').exists():raise SystemExit('Choose a new export directory; existing export will not be overwritten.')
conn=sqlite3.connect(pathlib.Path(a.database).resolve().as_uri()+'?mode=ro',uri=True);conn.row_factory=sqlite3.Row
records=[{'id':r['id'],'source':r['source'],'payload':json.loads(r['payload']),'hidden':bool(r['hidden']),'override':json.loads(r['override']) if r['override'] else {}} for r in conn.execute('SELECT * FROM listings')]
sources=[{'id':r['id'],'checkedAt':r['checked_at'],'attemptedAt':r['attempted_at'],'count':r['count'],'status':r['status'],'error':r['error']} for r in conn.execute('SELECT * FROM sources')];conn.close()
media={}
for r in records:
 for url in (r['payload'].get('images') or [])+[r['payload'].get('image','')]+(r['override'].get('images') or [])+[r['override'].get('image','')]:
  if not url.startswith('/api/photos/'):continue
  id=url.split('/')[-1]
  if len(id)!=64 or any(c not in '0123456789abcdef' for c in id):raise SystemExit('Invalid stored photo ID')
  media[id]={'id':id,'file':'photos/'+id}
if a.photos_dir:
 (out/'photos').mkdir(exist_ok=True,mode=0o700)
 for m in media.values():
  data=(pathlib.Path(a.photos_dir)/m['id']).read_bytes()
  if hashlib.sha256(data).hexdigest()!=m['id']:raise SystemExit('Photo hash mismatch')
  mime='image/png' if data.startswith(b'\x89PNG') else 'image/jpeg' if data.startswith(b'\xff\xd8\xff') else 'image/webp' if data[:4]==b'RIFF' and data[8:12]==b'WEBP' else None
  if mime is None:raise SystemExit('Unsupported legacy photo format')
  (out/m['file']).write_bytes(data);(out/m['file']).chmod(0o600);m.update(size=len(data),contentType=mime)
manifest={'version':1,'listings':records,'sources':sources,'media':list(media.values())}
(out/'manifest.json').write_text(json.dumps(manifest));(out/'manifest.json').chmod(0o600)
print(json.dumps({'listings':len(records),'sources':len(sources),'photos':len(media),'photosComplete':bool(a.photos_dir) or not media}))
