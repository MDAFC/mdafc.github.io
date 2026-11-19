/* =====================================================================
   MDAFC – synchronisation avec la base partagée
   Trois modes, choisis dans config.js :
     • local    : pas d'URL → tout reste sur l'appareil (démo)
     • mock     : url "mock://local" → simulation entre onglets d'un même navigateur (tests)
     • supabase : vraie base partagée
   ===================================================================== */
(function(){
const CFG=window.MDAFC_CONFIG||{};
const MODE=!CFG.url?'local':CFG.url.startsWith('mock')?'mock':'supabase';
const BDE_COLS=new Set(['todo','bde_setting']);
const PROMO_CH={c2:'Mag 1',c3:'Mag 2',c4:'Mag 3'};
const scopeOf=(col,d)=>col==='dm'?'dm':BDE_COLS.has(col)||(col==='msg'&&d.channel==='cb')?'bde':(col==='msg'&&PROMO_CH[d.channel])||'public';
const key=(c,i)=>c+'/'+i;
const snap=m=>new Map([...m].map(([k,r])=>[k,JSON.stringify(r.data)]));

let bdeRefused=false,joined=false,client=null,uid='me',member=null,rows=new Map(),synced=new Map(),profiles={},empty=false;
let S=null,SEED=null,onChange=()=>{},onError=()=>{},timer=null,pushing=Promise.resolve(),status='local';

/* ---------- conversion état de l'app <-> lignes de la base ---------- */
function flatten(S){
  const m=new Map(),put=(col,id,data)=>m.set(key(col,id),{col,id:String(id),data:JSON.parse(JSON.stringify(data))});
  S.events.forEach(e=>{const {booking,...r}=e;
    put('event',e.id,{...r,booking:booking?{places:booking.places,price:booking.price,link:booking.link||''}:null});
    (booking?.going||[]).forEach(u=>put('going',e.id+':'+u,{event:e.id,user:u}));});
  S.reminders.forEach(r=>put('reminder',r.id,r));
  S.polls.forEach(p=>{put('poll',p.id,{...p,options:p.options.map(o=>({text:o.text}))});
    p.options.forEach((o,i)=>o.votes.forEach(u=>put('vote',p.id+':'+u,{poll:p.id,opt:i,user:u})));});
  S.boards.forEach(b=>{const {questions,...r}=b;put('board',b.id,r);
    questions.forEach(q=>{const {likes,...qr}=q;put('question',q.id,{...qr,board:b.id});likes.forEach(u=>put('like',q.id+':'+u,{q:q.id,user:u}));});});
  [['offers','offer'],['products','product'],['albums','album'],['files','file'],['todos','todo']].forEach(([k,c])=>S[k].forEach(x=>put(c,x.id,x)));
  S.pairs.forEach(p=>put('pair',p.parrain+'→'+p.filleul,p));
  S.channels.forEach(c=>c.msgs.forEach(x=>{if(x.id)put('msg',x.id,{...x,channel:c.id});}));
  (S.dms||[]).forEach(x=>put('dm',x.id,x));
  put('setting','subjects',{v:S.subjects});put('setting','semester',{v:S.semester});put('bde_setting','drive',{v:S.bdeDrive});
  return m;
}
function unflatten(){
  const all=[...rows.values()],by=c=>all.filter(r=>r.col===c).map(r=>r.data);
  const going=by('going'),votes=by('vote'),qs=by('question'),likes=by('like'),msgs=by('msg');
  S.events=by('event').map(e=>{const x={...e,booking:e.booking?{...e.booking,going:going.filter(g=>g.event===e.id).map(g=>g.user)}:undefined};if(!x.booking)delete x.booking;return x;});
  S.reminders=by('reminder');
  S.polls=by('poll').map(p=>({...p,options:p.options.map((o,i)=>({text:o.text,votes:votes.filter(v=>v.poll===p.id&&v.opt===i).map(v=>v.user)}))}));
  S.boards=by('board').map(b=>({...b,questions:qs.filter(q=>q.board===b.id).map(({board,...q})=>({...q,likes:likes.filter(l=>l.q===q.id).map(l=>l.user)}))}));
  S.offers=by('offer');S.products=by('product');S.albums=by('album');S.files=by('file');S.todos=by('todo');S.pairs=by('pair');
  S.dms=by('dm').sort((a,b)=>a.t-b.t);
  S.channels=SEED.channels.map(c=>({...c,msgs:[...c.msgs,...msgs.filter(x=>x.channel===c.id).map(({channel,...x})=>x)].sort((a,b)=>a.t-b.t)}));
  const st=k=>rows.get(key('setting',k))?.data?.v;
  S.subjects=st('subjects')||SEED.subjects;S.semester=st('semester')||SEED.semester;
  S.bdeDrive=rows.get(key('bde_setting','drive'))?.data?.v||SEED.bdeDrive;
  S.profiles=profiles;
}

/* ---------- chargement, temps réel, envoi ---------- */
async function loadAll(){
  const {data,error}=await client.from('items').select('col,id,data').order('created_at',{ascending:true});
  if(error)throw error;
  rows=new Map(data.map(r=>[key(r.col,r.id),r]));
  const p=await client.from('profiles').select('id,name,promo,updated_at');
  profiles={};(p.data||[]).forEach(x=>profiles[x.id]={name:x.name,promo:x.promo,at:Date.parse(x.updated_at)||0});
  empty=!rows.has(key('setting','subjects'));
  if(empty){
    // Base encore vide : on affiche le contenu de départ. Le premier membre du BDE connecté l'enverra.
    const seedS=structuredClone(SEED);Object.assign(S,{events:seedS.events,reminders:seedS.reminders,polls:seedS.polls,boards:seedS.boards,offers:[],products:seedS.products,albums:seedS.albums,files:[],todos:seedS.todos,pairs:[],channels:seedS.channels,dms:[],subjects:seedS.subjects,semester:seedS.semester,bdeDrive:seedS.bdeDrive,profiles});
    synced=member?new Map():snap(flatten(S));
  } else { unflatten(); synced=snap(flatten(S)); }
}
let pending=false;
function remote(payload){
  const t=payload.table,ev=payload.eventType;
  if(t==='profiles'){const r=ev==='DELETE'?payload.old:payload.new;if(ev==='DELETE')delete profiles[r.id];else profiles[r.id]={name:r.name,promo:r.promo,at:Date.parse(r.updated_at)||Date.now()};S.profiles=profiles;onChange();return;}
  if(ev==='DELETE'){rows.delete(key(payload.old.col,payload.old.id));}
  else{const r=payload.new;rows.set(key(r.col,r.id),{col:r.col,id:r.id,data:r.data});}
  if(empty&&rows.has(key('setting','subjects')))empty=false;
  if(empty)return;
  // Applique les changements locaux non encore envoyés avant de recalculer l'état
  if(timer){pending=true;return;}
  unflatten();synced=snap(flatten(S));onChange();
}
let subscribed=false;
function subscribe(){
  if(subscribed)return;subscribed=true;
  client.channel('mdafc-sync')
    .on('postgres_changes',{event:'*',schema:'public',table:'items'},remote)
    .on('postgres_changes',{event:'*',schema:'public',table:'profiles'},remote)
    .subscribe();
}
async function pushNow(){
  if(MODE==='local'||!client)return;
  if(empty&&!member)return;
  const cur=flatten(S),ups=[],dels=[];
  for(const [k,r] of cur){const j=JSON.stringify(r.data);if(synced.get(k)!==j)ups.push(r);}
  for(const k of synced.keys())if(!cur.has(k))dels.push(k);
  if(!ups.length&&!dels.length)return;
  for(const r of ups){synced.set(key(r.col,r.id),JSON.stringify(r.data));rows.set(key(r.col,r.id),{col:r.col,id:r.id,data:r.data});}
  for(const k of dels){synced.delete(k);rows.delete(k);}
  if(ups.length){
    const {error}=await client.from('items').upsert(ups.map(r=>({col:r.col,id:r.id,data:r.data,scope:scopeOf(r.col,r.data)})),{onConflict:'col,id'});
    if(error){onError(error);await refresh();return;}
    if(empty&&cur.has(key('setting','subjects')))empty=false;
  }
  for(const k of dels){const i=k.indexOf('/');const {error}=await client.from('items').delete().eq('col',k.slice(0,i)).eq('id',k.slice(i+1));if(error){onError(error);await refresh();return;}}
}
async function refresh(){await loadAll();onChange();}

/* ---------- API utilisée par l'application ---------- */
window.Backend={
  get mode(){return MODE;},
  get uid(){return uid;},
  get member(){return member;},
  get joined(){return joined;},
  get status(){return status;},
  async init(state,seed,handlers){
    S=state;SEED=seed;onChange=handlers.onChange||onChange;onError=handlers.onError||onError;
    if(MODE==='local'){status='local';return {uid:'me',member:null};}
    client=MODE==='mock'?MockSupabase():window.supabase.createClient(CFG.url,CFG.anonKey);
    // « Se souvenir de moi » décoché : la session ne survit pas à la fermeture de l'application
    try{if(localStorage.getItem('mdafc-remember')==='0'&&!sessionStorage.getItem('mdafc-alive')){await client.auth.signOut({scope:'local'});localStorage.removeItem('mdafc-remember');}}catch(e){}
    let {data:{session}}=await client.auth.getSession();
    if(!session){const r=await client.auth.signInAnonymously();if(r.error)throw r.error;session=r.data.session;}
    uid=session.user.id;
    member=(await client.rpc('my_bde_member')).data||null;
    // Compte e-mail qui n'est pas dans la liste du BDE : retour en mode étudiant
    if(session.user.email&&!member){await client.auth.signOut();const a=await client.auth.signInAnonymously();if(a.error)throw a.error;uid=a.data.session.user.id;bdeRefused=true;}
    // Accès réservé : étudiant inscrit avec le code de sa promo, ou membre du BDE
    joined=!!member||!!(await client.rpc('is_member')).data;
    if(!joined){status='locked';return {uid,member,bdeRefused,joined};}
    await loadAll();
    if(member){
      // retire le profil anonyme qu'avait cet appareil avant la connexion BDE (évite un doublon dans l'annuaire)
      const prev=localStorage.getItem('mdafc-prev-anon');
      if(prev&&prev!==uid){await client.from('profiles').delete().eq('id',prev);delete profiles[prev];}
      localStorage.removeItem('mdafc-prev-anon');
      if(empty){synced=new Map();await pushNow();}   // premier membre connecté : remplit la base avec le contenu de départ
    }
    subscribe();status='online';
    return {uid,member,bdeRefused,joined};
  },
  // Entrée avec le code de promo : renvoie la promo correspondante
  async joinPromo(code){
    const {data,error}=await client.rpc('join_promo',{p_code:(code||'').trim()});
    if(error)throw new Error(/invalide/i.test(error.message)?'Code incorrect : demandez le code de votre promo au BDE':'Connexion impossible : '+error.message);
    joined=true;await loadAll();subscribe();status='online';onChange();return data;
  },
  // Réseau des anciens (stocké dans la base, lisible seulement par les inscrits)
  async loadAnciens(){
    if(MODE==='supabase'){const {data,error}=await client.from('alumni').select('id,p,n,c,j,v,y,m,t,l').order('id');if(error)throw error;return data;}
    if(!window.ANCIENS)await new Promise((ok,ko)=>{const sc=document.createElement('script');sc.src='anciens.js';sc.onload=ok;sc.onerror=()=>ok();document.head.appendChild(sc);});
    return (window.ANCIENS||[]).map((x,i)=>({id:i,...x}));
  },
  async updateAncien(id,ch){
    if(MODE==='supabase'){const {error}=await client.from('alumni').update(ch).eq('id',id);if(error)throw error;return;}
    if(window.ANCIENS&&window.ANCIENS[id])Object.assign(window.ANCIENS[id],ch);
  },
  // Gestion des accès (BDE)
  async getCodes(){const {data,error}=await client.rpc('get_promo_codes');if(error)throw error;return data;},
  async setCode(promo,code){const {error}=await client.rpc('set_promo_code',{p_promo:promo,p_code:code});if(error)throw new Error(error.message);},
  async listStudents(){const {data,error}=await client.from('students').select('id,promo,joined_at').order('joined_at',{ascending:false});if(error)throw error;return data;},
  async setStudentPromo(id,promo){const {error}=await client.rpc('set_student_promo',{p_id:id,p_promo:promo});if(error)throw new Error(error.message);if(profiles[id])profiles[id].promo=promo;onChange();},
  async removeStudent(id){let r=await client.from('students').delete().eq('id',id);if(r.error)throw r.error;r=await client.from('profiles').delete().eq('id',id);delete profiles[id];onChange();},
  // Se souvenir de moi : la session reste enregistrée sur l'appareil (et on demande au navigateur de ne pas l'effacer)
  remember(on){try{if(on){localStorage.setItem('mdafc-remember','1');navigator.storage?.persist?.();}else{localStorage.setItem('mdafc-remember','0');sessionStorage.setItem('mdafc-alive','1');}}catch(e){}},
  schedulePush(){if(MODE==='local')return;clearTimeout(timer);timer=setTimeout(()=>{timer=null;pushing=pushing.then(pushNow).then(()=>{if(pending){pending=false;unflatten();synced=snap(flatten(S));onChange();}}).catch(e=>onError(e));},250);},
  async flush(){clearTimeout(timer);timer=null;await (pushing=pushing.then(pushNow));},
  async saveProfile(me){if(MODE==='local'||!client)return;const {error}=await client.from('profiles').upsert({id:uid,name:me.name,promo:me.promo});if(error)onError(error);profiles[uid]={name:me.name,promo:me.promo};},
  // Connexion BDE par e-mail + mot de passe personnel (create = première connexion : création du compte)
  async loginBDE(email,password,create){
    const anonId=uid;email=(email||'').toLowerCase().trim();
    const r=create?await client.auth.signUp({email,password}):await client.auth.signInWithPassword({email,password});
    if(r.error){const msg=r.error.message||'';
      if(create&&/registered|exists/i.test(msg))throw new Error('Ce compte existe déjà : utilisez « Se connecter »');
      if(create&&/database|saving|not allowed|bde/i.test(msg))throw new Error('Cette adresse n\'est pas enregistrée comme membre du BDE');
      if(/password/i.test(msg)&&create)throw new Error('Mot de passe trop faible (8 caractères minimum)');
      if(/rate|limit/i.test(msg))throw new Error('Trop d\'essais : réessayez dans quelques minutes');
      throw new Error(create?'Création impossible : '+msg:'E-mail ou mot de passe incorrect. Première fois ? Touchez « Première connexion : créer mon mot de passe »');}
    if(!r.data.session)throw new Error('Compte créé, mais la confirmation par e-mail est encore active côté Supabase');
    const m=(await client.rpc('my_bde_member')).data;
    if(!m){await client.auth.signOut();const a=await client.auth.signInAnonymously();uid=a.data.session.user.id;await loadAll();throw new Error('Ce compte n\'est pas membre du BDE');}
    uid=r.data.session.user.id;member=m;joined=true;
    // retire l'ancien profil anonyme de cet appareil pour éviter un doublon dans l'annuaire (le BDE peut supprimer un profil)
    if(anonId&&anonId!==uid){await client.from('profiles').delete().eq('id',anonId);await client.from('students').delete().eq('id',anonId);}
    await loadAll();
    if(empty){synced=new Map();await pushNow();}     // initialise la base avec le contenu de départ
    subscribe();status='online';onChange();return m;
  },
  async logoutBDE(){await client.auth.signOut();const a=await client.auth.signInAnonymously();uid=a.data.session.user.id;member=null;joined=false;return uid;},
  // Notifications
  async pushKey(){if(MODE!=='supabase')return null;if(this._pk)return this._pk;let {data}=await client.rpc('push_public_key');
    if(!data){await fetch(CFG.url+'/functions/v1/notify',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).catch(()=>{});({data}=await client.rpc('push_public_key'));}
    return this._pk=data||null;},
  async savePush(endpoint,p256dh,auth,msgs){const {error}=await client.rpc('save_push_sub',{p_endpoint:endpoint,p_p256dh:p256dh,p_auth:auth,p_msgs:msgs});if(error)throw new Error(error.message);},
  async removePush(endpoint){await client.rpc('remove_push_sub',{p_endpoint:endpoint});},
  async changePassword(pw){const {error}=await client.auth.updateUser({password:pw});if(error)throw error;},
  async upload(blob,ext){
    if(MODE==='local')return null;
    const path=`${new Date().getFullYear()}/${crypto.randomUUID()}.${ext}`;
    const {error}=await client.storage.from('uploads').upload(path,blob,{contentType:blob.type||undefined});
    if(error)throw error;
    return client.storage.from('uploads').getPublicUrl(path).data.publicUrl;
  },
  _debug:{flatten:()=>flatten(S),rows:()=>rows,diff:()=>{const c=flatten(S);return [...c].filter(([k,r])=>synced.get(k)!==JSON.stringify(r.data)).map(([k,r])=>k+" "+JSON.stringify(r.data).slice(0,200)+" ≠ "+(synced.get(k)||"").slice(0,200));}}
};

/* =====================================================================
   Simulation de Supabase (mode « mock ») : la « base » est le localStorage
   du navigateur, chaque onglet est un utilisateur différent, et les
   modifications sont diffusées aux autres onglets comme le temps réel.
   Comptes BDE de test : <prenom>@mdafc.test (n'importe quel mot de passe de 8 caractères)
   ===================================================================== */
function MockSupabase(){
  const DB='mock-db',EVT='mock-evt',SES='mock-session';
  const BDE={'clemence@mdafc.test':'b1','feyrielle@mdafc.test':'b2','valentine@mdafc.test':'b3','lou@mdafc.test':'b4','anae@mdafc.test':'b5','jb@mdafc.test':'b6','mael@mdafc.test':'b7'};
  const db=()=>{try{return JSON.parse(localStorage.getItem(DB))||{items:{},profiles:{}};}catch(e){return {items:{},profiles:{}};}};
  const setdb=d=>localStorage.setItem(DB,JSON.stringify(d));
  const ses=()=>{try{return JSON.parse(sessionStorage.getItem(SES));}catch(e){return null;}};
  const isBde=()=>!!BDE[ses()?.user?.email];
  const studentCol=(c,d)=>['msg','vote','like','question','going','offer','file'].includes(c)&&!(c==='msg'&&d.channel==='cb');
  const emit=(table,eventType,n,o)=>localStorage.setItem(EVT,JSON.stringify({table,eventType,new:n,old:o,nonce:Math.random()}));
  const res=(data,error=null)=>Promise.resolve({data,error});
  function from(table){
    const f={eqs:[],op:'select',
      select(){return f;},order(){return f;},eq(c,v){f.eqs.push([c,v]);return f;},
      upsert(arr){const d=db(),me=ses().user.id;
        for(const r of [].concat(arr)){
          if(table==='profiles'){d.profiles[r.id]=r;emit('profiles','UPDATE',r);continue;}
          const k=r.col+'/'+r.id,old=d.items[k];
          const ok=isBde()||((r.scope==='public'&&studentCol(r.col,r.data))||r.scope==='dm'||['Mag 1','Mag 2','Mag 3'].includes(r.scope))&&(!old||old.owner===me);
          if(!ok){return res(null,{message:'new row violates row-level security policy'});}
          d.items[k]={...r,owner:old?.owner||me,created_at:old?.created_at||Date.now()};
        }
        setdb(d);[].concat(arr).forEach(r=>table!=='profiles'&&emit('items','UPDATE',{col:r.col,id:r.id,data:r.data,scope:r.scope}));return res(null);},
      delete(){f.op='delete';return f;},
      then(ok,ko){
        const d=db();
        if(table==='students'){d.students=d.students||{};if(f.op==='delete'){delete d.students[f.eqs[0][1]];setdb(d);return res(null).then(ok,ko);}return res(Object.values(d.students)).then(ok,ko);}
        if(f.op==='delete'&&table==='profiles'){const id=f.eqs.find(x=>x[0]==='id')[1];if(!(isBde()||id===ses().user.id))return res(null,{message:'not allowed'}).then(ok,ko);delete d.profiles[id];setdb(d);emit('profiles','DELETE',null,{id});return res(null).then(ok,ko);}
        if(f.op==='delete'){const [c,i]=[f.eqs.find(x=>x[0]==='col')[1],f.eqs.find(x=>x[0]==='id')[1]];const k=c+'/'+i,old=d.items[k];
          if(old&&!(isBde()||old.owner===ses().user.id))return res(null,{message:'not allowed'}).then(ok,ko);
          delete d.items[k];setdb(d);emit('items','DELETE',null,{col:c,id:i});return res(null).then(ok,ko);}
        if(table==='profiles')return res(Object.values(d.profiles)).then(ok,ko);
        const me=ses()?.user?.id,myBde=BDE[ses()?.user?.email],st=(d.students||{})[me];
        const can=r=>r.scope==='dm'?(r.owner===me||r.data.to===me||r.data.to===myBde||(String(r.data.thread).startsWith('bde:')&&isBde())):r.scope==='public'||isBde()||(st&&r.scope===st.promo);
        const items=Object.values(d.items).filter(can).sort((a,b)=>a.created_at-b.created_at);
        return res(items).then(ok,ko);}
    };return f;
  }
  const listeners=[];
  window.addEventListener('storage',e=>{if(e.key!==EVT||!e.newValue)return;const p=JSON.parse(e.newValue);
    if(p.table==='items'&&p.new&&p.new.scope==='bde'&&!isBde())return;listeners.forEach(l=>l.table===p.table&&l.cb(p));});
  return {
    auth:{
      async getSession(){return {data:{session:ses()}};},
      async signInAnonymously(){const s={user:{id:crypto.randomUUID(),email:null}};sessionStorage.setItem(SES,JSON.stringify(s));return {data:{session:s},error:null};},
      async signInWithPassword({email,password}){email=(email||'').toLowerCase().trim();if((password||'').length<8||!email.endsWith('@mdafc.test'))return {data:null,error:{message:'Invalid login'}};
        const s={user:{id:'u-'+email,email}};sessionStorage.setItem(SES,JSON.stringify(s));return {data:{session:s},error:null};},
      async signUp({email,password}){email=(email||'').toLowerCase().trim();if(!BDE[email])return {data:null,error:{message:'Database error saving new user'}};if((password||'').length<8)return {data:null,error:{message:'Password should be at least 8 characters'}};
        const s={user:{id:'u-'+email,email}};sessionStorage.setItem(SES,JSON.stringify(s));return {data:{session:s},error:null};},
      async signOut(){sessionStorage.removeItem(SES);return {error:null};},
      async updateUser(){return {data:{},error:null};}
    },
    rpc(name,args){const d=db();d.students=d.students||{};const me=ses()?.user?.id;
      if(name==='my_bde_member')return res(BDE[ses()?.user?.email]||null);
      if(name==='is_member')return res(isBde()||!!d.students[me]);
      if(name==='join_promo'){const p={'MAG1-TEST':'Mag 1','MAG2-TEST':'Mag 2','MAG3-TEST':'Mag 3'}[(args.p_code||'').toUpperCase()];if(!p)return res(null,{message:'Code invalide'});d.students[me]={id:me,promo:p,joined_at:new Date().toISOString()};setdb(d);return res(p);}
      if(name==='get_promo_codes')return res([{promo:'Mag 1',code:'MAG1-TEST'},{promo:'Mag 2',code:'MAG2-TEST'},{promo:'Mag 3',code:'MAG3-TEST'}]);
      if(name==='set_promo_code')return res(null);
      if(name==='set_student_promo'){if(d.students[args.p_id])d.students[args.p_id].promo=args.p_promo;if(d.profiles[args.p_id])d.profiles[args.p_id].promo=args.p_promo;setdb(d);return res(null);}
      return res(null);},
    from,
    channel(){const ch={on(_,filter,cb){listeners.push({table:filter.table,cb});return ch;},subscribe(){return ch;}};return ch;},
    storage:{from(){return {
      async upload(path,blob){const url=await new Promise(r=>{const fr=new FileReader();fr.onload=()=>r(fr.result);fr.readAsDataURL(blob);});localStorage.setItem('mock-file:'+path,url);return {error:null};},
      getPublicUrl(path){return {data:{publicUrl:localStorage.getItem('mock-file:'+path)}};}
    };}}
  };
}
})();
