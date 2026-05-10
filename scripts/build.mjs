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

function stripHtml(html) {
  return html
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
      const text = stripHtml(html).slice(0, 20000);
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

const prompt = `당신은 한국 건축 현상설계 트렌드 큐레이터입니다. **아래 제공된 텍스트만** 사용하세요. 외부 웹 브라우징·도구 사용 금지 — 순수하게 텍스트만 읽고 판단.

## 미션
1. 새로 뜬 의미 있는 공모전·발주·설계공고를 3~5개 골라주세요.
   - 단순 행정공고·자료실 글 제외.
   - *건축 설계*가 본질인 것만. 단순 시공·전기·기계 분리 발주 제외.
2. 각 항목에 한 문장 큐레이션 — *왜 이게 흥미로운지*. 규모·발주처 의도·시기적 의미·이전 패턴과의 차이 중 하나에 집중.
3. 이번 주 전체 흐름 두세 문장 요약.

## 사이트 텍스트 (${okSources.length}개)
${okSources
  .map((f) => `### ${f.name} (${f.url})\n${f.text}`)
  .join("\n\n---\n\n")}

structured_output_schema 에 정의된 JSON 형식으로만 응답하세요.`;

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
    message: { content: prompt },
    agent_profile: AGENT_PROFILE,
    hide_in_task_list: true,
    title: `arch-trends ${slug}`,
    structured_output_schema: STRUCTURED_SCHEMA,
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
    const text = assistant?.assistant_message?.content;
    if (typeof text === "string") {
      const m =
        text.match(/```json\s*([\s\S]*?)\s*```/) ||
        text.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          structuredResult = JSON.parse(m[1] ?? m[0]);
        } catch (e) {
          console.error("JSON 파싱 실패:", e.message);
        }
      }
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
    (p) => `### ${p.title}

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
