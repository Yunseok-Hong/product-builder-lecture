const ALERT_STATE_KEY = 'server_alert_state';

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

export async function onRequestPost({ env }) {
    try {
        const rawState = await env.KV.get(ALERT_STATE_KEY);
        const state = rawState ? JSON.parse(rawState) : {};
        state.acknowledged = true;
        state.acknowledgedAt = new Date().toISOString();
        await env.KV.put(ALERT_STATE_KEY, JSON.stringify(state));

        return jsonResponse({ success: true });
    } catch (error) {
        return jsonResponse({ error: error.message }, 500);
    }
}
