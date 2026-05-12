import { QdrantClient } from '@qdrant/js-client-rest';

const COLLECTION_NAME = 'chunks';
const QDRANT_URL = process.env.QDRANT_URL ?? 'http://localhost:6333';

async function run(): Promise<void> {
  const client = new QdrantClient({
    url: QDRANT_URL,
    ...(process.env.QDRANT_API_KEY ? { apiKey: process.env.QDRANT_API_KEY } : {}),
  });

  // Check if collection already exists
  const collections = await client.getCollections();
  const exists = collections.collections.some(
    (c) => c.name === COLLECTION_NAME,
  );

  if (exists) {
    console.log(`Collection "${COLLECTION_NAME}" already exists, skipping.`);
  } else {
    console.log(`Creating collection "${COLLECTION_NAME}"...`);
    await client.createCollection(COLLECTION_NAME, {
      vectors: {
        gemini: { size: 3072, distance: 'Cosine' },
        specter2: { size: 768, distance: 'Cosine' },
      },
    });
    console.log('Collection created.');
  }

  // Create payload indexes (idempotent)
  console.log('Ensuring payload indexes...');

  const indexes: Array<{
    field: string;
    schema: 'keyword' | 'integer' | 'float' | 'datetime' | 'bool';
  }> = [
    { field: 'document_id', schema: 'keyword' },
    { field: 'document_title', schema: 'keyword' },
    { field: 'section_title', schema: 'keyword' },
    { field: 'section_path', schema: 'keyword' },
    { field: 'categories', schema: 'keyword' },
    { field: 'published_at', schema: 'datetime' },
    // F3 versioning
    { field: 'is_latest', schema: 'bool' },
    { field: 'concept_id', schema: 'keyword' },
    { field: 'version', schema: 'integer' },
  ];

  for (const { field, schema } of indexes) {
    try {
      await client.createPayloadIndex(COLLECTION_NAME, {
        field_name: field,
        field_schema: schema,
      });
      console.log(`  [created] ${field} (${schema})`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('already exists')) {
        console.log(`  [exists] ${field} (${schema})`);
      } else {
        throw err;
      }
    }
  }

  console.log('Qdrant setup complete.');
}

run().catch((err) => {
  console.error('Qdrant setup failed:', err);
  process.exit(1);
});
