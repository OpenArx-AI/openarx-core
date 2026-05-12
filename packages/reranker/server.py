"""BGE Reranker microservice for OpenArx (ONNX Runtime).

Loads BAAI/bge-reranker-v2-m3 via ONNX Runtime for fast CPU inference.
Takes (query, passages) pairs, returns relevance scores.

ONNX Runtime gives 5-10x speedup over PyTorch on CPU.
Model converted to ONNX at Docker build time via optimum-cli.
"""

import logging
import os
from contextlib import asynccontextmanager
from typing import Optional

import numpy as np
from fastapi import FastAPI
from optimum.onnxruntime import ORTModelForSequenceClassification
from pydantic import BaseModel, Field
from transformers import AutoTokenizer

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

MODEL_DIR = os.environ.get("MODEL_DIR", "/app/model-onnx")
MAX_LENGTH = 512
DEFAULT_BATCH_SIZE = 16

tokenizer = None
model = None


def load_model():
    global tokenizer, model
    logger.info("Loading ONNX model from %s", MODEL_DIR)
    tokenizer = AutoTokenizer.from_pretrained(MODEL_DIR)
    model = ORTModelForSequenceClassification.from_pretrained(MODEL_DIR)
    logger.info("Model ready (ONNX Runtime)")


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_model()
    yield


app = FastAPI(title="BGE Reranker Service (ONNX)", lifespan=lifespan)


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))


class RerankRequest(BaseModel):
    query: str
    passages: list[str]
    batch_size: Optional[int] = Field(default=DEFAULT_BATCH_SIZE, ge=1, le=256)


class RerankResult(BaseModel):
    index: int
    score: float


class RerankResponse(BaseModel):
    scores: list[RerankResult]
    model: str


class HealthResponse(BaseModel):
    status: str
    model: str
    runtime: str


@app.post("/rerank", response_model=RerankResponse)
async def rerank(request: RerankRequest):
    batch_size = request.batch_size or DEFAULT_BATCH_SIZE
    pairs = [[request.query, passage] for passage in request.passages]
    all_scores: list[float] = []

    for i in range(0, len(pairs), batch_size):
        batch = pairs[i : i + batch_size]
        inputs = tokenizer(
            batch,
            padding=True,
            truncation=True,
            max_length=MAX_LENGTH,
            return_tensors="np",
        )
        outputs = model(**inputs)
        logits = outputs.logits.squeeze(-1)
        scores = sigmoid(logits)
        if scores.ndim == 0:
            all_scores.append(float(scores))
        else:
            all_scores.extend(scores.tolist())

    results = [
        RerankResult(index=i, score=s)
        for i, s in sorted(enumerate(all_scores), key=lambda x: x[1], reverse=True)
    ]

    return RerankResponse(scores=results, model="bge-reranker-v2-m3-onnx")


@app.get("/health", response_model=HealthResponse)
async def health():
    if model is None:
        return HealthResponse(status="loading", model="bge-reranker-v2-m3", runtime="onnx")
    return HealthResponse(status="ok", model="bge-reranker-v2-m3", runtime="onnx")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8091)
