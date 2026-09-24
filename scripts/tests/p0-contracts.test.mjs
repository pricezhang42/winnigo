import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {listingImportSchema, discoveryResponseSchema, preferencesSchema} from '../../lib/contracts/discovery.mjs';
import {normalizeHikingBatch} from '../../lib/social.mjs';
import {parseSource,dedupe} from '../../lib/connectors.mjs';
import {parseFreeSwim} from '../../lib/free-swim.mjs';
const f=JSON.parse(readFileSync(new URL('../fixtures/p0-discovery.json',import.meta.url)));
test('P0 fixtures: calendar ranges and multiple swims remain distinct',()=>{
 const [event]=parseSource('forks',f.calendarHtml,'2026-12-15T18:00:00Z');
 assert.equal(event.start,'2026-12-31');assert.equal(event.end,'2027-01-01');
 const swims=parseFreeSwim(f.swimHtml);
 assert.equal(swims.length,2);assert.equal(dedupe(swims).length,2);
 assert.equal(swims[1].family,false);assert.match(swims[1].description,/9–19/);
});
test('P0 fixtures: duplicate post imports retain ordered photos and linked comment uncertainty',()=>{
 const duplicate={...f.community,url:f.community.url.replace('www.','')};
 const result=normalizeHikingBatch({status:'ok',items:[f.community,duplicate]});
 assert.equal(result.items.length,1);
 const item=result.items[0];assert.deepEqual(item.images,f.community.images);
 assert.equal(item.commentNotes[0].text,f.community.commentNotes[0].text);
 assert.match(item.commentNotes[0].url,/comment_id=/);assert.doesNotMatch(item.commentNotes[0].url,/utm_source/);
 assert.equal(item.sourceVisibility,'private');assert.equal(item.distanceKm,null);
});
test('P0 target contracts preserve restrictions and approximate location uncertainty',()=>{
 assert.deepEqual(listingImportSchema.parse(f.listing),f.listing);
 for(const patch of [{location:{...f.listing.location,approximate:false}},{location:{...f.listing.location,uncertainty:null}},{source:'facebook',collection:'Community Highlights'},{collection:'All discoveries'}])
   assert.equal(listingImportSchema.safeParse({...f.listing,...patch}).success,false);
});
test('P0 target contracts reject impossible occurrences, leaked internals and unknown preference fields',()=>{
 for(const start of ['2026-02-30','invalid'])assert.equal(listingImportSchema.safeParse({...f.listing,type:'Event',occurrences:[{start,end:'2026-03-01',time:null}]}).success,false);
 assert.equal(listingImportSchema.safeParse({...f.listing,type:'Event'}).success,false);
 assert.equal(listingImportSchema.safeParse({...f.listing,author:'private author'}).success,false);
 assert.equal(discoveryResponseSchema.safeParse({items:[{...f.listing,id:'one',override:f.stored.override}],nextCursor:null,total:1}).success,false);
 assert.equal(discoveryResponseSchema.safeParse({items:[{...f.listing,id:'one'}],nextCursor:null,total:1}).success,true);
 assert.deepEqual(preferencesSchema.parse(f.preferences),f.preferences);
 for(const patch of [{userId:'other'},{budget:-1},{travelRadiusKm:0}])assert.equal(preferencesSchema.safeParse({...f.preferences,...patch}).success,false);
});
