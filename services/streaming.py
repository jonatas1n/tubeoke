import os
import time
from typing import Any, Optional

from yt_dlp import YoutubeDL

_URL_CACHE_TTL_SECONDS = 60 * 30
_url_cache: dict[str, tuple[str, float]] = {}

_YOUTUBE_PLAYER_CLIENTS = ["tv_embedded", "mweb", "ios", "android", "web_safari"]


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
        "format": "bestaudio/best",
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


def get_audio_stream_url(video_id: str) -> str:
    cached_url = _get_cached_url(video_id)
    if cached_url:
        return cached_url

    youtube_url = f"https://www.youtube.com/watch?v={video_id}"

    try:
        with YoutubeDL(_build_ydl_options()) as ydl:
            info = ydl.extract_info(youtube_url, download=False)
    except Exception as error:
        print(f"Falha ao extrair áudio para {video_id}: {error}")
        raise

    audio_url = info.get("url")
    if not audio_url:
        raise RuntimeError(f"yt-dlp não retornou URL de áudio para {video_id}")

    _store_url(video_id, audio_url)
    return audio_url
