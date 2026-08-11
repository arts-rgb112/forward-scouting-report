type Props = { page: number; total: number; pageSize: number; onPageChange(page: number): void };

function pageNumbers(page: number, total: number) {
  const values = new Set([1, total, page - 2, page - 1, page, page + 1, page + 2]);
  return [...values].filter((value) => value >= 1 && value <= total).sort((a, b) => a - b);
}

export function LeaderboardPagination({ page, total, pageSize, onPageChange }: Props) {
  if (total <= pageSize) return null;
  const pages = Math.ceil(total / pageSize);
  const numbered = pageNumbers(page, pages);
  const button = "min-h-11 min-w-11 rounded-md border border-white/10 px-3 text-xs font-bold text-zinc-300 disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300";
  return <nav aria-label="리더보드 페이지네이션" className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-[#101415] p-2">
    <div className="hidden items-center gap-1 md:flex">
      <button type="button" className={button} disabled={page === 1} onClick={() => onPageChange(1)}>First</button>
      <button type="button" className={button} disabled={page === 1} onClick={() => onPageChange(page - 1)}>Previous</button>
      {numbered.map((value, index) => <span key={value} className="contents">
        {index > 0 && value - numbered[index - 1] > 1 && <span aria-hidden="true" className="px-1 text-zinc-500">…</span>}
        <button type="button" className={button} aria-current={value === page ? "page" : undefined} onClick={() => onPageChange(value)}>{value}</button>
      </span>)}
      <button type="button" className={button} disabled={page === pages} onClick={() => onPageChange(page + 1)}>Next</button>
      <button type="button" className={button} disabled={page === pages} onClick={() => onPageChange(pages)}>Last</button>
    </div>
    <div className="flex w-full items-center justify-between gap-2 md:hidden">
      <button type="button" className={button} disabled={page === 1} onClick={() => onPageChange(page - 1)}>Previous</button>
      <span className="text-xs font-bold text-zinc-300">Page {page}/{pages}</span>
      <button type="button" className={button} disabled={page === pages} onClick={() => onPageChange(page + 1)}>Next</button>
    </div>
    <span className="hidden whitespace-nowrap text-xs text-zinc-500 md:block">Page {page} of {pages}</span>
  </nav>;
}
