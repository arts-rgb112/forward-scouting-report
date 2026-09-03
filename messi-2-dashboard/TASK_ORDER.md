# PART B — 도트 매트릭스 히트맵

## 범위

- 기존 `2D 회랑 / 3D 회랑 / 골대맵` 세 탭은 구조와 동작을 변경하지 않는다.
- 네 번째 탭 `heat`를 추가하고 사용자 표시명은 `히트맵`으로 한다.
- 브라우저는 서버 값을 재집계하거나 CCA·점수·코호트를 계산하지 않는다.
- 신규 API, SportsAPI 호출, 데이터 ETL, 점수·코호트·CSV 변경을 하지 않는다.

## 입력과 계산

- 입력은 기존 `analysis.spatial`의 max-180 좌표/32×22 density 필드만 사용한다.
- `legacyDensityGrid` → `normalizeDensity`를 거쳐 64×24 도트 중심에 bilinear sample한다.
- 정규화 밀도 `d <= 0.05`는 렌더하지 않는다.
- 색은 프로젝트의 승인된 원본 금색→주황→빨강 ramp 유틸을 import해 사용한다.
- 도트 자체 alpha만 사용하고 `HEATMAP_OPACITY`, SVG/canvas blur, stroke를 적용하지 않는다.

## 2D/3D 표현

- 단일 도트 매트릭스 전용 컴포넌트로 2D 평면과 원근 3D slab을 제공한다.
- 3D는 기존 카메라/투영 유틸을 재사용하고 새 좌표계를 만들지 않는다.
- 세로 thirds 구역을 클릭하면 해당 구역을 분리 표시하고 다시 클릭하면 전체로 복귀한다.
- 히트맵 탭에는 슈팅 마커·궤적·CCA를 겹치지 않는다.

## 접근성/상태

- 탭과 thirds 제어는 키보드로 조작 가능하고 현재 선택을 ARIA로 노출한다.
- 원천이 없으면 추정하지 않고 명시적인 unavailable 상태를 보여준다.
- 캔버스/SVG의 장식 도트는 보조기술에서 숨기고 판독 가능한 텍스트 요약을 제공한다.

## 완료 조건

- 64×24 bilinear sampling, cutoff, 승인 ramp, 무 blur/무 stroke를 단위 테스트한다.
- 탭 추가가 기존 3개 탭을 바꾸지 않았음을 회귀 테스트한다.
- thirds 클릭/키보드 전환과 unavailable 접근성을 DOM 테스트한다.
- Kane과 저출전 선수의 동일 뷰 캡처를 남긴다.
- 테스트와 production build가 통과해야 한다.
- 자동 push·PR·merge·deploy는 하지 않는다.
