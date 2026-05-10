# arch-trends-curation

한국 건축 현상설계 주간 트렌드 자동 큐레이션. 매주 월요일 09:00 KST, GitHub Actions가 사이트들을 fetch → **Manus API** 로 의미 있는 공고 3~5개를 골라 → MD 파일로 커밋. Next.js 측(`design-competition-ontology` 의 `/trends` 라우트)이 raw.githubusercontent.com에서 MD를 끌어다 렌더링.

## 구조

```
arch-trends-curation/
├── scripts/
│   ├── build.mjs         # 워커: fetch → Manus → MD 작성
│   └── sources.json      # 크롤링할 사이트 목록 (사용자가 채움)
├── .github/workflows/
│   └── build.yml         # 매주 월요일 cron + 수동 트리거 가능
├── package.json          # 의존성 없음 (Node 20+ 내장 fetch)
├── index.md              # 회차 목록 (워커가 자동 갱신)
└── YYYY-MM-DD_요일.md    # 주간 회차 (워커가 자동 작성)
```

## 1회 세팅 (Manus API 키 발급 후)

### 1. GitHub 레포 만들기

```powershell
cd "C:\Users\myh43\OneDrive\바탕 화면\zzori\arch-trends-curation"
git init
git add .
git commit -m "init"
gh repo create ghkch5gh-jpg/arch-trends-curation --public --source=. --remote=origin --push
```

→ 레포 이름은 반드시 **`arch-trends-curation`** — `design-competition-ontology` 의 `lib/trends.ts` 가 그 이름을 가리키고 있음.

### 2. Manus API 키 발급

마누스 대시보드 → API Keys 메뉴에서 키 생성. `sk-...` 또는 유사한 형식의 문자열.

본인이 결제한 Manus 구독의 *크레딧을 그대로 소비* — 추가 결제 없음.

### 3. MANUS_API_KEY 시크릿 등록

```powershell
gh secret set MANUS_API_KEY --repo ghkch5gh-jpg/arch-trends-curation
# (프롬프트에서 키 붙여넣기)
```

### 4. sources.json 채우기

`scripts/sources.json` 의 `"TBD"` 자리를 실제 사이트 목록 페이지 URL로 교체. 후보:

- 공공건축지원센터 (pa.kr) 공모정보 목록
- 건축사협회 (kira.or.kr) 공모전 게시판
- 조달청 나라장터 (g2b.go.kr) 설계용역 검색결과 URL
- 각 발주처 (LH·서울시·경기도교육청 등) 공고 페이지

5~10개 정도가 적당. 너무 많으면 토큰비 늘고, 모델이 신호/노이즈 구분이 흐려짐.

### 5. 첫 실행 — 워크플로 수동 트리거

```powershell
gh workflow run "Build weekly arch trends" --repo ghkch5gh-jpg/arch-trends-curation
```

또는 GitHub 웹 UI → Actions 탭 → "Build weekly arch trends" → "Run workflow".

성공하면 `2026-XX-XX_요일.md` 가 레포에 커밋됨. `/trends` 페이지 새로고침하면 5분 안에 (라이브러리 cache TTL) 보임.

### 6. 자동 실행 확인

이후엔 매주 월요일 09:00 KST에 자동 실행. 결과는 GitHub Actions 탭에서 확인 가능.

## 모델 격상

기본 `manus-1.6-lite` (가볍고 빠름·크레딧 적게). 품질 부족하면 `.github/workflows/build.yml` 의 `MANUS_AGENT_PROFILE` 환경변수를:
- `manus-1.6` — 표준
- `manus-1.6-max` — 최고품질·크레딧 많이

## 로컬 개발

```powershell
cd "C:\Users\myh43\OneDrive\바탕 화면\zzori\arch-trends-curation"

# Manus API 호출 없이 프롬프트 미리보기
$env:DRY_RUN = "1"
npm run build

# 실제 실행
$env:DRY_RUN = $null
$env:MANUS_API_KEY = "your-manus-key"
npm run build
```

## 사용자가 직접 추가 게재하기

자동 큐레이션이 마음에 안 들거나, 본인 코멘트를 더하고 싶을 땐:

1. `YYYY-MM-DD_요일.md` 파일 직접 편집 (워커가 만든 파일을 수정하거나, 본인이 새로 만들어도 됨)
2. `git commit && git push`
3. 5분 뒤 `/trends` 페이지에 반영

`index.md` 는 워커가 매번 덮어쓰니 회차 추가는 MD 파일 자체로 — 파일명만 패턴 (`YYYY-MM-DD_요일.md`) 맞으면 자동으로 목록에 들어감.

## 작동 방식 — Manus API 호출 순서

1. `scripts/sources.json` 의 각 URL을 Node 내장 `fetch` 로 가져옴 (HTTPS)
2. HTML → 순수 텍스트 변환 (20K자로 cut)
3. `POST https://api.manus.ai/v2/task.create` — `agent_profile`, `structured_output_schema`, 그리고 모든 사이트 텍스트를 합친 프롬프트
4. 응답으로 `task_id` 받음
5. `GET task.listMessages?task_id=...` 를 10초마다 폴링 (최대 15분)
6. `structured_output_result` 이벤트가 오면 그 안의 `value`를 JSON으로 받음
7. JSON을 MD 마크업으로 변환 → 파일 저장 → `index.md` 갱신
8. GitHub Actions가 `git commit && git push`

## 트러블슈팅

- **`task.create 실패: 401`**: `MANUS_API_KEY` 시크릿이 빈 값이거나 만료. 재발급 후 `gh secret set` 다시.
- **`Task 타임아웃`**: 15분 안에 끝나지 않음. 보통 입력이 너무 크거나 모델이 헤맸을 때. `sources.json` 사이트 수 줄이거나 `MANUS_AGENT_PROFILE` 을 `manus-1.6` 으로 격상.
- **`All sources failed to fetch`**: 사이트들이 봇 차단. User-Agent 변경 시도 (`build.mjs`) 또는 다른 사이트 사용.
- **`structured_output_result` 안 옴**: 일부 agent 프로파일은 structured output 미지원일 수 있음. 그 경우 워커가 `assistant_message` 에서 JSON 파싱으로 폴백.
- **빈 결과**: 그 주에 진짜 의미 있는 공고가 없을 수 있음. 또는 사이트 텍스트가 너무 짧아 못 골랐을 수도. dry-run 으로 프롬프트 확인.

## 비용

본인이 결제한 Manus 구독의 *크레딧을 직접 소비*. 별도 결제 없음. 1회 실행당 소비 크레딧은 마누스 대시보드의 `usage.list` 에서 확인.

---

> 기존 Anthropic API 직접 호출 버전에서 Manus API로 갈아낌 — 본인 구독 크레딧 활용해서 추가 결제 회피.
