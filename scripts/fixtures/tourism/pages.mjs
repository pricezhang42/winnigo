const C='https://www.tourismwinnipeg.com/festivals-and-events/upcoming-events',A='https://www.tourismwinnipeg.com/festivals-and-events/annual-festivals-and-events';
const event=C+'/display,event/100/show',festival=A+'/display,listing/200/festival';
const entry=(start,end=start,extra={})=>({'@type':'Event',name:'Test exhibition',url:event,startDate:start,endDate:end,description:'A solo exhibition.',image:'https://www.tourismwinnipeg.com/uploads/event_image/show.png',location:{name:'Test Hall'},...extra});
const json=e=>'<script type="application/ld+json">'+JSON.stringify(e)+'</script>';
const selects=Object.entries({s:{year:'2026',month:'10',day:'01'},e:{year:'2026',month:'11',day:'30'}}).flatMap(([k,v])=>Object.entries(v).map(([p,val])=>`<select name="data[F][${k}][${p}]"><option selected>${val}</option></select>`)).join('');
const calendar=(entries,link='')=>'<div id="content">'+selects+'<ul class="event-list"><li><a class="title" href="'+event+'">Test exhibition</a></li></ul>'+entries.map(json).join('')+link+'</div>';
const directory='<div id="content"><ul class="profile-list"><li><a class="title" href="'+festival+'">Annual Festival</a></li></ul></div>';
const detail=(annual=false,label='October 31, 2026',body='An exhibition.')=>`<div id="content"><div class="${annual?'profile':'event'}-image-block"><div id="page-image"><img src="https://www.tourismwinnipeg.com/uploads/event_image/show.png"></div><h2>${annual?'Annual Festival':'Test exhibition'}</h2></div><div class="${annual?'profile':'event'}-description-block"><div class="body"><p class="${annual?'':'dates'}">${label}</p><p>${body}</p></div></div></div>`;

export {entry,calendar,directory,detail,event,festival,C,A};
