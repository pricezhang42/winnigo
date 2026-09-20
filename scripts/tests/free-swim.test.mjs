import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFreeSwim,applyPoolClosures} from '../../lib/free-swim.mjs';
import {dedupe} from '../../lib/connectors.mjs';

const card=(range='August 31 – September 28, 2026',sessions='<p>Monday<br>8:30 - 9:25 a.m.</p><p>Friday<br>8:30 - 9:25 a.m.<br>7:30 - 9 p.m. <span>Youth swim</span></p>')=>`<h3 class="card-title"><a href="/recreation-leisure/pools/indoor-pools/margaret-grant-pool">Margaret Grant</a></h3><div class="field--name-field-card-body"><p><a>685 Dalhousie Dr.</a>&nbsp;</p><p><strong>${range}</strong></p>${sessions}</div>`;
const checked='2026-09-20T12:00:00Z';

test('separate swim sessions at the same pool and date remain discoverable',()=>{
 const items=parseFreeSwim(card(undefined,'<p>Friday<br>9 – 11 a.m.<br>2 – 4 p.m.</p>'),checked);
 assert.equal(dedupe([...items,...items]).length,8);
});

test('weekly swims occur only on published weekdays within effective dates',()=>{
 const items=parseFreeSwim(card(),checked);
 assert.equal(items.length,13);
 assert.equal(new Set(items.map(i=>i.id)).size,13);
 assert.ok(items.every(i=>i.start>='2026-08-31'&&i.end<='2026-09-28'&&i.start===i.end&&i.price===0));
 assert.equal(items.filter(i=>i.start==='2026-09-25').length,2);
 assert.equal(items.filter(i=>i.title.includes('youth')).length,4);
 assert.ok(items.filter(i=>i.title.includes('youth')).every(i=>!i.family&&i.title.includes('9–19')));
 assert.equal(items[0].address,'685 Dalhousie Dr., Winnipeg');
});

test('year boundary and same-month date ranges retain correct dates',()=>{
 assert.deepEqual(parseFreeSwim(card('December 28 – January 5, 2027','<p>Monday<br>2 – 4 p.m.</p>'),checked).map(i=>i.start),['2026-12-28','2027-01-04']);
 assert.deepEqual(parseFreeSwim(card('September 1 – 9, 2026','<p>Tuesday<br>2 – 4 p.m.</p>'),checked).map(i=>i.start),['2026-09-01','2026-09-08']);
});

test('restricted swim notes survive import and malformed schedules fail safely',()=>{
 const items=parseFreeSwim(card(undefined,'<p>Friday<br>4 – 6 p.m. <span>Indoor splash pad and Kiddie pool only</span></p>'),checked);
 assert.ok(items.every(i=>i.time.includes('Kiddie pool only')&&i.description.includes('Kiddie pool only')));
 assert.throws(()=>parseFreeSwim(card('Coming soon'),checked));
 assert.throws(()=>parseFreeSwim(card(undefined,'<p>Every day<br>2 – 4 p.m.</p>'),checked));
 assert.throws(()=>parseFreeSwim('<p>Page unavailable</p>',checked));
});

test('facility closures cancel only affected sessions, preserving later sessions',()=>{
 const directory='<div class="card card-body"><h2><a href="/recreation-leisure/pools/indoor-pools/margaret-grant-pool">Margaret Grant</a></h2><span>Facility closed</span><time datetime="2026-09-08T12:00:00Z"></time><time datetime="2026-09-26T12:00:00Z"></time></div>';
 const items=applyPoolClosures(parseFreeSwim(card(),checked),directory);
 assert.ok(items.filter(i=>i.start>='2026-09-08'&&i.start<='2026-09-26').every(i=>i.status==='cancelled'));
 assert.equal(items.find(i=>i.start==='2026-09-28').status,'active');
 assert.throws(()=>applyPoolClosures(items,'Unavailable'));
});
