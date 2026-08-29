(function(){'use strict';
let db=null,component=null,unsubscribers=[],_usersUnsub=null,_publicListening=false;
const C={boxes:'boxes',audit:'audit_log',users:'users',boxDrugs:'box_drugs',usageLog:'usage_log',appSettings:'app_settings',kpiEvents:'kpi_events',kpiInvestigations:'kpi_investigations'};

// Called from componentDidMount — signs in anonymously and starts users listener
// so login can authenticate against ALL users in Firestore from any device
function initUsersOnly(comp){
  if(!window.EB_Firebase){
    console.warn('[Sync] Firebase not ready');
    // firebase-init.js failed entirely (CDN blocked, ad-blocker, invalid
    // config) — without this, state.users stays permanently empty with the
    // SAME "loading, please wait" symptom as a failed anonymous sign-in
    // below, but authInitError (doLogin()'s only signal to show a real error
    // instead) was never set for this specific failure mode, since it used
    // to require window.EB_Firebase to already exist before even reaching
    // the signInAnonymously().catch() that sets it.
    if(comp&&comp.setState)comp.setState({authInitError:true});
    return;
  }
  db=window.EB_Firebase.db;component=comp;
  if(_usersUnsub){return;} // already listening, just update component reference
  window.EB_Firebase.auth.signInAnonymously()
    .then(()=>{
      console.log('[Sync] Anon auth OK — starting users listener');
      _startUsersListener();
    })
    .catch(err=>{
      console.warn('[Sync] Anon auth failed:',err.message);
      // without this, state.users stays permanently empty with no signal —
      // doLogin() would show "loading, please wait" forever, indistinguishable
      // from a slow network, with no way for the user to know it actually failed
      if(component&&component.setState)component.setState({authInitError:true});
    });
}

function _startUsersListener(){
  if(_usersUnsub)return;
  if(!db)return;
  // Seed hardcoded admin to Firestore if users collection is empty — this
  // one-time check + possible write MUST resolve before the onSnapshot
  // listener below attaches. Both used to fire back-to-back unsequenced: on a
  // genuinely fresh Firestore project the listener's own first (empty)
  // snapshot could land first and set component.state.users to [], so by the
  // time this .get() callback ran, component.state.users.length was already
  // 0 and the seed condition never fired — permanently skipping admin seeding
  // with no retry path (every future page load hits the same empty
  // collection and races the same way).
  db.collection(C.users).limit(1).get().then(snap=>{
    if(snap.empty&&component&&component.state&&component.state.users&&component.state.users.length){
      console.log('[Sync] Seeding users (admin)...');
      const ub=db.batch();
      component.state.users.forEach(u=>{const{uid,...data}=u;const docId=uid||u.username;ub.set(db.collection(C.users).doc(docId),data);});
      return ub.commit().then(()=>console.log('[Sync] Users seeded.')).catch(err=>console.warn('[Sync] User seed failed:',err.message));
    }
  }).catch(()=>{}).then(()=>{
    if(_usersUnsub)return; // guard against a concurrent initUsersOnly() call landing here twice
    _usersUnsub=db.collection(C.users).onSnapshot(snap=>{
      if(!component)return;
      const users=[],seen=new Set();
      snap.forEach(doc=>{
        const u={uid:doc.id,...doc.data()};
        if(u.username&&!seen.has(u.username)){seen.add(u.username);users.push(u);}
      });
      component.setState({users});
    },err=>_onListenerError('Users',err));
  });
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
function startPublicSync(comp, boxId) {
  if (!window.EB_Firebase) { console.warn('[Sync] Firebase not ready'); return; }
  if (!boxId) { console.warn('[Sync] startPublicSync called with no boxId'); return; }
  db = window.EB_Firebase.db; component = comp;
  if (_publicListening || unsubscribers.length) return; // already listening — just update component ref
  _publicListening = true; // set synchronously before async auth to prevent race on double-call
  window.EB_Firebase.auth.signInAnonymously()
    .then(() => {
      console.log('[Sync] Public sync: anon auth OK');
      // Scoped to the single scanned box — this page requires no login at all,
      // so without this every ordinary QR scan (a delivery person, a visiting
      // relative) streamed the live dispense/receiver/preparer/checker fields
      // AND full drug/lot/quantity data for EVERY box in every department to
      // that anonymous browser, not just the one scanned. firestore.rules'
      // accepted trust model is about a visitor actively probing Firestore
      // with devtools — this was a much larger, purely incidental exposure
      // with zero effort required to trigger it.
      const u1 = db.collection(C.boxes).doc(boxId).onSnapshot(doc => {
        if (!component) return;
        component.BOXES = doc.exists ? [{ id: doc.id, ...doc.data() }] : [];
        component.setState({ _publicSynced: true });
      }, err => { console.warn('[Sync] Public box error:', err.message); if (component) component.setState({ _publicLoadError: true }); });
      const u2 = db.collection(C.boxDrugs).doc(boxId).onSnapshot(doc => {
        if (!component) return;
        const d = doc.exists ? doc.data() : null;
        const bd = (d && d.drugs) ? { [d.boxId || boxId]: d.drugs } : {};
        component.BOX_DRUGS = bd;
        component.setState({ boxDrugs: bd });
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
// onSnapshot's error callback only fires for TERMINAL errors (Firestore's own
// SDK already retries transient network blips internally without surfacing
// them here) — so once it fires, that listener is dead for good with no
// automatic resubscribe. Every one of these must set _syncError so the app
// shell can show a persistent "real-time sync lost, refresh" banner instead
// of silently freezing BOXES/AUDIT/BOX_DRUGS at their last known value while
// still looking fully live. Mirrors the _publicLoadError flag startPublicSync
// already sets for the same class of failure on the public QR page.
function _onListenerError(label,err){
  console.warn(`[Sync] ${label} error:`,err.message);
  if(component)component.setState({_syncError:true});
}
function listenBoxes(){
  const unsub=db.collection(C.boxes).onSnapshot(snap=>{
    if(!component)return;
    const boxes=[];snap.forEach(doc=>{boxes.push({id:doc.id,...doc.data()});});
    boxes.sort((a,b)=>{const n=(s)=>parseInt(s.replace(/\D/g,''),10)||0;return n(a.id)-n(b.id);});
    // always update BOXES even when empty — prevents stale data after deletion
    // boxesSynced flips true here so the app can gate its very first
    // post-login render behind a loading state instead of briefly showing
    // this.BOXES's blank class-property default (see showInitialBoxesLoading
    // in index.html's renderVals()), which looks identical to a freshly-
    // reset set of boxes.
    component.BOXES=boxes;component.setState({boxesSynced:true});
    if(typeof component._syncChipStates==='function')component._syncChipStates();
    // expiry alerts depend on box fields too (dept/dispense/receiver), not just
    // box_drugs — without this, a plain dispense/return/register write (which
    // never touches box_drugs) left the dashboard's alert list showing stale
    // department/location context until some UNRELATED box_drugs write
    // anywhere in the system happened to trigger the listenBoxDrugs recompute.
    const _st=component.state||{};
    if(_st.authed&&window.EB_Notify){
      const _s=window.EB_Notify.loadSettings();
      const _a=window.EB_Notify.findExpiringDrugs(component,_s.thresholdDays);
      const _patch={expiryAlerts:_a};
      if(_a.length&&!_st.showExpiryBanner&&component._hasNewUrgentAlerts(_a))_patch.showExpiryBanner=true;
      component.setState(_patch);
    }
  },err=>_onListenerError('Boxes',err));
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
  },err=>_onListenerError('Audit',err));
  unsubscribers.push(unsub);
}
function listenBoxDrugs(){
  const unsub=db.collection(C.boxDrugs).onSnapshot(snap=>{
    if(!component)return;
    const bd={};snap.forEach(doc=>{const d=doc.data();const boxId=d.boxId||doc.id;if(boxId&&d.drugs)bd[boxId]=d.drugs;});
    // always update BOX_DRUGS — authoritative source for current Firestore data
    component.BOX_DRUGS=bd;
    // block state update entirely only while user is actively editing drug lots on the
    // Detail screen (editDrugs=true) — that editor has its own conflict check at save time.
    // this prevents listener from clobbering in-progress drug edits
    // all other screens (dashboard, detail, register, dispense, return) receive live updates
    const _st=component.state||{};
    const _editing=_st.editDrugs;
    if(!_editing){
      const _patch={boxDrugs:Object.keys(bd).length?bd:{}};
      // The register Stage 1/2 form uses this SAME boxDrugs key as its own live edit
      // buffer (setLotField/addLot/removeLot/toggleDrugVerified) but has no editDrugs
      // flag of its own — without this, any unrelated box_drugs write anywhere (a
      // dispense, return, or paperless usage-log entry on a DIFFERENT box) would
      // silently overwrite the whole boxDrugs map here, discarding a จพ.'s unsaved
      // in-progress lot/expiry typing for the box they're actively preparing.
      // Preserve just that one box's local buffer; every other box still gets the
      // fresh server data live.
      if(component._regTouched&&_st.formMode==='register'&&_st.regEB&&_st.boxDrugs&&_st.boxDrugs[_st.regEB]){
        _patch.boxDrugs[_st.regEB]=_st.boxDrugs[_st.regEB];
      }
      if(_st.authed&&window.EB_Notify){
        const _s=window.EB_Notify.loadSettings();
        const _a=window.EB_Notify.findExpiringDrugs(component,_s.thresholdDays);
        _patch.expiryAlerts=_a;
        if(_a.length&&!_st.showExpiryBanner&&component._hasNewUrgentAlerts(_a))_patch.showExpiryBanner=true;
      }
      component.setState(_patch);
    }
  },err=>_onListenerError('BoxDrugs',err));
  unsubscribers.push(unsub);
}
function logAudit(entry){
  // reject (not resolve) when Firebase never initialized — mirrors
  // syncUsers/deleteUser/returnBoxAndDrugsTx/logDrugUsageTx below. A silent
  // resolve() here used to make every write path built on it (_syncBox,
  // logAction, logBoxHist) report success while nothing was ever persisted,
  // if firebase-init.js failed to reach Firestore (blocked CDN, ad-blocker,
  // bad config) for the whole session.
  if(!db)return Promise.reject(new Error('no-db'));
  return db.collection(C.audit).add({...entry,createdAt:firebase.firestore.FieldValue.serverTimestamp()}).catch(err=>{console.error('[Sync] Audit write failed:',err.message);throw err;});
}
function syncBoxes(box){
  if(!box.id)return Promise.resolve();
  if(!db)return Promise.reject(new Error('no-db'));
  const{id,...data}=box;
  return db.collection(C.boxes).doc(id).set(data,{merge:true}).catch(err=>{console.error('[Sync] Box write failed:',err.message);throw err;});
}
function syncUsers(user){
  if(!db)return Promise.reject(new Error('no-db'));
  const{uid,...data}=user;
  const docId=uid||user.username;
  if(!docId){const err=new Error('syncUsers: missing uid and username');console.error('[Sync]',err.message);return Promise.reject(err);}
  // rethrow (not swallow) — callers must know a role/status/password change
  // actually landed before logging it to audit_log or flashing success
  return db.collection(C.users).doc(docId).set(data,{merge:true}).catch(err=>{console.error('[Sync] User write failed:',err.message);throw err;});
}
function syncBoxDrugs(boxId,drugs){
  if(!db)return Promise.reject(new Error('no-db'));
  return db.collection(C.boxDrugs).doc(boxId).set({boxId,drugs,updatedAt:firebase.firestore.FieldValue.serverTimestamp()},{merge:true}).catch(err=>{console.error('[Sync] BoxDrugs write failed:',err.message);throw err;});
}
function deleteUser(user){
  if(!db)return Promise.reject(new Error('no-db'));
  const docId=user.uid||user.username;
  if(!docId)return Promise.reject(new Error('deleteUser: missing uid and username'));
  return db.collection(C.users).doc(docId).delete().catch(err=>{console.error('[Sync] User delete failed:',err.message);throw err;});
}
// setUserRole/toggleUserStatus/deleteUser's "keep at least 1 active admin"
// guard was previously a plain client-side count against state.users (a
// live-but-possibly-stale onSnapshot array) checked BEFORE the actual write
// — non-transactional, so two admins racing to demote/suspend/delete EACH
// OTHER at nearly the same moment could each independently see "the other
// one is still active" and both writes land, leaving zero active admins
// with no in-app recovery path. Re-reads the known admin docs fresh,
// atomically, inside the SAME transaction that performs the change, and
// aborts with LAST_ADMIN if fewer than one OTHER active admin would remain.
// action: 'fields' (role/status change, merges `fields`) or 'delete'.
//
// candidateUsernames is the current admin roster from the CALLER's
// state.users (a live-but-possibly-stale onSnapshot array) — NOT read via
// a live query inside the transaction. This is a real, confirmed
// constraint, not a design choice: Transaction.get() in this SDK version
// only accepts a single DocumentReference, never a Query — an earlier
// version of this function tried `tx.get(collection.where(...))` and it
// was NEVER actually exercised against real Firestore before shipping;
// tested directly against production with a throwaway test user doc, it
// threw `invalid-argument: Expected type 'DocumentReference', but it was:
// a custom Query object` on every single call, silently breaking every
// admin demote/suspend/delete action in production. Fixed by tx.get()-ing
// each admin's own DocumentReference individually instead.
// This still closes the actual race that mattered: two clients acting on
// the same two admin accounts both read/write documents from this same
// known set, so Firestore's normal transaction conflict detection (a
// transaction that read a document since modified by another committed
// transaction is automatically retried with fresh data) still forces the
// second-to-commit transaction to re-evaluate against the first one's
// result — role AND status are both re-checked fresh per doc inside the
// transaction (not trusted from the possibly-stale candidate list), so a
// candidate that turns out to no longer be an active admin by commit time
// is correctly excluded. The only residual gap is a roster GAIN/LOSS
// exactly in the moment between the caller reading state.users and the
// transaction starting (a newly-promoted admin not yet in the candidate
// list, or a newly-demoted one still in it) — a materially different,
// far narrower race than the one this function exists to close, and
// self-corrects on the admin list's next live update.
function guardedAdminChangeTx(username,candidateUsernames,action,fields){
  if(!db)return Promise.reject(new Error('no-db'));
  const userRef=db.collection(C.users).doc(username);
  const usernames=Array.from(new Set([...(candidateUsernames||[]),username]));
  const refs=usernames.map(u=>db.collection(C.users).doc(u));
  return db.runTransaction(tx=>Promise.all(refs.map(r=>tx.get(r))).then(snaps=>{
    let activeOthers=0;
    snaps.forEach(snap=>{
      if(!snap.exists||snap.id===username)return;
      const d=snap.data();
      if(d.role==='admin'&&(d.status||'active')==='active')activeOthers++;
    });
    if(activeOthers===0){const err=new Error('ต้องมีแอดมินที่ใช้งานได้อย่างน้อย 1 คนเสมอ');err.code='LAST_ADMIN';throw err;}
    if(action==='delete')tx.delete(userRef);
    else tx.set(userRef,fields,{merge:true});
  })).catch(err=>{if(err.code!=='LAST_ADMIN')console.error('[Sync] guardedAdminChangeTx failed:',err.message);throw err;});
}
// Atomically marks a box returned AND decrements its box_drugs quantities in one
// Firestore transaction, reading both docs fresh at commit time (never the
// client's local cache). This closes two races the plain set()/merge() writes
// could not: (1) two staff returning the SAME box — the transaction re-reads
// server state and rejects with NOT_OUT if it's already been returned, instead
// of silently overwriting whoever returned it first; (2) concurrent quantity
// decrements on the same box_drugs doc from two devices — each transaction
// decrements from whatever the server currently holds, so both decrements
// compose correctly instead of the slower write clobbering the faster one.
// Also guarantees the box-status write and the drug-decrement write succeed or
// fail together, so a partial failure can never leave one persisted without
// the other.
function returnBoxAndDrugsTx(boxId,boxFields,usageMap){
  if(!db)return Promise.reject(new Error('no-db'));
  const boxRef=db.collection(C.boxes).doc(boxId);
  const drugsRef=db.collection(C.boxDrugs).doc(boxId);
  return db.runTransaction(tx=>Promise.all([tx.get(boxRef),tx.get(drugsRef)]).then(([boxSnap,drugsSnap])=>{
    const boxData=boxSnap.exists?boxSnap.data():{};
    const isOut=!!(boxData.dispense&&!boxData.receiver);
    if(!isOut){const err=new Error('กล่องนี้ไม่ได้อยู่ในสถานะจ่ายออกแล้ว (อาจถูกรับคืนไปแล้วโดยผู้อื่น)');err.code='NOT_OUT';throw err;}
    tx.update(boxRef,boxFields);
    const drugs=(drugsSnap.exists?drugsSnap.data().drugs:null)||[];
    let updatedDrugs=null;
    if(drugs.length>0){
      // every returned box needs จพ. to restock/re-check and a pharmacist to
      // re-verify before it can go out again — a box that was just out and used
      // is no longer guaranteed full/verified, so unverify every drug here in
      // the same transaction as the quantity decrement (caller resets
      // preparedAt/registeredAt on the box doc via boxFields for the same reason)
      updatedDrugs=drugs.map((d,di)=>({
        ...d,
        verified:false,
        lots:(d.lots||[]).map((l,li)=>({...l,qty:Math.max(0,(l.qty||0)-((usageMap[di]||{})[li]||0))})).filter(l=>l.qty>0),
      }));
      tx.set(drugsRef,{boxId,drugs:updatedDrugs,updatedAt:firebase.firestore.FieldValue.serverTimestamp()},{merge:true});
    }
    return {drugs:updatedDrugs};
  })).catch(err=>{if(err.code!=='NOT_OUT')console.error('[Sync] returnBoxAndDrugsTx failed:',err.message);throw err;});
}
// Detail screen's drug/lot editor (saveEditDrugs() in index.html) — was
// previously a plain overwrite of the whole box_drugs.drugs[] array, with a
// client-side "did the data change since I started editing" check performed
// BEFORE that write (comparing against a snapshot taken when editing
// started). A real concurrent write (a return, a paperless usage-log entry)
// landing in the sub-second gap between that check and the write itself was
// never caught, letting the editor silently overwrite a real quantity
// decrement that happened in that gap. Now a genuine transaction: re-reads
// box_drugs fresh at commit time and compares against the same
// editing-started snapshot (expectedDrugs) ATOMICALLY inside the
// transaction, closing that race the same way returnBoxAndDrugsTx/
// logDrugUsageTx already close theirs. boxFields (expiry/nearDrug) is
// optional and applied to the boxes doc in the same transaction.
function saveEditDrugsTx(boxId,expectedDrugs,newDrugs,boxFields){
  if(!db)return Promise.reject(new Error('no-db'));
  const boxRef=db.collection(C.boxes).doc(boxId);
  const drugsRef=db.collection(C.boxDrugs).doc(boxId);
  return db.runTransaction(tx=>tx.get(drugsRef).then(drugsSnap=>{
    const liveDrugs=(drugsSnap.exists?drugsSnap.data().drugs:null)||[];
    if(JSON.stringify(liveDrugs)!==JSON.stringify(expectedDrugs)){
      const err=new Error('ข้อมูลยาของกล่องนี้เปลี่ยนไประหว่างที่คุณแก้ไข');err.code='CONCURRENT_CHANGE';throw err;
    }
    tx.set(drugsRef,{boxId,drugs:newDrugs,updatedAt:firebase.firestore.FieldValue.serverTimestamp()},{merge:true});
    if(boxFields)tx.update(boxRef,boxFields);
  })).catch(err=>{if(err.code!=='CONCURRENT_CHANGE')console.error('[Sync] saveEditDrugsTx failed:',err.message);throw err;});
}
// Paperless usage logging — a ward/dept scans the box QR and records a single
// drug-use event (no login required, gated by a department PIN checked in the
// UI layer before this is called). Atomic in one transaction, same reasoning
// as returnBoxAndDrugsTx: reads box + box_drugs fresh at commit time so two
// nurses logging usage on the same box around the same moment compose
// correctly instead of one clobbering the other, verifies the box is still
// actually out, verifies the requested quantity does not exceed what the
// server currently holds (rejects rather than silently clamping — a nurse
// should be told the count looks wrong, not have it silently adjusted), sets
// openedAt the first time a box is used in its current dispense cycle, and
// appends a permanent usage_log entry (append-only, see firestore.rules) for
// the box's real-time usage history.
function logDrugUsageTx(boxId,dept,drugIdx,lotIdx,qty,hn,patientName,recordedAt,recordedTime){
  if(!db)return Promise.reject(new Error('no-db'));
  if(!(qty>0)){const err=new Error('จำนวนต้องมากกว่า 0');err.code='BAD_QTY';return Promise.reject(err);}
  const boxRef=db.collection(C.boxes).doc(boxId);
  const drugsRef=db.collection(C.boxDrugs).doc(boxId);
  const usageRef=db.collection(C.usageLog).doc();
  return db.runTransaction(tx=>Promise.all([tx.get(boxRef),tx.get(drugsRef)]).then(([boxSnap,drugsSnap])=>{
    const boxData=boxSnap.exists?boxSnap.data():{};
    const isOut=!!(boxData.dispense&&!boxData.receiver);
    if(!isOut){const err=new Error('กล่องนี้ไม่ได้อยู่ในสถานะจ่ายออกอยู่ — รีเฟรชหน้าแล้วลองใหม่');err.code='NOT_OUT';throw err;}
    const drugs=(drugsSnap.exists?drugsSnap.data().drugs:null)||[];
    const drug=drugs[drugIdx];
    const lot=drug&&(drug.lots||[])[lotIdx];
    if(!drug||!lot){const err=new Error('ไม่พบรายการยานี้ในกล่อง — ข้อมูลอาจเปลี่ยนไปแล้ว รีเฟรชแล้วลองใหม่');err.code='NOT_FOUND';throw err;}
    if(qty>(lot.qty||0)){const err=new Error(`จำนวนที่กรอก (${qty}) มากกว่าที่มีอยู่จริง (${lot.qty||0}) — ตรวจสอบแล้วลองใหม่`);err.code='INSUFFICIENT_QTY';throw err;}
    // Deliberately does NOT filter out a lot that reaches qty=0 here (unlike
    // returnBoxAndDrugsTx's one-time full-return cleanup) — drugIdx/lotIdx are
    // plain array positions chosen from whatever snapshot the client had
    // rendered, and two concurrent public-page usage submissions on the same
    // drug's different lots is a realistic scenario (multiple ward staff
    // scanning the same box's QR around the same time). If an earlier-index
    // lot were removed here, every later lot's index would shift for the NEXT
    // transaction that re-reads this array, silently decrementing the wrong
    // physical lot with no error surfaced. Keeping the (now-empty) lot in
    // place preserves index stability across concurrent calls; it disappears
    // the normal way on the next register Stage 1 restock/edit.
    const updatedDrugs=drugs.map((d,di)=>di!==drugIdx?d:{
      ...d,
      lots:(d.lots||[]).map((l,li)=>li!==lotIdx?l:{...l,qty:l.qty-qty}),
    });
    tx.set(drugsRef,{boxId,drugs:updatedDrugs,updatedAt:firebase.firestore.FieldValue.serverTimestamp()},{merge:true});
    if(!boxData.openedAt)tx.update(boxRef,{openedAt:recordedAt});
    tx.set(usageRef,{boxId,dept:dept||boxData.dept||'',drugName:drug.name,qty,hn:hn||'',patientName:patientName||'',recordedAt,recordedTime,createdAt:firebase.firestore.FieldValue.serverTimestamp()});
    return {drugs:updatedDrugs,drugName:drug.name,openedNow:!boxData.openedAt};
  })).catch(err=>{if(!err.code)console.error('[Sync] logDrugUsageTx failed:',err.message);throw err;});
}
function listenUsageLog(boxId,cb){
  if(!db)return ()=>{};
  // filter by boxId only (no orderBy) to avoid requiring a composite index —
  // sort client-side instead, newest first
  return db.collection(C.usageLog).where('boxId','==',boxId).limit(200)
    .onSnapshot(snap=>{
      const rows=[];snap.forEach(doc=>rows.push({id:doc.id,...doc.data()}));
      rows.sort((a,b)=>{const ka=(a.recordedAt||'')+' '+(a.recordedTime||''),kb=(b.recordedAt||'')+' '+(b.recordedTime||'');return kb<ka?-1:kb>ka?1:0;});
      cb(rows);
    },err=>console.warn('[Sync] UsageLog error:',err.message));
}
// Admin-wide usage log report — every entry across every box, not scoped to
// one boxId like listenUsageLog. Same no-orderBy-avoid-composite-index
// reasoning; capped and sorted client-side, newest first.
function listenAllUsageLog(cb){
  if(!db)return ()=>{};
  return db.collection(C.usageLog).limit(1000)
    .onSnapshot(snap=>{
      const rows=[];snap.forEach(doc=>rows.push({id:doc.id,...doc.data()}));
      rows.sort((a,b)=>{const ka=(a.recordedAt||'')+' '+(a.recordedTime||''),kb=(b.recordedAt||'')+' '+(b.recordedTime||'');return kb<ka?-1:kb>ka?1:0;});
      cb(rows);
    },err=>console.warn('[Sync] AllUsageLog error:',err.message));
}
// One-time (non-realtime) range query — the live listenAudit() listener is
// deliberately capped at the 500 most-recent docs to keep the real-time
// dashboard/history view light, but that means a fiscal-year or custom
// date-range filter reaching further back than that window would otherwise
// silently show (and CSV-export) INCOMPLETE results with no indication
// anything was cut off. Used specifically by exportCSV() so the compliance-
// critical export path is always guaranteed complete regardless of the live
// window's size, even though the on-screen live view still honors the cap.
//
// {source:'server'} on every .get() below (this one, fetchUsageLogRange,
// fetchKpiEvents, fetchKpiInvestigations, fetchBoxHistory) is deliberate and
// load-bearing, not cosmetic — the SDK's default .get() silently falls back
// to whatever's in the local IndexedDB cache when the server is unreachable
// (a network blip, a restrictive hospital firewall/proxy — see the anon-auth
// trust-model notes elsewhere in this app for why that's a real, expected
// risk here) and RESOLVES successfully with an empty snapshot rather than
// rejecting, if that cache happens to be empty (e.g. a browser profile that
// has never synced this collection before, or cleared storage). Confirmed
// directly against the real SDK: default .get() on an unreachable backend
// returned `{size:0, fromCache:true}` with no error at all, while
// .get({source:'server'}) on the same query correctly rejected with
// `unavailable`. Every one of these five functions feeds a completeness-
// critical admin view (KPI dashboard drill-down, CSV/PDF exports, box
// history) that CLAUDE.md already documents as "must never silently show
// incomplete data" — without forcing source:'server', a KPI card or export
// hitting this exact condition reads as "0 events / no data recorded",
// indistinguishable from genuinely-zero, instead of the actual truth ("the
// fetch never reached the server"). Forcing server-only trades silent wrong
// answers for a loud, retryable error — every caller's existing .catch()
// already surfaces one.
function fetchAuditRange(fromISO,toISO){
  if(!db)return Promise.resolve([]);
  let q=db.collection(C.audit);
  if(fromISO)q=q.where('date','>=',fromISO);
  if(toISO)q=q.where('date','<=',toISO);
  return q.get({source:'server'}).then(snap=>{
    const logs=[];
    snap.forEach(doc=>{const d=doc.data();const cat=d.cat||(d.action==='จ่าย'?'dispense':d.action==='รับคืน'?'return':'other');logs.push({...d,cat});});
    return logs;
  }).catch(err=>{console.warn('[Sync] fetchAuditRange failed:',err.message);throw err;});
}
// Same completeness fix as fetchAuditRange, for the admin-wide usage_log
// report/CSV export — listenAllUsageLog's live listener is capped at 1000
// most-recent docs, so a date-range filter (or an unbounded export once past
// the cap) could otherwise silently omit older drug-administration records
// (who gave what dose to which HN, when) with no indication anything was cut.
function fetchUsageLogRange(fromISO,toISO){
  if(!db)return Promise.resolve([]);
  let q=db.collection(C.usageLog);
  if(fromISO)q=q.where('recordedAt','>=',fromISO);
  if(toISO)q=q.where('recordedAt','<=',toISO);
  // source:'server' — see fetchAuditRange's comment above for why
  return q.get({source:'server'}).then(snap=>{
    const rows=[];snap.forEach(doc=>rows.push({id:doc.id,...doc.data()}));
    return rows;
  }).catch(err=>{console.warn('[Sync] fetchUsageLogRange failed:',err.message);throw err;});
}
// KPI instrumentation — append-only event log feeding the admin-only KPI
// dashboard. `entry.type` distinguishes what kind of event this is
// ('expiry_incident' from the daily check-expiry.js Action, 'reg_timing' from
// a completed Stage 1/2 registration, 'audit_write_failure' from a failed
// logAction/logBoxHist call). Fire-and-forget from every call site — a KPI
// write failing must never block or roll back the real action it's measuring.
function logKpiEvent(entry){
  if(!db)return Promise.reject(new Error('no-db'));
  return db.collection(C.kpiEvents).add({...entry,createdAt:firebase.firestore.FieldValue.serverTimestamp()}).catch(err=>{console.warn('[Sync] KPI event write failed:',err.message);throw err;});
}
// One-time range query against `date` (ISO, no composite index needed) —
// kept for CSV/PDF export and any one-off read; the live KPI dashboard
// itself now uses listenKpiEvents() below instead (see that function's own
// comment for why this changed from the original "fetch on demand" design).
function fetchKpiEvents(fromISO,toISO){
  if(!db)return Promise.resolve([]);
  let q=db.collection(C.kpiEvents);
  if(fromISO)q=q.where('date','>=',fromISO);
  if(toISO)q=q.where('date','<=',toISO);
  // source:'server' — see fetchAuditRange's comment above for why
  return q.get({source:'server'}).then(snap=>{
    const rows=[];snap.forEach(doc=>rows.push({id:doc.id,...doc.data()}));
    return rows;
  }).catch(err=>{console.warn('[Sync] fetchKpiEvents failed:',err.message);throw err;});
}
// Real-time counterpart of fetchKpiEvents — the KPI dashboard now updates
// live the moment a new instrumentation event is recorded (had_check,
// stage2_wait, reg_timing, csv_export, qr_pageview, etc.) instead of only
// refreshing on manual "รีเฟรช" or a date-range change, per direct admin
// request ("นำมาเชื่อกับตัวชี้วัดอย่าง real time"). Kept as a genuine
// onSnapshot listener (not a one-time complete fetch, unlike audit_log's
// KPI usage) because kpi_events volume is far lower than audit_log — every
// write here is a deliberate, sparse instrumentation event, not a
// general-purpose log, so there's no equivalent 500-doc-cap concern.
// Callback receives (rows, null) on each snapshot, or (null, err) on a
// terminal listener error — caller decides how to surface that.
function listenKpiEvents(fromISO,toISO,cb){
  if(!db)return ()=>{};
  let q=db.collection(C.kpiEvents);
  if(fromISO)q=q.where('date','>=',fromISO);
  if(toISO)q=q.where('date','<=',toISO);
  return q.onSnapshot(snap=>{
    const rows=[];snap.forEach(doc=>rows.push({id:doc.id,...doc.data()}));
    cb(rows,null);
  },err=>{console.warn('[Sync] listenKpiEvents error:',err.message);cb(null,err);});
}
// Admin's manual log of audit-trail investigations (KPI 4.2 — a system
// cannot auto-detect whether an investigation was "successful", so this is a
// deliberately simple hand-entered record, append-only like the rest).
function logKpiInvestigation(entry){
  if(!db)return Promise.reject(new Error('no-db'));
  return db.collection(C.kpiInvestigations).add({...entry,createdAt:firebase.firestore.FieldValue.serverTimestamp()}).catch(err=>{console.warn('[Sync] KPI investigation write failed:',err.message);throw err;});
}
function fetchKpiInvestigations(fromISO,toISO){
  if(!db)return Promise.resolve([]);
  let q=db.collection(C.kpiInvestigations);
  if(fromISO)q=q.where('date','>=',fromISO);
  if(toISO)q=q.where('date','<=',toISO);
  // source:'server' — see fetchAuditRange's comment above for why
  return q.get({source:'server'}).then(snap=>{
    const rows=[];snap.forEach(doc=>rows.push({id:doc.id,...doc.data()}));
    return rows;
  }).catch(err=>{console.warn('[Sync] fetchKpiInvestigations failed:',err.message);throw err;});
}
// Real-time counterpart of fetchKpiInvestigations — see listenKpiEvents's
// comment above for why this collection gets a genuine live listener
// instead of the one-time-complete-fetch pattern audit_log uses.
function listenKpiInvestigations(fromISO,toISO,cb){
  if(!db)return ()=>{};
  let q=db.collection(C.kpiInvestigations);
  if(fromISO)q=q.where('date','>=',fromISO);
  if(toISO)q=q.where('date','<=',toISO);
  return q.onSnapshot(snap=>{
    const rows=[];snap.forEach(doc=>rows.push({id:doc.id,...doc.data()}));
    cb(rows,null);
  },err=>{console.warn('[Sync] listenKpiInvestigations error:',err.message);cb(null,err);});
}
// One-time (non-realtime) per-box fetch — the Detail screen's box-history
// panel reads from the live listenAudit() array (capped at 500 most-recent
// docs across the WHOLE audit_log), so once total audit_log docs exceed 500
// an older box's history entries can silently fall out of that window with
// no indication anything was cut off. Two equality filters (eb + cat) don't
// need a composite index, unlike an added orderBy would.
function fetchBoxHistory(boxId){
  if(!db)return Promise.resolve([]);
  // source:'server' — see fetchAuditRange's comment above for why. Still
  // resolves to [] on failure (not a throw) same as before — the Detail
  // screen's own fallback chain (state.boxHist → the live/capped audit
  // array) already handles that gracefully and no caller attaches a .catch.
  return db.collection(C.audit).where('eb','==',boxId).where('cat','==','boxhist').get({source:'server'})
    .then(snap=>{
      const rows=[];
      snap.forEach(doc=>{const d=doc.data();rows.push({text:d.action||'',who:d.person||'—',stamp:`${d.date||''} · ${d.time||''}`,date:d.date||'',time:d.time||''});});
      rows.sort((a,b)=>{const ka=a.date+' '+a.time,kb=b.date+' '+b.time;return kb<ka?-1:kb>ka?1:0;});
      return rows;
    }).catch(err=>{console.warn('[Sync] fetchBoxHistory failed:',err.message);return [];});
}
function getDeptPins(){
  if(!db)return Promise.resolve({});
  return db.collection(C.appSettings).doc('dept_pins').get()
    .then(doc=>doc.exists?doc.data():{})
    .catch(err=>{console.warn('[Sync] getDeptPins failed:',err.message);return {};});
}
function syncDeptPins(pins){
  if(!db)return Promise.reject(new Error('no-db'));
  return db.collection(C.appSettings).doc('dept_pins').set(pins,{merge:true})
    .catch(err=>{console.error('[Sync] syncDeptPins failed:',err.message);throw err;});
}
window.EB_Sync={initUsersOnly,initFirebaseSync,startPublicSync,stopSync,stopAll,logAudit,syncBoxes,syncUsers,deleteUser,guardedAdminChangeTx,syncBoxDrugs,returnBoxAndDrugsTx,saveEditDrugsTx,logDrugUsageTx,listenUsageLog,listenAllUsageLog,getDeptPins,syncDeptPins,fetchAuditRange,fetchUsageLogRange,fetchBoxHistory,logKpiEvent,fetchKpiEvents,listenKpiEvents,logKpiInvestigation,fetchKpiInvestigations,listenKpiInvestigations};
})();
