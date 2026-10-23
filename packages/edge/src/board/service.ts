import type { EdgeConfig } from "../config.ts";
import { BoardAggregator } from "./ingest.ts";
import type { BoardRetention } from "./record.ts";
import { BoardStore } from "./store.ts";

export interface BoardService {
  readonly store: BoardStore;
  readonly aggregator: BoardAggregator;
  readonly retention: BoardRetention;
  readonly now: () => number;
  readonly close: () => Promise<void>;
}

export interface BoardServiceOptions {
  readonly now?: () => number;
  // Tests seed board.sqlite and query it without background ingestion.
  readonly autoStart?: boolean;
}

/**
 * Opens board.sqlite and starts ingestion when the board is configured. A store
 * that cannot be opened disables the board instead of failing the edge: board
 * data is rebuildable observation data, never a startup dependency.
 */
export function openBoardService(config: EdgeConfig, options: BoardServiceOptions = {}): BoardService | null {
  if (!config.board) return null;
  let store: BoardStore;
  try {
    store = new BoardStore(config.board.dbPath);
  } catch {
    console.error("session board store is unavailable; the board is disabled");
    return null;
  }
  const now = options.now ?? Date.now;
  const aggregator = new BoardAggregator(store, config.machines, { retention: config.board.retention, now });
  if (options.autoStart !== false) aggregator.start();
  return {
    store,
    aggregator,
    retention: config.board.retention,
    now,
    close: async () => {
      await aggregator.stop();
      store.close();
    },
  };
}
