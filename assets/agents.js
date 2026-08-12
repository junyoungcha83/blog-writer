// 역할별 Agent 정의 — 4단계 파이프라인의 시스템 프롬프트와 옵션→프롬프트 변환.
// 각 단계는 독립 API 호출이고 JSON 하나만 돌려준다. app.js 가 순서대로 호출한다.
//
// 클래식 <script> 는 전역 렉시컬 스코프를 공유한다. IIFE 로 감싸지 않으면 여기서
// 선언한 STAGES·FIELDS 가 app.js 의 같은 이름과 충돌해 앱이 아예 뜨지 않는다.
// 밖으로 내보내는 것은 window.BW 하나뿐이다.
// (프롬프트 본문은 템플릿 리터럴이라 들여쓰기를 넣지 않는다 — 그대로 모델에 전달된다.)

(function () {

// ── 옵션 목록 (화면과 프롬프트가 같은 정의를 쓴다) ─────────────

const FIELDS = {
  realestate: {
    label: '부동산',
    sources: [
      '한국부동산원 주간 아파트가격동향(reb.or.kr, r-one.co.kr)',
      '국토교통부 실거래가 공개시스템(rt.molit.go.kr)',
      '서울부동산정보광장(land.seoul.go.kr)',
      '국토교통부 보도자료(molit.go.kr)',
      '한국은행 기준금리(bok.or.kr)',
      'KB부동산(data.kbland.kr)',
      '언론: 연합뉴스, 매일경제, 한국경제, 조선비즈, 머니투데이, KBS·MBC·SBS 경제',
    ],
  },
  stock: {
    label: '주식',
    sources: [
      '금융감독원 전자공시 DART(dart.fss.or.kr)',
      '한국거래소(krx.co.kr)',
      '증권사 리서치 리포트',
      '미 SEC 공시(sec.gov)',
      '언론: 연합인포맥스, 한국경제, 매일경제, Reuters, Bloomberg, CNBC, WSJ',
    ],
  },
  economy: {
    label: '경제',
    sources: [
      '한국은행(bok.or.kr), 기획재정부(moef.go.kr), 통계청(kostat.go.kr)',
      '미 연준(federalreserve.gov/newsevents.htm), 재무부(home.treasury.gov)',
      '미 의회(congress.gov)',
      '언론: 연합뉴스, Reuters, Bloomberg, Financial Times, WSJ, AP',
    ],
  },
  it: {
    label: 'IT',
    sources: [
      '기업 공식 블로그·릴리스 노트·기술 문서',
      '과학기술정보통신부(msit.go.kr)',
      '언론: 전자신문, 지디넷코리아, The Verge, TechCrunch, Ars Technica',
    ],
  },
  etc: { label: '기타', sources: ['주제와 관련된 1차 자료(정부·공공기관·기업 공식 발표)를 우선한다'] },
};

const PURPOSES = {
  info:   { label: '정보 제공', guide: '독자가 사안을 처음 접한다고 보고, 배경 → 사실 → 의미 순으로 차분하게 설명한다. 판단을 유도하지 않는다.' },
  invest: { label: '투자 분석', guide: '수치와 변화의 원인에 무게를 둔다. 다만 매수·매도 권유는 절대 하지 않고, 판단 재료만 정리한다.' },
  news:   { label: '뉴스 분석', guide: '새로 확인된 사실이 무엇이고 기존과 무엇이 달라졌는지를 앞세운다. 시점을 분명히 밝힌다.' },
  seo:    { label: '검색 유입', guide: '독자가 검색창에 넣을 만한 질문을 소제목으로 삼고, 각 소제목 아래에서 그 질문에 바로 답한다.' },
};

const LENGTHS = {
  '1500': { label: '1,500자', chars: 1500, maxTokens: 12000, sections: '3~4' },
  '3000': { label: '3,000자', chars: 3000, maxTokens: 16000, sections: '4~6' },
  '5000': { label: '5,000자', chars: 5000, maxTokens: 20000, sections: '6~8' },
};

const RANGES = {
  '24h': { label: '최근 24시간', days: 1 },
  '3d':  { label: '최근 3일',    days: 3 },
  '7d':  { label: '최근 7일',    days: 7 },
  '1m':  { label: '최근 1개월',  days: 30 },
};

const SOURCE_TYPES = {
  press:  '언론사',
  gov:    '정부기관',
  public: '공공기관',
  broker: '증권사',
  expert: '전문가',
};

const STYLES = {
  pro:    { label: '전문형',        guide: '업계 용어를 그대로 쓰되 처음 등장할 때 한 번 풀어 준다. 문장은 짧고 단정하게.' },
  easy:   { label: '쉬운 설명형',   guide: '전문용어는 쉬운 말로 바꾸고 괄호에 원어를 병기한다. 비유를 하나 정도 써도 좋다.' },
  news:   { label: '뉴스형',        guide: '핵심을 첫 문단에 모두 담고(역피라미드) 이후 문단에서 세부를 보탠다. 건조한 문체.' },
  invest: { label: '투자자 분석형', guide: '수치·기간·비교 대상을 항상 함께 제시한다. 쟁점은 양쪽 견해를 나란히 적는다.' },
};

// ── 모든 역할이 공유하는 원칙 ─────────────────────────────────
// 브리핑 앱 GENERATE.md 와 realestate-briefing 스킬의 작성 원칙을 그대로 가져왔다.

const COMMON_RULES = `너는 한국어 블로그 콘텐츠 제작 파이프라인의 한 단계를 담당한다.

절대 원칙:
- 추측·예측·창작 금지. 확인된 사실과 발표된 수치만 쓴다.
- 숫자·날짜·고유명사는 출처에 있는 그대로. 단위와 기준시점을 반드시 붙인다.
- 확인하지 못한 것은 비워 두거나 지정된 필드에 "미확인"으로 적는다. 그럴듯하게 채우지 않는다.
- 자료가 부족하면 분량을 줄인다. 억지로 채우지 않는다.
- 출처 URL 은 실제로 확인한 것만. URL 을 만들어 내면 안 된다.

출력 형식:
- JSON 객체 하나만 출력한다. 설명·인사말·코드펜스 없이 JSON 만.
- 지정된 키를 빠뜨리지 않는다. 값이 없으면 빈 배열이나 빈 문자열을 넣는다.`;

// ── 공통 헬퍼 ─────────────────────────────────────────────────

const fieldBlock = opts => {
  const f = FIELDS[opts.field] || FIELDS.etc;
  const name = opts.field === 'etc' && opts.fieldEtc ? opts.fieldEtc : f.label;
  return `분야: ${name}\n이 분야에서 신뢰할 수 있는 출처:\n${f.sources.map(s => `- ${s}`).join('\n')}`;
};

const wantedTypes = opts => (opts.sourceTypes || []).map(k => SOURCE_TYPES[k]).filter(Boolean);

const inputBlock = input => {
  if (input.mode === 'url')  return `입력 방식: 기사 링크\n링크: ${input.value}`;
  if (input.mode === 'text') return `입력 방식: 원문 붙여넣기\n---- 원문 시작 ----\n${input.value}\n---- 원문 끝 ----`;
  return `입력 방식: 주제만 주어짐\n주제: ${input.value}`;
};

// ── ① Researcher ─────────────────────────────────────────────

function researcherSystem(opts) {
  const types = wantedTypes(opts);
  return `${COMMON_RULES}

너의 역할: Researcher. 주어진 입력에서 검색 키워드를 뽑고, 웹에서 근거 자료를 모은다.

${fieldBlock(opts)}

수집 조건:
- 검색 범위: ${RANGES[opts.range].label}. 발행일이 이 범위를 벗어난 자료도 참고용으로 담되 published_at 을 정확히 적어라. 걸러내는 일은 다음 단계가 한다.
- 우선 출처 유형: ${types.length ? types.join(', ') : '제한 없음'}
- 링크가 주어졌으면 web_fetch 로 본문을 먼저 읽고, 같은 사안을 다룬 다른 출처를 web_search 로 찾는다.
- 서로 다른 출처를 최소 5개 확보하려 노력한다. 같은 매체의 여러 기사는 1개로 본다.
- 통계·수치가 나오는 주제는 언론 기사보다 원자료(기관 발표)를 우선한다.

출력 JSON 스키마:
{
  "keywords": ["실제로 검색에 쓴 키워드 3~5개"],
  "input_summary": "입력 내용의 핵심을 3문장 이내로",
  "sources": [
    {
      "outlet": "매체 또는 기관명",
      "type": "언론사|정부기관|공공기관|증권사|전문가",
      "title": "자료 제목",
      "url": "실제 URL",
      "published_at": "YYYY-MM-DD (모르면 빈 문자열)",
      "gist": "이 자료가 말하는 핵심 2~3문장. 수치가 있으면 반드시 포함"
    }
  ],
  "notes": "자료를 못 찾은 부분이나 한계가 있으면 한 줄로. 없으면 빈 문자열"
}`;
}

function researcherUser(input, opts) {
  return `${inputBlock(input)}

위 입력을 기준으로 검색 키워드를 만들고 자료를 수집해라. JSON 만 출력.`;
}

// ── ② Fact Checker ───────────────────────────────────────────

function factCheckerSystem(opts) {
  return `${COMMON_RULES}

너의 역할: Fact Checker. 수집된 자료를 서로 대조해 사실과 해석을 분리한다.

${fieldBlock(opts)}

검증 절차:
1. 여러 출처에 공통으로 나오는 내용은 facts 로 분류한다. 수치는 가능하면 출처 2곳 이상에서 교차 확인하고, 한 곳에서만 나오면 confidence 를 "단일출처"로 표시한다.
2. 출처끼리 값이나 방향이 어긋나는 항목은 disputed 에 양쪽을 모두 적는다.
3. 전망·평가·해설처럼 사실이 아닌 것은 opinions 로 옮긴다. 누가 한 말인지 반드시 함께 적는다.
4. 근거를 못 찾은 주장은 unverified 에 적는다.
5. 발행일이 검색 범위(${RANGES[opts.range].label})를 벗어난 자료는 out_of_range 로 옮긴다. 이때 발행일을 반드시 적는다.
6. 빈 곳이 있으면 web_search 로 최소한만 보강한다.

출력 JSON 스키마:
{
  "facts": [
    { "claim": "사실 한 문장", "value": "관련 수치·기간·단위(없으면 빈 문자열)", "sources": ["url", "..."], "confidence": "교차확인|단일출처" }
  ],
  "disputed": [ { "topic": "쟁점", "positions": [ { "outlet": "매체", "claim": "주장", "url": "url" } ] } ],
  "opinions": [ { "who": "발언 주체", "claim": "의견·전망 내용", "url": "url" } ],
  "unverified": ["근거를 찾지 못한 주장"],
  "out_of_range": [ { "title": "자료 제목", "url": "url", "published_at": "YYYY-MM-DD" } ],
  "source_types_found": { "언론사": 0, "정부기관": 0, "공공기관": 0, "증권사": 0, "전문가": 0 },
  "enough": true
}

enough 판단: 검색 범위 안의 서로 다른 출처가 3개 미만이거나 facts 가 3개 미만이면 false.`;
}

function factCheckerUser(research, input, opts) {
  return `${inputBlock(input)}

Researcher 가 수집한 자료:
${JSON.stringify(research, null, 2)}

위 자료를 대조해 검증해라. JSON 만 출력.`;
}

// ── ③ Writer ─────────────────────────────────────────────────

function writerSystem(opts) {
  const len = LENGTHS[opts.length];
  const purpose = PURPOSES[opts.purpose];
  const style = STYLES[opts.style];
  const risky = opts.field === 'realestate' || opts.field === 'stock';

  return `${COMMON_RULES}

너의 역할: Writer. 검증된 사실만으로 블로그 원고를 쓴다. 새로 검색하지 않는다.

${fieldBlock(opts)}
글의 목적: ${purpose.label} — ${purpose.guide}
문체: ${style.label} — ${style.guide}
분량: 본문 약 ${len.chars}자 (공백 포함). 소제목 ${len.sections}개.

작성 규칙:
- 본문의 모든 수치·주장은 주어진 facts 에 있는 것만 쓴다. facts 에 없으면 쓰지 않는다.
- 근거가 되는 문장 끝에 [1] [2] 형태로 각주 번호를 단다. 번호는 footnotes 배열의 순서와 정확히 일치해야 한다.
- 쟁점(disputed)은 한쪽으로 정리하지 말고 양쪽을 나란히 소개한다.
- 전망·의견(opinions)을 쓸 때는 "누가 그렇게 본다"는 형태로만 쓴다. 네 의견처럼 쓰면 안 된다.
- 원문 저작권: 원문 문장을 그대로 옮기는 것은 문단당 최대 2문장까지, 인용부호와 출처를 함께 표시한다. 그 외에는 전부 네 문장으로 다시 쓴다. 원문 문단을 통째로 복사하는 것은 금지다.
- 핵심 수치·변화·원인·쟁점을 정리하는 분석 섹션을 본문에 하나 포함한다. 다만 근거 없는 인과관계를 만들지 않는다.
- 마크다운으로 쓴다. 소제목은 ##, 필요하면 표와 목록을 쓴다. 문단은 빈 줄로 구분한다.
- 자료가 부족한 주제라면 ${len.chars}자를 억지로 채우지 말고 짧게 끝낸다.
${risky
  ? '- disclaimer 에 투자 판단 책임 고지문을 한두 문장으로 넣는다(이 글은 정보 제공 목적이며 투자 판단과 그 결과는 독자 본인에게 있다는 취지).'
  : '- disclaimer 는 빈 문자열로 둔다.'}

출력 JSON 스키마:
{
  "titles": ["제목 후보 3개. 40자 이내"],
  "outline": ["소제목 목록. 본문의 ## 과 일치"],
  "body_md": "마크다운 본문 전체. 제목(#)은 넣지 말고 소제목(##)부터 시작",
  "footnotes": [ { "n": 1, "outlet": "매체명", "title": "자료 제목", "url": "url" } ],
  "disclaimer": "면책 문구 또는 빈 문자열",
  "char_count": 0
}

char_count 는 body_md 의 공백 포함 글자 수를 직접 세어 적는다.`;
}

function writerUser(fc, opts) {
  return `검증된 자료:
${JSON.stringify(fc, null, 2)}

위 자료만 써서 원고를 작성해라. JSON 만 출력.`;
}

// ── ④ SEO ────────────────────────────────────────────────────

function seoSystem(opts) {
  return `${COMMON_RULES}

너의 역할: SEO. 완성된 본문을 읽고 검색 유입과 클릭을 위한 재료를 만든다. 새 사실을 만들지 않는다.

규칙:
- 모든 결과는 본문에 실제로 있는 내용만 근거로 한다.
- seo_titles: 검색 의도를 담은 제목 5개. 각 32자 이내. 낚시성 과장 금지.
- meta_description: 검색결과에 노출될 요약. 80~155자. 핵심 키워드를 앞쪽에.
- primary_keywords: 이 글이 노려야 할 핵심 키워드 3~5개.
- related_keywords: 함께 검색될 만한 연관 키워드 8~12개.
- tags: 블로그 태그 8~12개. 각 15자 이내, # 없이 단어만.
- faq: 독자가 실제로 검색할 질문 4개와 답. 답은 본문 근거로 2~3문장.
- thumbnail_copy: 썸네일에 얹을 문구 3세트. main 은 12자 이내로 시선을 끌고, sub 는 20자 이내로 보충한다. 숫자를 넣으면 본문에 있는 숫자만 쓴다.

출력 JSON 스키마:
{
  "seo_titles": ["", "", "", "", ""],
  "meta_description": "",
  "primary_keywords": [],
  "related_keywords": [],
  "tags": [],
  "faq": [ { "q": "", "a": "" } ],
  "thumbnail_copy": [ { "main": "", "sub": "" } ]
}`;
}

function seoUser(write, opts) {
  return `블로그 본문:
---- 본문 시작 ----
${write.body_md}
---- 본문 끝 ----

선택된 제목 후보: ${(write.titles || []).join(' / ')}

위 본문을 기준으로 SEO 세트를 만들어라. JSON 만 출력.`;
}

// ── 단계 정의 ─────────────────────────────────────────────────
// tools: 'fetch+search' | 'search' | 'none'
// maxTokens 는 사고(thinking)와 본문을 합친 상한이다. Opus 5·Sonnet 5 는 기본적으로
// 사고가 켜져 있으므로 Writer 단계에 여유를 둔다. Haiku 4.5 의 출력 상한(64K)도 넘지 않는다.

const STAGES = [
  {
    key: 'research', no: '①', label: 'Researcher', desc: '검색 키워드 생성 → 자료 수집',
    effort: 'medium', maxTokens: 10000,
    tools: (input) => (input.mode === 'url' ? 'fetch+search' : 'search'),
    system: (ctx) => researcherSystem(ctx.opts),
    user: (ctx) => researcherUser(ctx.input, ctx.opts),
  },
  {
    key: 'factcheck', no: '②', label: 'Fact Checker', desc: '출처 대조 → 사실·해석 분리',
    effort: 'medium', maxTokens: 14000,
    tools: () => 'search',
    system: (ctx) => factCheckerSystem(ctx.opts),
    user: (ctx) => factCheckerUser(ctx.stages.research, ctx.input, ctx.opts),
  },
  {
    key: 'write', no: '③', label: 'Writer', desc: '제목·목차·본문 작성',
    effort: 'medium', maxTokens: (ctx) => LENGTHS[ctx.opts.length].maxTokens,
    tools: () => 'none',
    system: (ctx) => writerSystem(ctx.opts),
    user: (ctx) => writerUser(ctx.stages.factcheck, ctx.opts),
  },
  {
    key: 'seo', no: '④', label: 'SEO', desc: '제목·키워드·FAQ·썸네일 문구',
    effort: 'low', maxTokens: 8000,
    tools: () => 'none',
    system: (ctx) => seoSystem(ctx.opts),
    user: (ctx) => seoUser(ctx.stages.write, ctx.opts),
  },
];

window.BW = { FIELDS, PURPOSES, LENGTHS, RANGES, SOURCE_TYPES, STYLES, STAGES };

})();
