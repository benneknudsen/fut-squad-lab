import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const tokensCss = readFileSync(new URL('../design/tokens.css', import.meta.url), 'utf8');

function token(name) {
  const match = tokensCss.match(
    new RegExp(`--fsl-${name}:\\s*oklch\\(([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\)`),
  );
  expect(match, `--fsl-${name} missing from design/tokens.css`).not.toBeNull();
  return match.slice(1, 4).map(Number);
}

function oklchToSrgb([L, C, H]) {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const channels = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return channels.map((c) => {
    const clamped = Math.max(0, Math.min(1, c));
    const srgb = clamped <= 0.0031308
      ? 12.92 * clamped
      : 1.055 * clamped ** (1 / 2.4) - 0.055;
    return Math.round(Math.max(0, Math.min(1, srgb)) * 255);
  });
}

function linear(channel) {
  const v = channel / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance(colour) {
  const [r, g, b] = oklchToSrgb(colour).map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground, background) {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe('--fsl-border-strong control outline', () => {
  const surfaces = ['surface-0', 'surface-1', 'surface-2'];

  it.each(surfaces)('clears the 3:1 non-text contrast minimum on %s', (surface) => {
    expect(contrast(token('border-strong'), token(surface))).toBeGreaterThanOrEqual(3);
  });

  it('keeps its chosen margin above 3.2:1 on the lightest surface', () => {
    expect(contrast(token('border-strong'), token('surface-2'))).toBeGreaterThanOrEqual(3.2);
  });
});
