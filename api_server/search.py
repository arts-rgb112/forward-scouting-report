"""Internal, display-preserving search normalization for static cohorts."""

from __future__ import annotations

import unicodedata


# These letters do not all decompose to their ASCII search equivalents under
# Unicode NFKD.  Transliterate only for matching; API display strings always
# retain their source spelling.
_SEARCH_TRANSLITERATION = str.maketrans({
    "ø": "o",
    "ł": "l",
    "đ": "d",
    "ð": "d",
    "þ": "th",
    "æ": "ae",
    "œ": "oe",
})


def canonical_search_key(value: str) -> str:
    """Return a stable case- and diacritic-insensitive matching key.

    This is deliberately stdlib-only and is used solely inside server-side
    predicates.  It never changes player, club, or competition labels sent to
    clients, nor the raw ``meta.applied.q`` echo.
    """
    normalized = unicodedata.normalize("NFKD", value).casefold()
    transliterated = normalized.translate(_SEARCH_TRANSLITERATION)
    without_marks = "".join(
        character
        for character in transliterated
        if not unicodedata.category(character).startswith("M")
    )
    # NFKD also decomposes Hangul syllables into Jamo. Recompose the final
    # key so non-Latin scripts retain their canonical user-visible form while
    # Latin marks already removed above stay folded.
    return unicodedata.normalize("NFC", " ".join(without_marks.split()))
