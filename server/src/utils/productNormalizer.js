const { DEDUPE_SEPARATOR } = require('../constants/productConstants');

// ─── normalize ────────────────────────────────────────────────────────────────
// Deterministic normalization algorithm:
// 1. Unicode NFKC normalization
// 2. Lowercase
// 3. Replace "&" with "and"
// 4. Remove every character that is NOT a Unicode letter or digit
//
// Uses the Unicode-aware \p{L} and \p{N} classes so the algorithm works
// correctly with non-Latin scripts.
function normalize(str) {
  if (!str || typeof str !== 'string') return '';

  return str
    .normalize('NFKC')        // 1. Unicode NFKC
    .toLowerCase()             // 2. Lowercase
    .replace(/&/g, 'and')      // 3. "&" → "and"
    .replace(/[^\p{L}\p{N}]/gu, ''); // 4. Keep only Unicode letters and digits
}

// ─── generateDedupeKey ────────────────────────────────────────────────────────
// Constructs: normalizedBrand + "::" + normalizedName
function generateDedupeKey(normalizedBrand, normalizedName) {
  return `${normalizedBrand}${DEDUPE_SEPARATOR}${normalizedName}`;
}

// ─── generateSlug ─────────────────────────────────────────────────────────────
// Generate a slug from brand + name in lowercase kebab-case.
// Steps:
// 1. Concatenate brand and name with a space
// 2. Lowercase
// 3. Replace any non-alphanumeric characters (except hyphens) with hyphens
// 4. Collapse consecutive hyphens
// 5. Trim leading/trailing hyphens
function generateSlug(brand, name) {
  const raw = `${brand} ${name}`;

  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')  // Non-alphanumeric → hyphen
    .replace(/-{2,}/g, '-')       // Collapse consecutive hyphens
    .replace(/^-+|-+$/g, '');     // Trim leading/trailing hyphens
}

// ─── collapseWhitespace ───────────────────────────────────────────────────────
// Collapses all internal runs of whitespace into a single space.
// Used for name and brand before other processing.
function collapseWhitespace(str) {
  if (!str || typeof str !== 'string') return '';
  return str.replace(/\s+/g, ' ').trim();
}

module.exports = {
  normalize,
  generateDedupeKey,
  generateSlug,
  collapseWhitespace,
};
