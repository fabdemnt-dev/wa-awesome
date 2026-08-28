const { defineSecret } = require('firebase-functions/params');

const manusApiKey = defineSecret('MANUS_API_KEY');

module.exports = { manusApiKey };
