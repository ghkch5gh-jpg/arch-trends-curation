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
      const text = stripHtml(html, s.url).slice(0, 12000);
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

const prompt = `당신은 한국 건축 현상설계 트렌드 큐레이터입니다. **아래 제공된 텍스트만** 사용하세요. 외부 웹 브라우징·도구 사용 금지 — 순수하게 텍스트만 읽고 판단.

## 미션
1. 새로 뜬 의미 있는 공모전·발주·설계공고를 3~5개 골라주세요.
   - 단순 행정공고·자료실 글 제외.
   - *건축 설계*가 본질인 것만. 단순 시공·전기·기계 분리 발주 제외.
   - **이미 지난 회차에서 다룬 공고는 가능한 한 제외** — 같은 공고가 또 보이면 신규 픽을 우선.
2. 각 항목에 한 문장 큐레이션 — *왜 이게 흥미로운지*. 규모·발주처 의도·시기적 의미·이전 패턴과의 차이 중 하나에 집중.
3. 이번 주 전체 흐름 두세 문장 요약.

## URL 박는 규칙 (중요)
각 항목의 \`url\` 필드는 **그 공고 자체로 가는 deep link**여야 합니다. 사이트 텍스트 안에 \`공고제목 (https://...)\` 형태로 deep link가 보이면 그것을 박으세요. deep link가 안 보일 때만 사이트 메인 URL을 fallback으로 사용하세요.

## 이미 다뤘던 공고 (지난 회차 카피)
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
- 아래 JSON 스키마 그대로, 다른 텍스트 없이만 출력.

{
  "weekly_summary": "두세 문장 요약 (~120자)",
  "trend_note": "이번 주 흐름 한 문장 (~40자)",
  "picks": [
    {
      "title": "공고명",
      "organizer": "발주처",
      "deadline": "YYYY-MM-DD 또는 '미명시'",
      "scale": "규모 한 줄 (없으면 빈 문자열)",
      "url": "원문 URL",
      "why": "왜 흥미로운지 한 문장 (~80자)"
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

// Annotate which picks are genuinely new vs carried over from a prior week.
// Normalized comparison so slight rewording doesn't false-positive.
const _norm = (s) => (s || "").replace(/\s+/g, "").toLowerCase();
const _priorNorm = priorTitles.map(_norm);
for (const p of data.picks || []) {
  if (priorTitles.length === 0) {
    p.isNew = false; // first run — "new" isn't meaningful
    continue;
  }
  const np = _norm(p.title);
  const matched = _priorNorm.some(
    (pp) =>
      pp === np ||
      (np.length >= 8 && pp.length >= 8 && (np.includes(pp) || pp.includes(np)))
  );
  p.isNew = !matched;
}
const newCount = (data.picks || []).filter((p) => p.isNew).length;
console.log(
  `픽 ${(data.picks || []).length}개 중 신규 ${newCount}개 (지난 회차 대비)`
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

## 큐레이션

${data.picks
  .map(
    (p) => `### ${p.isNew ? "[신규] " : ""}${p.title}

- **발주처**: ${p.organizer}
- **마감**: ${p.deadline}${p.scale ? `\n- **규모**: ${p.scale}` : ""}
- [원문 링크](${p.url})

${p.why}
`
  )
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

const indexMd = `---
title: 건축 현상설계 트렌드
eyebrow: WEEKLY · KOREA ARCH COMPETITIONS
hero_title: "Weekly Pulse,<br/><i>건축 현상설계.</i>"
description: 매주 월요일 09:00 KST, 새로 뜬 공모전과 발주 흐름을 정리합니다.
stats:
  - num: "${validSources.length}"
    lbl: "수집 사이트"
  - num: "주 1회"
    lbl: "갱신 주기"
  - num: "${files.length}"
    lbl: "회차"
---

## 회차

${files
  .map((f) => `- [${f.replace(".md", "")}](${f.replace(".md", ".html")})`)
  .join("\n")}
`;

await writeFile("index.md", indexMd);
console.log(`index.md 갱신됨 (${files.length}회차)`);
