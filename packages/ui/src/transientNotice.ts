import { createContext } from "react";
import type { StatusNotice } from "./statusNoticeModel.ts";

/**
 * Shows a short-lived result in the shared top-right notice layer, where connection changes appear.
 * The dashboard provides this; outside it, nothing is shown.
 */
export interface TransientNoticeControl {
  show(notice: StatusNotice): void;
}

export const TransientNoticeContext = createContext<TransientNoticeControl>({ show() {} });

/** How long a transient result stays in the shared layer. */
export const TRANSIENT_NOTICE_MS = 3_000;
