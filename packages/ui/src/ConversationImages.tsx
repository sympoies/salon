import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { sanitizeAttachmentName, type ConversationImage } from "@agent-console/shared/conversation-images";
import { Modal } from "./Modal.tsx";
import { fetchConversationImage, type ConversationImageData } from "./conversationImageData.ts";
import { conversationImageCache, type ImageTarget } from "./conversationImageCache.ts";
import { saveConversationImage } from "./saveConversationImage.ts";
import { copyConversationImage } from "./copyConversationImage.ts";
import { openExternalTerminalUrl, validateTerminalUrl } from "./terminalLinks.ts";
import { isMacTauri } from "./runtime.ts";
import { writeTerminalClipboardText } from "./terminalClipboard.ts";
import { IconButton } from "./IconButton.tsx";
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon, DownloadIcon, FitImageIcon, ZoomInIcon, ZoomOutIcon } from "./icons.tsx";
import "./ConversationImages.css";

function useImage(target: ImageTarget, visible: boolean) {
  const key = JSON.stringify([target.machine,target.history,target.image]);
  const [snapshot,setSnapshot] = useState(() => ({key,data:conversationImageCache.peek(target)}));
  const watch = useRef<ReturnType<typeof conversationImageCache.watch> | null>(null);
  useEffect(() => {
    const current = conversationImageCache.watch(target,data => setSnapshot({key,data}));
    watch.current = current;
    return () => { current.unsubscribe(); watch.current = null; };
  },[target.machine,target.history,target.image,key]);
  useEffect(() => { watch.current?.setVisible(visible); },[target.machine,target.history,target.image,visible]);
  return {data:snapshot.key === key ? snapshot.data : conversationImageCache.peek(target),
    retry:() => watch.current?.retry(),
    unavailable:(data: Exclude<ConversationImageData,{state:"ready"}>) => watch.current?.update(data),
    fail:() => watch.current?.update({state:"error"})};
}
function RetryImage({retry}: { readonly retry: () => void }) {
  return <button type="button" className="conversation-image-retry" onClick={event => { event.stopPropagation(); retry(); }}>Retry</button>;
}
const remoteReasons: Record<string,string> = {
  "invalid-url":"Invalid image URL", "blocked-address":"Address blocked", "too-many-redirects":"Too many redirects",
  "upstream-status":"Image server refused the request", "too-large":"Image is too large", "timeout":"Request timed out",
  "not-image":"Response is not an image", "network":"Network error", "busy":"Image service is busy",
};
const remoteReasonText = (reason: string) => Object.hasOwn(remoteReasons,reason) ? remoteReasons[reason] : "Image could not be loaded";
function ExternalImage({url,origin,reason}: { readonly url?: string; readonly origin?: string; readonly reason?: string }) {
  return <div className="conversation-external-image">
    <span role="status">External image, not loaded{origin ? ` · ${origin}` : ""}{reason ? ` · ${Object.hasOwn(remoteReasons,reason) ? remoteReasons[reason] : "Image could not be loaded"}` : ""}</span>
    {url ? <a href={url} target="_blank" rel="noopener noreferrer"
      onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
      onClick={event => {
        event.preventDefault(); event.stopPropagation();
        void openExternalTerminalUrl(url);
      }}>Open link</a> : null}
  </div>;
}
function ImageContent({data,fail,onLoad,retry,sourceName,sourceUrl}: { readonly sourceUrl?: string; readonly data: ConversationImageData; readonly fail: () => void; readonly sourceName?: string;
  readonly onLoad?: (image: HTMLImageElement) => void; readonly retry?: () => void }) {
  if (data.state === "unavailable" && (data.reason === "remote-url-not-fetched" || sourceUrl))
    return <ExternalImage url={sourceUrl} reason={data.remoteReason} origin={data.reason === "remote-url-not-fetched" ? data.sourceOrigin : sourceUrl ? new URL(sourceUrl).origin : undefined} />;
  const unavailable = data.state === "unavailable" && data.reason === "outside-allowed-roots"
    ? `Not shared: outside the session folder${sourceName ? ` · ${sourceName}` : ""}` : "Image unavailable";
  return data.state === "ready" ? <img src={data.url} alt="Conversation attachment" draggable={false} onError={fail} onLoad={event => onLoad?.(event.currentTarget)} />
    : <span role="status">{data.state === "deleted" ? "Image deleted" : data.state === "unavailable" ? unavailable : data.state === "error" ? `Couldn't load${data.remoteReason ? ` · ${remoteReasonText(data.remoteReason)}` : ""}` : "Loading image…"}
      {data.state === "error" && retry ? <RetryImage retry={retry} /> : null}</span>;
}
type ReadyImage = Extract<ConversationImageData,{state:"ready"}>;
interface MenuState { readonly index: number; readonly x: number; readonly y: number; readonly image: ReadyImage }
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The macOS shell's own menu for an image: only actions that work there. */
function ImageMenu({menu,paths,uploadPath,onOpen,onClose,onError}: {
  readonly menu: MenuState; readonly paths: readonly string[]; readonly uploadPath?: string;
  readonly onOpen: (index: number) => void; readonly onClose: () => void; readonly onError: (message: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Runtimes before nils-cli 1.40.12 supply only the quoted-text fallback.
  const path = uploadPath ?? paths.find(candidate => baseName(candidate) === menu.image.filename);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const away = (event: Event) => { if (!ref.current?.contains(event.target as Node)) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    document.addEventListener("pointerdown",away,true);
    document.addEventListener("keydown",key,true);
    window.addEventListener("blur",onClose);
    return () => { document.removeEventListener("pointerdown",away,true); document.removeEventListener("keydown",key,true); window.removeEventListener("blur",onClose); };
  },[onClose]);
  // Run the action inside the click itself: the clipboard needs the user gesture.
  const run = (action: () => Promise<void> | void, failure: string) => () => {
    onClose();
    try { void Promise.resolve(action()).catch(() => onError(failure)); } catch { onError(failure); }
  };
  const items: Array<[string,() => void]> = [
    ["Copy image",run(() => copyConversationImage(menu.image.blob),"Image could not be copied")],
    ["Save image",run(() => saveConversationImage(menu.image.blob,menu.image.filename,menu.image.url),"Image could not be saved")],
    ["Open in image viewer",() => { onClose(); onOpen(menu.index); }],
    ...(path ? [["Copy file path",run(() => writeTerminalClipboardText(path),"File path could not be copied")] as [string,() => void]] : []),
  ];
  return createPortal(<div ref={ref} className="conversation-image-menu" role="menu" aria-label="Image actions"
    style={{left:Math.min(menu.x,window.innerWidth - 200),top:Math.min(menu.y,window.innerHeight - 160)}}>
    {items.map(([label,action]) => <button key={label} type="button" role="menuitem" onClick={action}>{label}</button>)}
  </div>,document.body);
}

function Thumbnail({target,index,onOpen,onMenu,sourceName,sourceUrl}: { readonly sourceUrl?: string; readonly sourceName?: string; readonly target: ImageTarget; readonly index: number; readonly onOpen: () => void; readonly onMenu: (menu: MenuState) => void }) {
  // The shared descriptor is ID-only. Retain decoded dimensions when lazy
  // loading restarts so a known image keeps its place in the conversation.
  const [size,setSize] = useState<{width:number;height:number} | null>(null);
  const [visible,setVisible] = useState(typeof IntersectionObserver === "undefined");
  // A callback ref observes whichever frame element is rendered, so a frame
  // that swapped branches (external tile back to loading) is observed again.
  const observer = useRef<IntersectionObserver | null>(null);
  const frame = useCallback((element: HTMLButtonElement | null) => {
    observer.current?.disconnect(); observer.current = null;
    if (!element || typeof IntersectionObserver === "undefined") return;
    observer.current = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)),{rootMargin:"128px"});
    observer.current.observe(element);
  },[]);
  const {data,fail,retry} = useImage(target,visible);
  const sizing = size ? {"--image-width":`${size.width}px`,"--image-ratio":size.width / size.height} as CSSProperties : undefined;
  // The macOS shell's native web view menu offers commands it cannot run; show
  // our own there. Browsers and Android keep theirs.
  const contextMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (!isMacTauri()) return;
    event.preventDefault();
    if (data.state === "ready") onMenu({index,x:event.clientX,y:event.clientY,image:data});
  };
  if (data.state === "unavailable" && (data.reason === "remote-url-not-fetched" || sourceUrl)) return <div className="conversation-image-frame">
    <div className="conversation-image-thumbnail is-external"><ImageContent data={data} fail={fail} sourceUrl={sourceUrl} /></div>
  </div>;
  return <div className="conversation-image-frame"><button ref={frame} style={sizing} className="conversation-image-thumbnail" type="button" aria-label={`Open image ${index + 1}`} onClick={event => { event.stopPropagation(); onOpen(); }} onContextMenu={contextMenu}>
    <ImageContent data={data} fail={fail} sourceName={sourceName} onLoad={image => {
      if (image.naturalWidth && image.naturalHeight) setSize({width:image.naturalWidth,height:image.naturalHeight});
    }} />
  </button>{data.state === "error" ? <RetryImage retry={retry} /> : null}</div>;
}
const clampZoom = (scale: number) => Math.max(1,Math.min(6,scale));
interface Point { x: number; y: number }

function ImageViewer({machine,history,images,initial,onClose,sourceNames,sourceUrls}: {
  readonly sourceUrls: readonly (string | undefined)[];
  readonly sourceNames: readonly (string | undefined)[];
  readonly machine: string; readonly history: string; readonly images: readonly ConversationImage[];
  readonly initial: number; readonly onClose: () => void;
}) {
  const [index,setIndex] = useState(initial);
  const [scale,setScale] = useState(1);
  const [pan,setPan] = useState<Point>({x:0,y:0});
  const stage = useRef<HTMLDivElement>(null);
  const points = useRef(new Map<number,Point>());
  const gesture = useRef<{start:Point;previous:Point;distance:number;pinched:boolean;moved:boolean;outside:boolean} | null>(null);
  const current = images[Math.min(index,images.length - 1)]!;
  const {data,fail,unavailable,retry} = useImage({machine,history,image:current.id},true);
  const [saving,setSaving] = useState(false);
  const [saveError,setSaveError] = useState(false);
  const downloadController = useRef<AbortController | null>(null);
  useEffect(() => {
    setSaveError(false);
    return () => { downloadController.current?.abort(); };
  },[current.id]);
  const download = async () => {
    if (saving || data.state !== "ready") return;
    const controller = new AbortController();
    downloadController.current = controller;
    stage.current?.closest<HTMLElement>('[role="dialog"]')?.focus();
    setSaving(true); setSaveError(false);
    const fresh = await fetchConversationImage(machine,history,current.id,controller.signal);
    try {
      if (controller.signal.aborted) return;
      if (fresh.state === "error") { setSaveError(true); return; }
      if (fresh.state !== "ready") { unavailable(fresh); return; }
      await saveConversationImage(fresh.blob,fresh.filename,fresh.url);
    } catch { if (!controller.signal.aborted) setSaveError(true); }
    finally {
      if (fresh.state === "ready") URL.revokeObjectURL(fresh.url);
      if (downloadController.current === controller) { downloadController.current = null; setSaving(false); }
    }
  };
  const move = (delta: number) => {
    // A boundary arrow becomes disabled after this update. Move focus before
    // that happens so keyboard events still reach the dialog in real browsers.
    stage.current?.closest<HTMLElement>('[role="dialog"]')?.focus();
    setIndex(value => Math.max(0,Math.min(images.length - 1,value + delta)));
    setScale(1); setPan({x:0,y:0});
  };
  const fit = () => { setScale(1); setPan({x:0,y:0}); };
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => { event.preventDefault(); event.stopPropagation(); setScale(value => clampZoom(value * Math.exp(-event.deltaY * 0.002))); };
    element.addEventListener("wheel",wheel,{passive:false});
    return () => element.removeEventListener("wheel",wheel);
  },[]);
  const distance = () => {
    const [a,b] = [...points.current.values()];
    return a && b ? Math.hypot(a.x-b.x,a.y-b.y) : 0;
  };
  const down = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const point = {x:event.clientX,y:event.clientY};
    points.current.set(event.pointerId,point);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    if (points.current.size === 1) gesture.current = {start:point,previous:point,distance:0,pinched:false,moved:false,outside:event.target === event.currentTarget};
    else if (gesture.current) { gesture.current.pinched = true; gesture.current.distance = distance(); }
  };
  const drag = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (!points.current.has(event.pointerId) || !gesture.current) return;
    const point = {x:event.clientX,y:event.clientY};
    points.current.set(event.pointerId,point);
    const state = gesture.current;
    if (points.current.size >= 2) {
      const next = distance();
      const previousDistance = state.distance;
      if (previousDistance > 0) setScale(value => clampZoom(value * next / previousDistance));
      state.distance = next; state.moved = true;
    } else {
      if (Math.hypot(point.x-state.start.x,point.y-state.start.y) > 8) state.moved = true;
      const previousPoint = state.previous;
      if (scale > 1) setPan(value => ({x:value.x + point.x-previousPoint.x,y:value.y + point.y-previousPoint.y}));
    }
    state.previous = point;
  };
  const up = (event: ReactPointerEvent<HTMLDivElement>,cancelled = false) => {
    event.stopPropagation();
    const state = gesture.current;
    points.current.delete(event.pointerId);
    if (!points.current.size && state) {
      const dx = event.clientX-state.start.x, dy = event.clientY-state.start.y;
      if (!cancelled && !state.pinched && scale === 1 && Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(dy)*1.5) move(dx < 0 ? 1 : -1);
    }
  };
  return createPortal(<Modal onClose={onClose} ariaLabel="Conversation images" androidBackEntry="conversation-images" lightDismiss
    backdropClassName="conversation-image-backdrop" className="conversation-image-viewer"
    onDialogKeyDown={event => {
      if (event.key === "Tab") event.stopPropagation();
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); event.stopPropagation(); move(event.key === "ArrowRight" ? 1 : -1); }
    }}>
    <div className="conversation-image-toolbar">
      <span aria-live="polite">{index + 1} / {images.length}</span>
      <IconButton className="btn" aria-label="Zoom out" title="Zoom out" disabled={scale <= 1} onClick={() => setScale(value => clampZoom(value / 1.5))}><ZoomOutIcon /></IconButton>
      <IconButton className="btn" aria-label="Fit image" title="Fit image" onClick={fit}><FitImageIcon /></IconButton>
      <IconButton className="btn" aria-label="Zoom in" title="Zoom in" disabled={scale >= 6} onClick={() => setScale(value => clampZoom(value * 1.5))}><ZoomInIcon /></IconButton>
      <IconButton className="btn" aria-label="Download image" title="Download image" disabled={data.state !== "ready" || saving} aria-busy={saving} onClick={() => void download()}><DownloadIcon /></IconButton>
      <IconButton className="btn" aria-label="Close image viewer" title="Close image viewer" onClick={onClose}><CloseIcon /></IconButton>
    </div>
    {saveError ? <div className="conversation-image-save-error" role="status">Image could not be saved</div> : null}
    <div ref={stage} className="conversation-image-stage" onContextMenu={event => event.preventDefault()} onPointerDown={down} onPointerMove={drag} onPointerUp={event => up(event)} onPointerCancel={event => up(event,true)}
      onTouchStart={event => event.stopPropagation()} onTouchMove={event => event.stopPropagation()} onTouchEnd={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); if (event.target === event.currentTarget && !gesture.current?.moved && gesture.current?.outside) onClose(); }}
      onDoubleClick={event => { event.stopPropagation(); setScale(value => value === 1 ? 2 : 1); setPan({x:0,y:0}); }}>
      <div className="conversation-image-canvas" style={{transform:`translate(${scale === 1 ? 0 : pan.x}px, ${scale === 1 ? 0 : pan.y}px) scale(${scale})`}}>
        <ImageContent data={data} fail={fail} retry={retry} sourceName={sourceNames[index]} sourceUrl={sourceUrls[index]} />
      </div>
    </div>
    {images.length > 1 ? <div className="conversation-image-navigation">
      <IconButton className="btn" aria-label="Previous image" title="Previous image" disabled={index === 0} onClick={() => move(-1)}><ChevronLeftIcon /></IconButton>
      <IconButton className="btn" aria-label="Next image" title="Next image" disabled={index === images.length - 1} onClick={() => move(1)}><ChevronRightIcon /></IconButton>
    </div> : null}
  </Modal>,document.body);
}

/** Shared by History, the full Conversation pane, phone and desktop tiles. */
export function ConversationImages({machine,history,images,attachmentPaths = [],markdownSource}: {
  /** Visible message Markdown; never used as a read target. */
  readonly markdownSource?: {readonly text: string; readonly images?: readonly ConversationImage[]};
  readonly machine: string; readonly history: string; readonly images: readonly ConversationImage[];
  /** The message's own quoted upload paths, for Copy file path (#237). */
  readonly attachmentPaths?: readonly string[];
}) {
  // Match the daemon's inline Markdown source order. Mixed structured sources
  // cannot be paired from visible text alone, so do not guess their names.
  const targets = [...(markdownSource?.text ?? "").matchAll(/!\[[\s\S]*?\]\(([^)]*)\)/g)].map(match => {
    const target = match[1]!.trim();
    return target.startsWith("<") && target.includes(">")
      ? target.slice(1,target.indexOf(">")) : target.split(/\s/)[0];
  });
  const sourceImages = markdownSource?.images ?? [];
  const sourceTargets = targets.length === sourceImages.length
    ? images.map(image => targets[sourceImages.findIndex(source => source.id === image.id)]) : [];
  const sourceNames = sourceTargets.map(sanitizeAttachmentName);
  const sourceUrls = sourceTargets.map(target => target ? validateTerminalUrl(target) ?? undefined : undefined);
  const [open,setOpen] = useState<number | null>(null);
  const [menu,setMenu] = useState<MenuState | null>(null);
  const [notice,setNotice] = useState("");
  const closeMenu = useCallback(() => setMenu(null),[]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""),4000);
    return () => clearTimeout(timer);
  },[notice]);
  return <div className="conversation-images">
    {images.map((image,index) => <Thumbnail key={image.id} target={{machine,history,image:image.id}} index={index} sourceName={sourceNames[index]} sourceUrl={sourceUrls[index]} onOpen={() => setOpen(index)} onMenu={next => { setNotice(""); setMenu(next); }} />)}
    {menu ? <ImageMenu menu={menu} paths={attachmentPaths} uploadPath={images[menu.index]?.upload_path} onOpen={setOpen} onClose={closeMenu} onError={setNotice} /> : null}
    {notice ? <div className="conversation-image-menu-error" role="status">{notice}</div> : null}
    {open !== null ? <ImageViewer key={`${machine}/${history}`} machine={machine} history={history} images={images} sourceNames={sourceNames} sourceUrls={sourceUrls} initial={open} onClose={() => setOpen(null)} /> : null}
  </div>;
}
