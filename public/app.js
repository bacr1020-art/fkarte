/* ===== طبقة البيانات =====
   كل بيانات المستخدم تُحفظ على الخادم (SQLite). الواجهة تقرأ من ذاكرة محلية متزامنة
   وتكتب إلى الخادم في الخلفية بدون فقدان التغييرات عند فشل الاتصال (إعادة محاولة تلقائية). */
const CACHE=new Map();           // مفتاح -> نص JSON (نسخة من بيانات المستخدم القادمة من الخادم)
const LOCAL=['theme'];           // إعدادات محلية فقط
let ME=null;
async function api(method,path,body){let r;
 try{r=await fetch(path,{method,credentials:'same-origin',headers:{'Content-Type':'application/json','X-Fikra':'1'},body:body==null?undefined:JSON.stringify(body)})}
 catch(e){const x=new Error('تعذر الاتصال بالخادم.');x.status=0;throw x}
 let j=null;try{j=await r.json()}catch(e){}
 if(!r.ok){const x=new Error((j&&j.message)||'حدث خطأ غير متوقع.');x.status=r.status;x.code=j&&j.error;if(r.status===401&&ME&&!path.startsWith('/api/auth/'))sessionLost();throw x}
 return j}
function sessionLost(){ME=null;CACHE.clear();Sync.q.clear();view='login';toast('انتهت الجلسة. سجّل الدخول من جديد.','error');render()}
const DB={
 get(k,d){if(LOCAL.includes(k)){try{const v=localStorage.getItem('fikra:'+k);return v?JSON.parse(v):d}catch(e){return d}}
  const v=CACHE.get(k);if(v==null)return d;try{return JSON.parse(v)}catch(e){return d}},
 set(k,v){if(LOCAL.includes(k)){try{localStorage.setItem('fikra:'+k,JSON.stringify(v));return true}catch(e){return false}}
  const old=CACHE.get(k);CACHE.set(k,JSON.stringify(v));Sync.push(k,old,v);return true},
 del(k){const old=CACHE.get(k);CACHE.delete(k);Sync.remove(k,old)},
 drop(k){CACHE.delete(k)},
 keys(p){return [...CACHE.keys()].filter(k=>k.startsWith(p))}
};
const Sync={q:new Map(),busy:false,fail:0,timer:0,rt:0,w:[],
 enq(method,path,body,key){this.q.set(key,{method,path,body});setSave('saving');clearTimeout(this.timer);this.timer=setTimeout(()=>this.flush(),250)},
 push(k,old,v){
  if(k.startsWith('ideas:')){const ol=old?JSON.parse(old):[],was=new Map(ol.map(i=>[i.id,JSON.stringify(i)])),ids=new Set();
   v.forEach(i=>{ids.add(i.id);if(was.get(i.id)!==JSON.stringify(i))this.enq('PUT','/api/ideas/'+i.id,i,'i:'+i.id)});
   ol.forEach(i=>{if(!ids.has(i.id))this.enq('DELETE','/api/ideas/'+i.id,null,'i:'+i.id)})}
  else if(k.startsWith('map:')){const id=k.split(':')[2];this.enq('PUT','/api/maps/'+id,v,'m:'+id)}
  else this.enq('PUT','/api/kv/'+k.split(':')[0],v,'k:'+k)},
 remove(k){if(k.startsWith('map:')){const id=k.split(':')[2];this.enq('DELETE','/api/maps/'+id,null,'m:'+id)}else this.enq('DELETE','/api/kv/'+k.split(':')[0],null,'k:'+k)},
 async flush(){clearTimeout(this.timer);this.timer=0;if(this.busy)return;this.busy=true;
  while(this.q.size){const [key,it]=this.q.entries().next().value;
   try{await api(it.method,it.path,it.body);if(this.q.get(key)===it)this.q.delete(key);this.fail=0}
   catch(e){if(e.status>=400&&e.status<500&&![401,429].includes(e.status)){if(this.q.get(key)===it)this.q.delete(key);toast(e.message||'تعذر حفظ بعض التغييرات.','error');continue}
    this.fail++;this.busy=false;setSave('error');this.done(false);clearTimeout(this.rt);this.rt=setTimeout(()=>this.flush(),Math.min(30000,1000*2**this.fail));return}}
  this.busy=false;this.fail=0;setSave('saved');this.done(true)},
 done(ok){const w=this.w;this.w=[];w.forEach(f=>f(ok))},
 onIdle(cb){if(!this.q.size&&!this.busy&&!this.timer)cb(true);else this.w.push(cb)},
 retry(){clearTimeout(this.rt);this.fail=0;if(this.q.size)this.flush();else{setSave('saved');this.done(true)}},
 drain(){return new Promise(r=>{if(!this.q.size&&!this.busy)return r();const t=setTimeout(r,6000);this.w.push(()=>{clearTimeout(t);r()});if(!this.busy)this.flush()})}
};
window.addEventListener('online',()=>Sync.retry());
window.addEventListener('beforeunload',e=>{if(Sync.q.size||Sync.busy){e.preventDefault();e.returnValue=''}});
const uid=()=>Math.random().toString(36).slice(2,10)+Date.now().toString(36);
const setMe=u=>{ME={id:u.id,name:u.name,email:u.email||'',guest:!!u.guest}};
async function loadData(){CACHE.clear();const d=await api('GET','/api/data'),id=ME.id;
 CACHE.set('ideas:'+id,JSON.stringify(d.ideas));d.maps.forEach(m=>CACHE.set('map:'+id+':'+m.ideaId,JSON.stringify(m)));Object.entries(d.kv||{}).forEach(([k,v])=>CACHE.set(k+':'+id,JSON.stringify(v)))}
const Auth={
 session:()=>ME,
 async register(name,email,pw){const r=await api('POST','/api/auth/register',{name,email,password:pw});setMe(r.user);await loadData()},
 async login(email,pw){const r=await api('POST','/api/auth/login',{email,password:pw});setMe(r.user);await loadData()},
 async guest(){const r=await api('POST','/api/auth/guest');setMe(r.user);await loadData()},
 async logout(){await Sync.drain();try{await api('POST','/api/auth/logout')}catch(e){}ME=null;CACHE.clear();Sync.q.clear()}
};
const norm=i=>({status:'new',priority:'medium',progress:0,category:'',updatedAt:i.createdAt,openedAt:i.createdAt,...i});
const Ideas={
 key:()=>'ideas:'+Auth.session().id,
 all(){return DB.get(this.key(),[]).map(norm)},
 save(l){return DB.set(this.key(),l)},
 list(){return this.all().filter(i=>!i.archived)},
 add(d){const n=Date.now(),l=this.all(),i={id:uid(),title:'',body:'',category:'',tags:[],status:'new',priority:'medium',progress:0,favorite:false,archived:false,createdAt:n,updatedAt:n,openedAt:n,log:[{t:n,m:'تم إنشاء الفكرة'}],...d};l.unshift(i);return this.save(l)?i:null},
 update(id,p,touch=true,lg=[]){const l=this.all(),i=l.find(x=>x.id===id);if(!i)return false;Object.assign(i,p);if(touch)i.updatedAt=Date.now();if(lg.length)i.log=[...(i.log||[{t:i.createdAt,m:'تم إنشاء الفكرة'}]),...lg.map(m=>({t:Date.now(),m}))];return this.save(l)},
 open(id){return this.update(id,{openedAt:Date.now()},false)},
 remove(id){DB.drop('map:'+Auth.session().id+':'+id);return this.save(this.all().filter(x=>x.id!==id))}
};

const Maps={list(){const out=[];DB.keys('map:'+Auth.session().id+':').forEach(k=>{try{const m=JSON.parse(CACHE.get(k));if(m&&Array.isArray(m.nodes))out.push(m)}catch(e){}});
 const by=new Map(Ideas.all().map(i=>[i.id,i]));return out.filter(m=>by.has(m.ideaId)).map(m=>({...m,idea:by.get(m.ideaId)})).sort((a,b)=>b.updatedAt-a.updatedAt)}};

/* ===== UI helpers ===== */
const P={home:'M3 11l9-8 9 8M5 10v10h14V10',ideas:'M9 18h6M10 21h4M12 3a6 6 0 00-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0012 3z',inbox:'M3 13l3-8h12l3 8v6H3zM3 13h5l1 3h6l1-3h5',maps:'M12 5v4M12 9l-6 5M12 9l6 5M6 14v3M18 14v3M10 3h4v2h-4zM4 17h4v3H4zM16 17h4v3h-4z',projects:'M3 7h6l2 2h10v10H3z',tasks:'M5 12l4 4 10-10',fav:'M12 20s-8-5-8-11a4.5 4.5 0 018-2.5A4.5 4.5 0 0120 9c0 6-8 11-8 11z',archive:'M3 5h18v4H3zM5 9v10h14V9M10 13h4',settings:'M12 15a3 3 0 100-6 3 3 0 000 6zM19 12l2 1-2 3-2-.5-1.5 1V19h-3l-.5-2-2-1-2 .5-2-3 1.5-1.5v-2L5 8l2-3 2 .5L10.5 4H14l.5 2 2 1 2-.5 2 3z',plus:'M12 5v14M5 12h14',more:'M5 12h.01M12 12h.01M19 12h.01',sun:'M12 17a5 5 0 100-10 5 5 0 000 10zM12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5',out:'M9 21H5V3h4M16 17l5-5-5-5M21 12H9'};
const ic=n=>`<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="${P[n]}"/></svg>`;
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const $=(s,r=document)=>r.querySelector(s);
function toast(msg,type=''){const t=document.createElement('div');t.className='toast '+type;t.textContent=msg;$('#toasts').append(t);setTimeout(()=>t.remove(),3200)}
let lastFocus=null;
function modal(html){lastFocus=document.activeElement;const r=$('#modal-root');r.innerHTML=`<div class="ov"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;const d=r.querySelector('.modal'),h=d.querySelector('h2');if(h){h.id='md-t';d.setAttribute('aria-labelledby','md-t')}
 r.firstChild.addEventListener('click',e=>{if(e.target===r.firstChild)closeModal()});
 d.addEventListener('keydown',e=>{if(e.key!=='Tab')return;const f=[...d.querySelectorAll('button,input,select,textarea,a[href]')].filter(x=>!x.disabled&&!x.hidden&&x.offsetParent!==null);if(!f.length)return;const a=f[0],z=f[f.length-1];if(e.shiftKey&&document.activeElement===a){e.preventDefault();z.focus()}else if(!e.shiftKey&&document.activeElement===z){e.preventDefault();a.focus()}});
 const f0=d.querySelector('input,textarea,select,button');if(f0)setTimeout(()=>f0.focus(),20);return r}
const closeModal=()=>{$('#modal-root').innerHTML='';if(lastFocus&&lastFocus.focus&&document.contains(lastFocus))lastFocus.focus();lastFocus=null};
const NAV=[['home','الرئيسية'],['ideas','أفكاري'],['inbox','صندوق الأفكار'],['maps','الخرائط الذهنية'],['fav','المفضلة'],['archive','الأرشيف'],['settings','الإعدادات']];
const EMPTY={fav:['fav','ما عندك مفضلة بعد.','الأفكار التي تضيفها إلى المفضلة ستظهر هنا.'],archive:['archive','الأرشيف فارغ.','الأفكار التي تؤرشفها ستظهر هنا.']};

/* ===== Theme ===== */
const Theme={get:()=>DB.get('theme','auto'),apply(){const t=this.get();t==='auto'?document.documentElement.removeAttribute('data-theme'):document.documentElement.setAttribute('data-theme',t)},toggle(){const dark=document.documentElement.dataset.theme?document.documentElement.dataset.theme==='dark':matchMedia('(prefers-color-scheme:dark)').matches;DB.set('theme',dark?'light':'dark');this.apply()}};
Theme.apply();

/* ===== State & routing ===== */
let view='login',page='home',saveState='saved',loading=false;
const setView=v=>{view=v;render()};
window.addEventListener('online',syncNet);window.addEventListener('offline',syncNet);
function syncNet(){$('#offline').hidden=navigator.onLine}
syncNet();

/* ===== Auth screens ===== */
function authShell(inner){return `<main class="auth"><div class="auth-box"><div class="brand">فِكرة</div><p class="tagline">فكرتك تبدأ هنا.</p>${inner}</div></main>`}
function fld(id,label,type='text',extra=''){return `<div class="field"><label for="${id}">${label}</label><input class="input ${type==='email'?'ltr':''}" id="${id}" name="${id}" type="${type}" ${extra}><span class="err" id="${id}-e" role="alert"></span></div>`}
function setErr(id,m){const i=$('#'+id),e=$('#'+id+'-e');if(!i)return;i.setAttribute('aria-invalid',m?'true':'false');if(e)e.textContent=m||''}
const mailOk=v=>/^\S+@\S+\.\S+$/.test(v.trim());
const localNote='<p class="muted small" style="margin-top:14px;text-align:center">بياناتك محفوظة في حسابك على خادم فِكرة.</p>';
function renderLogin(){return authShell(`<div class="card"><h1>مرحبًا بعودتك</h1><p class="muted" style="margin:4px 0 20px">سجّل دخولك للعودة إلى أفكارك.</p><div id="form-err"></div>${fld('email','البريد الإلكتروني','email','autocomplete="email" inputmode="email"')}${fld('pw','كلمة المرور','password','autocomplete="current-password"')}<button class="btn primary block" id="go">تسجيل الدخول</button><div class="row" style="margin-top:12px;justify-content:center"><span class="muted">ليس لديك حساب؟</span><button class="link" data-v="register">إنشاء حساب جديد</button></div><div class="sep">أو</div><button class="btn block" id="guest">الدخول كزائر</button>${localNote}</div>`)}
function renderRegister(){return authShell(`<div class="card"><h1>إنشاء حساب</h1><p class="muted" style="margin:4px 0 20px">أنشئ مساحتك الشخصية لأفكارك.</p><div id="form-err"></div>${fld('name','الاسم','text','autocomplete="name"')}${fld('email','البريد الإلكتروني','email','autocomplete="email"')}${fld('pw','كلمة المرور','password','autocomplete="new-password"')}${fld('pw2','تأكيد كلمة المرور','password','autocomplete="new-password"')}<button class="btn primary block" id="go">إنشاء حساب</button><div class="row" style="margin-top:12px;justify-content:center"><span class="muted">لديك حساب؟</span><button class="link" data-v="login">تسجيل الدخول</button></div>${localNote}</div>`)}
function bindAuth(){
 document.querySelectorAll('[data-v]').forEach(b=>b.onclick=()=>setView(b.dataset.v));
 const g=$('#guest');if(g)g.onclick=async()=>{g.disabled=true;try{await Auth.guest();enter()}catch(e){g.disabled=false;toast(e.message,'error')}};
 const go=$('#go');if(!go)return;const v=id=>($('#'+id)?.value||'');
 const submit=async()=>{const box=$('#form-err');box.innerHTML='';let bad=false;['name','email','pw','pw2'].forEach(i=>setErr(i,''));
  if(view==='register'&&!v('name').trim()){setErr('name','أدخل اسمك.');bad=true}
  if(!mailOk(v('email'))){setErr('email','أدخل بريدًا إلكترونيًا صحيحًا.');bad=true}
  if(view==='register'&&v('pw').length<8){setErr('pw','كلمة المرور يجب ألا تقل عن 8 أحرف.');bad=true}else if(!v('pw')){setErr('pw','أدخل كلمة المرور.');bad=true}
  if(view==='register'&&v('pw')!==v('pw2')){setErr('pw2','كلمتا المرور غير متطابقتين.');bad=true}
  if(bad)return;go.disabled=true;const old=go.textContent;go.textContent='جارٍ المعالجة…';
  try{if(view==='login'){await Auth.login(v('email'),v('pw'));enter()}else{await Auth.register(v('name'),v('email'),v('pw'));toast('تم إنشاء حسابك. أهلًا بك في فِكرة.');enter()}}
  catch(e){box.innerHTML=`<div class="alert" role="alert">${esc(e.message||'حدث خطأ غير متوقع.')}</div>`;go.disabled=false;go.textContent=old}};
 go.onclick=submit;document.querySelectorAll('.auth input').forEach(i=>i.onkeydown=e=>{if(e.key==='Enter')submit()})}
function enter(){page='home';view='app';loading=true;render();setTimeout(()=>{loading=false;if(page==='home'&&view==='app')render()},450)}

/* ===== App shell ===== */
function savingBadge(){return saveState==='saving'?'<span class="status"><span class="dot busy"></span>جارٍ الحفظ...</span>':saveState==='error'?'<span class="status" style="color:var(--danger)"><span class="dot" style="background:var(--danger)"></span>تعذر الحفظ</span>':'<span class="status"><span class="dot"></span>تم الحفظ</span>'}
function setSave(st){saveState=st;const e=$('#svb');if(e)e.innerHTML=savingBadge()}
const STATUS={new:'💡 فكرة جديدة',important:'🔥 مهمة',progress:'🚧 قيد التطوير',paused:'⏸️ متوقفة',done:'✅ مكتملة'},PRI={high:'عالية',medium:'متوسطة',low:'منخفضة'},CATS=['تطبيقات','أعمال','محتوى','تعليم','شخصي','تقنية','تسويق','مشاريع','أخرى'],PRI_W={high:3,medium:2,low:1};
const rtf=new Intl.RelativeTimeFormat('ar',{numeric:'auto'}),N=n=>Number(n).toLocaleString('ar');
function ago(t){const x=Math.round((t-Date.now())/1000),a=Math.abs(x);if(a<60)return 'الآن';if(a<3600)return rtf.format(Math.round(x/60),'minute');if(a<86400)return rtf.format(Math.round(x/3600),'hour');return rtf.format(Math.round(x/86400),'day')}
let F={q:'',st:'',cat:'',sort:'date'};
const opts=(o,sel,all)=>(all?`<option value="">${all}</option>`:'')+Object.entries(o).map(([k,v])=>`<option value="${k}" ${k===sel?'selected':''}>${v}</option>`).join('');
const catOpts=(sel,all)=>`<option value="">${all||'بدون تصنيف'}</option>`+[...new Set([...cats(),...(sel?[sel]:[])])].map(c=>`<option ${c===sel?'selected':''}>${esc(c)}</option>`).join('');
const ideaCard=i=>`<article class="card idea" tabindex="0" data-open="${i.id}"><div class="row" style="align-items:flex-start;flex-wrap:nowrap"><h3>${esc(i.title)}</h3><button class="star" data-fav="${i.id}" aria-pressed="${i.favorite}" aria-label="${i.favorite?'إزالة من المفضلة':'إضافة إلى المفضلة'}">${ic('fav')}</button></div><p class="muted clamp">${esc(i.body||'بدون وصف')}</p><div class="meta"><span class="badge">${i.archived?'📦 مؤرشفة':STATUS[i.status]}</span>${i.category?`<span class="badge neutral">${esc(i.category)}</span>`:''}${(i.tags||[]).slice(0,3).map(t=>`<span class="badge neutral">#${esc(t)}</span>`).join('')}</div><div class="prog"><i style="width:${i.progress}%"></i></div><div class="row small muted"><span>${N(i.progress)}٪</span><span>آخر تحديث: ${ago(i.updatedAt)}</span></div></article>`;
function visible(arr){const q=nrm(F.q).replace(/^#/,''),l=arr.filter(i=>(!F.st||i.status===F.st)&&(!F.cat||i.category===F.cat)&&(!q||hay(i).includes(q)));
 return l.sort(F.sort==='priority'?(a,b)=>PRI_W[b.priority]-PRI_W[a.priority]||b.updatedAt-a.updatedAt:(a,b)=>b.createdAt-a.createdAt)}
const listHtml=a=>{const l=visible(a);return l.length?`<div class="grid">${l.map(ideaCard).join('')}</div>`:'<div class="card empty"><p class="muted">لا توجد نتائج مطابقة. جرّب تغيير البحث أو الفلاتر.</p></div>'};
const toolbar=()=>`<div class="tools"><input class="input" id="q" type="search" placeholder="ابحث في أفكارك" value="${esc(F.q)}" aria-label="بحث"><select class="input" id="fs" aria-label="الحالة">${opts(STATUS,F.st,'كل الحالات')}</select><select class="input" id="fc" aria-label="التصنيف">${catOpts(F.cat,'كل التصنيفات')}</select><select class="input" id="so" aria-label="الترتيب"><option value="date" ${F.sort==='date'?'selected':''}>الأحدث أولًا</option><option value="priority" ${F.sort==='priority'?'selected':''}>حسب الأولوية</option></select></div>`;
const src=()=>page==='fav'?Ideas.list().filter(i=>i.favorite):page==='archive'?Ideas.all().filter(i=>i.archived):Ideas.list();
const emptyIdeas=(cta='data-new')=>`<div class="card empty"><div class="ic">${ic('ideas')}</div><h2>ما عندك أفكار بعد.</h2><p class="muted">ابدأ بتسجيل أول فكرة.</p><button class="btn primary" ${cta}>${cta==='data-focus'?'اكتب فكرتك الأولى':'+ فكرة جديدة'}</button></div>`;
const emptyCard=p=>{const [icn,t,d]=EMPTY[p];return `<div class="card empty"><div class="ic">${ic(icn)}</div><h2>${t}</h2><p class="muted">${d}</p></div>`};
const mapCard=m=>`<article class="card idea" tabindex="0" role="button" data-map="${m.ideaId}" aria-label="فتح خريطة ${esc(m.idea.title)}"><h3>${esc(m.idea.title)}</h3><p class="muted small">${N(m.nodes.length)} عقدة — آخر تحديث ${ago(m.updatedAt)}</p></article>`;
function renderHome(){const all=Ideas.list(),maps=Maps.list(),fav=all.filter(i=>i.favorite).length;
 const st=[['الأفكار',all.length],['المفضلة',fav],['الخرائط الذهنية',maps.length]];
 const head=`<div class="row" style="justify-content:flex-start;margin-bottom:28px"><button class="btn primary" data-new>+ فكرة جديدة</button><button class="btn" data-newmap>🧠 خريطة ذهنية</button><button class="btn ghost" data-quick>التقاط فكرة سريعة</button></div><div class="stats">${st.map(([l,n])=>`<div class="card stat"><span class="muted">${l}</span><strong>${N(n)}</strong></div>`).join('')}</div>`;
 if(!all.length)return head+`<div class="sec">${emptyIdeas()}</div>`;
 const rec=[...all].sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,6);
 return head+`<section class="sec"><div class="row"><h2>آخر الأفكار</h2><button class="link" data-p="ideas">عرض الكل</button></div><div class="grid">${rec.map(ideaCard).join('')}</div></section><section class="sec"><div class="row"><h2>آخر الخرائط</h2>${maps.length?'<button class="link" data-p="maps">عرض الكل</button>':''}</div>${maps.length?`<div class="grid">${maps.slice(0,4).map(mapCard).join('')}</div>`:'<div class="card empty"><p class="muted">ما عندك خرائط بعد. افتح أي فكرة وأنشئ لها خريطة ذهنية.</p></div>'}</section>`}
function renderMaps(){const maps=Maps.list();if(!maps.length)return `<div class="card empty"><div class="ic">${ic('maps')}</div><h2>ما عندك خرائط بعد.</h2><p class="muted">افتح أي فكرة وأنشئ لها خريطة ذهنية، أو ابدأ خريطة جديدة الآن.</p><button class="btn primary" data-newmap>🧠 خريطة ذهنية</button></div>`;
 return `<div class="row" style="justify-content:flex-start;margin-bottom:16px"><button class="btn primary" data-newmap>🧠 خريطة ذهنية جديدة</button></div><div class="grid">${maps.map(mapCard).join('')}</div>`}
function newMapDialog(){const free=Ideas.list().filter(i=>!DB.get(mapKey(i.id),null));
 modal(`<h2 style="margin-bottom:14px">🧠 خريطة ذهنية جديدة</h2><div class="field"><label for="nm-t">عنوان الفكرة الرئيسية</label><input class="input" id="nm-t" maxlength="120" autocomplete="off"><span class="err" id="nm-t-e" role="alert"></span></div>${free.length?`<div class="field"><label for="nm-i">أو اختر فكرة موجودة بلا خريطة</label><select class="input" id="nm-i"><option value="">—</option>${free.map(i=>`<option value="${i.id}">${esc(i.title)}</option>`).join('')}</select></div>`:''}<div class="row" style="justify-content:flex-end"><button class="btn" id="nm-x">إلغاء</button><button class="btn primary" id="nm-ok">إنشاء الخريطة</button></div>`);
 $('#nm-x').onclick=closeModal;
 const go=()=>{const sel=$('#nm-i')?.value,t=$('#nm-t').value.trim();let idea=sel?free.find(i=>i.id===sel):null;if(!idea){if(!t){setErr('nm-t','اكتب عنوان الفكرة أو اختر فكرة موجودة.');return}idea=Ideas.add({title:t})}
  if(!idea){toast('تعذّر الحفظ.','error');return}if(!createMap(idea))return;closeModal();openMap(idea.id)};
 $('#nm-ok').onclick=go;$('#nm-t').onkeydown=e=>{if(e.key==='Enter')go()}}
function renderInbox(){const total=Ideas.list().length,r=Ideas.list().filter(i=>i.status==='new').slice(0,6);
 return `<div class="card"><h2>ما الفكرة التي تدور في بالك الآن؟</h2><textarea class="input big" id="cap" placeholder="مثلاً: أريد تطبيقًا يحول الكتب إلى خرائط ذهنية..." aria-label="فكرتك"></textarea><div class="row" style="justify-content:flex-start"><button class="btn primary" id="cap-save">حفظ الفكرة</button><button class="btn" id="cap-map">🧠 تحويل إلى خريطة ذهنية</button></div><p class="muted small" style="margin-top:10px">للحفظ السريع اضغط Ctrl + Enter.</p></div><section class="sec"><h2>الأفكار الملتقطة حديثًا</h2>${r.length?`<div class="grid">${r.map(ideaCard).join('')}</div>`:total?'<div class="card empty"><p class="muted">لا توجد أفكار جديدة في الصندوق.</p></div>':emptyIdeas('data-focus')}</section>`}
function renderPage(){
 if(loading&&!['new','idea','map'].includes(page))return `<div class="grid"><div class="skel"></div><div class="skel"></div><div class="skel"></div></div>`;
 if(page==='maps')return renderMaps();
 if(page==='new')return renderForm();
 if(page==='idea')return renderIdea();
 if(page==='settings')return renderSettings();
 if(page==='home')return renderHome();
 if(page==='inbox')return renderInbox();
 if(['ideas','fav','archive'].includes(page)){const a=src();if(!a.length)return page==='ideas'?emptyIdeas():emptyCard(page);return toolbar()+`<div id="list" style="margin-top:16px">${listHtml(a)}</div>`}
 return emptyCard(page)}
function renderSettingsBase(){const s=Auth.session();
 return `<div class="card stack"><div class="tabs" role="tablist"><button class="tab" role="tab" aria-selected="true">الحساب</button></div>
 <div class="row"><div><h3>${esc(s.name)}</h3><p class="muted">${s.guest?'وضع الزائر — البيانات محفوظة على هذا الجهاز فقط':esc(s.email)}</p></div>${s.guest?'<span class="badge">زائر</span>':''}</div>
 <div class="row"><span>المظهر</span><button class="btn" id="theme">${ic('sun')} تبديل الفاتح / الداكن</button></div>
 <div class="row"><span>الجلسة</span><button class="btn" id="out">${ic('out')} تسجيل الخروج</button></div></div>`}
function storageCard(){let u=0;CACHE.forEach((v,k)=>{u+=k.length+v.length});return `<div class="card stack" style="margin-top:14px"><h3>بياناتك</h3><p class="muted small">محفوظة في حسابك على خادم فِكرة. الحجم الحالي: ${N(Math.round(u/1024))} كيلوبايت.</p></div>`}
function renderSettings(){return renderSettingsBase()+storageCard()+`<div class="card only-m stack" style="margin-top:14px"><h3>الأقسام</h3>${['inbox','archive'].map(k=>`<button class="nav" data-p="${k}">${ic(k)}<span>${NAV.find(n=>n[0]===k)[1]}</span></button>`).join('')}</div>`}
function renderApp(){
 const s=Auth.session(),cur=(NAV.find(n=>n[0]===page)||[0,page==='new'?(editId?'تعديل الفكرة':'فكرة جديدة'):''])[1],head=page==='idea'?[esc((curIdea()||{}).title||''),'']:page==='home'?['مرحبًا بك في فِكرة 👋','حوّل أفكارك من مجرد خواطر إلى أشياء قابلة للتنفيذ.']:[cur,'أهلًا، '+esc(s.name)];
 const navBtns=NAV.map(([k,l])=>`<button class="nav" data-p="${k}" ${k===navKey()?'aria-current="page"':''}>${ic(k)}<span>${l}</span></button>`).join('');
 const bn=[['home','الرئيسية'],['ideas','أفكاري'],['maps','الخرائط'],['fav','المفضلة'],['settings','الحساب']];
 return `<div class="shell"><aside class="side"><div class="brand">فِكرة</div>${navBtns}<div style="flex:1"></div><button class="btn primary" data-new>${ic('plus')} فكرة جديدة</button></aside>
 <main class="main"><div class="top"><div><h1 tabindex="-1">${head[0]}</h1><p class="muted">${head[1]}</p></div><span id="svb" aria-live="polite">${savingBadge()}</span></div><div id="content">${renderPage()}</div></main></div>
 <button class="fab" data-new aria-label="فكرة جديدة">${ic('plus')}</button>
 <nav class="bnav" aria-label="التنقل الرئيسي">${bn.map(([k,l])=>bnBtn(k,l)).join('')}</nav>`;
}
const bnBtn=(k,l)=>`<button data-p="${k}" ${k===navKey()?'aria-current="page"':''}>${ic(k==='more'?'more':k)}<span>${l}</span></button>`;

/* ===== المرحلة 3: إدارة الأفكار ===== */
let FM={mode:'quick',tags:[],files:[]},TAB='overview',openId=null,editId=null;
const TABS=[['overview','نظرة عامة'],['map','الخريطة الذهنية'],['tasks','المهام'],['notes','الملاحظات'],['files','الملفات'],['links','الروابط'],['log','النشاط']];
const cats=()=>[...CATS,...DB.get('cats:'+Auth.session().id,[])];
const navKey=()=>['idea','new'].includes(page)?'ideas':page;
const curIdea=()=>Ideas.all().find(x=>x.id===openId);
const T=x=>esc(x||'').replace(/\n/g,'<br>'),txt=h=>(h||'').replace(/<[^>]*>/g,' ');
const nrm=t=>String(t||'').toLowerCase().replace(/[\u064B-\u0652\u0640]/g,'').replace(/[أإآٱ]/g,'ا').replace(/ى/g,'ي').replace(/ة/g,'ه');
const hay=i=>nrm([i.title,i.body,i.category,i.problem,i.solution,i.audience,i.model,i.remarks,txt(i.notes),(i.tags||[]).join(' ').replace(/_/g,' ')].join(' '));
const normTag=t=>t.trim().replace(/^#+/,'').replace(/\s+/g,'_').slice(0,30);
const normUrl=u=>{u=u.trim();if(!u)return '';if(!/^https?:\/\//i.test(u))u='https://'+u;try{return new URL(u).href}catch(e){return ''}};
const OKT=new Set(['B','STRONG','I','EM','U','H2','H3','UL','OL','LI','A','P','DIV','BR','INPUT','SPAN']);
function clean(html){const t=document.createElement('template');t.innerHTML=html||'';
 const walk=p=>{[...p.childNodes].forEach(c=>{if(c.nodeType!==1)return;const g=c.tagName;if(['SCRIPT','STYLE','IFRAME','OBJECT','EMBED','LINK','META'].includes(g)){c.remove();return}walk(c);if(!OKT.has(g)){c.replaceWith(...c.childNodes);return}
  [...c.attributes].forEach(a=>{const n=a.name;if(g==='A'&&n==='href'&&/^https?:\/\//i.test(a.value))return;if(g==='INPUT'&&((n==='type'&&a.value==='checkbox')||n==='checked'))return;if(g==='UL'&&n==='class'&&a.value==='chk')return;c.removeAttribute(n)});
  if(g==='INPUT'&&c.type!=='checkbox')c.remove();if(g==='A'){c.setAttribute('target','_blank');c.setAttribute('rel','noopener noreferrer')}})};
 walk(t.content);return t.innerHTML}
const OKF=['image/png','image/jpeg','image/gif','image/webp','application/pdf','text/plain','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],MAXF=2*1024*1024;
const readFile=f=>new Promise(r=>{if(!OKF.includes(f.type)){toast('نوع الملف غير مدعوم. المسموح: صور وPDF ونص ومستندات Word وExcel.','error');return r(null)}if(f.size>MAXF){toast('حجم «'+f.name+'» أكبر من 2 ميغابايت.','error');return r(null)}const fr=new FileReader();fr.onload=()=>r({id:uid(),name:f.name.slice(0,120),type:f.type,size:f.size,data:fr.result});fr.onerror=()=>{toast('تعذّرت قراءة الملف.','error');r(null)};fr.readAsDataURL(f)});
const fileView=(f,rm)=>!/^data:[\w.+\/-]+;base64,/.test(f.data||'')?'<div class="card fcard small">ملف غير صالح</div>':`<div class="card fcard">${f.type.startsWith('image/')?`<img src="${f.data}" alt="${esc(f.name)}">`:f.type==='application/pdf'?`<embed src="${f.data}" type="application/pdf">`:''}<div class="small">${esc(f.name)}</div><div class="row small"><a class="link" href="${f.data}" download="${esc(f.name)}">تنزيل</a>${rm?`<button class="link" data-rmf="${f.id}">حذف</button>`:''}</div></div>`;
function newIdea(id=null){editId=id;page='new';render();scrollTo(0,0)}
function openIdea(id){if(!Ideas.all().some(x=>x.id===id)){toast('تعذر العثور على الفكرة.','error');return}openId=id;TAB='overview';Ideas.open(id);page='idea';render();scrollTo(0,0)}

function renderForm(){const e=editId?Ideas.all().find(x=>x.id===editId):null,v=e||DB.get('draft:'+Auth.session().id,{});
 FM={mode:e?'adv':'quick',tags:[...(v.tags||[])],files:[...(v.files||[])]};
 const ta=(id,l,val)=>`<div class="field"><label for="${id}">${l}</label><textarea class="input" id="${id}">${esc(val||'')}</textarea></div>`;
 return `<div class="card"><div class="tabs" role="tablist"><button class="tab" role="tab" data-mode="quick" aria-selected="${!e}">الوضع السريع</button><button class="tab" role="tab" data-mode="adv" aria-selected="${!!e}">الوضع المتقدم</button></div><div style="margin-top:18px">
 <div class="field"><label for="f-t">عنوان الفكرة</label><input class="input" id="f-t" maxlength="120" value="${esc(v.title||'')}"><span class="err" id="f-t-e" role="alert"></span></div>
 ${ta('f-b','وصف قصير',v.body)}
 <div class="field"><label for="f-c">التصنيف</label><div class="row" style="flex-wrap:nowrap"><select class="input" id="f-c">${catOpts(v.category)}</select><button class="btn" type="button" id="f-ac">+ تصنيف</button></div><div class="row" id="ncrow" hidden style="flex-wrap:nowrap"><input class="input" id="f-nc" placeholder="اسم التصنيف الجديد" maxlength="30"><button class="btn" type="button" id="f-ncs">إضافة</button></div></div>
 <div class="field"><label for="f-tag">الوسوم</label><input class="input" id="f-tag" placeholder="اكتب وسمًا ثم اضغط Enter"><div class="meta" id="tagbox"></div></div>
 <div id="adv" ${e?'':'hidden'}>${ta('f-pr','المشكلة',v.problem)}${ta('f-so','الحل المقترح',v.solution)}${ta('f-au','الجمهور المستهدف',v.audience)}${ta('f-bm','نموذج العمل',v.model)}${ta('f-rm','الملاحظات',v.remarks)}
 <div class="fgrid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))"><div class="field"><label for="f-p">الأولوية</label><select class="input" id="f-p">${opts(PRI,v.priority||'medium')}</select></div><div class="field"><label for="f-s">الحالة</label><select class="input" id="f-s">${opts(STATUS,v.status||'new')}</select></div><div class="field"><label for="f-d">الموعد المستهدف</label><input class="input ltr" type="date" id="f-d" value="${v.due||''}"></div></div>
 ${ta('f-l','الروابط (رابط في كل سطر)',(v.links||[]).join('\n'))}
 <div class="field"><label for="f-file">المرفقات: صور أو PDF أو ملفات (حتى 2 ميغابايت للملف)</label><input class="input" type="file" id="f-file" multiple accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,.docx,.xlsx"><ul id="fl" class="plain"></ul></div>
 <div class="field"><label for="f-g">نسبة التقدم</label><input type="range" id="f-g" min="0" max="100" step="5" value="${v.progress||0}"></div></div>
 <div class="row" style="justify-content:flex-start;margin-top:8px"><button class="btn primary" id="f-ok">${e?'حفظ التغييرات':'إنشاء الفكرة'}</button><button class="btn" id="f-x">إلغاء</button></div></div></div>`}
function bindForm(){
 const e=editId?Ideas.all().find(x=>x.id===editId):null,adv=$('#adv');if(!adv)return;
 document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{FM.mode=b.dataset.mode;document.querySelectorAll('[data-mode]').forEach(x=>x.setAttribute('aria-selected',String(x===b)));adv.hidden=FM.mode!=='adv'});
 const dk='draft:'+Auth.session().id,sd=()=>{if(e)return;const g=id=>$(id)?$(id).value:'';DB.set(dk,{title:g('#f-t'),body:g('#f-b'),category:g('#f-c'),tags:FM.tags,problem:g('#f-pr'),solution:g('#f-so'),audience:g('#f-au'),model:g('#f-bm'),remarks:g('#f-rm'),links:g('#f-l').split('\n').filter(Boolean)})};
 if(!e){$('#f-t').closest('.card').addEventListener('input',sd);if(DB.get(dk,{}).title)toast('تم استرجاع مسودتك السابقة.')}
 const paint=()=>{sd();$('#tagbox').innerHTML=FM.tags.map((t,k)=>`<span class="chip">#${esc(t)}<button type="button" data-rt="${k}" aria-label="حذف الوسم">×</button></span>`).join('');
  $('#fl').innerHTML=FM.files.map((x,k)=>`<li class="row small"><span>${esc(x.name)}</span><button class="link" type="button" data-rf="${k}">إزالة</button></li>`).join('');
  document.querySelectorAll('[data-rt]').forEach(b=>b.onclick=()=>{FM.tags.splice(+b.dataset.rt,1);paint()});document.querySelectorAll('[data-rf]').forEach(b=>b.onclick=()=>{FM.files.splice(+b.dataset.rf,1);paint()})};paint();
 const addTag=()=>{const i=$('#f-tag'),t=normTag(i.value);if(t&&!FM.tags.includes(t))FM.tags.push(t);i.value='';paint()};
 $('#f-tag').onkeydown=ev=>{if(ev.key==='Enter'||ev.key===','){ev.preventDefault();addTag()}};
 $('#f-ac').onclick=()=>{$('#ncrow').hidden=false;$('#f-nc').focus()};
 $('#f-ncs').onclick=()=>{const n=$('#f-nc').value.trim();if(!n)return;const k='cats:'+Auth.session().id;if(!cats().includes(n))DB.set(k,[...DB.get(k,[]),n]);$('#f-c').innerHTML=catOpts(n);$('#ncrow').hidden=true;$('#f-nc').value='';toast('تمت إضافة التصنيف.')};
 $('#f-file').onchange=async ev=>{for(const x of ev.target.files){const d=await readFile(x);if(d)FM.files.push(d)}ev.target.value='';paint()};
 $('#f-x').onclick=()=>{if(e)openId=e.id;page=e?'idea':'ideas';render()};
 $('#f-ok').onclick=()=>{const t=$('#f-t').value.trim();if(!t){setErr('f-t','اكتب عنوانًا للفكرة.');$('#f-t').focus();return}
  addTag();const v=id=>$(id).value.trim();
  const d={title:t,body:v('#f-b'),category:$('#f-c').value,tags:FM.tags,problem:v('#f-pr'),solution:v('#f-so'),audience:v('#f-au'),model:v('#f-bm'),remarks:v('#f-rm'),priority:$('#f-p').value,status:$('#f-s').value,due:$('#f-d').value,links:[...new Set($('#f-l').value.split('\n').map(normUrl).filter(Boolean))],files:FM.files,progress:+$('#f-g').value};
  if(d.status==='done')d.progress=100;let r;
  if(e){const lg=[];if(d.body!==e.body)lg.push('تم تعديل الوصف');if(d.status!==e.status)lg.push('تم تغيير الحالة إلى '+STATUS[d.status]);
   if(['title','category','problem','solution','audience','model','remarks','priority','due'].some(k=>(d[k]||'')!==(e[k]||''))||JSON.stringify(d.tags)!==JSON.stringify(e.tags||[])||JSON.stringify(d.links)!==JSON.stringify(e.links||[]))lg.push('تم تعديل بيانات الفكرة');
   if(d.files.map(x=>x.id).join()!==(e.files||[]).map(x=>x.id).join())lg.push('تم تحديث المرفقات');
   r=Ideas.update(e.id,d,true,lg)?e:null}else r=Ideas.add(d);
  if(!r){toast('تعذّر الحفظ. قد تكون مساحة التخزين ممتلئة، جرّب تقليل حجم المرفقات.','error');return}
  if(!e)DB.del(dk);openId=r.id;TAB='overview';page='idea';toast(e?'تم حفظ التغييرات.':'تم إنشاء الفكرة.');render();scrollTo(0,0)}
}
function renderIdea(){const i=curIdea();if(!i){page='ideas';return emptyIdeas()}
 const kv=(l,v)=>v?`<div><div class="muted small">${l}</div><div>${v}</div></div>`:'';
 const body={
 overview:()=>`<div class="card stack" style="gap:16px"><div class="fgrid2"><div class="field"><label for="d-st">الحالة</label><select class="input" id="d-st">${opts(STATUS,i.status)}</select></div><div class="field"><label for="d-ct">التصنيف</label><select class="input" id="d-ct">${catOpts(i.category)}</select></div></div><div class="meta"><span class="badge">${i.archived?'📦 مؤرشفة':STATUS[i.status]}</span><span class="badge neutral">الأولوية: ${PRI[i.priority]||''}</span>${i.category?`<span class="badge neutral">${esc(i.category)}</span>`:''}${(i.tags||[]).map(t=>`<span class="badge neutral">#${esc(t)}</span>`).join('')}</div><div class="prog"><i style="width:${i.progress}%"></i></div>${kv('الوصف',T(i.body))}${kv('المشكلة',T(i.problem))}${kv('الحل المقترح',T(i.solution))}${kv('الجمهور المستهدف',T(i.audience))}${kv('نموذج العمل',T(i.model))}${kv('الموعد المستهدف',i.due?new Date(i.due).toLocaleDateString('ar'):'')}${kv('الملاحظات',T(i.remarks))}</div>`,
 map:()=>mapTab(i),
 tasks:()=>`<div class="card stack"><div class="row" style="flex-wrap:nowrap"><input class="input" id="t-in" placeholder="أضف مهمة جديدة" maxlength="200"><button class="btn primary" id="t-add">إضافة</button></div>${(i.tasks||[]).length?`<ul class="plain">${i.tasks.map(k=>`<li class="row"><label class="row" style="flex-wrap:nowrap;justify-content:flex-start"><input type="checkbox" data-tk="${k.id}" ${k.done?'checked':''}><span ${k.done?'style="text-decoration:line-through;opacity:.6"':''}>${esc(k.text)}</span></label><button class="link" data-td="${k.id}">حذف</button></li>`).join('')}</ul>`:'<p class="muted">لا توجد مهام بعد. أضف أول مهمة لهذه الفكرة.</p>'}</div>`,
 notes:()=>`<div class="card"><div class="etb"><button class="btn" data-cmd="bold" aria-label="غامق"><b>غ</b></button><button class="btn" data-cmd="italic" aria-label="مائل"><i>م</i></button><button class="btn" data-cmd="h2">عنوان</button><button class="btn" data-cmd="ul">قائمة</button><button class="btn" data-cmd="ol">مرقّمة</button><button class="btn" data-cmd="chk">قائمة مهام</button><button class="btn" data-cmd="link">رابط</button></div><div class="row" id="lkrow" hidden style="flex-wrap:nowrap;margin-bottom:8px"><input class="input ltr" id="lk" placeholder="https://"><button class="btn" id="lk-ok">إدراج</button></div><div class="ed" id="ed" contenteditable="true" role="textbox" aria-multiline="true" aria-label="الملاحظات" data-ph="اكتب ملاحظاتك هنا…">${clean(i.notes)}</div><div class="status small" id="ns" style="margin-top:8px"><span class="dot"></span>تم الحفظ</div></div>`,
 files:()=>`<div class="card stack"><input class="input" type="file" id="d-file" multiple accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,.docx,.xlsx" aria-label="إضافة ملفات">${(i.files||[]).length?`<div class="files">${i.files.map(x=>fileView(x,true)).join('')}</div>`:'<p class="muted">لا توجد ملفات. أرفق صورًا أو PDF أو أي ملف (حتى 2 ميغابايت).</p>'}</div>`,
 links:()=>`<div class="card stack"><div class="row" style="flex-wrap:nowrap"><input class="input ltr" id="l-in" placeholder="https://example.com"><button class="btn primary" id="l-add">إضافة</button></div>${(i.links||[]).length?`<ul class="plain">${i.links.map((u,k)=>`<li class="row"><a class="link" dir="ltr" href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a><button class="link" data-rl="${k}">حذف</button></li>`).join('')}</ul>`:'<p class="muted">لا توجد روابط بعد.</p>'}</div>`,
 log:()=>`<div class="card"><ul class="plain">${[...(i.log&&i.log.length?i.log:[{t:i.createdAt,m:'تم إنشاء الفكرة'}])].reverse().map(l=>`<li class="row" title="${new Date(l.t).toLocaleString('ar')}"><span>${esc(l.m)}</span><span class="muted small">${ago(l.t)}</span></li>`).join('')}</ul></div>`};
 return `<div class="row" style="margin-bottom:16px"><button class="btn ghost" id="d-back">رجوع</button><div class="row"><button class="btn" id="d-map">🧠 الخريطة الذهنية</button><button class="btn" id="d-ai">✨ حوّل فكرتي إلى خريطة ذهنية</button><button class="btn" id="d-edit">تعديل</button><button class="btn" id="d-fav">${i.favorite?'★ في المفضلة':'☆ مفضلة'}</button><button class="btn" id="d-share">مشاركة</button><button class="btn" id="d-arch">${i.archived?'استعادة':'أرشفة'}</button><button class="btn danger" id="d-del">حذف</button><div class="dd"><button class="btn" id="d-more" aria-haspopup="true">المزيد</button><div class="dd-menu" id="d-menu" hidden><button class="nav" id="d-dup">تكرار الفكرة</button></div></div></div></div><div class="tabs" role="tablist">${TABS.map(([k,l])=>`<button class="tab" role="tab" data-tab="${k}" aria-selected="${k===TAB}">${l}</button>`).join('')}</div><div style="margin-top:16px">${body[TAB]()}</div>`}
function bindDetail(){const i=curIdea();if(!i)return;
 document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{TAB=b.dataset.tab;render()});
 $('#d-back').onclick=()=>{page='ideas';render()};$('#d-edit').onclick=()=>newIdea(i.id);
 $('#d-ai').onclick=()=>aiMap(i.id);
 $('#d-map').onclick=()=>{if(DB.get(mapKey(i.id),null))openMap(i.id);else{TAB='map';render()}};
 const ds=$('#d-st');if(ds){ds.onchange=()=>{const p={status:ds.value};if(p.status==='done')p.progress=100;if(!Ideas.update(i.id,p,true,['تم تغيير الحالة إلى '+STATUS[p.status]]))toast('تعذّر حفظ التغييرات.','error');render()};
  $('#d-ct').onchange=e=>{if(!Ideas.update(i.id,{category:e.target.value},true,['تم تعديل بيانات الفكرة']))toast('تعذّر حفظ التغييرات.','error');render()}}
 $('#d-fav').onclick=()=>{Ideas.update(i.id,{favorite:!i.favorite},false);render()};
 $('#d-share').onclick=async()=>{const t=[i.title,i.body,(i.tags||[]).map(x=>'#'+x).join(' ')].filter(Boolean).join('\n');try{if(navigator.share)await navigator.share({title:i.title,text:t});else{await navigator.clipboard.writeText(t);toast('تم نسخ ملخص الفكرة.')}}catch(e){if(e.name!=='AbortError')toast('تعذّرت المشاركة.','error')}};
 $('#d-arch').onclick=()=>{Ideas.update(i.id,{archived:!i.archived},true,[i.archived?'تمت استعادة الفكرة':'تمت أرشفة الفكرة']);toast(i.archived?'تمت استعادة الفكرة.':'تمت أرشفة الفكرة.');page='ideas';render()};
 const dl=$('#d-del');dl.onclick=()=>{if(dl.dataset.sure){Ideas.remove(i.id);toast('تم حذف الفكرة.');page='ideas';render()}else{dl.dataset.sure=1;dl.textContent='اضغط للتأكيد'}};
 $('#d-more').onclick=()=>{$('#d-menu').hidden=!$('#d-menu').hidden};
 $('#d-dup').onclick=()=>{const {id,log,createdAt,updatedAt,openedAt,...r}=i,n=Ideas.add({...r,title:i.title+' (نسخة)',favorite:false,archived:false});if(n){openId=n.id;TAB='overview';toast('تم تكرار الفكرة.');render()}else toast('تعذّر الحفظ.','error')};
 const up=(p,lg)=>{if(!Ideas.update(i.id,p,true,lg||[]))toast('تعذّر الحفظ. قد تكون مساحة التخزين ممتلئة.','error');render()};
 if(TAB==='tasks'){const add=()=>{const t=$('#t-in').value.trim();if(t){up({tasks:[...(i.tasks||[]),{id:uid(),text:t,done:false}]},['تم إضافة مهمة: '+t]);$('#t-in')?.focus()}};$('#t-add').onclick=add;$('#t-in').onkeydown=ev=>{if(ev.key==='Enter')add()};
  document.querySelectorAll('[data-tk]').forEach(c=>c.onchange=()=>up({tasks:i.tasks.map(k=>k.id===c.dataset.tk?{...k,done:c.checked}:k)},c.checked?['تم إنجاز مهمة']:[]));
  document.querySelectorAll('[data-td]').forEach(b=>b.onclick=()=>up({tasks:i.tasks.filter(k=>k.id!==b.dataset.td)},['تم حذف مهمة']))}
 if(TAB==='links'){const add=()=>{const u=normUrl($('#l-in').value);if(!u){toast('أدخل رابطًا صحيحًا.','error');return}up({links:[...new Set([...(i.links||[]),u])]},['تمت إضافة رابط'])};$('#l-add').onclick=add;$('#l-in').onkeydown=ev=>{if(ev.key==='Enter')add()};document.querySelectorAll('[data-rl]').forEach(b=>b.onclick=()=>up({links:i.links.filter((_,k)=>k!==+b.dataset.rl)},['تم حذف رابط']))}
 if(TAB==='files'){$('#d-file').onchange=async ev=>{const n=[];for(const x of ev.target.files){const d=await readFile(x);if(d)n.push(d)}if(n.length)up({files:[...(i.files||[]),...n]},n.map(x=>'تمت إضافة ملف: '+x.name))};document.querySelectorAll('[data-rmf]').forEach(b=>b.onclick=()=>up({files:i.files.filter(x=>x.id!==b.dataset.rmf)},['تم حذف ملف']))}
 if(TAB==='map'){const c=$('#mk-create'),o=$('#mk-open'),dm=$('#mk-del'),ab=$('#mk-ai');if(ab)ab.onclick=()=>aiMap(i.id);if(c)c.onclick=()=>{if(createMap(i))openMap(i.id)};if(o)o.onclick=()=>openMap(i.id);if(dm)dm.onclick=()=>{if(dm.dataset.sure){DB.del(mapKey(i.id));Ideas.update(i.id,{},true,['تم حذف الخريطة الذهنية']);toast('تم حذف الخريطة.');render()}else{dm.dataset.sure=1;dm.textContent='اضغط للتأكيد'}}}
 if(TAB==='notes')bindEditor()}
function bindEditor(){const ed=$('#ed');let tm,rng;
 const save=()=>{ed.querySelectorAll('input').forEach(c=>c.checked?c.setAttribute('checked',''):c.removeAttribute('checked'));$('#ns').innerHTML='<span class="dot busy"></span>جارٍ الحفظ…';clearTimeout(tm);
  tm=setTimeout(()=>{const c=curIdea();if(!c)return;const last=(c.log||[]).slice(-1)[0],lg=last&&last.m==='تم تحديث الملاحظات'&&Date.now()-last.t<6e5?[]:['تم تحديث الملاحظات'];const ok=Ideas.update(c.id,{notes:clean(ed.innerHTML)},true,lg),s=$('#ns');if(s)s.innerHTML=ok?'<span class="dot"></span>تم الحفظ':'تعذّر الحفظ'},500)};
 ed.oninput=save;ed.onchange=save;
 ed.onkeydown=ev=>{if(ev.key==='Enter')setTimeout(()=>{const n=getSelection().anchorNode,el=n&&(n.nodeType===3?n.parentNode:n),li=el&&el.closest&&el.closest('ul.chk li');if(li&&!li.querySelector('input'))li.insertAdjacentHTML('afterbegin','<input type="checkbox">')},0)};
 document.querySelectorAll('[data-cmd]').forEach(b=>{b.onmousedown=ev=>ev.preventDefault();b.onclick=()=>{const c=b.dataset.cmd;ed.focus();
  if(c==='bold'||c==='italic')document.execCommand(c);else if(c==='h2')document.execCommand('formatBlock',false,'H2');else if(c==='ul')document.execCommand('insertUnorderedList');else if(c==='ol')document.execCommand('insertOrderedList');
  else if(c==='chk')document.execCommand('insertHTML',false,'<ul class="chk"><li><input type="checkbox">&nbsp;</li></ul>');
  else{const s=getSelection();rng=s.rangeCount?s.getRangeAt(0).cloneRange():null;$('#lkrow').hidden=false;$('#lk').focus();return}
  save()}});
 $('#lk-ok').onclick=()=>{const u=normUrl($('#lk').value);if(!u){toast('أدخل رابطًا صحيحًا.','error');return}ed.focus();if(rng){const s=getSelection();s.removeAllRanges();s.addRange(rng)}document.execCommand('createLink',false,u);$('#lkrow').hidden=true;$('#lk').value='';save()}}

/* ===== المرحلة 4: محرك الخريطة الذهنية ===== */
const TYPES={idea:['فكرة','💡'],feature:['ميزة','⭐'],problem:['مشكلة','⚠️'],solution:['حل','🛠️'],audience:['جمهور','👥'],competitor:['منافس','🏁'],task:['مهمة','☑️'],goal:['هدف','🎯'],note:['ملاحظة','📝'],question:['سؤال','❓']};
const COLORS={def:'افتراضي',blue:'أزرق',purple:'بنفسجي',green:'أخضر',orange:'برتقالي',red:'أحمر',gray:'رمادي'};
const GAP=16,HG=70,mapKey=id=>'map:'+Auth.session().id+':'+id;
let S=null,ix={};
const cvx=document.createElement('canvas').getContext('2d');
const tw=(t,fs,w)=>{cvx.font=`${w} ${fs}px "IBM Plex Sans Arabic",Tahoma,sans-serif`;return cvx.measureText(t).width};
const mkNode=(mid,pid,title,type,order,x,y)=>{const n=Date.now();return{id:uid(),mindMapId:mid,parentId:pid,title,description:'',notes:'',type,positionX:x,positionY:y,color:'def',icon:pid?'':TYPES[type][1],isCollapsed:false,isCompleted:false,order,createdAt:n,updatedAt:n}};
function mapTab(i){const m=DB.get(mapKey(i.id),null),ai=`<button class="btn ${m?'':'primary'}" id="mk-ai">✨ حوّل فكرتي إلى خريطة ذهنية</button>`;
 return m?`<div class="card empty"><div class="ic">${ic('maps')}</div><h2>${esc(m.title)}</h2><p class="muted">${N(m.nodes.length)} عقدة — آخر تحديث ${ago(m.updatedAt)}</p><div class="row" style="justify-content:center"><button class="btn primary" id="mk-open">فتح الخريطة</button>${ai}<button class="btn ghost danger" id="mk-del">حذف الخريطة</button></div></div>`
 :`<div class="card empty"><div class="ic">${ic('maps')}</div><h2>لا توجد خريطة ذهنية بعد</h2><p class="muted">حوّل فكرتك إلى فروع مترابطة بالذكاء الاصطناعي، أو ابدأ خريطة فارغة وابنها بنفسك.</p><div class="row" style="justify-content:center">${ai}<button class="btn" id="mk-create">إنشاء خريطة فارغة</button></div></div>`}
