// api/cron.js
// Automated daily email dispatch for Takealot tracking & post-purchase lifecycle (Days 0 to 8).
// Executable via Vercel Cron (scheduled daily at 08:00 UTC / 10:00 SAST)
// or manually via GET /api/cron (?force=1 to bypass same-day idempotency; ?order=T... for single order).
//
// Required env vars:
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN
//   VISIONSPY_API_KEY (optional, fallback provided)
//   VISIONSPY_SENDER_ID (optional, fallback provided)

'use strict';

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_KV_REST_API_URL
  || process.env.UPSTASH_REDIS_REST_URL
  || process.env.KV_REST_API_URL
  || process.env.UPSTASH_REDIS_REST_KV_URL
  || process.env.REDIS_REST_URL
  || process.env.UPSTASH_URL
  || 'https://major-oriole-190689.upstash.io';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN
  || process.env.UPSTASH_REDIS_REST_TOKEN
  || process.env.KV_REST_API_TOKEN
  || process.env.REDIS_REST_TOKEN
  || process.env.UPSTASH_TOKEN
  || 'gQAAAAAAAujhAAIgcDE1YmEzYTI1OWViYzU0YzVhYjA2NTFiZmNjZTc1ZTJiNw';



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
    console.warn('[cron] Redis get error:', err.message);
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
    console.warn('[cron] Redis set error:', err.message);
    return false;
  }
}

async function getAllOrderKeys() {
  if (!REDIS_URL || !REDIS_TOKEN) return [];
  try {
    const res = await fetch(REDIS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(['KEYS', 'takealot:order:*']),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.result) ? data.result : [];
  } catch (err) {
    console.error('[cron] Redis KEYS error:', err.message);
    return [];
  }
}

/**
 * Process a single order through the 8-day lifecycle.
 * @param {Object} order - Full order object from Redis.
 * @param {boolean} force - Whether to bypass same-day idempotency.
 * @param {string} todayIso - Current date in YYYY-MM-DD (Africa/Johannesburg).
 * @returns {Promise<Object>} Process result.
 */
async function processOrderDailyEmail(order, force = false, todayIso = null) {
  if (!order || !order.order_id) {
    return { order_id: null, status: 'INVALID_ORDER', skipped: true };
  }

  const orderId = order.order_id;
  const customerEmail = (order.customer_email || '').trim();
  if (!customerEmail || !customerEmail.includes('@')) {
    return { order_id: orderId, status: 'NO_EMAIL', skipped: true };
  }

  const now = new Date();
  if (!todayIso) {
    todayIso = getSADateIso(now);
  }

  // 1. Blindagem de Datas: Garantir delivery_date sem nunca sobrescrever received_date
  const purchaseDate = order.received_date || order.created_at || now.toISOString();
  if (!order.received_date) {
    order.received_date = purchaseDate;
  }
  if (!order.delivery_date) {
    order.delivery_date = new Date(new Date(purchaseDate).getTime() + 8 * 86400000).toISOString();
  }

  // 2. Cálculo de dias decorridos no fuso África do Sul (Africa/Johannesburg)
  const daysElapsed = calculateSADaysElapsed(order.received_date, now);

  // 3. Verificações de Estágio e Idempotência
  // Dia 0: Compra recém-realizada. O e-mail imediato de confirmação já é disparado na compra.
  if (daysElapsed <= 0 && !force) {
    return {
      order_id: orderId,
      email: customerEmail,
      days_elapsed: daysElapsed,
      status: 'SKIPPED_DAY_ZERO',
      message: 'Day 0 payment confirmation is handled immediately upon purchase',
      skipped: true,
    };
  }

  // Dia 9+: Pedido já entregue e ciclo concluído
  if (daysElapsed > 8 || (daysElapsed >= 8 && order.status === 'DELIVERED' && order.email_delivered_status === 'SENT')) {
    if (!force) {
      return {
        order_id: orderId,
        email: customerEmail,
        days_elapsed: daysElapsed,
        status: 'ALREADY_DELIVERED',
        message: 'Order delivery cycle completed',
        skipped: true,
      };
    }
  }

  // Idempotência: 1 e-mail por dia por pedido (last_daily_email_date = hoje)
  if (!force && order.last_daily_email_date === todayIso) {
    return {
      order_id: orderId,
      email: customerEmail,
      days_elapsed: daysElapsed,
      status: 'ALREADY_SENT_TODAY',
      last_daily_email_date: order.last_daily_email_date,
      skipped: true,
    };
  }

  // Determinar o estágio correspondente (dias 1 a 8)
  const targetDay = Math.min(Math.max(daysElapsed, 1), 8);
  const stage = STAGES[targetDay];
  if (!stage) {
    return {
      order_id: orderId,
      days_elapsed: daysElapsed,
      status: 'UNKNOWN_STAGE',
      skipped: true,
    };
  }

  const subject = stage.subject(orderId);
  const html = renderStageHtml(order, stage);
  const plainText = renderStagePlainText(order, stage);

  // 4. Disparo via VisionSpy API
  const sendRes = await sendVisionSpyEmail({
    to: customerEmail,
    subject,
    html,
    text: plainText,
  });

  if (!sendRes.ok) {
    console.warn('[cron] VisionSpy send failed for', orderId, sendRes.data);
    return {
      order_id: orderId,
      email: customerEmail,
      days_elapsed: targetDay,
      status: 'SEND_FAILED',
      http_status: sendRes.status,
      error: sendRes.data,
      skipped: false,
    };
  }

  // 5. Atualização atômica do pedido após sucesso
  const nowIso = now.toISOString();
  order.last_daily_email_date = todayIso;
  order.status = stage.status;
  if (stage.setShipped) {
    order.email_shipped_status = 'SENT';
  }
  if (stage.setDelivered) {
    order.email_delivered_status = 'SENT';
  }

  // Histórico de disparos diários
  if (!Array.isArray(order.daily_emails_sent)) {
    order.daily_emails_sent = [];
  }
  order.daily_emails_sent.push({
    day: targetDay,
    stage: stage.headerTitle,
    subject,
    date_sast: todayIso,
    sent_at: nowIso,
    message_id: sendRes.id,
    provider: 'VISIONSPY',
  });

  // Histórico de status
  if (!Array.isArray(order.status_history)) {
    order.status_history = [];
  }
  if (!order.status_history.some(h => h.status === stage.status && h.day === targetDay)) {
    order.status_history.push({
      status: stage.status,
      day: targetDay,
      timestamp: nowIso,
    });
  }

  await kv_set('takealot:order:' + orderId, order);

  console.log(`[cron] Sent Day ${targetDay} email to ${customerEmail} for order #${orderId}`);
  return {
    order_id: orderId,
    email: customerEmail,
    days_elapsed: targetDay,
    status: 'SENT',
    stage: stage.headerTitle,
    subject,
    message_id: sendRes.id,
    skipped: false,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const force = req.query.force === '1' || req.query.force === 'true';
  const specificOrderId = (req.query.order || req.query.order_id || req.query.id || '').trim();
  const now = new Date();
  const todayIso = getSADateIso(now);
  const nowSastFormatted = formatSADateLong(now) + ' (SAST UTC+2)';

  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(503).json({
      error: 'Upstash Redis configuration missing (UPSTASH_REDIS_REST_URL/TOKEN)',
      today_sast: todayIso,
    });
  }

  try {
    let orderKeys = [];
    if (specificOrderId) {
      orderKeys = ['takealot:order:' + specificOrderId];
    } else {
      orderKeys = await getAllOrderKeys();
    }

    if (orderKeys.length === 0) {
      return res.status(200).json({
        ok: true,
        message: 'No orders found to process',
        today_sast: todayIso,
        now_sast: nowSastFormatted,
        processed_count: 0,
        sent_count: 0,
        skipped_count: 0,
        results: [],
      });
    }

    const results = [];
    let sentCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const key of orderKeys) {
      const order = await kv_get(key);
      if (!order) continue;

      const result = await processOrderDailyEmail(order, force, todayIso);
      results.push(result);

      if (result.status === 'SENT') {
        sentCount++;
      } else if (result.status === 'SEND_FAILED') {
        failedCount++;
      } else {
        skippedCount++;
      }
    }

    return res.status(200).json({
      ok: true,
      today_sast: todayIso,
      now_sast: nowSastFormatted,
      force,
      processed_count: results.length,
      sent_count: sentCount,
      skipped_count: skippedCount,
      failed_count: failedCount,
      results,
    });
  } catch (err) {
    console.error('[cron] Unhandled error:', err);
    return res.status(500).json({
      ok: false,
      error: err.message,
      today_sast: todayIso,
    });
  }
};

module.exports.processOrderDailyEmail = processOrderDailyEmail;
