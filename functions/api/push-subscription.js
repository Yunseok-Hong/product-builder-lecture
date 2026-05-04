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

async function writeSubscriptions(env, subscriptions) {
    await env.KV.put(SUBSCRIPTIONS_KEY, JSON.stringify(subscriptions));
}

export async function onRequestGet({ env }) {
    try {
        const subscriptions = await readSubscriptions(env);
        return jsonResponse({ count: subscriptions.length });
    } catch (error) {
        return jsonResponse({ error: error.message }, 500);
    }
}

export async function onRequestPost({ request, env }) {
    try {
        const subscription = await request.json();
        if (!subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
            return jsonResponse({ error: 'Invalid push subscription.' }, 400);
        }

        const subscriptions = await readSubscriptions(env);
        const filtered = subscriptions.filter(item => item.endpoint !== subscription.endpoint);
        filtered.push({
            ...subscription,
            updatedAt: new Date().toISOString()
        });
        await writeSubscriptions(env, filtered);

        return jsonResponse({ success: true, count: filtered.length });
    } catch (error) {
        return jsonResponse({ error: error.message }, 500);
    }
}
