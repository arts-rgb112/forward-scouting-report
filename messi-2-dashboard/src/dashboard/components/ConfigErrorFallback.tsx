import { useEffect, useRef, useState } from "react";

import type { ConfigErrorCategory } from "../../api/env";

const reasonByCategory: Record<ConfigErrorCategory, string> = {
  MISSING_API_BASE_URL: "필수 API 주소가 설정되지 않았습니다.",
  INVALID_API_ORIGIN: "API 주소 형식이 허용되지 않습니다.",
  INSECURE_API_ORIGIN: "이 환경에서는 보안 HTTPS API 주소가 필요합니다.",
  INVALID_DATASET_SETTINGS: "데이터셋 설정 값이 허용 범위를 벗어났습니다.",
  CONFIG_INVALID: "배포 설정을 확인해야 합니다.",
};

const variableNames = ["VITE_MESSI_API_BASE_URL", "VITE_MESSI_SEASON", "VITE_MESSI_SCOPE", "VITE_MESSI_LIMIT"];

function safeMode(mode: string): "development" | "preview" | "production" | "unknown" {
  return mode === "development" || mode === "preview" || mode === "production" ? mode : "unknown";
}

export function ConfigErrorFallback({ category, mode }: { category: ConfigErrorCategory; mode: string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [copied, setCopied] = useState(false);
  const diagnostic = [
    "M.E.S.S.I. 2.0 configuration validation failure",
    `category: ${category}`,
    `build mode: ${safeMode(mode)}`,
    "request: not started",
    `required variables: ${variableNames.join(", ")}`,
  ].join("\n");

  useEffect(() => { heading.current?.focus(); }, []);

  async function copyDiagnostic() {
    try {
      await navigator.clipboard?.writeText(diagnostic);
    } finally {
      setCopied(true);
    }
  }

  return <main className="grid min-h-screen place-items-center bg-[#080b0c] p-4 text-zinc-100 sm:p-6">
    <section className="w-full max-w-2xl border border-amber-300/30 bg-[#101415] p-5 shadow-2xl shadow-black/30 sm:p-7">
      <div className="mb-5 border-l-2 border-amber-300 pl-3 text-xs font-bold tracking-[0.16em] text-amber-200">M.E.S.S.I. 2.0 · DEPLOYMENT CHECK</div>
      <div role="alert" aria-labelledby="config-error-heading">
        <h1 ref={heading} id="config-error-heading" tabIndex={-1} className="text-2xl font-black tracking-tight text-zinc-50 outline-none focus-visible:ring-2 focus-visible:ring-lime-300">Config Error (환경 변수 누락)</h1>
        <p className="mt-3 text-sm leading-6 text-zinc-300">대시보드를 안전하게 시작할 수 없습니다. 이 배포본의 환경 변수 설정을 확인해 주세요.</p>
      </div>
      <p className="mt-4 border-l border-amber-300/40 pl-3 text-sm font-semibold text-amber-100">{reasonByCategory[category]}</p>

      <div className="mt-6 border border-white/10 bg-black/15 p-4">
        <h2 className="text-sm font-bold text-zinc-100">배포 담당자 조치</h2>
        <p className="mt-2 text-sm leading-6 text-zinc-300">Vercel 프로젝트의 Preview 또는 Production 환경에 필요한 VITE_MESSI_* 값을 설정한 뒤 새로 배포하세요. 환경 변수 변경은 이미 배포된 화면에 반영되지 않습니다.</p>
        <ul className="mt-3 grid gap-1 text-xs text-zinc-200 sm:grid-cols-2">{variableNames.map((name) => <li key={name} className="break-all font-mono">{name}</li>)}</ul>
        <p className="mt-3 text-xs leading-5 text-zinc-400"><code>VITE_MESSI_API_BASE_URL</code>에는 HTTPS origin만 입력합니다. <code>/api/v1/players</code>, 경로, 쿼리, 해시, 자격 증명은 넣지 않습니다.</p>
      </div>

      <details className="mt-5 border-t border-white/10 pt-4">
        <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold text-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lime-300">안전한 진단 정보 보기</summary>
        <dl className="mt-2 grid gap-1 text-xs text-zinc-400"><div><dt className="inline">상태: </dt><dd className="inline">구성 검증 실패</dd></div><div><dt className="inline">분류: </dt><dd className="inline font-mono text-zinc-200">{category}</dd></div><div><dt className="inline">요청 상태: </dt><dd className="inline">API 요청을 시작하지 않음</dd></div></dl>
      </details>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <button type="button" onClick={copyDiagnostic} className="min-h-11 border border-lime-300/70 px-4 text-sm font-bold text-lime-200 outline-none transition-none focus-visible:ring-2 focus-visible:ring-lime-300">문제 정보 복사</button>
        <div className="text-xs leading-5 text-zinc-400 sm:ml-auto sm:text-right">새 배포가 완료된 경우에만 다시 불러오세요.</div>
        <button type="button" onClick={() => window.location.reload()} className="min-h-11 border border-white/20 px-4 text-sm font-semibold text-zinc-200 outline-none transition-none hover:border-white/40 focus-visible:ring-2 focus-visible:ring-lime-300">새 배포 후 페이지 새로고침</button>
      </div>
      <p role="status" className="mt-3 min-h-5 text-xs text-lime-200">{copied ? "복사되었습니다. 배포 담당자에게 전달하세요." : ""}</p>
    </section>
  </main>;
}
