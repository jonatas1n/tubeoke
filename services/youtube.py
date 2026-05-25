import logging
import os

from googleapiclient.discovery import build

logger = logging.getLogger(__name__)

VIDEOS_CATEGORY_ID = "10"


def _get_api_key() -> str:
    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        raise RuntimeError(
            "GOOGLE_API_KEY não definido. Configure a variável de ambiente "
            "ou adicione-a ao arquivo .env."
        )
    return api_key


def search_youtube_videos(query: str, max_results: int = 5):
    try:
        youtube = build("youtube", "v3", developerKey=_get_api_key())

        request = youtube.search().list(
            q=query,
            part="snippet",
            type="video",
            videoCategoryId=VIDEOS_CATEGORY_ID,
            maxResults=max_results,
            regionCode="BR",
        )

        response = request.execute()

        return [
            {
                "id": item["id"]["videoId"],
                "titulo": item["snippet"]["title"],
                "canal": item["snippet"]["channelTitle"],
            }
            for item in response.get("items", [])
        ]

    except Exception:
        logger.exception("Erro na API do YouTube ao buscar query=%r", query)
        return None
