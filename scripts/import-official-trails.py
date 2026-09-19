#!/usr/bin/env python3
"""Import the public exports of both maps linked by Trails Manitoba."""
import concurrent.futures
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import urllib.request
import xml.etree.ElementTree as ET

MAPS = {'Summer': '19DNqGXcQFtHyzbrP7YwLKv8_Wf-Gtkgy', 'Winter': '1HftjxykHeG_JOTFXC2vQIMpUBMeOLY1h'}
SOURCE = 'https://www.trailsmanitoba.ca/trail-info/hiking-trails-manitoba-maps/'
NS = {'k': 'http://www.opengis.net/kml/2.2'}
ROOT = Path(__file__).resolve().parents[1]

def clean(value):
    return ' '.join((value or '').split())

def categories(text):
    result = []
    if re.search(r'hik|walk|portage', text, re.I): result.append('Hiking')
    if re.search(r'bik|cycl', text, re.I): result.append('Cycling')
    if re.search(r'ski|snow|sled|skat', text, re.I): result.append('Winter sports')
    if re.search(r'paddl|canoe|kayak|sup|water', text, re.I): result.append('Water activities')
    return result or ['Outdoors']

def fetch_map(entry):
    season, mid = entry
    url = 'https://www.google.com/maps/d/kml?mid=' + mid + '&forcekml=1'
    with urllib.request.urlopen(url, timeout=45) as response:
        raw = response.read(20_000_001)
    if len(raw)>20_000_000: raise ValueError('Unexpected map size')
    root = ET.fromstring(raw)
    placemarks = root.findall('.//k:Placemark', NS)
    if not placemarks: raise ValueError('Map export contains no trails')
    return season, mid, placemarks

def main():
    now = datetime.now(timezone.utc).isoformat()
    records, counts = {}, {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        exports = list(pool.map(fetch_map, MAPS.items()))
    for season, mid, placemarks in exports:
        counts[season] = len(placemarks)
        for p in placemarks:
            name = clean(p.findtext('k:name', namespaces=NS))
            values = {clean(x.get('name')): clean(x.findtext('k:value', namespaces=NS)) for x in p.findall('k:ExtendedData/k:Data', NS)}
            coordinate = p.findtext('.//k:Point/k:coordinates', namespaces=NS)
            if not name or not coordinate: raise ValueError('A map entry lacks a name or point')
            lon, lat = [float(v) for v in coordinate.strip().split(',')[:2]]
            if not (-180<=lon<=180 and -90<=lat<=90) or (lat==0 and lon==0): raise ValueError('Invalid coordinate for '+name)
            key = re.sub(r'[^a-z0-9]', '', name.lower()) + f'|{lat:.7f},{lon:.7f}'
            record = records.setdefault(key, {'name':name,'position':[lat,lon],'variants':[]})
            variant = {'season':season,'url':f'https://www.google.com/maps/d/viewer?mid={mid}&ll={lat},{lon}&z=14','location':values.get('Location',''),'region':values.get('Region',''),'primaryActivity':values.get('Primary Activity Type',''),'otherUses':values.get('Other Popular Uses',''),'distance':values.get('Trail Distance (km)',''),'difficultyLevel':values.get('Hiking Difficulty Level',''),'trailType':values.get('Trail Type',''),'considerations':values.get('Considerations',''),'prohibitedActivities':values.get('Prohibited Activities','')}
            if variant not in record['variants']:record['variants'].append(variant)
    items = []
    for key,r in records.items():
        variants=r['variants'];v=variants[0]
        activity_categories=list(dict.fromkeys(c for x in variants for c in categories(x['primaryActivity']+', '+x['otherUses'])))
        distances=set(x['distance'] for x in variants if x['distance'])
        try:distance=float(next(iter(distances))) if len(distances)==1 else None
        except ValueError:distance=None
        if distance is not None and distance<=0:distance=None
        levels=set(x['difficultyLevel'] for x in variants if x['difficultyLevel'])
        difficulty='Unknown'
        if len(levels)==1:
            level=float(next(iter(levels)))
            if level in [1,2,3,4]:difficulty=f'Level {int(level)} / 4'
        seasons=list(dict.fromkeys(x['season'] for x in variants))
        id='official-'+hashlib.sha256(key.encode()).hexdigest()[:24]
        location=v['location'] or r['name']
        description=f"Listed by Trails Manitoba in the {' and '.join(seasons).lower()} maps."
        if v['primaryActivity']:description+=' Primary activity: '+v['primaryActivity']+'.'
        if v['otherUses']:description+=' Other listed uses: '+v['otherUses']+'.'
        if v['trailType']:description+=' Route type: '+v['trailType']+'.'
        items.append({'id':id,'title':r['name'],'type':'Activity','category':categories(v['primaryActivity'])[0],'activityCategories':activity_categories,'collection':'Official Trails','venue':location,'address':location,'neighbourhood':(v['region'] or 'Manitoba')+' region','time':'','image':'','images':[],'url':v['url'],'source':'trails-manitoba','sourceName':'Trails Manitoba','checkedAt':now,'price':None,'family':False,'indoor':False,'description':description,'schedule':'seasonal','status':'active','distanceKm':distance,'difficulty':difficulty,'provenance':'official','seasons':seasons,'trailVariants':variants,'mapLocation':{'id':id,'title':r['name'],'position':r['position'],'locationKind':'Source map location','lines':[],'sources':list(dict.fromkeys(x['url'] for x in variants)),'geometryNote':'Point supplied by Trails Manitoba; a full route is not included in their export.'}})
    items.sort(key=lambda x:x['title'].casefold())
    output={'source':{'id':'trails-manitoba','name':'Trails Manitoba · Official Trails','url':SOURCE,'checkedAt':now,'count':len(items),'status':'ok'},'rawCounts':counts,'items':items}
    path=ROOT/'lib/data/official-trails.json'
    path.write_text(json.dumps(output,ensure_ascii=False,separators=(',',':'))+'\n')
    anchors=[]
    for name,match in [('Lake Minnewasta Loop','Lake Minnewasta'),('Little Steep Rock Trail','Little Steep Rock')]:
        item=next(i for i in items if i['title']==name)
        anchors.append({**item['mapLocation'],'match':match})
    (ROOT/'lib/data/trail-map-anchors.json').write_text(json.dumps(anchors,ensure_ascii=False,separators=(',',':'))+'\n')
    print(json.dumps({'rawEntries':sum(counts.values()),'uniqueTrails':len(items),'seasonVariants':sum(len(i['trailVariants']) for i in items),'output':str(path)}))

if __name__=='__main__':main()
