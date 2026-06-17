/**
 * Firebase Sync Layer - Emergency Box Notify
 * Real-time sync between DC Component state and Firestore.
 *
 * Depends on: firebase-init.js (window.EB_Firebase)
 * Include after firebase-init.js:
 *   <script src="firebase-sync.js"></script>
 */

(function () {
  'use strict';

  let db = null;
  let component = null;
  let unsubscribers = [];

  const COLLECTIONS = {
    boxes: 'boxes',
    audit: 'audit_log',
    users: 'users',
    boxDrugs: 'box_drugs',
  };

  function initFirebaseSync(comp) {
    if (!window.EB_Firebase) {
      console.warn('[Sync] Firebase not initialized. Skipping sync.');
      return;
    }
    db = window.EB_Firebase.db;
    component = comp;
    console.log('[Sync] Initializing real-time sync...');
    seedIfEmpty().then(() => {
      listenBoxes();
      listenAudit();
      listenUsers();
      listenBoxDrugs();
      console.log('[Sync] All listeners active.');
    });
  }

  function stopSync() {
    unsubscribers.forEach(fn => fn());
    unsubscribers = [];
    console.log('[Sync] All listeners stopped.');
  }

  async function seedIfEmpty() {
    if (!component || !db) return;
    try {
      const boxSnap = await db.collection(COLLECTIONS.boxes).limit(1).get();
      if (boxSnap.empty) {
        console.log('[Sync] Seeding default data...');
        await seedCollection(COLLECTIONS.boxes, component.BOXES, 'id');
        await seedCollection(COLLECTIONS.audit, component.AUDIT.map((a, i) => ({ ...a, _id: `audit-${i}` })), '_id');
        await seedBoxDrugs();
        console.log('[Sync] Default data seeded.');
      }
    } catch (err) {
      console.warn('[Sync] Seed check failed (offline?):', err.message);
    }
  }

  async function seedCollection(collName, items, idField) {
    const batch = db.batch();
    items.forEach(item => {
      const docId = item[idField] || db.collection(collName).doc().id;
      const ref = db.collection(collName).doc(docId);
      const data = { ...item };
      delete data[idField];
      data._docId = docId;
      batch.set(ref, data);
    });
    await batch.commit();
  }

  async function seedBoxDrugs() {
    if (!component.buildBoxDrugs) return;
    const bd = {};
    component.BOXES.forEach(box => {
      const drugs = component.DRUGS.map((d, i) => {
        const isNear = d.name === box.nearDrug;
        const exp = isNear
          ? component.parse(box.expiry)
          : component.addDays(box.expiry, 40 + i * 12);
        return { name: d.name, qty: d.par, par: d.par, expiry: component.isoOf(exp), lot: 'L' + box.id.replace('EB-', '') + String(i).padStart(2, '0') };
      });
      bd[box.id] = drugs;
    });
    const batch = db.batch();
    Object.entries(bd).forEach(([boxId, drugs]) => {
      const ref = db.collection(COLLECTIONS.boxDrugs).doc(boxId);
      batch.set(ref, { boxId, drugs, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
    });
    await batch.commit();
  }

  function listenBoxes() {
    const unsub = db.collection(COLLECTIONS.boxes)
      .onSnapshot(snapshot => {
        if (!component) return;
        const boxes = [];
        snapshot.forEach(doc => {
          const d = doc.data();
          boxes.push({ id: doc.id, dept: d.dept || '', mfg: d.mfg || '', expiry: d.expiry || '', dispense: d.dispense || '', dispenser: d.dispenser || '', receiver: d.receiver || '', nearDrug: d.nearDrug || '' });
        });
        if (boxes.length) {
          component.BOXES = boxes;
          component.setState({});
          console.log('[Sync] Boxes updated:', boxes.length);
        }
      }, err => console.warn('[Sync] Boxes listener error:', err.message));
    unsubscribers.push(unsub);
  }

  function listenAudit() {
    const unsub = db.collection(COLLECTIONS.audit)
      .orderBy('date', 'desc')
      .onSnapshot(snapshot => {
        if (!component) return;
        const logs = [];
        snapshot.forEach(doc => {
          const d = doc.data();
          logs.push({ date: d.date || '', time: d.time || '', action: d.action || '', eb: d.eb || '', dept: d.dept || '', person: d.person || '', drug: d.drug || '—', cat: d.action === 'จ่าย' ? 'dispense' : (d.action === 'รับคืน' ? 'return' : 'other') });
        });
        if (logs.length) {
          component.AUDIT = logs;
          component.setState({ auditLog: logs });
          console.log('[Sync] Audit log updated:', logs.length);
        }
      }, err => console.warn('[Sync] Audit listener error:', err.message));
    unsubscribers.push(unsub);
  }

  function listenUsers() {
    const unsub = db.collection(COLLECTIONS.users)
      .onSnapshot(snapshot => {
        if (!component) return;
        const users = [];
        snapshot.forEach(doc => { users.push({ uid: doc.id, ...doc.data() }); });
        if (users.length) {
          component.setState({ users });
          console.log('[Sync] Users updated:', users.length);
        }
      }, err => console.warn('[Sync] Users listener error:', err.message));
    unsubscribers.push(unsub);
  }

  function listenBoxDrugs() {
    const unsub = db.collection(COLLECTIONS.boxDrugs)
      .onSnapshot(snapshot => {
        if (!component) return;
        const bd = {};
        snapshot.forEach(doc => { const d = doc.data(); if (d.boxId && d.drugs) bd[d.boxId] = d.drugs; });
        if (Object.keys(bd).length) {
          component.BOX_DRUGS = bd;
          component.setState({});
          console.log('[Sync] Box drugs updated:', Object.keys(bd).length, 'boxes');
        }
      }, err => console.warn('[Sync] BoxDrugs listener error:', err.message));
    unsubscribers.push(unsub);
  }

  function syncBoxes(box) {
    if (!db) return Promise.resolve();
    const { id, ...data } = box;
    return db.collection(COLLECTIONS.boxes).doc(id).set(data, { merge: true })
      .then(() => console.log('[Sync] Box saved:', id))
      .catch(err => console.error('[Sync] Box save failed:', err.message));
  }

  function logAudit(entry) {
    if (!db) return Promise.resolve();
    const data = { ...entry, createdAt: firebase.firestore.FieldValue.serverTimestamp() };
    return db.collection(COLLECTIONS.audit).add(data)
      .then(ref => console.log('[Sync] Audit logged:', ref.id))
      .catch(err => console.error('[Sync] Audit log failed:', err.message));
  }

  function syncUsers(user) {
    if (!db) return Promise.resolve();
    const { uid, ...data } = user;
    const docId = uid || db.collection(COLLECTIONS.users).doc().id;
    return db.collection(COLLECTIONS.users).doc(docId).set(data, { merge: true })
      .then(() => console.log('[Sync] User saved:', docId))
      .catch(err => console.error('[Sync] User save failed:', err.message));
  }

  function syncBoxDrugs(boxId, drugs) {
    if (!db) return Promise.resolve();
    return db.collection(COLLECTIONS.boxDrugs).doc(boxId).set({ boxId, drugs, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true })
      .then(() => console.log('[Sync] BoxDrugs saved:', boxId))
      .catch(err => console.error('[Sync] BoxDrugs save failed:', err.message));
  }

  window.EB_Sync = { initFirebaseSync, stopSync, syncBoxes, logAudit, syncUsers, syncBoxDrugs };
})();
