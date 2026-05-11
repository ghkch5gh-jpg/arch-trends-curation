#!/usr/bin/env node
import { readFile, writeFile, readdir } from "node:fs/promises";

const DRY_RUN = process.env.DRY_RUN === "1";
const API_KEY = process.env.MANUS_API_KEY;
const AGENT_PROFILE = process.env.MANUS_AGENT_PROFILE || "manus-1.6-lite";
const BASE_URL = "https://api.manus.ai/v2";
const POLL_INTERVAL_MS = 10_000;
const MAX_POLLS = 90;

if (!DRY_RUN && !API_KEY) {
  console.error("MANUS_API_KEY 환경변수가 비어 있음.");
  process.exit(1);
}

const sources = JSON.parse(await readFile("scripts/sources.json", "utf8"));
const validSources = sources.filter(
  (s) => s.url && !s.url.startsWith("TBD")
);

// User's own curated 당선작 ontology packs in the sister repo. Fetched at
// build time from GitHub raw so the worker always sees the latest packs
// without coupling the two repos at code level. Hardcoded slugs — add new
// packs to this list when they appear in design-competition-ontology/data/
// sample-packs/. If GitHub raw is unreachable, the worker still runs
// without the reference dictionary (logs a warning).
const OWN_PACKS_RAW_BASE =
  "https://raw.githubusercontent.com/ghkch5gh-jpg/design-competition-ontology/main/data/sample-packs";
const OWN_PACK_SLUGS = [
  "elementary",
  "etc",
  "high",
  "integrated",
  "kindergarten",
  "mid",
  "special",
];

async function fetchOwnPackSummary() {
  const results = await Promise.all(
    OWN_PACK_SLUGS.map(async (slug) => {
      try {
        const res = await fetch(`${OWN_PACKS_RAW_BASE}/${slug}.json`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const pack = await res.json();
        const projects = (pack.nodes || []).filter(
          (n) => n.type === "Project" && n.data?.award === "당선"
        );
        return { slug, projects, ok: true };
      } catch (err) {
        console.warn(`own pack ${slug} fetch 실패: ${err.message}`);
        return { slug, projects: [], ok: false };
      }
    })
  );
  const lines = [];
  let total = 0;
  for (const { slug, projects } of results) {
    if (projects.length === 0) continue;
    for (const p of projects) {
      const d = p.data || {};
      const meta = [
        slug,
        d.phase || "?",
        d.year || "?",
        d.siteContext || "?",
      ].join("·");
      const move = (d.decisiveMove || "").replace(/\s+/g, " ").trim();
      if (!move) continue;
      lines.push(`- [${meta}] ${p.label || "(이름없음)"} → ${move}`);
      total++;
    }
  }
  return { lines, total, sourceCount: results.filter((r) => r.ok).length };
}

console.log(
  "본인 큐레이션 ontology packs fetch — design-competition-ontology/data/sample-packs"
);
const ownPackSummary = await fetchOwnPackSummary();
console.log(
  `당선 Project ${ownPackSummary.total}개 추출 (packs ${ownPackSummary.sourceCount}/${OWN_PACK_SLUGS.length})`
);

if (validSources.length === 0) {
  console.error(
    "scripts/sources.json 의 모든 url 이 비어있거나 'TBD' — 실제 사이트 채워야 함."
  );
  process.exit(1);
}

// Nav chrome / boilerplate that should NEVER carry a URL into the prompt.
// Keep the text (for context) but drop the href so the prompt stays focused
// on competition content and the model has fewer URLs to choose from.
const NAV_TEXT = new RegExp(
  "^(" +
    [
      "로그인", "회원가입", "닫기", "이전", "다음", "메인", "홈",
      "home", "menu", "next", "prev", ">", "<",
      "소개", "공지사항", "자료실", "검색", "사이트맵", "이용약관",
      "개인정보처리방침", "팝업", "오늘 하루 보이지 않기",
      "본문바로가기", "전체메뉴", "more", "더보기",
      "english", "english\\(en\\)", "korean", "한국어",
    ].join("|") +
    ")$",
  "i"
);

function stripHtml(html, baseUrl) {
  // Inline anchor href as "text (absoluteURL)" BEFORE stripping tags so the
  // model can put real deep-links in pick.url instead of just the source's
  // landing page. Aggressively drop nav/chrome URLs to keep the prompt focused.
  const seen = new Set(); // dedupe identical "text+url" pairs (nav often repeats)
  let s = html.replace(
    /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, inner) => {
      let url;
      try {
        url = new URL(href, baseUrl).href;
      } catch {
        url = href;
      }
      const text = inner.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      if (!text) return " ";
      // Drop non-http, hash-only, and chrome links — keep text only.
      if (/^(mailto:|tel:|javascript:|#)/i.test(url)) return ` ${text} `;
      if (NAV_TEXT.test(text)) return ` ${text} `;
      // Very short anchor text is usually nav (icon-only, page numbers, etc).
      if (text.length < 4) return ` ${text} `;
      // Dedupe — nav blocks reappear in header/footer.
      const key = `${text}::${url}`;
      if (seen.has(key)) return ` ${text} `;
      seen.add(key);
      return ` ${text} (${url}) `;
    }
  );
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const fetched = await Promise.all(
  validSources.map(async (s) => {
    try {
      const res = await fetch(s.url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; ArchTrendsBot/1.0; +https://design-competition-ontology.vercel.app)",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const text = stripHtml(html, s.url).slice(0, 9000);
      return { ...s, text, ok: true };
    } catch (err) {
      console.warn(`수집 실패 ${s.name}: ${err.message}`);
      return { ...s, text: "", ok: false, error: String(err) };
    }
  })
);

const okSources = fetched.filter((f) => f.ok);
if (okSources.length === 0) {
  console.error("모든 사이트 fetch 실패");
  process.exit(1);
}

const now = new Date();
const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
const dateStr = kst.toISOString().slice(0, 10);
const dayOfWeek = ["일", "월", "화", "수", "목", "금", "토"][kst.getUTCDay()];
const slug = `${dateStr}_${dayOfWeek}`;

// Find the most recent prior weekly file (skip this run's slug if a same-day
// re-run is happening). Extract its `### Title` lines so we can ask the model
// to prefer genuinely new picks, and mark survivors as carryovers.
const _allMd = (await readdir(".")).filter((f) =>
  /^\d{4}-\d{2}-\d{2}_.+\.md$/.test(f)
);
const _priorFile = _allMd
  .filter((f) => f !== `${slug}.md`)
  .sort()
  .reverse()[0];
let priorTitles = [];
if (_priorFile) {
  const priorContent = await readFile(_priorFile, "utf8");
  priorTitles = [...priorContent.matchAll(/^###\s+(?:\[신규\]\s*)?(.+)$/gm)].map(
    (m) => m[1].trim()
  );
  console.log(
    `이전 회차 ${_priorFile}: 제목 ${priorTitles.length}개 추출 → 프롬프트에 중복 회피 힌트로 주입`
  );
}

const prompt = `당신은 한국 건축 현상설계 **트렌드 분석가**입니다. 단순 공모 리스트가 아니라, 현상설계 실무자가 *설계 어휘·전략을 갈고닦는 데 쓸 트렌드*를 추출하세요. **아래 제공된 텍스트만** 사용. 외부 도구 사용 금지.

## 핵심 차이 — 캘린더 vs 트렌드
**나쁜 출력 (캘린더)**: "현남행정문화복합센터 — 5/15 마감, 양양군 발주, 112억 규모, 농촌 복합거점"
**좋은 출력 (트렌드)**: "농촌 행정-문화 복합거점 모델 정착 — 이번 주 2건(양양·OO), 둘 다 인구감소 소도시. 디자인 시사: 단일 매스로 행정+도서관+공연 통합. RFP에서 '주민 마당' 키워드 빈출. 광장·진입부 처리가 당락 결정."

## 미션
이번 주 사이트 텍스트 전체를 훑은 뒤, **현상설계에 실제 적용 가능한 트렌드 시그널을 2~4개** 추출합니다. 각 트렌드는 *반드시* 이번 주 관찰된 *둘 이상의 공고*를 evidence로 가져야 합니다 (단일 사례는 트렌드 아님 — 그냥 isolated case).

추출할 트렌드 후보 축 (여러 축이 섞여도 됨):
- **타이폴로지 변화**: 어떤 건물 유형 발주가 늘고 있나 (학교·도서관·복지·복합문화·산업·SOC)
- **RFP 언어 변화**: 발주처가 강조하는 키워드 (탄소중립·그린리모델링·통합돌봄·지역상생·복합거점·역세권 연계 등)
- **방식 변화**: 신축 vs 리모델링 비율, 대형 vs 소형, 단독 vs 복합
- **부지·맥락 패턴**: 신도시·구도심·농촌·역세권 등 어디에 집중
- **국제·일반 공모 시점**: 큰 아이디어 공모(건축대전·서울건축상·국제공모)의 시기 분포·주제 흐름

각 트렌드에 대해:
- **signal**: 이번 주 관찰 근거 (몇 건? 어디서?). 빈도가 약하면 솔직히 "초기 시그널" 명시.
- **design_implication**: *이 트렌드에 응답하려면 현상설계에서 어떤 어휘·공간 전략이 유리한가.* 추상 ("친환경 강화") 금지, 구체 ("외부 복도+테라스 두께 추가로 그린리모델링 표현" 식). **아래 '과거 당선작 어휘 사전' 의 표현을 *재활용·변형·대조*하여 connect 하면 신뢰성 ↑** (단, 사전은 학교급 위주라 비학교 RFP에 무리한 일반화 X).
- **evidence**: 트렌드를 보여주는 *이번 주* 공고 2~5개. 각각 제목·발주처·마감·규모·deep link URL.

## URL 박는 규칙 (중요)
evidence[].url 은 **그 공고 자체로 가는 deep link**여야 합니다. 사이트 텍스트에 \`공고제목 (https://...)\` 형태로 deep link가 보이면 그것을 박으세요. deep link가 안 보일 때만 사이트 메인 URL을 fallback.

## 과거 당선작 어휘 사전 (사용자가 직접 큐레이션한 학교 현상설계 당선작 ${ownPackSummary.total}건)
형식: [packSlug · phase · year · siteContext] 학교명 → decisiveMove

${
  ownPackSummary.lines.length > 0
    ? ownPackSummary.lines.join("\n")
    : "(사전 fetch 실패 또는 비어있음 — 일반 지식으로만 추론)"
}

## 이미 다뤘던 트렌드 관점 (지난 회차 — 같은 시각 반복 피하기)
${
  priorTitles.length > 0
    ? priorTitles.map((t) => `- ${t}`).join("\n")
    : "(첫 회차 — 비교 대상 없음)"
}

## 사이트 텍스트 (${okSources.length}개)
${okSources
  .map((f) => `### ${f.name} (${f.url})\n${f.text}`)
  .join("\n\n---\n\n")}

**응답 규칙 (절대 준수):**
- 첫 글자부터 \`{\` 또는 \`\`\`json 으로 시작. 인사·설명·"분석하겠습니다" 같은 서론 **금지**.
- 아래 스키마 그대로 다른 텍스트 없이만 출력.

{
  "weekly_summary": "두세 문장 — 이번 주 트렌드 종합 (~150자)",
  "trend_note": "한 문장 — 이번 주 정수 슬로건 (~40자)",
  "trends": [
    {
      "title": "트렌드 한 줄 제목 (~30자, 예: '농촌 행정-문화 복합거점 모델 정착')",
      "signal": "이번 주 관찰 근거 + 빈도 (~100자)",
      "design_implication": "현상설계에 적용 가능한 구체 어휘·전략 (~150자)",
      "evidence": [
        {
          "title": "공고명",
          "organizer": "발주처",
          "deadline": "YYYY-MM-DD 또는 '미명시'",
          "scale": "규모 한 줄 (없으면 빈 문자열)",
          "url": "원문 deep link URL"
        }
      ]
    }
  ]
}`;

const STRUCTURED_SCHEMA = {
  type: "object",
  properties: {
    weekly_summary: {
      type: "string",
      description: "두세 문장 요약 (~120자)",
    },
    trend_note: {
      type: "string",
      description: "이번 주 흐름 한 문장 (~40자)",
    },
    picks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "공고명" },
          organizer: { type: "string", description: "발주처" },
          deadline: {
            type: "string",
            description: "마감일 (YYYY-MM-DD 또는 '미명시')",
          },
          scale: {
            type: "string",
            description:
              "규모 한 줄 (학급수·연면적·예산 등 하나만. 없으면 빈 문자열)",
          },
          url: { type: "string", description: "원문 URL" },
          why: {
            type: "string",
            description: "왜 흥미로운지 한 문장 (~80자)",
          },
        },
        required: ["title", "organizer", "deadline", "url", "why"],
      },
    },
  },
  required: ["weekly_summary", "trend_note", "picks"],
};

if (DRY_RUN) {
  console.log("=== DRY RUN — 프롬프트 미리보기 ===");
  console.log(prompt.slice(0, 1500));
  console.log("...");
  console.log(`(전체 길이: ${prompt.length}자, agent_profile=${AGENT_PROFILE})`);
  process.exit(0);
}

console.log(`Manus task.create 호출 — profile=${AGENT_PROFILE}`);
const createRes = await fetch(`${BASE_URL}/task.create`, {
  method: "POST",
  headers: {
    "x-manus-api-key": API_KEY,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    message: { content: [{ type: "text", text: prompt }] },
    agent_profile: AGENT_PROFILE,
    hide_in_task_list: true,
    title: `arch-trends ${slug}`,
    // structured_output_schema removed — Manus v2 returns 400 invalid_argument
    // for this field as of 2026-05-11. Bisect in commit 25a13ad confirmed it
    // breaks alone while title/profile/hide_in_task_list each pass. Falling
    // back to assistant_message JSON parsing path (already implemented below).
  }),
});

if (!createRes.ok) {
  console.error(
    `task.create 실패: ${createRes.status} ${await createRes.text()}`
  );
  process.exit(1);
}

const createJson = await createRes.json();
if (!createJson.ok) {
  console.error(`task.create 응답 오류:`, createJson);
  process.exit(1);
}
const taskId = createJson.task_id;
console.log(`Task 생성됨: ${taskId}`);

async function pollOnce() {
  const res = await fetch(
    `${BASE_URL}/task.listMessages?task_id=${encodeURIComponent(
      taskId
    )}&order=desc&limit=100&verbose=true`,
    { headers: { "x-manus-api-key": API_KEY } }
  );
  if (!res.ok) {
    throw new Error(`listMessages: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

let structuredResult = null;
let lastStatus = "running";
for (let i = 0; i < MAX_POLLS; i++) {
  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  let pollJson;
  try {
    pollJson = await pollOnce();
  } catch (err) {
    console.warn(`Poll ${i + 1} 실패: ${err.message} — 재시도`);
    continue;
  }
  const messages = pollJson.messages || [];

  const structured = messages.find(
    (m) =>
      m.type === "structured_output_result" &&
      m.structured_output_result?.value
  );
  if (structured) {
    structuredResult = structured.structured_output_result.value;
    console.log("structured_output_result 수신");
    break;
  }

  const stopped = messages.find(
    (m) =>
      m.type === "status_update" &&
      m.status_update?.agent_status === "stopped"
  );
  if (stopped) {
    console.log("Task stopped — assistant_message에서 JSON 추출 시도");
    const assistant = messages.find((m) => m.type === "assistant_message");
    const raw = assistant?.assistant_message?.content;
    // Manus v2 returns content as array of typed parts; older paths returned string.
    const text =
      typeof raw === "string"
        ? raw
        : Array.isArray(raw)
        ? raw
            .filter((p) => p?.type === "text" && typeof p.text === "string")
            .map((p) => p.text)
            .join("\n")
        : "";
    if (text) {
      const m =
        text.match(/```json\s*([\s\S]*?)\s*```/) ||
        text.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          structuredResult = JSON.parse(m[1] ?? m[0]);
        } catch (e) {
          console.error("JSON 파싱 실패:", e.message);
          console.error("원문 처음 500자:", text.slice(0, 500));
        }
      } else {
        console.error("JSON 블록 미발견. 원문 처음 500자:", text.slice(0, 500));
      }
    } else {
      console.error("assistant_message.content 비어있음.");
    }
    break;
  }

  const latestStatus = messages.find((m) => m.type === "status_update");
  const status = latestStatus?.status_update?.agent_status || "running";
  if (status !== lastStatus) {
    console.log(`상태: ${status}`);
    lastStatus = status;
  } else {
    console.log(`Poll ${i + 1}: ${status}...`);
  }
}

if (!structuredResult) {
  console.error(
    `Task 타임아웃 또는 결과 없음 (${MAX_POLLS} × ${POLL_INTERVAL_MS}ms)`
  );
  process.exit(1);
}

const data = structuredResult;

// Trends list (renamed from picks). Backward compat — if model returned old
// 'picks' shape, wrap each pick as a single-evidence trend so we don't crash.
if (!Array.isArray(data.trends) && Array.isArray(data.picks)) {
  console.warn("모델이 옛 picks 스키마로 반환 — trends 형태로 래핑");
  data.trends = data.picks.map((p) => ({
    title: p.title || "(제목 없음)",
    signal: "",
    design_implication: p.why || "",
    evidence: [
      {
        title: p.title,
        organizer: p.organizer,
        deadline: p.deadline,
        scale: p.scale || "",
        url: p.url,
      },
    ],
  }));
}
data.trends = Array.isArray(data.trends) ? data.trends : [];
console.log(
  `트렌드 ${data.trends.length}개 추출 (evidence 총 ${data.trends.reduce(
    (n, t) => n + (Array.isArray(t.evidence) ? t.evidence.length : 0),
    0
  )}건)`
);

const heroDate = dateStr.replaceAll("-", ".");

const md = `---
title: ${slug} — 건축 현상설계 트렌드
eyebrow: WEEKLY · ${heroDate} ${dayOfWeek}
hero_title: "${heroDate}<br/><i>${data.trend_note}</i>"
description: ${data.weekly_summary}
---

## 이번 주 흐름

${data.weekly_summary}

${data.trends
  .map((t, i) => {
    const evidenceList = (Array.isArray(t.evidence) ? t.evidence : [])
      .map(
        (e) =>
          `- [${e.title}](${e.url}) — ${e.organizer || "발주처 미상"} · 마감 ${
            e.deadline || "미명시"
          }${e.scale ? ` · ${e.scale}` : ""}`
      )
      .join("\n");
    return `## 트렌드 ${i + 1}. ${t.title}

**시그널** — ${t.signal || "(근거 없음)"}

**디자인 시사** — ${t.design_implication || "(시사 없음)"}

**이번 주 evidence**:

${evidenceList || "_(없음)_"}
`;
  })
  .join("\n---\n\n")}

---

> 자동 큐레이션 (Manus ${AGENT_PROFILE}) · ${okSources.length}개 사이트 수집 · 사람 검수 권장
`;

await writeFile(`${slug}.md`, md);
console.log(`${slug}.md 저장됨`);

const files = (await readdir("."))
  .filter((f) => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(f))
  .sort()
  .reverse();

// Build a teaser block from THIS run's trends so the index page is never
// just a bare 회차 list. The teaser is regenerated every run, so it always
// reflects the latest issue.
const sourceNames = validSources
  .map((s) => s.name.replace(/\s*\([^)]+\)\s*$/, "").trim())
  .filter(Boolean);
const sourceLine =
  sourceNames.length > 0 ? sourceNames.join(" · ") : "(미설정)";
const trendTeaser =
  data.trends.length > 0
    ? data.trends.map((t, i) => `${i + 1}. **${t.title}**`).join("\n")
    : "_(이번 주 트렌드 추출 결과 없음)_";
const ownPackLine =
  ownPackSummary.total > 0
    ? `사용자가 직접 큐레이션한 학교 현상설계 당선작 **${ownPackSummary.total}건**의 어휘 사전`
    : "사용자 당선작 어휘 사전";

const indexMd = `---
title: 건축 현상설계 트렌드
eyebrow: WEEKLY · KOREA ARCH COMPETITIONS
hero_title: "Weekly Pulse,<br/><i>건축 현상설계.</i>"
description: 매주 월요일 09:00 KST, 한국 건축 현상설계 트렌드를 자동 추출합니다. 발주 캘린더가 아니라 설계 어휘·전략에 초점.
stats:
  - num: "${validSources.length}"
    lbl: "수집 사이트"
  - num: "주 1회"
    lbl: "갱신 주기"
  - num: "${files.length}"
    lbl: "회차"
---

## 이번 주 (${slug})

${data.weekly_summary}

**다룬 트렌드 ${data.trends.length}건:**

${trendTeaser}

[→ 자세히 보기](${slug}.html)

## 이 큐레이션이 하는 것

매주 월요일 09:00 KST, **${sourceLine}** ${validSources.length}곳에서 새로 뜬 공모와 결과를 자동 수집해 Manus AI가 트렌드를 추출합니다.

단순 공모 캘린더가 아니라 **설계 어휘·전략** 추출이 목적입니다. 매 트렌드마다 evidence 공고 묶음과 함께 구체적인 디자인 시사(공간 어휘·다이어그램 전략·재료 선택)를 같이 제시합니다.

디자인 시사 작성 시 ${ownPackLine}을 직접 참조하므로, 응모안 컨셉 스타팅 포인트로 바로 활용 가능합니다.

자동 추출이라 일부 표면 패턴·노이즈 섞일 수 있음 — 사람 검수 권장.

## 회차

${files
  .map((f) => `- [${f.replace(".md", "")}](${f.replace(".md", ".html")})`)
  .join("\n")}
`;

await writeFile("index.md", indexMd);
console.log(`index.md 갱신됨 (${files.length}회차)`);
