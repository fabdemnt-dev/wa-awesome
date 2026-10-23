// Public identifiers copied explicitly from reviewed main, never imported from its resolver.
// Enabled only for this isolated limited-trial source. Publication and live testing remain
// separately gated; this local flag is not proof of a successful live App Check or Auth test.
export default Object.freeze({
  "schemaVersion": 1,
  "enabled": true,
  "projectId": "wa-awesome",
  "region": "asia-northeast1",
  "origin": "https://fabdemnt-dev.github.io",
  "epochId": "public-production-20261023-v1",
  "maxRooms": 20,
  "roomTtlMillis": 86400000,
  "retentionMillis": 604800000,
  "projectNumber": "1074804319870",
  "firebase": {
    "apiKey": "AIzaSyBtb74uz6clsoc9uA_AkDHi7DdepEWn2dw",
    "authDomain": "wa-awesome.firebaseapp.com",
    "projectId": "wa-awesome",
    "storageBucket": "wa-awesome.firebasestorage.app",
    "messagingSenderId": "1074804319870",
    "appId": "1:1074804319870:web:923f0ec866812f98ae5a2f"
  },
  "appCheck": {
    "provider": "recaptcha-enterprise",
    "siteKey": "6LeU8sstAAAAAOEyP56nWLD633TiAWaLmvcskE6e",
    "verified": true
  }
});
