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
    emailEnabled: false,
    emailjsPublicKey: '',
    emailjsServiceId: '',
    emailjsTemplateId: '',
    recipientEmail: '',
    lineEnabled: false,
    lineWebhookUrl: '',
    browserEnabled: true,
  };

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
    } catch { return { ...DEFAULTS }; }
  }

  function saveSettings(s) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
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

  function getLastSent() {
    return localStorage.getItem(LAST_SENT_KEY) || '';
  }

  function setLastSent() {
    const today = new Date().toISOString().slice(0, 10);
    localStorage.setItem(LAST_SENT_KEY, today);
  }

  function alreadySentToday() {
    const today = new Date().toISOString().slice(0, 10);
    return getLastSent() === today;
  }

  function findExpiringDrugs(component, thresholdDays) {
    if (!component || !component.BOXES) return [];
    const bd = component.state.boxDrugs || component.buildBoxDrugs();
    const today = component.TODAY || new Date();
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
              dept: box.dept,
              drugName: drug.name,
              expiry: lot.expiry,
              daysLeft: daysLeft,
              lot: lot.lot || '',
              qty: lot.qty || 0,
              isHAD: drug.had || false,
              status: daysLeft <= 0 ? 'expired' : daysLeft <= 7 ? 'critical' : daysLeft <= 15 ? 'warning' : 'notice',
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
    const expired = alerts.filter(a => a.status === 'expired');
    const critical = alerts.filter(a => a.status === 'critical');
    const warning = alerts.filter(a => a.status === 'warning');
    const notice = alerts.filter(a => a.status === 'notice');

    let msg = '🏥 แจ้งเตือนยาใกล้หมดอายุ - Emergency Box\n';
    msg += `📅 วันที่: ${new Date().toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' })}\n`;
    msg += `📊 พบยาที่ต้องดำเนินการ ${alerts.length} รายการ\n\n`;

    if (expired.length) {
      msg += `🔴 หมดอายุแล้ว (${expired.length} รายการ):\n`;
      expired.forEach(a => {
        msg += `  • ${a.boxId} (${a.dept}) - ${a.drugName} [หมดอายุไปแล้ว ${Math.abs(a.daysLeft)} วัน]${a.isHAD ? ' ⚠️HAD' : ''}\n`;
      });
      msg += '\n';
    }
    if (critical.length) {
      msg += `🟠 วิกฤต ≤7 วัน (${critical.length} รายการ):\n`;
      critical.forEach(a => {
        msg += `  • ${a.boxId} (${a.dept}) - ${a.drugName} [เหลือ ${a.daysLeft} วัน]${a.isHAD ? ' ⚠️HAD' : ''}\n`;
      });
      msg += '\n';
    }
    if (warning.length) {
      msg += `🟡 ใกล้กำหนด ≤15 วัน (${warning.length} รายการ):\n`;
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

  function buildHtmlEmail(alerts) {
    if (!alerts.length) return null;
    const expired = alerts.filter(a => a.status === 'expired');
    const critical = alerts.filter(a => a.status === 'critical');
    const warning = alerts.filter(a => a.status === 'warning');

    let rows = '';
    alerts.slice(0, 30).forEach(a => {
      const color = a.status === 'expired' ? '#E03E3E' : a.status === 'critical' ? '#D9810F' : a.status === 'warning' ? '#EE8A2B' : '#1A6FA3';
      const label = a.status === 'expired' ? 'หมดอายุแล้ว' : a.status === 'critical' ? 'วิกฤต' : a.status === 'warning' ? 'ใกล้กำหนด' : 'เตือนล่วงหน้า';
      const days = a.daysLeft <= 0 ? `เกิน ${Math.abs(a.daysLeft)} วัน` : `เหลือ ${a.daysLeft} วัน`;
      rows += `<tr><td style="padding:8px;border-bottom:1px solid #eee">${a.boxId}</td><td style="padding:8px;border-bottom:1px solid #eee">${a.dept}</td><td style="padding:8px;border-bottom:1px solid #eee">${a.drugName}${a.isHAD ? ' <span style="color:#E03E3E;font-weight:600">HAD</span>' : ''}</td><td style="padding:8px;border-bottom:1px solid #eee;color:${color};font-weight:600">${label}</td><td style="padding:8px;border-bottom:1px solid #eee">${days}</td></tr>`;
    });

    return `
      <div style="font-family:'IBM Plex Sans Thai',sans-serif;max-width:700px;margin:0 auto">
        <div style="background:linear-gradient(135deg,#1A6FA3,#168C84);color:#fff;padding:24px 28px;border-radius:12px 12px 0 0">
          <h2 style="margin:0;font-size:20px">🏥 แจ้งเตือนยาใกล้หมดอายุ</h2>
          <p style="margin:6px 0 0;opacity:.85;font-size:14px">Emergency Box - รพ.กรงปินัง</p>
        </div>
        <div style="background:#fff;padding:20px 28px;border:1px solid #e0e0e0;border-top:0">
          <p style="color:#333;font-size:14px">พบยาที่ต้องดำเนินการ <strong>${alerts.length}</strong> รายการ
            ${expired.length ? `(หมดอายุแล้ว <span style="color:#E03E3E;font-weight:700">${expired.length}</span>)` : ''}
            ${critical.length ? `(วิกฤต <span style="color:#D9810F;font-weight:700">${critical.length}</span>)` : ''}
          </p>
          <table style="width:100%;border-collapse:collapse;font-size:13px;margin:12px 0">
            <tr style="background:#f5f7f9"><th style="padding:8px;text-align:left">กล่อง</th><th style="padding:8px;text-align:left">แผนก</th><th style="padding:8px;text-align:left">ชื่อยา</th><th style="padding:8px;text-align:left">สถานะ</th><th style="padding:8px;text-align:left">เวลา</th></tr>
            ${rows}
          </table>
          <p style="margin:16px 0 0"><a href="https://emergencyboxnotyfykpnhos.web.app" style="display:inline-block;background:#1A6FA3;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600">เปิดระบบ EB Notify</a></p>
        </div>
        <div style="background:#f9fafb;padding:12px 28px;border:1px solid #e0e0e0;border-top:0;border-radius:0 0 12px 12px;font-size:11px;color:#888">
          ส่งอัตโนมัติจากระบบ Emergency Box Notify — ฝ่ายเภสัชกรรม รพ.กรงปินัง
        </div>
      </div>`;
  }

  async function sendEmail(settings, alerts) {
    if (!settings.emailEnabled || !settings.emailjsPublicKey || !settings.emailjsServiceId || !settings.emailjsTemplateId) return false;
    if (typeof emailjs === 'undefined') { console.warn('[Notify] EmailJS SDK not loaded'); return false; }
    try {
      emailjs.init(settings.emailjsPublicKey);
      await emailjs.send(settings.emailjsServiceId, settings.emailjsTemplateId, {
        to_email: settings.recipientEmail,
        subject: `🏥 แจ้งเตือนยาใกล้หมดอายุ (${alerts.length} รายการ)`,
        message: buildAlertMessage(alerts),
        html_content: buildHtmlEmail(alerts),
      });
      console.log('[Notify] Email sent successfully');
      return true;
    } catch (err) {
      console.error('[Notify] Email failed:', err);
      return false;
    }
  }

  async function sendLINE(settings, alerts) {
    if (!settings.lineEnabled || !settings.lineWebhookUrl) return false;
    const msg = buildAlertMessage(alerts);
    if (!msg) return false;
    try {
      await fetch(settings.lineWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg }),
      });
      console.log('[Notify] LINE message sent');
      return true;
    } catch (err) {
      console.error('[Notify] LINE failed:', err);
      return false;
    }
  }

  function sendBrowserNotification(alerts) {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') {
      Notification.requestPermission();
      return;
    }
    const expired = alerts.filter(a => a.status === 'expired' || a.status === 'critical');
    if (!expired.length) return;
    new Notification('🏥 EB Notify - ยาใกล้หมดอายุ', {
      body: `พบยา ${expired.length} รายการ ต้องดำเนินการด่วน`,
      icon: './icons/icon-192.svg',
      tag: 'eb-expiry-alert',
    });
  }

  async function checkAndNotify(component, force) {
    const settings = loadSettings();
    if (!settings.enabled && !force) return { alerts: [], sent: false };

    const firestoreSettings = await loadFromFirestore();
    if (firestoreSettings) {
      Object.assign(settings, firestoreSettings);
      saveSettings(settings);
    }

    const alerts = findExpiringDrugs(component, settings.thresholdDays);
    if (!alerts.length) {
      console.log('[Notify] No expiring drugs found');
      return { alerts: [], sent: false };
    }

    console.log(`[Notify] Found ${alerts.length} expiring drugs`);

    if (settings.browserEnabled) {
      sendBrowserNotification(alerts);
    }

    if (!force && alreadySentToday()) {
      console.log('[Notify] Already sent today, skipping email/LINE');
      return { alerts, sent: false };
    }

    let sent = false;
    if (settings.emailEnabled) {
      sent = await sendEmail(settings, alerts) || sent;
    }
    if (settings.lineEnabled) {
      sent = await sendLINE(settings, alerts) || sent;
    }

    if (sent) {
      setLastSent();
      console.log('[Notify] Notifications sent successfully');
    }

    return { alerts, sent };
  }

  function requestBrowserPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  window.EB_Notify = {
    loadSettings,
    saveSettings,
    saveToFirestore,
    checkAndNotify,
    findExpiringDrugs,
    buildAlertMessage,
    requestBrowserPermission,
    sendEmail,
    sendLINE,
    DEFAULTS,
  };
})();
