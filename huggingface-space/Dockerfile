FROM python:3.11-slim

# Install system dependencies: aria2 (downloader) + ffmpeg (HLS muxer)
RUN apt-get update && apt-get install -y --no-install-recommends \
    aria2 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application
COPY app.py .

# HuggingFace Spaces runs as non-root user
RUN useradd -m -u 1000 user && chown -R user:user /app
USER user

EXPOSE 7860

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860", "--workers", "1"]
