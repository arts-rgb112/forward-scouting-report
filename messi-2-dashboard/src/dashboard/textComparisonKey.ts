/**
 * Local comparison-only key for already-loaded display data. Never use this
 * value for a route or API request: those preserve the user's raw input.
 */
export function textComparisonKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[øłđðþæœß]/g, (character) => ({
      ø: "o", ł: "l", đ: "d", ð: "d", þ: "th", æ: "ae", œ: "oe", ß: "ss",
    })[character] ?? character)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .normalize("NFC")
    .replace(/\p{White_Space}+/gu, " ")
    .trim();
}
