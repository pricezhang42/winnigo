import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseSource,parsePlaces,dedupe,localDay} from '../../lib/connectors.mjs';
test('Winnipeg day stays correct around midnight and DST',()=>{assert.equal(localDay(new Date('2026-09-17T02:00:00Z')),'2026-09-16');assert.equal(localDay(new Date('2026-01-01T05:00:00Z')),'2025-12-31');});
test('Forks date ranges cross the year boundary',()=>{const [e]=parseSource('forks','<div class="event-listing"><p class="dates">Thursday, Dec 31 to Friday, Jan 1</p><h3><a href="/events/calendar-of-events/event/1">New Year</a></h3><p class="hours">7 PM</p>','2026-12-15T18:00:00Z');assert.equal(e.start,'2026-12-31');assert.equal(e.end,'2027-01-01');assert.equal(e.price,null);});
test('Park recurrence is a series, never an every-day event',()=>{const [e]=parseSource('park','<div class="event-item leaf"><a href="/events/event/1"><img src="/one.jpg"></a><h3><a href="/events/event/1">Gardener Chats</a></h3><time datetime="2026-09-17T00:00:00+00:00"></time><time datetime="2027-01-09T00:00:00+00:00"></time>');assert.equal(e.schedule,'series');assert.equal(e.end,'2027-01-09');});
test('identical listings merge but different venues remain',()=>{const a={title:'One event',start:'2026-09-19',venue:'Venue A'};assert.equal(dedupe([a,{...a},{...a,venue:'Venue B'}]).length,2);});
test('closed places are hidden and unsafe seasonal assumptions excluded',()=>{const [e]=parsePlaces('<div class="attraction"><img src="/a.jpg"><h3>Historic Rail Bridge</h3><div class="brief"><p>Currently closed for assessment.</p><a href="/bridge">Read more</a></div>');assert.equal(e.status,'hidden');assert.equal(e.price,null);});
test('source layout failures yield no invented listings',()=>{assert.deepEqual(parseSource('park','<p>Maintenance</p>'),[]);assert.deepEqual(parseSource('manitoba','<p>Maintenance</p>'),[]);});
import {normalizeSocial,normalizeHikingBatch} from '../../lib/social.mjs';
const social={title:'River ride',url:'https://www.facebook.com/groups/810758152436911/posts/123456/?utm_source=test',category:'Cycling',type:'Event',start:'2026-09-20',distanceKm:'12.5',difficulty:'Moderate'};
test('social outings retain original attribution and normalize confirmed details',()=>{const e=normalizeSocial(social);assert.equal(e.source,'facebook');assert.equal(e.distanceKm,12.5);assert.equal(e.end,'2026-09-20');assert.equal(e.url,'https://www.facebook.com/groups/810758152436911/posts/123456/');assert.equal(e.provenance,'manual');});
test('social links reject non-platform URLs, insecure protocols and group homepages',()=>{for(const url of ['https://facebook.com.evil.example/posts/123/','javascript:alert(1)','http://instagram.com/p/abc/','https://www.facebook.com/groups/810758152436911/'])assert.throws(()=>normalizeSocial({...social,url}));});
test('social listings do not invent dates, price or route difficulty',()=>{const e=normalizeSocial({...social,type:'Activity',url:'https://www.instagram.com/p/example/',distanceKm:'',difficulty:'Unknown'});assert.equal(e.start,undefined);assert.equal(e.price,null);assert.equal(e.distanceKm,null);assert.equal(e.difficulty,'Unknown');});
test('social events reject impossible dates, backwards ranges and invalid distances',()=>{for(const patch of [{start:'2026-02-30'},{end:'2026-01-01'},{distanceKm:-1},{distanceKm:'hello'}])assert.throws(()=>normalizeSocial({...social,...patch}));});
test('browser batches deduplicate tracked links and never retain personal fields',()=>{
 const b=normalizeHikingBatch({status:'ok',items:[{...social,author:'Person',email:'private@example.com'},{...social,url:social.url.replace('www.','')}]});
 assert.equal(b.items.length,1);assert.equal(b.items[0].sourceVisibility,'private');assert.equal(b.items[0].provenance,'browser');assert.equal(b.items[0].author,undefined);assert.equal(b.items[0].email,undefined);
});
test('browser batches reject invalid or misleading checks',()=>{
 for(const b of [{status:'blocked',items:[social]},{status:'ok',items:Array(101).fill(social)},{status:'ok',items:[{...social,url:'https://instagram.com/p/abc/'}]},{status:'unknown',items:[]}])assert.throws(()=>normalizeHikingBatch(b));
 assert.equal(normalizeHikingBatch({status:'ok',items:[{...social,cancelled:true}]}).items[0].status,'cancelled');
});

test('discussion notes retain their source and stored photos reject external URLs',()=>{
 const url='https://www.facebook.com/groups/810758152436911/posts/123456/?comment_id=789&utm_source=tracking';
 const item=normalizeHikingBatch({status:'ok',items:[{...social,images:['/api/photos/'+'a'.repeat(64)],commentNotes:[{text:'Trailhead signs reported unclear.',url}]}]}).items[0];
 assert.equal(item.images.length,1);assert.equal(item.commentNotes[0].url,'https://www.facebook.com/groups/810758152436911/posts/123456/?comment_id=789');
 for(const patch of [{images:['https://example.com/photo.jpg']},{commentNotes:[{text:'Test',url:'https://evil.example/comment/1'}]}])assert.throws(()=>normalizeHikingBatch({status:'ok',items:[{...social,...patch}]}));
});
