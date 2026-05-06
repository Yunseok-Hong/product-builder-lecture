const SYMBOL = 'TQQQ';
const PERFORMANCE_SYMBOLS = ['QQQM', 'TQQQ', 'GLDM'];
const SUBSCRIPTIONS_KEY = 'push_subscriptions';
const ALERT_STATE_KEY = `server_alert_state_${SYMBOL}`;
const MONITOR_STATUS_KEY = `server_monitor_status_${SYMBOL}`;
const CLOSE_HISTORY_KEY = 'close_history_v1';
const CLOSE_HISTORY_SYNC_KEY = 'close_history_sync_v1';
const USER_SETTINGS_KEY = 'user_settings';
const CHECK_INTERVAL_NOTICE = 'Cloudflare Cron should run this worker every 1 minute.';
const REMINDER_INTERVAL_MS = 3 * 60 * 1000;
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
    const closeMinute = 0;
    const finalWindowStart = minutesToTime(closeHour * 60 + closeMinute - 30);
    const alertTime = minutesToTime(closeHour * 60 + closeMinute - 15);
    const ackResetTime = minutesToTime(closeHour * 60 + closeMinute - 60);
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
        alertTimeEt: alertTime,
        finalWindowStartEt: finalWindowStart,
        ackResetTimeEt: ackResetTime,
        calendarMaxYear: CALENDAR_MAX_YEAR,
        calendarWarning
    };
}

function minutesToTime(totalMinutes) {
    const hour = Math.floor(totalMinutes / 60);
    const minute = totalMinutes % 60;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function getPartMinutes(parts) {
    return parts.hour * 60 + parts.minute;
}

function getStatusMinutes(marketStatus, key) {
    const [hour, minute] = marketStatus[key].split(':').map(Number);
    return hour * 60 + minute;
}

function isAtOrAfter(parts, marketStatus, key) {
    return getPartMinutes(parts) >= getStatusMinutes(marketStatus, key);
}

function isBeforeMarketClose(parts, marketStatus) {
    return getPartMinutes(parts) < getStatusMinutes(marketStatus, 'closeTimeEt');
}

function isInFinalWindow(parts, marketStatus) {
    return isAtOrAfter(parts, marketStatus, 'finalWindowStartEt') && isBeforeMarketClose(parts, marketStatus);
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

async function fetchPortfolioQuotes(env) {
    const entries = await Promise.all(['TQQQ', 'GLDM'].map(async symbol => [symbol, await fetchQuote(symbol, env)]));
    return Object.fromEntries(entries);
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
    const result = data.chart?.result?.[0];
    const closes = result?.indicators?.quote?.[0]?.close;
    if (!closes || closes.length < 20) {
        throw new Error('Not enough Yahoo Finance close data.');
    }

    const lastCloseIndex = closes.length - 1;
    return {
        closes,
        lastClose: closes[lastCloseIndex],
        lastCloseAt: result.timestamp?.[lastCloseIndex]
            ? new Date(result.timestamp[lastCloseIndex] * 1000).toISOString()
            : null,
        closeCount: closes.length
    };
}

async function fetchAdjustedCloseRows(symbol, daysBack = 14) {
    const period2 = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
    const period1 = period2 - (daysBack * 24 * 60 * 60);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&period1=${period1}&period2=${period2}`;
    const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 Market Pulse Worker' }
    });
    if (!response.ok) throw new Error(`Yahoo Finance ${symbol} responded with ${response.status}`);

    const data = await response.json();
    const result = data.chart?.result?.[0];
    const timestamps = result?.timestamp || [];
    const closes = result?.indicators?.quote?.[0]?.close || [];
    const adjCloses = result?.indicators?.adjclose?.[0]?.adjclose || [];
    const rows = {};

    timestamps.forEach((timestamp, index) => {
        const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
        const adjustedClose = Number(adjCloses[index] ?? closes[index]);
        if (Number.isFinite(adjustedClose) && adjustedClose > 0) {
            rows[date] = {
                adjustedClose,
                close: Number(closes[index]) || adjustedClose,
                source: 'yahoo',
                savedAt: new Date().toISOString()
            };
        }
    });

    return rows;
}

async function syncPerformanceCloseHistory(env, nyParts, marketStatus) {
    const [syncHour] = marketStatus.closeTimeEt.split(':').map(Number);
    const isAfterClose = nyParts.hour > syncHour + 1 || (nyParts.hour === syncHour + 1 && nyParts.minute >= 30);
    if (!isAfterClose) return null;

    const syncState = await readJson(env, CLOSE_HISTORY_SYNC_KEY, {});
    if (syncState.lastSyncDate === nyParts.dateKey) return syncState;

    const rawHistory = await env.KV.get(CLOSE_HISTORY_KEY);
    const history = rawHistory ? JSON.parse(rawHistory) : {};
    const fetched = await Promise.all(
        PERFORMANCE_SYMBOLS.map(async symbol => [symbol, await fetchAdjustedCloseRows(symbol)])
    );

    fetched.forEach(([symbol, rows]) => {
        history[symbol] = {
            ...(history[symbol] || {}),
            ...rows
        };
    });

    const nextState = {
        lastSyncDate: nyParts.dateKey,
        lastSyncedAt: new Date().toISOString(),
        symbols: PERFORMANCE_SYMBOLS
    };
    await env.KV.put(CLOSE_HISTORY_KEY, JSON.stringify(history));
    await env.KV.put(CLOSE_HISTORY_SYNC_KEY, JSON.stringify(nextState));
    return nextState;
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

function getSignalType(bPercent) {
    if (bPercent >= 1) return 'upper';
    if (bPercent <= 0) return 'lower';
    return null;
}

function getSignalLabel(signalType) {
    return signalType === 'upper' ? 'upper band breakout' : 'lower band touch';
}

function evaluateSignalState(previousState, signalType, dateKey, currentPrice, bPercent, firstSignalWindow) {
    const hadSignalToday = previousState.dateKey === dateKey && Boolean(previousState.signalType);
    const isSameDirection = signalType === previousState.lastSignalType;
    const previousSignalDate = previousState.lastCountedSignalDate || previousState.dateKey;
    const isConsecutiveTradingSignal = isSameDirection && previousSignalDate !== dateKey && previousState.previousTradingDayHadSignal !== false;
    const consecutiveSignalCount = isConsecutiveTradingSignal
        ? Number(previousState.consecutiveSignalCount || 0) + 1
        : isSameDirection && previousState.lastCountedSignalDate === dateKey
            ? Number(previousState.consecutiveSignalCount || 0)
            : 0;
    const firstSeenAt = hadSignalToday
        ? previousState.firstSeenAt
        : new Date().toISOString();

    return {
        ...previousState,
        dateKey,
        price: currentPrice,
        bPercent,
        signalType,
        type: getSignalLabel(signalType),
        acknowledged: previousState.dateKey === dateKey ? Boolean(previousState.acknowledged) : false,
        lastPushedAt: previousState.dateKey === dateKey ? Number(previousState.lastPushedAt || 0) : 0,
        lastCheckedAt: new Date().toISOString(),
        actionMode: 'execute',
        shouldExecute: true,
        consecutiveSignalCount,
        lastCountedSignalDate: dateKey,
        lastSignalType: signalType,
        previousTradingDayHadSignal: true,
        lastExecutedAt: new Date().toISOString(),
        firstSeenAt,
        firstSignalWindow: hadSignalToday ? previousState.firstSignalWindow : firstSignalWindow
    };
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

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function parseNumber(value, fallback = 0) {
    const number = parseFloat(String(value ?? '').replace(/,/g, ''));
    return Number.isFinite(number) ? number : fallback;
}

async function readUserSettings(env) {
    const raw = await env.KV.get(USER_SETTINGS_KEY);
    return raw ? JSON.parse(raw) : {};
}

function getAdjustedTargetsFromSettings(settings, signalType, consecutiveSignalCount) {
    let baseTargetT = parseNumber(settings.rebalanceTargetTqqq, 70);
    let baseTargetG = parseNumber(settings.rebalanceTargetGldm, 100 - baseTargetT);
    const sum = baseTargetT + baseTargetG;

    if (!sum) {
        baseTargetT = 70;
        baseTargetG = 30;
    } else if (Math.abs(sum - 100) > 0.05) {
        baseTargetG = 100 - baseTargetT;
    }

    const step = clamp(Math.abs(parseNumber(settings.rebalanceWeightStep, 4)), 0, 100) / 100;
    const repeatedSteps = Math.max(0, Number(consecutiveSignalCount || 0));
    const direction = signalType === 'lower' ? 1 : signalType === 'upper' ? -1 : 0;
    const targetT = clamp((baseTargetT / 100) + (step * direction * repeatedSteps), 0, 1);

    return {
        baseTargetT: baseTargetT / 100,
        baseTargetG: baseTargetG / 100,
        targetT,
        targetG: 1 - targetT,
        step,
        repeatedSteps
    };
}

function scoreTargetPlan(tVal, gVal, leftover, targetT) {
    const invested = tVal + gVal;
    const tPct = invested ? tVal / invested : 0;
    return Math.abs(tPct - targetT) + (leftover / Math.max(invested + leftover, 1) * 0.001);
}

function findTargetPlan(snapshot, prices, targets) {
    const targetT = targets.targetT;
    let best = {
        sellT: 0,
        buyT: 0,
        sellG: 0,
        buyG: 0,
        tVal: snapshot.tVal,
        gVal: snapshot.gVal,
        leftover: 0,
        score: scoreTargetPlan(snapshot.tVal, snapshot.gVal, 0, targetT)
    };

    for (let sellG = 0; sellG <= Math.floor(snapshot.gQty); sellG += 1) {
        const proceeds = sellG * prices.GLDM;
        const buyT = Math.floor(proceeds / prices.TQQQ);
        if (sellG > 0 && buyT === 0) continue;
        const leftover = proceeds - (buyT * prices.TQQQ);
        const tVal = snapshot.tVal + (buyT * prices.TQQQ);
        const gVal = snapshot.gVal - proceeds;
        const score = scoreTargetPlan(tVal, gVal, leftover, targetT);

        if (score < best.score) {
            best = { sellT: 0, buyT, sellG, buyG: 0, tVal, gVal, leftover, score };
        }
    }

    for (let sellT = 0; sellT <= Math.floor(snapshot.tQty); sellT += 1) {
        const proceeds = sellT * prices.TQQQ;
        const buyG = Math.floor(proceeds / prices.GLDM);
        if (sellT > 0 && buyG === 0) continue;
        const leftover = proceeds - (buyG * prices.GLDM);
        const tVal = snapshot.tVal - proceeds;
        const gVal = snapshot.gVal + (buyG * prices.GLDM);
        const score = scoreTargetPlan(tVal, gVal, leftover, targetT);

        if (score < best.score) {
            best = { sellT, buyT: 0, sellG: 0, buyG, tVal, gVal, leftover, score };
        }
    }

    return best;
}

async function buildLockedRecommendation(env, state, portfolioPrices) {
    const settings = await readUserSettings(env);
    const tQty = parseNumber(settings.tqqqQuantity, 0);
    const gQty = parseNumber(settings.gldmQuantity, 0);
    const prices = portfolioPrices || await fetchPortfolioQuotes(env);
    const snapshot = {
        tQty,
        gQty,
        tVal: tQty * prices.TQQQ,
        gVal: gQty * prices.GLDM
    };
    const targets = getAdjustedTargetsFromSettings(settings, state.signalType, state.consecutiveSignalCount);
    const plan = findTargetPlan(snapshot, prices, targets);

    return {
        dateKey: state.dateKey,
        signalType: state.signalType,
        consecutiveSignalCount: Number(state.consecutiveSignalCount || 0),
        targetT: targets.targetT,
        targetG: targets.targetG,
        baseTargetT: targets.baseTargetT,
        baseTargetG: targets.baseTargetG,
        tqqqAction: plan.sellT > 0 ? 'sell' : plan.buyT > 0 ? 'buy' : 'none',
        tqqqQuantity: plan.sellT || plan.buyT || 0,
        gldmAction: plan.sellG > 0 ? 'sell' : plan.buyG > 0 ? 'buy' : 'none',
        gldmQuantity: plan.sellG || plan.buyG || 0,
        projectedT: plan.tVal,
        projectedG: plan.gVal,
        leftover: plan.leftover,
        prices,
        createdAt: new Date().toISOString()
    };
}

async function ensureLockedRecommendation(env, state, portfolioPrices) {
    if (state.lockedRecommendation?.dateKey === state.dateKey) return state;
    return {
        ...state,
        lockedRecommendation: await buildLockedRecommendation(env, state, portfolioPrices)
    };
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
        ? 'Action: open Market Pulse and rebalance toward the TQQQ/GLDM target weights.'
        : 'Action: open Market Pulse and rebalance toward the TQQQ/GLDM target weights.';
    const recommendation = state.lockedRecommendation
        ? `Target: TQQQ ${(state.lockedRecommendation.targetT * 100).toFixed(1)}% / GLDM ${(state.lockedRecommendation.targetG * 100).toFixed(1)}%`
        : null;

    return [
        `${SYMBOL} ${state.type}`,
        'Status: execute rebalance check.',
        `Price: $${state.price.toFixed(2)}`,
        `BB %b: ${state.bPercent.toFixed(4)}`,
        recommendation,
        direction,
        'Open Market Pulse to review rebalance orders.'
    ].filter(Boolean).join('\n');
}

async function runMonitor(env) {
    const nyParts = getNewYorkParts();
    const marketStatus = getMarketCalendarStatus(nyParts);
    const previousState = await readJson(env, ALERT_STATE_KEY, {});
    let state = previousState.dateKey === nyParts.dateKey ? previousState : {
        ...previousState,
        dateKey: nyParts.dateKey,
        acknowledged: false,
        lastPushedAt: 0,
        firstSeenAt: null,
        firstSignalWindow: null,
        lockedRecommendation: null
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

    const closeHistorySync = await syncPerformanceCloseHistory(env, nyParts, marketStatus).catch(error => ({
        error: error.message,
        failedAt: new Date().toISOString()
    }));
    const currentPrice = await fetchQuote(SYMBOL, env);
    const history = await fetchRecentCloses(SYMBOL);
    const bPercent = calculateBPercent(currentPrice, history.closes);

    if (state.acknowledged && isAtOrAfter(nyParts, marketStatus, 'ackResetTimeEt') && state.ackResetDateKey !== nyParts.dateKey) {
        state = {
            ...state,
            acknowledged: false,
            ackResetDateKey: nyParts.dateKey,
            acknowledgedAt: null
        };
    }

    const signalType = getSignalType(bPercent);
    if (signalType) {
        state = evaluateSignalState(state, signalType, nyParts.dateKey, currentPrice, bPercent, isInFinalWindow(nyParts, marketStatus) ? 'final-window' : 'regular');
        await env.KV.put(ALERT_STATE_KEY, JSON.stringify(state));
    } else {
        state = {
            ...state,
            dateKey: nyParts.dateKey,
            actionMode: 'wait',
            shouldExecute: false,
            signalType: null,
            type: null,
            price: currentPrice,
            bPercent,
            acknowledged: false,
            lastPushedAt: 0,
            lastCheckedAt: new Date().toISOString(),
            firstSeenAt: null,
            firstSignalWindow: null,
            lockedRecommendation: null,
            consecutiveSignalCount: 0,
            lastSignalType: null,
            previousTradingDayHadSignal: false,
            lastCountedSignalDate: nyParts.dateKey
        };
        await env.KV.put(ALERT_STATE_KEY, JSON.stringify(state));
    }

    const isFirstPushToday = !Number(state.lastPushedAt || 0);
    const isRegularSignalReady = state.firstSignalWindow !== 'final-window' && isAtOrAfter(nyParts, marketStatus, 'alertTimeEt');
    const isFinalWindowSignalReady = state.firstSignalWindow === 'final-window' && isInFinalWindow(nyParts, marketStatus);
    const isReminderReady = !isFirstPushToday && Date.now() - Number(state.lastPushedAt || 0) >= REMINDER_INTERVAL_MS;
    const shouldPush = signalType
        && isBeforeMarketClose(nyParts, marketStatus)
        && !state.acknowledged
        && (isFirstPushToday ? (isRegularSignalReady || isFinalWindowSignalReady) : isReminderReady);

    let pushResult = null;
    if (shouldPush) {
        state = await ensureLockedRecommendation(env, state);
        pushResult = await notifySubscriptions(env, {
            title: `Market Pulse: ${SYMBOL} 실행`,
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
        symbol: SYMBOL,
        notice: CHECK_INTERVAL_NOTICE,
        nyDate: nyParts.dateKey,
        currentPrice,
        lastClose: history.lastClose,
        lastCloseAt: history.lastCloseAt,
        closeCount: history.closeCount,
        calculatedAt: new Date().toISOString(),
        bPercent,
        marketStatus,
        closeHistorySync,
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
        ctx.waitUntil(runMonitor(env).catch(error => writeMonitorStatus(env, {
            ok: false,
            error: error.message
        })));
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
            const failureStatus = {
                ok: false,
                symbol: SYMBOL,
                error: error.message,
                updatedAt: new Date().toISOString()
            };
            await env.KV?.put?.(MONITOR_STATUS_KEY, JSON.stringify(failureStatus)).catch(() => null);
            return jsonResponse(failureStatus, 500);
        }
    }
};
