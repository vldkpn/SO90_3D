import {
  STATE,
  LOGICAL_HEIGHT,
  PROJ_HALF_WIDTH,
  ROAD_WIDTH,
  SEGMENT_LENGTH,
  CAMERA_HEIGHT,
  DRAW_DISTANCE,
  FOG_DENSITY,
  PLAYER_Z,
  PLAYER_CENTER_OFFSET_Z,
  PLAYER_LEN_Z,
  PLAYER_WIDTH_NORM,
  HEADLIGHT_BEAM_DIST_Z,
  MAX_HARDCORE_COLLISIONS,
  WHEEL_TRACK_OFFSET,
  WHEEL_SKID_HALF_W
} from './config.js';
import { MathUtil } from './utils.js';
import { state, findSegment, getSunX } from './state.js';

// Базовое смещение опор арок от центра дороги (синхронизировано с хитбоксами в js/physics.js)
const ARCH_TOWER_OFFSET_NORM = 1.28;
// Коэффициент сохранения визуального размера придорожных спрайтов без искажения от динамического FOV
const SPRITE_SCALE_RATIO = 0.84;

// Безопасные ближние плоскости отсечения по Z (устраняют взрыв масштаба и 1-кадровые полосы-артефакты)
export const MIN_SAMPLE_CAM_Z = 24;
export const MIN_GUARDRAIL_CAM_Z = 80;
export const MIN_SPRITE_CAM_Z = 120;
export const MIN_CAR_CAM_Z = 160;

// Размеры кэшируемых offscreen-тайлов фона и спрайтов освещения
const MOUNTAIN_TILE_W = 480;
const MOUNTAIN_TILE_H = 104;
const CITY_TILE_W = 640;
const CITY_TILE_H = 104;
const SUN_RADIUS = 88;
const SUN_SPRITE_HALF = Math.ceil(SUN_RADIUS * 2.15);
const SUN_SPRITE_SIZE = SUN_SPRITE_HALF * 2;
const SKY_LUT_H = 256;
const HALO_SPRITE_SIZE = 64;

// Параметры мип-кэша надписей для щитов и арок (устраняют дрожание шрифта и ступенчатые скачки размера)
const SIGN_TEXT_BASE_H = 96;
const SIGN_TEXT_BASE_FONT_PX = 68;
const SIGN_TEXT_FONT_RATIO = SIGN_TEXT_BASE_FONT_PX / SIGN_TEXT_BASE_H;

// Постоянные массивы разметки и колей (без пересоздания в каждом сегменте)
const GROOVES_ONCOMING = Object.freeze([-0.66, -0.23, 0.23, 0.66]);
const GROOVES_CIRCUIT = Object.freeze([-0.45, 0.45]);
const GROOVES_ONEWAY = Object.freeze([-0.64, 0, 0.64]);
const LANES_ONCOMING = Object.freeze([-0.45, 0.45]);
const LANES_CIRCUIT = Object.freeze([0]);
const LANES_ONEWAY = Object.freeze([-0.33, 0.33]);
const WHEEL_SIDES = Object.freeze([-WHEEL_TRACK_OFFSET, WHEEL_TRACK_OFFSET]);

// Предрасчитанная тригонометрия кроны пальм (убирает ~1400 вызовов sin/cos за кадр)
const PALM_BASE_ANGLES = [-2.6, -1.9, -1.2, -0.5, 0.2, 0.7];
const PALM_FRONDS = Object.freeze(
  PALM_BASE_ANGLES.map((ang, idx) => Object.freeze({
    cos: Math.cos(ang),
    sin: Math.sin(ang),
    shCos: Math.cos(ang + 0.14),
    shSin: Math.sin(ang + 0.14),
    color: idx % 2 === 0 ? '#00f5d4' : '#00bbf9'
  }))
);

// Неизменяемые пресеты радиальных градиентов световых ореолов (используются как ключи WeakMap-кэша offscreen-спрайтов)
export const HALO_STOPS = Object.freeze({
  beaconStart: Object.freeze([
    Object.freeze([0.0, 'rgba(255, 248, 200, 0.82)']),
    Object.freeze([0.35, 'rgba(255, 190, 11, 0.45)']),
    Object.freeze([1.0, 'rgba(255, 190, 11, 0.0)'])
  ]),
  beaconCheckpoint: Object.freeze([
    Object.freeze([0.0, 'rgba(255, 220, 240, 0.82)']),
    Object.freeze([0.35, 'rgba(255, 42, 133, 0.48)']),
    Object.freeze([1.0, 'rgba(255, 42, 133, 0.0)'])
  ]),
  streetLamp: Object.freeze([
    Object.freeze([0.0, 'rgba(215, 252, 255, 0.72)']),
    Object.freeze([0.35, 'rgba(0, 240, 255, 0.34)']),
    Object.freeze([1.0, 'rgba(0, 240, 255, 0.0)'])
  ]),
  headlightPool: Object.freeze([
    Object.freeze([0.0, 'rgba(215, 250, 255, 0.20)']),
    Object.freeze([0.55, 'rgba(165, 238, 255, 0.08)']),
    Object.freeze([1.0, 'rgba(140, 225, 255, 0.0)'])
  ]),
  backfire: Object.freeze([
    Object.freeze([0.0, 'rgba(255, 252, 225, 0.96)']),
    Object.freeze([0.28, 'rgba(255, 165, 20, 0.78)']),
    Object.freeze([0.62, 'rgba(255, 72, 0, 0.34)']),
    Object.freeze([1.0, 'rgba(255, 45, 0, 0.0)'])
  ]),
  flameSlipstream: Object.freeze([
    Object.freeze([0.0, 'rgba(235, 255, 230, 0.95)']),
    Object.freeze([0.30, 'rgba(57, 255, 20, 0.72)']),
    Object.freeze([0.65, 'rgba(20, 210, 45, 0.28)']),
    Object.freeze([1.0, 'rgba(0, 180, 40, 0.0)'])
  ]),
  flameNormal: Object.freeze([
    Object.freeze([0.0, 'rgba(235, 253, 255, 0.95)']),
    Object.freeze([0.30, 'rgba(0, 240, 255, 0.72)']),
    Object.freeze([0.65, 'rgba(0, 150, 255, 0.26)']),
    Object.freeze([1.0, 'rgba(0, 110, 255, 0.0)'])
  ]),
  oncomingHighBeam: Object.freeze([
    Object.freeze([0.0, 'rgba(255, 255, 255, 0.95)']),
    Object.freeze([0.32, 'rgba(200, 250, 255, 0.62)']),
    Object.freeze([0.68, 'rgba(120, 235, 255, 0.22)']),
    Object.freeze([1.0, 'rgba(120, 235, 255, 0.0)'])
  ]),
  oncomingLowBeam: Object.freeze([
    Object.freeze([0.0, 'rgba(240, 252, 255, 0.72)']),
    Object.freeze([0.38, 'rgba(180, 242, 255, 0.34)']),
    Object.freeze([1.0, 'rgba(140, 225, 255, 0.0)'])
  ]),
  brakeLight: Object.freeze([
    Object.freeze([0.0, 'rgba(255, 195, 210, 0.82)']),
    Object.freeze([0.34, 'rgba(255, 42, 95, 0.50)']),
    Object.freeze([1.0, 'rgba(255, 20, 75, 0.0)'])
  ]),
  reverseLight: Object.freeze([
    Object.freeze([0.0, 'rgba(255, 255, 255, 0.90)']),
    Object.freeze([0.35, 'rgba(200, 245, 255, 0.48)']),
    Object.freeze([1.0, 'rgba(180, 240, 255, 0.0)'])
  ]),
  turnSignal: Object.freeze([
    Object.freeze([0.0, 'rgba(255, 250, 215, 0.95)']),
    Object.freeze([0.26, 'rgba(255, 195, 20, 0.62)']),
    Object.freeze([0.58, 'rgba(255, 115, 0, 0.24)']),
    Object.freeze([1.0, 'rgba(255, 90, 0, 0.0)'])
  ])
});

// Предрасчитанные кэши строк цветов для тумана, следов шин и колей асфальта (0 строковых аллокаций в кадре)
export const FOG_COLOR_CACHE = Object.freeze(
  Array.from({ length: 101 }, (_, i) => `rgba(26, 9, 52, ${(i / 100).toFixed(2)})`)
);
const SKID_COLOR_CACHE = Object.freeze(
  Array.from({ length: 101 }, (_, i) => `rgba(7, 5, 14, ${(i / 100).toFixed(2)})`)
);
const GROOVE_COLOR_CACHE = Object.freeze(
  Array.from({ length: 19 }, (_, i) => `rgba(9, 5, 22, ${(i / 100).toFixed(2)})`)
);

// Offscreen-кэши слоёв фона и источников света
let skyLutCanvas = null;
let sunSpriteCanvas = null;
let mountainTileCanvas = null;
let cityTileCanvas = null;

const haloWeakCache = new WeakMap();
const haloStringCache = new Map();
const signLabelCache = new Map();

// Переиспользуемые scratch-буферы для устранения аллокаций в расчёте света фар и геометрии арок
const HEADLIGHT_STEPS = 20;
const _hlSliceDz = new Float64Array(HEADLIGHT_STEPS + 1);
const _hlSliceScale = new Float64Array(HEADLIGHT_STEPS + 1);
const _hlSliceY = new Float64Array(HEADLIGHT_STEPS + 1);
const _hlLeftX = new Float64Array(HEADLIGHT_STEPS + 1);
const _hlRightX = new Float64Array(HEADLIGHT_STEPS + 1);
const _hlFrontSample = { camZ: 0, scale: 0, roadCenterX: 0, roadY: 0, clipY: LOGICAL_HEIGHT };
const _hlStepSample = { camZ: 0, scale: 0, roadCenterX: 0, roadY: 0, clipY: LOGICAL_HEIGHT };

const _archLayout = {
  archH: 0,
  towerW: 0,
  sideDepthW: 0,
  bannerH: 0,
  topY: 0,
  bannerBottomY: 0,
  leftTowerCenterX: 0,
  rightTowerCenterX: 0,
  leftOuterX: 0,
  leftInnerX: 0,
  rightInnerX: 0,
  rightOuterX: 0,
  accentColor: '',
  secondaryColor: '',
  darkFrameColor: '#120326',
  sideShadeColor: '#080114',
  lineW: 1.2
};

/**
 * Однократная генерация offscreen-текстур неба, ретро-солнца с ореолом, гор и неонового города.
 * Исключает ежекадровые createLinearGradient, createRadialGradient и круговой ctx.clip() солнца.
 */
function ensureBackgroundCaches() {
  if (skyLutCanvas && sunSpriteCanvas && mountainTileCanvas && cityTileCanvas) return;

  try {
    if (!skyLutCanvas) {
      const sc = document.createElement('canvas');
      sc.width = 2;
      sc.height = SKY_LUT_H;
      const sctx = sc.getContext('2d');
      if (sctx) {
        const skyGrad = sctx.createLinearGradient(0, 0, 0, SKY_LUT_H);
        skyGrad.addColorStop(0.0, '#070116');
        skyGrad.addColorStop(0.42, '#1d0642');
        skyGrad.addColorStop(0.76, '#691268');
        skyGrad.addColorStop(1.0, '#ff3b7f');
        sctx.fillStyle = skyGrad;
        sctx.fillRect(0, 0, 2, SKY_LUT_H);
      }
      skyLutCanvas = sc;
    }

    if (!sunSpriteCanvas) {
      const sunC = document.createElement('canvas');
      sunC.width = SUN_SPRITE_SIZE;
      sunC.height = SUN_SPRITE_SIZE;
      const uctx = sunC.getContext('2d');
      if (uctx) {
        const cx = SUN_SPRITE_HALF;
        const cy = SUN_SPRITE_HALF;
        const sunR = SUN_RADIUS;

        const glowGrad = uctx.createRadialGradient(cx, cy, sunR * 0.4, cx, cy, sunR * 2.1);
        glowGrad.addColorStop(0, 'rgba(255, 190, 11, 0.45)');
        glowGrad.addColorStop(0.5, 'rgba(255, 42, 133, 0.22)');
        glowGrad.addColorStop(1, 'rgba(255, 42, 133, 0)');
        uctx.fillStyle = glowGrad;
        uctx.beginPath();
        uctx.arc(cx, cy, sunR * 2.1, 0, Math.PI * 2);
        uctx.fill();

        // Вырезаем полосатый диск заката в отдельном буфере, чтобы не затереть мягкий внешний ореол
        const discC = document.createElement('canvas');
        discC.width = sunR * 2 + 4;
        discC.height = sunR * 2 + 4;
        const dctx = discC.getContext('2d');
        if (dctx) {
          const dcx = sunR + 2;
          const dcy = sunR + 2;
          dctx.beginPath();
          dctx.arc(dcx, dcy, sunR, 0, Math.PI * 2);
          dctx.clip();

          const sunGrad = dctx.createLinearGradient(0, dcy - sunR, 0, dcy + sunR);
          sunGrad.addColorStop(0, '#fff3b0');
          sunGrad.addColorStop(0.45, '#ffbe0b');
          sunGrad.addColorStop(1, '#ff2a85');
          dctx.fillStyle = sunGrad;
          dctx.fillRect(dcx - sunR, dcy - sunR, sunR * 2, sunR * 2);

          dctx.fillStyle = '#2d0845';
          for (let stripe = 0; stripe < 6; stripe++) {
            const sy = dcy + 10 + stripe * 13;
            const sh = 2 + stripe * 1.3;
            dctx.fillRect(dcx - sunR, sy, sunR * 2, sh);
          }

          uctx.drawImage(discC, cx - dcx, cy - dcy);
        }
      }
      sunSpriteCanvas = sunC;
    }

    if (!mountainTileCanvas) {
      const mc = document.createElement('canvas');
      mc.width = MOUNTAIN_TILE_W;
      mc.height = MOUNTAIN_TILE_H;
      const mctx = mc.getContext('2d');
      if (mctx) {
        const baseY = MOUNTAIN_TILE_H - 2;
        mctx.fillStyle = '#180636';
        mctx.beginPath();
        mctx.moveTo(0, baseY);
        mctx.lineTo(90, baseY - 64);
        mctx.lineTo(175, baseY - 30);
        mctx.lineTo(280, baseY - 86);
        mctx.lineTo(390, baseY - 36);
        mctx.lineTo(480, baseY);
        mctx.closePath();
        mctx.fill();

        mctx.strokeStyle = 'rgba(0, 240, 255, 0.35)';
        mctx.lineWidth = 1.5;
        mctx.stroke();
      }
      mountainTileCanvas = mc;
    }

    if (!cityTileCanvas) {
      const cc = document.createElement('canvas');
      cc.width = CITY_TILE_W;
      cc.height = CITY_TILE_H;
      const cctx = cc.getContext('2d');
      if (cctx) {
        const baseY = CITY_TILE_H - 2;
        const buildings = [
          { x: 10, w: 38, h: 46 }, { x: 54, w: 28, h: 68 }, { x: 88, w: 46, h: 36 },
          { x: 142, w: 34, h: 78 }, { x: 184, w: 50, h: 52 }, { x: 242, w: 30, h: 62 },
          { x: 280, w: 44, h: 40 }, { x: 332, w: 36, h: 84 }, { x: 376, w: 48, h: 48 },
          { x: 432, w: 32, h: 64 }, { x: 472, w: 46, h: 42 }, { x: 526, w: 38, h: 72 },
          { x: 572, w: 52, h: 44 }
        ];

        for (let i = 0; i < buildings.length; i++) {
          const b = buildings[i];
          const bx = b.x;
          const by = baseY - b.h;
          cctx.fillStyle = '#0d0322';
          cctx.fillRect(bx, by, b.w, b.h);

          cctx.fillStyle = (i % 2 === 0) ? 'rgba(0, 240, 255, 0.45)' : 'rgba(255, 190, 11, 0.45)';
          let row = 0;
          for (let wy = by + 6; wy < baseY - 8; wy += 9, row++) {
            let col = 0;
            for (let wx = bx + 5; wx < bx + b.w - 6; wx += 8, col++) {
              if ((row + col + i) % 3 !== 0) {
                cctx.fillRect(wx, wy, 3, 4);
              }
            }
          }
        }
      }
      cityTileCanvas = cc;
    }
  } catch (e) {
    skyLutCanvas = null;
    sunSpriteCanvas = null;
    mountainTileCanvas = null;
    cityTileCanvas = null;
  }
}

/**
 * Возвращает кэшированный offscreen-спрайт мягкого светового ореола (запекается 1 раз на пресет).
 * Заменяет десятки тяжёлых createRadialGradient() на быстрый аппаратный drawImage().
 */
function getLightHaloSprite(softStops) {
  if (!softStops || !softStops.length) return null;

  const fromWeak = haloWeakCache.get(softStops);
  if (fromWeak) return fromWeak;

  let key = '';
  for (let i = 0; i < softStops.length; i++) {
    key += `${softStops[i][0]}:${softStops[i][1]}|`;
  }
  const fromMap = haloStringCache.get(key);
  if (fromMap) {
    haloWeakCache.set(softStops, fromMap);
    return fromMap;
  }

  const size = HALO_SPRITE_SIZE;
  const half = size * 0.5;
  const off = document.createElement('canvas');
  off.width = size;
  off.height = size;
  const octx = off.getContext('2d');
  if (octx) {
    const grad = octx.createRadialGradient(half, half, half * 0.08, half, half, half);
    for (let i = 0; i < softStops.length; i++) {
      grad.addColorStop(softStops[i][0], softStops[i][1]);
    }
    octx.fillStyle = grad;
    octx.beginPath();
    octx.arc(half, half, half, 0, Math.PI * 2);
    octx.fill();
  }

  if (haloStringCache.size > 32) {
    haloStringCache.clear();
  }
  haloStringCache.set(key, off);
  haloWeakCache.set(softStops, off);
  return off;
}

/**
 * Однократно запекает надпись дорожного баннера/арки в цепочку из 5 мип-уровней (96 -> 48 -> 24 -> 12 -> 6 px).
 * Исключает ежекадровую растеризацию шрифта на CPU и квантование глифов fillText при масштабировании в 3D.
 */
function getSignLabelMipEntry(key, text, color) {
  const cached = signLabelCache.get(key);
  if (cached) return cached;

  try {
    const baseCanvas = document.createElement('canvas');
    baseCanvas.width = 32;
    baseCanvas.height = 32;
    const bctx = baseCanvas.getContext('2d');
    if (!bctx) return null;

    const fontSpec = `900 ${SIGN_TEXT_BASE_FONT_PX}px sans-serif`;
    bctx.font = fontSpec;
    const rawW = Math.max(64, Math.ceil(bctx.measureText(text).width + 36));
    // Кратность 16 гарантирует точное целочисленное деление пополам на всех 5 мип-уровнях без искажения пропорций
    const baseW = Math.ceil(rawW / 16) * 16;

    baseCanvas.width = baseW;
    baseCanvas.height = SIGN_TEXT_BASE_H;
    bctx.font = fontSpec;
    bctx.textAlign = 'center';
    bctx.textBaseline = 'middle';
    bctx.fillStyle = color;
    bctx.fillText(text, baseW * 0.5, SIGN_TEXT_BASE_H * 0.53);

    const levels = [baseCanvas];
    let prevCanvas = baseCanvas;
    let mw = baseW;
    let mh = SIGN_TEXT_BASE_H;

    for (let m = 1; m <= 4; m++) {
      mw >>= 1;
      mh >>= 1;
      const mipCanvas = document.createElement('canvas');
      mipCanvas.width = mw;
      mipCanvas.height = mh;
      const mctx = mipCanvas.getContext('2d');
      if (mctx) {
        mctx.imageSmoothingEnabled = true;
        if ('imageSmoothingQuality' in mctx) {
          mctx.imageSmoothingQuality = 'high';
        }
        mctx.drawImage(prevCanvas, 0, 0, mw, mh);
      }
      levels.push(mipCanvas);
      prevCanvas = mipCanvas;
    }

    const entry = { levels, aspect: baseW / SIGN_TEXT_BASE_H };
    signLabelCache.set(key, entry);
    return entry;
  } catch (e) {
    return null;
  }
}

/**
 * Субпиксельная отрисовка текста на 3D-объектах мира (арках и рекламных щитах) через мип-спрайт.
 * Плавная float-интерполяция drawImage убирает рывки от Math.floor(fontSize) и хинтинга глифов.
 */
function drawWorldSignText(ctx, key, text, color, centerX, centerY, targetFontPx, maxWidth, alpha = 1) {
  if (alpha <= 0.01 || targetFontPx < 0.9 || maxWidth <= 2) return;

  const entry = getSignLabelMipEntry(key, text, color);
  if (!entry) return;

  let drawH = targetFontPx / SIGN_TEXT_FONT_RATIO;
  let drawW = drawH * entry.aspect;

  if (drawW > maxWidth) {
    const fitScale = maxWidth / drawW;
    drawW = maxWidth;
    drawH *= fitScale;
  }
  if (drawH < 1.0) return;

  // На порогах 48/24/12/6 px билинейная выборка 0.5x предыдущего уровня совпадает с 1.0x следующего (бесшовный переход)
  const levels = entry.levels;
  let mip = levels[0];
  if (drawH < 6) mip = levels[4];
  else if (drawH < 12) mip = levels[3];
  else if (drawH < 24) mip = levels[2];
  else if (drawH < 48) mip = levels[1];

  const prevAlpha = ctx.globalAlpha;
  if (alpha < 0.999) {
    ctx.globalAlpha = prevAlpha * alpha;
  }
  ctx.drawImage(mip, centerX - drawW * 0.5, centerY - drawH * 0.5, drawW, drawH);
  ctx.globalAlpha = prevAlpha;
}

/**
 * Перспективная проекция мировой точки в экранные координаты
 */
export function project(p, cameraX, cameraY, cameraZ, cameraDepth, width, height, roadWidth, pitchOffset = 0) {
  p.camera.x = (p.world.x || 0) - cameraX;
  p.camera.y = (p.world.y || 0) - cameraY;
  p.camera.z = (p.world.z || 0) - cameraZ;
  p.screen.scale = cameraDepth / Math.max(1, p.camera.z);
  p.screen.x = (width * 0.5) + (p.screen.scale * p.camera.x * PROJ_HALF_WIDTH);
  p.screen.y = (height * 0.5) + pitchOffset - (p.screen.scale * p.camera.y * height * 0.5);
  p.screen.w = p.screen.scale * roadWidth * PROJ_HALF_WIDTH;
}

/**
 * Вычисляет экранное положение оси дороги в произвольной продольной координате worldZ.
 * Поддерживает передачу выходного объекта out для работы с нулевыми аллокациями в горячем цикле.
 */
export function sampleRoadAtZ(worldZ, out = null) {
  const seg = findSegment(worldZ);
  if (!seg || seg.projectedFrame !== state.frameCounter) return null;

  const wrappedZ = ((worldZ % state.trackLength) + state.trackLength) % state.trackLength;
  const t = MathUtil.percentRemaining(wrappedZ, SEGMENT_LENGTH);

  const camX = MathUtil.lerp(seg.p1.camera.x, seg.p2.camera.x, t);
  const camY = MathUtil.lerp(seg.p1.camera.y, seg.p2.camera.y, t);
  const camZ = MathUtil.lerp(seg.p1.camera.z, seg.p2.camera.z, t);
  if (camZ <= MIN_SAMPLE_CAM_Z) return null;

  const scale = state.activeCameraDepth / camZ;
  const target = out || { camZ: 0, scale: 0, roadCenterX: 0, roadY: 0, clipY: LOGICAL_HEIGHT };
  target.camZ = camZ;
  target.scale = scale;
  target.roadCenterX = (state.logicalWidth * 0.5) + scale * camX * PROJ_HALF_WIDTH;
  target.roadY = (LOGICAL_HEIGHT * 0.5) + state.cameraPitch - scale * camY * (LOGICAL_HEIGHT * 0.5);
  target.clipY = seg.clip;
  return target;
}

/**
 * Применяет отсечение по гребню рельефа (clipY) с запасом сверху на случай крена камеры
 */
export function beginHorizonClip(ctx, clipY) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(-48, -64, state.logicalWidth + 96, Math.max(0, clipY + 64));
  ctx.clip();
}

export function renderPolygon(ctx, x1, y1, x2, y2, x3, y3, x4, y4, color) {
  const by1 = y1 + 0.55;
  const by2 = y2 + 0.55;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x1, by1);
  ctx.lineTo(x2, by2);
  ctx.lineTo(x3, y3);
  ctx.lineTo(x4, y4);
  ctx.closePath();
  ctx.fill();
}

export function fillQuad(ctx, x1, y1, x2, y2, x3, y3, x4, y4, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.lineTo(x3, y3);
  ctx.lineTo(x4, y4);
  ctx.closePath();
  ctx.fill();
}

/**
 * Отрисовка четырёхугольника со скруглёнными углами в перспективе (для мягкой тени автомобилей)
 */
export function fillRoundedQuad(ctx, x1, y1, x2, y2, x3, y3, x4, y4, roundFrac, color) {
  const r = MathUtil.clamp(roundFrac, 0, 0.48);
  const inv = 1 - r;

  const ax1 = x1 * inv + x2 * r;
  const ay1 = y1 * inv + y2 * r;
  const bx1 = x1 * r + x2 * inv;
  const by1 = y1 * r + y2 * inv;

  const ax2 = x2 * inv + x3 * r;
  const ay2 = y2 * inv + y3 * r;
  const bx2 = x2 * r + x3 * inv;
  const by2 = y2 * r + y3 * inv;

  const ax3 = x3 * inv + x4 * r;
  const ay3 = y3 * inv + y4 * r;
  const bx3 = x3 * r + x4 * inv;
  const by3 = y3 * r + y4 * inv;

  const ax4 = x4 * inv + x1 * r;
  const ay4 = y4 * inv + y1 * r;
  const bx4 = x4 * r + x1 * inv;
  const by4 = y4 * r + y1 * inv;

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(ax1, ay1);
  ctx.lineTo(bx1, by1);
  ctx.quadraticCurveTo(x2, y2, ax2, ay2);
  ctx.lineTo(bx2, by2);
  ctx.quadraticCurveTo(x3, y3, ax3, ay3);
  ctx.lineTo(bx3, by3);
  ctx.quadraticCurveTo(x4, y4, ax4, ay4);
  ctx.lineTo(bx4, by4);
  ctx.quadraticCurveTo(x1, y1, ax1, ay1);
  ctx.closePath();
  ctx.fill();
}

/**
 * Отрисовка ореола источника света без накладных расходов ctx.save()/restore() и без создания градиентов
 */
export function drawLightHalo(ctx, x, y, hardRadius, hardColor, softRadius, softStops, alphaScale = 1) {
  const clampedAlpha = MathUtil.clamp(alphaScale, 0, 1);
  if (clampedAlpha <= 0.01) return;

  const prevAlpha = ctx.globalAlpha;
  ctx.globalAlpha = prevAlpha * clampedAlpha;

  if (state.settings.lightStyle === 'soft') {
    const r = Math.max(2, softRadius);
    const sprite = getLightHaloSprite(softStops);
    if (sprite) {
      const prevComp = ctx.globalCompositeOperation;
      if (prevComp !== 'screen') ctx.globalCompositeOperation = 'screen';
      ctx.drawImage(sprite, x - r, y - r, r * 2, r * 2);
      if (prevComp !== 'screen') ctx.globalCompositeOperation = prevComp;
      ctx.globalAlpha = prevAlpha;
      return;
    }
  }

  ctx.fillStyle = hardColor;
  ctx.beginPath();
  ctx.arc(x, y, hardRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = prevAlpha;
}

/**
 * Отрисовка неба, звёзд, ретро-солнца и параллакс-слоёв гор и ночного города
 */
export function renderBackground(ctx) {
  ensureBackgroundCaches();

  const LOGICAL_WIDTH = state.logicalWidth;
  const horizonY = LOGICAL_HEIGHT * 0.50 + state.cameraPitch;

  if (skyLutCanvas) {
    ctx.drawImage(skyLutCanvas, -48, -64, LOGICAL_WIDTH + 96, Math.max(16, horizonY + 70));
  } else {
    ctx.fillStyle = '#1d0642';
    ctx.fillRect(-48, -64, LOGICAL_WIDTH + 96, Math.max(16, horizonY + 70));
  }

  const now = state.animClockMs * 0.002;
  const starSpanY = Math.max(40, horizonY);
  const prevAlpha = ctx.globalAlpha;
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < state.stars.length; i++) {
    const s = state.stars[i];
    const sx = (((s.x - state.skyOffset * 0.5) % 1) + 1) % 1 * LOGICAL_WIDTH;
    const sy = s.y * starSpanY;
    ctx.globalAlpha = 0.45 + 0.55 * Math.sin(now + s.phase);
    ctx.fillRect(sx, sy, s.r * 1.6, s.r * 1.6);
  }
  ctx.globalAlpha = prevAlpha;

  const sunX = getSunX();
  const sunY = horizonY - 26;
  if (sunSpriteCanvas) {
    ctx.drawImage(sunSpriteCanvas, sunX - SUN_SPRITE_HALF, sunY - SUN_SPRITE_HALF);
  }

  // Параллакс гор из кэшированного тайла
  const mShift = (((state.hillOffset * MOUNTAIN_TILE_W) % MOUNTAIN_TILE_W) + MOUNTAIN_TILE_W) % MOUNTAIN_TILE_W;
  const mountainTopY = horizonY - MOUNTAIN_TILE_H + 4;
  if (mountainTileCanvas) {
    for (let x = -mShift - MOUNTAIN_TILE_W; x < LOGICAL_WIDTH + MOUNTAIN_TILE_W; x += MOUNTAIN_TILE_W) {
      ctx.drawImage(mountainTileCanvas, x, mountainTopY);
    }
  }

  // Параллакс неонового города из кэшированного тайла
  const cShift = (((state.cityOffset * CITY_TILE_W) % CITY_TILE_W) + CITY_TILE_W) % CITY_TILE_W;
  const cityTopY = horizonY - CITY_TILE_H + 4;
  if (cityTileCanvas) {
    for (let baseX = -cShift - CITY_TILE_W; baseX < LOGICAL_WIDTH + CITY_TILE_W; baseX += CITY_TILE_W) {
      ctx.drawImage(cityTileCanvas, baseX, cityTopY);
    }
  }

  ctx.fillStyle = '#100624';
  ctx.fillRect(-48, horizonY, LOGICAL_WIDTH + 96, LOGICAL_HEIGHT - horizonY + 84);
}

/**
 * Отрисовка одного сегмента дорожного полотна с дистанционным LOD и отсечением лишней заливки травы под асфальтом
 */
export function renderSegment(ctx, seg, distIndex = 0, fogAlpha = 0) {
  const LOGICAL_WIDTH = state.logicalWidth;
  const x1 = seg.p1.screen.x;
  const y1 = seg.p1.screen.y;
  const w1 = seg.p1.screen.w;
  const x2 = seg.p2.screen.x;
  const y2 = seg.p2.screen.y;
  const w2 = seg.p2.screen.w;
  const sliceH = y1 - y2;

  // Заливаем траву только слева и справа от асфальта (убирает двойную перерисовку нижней половины экрана на мобильных GPU)
  const leftRoadInner = Math.max(x1 - w1, x2 - w2);
  const rightRoadInner = Math.min(x1 + w1, x2 + w2);
  ctx.fillStyle = seg.color.grass;
  if (leftRoadInner < rightRoadInner) {
    if (leftRoadInner + 1 > -48) {
      ctx.fillRect(-48, y2 - 0.5, leftRoadInner + 49, sliceH + 0.55);
    }
    if (rightRoadInner - 1 < LOGICAL_WIDTH + 48) {
      ctx.fillRect(rightRoadInner - 1, y2 - 0.5, (LOGICAL_WIDTH + 49) - rightRoadInner, sliceH + 0.55);
    }
  } else {
    ctx.fillRect(-48, y2 - 0.5, LOGICAL_WIDTH + 96, sliceH + 0.55);
  }

  const r1 = w1 * 0.15;
  const r2 = w2 * 0.15;
  const curbLift1 = w1 * 0.015;
  const curbLift2 = w2 * 0.015;

  renderPolygon(
    ctx,
    x1 - w1 - r1, y1 - curbLift1 * 0.4,
    x1 - w1, y1 - curbLift1,
    x2 - w2, y2 - curbLift2,
    x2 - w2 - r2, y2 - curbLift2 * 0.4,
    seg.color.rumble
  );
  renderPolygon(
    ctx,
    x1 + w1, y1 - curbLift1,
    x1 + w1 + r1, y1 - curbLift1 * 0.4,
    x2 + w2 + r2, y2 - curbLift2 * 0.4,
    x2 + w2, y2 - curbLift2,
    seg.color.rumble
  );

  // LOD 3D-ступеньки поребрика: рисуем только на ближней/средней дистанции, где её толщина > 1.3 px
  if (curbLift1 > 1.3 && distIndex < 90) {
    renderPolygon(ctx, x1 - w1, y1, x1 - w1, y1 - curbLift1, x2 - w2, y2 - curbLift2, x2 - w2, y2, '#180933');
    renderPolygon(ctx, x1 + w1, y1 - curbLift1, x1 + w1, y1, x2 + w2, y2, x2 + w2, y2 - curbLift2, '#180933');
  }

  renderPolygon(ctx, x1 - w1, y1, x1 + w1, y1, x2 + w2, y2, x2 - w2, y2, seg.color.road);

  // LOD накатанной колеи: плавно сводим прозрачность к нулю на сегментах 60..95, экономя ~700 полупрозрачных полигонов/кадр
  if (distIndex < 95 && sliceH >= 0.7) {
    const grooveFade = distIndex <= 60 ? 1 : (95 - distIndex) / 35;
    const grooveAlphaIdx = Math.round(18 * grooveFade);
    if (grooveAlphaIdx > 0) {
      const grooveColor = GROOVE_COLOR_CACHE[grooveAlphaIdx];
      const grooveCenters = state.gameMode === 'oncoming'
        ? GROOVES_ONCOMING
        : (state.gameMode === 'circuit' ? GROOVES_CIRCUIT : GROOVES_ONEWAY);
      const gw1 = w1 * 0.13;
      const gw2 = w2 * 0.13;
      for (let g = 0; g < grooveCenters.length; g++) {
        const gc = grooveCenters[g];
        renderPolygon(
          ctx,
          x1 + w1 * gc - gw1, y1,
          x1 + w1 * gc + gw1, y1,
          x2 + w2 * gc + gw2, y2,
          x2 + w2 * gc - gw2, y2,
          grooveColor
        );
      }
    }
  }

  // Боковые краевые линии рисуются, пока их экранная ширина различима (> 0.45 px)
  if (w1 >= 18) {
    const edgeW1 = w1 * 0.026;
    const edgeW2 = w2 * 0.026;
    renderPolygon(ctx, x1 - w1, y1, x1 - w1 + edgeW1, y1, x2 - w2 + edgeW2, y2, x2 - w2, y2, seg.color.edge);
    renderPolygon(ctx, x1 + w1 - edgeW1, y1, x1 + w1, y1, x2 + w2, y2, x2 + w2 - edgeW2, y2, seg.color.edge);
  }

  if (state.gameMode === 'oncoming') {
    const divW1 = w1 * 0.017;
    const divW2 = w2 * 0.017;
    const divGap1 = w1 * 0.032;
    const divGap2 = w2 * 0.032;
    renderPolygon(ctx, x1 - divGap1 - divW1, y1, x1 - divGap1 + divW1, y1, x2 - divGap2 + divW2, y2, x2 - divGap2 - divW2, y2, '#ffbe0b');
    renderPolygon(ctx, x1 + divGap1 - divW1, y1, x1 + divGap1 + divW1, y1, x2 + divGap2 + divW2, y2, x2 + divGap2 - divW2, y2, '#ffbe0b');

    if (seg.color.lane && w1 >= 16) {
      const lw1 = w1 * 0.018;
      const lw2 = w2 * 0.018;
      for (let i = 0; i < LANES_ONCOMING.length; i++) {
        const laneNorm = LANES_ONCOMING[i];
        const lx1 = x1 + w1 * laneNorm;
        const lx2 = x2 + w2 * laneNorm;
        renderPolygon(ctx, lx1 - lw1, y1, lx1 + lw1, y1, lx2 + lw2, y2, lx2 - lw2, y2, seg.color.lane);
      }
    }
  } else if (seg.color.lane && w1 >= 16) {
    const lw1 = w1 * 0.020;
    const lw2 = w2 * 0.020;
    const lanesNorm = state.gameMode === 'circuit' ? LANES_CIRCUIT : LANES_ONEWAY;
    for (let i = 0; i < lanesNorm.length; i++) {
      const laneNorm = lanesNorm[i];
      const lx1 = x1 + w1 * laneNorm;
      const lx2 = x2 + w2 * laneNorm;
      renderPolygon(ctx, lx1 - lw1, y1, lx1 + lw1, y1, lx2 + lw2, y2, lx2 - lw2, y2, seg.color.lane);
    }
  }

  // Линия старта/финиша с дистанционным упрощением шахматной сетки вдали
  if (seg.isStartFinish) {
    if (w1 >= 48) {
      const cols = 12;
      const midY = (y1 + y2) * 0.5;
      const midX = (x1 + x2) * 0.5;
      const midW = (w1 + w2) * 0.5;
      for (let c = 0; c < cols; c++) {
        const f1 = -1 + (2 * c) / cols;
        const f2 = -1 + (2 * (c + 1)) / cols;
        const isWhite = c % 2 === 0;
        renderPolygon(ctx, x1 + w1 * f1, y1, x1 + w1 * f2, y1, midX + midW * f2, midY, midX + midW * f1, midY, isWhite ? '#ffffff' : '#090314');
        renderPolygon(ctx, midX + midW * f1, midY, midX + midW * f2, midY, x2 + w2 * f2, y2, x2 + w2 * f1, y2, isWhite ? '#090314' : '#ffffff');
      }
    } else {
      const cols = 6;
      for (let c = 0; c < cols; c++) {
        const f1 = -1 + (2 * c) / cols;
        const f2 = -1 + (2 * (c + 1)) / cols;
        renderPolygon(ctx, x1 + w1 * f1, y1, x1 + w1 * f2, y1, x2 + w2 * f2, y2, x2 + w2 * f1, y2, c % 2 === 0 ? '#ffffff' : '#090314');
      }
    }
  }

  if (seg.isCheckpoint) {
    renderPolygon(ctx, x1 - w1, y1, x1 + w1, y1, x2 + w2, y2, x2 - w2, y2, '#ffbe0b');
  }

  // Следы шин рисуются на дистанциях, где их ширина превышает ~0.5 px
  if (distIndex < 120 && w1 >= 22 && seg.skidMarks && seg.skidMarks.length > 0) {
    for (let i = 0; i < seg.skidMarks.length; i++) {
      const sm = seg.skidMarks[i];
      const sx1 = MathUtil.lerp(x1, x2, sm.t1);
      const sy1 = MathUtil.lerp(y1, y2, sm.t1);
      const sw1 = MathUtil.lerp(w1, w2, sm.t1);

      const sx2 = MathUtil.lerp(x1, x2, sm.t2);
      const sy2 = MathUtil.lerp(y1, y2, sm.t2);
      const sw2 = MathUtil.lerp(w1, w2, sm.t2);

      const hw1 = sw1 * WHEEL_SKID_HALF_W;
      const hw2 = sw2 * WHEEL_SKID_HALF_W;
      const alphaIdx = MathUtil.clamp(Math.round(sm.alpha * 100), 0, 100);
      const trackColor = sm.color || SKID_COLOR_CACHE[alphaIdx];

      for (let w = 0; w < 2; w++) {
        const wheelSide = WHEEL_SIDES[w];
        const cx1 = sx1 + sw1 * (sm.x1 + wheelSide);
        const cx2 = sx2 + sw2 * (sm.x2 + wheelSide);
        renderPolygon(ctx, cx1 - hw1, sy1, cx1 + hw1, sy1, cx2 + hw2, sy2, cx2 - hw2, sy2, trackColor);
      }
    }
  }

  // Дымка горизонта накладывается строго в пределах высоты сегмента
  if (fogAlpha > 0.01 && sliceH > 0.05) {
    const fogIdx = MathUtil.clamp(Math.round(fogAlpha * 100), 1, 100);
    ctx.fillStyle = FOG_COLOR_CACHE[fogIdx];
    ctx.fillRect(-48, y2, LOGICAL_WIDTH + 96, sliceH);
  }
}

/**
 * Отрисовка световых конусов фар автомобиля игрока на дорожном полотне (с 0 аллокаций массивов и точек)
 */
export function renderRoadHeadlights(ctx) {
  const LOGICAL_WIDTH = state.logicalWidth;
  const isTotalWreck = state.gameMode !== 'circuit' && state.visualDamage >= MAX_HARDCORE_COLLISIONS;
  if (isTotalWreck || (state.gameState !== STATE.PLAYING && state.gameState !== STATE.TITLE)) return;

  const hasDamageSystem = state.gameMode !== 'circuit';
  const flickerPhase = Math.floor(state.animClockMs / 95);
  const rightBroken = hasDamageSystem && (state.frontDamage >= 3 || state.rightDamage >= 3 || state.visualDamage >= 4);
  const leftBroken = hasDamageSystem && state.leftDamage >= 3;
  const leftFlicker = !leftBroken && hasDamageSystem && (state.frontDamage >= 2 || state.leftDamage >= 2 || state.visualDamage >= 4) && (flickerPhase % 4 === 0);
  const rightFlicker = !rightBroken && hasDamageSystem && (state.frontDamage >= 1 || state.rightDamage >= 2) && (flickerPhase % 5 === 2);
  if ((leftBroken || leftFlicker) && (rightBroken || rightFlicker)) return;

  const halfLen = PLAYER_LEN_Z * 0.5;
  const frontBumperCamZ = PLAYER_Z + PLAYER_CENTER_OFFSET_Z + halfLen;
  const playerYaw = MathUtil.clamp(state.steerVisual * 0.22 + state.playerVX * 0.14, -0.34, 0.34);
  const yawSlope = Math.tan(playerYaw);

  let frontSample = sampleRoadAtZ(state.position + frontBumperCamZ, _hlFrontSample);
  if (!frontSample) {
    const effectiveCamX = (state.playerX - state.cameraLagX) * ROAD_WIDTH;
    const scale = state.activeCameraDepth / frontBumperCamZ;
    _hlFrontSample.camZ = frontBumperCamZ;
    _hlFrontSample.scale = scale;
    _hlFrontSample.roadCenterX = (LOGICAL_WIDTH * 0.5) + scale * (-effectiveCamX) * PROJ_HALF_WIDTH;
    _hlFrontSample.roadY = (LOGICAL_HEIGHT * 0.5) + state.cameraPitch - scale * (-CAMERA_HEIGHT) * (LOGICAL_HEIGHT * 0.5);
    _hlFrontSample.clipY = LOGICAL_HEIGHT;
    frontSample = _hlFrontSample;
  }
  if (frontSample.scale <= 0) return;

  const frontWorldX = state.playerX * ROAD_WIDTH + halfLen * yawSlope;
  const frontCenterScreenX = frontSample.roadCenterX + frontSample.scale * frontWorldX * PROJ_HALF_WIDTH;
  const bumperRelCamX = (frontCenterScreenX - LOGICAL_WIDTH * 0.5) / (frontSample.scale * PROJ_HALF_WIDTH);

  let sliceCount = 0;
  let minYSoFar = Infinity;

  for (let i = 0; i <= HEADLIGHT_STEPS; i++) {
    const dZ = (i / HEADLIGHT_STEPS) * HEADLIGHT_BEAM_DIST_Z;
    const camZ = frontBumperCamZ + dZ;
    const s = i === 0 ? frontSample : sampleRoadAtZ(state.position + camZ, _hlStepSample);
    if (!s || s.scale <= 0) break;
    // Прерываем луч за гребнем холма, чтобы свет фар не просвечивал сквозь рельеф
    if (i > 0 && (s.roadY >= minYSoFar - 0.2 || s.roadY > s.clipY + 1)) break;
    minYSoFar = s.roadY;
    _hlSliceDz[sliceCount] = dZ;
    _hlSliceScale[sliceCount] = s.scale;
    _hlSliceY[sliceCount] = s.roadY;
    sliceCount++;
  }

  if (sliceCount < 2) return;
  const nearY = _hlSliceY[0];
  const farY = _hlSliceY[sliceCount - 1];
  if (nearY <= farY + 4) return;

  const carHalfWWorld = PLAYER_WIDTH_NORM * ROAD_WIDTH * 0.5;
  const lampLateralWorld = carHalfWWorld * 0.68;
  const lampStartHalfW = carHalfWWorld * 0.17;
  const isSoftLight = state.settings.lightStyle === 'soft';

  ctx.save();
  ctx.globalCompositeOperation = 'screen';

  const drawBeamPolygon = (sideSign, startWidthMult, spreadMult, a0, a1, a2) => {
    for (let i = 0; i < sliceCount; i++) {
      const dZ = _hlSliceDz[i];
      const scale = _hlSliceScale[i];
      const rayCenterRelCamX = bumperRelCamX + dZ * yawSlope + sideSign * lampLateralWorld;
      const halfWWorld = lampStartHalfW * startWidthMult + dZ * 0.082 * spreadMult;

      _hlLeftX[i] = (LOGICAL_WIDTH * 0.5) + scale * (rayCenterRelCamX - halfWWorld) * PROJ_HALF_WIDTH;
      _hlRightX[i] = (LOGICAL_WIDTH * 0.5) + scale * (rayCenterRelCamX + halfWWorld) * PROJ_HALF_WIDTH;
    }

    const grad = ctx.createLinearGradient(0, nearY, 0, farY);
    grad.addColorStop(0.0, `rgba(210, 248, 255, ${a0})`);
    grad.addColorStop(0.32, `rgba(175, 240, 255, ${a1})`);
    grad.addColorStop(0.72, `rgba(140, 225, 255, ${a2})`);
    grad.addColorStop(1.0, 'rgba(140, 225, 255, 0.0)');

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(_hlLeftX[0], _hlSliceY[0]);
    for (let i = 1; i < sliceCount; i++) {
      ctx.lineTo(_hlLeftX[i], _hlSliceY[i]);
    }
    for (let i = sliceCount - 1; i >= 0; i--) {
      ctx.lineTo(_hlRightX[i], _hlSliceY[i]);
    }
    ctx.closePath();
    ctx.fill();
  };

  const drawSingleHeadlight = (sideSign) => {
    if (isSoftLight) {
      drawBeamPolygon(sideSign, 1.55, 1.65, 0.055, 0.028, 0.008);
      drawBeamPolygon(sideSign, 1.25, 1.28, 0.068, 0.036, 0.010);
      drawBeamPolygon(sideSign, 0.96, 0.94, 0.080, 0.042, 0.011);
      drawBeamPolygon(sideSign, 0.65, 0.56, 0.085, 0.038, 0.007);

      const scale0 = _hlSliceScale[0];
      const poolX = (LOGICAL_WIDTH * 0.5) + scale0 * (bumperRelCamX + sideSign * lampLateralWorld) * PROJ_HALF_WIDTH;
      const poolR = Math.max(12, scale0 * carHalfWWorld * 1.05 * PROJ_HALF_WIDTH);
      const poolSprite = getLightHaloSprite(HALO_STOPS.headlightPool);
      if (poolSprite) {
        ctx.drawImage(poolSprite, poolX - poolR, (_hlSliceY[0] - poolR * 0.18) - poolR * 0.42, poolR * 2, poolR * 0.84);
      }
    } else {
      drawBeamPolygon(sideSign, 1.0, 1.0, 0.25, 0.12, 0.035);
    }
  };

  if (!leftBroken && !leftFlicker) drawSingleHeadlight(-1);
  if (!rightBroken && !rightFlicker) drawSingleHeadlight(1);
  ctx.restore();
}

/**
 * Отрисовка 3D-отбойников в кольцевом режиме.
 * Устранено ложное отсечение (y2 >= y1) на перегибах холмов: вертикальные балки корректно возвышаются
 * из-за гребня рельефа с точным отсечением по seg.clip, плавным скосом высоты на краях и фейдом у горизонта.
 */
export function renderGuardrail(ctx, seg, distRatio = 0, drawShadow = true) {
  if (!seg.guardrailLeft && !seg.guardrailRight) return;

  // Плавное проявление отбойников из дымки горизонта на дальних 20% DRAW_DISTANCE
  const horizonFade = distRatio > 0.80 ? MathUtil.clamp((1 - distRatio) / 0.20, 0, 1) : 1;
  if (horizonFade <= 0.01) return;

  const LOGICAL_WIDTH = state.logicalWidth;
  const x1 = seg.p1.screen.x;
  const y1 = seg.p1.screen.y;
  const w1 = seg.p1.screen.w;
  const x2 = seg.p2.screen.x;
  const y2 = seg.p2.screen.y;
  const w2 = seg.p2.screen.w;

  if (w1 < 1.2 || w2 <= 0.5) return;

  const segments = state.segments;
  const totalSegs = segments.length;
  const prevSeg = totalSegs > 0 ? segments[(seg.index - 1 + totalSegs) % totalSegs] : null;
  const nextSeg = totalSegs > 0 ? segments[(seg.index + 1) % totalSegs] : null;
  const clipY = seg.clip;
  const hasClipLimit = clipY !== null && clipY !== undefined;

  const isReflectorSeg = seg.index % 2 === 0;
  const railTopColor = isReflectorSeg ? '#ffe066' : '#f8fafc';
  const railColor = isReflectorSeg ? '#ffbe0b' : '#cbd5e1';
  const railLowerColor = isReflectorSeg ? '#ff2a85' : '#64748b';

  const prevAlpha = ctx.globalAlpha;
  if (horizonFade < 0.999) {
    ctx.globalAlpha = prevAlpha * horizonFade;
  }

  for (let sideIdx = 0; sideIdx < 2; sideIdx++) {
    const dir = sideIdx === 0 ? -1 : 1;
    const isLeft = dir < 0;
    if (isLeft ? !seg.guardrailLeft : !seg.guardrailRight) continue;

    const gx1 = x1 + dir * w1 * 1.15;
    const gx2 = x2 + dir * w2 * 1.15;
    const gxOuter1 = x1 + dir * w1 * 1.195;
    const gxOuter2 = x2 + dir * w2 * 1.195;

    const maxX = Math.max(gx1, gx2, gxOuter1, gxOuter2);
    const minX = Math.min(gx1, gx2, gxOuter1, gxOuter2);
    if (maxX < -48 || minX > LOGICAL_WIDTH + 48) continue;

    // Согласованные коэффициенты высоты на стыках p1 и p2 дают бесшовный наклонный скос на концах барьера
    const currScale = (isLeft ? seg.guardrailLeftScale : seg.guardrailRightScale) || 1;
    const prevHas = prevSeg ? (isLeft ? prevSeg.guardrailLeft : prevSeg.guardrailRight) : true;
    const nextHas = nextSeg ? (isLeft ? nextSeg.guardrailLeft : nextSeg.guardrailRight) : true;
    const prevScale = prevHas ? ((isLeft ? prevSeg.guardrailLeftScale : prevSeg.guardrailRightScale) || 1) : 0;
    const nextScale = nextHas ? ((isLeft ? nextSeg.guardrailLeftScale : nextSeg.guardrailRightScale) || 1) : 0;

    const scale1 = prevHas ? (prevScale + currScale) * 0.5 : 0.18;
    const scale2 = nextHas ? (currScale + nextScale) * 0.5 : 0.18;

    const h1 = Math.max(1.5, w1 * 0.21) * scale1;
    const h2 = Math.max(1.2, w2 * 0.21) * scale2;
    const beamTop1 = y1 - h1;
    const beamBot1 = y1 - h1 * 0.42;
    const beamTop2 = y2 - h2;
    const beamBot2 = y2 - h2 * 0.42;

    const minTopY = Math.min(beamTop1, beamTop2);
    const maxBotY = Math.max(y1, y2);

    // Если даже верхняя кромка барьера ниже гребня ближнего холма — отбойник полностью скрыт
    if (hasClipLimit && minTopY >= clipY - 0.2) continue;

    // Включаем stencil/rect clip ТОЛЬКО когда секция реально пересекает линию горизонта рельефа
    const needsClip = hasClipLimit && maxBotY > clipY + 0.5;
    if (needsClip) {
      beginHorizonClip(ctx, clipY);
    }

    // Тень на обочине рисуется только на видимом склоне полотна (y1 > y2) и вблизи/на средней дистанции
    if (drawShadow && y1 > y2 + 0.3 && w1 >= 10) {
      renderPolygon(
        ctx,
        gx1 - dir * w1 * 0.03, y1,
        gxOuter1, y1,
        gxOuter2, y2,
        gx2 - dir * w2 * 0.03, y2,
        'rgba(6, 2, 16, 0.45)'
      );
    }

    if (w1 >= 8) {
      const postW = Math.max(1.8, w1 * 0.034);
      ctx.fillStyle = '#334155';
      ctx.fillRect(gx1 - postW * 0.5, beamTop1, postW, y1 - beamTop1);
    }

    renderPolygon(ctx, gx1, beamBot1, gx1, y1 - h1 * 0.24, gx2, y2 - h2 * 0.24, gx2, beamBot2, railLowerColor);
    renderPolygon(ctx, gx1, beamTop1, gx1, beamBot1, gx2, beamBot2, gx2, beamTop2, railColor);
    renderPolygon(ctx, gx1, beamTop1, gxOuter1, beamTop1, gxOuter2, beamTop2, gx2, beamTop2, railTopColor);

    if (needsClip) {
      ctx.restore();
    }
  }

  ctx.globalAlpha = prevAlpha;
}

/**
 * Заполняет переиспользуемый буфер геометрии арки старта/чекпоинта (0 аллокаций объектов)
 */
function computeArchLayout(destX, destY, roadHalfPx, isStartFinish) {
  const L = _archLayout;
  const archH = roadHalfPx * 0.72;
  const towerCenterOffset = roadHalfPx * ARCH_TOWER_OFFSET_NORM;
  const towerW = Math.max(4, roadHalfPx * 0.11);
  const sideDepthW = towerW * 0.36;
  const bannerH = archH * 0.25;
  const topY = destY - archH;

  L.archH = archH;
  L.towerW = towerW;
  L.sideDepthW = sideDepthW;
  L.bannerH = bannerH;
  L.topY = topY;
  L.bannerBottomY = topY + bannerH;
  L.leftTowerCenterX = destX - towerCenterOffset;
  L.rightTowerCenterX = destX + towerCenterOffset;
  L.leftOuterX = L.leftTowerCenterX - towerW * 0.5;
  L.leftInnerX = L.leftTowerCenterX + towerW * 0.5;
  L.rightInnerX = L.rightTowerCenterX - towerW * 0.5;
  L.rightOuterX = L.rightTowerCenterX + towerW * 0.5;
  L.accentColor = isStartFinish ? '#39ff14' : '#00f0ff';
  L.secondaryColor = isStartFinish ? '#ffbe0b' : '#ff2a85';
  L.lineW = MathUtil.clamp(towerW * 0.14, 1.2, 8.0);
  return L;
}

function renderOverheadArchPillars(ctx, destX, destY, roadHalfPx, isStartFinish, drawShadow = true) {
  const L = computeArchLayout(destX, destY, roadHalfPx, isStartFinish);
  if (L.archH < 3 || destY < -40 || L.topY > LOGICAL_HEIGHT + 40) return;

  if (drawShadow) {
    const shadowLen = roadHalfPx * 0.20;
    fillQuad(ctx, L.leftOuterX, destY, L.leftInnerX + L.sideDepthW, destY, L.leftInnerX + L.sideDepthW + L.towerW * 0.25, destY + shadowLen, L.leftOuterX - L.towerW * 0.15, destY + shadowLen, 'rgba(6, 2, 16, 0.45)');
    fillQuad(ctx, L.rightInnerX - L.sideDepthW, destY, L.rightOuterX, destY, L.rightOuterX + L.towerW * 0.15, destY + shadowLen, L.rightInnerX - L.sideDepthW - L.towerW * 0.25, destY + shadowLen, 'rgba(6, 2, 16, 0.45)');
  }

  const baseW = L.towerW * 1.42;
  const baseH = Math.max(2, L.archH * 0.055);
  ctx.fillStyle = '#24183b';
  ctx.fillRect(L.leftTowerCenterX - baseW * 0.5, destY - baseH, baseW, baseH);
  ctx.fillRect(L.rightTowerCenterX - baseW * 0.5, destY - baseH, baseW, baseH);

  if (L.sideDepthW > 1.5) {
    fillQuad(ctx, L.leftInnerX, L.topY + L.bannerH, L.leftInnerX + L.sideDepthW, L.topY + L.bannerH + L.sideDepthW * 0.45, L.leftInnerX + L.sideDepthW, destY - L.sideDepthW * 0.35, L.leftInnerX, destY, L.sideShadeColor);
    fillQuad(ctx, L.rightInnerX - L.sideDepthW, L.topY + L.bannerH + L.sideDepthW * 0.45, L.rightInnerX, L.topY + L.bannerH, L.rightInnerX, destY, L.rightInnerX - L.sideDepthW, destY - L.sideDepthW * 0.35, L.sideShadeColor);
  }

  for (let t = 0; t < 2; t++) {
    const tx = t === 0 ? L.leftOuterX : L.rightOuterX;
    ctx.fillStyle = L.darkFrameColor;
    ctx.fillRect(tx, L.topY, L.towerW, L.archH);

    ctx.strokeStyle = L.accentColor;
    ctx.lineWidth = L.lineW;
    ctx.strokeRect(tx, L.topY, L.towerW, L.archH);

    if (L.towerW >= 6 && L.archH > 22) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.24)';
      ctx.lineWidth = Math.max(1, L.lineW * 0.65);
      ctx.beginPath();
      const steps = 4;
      const stepH = (L.archH - L.bannerH) / steps;
      for (let s = 0; s < steps; s++) {
        const sy1 = L.bannerBottomY + s * stepH;
        const sy2 = sy1 + stepH;
        if (s % 2 === 0) {
          ctx.moveTo(tx + L.lineW, sy1);
          ctx.lineTo(tx + L.towerW - L.lineW, sy2);
        } else {
          ctx.moveTo(tx + L.towerW - L.lineW, sy1);
          ctx.lineTo(tx + L.lineW, sy2);
        }
      }
      ctx.stroke();
    }
  }

  // Угловые раскосы жёсткости между стойками и верхней балкой арки
  const gussetSpan = Math.min(roadHalfPx * 0.20, L.bannerH * 1.15);
  const gussetDrop = L.bannerH * 0.85;
  if (gussetSpan > 4) {
    ctx.fillStyle = L.darkFrameColor;
    ctx.strokeStyle = L.accentColor;
    ctx.lineWidth = L.lineW;

    ctx.beginPath();
    ctx.moveTo(L.leftInnerX, L.bannerBottomY - 1);
    ctx.lineTo(L.leftInnerX + gussetSpan, L.bannerBottomY - 1);
    ctx.lineTo(L.leftInnerX, L.bannerBottomY + gussetDrop);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(L.rightInnerX, L.bannerBottomY - 1);
    ctx.lineTo(L.rightInnerX - gussetSpan, L.bannerBottomY - 1);
    ctx.lineTo(L.rightInnerX, L.bannerBottomY + gussetDrop);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
}

export function renderOverheadArchPillarsClipped(ctx, scale, destX, destY, clipY, isStartFinish, drawShadow = true, distRatio = 0) {
  if (scale <= 0) return;
  const archFade = distRatio > 0.88 ? MathUtil.clamp((1 - distRatio) / 0.12, 0, 1) : 1;
  if (archFade <= 0.01) return;

  const LOGICAL_WIDTH = state.logicalWidth;
  const roadHalfPx = scale * ROAD_WIDTH * PROJ_HALF_WIDTH;
  const horizontalBound = roadHalfPx * 1.55;
  if (roadHalfPx < 1.2 || destX + horizontalBound < -48 || destX - horizontalBound > LOGICAL_WIDTH + 48) {
    return;
  }

  const archTopY = destY - roadHalfPx * 0.72;
  const archBotY = drawShadow ? (destY + roadHalfPx * 0.20) : destY;
  const hasClip = clipY !== null && clipY !== undefined;
  if (hasClip && archTopY >= clipY - 0.2) return;

  const needsClip = hasClip && archBotY > clipY + 0.5;
  if (needsClip) beginHorizonClip(ctx, clipY);

  const prevAlpha = ctx.globalAlpha;
  if (archFade < 0.999) ctx.globalAlpha = prevAlpha * archFade;

  renderOverheadArchPillars(ctx, destX, destY, roadHalfPx, isStartFinish, drawShadow);

  ctx.globalAlpha = prevAlpha;
  if (needsClip) ctx.restore();
}

export function renderOverheadArchBeam(ctx, scale, destX, destY, clipY, isStartFinish, distRatio = 0) {
  if (scale <= 0) return;
  const archFade = distRatio > 0.88 ? MathUtil.clamp((1 - distRatio) / 0.12, 0, 1) : 1;
  if (archFade <= 0.01) return;

  const LOGICAL_WIDTH = state.logicalWidth;
  const roadHalfPx = scale * ROAD_WIDTH * PROJ_HALF_WIDTH;
  const horizontalBound = roadHalfPx * 1.55;
  if (roadHalfPx < 1.2 || destX + horizontalBound < -48 || destX - horizontalBound > LOGICAL_WIDTH + 48) {
    return;
  }

  const L = computeArchLayout(destX, destY, roadHalfPx, isStartFinish);
  const soffitH = Math.max(1.2, L.bannerH * 0.16);
  const rawBeaconR = L.towerW * 0.34;
  const beaconR = MathUtil.clamp(rawBeaconR, 1.5, 22);
  const topBoundY = L.topY - beaconR * 2.5;
  const botBoundY = L.bannerBottomY + soffitH;

  if (L.archH < 3 || botBoundY < -48 || topBoundY > LOGICAL_HEIGHT + 48) return;

  const hasClip = clipY !== null && clipY !== undefined;
  if (hasClip && topBoundY >= clipY - 0.2) return;

  const needsClip = hasClip && botBoundY > clipY + 0.5;
  if (needsClip) beginHorizonClip(ctx, clipY);

  const prevAlpha = ctx.globalAlpha;
  if (archFade < 0.999) ctx.globalAlpha = prevAlpha * archFade;

  const beamOverhang = L.towerW * 0.16;
  const beamLeftX = L.leftOuterX - beamOverhang;
  const beamWidth = (L.rightOuterX + beamOverhang) - beamLeftX;

  fillQuad(ctx, beamLeftX, L.bannerBottomY, beamLeftX + beamWidth, L.bannerBottomY, beamLeftX + beamWidth - L.sideDepthW, L.bannerBottomY + soffitH, beamLeftX + L.sideDepthW, L.bannerBottomY + soffitH, L.sideShadeColor);

  ctx.fillStyle = L.darkFrameColor;
  ctx.fillRect(beamLeftX, L.topY, beamWidth, L.bannerH);

  // Пропорциональная толщина канта не перекрывает тёмное поле баннера на дальних дистанциях
  const trimH = Math.max(0.5, L.bannerH * 0.15);
  if (isStartFinish) {
    if (L.bannerH >= 3.5) {
      const checkCols = 16;
      const cellW = beamWidth / checkCols;
      for (let c = 0; c < checkCols; c++) {
        ctx.fillStyle = c % 2 === 0 ? '#ffffff' : '#140326';
        ctx.fillRect(beamLeftX + c * cellW, L.topY, cellW + 0.4, trimH);
        ctx.fillStyle = c % 2 === 1 ? '#ffffff' : '#140326';
        ctx.fillRect(beamLeftX + c * cellW, L.bannerBottomY - trimH, cellW + 0.4, trimH);
      }
    } else {
      // На сверхдальней дистанции используем оптическое среднее шашечек вместо жёлтого, чтобы избежать скачка цвета
      ctx.fillStyle = '#cbd5e1';
      ctx.fillRect(beamLeftX, L.topY, beamWidth, trimH);
      ctx.fillRect(beamLeftX, L.bannerBottomY - trimH, beamWidth, trimH);
    }
  } else {
    ctx.fillStyle = L.secondaryColor;
    ctx.fillRect(beamLeftX, L.topY, beamWidth, trimH);
    ctx.fillRect(beamLeftX, L.bannerBottomY - trimH, beamWidth, trimH);
  }

  const beaconY = L.topY - beaconR * 0.85;
  ctx.fillStyle = L.secondaryColor;
  ctx.beginPath();
  ctx.arc(L.leftTowerCenterX, beaconY, beaconR, 0, Math.PI * 2);
  ctx.arc(L.rightTowerCenterX, beaconY, beaconR, 0, Math.PI * 2);
  ctx.fill();

  const beaconHaloFade = MathUtil.clamp((rawBeaconR - 0.5) / 1.8, 0, 1) * archFade;
  if (state.settings.lightStyle === 'soft' && beaconHaloFade > 0.01) {
    const beaconStops = isStartFinish ? HALO_STOPS.beaconStart : HALO_STOPS.beaconCheckpoint;
    const haloBaseR = MathUtil.clamp(rawBeaconR, 1.2, 22);
    drawLightHalo(ctx, L.leftTowerCenterX, beaconY, haloBaseR, L.secondaryColor, haloBaseR * 3.2, beaconStops, beaconHaloFade);
    drawLightHalo(ctx, L.rightTowerCenterX, beaconY, haloBaseR, L.secondaryColor, haloBaseR * 3.2, beaconStops, beaconHaloFade);
  }

  // Плавное проявление текста арки издалека (с L.bannerH = 2.0 px вместо позднего скачка на 10 px)
  if (L.bannerH >= 2.0 && L.bannerH < 900) {
    const textAlpha = MathUtil.clamp((L.bannerH - 2.0) / 1.8, 0, 1);
    drawWorldSignText(
      ctx,
      isStartFinish ? 'arch_start' : 'arch_cp',
      isStartFinish ? 'START / FINISH' : 'CHECKPOINT',
      isStartFinish ? '#39ff14' : '#ffffff',
      destX,
      L.topY + L.bannerH * 0.50,
      L.bannerH * 0.52,
      beamWidth * 0.88,
      textAlpha
    );
  }

  ctx.globalAlpha = prevAlpha;
  if (needsClip) ctx.restore();
}

/**
 * Отрисовка только плоской наземной тени придорожного объекта или опор арки.
 * Используется для объектов переднего плана (ближе машины игрока): тень ложится на траву/обочину
 * строго ПОД колёса машин, тогда как сама вертикальная 3D-стойка рисуется позже поверх машин позади неё.
 */
export function renderSpriteGroundShadow(ctx, sprite, scale, destX, destY, clipY) {
  // Если основание объекта уже ниже нижнего края экрана, направленная вниз тень полностью за кадром
  if (scale <= 0 || destY > LOGICAL_HEIGHT + 24) return;

  const LOGICAL_WIDTH = state.logicalWidth;
  const roadHalfPx = scale * ROAD_WIDTH * PROJ_HALF_WIDTH;
  const unit = roadHalfPx * SPRITE_SCALE_RATIO;
  const isFullArch = sprite.type === 'start_arch' || sprite.type === 'checkpoint_arch';
  const horizontalBound = isFullArch ? roadHalfPx * 1.55 : unit * 1.25;

  if (
    roadHalfPx < 1.2 ||
    destX + horizontalBound < -48 ||
    destX - horizontalBound > LOGICAL_WIDTH + 48
  ) {
    return;
  }

  const shadowSpanY = isFullArch ? roadHalfPx * 0.22 : unit * 0.36;
  const hasClip = clipY !== null && clipY !== undefined;
  if (hasClip && destY >= clipY - 0.2) return;

  const needsClip = hasClip && (destY + shadowSpanY) > clipY + 0.5;
  if (needsClip) beginHorizonClip(ctx, clipY);

  const sunX = getSunX();
  const shadowDirX = (destX - sunX) * 0.0005;

  if (isFullArch) {
    const L = computeArchLayout(destX, destY, roadHalfPx, sprite.type === 'start_arch');
    if (L.archH >= 5) {
      const shadowLen = roadHalfPx * 0.20;
      fillQuad(ctx, L.leftOuterX, destY, L.leftInnerX + L.sideDepthW, destY, L.leftInnerX + L.sideDepthW + L.towerW * 0.25, destY + shadowLen, L.leftOuterX - L.towerW * 0.15, destY + shadowLen, 'rgba(6, 2, 16, 0.45)');
      fillQuad(ctx, L.rightInnerX - L.sideDepthW, destY, L.rightOuterX, destY, L.rightOuterX + L.towerW * 0.15, destY + shadowLen, L.rightInnerX - L.sideDepthW - L.towerW * 0.25, destY + shadowLen, 'rgba(6, 2, 16, 0.45)');
    }
  } else if (sprite.type === 'palm') {
    if (unit >= 10) {
      const trunkW = MathUtil.clamp(unit * 0.055, 1.8, 42);
      const shadowLen = unit * 0.34;
      ctx.strokeStyle = 'rgba(6, 2, 16, 0.42)';
      ctx.lineWidth = MathUtil.clamp(trunkW * 1.2, 2, 48);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(destX, destY);
      ctx.lineTo(destX + shadowDirX * shadowLen * 12, destY + shadowLen);
      ctx.stroke();
      ctx.lineCap = 'butt';
    }
  } else if (sprite.type === 'lamp') {
    if (unit >= 11) {
      const poleW = MathUtil.clamp(unit * 0.028, 1.8, 24);
      const shadowLen = unit * 0.28;
      ctx.strokeStyle = 'rgba(6, 2, 16, 0.40)';
      ctx.lineWidth = MathUtil.clamp(poleW * 1.1, 1.5, 26);
      ctx.beginPath();
      ctx.moveTo(destX, destY);
      ctx.lineTo(destX + shadowDirX * shadowLen * 10, destY + shadowLen);
      ctx.stroke();
    }
  } else if (sprite.type === 'billboard') {
    if (unit >= 10) {
      const boardW = unit * 0.56;
      const bx = destX - boardW * 0.5;
      fillQuad(ctx, bx, destY, bx + boardW, destY, bx + boardW + shadowDirX * unit * 3, destY + unit * 0.22, bx + shadowDirX * unit * 3, destY + unit * 0.22, 'rgba(6, 2, 16, 0.42)');
    }
  } else if (sprite.type === 'chevron_left' || sprite.type === 'chevron_right') {
    if (unit >= 10) {
      const signW = unit * 0.22;
      const sx = destX - signW * 0.5;
      fillQuad(ctx, sx, destY, sx + signW, destY, sx + signW, destY + unit * 0.14, sx, destY + unit * 0.14, 'rgba(6, 2, 16, 0.38)');
    }
  }

  if (needsClip) ctx.restore();
}

/**
 * Отрисовка придорожных объектов с ранним отсечением за холмами (clipY), условным ctx.clip() и дистанционным LOD пальм
 */
export function renderSprite(ctx, sprite, scale, destX, destY, clipY, distRatio = 0, drawShadow = true) {
  if (scale <= 0) return;

  const isFullArch = sprite.type === 'start_arch' || sprite.type === 'checkpoint_arch';
  const horizonFade = isFullArch
    ? (distRatio > 0.88 ? MathUtil.clamp((1 - distRatio) / 0.12, 0, 1) : 1)
    : (distRatio > 0.84 ? MathUtil.clamp((1 - distRatio) / 0.16, 0, 1) : 1);
  if (horizonFade <= 0.01) return;

  const LOGICAL_WIDTH = state.logicalWidth;
  const roadHalfPx = scale * ROAD_WIDTH * PROJ_HALF_WIDTH;
  const unit = roadHalfPx * SPRITE_SCALE_RATIO;
  const horizontalBound = isFullArch ? roadHalfPx * 1.55 : unit * 1.25;

  if (
    roadHalfPx < 1.2 ||
    destX + horizontalBound < -48 ||
    destX - horizontalBound > LOGICAL_WIDTH + 48
  ) {
    return;
  }

  // Точная верхняя и нижняя граница спрайта для мгновенного отсечения объектов, полностью скрытых за гребнем холма
  const approxTopY = isFullArch ? (destY - roadHalfPx * 0.78) : (destY - unit * 1.18);
  const approxBotY = drawShadow ? (destY + (isFullArch ? roadHalfPx * 0.22 : unit * 0.36)) : destY;

  if (approxTopY > LOGICAL_HEIGHT + 48) return;

  const hasClip = clipY !== null && clipY !== undefined;
  if (hasClip && approxTopY >= clipY - 0.3) return;

  // Вызываем тяжёлый ctx.clip() ТОЛЬКО если объект частично перекрыт линией холма
  const needsClip = hasClip && approxBotY > clipY + 0.5;
  if (needsClip) beginHorizonClip(ctx, clipY);

  const prevAlpha = ctx.globalAlpha;
  if (horizonFade < 0.999) {
    ctx.globalAlpha = prevAlpha * horizonFade;
  }

  const sunX = getSunX();
  const shadowDirX = (destX - sunX) * 0.0005;

  if (isFullArch) {
    renderOverheadArchPillars(ctx, destX, destY, roadHalfPx, sprite.type === 'start_arch', drawShadow);
  } else if (sprite.type === 'palm') {
    const trunkW = MathUtil.clamp(unit * 0.055, 1.8, 42);
    const trunkH = unit * 0.85;
    const topX = destX + (sprite.offset < 0 ? -unit * 0.06 : unit * 0.06);
    const topY = destY - trunkH;

    if (drawShadow && unit >= 10) {
      const shadowLen = unit * 0.34;
      ctx.strokeStyle = 'rgba(6, 2, 16, 0.42)';
      ctx.lineWidth = MathUtil.clamp(trunkW * 1.2, 2, 48);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(destX, destY);
      ctx.lineTo(destX + shadowDirX * shadowLen * 12, destY + shadowLen);
      ctx.stroke();
    }

    ctx.strokeStyle = '#5c2c16';
    ctx.lineWidth = trunkW;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(destX, destY);
    if (unit >= 12) {
      ctx.quadraticCurveTo(destX, destY - trunkH * 0.55, topX, topY);
    } else {
      ctx.lineTo(topX, topY);
    }
    ctx.stroke();

    const leafLen = unit * 0.36;
    const frondWidth = Math.max(1.4, trunkW * 0.65);

    if (unit >= 14) {
      // Полная детализация кроны с теневым подслоем вблизи и на средней дистанции
      ctx.strokeStyle = '#1b0b45';
      ctx.lineWidth = Math.max(1.4, trunkW * 0.62);
      ctx.beginPath();
      for (let i = 0; i < PALM_FRONDS.length; i++) {
        const f = PALM_FRONDS[i];
        const lx = topX + f.shCos * leafLen * 0.92;
        const ly = topY + f.shSin * leafLen * 0.62 + leafLen * 0.24;
        ctx.moveTo(topX, topY + trunkW * 0.35);
        ctx.quadraticCurveTo((topX + lx) * 0.5, topY - leafLen * 0.08, lx, ly);
      }
      ctx.stroke();

      ctx.lineWidth = frondWidth;
      for (let i = 0; i < PALM_FRONDS.length; i++) {
        const f = PALM_FRONDS[i];
        const lx = topX + f.cos * leafLen;
        const ly = topY + f.sin * leafLen * 0.65 + leafLen * 0.18;
        ctx.strokeStyle = f.color;
        ctx.beginPath();
        ctx.moveTo(topX, topY);
        ctx.quadraticCurveTo((topX + lx) * 0.5, topY - leafLen * 0.18, lx, ly);
        ctx.stroke();
      }
    } else {
      // Лёгкий дальний LOD кроны: единый пакетный контур без квадратичных кривых и теневого дубля
      ctx.strokeStyle = '#00e5d4';
      ctx.lineWidth = frondWidth;
      ctx.beginPath();
      for (let i = 0; i < PALM_FRONDS.length; i++) {
        const f = PALM_FRONDS[i];
        ctx.moveTo(topX, topY);
        ctx.lineTo(topX + f.cos * leafLen, topY + f.sin * leafLen * 0.65 + leafLen * 0.18);
      }
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
  } else if (sprite.type === 'lamp') {
    const poleW = MathUtil.clamp(unit * 0.028, 1.8, 24);
    const poleH = unit * 0.78;
    const armDir = sprite.offset < 0 ? 1 : -1;
    const armLen = unit * 0.18 * armDir;

    if (drawShadow && unit >= 11) {
      const shadowLen = unit * 0.28;
      ctx.strokeStyle = 'rgba(6, 2, 16, 0.40)';
      ctx.lineWidth = MathUtil.clamp(poleW * 1.1, 1.5, 26);
      ctx.beginPath();
      ctx.moveTo(destX, destY);
      ctx.lineTo(destX + shadowDirX * shadowLen * 10, destY + shadowLen);
      ctx.stroke();
    }

    ctx.strokeStyle = '#8d99ae';
    ctx.lineWidth = poleW;
    ctx.beginPath();
    ctx.moveTo(destX, destY);
    ctx.lineTo(destX, destY - poleH);
    ctx.lineTo(destX + armLen, destY - poleH);
    ctx.stroke();

    const lampX = destX + armLen;
    const lampY = destY - poleH;
    const rawLampR = unit * 0.032;
    const lampR = MathUtil.clamp(rawLampR, 1.4, 24);
    ctx.fillStyle = '#00f0ff';
    ctx.beginPath();
    ctx.arc(lampX, lampY, lampR, 0, Math.PI * 2);
    ctx.fill();

    const lampHaloFade = MathUtil.clamp((rawLampR - 0.45) / 2.6, 0, 1) * horizonFade;
    if (lampHaloFade > 0.01) {
      const haloBaseR = MathUtil.clamp(rawLampR, 1.1, 24);
      drawLightHalo(
        ctx,
        lampX,
        lampY,
        haloBaseR * 2.6,
        'rgba(0, 240, 255, 0.22)',
        haloBaseR * 4.4,
        HALO_STOPS.streetLamp,
        lampHaloFade
      );
    }
  } else if (sprite.type === 'billboard') {
    const boardW = unit * 0.56;
    const boardH = unit * 0.30;
    const legH = unit * 0.34;
    const bx = destX - boardW * 0.5;
    const by = destY - legH - boardH;
    const depthW = Math.max(0.8, boardW * 0.08);
    const sideSign = sprite.offset < 0 ? -1 : 1;

    if (drawShadow && unit >= 10) {
      fillQuad(ctx, bx, destY, bx + boardW, destY, bx + boardW + shadowDirX * unit * 3, destY + unit * 0.22, bx + shadowDirX * unit * 3, destY + unit * 0.22, 'rgba(6, 2, 16, 0.42)');
    }

    ctx.fillStyle = '#4a4e69';
    const legW = Math.max(1.2, boardW * 0.08);
    ctx.fillRect(bx + boardW * 0.2, destY - legH, legW, legH);
    ctx.fillRect(bx + boardW * 0.72, destY - legH, legW, legH);

    const outerEdgeX = sideSign < 0 ? bx : (bx + boardW);
    fillQuad(ctx, outerEdgeX, by, outerEdgeX + sideSign * depthW, by + depthW * 0.35, outerEdgeX + sideSign * depthW, by + boardH + depthW * 0.35, outerEdgeX, by + boardH, '#090117');
    fillQuad(ctx, bx, by, bx + boardW, by, bx + boardW + (sideSign > 0 ? depthW : 0), by - depthW * 0.22, bx + (sideSign < 0 ? -depthW : 0), by - depthW * 0.22, '#2b0959');

    ctx.fillStyle = '#14042e';
    ctx.fillRect(bx, by, boardW, boardH);
    ctx.strokeStyle = '#ff2a85';
    // Уменьшенный нижний порог толщины рамки сохраняет читаемое тёмное поле под текст вдали
    ctx.lineWidth = MathUtil.clamp(unit * 0.015, 0.75, 10);
    ctx.strokeRect(bx, by, boardW, boardH);

    // Плавное проявление текста щита издалека (с boardH = 2.6 px вместо позднего скачка на 12 px)
    if (boardH >= 2.6 && boardH < 900) {
      const textAlpha = MathUtil.clamp((boardH - 2.6) / 2.2, 0, 1);
      drawWorldSignText(
        ctx,
        'billboard_turbo90',
        'TURBO 90',
        '#ffbe0b',
        destX,
        by + boardH * 0.50,
        boardH * 0.36,
        boardW * 0.84,
        textAlpha
      );
    }
  } else if (sprite.type === 'chevron_left' || sprite.type === 'chevron_right') {
    const signW = unit * 0.22;
    const signH = unit * 0.18;
    const legH = unit * 0.22;
    const sx = destX - signW * 0.5;
    const sy = destY - legH - signH;
    const depthW = Math.max(1.5, signW * 0.10);
    const sideSign = sprite.offset < 0 ? -1 : 1;

    if (drawShadow && unit >= 10) {
      fillQuad(ctx, sx, destY, sx + signW, destY, sx + signW, destY + unit * 0.14, sx, destY + unit * 0.14, 'rgba(6, 2, 16, 0.38)');
    }

    ctx.fillStyle = '#6c757d';
    ctx.fillRect(destX - Math.max(1.5, signW * 0.08), destY - legH, Math.max(3, signW * 0.16), legH);

    const outerEdgeX = sideSign < 0 ? sx : (sx + signW);
    fillQuad(ctx, outerEdgeX, sy, outerEdgeX + sideSign * depthW, sy + depthW * 0.35, outerEdgeX + sideSign * depthW, sy + signH + depthW * 0.35, outerEdgeX, sy + signH, '#090117');

    ctx.fillStyle = '#140326';
    ctx.fillRect(sx, sy, signW, signH);
    ctx.strokeStyle = '#ffbe0b';
    ctx.lineWidth = MathUtil.clamp(unit * 0.012, 1.2, 8);
    ctx.strokeRect(sx, sy, signW, signH);

    const dir = sprite.type === 'chevron_right' ? 1 : -1;
    ctx.strokeStyle = '#ff2a85';
    ctx.lineWidth = MathUtil.clamp(signH * 0.16, 2, 18);
    ctx.beginPath();
    ctx.moveTo(destX - dir * signW * 0.18, sy + signH * 0.24);
    ctx.lineTo(destX + dir * signW * 0.18, sy + signH * 0.50);
    ctx.lineTo(destX - dir * signW * 0.18, sy + signH * 0.76);
    ctx.stroke();
  }

  ctx.globalAlpha = prevAlpha;
  if (needsClip) ctx.restore();
}