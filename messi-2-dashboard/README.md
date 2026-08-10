# M.E.S.S.I. 2.0 scouting dashboard

React, TypeScript, Vite, and Tailwind CSS 기반의 실행 가능한 스카우팅 대시보드입니다.

## 로컬 실행

Node.js 20.19 이상과 pnpm을 준비한 뒤 실행합니다.

```bash
pnpm install
pnpm dev
```

프로덕션 빌드는 다음 명령을 사용합니다.

```bash
pnpm build
```

## 구현된 사용자 플로우

- 선수, 클럽, 리그, 국가 통합 검색
- 악센트를 생략한 검색 지원 (`Mbappe` → `Mbappé`)
- 데이터 기반 포지션 필터, 정렬, 활성 조건 초기화
- 2~4명 비교 선택, 고정 비교 트레이, 상세 지표 비교
- `localStorage` 기반 관심선수 저장 및 관심선수만 보기
- 데스크톱 고밀도 테이블과 모바일 전용 카드
- 점수/티어 범례, 빈 결과 복구 액션, 키보드·스크린리더 접근성

현재 선수와 이미지 URL은 UI 검증용 샘플 데이터입니다. 실제 데이터 연결 시
`MessiScoutingDashboard.tsx`의 `players` 배열을 API 응답이나 props로 교체하세요.

## Google Colab 에셋 수집기

붙여넣기 가능한 실행 셀은 `COLAB_SNIPPET.md`에 있습니다. 출력은
`/content/messi_assets/{players,clubs,nations}`에 생성됩니다.

- `assets_manifest.csv`: 저장된 에셋의 원본/썸네일 URL, 저작자, 라이선스, SHA-256
- `asset_status.csv`: 요청별 최종 성공/실패 상태
- `rejected_assets.csv`: 후보별 거절 사유

수집기는 Wikimedia Commons 라이선스 메타데이터, 차단 도메인/키워드, MIME,
파일 크기, OCR 워터마크, 코너 오버레이, 중복 해시를 검사합니다. 자동 검사는
보조 장치이므로 배포 전 모든 이미지와 라이선스/표시 의무를 사람이 검수해야 합니다.
