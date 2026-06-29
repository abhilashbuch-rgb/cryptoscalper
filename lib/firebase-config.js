const admin = require('firebase-admin');

let _initError = null;

if (!admin.apps.length) {
  try {
    let credential;

    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      credential = admin.credential.cert(sa);
    } else if (process.env.FIREBASE_PRIVATE_KEY) {
      let pk = process.env.FIREBASE_PRIVATE_KEY;
      // Handle various Vercel env var formats
      if (pk.startsWith('"') && pk.endsWith('"')) pk = pk.slice(1, -1);
      pk = pk.replace(/\\n/g, '\n');
      if (!pk.includes('-----BEGIN')) {
        _initError = 'FIREBASE_PRIVATE_KEY does not contain a valid PEM key (missing BEGIN marker)';
        throw new Error(_initError);
      }
      credential = admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: pk,
      });
    } else {
      credential = admin.credential.applicationDefault();
    }

    admin.initializeApp({ credential });
  } catch (err) {
    _initError = _initError || err.message;
    console.error('[FIREBASE] Init failed:', _initError);
    if (!admin.apps.length) {
      admin.initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || 'wicknetwork' });
    }
  }
}

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

module.exports = { db, FieldValue, _initError };
