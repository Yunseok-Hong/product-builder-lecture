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
            const forexSymbols = ['OANDA:USD_KRW', 'FOREXCOM:USDKRW'];
            let lastError;

            for (const symbol of forexSymbols) {
                try {
                    return {
                        symbol,
                        rate: await fetchQuotePrice(symbol)
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
