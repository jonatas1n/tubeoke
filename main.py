from pathlib import Path

import httpx
from fastapi import FastAPI, Request, Query, HTTPException
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from dotenv import load_dotenv

from services.streaming import get_audio_stream_url
from services.youtube import search_youtube_videos

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))

app = FastAPI(
    title="Tubeoke API",
    description="API para busca de vídeos musicais no YouTube.",
    version="0.1.0",
)

app.mount(
    "/assets",
    StaticFiles(directory=str(BASE_DIR / "assets")),
    name="assets",
)

def adjust_query(query: str) -> str:
    query = query.lower()
    query = query.replace("karaoke", "")
    query = query.replace("karaokê", "")
    query = query.strip()
    return query + " karaoke"


@app.get("/", response_class=HTMLResponse, tags=["pages"])
def index(request: Request):
    return templates.TemplateResponse(
        request,
        "index.html",
    )


@app.get("/search", response_class=HTMLResponse, tags=["pages"])
def search_videos(
    request: Request,
    q: str = Query(..., min_length=1, description="Termo de busca"),
    max_results: int = Query(
        5, ge=1, le=50, description="Quantidade máxima de resultados"
    ),
):
    adjusted_query = adjust_query(q)

    videos = search_youtube_videos(query=adjusted_query, max_results=max_results)

    if videos is None:
        raise HTTPException(
            status_code=502, detail="Falha ao consultar a API do YouTube."
        )

    return templates.TemplateResponse(
        request,
        "results.html",
        {"videos": videos, "q": q},
    )


@app.get("/play/{video_id}", response_class=HTMLResponse, tags=["play"])
def play_video(request: Request, video_id: str):
    return templates.TemplateResponse(
        request,
        "play.html",
        {"video_id": video_id},
    )


@app.get("/stream/{video_id}", tags=["stream"])
async def stream_audio(request: Request, video_id: str):
    try:
        audio_url = get_audio_stream_url(video_id)
    except Exception as error:
        raise HTTPException(
            status_code=502,
            detail="Falha ao extrair o áudio do vídeo.",
        ) from error

    upstream_headers = {}
    range_header = request.headers.get("range")
    if range_header:
        upstream_headers["Range"] = range_header

    client = httpx.AsyncClient(timeout=None, follow_redirects=True)

    try:
        upstream_request = client.build_request(
            "GET", audio_url, headers=upstream_headers
        )
        upstream_response = await client.send(upstream_request, stream=True)
    except Exception as error:
        await client.aclose()
        raise HTTPException(
            status_code=502,
            detail="Falha ao conectar no servidor de áudio do YouTube.",
        ) from error

    forwarded_headers = {
        "Accept-Ranges": "bytes",
        "Content-Type": upstream_response.headers.get("content-type", "audio/webm"),
        "Cache-Control": "no-store",
    }
    for header_name in ("content-length", "content-range"):
        if header_name in upstream_response.headers:
            forwarded_headers[header_name.title()] = upstream_response.headers[header_name]

    async def audio_iterator():
        try:
            async for chunk in upstream_response.aiter_raw(8192):
                yield chunk
        finally:
            await upstream_response.aclose()
            await client.aclose()

    return StreamingResponse(
        audio_iterator(),
        status_code=upstream_response.status_code,
        headers=forwarded_headers,
    )


@app.get("/health", tags=["health"])
def health_check():
    return {"status": "ok"}
