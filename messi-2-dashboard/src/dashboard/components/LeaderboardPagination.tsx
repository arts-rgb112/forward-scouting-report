type Props = { page: number; total: number; pageSize: number; pending?: boolean; onPageChange(page: number): void };

function pageNumbers(page: number, total: number) {
  const values = new Set([1, total, page - 1, page, page + 1]);
  return [...values].filter((value) => value >= 1 && value <= total).sort((a, b) => a - b);
}

export function LeaderboardPagination({ page, total, pageSize, pending = false, onPageChange }: Props) {
  if (total <= pageSize) return null;
  const pages = Math.ceil(total / pageSize);
  const numbered = pageNumbers(page, pages);
  const unavailable = pending;
  const button = "min-h-11 min-w-11 rounded-md border border-white/10 px-3 text-xs font-bold text-zinc-300 disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300";
  return <nav aria-label="Leaderboard pagination" aria-busy={pending} className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-[#101415] p-2">
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
      <button type="button" aria-label="First page" className={button} disabled={unavailable || page === 1} onClick={() => onPageChange(1)}>First</button>
      <button type="button" aria-label="Previous page" className={button} disabled={unavailable || page === 1} onClick={() => onPageChange(page - 1)}>Previous</button>
      {numbered.map((value, index) => <span key={value} className="contents">
        {index > 0 && value - numbered[index - 1] > 1 && <span aria-hidden="true" className="px-1 text-zinc-500">…</span>}
        <button type="button" aria-label={`Page ${value}`} className={button} aria-current={value === page ? "page" : undefined} disabled={unavailable} onClick={() => onPageChange(value)}>{value}</button>
      </span>)}
      <button type="button" aria-label="Next page" className={button} disabled={unavailable || page === pages} onClick={() => onPageChange(page + 1)}>Next</button>
      <button type="button" aria-label="Last page" className={button} disabled={unavailable || page === pages} onClick={() => onPageChange(pages)}>Last</button>
    </div>
    <span className="shrink-0 whitespace-nowrap px-1 text-xs text-zinc-500">Page {page} of {pages}</span>
  </nav>;
}
