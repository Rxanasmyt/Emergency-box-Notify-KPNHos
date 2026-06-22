/**
 * Drug Expiry Notification System - Emergency Box Notify
 * Sends alerts via Email (EmailJS), LINE (Webhook), and Browser Notifications.
 *
 * Depends on: firebase-init.js (window.EB_Firebase)
 * Include after firebase-sync.js:
 *   <script src="https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js"></script>
 *   <script src="./notify.js"></script>
 */

(function () {
  'use strict';

  const SETTINGS_KEY = 'eb_notify_settings';
  const LAST_SENT_KEY = 'eb_notify_last_sent';

  const DEFAULTS = {
    enabled: true,
    thresholdDays: 30,
    lineEnabled: false,
    lineWebhookUrl: '',
  };

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
    } catch { return { ...DEFAULTS }; }
  }

  function saveSettings(s) {
    const { githubPAT, ...rest } = s;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(rest));
  }

  function loadFromFirestore() {
    if (!window.EB_Firebase || !window.EB_Firebase.db) return Promise.resolve(null);
    return window.EB_Firebase.db.collection('app_settings').doc('notifications').get()
      .then(doc => doc.exists ? doc.data() : null)
      .catch(() => null);
  }

  function saveToFirestore(s) {
    if (!window.EB_Firebase || !window.EB_Firebase.db) return Promise.resolve();
    return window.EB_Firebase.db.collection('app_settings').doc('notifications')
      .set(s, { merge: true }).catch(() => {});
  }

  function todayBangkok() {
    const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function getLastSent() {
    return localStorage.getItem(LAST_SENT_KEY) || '';
  }

  function setLastSent() {
    localStorage.setItem(LAST_SENT_KEY, todayBangkok());
  }

  function alreadySentToday() {
    return getLastSent() === todayBangkok();
  }

  function findExpiringDrugs(component, thresholdDays) {
    if (!component || !component.BOXES) return [];
    const bd = component.BOX_DRUGS || component.state.boxDrugs || {};
    const today = new Date(todayBangkok() + 'T00:00:00');
    const alerts = [];

    component.BOXES.forEach(box => {
      const drugs = bd[box.id] || [];
      drugs.forEach(drug => {
        const lots = drug.lots || [];
        lots.forEach(lot => {
          if (!lot.expiry) return;
          const expDate = new Date(lot.expiry + 'T00:00:00');
          const daysLeft = Math.round((expDate - today) / 86400000);
          if (daysLeft <= thresholdDays) {
            alerts.push({
              boxId: box.id,
              dept: box.dept || '—',
              drugName: drug.name,
              expiry: lot.expiry,
              daysLeft: daysLeft,
              lot: lot.lot || '',
              qty: lot.qty || 0,
              isHAD: drug.had || false,
              status: daysLeft < 0 ? 'expired' : daysLeft === 0 ? 'expired_today' : daysLeft <= 15 ? 'critical' : daysLeft <= 30 ? 'warning' : 'notice',
            });
          }
        });
      });
    });

    alerts.sort((a, b) => a.daysLeft - b.daysLeft);
    return alerts;
  }

  function buildAlertMessage(alerts) {
    if (!alerts.length) return null;
    const expired = alerts.filter(a => a.status === 'expired' || a.status === 'expired_today');
    const critical = alerts.filter(a => a.status === 'critical');
    const warning = alerts.filter(a => a.status === 'warning');
    const notice = alerts.filter(a => a.status === 'notice');

    let msg = '🏥 แจ้งเตือนยาใกล้หมดอายุ - Emergency Box\n';
    msg += `📅 วันที่: ${new Date().toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' })}\n`;
    msg += `📊 พบยาที่ต้องดำเนินการ ${alerts.length} รายการ\n\n`;

    if (expired.length) {
      msg += `🔴 หมดอายุแล้ว (${expired.length} รายการ):\n`;
      expired.forEach(a => {
        const expLabel = a.daysLeft === 0 ? 'หมดอายุวันนี้' : `หมดอายุไปแล้ว ${Math.abs(a.daysLeft)} วัน`;
        msg += `  • ${a.boxId} (${a.dept}) - ${a.drugName} [${expLabel}]${a.isHAD ? ' ⚠️HAD' : ''}\n`;
      });
      msg += '\n';
    }
    if (critical.length) {
      msg += `🟠 วิกฤต ≤15 วัน (${critical.length} รายการ):\n`;
      critical.forEach(a => {
        msg += `  • ${a.boxId} (${a.dept}) - ${a.drugName} [เหลือ ${a.daysLeft} วัน]${a.isHAD ? ' ⚠️HAD' : ''}\n`;
      });
      msg += '\n';
    }
    if (warning.length) {
      msg += `🟡 ใกล้กำหนด ≤30 วัน (${warning.length} รายการ):\n`;
      warning.forEach(a => {
        msg += `  • ${a.boxId} (${a.dept}) - ${a.drugName} [เหลือ ${a.daysLeft} วัน]\n`;
      });
      msg += '\n';
    }
    if (notice.length) {
      msg += `🔵 เตือนล่วงหน้า (${notice.length} รายการ):\n`;
      notice.slice(0, 10).forEach(a => {
        msg += `  • ${a.boxId} (${a.dept}) - ${a.drugName} [เหลือ ${a.daysLeft} วัน]\n`;
      });
      if (notice.length > 10) msg += `  ... อีก ${notice.length - 10} รายการ\n`;
    }

    msg += '\n🔗 ตรวจสอบที่: https://emergencyboxnotyfykpnhos.web.app';
    return msg;
  }

  async function sendLINE(settings, alerts) {
    if (!settings.lineEnabled || !settings.lineWebhookUrl) return false;
    const msg = buildAlertMessage(alerts);
    if (!msg) return false;
    try {
      const res = await fetch(settings.lineWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'message=' + encodeURIComponent(msg),
      });
      if (!res.ok) {
        console.error('[Notify] LINE error:', res.status, await res.text().catch(() => ''));
        return false;
      }
      console.log('[Notify] LINE message sent');
      return true;
    } catch (err) {
      console.error('[Notify] LINE failed:', err);
      return false;
    }
  }


  async function checkAndNotify(component, force) {
    const settings = loadSettings();
    if (!settings.enabled && !force) return { alerts: [], sent: false };

    const firestoreSettings = await loadFromFirestore();
    if (firestoreSettings) {
      Object.assign(settings, firestoreSettings);
      saveSettings(settings);
      if (!settings.enabled && !force) return { alerts: [], sent: false };
    }

    const alerts = findExpiringDrugs(component, settings.thresholdDays);
    if (!alerts.length) {
      console.log('[Notify] No expiring drugs found');
      return { alerts: [], sent: false };
    }

    console.log(`[Notify] Found ${alerts.length} expiring drugs`);

    if (!force) {
      // check both localStorage (this browser) and Firestore lastSentDate (set by GH Actions cron)
      const fsLastSent = firestoreSettings && firestoreSettings.lastSentDate ? firestoreSettings.lastSentDate : '';
      if (alreadySentToday() || fsLastSent === todayBangkok()) {
        console.log('[Notify] Already sent today, skipping LINE');
        return { alerts, sent: false };
      }
    }

    let sent = false;
    if (settings.lineEnabled) {
      sent = await sendLINE(settings, alerts) || sent;
    }

    if (sent) {
      setLastSent();
      console.log('[Notify] Notifications sent successfully');
    }

    return { alerts, sent };
  }


  function loadGithubPAT() {
    return loadFromFirestore().then(fs => (fs && fs.githubPAT) || '').catch(() => '');
  }

  window.EB_Notify = {
    loadSettings,
    saveSettings,
    saveToFirestore,
    checkAndNotify,
    findExpiringDrugs,
    buildAlertMessage,
    sendLINE,
    loadGithubPAT,
    DEFAULTS,
  };
})();
