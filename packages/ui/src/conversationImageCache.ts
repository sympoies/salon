import { fetchConversationImage, type ConversationImageData } from "./conversationImageData.ts";

export interface ImageTarget { readonly machine: string; readonly history: string; readonly image: string }
type ReadyImage = Extract<ConversationImageData,{state:"ready"}>;
interface Observer { visible: boolean; readonly notify: (data: ConversationImageData) => void }
interface Entry {
  readonly key: string;
  readonly target: ImageTarget;
  readonly observers: Set<Observer>;
  data: ConversationImageData;
  controller?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  attempts: number;
}
const keyOf = (target: ImageTarget) => JSON.stringify([target.machine,target.history,target.image]);
const backoff = [1000,3000];

/** Shared by thumbnails and viewers; only eviction releases a cached object URL. */
export class ConversationImageCache {
  private readonly entries = new Map<string,Entry>();
  private readonly lru = new Map<Entry,ReadyImage>();
  private bytes = 0;
  private readonly maxCount: number;
  private readonly maxBytes: number;
  constructor(maxCount = 48, maxBytes = 64 * 1024 * 1024) {
    this.maxCount = maxCount;
    this.maxBytes = maxBytes;
  }

  peek(target: ImageTarget): ConversationImageData {
    return this.entries.get(keyOf(target))?.data ?? {state:"loading"};
  }

  clear() {
    const entries = [...this.entries.values()];
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.controller?.abort();
      entry.controller = undefined;
      entry.timer = undefined;
      entry.attempts = 0;
      this.evict(entry);
      if (entry.data.state !== "loading") this.publish(entry,{state:"loading"});
      if (!entry.observers.size) this.entries.delete(entry.key);
    }
  }

  reloadVisible() {
    for (const entry of this.entries.values()) {
      if (this.isVisible(entry) && entry.data.state === "loading") this.load(entry);
    }
  }

  watch(target: ImageTarget, notify: Observer["notify"]) {
    const key = keyOf(target);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {key,target,observers:new Set(),data:{state:"loading"},attempts:0};
      this.entries.set(key,entry);
    }
    const current = entry;
    const observer: Observer = {visible:false,notify};
    current.observers.add(observer);
    notify(current.data);
    return {
      setVisible:(visible: boolean) => {
        observer.visible = visible;
        if (visible) {
          this.touch(current);
          if (current.data.state === "loading") this.load(current);
        }
      },
      retry:() => {
        // Another observer may have completed the read before this click.
        if (current.controller || current.data.state === "ready") return;
        clearTimeout(current.timer); current.timer = undefined; current.attempts = 0;
        this.load(current);
      },
      update:(data: Exclude<ConversationImageData,{state:"ready"}>) => {
        this.evict(current);
        this.publish(current,data);
      },
      unsubscribe:() => {
        current.observers.delete(observer);
        if (current.observers.size) return;
        clearTimeout(current.timer); current.timer = undefined;
        current.controller?.abort();
        if (current.data.state !== "ready" && this.entries.get(key) === current) this.entries.delete(key);
      },
    };
  }

  private touch(entry: Entry) {
    const image = this.lru.get(entry);
    if (image) { this.lru.delete(entry); this.lru.set(entry,image); }
  }

  private publish(entry: Entry, data: ConversationImageData) {
    entry.data = data;
    entry.observers.forEach(observer => observer.notify(data));
  }

  private isVisible(entry: Entry) {
    return [...entry.observers].some(observer => observer.visible);
  }

  private evict(entry: Entry, state: "loading" | "error" = "loading") {
    const image = this.lru.get(entry);
    if (!image) return;
    this.lru.delete(entry); this.bytes -= image.blob.size;
    URL.revokeObjectURL(image.url);
    this.publish(entry,{state});
    if (!entry.observers.size && this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
  }

  private load(entry: Entry) {
    if (entry.controller || !entry.observers.size || this.entries.get(entry.key) !== entry) return;
    const controller = new AbortController();
    entry.controller = controller;
    this.publish(entry,{state:"loading"});
    void fetchConversationImage(entry.target.machine,entry.target.history,entry.target.image,controller.signal,
      () => this.isVisible(entry)).then(data => {
      if (entry.controller === controller) entry.controller = undefined;
      if (controller.signal.aborted) {
        if (data.state === "ready") URL.revokeObjectURL(data.url);
        return;
      }
      if (data.state === "ready") {
        entry.attempts = 0;
        this.lru.set(entry,data); this.bytes += data.blob.size;
        while (this.lru.size > this.maxCount || this.bytes > this.maxBytes) {
          const victim = [...this.lru.keys()].find(candidate => !this.isVisible(candidate)) ?? entry;
          // If every resident is visible, decline this new result with Retry
          // rather than revoke a displayed image or loop through more reads.
          this.evict(victim,this.isVisible(victim) ? "error" : "loading");
        }
        if (this.lru.has(entry)) this.publish(entry,data);
      } else {
        this.publish(entry,data);
        if (data.state === "error" && entry.attempts < backoff.length && entry.observers.size) {
          entry.timer = setTimeout(() => { entry.timer = undefined; this.load(entry); },backoff[entry.attempts++]!);
        }
      }
    });
  }
}

export const conversationImageCache = new ConversationImageCache();
