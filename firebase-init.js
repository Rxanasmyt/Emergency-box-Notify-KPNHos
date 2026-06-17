/**
 * Firebase Initialization - Emergency Box Notify
 * Uses Firebase v10 compat CDN (no build tools required)
 */

(function () {
  'use strict';

  const firebaseConfig = {
    apiKey: 'AIzaSyCTIEdwRCwQsrh61dY87dvcPwtK5q_isqU',
    authDomain: 'emergencyboxnotyfykpnhos.firebaseapp.com',
    projectId: 'emergencyboxnotyfykpnhos',
    storageBucket: 'emergencyboxnotyfykpnhos.firebasestorage.app',
    messagingSenderId: '825126916',
    appId: '1:825126916:web:0de8d3c1454a15990bc551',
    measurementId: 'G-3PF2DHD1VB',
  };

  if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
  }

  const app = firebase.app();
  const db = firebase.firestore();
  const auth = firebase.auth();

  db.enablePersistence({ synchronizeTabs: true })
    .then(() => console.log('[Firebase] Firestore persistence enabled'))
    .catch(err => {
      if (err.code === 'failed-precondition') console.warn('[Firebase] Persistence failed: multiple tabs open');
      else if (err.code === 'unimplemented') console.warn('[Firebase] Persistence not supported in this browser');
      else console.error('[Firebase] Persistence error:', err);
    });

  window.EB_Firebase = { app, db, auth, config: firebaseConfig };
})();
