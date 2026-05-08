const SYMBOLS = ['QQQM', 'TQQQ', 'GLDM'];
const CLOSE_HISTORY_KEY = 'close_history_v1';
const CLOSE_HISTORY_API_SYNC_KEY = 'close_history_api_sync_v1';
const PORTFOLIO_VALUES_KEY = 'portfolio_values_v1';

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

function normalizeDate(value) {
    const date = String(value || '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function dateToUnix(date, extraDays = 0) {
    return Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000) + extraDays * 24 * 60 * 60;
}

async function readJson(env, key, fallback) {
    const raw = await env.KV.get(key);
    return raw ? JSON.parse(raw) : fallback;
}

function normalizePortfolioValues(values) {
    return Object.values((Array.isArray(values) ? values : []).reduce((map, item) => {
        const date = normalizeDate(item.date);
        const valueUsd = Number(item.valueUsd);
        if (date && Number.isFinite(valueUsd) && valueUsd > 0) {
            map[date] = {
                date,
                valueUsd,
                savedAt: item.savedAt || item.createdAt || new Date().toISOString()
            };
        }
        return map;
    }, {})).sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchAdjustedCloses(symbol, startDate, endDate) {
    const period1 = dateToUnix(startDate, -3);
    const period2 = dateToUnix(endDate, 2);
    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&period1=${period1}&period2=${period2}`;
    const response = await fetch(yahooUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 Market Pulse Pages Function' }
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
        if (date >= startDate && date <= endDate && Number.isFinite(adjustedClose) && adjustedClose > 0) {
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

async function ensureCloseHistory(env, closeHistory, portfolioValues) {
    if (!portfolioValues.length) return closeHistory;

    const startDate = portfolioValues[0].date;
    const endDate = new Date().toISOString().slice(0, 10);
    const nextHistory = closeHistory && typeof closeHistory === 'object' ? { ...closeHistory } : {};
    const syncState = await readJson(env, CLOSE_HISTORY_API_SYNC_KEY, {});

    // 오늘 이미 시도했거나 성공했다면 더 이상 KV에 쓰지 않고 종료
    if (syncState.lastAttemptDate === endDate && syncState.startDate <= startDate) {
        return nextHistory;
    }

    let changed = false;

    await Promise.all(SYMBOLS.map(async (symbol) => {
        const existingRows = nextHistory[symbol] && typeof nextHistory[symbol] === 'object'
            ? { ...nextHistory[symbol] }
            : {};
        const hasStart = Object.keys(existingRows).some(date => date >= startDate);
        const hasRecentRange = Object.keys(existingRows).some(date => date >= endDate);

        if (hasStart && hasRecentRange) {
            nextHistory[symbol] = existingRows;
            return;
        }

        try {
            const fetchedRows = await fetchAdjustedCloses(symbol, startDate, endDate);
            nextHistory[symbol] = { ...existingRows, ...fetchedRows };
            changed = changed || Object.keys(fetchedRows).length > 0;
        } catch (error) {
            console.error(`Sync failed for ${symbol}:`, error);
        }
    }));

    if (changed) {
        await env.KV.put(CLOSE_HISTORY_KEY, JSON.stringify(nextHistory));
    }

    // 성공 여부와 상관없이 "오늘 시도함"을 기록하여 반복적인 put() 발생 방지
    await env.KV.put(CLOSE_HISTORY_API_SYNC_KEY, JSON.stringify({
        lastAttemptDate: endDate,
        startDate,
        attemptedAt: new Date().toISOString(),
        changed
    }));

    return nextHistory;
}

export async function onRequestGet({ env }) {
    try {
        let portfolioValues = normalizePortfolioValues(await readJson(env, PORTFOLIO_VALUES_KEY, []));
        let closeHistory = await readJson(env, CLOSE_HISTORY_KEY, {});
        closeHistory = await ensureCloseHistory(env, closeHistory, portfolioValues);
        return jsonResponse({ symbols: SYMBOLS, closeHistory, portfolioValues });
    } catch (error) {
        return jsonResponse({ error: error.message }, 500);
    }
}

export async function onRequestPost({ request, env }) {
    try {
        const body = await request.json();
        const date = normalizeDate(body.date);
        const valueUsd = Number(body.valueUsd);
        if (!date || !Number.isFinite(valueUsd) || valueUsd <= 0) {
            return jsonResponse({ error: 'date and positive valueUsd are required.' }, 400);
        }

        const values = normalizePortfolioValues(await readJson(env, PORTFOLIO_VALUES_KEY, []));
        const nextValues = normalizePortfolioValues([
            ...values.filter(item => item.date !== date),
            { date, valueUsd, savedAt: new Date().toISOString() }
        ]);
        await env.KV.put(PORTFOLIO_VALUES_KEY, JSON.stringify(nextValues));

        let closeHistory = await readJson(env, CLOSE_HISTORY_KEY, {});
        closeHistory = await ensureCloseHistory(env, closeHistory, nextValues);
        return jsonResponse({ success: true, symbols: SYMBOLS, closeHistory, portfolioValues: nextValues });
    } catch (error) {
        return jsonResponse({ error: error.message }, 500);
    }
}

export async function onRequestDelete({ request, env }) {
    try {
        const url = new URL(request.url);
        const date = normalizeDate(url.searchParams.get('date'));
        if (!date) return jsonResponse({ error: 'date is required.' }, 400);

        const values = normalizePortfolioValues(await readJson(env, PORTFOLIO_VALUES_KEY, []));
        const nextValues = values.filter(item => item.date !== date);
        await env.KV.put(PORTFOLIO_VALUES_KEY, JSON.stringify(nextValues));

        const closeHistory = await readJson(env, CLOSE_HISTORY_KEY, {});
        return jsonResponse({ success: true, symbols: SYMBOLS, closeHistory, portfolioValues: nextValues });
    } catch (error) {
        return jsonResponse({ error: error.message }, 500);
    }
}
