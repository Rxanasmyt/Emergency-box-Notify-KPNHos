(function(){'use strict';
let db=null,component=null,unsubscribers=[],_usersUnsub=null,_publicListening=false;
const C={boxes:'boxes',audit:'audit_log',users:'users',boxDrugs:'box_drugs'};

// Called from componentDidMount — signs in anonymously and starts users listener
// so login can authenticate against ALL users in Firestore from any device
function initUsersOnly(comp){
  if(!window.EB_Firebase){console.warn('[Sync] Firebase not ready');return;}
  db=window.EB_Firebase.db;component=comp;
  if(_usersUnsub){return;} // already listening, just update component reference
  window.EB_Firebase.auth.signInAnonymously()
    .then(()=>{
      console.log('[Sync] Anon auth OK — starting users listener');
      _startUsersListener();
    })
    .catch(err=>console.warn('[Sync] Anon auth failed:',err.message));
}

function _startUsersListener(){
  if(_usersUnsub)return;
  if(!db)return;
  // seed hardcoded admin to Firestore if users collection is empty
  db.collection(C.users).limit(1).get().then(snap=>{
    if(snap.empty&&component&&component.state&&component.state.users&&component.state.users.length){
      console.log('[Sync] Seeding users (admin)...');
      const ub=db.batch();
      component.state.users.forEach(u=>{const{uid,...data}=u;const docId=uid||u.username;ub.set(db.collection(C.users).doc(docId),data);});
      ub.commit().then(()=>console.log('[Sync] Users seeded.')).catch(err=>console.warn('[Sync] User seed failed:',err.message));
    }
  }).catch(()=>{});
  _usersUnsub=db.collection(C.users).onSnapshot(snap=>{
    if(!component)return;
    const users=[],seen=new Set();
    snap.forEach(doc=>{
      const u={uid:doc.id,...doc.data()};
      if(u.username&&!seen.has(u.username)){seen.add(u.username);users.push(u);}
    });
    component.setState({users});
  },err=>console.warn('[Sync] Users error:',err.message));
}

// Called after login — starts boxes/audit/boxDrugs listeners (users already active)
// Calls stopSync() first to prevent duplicate listeners if called more than once
function initFirebaseSync(comp){
  if(!window.EB_Firebase){console.warn('[Sync] Firebase not initialized');return;}
  stopSync(); // clear any previous listeners before starting new ones
  db=window.EB_Firebase.db;component=comp;
  console.log('[Sync] Initializing full sync...');
  seedIfEmpty()
    .then(()=>{listenBoxes();listenAudit();listenBoxDrugs();console.log('[Sync] All listeners active.');})
    .catch(err=>{
      // seedIfEmpty has its own try/catch, but guard here as well
      console.warn('[Sync] Seed error, starting listeners anyway:',err.message);
      listenBoxes();listenAudit();listenBoxDrugs();
    });
}

// Called on logout — stops boxes/audit/boxDrugs; users listener stays active for next login
function stopSync(){unsubscribers.forEach(fn=>fn());unsubscribers=[];_publicListening=false;}

// Called on componentWillUnmount — stops everything
function stopAll(){
  stopSync();
  _publicListening=false;
  if(_usersUnsub){_usersUnsub();_usersUnsub=null;}
  component=null;
}

// Called when viewing public box page (QR code scan) — no login required
function startPublicSync(comp) {
  if (!window.EB_Firebase) { console.warn('[Sync] Firebase not ready'); return; }
  db = window.EB_Firebase.db; component = comp;
  if (_publicListening || unsubscribers.length) return; // already listening — just update component ref
  _publicListening = true; // set synchronously before async auth to prevent race on double-call
  window.EB_Firebase.auth.signInAnonymously()
    .then(() => {
      console.log('[Sync] Public sync: anon auth OK');
      const u1 = db.collection(C.boxes).onSnapshot(snap => {
        if (!component) return;
        const boxes = [];
        snap.forEach(doc => boxes.push({ id: doc.id, ...doc.data() }));
        boxes.sort((a, b) => { const n = s => parseInt(s.replace(/\D/g, ''), 10) || 0; return n(a.id) - n(b.id); });
        component.BOXES = boxes;
        component.setState({ _publicSynced: true });
      }, err => { console.warn('[Sync] Public boxes error:', err.message); if (component) component.setState({ _publicLoadError: true }); });
      const u2 = db.collection(C.boxDrugs).onSnapshot(snap => {
        if (!component) return;
        const bd = {};
        snap.forEach(doc => { const d = doc.data(); const boxId = d.boxId || doc.id; if (boxId && d.drugs) bd[boxId] = d.drugs; });
        component.BOX_DRUGS = bd;
        component.setState({ boxDrugs: Object.keys(bd).length ? bd : {} });
      }, err => { console.warn('[Sync] Public drugs error:', err.message); if (component) component.setState({ _publicLoadError: true }); });
      unsubscribers.push(u1, u2);
    })
    .catch(err => { _publicListening = false; console.warn('[Sync] Public anon auth failed:', err.message); if (component) component.setState({ _publicLoadError: true }); });
}

async function seedIfEmpty(){
  if(!component||!db)return;
  try{
    const snap=await db.collection(C.boxes).limit(1).get();
    if(snap.empty){
      console.log('[Sync] Seeding defaults...');
      const batch=db.batch();
      component.BOXES.forEach(box=>{const ref=db.collection(C.boxes).doc(box.id);const{id,...data}=box;batch.set(ref,data);});
      await batch.commit();
      const ab=db.batch();
      component.AUDIT.filter(a=>a.date).forEach((a,i)=>{const ref=db.collection(C.audit).doc('audit-'+i);ab.set(ref,a);});
      await ab.commit();
    }
    // seed box_drugs separately — may be empty even when boxes exist
    const bdSnap=await db.collection(C.boxDrugs).limit(1).get();
    if(bdSnap.empty){
      console.log('[Sync] Seeding box_drugs...');
      const bd=component.buildBoxDrugs();
      const bb=db.batch();
      Object.entries(bd).forEach(([boxId,drugs])=>{bb.set(db.collection(C.boxDrugs).doc(boxId),{boxId,drugs,updatedAt:firebase.firestore.FieldValue.serverTimestamp()});});
      await bb.commit();
      console.log('[Sync] box_drugs seeded.');
    }
  }catch(err){console.warn('[Sync] Seed failed (offline?):', err.message);}
}
function listenBoxes(){
  const unsub=db.collection(C.boxes).onSnapshot(snap=>{
    if(!component)return;
    const boxes=[];snap.forEach(doc=>{boxes.push({id:doc.id,...doc.data()});});
    boxes.sort((a,b)=>{const n=(s)=>parseInt(s.replace(/\D/g,''),10)||0;return n(a.id)-n(b.id);});
    // always update BOXES even when empty — prevents stale data after deletion
    component.BOXES=boxes;component.setState({});
    if(typeof component._syncChipStates==='function')component._syncChipStates();
  },err=>console.warn('[Sync] Boxes error:',err.message));
  unsubscribers.push(unsub);
}
function listenAudit(){
  const unsub=db.collection(C.audit).orderBy('date','desc').limit(500).onSnapshot(snap=>{
    if(!component)return;
    const logs=[];snap.forEach(doc=>{const d=doc.data();const cat=d.cat||(d.action==='จ่าย'?'dispense':d.action==='รับคืน'?'return':'other');logs.push({...d,cat});});
    // Firestore orderBy('date') only sorts by date string — re-sort by date+time
    // so multiple events on the same day appear in true newest-first order
    logs.sort((a,b)=>{const ka=(a.date||'')+' '+(a.time||''),kb=(b.date||'')+' '+(b.time||'');return kb<ka?-1:kb>ka?1:0;});
    // always update audit even when empty
    component.AUDIT=logs;component.setState({auditLog:logs});
  },err=>console.warn('[Sync] Audit error:',err.message));
  unsubscribers.push(unsub);
}
function listenBoxDrugs(){
  const unsub=db.collection(C.boxDrugs).onSnapshot(snap=>{
    if(!component)return;
    const bd={};snap.forEach(doc=>{const d=doc.data();const boxId=d.boxId||doc.id;if(boxId&&d.drugs)bd[boxId]=d.drugs;});
    // always update BOX_DRUGS — authoritative source for current Firestore data
    component.BOX_DRUGS=bd;
    // block state update only while user is actively editing drug lots (editDrugs=true)
    // this prevents listener from clobbering in-progress drug edits
    // all other screens (dashboard, detail, register, dispense, return) receive live updates
    const _st=component.state||{};
    const _editing=_st.editDrugs;
    if(!_editing){
      const _patch={boxDrugs:Object.keys(bd).length?bd:{}};
      if(_st.authed&&window.EB_Notify){
        const _s=window.EB_Notify.loadSettings();
        const _a=window.EB_Notify.findExpiringDrugs(component,_s.thresholdDays);
        _patch.expiryAlerts=_a;
        if(_a.length&&!_st.showExpiryBanner&&!_st._expiryBannerDismissed)_patch.showExpiryBanner=true;
      }
      component.setState(_patch);
    }
  },err=>console.warn('[Sync] BoxDrugs error:',err.message));
  unsubscribers.push(unsub);
}
function logAudit(entry){
  if(!db)return Promise.resolve();
  return db.collection(C.audit).add({...entry,createdAt:firebase.firestore.FieldValue.serverTimestamp()}).catch(err=>{console.error('[Sync] Audit write failed:',err.message);throw err;});
}
function syncBoxes(box){
  if(!db||!box.id)return Promise.resolve();
  const{id,...data}=box;
  return db.collection(C.boxes).doc(id).set(data,{merge:true}).catch(err=>{console.error('[Sync] Box write failed:',err.message);throw err;});
}
function syncUsers(user){
  if(!db)return Promise.resolve();
  const{uid,...data}=user;
  const docId=uid||user.username;
  if(!docId){console.error('[Sync] syncUsers: missing uid and username — write skipped');return Promise.resolve();}
  return db.collection(C.users).doc(docId).set(data,{merge:true}).catch(err=>console.error('[Sync] User write failed:',err.message));
}
function syncBoxDrugs(boxId,drugs){
  if(!db)return Promise.resolve();
  return db.collection(C.boxDrugs).doc(boxId).set({boxId,drugs,updatedAt:firebase.firestore.FieldValue.serverTimestamp()},{merge:true}).catch(err=>{console.error('[Sync] BoxDrugs write failed:',err.message);throw err;});
}
function deleteUser(user){
  if(!db)return Promise.resolve();
  const docId=user.uid||user.username;
  if(!docId)return Promise.resolve();
  return db.collection(C.users).doc(docId).delete().catch(err=>console.error('[Sync] User delete failed:',err.message));
}
window.EB_Sync={initUsersOnly,initFirebaseSync,startPublicSync,stopSync,stopAll,logAudit,syncBoxes,syncUsers,deleteUser,syncBoxDrugs};
})();
