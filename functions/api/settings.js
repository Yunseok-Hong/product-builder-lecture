function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

export async function onRequestGet({ env }) {
    try {
        if (!env.KV) return jsonResponse({ error: 'KV binding is not configured.' }, 500);

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
        if (!env.KV) return jsonResponse({ error: 'KV binding is not configured.' }, 500);

        const settings = await request.json();
        await env.KV.put('user_settings', JSON.stringify(settings));

        return jsonResponse({ success: true, settings });
    } catch (error) {
        return jsonResponse({ error: error.message }, 500);
    }
}
