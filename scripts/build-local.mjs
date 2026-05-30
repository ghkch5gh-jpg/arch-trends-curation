#!/usr/bin/env node
// 로컬 생성기 — 수집 → claude -p (정액제) → 회차 .md(시맨틱 HTML) → index.md.
// 도메인: 한국 건축 현상설계/설계공모 "공고" 주간 큐레이션.
// 레이아웃·말투는 dangsun /news·/curation 과 동일한 .ni 카드: 항목마다 시그널/응모 검토/왜 지금/주목도/출처.
//   DRY_RUN=1 : 수집+프롬프트만   FORCE=1 : 오늘 회차 강제 재생성   CLAUDE_MODEL=opus
import { readFile, writeFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";

const DRY_RUN = process.env.DRY_RUN === "1";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "sonnet";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";

const sources = JSON.parse(await readFile("scripts/sources.json", "utf8"));

const now = new Date();
const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
const sinceIso = yesterday.toISOString().slice(0, 10);
const sinceTs = Math.floor(yesterday.getTime() / 1000);

const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
const dateStr = kst.toISOString().slice(0, 10);
const dayOfWeek = ["일", "월", "화", "수", "목", "금", "토"][kst.getUTCDay()];
const slug = `${dateStr}_${dayOfWeek}`;

const existing = (await readdir(".")).filter((f) => f === `${slug}.md`);
if (existing.length && process.env.FORCE !== "1") {
  console.log(`${slug}.md 이미 존재 — 종료 (FORCE=1로 강제 재생성)`);
  process.exit(0);
}

async function fetchWithRetry(url, { headers = {}, attempts = 3, baseDelayMs = 800 } = {}) {
  const mergedHeaders = {
    "User-Agent": "Mozilla/5.0 (compatible; ArchTrendsBot/1.0; +https://www.dangsun.kr)",
    "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
    ...headers,
  };
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: mergedHeaders });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      lastErr = err;
      if (/HTTP (401|403|404)/.test(err.message)) throw err;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(2, i)));
      }
    }
  }
  throw lastErr;
}

function stripHtml(html, baseUrl) {
  const seen = new Set();
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
      if (/^(mailto:|tel:|javascript:|#)/i.test(url)) return ` ${text} `;
      if (text.length < 3) return ` ${text} `;
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
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
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

// RSS/Atom 공통 파서 (공고 RSS 소스가 생길 경우 대비)
function parseFeed(xml, max = 20) {
  const clean = (s) => String(s || "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
  const blocks = xml.split(/<entry[\s>]|<item[\s>]/i).slice(1, max + 1);
  return blocks
    .map((b) => {
      const title = clean((b.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
      let link = (b.match(/<link[^>]*href=["']([^"']+)["']/i) || [])[1];
      if (!link) link = clean((b.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1]);
      const date = ((b.match(/<(updated|pubDate|published|dc:date)[^>]*>([\s\S]*?)<\/\1>/i) || [])[2] || "").slice(0, 10);
      if (!title) return "";
      return `- ${title} (${(link || "").trim()})${date ? ` · ${date}` : ""}`;
    })
    .filter(Boolean)
    .join("\n");
}

async function fetchSource(s) {
  try {
    let url = s.url.replaceAll("__SINCE__", sinceIso).replaceAll("__SINCE_TS__", String(sinceTs));
    const headers = {};
    if (GITHUB_TOKEN && /api\.github\.com/.test(url)) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;

    const res = await fetchWithRetry(url, { headers });
    if (s.kind === "rss") return { ...s, text: parseFeed(await res.text(), 20).slice(0, 9000), ok: true };
    if (s.kind === "json") return { ...s, text: JSON.stringify(await res.json()).slice(0, 9000), ok: true };
    // 기본: 공고 포털 HTML
    return { ...s, text: stripHtml(await res.text(), url).slice(0, 9000), ok: true };
  } catch (err) {
    console.warn(`수집 실패 ${s.name}: ${err.message}`);
    return { ...s, text: "", ok: false };
  }
}

console.log(`소스 ${sources.length}개 fetch 시작...`);
const fetched = await Promise.all(sources.map(fetchSource));
const okSources = fetched.filter((f) => f.ok && f.text);
console.log(`성공: ${okSources.length}/${sources.length}`);
if (okSources.length === 0) {
  console.error("모든 소스 fetch 실패");
  process.exit(1);
}

const allMd = (await readdir(".")).filter((f) => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(f) && f !== `${slug}.md`);
const priorFiles = allMd.sort().reverse().slice(0, 2);
const priorUrls = new Set();
for (const f of priorFiles) {
  for (const m of (await readFile(f, "utf8")).matchAll(/href="(https?:\/\/[^"]+)"/g)) priorUrls.add(m[1]);
}

const SPEC = await readFile("CURATION_SPEC.md", "utf8");

const prompt = `**중요 — 이 요청은 *채팅 응답* 형식입니다. 도구·검색·파일시스템 사용 금지. 응답은 한 덩어리 JSON만. 첫 글자부터 \`{\` 로 시작. 인사·보고문 금지.**

당신은 **한국 건축가·현상설계 실무자를 위한 "건축 설계공모/현상설계 공고" 주간 큐레이터**입니다. 이번 주(${dateStr}, ${dayOfWeek}요일 기준) 회차를 작성하세요. 아래 명세(공고 도메인·필터)를 엄격히 따르세요 — 설계공모·현상설계·건축상·아이디어공모 등 건축가가 *실제로 응모를 검토할 수 있는* 공고 위주로. 마감·발주처·지역·규모(연면적/공사비/설계비)가 명확한 항목을 우선.

# 명세
${SPEC}

# 말투 (이 톤을 그대로 따라하세요 — 실제 레퍼런스 2개)

[예시 A — 설계공모]
본문: "인천 동구가 배다리 복합커뮤니티센터 설계용역을 일반공모로 접수합니다. 돌봄·교육·근린생활을 한 매스에 묶는 6,920㎡ 규모로, 마감은 5월 27일입니다. 발주처 키워드가 '아이행복·통합돌봄'에 쏠려 있어, 1층을 주민 마당처럼 개방하는 구성이 RFP 단골 패턴입니다."
시그널: "복합커뮤니티센터 공고가 같은 주에 3건 — 돌봄·교육·근생을 한 지붕에 묶는 소규모 공공건축 수요가 수도권·충남·제주에 동시 다발입니다."
응모 검토: "마감 5/27. 연면적 6,920㎡·설계비 10.2억으로 중형 사무소 단독 응모 가능 규모. 1층 외부 쌈지마당→내부 실내광장 시퀀스를 전면에 내세울 것."
왜 지금: "같은 유형 3건이 겹친 주라, 한 안을 다듬어 두면 인접 공고에 변형 응모하기 좋습니다."

[예시 B — 건축상·아이디어공모]
본문: "제44회 서울특별시 건축상이 6월 5일까지 접수합니다. 사용승인 완료 건축물 중 도시 맥락 연결·공공성 기여를 내세울 수 있는 작업이 대상입니다. 지역 건축상 시즌이 본격 개막했습니다."
시그널: "서울건축상·경기도건축문화상·계룡 아이디어공모가 한 주에 동시 접수 — 지역 건축상 시즌 개막."
응모 검토: "마감 6/5, D-11로 가장 급함. 사용승인 끝난 프로젝트 중 '도시맥락·공공성' 부합작을 지금 추려야 함. 경기도건축문화상은 계획작품 부문도 있어 진행 중 SD/DD도 출품 가능."
왜 지금: "접수 마감이 줄줄이 임박 — 지금 출품작을 못 고르면 이번 시즌을 통째로 넘깁니다."

→ 해요체/합니다체 섞어 간결하게. 과장·영업체 금지. '시그널'은 이 공고가 가리키는 흐름·패턴(혼자가 아니라 같은 유형이 몇 건인지), '응모 검토'는 마감·규모·자격·준비 전략 등 *응모를 판단·준비*하는 실무 정보(가능하면 마감일·규모 수치 포함), '왜 지금'은 타이밍·긴급도(D-day).

**누구나 이해하게:** 건축 실무자가 1초 만에 "이게 어떤 공고고 / 나한테 응모 가치가 있나"를 파악하게 쓰세요. 건축 약어(RFP·SD·DD·연면적·용적률 등)는 그대로 OK. 발주처·지역·마감·규모는 빠짐없이. 과장 없이 사실 위주로.

# 수집된 소스 (${okSources.length}개)
${okSources.map((f) => `### ${f.name}\n${f.text}`).join("\n\n---\n\n")}

# 직전 회차 URL (중복 금지)
${[...priorUrls].slice(0, 50).map((u) => `- ${u}`).join("\n") || "(없음)"}

# 출력 스키마 (이대로만)
\`\`\`
{
  "edition_note": "이번 주 호 한 줄 소개 (~90자) — 무슨 유형이 화제였는지",
  "intro": "맨 처음 흐름 요약 — '이번 주는' 으로 시작. 쉽고 자연스러운 한국어 4~6문장. 이번 주 공고들을 관통하는 유형·지역·발주처 흐름을 한 호흡으로. 예시 톤: 이번 주는 '돌봄·복지·커뮤니티'를 한 지붕에 묶는 복합센터 공고가 수도권·충남·전남에 동시 다발로 쏟아졌고, 지역 건축상 접수도 줄줄이 열렸습니다. 학교 신축은 부산 고교 한 건으로 조용한 반면, 어촌 생활거점 조성이 충남에서 두 건 겹쳐 지역 밀착형 소규모 공공건축 수요가 뚜렷합니다.",
  "outro": "맺음말 — 이번 주 흐름을 한 발 물러나 본 소회. 응모 전략상 한마디 + 다음 주 전망 2~3문장. 담백하게 마무리.",
  "items": [
    {
      "section": "headline | competition | award | result | notice",
      "title": "공고명 — 한국어, 간결하고 구체적으로 (발주처·시설유형 드러나게)",
      "url": "원본 링크 (수집된 것 중에서만)",
      "source": "출처태그: jootek | wevity | hub | busan | kia",
      "score": 1-10 정수 (요한님 실무 관점 응모 주목도 — 규모·유형 적합·마감 여유 종합),
      "body": "본문 정확히 3~4문장 (분량 통일) — 무슨 공고고 어디·무엇을 짓는지, 발주처 의도가 뭔지, 유사 패턴에 빗대 한 줄",
      "points": ["지역 · 마감일 (예: 인천 동구 · 마감 2026-05-27)", "규모 (예: 연면적 6,920㎡ · 공사비 246억 · 설계비 10.2억)", "(선택) 자격·방식 (예: 일반공모 / 사용승인 완료작 대상)"],
      "gain": "시그널 — 이 공고가 가리키는 흐름·패턴 1~2문장 (같은 유형 몇 건인지, 지역 집중 등)",
      "todo": "응모 검토 — 마감·규모·자격·준비전략. 즉시 판단에 필요한 실무 정보 1~2문장 (마감일·규모 수치 포함)",
      "why_now": "왜 지금 — 타이밍·긴급도(D-day) 1~2문장"
    }
  ]
}
\`\`\`

분량·분류 규칙:
- section "headline": **이번 주 가장 주목할 3~5개** (출처 무관, 응모 가치 톱). 나머지 섹션과 중복 게재 금지.
- "competition"(설계공모·현상설계): 건축 설계용역 공모·현상설계 본 공고. "award"(건축상·아이디어공모): 건축상·계획/아이디어 공모전. "result"(결과·당선작): 결과 발표·당선작 공개. "notice"(예정·기타): 접수예정·사전공고·기타 관련 공고. 각각 **2~6개**, 해당 유형 없으면 비워도 됨 (지어내기 금지).
- 전체 12~22개. 수집 안 된 내용 지어내지 말 것. URL은 반드시 위 소스에 등장한 것. 마감·발주처·규모가 불명확한 generic 항목·랜딩페이지는 제외. 건축과 무관한 공모(디자인·미술·논문 등)는 제외.`;

console.log(`Prompt: ${(Buffer.byteLength(prompt, "utf8") / 1024).toFixed(1)} KB`);
if (DRY_RUN) {
  console.log("=== DRY RUN ===\n" + prompt.slice(0, 2500) + `\n...(전체 ${prompt.length}자)`);
  process.exit(0);
}

function callClaude(promptText) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "text", "--allowedTools", "", "--model", CLAUDE_MODEL];
    console.log(`claude -p (${CLAUDE_MODEL}) 호출...`);
    const child = spawn("claude", args, { stdio: ["pipe", "pipe", "inherit"], shell: true });
    let out = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("타임아웃 5분")); }, 5 * 60 * 1000);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`claude exit ${code}`)); });
    child.stdin.write(promptText);
    child.stdin.end();
  });
}

const raw = await callClaude(prompt);
const jm = raw.match(/```json\s*([\s\S]*?)\s*```/) || raw.match(/\{[\s\S]*\}/);
if (!jm) { console.error("JSON 미발견:", raw.slice(0, 600)); process.exit(1); }
let data;
try { data = JSON.parse(jm[1] ?? jm[0]); } catch (e) { console.error("파싱 실패:", e.message, "\n", raw.slice(0, 600)); process.exit(1); }

// ===== 가벼운 검증: 선택 항목의 원문을 실제로 fetch 해서 요약을 대조·정정 =====
// (1차 선정은 목록 스니펫 기반이라 마감일·규모·발주처 환각 위험 → 원문과 1회 대조)
async function verifyItems(items) {
  if (!items.length) return items;
  console.log(`검증: ${items.length}개 항목 원문 fetch...`);
  const withSrc = await Promise.all(items.map(async (it) => {
    if (!/^https?:\/\//.test(it.url || "")) return { it, src: "" };
    try {
      const res = await fetchWithRetry(it.url, { attempts: 2, baseDelayMs: 500 });
      const ct = res.headers.get("content-type") || "";
      if (!/text|html|json|xml/i.test(ct)) return { it, src: "" };
      return { it, src: stripHtml(await res.text(), it.url).slice(0, 2200) };
    } catch { return { it, src: "" }; }
  }));
  const fetched = withSrc.filter((x) => x.src).length;
  console.log(`  원문 확보: ${fetched}/${items.length}`);
  if (!fetched) return items.map((it) => ({ ...it, verified: false }));

  const payload = withSrc.map((x, i) => ({
    idx: i, title: x.it.title, body: x.it.body, gain: x.it.gain, todo: x.it.todo,
    source_excerpt: x.src || "(원문 못 가져옴)",
  }));
  const vPrompt = `**채팅 응답. 도구·검색 금지. 응답은 JSON 배열 하나만, 첫 글자 [ 로 시작.**
당신은 건축 공고 팩트체커입니다. 각 항목은 [작성된 요약(body/gain/todo)] + [원문 발췌(source_excerpt)]. 원문에 비춰:
- 원문에 근거하면 그대로(작은 표현만 다듬기), 원문에 없는 사실·과장·환각(마감일/연면적/공사비/설계비/발주처/지역 오류 등)은 원문 기준으로 정정.
- source_excerpt 가 "(원문 못 가져옴)" 이면 검증 불가 → 손대지 말고 verified=false.
- 한국어·기존 말투 유지. 건축 약어 유지.
각 항목 반환: { "idx": 정수, "body": "...", "gain": "...", "todo": "...", "verified": true/false, "note": "정정했으면 한 줄, 없으면 빈 문자열" }

# 항목
${JSON.stringify(payload)}

# 출력 (JSON 배열만)`;
  let vraw;
  try { vraw = await callClaude(vPrompt); }
  catch (e) { console.warn(`검증 호출 실패: ${e.message} — 원본 유지`); return items.map((it) => ({ ...it, verified: false })); }
  const vm = vraw.match(/```json\s*([\s\S]*?)\s*```/) || vraw.match(/\[[\s\S]*\]/);
  if (!vm) { console.warn("검증 JSON 미발견 — 원본 유지"); return items.map((it) => ({ ...it, verified: false })); }
  let verdicts;
  try { verdicts = JSON.parse(vm[1] ?? vm[0]); } catch { console.warn("검증 파싱 실패 — 원본 유지"); return items.map((it) => ({ ...it, verified: false })); }
  const byIdx = new Map(verdicts.map((v) => [v.idx, v]));
  let okCount = 0, fixCount = 0;
  const out = items.map((it, i) => {
    const v = byIdx.get(i);
    if (!v) return { ...it, verified: false };
    if (v.body && v.body !== it.body) fixCount++;
    if (v.verified) okCount++;
    return {
      ...it,
      body: v.body || it.body,
      gain: v.gain || it.gain,
      todo: v.todo || it.todo,
      verified: !!v.verified,
    };
  });
  console.log(`  검증 완료: 대조통과 ${okCount} · 정정 ${fixCount}`);
  return out;
}
data.items = await verifyItems(Array.isArray(data.items) ? data.items : []);

// ===== 시맨틱 HTML 렌더 (.ni 카드 — news·curation 과 동일 폼) =====
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const SECTIONS = [
  ["headline", "이번 주 핵심 공고"],
  ["competition", "설계공모 · 현상설계"],
  ["award", "건축상 · 아이디어공모"],
  ["result", "결과 · 당선작"],
  ["notice", "예정 · 기타"],
];
const SRC_LABEL = { jootek: "주택폴리오", wevity: "위비티", hub: "건축HUB", busan: "부산건축공모", kia: "한국건축가협회" };
const isCmd = (s) => /(^\$|pip install|npm |npx |git clone|brew |docker|curl |uv |cargo |huggingface-cli|conda )/i.test(String(s || "").trim());
const HANGUL = /[가-힣]/;
const isPureCmd = (s) => isCmd(s) && !HANGUL.test(s.replace(/^\$\s*/, ""));
const CMD_TOKENS = "pipx|pip|npm|npx|pnpm|yarn|git|brew|docker|curl|wget|uvx|uv|cargo|conda|ollama|huggingface-cli|python3|python|node";
const CMD_RUN_RE = new RegExp(`(^|\\s)((?:${CMD_TOKENS})(?=\\s|$)[^\\uAC00-\\uD7A3\\n]*)`, "g");
const highlightCmds = (escaped) =>
  escaped.replace(CMD_RUN_RE, (_m, lead, run) => {
    const trail = run.match(/\s*$/)[0];
    return `${lead}<code class="ni__code">${run.slice(0, run.length - trail.length)}</code>${trail}`;
  });
const codeSpans = (escaped) =>
  escaped
    .replace(/`([^`\n]+)`/g, (_m, c) => `<code class="ni__code">${c}</code>`)
    .replace(/\*\*([^*\n]+)\*\*/g, (_m, b) => `<strong>${b}</strong>`);
const inlineEsc = (s) => codeSpans(esc(s));
const todoProse = (s) => highlightCmds(codeSpans(esc(s)));
const stripBackticks = (s) => s.replace(/`/g, "");

const items = Array.isArray(data.items) ? data.items : [];
let n = 0;
function renderItem(it) {
  n += 1;
  const num = String(n).padStart(2, "0");
  const todo = String(it.todo || "").trim();
  const todoHtml = isPureCmd(todo)
    ? `<pre class="ni__cmd"><code>${esc(stripBackticks(todo).replace(/^\$\s*/, ""))}</code></pre>`
    : `<p class="ni__do-text">${todoProse(todo)}</p>`;
  const points = (it.points || []).map((p) => `<li>${inlineEsc(p)}</li>`).join("");
  const src = SRC_LABEL[it.source] || esc(it.source || "");
  const score = Number.isFinite(+it.score) ? `${+it.score}/10` : "";
  return `<article class="ni reveal">
  <header class="ni__h">
    <span class="ni__n">${num}</span>
    <a class="ni__t" href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)} <span class="ni__arrow">↗</span></a>
    <span class="ni__tr">${src ? `<span class="ni__src">${src}</span>` : ""}${score ? `<span class="ni__score">${score}</span>` : ""}</span>
  </header>
  <p class="ni__body">${inlineEsc(it.body)}</p>
  ${points ? `<ul class="ni__pts">${points}</ul>` : ""}
  <div class="ni__meta">
    <div class="ni__row"><dt>시그널</dt><dd>${inlineEsc(it.gain)}</dd></div>
    <div class="ni__row ni__row--do"><dt>응모 검토</dt><dd>${todoHtml}</dd></div>
    <div class="ni__row ni__row--why"><dt>왜 지금</dt><dd>${inlineEsc(it.why_now)}</dd></div>
  </div>
  <footer class="ni__f"><span class="ni__verified">${it.verified ? "✓ 원문 대조" : ""}</span><a class="ni__story" href="${esc(it.url)}" target="_blank" rel="noopener">공고 보기 →</a></footer>
</article>`;
}

let bodyHtml = "";
let total = 0;
for (const [key, label] of SECTIONS) {
  const secItems = items.filter((it) => it.section === key);
  if (!secItems.length) continue;
  total += secItems.length;
  bodyHtml += `<section class="news-sec">\n<h2 class="news-sec__t">${label}</h2>\n${secItems.map(renderItem).join("\n")}\n</section>\n`;
}
const orphans = items.filter((it) => !SECTIONS.some(([k]) => k === it.section));
if (orphans.length) {
  bodyHtml += `<section class="news-sec">\n<h2 class="news-sec__t">그 외</h2>\n${orphans.map(renderItem).join("\n")}\n</section>\n`;
  total += orphans.length;
}

const note = String(data.edition_note || "").replaceAll('"', "'").trim();
const introHtml = data.intro ? `<section class="news-flow-sec reveal"><h2 class="news-flow__t">이번 주 흐름</h2><div class="news-flow"><p>${inlineEsc(data.intro)}</p></div></section>\n` : "";
const outroHtml = data.outro ? `<div class="news-outro"><span class="news-outro__t">맺음말</span><p>${inlineEsc(data.outro)}</p></div>\n` : "";
const md = `---
title: ${dateStr} (${dayOfWeek}) — 건축 현상설계 트렌드
eyebrow: ARCH · COMPETITION WEEKLY
hero_title: "${dateStr.replaceAll("-", " · ")} <em>(${dayOfWeek})</em>"
description: "${note}"
summary: ${note}
---

<div class="news">
${introHtml}${bodyHtml}${outroHtml}</div>
`;

await writeFile(`${slug}.md`, md);
console.log(`${slug}.md 저장 — 항목 ${total}개`);

// ===== index.md 재생성 =====
const files = (await readdir(".")).filter((f) => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(f)).sort().reverse();
async function readSummaryOf(file) {
  try {
    const fm = (await readFile(file, "utf8")).replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---/);
    if (!fm) return "";
    const s = fm[1].match(/^summary:\s*(.+)$/m);
    if (s) return s[1].trim();
    const d = fm[1].match(/^description:\s*"?(.+?)"?$/m);
    return d ? d[1].trim() : "";
  } catch { return ""; }
}
const entries = await Promise.all(files.map(async (f) => {
  const slugOnly = f.replace(".md", "");
  const summary = await readSummaryOf(f);
  const mm = slugOnly.match(/^(\d{4}-\d{2}-\d{2})_(.+)$/);
  const label = mm ? `${mm[1]} (${mm[2]})` : slugOnly;
  return summary ? `- [${label} — ${summary}](${slugOnly}.html)` : `- [${label}](${slugOnly}.html)`;
}));

const indexMd = `---
title: 건축 현상설계 트렌드
eyebrow: ARCH · COMPETITION WEEKLY
hero_title: "건축 현상설계 <em>트렌드</em>"
description: 매주, 주택폴리오·위비티·건축HUB·부산건축공모·한국건축가협회에서 그 주의 설계공모·현상설계·건축상 공고를 골라 한국어로 정리합니다. 항목마다 '시그널 · 응모 검토 · 왜 지금'으로 바로 판단하게.
stats:
  - num: "매주"
    lbl: "Weekly"
  - num: "${sources.length}"
    lbl: "Sources"
  - num: "5"
    lbl: "Sections"
  - num: "${files.length}"
    lbl: "회차"
---

## 회차 목록

${entries.join("\n")}
{:.episode-list}

*매주 새 회차가 자동으로 추가됩니다.*

## 각 회차 구성

- **이번 주 핵심 공고** — 출처 무관, 그 주 응모 가치 톱 3~5
- **설계공모 · 현상설계 / 건축상 · 아이디어공모 / 결과 · 당선작 / 예정 · 기타**
- 항목마다 *시그널 · 응모 검토 · 왜 지금* + 응모 주목도

## 이 큐레이션은

매주 **주택폴리오 · 위비티 · 건축HUB · 부산건축공모 · 한국건축가협회** 를 자동으로 돌며 그 주에 새로 열린 설계공모·현상설계·건축상 공고 중 실제로 응모를 검토할 만한 것만 골라 정리합니다. Claude Code 구독으로 로컬 생성하므로 별도 API 비용이 없습니다.
`;

await writeFile("index.md", indexMd);
console.log(`index.md 갱신 (${files.length}회차)`);
