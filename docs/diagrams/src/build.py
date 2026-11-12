# -*- coding: utf-8 -*-
"""Regenerate docs/diagrams/*.svg|png.  Usage: python build.py [architecture|sequence|preprocess] [--publish]
Requires Pillow and Google Chrome (headless render). Intermediate files go to the OS temp dir."""
import os, shutil, subprocess, sys, tempfile
from PIL import Image
from svgkit import Svg, tw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(tempfile.gettempdir(), "qtg-diagrams-build")
DEST = os.path.dirname(HERE)  # docs/diagrams
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

# ---- palette -------------------------------------------------------------
INK, SUB, MUTE = "#111827", "#374151", "#4B5563"
GH_Z, GH_ZS, GH_B, GH_T, GH_CHIP = "#F3F4F6", "#9CA3AF", "#4B5563", "#1F2937", "#E5E7EB"
CO_Z, CO_ZS, CO_B, CO_T, CO_G, CO_BADGE = "#EFF6FF", "#60A5FA", "#2563EB", "#1E3A8A", "#DBEAFE", "#1D4ED8"
EX_Z, EX_ZS, EX_B, EX_T = "#F5F3FF", "#A78BFA", "#7C3AED", "#4C1D95"
RU_F, RU_S, RU_T = "#FFF3E0", "#C2410C", "#9A3412"
FLOW, CALL = "#1E3A8A", "#374151"


# =========================================================================
# 1. 구성도
# =========================================================================
def architecture():
    W, H = 800, 1038
    s = Svg(W, H, "qa-ticket-generator 구성도")
    ZT, ZB = 10, 1028
    BX, BW, CX = 224, 352, 400          # core box x / width / centre
    GX, GW, GC = 22, 152, 98            # github box
    EX, EW, EC = 626, 152, 702          # external box
    GAP = 28

    s.comment("영역 1: GitHub")
    s.rect(10, ZT, 176, ZB - ZT, GH_Z, GH_ZS, 1.5, 12)
    s.text(GC, 34, "GitHub", 17, True, GH_T, "middle")
    s.comment("영역 2: qa-ticket-generator 내부 파이프라인")
    s.rect(202, ZT, 396, ZB - ZT, CO_Z, CO_ZS, 1.5, 12)
    s.text(CX, 34, "qa-ticket-generator 내부 파이프라인", 17, True, CO_T, "middle", 330)
    s.comment("영역 3: 외부 서비스")
    EZT = 306
    s.rect(614, EZT, 176, ZB - EZT, EX_Z, EX_ZS, 1.5, 12)
    s.text(EC, EZT + 26, "외부 서비스", 17, True, EX_T, "middle")

    def core(y, h, n, rows, rust=False):
        s.rect(BX, y, BW, h, RU_F if rust else "#FFFFFF", RU_S if rust else CO_B, 2.8 if rust else 1.8, 8)
        s.lines(CX, y, h, rows, maxw=BW - 20)
        if n:
            s.badge(BX, y, n, RU_S if rust else CO_BADGE)

    def flow(y1, y2, label=None):
        s.arrow([(CX, y1), (CX, y2)], FLOW, 2.6, hl=11, hw=5.5)
        if label:
            s.text(CX + 14, (y1 + y2) / 2 + 5, label, 16, False, CO_T, maxw=BX + BW - CX - 14)

    # ---- pipeline boxes --------------------------------------------------
    s.comment("파이프라인 ①~③")
    y1 = 48
    core(y1, 58, 1, [("Input Adapter", True, CO_T), ("Action · CLI 진입점 (코어 공유)", False, SUB)])
    y2 = y1 + 58 + GAP
    core(y2, 58, 2, [("Config Loader", True, CO_T), ("input > 설정 파일 > 기본값 병합", False, SUB)])
    y3 = y2 + 58 + GAP
    core(y3, 58, 3, [("Trigger Gate", True, CO_T), ("run / skip 판정 · skip이면 종료", False, SUB)])

    s.comment("파이프라인 ④ Context 수집 (Context Aggregator + PRD Providers)")
    yg = y3 + 58 + GAP                       # group band top
    y4a = yg + 34
    y4b = y4a + 58 + GAP
    yg_end = y4b + 124 + 12
    s.rect(BX - 8, yg, BW + 16, yg_end - yg, CO_G, None, rx=10)
    s.badge(BX, yg, 4)
    s.rich(BX + 20, yg + 23, [("Context 수집", True, CO_T), ("  src/context", False, SUB)], 16)
    core(y4a, 58, None, [("Context Aggregator", True, CO_T), ("PR 메타 · 변경 파일+patch · 원문", False, SUB)])
    core(y4b, 124, None, [("PRD Providers", True, CO_T), ("GitHub Issue · Jira · Notion", False, SUB),
                          ("병렬 조회 · 문서당 15초 타임아웃", False, SUB), ("실패한 문서는 경고 후 계속", False, SUB)])

    s.comment("파이프라인 ⑤ Preprocess — ★ Rust 전환점")
    y5 = yg_end + GAP
    core(y5, 88, 5, [([("Preprocess  ", True, CO_T), ("★ Rust 전환점", True, RU_S)], True, CO_T),
                     ("filter→parse→redact→AST→score→pack", False, INK),
                     ("I/O 없는 순수 함수 (결정적)", False, RU_T)], rust=True)
    s.comment("파이프라인 ⑥~⑧")
    y6 = y5 + 88 + GAP
    core(y6, 80, 6, [("LLM Orchestrator", True, CO_T), ("single: 1회 호출", False, SUB),
                     ("map-reduce: map N회 + reduce 1회", False, SUB)])
    y7 = y6 + 80 + GAP
    core(y7, 58, 7, [("QaReport 검증", True, CO_T), ("zod 스키마 검증 · 비용 집계", False, SUB)])
    y8 = y7 + 58 + GAP
    core(y8, 112, 8, [("Delivery", True, CO_T), ("PR comment · Slack · Job Summary", False, SUB),
                      ("채널별 독립 발행 · 출력 무해화", False, SUB)])
    assert y8 + 112 + 16 == ZB, (y8 + 112 + 16, ZB)

    s.comment("파이프라인 데이터 흐름 (굵은 실선, 위→아래)")
    flow(y1 + 58, y2, "이벤트 · inputs")
    flow(y2 + 58, y3, "Config")
    flow(y3 + 58, yg, "run")
    flow(y4a + 58, y4b, "PrdRef[]")
    flow(yg_end, y5, "PreprocessInput")
    flow(y5 + 88, y6, "PreprocessOutput")
    flow(y6 + 80, y7, "parsed_output")
    flow(y7 + 58, y8, "QaReport")

    # ---- GitHub side -----------------------------------------------------
    s.comment("GitHub: 이벤트(트리거)")
    s.rect(GX, y1, GW, 58, "#FFFFFF", GH_B, 1.8)
    s.lines(GC, y1, 58, [("PR 이벤트", True, GH_T), ("workflow_dispatch", False, SUB)], maxw=GW - 10)
    s.arrow([(GX + GW, y1 + 29), (BX, y1 + 29)], CALL)

    s.comment("GitHub REST API (세로로 긴 상자 1개 — 조회 2곳, 발행 1곳)")
    p_ctx, p_iss, p_cmt, p_sum = y4a + 29, y4b + 62, y8 + 26, y8 + 90
    api_top, api_bot = yg, p_cmt + 30
    s.rect(GX, api_top, GW, api_bot - api_top, "#FFFFFF", GH_B, 1.8)
    s.text(GC, api_top + 26, "GitHub REST API", 16, True, GH_T, "middle", GW - 10)

    def chip(py, rows):
        s.rect(GX + 8, py - 24, GW - 16, 48, GH_CHIP, None, rx=6)
        s.lines(GC, py - 24, 48, rows, lh=21, maxw=GW - 20)

    chip(p_ctx, [("PR 메타 · 파일", False, INK), ("원문 · 설정 조회", False, INK)])
    chip(p_iss, [("GitHub Issue", False, INK), ("조회 (PRD)", False, INK)])
    chip(p_cmt, [("PR 코멘트", False, INK), ("검색 · 수정/생성", False, INK)])
    ymid = (p_iss + p_cmt) / 2
    s.lines(GC, ymid - 44, 88, [("모든 호출 공통", False, MUTE), ("재시도 최대 3회", False, MUTE),
                               ("rate-limit 대기", False, MUTE)], maxw=GW - 16)
    s.arrow([(GX + GW, p_ctx), (BX, p_ctx)], CALL, heads="both")
    s.arrow([(GX + GW, p_iss), (BX, p_iss)], CALL, heads="both")
    s.arrow([(BX, p_cmt), (GX + GW, p_cmt)], CALL)

    s.comment("GitHub Actions Job Summary")
    s.rect(GX, p_sum - 26, GW, 52, "#FFFFFF", GH_B, 1.8)
    s.lines(GC, p_sum - 26, 52, [("Job Summary", True, GH_T), ("+ report.json", False, SUB)], lh=21, maxw=GW - 10)
    s.arrow([(BX, p_sum), (GX + GW, p_sum)], CALL)

    # ---- external side ---------------------------------------------------
    def ext(py, rows, h=58):
        s.rect(EX, py - h / 2, EW, h, "#FFFFFF", EX_B, 1.8)
        s.lines(EC, py - h / 2, h, rows, maxw=EW - 10)

    s.comment("외부 서비스: Jira · Notion (PRD Providers 옆)")
    p_jira, p_notion = y4b + 29, y4b + 95
    ext(p_jira, [("Jira Cloud", True, EX_T), ("이슈 조회", False, SUB)])
    ext(p_notion, [("Notion", True, EX_T), ("페이지·블록 조회", False, SUB)])
    s.arrow([(BX + BW, p_jira), (EX, p_jira)], CALL, heads="both")
    s.arrow([(BX + BW, p_notion), (EX, p_notion)], CALL, heads="both")
    s.comment("외부 서비스: Anthropic (LLM Orchestrator 옆)")
    p_ant = y6 + 40
    ext(p_ant, [("Anthropic API", True, EX_T), ("Structured", False, SUB), ("Outputs 호출", False, SUB)], h=80)
    s.arrow([(BX + BW, p_ant), (EX, p_ant)], CALL, heads="both")
    s.comment("외부 서비스: Slack (Delivery 옆)")
    p_slack = y8 + 56
    ext(p_slack, [("Slack", True, EX_T), ("Bot · Webhook", False, SUB)])
    s.arrow([(BX + BW, p_slack), (EX, p_slack)], CALL)

    # ---- legend ----------------------------------------------------------
    s.comment("범례")
    LX, LY, LW, LH = 614, 10, 176, 280
    s.rect(LX, LY, LW, LH, "#FFFFFF", "#6B7280", 1.2, 10, dash="5 4")
    s.text(LX + LW / 2, LY + 26, "범례", 17, True, INK, "middle")
    sx, tx, y, st = LX + 12, LX + 50, LY + 56, 29

    def sw_(yy, fill, stroke, sw=1.8):
        s.rect(sx, yy - 14, 30, 18, fill, stroke, sw, 4)

    sw_(y, GH_Z, GH_B); s.text(tx, y, "GitHub", 16, False, INK)
    y += st; sw_(y, CO_Z, CO_B); s.text(tx, y, "내부 파이프라인", 16, False, INK, maxw=LW - 56)
    y += st; sw_(y, EX_Z, EX_B); s.text(tx, y, "외부 서비스", 16, False, INK)
    y += st; sw_(y, RU_F, RU_S, 2.6); s.rich(tx, y, [("★ ", True, RU_S), ("Rust 전환점", False, INK)], 16, maxw=LW - 56)
    y += st; s.arrow([(sx, y - 5), (sx + 30, y - 5)], FLOW, 2.6, hl=11, hw=5.5); s.text(tx, y, "데이터 흐름", 16, False, INK)
    y += st; s.arrow([(sx, y - 5), (sx + 30, y - 5)], CALL, heads="both", hl=9); s.text(tx, y, "요청·응답 호출", 16, False, INK, maxw=LW - 56)
    y += st; s.arrow([(sx, y - 5), (sx + 30, y - 5)], CALL, hl=9); s.text(tx, y, "트리거 · 발행", 16, False, INK, maxw=LW - 56)
    y += st; s.badge(sx + 15, y - 5, 1); s.text(tx, y, "실행 순서", 16, False, INK)

    s.save(os.path.join(OUT, "architecture.svg"))
    return W, H


# =========================================================================
# 2. 실행 시퀀스
# =========================================================================
def sequence():
    W = 800
    E, A, G, P, L, S_ = 56, 232, 470, 574, 674, 762
    REQ, RES = "#111827", "#4B5563"
    PAR_F, PAR_S = "#ECFDF5", "#059669"
    ALT_S, BR1, BR2 = "#B45309", "#FEFCE8", "#FFEDD5"
    AR = A + 5                                   # right edge of activation bar
    ops = []                                     # deferred drawing: (layer, fn)

    def L0(fn): ops.append((0, fn))              # frame fills
    def L2(fn): ops.append((2, fn))              # arrows
    def L3(fn): ops.append((3, fn))              # labels / boxes

    s = Svg(W, 10, "qa-ticket-generator 실행 시퀀스")

    def req(y, x2, text=None, n=None, bg="#FFFFFF", x1=None, text2=None):
        x1 = AR if x1 is None else x1
        L2(lambda: s.arrow([(x1, y), (x2, y)], REQ, 1.8))
        if text:
            lx = min(x1, x2) + 8
            if n:
                L3(lambda bx=lx + 12: s.badge(bx, y - 15 - (20 if text2 else 0), n, "#111827"))
                lx += 30
            if text2:
                L3(lambda: s.label(lx, y - 29, text, bg=bg))
                L3(lambda: s.label(lx, y - 9, text2, bg=bg))
            else:
                L3(lambda: s.label(lx, y - 9, text, bg=bg))

    def res(y, x1, text, bg="#FFFFFF"):
        L2(lambda: s.arrow([(x1, y), (AR, y)], RES, 1.6, dash="6 4", hl=9, hw=4))
        L3(lambda: s.label(x1 - 8, y - 9, text, fill=RES, anchor="end", bg=bg, pad=3))

    def selfbox(y, n, rows, rust=False):
        """Action 내부 처리 상자. rows: [(parts)] 한 줄 또는 두 줄"""
        widths = [sum(tw(t, 16, b) for t, b, _ in r) for r in rows]
        w = 40 + max(widths) + 14
        h = 14 + 22 * len(rows)
        x = A - w / 2 if w <= 2 * (A - 80) else 80
        assert x + w <= G - 14, ("selfbox too wide", rows)

        def draw():
            s.rect(x, y, w, h, RU_F if rust else CO_Z, RU_S if rust else CO_B, 2.4 if rust else 1.6, 8)
            s.badge(x + 20, y + h / 2, n, RU_S if rust else CO_BADGE)
            for i, r in enumerate(rows):
                s.rich(x + 40, y + 24 + 22 * i, r, 16)
        L3(draw)
        return y + h

    T = lambda t, b=False, c=INK: (t, b, c)

    # ---- rows (y cursor) -------------------------------------------------
    y_act0 = 100
    req(100, A - 5, "pull_request", 1, x1=E)
    L3(lambda: s.label((E + A - 5) / 2, 120, "labeled · synchronize", fill=SUB, anchor="middle", pad=2))

    y = selfbox(132, 2, [[T("Trigger Gate", True, CO_T), T(" — run / skip 판정")]])

    y += 36                                                  # ③ request
    req(y, G, "PR 컨텍스트 조회", 3)
    y += 30
    res(y, G, "메타 · 파일+patch · 설정·원문")

    y = selfbox(y + 12, 4, [[T("PR 본문에서 "), T("PRD 참조", True, CO_T), T(" 추출")]])

    # ---- par frame -------------------------------------------------------
    y += 12
    par_top = y
    par_x, par_w = 210, P + 30 - 210
    y += 32                                                  # header row
    hdr_par = y - 12
    ys = []
    for _ in range(3):
        y += 27
        ys.append(y)
    y += 32
    y_par_res = y
    y += 12
    par_bot = y
    L0(lambda: s.rect(par_x, par_top, par_w, par_bot - par_top, PAR_F, PAR_S, 1.6, 8))

    def par_hdr():
        s.rect(par_x + 36, hdr_par - 17, 62, 26, PAR_S, None, rx=5)
        s.text(par_x + 67, hdr_par + 1, "병렬", 16, True, "#FFFFFF", "middle")
        s.badge(par_x + 118, hdr_par - 5, 5, "#111827")
        s.label(par_x + 136, hdr_par + 1, "PRD 조회 · 문서당 15초 타임아웃", bold=True, fill="#065F46", bg=PAR_F,
                maxw=par_x + par_w - (par_x + 136) - 6)
    L3(par_hdr)
    for yy, t in zip(ys, ["Jira 이슈", "Notion 페이지", "GitHub Issue"]):
        req(yy, P, t, bg=PAR_F)
    res(y_par_res, P, "PrdDocument[] · 실패 문서는 경고 후 계속", bg=PAR_F)

    y = selfbox(y + 12, 6, [[T("Preprocess  ", True, CO_T), T("★ Rust 전환점", True, RU_S)],
                            [T("filter→parse→redact→AST→score→pack")]], rust=True)

    # ---- alt frame -------------------------------------------------------
    y += 12
    alt_top = y
    alt_x, alt_w = 210, L + 30 - 210
    y += 36
    hdr_alt = y - 12
    b1_top = y
    y += 24; g1 = y                                          # guard 1 baseline
    y += 34; y_s_req = y
    y += 30; y_s_res = y
    y += 10; b1_bot = y
    b2_top = y
    y += 24; g2 = y
    y += 34; y_map = y                                       # first of 3 map arrows
    y += 22 + 30; y_map_res = y
    y += 32; y_red = y
    y += 30; y_red_res = y
    y += 10; b2_bot = y
    alt_bot = y
    L0(lambda: s.rect(alt_x, alt_top, alt_w, alt_bot - alt_top, "#FFFFFF", None, rx=8))
    L0(lambda: s.rect(alt_x, b1_top, alt_w, b1_bot - b1_top, BR1, None, rx=0))
    L0(lambda: s.rect(alt_x, b2_top, alt_w, b2_bot - b2_top, BR2, None, rx=0))
    L0(lambda: s.rect(alt_x, alt_top, alt_w, alt_bot - alt_top, "none", ALT_S, 1.6, 8))
    L0(lambda: s.line(alt_x, b1_top, alt_x + alt_w, b1_top, ALT_S, 1.2))
    L0(lambda: s.line(alt_x, b2_top, alt_x + alt_w, b2_top, ALT_S, 1.4, "7 5"))

    def alt_hdr():
        s.rect(alt_x + 36, hdr_alt - 17, 62, 26, ALT_S, None, rx=5)
        s.text(alt_x + 67, hdr_alt + 1, "분기", 16, True, "#FFFFFF", "middle")
        s.badge(alt_x + 118, hdr_alt - 5, 7, "#111827")
        s.label(alt_x + 136, hdr_alt + 1, "LLM 호출 · 토큰 예산에 따라 둘 중 하나", bold=True, fill="#7C2D12", bg="#FFFFFF")
        s.rich(alt_x + 36, g1, [T("[예산 이내] ", True, "#7C2D12"), T("single 모드", True, INK)], 16)
        s.rich(alt_x + 36, g2, [T("[예산 초과] ", True, "#7C2D12"), T("map-reduce 모드", True, INK)], 16)
    L3(alt_hdr)
    req(y_s_req, L, "1회 호출 (Structured Outputs)", bg=BR1)
    res(y_s_res, L, "QaReport", bg=BR1)
    req(y_map, L, "map 호출 × N청크 (동시 최대 3 · PRD 프리픽스 캐시)", bg=BR2)
    req(y_map + 11, L)
    req(y_map + 22, L)
    res(y_map_res, L, "부분 리포트 × N", bg=BR2)
    req(y_red, L, "reduce 호출 1회 (부분 리포트만 병합)", bg=BR2)
    res(y_red_res, L, "QaReport", bg=BR2)

    y = selfbox(y + 12, 8, [[T("QaReport 검증", True, CO_T), T(" (zod) · 비용 계산")]])

    y += 58
    req(y, G, "마커 코멘트 검색 →", 9, text2="수정 또는 생성 (+qtg-state)")
    y += 38
    req(y, S_, "Bot: chat.update(부모) + 스레드 재게시 / Webhook: 요약 카드", 10)
    y = selfbox(y + 12, 11, [[T("Job Summary", True, CO_T), T(" + outputs 기록")]])
    y_end = y + 12

    # ---- legend ----------------------------------------------------------
    ly = y_end + 29
    H = ly + 14
    s.h = H

    # ---- paint in layer order -------------------------------------------
    s.comment("프레임 배경 (병렬 / 분기)")
    for _, fn in [o for o in ops if o[0] == 0]:
        fn()
    s.comment("생명선")
    for x in (E, A, G, P, L, S_):
        s.line(x, 60, x, y_end, "#9CA3AF", 1.3, "5 5")
    s.comment("Action 활성 구간")
    s.rect(A - 5, y_act0, 10, y_end - y_act0, "#BFDBFE", CO_B, 1.2, 2)
    s.comment("메시지 화살표 (실선=호출, 점선=응답)")
    for _, fn in [o for o in ops if o[0] == 2]:
        fn()
    s.comment("라벨 · Action 내부 처리 상자")
    for _, fn in [o for o in ops if o[0] == 3]:
        fn()

    s.comment("참여자 6개")
    parts = [(E, 88, ["GitHub", "Event"], GH_Z, GH_B, GH_T), (A, 88, ["Action"], CO_G, CO_B, CO_T),
             (G, 88, ["GitHub", "API"], GH_Z, GH_B, GH_T), (P, 88, ["PRD", "Sources"], EX_Z, EX_B, EX_T),
             (L, 92, ["Anthropic"], EX_Z, EX_B, EX_T), (S_, 60, ["Slack"], EX_Z, EX_B, EX_T)]
    for x, w, names, fl, st, tc in parts:
        s.rect(x - w / 2, 8, w, 52, fl, st, 1.8, 8)
        s.lines(x, 8, 52, [(n_, True, tc) for n_ in names], lh=21, maxw=w - 8)

    s.comment("범례")
    s.line(10, y_end + 8, W - 10, y_end + 8, "#D1D5DB", 1)
    x = 20
    s.arrow([(x, ly - 5), (x + 34, ly - 5)], REQ, 1.8); s.text(x + 42, ly, "호출", 16, False, INK)
    x += 100
    s.arrow([(x + 34, ly - 5), (x, ly - 5)], RES, 1.6, dash="6 4", hl=9, hw=4); s.text(x + 42, ly, "응답", 16, False, INK)
    x += 100
    s.rect(x, ly - 15, 30, 20, CO_Z, CO_B, 1.6, 5); s.text(x + 38, ly, "Action 내부 처리", 16, False, INK)
    x += 178
    s.rect(x, ly - 15, 30, 20, PAR_F, PAR_S, 1.6, 5); s.text(x + 38, ly, "병렬 실행", 16, False, INK)
    x += 124
    s.rect(x, ly - 15, 30, 20, BR2, ALT_S, 1.6, 5); s.text(x + 38, ly, "조건 분기 (택1)", 16, False, INK)
    x += 38 + tw("조건 분기 (택1)") + 22
    s.badge(x + 12, ly - 5, 1, "#111827"); s.text(x + 30, ly, "순서", 16, False, INK, maxw=W - 10 - (x + 30))

    s.save(os.path.join(OUT, "sequence.svg"))
    return W, H


# =========================================================================
# 3. 전처리 파이프라인 상세
# =========================================================================
def preprocess():
    W = 800
    s = Svg(W, 10, "전처리 파이프라인 상세")
    SX, SW, NW = 24, 576, 164            # stage box x / width / name-cell width
    AXC = SX + NW / 2                    # flow arrow x
    RH, RG = 64, 30                      # row height / gap
    BUS = 772

    s.comment("입력")
    s.rect(SX, 10, SW, 62, CO_Z, CO_B, 1.8)
    s.rich(SX + 18, 36, [("PreprocessInput", True, CO_T), ("  JSON 직렬화 가능한 값만", False, SUB)], 16)
    s.text(SX + 18, 59, "files[] (patch · headContent) · prdDocuments[] · options", 16, False, INK, maxw=SW - 30)

    FT = 100
    stages = [
        ("filter", "filter.ts", "lock · 바이너리 · 빌드 산출물 · 자동 생성 파일 제외", "의존성·설정 변경은 제외하지 않고 요약", "남은 파일"),
        ("parse", "diff.ts", "unified diff를 hunk 단위로 파싱", "파일 경로 · rename · 추가/삭제 줄 범위", "hunk[]"),
        ("redact", "redact.ts", "diff · 원문 · PRD의 비밀값을 마스킹", "키 · 토큰 · JWT · 고엔트로피 → [REDACTED:type]", "마스킹된 hunk"),
        ("AST", "ast/expand.ts", "변경 줄을 감싸는 함수 · 메서드 · 클래스 추출", "TS · JS · Python · Java · Go, 실패 시 ±20줄", "hunk + 심볼 문맥"),
        ("score", "score.ts", "PRD 키워드 + log(변경 줄 수) + 도메인 경로", "− 테스트 · 설정 파일 (가중치 설정 가능)", "점수순 파일"),
        ("pack", "pack.ts · tokens.ts", "점수순으로 토큰 예산 안에 담기", "넘치면 map_reduce로 전환해 청크 분할", None),
    ]
    y0 = FT + 44
    ys = [y0 + i * (RH + RG) for i in range(6)]
    FB = ys[-1] + RH + 16

    s.comment("★ Rust 전환점 경계")
    s.rect(10, FT, 780, FB - FT, "#FFFBF5", RU_S, 2.2, 12, dash="9 5")
    s.rich(AXC + 20, FT + 28, [("★ Rust 전환점", True, RU_S), ("  src/preprocess — I/O 없는 순수 함수, 같은 입력 → 같은 출력", False, RU_T)], 16, maxw=780 - AXC - 20)

    s.comment("입력 → ① filter")
    s.arrow([(AXC, 72), (AXC, ys[0])], FLOW, 2.6, hl=11, hw=5.5)

    s.comment("6단계")
    for i, (name, file_, d1, d2, out) in enumerate(stages):
        y = ys[i]
        s.rect(SX, y, SW, RH, "#FFFFFF", CO_B, 1.8)
        s.add('<path d="M%d,%d h%d v%d h-%d a8,8 0 0 1 -8,-8 v-%d a8,8 0 0 1 8,-8 z" fill="%s"/>' % (SX + 8, y + 1, NW - 8, RH - 2, NW - 8, RH - 18, CO_G))
        s.line(SX + NW, y + 1, SX + NW, y + RH - 1, CO_B, 1.2)
        s.badge(SX + 24, y + 22, i + 1)
        s.text(SX + 44, y + 28, name, 17, True, CO_T)
        s.text(SX + 12, y + 52, file_, 16, False, SUB, maxw=NW - 18)
        s.text(SX + NW + 14, y + 27, d1, 16, False, INK, maxw=SW - NW - 24)
        s.text(SX + NW + 14, y + 50, d2, 16, False, SUB, maxw=SW - NW - 24)
        if out:
            s.arrow([(AXC, y + RH), (AXC, y + RH + RG)], FLOW, 2.6, hl=11, hw=5.5)
            s.text(AXC + 14, y + RH + RG / 2 + 6, out, 16, False, CO_T)

    s.comment("부산물: skipped[] · redactions[] → 오른쪽 세로선으로 출력에 합류")
    OY = FB + 30
    CXc, CW = 622, 128

    def side(y, t):
        s.rect(CXc, y + RH / 2 - 18, CW, 36, "#FFFFFF", MUTE, 1.5, 18)
        s.text(CXc + CW / 2, y + RH / 2 + 6, t, 16, False, INK, "middle", CW - 12)
        s.arrow([(SX + SW, y + RH / 2), (CXc, y + RH / 2)], CALL, hl=9)
        s.line(CXc + CW, y + RH / 2, BUS, y + RH / 2, CALL, 1.8)

    side(ys[0], "skipped[]")
    side(ys[2], "redactions[]")
    s.arrow([(BUS, ys[0] + RH / 2), (BUS, OY)], CALL, hl=9)
    s.add('<circle cx="%d" cy="%s" r="3.5" fill="%s"/>' % (BUS, ys[2] + RH / 2, CALL))

    s.comment("⑥ pack → 출력")
    s.arrow([(AXC, ys[5] + RH), (AXC, OY)], FLOW, 2.6, hl=11, hw=5.5)

    s.comment("출력")
    OW = 786 - SX
    s.rect(SX, OY, OW, 62, CO_Z, CO_B, 1.8)
    s.rich(SX + 18, OY + 26, [("PreprocessOutput", True, CO_T)], 16)
    s.text(SX + 18, OY + 49, "mode · chunks[] · prdDocuments[] (마스킹본) · skipped[] · redactions[] · estimatedTokens", 16, False, INK, maxw=OW - 30)

    s.comment("mode에 따른 다음 단계 (LLM Orchestrator)")
    MY = OY + 62 + 34
    MW = (OW - 20) / 2
    for k, (title, sub_, guard) in enumerate([("mode: single", "예산 이내 → LLM 1회 호출", None),
                                               ("mode: map_reduce", "예산 초과 → 청크별 map + reduce", None)]):
        x = SX + k * (MW + 20)
        s.rect(x, MY, MW, 58, BR[k], ALT_S, 1.6)
        s.lines(x + MW / 2, MY, 58, [(title, True, INK), (sub_, False, SUB)], maxw=MW - 16)
        s.arrow([(x + MW / 2, OY + 62), (x + MW / 2, MY)], FLOW, 2.6, hl=11, hw=5.5)
    s.text(SX + OW / 2, OY + 62 + 22, "둘 중 하나", 16, False, MUTE, "middle")

    s.h = MY + 58 + 12
    s.save(os.path.join(OUT, "preprocess.svg"))
    return W, s.h


BR = ["#FEFCE8", "#FFEDD5"]
ALT_S = "#B45309"


# =========================================================================
def render(name, w, h):
    svg = os.path.join(OUT, name + ".svg")
    html = os.path.join(OUT, name + ".html")
    png = os.path.join(OUT, name + ".png")
    with open(html, "w", encoding="utf-8") as fp:
        fp.write('<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#fff;overflow:hidden}'
                 'img{display:block}</style><img src="%s.svg" width="%d" height="%d">' % (name, w, h))
    if os.path.exists(png):
        os.remove(png)
    pad = 120  # new headless: viewport can be shorter than the window; over-size then crop
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2",
                    "--window-size=%d,%d" % (w, h + pad), "--screenshot=" + png,
                    "--user-data-dir=" + os.path.join(OUT, "chrome-profile"),
                    "file:///" + html.replace("\\", "/")], check=True, capture_output=True, timeout=120)
    im = Image.open(png)
    im = im.convert("RGB").crop((0, 0, 2 * w, 2 * h))
    im.save(png, dpi=(192, 192))
    print("rendered", png, im.size)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    which = [a for a in sys.argv[1:] if not a.startswith("--")] or ["architecture", "sequence", "preprocess"]
    fns = {"architecture": architecture, "sequence": sequence, "preprocess": preprocess}
    for n in which:
        w, h = fns[n]()
        render(n, w, h)
    if "--publish" in sys.argv:
        os.makedirs(DEST, exist_ok=True)
        for n in fns:
            for ext in (".svg", ".png"):
                shutil.copyfile(os.path.join(OUT, n + ext), os.path.join(DEST, n + ext))
        print("published ->", DEST, sorted(os.listdir(DEST)))
