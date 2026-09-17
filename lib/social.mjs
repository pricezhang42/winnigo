export const communitySources=[
 {id:'facebook',name:'Hiking Manitoba · Facebook',url:'https://www.facebook.com/groups/810758152436911/',platform:'Facebook',mode:'browser',note:'Scheduled browser checks at 9 a.m. Winnipeg time. Requires the collector computer and signed-in Facebook session. Private group summaries stay in your private collection.'},
 {id:'instagram',name:'Instagram outdoor posts',url:'https://www.instagram.com/',platform:'Instagram',mode:'manual',note:'Add specific hiking or cycling posts by link. No account feed is connected yet.'}
];
export function normalizeSocial(input,now=new Date().toISOString()){
 if(!input||typeof input!=='object')throw Error('Enter the outing details.');
 const text=(key,max=500)=>typeof input[key]==='string'?input[key].trim().slice(0,max):'';
 const title=text('title',200);if(!title)throw Error('Add a title for this outing.');
 let url;try{url=new URL(text('url',2000));}catch{throw Error('Enter a Facebook or Instagram post URL.');}
 if(url.protocol!=='https:'||url.username||url.password)throw Error('Use a secure Facebook or Instagram post URL.');
 const host=url.hostname.toLowerCase();const source=host==='facebook.com'||host.endsWith('.facebook.com')?'facebook':host==='instagram.com'||host.endsWith('.instagram.com')?'instagram':null;
 if(!source)throw Error('Only Facebook and Instagram links are supported here.');
 if(source==='facebook'&&!/\/(posts|permalink|events|reel|share)\/|story_fbid=/.test(url.pathname+url.search))throw Error('Paste an individual Facebook post or event link, rather than the group homepage.');
 if(source==='instagram'&&!/^\/(p|reel|reels)\//.test(url.pathname))throw Error('Paste an individual Instagram post or reel link.');
 // Strip tracking parameters while preserving Facebook post identity parameters.
 for(const key of [...url.searchParams.keys()])if(!['story_fbid','id','fbid'].includes(key))url.searchParams.delete(key);url.hash='';
 const category=text('category');if(!['Hiking','Cycling'].includes(category))throw Error('Choose hiking or cycling.');
 const type=text('type')==='Event'?'Event':'Activity';const start=text('start',10),end=text('end',10)||start;
 const validDate=s=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&!Number.isNaN(Date.parse(s+'T12:00:00Z'))&&new Date(s+'T12:00:00Z').toISOString().slice(0,10)===s;
 if(type==='Event'&&(!validDate(start)||!validDate(end)||end<start))throw Error('Use valid outing dates, with the end on or after the start.');
 const distance=input.distanceKm===''||input.distanceKm==null?null:Number(input.distanceKm);if(distance!==null&&(!Number.isFinite(distance)||distance<=0||distance>2000))throw Error('Distance must be between 0 and 2,000 km.');
 const difficulty=text('difficulty');if(!['Unknown','Easy','Moderate','Challenging'].includes(difficulty))throw Error('Choose the difficulty, or leave it unknown.');
 return {title,url:url.href,type,category,start:type==='Event'?start:undefined,end:type==='Event'?end:undefined,schedule:type==='Event'?'event':'unscheduled',venue:text('venue',200)||'Location not confirmed',address:text('venue',200),neighbourhood:text('neighbourhood',100)||'Winnipeg area',time:text('time',100),description:text('description',1200)||'Added from a community post. Check the original post for current details.',source,sourceName:source==='facebook'?'Facebook community post':'Instagram community post',checkedAt:now,addedAt:now,provenance:'manual',distanceKm:distance,difficulty,price:null,family:false,indoor:false,image:'',status:'active'};
}

export function normalizeHikingBatch(input,now=new Date().toISOString()){
 if(!input||!Array.isArray(input.items)||input.items.length>30)throw Error('Provide up to 30 outings per check.');
 if(!['ok','blocked','partial'].includes(input.status))throw Error('Use a valid collection status.');
 if(input.status==='blocked'&&input.items.length)throw Error('A blocked check cannot import outings.');
 const items=new Map();
 for(const raw of input.items){
  const item=normalizeSocial(raw,now);
  if(item.source!=='facebook')throw Error('This collector accepts Facebook posts only.');
  item.url=item.url.replace('https://www.facebook.com/','https://facebook.com/');
  items.set(item.url,{...item,sourceName:'Hiking Manitoba · Facebook',sourceGroup:'810758152436911',sourceVisibility:'private',provenance:'browser',status:raw.cancelled===true?'cancelled':'active'});
 }
 return {items:[...items.values()],status:input.status,message:typeof input.message==='string'?input.message.trim().slice(0,500):'',checkedAt:now};
}
