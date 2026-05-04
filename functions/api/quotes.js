function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

export async function onRequestGet({ request, env }) {
    try {
        if (!env.FINNHUB_KEY) {
            return jsonResponse({ error: 'FINNHUB_KEY is not configured.' }, 500);
        }

        const url = new URL(request.url);
        const symbols = (url.searchParams.get('symbols') || 'QQQM')
            .split(',')
            .map(symbol => symbol.trim().toUpperCase())
            .filter(Boolean);

        const entries = await Promise.all(symbols.map(async (symbol) => {
            const quoteUrl = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${env.FINNHUB_KEY}`;
            const response = await fetch(quoteUrl);
            if (!response.ok) throw new Error(`Finnhub ${symbol} responded with ${response.status}`);

            const quote = await response.json();
            const price = Number(quote.c);
            if (!price) throw new Error(`${symbol} current price is missing.`);

            return [symbol, price];
        }));

        return jsonResponse({ quotes: Object.fromEntries(entries) });
    } catch (error) {
        return jsonResponse({ error: error.message }, 500);
    }
}
