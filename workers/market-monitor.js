const SYMBOL = 'QQQM';
const SUBSCRIPTIONS_KEY = 'push_subscriptions';
const ALERT_STATE_KEY = 'server_alert_state';
const MONITOR_STATUS_KEY = 'server_monitor_status';
const CHECK_INTERVAL_NOTICE = 'Cloudflare Cron should run this worker every 1 minute.';
const CALENDAR_MAX_YEAR = 2028;
const MARKET_HOLIDAYS = new Set([
    '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
    '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
    '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
    '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
    '2028-01-17', '2028-02-21', '2028-04-14', '2028-05-29', '2028-06-19',
    '2028-07-04', '2028-09-04', '2028-11-23', '2028-12-25'
]);
const EARLY_CLOSE_DATES = new Set([
    '2026-07-02', '2026-11-27', '2026-12-24',
    '2027-07-02', '2027-11-26',
    '2028-07-03', '2028-11-24'
]);
const encoder = new TextEncoder();

function base64UrlToBytes(value) {
    const padding = '='.repeat((4 - value.length % 4) % 4);
    const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64);
    return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function bytesToBase64Url(bytes) {
    let binary = '';
    bytes.forEach(byte => {
        binary += String.fromCharCode(byte);
    });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function concatBytes(...arrays) {
    const length = arrays.reduce((sum, array) => sum + array.length, 0);
    const result = new Uint8Array(length);
    let offset = 0;
    arrays.forEach(array => {
        result.set(array, offset);
        offset += array.length;
    });
    return result;
}

async function hmac(keyBytes, dataBytes) {
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, dataBytes));
}

async function hkdfExpand(prk, info, length) {
    const infoBytes = typeof info === 'string' ? encoder.encode(info) : info;
    const blocks = [];
    let previous = new Uint8Array(0);
    let outputLength = 0;
    let counter = 1;

    while (outputLength < length) {
        previous = await hmac(prk, concatBytes(previous, infoBytes, new Uint8Array([counter])));
        blocks.push(previous);
        outputLength += previous.length;
        counter += 1;
    }

    return concatBytes(...blocks).slice(0, length);
}

async function importP256PublicKey(rawPublicKey) {
    return crypto.subtle.importKey(
        'raw',
        rawPublicKey,
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        []
    );
}

async function createVapidJwt(endpoint, env) {
    const publicKeyBytes = base64UrlToBytes(env.VAPID_PUBLIC_KEY);
    const x = bytesToBase64Url(publicKeyBytes.slice(1, 33));
    const y = bytesToBase64Url(publicKeyBytes.slice(33, 65));
    const privateJwk = {
        kty: 'EC',
        crv: 'P-256',
        x,
        y,
        d: env.VAPID_PRIVATE_KEY,
        ext: true
    };
    const key = await crypto.subtle.importKey(
        'jwk',
        privateJwk,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign']
    );
    const aud = new URL(endpoint).origin;
    const header = bytesToBase64Url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
    const payload = bytesToBase64Url(encoder.encode(JSON.stringify({
        aud,
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
        sub: env.VAPID_SUBJECT
    })));
    const data = `${header}.${payload}`;
    const signature = new Uint8Array(await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        encoder.encode(data)
    ));

    return `${data}.${bytesToBase64Url(signature)}`;
}

async function encryptPushPayload(subscription, payload) {
    const receiverPublicKey = base64UrlToBytes(subscription.keys.p256dh);
    const authSecret = base64UrlToBytes(subscription.keys.auth);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const senderKeys = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveBits']
    );
    const senderPublicKey = new Uint8Array(await crypto.subtle.exportKey('raw', senderKeys.publicKey));
    const receiverKey = await importP256PublicKey(receiverPublicKey);
    const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
        { name: 'ECDH', public: receiverKey },
        senderKeys.privateKey,
        256
    ));

    const prkKey = await hmac(authSecret, sharedSecret);
    const keyInfo = concatBytes(
        encoder.encode('WebPush: info'),
        new Uint8Array([0]),
        receiverPublicKey,
        senderPublicKey
    );
    const ikm = await hkdfExpand(prkKey, keyInfo, 32);
    const prk = await hmac(salt, ikm);
    const cek = await hkdfExpand(prk, 'Content-Encoding: aes128gcm\0', 16);
    const nonce = await hkdfExpand(prk, 'Content-Encoding: nonce\0', 12);
    const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
    const plaintext = concatBytes(encoder.encode(JSON.stringify(payload)), new Uint8Array([2]));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce, tagLength: 128 },
        aesKey,
        plaintext
    ));
    const rs = new Uint8Array([0, 0, 16, 0]);

    return concatBytes(salt, rs, new Uint8Array([senderPublicKey.length]), senderPublicKey, ciphertext);
}

async function sendWebPush(subscription, payload, env) {
    if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
        throw new Error('VAPID environment variables are not configured.');
    }

    const jwt = await createVapidJwt(subscription.endpoint, env);
    const body = await encryptPushPayload(subscription, payload);
    const response = await fetch(subscription.endpoint, {
        method: 'POST',
        headers: {
            TTL: '300',
            Urgency: 'high',
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
            Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`
        },
        body
    });

    if (!response.ok && response.status !== 201) {
        throw new Error(`Push service responded with ${response.status}`);
    }

    return response;
}

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

function getNewYorkParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).formatToParts(date).reduce((acc, part) => {
        acc[part.type] = part.value;
        return acc;
    }, {});

    return {
        dateKey: `${parts.year}-${parts.month}-${parts.day}`,
        year: Number(parts.year),
        month: Number(parts.month),
        weekday: parts.weekday,
        hour: Number(parts.hour),
        minute: Number(parts.minute)
    };
}

function getMarketCalendarStatus(parts) {
    const isWeekend = parts.weekday === 'Sat' || parts.weekday === 'Sun';
    const isHoliday = MARKET_HOLIDAYS.has(parts.dateKey);
    const isEarlyClose = EARLY_CLOSE_DATES.has(parts.dateKey);
    const closeHour = isEarlyClose ? 13 : 16;
    const alertHour = isEarlyClose ? 12 : 15;
    const alertMinute = 30;
    const shouldReviewCalendar = parts.month >= 11;
    const calendarWarning = parts.year >= CALENDAR_MAX_YEAR
        ? `Hardcoded NYSE market calendar ends in ${CALENDAR_MAX_YEAR}. Update next year's holidays and early closes.`
        : shouldReviewCalendar
            ? 'Annual reminder: review and hardcode next year NYSE holidays/early closes before year-end.'
            : null;

    return {
        isTradingDay: !isWeekend && !isHoliday,
        isWeekend,
        isHoliday,
        isEarlyClose,
        closeTimeEt: `${String(closeHour).padStart(2, '0')}:00`,
        alertTimeEt: `${String(alertHour).padStart(2, '0')}:${String(alertMinute).padStart(2, '0')}`,
        calendarMaxYear: CALENDAR_MAX_YEAR,
        calendarWarning
    };
}

function isAfterAlertTime(parts, marketStatus) {
    const [alertHour, alertMinute] = marketStatus.alertTimeEt.split(':').map(Number);
    return parts.hour > alertHour || (parts.hour === alertHour && parts.minute >= alertMinute);
}

async function fetchQuote(symbol, env) {
    if (!env.FINNHUB_KEY) {
        throw new Error('FINNHUB_KEY is not configured.');
    }

    const url = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${env.FINNHUB_KEY}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Finnhub responded with ${response.status}`);

    const quote = await response.json();
    const price = Number(quote.c);
    if (!price) throw new Error(`${symbol} current price is missing.`);

    return price;
}

async function fetchRecentCloses(symbol) {
    const period2 = Math.floor(Date.now() / 1000);
    const period1 = period2 - (35 * 24 * 60 * 60);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&period1=${period1}&period2=${period2}`;
    const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 Market Pulse Worker' }
    });
    if (!response.ok) throw new Error(`Yahoo Finance responded with ${response.status}`);

    const data = await response.json();
    const closes = data.chart?.result?.[0]?.indicators?.quote?.[0]?.close
        ?.filter(value => typeof value === 'number');
    if (!closes || closes.length < 20) {
        throw new Error('Not enough Yahoo Finance close data.');
    }

    return closes;
}

function calculateBPercent(currentPrice, closes) {
    const recentCloses = closes.slice(-20);
    const sma = recentCloses.reduce((sum, value) => sum + value, 0) / recentCloses.length;
    const variance = recentCloses.reduce((sum, value) => sum + Math.pow(value - sma, 2), 0) / recentCloses.length;
    const stdDev = Math.sqrt(variance);
    const upperBand = sma + stdDev * 2;
    const lowerBand = sma - stdDev * 2;

    return (currentPrice - lowerBand) / (upperBand - lowerBand);
}

async function readJson(env, key, fallback) {
    const raw = await env.KV.get(key);
    return raw ? JSON.parse(raw) : fallback;
}

async function writeMonitorStatus(env, status) {
    await env.KV.put(MONITOR_STATUS_KEY, JSON.stringify({
        ...status,
        updatedAt: new Date().toISOString()
    }));
}

async function notifySubscriptions(env, payload) {
    const subscriptions = await readJson(env, SUBSCRIPTIONS_KEY, []);
    const results = await Promise.allSettled(
        subscriptions.map(subscription => sendWebPush(subscription, payload, env))
    );

    return {
        total: results.length,
        success: results.filter(result => result.status === 'fulfilled').length,
        failed: results.filter(result => result.status === 'rejected').length
    };
}

function buildPushBody(state) {
    const direction = state.bPercent >= 1
        ? 'Action: review profitable TQQQ lots, then consider moving proceeds into QQQM/GLDM.'
        : 'Action: consider moving part of GLDM into TQQQ.';

    return [
        `QQQM ${state.type}`,
        `Price: $${state.price.toFixed(2)}`,
        `BB %b: ${state.bPercent.toFixed(4)}`,
        direction,
        'Open Market Pulse to review rebalance orders.'
    ].join('\n');
}

async function runMonitor(env) {
    const nyParts = getNewYorkParts();
    const marketStatus = getMarketCalendarStatus(nyParts);
    const previousState = await readJson(env, ALERT_STATE_KEY, {});
    let state = previousState.dateKey === nyParts.dateKey ? previousState : {
        dateKey: nyParts.dateKey,
        acknowledged: false,
        lastPushedAt: 0
    };

    if (!marketStatus.isTradingDay) {
        const status = {
            ok: true,
            mode: 'skipped',
            reason: marketStatus.isWeekend ? 'weekend' : 'market holiday',
            nyDate: nyParts.dateKey,
            marketStatus,
            alertState: state,
            pushed: false
        };
        await writeMonitorStatus(env, status);
        return status;
    }

    const currentPrice = await fetchQuote(SYMBOL, env);
    const closes = await fetchRecentCloses(SYMBOL);
    const bPercent = calculateBPercent(currentPrice, closes);

    if (bPercent <= 0 || bPercent >= 1) {
        state = {
            ...state,
            dateKey: nyParts.dateKey,
            type: bPercent >= 1 ? 'upper band breakout' : 'lower band touch',
            price: currentPrice,
            bPercent,
            firstSeenAt: state.firstSeenAt || new Date().toISOString(),
            acknowledged: Boolean(state.acknowledged),
            lastCheckedAt: new Date().toISOString()
        };
        await env.KV.put(ALERT_STATE_KEY, JSON.stringify(state));
    }

    const shouldPush = state.type
        && isAfterAlertTime(nyParts, marketStatus)
        && !state.acknowledged
        && Date.now() - Number(state.lastPushedAt || 0) >= 5 * 60 * 1000;

    let pushResult = null;
    if (shouldPush) {
        pushResult = await notifySubscriptions(env, {
            title: `Market Pulse: QQQM ${state.type}`,
            body: buildPushBody(state),
            url: '/',
            ackUrl: '/api/ack-alert'
        });
        state.lastPushedAt = Date.now();
        state.lastPushedAtIso = new Date().toISOString();
        await env.KV.put(ALERT_STATE_KEY, JSON.stringify(state));
    }

    const status = {
        ok: true,
        notice: CHECK_INTERVAL_NOTICE,
        nyDate: nyParts.dateKey,
        currentPrice,
        bPercent,
        marketStatus,
        alertState: state,
        pushed: Boolean(pushResult),
        pushResult
    };
    await writeMonitorStatus(env, status);

    return status;
}

async function runTestPush(env) {
    const pushResult = await notifySubscriptions(env, {
        title: '[TEST] Market Pulse Cron Worker',
        body: [
            'This is a test notification.',
            'No real rebalance action is required.',
            'If this notification arrived, Cron Worker push delivery is configured correctly.'
        ].join('\n'),
        url: '/',
        ackUrl: '/api/ack-alert'
    });
    const state = await readJson(env, ALERT_STATE_KEY, {});
    state.testPushedAt = new Date().toISOString();
    await env.KV.put(ALERT_STATE_KEY, JSON.stringify(state));

    return {
        ok: true,
        testPush: true,
        pushResult
    };
}

export default {
    async scheduled(event, env, ctx) {
        ctx.waitUntil(runMonitor(env));
    },

    async fetch(request, env) {
        try {
            const url = new URL(request.url);
            if (url.searchParams.get('testPush') === '1') {
                return jsonResponse(await runTestPush(env));
            }

            const result = await runMonitor(env);
            return jsonResponse(result);
        } catch (error) {
            return jsonResponse({ ok: false, error: error.message }, 500);
        }
    }
};
