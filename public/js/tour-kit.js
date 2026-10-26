// A full-screen guided tour: <TourProvider steps> holds the state, useTour() reads and drives it, and the dimmed page, the spotlight
// and the step card are drawn into document.body (createPortal), so no page's stacking or clipping can hide them.
// A step is { target?: CSS selector, title, body, placement?: "right" | "left" | "bottom" | "top", cta?: { label, href } }.
// No target (or one that never appears) shows the card in the middle of the window. A target is looked up in
// getRoot(step) (default: this page), which may be the document of an iframe: its position is worked out in this window.
const html = htm.bind(React.createElement);
const { createContext, useContext, useState, useEffect, useLayoutEffect, useRef, useMemo } = React;

const TourContext = createContext(null);
function useTour() {
  const tour = useContext(TourContext);
  if (!tour) throw new Error("useTour needs a TourProvider above it");
  return tour;
}

const PAD = 8;            // the spotlight stands this far outside its element
const GAP = 14;           // and the card this far from the spotlight
const EDGE = 12;          // the card keeps this far from the window's edges
const FIND_EVERY_MS = 150, FIND_FOR_MS = 8000; // how long to wait for an element that is rendered late
const narrow = () => window.innerWidth < 600; // the card becomes a sheet at the bottom (tour.css)

function TourProvider({ steps, getRoot, onClose, children }) {
  const [open, setOpen] = useState(true);
  const [index, setIndex] = useState(0);
  const tour = useMemo(() => ({
    open, index, total: steps.length, step: steps[index], isFirst: index === 0, isLast: index === steps.length - 1,
    next: () => setIndex((i) => Math.min(i + 1, steps.length - 1)),
    back: () => setIndex((i) => Math.max(i - 1, 0)),
    goTo: (i) => setIndex(Math.max(0, Math.min(i, steps.length - 1))),
    start: () => { setIndex(0); setOpen(true); },
    close: () => (onClose ? onClose() : setOpen(false)), // skipping or Escape: the page decides where that leads
  }), [open, index, steps]);
  return html`<${TourContext.Provider} value=${tour}>${children}${open && html`<${TourLayer} getRoot=${getRoot} />`}<//>`;
}

// The element a step points at, and where it is in the window now. It waits for an element that is not rendered yet, follows it
// through resizes and scrolling, and looks again if the element is removed.
function useTargetRect(step, getRoot) {
  const selector = step.target;
  const [rect, setRect] = useState(null);
  useEffect(() => {
    setRect(null);
    if (!selector) return undefined;
    let el = null, observer, timer, keep, inner;
    const measure = () => {
      if (!el) return;
      if (!el.isConnected) { detach(); seek(); return; }
      let r = el.getBoundingClientRect(); const frame = el.ownerDocument.defaultView.frameElement;
      const o = frame ? frame.getBoundingClientRect() : { top: 0, left: 0 }; // an element in an iframe is measured from the iframe's corner
      r = { top: r.top + o.top, left: r.left + o.left, width: r.width, height: r.height };
      setRect((old) => (old && old.top === r.top && old.left === r.left && old.width === r.width && old.height === r.height ? old : r));
    };
    const detach = () => { observer?.disconnect(); clearInterval(keep); inner?.removeEventListener("scroll", measure, true); el = null; setRect(null); };
    const seek = () => {
      const started = Date.now();
      clearInterval(timer);
      timer = setInterval(() => {
        const found = (getRoot ? getRoot(step) : document)?.querySelector(selector);
        if (found) {
          clearInterval(timer);
          el = found;
          el.scrollIntoView({ block: narrow() ? "start" : "center", inline: "nearest" });
          observer = new ResizeObserver(measure);
          observer.observe(el);
          inner = el.ownerDocument.defaultView;
          if (inner !== window) inner.addEventListener("scroll", measure, true); // the iframe's own scrolling
          keep = setInterval(measure, 400); // late layout changes (data arriving above it) don't resize the element itself
          measure();
        } else if (Date.now() - started > FIND_FOR_MS) clearInterval(timer); // never appeared: the card is shown without a spotlight
      }, FIND_EVERY_MS);
    };
    seek();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true); // true: scrolling inside any box moves the element too
    return () => {
      clearInterval(timer); clearInterval(keep); observer?.disconnect(); inner?.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [step]);
  return rect;
}

// Where the card goes: beside the spotlight on the preferred side, else any side it fits, else pinned at the bottom of the window.
function placeCard(rect, size, pref) {
  const vw = window.innerWidth, vh = window.innerHeight;
  if (!rect) return { left: (vw - size.w) / 2, top: (vh - size.h) / 2 };
  const r = { left: rect.left - PAD, top: rect.top - PAD, right: rect.left + rect.width + PAD, bottom: rect.top + rect.height + PAD };
  const midX = (r.left + r.right) / 2 - size.w / 2, midY = (r.top + r.bottom) / 2 - size.h / 2;
  const sides = { right: { left: r.right + GAP, top: midY }, left: { left: r.left - GAP - size.w, top: midY },
    bottom: { left: midX, top: r.bottom + GAP }, top: { left: midX, top: r.top - GAP - size.h } };
  const fits = (p) => p.left >= EDGE && p.top >= EDGE && p.left + size.w <= vw - EDGE && p.top + size.h <= vh - EDGE;
  for (const side of [pref, "bottom", "top", "right", "left"]) if (sides[side] && fits(sides[side])) return sides[side];
  return { left: (vw - size.w) / 2, top: vh - size.h - EDGE };
}

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

function TourLayer({ getRoot }) {
  const { step, index, total, isFirst, isLast, next, back, close } = useTour();
  const rect = useTargetRect(step, getRoot);
  const card = useRef();
  const [size, setSize] = useState({ w: 340, h: 220 });
  const [, bump] = useState(0);

  // While the tour is open: the page behind can't scroll or take focus, and everything is put back when it closes.
  useEffect(() => {
    const root = document.getElementById("root"), before = document.activeElement;
    const overflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    if (root) root.inert = true;
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if (e.key !== "Tab" || !card.current) return;
      const items = [...card.current.querySelectorAll(FOCUSABLE)];
      const first = items[0], last = items[items.length - 1];
      if (!card.current.contains(document.activeElement)) { e.preventDefault(); first?.focus(); }
      else if (e.shiftKey && (document.activeElement === first || document.activeElement === card.current)) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    const onResize = () => bump((n) => n + 1);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      document.documentElement.style.overflow = overflow;
      if (root) root.inert = false;
      if (before && before.isConnected) before.focus();
    };
  }, []);

  useEffect(() => { card.current?.focus(); }, [index]); // each step is announced and keyboard users start at its card
  useLayoutEffect(() => {
    const measure = () => card.current && setSize((old) => (old.w === card.current.offsetWidth && old.h === card.current.offsetHeight ? old : { w: card.current.offsetWidth, h: card.current.offsetHeight }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(card.current);
    return () => observer.disconnect();
  }, [index]);

  const spot = rect
    ? { top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 }
    : { top: window.innerHeight / 2, left: window.innerWidth / 2, width: 0, height: 0 };
  const at = narrow() ? undefined : placeCard(rect, size, step.placement);
  return ReactDOM.createPortal(html`<div className="tour-layer">
    <div className=${rect ? "tour-spot" : "tour-spot none"} style=${spot}></div>
    <div ref=${card} className="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-body" tabIndex="-1" style=${at}>
      <p className="tour-count">Step ${index + 1} of ${total}</p>
      <h2 id="tour-title">${step.title}</h2>
      <p id="tour-body">${step.body}</p>
      <div className="tour-dots" aria-hidden="true">${Array.from({ length: total }, (_, i) => html`<i key=${i} className=${i === index ? "on" : ""}></i>`)}</div>
      <div className="tour-actions">
        ${!isFirst && html`<button className="tour-btn" onClick=${back}>Back</button>`}
        ${isLast && step.cta ? html`<a className="tour-btn primary" href=${step.cta.href}>${step.cta.label}</a>`
          : !isLast && html`<button className="tour-btn primary" onClick=${next}>Next</button>`}
        ${!isLast && html`<button className="tour-skip" onClick=${close}>Skip tour</button>`}
      </div>
    </div>
  </div>`, document.body);
}
