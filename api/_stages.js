// api/_stages.js
// Standardized post-purchase lifecycle stages (Days 0 to 8) for Takealot.
// Fully grounded in Africa/Johannesburg (SAST: UTC+2) dates.

'use strict';

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

const VISIONSPY_URL = 'https://visionspyads.com/api/public/v1/email/send';
const DEFAULT_VISIONSPY_KEY = 'vs_live_5623f17b36bdf353ba179aa6ed606e1935c6aa4ac4b1aea5';
const DEFAULT_SENDER_ID = 'd86d0b35-3472-4aac-af74-4bd52308ea07';

const STAGES = {
  0: {
    day: 0,
    status: 'PROCESSING',
    headerTitle: 'Order Confirmation',
    subject: (id) => `Order Confirmation #${id}`,
    preheader: (id, dLong) => `Thank you for your order #${id}. Delivery scheduled for ${dLong}.`,
    paragraphs: (order, dates) => [
      `Thank you for your purchase. We're pleased to confirm that payment for order <strong class="email-heading" style="color: #111827;">#${order.order_id}</strong> has been approved.`,
      `Your items are now being prepared for dispatch. Your estimated delivery date is <strong class="email-heading" style="color: #111827;">${dates.delivery_date_long}</strong>.`,
      `When your parcel is dispatched with the courier, you will receive an SMS notification with live delivery details.`
    ],
    plainTextBody: (order, dates) => [
      `Thank you for your purchase. We're pleased to confirm that payment for order #${order.order_id} has been approved.`,
      `Your items are now being prepared for dispatch. Your estimated delivery date is ${dates.delivery_date_long}.`,
      `When your parcel is dispatched with the courier, you will receive an SMS notification with live delivery details.`
    ]
  },
  1: {
    day: 1,
    status: 'PROCESSING',
    headerTitle: 'Packed & Ready',
    subject: (id) => `Order Update: #${id} is Packed & Ready for Dispatch 📦`,
    preheader: (id, dLong) => `Order #${id} has been packed at our fulfillment center and is ready for courier dispatch.`,
    paragraphs: (order, dates) => [
      `Your order <strong class="email-heading" style="color: #111827;">#${order.order_id}</strong> has been carefully inspected and packed at our distribution center.`,
      `It is now staged in our dispatch bay and scheduled for courier pickup.`,
      `Estimated delivery remains on track for <strong class="email-heading" style="color: #111827;">${dates.delivery_date_long}</strong>.`
    ],
    plainTextBody: (order, dates) => [
      `Your order #${order.order_id} has been carefully inspected and packed at our distribution center.`,
      `It is now staged in our dispatch bay and scheduled for courier pickup.`,
      `Estimated delivery remains on track for ${dates.delivery_date_long}.`
    ]
  },
  2: {
    day: 2,
    status: 'IN_TRANSIT',
    setShipped: true,
    headerTitle: 'Order Shipped',
    subject: (id) => `Your Order #${id} Has Shipped! 🚚`,
    preheader: (id, dLong) => `Great news! Order #${id} has shipped and is now on route with our courier.`,
    paragraphs: (order, dates) => [
      `Great news! Your order <strong class="email-heading" style="color: #111827;">#${order.order_id}</strong> has left our warehouse and is officially in transit with the courier.`,
      `The parcel is moving along the primary logistics corridor toward your region.`,
      `Your estimated delivery date is <strong class="email-heading" style="color: #111827;">${dates.delivery_date_long}</strong>.`
    ],
    plainTextBody: (order, dates) => [
      `Great news! Your order #${order.order_id} has left our warehouse and is officially in transit with the courier.`,
      `The parcel is moving along the primary logistics corridor toward your region.`,
      `Your estimated delivery date is ${dates.delivery_date_long}.`
    ]
  },
  3: {
    day: 3,
    status: 'IN_TRANSIT',
    headerTitle: 'In Transit',
    subject: (id) => `In Transit: Order #${id} is on Route to Regional Hub 🚛`,
    preheader: (id, dLong) => `Order #${id} is currently in transit on route to your regional distribution hub.`,
    paragraphs: (order, dates) => [
      `Order <strong class="email-heading" style="color: #111827;">#${order.order_id}</strong> is progressing smoothly along the inter-provincial freight network.`,
      `Our logistics fleet is transporting your parcel directly toward the regional sorting hub.`,
      `Everything is on schedule for delivery on <strong class="email-heading" style="color: #111827;">${dates.delivery_date_long}</strong>.`
    ],
    plainTextBody: (order, dates) => [
      `Order #${order.order_id} is progressing smoothly along the inter-provincial freight network.`,
      `Our logistics fleet is transporting your parcel directly toward the regional sorting hub.`,
      `Everything is on schedule for delivery on ${dates.delivery_date_long}.`
    ]
  },
  4: {
    day: 4,
    status: 'IN_TRANSIT',
    headerTitle: 'Regional Hub',
    subject: (id) => `Transit Update: Order #${id} Arrived at Regional Hub 🏢`,
    preheader: (id, dLong) => `Order #${id} has safely arrived at the regional distribution facility.`,
    paragraphs: (order, dates) => [
      `Your parcel for order <strong class="email-heading" style="color: #111827;">#${order.order_id}</strong> has arrived at the regional distribution hub.`,
      `It has been checked in and queued for regional scanning and sorting.`,
      `Estimated delivery date: <strong class="email-heading" style="color: #111827;">${dates.delivery_date_long}</strong>.`
    ],
    plainTextBody: (order, dates) => [
      `Your parcel for order #${order.order_id} has arrived at the regional distribution hub.`,
      `It has been checked in and queued for regional scanning and sorting.`,
      `Estimated delivery date: ${dates.delivery_date_long}.`
    ]
  },
  5: {
    day: 5,
    status: 'IN_TRANSIT',
    headerTitle: 'Sorting Cleared',
    subject: (id) => `Tracking Update: Order #${id} Cleared Sorting Facility 📋`,
    preheader: (id, dLong) => `Order #${id} has cleared sorting and is scheduled for local depot transfer.`,
    paragraphs: (order, dates) => [
      `Order <strong class="email-heading" style="color: #111827;">#${order.order_id}</strong> has completed automated barcode sorting and facility security clearance.`,
      `Your parcel is now loaded onto the final transport feeder heading to your nearest local delivery depot.`,
      `Delivery is confirmed for <strong class="email-heading" style="color: #111827;">${dates.delivery_date_long}</strong>.`
    ],
    plainTextBody: (order, dates) => [
      `Order #${order.order_id} has completed automated barcode sorting and facility security clearance.`,
      `Your parcel is now loaded onto the final transport feeder heading to your nearest local delivery depot.`,
      `Delivery is confirmed for ${dates.delivery_date_long}.`
    ]
  },
  6: {
    day: 6,
    status: 'IN_TRANSIT',
    headerTitle: 'Local Depôt',
    subject: (id) => `Almost There: Order #${id} Arrived at Local Depôt 📍`,
    preheader: (id, dLong) => `Order #${id} has arrived at the local delivery depot closest to your address.`,
    paragraphs: (order, dates) => [
      `We're almost there! Order <strong class="email-heading" style="color: #111827;">#${order.order_id}</strong> has arrived at your local Takealot delivery depôt.`,
      `Our local dispatch team is assigning your parcel to your delivery route and driver.`,
      `Scheduled delivery date: <strong class="email-heading" style="color: #111827;">${dates.delivery_date_long}</strong>.`
    ],
    plainTextBody: (order, dates) => [
      `We're almost there! Order #${order.order_id} has arrived at your local Takealot delivery depôt.`,
      `Our local dispatch team is assigning your parcel to your delivery route and driver.`,
      `Scheduled delivery date: ${dates.delivery_date_long}.`
    ]
  },
  7: {
    day: 7,
    status: 'OUT_FOR_DELIVERY',
    headerTitle: 'Delivery Tomorrow',
    subject: (id) => `Scheduled for Tomorrow: Order #${id} ⏰`,
    preheader: (id, dLong) => `Your Takealot order #${id} is scheduled for delivery tomorrow!`,
    paragraphs: (order, dates) => [
      `Get ready! Your order <strong class="email-heading" style="color: #111827;">#${order.order_id}</strong> is scheduled for delivery tomorrow, <strong class="email-heading" style="color: #111827;">${dates.delivery_date_long}</strong>.`,
      `Our courier driver will be in your area between 08:00 and 17:00. Please ensure someone is available at your delivery address to receive the parcel.`,
      `You will receive an SMS when the driver begins your neighborhood route.`
    ],
    plainTextBody: (order, dates) => [
      `Get ready! Your order #${order.order_id} is scheduled for delivery tomorrow, ${dates.delivery_date_long}.`,
      `Our courier driver will be in your area between 08:00 and 17:00. Please ensure someone is available at your delivery address to receive the parcel.`,
      `You will receive an SMS when the driver begins your neighborhood route.`
    ]
  },
  8: {
    day: 8,
    status: 'DELIVERED',
    setDelivered: true,
    headerTitle: 'Order Delivered',
    subject: (id) => `Delivered: Your Order #${id} 📦`,
    preheader: (id, dLong) => `Your order #${id} has been delivered. Thank you for shopping with Takealot!`,
    paragraphs: (order, dates) => [
      `Your order <strong class="email-heading" style="color: #111827;">#${order.order_id}</strong> has been successfully delivered!`,
      `We hope you enjoy your new <strong class="email-heading" style="color: #111827;">Hisense 263L Bottom Freezer Fridge</strong>.`,
      `If you have any questions or need support, our Customer Care team is always available to help.`
    ],
    plainTextBody: (order, dates) => [
      `Your order #${order.order_id} has been successfully delivered!`,
      `We hope you enjoy your new Hisense 263L Bottom Freezer Fridge.`,
      `If you have any questions or need support, our Customer Care team is always available to help.`
    ]
  }
};

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

function renderStageHtml(order, stage) {
  const dates = computeOrderDates(order.received_date, order.delivery_date);
  const template = loadEmailTemplate();
  if (!template) {
    throw new Error('Email template (email.index) not found');
  }

  const subject = stage.subject(order.order_id);
  const headerTitle = stage.headerTitle;
  const preheader = stage.preheader(order.order_id, dates.delivery_date_long);
  const paragraphsList = stage.paragraphs(order, dates);

  const paragraphsHtml = paragraphsList.map((p, idx) => {
    const marginBottom = (idx === paragraphsList.length - 1) ? '24px' : '16px';
    return `              <p class="email-text" style="margin: 0 0 ${marginBottom} 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">\n                ${p}\n              </p>`;
  }).join('\n');

  return template
    .replace(/\{\{customer_name\}\}/g, order.customer_name || 'Customer')
    .replace(/\{\{order_number\}\}/g, order.order_id)
    .replace(/\{\{order_date\}\}/g, dates.order_date_formatted)
    .replace(/\{\{delivery_date\}\}/g, dates.delivery_date_iso)
    .replace(/\{\{delivery_date_long\}\}/g, dates.delivery_date_long)
    .replace(/\{\{variant\}\}/g, 'Black Glass')
    .replace(/\{\{email_title\}\}/g, subject)
    .replace(/\{\{email_preheader\}\}/g, preheader)
    .replace(/\{\{header_title\}\}/g, headerTitle)
    .replace(/\{\{email_paragraphs\}\}/g, paragraphsHtml);
}

function renderStagePlainText(order, stage) {
  const dates = computeOrderDates(order.received_date, order.delivery_date);
  const customerName = order.customer_name || 'Customer';
  const orderNumber = order.order_id;
  const trackUrl = order.tracking_url || `https://takeasealotsa.vercel.app/track.html?order=${orderNumber}`;
  const paragraphs = stage.plainTextBody(order, dates);

  return [
    `TAKEALOT ORDER UPDATE - ${stage.headerTitle.toUpperCase()}`,
    `Order Number: ${orderNumber}`,
    `Estimated Delivery Date: ${dates.delivery_date_long}`,
    `Status: ${stage.status}`,
    ``,
    `Hi ${customerName},`,
    ``,
    ...paragraphs.map(p => p + '\n'),
    `MANAGE YOUR ORDER:`,
    `${trackUrl}`,
    ``,
    `ORDER DETAILS:`,
    `- Order Date: ${dates.order_date_formatted}`,
    `- Estimated Delivery Date: ${dates.delivery_date_long}`,
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
    `This is an automated transactional order notification.`,
    `To manage your communication preferences or unsubscribe: https://takeasealotsa.vercel.app`,
  ].join('\n');
}

async function sendVisionSpyEmail({ to, subject, html, text }) {
  const apiKey = (process.env.VISIONSPY_API_KEY
    || process.env.VISION_SPY_API_KEY
    || process.env.VISIONSPY_KEY
    || DEFAULT_VISIONSPY_KEY).trim();
  const senderId = (process.env.VISIONSPY_SENDER_ID || DEFAULT_SENDER_ID).trim();

  const res = await fetch(VISIONSPY_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Takealot-Order-Notification/1.0',
    },
    body: JSON.stringify({
      sender_id: senderId,
      to,
      subject,
      html,
      text,
    }),
  });

  const data = await res.json().catch(() => null);
  const isOk = res.ok && data && (data.ok !== false && data.success !== false);
  return {
    ok: isOk,
    status: res.status,
    data,
    id: (data && data.id) || null,
  };
}

module.exports = {
  STAGES,
  loadEmailTemplate,
  renderStageHtml,
  renderStagePlainText,
  sendVisionSpyEmail,
};
