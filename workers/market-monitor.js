import { sendWebPush } from '../functions/api/_webpush.js';

const SYMBOL = 'QQQM';
const SUBSCRIPTIONS_KEY = 'push_subscriptions';
const SETTINGS_KEY = 'user_settings';
const ALERT_STATE_KEY = 'server_alert_state';
const CHECK_INTERVAL_NOTICE = 'Cloudflare Cron should run this worker every 1 minute.';

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
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).formatToParts(date).reduce((acc, part) => {
        acc[part.type] = part.value;
        return acc;
    }, {});

    return {
        dateKey: `${parts.year}-${parts.month}-${parts.day}`,
        hour: Number(parts.hour),
        minute: Number(parts.minute)
    };
}

function isAfterAlertTime(parts) {
    return parts.hour > 15 || (parts.hour === 15 && parts.minute >= 30);
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
    return [
        `QQQM ${state.type}`,
        `Price: $${state.price.toFixed(2)}`,
        `BB %b: ${state.bPercent.toFixed(4)}`,
        'Open Market Pulse to review rebalance orders.'
    ].join('\n');
}

async function runMonitor(env) {
    const nyParts = getNewYorkParts();
    const currentPrice = await fetchQuote(SYMBOL, env);
    const closes = await fetchRecentCloses(SYMBOL);
    const bPercent = calculateBPercent(currentPrice, closes);
    const previousState = await readJson(env, ALERT_STATE_KEY, {});
    let state = previousState.dateKey === nyParts.dateKey ? previousState : {
        dateKey: nyParts.dateKey,
        acknowledged: false,
        lastPushedAt: 0
    };

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
        && isAfterAlertTime(nyParts)
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

    return {
        ok: true,
        notice: CHECK_INTERVAL_NOTICE,
        nyDate: nyParts.dateKey,
        currentPrice,
        bPercent,
        alertState: state,
        pushed: Boolean(pushResult),
        pushResult
    };
}

export default {
    async scheduled(event, env, ctx) {
        ctx.waitUntil(runMonitor(env));
    },

    async fetch(request, env) {
        try {
            const result = await runMonitor(env);
            return jsonResponse(result);
        } catch (error) {
            return jsonResponse({ ok: false, error: error.message }, 500);
        }
    }
};
