#!/usr/bin/env python3
"""OKLch -> sRGB -> WCAG contrast helper for the FUT Squad Lab token set."""
import math


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


def lum(L, C, H):
    r, g, b = oklch_to_srgb(L, C, H)
    def lin(v):
        v = v / 255
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)


def ratio(fg, bg):
    a, b = lum(*fg), lum(*bg)
    hi, lo = max(a, b), min(a, b)
    return (hi + 0.05) / (lo + 0.05)


T = {
    "surface-0": (0.165, 0.013, 250),
    "surface-1": (0.208, 0.015, 250),
    "surface-2": (0.255, 0.017, 250),
    "inset": (0.135, 0.012, 250),
    "border": (0.30, 0.016, 250),
    "border-strong": (0.48, 0.018, 250),
    "fg": (0.965, 0.006, 250),
    "fg-muted": (0.745, 0.014, 250),
    "fg-dim": (0.635, 0.014, 250),
    "accent": (0.815, 0.135, 197),
    "accent-deep": (0.62, 0.11, 197),
    "success": (0.835, 0.16, 142),
    "warning": (0.83, 0.145, 82),
    "danger": (0.715, 0.185, 25),
    "accent-fg": (0.18, 0.02, 240),
    "lime-deep": (0.55, 0.12, 142),
    "danger-fg": (0.30, 0.09, 25),
    "warn-fg": (0.28, 0.06, 82),
}

pairs = [
    ("fg", "surface-0"), ("fg", "surface-1"), ("fg", "surface-2"), ("fg", "inset"),
    ("fg-muted", "surface-0"), ("fg-muted", "surface-1"), ("fg-muted", "surface-2"), ("fg-muted", "inset"),
    ("fg-dim", "surface-0"), ("fg-dim", "surface-1"), ("fg-dim", "surface-2"), ("fg-dim", "inset"),
    ("accent", "surface-0"), ("accent", "surface-1"), ("accent", "surface-2"),
    ("success", "surface-1"), ("warning", "surface-1"), ("danger", "surface-1"), ("danger", "surface-2"),
    ("accent-fg", "accent"), ("accent-fg", "success"), ("accent-fg", "warning"),
    ("danger-fg", "danger"), ("warn-fg", "warning"), ("lime-deep", "success"),
    ("border-strong", "surface-0"),
]

print("name".ljust(26), "hex".ljust(9), "vs surface-0")
for k, v in T.items():
    print(f"{k:<26} #{''.join(f'{c:02x}' for c in oklch_to_srgb(*v)):<9}")
print()
for f, b in pairs:
    r = ratio(T[f], T[b])
    flag = "OK " if r >= 4.5 else ("3:1" if r >= 3 else "LOW")
    print(f"{f:>12} on {b:<12} {r:6.2f}  {flag}")


# Chip check: color-mix(in oklch, COLOUR 16%, transparent) composited over surface-1.
def srgb_lin(c):
    v = c / 255
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def luminance_rgb(rgb):
    r, g, b = (srgb_lin(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast_rgb(a, b):
    la, lb = luminance_rgb(a), luminance_rgb(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


print("\nchip: text colour on its own 16% tint over surface-1")
base = oklch_to_srgb(*T["surface-1"])
for name in ("accent", "success", "warning", "danger"):
    tint = oklch_to_srgb(*T[name])
    comp = tuple(int(round(base[i] * 0.84 + tint[i] * 0.16)) for i in range(3))
    print(f"  {name:>8} text on tint #{''.join(f'{c:02x}' for c in comp)}  {contrast_rgb(tint, comp):5.2f}  "
          f"fg on tint {contrast_rgb(oklch_to_srgb(*T['fg']), comp):5.2f}")

print("\nrule/border visibility (non-text, 3:1 target vs surface-0)")
for name in ("border", "border-strong"):
    print(f"  {name:>14} {contrast_rgb(oklch_to_srgb(*T[name]), base):5.2f}")

