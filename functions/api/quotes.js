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
        const symbols = (url.searchParams.get('symbols') || 'TQQQ')
            .split(',')
            .map(symbol => symbol.trim().toUpperCase())
            .filter(Boolean);

        async function fetchQuotePrice(symbol) {
            const quoteUrl = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${env.FINNHUB_KEY}`;
            const response = await fetch(quoteUrl);
            if (!response.ok) throw new Error(`Finnhub ${symbol} responded with ${response.status}`);

            const quote = await response.json();
            const price = Number(quote.c);
            if (!price) throw new Error(`${symbol} current price is missing.`);
            return price;
        }

        async function fetchUsdKrwRate() {
            const forexSymbols = ['USDKRW=X', 'KRW=X'];
            let lastError;

            for (const symbol of forexSymbols) {
                try {
                    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
                    const response = await fetch(yahooUrl, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                        }
                    });
                    if (!response.ok) throw new Error(`Yahoo ${symbol} responded with ${response.status}`);

                    const data = await response.json();
                    const result = data.chart?.result?.[0];
                    const price = Number(
                        result?.meta?.regularMarketPrice ||
                        result?.meta?.previousClose ||
                        result?.indicators?.quote?.[0]?.close?.filter(Boolean).at(-1)
                    );
                    if (!price) throw new Error(`${symbol} exchange rate is missing.`);

                    return {
                        symbol,
                        rate: price
                    };
                } catch (error) {
                    lastError = error;
                }
            }

            throw lastError || new Error('USD/KRW exchange rate is missing.');
        }

        const [entries, usdKrwResult] = await Promise.all([
            Promise.all(symbols.map(async (symbol) => [symbol, await fetchQuotePrice(symbol)])),
            fetchUsdKrwRate()
                .then(value => ({ ok: true, value }))
                .catch(error => ({ ok: false, error: error.message }))
        ]);

        const body = { quotes: Object.fromEntries(entries) };
        if (usdKrwResult.ok) {
            body.fx = { USDKRW: usdKrwResult.value.rate, symbol: usdKrwResult.value.symbol };
        } else {
            body.fxError = usdKrwResult.error;
        }

        return jsonResponse(body);
    } catch (error) {
        return jsonResponse({ error: error.message }, 500);
    }
}
