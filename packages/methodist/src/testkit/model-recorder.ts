// Recorded/scripted model client for model-call tests (runtime §7): assert the
// SHAPE of the output and mode branches, never the substance of a judgment. A
// scripted Error simulates a technical fault (retried); a RuntimeError with a
// rejected code simulates a contract fault (not retried).

import type { ModelClient, ModelRequest, ModelResponse } from '../runtime/model-client.js';

export class RecordedModelClient implements ModelClient {
  private i = 0;
  readonly requests: ModelRequest[] = [];

  constructor(private readonly script: Array<ModelResponse | Error>) {}

  async generate(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(req);
    const item = this.script[Math.min(this.i, this.script.length - 1)];
    this.i++;
    if (item instanceof Error) throw item;
    return item;
  }

  /** Number of times generate() was called. */
  get calls(): number {
    return this.i;
  }
}
