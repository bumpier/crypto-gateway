'use strict';

// Per-payment webhook URLs, so several shops can share one gateway. A caller
// may name where a payment's confirmation goes, but only an allowlisted URL is
// accepted: the gateway signs every webhook with WEBHOOK_SECRET, so an open
// choice of destination would hand signed payloads to anyone who asks.

/** WEBHOOK_URL plus each comma-separated WEBHOOK_URLS entry (trimmed, blanks dropped). */
function allowedWebhookUrls(webhookUrl, webhookUrls) {
  const extra = String(webhookUrls || '').split(',').map((s) => s.trim());
  return new Set([webhookUrl, ...extra].filter(Boolean));
}

/**
 * Validate a requested webhookUrl. Absent/empty → { ok: true, url: null } (use
 * the default WEBHOOK_URL). Exact allowlist match → { ok: true, url }.
 * Anything else → { ok: false }.
 */
function resolveWebhookUrl(requested, allowed) {
  if (requested === undefined || requested === null || requested === '') return { ok: true, url: null };
  if (typeof requested === 'string' && allowed.has(requested)) return { ok: true, url: requested };
  return { ok: false };
}

module.exports = { allowedWebhookUrls, resolveWebhookUrl };
