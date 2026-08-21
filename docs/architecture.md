# 구조와 경계

`realestate-auction-myauction/docs/all-apps-architecture.md` 의 공통 구조를 따른다.

## 런타임 경계

- **정적 UI**: 저장소 루트(`index.html`, `assets/`, `manifest.webmanifest`, `sw.js`).
  이 경로들은 공개 URL이자 PWA 캐시 계약이므로 **이름을 바꾸거나 옮기지 않는다.**
- **API**: 없음. 배포는 정적 전용이고, Claude API는 브라우저가 직접 호출한다.
- **저장소(데이터)**: 없음. 초안·이력·API 키·사용량은 전부 `localStorage`.
  서버도, `data/` 디렉터리도 없다.

## 왜 briefing 앱에 붙이지 않았나

`briefing` 앱은 `docs/architecture.md` 에 `API: none; deployment is static-only` 로
경계가 명시된 **순수 정적 열람 앱**이고, 온 가족이 보는 PUBLIC 저장소다.
거기에 API 키 입력과 글 작성 기능을 넣으면 그 경계가 깨진다.
`article-search` 가 이미 "같은 팔레트, 별도 저장소"로 분리한 선례가 있어 같은 방식을 썼다.

## 파일 경계

| 파일 | 책임 | 넘지 않는 선 |
|---|---|---|
| `assets/agents.js` | 옵션 목록·역할 프롬프트·단계 정의 | DOM을 만지지 않는다. `window.BW` 하나만 내보낸다 |
| `assets/app.js` | API 호출·파이프라인·렌더·저장 | 프롬프트 문구를 여기서 만들지 않는다 |
| `assets/app.css` | 스타일 | — |

### agents.js 는 IIFE로 감싸 둔다

클래식 `<script>` 는 **전역 렉시컬 스코프를 공유한다.** `agents.js` 와 `app.js` 가 둘 다
최상위에 `const STAGES` 를 선언하면 `Identifier 'STAGES' has already been declared` 로
**app.js 가 아예 로드되지 않는다.** 그래서 `agents.js` 전체를 IIFE로 감싸고 `window.BW` 만
내보낸다. 새 전역 상수를 추가할 때 이 경계를 깨지 않도록 주의.

## 파이프라인 계약

`STAGES` 배열의 각 항목이 한 단계다. 단계를 추가·수정할 때 지킬 것:

```js
{
  key, no, label, desc,
  effort,                       // 'low' | 'medium' | 'high' — Haiku 4.5 는 자동 생략됨
  maxTokens,                    // 숫자 또는 (ctx) => 숫자. 사고+본문 합산 상한
  tools: (input) => 'fetch+search' | 'search' | 'none',
  system: (ctx) => string,      // ctx = { input, opts, stages }
  user:   (ctx) => string,
}
```

- 각 단계는 **JSON 객체 하나**만 반환해야 한다. `extractJSON()` 이 코드펜스와 잡소리를 걷어낸다.
- `skipIf(ctx)` 가 true 면 API 호출 없이 `skipResult` 를 결과로 쓰고 상태를 `skip` 으로 둔다.
  (Visualization 이 이 방식으로, 요청된 차트가 없을 때 요금 없이 건너뛴다.)
- 뒤 단계는 `ctx.stages.<앞단계키>` 로 앞 결과를 읽는다. 순서 의존성은 여기서만 생긴다.
- 단계 결과는 `draft.stages[key]` 에 저장된다. **단계별 재생성**은 그 키와 이후 키만 지우고
  다시 돌리는 방식이라, 단계 사이에 숨은 상태를 두면 안 된다.

## 차트 (Visualization 산출물)

외부 라이브러리 없이 `app.js` 안에서 SVG 문자열을 직접 만든다(빌드 단계를 만들지 않기 위해).

- `vizProblem(v)` 가 먼저 **그릴 수 있는 데이터인지 검사**한다. 포인트 3개 미만, 계열 길이 불일치,
  빈 데이터 등은 그리지 않고 화면에 이유를 표시한다. 조용히 넘기지 않는 것이 원칙이다.
- `renderViz()` → `svgLineBar()` / `svgPie()` / 표. 값 보정이나 생성은 절대 하지 않는다.
- 본문은 `[[viz:N]]` 자리표시자를 쓰고, `mdToHtml` 이 이를 `\u0001VIZn\u0001` 로 남긴 뒤
  `injectViz()` 가 실제 figure 로 바꾼다. 배치되지 않은 차트는 본문 끝에 붙인다(버리지 않는다).
- 마크다운·평문 복사는 `resolveVizText()` 가 차트를 **데이터 표**로 바꾼다.
- `savePng()` 는 SVG → canvas → PNG(2배 크기). 네이버·티스토리에 이미지로 올리는 경로다.

표 스타일은 `.md-table` 기준으로 걸어야 한다. `.md` 하위로 걸면 차트 figure 안의 표에 테두리가 안 붙는다.

## 모델별 분기 (깨지기 쉬운 부분)

`app.js` 상단의 두 목록이 모델 능력 차이를 흡수한다.

- `EFFORT_MODELS` — `output_config.effort` 를 받는 모델. **Haiku 4.5 는 보내면 400.**
- `MODERN_TOOL_MODELS` — `web_search_20260209` / `web_fetch_20260209` 를 쓰는 모델.
  그 외 모델은 `web_search_20250305` / `web_fetch_20250910`.

400이 오면 해당 옵션을 빼고 재시도하고, 그 모델을 `bw-no-effort` / `bw-basic-tools` 에
기억한다. **새 모델을 추가하면 이 두 목록에 함께 등록해야 한다.**

`max_tokens` 는 **사고(thinking)와 응답 텍스트의 합산 상한**이다. Opus 5·Sonnet 5는 사고가
기본으로 켜져 있으므로 Writer 단계에 여유를 둔다. Haiku 4.5의 출력 상한 64K를 넘기지 않는다.

## localStorage 키

전부 `bw-` 접두사를 쓴다. **`as-` 는 `article-search` 앱이 쓰므로 절대 쓰지 않는다**
(같은 `github.io` 호스트라 localStorage를 공유한다).

| 키 | 내용 |
|---|---|
| `bw-api-key` | Anthropic API 키 |
| `bw-model` / `bw-opus-writer` | 모델, 본문만 Opus 5 토글 |
| `bw-budget` / `bw-ai-notice` | 월 비용 한도, AI 작성 고지 |
| `bw-no-effort` / `bw-basic-tools` | 모델별 폴백 기억 |
| `bw-usage` | 사용량·비용 기록(최근 300건) |
| `bw-draft` / `bw-history` | 작성 중 초안, 완료 이력(최대 20건) |

### 비용 집계 — '글 1편'을 무엇으로 보는가

`bw-usage` 는 **단계 1회 = 기록 1건**이다(최신이 앞). 정보 탭의 *글 1편 평균*·*마지막 글 1편
비용*은 기록을 시각으로 묶어 센다 — 바로 앞 기록과 **1시간**(`RUN_GAP_MS`) 넘게 벌어지면
다른 글로 본다. 단계 수로 자르면 시각자료를 건너뛴 글(5단계)이나 단계를 다시 돌린 글(7건 이상)
에서 앞뒤 글의 요금이 섞여 들어간다. 묶음 안에서 단계별 **가장 최근 1회**가 결과에 쓰인 것이고,
그보다 앞선 같은 단계 기록은 다시 돌렸거나 실패한 것이라 화면에서 따로 더한다(요금은 나갔다).

## 이동·변경 시 확인할 것

1. `index.html` / `assets/` / `sw.js` / `manifest.webmanifest` 경로는 그대로 둔다.
   옮기면 PWA 캐시와 홈화면 아이콘이 깨진다.
2. `sw.js` 의 `CACHE` 이름과 `CORE` 목록을 파일 추가·이름변경 시 함께 고친다.
3. `sw.js` 는 **동일 출처 GET만** 캐시한다. `api.anthropic.com` 요청을 가로채면 안 된다.
4. 새 전역 `const` 를 `agents.js` 에 추가할 때 IIFE 안쪽인지 확인한다.

## 나중에 붙일 수 있는 것 (지금은 없음)

- **주제 후보 공급**: `briefing` 앱과 같은 호스트이므로 `../briefing/data/feed.json` 을
  상대경로로 **읽기만** 하면 CORS 없이 "오늘 주제 후보"를 띄울 수 있다.
  briefing 저장소를 수정하지 않는 선을 지킬 것.
- **기기 간 이력 동기화**: 필요해지면 `family-chart` 의 Cloudflare Worker + KV + passcode
  패턴을 따른다. 그때 `worker/` 디렉터리가 새로 생긴다.
- **자동 게시**: 워드프레스/Ghost로 옮기지 않는 한 불가(티스토리 API 종료, 네이버 미제공).
  붙이게 되면 결과 화면의 복사 로직 옆에 어댑터를 두고, 본문 조립은 `buildMarkdown()` 을 재사용한다.
