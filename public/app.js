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

/* ===== الذكاء الاصطناعي (Gemini عبر الخادم فقط — لا مفاتيح في الواجهة) ===== */
const AI={busy:false};
const aiMsg=(e,fb)=>e.status===0?'تعذر الاتصال بالخادم.':(e.message||fb);
function aiConfirm(ideaId){modal(`<h2>استبدال الخريطة؟</h2><p class="muted" style="margin:8px 0 18px">توجد خريطة ذهنية حالية. هل تريد استبدالها بالخريطة الجديدة؟</p><div class="row" style="justify-content:flex-end"><button class="btn" id="ai-x">إلغاء</button><button class="btn primary" id="ai-ok">استبدال الخريطة</button></div>`);
 $('#ai-x').onclick=closeModal;$('#ai-ok').onclick=()=>{closeModal();aiMap(ideaId,true)}}
async function aiMap(ideaId,replace=false){
 if(AI.busy||!Ideas.all().some(x=>x.id===ideaId))return;
 if(!replace&&DB.get(mapKey(ideaId),null)){aiConfirm(ideaId);return}
 AI.busy=true;modal('<div class="row" style="justify-content:flex-start;flex-wrap:nowrap" role="status"><span class="spin" aria-hidden="true"></span><h2>جاري تحليل فكرتك وإنشاء الخريطة...</h2></div>');
 try{await Sync.drain();const r=await api('POST','/api/ai/map',{ideaId,replace});
  CACHE.set(mapKey(ideaId),JSON.stringify(r.map));Ideas.update(ideaId,{},true,['تم إنشاء خريطة ذهنية بالذكاء الاصطناعي']);
  closeModal();AI.busy=false;toast('تم إنشاء الخريطة الذهنية بنجاح.');openMap(ideaId)}
 catch(e){AI.busy=false;closeModal();if(e.code==='map_exists'&&!replace)aiConfirm(ideaId);else toast(aiMsg(e,'تعذر إنشاء الخريطة الذهنية. حاول مرة أخرى.'),'error')}}
async function aiExpand(id){const n=ix.by[id];if(!n||AI.busy)return;AI.busy=true;S.ai=true;stat();clearTimeout(S.sv);persist();
 try{await Sync.drain();const r=await api('POST','/api/ai/expand',{ideaId:S.ideaId,nodeId:id});
  if(S&&page==='map'){hpush('');S.M.nodes=r.map.nodes;S.M.conns=r.map.conns;S.M.updatedAt=r.map.updatedAt;CACHE.set(mapKey(S.ideaId),JSON.stringify(S.M));
   draw();insp();const nn=ix.by[id];autoLayout(S.M.manual?nn:ix.root,true,()=>reveal(nn));toast('تم توسيع الفرع بنجاح.')}}
 catch(e){toast(aiMsg(e,'تعذر توسيع الفرع. حاول مرة أخرى.'),'error')}
 AI.busy=false;if(S){S.ai=false;stat()}}
function createMap(i){const n=Date.now(),mid=uid(),M={id:mid,userId:Auth.session().id,ideaId:i.id,title:i.title,description:'',createdAt:n,updatedAt:n,manual:false,nodes:[mkNode(mid,null,i.title,'idea',0,0,0)],conns:[]};
 if(!DB.set(mapKey(i.id),M)){toast('تعذّر إنشاء الخريطة. تحقق من مساحة التخزين.','error');return false}Ideas.update(i.id,{},true,['تم إنشاء خريطة ذهنية']);return true}
function openMap(id){if(!Ideas.all().some(x=>x.id===id)){toast('تعذر العثور على الفكرة.','error');page='ideas';render();return}S={ideaId:id,view:{x:0,y:0,k:1},sel:new Set(),H:{u:[],r:[],key:'',t:0},st:'saved',M:null};page='map';render()}
function loadMap(){try{if(!Ideas.all().some(x=>x.id===S.ideaId))return false;const raw=CACHE.get(mapKey(S.ideaId));if(!raw)return false;const M=JSON.parse(raw);
 if(M.userId!==Auth.session().id||M.ideaId!==S.ideaId||!Array.isArray(M.nodes)||!M.nodes.length)return false;S.M=M;return true}catch(e){return false}}
function leaveMap(){clearTimeout(S.sv);if(S.M)persist();const id=S.ideaId;S=null;openId=id;TAB='map';page='idea';render()}
const dim=(n,d)=>{const root=!n.parentId,fs=root?18:d===1?15:14,t=(n.icon?n.icon+' ':'')+n.title+(n.isCompleted?' ✓':'');return{fs,h:root?58:d===1?46:40,w:Math.max(root?150:96,Math.ceil(tw(t,fs,root?700:600))+(root?48:34))}};
function index(){const by={},kids={},dep={},hid=new Set(),desc={},dm={},roots=[];S.M.nodes.forEach(n=>{by[n.id]=n;kids[n.id]=[]});
 S.M.nodes.forEach(n=>(n.parentId&&by[n.parentId]?kids[n.parentId]:roots).push(n));Object.values(kids).forEach(a=>a.sort((p,q)=>p.order-q.order));
 const walk=(n,d,h)=>{dep[n.id]=d;if(h)hid.add(n.id);let c=0;kids[n.id].forEach(k=>{c+=1+walk(k,d+1,h||n.isCollapsed)});desc[n.id]=c;return c};roots.forEach(r=>walk(r,0,false));
 S.M.nodes.forEach(n=>{dm[n.id]=dim(n,dep[n.id]||0)});ix={by,kids,dep,hid,desc,dm,root:roots[0]}}
const ctr=n=>({x:n.positionX+ix.dm[n.id].w/2,y:n.positionY+ix.dm[n.id].h/2});
function edgePath(a,b){const da=ix.dm[a.id],db=ix.dm[b.id],left=b.positionX+db.w/2<a.positionX+da.w/2,ax=left?a.positionX:a.positionX+da.w,bx=left?b.positionX+db.w:b.positionX,ay=a.positionY+da.h/2,by=b.positionY+db.h/2,dx=Math.max(30,Math.abs(ax-bx)/2),q=left?-1:1;return `M${ax} ${ay}C${ax+q*dx} ${ay} ${bx-q*dx} ${by} ${bx} ${by}`}
function nodeSVG(n){const d=ix.dm[n.id],root=!n.parentId,k=ix.kids[n.id].length,t=(n.icon?n.icon+' ':'')+n.title+(n.isCompleted?' ✓':'');
 const tg=k?(n.isCollapsed?`<g class="tg" data-tg="${n.id}" transform="translate(-6 ${d.h/2})" role="button" tabindex="0" aria-label="فتح الفرع"><rect x="-30" y="-11" width="36" height="22" rx="11"/><text y="4" x="-12" text-anchor="middle">+${N(ix.desc[n.id])}</text></g>`:`<g class="tg" data-tg="${n.id}" transform="translate(-6 ${d.h/2})" role="button" tabindex="0" aria-label="طي الفرع"><circle cx="-10" r="9"/><text y="4" x="-10" text-anchor="middle">−</text></g>`):'';
 return `<g class="nd c-${n.color||'def'}${root?' root':''}${n.isCompleted?' done':''}${S.sel.has(n.id)?' sel':''}${S.pop===n.id?' pop':''}" data-id="${n.id}" transform="translate(${n.positionX} ${n.positionY})" tabindex="0" role="button" aria-label="${esc(n.title)}"><rect width="${d.w}" height="${d.h}" rx="${root?18:12}"/><text x="${d.w/2}" y="${d.h/2}" dy=".35em" text-anchor="middle" style="font-size:${d.fs}px;font-weight:${root?700:600}">${esc(t)}</text>${tg}</g>`}
function connSVG(c){const a=ix.by[c.sourceNodeId],b=ix.by[c.targetNodeId],p=ctr(a),q=ctr(b);return `<g data-c="${c.id}"><path d="${edgePath(a,b)}"/>${c.label?`<text x="${(p.x+q.x)/2}" y="${(p.y+q.y)/2-6}" text-anchor="middle">${esc(c.label)}</text>`:''}</g>`}
function draw(){index();const {by,hid}=ix,vis=S.M.nodes.filter(n=>!hid.has(n.id));
 const ed=vis.filter(n=>n.parentId&&by[n.parentId]).map(n=>`<path data-e="${n.id}" d="${edgePath(by[n.parentId],n)}"/>`).join('');
 const cc=S.M.conns.filter(c=>by[c.sourceNodeId]&&by[c.targetNodeId]&&!hid.has(c.sourceNodeId)&&!hid.has(c.targetNodeId)).map(connSVG).join('');
 $('#vp').innerHTML=`<g class="eg">${ed}</g><g class="cg">${cc}</g><g class="ng">${vis.map(nodeSVG).join('')}</g>`;
 S.el={};S.ee={};S.ce={};document.querySelectorAll('#vp .ng>g').forEach(g=>S.el[g.dataset.id]=g);document.querySelectorAll('#vp .eg>path').forEach(p=>S.ee[p.dataset.e]=p);document.querySelectorAll('#vp .cg>g').forEach(g=>S.ce[g.dataset.c]=g);
 applyView();mini();hint();stat();hbtn();if(S.pop)setTimeout(()=>{if(S)S.pop=null},400)}
function upd(n){const el=S.el[n.id];if(el)el.setAttribute('transform',`translate(${n.positionX} ${n.positionY})`);
 const e=S.ee[n.id];if(e&&n.parentId&&ix.by[n.parentId])e.setAttribute('d',edgePath(ix.by[n.parentId],n));
 ix.kids[n.id].forEach(k=>{const x=S.ee[k.id];if(x)x.setAttribute('d',edgePath(n,k))});
 S.M.conns.forEach(c=>{if(c.sourceNodeId!==n.id&&c.targetNodeId!==n.id)return;const g=S.ce[c.id];if(!g)return;const a=ix.by[c.sourceNodeId],b=ix.by[c.targetNodeId];g.firstChild.setAttribute('d',edgePath(a,b));const t=g.querySelector('text');if(t){const p=ctr(a),q=ctr(b);t.setAttribute('x',(p.x+q.x)/2);t.setAttribute('y',(p.y+q.y)/2-6)}})}
function refreshNode(n){ix.dm[n.id]=dim(n,ix.dep[n.id]||0);const el=S.el[n.id];if(!el)return;el.outerHTML=nodeSVG(n);S.el[n.id]=document.querySelector(`#vp .ng>g[data-id="${n.id}"]`);upd(n);mini()}
const sz=()=>{const r=$('#sv').getBoundingClientRect();return{w:r.width,h:r.height}};
function applyView(){const v=S.view;$('#vp').setAttribute('transform',`translate(${v.x} ${v.y}) scale(${v.k})`);const z=$('#zl');if(z)z.textContent=N(Math.round(v.k*100))+'٪';mini()}
function setVw(v,anim=true){cancelAnimationFrame(S.vr);if(!anim){S.view=v;applyView();return}const a={...S.view},t0=performance.now();const f=t=>{const p=Math.min(1,(t-t0)/220),e=1-Math.pow(1-p,3);S.view={x:a.x+(v.x-a.x)*e,y:a.y+(v.y-a.y)*e,k:a.k+(v.k-a.k)*e};applyView();if(p<1)S.vr=requestAnimationFrame(f)};S.vr=requestAnimationFrame(f)}
function bounds(){let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;S.M.nodes.forEach(n=>{if(ix.hid.has(n.id))return;const d=ix.dm[n.id];x0=Math.min(x0,n.positionX);y0=Math.min(y0,n.positionY);x1=Math.max(x1,n.positionX+d.w);y1=Math.max(y1,n.positionY+d.h)});return{x0,y0,x1,y1}}
function fit(anim=true){const b=bounds(),s=sz(),p=70,k=Math.max(.15,Math.min(1.3,(s.w-p*2)/Math.max(1,b.x1-b.x0),(s.h-p*2)/Math.max(1,b.y1-b.y0)));setVw({k,x:s.w/2-k*(b.x0+b.x1)/2,y:s.h/2-k*(b.y0+b.y1)/2},anim)}
function centerOn(n,k,anim=true){const d=ix.dm[n.id],s=sz();setVw({k,x:s.w/2-k*(n.positionX+d.w/2),y:s.h/2-k*(n.positionY+d.h/2)},anim)}
function zoomBy(f,px,py,anim=true){const s=sz(),v=S.view,k=Math.min(2.5,Math.max(.15,v.k*f));px=px??s.w/2;py=py??s.h/2;setVw({k,x:px-(px-v.x)*k/v.k,y:py-(py-v.y)*k/v.k},anim)}
function reveal(n){const s=sz(),v=S.view,d=ix.dm[n.id],x=v.x+v.k*n.positionX,y=v.y+v.k*n.positionY;if(x<40||y<40||x+v.k*d.w>s.w-40||y+v.k*d.h>s.h-40)centerOn(n,Math.max(.6,v.k))}
function mini(){if(!S||S.mr)return;S.mr=requestAnimationFrame(()=>{if(!S)return;S.mr=0;const m=$('#mini');if(!m||!ix.root)return;const b=bounds(),s=sz(),v=S.view,vx=-v.x/v.k,vy=-v.y/v.k,vw=s.w/v.k,vh=s.h/v.k,x0=Math.min(b.x0-40,vx),y0=Math.min(b.y0-40,vy),x1=Math.max(b.x1+40,vx+vw),y1=Math.max(b.y1+40,vy+vh);
 m.setAttribute('viewBox',`${x0} ${y0} ${x1-x0} ${y1-y0}`);m.innerHTML=S.M.nodes.filter(n=>!ix.hid.has(n.id)).map(n=>{const d=ix.dm[n.id];return `<rect x="${n.positionX}" y="${n.positionY}" width="${d.w}" height="${d.h}" rx="8"${S.sel.has(n.id)?' class="ms"':''}/>`}).join('')+`<rect class="mv" x="${vx}" y="${vy}" width="${vw}" height="${vh}"/>`})}
const hint=()=>{const h=$('#hint');if(h)h.hidden=S.M.nodes.length>1};
function stat(){const e=$('#mm-st');if(!e)return;const m={saving:'<span class="dot busy"></span>جاري الحفظ...',saved:'<span class="dot"></span>تم الحفظ',offline:'<span class="dot busy"></span>غير متصل — سيتم الحفظ عند عودة الاتصال',error:'<span class="dot" style="background:var(--danger)"></span>تعذر حفظ آخر التغييرات. <button class="link" data-act="retry">إعادة المحاولة</button>'};e.innerHTML=S.ai?'<span class="dot busy"></span>جاري توسيع الفرع...':m[S.st]}
function dirty(){S.st=navigator.onLine?'saving':'offline';stat();clearTimeout(S.sv);S.sv=setTimeout(persist,400)}
function persist(){if(!S||!S.M)return false;S.M.updatedAt=Date.now();DB.set(mapKey(S.ideaId),S.M);S.st=navigator.onLine?'saving':'offline';stat();Sync.onIdle(ok=>{if(S){S.st=ok?(navigator.onLine?'saved':'offline'):'error';stat()}});return true}
/* التاريخ: تراجع / إعادة */
const snap=()=>JSON.stringify({n:S.M.nodes,c:S.M.conns,m:S.M.manual});
function hpush(key){const H=S.H,now=Date.now();if(key&&key===H.key&&now-H.t<1500){H.t=now;return}H.u.push(snap());if(H.u.length>100)H.u.shift();H.r=[];H.key=key||'';H.t=now}
function restore(t){const o=JSON.parse(t);S.M.nodes=o.n;S.M.conns=o.c;S.M.manual=o.m;S.sel=new Set([...S.sel].filter(id=>S.M.nodes.some(n=>n.id===id)))}
function undo(){const H=S.H;if(!H.u.length)return;cancelAnimationFrame(S.ar);H.r.push(snap());restore(H.u.pop());H.key='';draw();insp();dirty()}
function redo(){const H=S.H;if(!H.r.length)return;cancelAnimationFrame(S.ar);H.u.push(snap());restore(H.r.pop());H.key='';draw();insp();dirty()}
const hbtn=()=>{document.querySelectorAll('[data-act="undo"]').forEach(b=>b.disabled=!S.H.u.length);document.querySelectorAll('[data-act="redo"]').forEach(b=>b.disabled=!S.H.r.length)};
function mut(key,fn,full=true){hpush(key);fn();dirty();if(full){draw();insp()}}
function select(ids,add){if(!add)S.sel=new Set();ids.forEach(id=>add&&S.sel.has(id)?S.sel.delete(id):S.sel.add(id));syncSel();insp()}
function syncSel(){Object.entries(S.el).forEach(([id,el])=>el.classList.toggle('sel',S.sel.has(id)));mini()}
/* الترتيب التلقائي: شجرة أفقية، الجذر على اليمين والفروع نحو اليسار (اتجاه القراءة العربي) */
function sh(n,m){if(m[n.id]!=null)return m[n.id];const ks=n.isCollapsed?[]:ix.kids[n.id];let t=0;ks.forEach(k=>t+=sh(k,m));t+=Math.max(0,ks.length-1)*GAP;return m[n.id]=Math.max(ix.dm[n.id].h,t)}
function place(n,m,o){const d=ix.dm[n.id],ks=n.isCollapsed?[]:ix.kids[n.id];if(!ks.length)return;let H=(ks.length-1)*GAP;ks.forEach(k=>H+=sh(k,m));let t=o[n.id].y+d.h/2-H/2;ks.forEach(k=>{const h=sh(k,m),dk=ix.dm[k.id];o[k.id]={x:o[n.id].x-HG-dk.w,y:t+h/2-dk.h/2};t+=h+GAP;place(k,m,o)})}
function animateTo(out,anim,done){const ids=Object.keys(out),from={};ids.forEach(id=>from[id]={x:ix.by[id].positionX,y:ix.by[id].positionY});
 const fin=()=>{ids.forEach(id=>{const n=ix.by[id];n.positionX=Math.round(out[id].x);n.positionY=Math.round(out[id].y);upd(n)});dirty();mini();if(done)done()};
 cancelAnimationFrame(S.ar);if(!anim||ids.length>400){fin();return}const t0=performance.now();
 const f=t=>{const p=Math.min(1,(t-t0)/280),e=1-Math.pow(1-p,3);if(p>=1){fin();return}ids.forEach(id=>{const n=ix.by[id];n.positionX=from[id].x+(out[id].x-from[id].x)*e;n.positionY=from[id].y+(out[id].y-from[id].y)*e;upd(n)});S.ar=requestAnimationFrame(f)};S.ar=requestAnimationFrame(f)}
function autoLayout(n=ix.root,anim=true,done){const o={};o[n.id]={x:n.positionX,y:n.positionY};place(n,{},o);animateTo(o,anim,done)}
/* العمليات */
function afterAdd(nn,was){const p=ix.by[nn.parentId];
 if(!S.M.manual||was)autoLayout(S.M.manual?p:ix.root,true,()=>reveal(nn));
 else{const sb=ix.kids[p.id].filter(k=>k!==nn),l=sb[sb.length-1];nn.positionX=Math.round(p.positionX-HG-ix.dm[nn.id].w);nn.positionY=l?l.positionY+ix.dm[l.id].h+GAP:p.positionY;upd(nn);reveal(nn)}
 S.sel=new Set([nn.id]);syncSel();insp();hint()}
function addChild(pid,title){const p=ix.by[pid],was=p.isCollapsed;let nn;
 mut('',()=>{p.isCollapsed=false;const ks=ix.kids[pid];nn=mkNode(S.M.id,pid,title,'idea',ks.length?ks[ks.length-1].order+1:0,p.positionX-HG-110,p.positionY);S.pop=nn.id;S.M.nodes.push(nn)});afterAdd(nn,was);toast('تمت إضافة الفرع.')}
function addSibling(id,title){const n=ix.by[id];if(!n.parentId){toast('الفكرة الرئيسية ليس لها فرع بجانبها.','error');return}let nn;
 mut('',()=>{nn=mkNode(S.M.id,n.parentId,title,'idea',n.order+.5,n.positionX,n.positionY+60);S.pop=nn.id;S.M.nodes.push(nn);S.M.nodes.filter(x=>x.parentId===n.parentId).sort((a,b)=>a.order-b.order).forEach((x,i)=>x.order=i)});afterAdd(nn,false);toast('تمت إضافة الفرع.')}
function askBranch(kind,id){modal(`<h2 style="margin-bottom:14px">${kind==='sib'?'إضافة فرع بجانبه':'+ إضافة فرع'}</h2><div class="field"><label for="br-t">اسم الفرع</label><input class="input" id="br-t" maxlength="120" autocomplete="off"></div><div class="row" style="justify-content:flex-end"><button class="btn" id="br-x">إلغاء</button><button class="btn primary" id="br-ok">إضافة</button></div>`);
 const i=$('#br-t');setTimeout(()=>i.focus(),30);const ok=()=>{const t=i.value.trim();if(!t){i.setAttribute('aria-invalid','true');return}closeModal();kind==='sib'?addSibling(id,t):addChild(id,t)};$('#br-ok').onclick=ok;i.onkeydown=e=>{if(e.key==='Enter')ok()};$('#br-x').onclick=closeModal}
function delNodes(ids){ids=ids.filter(id=>ix.by[id]&&ix.by[id].parentId);if(!ids.length){toast('لا يمكن حذف الفكرة الرئيسية.','error');return}
 const go=()=>{const rm=new Set(),col=id=>{rm.add(id);ix.kids[id].forEach(k=>col(k.id))};ids.forEach(col);
  mut('',()=>{S.M.nodes=S.M.nodes.filter(n=>!rm.has(n.id));S.M.conns=S.M.conns.filter(c=>!rm.has(c.sourceNodeId)&&!rm.has(c.targetNodeId));S.sel=new Set([...S.sel].filter(i=>!rm.has(i)))});if(!S.M.manual)autoLayout();toast('تم حذف الفرع.')};
 if(!ids.some(id=>ix.kids[id].length)){go();return}
 modal(`<h2>هذا الفرع يحتوي على فروع أخرى.</h2><p class="muted" style="margin:8px 0 18px">هل تريد حذف الفرع وجميع الفروع الموجودة بداخله؟</p><div class="row" style="justify-content:flex-end"><button class="btn" id="dx">إلغاء</button><button class="btn" id="dok" style="background:var(--danger);border-color:var(--danger);color:#fff">حذف الكل</button></div>`);$('#dx').onclick=closeModal;$('#dok').onclick=()=>{closeModal();go()}}
function copyNode(id){const n=ix.by[id];if(!n.parentId){toast('لا يمكن نسخ الفكرة الرئيسية.','error');return}let nn;
 mut('',()=>{const man=S.M.manual,dup=(o,pid,top)=>{const t=Date.now(),c={...o,id:uid(),parentId:pid,createdAt:t,updatedAt:t,title:top?o.title+' (نسخة)':o.title,order:top?o.order+.5:o.order,positionX:o.positionX+(man?40:0),positionY:o.positionY+(man?40:0)};S.M.nodes.push(c);ix.kids[o.id].forEach(k=>dup(k,c.id,false));return c};nn=dup(n,n.parentId,true);S.pop=nn.id;S.M.nodes.filter(x=>x.parentId===n.parentId).sort((a,b)=>a.order-b.order).forEach((x,i)=>x.order=i)});
 if(!S.M.manual)autoLayout();S.sel=new Set([nn.id]);syncSel();insp();toast('تم نسخ الفرع.')}
function toggleCollapse(id){const n=ix.by[id];if(!ix.kids[id].length)return;mut('',()=>{n.isCollapsed=!n.isCollapsed});S.sel=new Set([...S.sel].filter(i=>!ix.hid.has(i)));syncSel();
 if(!S.M.manual)autoLayout();else if(!n.isCollapsed)autoLayout(n)}
function doSearch(dir){const q=nrm($('#sr-i').value.trim()),c=$('#sr-c');if(!q){S.hits=[];c.textContent='';return}S.hits=S.M.nodes.filter(n=>nrm(n.title+' '+n.description+' '+n.notes).includes(q));
 if(!S.hits.length){c.textContent='لا نتائج';return}S.hi=dir?((S.hi||0)+dir+S.hits.length)%S.hits.length:0;const n=S.hits[S.hi];c.textContent=`${N(S.hi+1)} من ${N(S.hits.length)}`;
 let p=ix.by[n.parentId],ch=false;while(p){if(p.isCollapsed){p.isCollapsed=false;ch=true}p=ix.by[p.parentId]}
 if(ch){hpush('');dirty();draw();if(!S.M.manual)autoLayout(ix.root,false)}
 const el=S.el[n.id];if(el){el.classList.add('hit');setTimeout(()=>el.classList.remove('hit'),2000)}centerOn(n,Math.max(S.view.k,1))}
/* القائمة السياقية */
const closeCtx=()=>{const c=$('#ctx');if(c)c.remove()};
function ctxMenu(x,y,id){closeCtx();const n=ix.by[id],m=document.createElement('div'),focus=sel=>{S.sel=new Set([id]);syncSel();insp();$('#insp').classList.add('open');setTimeout(()=>$(sel)?.focus(),60)};
 m.className='ctx';m.id='ctx';m.setAttribute('role','menu');
 const it=[['تعديل',()=>focus('#i-t')],['إضافة فرع',()=>askBranch('child',id)],['إضافة فرع بجانبه',()=>askBranch('sib',id)],['نسخ',()=>copyNode(id)],['حذف',()=>delNodes(S.sel.has(id)?[...S.sel]:[id])],[n.isCollapsed?'فتح الفرع':'طي الفرع',()=>toggleCollapse(id)],[n.isCompleted?'إلغاء الإكمال':'إكمال الفرع',()=>mut('',()=>{n.isCompleted=!n.isCompleted})],['تغيير اللون',null],['إضافة ملاحظة',()=>focus('#i-n')],['تحويل إلى مهمة',()=>nodeToTask(id)],['✨ توسيع هذا الفرع',()=>aiExpand(id)]];
 it.forEach(([l,f])=>{const b=document.createElement('button');b.className='nav';b.setAttribute('role','menuitem');b.textContent=l;
  if(f)b.onclick=()=>{closeCtx();f()};else b.onclick=()=>{if(m.querySelector('.sw'))return;const w=document.createElement('div');w.className='sw';w.innerHTML=Object.entries(COLORS).map(([k,lb])=>`<button type="button" class="c-${k}" data-col="${k}" aria-label="${lb}" title="${lb}"></button>`).join('');w.onclick=e=>{const c=e.target.dataset.col;if(c){closeCtx();setColor(id,c)}};b.after(w)};m.append(b)});
 $('#mm').append(m);m.style.left=Math.max(8,Math.min(x,innerWidth-226))+'px';m.style.top=Math.max(8,Math.min(y,innerHeight-m.offsetHeight-8))+'px'}
function nodeToTask(id){const n=ix.by[id],i=Ideas.all().find(x=>x.id===S.ideaId);if(!n||!i)return;if((i.tasks||[]).some(k=>k.text===n.title)){toast('هذه المهمة موجودة بالفعل في مهام الفكرة.','error');return}
 Ideas.update(i.id,{tasks:[...(i.tasks||[]),{id:uid(),text:n.title,done:false}]},true,['تم إضافة مهمة: '+n.title]);toast('أُضيف «'+n.title+'» إلى مهام الفكرة.')}
function setColor(id,c){const ids=S.sel.has(id)?[...S.sel]:[id];mut('',()=>ids.forEach(i=>{ix.by[i].color=c}))}
/* اللوحة الجانبية / الورقة السفلية */
function insp(){const el=$('#insp');if(!el)return;hbtn();const ids=[...S.sel].filter(id=>ix.by[id]);let h='<div class="grab" id="grab" aria-label="اسحب للأسفل للإغلاق"></div>';
 if(!ids.length){el.innerHTML=h+'<h3>تفاصيل الفرع</h3><p class="muted">اختر فرعًا من الخريطة لعرض تفاصيله وتعديله.</p>';el.classList.remove('open');grab(el);return}
 if(ids.length>1){el.innerHTML=h+`<h3>تم تحديد ${N(ids.length)} فروع</h3><div class="stack" style="margin-top:12px"><button class="btn" data-act="del">حذف المحدد</button></div>`;el.classList.add('open');grab(el);return}
 const n=ix.by[ids[0]],cs=S.M.conns.filter(c=>c.sourceNodeId===n.id||c.targetNodeId===n.id),nm=id=>esc((ix.by[id]||{}).title||'');
 el.innerHTML=h+`<h3>تفاصيل الفرع</h3><div class="field"><label for="i-t">اسم الفرع</label><input class="input" id="i-t" maxlength="120" value="${esc(n.title)}"></div><div class="field"><label for="i-d">الوصف</label><textarea class="input" id="i-d" style="min-height:70px">${esc(n.description)}</textarea></div>
<div class="fgrid2"><div class="field"><label for="i-ty">النوع</label><select class="input" id="i-ty">${Object.entries(TYPES).map(([k,v])=>`<option value="${k}" ${k===n.type?'selected':''}>${v[0]}</option>`).join('')}</select></div><div class="field"><label for="i-ic">الأيقونة</label><select class="input" id="i-ic"><option value="">بدون</option>${Object.values(TYPES).map(v=>`<option ${v[1]===n.icon?'selected':''}>${v[1]}</option>`).join('')}</select></div></div>
<div class="field"><label>اللون</label><div class="sw">${Object.entries(COLORS).map(([k,l])=>`<button type="button" class="c-${k}" data-col="${k}" aria-label="${l}" title="${l}" aria-pressed="${(n.color||'def')===k}"></button>`).join('')}</div></div>
<label class="row" style="justify-content:flex-start;margin-bottom:12px"><input type="checkbox" id="i-c" ${n.isCompleted?'checked':''}> مكتمل</label><div class="field"><label for="i-n">ملاحظات</label><textarea class="input" id="i-n" style="min-height:70px">${esc(n.notes)}</textarea></div>
<p class="muted small">عدد الفروع: ${N(ix.kids[n.id].length)} — أُنشئ في ${new Date(n.createdAt).toLocaleDateString('ar')}</p>
<div class="stack" style="margin:12px 0"><button class="btn primary" data-act="save">حفظ</button><button class="btn" data-act="child">+ إضافة فرع</button><button class="btn" data-act="sib">إضافة فرع بجانبه</button><button class="btn" data-act="expand">✨ توسيع هذا الفرع</button><button class="btn" data-act="copy">نسخ</button><button class="btn" data-act="collapse" ${ix.kids[n.id].length?'':'disabled'}>${n.isCollapsed?'فتح الفرع':'طي الفرع'}</button><button class="btn" data-act="del">حذف</button><button class="btn" data-act="task">تحويل إلى مهمة</button></div>
<h3 style="font-size:.95rem">ارتباطات إضافية</h3><div class="stack" style="margin:8px 0"><select class="input" id="cn-t" aria-label="ربط بعقدة"><option value="">ربط بعقدة…</option>${S.M.nodes.filter(x=>x.id!==n.id).slice(0,300).map(x=>`<option value="${x.id}">${esc(x.title)}</option>`).join('')}</select><input class="input" id="cn-l" placeholder="تسمية (اختياري)" maxlength="40"><button class="btn" id="cn-add">ربط</button></div>${cs.map(c=>`<div class="row small"><span>${nm(c.sourceNodeId)} ← ${nm(c.targetNodeId)}</span><button class="link" data-dc="${c.id}">حذف</button></div>`).join('')}`;
 el.classList.add('open');grab(el);
 const hook=(id,fn,vis)=>{const e=$(id);e.oninput=()=>{hpush('e:'+n.id+id);fn(e);n.updatedAt=Date.now();if(vis)refreshNode(n);dirty()};e.onblur=()=>{if(id==='#i-t')e.value=n.title}};
 hook('#i-t',e=>{if(e.value.trim())n.title=e.value.trim()},1);hook('#i-d',e=>{n.description=e.value});hook('#i-n',e=>{n.notes=e.value});
 $('#i-ty').onchange=e=>mut('',()=>{n.type=e.target.value;n.icon=TYPES[n.type][1]});$('#i-ic').onchange=e=>mut('',()=>{n.icon=e.target.value});$('#i-c').onchange=e=>mut('',()=>{n.isCompleted=e.target.checked});
 el.querySelectorAll('[data-col]').forEach(b=>b.onclick=()=>setColor(n.id,b.dataset.col));
 $('#cn-add').onclick=()=>{const t=$('#cn-t').value;if(!t)return;if(S.M.conns.some(c=>c.sourceNodeId===n.id&&c.targetNodeId===t)){toast('هذا الارتباط موجود بالفعل.','error');return}mut('',()=>S.M.conns.push({id:uid(),mindMapId:S.M.id,sourceNodeId:n.id,targetNodeId:t,label:$('#cn-l').value.trim(),createdAt:Date.now()}))};
 el.querySelectorAll('[data-dc]').forEach(b=>b.onclick=()=>mut('',()=>{S.M.conns=S.M.conns.filter(c=>c.id!==b.dataset.dc)}))}
function grab(el){const g=$('#grab');if(!g)return;let y0=null;g.onpointerdown=e=>{y0=e.clientY;g.setPointerCapture(e.pointerId)};g.onpointermove=e=>{if(y0!=null&&e.clientY-y0>50){el.classList.remove('open');y0=null}};g.onpointerup=()=>{y0=null}}
function act(a){const id=[...S.sel][0],one=S.sel.size===1;
 switch(a){case'back':leaveMap();break;case'undo':undo();break;case'redo':redo();break;
 case'add':askBranch('child',one?id:ix.root.id);break;
 case'layout':hpush('');S.M.manual=false;autoLayout(ix.root,true,()=>fit());break;
 case'fit':fit();break;case'zin':zoomBy(1.25);break;case'zout':zoomBy(.8);break;
 case'search':{const r=$('#sr');r.hidden=!r.hidden;if(!r.hidden)$('#sr-i').focus();break}
 case'srn':doSearch(1);break;case'srx':$('#sr').hidden=true;break;
 case'full':{const m=$('#mm');document.fullscreenElement?document.exitFullscreen():m.requestFullscreen&&m.requestFullscreen().catch(()=>{});break}
 case'task':if(one)nodeToTask(id);break;
 case'more':$('#mm-more').hidden=!$('#mm-more').hidden;break;case'retry':Sync.retry();S.st='saving';stat();Sync.onIdle(ok=>{if(S){S.st=ok?(navigator.onLine?'saved':'offline'):'error';stat()}});break;
 case'save':persist();Sync.onIdle(ok=>toast(ok?'تم الحفظ.':'تعذر حفظ آخر التغييرات.',ok?'':'error'));break;
 case'child':if(one)askBranch('child',id);break;case'sib':if(one)askBranch('sib',id);break;case'copy':if(one)copyNode(id);break;
 case'expand':if(one)aiExpand(id);break;case'collapse':if(one)toggleCollapse(id);break;case'del':delNodes([...S.sel]);break}}
function renderMap(){const app=$('#app');
 if(!S||!loadMap()){app.innerHTML=`<main class="auth"><div class="auth-box"><div class="card empty"><h2>تعذر تحميل الخريطة.</h2><div class="row" style="justify-content:center"><button class="btn primary" id="e-retry">إعادة المحاولة</button><button class="btn" id="e-back">العودة إلى الفكرة</button></div></div></div></main>`;
  $('#e-retry').onclick=render;$('#e-back').onclick=()=>{if(S){openId=S.ideaId;TAB='map';page='idea'}else page='ideas';S=null;render()};return}
 const B=(a,l,t,c='')=>`<button class="btn ${c}" data-act="${a}" title="${t||l}" aria-label="${t||l}">${l}</button>`;
 app.innerHTML=`<div class="mm" id="mm"><header class="mt">${B('back','<span class="dsk">→ العودة إلى الفكرة</span><span class="mob">رجوع</span>','العودة إلى الفكرة','ghost')}<h2 class="mtt" id="mm-title">${esc(S.M.title)}</h2><span class="status small" id="mm-st"></span><span class="sp"></span>
${B('undo','تراجع','تراجع (Ctrl+Z)','dsk')}${B('redo','إعادة','إعادة (Ctrl+Shift+Z)','dsk')}${B('add','+ إضافة','إضافة فرع','dsk primary')}${B('layout','ترتيب تلقائي','','dsk')}${B('fit','ملاءمة الشاشة','','dsk')}${B('search','بحث','بحث داخل الخريطة','dsk')}${B('zout','−','تصغير','dsk')}<span id="zl" class="dsk small muted">100٪</span>${B('zin','+','تكبير','dsk')}${B('full','ملء الشاشة','','dsk')}
${B('search','بحث','بحث داخل الخريطة','mob')}<div class="dd mob"><button class="btn" data-act="more" aria-haspopup="true">المزيد</button><div class="dd-menu" id="mm-more" hidden>${[['undo','تراجع'],['redo','إعادة'],['zin','تكبير'],['zout','تصغير'],['full','ملء الشاشة']].map(([a,l])=>`<button class="nav" data-act="${a}">${l}</button>`).join('')}</div></div></header>
<div class="mb"><aside class="insp" id="insp" aria-label="تفاصيل الفرع"></aside><div class="cv" id="cv"><svg id="sv" role="application" aria-label="لوحة الخريطة الذهنية"><g id="vp"></g></svg>
<div class="sr" id="sr" hidden><input class="input" id="sr-i" placeholder="بحث داخل الخريطة" aria-label="بحث داخل الخريطة"><span id="sr-c" class="muted small"></span>${B('srn','التالي')}${B('srx','إغلاق','','ghost')}</div>
<div class="hint card" id="hint" hidden><h3>ابدأ بفكرتك الرئيسية، ثم أضف الفروع التي تساعدك على تطويرها.</h3><p class="muted small">مثلاً: الجمهور، المميزات، المشاكل، الحلول، طريقة الربح...</p></div><svg class="mini" id="mini" aria-label="خريطة مصغرة للتنقل" preserveAspectRatio="xMidYMid meet"></svg>
<div class="mfab">${B('add','+ إضافة','','primary')}${B('layout','ترتيب')}${B('fit','ملاءمة')}</div></div></div></div>`;
 $('#mm').onclick=e=>{const b=e.target.closest('[data-act]');if(!b)return;act(b.dataset.act);const mo=$('#mm-more');if(mo&&b.dataset.act!=='more')mo.hidden=true};
 $('#sr-i').oninput=()=>doSearch(0);$('#sr-i').onkeydown=e=>{if(e.key==='Enter')doSearch(1)};
 $('#mini').onclick=e=>{const m=$('#mini'),p=new DOMPoint(e.clientX,e.clientY).matrixTransform(m.getScreenCTM().inverse()),s=sz(),k=S.view.k;setVw({k,x:s.w/2-k*p.x,y:s.h/2-k*p.y},true)};
 index();bindCanvas();draw();fit(false);insp();stat();
 const z=S.M.nodes.length>1&&S.M.nodes.every(n=>n.positionX===S.M.nodes[0].positionX&&n.positionY===S.M.nodes[0].positionY);
 if(z){S.M.manual=false;autoLayout(ix.root,false,()=>fit(false))}}
function bindCanvas(){const sv=$('#sv'),ptr=new Map();let mode=null,st=null,pinch=null,lp=0,moved=false,lpf=false;
 sv.onpointerdown=e=>{closeCtx();sv.setPointerCapture(e.pointerId);ptr.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if(ptr.size===2){clearTimeout(lp);const [a,b]=[...ptr.values()],r=sv.getBoundingClientRect();mode='pinch';st=null;pinch={d:Math.hypot(a.x-b.x,a.y-b.y)||1,k:S.view.k,x:S.view.x,y:S.view.y,mx:(a.x+b.x)/2-r.left,my:(a.y+b.y)/2-r.top};return}
  if(e.button===2)return;const tg=e.target.closest('[data-tg]'),nd=e.target.closest('.nd');moved=false;lpf=false;
  st={x:e.clientX,y:e.clientY,v:{...S.view},tg:tg&&tg.dataset.tg,id:nd&&nd.dataset.id,shift:e.shiftKey||e.ctrlKey||e.metaKey,p:{}};
  if(tg){mode='tg';return}
  if(nd){mode='node';const id=st.id;if(!S.sel.has(id)&&!st.shift){S.sel=new Set([id]);syncSel()}S.sel.forEach(i=>{const n=ix.by[i];if(n)st.p[i]={x:n.positionX,y:n.positionY}});const cx=e.clientX,cy=e.clientY;lp=setTimeout(()=>{if(!moved&&mode==='node'){lpf=true;ctxMenu(cx,cy,id)}},520)}
  else mode='pan'};
 sv.onpointermove=e=>{if(!ptr.has(e.pointerId))return;ptr.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if(mode==='pinch'&&ptr.size>=2){const [a,b]=[...ptr.values()],d=Math.hypot(a.x-b.x,a.y-b.y),k=Math.min(2.5,Math.max(.15,pinch.k*d/pinch.d));S.view={k,x:pinch.mx-(pinch.mx-pinch.x)*k/pinch.k,y:pinch.my-(pinch.my-pinch.y)*k/pinch.k};applyView();return}
  if(!st)return;const dx=e.clientX-st.x,dy=e.clientY-st.y;if(!moved&&Math.hypot(dx,dy)<5)return;
  if(!moved){moved=true;clearTimeout(lp);if(mode==='node'){cancelAnimationFrame(S.ar);hpush('')}}
  if(mode==='pan'){S.view={...st.v,x:st.v.x+dx,y:st.v.y+dy};applyView()}
  else if(mode==='node'){const k=S.view.k;Object.entries(st.p).forEach(([id,o])=>{const n=ix.by[id];if(n&&!ix.hid.has(id)){n.positionX=o.x+dx/k;n.positionY=o.y+dy/k;upd(n)}});mini()}};
 const up=e=>{clearTimeout(lp);ptr.delete(e.pointerId);if(mode==='pinch'){if(ptr.size<2){mode=null;st=null}return}
  if(!st){mode=null;return}
  if(mode==='tg'&&!moved)toggleCollapse(st.tg);
  else if(mode==='node'){if(moved){Object.keys(st.p).forEach(id=>{const n=ix.by[id];if(n){n.positionX=Math.round(n.positionX);n.positionY=Math.round(n.positionY)}});S.M.manual=true;dirty()}else if(!lpf){if(st.shift)select([st.id],true);else{S.sel=new Set([st.id]);syncSel();insp()}}}
  else if(mode==='pan'&&!moved){S.sel=new Set();syncSel();insp()}
  mode=null;st=null};
 sv.onpointerup=up;sv.onpointercancel=up;
 sv.addEventListener('contextmenu',e=>{e.preventDefault();const nd=(document.elementFromPoint(e.clientX,e.clientY)||e.target).closest('.nd');if(!nd)return;const id=nd.dataset.id;if(!S.sel.has(id)){S.sel=new Set([id]);syncSel();insp()}ctxMenu(e.clientX,e.clientY,id)});
 sv.addEventListener('wheel',e=>{e.preventDefault();const r=sv.getBoundingClientRect();zoomBy(e.deltaY<0?1.1:1/1.1,e.clientX-r.left,e.clientY-r.top,false)},{passive:false});
 sv.addEventListener('dblclick',e=>{const nd=(document.elementFromPoint(e.clientX,e.clientY)||e.target).closest('.nd');if(nd){S.sel=new Set([nd.dataset.id]);syncSel();insp();$('#i-t')?.focus()}});
 sv.addEventListener('keydown',e=>{if(e.key!=='Enter'&&e.key!==' ')return;const tg=e.target.closest&&e.target.closest('.tg'),nd=e.target.closest&&e.target.closest('.nd');if(tg){e.preventDefault();toggleCollapse(tg.dataset.tg)}else if(nd){e.preventDefault();select([nd.dataset.id])}})}
document.addEventListener('keydown',e=>{if(page!=='map'||!S||!S.M)return;const t=e.target,typing=/INPUT|TEXTAREA|SELECT/.test(t.tagName);
 if(e.key==='Escape'){closeCtx();const r=$('#sr');if(r)r.hidden=true;return}
 if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'&&!typing){e.preventDefault();e.shiftKey?redo():undo()}
 else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='y'&&!typing){e.preventDefault();redo()}
 else if((e.key==='Delete'||e.key==='Backspace')&&!typing&&!document.querySelector('.ov')){e.preventDefault();delNodes([...S.sel])}});
window.addEventListener('online',()=>{if(S&&S.M&&page==='map'){persist();toast('عاد الاتصال.')}});
window.addEventListener('offline',()=>{if(S&&page==='map'){S.st='offline';stat()}});
window.addEventListener('resize',()=>{if(S&&page==='map')mini()});
function done(ok,msg){closeModal();ok?toast(msg):toast('تعذّر الحفظ. تحقق من مساحة التخزين.','error');render()}
const capture=t=>{const title=t.split('\n')[0].slice(0,60);return Ideas.add({title,body:t.length>title.length?t:''})};
function quick(){modal(`<h2 style="margin-bottom:14px">التقاط فكرة سريعة</h2><div class="field"><textarea class="input" id="qc" placeholder="اكتب فكرتك كما خطرت لك…" aria-label="فكرتك"></textarea></div><div class="row" style="justify-content:flex-end"><button class="btn" id="qx">إلغاء</button><button class="btn primary" id="qs">حفظ الفكرة</button></div>`);
 setTimeout(()=>$('#qc')?.focus(),30);$('#qx').onclick=closeModal;
 $('#qs').onclick=()=>{const t=$('#qc').value.trim();if(!t){toast('اكتب فكرتك أولًا.','error');return}done(capture(t),'تم حفظ الفكرة.')}}
function bindCards(){
 document.querySelectorAll('[data-open]').forEach(el=>{el.onclick=e=>{if(!e.target.closest('[data-fav]'))openIdea(el.dataset.open)};el.onkeydown=e=>{if(e.key==='Enter'&&e.target===el)openIdea(el.dataset.open)}});
 document.querySelectorAll('[data-fav]').forEach(b=>b.onclick=e=>{e.stopPropagation();const i=Ideas.all().find(x=>x.id===b.dataset.fav);if(!i)return;Ideas.update(i.id,{favorite:!i.favorite},false);if(page==='fav')render();else{b.setAttribute('aria-pressed',String(!i.favorite));b.setAttribute('aria-label',i.favorite?'إضافة إلى المفضلة':'إزالة من المفضلة')}})}
function bindExtra(){
 document.querySelectorAll('[data-newmap]').forEach(b=>b.onclick=newMapDialog);
 document.querySelectorAll('[data-map]').forEach(el=>{el.onclick=()=>openMap(el.dataset.map);el.onkeydown=e=>{if(e.key==='Enter')openMap(el.dataset.map)}});
 const cap=$('#cap');if(cap){cap.onkeydown=e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey))$('#cap-save').click()};
  $('#cap-map').onclick=()=>{const t=cap.value.trim();if(!t){toast('اكتب فكرتك أولًا.','error');return}const i=capture(t);if(i&&createMap(i)){toast('تم حفظ الفكرة وإنشاء خريطتها.');openMap(i.id)}else toast('تعذّر الحفظ.','error')}}}
function bindApp(){
 bindCards();bindExtra();if(page==='new')bindForm();if(page==='idea')bindDetail();
 const rb=()=>{const l=$('#list');if(l){l.innerHTML=listHtml(src());bindCards()}};
 const q=$('#q');if(q){q.oninput=e=>{F.q=e.target.value;rb()};$('#fs').onchange=e=>{F.st=e.target.value;rb()};$('#fc').onchange=e=>{F.cat=e.target.value;rb()};$('#so').onchange=e=>{F.sort=e.target.value;rb()}}
 document.querySelectorAll('[data-quick]').forEach(b=>b.onclick=quick);
 document.querySelectorAll('[data-focus]').forEach(b=>b.onclick=()=>$('#cap')?.focus());
 const sv=$('#cap-save');if(sv)sv.onclick=()=>{const t=$('#cap').value.trim();if(!t){toast('اكتب فكرتك أولًا.','error');return}if(capture(t)){toast('تم حفظ الفكرة.');render();$('#cap')?.focus()}else toast('تعذّر الحفظ. تحقق من مساحة التخزين.','error')}
}
/* ===== Render ===== */
function render(){try{_render()}catch(e){console.error(e);$('#app').innerHTML=`<main class="auth"><div class="auth-box"><div class="card empty" role="alert"><h2>حدث خطأ غير متوقع.</h2><p class="muted">بياناتك محفوظة. جرّب إعادة المحاولة.</p><button class="btn primary" id="rr">إعادة المحاولة</button></div></div></main>`;$('#rr').onclick=()=>{page='home';view=Auth.session()?'app':'login';render()}}}
window.addEventListener('error',e=>{if(e&&e.message&&!/ResizeObserver/.test(e.message))toast('حدث خطأ غير متوقع.','error')});
window.addEventListener('unhandledrejection',()=>toast('حدث خطأ غير متوقع.','error'));
function _render(){
 const s=Auth.session();
 if(view==='app'&&!s){view='login'}
 if(!['login','register'].includes(view)&&!s){view='login'}
 document.title='فِكرة — '+(view==='app'?(page==='map'?'الخريطة الذهنية':(NAV.find(n=>n[0]===page)||[0,page==='idea'?'تفاصيل الفكرة':'فكرة جديدة'])[1]):'فكرتك تبدأ هنا');
 const app=$('#app');
 if(view==='app'&&page==='map'){renderMap();return}
 app.innerHTML=view==='app'?renderApp():view==='register'?renderRegister():renderLogin();
 if(view==='app'){
  document.querySelectorAll('[data-p]').forEach(b=>b.onclick=()=>{page=b.dataset.p;closeModal();render();$('#app h1')?.focus()});
  document.querySelectorAll('[data-new]').forEach(b=>b.onclick=()=>newIdea());
  const th=$('#theme');if(th)th.onclick=()=>Theme.toggle();
  const o=$('#out');if(o)o.onclick=async()=>{o.disabled=true;await Auth.logout();toast('تم تسجيل الخروج.');setView('login')};
  bindApp();
 }else bindAuth();
}
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal()});
(async()=>{try{const r=await api('GET','/api/me');if(r.user){setMe(r.user);await loadData();view='app'}render()}
 catch(e){$('#app').innerHTML=`<main class="auth"><div class="auth-box"><div class="card empty" role="alert"><h2>تعذر الاتصال بالخادم.</h2><p class="muted">تحقق من اتصالك ثم أعد المحاولة.</p><button class="btn primary" id="rr">إعادة المحاولة</button></div></div></main>`;$('#rr').onclick=()=>location.reload()}})();
