import type { GoalMouthBaselineState } from "./useGoalMouthBaseline";

const HEX_COPY = {
  summary: "좋은 자리에서 쏘나",
  title: "슈팅 위치 빈도",
  sizeLegend: "헥스 크기 = 선수 슛 빈도",
  colorPending: "헥스 색 = 리그 배치 기준선 · 준비 중",
  penalty: "페널티킥 제외",
  outOfCrop: "표시 범위 밖",
  loading: "헥스 빈도를 불러오는 중입니다.",
  unavailable: "이 컨텍스트의 헥스 빈도를 사용할 수 없습니다.",
} as const;

const hexPath = (cx: number, cy: number, radius: number) => Array.from({ length: 6 }, (_, index) => {
  const angle = Math.PI / 3 * index;
  return `${index === 0 ? "M" : "L"}${cx + Math.cos(angle) * radius},${cy + Math.sin(angle) * radius}`;
}).join(" ") + " Z";

export function PitchHexFrequencyPanel({ state }: { state: GoalMouthBaselineState }) {
  const frequency = state.kind === "ready" ? state.data.data.hexFrequency : null;
  return <details data-pitch-hex-panel className="mt-4 rounded-xl border border-white/10 bg-[#0b1113]">
    <summary className="cursor-pointer list-none px-4 py-3 text-sm font-black text-zinc-100 focus-visible:ring-2 focus-visible:ring-lime-300">{HEX_COPY.summary}</summary>
    <div className="border-t border-white/10 p-4">
      <h3 className="text-sm font-black text-zinc-50">{HEX_COPY.title}</h3>
      {frequency ? <>
        <svg data-pitch-hex-frequency viewBox="0 0 600 400" className="mt-3 block h-auto w-full rounded-lg border border-white/10 bg-[#07120d]" role="img" aria-label={`${HEX_COPY.title}. ${frequency.cells.length} occupied cells. ${HEX_COPY.penalty}.`}>
          <rect x="28" y="24" width="544" height="352" rx="8" fill="none" stroke="#b9c3bd" strokeOpacity=".45"/>
          <line x1="28" y1="200" x2="572" y2="200" stroke="#67e8f9" strokeOpacity=".65" strokeDasharray="5 5"/>
          {frequency.cells.map((cell) => {
            const cx = 28 + (cell.cx - 66.7) / (100 - 66.7) * 544;
            const cy = 24 + (90 - cell.cy) / 80 * 352;
            const radius = Math.min(18, 4 + Math.sqrt(cell.shots) * 2.1);
            return <path key={cell.hexId} data-pitch-hex-cell={cell.hexId} data-shots={cell.shots} d={hexPath(cx, cy, radius)} fill="none" stroke="#e5e7eb" strokeWidth="1.5" strokeOpacity=".9"><title>{cell.shots} shots</title></path>;
          })}
        </svg>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-300"><span>{HEX_COPY.sizeLegend}</span><span>{HEX_COPY.colorPending}</span><span>{HEX_COPY.penalty}</span><span>{HEX_COPY.outOfCrop} {frequency.outOfCropShots} shots</span></div>
      </> : <p role="status" className="mt-3 text-sm text-zinc-300">{state.kind === "loading" ? HEX_COPY.loading : HEX_COPY.unavailable}</p>}
    </div>
  </details>;
}
