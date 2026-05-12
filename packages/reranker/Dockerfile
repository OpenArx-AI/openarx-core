# Stage 1: Convert PyTorch model → ONNX (needs torch, discarded after)
FROM python:3.11-slim-bookworm AS builder

WORKDIR /build

RUN pip install --no-cache-dir \
    torch==2.5.1 --index-url https://download.pytorch.org/whl/cpu && \
    pip install --no-cache-dir \
    transformers==4.45.2 \
    optimum==1.24.0 \
    onnx onnxruntime

# Export to ONNX with O2 optimization (graph optimizations + constant folding)
RUN optimum-cli export onnx \
    --model BAAI/bge-reranker-v2-m3 \
    --task text-classification \
    --optimize O2 \
    /build/model-onnx/

# Stage 2: Runtime (ONNX Runtime only — no PyTorch, no CUDA)
FROM python:3.11-slim-bookworm

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
    onnxruntime==1.21.1 \
    optimum[onnxruntime]==1.24.0 \
    transformers==4.45.2 \
    fastapi==0.115.6 \
    uvicorn==0.34.0

# Copy only the ONNX model from builder (no PyTorch weights)
COPY --from=builder /build/model-onnx/ /app/model-onnx/

COPY server.py .

EXPOSE 8091

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8091"]
