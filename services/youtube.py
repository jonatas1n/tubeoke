import os

from googleapiclient.discovery import build

API_KEY = os.getenv("GOOGLE_API_KEY")
VIDEOS_CATEGORY_ID = "10"


def search_youtube_videos(query: str, max_results: int = 5):
    youtube = build("youtube", "v3", developerKey=API_KEY)

    try:
        request = youtube.search().list(
            q=query,
            part="snippet",
            type="video",
            videoCategoryId=VIDEOS_CATEGORY_ID,
            maxResults=max_results,
            regionCode="BR",
        )

        response = request.execute()

        videos = []
        for item in response.get("items", []):
            videos.append(
                {
                    "id": item["id"]["videoId"],
                    "titulo": item["snippet"]["title"],
                    "canal": item["snippet"]["channelTitle"],
                }
            )

        return videos

    except Exception as e:
        print(f"Ocorreu um erro na API: {e}")
        return None
