import { createApp } from './app.js';
import { connect } from './storage.js';

const {
  PORT = '3000',
  MONGODB_URI = 'mongodb://127.0.0.1:27017/social_networks',
  PUBLIC_BASE_URL = 'http://localhost:' + PORT,
  JWT_SECRET
} = process.env;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error('Configure JWT_SECRET dans .env avec au moins 32 caractères.');
}
const publicUrl = new URL(PUBLIC_BASE_URL);
if (!['http:', 'https:'].includes(publicUrl.protocol)) throw new Error('PUBLIC_BASE_URL doit être une URL HTTP(S).');

const { db, client } = await connect(MONGODB_URI);
const server = createApp(db, { jwtSecret: JWT_SECRET, publicBaseUrl: publicUrl }).app.listen(Number(PORT), () => {
  console.log('My Social Networks API disponible sur le port ' + PORT);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(async () => { await client.close(); }));
}
