const admin = require('firebase-admin');

if (!admin.apps.length) {
  try {
    let credential;

    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      credential = admin.credential.cert(sa);
    } else if (process.env.FIREBASE_PRIVATE_KEY) {
      credential = admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      });
    } else {
      credential = admin.credential.applicationDefault();
    }

    admin.initializeApp({ credential });
  } catch (err) {
    console.error('[FIREBASE] Init failed:', err.message);
    admin.initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || 'wicknetwork' });
  }
}

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

module.exports = { db, FieldValue };
