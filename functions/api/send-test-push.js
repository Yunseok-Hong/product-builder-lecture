import { sendWebPush } from './_webpush.js';

const SUBSCRIPTIONS_KEY = 'push_subscriptions';

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

async function readSubscriptions(env) {
    const raw = await env.KV.get(SUBSCRIPTIONS_KEY);
    return raw ? JSON.parse(raw) : [];
}

export async function onRequestPost({ request, env }) {
    try {
        const subscriptions = await readSubscriptions(env);
        if (!subscriptions.length) {
            return jsonResponse({ error: 'No push subscriptions saved.' }, 404);
        }

        const requestBody = await request.json().catch(() => ({}));
        const payload = {
            title: requestBody.title || 'Market Pulse Server Push Test',
            body: requestBody.body || 'This Web Push notification was sent by the server.',
            url: '/'
        };
        const results = await Promise.allSettled(
            subscriptions.map(subscription => sendWebPush(subscription, payload, env))
        );
        const success = results.filter(result => result.status === 'fulfilled').length;
        const failed = results.length - success;

        return jsonResponse({ success, failed, total: results.length });
    } catch (error) {
        return jsonResponse({ error: error.message }, 500);
    }
}
