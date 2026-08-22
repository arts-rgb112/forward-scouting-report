import { useEffect, useState } from "react";

import { PlayersResourceContainer } from "../dashboard/PlayersResourceContainer";
import { DashboardErrorBoundary } from "../dashboard/components/DashboardErrorBoundary";
import { StaticRoute } from "./StaticRoute";
import { WatchlistV3Provider } from "../dashboard/WatchlistV3Provider";
import { legacyRootAdapter } from "./legacyRootAdapter";

export function GlobalNavigation({ pathname }: { pathname: string }) {
  const active = pathname === "/compare" ? "compare" : pathname === "/about/messi" ? "about" : "leaderboard";
  const item = "min-h-11 whitespace-nowrap rounded-md px-2 py-2 text-xs font-bold text-zinc-400 hover:text-lime-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300 sm:px-3";
  const compareHref = "/compare";
  const aboutHref = "/about/messi";
  return <header className="border-b border-white/10 bg-[#080b0c]/95">
    <a href="#main-content" className="sr-only z-[100] rounded bg-lime-300 px-3 py-2 font-bold text-black focus:not-sr-only focus:absolute focus:left-3 focus:top-3">본문으로 건너뛰기</a>
    <div className="mx-auto flex max-w-[1580px] flex-wrap items-center justify-between gap-x-3 px-3 sm:px-6 lg:px-8">
      <a href="/" className="min-h-11 py-3 text-xs font-black tracking-[.18em] text-lime-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300">M.E.S.S.I.</a>
      <nav aria-label="주요 탐색" className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-1">
        <a href="/" aria-current={active === "leaderboard" ? "page" : undefined} className={item}>Leaderboard</a>
        <a href={compareHref} aria-current={active === "compare" ? "page" : undefined} className={item}>Compare</a>
        <a href={aboutHref} aria-current={active === "about" ? "page" : undefined} className={item}>MESSI stats</a>
      </nav>
    </div>
  </header>;
}

export default function App() {
  const [resetKey, setResetKey] = useState(0);
  const [pathname, setPathname] = useState(window.location.pathname);
  useEffect(() => {
    const updatePath = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", updatePath);
    return () => window.removeEventListener("popstate", updatePath);
  }, []);
  useEffect(() => { if (window.location.pathname !== "/") return; const target = legacyRootAdapter(window.location.search); if (target) window.location.replace(target); }, []);
  const routed = pathname !== "/";
  return <WatchlistV3Provider><GlobalNavigation pathname={pathname} /><DashboardErrorBoundary resetKey={resetKey} onReset={() => setResetKey((key) => key + 1)}>{routed ? <StaticRoute /> : <PlayersResourceContainer key={resetKey} />}</DashboardErrorBoundary></WatchlistV3Provider>;
}
