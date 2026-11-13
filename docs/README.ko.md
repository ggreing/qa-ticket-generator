# qa-ticket-generator

[English](../README.md) | **한국어** | [日本語](README.ja.md) | [简体中文](README.zh-CN.md)

<!-- 배지(CI, 릴리스, 라이선스)는 레포를 공개할 때 추가합니다. -->

> 🚧 pre-v0.1입니다. 테스트 레포에서는 잘 돌아가지만, input 이름이나 코멘트 모양은 아직 바뀔 수 있어요.

기획서(GitHub 이슈, Jira 스토리, Notion 페이지)를 읽고 QA 담당자가 돌려 볼 테스트 케이스를 케이스마다
티켓으로 써 주는 GitHub Action입니다. 놓치기 쉬운 케이스까지 챙깁니다. 그 기획서를 구현한 PR이 올라오면
코드와 케이스를 대조해서 어떤 케이스가 구현된 것 같은지 알려 줍니다.

## Why

작은 팀에는 보통 QA 전담자가 없고, 리뷰어도 diff를 보면서 Jira 티켓을 옆에 띄워 두는 경우가 드뭅니다.
그러다 보니 리뷰 승인 나고 테스트도 다 통과했는데, 일주일 뒤에야 인수 조건 하나가 아예 구현이 안 됐다는 걸
알게 되는 일이 생깁니다.

이 액션이 그 QA 준비 작업을 대신합니다. 코드가 나오기 전에 기획서를 읽고, 인수 조건마다 경계값이나 실패
상황까지 포함한 구체적인 테스트 케이스를 만듭니다. 나중에 PR이 올라오면 케이스 하나하나를 코드와 대조합니다.
코드 리뷰 봇은 아니라서 스타일 같은 건 보지 않습니다. 이 변경이 기획서대로 동작하는지, 그걸 확인하려면 뭘
테스트해야 하는지만 봅니다.

## How it works

1. 기획. 기획서 이슈에 `needs-qa-plan` 라벨을 붙이거나, Jira 키나 Notion URL을 넣고 워크플로를 직접
   실행합니다. Claude가 인수 조건마다 흔히 쓰는 테스트 기법(경계값, 잘못된 입력, 권한, 동시성, 시간대 등)을
   적용해 보고 케이스를 씁니다. 기획서에 안 적힌 부분도 케이스로 만듭니다.
2. 케이스 티켓. 케이스마다 팀이 이미 쓰는 곳에 티켓이 생깁니다. GitHub 이슈, 스토리 아래 Jira 하위 작업,
   Notion 데이터베이스의 행 중에서 고르면 됩니다. `qa-cases.md`, `.csv`, `.json` 파일도 같이 나오고, CSV는
   TestRail이나 스프레드시트로 가져올 수 있어요. 기획서에는 케이스 목록 코멘트가 하나 달립니다.
3. PR 대조. 기획서를 링크한 PR에 `needs-ai-qa`를 붙입니다. 케이스마다 코드 상태(구현 확인됨, 미구현 의심,
   기획과 상충, 코드로 판단 불가)가 매겨지고, diff에서만 보이는 위험은 새 케이스로 추가됩니다. PR에는
   P0 체크리스트가 들어간 요약 코멘트가 남습니다. 아직 케이스를 뽑지 않은 기획서라면 이 단계에서 먼저
   뽑습니다.

다시 돌려도 괜찮습니다. 같은 케이스는 ID와 티켓이 그대로라서 중복이 생기지 않습니다. 팀이 남긴 실행 결과,
담당자, 코멘트, 라벨은 절대 덮어쓰지 않습니다. 누가 티켓 내용을 고쳤다면 그대로 두고, 도구가 바꾸려던 내용을
코멘트로 남깁니다. 기획서에서 빠진 케이스는 닫거나 지우지 않고 해당 없음으로 표시합니다.

두 번째 실행부터는 필요한 일만 합니다. 마지막 기획 이후 기획서가 바뀌지 않았으면 케이스를 다시 만들지
않습니다(그래도 다시 만들려면 `force-plan: true`). PR 대조는 이미 대조한 커밋과, 주석이나 공백만 바뀐
push를 건너뜁니다. 첫 대조 이후에는 바뀐 줄에서만 새 케이스를 만들고, 케이스는 근거가 된 파일이 바뀌었거나
아직 코드를 기다리던 경우에만 다시 판정합니다. 워크플로를 직접 실행하면 처음부터 전부 다시 봅니다.

Jira나 Notion을 쓰려면 설정이 조금 더 필요합니다:
[`setup/jira-subtasks.md`](setup/jira-subtasks.md),
[`setup/notion-qa-database.md`](setup/notion-qa-database.md).

## What you get

도구가 쓰는 케이스 티켓 하나는 이렇게 생겼습니다(제목은 `[P0][경계값] 만료 1초 지난 쿠폰 적용 시 거부`):

```markdown
### 전제 조건

- 쿠폰 EXP1 발급됨, 만료 2026-11-13 23:59:59
- 주문 금액 30,000원 장바구니

### 테스트 데이터

- 쿠폰 코드 EXP1
- 현재 시각 2026-11-14 00:00:00

### 단계

1. 결제 화면 진입
2. 쿠폰 EXP1 입력 후 적용

### 기대 결과

- **"만료된 쿠폰입니다" 토스트 노출**
- 결제 금액 30,000원 유지

### 놓치기 쉬운 이유

기획서에 만료 시각 포함 여부(이하/미만) 정의 없음

### 관련 AC

AC3
```

PR 코멘트는 변경이 기획서와 얼마나 맞는지로 시작하고, 코드가 놓쳤거나 기획과 어긋나 보이는 케이스와 P0
체크리스트를 티켓 링크와 함께 보여 줍니다. 커밋을 더 push하면 새 코멘트를 다는 대신 같은 코멘트를 고치고,
lock 파일이나 빌드 결과물만 바뀐 push는 무시합니다.

체크를 실패시키고 싶다면 `fail-on`을 보세요. 요구사항의 기본 동작은 있는데 일부 케이스가 미구현 의심이나
기획과 상충이면, 그 요구사항은 부분 충족이 되고 배지는 부분 일치로 나옵니다. 그래서 `fail-on: misaligned`는
기본 동작이 기획과 반대일 때만 실패합니다. 가장자리 케이스까지 머지를 막고 싶다면 `fail-on: partial`을
쓰세요.

기획서를 링크하지 않은 PR도 코멘트를 받습니다. 이때는 코드에서 요구사항을 추정해 짧은 테스트 케이스 목록을
쓰고, 대조할 기획서가 없었다는 점을 함께 적습니다. Slack을 연결하면 채널에는 이 코멘트의 짧은 요약이, 그
스레드에는 테스트 케이스가 올라갑니다.

내부 흐름이 궁금하면 아래 그림을 보세요.

![구성도: GitHub 이벤트, 트리거 판정, 컨텍스트와 PRD 수집, 전처리, Claude, PR 코멘트·Slack·Job Summary](diagrams/architecture.png)

## Setup

Anthropic API 키 하나와 5분 정도면 됩니다.

1. 레포 secret에 `ANTHROPIC_API_KEY`라는 이름으로 키를 넣습니다.
2. 라벨 두 개를 만듭니다. 기획서용 `needs-qa-plan`, PR용 `needs-ai-qa`.
3. 아래 워크플로를 `.github/workflows/qa-cases.yml`로 추가합니다.

```yaml
name: QA cases
on:
  issues:
    types: [labeled]
  pull_request:
    types: [labeled, synchronize, opened, reopened]
  workflow_dispatch:
    inputs:
      spec: { description: "Issue number, Jira key or Notion URL", required: false }

permissions:
  contents: read
  issues: write
  pull-requests: write

jobs:
  qa:
    if: >-
      github.event_name == 'workflow_dispatch' ||
      (github.event_name == 'issues' && github.event.label.name == 'needs-qa-plan') ||
      (github.event_name == 'pull_request' && contains(github.event.pull_request.labels.*.name, 'needs-ai-qa'))
    concurrency:
      group: qa-cases-${{ github.event.issue.number || github.event.pull_request.number || inputs.spec }}
      cancel-in-progress: ${{ github.event_name == 'pull_request' }}
    runs-on: ubuntu-latest
    steps:
      # 일부러 actions/checkout을 넣지 않습니다. 모든 내용은 API로 읽습니다.
      - id: qa
        uses: ggreing/qa-ticket-generator@v0
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
      - if: steps.qa.outputs.cases-dir != ''
        uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        with:
          name: qa-cases
          path: ${{ steps.qa.outputs.cases-dir }}
```

이게 전부입니다. 기획서 이슈에 라벨을 붙이면 케이스 이슈가 생기고, 그 기획서를 구현한 PR에 라벨을 붙이면
됩니다. Jira와 Notion input은 주석과 함께 [`examples/workflow-v3.yml`](examples/workflow-v3.yml)에 있습니다.
케이스 티켓 없이 PR 코멘트만 원하면 [`examples/workflow.yml`](examples/workflow.yml)을 쓰세요. 결과를
한국어로 받으려면 `language: ko` 한 줄만 넣으면 됩니다.

fork에서 온 PR은 기본적으로 건너뜁니다. GitHub가 fork PR에는 secret을 넘겨주지 않기 때문입니다. 꼭 필요하면
[`examples/workflow-fork-opt-in.yml`](examples/workflow-fork-opt-in.yml)을 쓰면 되는데, 맨 위 경고는
꼭 읽고 쓰세요.

## Linking the spec

기획 단계에서는 라벨을 붙인 이슈나 직접 실행할 때 넣은 `spec`이 기획서입니다. PR 대조 단계에서는 PR 본문에서
기획서 링크를 찾습니다.

- GitHub 이슈: `#123`, `owner/repo#123`, 이슈 URL, `Closes #123`
- Jira Cloud: `https://your-site.atlassian.net/browse/PROJ-123`, 또는 `jira-project-keys`에 `PROJ`를
  넣어 두면 `PROJ-123`만 써도 됩니다
- Notion: `notion.so`나 `notion.site` 페이지 URL

인수 조건은 "Acceptance Criteria"(또는 "AC") 헤딩 아래 목록이나 체크리스트에서 읽습니다. 그런 섹션이 없으면
티켓 본문 전체를 보고 판단합니다. 코드 블록과 HTML 주석 안의 링크는 무시하니까 PR 템플릿에 예시 링크를
넣어 둬도 괜찮습니다. 바로 쓸 수 있는 템플릿도 있어요:
[`examples/pull_request_template.md`](examples/pull_request_template.md).

티켓을 안 걸었다면? 그래도 코드만 보고 돌아가고, 코멘트 맨 위에 그 사실을 표시합니다. 차라리 체크를 실패시키고
싶다면 `require-prd: true`를 쓰세요.

## Running it locally

같은 기능을 CLI로도 쓸 수 있습니다. 기본은 아무 데도 올리지 않습니다. `plan`은 `qa-cases` 파일만 쓰고, `run`은
리포트를 출력만 합니다.

```bash
export GITHUB_TOKEN=… ANTHROPIC_API_KEY=…
npx qa-ticket-generator plan --repo owner/repo --spec PROJ-123                                # 파일만
npx qa-ticket-generator plan --repo owner/repo --spec 42 --sinks github-issue --publish       # 티켓 생성
npx qa-ticket-generator run --repo owner/repo --pr 123            # 드라이런(기본)
npx qa-ticket-generator run --repo owner/repo --pr 123 --format json --out report.json
npx qa-ticket-generator run --repo owner/repo --pr 123 --publish  # PR 코멘트 / Slack에 게시
```

액션 input은 전부 대문자 환경 변수로도 넘길 수 있습니다(`JIRA_BASE_URL`, `MAX_SCENARIOS` 등).
플래그 목록은 `npx qa-ticket-generator --help`로 볼 수 있어요.

## What it costs

지금까지 돌려 본 작은 PR(변경 파일 1\~3개)에서는 Claude Opus 5.5 기준으로 한 번에 $0.09\~0.19, 평균 $0.13
정도 들었고 1분쯤 걸렸습니다. 합성 PR 10개와 샌드박스 PR 1개로 잰 값이라 대략적인 감으로만 봐 주세요.

큰 PR은 여러 번에 나눠 호출하니까 비용이 더 듭니다. 그래서 실행마다 상한이 있습니다. `max-cost-usd`이고
기본값은 $2예요. 넘을 것 같으면 덜 중요한 파일부터 빼고, 뭘 뺐는지 코멘트에 적습니다. 매 실행의 예상 비용은
코멘트 맨 아래에 나옵니다.

기획서에서 케이스를 뽑는 일은 더 큽니다. 인수 조건 몇 개씩 나눠서 케이스를 쓴 뒤 합치기 때문입니다. 기획서
하나에 $0.5\~2 정도로 예상하지만 아직 재 보지는 않았습니다. 같은 `max-cost-usd` 상한이 적용되고,
`max-cases`(기본 80)로 기획서 하나의 케이스 수도 제한합니다. 넘으면 P2부터 뺍니다.

## Where your code goes

이 액션은 PR의 코드를 checkout하거나 실행하지 않습니다. diff, 변경된 파일, 연결된 티켓을 GitHub, Jira,
Notion API로 읽어서 Anthropic API로 보냅니다. 그 밖의 곳으로는 보내지 않고, 텔레메트리도 없습니다.

보내기 전에 비밀값처럼 보이는 것(API 키, 토큰, 개인 키, 설정 파일 속 비밀번호)은 가립니다. PR 제목과 본문도
마찬가지입니다. 몇 개를 가렸는지는 코멘트에 나옵니다. 로그에는 개수와 크기만 남고 파일 내용은 남지 않아요.

알아 두면 좋은 것 두 가지:

- 레포 설정 파일은 base 브랜치에서 읽습니다. 그래서 PR이 자기를 검토할 지시를 바꿀 수 없습니다. 모델이 쓴
  텍스트는 이스케이프해서 올리고, Slack 멘션은 막고, 링크는 PR·연결된 티켓·우리 레포로만 제한합니다.
- 실행과 실행 사이의 상태를 자기 코멘트 안 숨김 블록에 저장하는데, 자기 토큰(`github-actions[bot]`이나
  넘겨준 PAT의 주인)이 쓴 코멘트만 믿습니다. 같은 레포의 다른 워크플로가 PR 작성자의 글을
  `github-actions[bot]` 이름으로 그대로 올린다면 이 상태가 위조될 수 있습니다. 최악의 경우는 재실행이
  건너뛰어지거나 엉뚱한 Slack 메시지가 수정되는 정도입니다.

보안 문제를 발견하셨다면 공개 이슈 말고 비공개로 알려 주세요. [`SECURITY.md`](../SECURITY.md)를 참고하세요.

## Known gaps

- 워크플로를 추가하기 _전에_ 열린 PR은 라벨을 붙여도 아무 일이 없을 수 있습니다. GitHub가 그 PR의 merge
  커밋을 갱신하지 않아서 새 워크플로를 못 보기 때문이에요. 브랜치를 갱신하면("Update branch" 버튼이나
  `gh pr update-branch <number>`) 다음 push부터 실행됩니다.
- Slack에는 기획서를 링크하지 않은 PR만 올라갑니다. 기획 실행과 케이스 티켓 대조 결과는 아직 Slack으로
  보내지 않습니다.
- Slack incoming webhook은 게시만 할 수 있어서 실행할 때마다 새 메시지가 쌓입니다. 같은 메시지를 고치고
  스레드를 쓰려면 bot 토큰(`slack-bot-token`, `slack-channel`)을 쓰세요.
- 기본 `GITHUB_TOKEN`으로는 다른 private 레포의 이슈를 읽지 못합니다. 기획서가 다른 레포에 있다면 PAT나
  GitHub App 토큰을 `github-token`으로 넘기세요.
- 아직 Jira는 Cloud만(Server, Data Center 미지원), GitHub는 github.com만(GHES 미지원) 됩니다.
- Notion 페이지는 integration에 공유해야 읽을 수 있습니다(페이지 메뉴 → 연결).
- Jira 하위 작업은 매달릴 Jira 스토리가 있어야 합니다. 기획서가 GitHub 이슈나 Notion 페이지면 Jira 쪽은
  건너뛰고 실행 로그에 그렇게 적습니다.
- Notion에는 케이스 행은 생기지만 기획서별 케이스 목록은 없습니다. 데이터베이스 하나에 모든 기획서의 케이스가
  들어가기 때문입니다. 그 목록은 기획서의 GitHub 이슈나 Jira 스토리에 달립니다.
- 모델은 바뀐 파일만 봅니다. PR이 건드리지 않은 파일에서 처리하는 요구사항은 "누락"으로 나올 수 있고,
  그런 가정은 코멘트 끝에 따로 적습니다.
- 아직 GitHub REST API를 버전 헤더 없이 호출합니다. 그래서 GitHub가 2022-11-28 버전으로 응답하고 이슈
  엔드포인트를 deprecated로 표시합니다. 이 버전은 2028년 3월까지 동작하고, 그 전에 2026-03-10으로 옮길
  예정입니다.
- 코드 상태는 모델의 판단입니다. 전부 다시 보는 수동 실행에서는 몇 개가 바뀔 수 있습니다.
- Jira sink가 쓰는 issue property(`qtg.case`)는 아직 실제 Jira 사이트에서 확인하지 않았습니다.
- Notion sink는 아직 실제 Notion workspace에서 확인하지 않았습니다.

## Configuration reference

### Inputs

<!-- inputs:start -->
| Input                   | 필수 | 기본값                            | 설명                                                                                      |
| ----------------------- | ---- | --------------------------------- | ----------------------------------------------------------------------------------------- |
| `anthropic-api-key`     | ✅   | —                                 | Anthropic API 키.                                                                         |
| `github-token`          |      | `${{ github.token }}`             | PR을 읽고 코멘트를 쓸 때 사용.                                                            |
| `model`                 |      | `claude-opus-5-5`                 | Claude 모델 ID.                                                                           |
| `effort`                |      | `high`                            | `low`, `medium`, `high`, `xhigh`, `max`. 낮을수록 싸고 빠릅니다.                          |
| `language`              |      | `en`                              | `en`, `ko`, `ja`, `zh-CN` (`kr`, `jp`, `cn`, `zh`도 됨).                                  |
| `trigger-label`         |      | `needs-ai-qa`                     | 실행을 시작하는 라벨.                                                                     |
| `rerun-on-push`         |      | `true`                            | 라벨이 붙어 있는 동안 새 커밋마다 다시 실행.                                              |
| `require-prd`           |      | `false`                           | 연결된 티켓을 못 읽으면 체크 실패.                                                        |
| `token-budget`          |      | `150000`                          | 모델 호출 1번의 입력 토큰. 큰 PR은 여러 번으로 나눔.                                      |
| `max-cost-usd`          |      | `2.00`                            | 실행당 비용 상한. 넘으면 덜 중요한 파일부터 뺌.                                           |
| `max-scenarios`         |      | `8`                               | 코멘트에 넣을 테스트 케이스 최대 개수.                                                    |
| `comment-author`        |      | —                                 | 커스텀 GitHub App 토큰을 쓸 때만 지정. 예: `my-app[bot]`.                                 |
| `pr-comment`            |      | `true`                            | PR 코멘트를 남기고 계속 갱신.                                                             |
| `slack-bot-token`       |      | —                                 | Slack bot 토큰(`xoxb-`). 메시지 수정과 스레드를 쓸 수 있음.                               |
| `slack-channel`         |      | —                                 | bot이 쓸 채널 ID나 `#이름`.                                                               |
| `slack-webhook-url`     |      | —                                 | bot 토큰이 없을 때 쓰는 incoming webhook.                                                 |
| `jira-base-url`         |      | —                                 | 예: `https://acme.atlassian.net`.                                                         |
| `jira-email`            |      | —                                 | Jira 계정 이메일.                                                                         |
| `jira-api-token`        |      | —                                 | Jira API 토큰. URL, 이메일, 토큰이 다 있어야 Jira를 씀.                                   |
| `jira-project-keys`     |      | —                                 | `KEY-123`만 써도 인식할 프로젝트 키를 쉼표로. 예: `PROJ,WEB`.                             |
| `notion-token`          |      | —                                 | Notion integration 토큰.                                                                  |
| `config-path`           |      | `.github/qa-ticket-generator.yml` | 레포 설정 파일. base 브랜치에서 읽음.                                                     |
| `fail-on`               |      | `none`                            | 정합성이 `partial`이나 `misaligned`면 체크 실패.                                          |
| `fail-on-error`         |      | `false`                           | 내부 오류 시 체크 실패. 기본은 경고만 남김.                                               |
| `allow-fork-prs`        |      | `false`                           | fork PR 허용. 옵트인 워크플로에서만 쓰세요.                                               |
| `server-fallback`       |      | `true`                            | Opus가 요청을 거절하면 Anthropic이 다른 모델로 재시도.                                    |
| `mode`                  |      | `auto`                            | `auto`는 이벤트로 판단, `plan`은 기획서로 QA 케이스 생성, `verify`는 PR 대조.             |
| `spec`                  |      | —                                 | 수동 실행 시 기획서: 이슈 번호, Jira 키, Notion URL.                                      |
| `plan-label`            |      | `needs-qa-plan`                   | 기획 단계를 시작하는 이슈 라벨.                                                           |
| `sinks`                 |      | `github-issue,file`               | 케이스 티켓을 만들 곳: `jira`, `github-issue`, `notion`, `file`.                          |
| `notion-qa-database-id` |      | —                                 | QA 케이스를 담을 Notion 데이터베이스.                                                     |
| `jira-subtask-type`     |      | `Sub-task`                        | 케이스 하위 작업에 쓸 Jira 이슈 타입.                                                     |
| `force-plan`            |      | `false`                           | 기획서가 바뀌지 않았어도 다시 생성.                                                       |
| `max-cases`             |      | `80`                              | 기획서당 안전 상한. 넘으면 P2부터 뺌.                                                     |
| `previous-cases`        |      | —                                 | 이전 실행의 `qa-cases.json` 경로(예: 내려받은 아티팩트). file sink가 케이스 ID를 이어 씀. |
| `dry-run`               |      | `false`                           | Job Summary에만 리포트를 씀.                                                              |
<!-- inputs:end -->

### Outputs

<!-- outputs:start -->
| Output             | 설명                                                    |
| ------------------ | ------------------------------------------------------- |
| `report-path`      | 전체 결과가 담긴 `report.json` 경로.                    |
| `case-count`       | 기획 단계 실행 후 유효한 QA 케이스 수.                  |
| `cases-dir`        | 기획 단계 실행 후 qa-cases.md, .csv, .json이 있는 폴더. |
| `scenario-count`   | 작성한 테스트 케이스 수.                                |
| `alignment-status` | `aligned`, `partial`, `misaligned`, `no_prd`.           |
| `cost-usd`         | 이번 실행의 예상 비용.                                  |
| `skipped-reason`   | 건너뛰었다면 그 이유.                                   |
<!-- outputs:end -->

### Repository config file

레포에 `.github/qa-ticket-generator.yml`을 두면 제외할 경로, 인수 조건이 들어 있는 Jira 필드, 도메인 설명
몇 줄 같은 걸 지정할 수 있습니다. 액션 input이 이 파일보다 우선합니다. 전체 예시는
[`examples/qa-ticket-generator.yml`](examples/qa-ticket-generator.yml)에 있어요.

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

## Contributing

버그 제보와 PR 모두 환영합니다. 테스트 돌리는 법은 [`CONTRIBUTING.md`](../CONTRIBUTING.md)에 있어요(테스트는
실제 API를 호출하지 않습니다). 설계 문서는 [`SPEC.ko.md`](SPEC.ko.md)와 [`adr/`](adr/)에 있습니다.

라이선스는 Apache-2.0입니다. [LICENSE](../LICENSE)를 보세요.
