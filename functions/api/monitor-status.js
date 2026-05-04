const ALERT_STATE_KEY = 'server_alert_state';
const MONITOR_STATUS_KEY = 'server_monitor_status';

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

async function readJson(env, key, fallback) {
    const raw = await env.KV.get(key);
    return raw ? JSON.parse(raw) : fallback;
}

export async function onRequestGet({ env }) {
    try {
        const [monitorStatus, alertState] = await Promise.all([
            readJson(env, MONITOR_STATUS_KEY, {}),
            readJson(env, ALERT_STATE_KEY, {})
        ]);

        return jsonResponse({ monitorStatus, alertState });
    } catch (error) {
        return jsonResponse({ error: error.message }, 500);
    }
}
