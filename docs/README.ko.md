# qa-ticket-generator

[English](../README.md) | **한국어** | [日本語](README.ja.md) | [简体中文](README.zh-CN.md)

<!-- Badges (CI, release, license) are added when the repository is published. -->

> 🚧 **개발 중입니다(pre-v0.1). 아직 사용할 수 없습니다.** input과 출력 형식은 바뀔 수 있습니다.
>
> 이 문서는 v0.1에서 목표로 하는 동작을 설명합니다. 지금까지 구현된 것: 트리거 게이트, PRD 수집
> (GitHub Issues, Jira Cloud, Notion), 비용 가드가 적용된 리포트 생성, PR 코멘트·Slack·Job Summary 발행, CLI.
> 아직 진행 중인 것: diff 전처리(노이즈 필터, 함수 단위 컨텍스트, 비밀값 마스킹, 토큰 패킹). 이 기능에 의존하는
> 항목에는 _(진행 중)_ 표시를 붙였습니다.

PR의 코드 변경을 연결된 요구사항 문서(GitHub Issues, Jira Cloud, Notion)와 Claude로 교차 검증하고,
BDD(Given / When / Then) QA 시나리오와 PRD 정합성 리포트를 PR과 Slack에 발행하는 GitHub Action입니다.

## 동작 방식

![아키텍처: GitHub 이벤트 → 트리거 게이트 → 컨텍스트·PRD 수집 → 전처리 → Claude → PR 코멘트, Slack, Job Summary](diagrams/architecture.png)

1. **트리거.** PR에 `needs-ai-qa` 라벨을 붙이면 실행됩니다. 라벨이 붙어 있는 동안 새 push가 오면 다시 실행합니다
   (설정 가능). 노이즈 파일(lock 파일, 빌드 산출물, 스냅샷 등)만 바뀐 push는 건너뜁니다 _(진행 중)_.
2. **수집과 준비.** diff와 연결된 PRD를 GitHub, Jira, Notion API로 읽습니다. 코드를 checkout하지 않습니다.
   노이즈 파일을 빼고, 변경을 감싸는 함수나 클래스까지 컨텍스트를 넓히고, 비밀값을 마스킹한 뒤, 중요한 파일부터
   토큰 예산에 맞춰 담습니다 _(진행 중)_.
3. **생성과 발행.** Claude가 코드와 인수 조건(AC)을 비교해 정상 경로·경계·부정 시나리오와 누락되거나 충돌하는
   요구사항을 돌려줍니다. 리포트는 실행할 때마다 갱신되는 PR 코멘트 1개로 게시되고, 설정하면 Slack에도 보내며,
   Job Summary에는 항상 기록합니다.

## 출력 예시

PR 코멘트의 예시 목업입니다(v0.1 전까지 실제 형식은 바뀔 수 있습니다). 결과물 언어는 `language` input으로 정합니다.

```markdown
## 🧪 AI QA Scenarios — `a1b2c3d` · ⚠️ PRD alignment: **Partial**

> Linked: PROJ-123 (Jira), #45 (GitHub)

### PRD Alignment

| Requirement            | Status     | Evidence                                   |
| ---------------------- | ---------- | ------------------------------------------ |
| AC1: 쿠폰은 1회만 적용 | ✅ covered | `CouponService.apply()`에서 사용 여부 검사 |
| AC3: 만료 쿠폰 거부    | ❌ missing | 만료일 비교 로직 없음 (`coupon.ts`)        |

### Scenarios (12)

<details><summary><b>[P0][Edge] 만료 1초 전 쿠폰 적용</b></summary>

- **Given** 만료 시각이 현재 +1초인 쿠폰이 있다
- **When** 사용자가 결제 화면에서 쿠폰을 적용한다
- **Then** 쿠폰이 적용된다
- _Related_: AC3 · `src/coupon/coupon.ts`
</details>

### Risks

- …

<sub>model · input / output tokens · estimated cost · duration · skipped files</sub>
```

Slack Bot 모드에서는 요약 카드(정합성 배지, 시나리오 수, 상위 리스크, PR과 전체 리포트 링크)를 게시하고,
시나리오 상세는 스레드에 답글로 보냅니다.

## 빠른 시작

1. 레포 Secret에 `ANTHROPIC_API_KEY`를 등록합니다. 선택: `SLACK_BOT_TOKEN`, `JIRA_API_TOKEN`, `NOTION_TOKEN`.
2. 레포에 `needs-ai-qa` 라벨을 만듭니다.
3. [`examples/workflow.yml`](examples/workflow.yml)을 `.github/workflows/qa-ticket-generator.yml`로 복사하고,
   쓰지 않는 Slack, Jira, Notion input은 지웁니다.

이제 PR에 라벨을 붙이면 됩니다. `actions/checkout`은 **추가하지 마세요**. 액션은 모든 데이터를 API로 읽습니다.
fork PR은 기본으로 건너뜁니다. 옵트인 방법과 주의 사항은 [`examples/workflow-fork-opt-in.yml`](examples/workflow-fork-opt-in.yml)을
참고하세요.

## Inputs와 Outputs

### Inputs

<!-- inputs:start -->
| Input               | 필수 | 기본값                            | 설명                                                                               |
| ------------------- | ---- | --------------------------------- | ---------------------------------------------------------------------------------- |
| `anthropic-api-key` | ✅   | —                                 | Anthropic API 키.                                                                  |
| `github-token`      |      | `${{ github.token }}`             | PR 조회와 리포트 코멘트 작성에 쓰는 토큰.                                          |
| `model`             |      | `claude-opus-5-5`                 | Claude 모델 ID.                                                                    |
| `effort`            |      | `high`                            | 추론 깊이: `low`, `medium`, `high`, `xhigh`, `max`.                                |
| `language`          |      | `en`                              | 결과물 언어: `en`, `ko`, `ja`, `zh-CN`(별칭 `kr`, `jp`, `cn`, `zh`).               |
| `trigger-label`     |      | `needs-ai-qa`                     | 실행을 요청하는 라벨.                                                              |
| `rerun-on-push`     |      | `true`                            | 라벨이 붙어 있는 동안 새 커밋이 오면 다시 실행.                                    |
| `require-prd`       |      | `false`                           | 연결된 PRD를 하나도 가져오지 못하면 실패.                                          |
| `token-budget`      |      | `150000`                          | LLM 호출 1회당 입력 토큰 예산(추정). 넘으면 Map-Reduce로 나눔.                     |
| `max-cost-usd`      |      | `2.00`                            | 실행 1번의 추정 비용 상한(USD). 넘으면 우선순위가 낮은 파일부터 제외.              |
| `max-scenarios`     |      | `20`                              | 리포트의 최대 시나리오 수.                                                         |
| `comment-author`    |      | —                                 | 리포트 코멘트 작성자 login. 커스텀 GitHub App 토큰일 때만 지정(예: `my-app[bot]`). |
| `pr-comment`        |      | `true`                            | 리포트를 PR 코멘트로 발행(같은 코멘트를 갱신).                                     |
| `slack-bot-token`   |      | —                                 | Slack Bot 토큰(`xoxb-`). 있으면 Bot 모드(갱신 + 스레드).                           |
| `slack-channel`     |      | —                                 | Bot 모드 채널 ID 또는 `#이름`.                                                     |
| `slack-webhook-url` |      | —                                 | Slack Incoming Webhook URL. Bot 토큰이 없을 때 사용.                               |
| `jira-base-url`     |      | —                                 | Jira Cloud 사이트 URL(예: `https://acme.atlassian.net`).                           |
| `jira-email`        |      | —                                 | API 토큰 인증에 쓰는 Jira 계정 이메일.                                             |
| `jira-api-token`    |      | —                                 | Jira API 토큰. URL, 이메일, 토큰이 모두 있어야 Jira가 활성화됨.                    |
| `jira-project-keys` |      | —                                 | PR 본문에서 키만 적어도 인식할 프로젝트 키 목록, 쉼표 구분(예: `PROJ,WEB`).        |
| `notion-token`      |      | —                                 | Notion integration 토큰.                                                           |
| `config-path`       |      | `.github/qa-ticket-generator.yml` | 레포 설정 파일 경로. base 브랜치에서 읽음.                                         |
| `fail-on`           |      | `none`                            | PRD 정합성이 기준에 못 미치면 체크 실패: `none`, `partial`, `misaligned`.          |
| `fail-on-error`     |      | `false`                           | 내부 오류 시 체크 실패(기본은 경고만 남김).                                        |
| `allow-fork-prs`    |      | `false`                           | fork PR 실행 허용(`pull_request_target` 옵트인 워크플로 전용).                     |
| `server-fallback`   |      | `true`                            | Anthropic 서버 측 refusal fallback 사용.                                           |
| `dry-run`           |      | `false`                           | 발행하지 않고 Job Summary에만 리포트를 기록.                                       |
<!-- inputs:end -->

`comment-author`는 `GITHUB_TOKEN`과 개인 액세스 토큰(PAT)이면 자동으로 감지합니다.

### Outputs

<!-- outputs:start -->
| Output             | 설명                                                  |
| ------------------ | ----------------------------------------------------- |
| `report-path`      | `report.json` 경로.                                   |
| `scenario-count`   | 생성된 시나리오 수.                                   |
| `alignment-status` | `aligned`, `partial`, `misaligned`, `no_prd` 중 하나. |
| `cost-usd`         | 이번 실행의 추정 비용(USD).                           |
| `skipped-reason`   | 건너뛴 경우 그 사유.                                  |
<!-- outputs:end -->

## PRD 연결 방법

PR 본문에 요구사항 문서 링크를 적습니다.

| 소스         | 인식 패턴                                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| GitHub Issue | `#123`, `owner/repo#123`, `https://github.com/owner/repo/issues/123`, `Closes #123` / `Fixes` / `Resolves` |
| Jira Cloud   | `https://<site>.atlassian.net/browse/KEY-123`, 그리고 `KEY`가 `jira-project-keys`에 있을 때의 `KEY-123`    |
| Notion       | `https://www.notion.so/…<32자리 hex ID>`, `https://<workspace>.notion.site/…<32자리 hex ID>`               |

- 문서는 최대 5개(설정 가능)까지 본문에 나온 순서대로 사용하고, 중복은 무시합니다.
- HTML 주석과 코드 블록 안의 링크는 무시하므로, PR 템플릿의 예시 링크가 잘못 인식되지 않습니다.
  바로 쓸 수 있는 템플릿: [`examples/pull_request_template.md`](examples/pull_request_template.md).
- 인수 조건은 "Acceptance Criteria"(또는 "인수 조건", "AC") 헤딩 아래의 목록이나 체크박스 목록에서 읽습니다.
  없으면 Claude가 문서 본문에서 요구사항을 해석합니다.
- 연결된 PRD가 없으면 코드만으로 분석하는 모드로 계속하고, 리포트에 신뢰도가 낮다는 표시를 붙입니다.
  대신 실패시키려면 `require-prd: true`로 설정하세요.

## 레포 설정 파일

선택 사항인 `.github/qa-ticket-generator.yml`로 필터, PRD 설정, 점수 규칙, 프롬프트 지시를 조정합니다.
이 파일은 항상 **base** 브랜치에서 읽으므로, PR이 자기 지시를 바꿀 수 없습니다.
우선순위: action input > 이 파일 > 기본값. 예시: [`examples/qa-ticket-generator.yml`](examples/qa-ticket-generator.yml).

```yaml
filters:
  exclude: ["**/*.snap", "src/generated/**"]
prd:
  jiraProjectKeys: [PROJ, WEB]
  jiraAcceptanceCriteriaField: customfield_10042
prompt:
  extraInstructions: |
    Partial refunds are supported.
```

## CLI

같은 파이프라인을 로컬에서 실행할 수 있습니다. 기본은 dry-run이라서 리포트를 출력만 하고 아무것도 발행하지 않습니다.

```bash
export GITHUB_TOKEN=… ANTHROPIC_API_KEY=…
npx qa-ticket-generator run --repo owner/repo --pr 123            # dry run (default)
npx qa-ticket-generator run --repo owner/repo --pr 123 --format json --out report.json
npx qa-ticket-generator run --repo owner/repo --pr 123 --publish  # write the PR comment / Slack message
```

나머지 설정은 action input과 같은 이름을 대문자 환경변수로 지정합니다(예: `JIRA_BASE_URL`, `NOTION_TOKEN`,
`MAX_SCENARIOS`). 전체 옵션은 `npx qa-ticket-generator --help`로 확인하세요.

## 비용

- 실행마다 추정 비용 상한 `max-cost-usd`(기본 **$2.00**)가 있습니다. Claude를 호출하기 전에 비용을 추정하고,
  상한을 넘으면 우선순위가 낮은 파일부터 제외합니다. 제외한 파일은 리포트에 표시합니다.
- `token-budget`은 LLM 호출 1회의 입력을 제한합니다(기본 150,000 토큰). 이보다 큰 PR은 나눠서 처리합니다.
- 일반적인 PR을 Claude Opus 5.5, `effort: high`로 분석하면 1회에 대략 $0.15~$0.40로 **추정**합니다.
  실측값이 아니라 설계상 추정치이며, 실행별 추정 비용은 리포트 하단에 표시됩니다.
- 노이즈 파일만 바뀐 push는 Claude를 호출하지 않습니다 _(진행 중)_.

## 보안과 데이터 흐름

- **checkout 없음.** PR 코드를 checkout하거나 실행하지 않고, 모든 데이터를 API로 읽습니다.
- **fork PR은 기본으로 건너뜁니다.** 문서화된 `pull_request_target` 옵트인은 관리자가 라벨을 붙였을 때만 실행됩니다.
- **비밀값을 마스킹합니다.** 모델에 보내기 전에 diff, 파일 원문, PRD에서 비밀값을 가리고, 마스킹 건수를 리포트에
  표시합니다 _(진행 중)_. 토큰은 로그에서 가려지고, 로그에는 크기와 개수만 남습니다.
- **코드와 PRD는 Anthropic API로만 전송합니다.** 텔레메트리는 없습니다.
- **설정은 base 브랜치에서 읽고**, 모델 출력은 데이터로만 다룹니다. HTML을 이스케이프하고, Slack 멘션을 무력화하고,
  링크는 PR, PRD 원본, 레포로 제한합니다.
- **신뢰하는 코멘트 작성자.** 토큰 작성자(`github-actions[bot]` 또는 PAT 소유자)가 쓴 리포트 코멘트만 신뢰합니다.
  같은 레포의 다른 워크플로가 `github-actions[bot]` 명의로 PR 작성자 입력을 그대로 코멘트하면 숨김 state를 위조할 수
  있지만, 영향은 push 재실행 판정과 갱신할 Slack 메시지 선택에 한정됩니다.
- 예시의 최소 권한을 사용하세요: `contents: read`, `pull-requests: write`, `issues: read`.

취약점은 [`SECURITY.md`](../SECURITY.md)에 안내된 방법으로 비공개 제보해 주세요.

## FAQ와 제약

- **Slack Webhook 모드**는 실행마다 요약 카드 1개를 새로 보냅니다. 이전 메시지 갱신과 스레드 상세는 Bot 모드
  (`slack-bot-token` + `slack-channel`)가 필요합니다.
- **다른 private 레포의 Issue**는 기본 `GITHUB_TOKEN`으로 읽을 수 없습니다. 개인 액세스 토큰(PAT)이나 GitHub App
  토큰을 `github-token`으로 넘기세요. 그 전까지는 리포트에 권한 경고가 표시됩니다.
- **Jira Cloud만 지원합니다.** v1은 Jira Server와 Data Center를 지원하지 않습니다.
- **Notion 페이지**는 integration에 공유해야 합니다(페이지 메뉴 → 연결).
- 현재는 **github.com만** 지원합니다. GitHub Enterprise Server는 아직 지원하지 않습니다.

## 기여와 라이선스

기여를 환영합니다. [`CONTRIBUTING.md`](../CONTRIBUTING.md)와 [행동 강령](../CODE_OF_CONDUCT.md)을 참고하세요.
설계 문서: [`SPEC.ko.md`](SPEC.ko.md) · [`adr/`](adr/) · [`DEVELOPMENT.md`](DEVELOPMENT.md).

[Apache-2.0](../LICENSE) 라이선스를 따릅니다.
