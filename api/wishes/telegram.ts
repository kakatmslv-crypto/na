import type { IncomingMessage, ServerResponse } from 'node:http';

const ALLOWED_STATUSES = new Set(['attending', 'wishing']);
const ALLOWED_SIDES = new Set(['groom', 'bride', 'both']);
const MAX_BODY_BYTES = 16 * 1024;

interface VercelRequest extends IncomingMessage {
  body?: unknown;
}

function cleanText(value: unknown, maxLen: number): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLen);
}

function formatSideLabel(side: string): string {
  if (side === 'groom') return 'ខាងប្រុស (Groom Side)';
  if (side === 'bride') return 'ខាងស្រី (Bride Side)';
  return 'ទាំងសងខាង (Both Families)';
}

function sendJson(res: ServerResponse, statusCode: number, payload: Record<string, unknown>) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: VercelRequest): Promise<Record<string, unknown> | null> {
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    return req.body as Record<string, unknown>;
  }
  if (typeof req.body === 'string') {
    if (Buffer.byteLength(req.body, 'utf8') > MAX_BODY_BYTES) {
      throw new Error('payload_too_large');
    }
    const parsed = JSON.parse(req.body);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buf.length;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new Error('payload_too_large');
    }
    chunks.push(buf);
  }

  if (chunks.length === 0) return null;
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

export default async function handler(req: VercelRequest, res: ServerResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
    return;
  }

  let body: Record<string, unknown> | null = null;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err instanceof Error && err.message === 'payload_too_large') {
      sendJson(res, 413, { ok: false, error: 'payload_too_large' });
      return;
    }
    sendJson(res, 400, { ok: false, error: 'invalid_payload' });
    return;
  }

  if (!body) {
    sendJson(res, 400, { ok: false, error: 'invalid_payload' });
    return;
  }

  const name = cleanText(body.name, 120);
  const message = cleanText(body.message, 1000);
  const coupleLabel = cleanText(body.coupleLabel, 150);
  const rawStatus = typeof body.status === 'string' ? body.status : '';
  const rawSide = typeof body.side === 'string' ? body.side : 'both';

  if (!name || !message || !ALLOWED_STATUSES.has(rawStatus) || !ALLOWED_SIDES.has(rawSide)) {
    sendJson(res, 400, { ok: false, error: 'validation_failed' });
    return;
  }

  const parsedCount = Number(body.guestCount);
  const guestCount =
    rawStatus === 'attending' && Number.isFinite(parsedCount)
      ? Math.min(50, Math.max(1, Math.round(parsedCount)))
      : 0;

  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim() || '';
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim() || '';

  if (!botToken || !chatId) {
    sendJson(res, 200, { ok: true, delivered: false, reason: 'not_configured' });
    return;
  }

  const attendanceText =
    rawStatus === 'attending' ? `នឹងចូលរួម (${guestCount} នាក់)` : 'ផ្ញើពាក្យជូនពរ';

  const lines = [
    '💐 ពាក្យជូនពរ និងការបញ្ជាក់វត្តមានថ្មី',
    coupleLabel ? `💍 ពិធីភ្ជាប់ពាក្យ៖ ${coupleLabel}` : '💍 ពិធីភ្ជាប់ពាក្យ',
    '',
    `👤 ឈ្មោះភ្ញៀវ៖ ${name}`,
    `🎊 ការចូលរួម៖ ${attendanceText}`,
    `🏡 ភ្ញៀវខាង៖ ${formatSideLabel(rawSide)}`,
    `💌 ពាក្យជូនពរ៖\n${message}`,
  ];

  try {
    const endpoint = `https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendMessage`;
    const tgResponse = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: lines.join('\n'),
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!tgResponse.ok) {
      sendJson(res, 502, { ok: false, delivered: false, error: 'telegram_delivery_failed' });
      return;
    }

    sendJson(res, 200, { ok: true, delivered: true });
  } catch {
    sendJson(res, 502, { ok: false, delivered: false, error: 'telegram_delivery_failed' });
  }
}
