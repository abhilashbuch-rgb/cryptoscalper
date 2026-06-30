// Polymarket's gamma-api encodes array fields (outcomePrices, clobTokenIds, etc.)
// as JSON strings rather than real arrays. Normalize either shape to an array.
function parseJsonArray(field) {
  if (Array.isArray(field)) return field;
  if (typeof field === 'string') {
    try {
      const parsed = JSON.parse(field);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

module.exports = { parseJsonArray };
