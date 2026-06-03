# Dockerfile per il backend FastAPI di Koda.
# Compatibile con Railway, Render, Fly.io, qualunque PaaS che supporta Docker.

FROM python:3.11-slim

WORKDIR /app

# Dipendenze di sistema essenziali
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libsndfile1 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Installa dipendenze Python (layer caching: requirements prima del codice)
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir \
        --extra-index-url https://d33sy5i8bnduwe.cloudfront.net/simple/ \
        -r requirements.txt

# Copia codice applicativo
COPY . .

# Railway/Render iniettano PORT come variabile d'ambiente. Default 8001.
ENV PORT=8001
EXPOSE 8001

# Avvia uvicorn (1 worker per risparmiare RAM su Railway free tier)
CMD uvicorn server:app --host 0.0.0.0 --port ${PORT:-8001} --workers 1 --timeout-keep-alive 30
