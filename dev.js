// Servidor local para probar el addon sin Vercel: npm start
import http from 'node:http';
import fs from 'node:fs';

if (fs.existsSync('.env')) {
  for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { default: handler } = await import('./lib/addon.js');
const PORT = Number(process.env.PORT || 7000);

const server = http.createServer((req, res) => {
  handler(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
server.requestTimeout = 0;
server.listen(PORT, () => console.log(`Addon local en http://127.0.0.1:${PORT}/configure`));
