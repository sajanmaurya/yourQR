import { createApp } from './app.js';

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
const app = createApp();
const server = app.listen(port, host, () => {
  console.log(`Qori is running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  console.log(`QR redirect origin: ${app.locals.config.publicBaseUrl}`);
});
let closing = false;
function close() {
  if (closing) return;
  closing = true;
  server.close(() => { app.locals.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', close);
process.on('SIGINT', close);
