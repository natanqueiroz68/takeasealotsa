// api/_dates.js
// Standardized South African (Africa/Johannesburg, UTC+2) date handling for Takealot.
// Guarantees:
// 1. Order Date is strictly based on Africa/Johannesburg timezone (SAST: UTC+2).
// 2. Estimated Delivery Date = Order Date + exactly 8 calendar days.
// 3. Immutability: Once computed and stored, dates never change.
// 4. Standard formats:
//    - Short with weekday: "Tue, 10 Nov 2026"
//    - Short Upper: "2 NOV 2026"
//    - Long: "Tuesday, 10 November 2026"

'use strict';

function parseDateInput(d) {
  if (d instanceof Date && !isNaN(d.getTime())) return d;
  if (typeof d === 'string' || typeof d === 'number') {
    const parsed = new Date(d);
    if (!isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

function formatSADateShort(d) {
  const dateObj = parseDateInput(d);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Johannesburg',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(dateObj);
}

function formatSADateUpper(d) {
  const dateObj = parseDateInput(d);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Johannesburg',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(dateObj).toUpperCase();
}

function formatSADateLong(d) {
  const dateObj = parseDateInput(d);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Johannesburg',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(dateObj);
}

function formatSAIsoDate(d) {
  const dateObj = parseDateInput(d);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Johannesburg',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(dateObj);
}

function getSADateIso(dateInput) {
  if (!dateInput) return null;
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Johannesburg',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
}

function calculateSADaysElapsed(receivedDateInput, nowInput = new Date()) {
  const pIso = getSADateIso(receivedDateInput);
  const nowIso = getSADateIso(nowInput);
  if (!pIso || !nowIso) return 0;
  const [py, pm, pd] = pIso.split('-').map(Number);
  const [ny, nm, nd] = nowIso.split('-').map(Number);
  return Math.floor((Date.UTC(ny, nm - 1, nd) - Date.UTC(py, pm - 1, pd)) / 86400000);
}

function computeOrderDates(orderDateInput, existingDeliveryDate) {
  const receivedDate = parseDateInput(orderDateInput);
  const receivedIso = receivedDate.toISOString();

  let deliveryDate;
  if (existingDeliveryDate) {
    const rawDelivery = new Date(existingDeliveryDate);
    if (!isNaN(rawDelivery.getTime())) {
      deliveryDate = rawDelivery;
    }
  }
  if (!deliveryDate) {
    deliveryDate = new Date(receivedDate.getTime() + 8 * 86400000);
  }
  const deliveryIso = deliveryDate.toISOString();

  return {
    received_date: receivedIso,
    delivery_date: deliveryIso,
    order_date_upper: formatSADateUpper(receivedDate),
    order_date_formatted: formatSADateShort(receivedDate),
    delivery_date_formatted: formatSADateShort(deliveryDate),
    delivery_date_long: formatSADateLong(deliveryDate),
    delivery_date_iso: formatSAIsoDate(deliveryDate),
  };
}

module.exports = {
  formatSADateShort,
  formatSADateUpper,
  formatSADateLong,
  formatSAIsoDate,
  getSADateIso,
  calculateSADaysElapsed,
  computeOrderDates,
};

