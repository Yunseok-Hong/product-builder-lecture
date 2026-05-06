function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

export async function onRequestGet({ env }) {
    try {
        const settings = await env.KV.get('user_settings');
        return settings
            ? new Response(settings, { status: 200, headers: { 'Content-Type': 'application/json' } })
            : jsonResponse({});
    } catch (error) {
        return jsonResponse({ error: error.message }, 500);
    }
}

export async function onRequestPost({ request, env }) {
    try {
        const settings = await request.json().catch(async () => JSON.parse(await request.text()));
        const settingsJson = JSON.stringify(settings);
        await env.KV.put('user_settings', settingsJson);

        return jsonResponse({ success: true, settings, savedAt: new Date().toISOString() });
    } catch (error) {
        return jsonResponse({ error: error.message }, 500);
    }
}
