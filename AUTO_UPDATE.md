# 자동 업데이트 프로세스

이 저장소는 성장주 핵심 5종목을 매일 추적하도록 구성되어 있습니다.

## 추적 종목

- 산일전기(062040)
- 파마리서치(214450)
- 삼양식품(003230)
- LS ELECTRIC(010120)
- 실리콘투(257720)

## 매일 하는 일

1. `scripts/update-daily-tracking.js`가 `data/growth-tracking-targets.json`을 읽습니다.
2. Naver Finance 참고 시세를 시도합니다.
3. `DART_API_KEY`가 있으면 최근 14일 DART 공시를 확인합니다.
4. `data/daily-growth-tracking.json`을 갱신합니다.
5. `scripts/apply-daily-tracking.js`가 갱신 데이터를 `index.html`에 반영합니다.
6. `scripts/check-dashboard.js`로 HTML 스크립트가 깨지지 않았는지 검증합니다.
7. 변경이 있으면 GitHub Actions가 자동 커밋합니다.

## DART 공시 자동 수집을 켜는 법

GitHub 저장소에서 `Settings > Secrets and variables > Actions > New repository secret`으로 이동한 뒤 `DART_API_KEY`를 추가합니다.

DART 키가 없어도 워크플로는 실행되지만, 공시 수집은 `확인 필요` 상태로 남습니다.

## 운영 원칙

- 자동 수집값은 매수 신호가 아닙니다.
- 공시·IR·분기보고서가 우선이고, 비공식 시세는 참고값입니다.
- 숫자가 확인되지 않은 항목은 자동 추정하지 않습니다.
- 성장주 1개 슬롯은 초기 40~50%만 매수하고, 성장 논리가 유지될 때만 추가매수합니다.
