"""M.E.S.S.I. 2.0 asset collector for Google Colab.

Colab setup::

    !pip -q install requests pillow easyocr opencv-python-headless

Only Wikimedia Commons candidates that pass source, license, metadata, OCR, and
visual checks are saved. These automated checks reduce risk; they cannot prove an
image is watermark-free or cleared for every use. Review the images and manifest
manually before publication.
"""

from __future__ import annotations

import csv
import hashlib
import io
import os
import re
import time
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable
from urllib.parse import urlparse

import cv2
import easyocr
import numpy as np
import requests
from PIL import Image
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

API = "https://commons.wikimedia.org/w/api.php"
ROOT = Path("/content/messi_assets")
USER_AGENT = "MESSI-Scouting-AssetCollector/2.1 (educational asset audit)"
TIMEOUT = (10, 45)  # connect, read
MAX_BYTES = 12 * 1024 * 1024
MAX_PIXELS = 30_000_000
SEARCH_PAGE_SIZE = 20
MAX_CANDIDATES_PER_QUERY = 60
DOWNLOAD_CHUNK_SIZE = 64 * 1024

# Extend these lists when a newly observed watermark/source appears.
BLOCKED_TOKENS = {
    "twitter", "twimg", "x.com", "tweet", "sofascore", "sofa score",
    "getty", "alamy", "shutterstock", "dreamstime", "depositphotos",
    "imago", "afp", "reuters", "ap images", "watermark", "stock photo",
    "pinterest", "instagram", "tiktok", "facebook",
}
BLOCKED_DOMAINS = {
    "twitter.com", "x.com", "pbs.twimg.com", "sofascore.com",
    "www.sofascore.com", "images.sofascore.com", "gettyimages.com",
    "alamy.com", "shutterstock.com", "pinterest.com",
}
ALLOWED_LICENSE_MARKERS = {
    "cc0", "public domain", "cc by", "cc-by", "cc by-sa", "cc-by-sa",
    "creative commons attribution", "gnu free documentation",
}


@dataclass(frozen=True)
class AssetRequest:
    kind: str  # players | clubs | nations
    name: str
    search: str


# Edit this list for the scouting cohort.
ASSETS = [
    AssetRequest("players", "Erling Haaland", "Erling Haaland portrait"),
    AssetRequest("players", "Kylian Mbappe", "Kylian Mbappé portrait"),
    AssetRequest("players", "Alexander Isak", "Alexander Isak footballer portrait"),
    AssetRequest("clubs", "Manchester City", "Manchester City FC crest SVG"),
    AssetRequest("clubs", "Real Madrid", "Real Madrid CF crest SVG"),
    AssetRequest("clubs", "Newcastle United", "Newcastle United FC crest SVG"),
    AssetRequest("nations", "Norway", "Flag of Norway SVG"),
    AssetRequest("nations", "France", "Flag of France SVG"),
    AssetRequest("nations", "Sweden", "Flag of Sweden SVG"),
]


def make_session() -> requests.Session:
    retry = Retry(
        total=5,
        connect=5,
        read=5,
        status=5,
        backoff_factor=1.0,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset({"GET"}),
        respect_retry_after_header=True,
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=4, pool_maxsize=4)
    session = requests.Session()
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    session.headers.update({"User-Agent": USER_AGENT})
    return session


def clean_text(value: object) -> str:
    return re.sub(r"<[^>]+>", " ", str(value or "")).lower()


def slugify(value: str) -> str:
    ascii_value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_value.lower()).strip("-")


def contains_blocked_token(*values: object) -> str | None:
    haystack = " ".join(clean_text(value) for value in values)
    return next((token for token in BLOCKED_TOKENS if token in haystack), None)


def blocked_domain(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return any(host == domain or host.endswith("." + domain) for domain in BLOCKED_DOMAINS)


def search_queries(request: AssetRequest) -> list[str]:
    """Return ordered, de-duplicated Commons search variants."""
    if request.kind == "players":
        variants = [
            request.search,
            f'"{request.name}" footballer',
            f'"{request.name}" portrait',
            f'"{request.name}" association football player',
        ]
    elif request.kind == "clubs":
        variants = [
            request.search,
            f'"{request.name}" crest SVG',
            f'"{request.name}" logo SVG',
            f'"{request.name}" badge',
        ]
    else:
        variants = [request.search, f'"Flag of {request.name}" SVG', f'"{request.name}" flag']
    return list(dict.fromkeys(query.strip() for query in variants if query.strip()))


def commons_candidates(
    session: requests.Session,
    query: str,
    max_candidates: int = MAX_CANDIDATES_PER_QUERY,
) -> Iterable[dict]:
    """Yield paginated Commons file-search results for one query."""
    continuation: dict[str, object] = {}
    yielded = 0
    while yielded < max_candidates:
        params: dict[str, object] = {
            "action": "query",
            "generator": "search",
            "gsrsearch": query,
            "gsrnamespace": 6,
            "gsrlimit": min(SEARCH_PAGE_SIZE, max_candidates - yielded),
            "prop": "imageinfo",
            "iiprop": "url|mime|size|sha1|extmetadata",
            "iiurlwidth": 600,
            "iiextmetadatafilter": (
                "Artist|LicenseShortName|LicenseUrl|UsageTerms|Copyrighted|"
                "Attribution|Credit|ImageDescription"
            ),
            "format": "json",
            "formatversion": 2,
            **continuation,
        }
        response = session.get(API, params=params, timeout=TIMEOUT)
        response.raise_for_status()
        payload = response.json()
        if "error" in payload:
            raise RuntimeError(f"Commons API error: {payload['error']}")
        pages = payload.get("query", {}).get("pages", [])
        for page in pages:
            yield page
            yielded += 1
            if yielded >= max_candidates:
                return
        continuation = payload.get("continue", {})
        if not continuation or not pages:
            return


def license_is_acceptable(meta: dict) -> bool:
    license_text = " ".join(
        clean_text(meta.get(key, {}).get("value"))
        for key in ("LicenseShortName", "UsageTerms", "Copyrighted")
    )
    return any(marker in license_text for marker in ALLOWED_LICENSE_MARKERS)


def fetch_image(session: requests.Session, url: str) -> tuple[bytes, str]:
    """Download with a hard streaming limit even if Content-Length is absent/wrong."""
    with session.get(url, timeout=TIMEOUT, stream=True, headers={"Accept": "image/*"}) as response:
        response.raise_for_status()
        mime = response.headers.get("Content-Type", "").split(";")[0].lower()
        if mime not in {"image/jpeg", "image/png", "image/webp"}:
            raise ValueError(f"unsupported MIME: {mime or 'missing'}")
        raw_length = response.headers.get("Content-Length")
        try:
            content_length = int(raw_length) if raw_length else 0
        except ValueError:
            content_length = 0
        if content_length > MAX_BYTES:
            raise ValueError(f"file too large (declared {content_length} bytes)")

        output = io.BytesIO()
        downloaded = 0
        for chunk in response.iter_content(chunk_size=DOWNLOAD_CHUNK_SIZE):
            if not chunk:
                continue
            downloaded += len(chunk)
            if downloaded > MAX_BYTES:
                raise ValueError(f"file too large (stream exceeded {MAX_BYTES} bytes)")
            output.write(chunk)
        if downloaded == 0:
            raise ValueError("empty response")
        return output.getvalue(), mime


def decode_image(data: bytes) -> tuple[Image.Image, np.ndarray]:
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    with Image.open(io.BytesIO(data)) as probe:
        probe.verify()
    with Image.open(io.BytesIO(data)) as source:
        source.load()
        if source.width < 96 or source.height < 96:
            raise ValueError("image resolution below 96px")
        if source.width * source.height > MAX_PIXELS:
            raise ValueError("image pixel count exceeds safety limit")
        output = source.convert("RGBA" if "A" in source.getbands() else "RGB")
    return output, np.asarray(output.convert("RGB"))


def ocr_watermark(reader: easyocr.Reader, rgb: np.ndarray) -> str | None:
    h, w = rgb.shape[:2]
    crops = [
        rgb,
        rgb[: h // 3, : w // 3],
        rgb[: h // 3, -w // 3 :],
        rgb[-h // 3 :, : w // 3],
        rgb[-h // 3 :, -w // 3 :],
    ]
    detected: list[str] = []
    for crop in crops:
        try:
            detected.extend(
                text.lower()
                for _, text, confidence in reader.readtext(crop, detail=1)
                if confidence >= 0.28
            )
        except Exception as exc:
            # Fail closed: an uninspected image must not silently enter the asset set.
            raise RuntimeError(f"OCR inspection failed: {type(exc).__name__}: {exc}") from exc
    return contains_blocked_token(" ".join(detected))


def suspicious_corner_overlay(rgb: np.ndarray) -> bool:
    """Conservatively reject strong corner overlays in player photographs."""
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    h, w = gray.shape
    side = max(24, int(min(h, w) * 0.18))
    corners = [gray[:side, :side], gray[:side, -side:], gray[-side:, :side], gray[-side:, -side:]]
    center = gray[h // 3 : 2 * h // 3, w // 3 : 2 * w // 3]
    center_edges = cv2.Canny(center, 80, 180).mean() + 1.0
    return any(cv2.Canny(corner, 80, 180).mean() > center_edges * 3.4 for corner in corners)


def png_bytes(image: Image.Image, kind: str) -> tuple[bytes, int, int]:
    image = image.copy()
    image.thumbnail((512, 512) if kind == "players" else (384, 384), Image.Resampling.LANCZOS)
    output = io.BytesIO()
    image.save(output, "PNG", optimize=True)
    return output.getvalue(), image.width, image.height


def rejection_row(request: AssetRequest, query: str, page: dict, reason: str, url: str) -> dict:
    return {
        "kind": request.kind,
        "requested_name": request.name,
        "search_query": query,
        "candidate": page.get("title", ""),
        "reason": reason,
        "url": url,
    }


def choose_candidate(
    session: requests.Session,
    reader: easyocr.Reader,
    request: AssetRequest,
    rejected: list[dict],
    seen_hashes: dict[str, str],
) -> tuple[dict | None, int]:
    visited: set[str] = set()
    inspected = 0
    for query in search_queries(request):
        try:
            candidates = commons_candidates(session, query)
            for page in candidates:
                identity = str(page.get("pageid") or page.get("title", ""))
                if identity in visited:
                    continue
                visited.add(identity)
                inspected += 1
                info = (page.get("imageinfo") or [{}])[0]
                meta = info.get("extmetadata", {})
                original_url = info.get("url", "")
                thumbnail_url = info.get("thumburl", "")
                original_mime = str(info.get("mime", "")).lower()

                # Commons creates a raster PNG thumbnail for SVG flags/crests.
                download_url = thumbnail_url or original_url
                reason = None
                if original_mime == "image/svg+xml" and not thumbnail_url:
                    reason = "SVG candidate has no raster thumbnail URL"
                token = contains_blocked_token(page.get("title"), original_url, thumbnail_url, meta)
                if reason is None and token:
                    reason = f"blocked keyword: {token}"
                elif reason is None and (blocked_domain(download_url) or blocked_domain(info.get("descriptionurl", ""))):
                    reason = "blocked source domain"
                elif reason is None and not license_is_acceptable(meta):
                    reason = "license not in allowlist"

                if reason is None:
                    try:
                        data, download_mime = fetch_image(session, download_url)
                        image, rgb = decode_image(data)
                        token = ocr_watermark(reader, rgb)
                        if token:
                            reason = f"OCR watermark: {token}"
                        elif request.kind == "players" and suspicious_corner_overlay(rgb):
                            reason = "suspicious corner overlay"
                        else:
                            encoded, width, height = png_bytes(image, request.kind)
                            digest = hashlib.sha256(encoded).hexdigest()
                            if digest in seen_hashes:
                                reason = f"duplicate SHA-256 of {seen_hashes[digest]}"
                    except Exception as exc:
                        reason = f"download/inspection error: {type(exc).__name__}: {exc}"

                if reason:
                    rejected.append(rejection_row(request, query, page, reason, download_url))
                    continue

                return {
                    "page": page,
                    "info": info,
                    "meta": meta,
                    "original_url": original_url,
                    "thumbnail_url": thumbnail_url,
                    "download_url": download_url,
                    "original_mime": original_mime,
                    "download_mime": download_mime,
                    "png": encoded,
                    "sha256": digest,
                    "width": width,
                    "height": height,
                    "query": query,
                }, inspected
        except Exception as exc:
            rejected.append(rejection_row(request, query, {}, f"search error: {type(exc).__name__}: {exc}", ""))
    return None, inspected


def metadata_value(meta: dict, key: str) -> str:
    value = str(meta.get(key, {}).get("value", ""))
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", value)).strip()


def atomic_write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with temporary.open("wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def write_csv(path: Path, rows: Iterable[dict], fieldnames: list[str]) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with temporary.open("w", newline="", encoding="utf-8-sig") as handle:
            writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction="ignore")
            writer.writeheader()
            writer.writerows(rows)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def run() -> None:
    for folder in ("players", "clubs", "nations"):
        (ROOT / folder).mkdir(parents=True, exist_ok=True)

    session = make_session()
    reader = easyocr.Reader(["en"], gpu=False, verbose=False)
    manifest: list[dict] = []
    rejected: list[dict] = []
    statuses: list[dict] = []
    seen_hashes: dict[str, str] = {}

    for index, request in enumerate(ASSETS, 1):
        print(f"[{index:02}/{len(ASSETS):02}] {request.kind}/{request.name}", end=" ... ")
        started = time.monotonic()
        inspected = 0
        try:
            result, inspected = choose_candidate(session, reader, request, rejected, seen_hashes)
            if not result:
                status, detail = "failed", "no safe unique candidate"
                print("NO SAFE CANDIDATE")
            else:
                filename = f"{slugify(request.name)}.png"
                target = ROOT / request.kind / filename
                atomic_write_bytes(target, result["png"])
                seen_hashes[result["sha256"]] = f"{request.kind}/{request.name}"
                meta = result["meta"]
                manifest.append({
                    "kind": request.kind,
                    "name": request.name,
                    "status": "saved",
                    "file": str(target),
                    "sha256": result["sha256"],
                    "width": result["width"],
                    "height": result["height"],
                    "candidate_title": result["page"].get("title", ""),
                    "search_query": result["query"],
                    "commons_page": result["info"].get("descriptionurl", ""),
                    "original_url": result["original_url"],
                    "thumbnail_url": result["thumbnail_url"],
                    "download_url": result["download_url"],
                    "original_mime": result["original_mime"],
                    "download_mime": result["download_mime"],
                    "author": metadata_value(meta, "Artist"),
                    "license": metadata_value(meta, "LicenseShortName"),
                    "license_url": metadata_value(meta, "LicenseUrl"),
                    "usage_terms": metadata_value(meta, "UsageTerms"),
                    "attribution": metadata_value(meta, "Attribution"),
                    "credit": metadata_value(meta, "Credit"),
                    "description": metadata_value(meta, "ImageDescription"),
                })
                status, detail = "saved", str(target)
                print("SAVED")
        except Exception as exc:
            status, detail = "error", f"{type(exc).__name__}: {exc}"
            print(f"ERROR ({detail})")
        finally:
            statuses.append({
                "kind": request.kind,
                "name": request.name,
                "status": status,
                "detail": detail,
                "candidates_inspected": inspected,
                "elapsed_seconds": f"{time.monotonic() - started:.2f}",
            })
        time.sleep(0.35)

    manifest_fields = [
        "kind", "name", "status", "file", "sha256", "width", "height",
        "candidate_title", "search_query", "commons_page", "original_url",
        "thumbnail_url", "download_url", "original_mime", "download_mime",
        "author", "license", "license_url", "usage_terms", "attribution",
        "credit", "description",
    ]
    write_csv(ROOT / "assets_manifest.csv", manifest, manifest_fields)
    write_csv(
        ROOT / "rejected_assets.csv",
        rejected,
        ["kind", "requested_name", "search_query", "candidate", "reason", "url"],
    )
    write_csv(
        ROOT / "asset_status.csv",
        statuses,
        ["kind", "name", "status", "detail", "candidates_inspected", "elapsed_seconds"],
    )
    failed = sum(row["status"] != "saved" for row in statuses)
    print(f"\nDone: {len(manifest)} saved, {failed} failed, {len(rejected)} candidates rejected -> {ROOT}")
    print("Review every image plus assets_manifest.csv before production use.")
    print("Automated watermark/OCR checks can produce both false positives and false negatives.")


if __name__ == "__main__":
    run()
