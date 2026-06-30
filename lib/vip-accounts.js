// Accounts exempted from the wallet-funding gate and the platform fee.
const VIP_EMAILS = new Set([
  'meetp14@gmail.com',
]);

function isVip(email) {
  return !!email && VIP_EMAILS.has(email.toLowerCase());
}

module.exports = { isVip };
