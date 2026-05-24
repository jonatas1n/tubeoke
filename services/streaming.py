import os
import time
from typing import Any, Optional

from yt_dlp import YoutubeDL

_URL_CACHE_TTL_SECONDS = 60 * 30
_url_cache: dict[str, tuple[str, float]] = {}

_YOUTUBE_PLAYER_CLIENTS = [
    "tv_embedded",
    "mediaconnect",
    "android_creator",
    "android_vr",
]
_OPUS_BONUS_KBPS = 20


def _resolve_cookie_options() -> dict[str, Any]:
    cookie_file = os.getenv("YTDLP_COOKIES_FILE")
    if cookie_file:
        return {"cookiefile": cookie_file}

    cookie_browser = os.getenv("YTDLP_COOKIES_BROWSER")
    if cookie_browser:
        return {"cookiesfrombrowser": (cookie_browser.strip().lower(),)}

    return {}


def _build_ydl_options() -> dict[str, Any]:
    return {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "extractor_args": {
            "youtube": {
                "player_client": _YOUTUBE_PLAYER_CLIENTS,
            },
        },
        **_resolve_cookie_options(),
    }


def _get_cached_url(video_id: str) -> Optional[str]:
    cached = _url_cache.get(video_id)
    if not cached:
        return None

    url, expires_at = cached
    if expires_at <= time.time():
        return None

    return url


def _store_url(video_id: str, url: str) -> None:
    expires_at = time.time() + _URL_CACHE_TTL_SECONDS
    _url_cache[video_id] = (url, expires_at)


def _is_audio_only(fmt: dict[str, Any]) -> bool:
    vcodec = fmt.get("vcodec")
    acodec = fmt.get("acodec")
    has_video = bool(vcodec) and vcodec != "none"
    has_audio = bool(acodec) and acodec != "none"
    return has_audio and not has_video


def _audio_sort_key(fmt: dict[str, Any]) -> tuple[int, int]:
    abr = int(fmt.get("abr") or 0)
    is_opus = fmt.get("acodec") == "opus"
    weighted = abr + (_OPUS_BONUS_KBPS if is_opus else 0)
    return weighted, abr


def _select_best_audio(formats: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    candidates = [fmt for fmt in formats if _is_audio_only(fmt) and fmt.get("url")]
    if not candidates:
        return None

    candidates.sort(key=_audio_sort_key, reverse=True)
    return candidates[0]


def _extract_audio_url(video_id: str) -> str:
    youtube_url = f"https://www.youtube.com/watch?v={video_id}"

    try:
        with YoutubeDL(_build_ydl_options()) as ydl:
            info = ydl.extract_info(youtube_url, download=False)
    except Exception as error:
        print(f"Falha ao extrair áudio para {video_id}: {error}")
        raise

    formats = info.get("formats") or []
    audio_format = _select_best_audio(formats)

    if not audio_format:
        raise RuntimeError(f"yt-dlp não encontrou formato de áudio para {video_id}")

    return audio_format["url"]


def get_audio_stream_url(video_id: str) -> str:
    cached = _get_cached_url(video_id)
    if cached:
        return cached

    audio_url = _extract_audio_url(video_id)
    _store_url(video_id, audio_url)
    return audio_url
