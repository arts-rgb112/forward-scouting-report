# Google Colab 실행 셀

## Cell 1 — 패키지 설치

```python
!pip -q install requests pillow easyocr opencv-python-headless
```

첫 실행에서는 EasyOCR 모델을 내려받기 때문에 시간이 조금 더 걸릴 수 있습니다.

## Cell 2 — 수집기 업로드 및 실행

```python
from google.colab import files

uploaded = files.upload()  # colab_asset_collector.py 선택
%run colab_asset_collector.py
```

수집 대상은 `colab_asset_collector.py`의 `ASSETS` 목록에서 수정합니다. 결과는
`/content/messi_assets/players`, `/clubs`, `/nations`에 PNG로 저장됩니다. SVG로
등록된 국기와 클럽 문장은 Wikimedia가 제공하는 `thumburl`의 래스터 PNG를
다운로드하므로 Pillow에서 정상 처리됩니다.

## Cell 3 — 결과 확인 및 ZIP 다운로드

```python
from pathlib import Path
from google.colab import files
import csv
import shutil

root = Path("/content/messi_assets")
for folder in ("players", "clubs", "nations"):
    print(f"{folder}:", len(list((root / folder).glob("*.png"))))

with (root / "asset_status.csv").open(encoding="utf-8-sig") as handle:
    for row in csv.DictReader(handle):
        print(row["status"].upper(), row["kind"], row["name"], "-", row["detail"])

archive = shutil.make_archive("/content/messi_assets", "zip", root)
files.download(archive)
```

생성되는 감사 파일은 다음과 같습니다.

- `assets_manifest.csv`: 저장 파일의 SHA-256, 원본·썸네일·실제 다운로드 URL,
  Commons 설명 페이지, 저작자, 라이선스, 이용 조건, 저작자 표시 정보를 보존합니다.
- `rejected_assets.csv`: 검사에서 제외된 모든 검색 후보와 제외 사유를 기록합니다.
- `asset_status.csv`: 요청한 각 자산의 최종 `saved`, `failed`, `error` 상태를
  기록하므로 결과 파일이 없는 항목도 확인할 수 있습니다.

수집기는 API 페이지네이션, 검색어 확장, 429/서버 오류 재시도와 지수형 backoff,
스트리밍 용량 제한, SHA-256 중복 방지 및 원자적 저장을 적용합니다. 하지만 OCR과
코너 오버레이 검사는 보조 수단이며 워터마크를 완벽히 판별하지 못합니다. 배포 전에
반드시 모든 이미지의 워터마크 여부를 육안으로 확인하고 `assets_manifest.csv`의
라이선스·저작자 표시 조건을 직접 검토하세요.
