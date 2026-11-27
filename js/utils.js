/**
 * Математические, цветовые и вспомогательные утилиты
 */
export function initCanvasPolyfills() {
  if (typeof CanvasRenderingContext2D !== 'undefined' && !CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, radii = 0) {
      const safeW = Math.max(0, w);
      const safeH = Math.max(0, h);
      const maxR = Math.min(safeW * 0.5, safeH * 0.5);
      const clampR = (val) => Math.max(0, Math.min(Number(val) || 0, maxR));

      let tl = 0;
      let tr = 0;
      let br = 0;
      let bl = 0;

      if (Array.isArray(radii)) {
        const len = radii.length;
        if (len === 1) {
          tl = tr = br = bl = clampR(radii[0]);
        } else if (len === 2) {
          tl = br = clampR(radii[0]);
          tr = bl = clampR(radii[1]);
        } else if (len === 3) {
          tl = clampR(radii[0]);
          tr = bl = clampR(radii[1]);
          br = clampR(radii[2]);
        } else if (len >= 4) {
          tl = clampR(radii[0]);
          tr = clampR(radii[1]);
          br = clampR(radii[2]);
          bl = clampR(radii[3]);
        }
      } else {
        tl = tr = br = bl = clampR(radii);
      }

      // Соответствует спецификации Canvas 2D: добавляет подпуть без сброса текущего пути через beginPath()
      this.moveTo(x + tl, y);
      this.arcTo(x + safeW, y, x + safeW, y + safeH, tr);
      this.arcTo(x + safeW, y + safeH, x, y + safeH, br);
      this.arcTo(x, y + safeH, x, y, bl);
      this.arcTo(x, y, x + safeW, y, tl);
      this.closePath();
      return this;
    };
  }
}

// Двухуровневый кэш оттенков: parseInt выполняется 1 раз на базовый цвет, попадание в кэш — 0 аллокаций строк
const MAX_SHADE_BASE_COLORS = 128;
const MAX_SHADE_FACTOR_INDEX = 300;
const shadeCache = new Map();

export const MathUtil = {
  clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  },
  lerp(a, b, t) {
    return a + (b - a) * t;
  },
  wrap(val, max) {
    if (!max) return 0;
    return ((val % max) + max) % max;
  },
  percentRemaining(n, total) {
    if (!total) return 0;
    return (((n % total) + total) % total) / total;
  },
  randomChoice(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  },
  overlap(x1, w1, x2, w2, percent = 1) {
    return Math.abs(x1 - x2) <= (w1 + w2) * percent * 0.5;
  },
  easeIn(a, b, percent) {
    return a + (b - a) * percent * percent;
  },
  easeInOut(a, b, percent) {
    return a + (b - a) * ((-Math.cos(percent * Math.PI) * 0.5) + 0.5);
  },
  exponentialFog(distance, density) {
    return 1 - Math.exp(-distance * distance * density);
  },
  shadeHex(hex, factor) {
    if (typeof hex !== 'string') return hex;

    const safeFactor = Number.isFinite(factor) ? Math.max(0, factor) : 1;
    const qInt = Math.round(safeFactor * 100);

    let entry = shadeCache.get(hex);
    if (!entry) {
      const clean = hex.charCodeAt(0) === 35 ? hex.slice(1) : hex;
      if (clean.length !== 6) return hex;
      const num = parseInt(clean, 16);
      if (Number.isNaN(num)) return hex;

      entry = {
        r: (num >> 16) & 255,
        g: (num >> 8) & 255,
        b: num & 255,
        shades: []
      };
      if (shadeCache.size >= MAX_SHADE_BASE_COLORS) {
        shadeCache.clear();
      }
      shadeCache.set(hex, entry);
    }

    if (qInt <= MAX_SHADE_FACTOR_INDEX) {
      const cached = entry.shades[qInt];
      if (cached !== undefined) return cached;
    }

    const qFactor = qInt * 0.01;
    const r = Math.min(255, Math.round(entry.r * qFactor));
    const g = Math.min(255, Math.round(entry.g * qFactor));
    const b = Math.min(255, Math.round(entry.b * qFactor));
    const res = `rgb(${r},${g},${b})`;

    if (qInt <= MAX_SHADE_FACTOR_INDEX) {
      entry.shades[qInt] = res;
    }
    return res;
  }
};

export function formatRaceTime(sec) {
  if (!Number.isFinite(sec)) return '00:00.00';
  // Целочисленный перевод в сотые доли секунды устраняет потерю 0.01с из-за погрешности IEEE-754
  const totalCs = Math.floor(Math.max(0, sec) * 100 + 1e-6);
  const mins = Math.floor(totalCs / 6000);
  const secs = Math.floor((totalCs % 6000) / 100);
  const hundredths = totalCs % 100;
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