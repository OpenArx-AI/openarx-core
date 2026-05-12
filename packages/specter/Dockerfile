FROM python:3.11-slim-bookworm

WORKDIR /app

# Install curl for healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
# Install PyTorch CPU-only first (saves ~4GB vs full CUDA build)
RUN pip install --no-cache-dir torch==2.5.1 --index-url https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir -r requirements.txt

# Download models at build time so they're cached in the image
RUN python -c "from transformers import AutoTokenizer; AutoTokenizer.from_pretrained('allenai/specter2_base')"
RUN python -c "from adapters import AutoAdapterModel; m = AutoAdapterModel.from_pretrained('allenai/specter2_base'); m.load_adapter('allenai/specter2', source='hf')"

COPY server.py .

EXPOSE 8090

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8090", "--workers", "2"]
