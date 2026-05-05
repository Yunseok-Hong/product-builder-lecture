const MONITOR_SYMBOL = 'TQQQ';
const ALERT_STATE_KEY = `server_alert_state_${MONITOR_SYMBOL}`;

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

export async function onRequestGet({ env }) {
    try {
        const rawState = await env.KV.get(ALERT_STATE_KEY);
        const state = rawState ? JSON.parse(rawState) : {};
        return jsonResponse(state);
    } catch (error) {
        return jsonResponse({ error: error.message }, 500);
    }
}

export async function onRequestPost({ request, env }) {
    try {
        const body = await request.json().catch(() => ({}));
        const rawState = await env.KV.get(ALERT_STATE_KEY);
        const state = rawState ? JSON.parse(rawState) : {};
        const acknowledged = body.acknowledged !== false;

        state.acknowledged = acknowledged;
        if (acknowledged) {
            state.acknowledgedAt = new Date().toISOString();
        } else {
            delete state.acknowledgedAt;
        }

        await env.KV.put(ALERT_STATE_KEY, JSON.stringify(state));

        return jsonResponse({ success: true, acknowledged });
    } catch (error) {
        return jsonResponse({ error: error.message }, 500);
    }
}
