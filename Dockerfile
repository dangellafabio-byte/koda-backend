# Dockerfile per il backend FastAPI di Koda — versione ROOT del repo.
# Compatibile con Railway/Railpack, Render, Fly.io, qualunque PaaS Docker.
# Si aspetta che `backend/` contenga server.py, requirements.txt e sottocartelle.

FROM python:3.11-slim

WORKDIR /app

# Dipendenze di sistema essenziali
# - build-essential: per compilare wheels native (PyNaCl, numpy)
# - libsndfile1: dipendenza di pydub
# - ffmpeg/ffprobe: per decode mp3 → envelope ampiezza (orb reattivo)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libsndfile1 \
    ca-certificates \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Installa dipendenze Python (layer caching: requirements prima del codice)
COPY backend/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir \
        --extra-index-url https://d33sy5i8bnduwe.cloudfront.net/simple/ \
        -r /app/requirements.txt

# Copia solo il backend (escludiamo frontend, test_reports, ecc.)
COPY backend/ /app/

# Railway/Render iniettano PORT come variabile d'ambiente. Default 8001.
ENV PORT=8001
EXPOSE 8001

# Avvia uvicorn (1 worker per risparmiare RAM su Railway free tier).
# Timeout-keep-alive 30s perché lo streaming TTS può tenere connessioni aperte.
CMD uvicorn server:app --host 0.0.0.0 --port ${PORT:-8001} --workers 1 --timeout-keep-alive 30
