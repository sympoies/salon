import { resolveLocalStorage, safeGetItem, safeSetItem, type StorageLike } from "./storage.ts";

export type CardPreview = "latest-message" | "last-prompt";
const CARD_PREVIEW_STORAGE_KEY = "ac.cardPreview";

export function loadCardPreview(storage?: StorageLike): CardPreview {
  return safeGetItem(resolveLocalStorage(storage), CARD_PREVIEW_STORAGE_KEY) === "last-prompt"
    ? "last-prompt" : "latest-message";
}

export function saveCardPreview(preview: CardPreview, storage?: StorageLike): boolean {
  return safeSetItem(resolveLocalStorage(storage), CARD_PREVIEW_STORAGE_KEY, preview);
}
