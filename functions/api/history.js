/**
 * Cloudflare Pages Function
 * 경로: /api/history
 * 역할: Yahoo Finance CORS 우회 프록시 (server.js의 역할을 대체)
 */
export async function onRequestGet(context) {
    const { request } = context;
    const url = new URL(request.url);

    const symbol = url.searchParams.get('symbol') || 'QQQM';
    const period1 = url.searchParams.get('period1');
    const period2 = url.searchParams.get('period2');

    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&period1=${period1}&period2=${period2}`;

    try {
        const yahooRes = await fetch(yahooUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            }
        });

        const data = await yahooRes.text();

        return new Response(data, {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            }
        });
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
            status: 500,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            }
        });
    }
}
