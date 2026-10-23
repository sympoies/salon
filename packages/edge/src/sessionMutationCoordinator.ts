interface SessionCoordinationState {
  epoch: number;
  tail: Promise<void>;
  pendingOperations: number;
  pendingPreviews: number;
}

interface PreviewRequest<T> {
  readonly epoch: number;
  readonly request: Promise<T>;
}

export class SessionMutationCoordinator<TPreview> {
  readonly #sessions = new Map<string, SessionCoordinationState>();
  readonly #previews = new Map<string, PreviewRequest<TPreview>>();

  get pendingSessionCount(): number {
    return this.#sessions.size;
  }

  get pendingPreviewCount(): number {
    return this.#previews.size;
  }

  serializeMutation<T>(key: string, action: () => Promise<T>): Promise<T> {
    return this.#serialize(key, action, true);
  }

  coalescePreview(
    cacheKey: string,
    sessionKey: string,
    action: () => Promise<TPreview>,
  ): Promise<TPreview> {
    const epoch = this.#sessions.get(sessionKey)?.epoch ?? 0;
    const current = this.#previews.get(cacheKey);
    if (current?.epoch === epoch) return current.request;

    const request = this.#serialize(sessionKey, action, false);
    const state = this.#sessions.get(sessionKey)!;
    state.pendingPreviews += 1;
    this.#previews.set(cacheKey, { epoch, request });
    void request.finally(() => {
      state.pendingPreviews -= 1;
      if (this.#previews.get(cacheKey)?.request === request) {
        this.#previews.delete(cacheKey);
      }
      this.#deleteIfIdle(sessionKey, state);
    }).catch(() => undefined);
    return request;
  }

  #serialize<T>(
    key: string,
    action: () => Promise<T>,
    invalidatesPreview: boolean,
  ): Promise<T> {
    const state = this.#sessions.get(key) ?? {
      epoch: 0,
      tail: Promise.resolve(),
      pendingOperations: 0,
      pendingPreviews: 0,
    };
    this.#sessions.set(key, state);
    if (invalidatesPreview) state.epoch += 1;
    state.pendingOperations += 1;

    const result = state.tail.catch(() => undefined).then(action);
    state.tail = result.then(() => undefined, () => undefined);
    void state.tail.then(() => {
      state.pendingOperations -= 1;
      this.#deleteIfIdle(key, state);
    });
    return result;
  }

  #deleteIfIdle(key: string, state: SessionCoordinationState): void {
    if (
      state.pendingOperations === 0
      && state.pendingPreviews === 0
      && this.#sessions.get(key) === state
    ) {
      this.#sessions.delete(key);
    }
  }
}
