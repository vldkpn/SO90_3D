/**
 * Математические, цветовые и вспомогательные утилиты
 */
export function initCanvasPolyfills() {
  if (typeof CanvasRenderingContext2D !== 'undefined' && !CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
      const safeW = Math.max(0, w);
      const safeH = Math.max(0, h);
      const rawR = Array.isArray(r) ? r[0] : (r || 0);
      const radius = Math.max(0, Math.min(rawR, safeW / 2, safeH / 2));
      this.beginPath();
      this.moveTo(x + radius, y);
      this.arcTo(x + safeW, y, x + safeW, y + safeH, radius);
      this.arcTo(x + safeW, y + safeH, x, y + safeH, radius);
      this.arcTo(x, y + safeH, x, y, radius);
      this.arcTo(x, y, x + safeW, y, radius);
      this.closePath();
      return this;
    };
  }
}

const shadeCache = new Map();

export const MathUtil = {
  clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  },
  lerp(a, b, t) {
    return a + (b - a) * t;
  },
  percentRemaining(n, total) {
    return (n % total) / total;
  },
  randomChoice(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  },
  overlap(x1, w1, x2, w2, percent = 1) {
    const half = percent / 2;
    const min1 = x1 - w1 * half;
    const max1 = x1 + w1 * half;
    const min2 = x2 - w2 * half;
    const max2 = x2 + w2 * half;
    return !(max1 < min2 || min1 > max2);
  },
  easeIn(a, b, percent) {
    return a + (b - a) * Math.pow(percent, 2);
  },
  easeInOut(a, b, percent) {
    return a + (b - a) * ((-Math.cos(percent * Math.PI) / 2) + 0.5);
  },
  exponentialFog(distance, density) {
    return 1 - (1 / Math.pow(Math.E, distance * distance * density));
  },
  shadeHex(hex, factor) {
    const key = `${hex}_${factor}`;
    const cached = shadeCache.get(key);
    if (cached) return cached;
    const clean = hex.replace('#', '');
    if (clean.length !== 6) return hex;
    const num = parseInt(clean, 16);
    const r = Math.min(255, Math.max(0, Math.round(((num >> 16) & 255) * factor)));
    const g = Math.min(255, Math.max(0, Math.round(((num >> 8) & 255) * factor)));
    const b = Math.min(255, Math.max(0, Math.round((num & 255) * factor)));
    const res = `rgb(${r},${g},${b})`;
    shadeCache.set(key, res);
    return res;
  }
};

export function formatRaceTime(sec) {
  const clamped = Math.max(0, sec);
  const mins = Math.floor(clamped / 60);
  const secs = Math.floor(clamped % 60);
  const hundredths = Math.floor((clamped - Math.floor(clamped)) * 100);
  const mm = String(mins).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');
  const cc = String(hundredths).padStart(2, '0');
  return `${mm}:${ss}.${cc}`;
}

export function getShortestTrackDz(fromZ, toZ, totalLen) {
  let dz = toZ - fromZ;
  if (dz > totalLen / 2) dz -= totalLen;
  if (dz < -totalLen / 2) dz += totalLen;
  return dz;
}