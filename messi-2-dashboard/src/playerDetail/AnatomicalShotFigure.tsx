import { useId } from 'react';
import type { KeyboardEvent } from 'react';

export type AnatomicalShotPart = 'head' | 'rightFoot' | 'leftFoot';
/**
 * `quality` is optional so this component still works wherever a caller has
 * not wired the native-body-part-stats-v2 quality field through yet —
 * omitting it renders the same two-line callout as before, it never
 * fabricates a third line.
 */
export type AnatomicalShotCount = {
  shots: number | null;
  goals: number | null;
  quality?: { delta: number | null; state: 'complete' | 'partial' | 'unavailable' };
};

export interface AnatomicalShotFigureProps {
  /** Controlled selection; null deliberately leaves every part inactive. */
  selectedPart: AnatomicalShotPart | null;
  onSelect: (part: AnatomicalShotPart) => void;
  counts: Record<AnatomicalShotPart, AnatomicalShotCount>;
  labels: Record<AnatomicalShotPart, string>;
  /** Accessible figure name, for example "슈팅 부위 선택". */
  title: string;
  shotsLabel?: string;
  goalsLabel?: string;
  /** e.g. "퀄리티" — the short xGOT−xG line's own label. */
  qualityLabel?: string;
  /** e.g. "일부 표본" — appended when that part's own metric pairing is partial. */
  qualityPartialLabel?: string;
  className?: string;
}

const PARTS: AnatomicalShotPart[] = ['head', 'rightFoot', 'leftFoot'];
const numberText = (value: number | null): string => value === null ? '—' : String(value);

/**
 * Presentation only: front-facing anatomical RIGHT is screen LEFT.
 * Counts are rendered verbatim; this component does not aggregate, infer a
 * selected shot's body part, calculate percentages, or combine other/unknown.
 * The parent owns loading/error/source/PK disclosures and selection state.
 */
export function AnatomicalShotFigure({
  selectedPart, onSelect, counts, labels, title,
  shotsLabel = '슛', goalsLabel = '득점', qualityLabel = '퀄리티', qualityPartialLabel = '일부 표본', className,
}: AnatomicalShotFigureProps) {
  const instance = useId().replace(/:/g, '');
  const metal = `${instance}-metal`;
  const head = `${instance}-head`;
  const highlight = `${instance}-highlight`;
  const titleId = `${instance}-title`;
  const activate = (event: KeyboardEvent<SVGGElement>, part: AnatomicalShotPart) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(part);
    }
  };
  const fill = (part: AnatomicalShotPart, fallback: string) =>
    selectedPart === part ? `url(#${highlight})` : fallback;
  const countText = (part: AnatomicalShotPart) =>
    `${numberText(counts[part].shots)} ${shotsLabel} · ${numberText(counts[part].goals)} ${goalsLabel}`;
  // xGOT−xG on this part's own paired native shots — a genuinely separate
  // measure from shots/goals above, so it never gets silently averaged or
  // combined into them. Sign is always shown; unobserved reads as "—". Kept
  // at full type size always — the partial flag gets its OWN line below
  // instead of being appended here, so this number is never compressed.
  const qualityValueText = (part: AnatomicalShotPart) => {
    const quality = counts[part].quality;
    if (!quality || quality.state === 'unavailable' || quality.delta === null) return `${qualityLabel} —`;
    const sign = quality.delta >= 0 ? '+' : '';
    return `${qualityLabel} ${sign}${quality.delta.toFixed(2)}`;
  };
  const isQualityPartial = (part: AnatomicalShotPart) => counts[part].quality?.state === 'partial';

  return (
    <svg
      className={className}
      viewBox="0 0 340 340"
      width="100%"
      style={{ display: 'block', maxWidth: 440, marginInline: 'auto', overflow: 'visible' }}
      role="group"
      aria-labelledby={titleId}
      data-anatomical-shot-figure="true"
    >
      <title id={titleId}>{title}</title>
      <style>{`
        .asf-target { cursor: pointer; outline: none; }
        .asf-focus { opacity: 0; pointer-events: none; }
        .asf-target:focus-visible .asf-focus { opacity: 1; }
        .asf-target:hover .asf-callout-outline { stroke: #a8c2d6; }
        @media (forced-colors: active) {
          .asf-target { forced-color-adjust: none; }
          .asf-target:focus-visible .asf-focus { stroke: Highlight; }
        }
      `}</style>
      <defs>
        {/* 2026-09-08 owner palette note ("색감은 이거 따라해주면 좋을거같아"): dark
            navy ground, a muted slate body, one warm coral accent reserved
            for the selected part — a starting token set from a reference
            image, not exact extracted values; adjusted here for on-body
            contrast. This accent is a SELECTION indicator only, unrelated to
            the shot-outcome win/loss palette used elsewhere on the pitch. */}
        <linearGradient id={metal} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#5b6b80" />
          <stop offset="0.48" stopColor="#7c8ca0" />
          <stop offset="0.53" stopColor="#4a586d" />
          <stop offset="1" stopColor="#252f3d" />
        </linearGradient>
        <linearGradient id={head} x1="0" y1="0" x2="0.8" y2="1">
          <stop stopColor="#aebccb" />
          <stop offset="0.55" stopColor="#79899d" />
          <stop offset="1" stopColor="#3a4659" />
        </linearGradient>
        <linearGradient id={highlight} x1="0" y1="0" x2="0.85" y2="1">
          <stop stopColor="#f8a4ac" />
          <stop offset="0.5" stopColor="#ee6471" />
          <stop offset="1" stopColor="#a83e49" />
        </linearGradient>
      </defs>

      {/* The silhouette has articulated joints; facets follow body volumes. */}
      <g aria-hidden="true" pointerEvents="none">
        <ellipse cx="170" cy="320" rx="48" ry="5" fill="#050d18" opacity="0.45" />
        <path d="M161 66 L159 78 146 84 170 97 194 84 181 78 179 66Z"
          fill={`url(#${metal})`} />
        <path d="M149 81 L135 85 125 96 120 116 114 138 113 154 108 183 106 196 108 207 112 210 114 200 115 210 119 209 120 197 117 187 123 161 130 148 135 124 143 109Z"
          fill={`url(#${metal})`} stroke="#344c62" strokeWidth="0.7" />
        <path d="M191 81 L205 85 215 96 220 116 226 138 227 154 232 183 234 196 232 207 228 210 226 200 225 210 221 209 220 197 223 187 217 161 210 148 205 124 197 109Z"
          fill={`url(#${metal})`} stroke="#344c62" strokeWidth="0.7" />
        <path d="M149 81 L161 87 170 91 179 87 191 81 204 96 198 125 188 146 187 169 195 192 185 209 170 200 155 209 145 192 153 169 152 146 142 125 136 96Z"
          fill={`url(#${metal})`} stroke="#344c62" strokeWidth="0.8" />
        <path d="M145 192 L169 201 166 225 162 249 159 267 158 291 161 302 158 309 145 311 137 308 139 300 143 293 141 267 140 247 140 224Z"
          fill={fill('rightFoot', `url(#${metal})`)} stroke="#52687b" strokeWidth="0.7" />
        <path d="M195 192 L171 201 174 225 178 249 181 267 182 291 179 302 182 309 195 311 203 308 201 300 197 293 199 267 200 247 200 224Z"
          fill={fill('leftFoot', `url(#${metal})`)} stroke="#52687b" strokeWidth="0.7" />
        <path d="M152 35 L154 25 163 19 177 19 186 26 188 36 186 48 183 61 176 70 164 70 157 61 154 48Z"
          fill={fill('head', `url(#${head})`)} stroke="#8ba2b2" strokeWidth="0.8" />
        <path d="M153 40 L150 40 150 49 155 54 M187 40 L190 40 190 49 185 54"
          fill={fill('head', '#8297a8')} />
        <path d="M154 29 L169 35 184 28 178 20 163 20Z" fill="#e2edf4" opacity="0.19" />
        <path d="M154 37 L168 40 165 51 157 49Z M185 37 L172 40 175 51 183 49Z" fill="#122940" opacity="0.33" />
        <path d="M170 37 L165 53 173 55Z M165 61 L179 57 175 67 165 67Z" fill="#d2e2eb" opacity="0.16" />
        <path d="M144 91 L168 96 165 119 146 115Z M172 96 L196 91 194 115 175 119Z"
          fill="#d5e2ec" opacity="0.2" />
        <path d="M146 117 L165 123 154 146Z M175 123 L194 117 186 146Z" fill="#152b41" opacity="0.3" />
        <path d="M169 122 L156 145 157 166 169 174Z M173 122 L183 145 183 166 173 174Z"
          fill="#c3d8e5" opacity="0.12" />
        <path d="M155 175 L169 184 149 192 157 203 170 196 183 203 191 192 173 184 185 175Z"
          fill="#142c44" opacity="0.3" />
        <path d="M131 100 L126 124 120 143 126 143 139 109Z M209 100 L214 124 220 143 214 143 201 109Z"
          fill="#d2e1eb" opacity="0.16" />
        <path d="M121 155 L114 181 116 190 126 159Z M219 155 L226 181 224 190 214 159Z"
          fill="#10283e" opacity="0.25" />
        <path d="M149 204 L160 212 151 239 142 246Z M191 204 L180 212 189 239 198 246Z"
          fill="#d9e4ea" opacity="0.19" />
        <path d="M142 249 L151 242 161 250 155 260 145 260Z M198 249 L189 242 179 250 185 260 195 260Z"
          fill="#1b344a" opacity="0.28" />
        <path d="M145 264 L152 271 147 293 143 297Z M195 264 L188 271 193 293 197 297Z"
          fill="#e1edf5" opacity="0.2" />
        <path d="M139 305 L148 303 159 305 M201 305 L192 303 181 305"
          fill="none" stroke="#e3edf3" strokeOpacity="0.35" />
      </g>

      {PARTS.map((part) => {
        const active = selectedPart === part;
        const x = part === 'leftFoot' ? 226 : 6;
        const y = part === 'head' ? 28 : 242;
        const anchorX = part === 'head' ? 152 : part === 'rightFoot' ? 148 : 192;
        const anchorY = part === 'head' ? 44 : 281;
        const lineEndX = part === 'leftFoot' ? x : x + 108;
        return (
          <g
            key={part}
            className="asf-target"
            role="button"
            tabIndex={0}
            aria-pressed={active}
            aria-label={`${labels[part]} · ${countText(part)} · ${qualityValueText(part)}${isQualityPartial(part) ? ` · ${qualityPartialLabel}` : ''}`}
            onClick={() => onSelect(part)}
            onKeyDown={(event) => activate(event, part)}
            data-shot-part={part}
          >
            {/* Transparent articulated hit regions supplement the 108×64 callout. */}
            {part === 'head' ? (
              <rect x="147" y="17" width="46" height="56" rx="18" fill="transparent" />
            ) : (
              <rect x={part === 'rightFoot' ? 132 : 172} y="209" width="40" height="105" rx="16" fill="transparent" />
            )}
            <path d={`M${anchorX} ${anchorY} L${part === 'leftFoot' ? 215 : 124} ${y + 24} H${lineEndX}`}
              stroke={active ? '#ee6471' : '#5f7186'} strokeWidth="1" fill="none" pointerEvents="none" />
            <circle cx={anchorX} cy={anchorY} r="2.5" fill={active ? '#ee6471' : '#8698ac'} pointerEvents="none" />
            {/* A part flagged partial gets a genuine 4th line for that flag
                alone — the quality number itself is never glyph-compressed
                to make room for it (compressing digits/text on an already
                small mobile card only makes it harder to read). The callout
                grows to fit that 4th line only where it's actually shown. */}
            <rect className="asf-callout-outline" x={x} y={y} width="108" height={isQualityPartial(part) ? 80 : 64} rx="9"
              fill={active ? '#2b232f' : '#1d2637'} fillOpacity="0.96"
              stroke={active ? '#ee6471' : '#3a4659'} strokeWidth={active ? 1.3 : 0.8} />
            <rect className="asf-focus" x={x - 3} y={y - 3} width="114" height={isQualityPartial(part) ? 86 : 70} rx="12"
              fill="none" stroke="#e8edf3" strokeWidth="2" />
            <text x={x + 11} y={y + 19} fill={active ? '#f8a4ac' : '#e8edf3'}
              fontFamily="system-ui, sans-serif" fontSize="12" fontWeight="650" pointerEvents="none">
              {labels[part]}
            </text>
            <text x={x + 11} y={y + 36} fill="#a9b8c9" fontFamily="system-ui, sans-serif"
              fontSize="11" pointerEvents="none" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {countText(part)}
            </text>
            <text data-shot-part-quality x={x + 11} y={y + 53} fill="#a9b8c9" fontFamily="system-ui, sans-serif"
              fontSize="11" pointerEvents="none" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {qualityValueText(part)}
            </text>
            {isQualityPartial(part) && (
              <text data-shot-part-quality-partial x={x + 11} y={y + 70} fill="#f2c879" fontFamily="system-ui, sans-serif"
                fontSize="10" pointerEvents="none">
                {qualityPartialLabel}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export default AnatomicalShotFigure;
