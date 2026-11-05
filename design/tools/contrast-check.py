#!/usr/bin/env python3
"""OKLch -> sRGB -> WCAG contrast checker for the FUT Squad Lab token set.

Exit status is part of the contract: the script exits 1 when any pair that
declares a target falls below it. Pairs without a target are informational and
can never fail the run.

Targets mirror WCAG 2.2: 4.5:1 for normal text and 3:1 for non-text boundaries
that identify a control (SC 1.4.3 and SC 1.4.11).
"""
import math
import re
import sys
from pathlib import Path

TOKENS_CSS = Path(__file__).resolve().parent.parent / "tokens.css"


def oklch_to_srgb(L, C, H):
    h = math.radians(H)
    a = C * math.cos(h)
    b = C * math.sin(h)
    l_ = L + 0.3963377774 * a + 0.2158037573 * b
    m_ = L - 0.1055613458 * a - 0.0638541728 * b
    s_ = L - 0.0894841775 * a - 1.2914855480 * b
    l, m, s = l_**3, m_**3, s_**3
    r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
    g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
    bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    out = []
    for c in (r, g, bl):
        c = max(0.0, min(1.0, c))
        srgb = 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055
        out.append(int(round(max(0.0, min(1.0, srgb)) * 255)))
    return tuple(out)


def srgb_lin(channel):
    v = channel / 255
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def luminance_rgb(rgb):
    r, g, b = (srgb_lin(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast_rgb(a, b):
    la, lb = luminance_rgb(a), luminance_rgb(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def ratio(fg, bg):
    return contrast_rgb(oklch_to_srgb(*fg), oklch_to_srgb(*bg))


def hex6(rgb):
    return "".join(f"{c:02x}" for c in rgb)


# Values are parsed from design/tokens.css rather than copied here. A copied
# table silently drifts whenever a token changes; parsing makes the checker read
# the same source of truth as the UI. Two colours are deliberately not tokens:
# `lime-deep` is a retired value kept only for an informational comparison, and
# `danger-fg` is used by a contrast pair but has no token in the palette. They
# stay literal, and `_build_T` raises if either name is later added to
# tokens.css, so a new token cannot be ignored silently.
_token_re = re.compile(
    r"--fsl-([a-z0-9-]+)\s*:\s*oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)"
)

# Script keys that do not share a name with their token.
TOKEN_ALIASES = {
    "inset": "surface-inset",
    "warn-fg": "fg-on-warning",
}

TOKEN_KEYS = [
    "surface-0", "surface-1", "surface-2", "inset",
    "border", "border-strong", "fg", "fg-muted", "fg-dim",
    "accent", "accent-deep", "success", "warning", "danger",
    "accent-fg", "warn-fg",
]

NON_TOKEN = {
    "lime-deep": (0.55, 0.12, 142),
    "danger-fg": (0.30, 0.09, 25),
}


def _build_T(tokens_css=TOKENS_CSS):
    text = tokens_css.read_text(encoding="utf-8")
    found = {
        name: (float(l), float(c), float(h))
        for name, l, c, h in _token_re.findall(text)
    }
    T = {}
    for key in TOKEN_KEYS:
        css_name = TOKEN_ALIASES.get(key, key)
        if css_name not in found:
            raise SystemExit(
                f"contrast-check: token --fsl-{css_name} is missing from {tokens_css}"
            )
        T[key] = found[css_name]
    for key, value in NON_TOKEN.items():
        if key in found:
            raise SystemExit(
                f"contrast-check: --fsl-{key} now exists in {tokens_css}; "
                "move it into TOKEN_KEYS so the checker uses the token value"
            )
        T[key] = value
    return T


T = _build_T()

# (foreground, background, target). `None` means informational only.
pairs = [
    ("fg", "surface-0", 4.5), ("fg", "surface-1", 4.5), ("fg", "surface-2", 4.5),
    ("fg", "inset", 4.5),
    ("fg-muted", "surface-0", 4.5), ("fg-muted", "surface-1", 4.5),
    ("fg-muted", "surface-2", 4.5), ("fg-muted", "inset", 4.5),
    ("fg-dim", "surface-0", 4.5), ("fg-dim", "surface-1", 4.5),
    ("fg-dim", "surface-2", 4.5), ("fg-dim", "inset", 4.5),
    ("accent", "surface-0", 4.5), ("accent", "surface-1", 4.5), ("accent", "surface-2", 4.5),
    ("success", "surface-1", 4.5), ("warning", "surface-1", 4.5),
    ("danger", "surface-1", 4.5), ("danger", "surface-2", 4.5),
    ("accent-fg", "accent", 4.5), ("accent-fg", "success", 4.5), ("accent-fg", "warning", 4.5),
    ("danger-fg", "danger", 4.5), ("warn-fg", "warning", 4.5),
    # `lime-deep` is not in tokens.css and no component uses it. Informational
    # only, so its 2.92:1 is reported without failing the run.
    ("lime-deep", "success", None),
]

# Functional boundaries: control outlines must clear SC 1.4.11 on every surface
# they are used on. The decorative hairline has no target.
border_pairs = [
    ("border-strong", "surface-0", 3.0),
    ("border-strong", "surface-1", 3.0),
    ("border-strong", "surface-2", 3.0),
    ("border", "surface-0", None),
    ("border", "surface-1", None),
    ("border", "surface-2", None),
]

failures = []


def verdict(label, r, target):
    """Return the printed flag and record the failure.

    FAIL and `failures` must never diverge: this is the only place that decides
    a targeted pair failed, and every caller prints the flag returned here.
    """
    if target is None:
        return "info" if r >= 3 else "LOW "
    if r >= target:
        return "OK"
    failures.append(f"{label}: {r:.2f} < {target:.1f}")
    return "FAIL"


def report(f, b, target):
    r = ratio(T[f], T[b])
    flag = verdict(f"{f} on {b}", r, target)
    target_text = "—" if target is None else f"{target:.1f}"
    print(f"{f:>14} on {b:<12} {r:6.2f}  target {target_text:>4}  {flag}")


print("name".ljust(26), "hex".ljust(9), "vs surface-0")
for k, v in T.items():
    print(f"{k:<26} #{hex6(oklch_to_srgb(*v)):<9}")
print()
print("text pairs")
for f, b, target in pairs:
    report(f, b, target)


# Chip check: color-mix(in oklch, COLOUR 16%, transparent) composited over surface-1.
print("\nchip: text colour on its own 16% tint over surface-1")
base = oklch_to_srgb(*T["surface-1"])
for name in ("accent", "success", "warning", "danger"):
    tint = oklch_to_srgb(*T[name])
    comp = tuple(int(round(b * 0.84 + t * 0.16)) for b, t in zip(base, tint))
    text_ratio = contrast_rgb(tint, comp)
    fg_ratio = contrast_rgb(oklch_to_srgb(*T["fg"]), comp)
    text_flag = verdict(f"{name} text on tint", text_ratio, 4.5)
    fg_flag = verdict("fg on tint", fg_ratio, 4.5)
    print(f"  {name:>8} text on tint #{hex6(comp)}  "
          f"{text_ratio:5.2f}  target 4.5  {text_flag}")
    print(f"  {'fg':>8} on tint                      {fg_ratio:5.2f}  target 4.5  "
          f"{fg_flag}")

print("\nrule/border visibility (non-text; target 3:1 where functional)")
for f, b, target in border_pairs:
    report(f, b, target)

if failures:
    print("\nFAILED:")
    for line in failures:
        print(f"  {line}")
    sys.exit(1)
print("\nall targeted pairs pass")
