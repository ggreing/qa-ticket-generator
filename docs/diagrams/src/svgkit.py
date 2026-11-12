# -*- coding: utf-8 -*-
"""Tiny hand-layout SVG helper. Every coordinate is given explicitly by the caller.
Portable output: no <marker>, no CSS classes, no filters (safe for Word / Chrome)."""
from PIL import ImageFont

FONT_REG = r"C:\Windows\Fonts\malgun.ttf"
FONT_BLD = r"C:\Windows\Fonts\malgunbd.ttf"
FAMILY = "'Malgun Gothic','맑은 고딕',sans-serif"
MIN_FONT = 16  # 800px canvas -> 16cm wide => 16px = 9.07pt

_fc = {}


def _font(size, bold):
    k = (size, bold)
    if k not in _fc:
        _fc[k] = ImageFont.truetype(FONT_BLD if bold else FONT_REG, size)
    return _fc[k]


def tw(s, size=16, bold=False):
    return _font(size, bold).getlength(s)


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def f(v):
    return ("%.1f" % v).rstrip("0").rstrip(".")


class Svg:
    def __init__(self, w, h, title):
        self.w, self.h, self.title = w, h, title
        self.el = []
        self.warn = []

    def add(self, s):
        self.el.append("  " + s)

    def comment(self, s):
        self.el.append("")
        self.el.append("  <!-- %s -->" % s)

    def rect(self, x, y, w, h, fill="#FFFFFF", stroke=None, sw=1.5, rx=8, dash=None):
        a = 'x="%s" y="%s" width="%s" height="%s" rx="%s" fill="%s"' % (f(x), f(y), f(w), f(h), f(rx), fill)
        if stroke:
            a += ' stroke="%s" stroke-width="%s"' % (stroke, f(sw))
            if dash:
                a += ' stroke-dasharray="%s"' % dash
        self.add("<rect %s/>" % a)

    def line(self, x1, y1, x2, y2, stroke, sw=1.5, dash=None):
        a = 'x1="%s" y1="%s" x2="%s" y2="%s" stroke="%s" stroke-width="%s"' % (f(x1), f(y1), f(x2), f(y2), stroke, f(sw))
        if dash:
            a += ' stroke-dasharray="%s"' % dash
        self.add("<line %s/>" % a)

    def _check(self, s, width, maxw, size):
        if size < MIN_FONT:
            self.warn.append("FONT<%d: %r" % (MIN_FONT, s))
        if maxw is not None and width > maxw:
            self.warn.append("OVERFLOW %.0f > %.0f: %r" % (width, maxw, s))

    def text(self, x, y, s, size=16, bold=False, fill="#111827", anchor="start", maxw=None):
        self._check(s, tw(s, size, bold), maxw, size)
        a = 'x="%s" y="%s" font-size="%d" fill="%s"' % (f(x), f(y), size, fill)
        if bold:
            a += ' font-weight="bold"'
        if anchor != "start":
            a += ' text-anchor="%s"' % anchor
        self.add("<text %s>%s</text>" % (a, esc(s)))

    def rich(self, x, y, parts, size=16, anchor="start", maxw=None):
        """parts: [(text, bold, fill)]. Anchor resolved by measurement (portable)."""
        total = sum(tw(t, size, b) for t, b, _ in parts)
        self._check("".join(t for t, _, _ in parts), total, maxw, size)
        x0 = x - total / 2 if anchor == "middle" else (x - total if anchor == "end" else x)
        sp = "".join(
            '<tspan%s fill="%s">%s</tspan>' % (' font-weight="bold"' if b else ' font-weight="normal"', c, esc(t))
            for t, b, c in parts
        )
        self.add('<text x="%s" y="%s" font-size="%d" xml:space="preserve">%s</text>' % (f(x0), f(y), size, sp))
        return x0, total

    def label(self, x, y, s, size=16, bold=False, fill="#111827", anchor="start", bg="#FFFFFF", pad=4, maxw=None):
        """Text with an opaque background plate (masks lifelines behind it)."""
        w = tw(s, size, bold)
        x0 = x - w / 2 if anchor == "middle" else (x - w if anchor == "end" else x)
        self.rect(x0 - pad, y - size + 2, w + 2 * pad, size + 3, fill=bg, rx=3)
        self.text(x0, y, s, size, bold, fill, maxw=maxw)
        return x0, w

    def _head(self, tip, frm, color, hl, hw):
        dx, dy = tip[0] - frm[0], tip[1] - frm[1]
        d = (dx * dx + dy * dy) ** 0.5
        ux, uy = dx / d, dy / d
        bx, by = tip[0] - ux * hl, tip[1] - uy * hl
        nx, ny = -uy, ux
        pts = [tip, (bx + nx * hw, by + ny * hw), (bx - nx * hw, by - ny * hw)]
        self.add('<polygon points="%s" fill="%s"/>' % (" ".join("%s,%s" % (f(px), f(py)) for px, py in pts), color))
        return (tip[0] - ux * (hl - 1), tip[1] - uy * (hl - 1))

    def arrow(self, pts, color="#374151", sw=1.8, heads="end", dash=None, hl=10, hw=4.5):
        """Orthogonal polyline with explicit polygon arrowheads. heads: end|both|none"""
        pts = [tuple(p) for p in pts]
        if heads in ("end", "both"):
            pts[-1] = self._head(pts[-1], pts[-2], color, hl, hw)
        if heads == "both":
            pts[0] = self._head(pts[0], pts[1], color, hl, hw)
        a = 'points="%s" fill="none" stroke="%s" stroke-width="%s"' % (
            " ".join("%s,%s" % (f(px), f(py)) for px, py in pts), color, f(sw))
        if dash:
            a += ' stroke-dasharray="%s"' % dash
        self.add("<polyline %s/>" % a)

    def badge(self, cx, cy, n, fill="#1D4ED8", r=12):
        self.add('<circle cx="%s" cy="%s" r="%s" fill="%s" stroke="#FFFFFF" stroke-width="1.5"/>' % (f(cx), f(cy), f(r), fill))
        self.text(cx, cy + 5.7, str(n), 16, True, "#FFFFFF", "middle")

    def lines(self, cx, y, h, rows, lh=22, maxw=None):
        """Vertically centred block of centred lines. rows: [(text|parts, bold, fill)]"""
        y0 = y + (h - len(rows) * lh) / 2 + 16.5
        for i, (t, b, c) in enumerate(rows):
            if isinstance(t, list):
                self.rich(cx, y0 + i * lh, t, 16, "middle", maxw)
            else:
                self.text(cx, y0 + i * lh, t, 17 if b else 16, b, c, "middle", maxw)

    def save(self, path):
        head = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d" '
            'font-family="%s">\n  <title>%s</title>\n'
            '  <rect x="0" y="0" width="%d" height="%d" fill="#FFFFFF"/>'
            % (self.w, self.h, self.w, self.h, FAMILY, esc(self.title), self.w, self.h)
        )
        with open(path, "w", encoding="utf-8", newline="\n") as fp:
            fp.write(head + "\n" + "\n".join(self.el) + "\n</svg>\n")
        for w_ in self.warn:
            print("  WARN", w_)
        print("saved", path, "%dx%d" % (self.w, self.h), "ratio %.2f -> %.1fcm tall @16cm" % (self.h / self.w, 16 * self.h / self.w))
