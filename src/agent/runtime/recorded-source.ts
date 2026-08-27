import type { RecordedModelResponse } from "../../replay/schema.js";
import { ModelSourceExhaustedError, ModelSourceFailedError } from "./model-errors.js";
import type { AgentModelRequest, ModelResponseSource } from "./model.js";

/** A no-network source backed by the model responses in one recorded turn. */
export class RecordedModelResponseSource implements ModelResponseSource {
  private readonly responses: readonly RecordedModelResponse[];
  private responseIndex = 0;

  constructor(responses: readonly RecordedModelResponse[]) {
    this.responses = responses.map((response) => ({ ...response }));
  }

  requestModel(request: AgentModelRequest): Promise<RecordedModelResponse> {
    const response = this.responses[this.responseIndex];
    if (response === undefined) {
      throw new ModelSourceExhaustedError({
        detail: `recorded model response source exhausted after ${this.responseIndex} response(s)`,
      });
    }
    this.responseIndex += 1;
    if (response.requestId !== request.requestId) {
      throw new ModelSourceFailedError({
        detail: `recorded response ${this.responseIndex} belongs to request ${JSON.stringify(response.requestId)}, not ${JSON.stringify(request.requestId)}`,
      });
    }
    return Promise.resolve(response);
  }
}
