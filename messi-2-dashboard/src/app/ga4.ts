import { useEffect, useState } from "react";

type GaEnvironment = { readonly VITE_GA_MEASUREMENT_ID?: string };
type GaWindow = Window & typeof globalThis & {
  dataLayer?: unknown[][];
  gtag?: (...args: unknown[]) => void;
  __messiGa4ConfiguredId?: string;
  __messiGa4LastPath?: string;
};

const measurementIdPattern = /^G-[A-Z0-9]+$/;

export function gaMeasurementId(environment: GaEnvironment = import.meta.env): string | undefined {
  const value = environment.VITE_GA_MEASUREMENT_ID?.trim();
  return value && measurementIdPattern.test(value) ? value : undefined;
}

export function currentPagePath(location: Pick<Location, "pathname"> = window.location) { return location.pathname; }
export function currentRouteKey(location: Pick<Location, "pathname" | "search"> = window.location) { return `${location.pathname}${location.search}`; }

export function pageViewContext(location: Pick<Location, "search"> = window.location) {
  const query = new URLSearchParams(location.search);
  const values = {
    messi_season: query.get("season") ?? undefined,
    messi_mode: query.get("mode") ?? undefined,
    messi_scope: query.get("scope") ?? undefined,
    messi_competition: query.get("competition") ?? undefined,
  };
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function gaWindow(): GaWindow { return window as GaWindow; }
function gtagQueue(target: GaWindow) {
  target.dataLayer ??= [];
  target.gtag ??= (...args: unknown[]) => { target.dataLayer!.push(args); };
  return target.gtag;
}

export function ensureGa4(measurementId: string | undefined, documentRef: Document = document): boolean {
  if (!measurementId || !measurementIdPattern.test(measurementId)) return false;
  const target = gaWindow();
  const gtag = gtagQueue(target);
  if (target.__messiGa4ConfiguredId === measurementId) return true;
  gtag("js", new Date());
  gtag("config", measurementId, { send_page_view: false });
  const existing = documentRef.querySelector(`script[data-messi-ga4-id="${measurementId}"]`);
  if (!existing) {
    const script = documentRef.createElement("script");
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
    script.dataset.messiGa4Id = measurementId;
    documentRef.head.appendChild(script);
  }
  target.__messiGa4ConfiguredId = measurementId;
  return true;
}

export function sendGa4PageView(measurementId: string | undefined, path = currentPagePath(), title = document.title, routeKey = currentRouteKey()): boolean {
  if (!ensureGa4(measurementId)) return false;
  const target = gaWindow();
  if (target.__messiGa4LastPath === routeKey) return false;
  gtagQueue(target)("event", "page_view", { page_path: path, page_location: window.location.href, page_title: title, ...pageViewContext() });
  target.__messiGa4LastPath = routeKey;
  return true;
}

/** Tracks SPA history mutations as well as back/forward navigation. */
export function useGa4PageViews(measurementId = gaMeasurementId()) {
  const [routeKey, setRouteKey] = useState(currentRouteKey);
  useEffect(() => {
    if (!measurementId) return;
    const refresh = () => setRouteKey((previous) => {
      const next = currentRouteKey();
      return next === previous ? previous : next;
    });
    const history = window.history;
    const pushState = history.pushState;
    const replaceState = history.replaceState;
    history.pushState = function (...args: Parameters<History["pushState"]>) { pushState.apply(history, args); refresh(); };
    history.replaceState = function (...args: Parameters<History["replaceState"]>) { replaceState.apply(history, args); refresh(); };
    window.addEventListener("popstate", refresh);
    return () => { history.pushState = pushState; history.replaceState = replaceState; window.removeEventListener("popstate", refresh); };
  }, [measurementId]);
  useEffect(() => { sendGa4PageView(measurementId, currentPagePath(), document.title, routeKey); }, [measurementId, routeKey]);
}
