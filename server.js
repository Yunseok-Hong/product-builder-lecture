const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const port = 8000;

http.createServer((req, res) => {
    // CORS 헤더 설정
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Yahoo Finance 프록시 엔드포인트 (/api/history?symbol=QQQM&period1=...&period2=...)
    if (req.url.startsWith('/api/history')) {
        const urlParams = new URLSearchParams(req.url.split('?')[1]);
        const symbol = urlParams.get('symbol') || 'QQQM';
        const period1 = urlParams.get('period1');
        const period2 = urlParams.get('period2');

        const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&period1=${period1}&period2=${period2}`;

        https.get(yahooUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (yahooRes) => {
            let data = '';
            yahooRes.on('data', chunk => data += chunk);
            yahooRes.on('end', () => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(data);
            });
        }).on('error', (err) => {
            res.writeHead(500);
            res.end(JSON.stringify({ error: err.message }));
        });
        return;
    }

    // 기존 정적 파일 서빙
    let filePath = '.' + req.url;
    if (filePath === './') filePath = './index.html';

    const extname = String(path.extname(filePath)).toLowerCase();
    const mimeTypes = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
    };

    const contentType = mimeTypes[extname] || 'application/octet-stream';

    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code == 'ENOENT') {
                res.writeHead(404);
                res.end('File not found');
            } else {
                res.writeHead(500);
                res.end('Server error: ' + error.code);
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
}).listen(port);

console.log(`Server running at http://localhost:${port}/`);
