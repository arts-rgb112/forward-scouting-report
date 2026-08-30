import type { PlayerHistoryEntry } from "../api/playerHistoryApi";
import { resolveTierPresentation } from "../dashboard/scoutingConfig";
import type { DatasetRouteState, Player, PlayerAnalysis, Tier } from "../dashboard/types";
import { seasonScoreRows, selectedScore, wholeScore } from "./playerDetailViewModel";

const COPY = {
  overallRank: "대회 전체",
  positionRank: "동포지션",
  current: "현재",
  seasonHighs: "시즌별 고점",
  retrievedRange: "조회 범위",
  selectedOnly: "선택 컨텍스트만",
  barNote: "막대 길이는 티어 순위입니다. 대회마다 모집단이 달라 점수는 직접 비교하지 않습니다.",
  partialHistory: (count: number) => `${count}개 컨텍스트의 시즌 이력을 불러오지 못했습니다.`,
} as const;

const TIER_ORDER = ["diamond", "emerald", "platinum", "gold", "silver", "bronze"] as const;
type TierVisualKey = (typeof TIER_ORDER)[number] | "unknown";

const TIER_VISUALS: Record<TierVisualKey, { color: string; variable: string }> = {
  diamond: { color: "#ab8ffa", variable: "var(--messi-violet, #ab8ffa)" },
  emerald: { color: "#b5f052", variable: "var(--messi-accent, #b5f052)" },
  platinum: { color: "#45d6ed", variable: "var(--messi-cyan, #45d6ed)" },
  gold: { color: "#f5b247", variable: "var(--messi-amber, #f5b247)" },
  silver: { color: "#949f9f", variable: "var(--messi-muted, #949f9f)" },
  bronze: { color: "#fa6e7a", variable: "var(--messi-rose, #fa6e7a)" },
  unknown: { color: "#949f9f", variable: "var(--messi-muted, #949f9f)" },
};

const LEGACY_VISUAL_KEY: Record<string, TierVisualKey> = {
  diamond: "diamond", platinum: "emerald", gold: "platinum",
  silver: "gold", bronze: "silver", iron: "bronze",
};

export type PlayerProfileHistoryState = {
  loading: boolean;
  entries: PlayerHistoryEntry[];
  failed: number;
  requestedSeasons: number;
};

export function tierVisualKey(tier: Tier): TierVisualKey {
  const presentation = resolveTierPresentation(tier);
  if (presentation.taxonomy === "crystal-v2" && TIER_ORDER.includes(tier.code as (typeof TIER_ORDER)[number])) return tier.code as (typeof TIER_ORDER)[number];
  if (presentation.taxonomy === "legacy-v1") return LEGACY_VISUAL_KEY[tier.code] ?? "unknown";
  return "unknown";
}

export function tierLadderPercent(tier: Tier) {
  const key = tierVisualKey(tier);
  const bandIndex = TIER_ORDER.indexOf(key as (typeof TIER_ORDER)[number]);
  if (bandIndex < 0) return 0;
  const level = Math.min(5, Math.max(1, Math.trunc(tier.level)));
  const step = (TIER_ORDER.length - bandIndex) * 5 - (level - 1);
  return step / 30 * 100;
}

function contextLabels(context: DatasetRouteState | PlayerHistoryEntry["context"]) {
  if (context.mode === "league") return { chip: "리그", detail: `${context.scope}대리그` };
  return { chip: "유럽대항전", detail: context.competition === "all" ? "전체 대회" : context.competition.toUpperCase() };
}

function ProfileTierBadge({ tier }: { tier: Tier }) {
  const presentation = resolveTierPresentation(tier);
  const visual = TIER_VISUALS[tierVisualKey(tier)];
  return <span
    aria-label={`Overall M.E.S.S.I. tier: ${presentation.label}, level ${tier.level}`}
    className="inline-flex shrink-0 items-center rounded-md border px-[10px] py-[5px] type-caption font-bold leading-none"
    style={{ borderColor: visual.variable, color: visual.variable }}
    title={presentation.tooltip}
  >
    <span aria-hidden="true">{presentation.glyph}</span>&nbsp;{presentation.label} Lv.{tier.level}
  </span>;
}

function RankRow({ label, rank, population }: { label: string; rank: number | null; population: number | null }) {
  return <div className="flex w-full items-baseline justify-between gap-2 type-caption">
    <span className="text-[var(--messi-muted,#949f9f)]">{label}</span>
    <span className="flex items-baseline gap-[5px]">
      <b className="type-label text-[var(--messi-text,#f5f8f7)]">{rank === null ? "—" : `${rank}위`}</b>
      <span className="text-[var(--messi-muted,#949f9f)]">/ {population === null ? "—명" : `${population}명`}</span>
    </span>
  </div>;
}

type SeasonRow = ReturnType<typeof seasonScoreRows>[number];

function SeasonRailRow({ row }: { row: SeasonRow }) {
  const visual = TIER_VISUALS[tierVisualKey(row.player.tier)];
  const presentation = resolveTierPresentation(row.player.tier);
  const width = tierLadderPercent(row.player.tier);
  const context = contextLabels(row.context);
  return <li className="flex w-full flex-col gap-1" data-season={row.context.season} data-selected={row.selected ? "true" : "false"}>
    <div className="flex w-full items-baseline justify-between gap-2">
      <span className="flex min-w-0 items-baseline gap-[6px]">
        <b className={`${row.selected ? "font-bold text-[var(--messi-text,#f5f8f7)]" : "font-normal text-[var(--messi-muted,#949f9f)]"} type-label`}>{row.context.season}</b>
        {row.selected && <span className="rounded-[3px] border border-[var(--messi-muted,#949f9f)] px-[6px] py-0.5 type-caption font-bold leading-none text-[var(--messi-muted,#949f9f)]">{COPY.current}</span>}
      </span>
      <b className="shrink-0 type-label tabular-nums text-[var(--messi-text,#f5f8f7)]">{row.score.toFixed(1)}</b>
    </div>
    <div className="h-1 w-full overflow-hidden rounded-sm bg-[var(--messi-border,#252d2e)]" role="progressbar" aria-label={`${row.context.season} ${presentation.label} level ${row.player.tier.level} tier ladder position`} aria-valuemin={0} aria-valuemax={30} aria-valuenow={Math.round(width * 0.3)}>
      <span className="block h-full rounded-sm" data-tier-fill style={{ width: `${width}%`, backgroundColor: visual.variable }} />
    </div>
    <div className="flex w-full items-center gap-[6px] type-caption">
      <span aria-hidden="true" className="size-[6px] shrink-0 rounded-full" style={{ backgroundColor: visual.variable }} />
      <b style={{ color: visual.variable }}>{presentation.label} {row.player.tier.level}</b>
      <span className="opacity-60 text-[var(--messi-muted,#949f9f)]">·</span>
      <span className="opacity-85 text-[var(--messi-muted,#949f9f)]">{context.chip} · {context.detail}</span>
    </div>
  </li>;
}

function SeasonSkeleton() {
  return <li aria-hidden="true" className="flex w-full animate-pulse flex-col gap-1 motion-reduce:animate-none">
    <div className="h-[14px] w-full rounded bg-white/[.06]"/><div className="h-1 w-full rounded-sm bg-[var(--messi-border,#252d2e)]"/><div className="h-[11px] w-2/3 rounded bg-white/[.05]"/>
  </li>;
}

export function PlayerProfileCard({ player, analysis, selected, history }: { player: Player; analysis?: PlayerAnalysis; selected: DatasetRouteState; history: PlayerProfileHistoryState }) {
  const selectedValue = selectedScore(player, analysis);
  const rows = seasonScoreRows(player, analysis, selected, history.entries)
    .sort((a, b) => b.score - a.score || b.context.season.localeCompare(a.context.season))
    .slice(0, 5);
  const scores = rows.map((row) => row.score);
  const range = `${Math.min(...scores).toFixed(1)}–${Math.max(...scores).toFixed(1)}`;
  const currentContext = contextLabels(selected);
  const currentVisual = TIER_VISUALS[tierVisualKey(player.tier)];
  const positionRank = analysis?.score.rank ?? null;
  const positionPopulation = analysis?.score.population && analysis.score.population > 0 ? analysis.score.population : null;

  return <section
    className="flex w-full flex-col gap-4 overflow-hidden rounded-[var(--radius-card,16px)] border border-[var(--messi-border,#252d2e)] bg-[var(--messi-panel,#101516)] p-[22px]"
    aria-labelledby="player-profile-heading"
    data-layout="approved-profile-card"
  >
    <div className="flex w-full items-baseline justify-between gap-3 overflow-hidden">
      <h2 id="player-profile-heading" className="type-display font-bold tabular-nums" style={{ color: currentVisual.variable }}>{wholeScore(player, analysis)}</h2>
      <ProfileTierBadge tier={player.tier}/>
    </div>

    <div className="flex w-full flex-col gap-[3px]">
      <RankRow label={COPY.overallRank} rank={player.rank} population={null}/>
      <RankRow label={COPY.positionRank} rank={positionRank} population={positionPopulation}/>
    </div>

    <div className="flex w-full items-center gap-[6px] overflow-hidden">
      <span className="shrink-0 rounded border border-[var(--messi-cyan,#45d6ed)] px-2 py-[3px] type-caption font-bold leading-none text-[var(--messi-cyan,#45d6ed)]">{currentContext.chip}</span>
      <span className="truncate type-caption text-[var(--messi-muted,#949f9f)]">{currentContext.detail} · {selected.season}</span>
    </div>

    <div className="h-px w-full bg-[var(--messi-border,#252d2e)]"/>

    <div className="flex w-full items-start gap-3 overflow-hidden">
      <div className="h-[68px] w-[54px] shrink-0 overflow-hidden rounded-md border border-[var(--messi-border,#252d2e)] bg-[var(--messi-surface,#0d1112)]">
        {player.face ? <img src={player.face} alt={`${player.name} portrait`} className="h-full w-full object-cover"/> : <span className="grid h-full place-items-center text-xl font-bold text-[var(--messi-muted,#949f9f)]" aria-hidden="true">{player.name[0]}</span>}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate type-title font-bold text-[var(--messi-text,#f5f8f7)]">{player.name}</p>
        <p className="truncate type-label text-[var(--messi-muted,#949f9f)]">{player.club.name} · {player.position}</p>
        <p className="type-label text-[var(--messi-muted,#949f9f)]">{player.age === null ? "나이 정보 없음" : `${player.age}세`} · {player.minutes.toLocaleString()}분</p>
      </div>
    </div>

    <div className="h-px w-full bg-[var(--messi-border,#252d2e)]"/>

    <section aria-label="Season score rail" className="flex w-full flex-col gap-4">
    <div className="flex w-full items-baseline justify-between gap-[6px] type-caption text-[var(--messi-muted,#949f9f)]">
      <h3 className="font-semibold tracking-[0.7px]">{COPY.seasonHighs}</h3>
      <span>{COPY.retrievedRange} {range}{history.entries.length ? "" : ` · ${COPY.selectedOnly}`}</span>
    </div>

    <ol className="flex w-full flex-col gap-4" aria-label="Season tier ladder">
      {history.loading ? <><SeasonRailRow row={rows.find((row) => row.selected) ?? rows[0]}/>{Array.from({ length: 4 }, (_, index) => <SeasonSkeleton key={index}/>)}</> : rows.map((row) => <SeasonRailRow key={`${row.context.season}-${row.context.mode}`} row={row}/>)}
    </ol>

    <p className="type-caption text-[var(--messi-muted,#949f9f)] opacity-70">{COPY.barNote}</p>
    {history.failed > 0 && <p aria-live="polite" className="type-caption text-[var(--messi-amber,#f5b247)]">{COPY.partialHistory(history.failed)}</p>}
    </section>
  </section>;
}
