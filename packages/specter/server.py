"""SPECTER2 embedding microservice for OpenArx.

Loads allenai/specter2_base with the proximity adapter and serves
768-dimensional scientific paper embeddings via HTTP.
"""

import logging
from contextlib import asynccontextmanager
from typing import Optional

import torch
from adapters import AutoAdapterModel
from fastapi import FastAPI
from pydantic import BaseModel, Field
from transformers import AutoTokenizer

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

MODEL_NAME = "allenai/specter2_base"
ADAPTER_NAME = "allenai/specter2"
DIMENSIONS = 768
MAX_LENGTH = 512
DEFAULT_BATCH_SIZE = 32

tokenizer = None
model = None


def load_model():
    global tokenizer, model
    logger.info("Loading tokenizer: %s", MODEL_NAME)
    tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
    logger.info("Loading model: %s", MODEL_NAME)
    model = AutoAdapterModel.from_pretrained(MODEL_NAME)
    logger.info("Loading adapter: %s", ADAPTER_NAME)
    model.load_adapter(ADAPTER_NAME, source="hf", set_active=True)
    model.eval()
    logger.info("Model ready (dimensions=%d)", DIMENSIONS)


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_model()
    yield


app = FastAPI(title="SPECTER2 Embedding Service", lifespan=lifespan)


class EmbedRequest(BaseModel):
    texts: list[str]
    batch_size: Optional[int] = Field(default=DEFAULT_BATCH_SIZE, ge=1, le=256)


class EmbedResponse(BaseModel):
    vectors: list[list[float]]
    dimensions: int
    model: str


class HealthResponse(BaseModel):
    status: str
    model: str


@app.post("/embed", response_model=EmbedResponse)
def embed(request: EmbedRequest):
    batch_size = request.batch_size or DEFAULT_BATCH_SIZE
    all_vectors: list[list[float]] = []

    for i in range(0, len(request.texts), batch_size):
        batch = request.texts[i : i + batch_size]
        inputs = tokenizer(
            batch,
            padding=True,
            truncation=True,
            max_length=MAX_LENGTH,
            return_tensors="pt",
        )
        with torch.no_grad():
            outputs = model(**inputs)
        # Use CLS token embedding
        embeddings = outputs.last_hidden_state[:, 0, :]
        all_vectors.extend(embeddings.tolist())

    return EmbedResponse(vectors=all_vectors, dimensions=DIMENSIONS, model=ADAPTER_NAME)


@app.get("/health", response_model=HealthResponse)
async def health():
    if model is None:
        return HealthResponse(status="loading", model=ADAPTER_NAME)
    return HealthResponse(status="ok", model=ADAPTER_NAME)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8090)
