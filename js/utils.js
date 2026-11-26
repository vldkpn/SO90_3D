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

const MAX_SHADE_CACHE_SIZE = 512;
const shadeCache = new Map();

export const MathUtil = {
  clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  },
  lerp(a, b, t) {
    return a + (b - a) * t;
  },
  percentRemaining(n, total) {
    if (!total) return 0;
    return (((n % total) + total) % total) / total;
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
    if (typeof hex !== 'string') return hex;
    // Квантуем коэффициент до сотых, чтобы кэш не переполнялся и не сбрасывался от дробных float
    const qFactor = Math.round(factor * 100) / 100;
    const key = `${hex}_${qFactor}`;
    const cached = shadeCache.get(key);
    if (cached) return cached;

    const clean = hex.replace('#', '');
    if (clean.length !== 6) return hex;
    const num = parseInt(clean, 16);
    if (Number.isNaN(num)) return hex;

    const r = Math.min(255, Math.max(0, Math.round(((num >> 16) & 255) * qFactor)));
    const g = Math.min(255, Math.max(0, Math.round(((num >> 8) & 255) * qFactor)));
    const b = Math.min(255, Math.max(0, Math.round((num & 255) * qFactor)));
    const res = `rgb(${r},${g},${b})`;

    // Мягкое вытеснение самой старой записи вместо полной очистки кэша
    if (shadeCache.size >= MAX_SHADE_CACHE_SIZE) {
      const oldestKey = shadeCache.keys().next().value;
      if (oldestKey !== undefined) {
        shadeCache.delete(oldestKey);
      }
    }
    shadeCache.set(key, res);
    return res;
  }
};

export function formatRaceTime(sec) {
  if (!Number.isFinite(sec)) return '00:00.00';
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
  if (!totalLen || totalLen <= 0) return 0;
  let dz = (((toZ - fromZ) % totalLen) + totalLen) % totalLen;
  if (dz > totalLen * 0.5) dz -= totalLen;
  return dz;
}