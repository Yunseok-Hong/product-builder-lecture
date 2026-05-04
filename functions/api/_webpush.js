const encoder = new TextEncoder();

function base64UrlToBytes(value) {
    const padding = '='.repeat((4 - value.length % 4) % 4);
    const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64);
    return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function bytesToBase64Url(bytes) {
    let binary = '';
    bytes.forEach(byte => {
        binary += String.fromCharCode(byte);
    });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function concatBytes(...arrays) {
    const length = arrays.reduce((sum, array) => sum + array.length, 0);
    const result = new Uint8Array(length);
    let offset = 0;
    arrays.forEach(array => {
        result.set(array, offset);
        offset += array.length;
    });
    return result;
}

async function hmac(keyBytes, dataBytes) {
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, dataBytes));
}

async function hkdfExpand(prk, info, length) {
    const infoBytes = typeof info === 'string' ? encoder.encode(info) : info;
    const blocks = [];
    let previous = new Uint8Array(0);
    let outputLength = 0;
    let counter = 1;

    while (outputLength < length) {
        previous = await hmac(prk, concatBytes(previous, infoBytes, new Uint8Array([counter])));
        blocks.push(previous);
        outputLength += previous.length;
        counter += 1;
    }

    return concatBytes(...blocks).slice(0, length);
}

async function importP256PublicKey(rawPublicKey) {
    return crypto.subtle.importKey(
        'raw',
        rawPublicKey,
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        []
    );
}

async function createVapidJwt(endpoint, env) {
    const publicKeyBytes = base64UrlToBytes(env.VAPID_PUBLIC_KEY);
    const x = bytesToBase64Url(publicKeyBytes.slice(1, 33));
    const y = bytesToBase64Url(publicKeyBytes.slice(33, 65));
    const privateJwk = {
        kty: 'EC',
        crv: 'P-256',
        x,
        y,
        d: env.VAPID_PRIVATE_KEY,
        ext: true
    };
    const key = await crypto.subtle.importKey(
        'jwk',
        privateJwk,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign']
    );
    const aud = new URL(endpoint).origin;
    const header = bytesToBase64Url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
    const payload = bytesToBase64Url(encoder.encode(JSON.stringify({
        aud,
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
        sub: env.VAPID_SUBJECT
    })));
    const data = `${header}.${payload}`;
    const signature = new Uint8Array(await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        encoder.encode(data)
    ));

    return `${data}.${bytesToBase64Url(signature)}`;
}

async function encryptPushPayload(subscription, payload) {
    const receiverPublicKey = base64UrlToBytes(subscription.keys.p256dh);
    const authSecret = base64UrlToBytes(subscription.keys.auth);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const senderKeys = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveBits']
    );
    const senderPublicKey = new Uint8Array(await crypto.subtle.exportKey('raw', senderKeys.publicKey));
    const receiverKey = await importP256PublicKey(receiverPublicKey);
    const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
        { name: 'ECDH', public: receiverKey },
        senderKeys.privateKey,
        256
    ));

    const prkKey = await hmac(authSecret, sharedSecret);
    const keyInfo = concatBytes(
        encoder.encode('WebPush: info'),
        new Uint8Array([0]),
        receiverPublicKey,
        senderPublicKey
    );
    const ikm = await hkdfExpand(prkKey, keyInfo, 32);
    const prk = await hmac(salt, ikm);
    const cek = await hkdfExpand(prk, 'Content-Encoding: aes128gcm\0', 16);
    const nonce = await hkdfExpand(prk, 'Content-Encoding: nonce\0', 12);
    const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
    const plaintext = concatBytes(encoder.encode(JSON.stringify(payload)), new Uint8Array([2]));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce, tagLength: 128 },
        aesKey,
        plaintext
    ));
    const rs = new Uint8Array([0, 0, 16, 0]);

    return concatBytes(salt, rs, new Uint8Array([senderPublicKey.length]), senderPublicKey, ciphertext);
}

export async function sendWebPush(subscription, payload, env) {
    if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
        throw new Error('VAPID environment variables are not configured.');
    }

    const jwt = await createVapidJwt(subscription.endpoint, env);
    const body = await encryptPushPayload(subscription, payload);
    const response = await fetch(subscription.endpoint, {
        method: 'POST',
        headers: {
            TTL: '300',
            Urgency: 'high',
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
            Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`
        },
        body
    });

    if (!response.ok && response.status !== 201) {
        throw new Error(`Push service responded with ${response.status}`);
    }

    return response;
}
