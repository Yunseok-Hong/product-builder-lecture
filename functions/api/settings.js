export async function onRequestGet(context) {
    const { env } = context;
    try {
        // KV에서 설정 값 불러오기 (키: 'user_settings')
        const settings = await env.KV.get('user_settings');
        
        if (settings) {
            return new Response(settings, {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        } else {
            return new Response(JSON.stringify({}), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
}

export async function onRequestPost(context) {
    const { request, env } = context;
    try {
        // 요청 본문에서 새 설정 값 읽기
        const newSettings = await request.text();
        
        // KV에 설정 값 저장 (키: 'user_settings')
        await env.KV.put('user_settings', newSettings);
        
        return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
}
