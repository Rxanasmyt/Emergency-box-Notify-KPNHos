/**
 * Firebase Initialization - Emergency Box Notify
 * Uses Firebase v10 compat CDN (no build tools required)
 *
 * USAGE: Include these scripts in index.html before this file:
 *   <script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js"></script>
 *   <script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js"></script>
 *   <script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js"></script>
 *   <script src="firebase-init.js"></script>
 */

(function () {
  'use strict';

  // ── Firebase Configuration ────────────────────────────────
  // TODO: Replace with your actual Firebase project config
  const firebaseConfig = {
    apiKey: 'YOUR_API_KEY',
    authDomain: 'YOUR_PROJECT.firebaseapp.com',
    projectId: 'YOUR_PROJECT_ID',
    storageBucket: 'YOUR_PROJECT.firebasestorage.app',
    messagingSenderId: 'YOUR_SENDER_ID',
    appId: 'YOUR_APP_ID',
  };

  // ── Initialize Firebase ───────────────────────────────────
  if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
  }

  const app = firebase.app();
  const db = firebase.firestore();
  const auth = firebase.auth();

  // ── Enable Firestore offline persistence ──────────────────
  db.enablePersistence({ synchronizeTabs: true })
    .then(() => console.log('[Firebase] Firestore persistence enabled'))
    .catch(err => {
      if (err.code === 'failed-precondition') {
        console.warn('[Firebase] Persistence failed: multiple tabs open');
      } else if (err.code === 'unimplemented') {
        console.warn('[Firebase] Persistence not supported in this browser');
      } else {
        console.error('[Firebase] Persistence error:', err);
      }
    });

  // ── Export to global scope ────────────────────────────────
  window.EB_Firebase = { app, db, auth, config: firebaseConfig };
})();
