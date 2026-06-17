(function(){'use strict';
let db=null,component=null,unsubscribers=[];
const C={boxes:'boxes',audit:'audit_log',users:'users',boxDrugs:'box_drugs'};
function initFirebaseSync(comp){
  if(!window.EB_Firebase){console.warn('[Sync] Firebase not initialized');return;}
  db=window.EB_Firebase.db;component=comp;
  console.log('[Sync] Initializing...');
  seedIfEmpty().then(()=>{listenBoxes();listenAudit();listenUsers();listenBoxDrugs();console.log('[Sync] All listeners active.');});
}
function stopSync(){unsubscribers.forEach(fn=>fn());unsubscribers=[];}
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
      component.AUDIT.forEach((a,i)=>{const ref=db.collection(C.audit).doc('audit-'+i);ab.set(ref,a);});
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
    if(boxes.length){component.BOXES=boxes;component.setState({});}
  },err=>console.warn('[Sync] Boxes error:',err.message));
  unsubscribers.push(unsub);
}
function listenAudit(){
  const unsub=db.collection(C.audit).orderBy('date','desc').onSnapshot(snap=>{
    if(!component)return;
    const logs=[];snap.forEach(doc=>{const d=doc.data();logs.push({...d,cat:d.action==='จ่าย'?'dispense':d.action==='รับคืน'?'return':'other'});});
    if(logs.length){component.AUDIT=logs;component.setState({auditLog:logs});}
  },err=>console.warn('[Sync] Audit error:',err.message));
  unsubscribers.push(unsub);
}
function listenUsers(){
  const unsub=db.collection(C.users).onSnapshot(snap=>{
    if(!component)return;
    const users=[];snap.forEach(doc=>{users.push({uid:doc.id,...doc.data()});});
    if(users.length)component.setState({users});
  },err=>console.warn('[Sync] Users error:',err.message));
  unsubscribers.push(unsub);
}
function listenBoxDrugs(){
  const unsub=db.collection(C.boxDrugs).onSnapshot(snap=>{
    if(!component)return;
    const bd={};snap.forEach(doc=>{const d=doc.data();if(d.boxId&&d.drugs)bd[d.boxId]=d.drugs;});
    if(Object.keys(bd).length){component.BOX_DRUGS=bd;component.setState({});}
  },err=>console.warn('[Sync] BoxDrugs error:',err.message));
  unsubscribers.push(unsub);
}
function logAudit(entry){
  if(!db)return Promise.resolve();
  return db.collection(C.audit).add({...entry,createdAt:firebase.firestore.FieldValue.serverTimestamp()}).catch(err=>console.error('[Sync] Audit write failed:',err.message));
}
function syncBoxes(box){
  if(!db)return Promise.resolve();
  const{id,...data}=box;
  return db.collection(C.boxes).doc(id).set(data,{merge:true}).catch(err=>console.error('[Sync] Box write failed:',err.message));
}
function syncUsers(user){
  if(!db)return Promise.resolve();
  const{uid,...data}=user;
  const docId=uid||db.collection(C.users).doc().id;
  return db.collection(C.users).doc(docId).set(data,{merge:true}).catch(err=>console.error('[Sync] User write failed:',err.message));
}
function syncBoxDrugs(boxId,drugs){
  if(!db)return Promise.resolve();
  return db.collection(C.boxDrugs).doc(boxId).set({boxId,drugs,updatedAt:firebase.firestore.FieldValue.serverTimestamp()},{merge:true}).catch(err=>console.error('[Sync] BoxDrugs write failed:',err.message));
}
window.EB_Sync={initFirebaseSync,stopSync,logAudit,syncBoxes,syncUsers,syncBoxDrugs};
})();
