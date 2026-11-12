import type { AuthoredCase } from './build';

/**
 * Narrative PRD: the requirements are prose, not a checkbox list or an "Acceptance Criteria"
 * heading, so PRD-07 extracts no criteria (acceptanceCriteria: []) and the model has to read
 * them out of the body. Labels appear inline once each, for grading.
 */
export const noticeScheduleKoNarrative: AuthoredCase = {
  id: 'notice-schedule-ko-narrative',
  pr: {
    number: 2005,
    title: '앱 공지 예약 발송',
    author: 'jiwoo',
    headRef: 'feat/notice-schedule',
    body: `
기획: https://www.notion.so/acme/7c1e4b2a9d3f4e8a8b6c5d4e3f2a1b0c

공지를 예약해 두면 워커가 매분 발송 대상을 찾아 보냅니다. 예약 취소 API도 함께 넣었습니다.
`,
  },
  prd: [
    {
      source: 'notion',
      id: '7c1e4b2a9d3f4e8a8b6c5d4e3f2a1b0c',
      url: 'https://www.notion.so/acme/7c1e4b2a9d3f4e8a8b6c5d4e3f2a1b0c',
      title: '공지 예약 발송',
      acceptanceCriteria: [],
      body: `
운영팀은 앱 공지를 미리 써 두었다가 정해진 시각에 내보내고 싶어 한다. 지금은 담당자가 발송 시각에 맞춰
직접 버튼을 눌러야 해서 새벽이나 주말 공지가 자주 늦어진다.

예약 시각은 저장하는 순간으로부터 최소 10분 뒤여야 하고, 그보다 이른 시각으로는 예약을 저장할 수 없다(AC1).
마지막 검수 시간을 확보하려는 것이다. 한번 예약된 공지는 발송 예정 시각 1분 전까지만 취소할 수 있으며, 그 이후에
들어온 취소 요청은 거절한다(AC2). 발송 직전에는 이미 푸시 서버로 전송이 시작되기 때문이다.

발송 작업이 실패하면 그 공지를 예약한 관리자에게 실패 사실을 알려서 다시 보낼지 판단하게 한다(AC3). 실패한 공지는
목록에서 실패 상태로 보여야 한다.
`,
    },
  ],
  files: [
    {
      path: 'notices/scheduler.py',
      content: `
from dataclasses import dataclass
from datetime import datetime, timedelta

MIN_LEAD_TIME = timedelta(minutes=10)


class ScheduleError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass
class Notice:
    id: str
    title: str
    body: str
    send_at: datetime
    created_by: str
    status: str = "SCHEDULED"


class NoticeScheduler:
    def __init__(self, repo, clock):
        self._repo = repo
        self._clock = clock

    def schedule(self, notice_id: str, title: str, body: str, send_at: datetime, admin_id: str) -> Notice:
        now = self._clock()
        if send_at < now + MIN_LEAD_TIME:
            raise ScheduleError("SEND_AT_TOO_SOON")
        notice = Notice(id=notice_id, title=title, body=body, send_at=send_at, created_by=admin_id)
        self._repo.save(notice)
        return notice

    def cancel(self, notice_id: str) -> Notice:
        notice = self._repo.get(notice_id)
        if notice.status != "SCHEDULED":
            raise ScheduleError("NOT_CANCELLABLE")
        if self._clock() >= notice.send_at:
            raise ScheduleError("TOO_LATE_TO_CANCEL")
        notice.status = "CANCELLED"
        self._repo.save(notice)
        return notice
`,
    },
    {
      path: 'notices/worker.py',
      content: `
import logging

log = logging.getLogger(__name__)


class NoticeWorker:
    """Runs every minute and sends notices whose send_at has passed."""

    def __init__(self, repo, push, clock):
        self._repo = repo
        self._push = push
        self._clock = clock

    def run_once(self) -> int:
        sent = 0
        for notice in self._repo.due(self._clock()):
            try:
                self._push.broadcast(title=notice.title, body=notice.body)
            except Exception:
                log.exception("notice send failed: %s", notice.id)
                notice.status = "FAILED"
                self._repo.save(notice)
                continue
            notice.status = "SENT"
            self._repo.save(notice)
            sent += 1
        return sent
`,
    },
    {
      path: 'notices/api.py',
      diff: `
-from notices.repo import NoticeRepository
+from notices.repo import NoticeRepository
+from notices.scheduler import NoticeScheduler, ScheduleError


 def register(app, repo: NoticeRepository, clock):
+    scheduler = NoticeScheduler(repo, clock)
+
     @app.get("/admin/notices")
     def list_notices(request):
         return [n.__dict__ for n in repo.all()]
+
+    @app.post("/admin/notices")
+    def create_notice(request):
+        data = request.json
+        try:
+            notice = scheduler.schedule(
+                data["id"], data["title"], data["body"], data["send_at"], request.user.id
+            )
+        except ScheduleError as e:
+            return 422, {"error": e.code}
+        return 201, notice.__dict__
+
+    @app.post("/admin/notices/<notice_id>/cancel")
+    def cancel_notice(request, notice_id):
+        try:
+            notice = scheduler.cancel(notice_id)
+        except ScheduleError as e:
+            return 409, {"error": e.code}
+        return 200, notice.__dict__
`,
    },
  ],
  expected: {
    expectedAlignment: 'misaligned',
    mustFindings: [
      {
        id: 'AC1',
        requirement: '예약 시각은 저장 시점으로부터 최소 10분 뒤',
        labels: ['AC1'],
        keywords: ['최소 10분'],
        accept: ['covered'],
      },
      {
        id: 'AC2',
        requirement: '발송 1분 전까지만 취소 가능',
        labels: ['AC2'],
        keywords: ['1분 전'],
        accept: ['contradicts'],
      },
      {
        id: 'AC3',
        requirement: '발송 실패 시 예약한 관리자에게 알림',
        labels: ['AC3'],
        keywords: ['관리자에게'],
        accept: ['missing'],
      },
    ],
    mustScenarios: [
      {
        id: 'cancel-cutoff',
        risk: 'A cancel request 30 seconds before send_at must be refused (cut-off is 1 minute before), but the code accepts cancels until send_at',
        keywords: [
          ['cancel', '취소'],
          [
            '1 min',
            '1분',
            'one minute',
            '60 second',
            '30 second',
            'before send',
            'cut-off',
            'cutoff',
            '직전',
          ],
        ],
      },
      {
        id: 'lead-time-boundary',
        risk: 'Scheduling exactly 10 minutes ahead is accepted; 9 minutes 59 seconds ahead is rejected with SEND_AT_TOO_SOON',
        keywords: [['10 min', '10분', 'ten min', '9 min', 'send_at_too_soon', 'lead']],
      },
      {
        id: 'failure-alert',
        risk: 'A failed send must notify the admin who scheduled it; today it is only logged and marked FAILED',
        keywords: [
          ['fail', '실패'],
          ['admin', 'notify', 'alert', '관리자', '알림'],
        ],
      },
      {
        id: 'cancel-after-send',
        risk: 'Cancelling a notice that is already SENT or FAILED is refused with NOT_CANCELLABLE',
        keywords: [['sent', 'failed', 'not_cancellable', 'already', '발송된', '이미']],
      },
    ],
    forbidden: [
      {
        id: 'invented-features',
        description: 'Recurring notices and audience targeting are in neither the page nor the code',
        patterns: ['recurring', 'segment target', 'audience target'],
        fields: ['scenarios', 'findings'],
      },
    ],
    tags: ['notifications', 'python', 'korean', 'narrative-ac', 'contradicts', 'missing'],
    notes:
      'Korean narrative PRD with no extractable criteria. AC2 is contradicted (cancel allowed until send_at, not 1 minute before) and AC3 is absent (failures are only logged).',
  },
};
