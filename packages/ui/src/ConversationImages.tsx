import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { ConversationImage } from "@agent-console/shared/conversation-images";
import { Modal } from "./Modal.tsx";
import { fetchConversationImage, type ConversationImageData } from "./conversationImageData.ts";
import { saveConversationImage } from "./saveConversationImage.ts";
import { IconButton } from "./IconButton.tsx";
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon, DownloadIcon, FitImageIcon, ZoomInIcon, ZoomOutIcon } from "./icons.tsx";
import "./ConversationImages.css";

interface ImageTarget { readonly machine: string; readonly history: string; readonly image: string }
function useImage(target: ImageTarget, enabled: boolean) {
  const [data,setData] = useState<ConversationImageData>({state:"loading"});
  const url = useRef<string | undefined>(undefined);
  const release = useCallback(() => {
    const owned = url.current;
    url.current = undefined;
    if (owned) URL.revokeObjectURL(owned);
  },[]);
  useEffect(() => {
    if (!enabled) { setData({state:"loading"}); return; }
    const controller = new AbortController();
    setData({state:"loading"});
    void fetchConversationImage(target.machine,target.history,target.image,controller.signal).then(result => {
      if (controller.signal.aborted) { if (result.state === "ready") URL.revokeObjectURL(result.url); return; }
      if (result.state === "ready") url.current = result.url;
      setData(result);
    });
    return () => { controller.abort(); release(); };
  },[target.machine,target.history,target.image,enabled,release]);
  return {data,unavailable:(result: Exclude<ConversationImageData,{state:"ready"}>) => { release(); setData(result); },fail:() => { release(); setData({state:"unavailable"}); }};
}
function ImageContent({data,fail,onLoad}: { readonly data: ConversationImageData; readonly fail: () => void; readonly onLoad?: (image: HTMLImageElement) => void }) {
  return data.state === "ready" ? <img src={data.url} alt="Conversation attachment" draggable={false} onError={fail} onLoad={event => onLoad?.(event.currentTarget)} />
    : <span role="status">{data.state === "deleted" ? "Image deleted" : data.state === "unavailable" ? "Image unavailable" : "Loading image…"}</span>;
}
function Thumbnail({target,index,onOpen}: { readonly target: ImageTarget; readonly index: number; readonly onOpen: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  // The shared descriptor is ID-only. Retain decoded dimensions when lazy
  // loading restarts so a known image keeps its place in the conversation.
  const [size,setSize] = useState<{width:number;height:number} | null>(null);
  const [visible,setVisible] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined" || !ref.current) return;
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)),{rootMargin:"128px"});
    observer.observe(ref.current);
    return () => observer.disconnect();
  },[]);
  const {data,fail} = useImage(target,visible);
  const sizing = size ? {"--image-width":`${size.width}px`,"--image-ratio":size.width / size.height} as CSSProperties : undefined;
  return <button ref={ref} style={sizing} className="conversation-image-thumbnail" type="button" aria-label={`Open image ${index + 1}`} onClick={event => { event.stopPropagation(); onOpen(); }}>
    <ImageContent data={data} fail={fail} onLoad={image => {
      if (image.naturalWidth && image.naturalHeight) setSize({width:image.naturalWidth,height:image.naturalHeight});
    }} />
  </button>;
}
const clampZoom = (scale: number) => Math.max(1,Math.min(6,scale));
interface Point { x: number; y: number }

function ImageViewer({machine,history,images,initial,onClose}: {
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
  const {data,fail,unavailable} = useImage({machine,history,image:current.id},true);
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
      <IconButton aria-label="Zoom out" title="Zoom out" disabled={scale <= 1} onClick={() => setScale(value => clampZoom(value / 1.5))}><ZoomOutIcon /></IconButton>
      <IconButton aria-label="Fit image" title="Fit image" onClick={fit}><FitImageIcon /></IconButton>
      <IconButton aria-label="Zoom in" title="Zoom in" disabled={scale >= 6} onClick={() => setScale(value => clampZoom(value * 1.5))}><ZoomInIcon /></IconButton>
      <IconButton aria-label="Download image" title="Download image" disabled={data.state !== "ready" || saving} aria-busy={saving} onClick={() => void download()}><DownloadIcon /></IconButton>
      <IconButton aria-label="Close image viewer" title="Close image viewer" onClick={onClose}><CloseIcon /></IconButton>
    </div>
    {saveError ? <div className="conversation-image-save-error" role="status">Image could not be saved</div> : null}
    <div ref={stage} className="conversation-image-stage" onPointerDown={down} onPointerMove={drag} onPointerUp={event => up(event)} onPointerCancel={event => up(event,true)}
      onTouchStart={event => event.stopPropagation()} onTouchMove={event => event.stopPropagation()} onTouchEnd={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); if (event.target === event.currentTarget && !gesture.current?.moved && gesture.current?.outside) onClose(); }}
      onDoubleClick={event => { event.stopPropagation(); setScale(value => value === 1 ? 2 : 1); setPan({x:0,y:0}); }}>
      <div className="conversation-image-canvas" style={{transform:`translate(${scale === 1 ? 0 : pan.x}px, ${scale === 1 ? 0 : pan.y}px) scale(${scale})`}}>
        <ImageContent data={data} fail={fail} />
      </div>
    </div>
    {images.length > 1 ? <div className="conversation-image-navigation">
      <IconButton aria-label="Previous image" title="Previous image" disabled={index === 0} onClick={() => move(-1)}><ChevronLeftIcon /></IconButton>
      <IconButton aria-label="Next image" title="Next image" disabled={index === images.length - 1} onClick={() => move(1)}><ChevronRightIcon /></IconButton>
    </div> : null}
  </Modal>,document.body);
}

/** Shared by History, the full Conversation pane, phone and desktop tiles. */
export function ConversationImages({machine,history,images}: {
  readonly machine: string; readonly history: string; readonly images: readonly ConversationImage[];
}) {
  const [open,setOpen] = useState<number | null>(null);
  return <div className="conversation-images">
    {images.map((image,index) => <Thumbnail key={image.id} target={{machine,history,image:image.id}} index={index} onOpen={() => setOpen(index)} />)}
    {open !== null ? <ImageViewer key={`${machine}/${history}`} machine={machine} history={history} images={images} initial={open} onClose={() => setOpen(null)} /> : null}
  </div>;
}
