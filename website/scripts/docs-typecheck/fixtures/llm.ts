// Huddle's one call to the model: yields text pieces, and stops early when `signal` aborts.
export declare const llm: {
  stream(request: {
    messages: readonly { role: string; text: string }[];
    signal?: AbortSignal;
  }): AsyncIterable<string>;
};
