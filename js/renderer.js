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
  MAX_SPEED,
  OFF_ROAD_THRESHOLD_X,
  MAX_HARDCORE_COLLISIONS,
  WHEEL_TRACK_OFFSET,
  WHEEL_SKID_HALF_W
} from './config.js';
import { MathUtil, getShortestTrackDz } from './utils.js';
import { state, findSegment, getSunX } from './state.js';
import { renderHUD } from './hud.js';

// Базовое смещение опор арок от центра дороги (синхронизируется с хитбоксами в physics.js)
const ARCH_TOWER_OFFSET_NORM = 1.28;
// Коэффициент сохранения визуального размера придорожных спрайтов без искажения от динамического FOV
const SPRITE_SCALE_RATIO = 0.84;

// Безопасные ближние плоскости отсечения по Z (устраняют взрыв масштаба и 1-кадровые полосы-артефакты)
const MIN_SAMPLE_CAM_Z = 24;
const MIN_GUARDRAIL_CAM_Z = 80;
const MIN_SPRITE_CAM_Z = 120;
const MIN_CAR_CAM_Z = 160;

// Кэш повторяемых слоёв фона (горы и город) для снижения нагрузки на CPU
const MOUNTAIN_TILE_W = 480;
const MOUNTAIN_TILE_H = 104;
const CITY_TILE_W = 640;
const CITY_TILE_H = 104;

// Постоянные массивы разметки и колей (без пересоздания в каждом сегменте)
const GROOVES_ONCOMING = [-0.66, -0.23, 0.23, 0.66];
const GROOVES_CIRCUIT = [-0.45, 0.45];
const GROOVES_ONEWAY = [-0.64, 0, 0.64];
const LANES_ONCOMING = [-0.45, 0.45];
const LANES_CIRCUIT = [0];
const LANES_ONEWAY = [-0.33, 0.33];
const WHEEL_SIDES = [-WHEEL_TRACK_OFFSET, WHEEL_TRACK_OFFSET];

// Профили 3D-кузовов по типам машин
const CAR_BODY_PROFILES = {
  coupe: { tCR: 0.18, tRR: 0.30, tRF: 0.64, tCF: 0.76, roofHalfFrac: 0.315, tAxleNear: 0.22, tAxleFar: 0.82, dtWheel: 0.086, wheelRFrac: 0.215 },
  sport: { tCR: 0.16, tRR: 0.28, tRF: 0.62, tCF: 0.75, roofHalfFrac: 0.300, tAxleNear: 0.22, tAxleFar: 0.82, dtWheel: 0.088, wheelRFrac: 0.215 },
  sedan: { tCR: 0.16, tRR: 0.26, tRF: 0.67, tCF: 0.78, roofHalfFrac: 0.330, tAxleNear: 0.21, tAxleFar: 0.82, dtWheel: 0.084, wheelRFrac: 0.210 },
  van:   { tCR: 0.07, tRR: 0.13, tRF: 0.82, tCF: 0.91, roofHalfFrac: 0.360, tAxleNear: 0.21, tAxleFar: 0.81, dtWheel: 0.078, wheelRFrac: 0.175 }
};

// Слои полутени для мягкого режима освещения (без нагрузки от ctx.filter)
const SOFT_SHADOW_LAYERS = [
  { wPad: 0.095, rExt: 0.085, fExt: 0.090, round: 0.17, color: 'rgba(7, 2, 18, 0.05)' },
  { wPad: 0.058, rExt: 0.055, fExt: 0.058, round: 0.15, color: 'rgba(7, 2, 18, 0.07)' },
  { wPad: 0.028, rExt: 0.028, fExt: 0.030, round: 0.13, color: 'rgba(7, 2, 18, 0.10)' },
  { wPad: 0.004, rExt: 0.008, fExt: 0.008, round: 0.11, color: 'rgba(7, 2, 18, 0.14)' },
  { wPad: -0.022, rExt: -0.018, fExt: -0.018, round: 0.09, color: 'rgba(7, 2, 18, 0.20)' }
];

const SOFT_SHADOW_FAR_LAYERS = [
  { wPad: 0.055, rExt: 0.045, fExt: 0.050, round: 0.14, color: 'rgba(7, 2, 18, 0.14)' },
  { wPad: -0.005, rExt: 0.000, fExt: 0.000, round: 0.10, color: 'rgba(7, 2, 18, 0.28)' }
];

// Кэши строк цветов для тумана и следов торможения (0 аллокаций в renderSegment)
const FOG_COLOR_CACHE = Array.from({ length: 101 }, (_, i) => `rgba(26, 9, 52, ${(i / 100).toFixed(2)})`);
const SKID_COLOR_CACHE = Array.from({ length: 101 }, (_, i) => `rgba(7, 5, 14, ${(i / 100).toFixed(2)})`);

let mountainTileCanvas = null;
let cityTileCanvas = null;

const particleColorCache = new Map();
const softParticleSpriteCache = new Map();
const SOFT_PARTICLE_TEX_SIZE = 48;

// Переиспользуемые буферы кадра (устраняют ежекадровые аллокации в renderFrame)
const _foregroundCars = [];
const _foregroundArchBeams = [];
const _segArchBeams = [];
const _segCarsScratch = [];

/**
 * Однократная генерация тайлов гор и неонового города в offscreen-канвасах
 */
function ensureBackgroundCaches() {
  if (mountainTileCanvas && cityTileCanvas) return;

  try {
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

          // Детерминированная сетка окон по целым индексам (без мерцания при движении)
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
    mountainTileCanvas = null;
    cityTileCanvas = null;
  }
}

function project(p, cameraX, cameraY, cameraZ, cameraDepth, width, height, roadWidth, pitchOffset = 0) {
  p.camera.x = (p.world.x || 0) - cameraX;
  p.camera.y = (p.world.y || 0) - cameraY;
  p.camera.z = (p.world.z || 0) - cameraZ;
  p.screen.scale = cameraDepth / Math.max(1, p.camera.z);
  p.screen.x = (width * 0.5) + (p.screen.scale * p.camera.x * PROJ_HALF_WIDTH);
  p.screen.y = (height * 0.5) + pitchOffset - (p.screen.scale * p.camera.y * height * 0.5);
  p.screen.w = p.screen.scale * roadWidth * PROJ_HALF_WIDTH;
}

function sampleRoadAtZ(worldZ) {
  const seg = findSegment(worldZ);
  if (!seg || seg.projectedFrame !== state.frameCounter) return null;

  const wrappedZ = ((worldZ % state.trackLength) + state.trackLength) % state.trackLength;
  const t = MathUtil.percentRemaining(wrappedZ, SEGMENT_LENGTH);

  const camX = MathUtil.lerp(seg.p1.camera.x, seg.p2.camera.x, t);
  const camY = MathUtil.lerp(seg.p1.camera.y, seg.p2.camera.y, t);
  const camZ = MathUtil.lerp(seg.p1.camera.z, seg.p2.camera.z, t);
  if (camZ <= MIN_SAMPLE_CAM_Z) return null;

  const scale = state.activeCameraDepth / camZ;
  return {
    camZ,
    scale,
    roadCenterX: (state.logicalWidth * 0.5) + scale * camX * PROJ_HALF_WIDTH,
    roadY: (LOGICAL_HEIGHT * 0.5) + state.cameraPitch - scale * camY * (LOGICAL_HEIGHT * 0.5),
    clipY: seg.clip
  };
}

function renderBackground(ctx) {
  ensureBackgroundCaches();

  const LOGICAL_WIDTH = state.logicalWidth;
  const horizonY = LOGICAL_HEIGHT * 0.50 + state.cameraPitch;

  const skyGrad = ctx.createLinearGradient(0, -60, 0, horizonY);
  skyGrad.addColorStop(0.0, '#070116');
  skyGrad.addColorStop(0.42, '#1d0642');
  skyGrad.addColorStop(0.76, '#691268');
  skyGrad.addColorStop(1.0, '#ff3b7f');
  ctx.fillStyle = skyGrad;
  ctx.fillRect(-40, -60, LOGICAL_WIDTH + 80, horizonY + 66);

  const now = state.animClockMs * 0.002;
  const starSpanY = Math.max(40, horizonY);
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < state.stars.length; i++) {
    const s = state.stars[i];
    const sx = (((s.x - state.skyOffset * 0.5) % 1) + 1) % 1 * LOGICAL_WIDTH;
    const sy = s.y * starSpanY;
    ctx.globalAlpha = 0.45 + 0.55 * Math.sin(now + s.phase);
    ctx.fillRect(sx, sy, s.r * 1.6, s.r * 1.6);
  }
  ctx.globalAlpha = 1;

  const sunX = getSunX();
  const sunY = horizonY - 26;
  const sunR = 88;

  const glowGrad = ctx.createRadialGradient(sunX, sunY, sunR * 0.4, sunX, sunY, sunR * 2.1);
  glowGrad.addColorStop(0, 'rgba(255, 190, 11, 0.45)');
  glowGrad.addColorStop(0.5, 'rgba(255, 42, 133, 0.22)');
  glowGrad.addColorStop(1, 'rgba(255, 42, 133, 0)');
  ctx.fillStyle = glowGrad;
  ctx.beginPath();
  ctx.arc(sunX, sunY, sunR * 2.1, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.arc(sunX, sunY, sunR, 0, Math.PI * 2);
  ctx.clip();

  const sunGrad = ctx.createLinearGradient(0, sunY - sunR, 0, sunY + sunR);
  sunGrad.addColorStop(0, '#fff3b0');
  sunGrad.addColorStop(0.45, '#ffbe0b');
  sunGrad.addColorStop(1, '#ff2a85');
  ctx.fillStyle = sunGrad;
  ctx.fillRect(sunX - sunR, sunY - sunR, sunR * 2, sunR * 2);

  ctx.fillStyle = '#2d0845';
  for (let stripe = 0; stripe < 6; stripe++) {
    const sy = sunY + 10 + stripe * 13;
    const sh = 2 + stripe * 1.3;
    ctx.fillRect(sunX - sunR, sy, sunR * 2, sh);
  }
  ctx.restore();

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
  ctx.fillRect(-40, horizonY, LOGICAL_WIDTH + 80, LOGICAL_HEIGHT - horizonY + 80);
}

function renderPolygon(ctx, x1, y1, x2, y2, x3, y3, x4, y4, color) {
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

function fillQuad(ctx, x1, y1, x2, y2, x3, y3, x4, y4, color) {
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
 * Отрисовка четырёхугольника со скруглёнными углами в перспективе (для мягкой тени)
 */
function fillRoundedQuad(ctx, x1, y1, x2, y2, x3, y3, x4, y4, roundFrac, color) {
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
 * Разбор цвета частицы (#hex или rgba) для плавных мягких спрайтов
 */
function parseParticleColor(color) {
  const cached = particleColorCache.get(color);
  if (cached) return cached;

  let parsed = { r: 220, g: 220, b: 230, a: 0.7, isLuminous: false, spriteKey: '220,220,230,0' };
  if (typeof color === 'string') {
    if (color.startsWith('#') && color.length === 7) {
      const num = parseInt(color.slice(1), 16);
      if (!Number.isNaN(num)) {
        const lower = color.toLowerCase();
        const r = (num >> 16) & 255;
        const g = (num >> 8) & 255;
        const b = num & 255;
        const isLuminous = lower === '#ffbe0b' || lower === '#ff7b00';
        parsed = { r, g, b, a: 1.0, isLuminous, spriteKey: `${r},${g},${b},${isLuminous ? 1 : 0}` };
      }
    } else if (color.startsWith('rgba(') || color.startsWith('rgb(')) {
      const m = color.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/);
      if (m) {
        const r = Math.round(Number(m[1]));
        const g = Math.round(Number(m[2]));
        const b = Math.round(Number(m[3]));
        const a = m[4] !== undefined ? Number(m[4]) : 1.0;
        parsed = { r, g, b, a, isLuminous: false, spriteKey: `${r},${g},${b},0` };
      }
    }
  }

  if (particleColorCache.size > 256) {
    particleColorCache.clear();
  }
  particleColorCache.set(color, parsed);
  return parsed;
}

/**
 * Кэшированный offscreen-спрайт мягкой радиальной частицы (заменяет сотни createRadialGradient/кадр)
 */
function getSoftParticleSprite(c) {
  let sprite = softParticleSpriteCache.get(c.spriteKey);
  if (sprite) return sprite;

  const size = SOFT_PARTICLE_TEX_SIZE;
  const half = size * 0.5;
  const off = document.createElement('canvas');
  off.width = size;
  off.height = size;
  const octx = off.getContext('2d');
  if (octx) {
    const grad = octx.createRadialGradient(half, half, half * 0.07, half, half, half);
    if (c.isLuminous) {
      grad.addColorStop(0.0, 'rgba(255, 253, 232, 0.96)');
      grad.addColorStop(0.32, `rgba(${c.r}, ${c.g}, ${c.b}, 0.72)`);
      grad.addColorStop(0.70, `rgba(${c.r}, ${Math.round(c.g * 0.55)}, 0, 0.22)`);
      grad.addColorStop(1.0, `rgba(${c.r}, ${Math.round(c.g * 0.4)}, 0, 0.0)`);
    } else {
      grad.addColorStop(0.0, `rgba(${c.r}, ${c.g}, ${c.b}, 0.92)`);
      grad.addColorStop(0.45, `rgba(${c.r}, ${c.g}, ${c.b}, 0.46)`);
      grad.addColorStop(1.0, `rgba(${c.r}, ${c.g}, ${c.b}, 0.0)`);
    }
    octx.fillStyle = grad;
    octx.beginPath();
    octx.arc(half, half, half, 0, Math.PI * 2);
    octx.fill();
  }

  if (softParticleSpriteCache.size > 64) {
    softParticleSpriteCache.clear();
  }
  softParticleSpriteCache.set(c.spriteKey, off);
  return off;
}

/**
 * Универсальная отрисовка ореола источника света с плавным масштабированием прозрачности по дистанции
 */
function drawLightHalo(ctx, x, y, hardRadius, hardColor, softRadius, softStops, alphaScale = 1) {
  const clampedAlpha = MathUtil.clamp(alphaScale, 0, 1);
  if (clampedAlpha <= 0.01) return;

  ctx.save();
  ctx.globalAlpha *= clampedAlpha;

  if (state.settings.lightStyle === 'soft') {
    const r = Math.max(2, softRadius);
    ctx.globalCompositeOperation = 'screen';
    const grad = ctx.createRadialGradient(x, y, r * 0.08, x, y, r);
    for (let i = 0; i < softStops.length; i++) {
      grad.addColorStop(softStops[i][0], softStops[i][1]);
    }
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  ctx.fillStyle = hardColor;
  ctx.beginPath();
  ctx.arc(x, y, hardRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function renderSegment(ctx, seg, fogAlpha = 0) {
  const LOGICAL_WIDTH = state.logicalWidth;
  const x1 = seg.p1.screen.x;
  const y1 = seg.p1.screen.y;
  const w1 = seg.p1.screen.w;
  const x2 = seg.p2.screen.x;
  const y2 = seg.p2.screen.y;
  const w2 = seg.p2.screen.w;
  const sliceH = y1 - y2;

  // Заливаем траву строго от y2 вверх на 0.5px до y1 (без затирания уже нарисованного ближнего полотна)
  ctx.fillStyle = seg.color.grass;
  ctx.fillRect(-40, y2 - 0.5, LOGICAL_WIDTH + 80, sliceH + 0.5);

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

  if (curbLift1 > 0.6) {
    renderPolygon(ctx, x1 - w1, y1, x1 - w1, y1 - curbLift1, x2 - w2, y2 - curbLift2, x2 - w2, y2, '#180933');
    renderPolygon(ctx, x1 + w1, y1 - curbLift1, x1 + w1, y1, x2 + w2, y2, x2 + w2, y2 - curbLift2, '#180933');
  }

  renderPolygon(ctx, x1 - w1, y1, x1 + w1, y1, x2 + w2, y2, x2 - w2, y2, seg.color.road);

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
      'rgba(9, 5, 22, 0.18)'
    );
  }

  const edgeW1 = w1 * 0.026;
  const edgeW2 = w2 * 0.026;
  renderPolygon(ctx, x1 - w1, y1, x1 - w1 + edgeW1, y1, x2 - w2 + edgeW2, y2, x2 - w2, y2, seg.color.edge);
  renderPolygon(ctx, x1 + w1 - edgeW1, y1, x1 + w1, y1, x2 + w2, y2, x2 + w2 - edgeW2, y2, seg.color.edge);

  if (state.gameMode === 'oncoming') {
    const divW1 = w1 * 0.017;
    const divW2 = w2 * 0.017;
    const divGap1 = w1 * 0.032;
    const divGap2 = w2 * 0.032;
    renderPolygon(ctx, x1 - divGap1 - divW1, y1, x1 - divGap1 + divW1, y1, x2 - divGap2 + divW2, y2, x2 - divGap2 - divW2, y2, '#ffbe0b');
    renderPolygon(ctx, x1 + divGap1 - divW1, y1, x1 + divGap1 + divW1, y1, x2 + divGap2 + divW2, y2, x2 + divGap2 - divW2, y2, '#ffbe0b');

    if (seg.color.lane) {
      const lw1 = w1 * 0.018;
      const lw2 = w2 * 0.018;
      for (let i = 0; i < LANES_ONCOMING.length; i++) {
        const laneNorm = LANES_ONCOMING[i];
        const lx1 = x1 + w1 * laneNorm;
        const lx2 = x2 + w2 * laneNorm;
        renderPolygon(ctx, lx1 - lw1, y1, lx1 + lw1, y1, lx2 + lw2, y2, lx2 - lw2, y2, seg.color.lane);
      }
    }
  } else if (seg.color.lane) {
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

  // Линия старта/финиша и полоса чекпоинта рисуются ПОД следами шин
  if (seg.isStartFinish) {
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
  }

  if (seg.isCheckpoint) {
    renderPolygon(ctx, x1 - w1, y1, x1 + w1, y1, x2 + w2, y2, x2 - w2, y2, '#ffbe0b');
  }

  if (seg.skidMarks && seg.skidMarks.length > 0) {
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

  // Дымка горизонта накладывается строго в пределах высоты сегмента (без многократного наслоения)
  if (fogAlpha > 0.01 && sliceH > 0.05) {
    const fogIdx = MathUtil.clamp(Math.round(fogAlpha * 100), 1, 100);
    ctx.fillStyle = FOG_COLOR_CACHE[fogIdx];
    ctx.fillRect(-40, y2, LOGICAL_WIDTH + 80, sliceH);
  }
}

function renderRoadHeadlights(ctx) {
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

  const fallbackSample = (camZ) => {
    const effectiveCamX = (state.playerX - state.cameraLagX) * ROAD_WIDTH;
    const scale = state.activeCameraDepth / camZ;
    return {
      scale,
      roadCenterX: (LOGICAL_WIDTH * 0.5) + scale * (-effectiveCamX) * PROJ_HALF_WIDTH,
      roadY: (LOGICAL_HEIGHT * 0.5) + state.cameraPitch - scale * (-CAMERA_HEIGHT) * (LOGICAL_HEIGHT * 0.5),
      clipY: LOGICAL_HEIGHT
    };
  };

  const frontSample = sampleRoadAtZ(state.position + frontBumperCamZ) || fallbackSample(frontBumperCamZ);
  if (!frontSample || frontSample.scale <= 0) return;

  const frontWorldX = state.playerX * ROAD_WIDTH + halfLen * yawSlope;
  const frontCenterScreenX = frontSample.roadCenterX + frontSample.scale * frontWorldX * PROJ_HALF_WIDTH;
  const bumperRelCamX = (frontCenterScreenX - LOGICAL_WIDTH * 0.5) / (frontSample.scale * PROJ_HALF_WIDTH);

  const steps = 20;
  const slices = [];
  let minYSoFar = Infinity;

  for (let i = 0; i <= steps; i++) {
    const dZ = (i / steps) * HEADLIGHT_BEAM_DIST_Z;
    const camZ = frontBumperCamZ + dZ;
    const s = i === 0 ? frontSample : sampleRoadAtZ(state.position + camZ);
    if (!s || s.scale <= 0) break;
    // Прерываем луч за гребнем холма, чтобы свет фар не просвечивал сквозь рельеф
    if (i > 0 && (s.roadY >= minYSoFar - 0.2 || s.roadY > s.clipY + 1)) break;
    minYSoFar = s.roadY;
    slices.push({ dZ, scale: s.scale, y: s.roadY });
  }

  if (slices.length < 2) return;
  const nearY = slices[0].y;
  const farY = slices[slices.length - 1].y;
  if (nearY <= farY + 4) return;

  const carHalfWWorld = PLAYER_WIDTH_NORM * ROAD_WIDTH * 0.5;
  const lampLateralWorld = carHalfWWorld * 0.68;
  const lampStartHalfW = carHalfWWorld * 0.17;
  const isSoftLight = state.settings.lightStyle === 'soft';

  const drawBeamPolygon = (sideSign, startWidthMult, spreadMult, a0, a1, a2) => {
    const leftPts = [];
    const rightPts = [];

    for (let i = 0; i < slices.length; i++) {
      const sl = slices[i];
      const rayCenterRelCamX = bumperRelCamX + sl.dZ * yawSlope + sideSign * lampLateralWorld;
      const halfWWorld = lampStartHalfW * startWidthMult + sl.dZ * 0.082 * spreadMult;

      leftPts.push({
        x: (LOGICAL_WIDTH * 0.5) + sl.scale * (rayCenterRelCamX - halfWWorld) * PROJ_HALF_WIDTH,
        y: sl.y
      });
      rightPts.push({
        x: (LOGICAL_WIDTH * 0.5) + sl.scale * (rayCenterRelCamX + halfWWorld) * PROJ_HALF_WIDTH,
        y: sl.y
      });
    }

    const grad = ctx.createLinearGradient(0, nearY, 0, farY);
    grad.addColorStop(0.0, `rgba(210, 248, 255, ${a0})`);
    grad.addColorStop(0.32, `rgba(175, 240, 255, ${a1})`);
    grad.addColorStop(0.72, `rgba(140, 225, 255, ${a2})`);
    grad.addColorStop(1.0, 'rgba(140, 225, 255, 0.0)');

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(leftPts[0].x, leftPts[0].y);
    for (let i = 1; i < leftPts.length; i++) ctx.lineTo(leftPts[i].x, leftPts[i].y);
    for (let i = rightPts.length - 1; i >= 0; i--) ctx.lineTo(rightPts[i].x, rightPts[i].y);
    ctx.closePath();
    ctx.fill();
  };

  const drawSingleHeadlight = (sideSign) => {
    if (isSoftLight) {
      drawBeamPolygon(sideSign, 1.55, 1.65, 0.055, 0.028, 0.008);
      drawBeamPolygon(sideSign, 1.25, 1.28, 0.068, 0.036, 0.010);
      drawBeamPolygon(sideSign, 0.96, 0.94, 0.080, 0.042, 0.011);
      drawBeamPolygon(sideSign, 0.65, 0.56, 0.085, 0.038, 0.007);

      const sl0 = slices[0];
      const poolX = (LOGICAL_WIDTH * 0.5) + sl0.scale * (bumperRelCamX + sideSign * lampLateralWorld) * PROJ_HALF_WIDTH;
      const poolR = Math.max(12, sl0.scale * carHalfWWorld * 1.05 * PROJ_HALF_WIDTH);
      const poolGrad = ctx.createRadialGradient(poolX, sl0.y - poolR * 0.15, poolR * 0.1, poolX, sl0.y - poolR * 0.15, poolR);
      poolGrad.addColorStop(0.0, 'rgba(215, 250, 255, 0.15)');
      poolGrad.addColorStop(0.55, 'rgba(165, 238, 255, 0.06)');
      poolGrad.addColorStop(1.0, 'rgba(140, 225, 255, 0.0)');
      ctx.fillStyle = poolGrad;
      ctx.beginPath();
      ctx.ellipse(poolX, sl0.y - poolR * 0.18, poolR, poolR * 0.42, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      drawBeamPolygon(sideSign, 1.0, 1.0, 0.25, 0.12, 0.035);
    }
  };

  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  if (!leftBroken && !leftFlicker) drawSingleHeadlight(-1);
  if (!rightBroken && !rightFlicker) drawSingleHeadlight(1);
  ctx.restore();
}

function renderGuardrail(ctx, seg) {
  if (!seg.guardrailLeft && !seg.guardrailRight) return;

  const LOGICAL_WIDTH = state.logicalWidth;
  const x1 = seg.p1.screen.x;
  const y1 = seg.p1.screen.y;
  const w1 = seg.p1.screen.w;
  const x2 = seg.p2.screen.x;
  const y2 = seg.p2.screen.y;
  const w2 = seg.p2.screen.w;

  if (w1 < 2 || y2 >= y1) return;

  ctx.save();
  if (seg.clip !== null && seg.clip !== undefined) {
    ctx.beginPath();
    ctx.rect(-40, 0, LOGICAL_WIDTH + 80, seg.clip);
    ctx.clip();
  }

  const isReflectorSeg = seg.index % 2 === 0;
  const railTopColor = isReflectorSeg ? '#ffe066' : '#f8fafc';
  const railColor = isReflectorSeg ? '#ffbe0b' : '#cbd5e1';
  const railLowerColor = isReflectorSeg ? '#ff2a85' : '#64748b';

  const drawSideRail = (dir) => {
    const gx1 = x1 + dir * w1 * 1.15;
    const gx2 = x2 + dir * w2 * 1.15;
    const gxOuter1 = x1 + dir * w1 * 1.195;
    const gxOuter2 = x2 + dir * w2 * 1.195;

    const h1 = Math.max(3, w1 * 0.21);
    const h2 = Math.max(2.5, w2 * 0.21);
    const beamTop1 = y1 - h1;
    const beamBot1 = y1 - h1 * 0.42;
    const beamTop2 = y2 - h2;
    const beamBot2 = y2 - h2 * 0.42;

    renderPolygon(ctx, gx1 - dir * w1 * 0.03, y1, gxOuter1, y1, gxOuter2, y2, gx2 - dir * w2 * 0.03, y2, 'rgba(6, 2, 16, 0.45)');

    const postW = Math.max(2, w1 * 0.034);
    ctx.fillStyle = '#334155';
    ctx.fillRect(gx1 - postW * 0.5, beamTop1, postW, y1 - beamTop1);

    renderPolygon(ctx, gx1, beamBot1, gx1, y1 - h1 * 0.24, gx2, y2 - h2 * 0.24, gx2, beamBot2, railLowerColor);
    renderPolygon(ctx, gx1, beamTop1, gx1, beamBot1, gx2, beamBot2, gx2, beamTop2, railColor);
    renderPolygon(ctx, gx1, beamTop1, gxOuter1, beamTop1, gxOuter2, beamTop2, gx2, beamTop2, railTopColor);
  };

  if (seg.guardrailLeft) drawSideRail(-1);
  if (seg.guardrailRight) drawSideRail(1);

  ctx.restore();
}

function computeArchLayout(destX, destY, roadHalfPx, isStartFinish) {
  const archH = roadHalfPx * 0.72;
  const towerCenterOffset = roadHalfPx * ARCH_TOWER_OFFSET_NORM;
  const towerW = Math.max(4, roadHalfPx * 0.11);
  const sideDepthW = towerW * 0.36;
  const bannerH = archH * 0.25;
  const topY = destY - archH;
  const bannerBottomY = topY + bannerH;

  const leftTowerCenterX = destX - towerCenterOffset;
  const rightTowerCenterX = destX + towerCenterOffset;
  const leftOuterX = leftTowerCenterX - towerW * 0.5;
  const leftInnerX = leftTowerCenterX + towerW * 0.5;
  const rightInnerX = rightTowerCenterX - towerW * 0.5;
  const rightOuterX = rightTowerCenterX + towerW * 0.5;

  return {
    archH,
    towerW,
    sideDepthW,
    bannerH,
    topY,
    bannerBottomY,
    leftTowerCenterX,
    rightTowerCenterX,
    leftOuterX,
    leftInnerX,
    rightInnerX,
    rightOuterX,
    accentColor: isStartFinish ? '#39ff14' : '#00f0ff',
    secondaryColor: isStartFinish ? '#ffbe0b' : '#ff2a85',
    darkFrameColor: '#120326',
    sideShadeColor: '#080114',
    lineW: MathUtil.clamp(towerW * 0.14, 1.2, 8.0)
  };
}

function renderOverheadArchPillars(ctx, destX, destY, roadHalfPx, isStartFinish) {
  const L = computeArchLayout(destX, destY, roadHalfPx, isStartFinish);
  if (L.archH < 5 || destY < -40 || L.topY > LOGICAL_HEIGHT + 40) return;

  const shadowLen = roadHalfPx * 0.20;
  fillQuad(ctx, L.leftOuterX, destY, L.leftInnerX + L.sideDepthW, destY, L.leftInnerX + L.sideDepthW + L.towerW * 0.25, destY + shadowLen, L.leftOuterX - L.towerW * 0.15, destY + shadowLen, 'rgba(6, 2, 16, 0.45)');
  fillQuad(ctx, L.rightInnerX - L.sideDepthW, destY, L.rightOuterX, destY, L.rightOuterX + L.towerW * 0.15, destY + shadowLen, L.rightInnerX - L.sideDepthW - L.towerW * 0.25, destY + shadowLen, 'rgba(6, 2, 16, 0.45)');

  const baseW = L.towerW * 1.42;
  const baseH = Math.max(2, L.archH * 0.055);
  ctx.fillStyle = '#24183b';
  ctx.fillRect(L.leftTowerCenterX - baseW * 0.5, destY - baseH, baseW, baseH);
  ctx.fillRect(L.rightTowerCenterX - baseW * 0.5, destY - baseH, baseW, baseH);

  if (L.sideDepthW > 1.5) {
    fillQuad(ctx, L.leftInnerX, L.topY + L.bannerH, L.leftInnerX + L.sideDepthW, L.topY + L.bannerH + L.sideDepthW * 0.45, L.leftInnerX + L.sideDepthW, destY - L.sideDepthW * 0.35, L.leftInnerX, destY, L.sideShadeColor);
    fillQuad(ctx, L.rightInnerX - L.sideDepthW, L.topY + L.bannerH + L.sideDepthW * 0.45, L.rightInnerX, L.topY + L.bannerH, L.rightInnerX, destY, L.rightInnerX - L.sideDepthW, destY - L.sideDepthW * 0.35, L.sideShadeColor);
  }

  const towers = [L.leftOuterX, L.rightOuterX];
  for (let t = 0; t < towers.length; t++) {
    const tx = towers[t];
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

function renderOverheadArchPillarsClipped(ctx, scale, destX, destY, clipY, isStartFinish) {
  if (scale <= 0) return;
  const LOGICAL_WIDTH = state.logicalWidth;
  const roadHalfPx = scale * ROAD_WIDTH * PROJ_HALF_WIDTH;
  const horizontalBound = roadHalfPx * 1.55;
  if (roadHalfPx < 1.2 || destX + horizontalBound < -40 || destX - horizontalBound > LOGICAL_WIDTH + 40) {
    return;
  }

  ctx.save();
  if (clipY !== null && clipY !== undefined) {
    ctx.beginPath();
    ctx.rect(-40, 0, LOGICAL_WIDTH + 80, clipY);
    ctx.clip();
  }
  renderOverheadArchPillars(ctx, destX, destY, roadHalfPx, isStartFinish);
  ctx.restore();
}

function renderOverheadArchBeam(ctx, scale, destX, destY, clipY, isStartFinish) {
  if (scale <= 0) return;
  const LOGICAL_WIDTH = state.logicalWidth;
  const roadHalfPx = scale * ROAD_WIDTH * PROJ_HALF_WIDTH;
  const horizontalBound = roadHalfPx * 1.55;
  if (roadHalfPx < 1.2 || destX + horizontalBound < -40 || destX - horizontalBound > LOGICAL_WIDTH + 40) {
    return;
  }

  const L = computeArchLayout(destX, destY, roadHalfPx, isStartFinish);
  const soffitH = Math.max(2, L.bannerH * 0.16);
  if (L.archH < 5 || L.bannerBottomY + soffitH < -40 || L.topY > LOGICAL_HEIGHT + 40) return;

  ctx.save();
  if (clipY !== null && clipY !== undefined) {
    ctx.beginPath();
    ctx.rect(-40, 0, LOGICAL_WIDTH + 80, clipY);
    ctx.clip();
  }

  const beamOverhang = L.towerW * 0.16;
  const beamLeftX = L.leftOuterX - beamOverhang;
  const beamWidth = (L.rightOuterX + beamOverhang) - beamLeftX;

  fillQuad(ctx, beamLeftX, L.bannerBottomY, beamLeftX + beamWidth, L.bannerBottomY, beamLeftX + beamWidth - L.sideDepthW, L.bannerBottomY + soffitH, beamLeftX + L.sideDepthW, L.bannerBottomY + soffitH, L.sideShadeColor);

  ctx.fillStyle = L.darkFrameColor;
  ctx.fillRect(beamLeftX, L.topY, beamWidth, L.bannerH);

  const trimH = Math.max(1.5, L.bannerH * 0.16);
  if (isStartFinish && L.bannerH >= 8) {
    const checkCols = 16;
    const cellW = beamWidth / checkCols;
    for (let c = 0; c < checkCols; c++) {
      ctx.fillStyle = c % 2 === 0 ? '#ffffff' : '#140326';
      ctx.fillRect(beamLeftX + c * cellW, L.topY, cellW + 0.4, trimH);
      ctx.fillStyle = c % 2 === 1 ? '#ffffff' : '#140326';
      ctx.fillRect(beamLeftX + c * cellW, L.bannerBottomY - trimH, cellW + 0.4, trimH);
    }
  } else {
    ctx.fillStyle = L.secondaryColor;
    ctx.fillRect(beamLeftX, L.topY, beamWidth, trimH);
    ctx.fillRect(beamLeftX, L.bannerBottomY - trimH, beamWidth, trimH);
  }

  const rawBeaconR = L.towerW * 0.34;
  const beaconR = MathUtil.clamp(rawBeaconR, 1.5, 22);
  const beaconY = L.topY - beaconR * 0.85;
  ctx.fillStyle = L.secondaryColor;
  ctx.beginPath();
  ctx.arc(L.leftTowerCenterX, beaconY, beaconR, 0, Math.PI * 2);
  ctx.arc(L.rightTowerCenterX, beaconY, beaconR, 0, Math.PI * 2);
  ctx.fill();

  const beaconHaloFade = MathUtil.clamp((rawBeaconR - 0.5) / 1.8, 0, 1);
  if (state.settings.lightStyle === 'soft' && beaconHaloFade > 0.01) {
    const beaconSoftStops = isStartFinish
      ? [
          [0.0, 'rgba(255, 248, 200, 0.82)'],
          [0.35, 'rgba(255, 190, 11, 0.45)'],
          [1.0, 'rgba(255, 190, 11, 0.0)']
        ]
      : [
          [0.0, 'rgba(255, 220, 240, 0.82)'],
          [0.35, 'rgba(255, 42, 133, 0.48)'],
          [1.0, 'rgba(255, 42, 133, 0.0)']
        ];
    const haloBaseR = MathUtil.clamp(rawBeaconR, 1.2, 22);
    drawLightHalo(ctx, L.leftTowerCenterX, beaconY, haloBaseR, L.secondaryColor, haloBaseR * 3.2, beaconSoftStops, beaconHaloFade);
    drawLightHalo(ctx, L.rightTowerCenterX, beaconY, haloBaseR, L.secondaryColor, haloBaseR * 3.2, beaconSoftStops, beaconHaloFade);
  }

  if (L.bannerH >= 10 && L.bannerH < 420) {
    const fontSize = Math.floor(L.bannerH * 0.52);
    ctx.fillStyle = isStartFinish ? '#39ff14' : '#ffffff';
    ctx.font = `900 ${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(isStartFinish ? 'START / FINISH' : 'CHECKPOINT', destX, L.topY + L.bannerH * 0.52);
  }

  ctx.restore();
}

function renderSprite(ctx, sprite, scale, destX, destY, clipY) {
  if (scale <= 0) return;

  const LOGICAL_WIDTH = state.logicalWidth;
  const roadHalfPx = scale * ROAD_WIDTH * PROJ_HALF_WIDTH;
  const unit = roadHalfPx * SPRITE_SCALE_RATIO;
  const isFullArch = sprite.type === 'start_arch' || sprite.type === 'checkpoint_arch';
  const horizontalBound = isFullArch ? roadHalfPx * 1.55 : unit * 1.25;

  if (
    roadHalfPx < 1.2 ||
    destX + horizontalBound < -40 ||
    destX - horizontalBound > LOGICAL_WIDTH + 40 ||
    destY - unit * 1.25 > LOGICAL_HEIGHT + 40
  ) {
    return;
  }

  ctx.save();
  if (clipY !== null && clipY !== undefined) {
    ctx.beginPath();
    ctx.rect(-40, 0, LOGICAL_WIDTH + 80, clipY);
    ctx.clip();
  }

  const sunX = getSunX();
  const shadowDirX = (destX - sunX) * 0.0005;

  if (isFullArch) {
    renderOverheadArchPillars(ctx, destX, destY, roadHalfPx, sprite.type === 'start_arch');
  } else if (sprite.type === 'palm') {
    const trunkW = MathUtil.clamp(unit * 0.055, 2, 42);
    const trunkH = unit * 0.85;
    const topX = destX + (sprite.offset < 0 ? -unit * 0.06 : unit * 0.06);
    const topY = destY - trunkH;

    const shadowLen = unit * 0.34;
    ctx.strokeStyle = 'rgba(6, 2, 16, 0.42)';
    ctx.lineWidth = MathUtil.clamp(trunkW * 1.2, 2, 48);
    ctx.beginPath();
    ctx.moveTo(destX, destY);
    ctx.lineTo(destX + shadowDirX * shadowLen * 12, destY + shadowLen);
    ctx.stroke();

    ctx.strokeStyle = '#5c2c16';
    ctx.lineWidth = trunkW;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(destX, destY);
    ctx.quadraticCurveTo(destX, destY - trunkH * 0.55, topX, topY);
    ctx.stroke();

    const leafLen = unit * 0.36;
    const angles = [-2.6, -1.9, -1.2, -0.5, 0.2, 0.7];
    for (let i = 0; i < angles.length; i++) {
      const ang = angles[i] + 0.14;
      const lx = topX + Math.cos(ang) * leafLen * 0.92;
      const ly = topY + Math.sin(ang) * leafLen * 0.62 + leafLen * 0.24;
      ctx.strokeStyle = '#1b0b45';
      ctx.lineWidth = Math.max(1.5, trunkW * 0.62);
      ctx.beginPath();
      ctx.moveTo(topX, topY + trunkW * 0.35);
      ctx.quadraticCurveTo((topX + lx) * 0.5, topY - leafLen * 0.08, lx, ly);
      ctx.stroke();
    }

    for (let i = 0; i < angles.length; i++) {
      const ang = angles[i];
      const lx = topX + Math.cos(ang) * leafLen;
      const ly = topY + Math.sin(ang) * leafLen * 0.65 + leafLen * 0.18;
      ctx.strokeStyle = i % 2 === 0 ? '#00f5d4' : '#00bbf9';
      ctx.lineWidth = Math.max(1.5, trunkW * 0.65);
      ctx.beginPath();
      ctx.moveTo(topX, topY);
      ctx.quadraticCurveTo((topX + lx) * 0.5, topY - leafLen * 0.18, lx, ly);
      ctx.stroke();
    }
  } else if (sprite.type === 'lamp') {
    const poleW = MathUtil.clamp(unit * 0.028, 2, 24);
    const poleH = unit * 0.78;
    const armDir = sprite.offset < 0 ? 1 : -1;
    const armLen = unit * 0.18 * armDir;

    const shadowLen = unit * 0.28;
    ctx.strokeStyle = 'rgba(6, 2, 16, 0.40)';
    ctx.lineWidth = MathUtil.clamp(poleW * 1.1, 1.5, 26);
    ctx.beginPath();
    ctx.moveTo(destX, destY);
    ctx.lineTo(destX + shadowDirX * shadowLen * 10, destY + shadowLen);
    ctx.stroke();

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

    const lampHaloFade = MathUtil.clamp((rawLampR - 0.45) / 2.6, 0, 1);
    if (lampHaloFade > 0.01) {
      const haloBaseR = MathUtil.clamp(rawLampR, 1.1, 24);
      drawLightHalo(ctx, lampX, lampY, haloBaseR * 2.6, 'rgba(0, 240, 255, 0.22)', haloBaseR * 4.4, [
        [0.0, 'rgba(215, 252, 255, 0.72)'],
        [0.35, 'rgba(0, 240, 255, 0.34)'],
        [1.0, 'rgba(0, 240, 255, 0.0)']
      ], lampHaloFade);
    }
  } else if (sprite.type === 'billboard') {
    const boardW = unit * 0.56;
    const boardH = unit * 0.30;
    const legH = unit * 0.34;
    const bx = destX - boardW * 0.5;
    const by = destY - legH - boardH;
    const depthW = Math.max(2, boardW * 0.08);
    const sideSign = sprite.offset < 0 ? -1 : 1;

    fillQuad(ctx, bx, destY, bx + boardW, destY, bx + boardW + shadowDirX * unit * 3, destY + unit * 0.22, bx + shadowDirX * unit * 3, destY + unit * 0.22, 'rgba(6, 2, 16, 0.42)');

    ctx.fillStyle = '#4a4e69';
    const legW = Math.max(2, boardW * 0.08);
    ctx.fillRect(bx + boardW * 0.2, destY - legH, legW, legH);
    ctx.fillRect(bx + boardW * 0.72, destY - legH, legW, legH);

    const outerEdgeX = sideSign < 0 ? bx : (bx + boardW);
    fillQuad(ctx, outerEdgeX, by, outerEdgeX + sideSign * depthW, by + depthW * 0.35, outerEdgeX + sideSign * depthW, by + boardH + depthW * 0.35, outerEdgeX, by + boardH, '#090117');
    fillQuad(ctx, bx, by, bx + boardW, by, bx + boardW + (sideSign > 0 ? depthW : 0), by - depthW * 0.22, bx + (sideSign < 0 ? -depthW : 0), by - depthW * 0.22, '#2b0959');

    ctx.fillStyle = '#14042e';
    ctx.fillRect(bx, by, boardW, boardH);
    ctx.strokeStyle = '#ff2a85';
    ctx.lineWidth = MathUtil.clamp(unit * 0.015, 1.5, 10);
    ctx.strokeRect(bx, by, boardW, boardH);

    if (boardH > 12 && boardH < 420) {
      ctx.fillStyle = '#ffbe0b';
      ctx.font = `900 ${Math.floor(boardH * 0.34)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('TURBO 90', destX, by + boardH * 0.52);
    }
  } else if (sprite.type === 'chevron_left' || sprite.type === 'chevron_right') {
    const signW = unit * 0.22;
    const signH = unit * 0.18;
    const legH = unit * 0.22;
    const sx = destX - signW * 0.5;
    const sy = destY - legH - signH;
    const depthW = Math.max(1.5, signW * 0.10);
    const sideSign = sprite.offset < 0 ? -1 : 1;

    fillQuad(ctx, sx, destY, sx + signW, destY, sx + signW, destY + unit * 0.14, sx, destY + unit * 0.14, 'rgba(6, 2, 16, 0.38)');

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

  ctx.restore();
}

function render3DCar(ctx, opts) {
  const {
    isPlayer = false,
    isParkedDetach = false,
    isRival = false,
    type = 'sport',
    dir = 1,
    w = 0.185,
    h = 0.96,
    lenZ = PLAYER_LEN_Z,
    primary = '#ff2a6d',
    secondary = '#6b052c',
    worldX = 0,
    centerZ = 0,
    camZ = 0,
    yaw = 0,
    screenShiftX = 0,
    verticalOffset = 0,
    useFallback = false,
    braking = false,
    reversing = false,
    damagedByPlayer = false,
    highBeamFlashing = false,
    turnSignal = 0,
    signalElapsed = 0,
    name = '',
    num = '',
    plate = '',
    isTotalWreck = false,
    leftLightBroken = false,
    rightLightBroken = false,
    leftLightFlicker = false,
    rightLightFlicker = false,
    visualDamageLevel = 0,
    leftDamageLevel = 0,
    rightDamageLevel = 0,
    rearDamageLevel = 0,
    spoilerDamageSide = 0,
    showExhaustFlame = false,
    isSlipstreamingFlame = false,
    showBackfireFlame = false
  } = opts;

  const LOGICAL_WIDTH = state.logicalWidth;
  const trackLength = state.trackLength;
  const halfLen = lenZ * 0.5;
  if (camZ + halfLen <= MIN_CAR_CAM_Z) return;

  const effectiveNearOffset = Math.min(halfLen, Math.max(-halfLen, camZ - MIN_CAR_CAM_Z));
  const clippedRear = halfLen - effectiveNearOffset;
  const nearFrac = clippedRear / lenZ;
  const visibleSpanFrac = Math.max(0.02, 1 - nearFrac);

  const zNear = (((centerZ - effectiveNearOffset) % trackLength) + trackLength) % trackLength;
  const zFar = (((centerZ + halfLen) % trackLength) + trackLength) % trackLength;

  const fallbackSample = (targetCamZ) => {
    const safeZ = Math.max(MIN_CAR_CAM_Z, targetCamZ);
    const effectiveCamX = (state.playerX - state.cameraLagX) * ROAD_WIDTH;
    const scale = state.activeCameraDepth / safeZ;
    return {
      scale,
      roadCenterX: (LOGICAL_WIDTH * 0.5) + scale * (-effectiveCamX) * PROJ_HALF_WIDTH,
      roadY: (LOGICAL_HEIGHT * 0.5) + state.cameraPitch - scale * (-CAMERA_HEIGHT) * (LOGICAL_HEIGHT * 0.5),
      clipY: LOGICAL_HEIGHT
    };
  };

  const near = sampleRoadAtZ(zNear) || (useFallback ? fallbackSample(camZ - effectiveNearOffset) : null);
  const far = sampleRoadAtZ(zFar) || (useFallback ? fallbackSample(camZ + halfLen) : null);
  if (!near || !far || near.scale <= 0 || far.scale <= 0) return;

  const yawSlope = Math.tan(yaw);
  const nearWorldX = worldX - effectiveNearOffset * yawSlope;
  const farWorldX = worldX + halfLen * yawSlope;

  const cxNear = near.roadCenterX + near.scale * nearWorldX * PROJ_HALF_WIDTH + screenShiftX;
  const cyNear = near.roadY + verticalOffset;
  const wNear = w * near.scale * ROAD_WIDTH * PROJ_HALF_WIDTH;
  const hNear = wNear * 0.58 * h;

  const cxFar = far.roadCenterX + far.scale * farWorldX * PROJ_HALF_WIDTH + screenShiftX;
  const cyFar = far.roadY + verticalOffset;
  const wFar = w * far.scale * ROAD_WIDTH * PROJ_HALF_WIDTH;
  const hFar = wFar * 0.58 * h;

  if (
    wNear < 2.2 ||
    Math.max(cxNear + wNear, cxFar + wFar) < -40 ||
    Math.min(cxNear - wNear, cxFar - wFar) > LOGICAL_WIDTH + 40 ||
    Math.min(cyNear - hNear * 1.15, cyFar - hFar * 1.15) > LOGICAL_HEIGHT + 40
  ) {
    return;
  }

  const clipY = near.clipY !== null && near.clipY !== undefined ? near.clipY : LOGICAL_HEIGHT;

  ctx.save();
  if (!isPlayer || isParkedDetach) {
    ctx.beginPath();
    ctx.rect(-40, 0, LOGICAL_WIDTH + 80, clipY);
    ctx.clip();
  }

  // Перспективно-корректная интерполяция (1/z) вдоль длины автомобиля
  const sec = (t) => {
    const u = MathUtil.clamp((t - nearFrac) / visibleSpanFrac, 0, 1);
    const denom = Math.max(1e-6, (1 - u) * far.scale + u * near.scale);
    const uProj = (u * near.scale) / denom;
    return {
      t,
      cx: MathUtil.lerp(cxNear, cxFar, uProj),
      cy: MathUtil.lerp(cyNear, cyFar, uProj),
      w: MathUtil.lerp(wNear, wFar, uProj),
      h: MathUtil.lerp(hNear, hFar, uProj)
    };
  };

  const isVan = type === 'van';
  const BODY_CLEARANCE = isVan ? 0.20 : 0.22;
  const BUMPER_TOP = dir === -1 ? (BODY_CLEARANCE + 0.12) : (BODY_CLEARANCE + 0.13);
  const BODY_MID = 0.40;
  const BODY_SHOULDER = 0.59;
  const GLASS_BOT = 0.63;
  const GLASS_TOP = 0.92;
  const ROOF_TOP = 0.98;

  const profile = CAR_BODY_PROFILES[type] || CAR_BODY_PROFILES.coupe;
  let { tCR, tRR, tRF, tCF, roofHalfFrac, tAxleNear, tAxleFar, dtWheel, wheelRFrac } = profile;

  // Зеркалируем продольные пропорции кузова и осей для встречных машин (передок обращён к камере)
  if (dir === -1) {
    const origCR = tCR;
    const origRR = tRR;
    const origRF = tRF;
    const origCF = tCF;
    tCR = 1 - origCF;
    tRR = 1 - origRF;
    tRF = 1 - origRR;
    tCF = 1 - origCR;

    const origNearAxle = tAxleNear;
    tAxleNear = 1 - tAxleFar;
    tAxleFar = 1 - origNearAxle;
  }

  const showRearPanel = nearFrac < 0.03;

  const s0 = sec(Math.max(0.0, nearFrac));
  const saNearAxle = sec(Math.max(tAxleNear, nearFrac));
  const sCabinRear = sec(Math.max(tCR, nearFrac));
  const sRoofRear = sec(Math.max(tRR, nearFrac));
  const sRoofFront = sec(Math.max(tRF, nearFrac));
  const sCabinFront = sec(Math.max(tCF, nearFrac));
  const s1 = sec(1.0);

  if (isPlayer && !isParkedDetach) {
    const a = state.playerScreenAnchors;
    a.rearCenterX = s0.cx;
    a.rearCenterY = s0.cy - s0.h * 0.36;
    a.rearGroundY = s0.cy;
    a.centerX = (s0.cx + s1.cx) * 0.5;
    a.centerY = (s0.cy + s1.cy) * 0.5 - s0.h * 0.36;
    a.hoodY = s0.cy - s0.h * BODY_SHOULDER;
    a.carW = s0.w;
    a.carH = s0.h;
    a.leftWheelX = saNearAxle.cx - saNearAxle.w * 0.38;
    a.leftWheelY = saNearAxle.cy - 2;
    a.rightWheelX = saNearAxle.cx + saNearAxle.w * 0.38;
    a.rightWheelY = saNearAxle.cy - 2;
    a.exhaustLeftX = s0.cx - s0.w * 0.26;
    a.exhaustRightX = s0.cx + s0.w * 0.26;
    a.exhaustY = s0.cy - s0.h * (BODY_CLEARANCE + 0.03);
  }

  // 1. Контактная тень под днищем (вытягивается строго вдоль 3D-оси кузова s0 -> s1)
  const shadowHalfW = 0.505;
  const invSpan = 1 / Math.max(0.25, visibleSpanFrac);
  const shadowAxisDx = (s1.cx - s0.cx) * invSpan;
  const shadowAxisDy = Math.min(-Math.max(1.2, s1.h * 0.18), (s1.cy - s0.cy) * invSpan);
  const rearExtFactor = showRearPanel ? 1 : 0;
  const baseRearExt = rearExtFactor * 0.10;
  const baseFrontExt = 0.12;

  const shRearBaseW = s0.w * (showRearPanel ? 1.02 : 1.0);
  const shFrontBaseW = s1.w * 1.01;

  if (state.settings.lightStyle === 'soft') {
    const layers = wNear >= 14 ? SOFT_SHADOW_LAYERS : SOFT_SHADOW_FAR_LAYERS;
    for (let l = 0; l < layers.length; l++) {
      const layer = layers[l];
      const hwNear = shRearBaseW * (shadowHalfW + layer.wPad);
      const hwFar = shFrontBaseW * (shadowHalfW + layer.wPad);
      const rExt = rearExtFactor * (baseRearExt + layer.rExt);
      const fExt = baseFrontExt + layer.fExt;
      const rearCx = s0.cx - shadowAxisDx * rExt;
      const rearY = s0.cy - shadowAxisDy * rExt;
      const frontCx = s1.cx + shadowAxisDx * fExt;
      const frontY = s1.cy + shadowAxisDy * fExt;
      fillRoundedQuad(
        ctx,
        rearCx - hwNear, rearY,
        rearCx + hwNear, rearY,
        frontCx + hwFar, frontY,
        frontCx - hwFar, frontY,
        layer.round,
        layer.color
      );
    }
  } else {
    const shRearCx = s0.cx - shadowAxisDx * baseRearExt;
    const shRearY = s0.cy - shadowAxisDy * baseRearExt;
    const shFrontCx = s1.cx + shadowAxisDx * baseFrontExt;
    const shFrontY = s1.cy + shadowAxisDy * baseFrontExt;
    fillQuad(
      ctx,
      shRearCx - shRearBaseW * shadowHalfW, shRearY,
      shRearCx + shRearBaseW * shadowHalfW, shRearY,
      shFrontCx + shFrontBaseW * shadowHalfW, shFrontY,
      shFrontCx - shFrontBaseW * shadowHalfW, shFrontY,
      'rgba(7, 2, 18, 0.40)'
    );
  }

  const lateralDeltaX = s1.cx - s0.cx;
  const flankOrder = lateralDeltaX >= 0 ? [-1, 1] : [1, -1];
  const visibleFlankSign = flankOrder[1];
  const axleOrder = [tAxleFar, tAxleNear];

  const BODY_W_BOT = 0.466;
  const BODY_W_BUMPER_TOP = 0.468;
  const BODY_W_MID = 0.470;
  const BODY_W_TOP = 0.468;
  const flankVisibility = MathUtil.clamp(Math.abs(lateralDeltaX) / Math.max(1, wNear * 0.42), 0, 1);

  const flankLowerColor = MathUtil.shadeHex(secondary, 0.88);
  const flankUpperColor = MathUtil.shadeHex(primary, 0.88);
  const roofColor = MathUtil.shadeHex(primary, 1.18);
  const deckColor = MathUtil.shadeHex(primary, 1.04);
  const pillarFrameColor = MathUtil.shadeHex(primary, 0.94);
  const innerGlassRoofFrac = roofHalfFrac * 0.80;

  const getFlankSpanPx = (sideSign) => {
    const edge0X = s0.cx + sideSign * s0.w * BODY_W_TOP;
    const edge1X = s1.cx + sideSign * s1.w * BODY_W_TOP;
    return sideSign * (edge1X - edge0X);
  };

  const visibleFlankSpanPx = getFlankSpanPx(visibleFlankSign);
  const showVisibleFlank = visibleFlankSpanPx > 0.35;

  // Расчёт точной 3D-геометрии колеса на оси tAxle в перспективе кузова
  const tireOuterFrac = 0.460;
  const tireWidthFrac = (isPlayer || isRival)
    ? 0.148
    : (isVan ? 0.128 : (type === 'sport' ? 0.140 : 0.130));
  const tireInnerFrac = tireOuterFrac - tireWidthFrac;

  const computeWheelMetrics = (sideSign, tAxle) => {
    if (tAxle < nearFrac) return null;
    const sa = sec(tAxle);
    const wheelR = Math.min(sa.h * 0.28, Math.max(0.5, sa.h * wheelRFrac));
    const t1 = Math.max(nearFrac, tAxle - dtWheel);
    const t2 = Math.min(1.0, tAxle + dtWheel);
    const spanT = Math.max(0.01, t2 - t1);
    const sBack = sec(t1);
    const sFront = sec(t2);
    const halfScale = dtWheel / spanT;

    const ox = sa.cx + sideSign * sa.w * tireOuterFrac;
    const oy = sa.cy - wheelR;
    const ix = sa.cx + sideSign * sa.w * tireInnerFrac;
    const iy = oy;

    const uxOut = ((sFront.cx + sideSign * sFront.w * tireOuterFrac) - (sBack.cx + sideSign * sBack.w * tireOuterFrac)) * halfScale;
    const uxIn = ((sFront.cx + sideSign * sFront.w * tireInnerFrac) - (sBack.cx + sideSign * sBack.w * tireInnerFrac)) * halfScale;
    const uy = (sFront.cy - sBack.cy) * halfScale;

    return { sa, wheelR, ox, oy, ix, iy, uxOut, uxIn, uy };
  };

  // Отрисовка 3D-цилиндра протектора колеса строго по высоте и координатам боковой проекции
  const drawWheelTread = (sideSign, tAxle) => {
    const m = computeWheelMetrics(sideSign, tAxle);
    if (!m) return;

    const H = Math.hypot(m.uy, m.wheelR);
    const cosExt = m.uy / Math.max(1e-4, H);

    let topOutX = m.ox - m.uxOut * cosExt;
    const topOutY = m.oy - H;
    let botOutX = m.ox + m.uxOut * cosExt;
    const botOutY = m.oy + H;
    let topInX = m.ix - m.uxIn * cosExt;
    const topInY = m.iy - H;
    let botInX = m.ix + m.uxIn * cosExt;
    const botInY = m.iy + H;

    // Минимальный анти-субпиксельный порог на предельной дистанции (пропорциональный ширине кузова)
    const treadW = Math.abs(botOutX - botInX);
    const minTreadW = Math.min(0.9, m.sa.w * 0.16);
    if (treadW < minTreadW) {
      const halfPad = (minTreadW - treadW) * 0.5 * sideSign;
      botOutX += halfPad;
      botInX -= halfPad;
      topOutX += halfPad;
      topInX -= halfPad;
    }

    if (wNear >= 12 && Math.abs(m.uxIn) > 0.6) {
      ctx.save();
      ctx.transform(m.uxIn, m.uy, 0, -m.wheelR, m.ix, m.iy);
      ctx.fillStyle = '#07050e';
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    const treadColor = wNear < 26 ? '#171326' : '#0b0816';
    fillQuad(ctx, topInX, topInY, topOutX, topOutY, botOutX, botOutY, botInX, botInY, treadColor);

    if (wNear >= 12 && Math.abs(m.uxOut) > 0.6) {
      ctx.save();
      ctx.transform(m.uxOut, m.uy, 0, -m.wheelR, m.ox, m.oy);
      ctx.fillStyle = '#100c1c';
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  };

  // Отрисовка перспективных колёсных арок, боковин шин и дисков на видимом борту (сохраняются и на удалении)
  const drawSideWheelsAndArches = (sideSign) => {
    if (wNear < 4.5 || !showVisibleFlank) return;

    const archR = 1.18;
    const ySill = (BODY_CLEARANCE / wheelRFrac) - 1;
    const startAng = Math.asin(MathUtil.clamp(ySill / archR, -0.35, 0.72));
    const maxFlankRx = visibleFlankSpanPx * 0.24;

    for (let a = 0; a < axleOrder.length; a++) {
      const m = computeWheelMetrics(sideSign, axleOrder[a]);
      if (!m) continue;

      const absUx = Math.abs(m.uxOut);
      const uxSign = m.uxOut < 0 ? -1 : (m.uxOut > 0 ? 1 : (lateralDeltaX >= 0 ? 1 : -1));
      const minVisibleRx = Math.min(maxFlankRx, m.wheelR * 0.38);
      const effUxMag = Math.max(absUx, minVisibleRx);
      if (effUxMag < 0.35) continue;
      const effUx = uxSign * effUxMag;

      ctx.save();
      ctx.transform(effUx, m.uy, 0, -m.wheelR, m.ox, m.oy);

      // Полукруглый вырез колёсной арки начинается строго от кромки порога, не закрывая дорожный просвет
      ctx.fillStyle = '#05030a';
      ctx.beginPath();
      ctx.arc(0, 0, archR, startAng, Math.PI - startAng, false);
      ctx.closePath();
      ctx.fill();

      const prevWheelAlpha = ctx.globalAlpha;

      // Плавное проявление кромки арки без резкого скачка при приближении
      const archRimAlpha = MathUtil.clamp((wNear - 14) / 14, 0, 1) * MathUtil.clamp((effUxMag - 0.9) / 1.2, 0, 1);
      if (archRimAlpha > 0.01) {
        ctx.globalAlpha = prevWheelAlpha * archRimAlpha;
        ctx.strokeStyle = MathUtil.shadeHex(primary, 1.12);
        ctx.lineWidth = 0.065;
        ctx.beginPath();
        ctx.arc(0, 0, archR + 0.03, startAng + 0.14, Math.PI - startAng - 0.14, false);
        ctx.stroke();
        ctx.globalAlpha = prevWheelAlpha;
      }

      // Боковина шины в перспективе
      ctx.fillStyle = '#141022';
      ctx.beginPath();
      ctx.arc(0, 0, 1.0, 0, Math.PI * 2);
      ctx.fill();

      // Плавное масштабирование и проявление диска/колпака и ступицы ещё на дальней дистанции
      const rimAlpha = MathUtil.clamp((effUxMag - 0.35) / 0.85, 0, 1) * MathUtil.clamp((m.wheelR - 0.85) / 1.35, 0, 1);
      if (rimAlpha > 0.01) {
        ctx.globalAlpha = prevWheelAlpha * rimAlpha;
        ctx.fillStyle = '#9aa5b1';
        ctx.beginPath();
        ctx.arc(0, 0, 0.56, 0, Math.PI * 2);
        ctx.fill();

        const hubAlpha = rimAlpha * MathUtil.clamp((effUxMag - 1.1) / 1.4, 0, 1) * MathUtil.clamp((m.wheelR - 2.2) / 2.2, 0, 1);
        if (hubAlpha > 0.01) {
          ctx.globalAlpha = prevWheelAlpha * hubAlpha;
          ctx.fillStyle = '#334155';
          ctx.beginPath();
          ctx.arc(0, 0, 0.22, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = prevWheelAlpha;
      }

      ctx.restore();
    }
  };

  // Отрисовка цельной ровной видимой боковины кузова (поднятой на BODY_CLEARANCE над асфальтом)
  const drawLowerFlank = (sideSign) => {
    if (!showVisibleFlank) return;

    fillQuad(
      ctx,
      s0.cx + sideSign * s0.w * BODY_W_BOT, s0.cy - s0.h * BODY_CLEARANCE,
      s1.cx + sideSign * s1.w * BODY_W_BOT, s1.cy - s1.h * BODY_CLEARANCE,
      s1.cx + sideSign * s1.w * BODY_W_MID, s1.cy - s1.h * BODY_MID,
      s0.cx + sideSign * s0.w * BODY_W_MID, s0.cy - s0.h * BODY_MID,
      flankLowerColor
    );
    fillQuad(
      ctx,
      s0.cx + sideSign * s0.w * BODY_W_MID, s0.cy - s0.h * BODY_MID,
      s1.cx + sideSign * s1.w * BODY_W_MID, s1.cy - s1.h * BODY_MID,
      s1.cx + sideSign * s1.w * BODY_W_TOP, s1.cy - s1.h * BODY_SHOULDER,
      s0.cx + sideSign * s0.w * BODY_W_TOP, s0.cy - s0.h * BODY_SHOULDER,
      flankUpperColor
    );

    if (wNear >= 14) {
      ctx.strokeStyle = MathUtil.shadeHex(secondary, 1.18);
      ctx.lineWidth = MathUtil.clamp(wNear * 0.009, 0.9, 3.5);
      ctx.beginPath();
      ctx.moveTo(s0.cx + sideSign * s0.w * BODY_W_BOT, s0.cy - s0.h * BODY_CLEARANCE);
      ctx.lineTo(s1.cx + sideSign * s1.w * BODY_W_BOT, s1.cy - s1.h * BODY_CLEARANCE);
      ctx.stroke();
    }

    const rearWrapEndT = Math.min(0.11, Math.max(0.04, tAxleNear - dtWheel * 1.04));
    const sRearBumper = sec(Math.max(rearWrapEndT, nearFrac));
    if (sRearBumper.t > s0.t + 0.004) {
      fillQuad(
        ctx,
        s0.cx + sideSign * s0.w * BODY_W_BOT, s0.cy - s0.h * BODY_CLEARANCE,
        sRearBumper.cx + sideSign * sRearBumper.w * BODY_W_BOT, sRearBumper.cy - sRearBumper.h * BODY_CLEARANCE,
        sRearBumper.cx + sideSign * sRearBumper.w * BODY_W_BUMPER_TOP, sRearBumper.cy - sRearBumper.h * BUMPER_TOP,
        s0.cx + sideSign * s0.w * BODY_W_BUMPER_TOP, s0.cy - s0.h * BUMPER_TOP,
        '#151124'
      );
    }

    const frontWrapStartT = Math.max(0.89, Math.min(0.96, tAxleFar + dtWheel * 1.04));
    const sFrontBumper = sec(Math.max(frontWrapStartT, nearFrac));
    if (s1.t > sFrontBumper.t + 0.004) {
      const farBumperTop = dir === -1 ? (BODY_CLEARANCE + 0.13) : (BODY_CLEARANCE + 0.12);
      fillQuad(
        ctx,
        sFrontBumper.cx + sideSign * sFrontBumper.w * BODY_W_BOT, sFrontBumper.cy - sFrontBumper.h * BODY_CLEARANCE,
        s1.cx + sideSign * s1.w * BODY_W_BOT, s1.cy - s1.h * BODY_CLEARANCE,
        s1.cx + sideSign * s1.w * BODY_W_BUMPER_TOP, s1.cy - s1.h * farBumperTop,
        sFrontBumper.cx + sideSign * sFrontBumper.w * BODY_W_BUMPER_TOP, sFrontBumper.cy - sFrontBumper.h * farBumperTop,
        '#151124'
      );
    }

    if (isPlayer && wNear >= 24 && flankVisibility > 0.14) {
      const sideDmg = sideSign < 0 ? leftDamageLevel : rightDamageLevel;
      if (sideDmg >= 1) {
        const sScrapeA = sec(Math.max(nearFrac, 0.30));
        const sScrapeB = sec(Math.max(nearFrac, sideDmg >= 2 ? 0.72 : 0.56));
        if (sScrapeB.t > sScrapeA.t + 0.03) {
          ctx.strokeStyle = 'rgba(220, 228, 242, 0.42)';
          ctx.lineWidth = MathUtil.clamp(wNear * 0.012, 1.0, 4.0);
          ctx.beginPath();
          ctx.moveTo(sScrapeA.cx + sideSign * sScrapeA.w * BODY_W_MID, sScrapeA.cy - sScrapeA.h * 0.44);
          ctx.lineTo(sScrapeB.cx + sideSign * sScrapeB.w * BODY_W_MID, sScrapeB.cy - sScrapeB.h * 0.46);
          ctx.stroke();
          if (sideDmg >= 2) {
            ctx.strokeStyle = 'rgba(28, 4, 16, 0.55)';
            ctx.lineWidth = MathUtil.clamp(wNear * 0.010, 1.0, 3.5);
            ctx.beginPath();
            ctx.moveTo(sScrapeA.cx + sideSign * sScrapeA.w * BODY_W_BUMPER_TOP, sScrapeA.cy - sScrapeA.h * 0.40);
            ctx.lineTo(sScrapeB.cx + sideSign * sScrapeB.w * BODY_W_BUMPER_TOP, sScrapeB.cy - sScrapeB.h * 0.42);
            ctx.stroke();
          }
        }
      }
    }

    ctx.strokeStyle = MathUtil.shadeHex(primary, 1.15);
    ctx.lineWidth = MathUtil.clamp(wNear * 0.011, 1.0, 4.0);
    ctx.beginPath();
    ctx.moveTo(s0.cx + sideSign * s0.w * BODY_W_TOP, s0.cy - s0.h * BODY_SHOULDER);
    ctx.lineTo(s1.cx + sideSign * s1.w * BODY_W_TOP, s1.cy - s1.h * BODY_SHOULDER);
    ctx.stroke();
  };

  // Отрисовка верхней боковины кабины и боковых стёкол (поверх капота и дальнего стекла)
  const drawCabinFlankAndWindow = (sideSign) => {
    if (nearFrac >= tCF) return;

    const cAx = sCabinRear.cx + sideSign * sCabinRear.w * BODY_W_TOP;
    const cAy = sCabinRear.cy - sCabinRear.h * BODY_SHOULDER;
    const cBx = sCabinFront.cx + sideSign * sCabinFront.w * BODY_W_TOP;
    const cBy = sCabinFront.cy - sCabinFront.h * BODY_SHOULDER;
    const cCx = sRoofFront.cx + sideSign * sRoofFront.w * roofHalfFrac;
    const cCy = sRoofFront.cy - sRoofFront.h * ROOF_TOP;
    const cDx = sRoofRear.cx + sideSign * sRoofRear.w * roofHalfFrac;
    const cDy = sRoofRear.cy - sRoofRear.h * ROOF_TOP;

    const cross = (cBx - cAx) * (cDy - cAy) - (cBy - cAy) * (cDx - cAx);
    if (sideSign * cross >= -0.5) return;

    fillQuad(ctx, cAx, cAy, cBx, cBy, cCx, cCy, cDx, cDy, flankUpperColor);

    const cabinPt = (u, v) => {
      const tRearU = MathUtil.lerp(tCR, tRR, u);
      const tFrontU = MathUtil.lerp(tCF, tRF, u);
      const spanU = Math.max(0.001, tFrontU - tRearU);
      const vClamped = Math.max(v, (nearFrac - tRearU) / spanU);
      const t = MathUtil.lerp(tRearU, tFrontU, MathUtil.clamp(vClamped, 0, 1));
      const s = sec(t);
      const hFrac = MathUtil.lerp(BODY_SHOULDER, ROOF_TOP, u);
      const wFrac = MathUtil.lerp(BODY_W_TOP, roofHalfFrac, u);
      return { x: s.cx + sideSign * s.w * wFrac, y: s.cy - s.h * hFrac, t };
    };

    const uBot = 0.16;
    const uTop = 0.84;
    const vRear = isVan ? 0.09 : 0.16;
    const vFront = isVan ? 0.91 : 0.83;

    const pBL = cabinPt(uBot, vRear);
    const pBR = cabinPt(uBot, vFront);
    const pTR = cabinPt(uTop, vFront);
    const pTL = cabinPt(uTop, vRear);

    if (pBR.t > pBL.t + 0.025 && pTR.t > pTL.t + 0.025) {
      const glassTopY = Math.min(pTL.y, pTR.y);
      const glassBotY = Math.max(pBL.y, pBR.y);
      const glassGrad = ctx.createLinearGradient(0, glassTopY, 0, glassBotY);
      if (dir === -1) {
        glassGrad.addColorStop(0.0, '#48cae4');
        glassGrad.addColorStop(0.45, '#1b4965');
        glassGrad.addColorStop(1.0, '#0b132b');
      } else {
        glassGrad.addColorStop(0.0, '#2c7da0');
        glassGrad.addColorStop(0.45, '#162647');
        glassGrad.addColorStop(1.0, '#091124');
      }

      fillQuad(ctx, pBL.x, pBL.y, pBR.x, pBR.y, pTR.x, pTR.y, pTL.x, pTL.y, glassGrad);

      if (wNear >= 12) {
        const rBL = cabinPt(uBot, MathUtil.lerp(vRear, vFront, 0.24));
        const rBR = cabinPt(uBot, MathUtil.lerp(vRear, vFront, 0.44));
        const rTR = cabinPt(uTop, MathUtil.lerp(vRear, vFront, 0.55));
        const rTL = cabinPt(uTop, MathUtil.lerp(vRear, vFront, 0.35));
        if (rBR.t > rBL.t + 0.008 && rTR.t > rTL.t + 0.008) {
          fillQuad(ctx, rBL.x, rBL.y, rBR.x, rBR.y, rTR.x, rTR.y, rTL.x, rTL.y, 'rgba(210, 244, 255, 0.36)');
        }
      }

      if (wNear >= 13 && type !== 'coupe') {
        const pillarFracs = isVan ? [0.36, 0.68] : [0.50];
        const halfPillarV = isVan ? 0.028 : 0.034;
        const uPillarBot = uBot - 0.015;
        const uPillarTop = uTop + 0.015;
        for (let p = 0; p < pillarFracs.length; p++) {
          const vCenter = MathUtil.lerp(vRear, vFront, pillarFracs[p]);
          const p1 = cabinPt(uPillarBot, vCenter - halfPillarV);
          const p2 = cabinPt(uPillarBot, vCenter + halfPillarV);
          const p3 = cabinPt(uPillarTop, vCenter + halfPillarV);
          const p4 = cabinPt(uPillarTop, vCenter - halfPillarV);
          if (p2.t > p1.t + 0.004 && p3.t > p4.t + 0.004) {
            fillQuad(ctx, p1.x, p1.y, p2.x, p2.y, p3.x, p3.y, p4.x, p4.y, flankUpperColor);
          }
        }
      }
    }
  };

  // 2. Протекторы всех 4 колёс под днищем (до отрисовки борта и кормы)
  for (let a = 0; a < axleOrder.length; a++) {
    drawWheelTread(flankOrder[0], axleOrder[a]);
    drawWheelTread(visibleFlankSign, axleOrder[a]);
  }

  // 3. Дальние верхние плоскости: капот (или багажник встречки) и дальнее стекло
  fillQuad(ctx, sCabinFront.cx - sCabinFront.w * BODY_W_TOP, sCabinFront.cy - sCabinFront.h * BODY_SHOULDER, sCabinFront.cx + sCabinFront.w * BODY_W_TOP, sCabinFront.cy - sCabinFront.h * BODY_SHOULDER, s1.cx + s1.w * BODY_W_TOP, s1.cy - s1.h * BODY_SHOULDER, s1.cx - s1.w * BODY_W_TOP, s1.cy - s1.h * BODY_SHOULDER, deckColor);

  if (nearFrac < tCF) {
    fillQuad(ctx, sRoofFront.cx - sRoofFront.w * roofHalfFrac, sRoofFront.cy - sRoofFront.h * ROOF_TOP, sRoofFront.cx + sRoofFront.w * roofHalfFrac, sRoofFront.cy - sRoofFront.h * ROOF_TOP, sCabinFront.cx + sCabinFront.w * BODY_W_TOP, sCabinFront.cy - sCabinFront.h * BODY_SHOULDER, sCabinFront.cx - sCabinFront.w * BODY_W_TOP, sCabinFront.cy - sCabinFront.h * BODY_SHOULDER, pillarFrameColor);
    fillQuad(ctx, sRoofFront.cx - sRoofFront.w * innerGlassRoofFrac, sRoofFront.cy - sRoofFront.h * GLASS_TOP, sRoofFront.cx + sRoofFront.w * innerGlassRoofFrac, sRoofFront.cy - sRoofFront.h * GLASS_TOP, sCabinFront.cx + sCabinFront.w * 0.375, sCabinFront.cy - sCabinFront.h * GLASS_BOT, sCabinFront.cx - sCabinFront.w * 0.375, sCabinFront.cy - sCabinFront.h * GLASS_BOT, dir === -1 ? '#1d3557' : '#48cae4');
  }

  // 4. Видимая нижняя боковина и её перспективные колёсные арки с дисками
  drawLowerFlank(visibleFlankSign);
  drawSideWheelsAndArches(visibleFlankSign);

  // 5. Крыша
  if (nearFrac < tRF) {
    fillQuad(ctx, sRoofRear.cx - sRoofRear.w * roofHalfFrac, sRoofRear.cy - sRoofRear.h * ROOF_TOP, sRoofRear.cx + sRoofRear.w * roofHalfFrac, sRoofRear.cy - sRoofRear.h * ROOF_TOP, sRoofFront.cx + sRoofFront.w * roofHalfFrac, sRoofFront.cy - sRoofFront.h * ROOF_TOP, sRoofFront.cx - sRoofFront.w * roofHalfFrac, sRoofFront.cy - sRoofFront.h * ROOF_TOP, roofColor);
  }

  // 6. Видимые боковины кабины и боковые стёкла
  for (let f = 0; f < 2; f++) {
    drawCabinFlankAndWindow(flankOrder[f]);
  }

  // 7. Ближнее стекло (заднее для попутных, лобовое для встречных)
  if (nearFrac < tRR) {
    fillQuad(ctx, sCabinRear.cx - sCabinRear.w * BODY_W_TOP, sCabinRear.cy - sCabinRear.h * BODY_SHOULDER, sCabinRear.cx + sCabinRear.w * BODY_W_TOP, sCabinRear.cy - sCabinRear.h * BODY_SHOULDER, sRoofRear.cx + sRoofRear.w * roofHalfFrac, sRoofRear.cy - sRoofRear.h * ROOF_TOP, sRoofRear.cx - sRoofRear.w * roofHalfFrac, sRoofRear.cy - sRoofRear.h * ROOF_TOP, pillarFrameColor);

    const glassBotY = sCabinRear.cy - sCabinRear.h * GLASS_BOT;
    const glassTopY = sRoofRear.cy - sRoofRear.h * GLASS_TOP;
    const nearGlassGrad = ctx.createLinearGradient(0, glassTopY, 0, glassBotY);
    if (dir === -1) {
      nearGlassGrad.addColorStop(0.0, '#90e0ef');
      nearGlassGrad.addColorStop(0.55, '#0096c7');
      nearGlassGrad.addColorStop(1.0, '#14213d');
    } else {
      nearGlassGrad.addColorStop(0.0, '#4cc9f0');
      nearGlassGrad.addColorStop(0.45, '#1d4e89');
      nearGlassGrad.addColorStop(1.0, '#102542');
    }

    fillQuad(ctx, sCabinRear.cx - sCabinRear.w * 0.375, glassBotY, sCabinRear.cx + sCabinRear.w * 0.375, glassBotY, sRoofRear.cx + sRoofRear.w * innerGlassRoofFrac, glassTopY, sRoofRear.cx - sRoofRear.w * innerGlassRoofFrac, glassTopY, nearGlassGrad);

    if (wNear > 18) {
      const glShift = MathUtil.clamp(yaw * 0.35, -0.14, 0.14);
      fillQuad(ctx, sCabinRear.cx + sCabinRear.w * (-0.11 + glShift), sCabinRear.cy - sCabinRear.h * (GLASS_BOT + 0.015), sCabinRear.cx + sCabinRear.w * (0.07 + glShift), sCabinRear.cy - sCabinRear.h * (GLASS_BOT + 0.015), sRoofRear.cx + sRoofRear.w * (0.03 + glShift), sRoofRear.cy - sRoofRear.h * (GLASS_TOP - 0.015), sRoofRear.cx + sRoofRear.w * (-0.09 + glShift), sRoofRear.cy - sRoofRear.h * (GLASS_TOP - 0.015), dir === -1 ? 'rgba(255, 255, 255, 0.42)' : 'rgba(255, 224, 178, 0.34)');
    }

    if (isPlayer && visualDamageLevel >= 1 && wNear > 22) {
      const crackLeft = spoilerDamageSide !== 0
        ? spoilerDamageSide < 0
        : (leftDamageLevel >= rightDamageLevel);
      const impactX = crackLeft ? (sCabinRear.cx - sCabinRear.w * 0.18) : (sCabinRear.cx + sCabinRear.w * 0.18);
      const impactY = MathUtil.lerp(glassBotY, glassTopY, 0.42);

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(sCabinRear.cx - sCabinRear.w * 0.375, glassBotY);
      ctx.lineTo(sCabinRear.cx + sCabinRear.w * 0.375, glassBotY);
      ctx.lineTo(sRoofRear.cx + sRoofRear.w * innerGlassRoofFrac, glassTopY);
      ctx.lineTo(sRoofRear.cx - sRoofRear.w * innerGlassRoofFrac, glassTopY);
      ctx.closePath();
      ctx.clip();

      ctx.strokeStyle = 'rgba(220, 245, 255, 0.78)';
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      const rays = [
        [-0.14, -0.22], [0.16, -0.18], [-0.18, 0.14],
        [0.14, 0.16], [0.02, -0.25], [-0.05, 0.18]
      ];
      const rayCount = Math.min(rays.length, 2 + visualDamageLevel);
      for (let r = 0; r < rayCount; r++) {
        ctx.moveTo(impactX, impactY);
        ctx.lineTo(impactX + rays[r][0] * sCabinRear.w, impactY + rays[r][1] * sCabinRear.h);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  // 8. Ближняя палуба (багажник для попутных, капот для встречных)
  if (nearFrac < tCR) {
    fillQuad(ctx, s0.cx - s0.w * BODY_W_TOP, s0.cy - s0.h * BODY_SHOULDER, s0.cx + s0.w * BODY_W_TOP, s0.cy - s0.h * BODY_SHOULDER, sCabinRear.cx + sCabinRear.w * BODY_W_TOP, sCabinRear.cy - sCabinRear.h * BODY_SHOULDER, sCabinRear.cx - sCabinRear.w * BODY_W_TOP, sCabinRear.cy - sCabinRear.h * BODY_SHOULDER, deckColor);

    if (isPlayer && visualDamageLevel >= 1 && wNear > 24) {
      const deckY0 = s0.cy - s0.h * BODY_SHOULDER;
      const deckY1 = sCabinRear.cy - sCabinRear.h * BODY_SHOULDER;

      if (visualDamageLevel >= 3) {
        const sootGrad = ctx.createLinearGradient(0, deckY1, 0, deckY0);
        sootGrad.addColorStop(0.0, 'rgba(12, 8, 20, 0.55)');
        sootGrad.addColorStop(1.0, 'rgba(12, 8, 20, 0.14)');
        fillQuad(ctx, s0.cx - s0.w * 0.28, deckY0, s0.cx + s0.w * 0.28, deckY0, sCabinRear.cx + sCabinRear.w * 0.26, deckY1, sCabinRear.cx - sCabinRear.w * 0.26, deckY1, sootGrad);
      }

      const deckMidY = MathUtil.lerp(deckY0, deckY1, 0.52);

      if (visualDamageLevel >= 2 || rearDamageLevel >= 1) {
        const dentSide = (spoilerDamageSide !== 0 ? spoilerDamageSide : (leftDamageLevel >= rightDamageLevel ? -1 : 1));
        const dInX0 = s0.cx + dentSide * s0.w * 0.04;
        const dOutX0 = s0.cx + dentSide * s0.w * 0.24;
        const dMidX = MathUtil.lerp(s0.cx, sCabinRear.cx, 0.55) + dentSide * sCabinRear.w * 0.16;
        fillQuad(ctx, dInX0, deckY0, dOutX0, deckY0, dMidX, deckMidY, dInX0 + dentSide * s0.w * 0.04, deckMidY, 'rgba(34, 4, 18, 0.36)');
        ctx.strokeStyle = 'rgba(255, 195, 220, 0.34)';
        ctx.lineWidth = 1.0;
        ctx.beginPath();
        ctx.moveTo(dOutX0, deckY0);
        ctx.lineTo(dMidX, deckMidY);
        ctx.stroke();
      }

      ctx.strokeStyle = 'rgba(225, 232, 244, 0.36)';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      if (leftDamageLevel >= 1 || visualDamageLevel >= 1) {
        ctx.moveTo(s0.cx - s0.w * 0.36, deckY0);
        ctx.lineTo(sCabinRear.cx - sCabinRear.w * 0.28, MathUtil.lerp(deckY0, deckY1, 0.65));
      }
      if (rightDamageLevel >= 1 || visualDamageLevel >= 2) {
        ctx.moveTo(s0.cx + s0.w * 0.36, deckY0);
        ctx.lineTo(sCabinRear.cx + sCabinRear.w * 0.28, MathUtil.lerp(deckY0, deckY1, 0.65));
      }
      ctx.stroke();
    }
  }

  // 9. Ближняя торцевая панель (корма для попутных, передок для встречных)
  if (showRearPanel) {
    const w0 = s0.w;
    const rearTopY = s0.cy - s0.h;
    const trunkLipY = s0.cy - s0.h * BODY_SHOULDER;

    fillQuad(ctx, s0.cx - w0 * BODY_W_BOT, s0.cy - s0.h * BODY_CLEARANCE, s0.cx + w0 * BODY_W_BOT, s0.cy - s0.h * BODY_CLEARANCE, s0.cx + w0 * BODY_W_MID, s0.cy - s0.h * BODY_MID, s0.cx - w0 * BODY_W_MID, s0.cy - s0.h * BODY_MID, secondary);
    fillQuad(ctx, s0.cx - w0 * BODY_W_MID, s0.cy - s0.h * BODY_MID, s0.cx + w0 * BODY_W_MID, s0.cy - s0.h * BODY_MID, s0.cx + w0 * BODY_W_TOP, trunkLipY, s0.cx - w0 * BODY_W_TOP, trunkLipY, primary);

    if (w0 >= 14) {
      ctx.strokeStyle = MathUtil.shadeHex(primary, 1.18);
      ctx.lineWidth = MathUtil.clamp(s0.h * 0.016, 1.0, 3.5);
      ctx.beginPath();
      ctx.moveTo(s0.cx - w0 * BODY_W_TOP, trunkLipY);
      ctx.lineTo(s0.cx + w0 * BODY_W_TOP, trunkLipY);
      ctx.stroke();
    }

    if (isPlayer && (visualDamageLevel >= 1 || rearDamageLevel >= 1) && wNear >= 20) {
      const seamSide = spoilerDamageSide !== 0 ? spoilerDamageSide : (leftDamageLevel >= rightDamageLevel ? -1 : 1);
      const seamGapL = seamSide < 0 ? Math.max(1.6, s0.h * (0.022 + Math.min(3, visualDamageLevel) * 0.008)) : Math.max(0.8, s0.h * 0.012);
      const seamGapR = seamSide > 0 ? Math.max(1.6, s0.h * (0.022 + Math.min(3, visualDamageLevel) * 0.008)) : Math.max(0.8, s0.h * 0.012);
      fillQuad(
        ctx,
        s0.cx - w0 * 0.34, trunkLipY,
        s0.cx + w0 * 0.34, trunkLipY,
        s0.cx + w0 * 0.33, trunkLipY + seamGapR,
        s0.cx - w0 * 0.33, trunkLipY + seamGapL,
        'rgba(10, 2, 16, 0.72)'
      );

      if (visualDamageLevel >= 2 || rearDamageLevel >= 1) {
        const dTopY = s0.cy - s0.h * 0.54;
        const dBotY = s0.cy - s0.h * 0.40;
        const dLeftX = s0.cx - w0 * 0.115;
        const dRightX = s0.cx + w0 * 0.115;
        const dPeakX = s0.cx + seamSide * w0 * 0.04;
        const dPeakY = MathUtil.lerp(dTopY, dBotY, 0.48);

        fillQuad(ctx, dLeftX, dTopY, dPeakX, dPeakY, dPeakX - seamSide * w0 * 0.02, dBotY, dLeftX + w0 * 0.02, dBotY, 'rgba(30, 3, 18, 0.38)');
        fillQuad(ctx, dPeakX, dPeakY, dRightX, dTopY, dRightX - w0 * 0.02, dBotY, dPeakX - seamSide * w0 * 0.02, dBotY, 'rgba(18, 2, 12, 0.24)');

        ctx.strokeStyle = 'rgba(255, 195, 222, 0.36)';
        ctx.lineWidth = MathUtil.clamp(s0.h * 0.016, 1.0, 3.0);
        ctx.beginPath();
        ctx.moveTo(dPeakX, dPeakY);
        ctx.lineTo(seamSide < 0 ? dLeftX : dRightX, dTopY);
        ctx.stroke();
      }

      if (visualDamageLevel >= 3) {
        fillQuad(
          ctx,
          s0.cx - w0 * 0.22, s0.cy - s0.h * 0.57,
          s0.cx + w0 * 0.22, s0.cy - s0.h * 0.57,
          s0.cx + w0 * 0.18, s0.cy - s0.h * 0.36,
          s0.cx - w0 * 0.18, s0.cy - s0.h * 0.36,
          'rgba(12, 6, 18, 0.28)'
        );
      }

      const drawQuarterScuff = (sideSign) => {
        const xOuter = s0.cx + sideSign * w0 * 0.456;
        const xInner = s0.cx + sideSign * w0 * 0.410;
        ctx.strokeStyle = 'rgba(218, 226, 240, 0.46)';
        ctx.lineWidth = MathUtil.clamp(s0.h * 0.018, 1.0, 3.0);
        ctx.beginPath();
        ctx.moveTo(xOuter, s0.cy - s0.h * 0.53);
        ctx.lineTo(xInner, s0.cy - s0.h * 0.47);
        ctx.moveTo(xOuter - sideSign * w0 * 0.008, s0.cy - s0.h * 0.45);
        ctx.lineTo(xInner + sideSign * w0 * 0.006, s0.cy - s0.h * 0.40);
        ctx.stroke();
      };
      if (leftDamageLevel >= 1) drawQuarterScuff(-1);
      if (rightDamageLevel >= 1) drawQuarterScuff(1);
    }

    let leftBumperDrop = 0;
    let rightBumperDrop = 0;
    if (isPlayer && (visualDamageLevel >= 2 || rearDamageLevel >= 1)) {
      const bumperSagLeft = spoilerDamageSide !== 0
        ? spoilerDamageSide < 0
        : (leftDamageLevel >= rightDamageLevel);
      const dropAmt = Math.min(
        s0.h * 0.085,
        s0.h * (0.025 + Math.max(rearDamageLevel, visualDamageLevel - 1) * 0.016)
      );
      if (isTotalWreck || (leftDamageLevel >= 2 && rightDamageLevel >= 2)) {
        leftBumperDrop = dropAmt * 0.85;
        rightBumperDrop = dropAmt * 0.65;
      } else if (bumperSagLeft) {
        leftBumperDrop = dropAmt;
      } else {
        rightBumperDrop = dropAmt;
      }
    }

    fillQuad(
      ctx,
      s0.cx - w0 * BODY_W_BOT, s0.cy - s0.h * BODY_CLEARANCE + leftBumperDrop,
      s0.cx + w0 * BODY_W_BOT, s0.cy - s0.h * BODY_CLEARANCE + rightBumperDrop,
      s0.cx + w0 * BODY_W_BUMPER_TOP, s0.cy - s0.h * BUMPER_TOP + rightBumperDrop,
      s0.cx - w0 * BODY_W_BUMPER_TOP, s0.cy - s0.h * BUMPER_TOP + leftBumperDrop,
      '#151124'
    );

    if (isPlayer && (visualDamageLevel >= 1 || rearDamageLevel >= 1) && wNear >= 20) {
      const drawBumperScuff = (sideSign) => {
        const dropFracA = sideSign < 0 ? 0.04 : 0.96;
        const dropFracB = sideSign < 0 ? 0.15 : 0.85;
        const dropA = MathUtil.lerp(leftBumperDrop, rightBumperDrop, dropFracA);
        const dropB = MathUtil.lerp(leftBumperDrop, rightBumperDrop, dropFracB);
        const xOuter = s0.cx + sideSign * w0 * 0.445;
        const xInner = s0.cx + sideSign * w0 * 0.335;

        ctx.strokeStyle = 'rgba(176, 184, 206, 0.36)';
        ctx.lineWidth = MathUtil.clamp(s0.h * 0.018, 1.0, 3.0);
        ctx.beginPath();
        ctx.moveTo(xOuter, s0.cy - s0.h * (BODY_CLEARANCE + 0.095) + dropA);
        ctx.lineTo(xInner, s0.cy - s0.h * (BODY_CLEARANCE + 0.075) + dropB);
        ctx.moveTo(xOuter - sideSign * w0 * 0.015, s0.cy - s0.h * (BODY_CLEARANCE + 0.060) + dropA);
        ctx.lineTo(xInner + sideSign * w0 * 0.02, s0.cy - s0.h * (BODY_CLEARANCE + 0.045) + dropB);
        ctx.stroke();
      };

      if (leftDamageLevel >= 1 || rearDamageLevel >= 2) drawBumperScuff(-1);
      if (rightDamageLevel >= 1 || rearDamageLevel >= 2) drawBumperScuff(1);
    }

    if (isPlayer) {
      const flameY = s0.cy - s0.h * (BODY_CLEARANCE + 0.03);
      const leftPipeX = s0.cx - w0 * 0.26;
      const rightPipeX = s0.cx + w0 * 0.26;

      if (wNear >= 20) {
        const pipeRx = Math.max(2.0, w0 * 0.028);
        const pipeRy = Math.max(1.6, s0.h * 0.026);
        ctx.fillStyle = '#090612';
        ctx.strokeStyle = '#475569';
        ctx.lineWidth = MathUtil.clamp(w0 * 0.008, 1.0, 2.5);
        ctx.beginPath();
        ctx.ellipse(leftPipeX, flameY, pipeRx, pipeRy, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.ellipse(rightPipeX, flameY, pipeRx, pipeRy, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }

      if (showExhaustFlame || showBackfireFlame) {
        const pulse = 0.5 + 0.5 * Math.sin(state.animClockMs * 0.08);

        if (state.settings.lightStyle === 'soft') {
          if (showBackfireFlame) {
            const bfR = 7.0 + pulse * 5.2;
            const backfireStops = [
              [0.0, 'rgba(255, 252, 225, 0.96)'],
              [0.28, 'rgba(255, 165, 20, 0.78)'],
              [0.62, 'rgba(255, 72, 0, 0.34)'],
              [1.0, 'rgba(255, 45, 0, 0.0)']
            ];
            drawLightHalo(ctx, leftPipeX, flameY, bfR, '#ff7b00', bfR * 2.15, backfireStops);
            drawLightHalo(ctx, rightPipeX, flameY, bfR * 0.8, '#ff7b00', bfR * 1.75, backfireStops);
          } else {
            const flameR = (isSlipstreamingFlame ? 6.5 : 4.6) + pulse * 4.2;
            const flameStops = isSlipstreamingFlame
              ? [
                  [0.0, 'rgba(235, 255, 230, 0.95)'],
                  [0.30, 'rgba(57, 255, 20, 0.72)'],
                  [0.65, 'rgba(20, 210, 45, 0.28)'],
                  [1.0, 'rgba(0, 180, 40, 0.0)']
                ]
              : [
                  [0.0, 'rgba(235, 253, 255, 0.95)'],
                  [0.30, 'rgba(0, 240, 255, 0.72)'],
                  [0.65, 'rgba(0, 150, 255, 0.26)'],
                  [1.0, 'rgba(0, 110, 255, 0.0)']
                ];
            drawLightHalo(ctx, leftPipeX, flameY, flameR, isSlipstreamingFlame ? '#39ff14' : '#00f0ff', flameR * 2.1, flameStops);
            drawLightHalo(ctx, rightPipeX, flameY, flameR, isSlipstreamingFlame ? '#39ff14' : '#00f0ff', flameR * 2.1, flameStops);
          }
        } else if (showBackfireFlame) {
          const bfR = 6.5 + pulse * 5.0;
          ctx.fillStyle = '#ff7b00';
          ctx.beginPath();
          ctx.arc(leftPipeX, flameY, bfR, 0, Math.PI * 2);
          ctx.arc(rightPipeX, flameY, bfR * 0.8, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#fff3b0';
          ctx.beginPath();
          ctx.arc(leftPipeX, flameY, bfR * 0.45, 0, Math.PI * 2);
          ctx.fill();
        } else {
          const flameR = (isSlipstreamingFlame ? 6.5 : 4.5) + pulse * 4.2;
          ctx.fillStyle = isSlipstreamingFlame ? '#39ff14' : '#00f0ff';
          ctx.beginPath();
          ctx.arc(leftPipeX, flameY, flameR, 0, Math.PI * 2);
          ctx.arc(rightPipeX, flameY, flameR, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    const isStreetTraffic = !isPlayer && !isRival;
    // Индивидуальный стиль обрамления оптики по моделям трафика:
    // фиолетовый van — полная рамка, зелёный sedan — тонкая рамка, голубой coupe и жёлтый sport — без рамки
    const opticFrameStyle = !isStreetTraffic
      ? 'none'
      : (type === 'van' ? 'full' : (type === 'sedan' ? 'thin' : 'none'));

    const turnW = w0 * 0.062;
    const lightW = isStreetTraffic ? w0 * 0.152 : w0 * 0.155;
    const lightH = s0.h * 0.12;
    const leftLightY = s0.cy - s0.h * 0.535;
    const rightLightY = leftLightY;

    const leftTurnX = s0.cx - w0 * 0.450;
    const rightTurnX = s0.cx + w0 * 0.450 - turnW;
    const leftLightX = isStreetTraffic ? (leftTurnX + turnW) : (s0.cx - w0 * 0.395);
    const rightLightX = isStreetTraffic ? (rightTurnX - lightW) : (s0.cx + w0 * 0.395 - lightW);

    const leftTailLit = !leftLightBroken && !leftLightFlicker;
    const rightTailLit = !rightLightBroken && !rightLightFlicker;
    let leftTurnLit = false;
    let rightTurnLit = false;

    // --- Проход А: непрозрачная геометрия оптики, номеров и спойлера (до световых ореолов) ---
    if (isStreetTraffic && opticFrameStyle !== 'none') {
      // Строго пропорциональная перспектива без пиксельного минимума + раннее плавное проявление на удалении
      const housingPad = opticFrameStyle === 'full'
        ? Math.min(2.2, w0 * 0.010)
        : Math.min(0.95, w0 * 0.005);
      const frameAlpha = MathUtil.clamp((w0 - 8) / 14, 0, 1);
      if (frameAlpha > 0.01 && housingPad > 0.04) {
        const clusterW = turnW + lightW;
        const prevAlpha = ctx.globalAlpha;
        ctx.globalAlpha = prevAlpha * frameAlpha;
        ctx.fillStyle = '#120a20';
        ctx.fillRect(leftTurnX - housingPad, leftLightY - housingPad, clusterW + housingPad * 2, lightH + housingPad * 2);
        ctx.fillRect(rightLightX - housingPad, rightLightY - housingPad, clusterW + housingPad * 2, lightH + housingPad * 2);
        ctx.globalAlpha = prevAlpha;
      }
    }

    if (dir === -1) {
      const grilleW = isStreetTraffic ? w0 * 0.37 : w0 * 0.42;
      ctx.fillStyle = '#0d091a';
      ctx.fillRect(s0.cx - grilleW * 0.5, leftLightY + lightH * 0.1, grilleW, lightH * 0.85);

      ctx.fillStyle = damagedByPlayer ? '#241f33' : (highBeamFlashing ? '#e0ffff' : '#ffffff');
      ctx.fillRect(leftLightX, leftLightY, lightW, lightH);
      ctx.fillRect(rightLightX, rightLightY, lightW, lightH);
    } else {
      const drawBrokenTaillight = (lx, ly, isLeft) => {
        ctx.fillStyle = '#18040b';
        ctx.fillRect(lx, ly, lightW, lightH);
        if (wNear >= 24) {
          ctx.fillStyle = '#5c0a20';
          ctx.beginPath();
          if (isLeft) {
            ctx.moveTo(lx + lightW, ly);
            ctx.lineTo(lx + lightW * 0.45, ly);
            ctx.lineTo(lx + lightW * 0.72, ly + lightH);
            ctx.lineTo(lx + lightW, ly + lightH);
          } else {
            ctx.moveTo(lx, ly);
            ctx.lineTo(lx + lightW * 0.55, ly);
            ctx.lineTo(lx + lightW * 0.28, ly + lightH);
            ctx.lineTo(lx, ly + lightH);
          }
          ctx.closePath();
          ctx.fill();

          ctx.fillStyle = 'rgba(200, 215, 232, 0.28)';
          ctx.fillRect(
            lx + (isLeft ? lightW * 0.16 : lightW * 0.62),
            ly + lightH * 0.24,
            lightW * 0.22,
            lightH * 0.48
          );
        }
      };

      if (leftLightBroken) {
        drawBrokenTaillight(leftLightX, leftLightY, true);
      } else {
        ctx.fillStyle = leftTailLit && braking ? '#ff4d6d' : (leftTailLit ? '#9e0b28' : '#3d0815');
        ctx.fillRect(leftLightX, leftLightY, lightW, lightH);
      }

      if (rightLightBroken) {
        drawBrokenTaillight(rightLightX, rightLightY, false);
      } else {
        ctx.fillStyle = rightTailLit && braking ? '#ff4d6d' : (rightTailLit ? '#9e0b28' : '#3d0815');
        ctx.fillRect(rightLightX, rightLightY, lightW, lightH);
      }
    }

    const revW = w0 * 0.085;
    const revH = lightH * 0.82;
    const leftRevX = s0.cx - w0 * 0.225;
    const rightRevX = s0.cx + w0 * 0.225 - revW;
    const leftRevY = leftLightY + (lightH - revH) * 0.5;
    const rightRevY = rightLightY + (lightH - revH) * 0.5;

    if (isPlayer) {
      ctx.fillStyle = reversing ? '#ffffff' : (isTotalWreck ? '#262030' : '#3a2d47');
      ctx.fillRect(leftRevX, leftRevY, revW, revH);
      ctx.fillRect(rightRevX, rightRevY, revW, revH);

      const plateW = w0 * 0.19;
      const plateH = s0.h * 0.12;
      const plateY = s0.cy - s0.h * (BUMPER_TOP - 0.006) + (leftBumperDrop + rightBumperDrop) * 0.45;
      const plateTilt = (rearDamageLevel >= 1 || visualDamageLevel >= 2)
        ? MathUtil.clamp((rightDamageLevel - leftDamageLevel) * 0.08 + rearDamageLevel * 0.05, -0.24, 0.24)
        : 0;

      ctx.save();
      ctx.translate(s0.cx, plateY + plateH * 0.5);
      if (plateTilt !== 0) ctx.rotate(plateTilt);
      ctx.fillStyle = isTotalWreck ? '#1f1b2b' : (visualDamageLevel >= 3 ? '#d8d2e2' : '#ffffff');
      ctx.fillRect(-plateW * 0.5, -plateH * 0.5, plateW, plateH);
      ctx.fillStyle = isTotalWreck ? '#5c5373' : '#140326';
      ctx.font = `900 ${Math.max(8, Math.round(plateH * 0.80))}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('01', 0, plateH * 0.04);
      ctx.restore();
    } else if (isStreetTraffic) {
      const hazardMode = damagedByPlayer;
      const hazardOn = hazardMode && (Math.floor(state.animClockMs / 260) % 2 === 0);
      const signalBlinkOn = !hazardMode && turnSignal !== 0 && (Math.floor(signalElapsed / 0.18) % 2 === 0);

      leftTurnLit = hazardMode ? hazardOn : (turnSignal === -1 && signalBlinkOn);
      rightTurnLit = hazardMode ? hazardOn : (turnSignal === 1 && signalBlinkOn);

      const drawIntegratedTurnLensBase = (lensX, lensY, lensW, lensH, isLit) => {
        // В неактивной фазе мигания линза остаётся штатного тёмно-оранжевого цвета (не чернеет)
        ctx.fillStyle = isLit ? '#ffbe0b' : '#7c4308';
        ctx.fillRect(lensX, lensY, lensW, lensH);

        if (!isLit) {
          const glossAlpha = MathUtil.clamp((w0 - 14) / 14, 0, 1);
          if (glossAlpha > 0.01) {
            const prevAlpha = ctx.globalAlpha;
            ctx.globalAlpha = prevAlpha * glossAlpha;
            ctx.fillStyle = 'rgba(255, 200, 96, 0.28)';
            ctx.fillRect(lensX, lensY, lensW, lensH * 0.28);
            ctx.globalAlpha = prevAlpha;
          }
        }
      };

      drawIntegratedTurnLensBase(leftTurnX, leftLightY, turnW, lightH, leftTurnLit);
      drawIntegratedTurnLensBase(rightTurnX, rightLightY, turnW, lightH, rightTurnLit);

      // Перегородка между основной фарой/фонарём и поворотником (пропорционально перспективе)
      if (opticFrameStyle !== 'none') {
        const sepW = opticFrameStyle === 'full'
          ? Math.min(1.5, w0 * 0.0075)
          : Math.min(0.85, w0 * 0.0042);
        const sepAlpha = MathUtil.clamp((w0 - 10) / 14, 0, 1);
        if (sepAlpha > 0.01 && sepW > 0.04) {
          const prevAlpha = ctx.globalAlpha;
          ctx.globalAlpha = prevAlpha * sepAlpha;
          ctx.fillStyle = '#120a20';
          ctx.fillRect(leftLightX - sepW * 0.5, leftLightY, sepW, lightH);
          ctx.fillRect(rightTurnX - sepW * 0.5, rightLightY, sepW, lightH);
          ctx.globalAlpha = prevAlpha;
        }
      }

      // Задний номерной знак гражданского трафика по центру между фонарями (плавный LOD без скачков)
      if (dir === 1 && w0 >= 3.5) {
        const plateW = w0 * 0.24;
        const plateH = s0.h * 0.118;
        const plateX = s0.cx - plateW * 0.5;
        const plateY = s0.cy - s0.h * 0.525;
        const plateVisAlpha = MathUtil.clamp((w0 - 3.5) / 5.5, 0, 1);
        const prevAlpha = ctx.globalAlpha;

        const framePad = Math.min(1.6, w0 * 0.0075);
        const plateFrameAlpha = plateVisAlpha * MathUtil.clamp((w0 - 5.5) / 10.5, 0, 1);
        if (plateFrameAlpha > 0.01 && framePad > 0.04) {
          ctx.globalAlpha = prevAlpha * plateFrameAlpha;
          ctx.fillStyle = '#130921';
          ctx.fillRect(plateX - framePad, plateY - framePad, plateW + framePad * 2, plateH + framePad * 2);
        }

        ctx.globalAlpha = prevAlpha * plateVisAlpha;
        ctx.fillStyle = damagedByPlayer ? '#8e889c' : '#f4f1ea';
        ctx.fillRect(plateX, plateY, plateW, plateH);

        const stripAlpha = plateVisAlpha * MathUtil.clamp((plateH - 1.0) / 1.8, 0, 1);
        if (stripAlpha > 0.01) {
          ctx.globalAlpha = prevAlpha * stripAlpha;
          ctx.fillStyle = damagedByPlayer ? '#495066' : '#2563eb';
          ctx.fillRect(plateX, plateY, plateW, plateH * 0.22);
        }

        // Плавный кроссфейд от условной тёмной полоски символов вдали к читаемому тексту номера вблизи
        const textAlpha = MathUtil.clamp((plateH - 2.6) / 2.2, 0, 1);
        const smudgeAlpha = plateVisAlpha * MathUtil.clamp((plateW - 4.0) / 5.0, 0, 1) * (1 - textAlpha);
        if (smudgeAlpha > 0.01) {
          ctx.globalAlpha = prevAlpha * smudgeAlpha * 0.65;
          ctx.fillStyle = '#140326';
          ctx.fillRect(plateX + plateW * 0.18, plateY + plateH * 0.54, plateW * 0.64, plateH * 0.22);
        }

        if (textAlpha > 0.01) {
          const plateText = plate || '90X';
          ctx.globalAlpha = prevAlpha * textAlpha;
          ctx.fillStyle = damagedByPlayer ? '#2a2438' : '#140326';
          ctx.font = `900 ${Math.max(4, plateH * 0.66)}px monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(plateText, s0.cx, plateY + plateH * 0.62, plateW * 0.86);
        }

        ctx.globalAlpha = prevAlpha;
      }
    }

    if (!isPlayer && !isRival && type === 'sport' && dir === 1 && w0 > 16) {
      const lipH = s0.h * 0.055;
      ctx.fillStyle = MathUtil.shadeHex(secondary, 0.85);
      ctx.fillRect(s0.cx - w0 * 0.43, trunkLipY - lipH, w0 * 0.86, lipH);
    }

    if (isPlayer || isRival) {
      const sWingFront = sec(0.11);
      const wingH = Math.max(3, s0.h * 0.16);
      const strutW = Math.max(1.8, w0 * 0.042);
      const trunkRearY = trunkLipY;
      const trunkFrontY = sWingFront.cy - sWingFront.h * BODY_SHOULDER;
      const lipThickness = Math.max(2.0, s0.h * 0.045);

      const drawWingEndplate = (rearXPos, rearTopYPos, frontXPos, frontTopYPos, scaleSide = 1) => {
        if (w0 < 16) return;
        const plateAbove = wingH * 0.22 * scaleSide;
        const plateBelow = wingH * 0.34 * scaleSide;
        fillQuad(ctx, rearXPos, rearTopYPos - plateAbove, frontXPos, frontTopYPos - plateAbove * 0.85, frontXPos, frontTopYPos + plateBelow * 0.85, rearXPos, rearTopYPos + plateBelow, '#140326');
        ctx.strokeStyle = primary;
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(rearXPos, rearTopYPos - plateAbove + 1);
        ctx.lineTo(frontXPos, frontTopYPos - plateAbove * 0.85 + 1);
        ctx.stroke();
      };

      if (isPlayer && (visualDamageLevel >= 4 || isTotalWreck)) {
        const breakLeft = spoilerDamageSide !== 0
          ? spoilerDamageSide < 0
          : (leftDamageLevel >= rightDamageLevel);
        const bSign = breakLeft ? -1 : 1;
        const iSign = -bSign;

        const stubX = s0.cx + bSign * w0 * 0.30;
        const stubTopY = trunkRearY - wingH * 0.38;
        ctx.strokeStyle = '#140326';
        ctx.lineWidth = Math.min(strutW, 10);
        ctx.beginPath();
        ctx.moveTo(stubX, trunkRearY);
        ctx.lineTo(stubX + bSign * strutW * 0.7, stubTopY);
        ctx.stroke();
        ctx.fillStyle = '#cbd5e1';
        ctx.fillRect(stubX + bSign * strutW * 0.7 - strutW * 0.5, stubTopY - 1, strutW, 2);

        const intactStrutX = s0.cx + iSign * w0 * 0.30;
        const intactTopY = trunkRearY - wingH;
        const intactFrontTopY = trunkFrontY - wingH * 0.85;
        ctx.fillStyle = '#140326';
        ctx.fillRect(intactStrutX - strutW * 0.5, intactTopY, strutW, wingH);

        const innerFrac = -bSign * 0.03;
        const outerFrac = iSign * 0.43;
        const xInnerRear = s0.cx + w0 * innerFrac;
        const xOuterRear = s0.cx + w0 * outerFrac;
        const xInnerFront = sWingFront.cx + sWingFront.w * (innerFrac * 0.95);
        const xOuterFront = sWingFront.cx + sWingFront.w * (outerFrac * 0.95);
        const xMidBreak = (xInnerRear + xInnerFront) * 0.5 - bSign * w0 * 0.035;
        const yMidBreak = (intactTopY + intactFrontTopY) * 0.5;

        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.moveTo(xInnerRear, intactTopY);
        ctx.lineTo(xOuterRear, intactTopY);
        ctx.lineTo(xOuterFront, intactFrontTopY);
        ctx.lineTo(xInnerFront, intactFrontTopY);
        ctx.lineTo(xMidBreak, yMidBreak);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = '#140326';
        ctx.fillRect(Math.min(xInnerRear, xOuterRear), intactTopY, Math.abs(xOuterRear - xInnerRear), lipThickness);
        drawWingEndplate(xOuterRear, intactTopY, xOuterFront, intactFrontTopY, 1);

        const hangPivotX = s0.cx + bSign * w0 * 0.13;
        const hangPivotY = trunkRearY - wingH * 0.22;
        const hangTipX = s0.cx + bSign * w0 * 0.47;
        const hangTipY = trunkRearY + wingH * 0.92;
        const chordX = -bSign * w0 * 0.045;
        const chordY = -wingH * 0.46;

        fillQuad(ctx, hangPivotX, hangPivotY, hangTipX, hangTipY, hangTipX, hangTipY + lipThickness * 1.15, hangPivotX, hangPivotY + lipThickness * 1.15, '#140326');
        fillQuad(ctx, hangPivotX, hangPivotY, hangTipX, hangTipY, hangTipX + chordX, hangTipY + chordY, hangPivotX + chordX, hangPivotY + chordY, '#e2e8f0');
        drawWingEndplate(hangTipX, hangTipY, hangTipX + chordX, hangTipY + chordY, 0.85);
      } else if (isPlayer && visualDamageLevel >= 2) {
        const bendLeft = spoilerDamageSide !== 0
          ? spoilerDamageSide < 0
          : (leftDamageLevel >= rightDamageLevel);
        const leftDrop = bendLeft ? wingH * 0.40 : 0;
        const rightDrop = bendLeft ? 0 : wingH * 0.40;

        const leftRearY = trunkRearY - wingH + leftDrop;
        const rightRearY = trunkRearY - wingH + rightDrop;
        const leftFrontY = trunkFrontY - wingH * 0.85 + leftDrop * 0.85;
        const rightFrontY = trunkFrontY - wingH * 0.85 + rightDrop * 0.85;

        const leftStrutTopX = s0.cx - w0 * (bendLeft ? 0.33 : 0.31);
        const rightStrutTopX = s0.cx + w0 * (bendLeft ? 0.31 : 0.33);

        ctx.strokeStyle = '#140326';
        ctx.lineWidth = Math.min(strutW, 10);
        ctx.beginPath();
        ctx.moveTo(s0.cx - w0 * 0.30, trunkRearY);
        ctx.lineTo(leftStrutTopX, leftRearY + 1);
        ctx.moveTo(s0.cx + w0 * 0.30, trunkRearY);
        ctx.lineTo(rightStrutTopX, rightRearY + 1);
        ctx.stroke();

        fillQuad(ctx, s0.cx - w0 * 0.43, leftRearY, s0.cx + w0 * 0.43, rightRearY, sWingFront.cx + sWingFront.w * 0.41, rightFrontY, sWingFront.cx - sWingFront.w * 0.41, leftFrontY, '#ffffff');
        fillQuad(ctx, s0.cx - w0 * 0.43, leftRearY, s0.cx + w0 * 0.43, rightRearY, s0.cx + w0 * 0.43, rightRearY + lipThickness, s0.cx - w0 * 0.43, leftRearY + lipThickness, '#140326');
        drawWingEndplate(s0.cx - w0 * 0.43, leftRearY, sWingFront.cx - sWingFront.w * 0.41, leftFrontY, 1);
        drawWingEndplate(s0.cx + w0 * 0.43, rightRearY, sWingFront.cx + sWingFront.w * 0.41, rightFrontY, 1);
      } else {
        const wingTopY = trunkRearY - wingH;
        const wingFrontTopY = trunkFrontY - wingH * 0.85;

        ctx.fillStyle = '#140326';
        ctx.fillRect(s0.cx - w0 * 0.32, wingTopY, strutW, wingH);
        ctx.fillRect(s0.cx + w0 * 0.32 - strutW, wingTopY, strutW, wingH);

        fillQuad(ctx, s0.cx - w0 * 0.43, wingTopY, s0.cx + w0 * 0.43, wingTopY, sWingFront.cx + sWingFront.w * 0.41, wingFrontTopY, sWingFront.cx - sWingFront.w * 0.41, wingFrontTopY, '#ffffff');
        ctx.fillStyle = '#140326';
        ctx.fillRect(s0.cx - w0 * 0.43, wingTopY, w0 * 0.86, lipThickness);

        drawWingEndplate(s0.cx - w0 * 0.43, wingTopY, sWingFront.cx - sWingFront.w * 0.41, wingFrontTopY, 1);
        drawWingEndplate(s0.cx + w0 * 0.43, wingTopY, sWingFront.cx + sWingFront.w * 0.41, wingFrontTopY, 1);
      }
    }

    // --- Проход Б: световые ореолы и блики (поверх спойлера, ламп заднего хода и поворотников) ---
    if (dir === -1) {
      const headlightHaloFade = MathUtil.clamp((w0 - 3.5) / 14, 0, 1);
      if (headlightHaloFade > 0.01 && !damagedByPlayer) {
        const beamRadius = highBeamFlashing ? lightW * 2.55 : lightW * 1.25;
        const hardBeamColor = highBeamFlashing ? 'rgba(210, 252, 255, 0.55)' : 'rgba(220, 250, 255, 0.22)';
        const softBeamRadius = highBeamFlashing ? lightW * 3.45 : lightW * 2.1;
        const softBeamStops = highBeamFlashing
          ? [
              [0.0, 'rgba(255, 255, 255, 0.95)'],
              [0.32, 'rgba(200, 250, 255, 0.62)'],
              [0.68, 'rgba(120, 235, 255, 0.22)'],
              [1.0, 'rgba(120, 235, 255, 0.0)']
            ]
          : [
              [0.0, 'rgba(240, 252, 255, 0.72)'],
              [0.38, 'rgba(180, 242, 255, 0.34)'],
              [1.0, 'rgba(140, 225, 255, 0.0)']
            ];
        drawLightHalo(ctx, leftLightX + lightW * 0.5, leftLightY + lightH * 0.5, beamRadius, hardBeamColor, softBeamRadius, softBeamStops, headlightHaloFade);
        drawLightHalo(ctx, rightLightX + lightW * 0.5, rightLightY + lightH * 0.5, beamRadius, hardBeamColor, softBeamRadius, softBeamStops, headlightHaloFade);

        const coneFade = MathUtil.clamp((w0 - 10) / 18, 0, 1);
        if (highBeamFlashing && coneFade > 0.01) {
          const coneTopY = leftLightY + lightH;
          const coneBotY = s0.cy + s0.h * 0.35;
          if (state.settings.lightStyle === 'soft') {
            ctx.save();
            ctx.globalCompositeOperation = 'screen';
            ctx.globalAlpha *= coneFade;
            const coneGrad = ctx.createLinearGradient(0, coneTopY, 0, coneBotY);
            coneGrad.addColorStop(0.0, 'rgba(215, 252, 255, 0.26)');
            coneGrad.addColorStop(0.6, 'rgba(170, 242, 255, 0.10)');
            coneGrad.addColorStop(1.0, 'rgba(140, 230, 255, 0.0)');
            fillQuad(ctx, leftLightX, coneTopY, leftLightX + lightW, coneTopY, leftLightX + lightW + w0 * 0.14, coneBotY, leftLightX - w0 * 0.20, coneBotY, coneGrad);
            fillQuad(ctx, rightLightX, coneTopY, rightLightX + lightW, coneTopY, rightLightX + lightW + w0 * 0.20, coneBotY, rightLightX - w0 * 0.14, coneBotY, coneGrad);
            ctx.restore();
          } else {
            ctx.save();
            ctx.globalAlpha *= coneFade;
            fillQuad(ctx, leftLightX + lightW * 0.1, coneTopY, leftLightX + lightW * 0.9, coneTopY, leftLightX + lightW + w0 * 0.10, coneBotY, leftLightX - w0 * 0.14, coneBotY, 'rgba(210, 252, 255, 0.24)');
            fillQuad(ctx, rightLightX + lightW * 0.1, coneTopY, rightLightX + lightW * 0.9, coneTopY, rightLightX + lightW + w0 * 0.14, coneBotY, rightLightX - w0 * 0.10, coneBotY, 'rgba(210, 252, 255, 0.24)');
            ctx.restore();
          }
        }
      }
    } else {
      const brakeHaloFade = MathUtil.clamp((w0 - 4.0) / 14, 0, 1);
      if (braking && brakeHaloFade > 0.01 && (leftTailLit || rightTailLit)) {
        const hardBrakeR = lightW * (isPlayer ? 1.15 : 1.05);
        const hardBrakeColor = isPlayer ? 'rgba(255, 42, 95, 0.38)' : 'rgba(255, 42, 95, 0.36)';
        const softBrakeR = lightW * (isPlayer ? 2.15 : 1.9);
        const softBrakeStops = [
          [0.0, 'rgba(255, 195, 210, 0.82)'],
          [0.34, 'rgba(255, 42, 95, 0.50)'],
          [1.0, 'rgba(255, 20, 75, 0.0)']
        ];
        if (leftTailLit) {
          drawLightHalo(ctx, leftLightX + lightW * 0.5, leftLightY + lightH * 0.5, hardBrakeR, hardBrakeColor, softBrakeR, softBrakeStops, brakeHaloFade);
        }
        if (rightTailLit) {
          drawLightHalo(ctx, rightLightX + lightW * 0.5, rightLightY + lightH * 0.5, hardBrakeR, hardBrakeColor, softBrakeR, softBrakeStops, brakeHaloFade);
        }
      }
    }

    if (isPlayer && reversing) {
      const revSoftStops = [
        [0.0, 'rgba(255, 255, 255, 0.90)'],
        [0.35, 'rgba(200, 245, 255, 0.48)'],
        [1.0, 'rgba(180, 240, 255, 0.0)']
      ];
      drawLightHalo(ctx, leftRevX + revW * 0.5, leftRevY + revH * 0.5, revW * 1.5, 'rgba(220, 250, 255, 0.50)', revW * 2.6, revSoftStops);
      drawLightHalo(ctx, rightRevX + revW * 0.5, rightRevY + revH * 0.5, revW * 1.5, 'rgba(220, 250, 255, 0.50)', revW * 2.6, revSoftStops);
    } else if (isStreetTraffic && (leftTurnLit || rightTurnLit)) {
      const signalHaloFade = MathUtil.clamp((w0 - 3.5) / 10, 0, 1);
      const drawTurnSignalGlow = (lensX, lensY) => {
        if (signalHaloFade > 0.01) {
          const gx = lensX + turnW * 0.5;
          const gy = lensY + lightH * 0.5;
          const hardR = Math.max(turnW * 1.45, w0 * 0.095);
          const softR = Math.max(turnW * 3.2, w0 * 0.22);

          drawLightHalo(ctx, gx, gy, hardR, 'rgba(255, 190, 11, 0.52)', softR, [
            [0.0, 'rgba(255, 250, 215, 0.95)'],
            [0.26, 'rgba(255, 195, 20, 0.62)'],
            [0.58, 'rgba(255, 115, 0, 0.24)'],
            [1.0, 'rgba(255, 90, 0, 0.0)']
          ], signalHaloFade);

          ctx.fillStyle = '#fff9db';
          ctx.fillRect(lensX + turnW * 0.18, lensY + lightH * 0.18, turnW * 0.64, lightH * 0.64);
        }
      };

      if (leftTurnLit) drawTurnSignalGlow(leftTurnX, leftLightY);
      if (rightTurnLit) drawTurnSignalGlow(rightTurnX, rightLightY);
    }

    // Чистый никнейм соперника над крышей без рамки и подложки (с плавным проявлением по дистанции)
    if (!isPlayer && isRival && w0 > 26) {
      const labelAlpha = MathUtil.clamp((w0 - 26) / 18, 0, 1);
      const roofTopY = Math.min(rearTopY, sRoofRear.cy - sRoofRear.h * ROOF_TOP);
      const labelY = roofTopY - 10;
      const prevAlpha = ctx.globalAlpha;

      ctx.globalAlpha = prevAlpha * labelAlpha;
      ctx.font = '800 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 2.6;
      ctx.strokeStyle = 'rgba(9, 2, 22, 0.85)';
      ctx.strokeText(`#${num} ${name}`, s0.cx, labelY);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(`#${num} ${name}`, s0.cx, labelY);
      ctx.globalAlpha = prevAlpha;
    }
  }

  ctx.restore();
}

function renderTrafficCar(ctx, car) {
  const carCamZ = getShortestTrackDz(state.position, car.z, state.trackLength);
  const isHighBeamFlashing =
    car.dir === -1 &&
    car.highBeamFlashTimer > 0 &&
    !car.damagedByPlayer &&
    Math.floor(state.animClockMs / 95) % 2 === 0;

  render3DCar(ctx, {
    isPlayer: false,
    isRival: car.isRival,
    type: car.type || 'sport',
    dir: car.dir,
    w: car.w,
    h: car.h,
    lenZ: car.lenZ || Math.round(SEGMENT_LENGTH * 1.3),
    primary: car.primary,
    secondary: car.secondary,
    worldX: car.x,
    centerZ: car.z,
    camZ: carCamZ,
    yaw: car.yaw || 0,
    braking: car.braking || car.speed < 25,
    damagedByPlayer: car.damagedByPlayer,
    highBeamFlashing: isHighBeamFlashing,
    turnSignal: car.turnSignal || 0,
    signalElapsed: car.signalElapsed || 0,
    name: car.name || '',
    num: car.num || '',
    plate: car.plate || ''
  });
}

function renderPlayerCar(ctx, parkedCamZ = null) {
  const isParkedDetach = parkedCamZ !== null;
  const isTitleDemo = state.gameState === STATE.TITLE;
  const absSpeedRatio = Math.abs(state.speed) / MAX_SPEED;
  const isOffRoad = Math.abs(state.playerX) > OFF_ROAD_THRESHOLD_X;
  const activeVisualDamage = state.gameMode !== 'circuit' ? state.visualDamage : 0;

  const baseBounce = (!isParkedDetach && !state.isPaused && (Math.abs(state.speed) > 15 || isTitleDemo))
    ? Math.sin(state.animClockMs * 0.045) * (0.5 + (isTitleDemo ? 0.26 : absSpeedRatio) * 1.4)
    : 0;
  const offRoadBounce = (!isParkedDetach && !state.isPaused && isOffRoad && Math.abs(state.speed) > 15)
    ? Math.sin(state.animClockMs * 0.16) * 2.0 * Math.min(1, absSpeedRatio * 2.5)
    : 0;
  const damageWobble = (!isParkedDetach && !state.isPaused && activeVisualDamage >= 3 && Math.abs(state.speed) > 25)
    ? Math.sin(state.animClockMs * 0.11) * (0.55 + (activeVisualDamage - 2) * 0.45) * Math.min(1, absSpeedRatio * 1.8)
    : 0;
  const crashShakeX = (!isParkedDetach && !state.isPaused && state.impactShake > 0)
    ? Math.sin(state.animClockMs * 0.19) * 6.5 * state.impactShake
    : 0;
  const crashShakeY = (!isParkedDetach && !state.isPaused && state.impactShake > 0)
    ? Math.cos(state.animClockMs * 0.23) * 4.5 * state.impactShake
    : 0;

  const playerYaw = isParkedDetach
    ? state.stoppedPlayerYaw
    : MathUtil.clamp(state.steerVisual * 0.22 + state.playerVX * 0.14, -0.34, 0.34);
  const isTotalWreck = state.gameMode !== 'circuit' && state.visualDamage >= MAX_HARDCORE_COLLISIONS;
  const hasDamageSystem = state.gameMode !== 'circuit';
  const flickerPhase = Math.floor(state.animClockMs / 95);
  const input = state.input;

  const isReversing =
    !isParkedDetach &&
    !isTotalWreck &&
    state.gameState === STATE.PLAYING &&
    state.raceCountdownTimer <= 0 &&
    (state.speed < -2 || (input.down && !input.up && state.speed <= 2));
  const isBraking = isParkedDetach
    ? !isTotalWreck
    : (!isTitleDemo && !isTotalWreck && !isReversing && ((input.down && state.speed > 2) || (input.up && input.down) || Math.abs(state.speed) < 15));
  const leftLightBroken = isTotalWreck || (hasDamageSystem && (state.leftDamage >= 3 || state.visualDamage >= 4));
  const rightLightBroken = isTotalWreck || (hasDamageSystem && (state.rightDamage >= 3 || state.visualDamage >= 4));
  const leftLightFlicker = !leftLightBroken && hasDamageSystem && state.leftDamage >= 2 && (flickerPhase % 3 === 0);
  const rightLightFlicker = !rightLightBroken && hasDamageSystem && state.rightDamage >= 2 && (flickerPhase % 4 === 1);
  const showExhaustFlame = !isParkedDetach && !state.isPaused && !isTotalWreck && input.up && !input.down && state.speed / MAX_SPEED > 0.72 && !state.isOverheated && state.engineMisfireTimer <= 0;
  const showBackfireFlame = !isParkedDetach && !state.isPaused && !isTotalWreck && activeVisualDamage >= 4 && state.engineMisfireTimer > 0 && input.up;

  render3DCar(ctx, {
    isPlayer: true,
    isParkedDetach,
    isRival: false,
    type: 'sport',
    dir: 1,
    w: PLAYER_WIDTH_NORM,
    h: 0.96,
    lenZ: PLAYER_LEN_Z,
    primary: '#ff2a6d',
    secondary: '#6b052c',
    worldX: (isParkedDetach ? state.stoppedPlayerX : state.playerX) * ROAD_WIDTH,
    centerZ: isParkedDetach ? state.stoppedPlayerZ : (state.position + PLAYER_Z + PLAYER_CENTER_OFFSET_Z),
    camZ: isParkedDetach ? parkedCamZ : (PLAYER_Z + PLAYER_CENTER_OFFSET_Z),
    yaw: playerYaw,
    screenShiftX: crashShakeX,
    verticalOffset: baseBounce + offRoadBounce + damageWobble + crashShakeY,
    useFallback: !isParkedDetach,
    braking: isBraking,
    reversing: isReversing,
    isTotalWreck,
    leftLightBroken,
    rightLightBroken,
    leftLightFlicker,
    rightLightFlicker,
    visualDamageLevel: activeVisualDamage,
    leftDamageLevel: hasDamageSystem ? state.leftDamage : 0,
    rightDamageLevel: hasDamageSystem ? state.rightDamage : 0,
    rearDamageLevel: hasDamageSystem ? state.rearDamage : 0,
    spoilerDamageSide: hasDamageSystem ? state.spoilerDamageSide : 0,
    showExhaustFlame,
    isSlipstreamingFlame: state.isSlipstreaming,
    showBackfireFlame
  });
}

function renderParticles(ctx) {
  if (!state.settings.particlesEnabled) return;
  const particles = state.particles;
  if (!particles.length) return;

  const isSoftLight = state.settings.lightStyle === 'soft';

  ctx.save();
  if (isSoftLight) {
    let activeComposite = 'source-over';
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const alpha = MathUtil.clamp(p.life / p.maxLife, 0, 1);
      if (alpha <= 0.01) continue;

      const c = parseParticleColor(p.color);
      const targetComposite = c.isLuminous ? 'screen' : 'source-over';
      if (targetComposite !== activeComposite) {
        ctx.globalCompositeOperation = targetComposite;
        activeComposite = targetComposite;
      }

      const r = c.isLuminous
        ? Math.max(2.5, p.size * 2.1)
        : Math.max(2.5, p.size * (p.expandRate > 0 ? 1.5 : 1.3));
      ctx.globalAlpha = c.isLuminous ? alpha : c.a * alpha;
      ctx.drawImage(getSoftParticleSprite(c), p.x - r, p.y - r, r * 2, r * 2);
    }
  } else {
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const alpha = MathUtil.clamp(p.life / p.maxLife, 0, 1);
      if (alpha <= 0.01) continue;

      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

export function renderFrame(ctx) {
  const frameId = ++state.frameCounter;
  const LOGICAL_WIDTH = state.logicalWidth;
  const segments = state.segments;
  const trackLength = state.trackLength;

  ctx.save();
  if (Math.abs(state.cameraRoll) > 0.0002) {
    ctx.translate(LOGICAL_WIDTH * 0.5, LOGICAL_HEIGHT * 0.5);
    ctx.rotate(state.cameraRoll);
    ctx.scale(1.03, 1.03);
    ctx.translate(-LOGICAL_WIDTH * 0.5, -LOGICAL_HEIGHT * 0.5);
  }

  renderBackground(ctx);

  if (!segments.length) {
    ctx.restore();
    return;
  }

  const baseSegment = findSegment(state.position);
  const basePercent = MathUtil.percentRemaining(state.position, SEGMENT_LENGTH);
  const playerSegment = findSegment(state.position + PLAYER_Z + PLAYER_CENTER_OFFSET_Z);
  const playerPercent = MathUtil.percentRemaining(state.position + PLAYER_Z + PLAYER_CENTER_OFFSET_Z, SEGMENT_LENGTH);
  const playerY = MathUtil.lerp(playerSegment.p1.world.y, playerSegment.p2.world.y, playerPercent);

  const effectiveCamXNorm = state.playerX - state.cameraLagX;
  // Запас +14px снизу исключает оголение фона в углах экрана при крене камеры (cameraRoll)
  let maxY = LOGICAL_HEIGHT + 14 + Math.max(0, state.cameraPitch);
  let x = 0;
  let dx = -(baseSegment.curve * basePercent);

  // 1. Прямой проход: проекция и отрисовка дорожного полотна
  for (let n = 0; n < DRAW_DISTANCE; n++) {
    const segIndex = (baseSegment.index + n) % segments.length;
    const seg = segments[segIndex];
    const looped = seg.index < baseSegment.index;
    const camZ = state.position - (looped ? trackLength : 0);

    project(
      seg.p1,
      (effectiveCamXNorm * ROAD_WIDTH) - x,
      playerY + CAMERA_HEIGHT,
      camZ,
      state.activeCameraDepth,
      LOGICAL_WIDTH,
      LOGICAL_HEIGHT,
      ROAD_WIDTH,
      state.cameraPitch
    );
    project(
      seg.p2,
      (effectiveCamXNorm * ROAD_WIDTH) - x - dx,
      playerY + CAMERA_HEIGHT,
      camZ,
      state.activeCameraDepth,
      LOGICAL_WIDTH,
      LOGICAL_HEIGHT,
      ROAD_WIDTH,
      state.cameraPitch
    );

    x += dx;
    dx += seg.curve;
    seg.clip = maxY;

    if (seg.p2.camera.z > MIN_SAMPLE_CAM_Z) {
      seg.projectedFrame = frameId;
    }

    if (
      seg.p1.camera.z <= state.activeCameraDepth ||
      seg.p2.screen.y >= seg.p1.screen.y ||
      seg.p2.screen.y >= maxY
    ) {
      continue;
    }

    const distNorm = Math.max(0, (n / DRAW_DISTANCE - 0.72) / 0.28);
    const fog = MathUtil.exponentialFog(distNorm, FOG_DENSITY);
    renderSegment(ctx, seg, fog * 0.28);

    maxY = seg.p2.screen.y;
  }

  renderRoadHeadlights(ctx);

  _foregroundCars.length = 0;
  _foregroundArchBeams.length = 0;
  const foregroundThresholdZ = PLAYER_Z + PLAYER_CENTER_OFFSET_Z;

  // 2. Обратный проход: отбойники, спрайты, машины и арки
  for (let n = DRAW_DISTANCE - 1; n >= 0; n--) {
    const segIndex = (baseSegment.index + n) % segments.length;
    const seg = segments[segIndex];
    _segArchBeams.length = 0;

    if (seg.p1.camera.z > MIN_GUARDRAIL_CAM_Z) {
      if (state.gameMode === 'circuit') {
        renderGuardrail(ctx, seg);
      }

      if (seg.p1.camera.z > MIN_SPRITE_CAM_Z) {
        for (let i = 0; i < seg.sprites.length; i++) {
          const sp = seg.sprites[i];
          const spriteScale = seg.p1.screen.scale;
          const spriteX = seg.p1.screen.x + (spriteScale * sp.offset * ROAD_WIDTH * PROJ_HALF_WIDTH);
          const spriteY = seg.p1.screen.y;
          const isArch = sp.type === 'start_arch' || sp.type === 'checkpoint_arch';

          if (isArch && seg.p1.camera.z < foregroundThresholdZ) {
            _segArchBeams.push({
              scale: spriteScale,
              x: spriteX,
              y: spriteY,
              clip: seg.clip,
              isStartFinish: sp.type === 'start_arch',
              camZ: seg.p1.camera.z,
              drawPillars: true
            });
            continue;
          }

          renderSprite(ctx, sp, spriteScale, spriteX, spriteY, seg.clip);

          if (isArch) {
            _segArchBeams.push({
              scale: spriteScale,
              x: spriteX,
              y: spriteY,
              clip: seg.clip,
              isStartFinish: sp.type === 'start_arch',
              camZ: seg.p1.camera.z,
              drawPillars: false
            });
          }
        }
      }
    }

    if (seg.cars.length > 0) {
      let segCars = seg.cars;
      if (segCars.length > 1) {
        _segCarsScratch.length = 0;
        for (let i = 0; i < segCars.length; i++) _segCarsScratch.push(segCars[i]);
        _segCarsScratch.sort(
          (a, b) => getShortestTrackDz(state.position, b.z, trackLength) - getShortestTrackDz(state.position, a.z, trackLength)
        );
        segCars = _segCarsScratch;
      }

      for (let i = 0; i < segCars.length; i++) {
        const car = segCars[i];
        if (car._renderedFrame === frameId) continue;
        car._renderedFrame = frameId;

        const carCamZ = getShortestTrackDz(state.position, car.z, trackLength);
        const halfCarLen = (car.lenZ || SEGMENT_LENGTH * 1.3) * 0.5;
        if (carCamZ + halfCarLen <= MIN_CAR_CAM_Z) continue;

        if (carCamZ < foregroundThresholdZ) {
          _foregroundCars.push({ car, carCamZ });
        } else {
          renderTrafficCar(ctx, car);
        }
      }
    }

    for (let b = 0; b < _segArchBeams.length; b++) {
      const beam = _segArchBeams[b];
      if (beam.drawPillars || beam.camZ < foregroundThresholdZ + 220) {
        _foregroundArchBeams.push(beam);
      } else {
        renderOverheadArchBeam(ctx, beam.scale, beam.x, beam.y, beam.clip, beam.isStartFinish);
      }
    }
  }

  // 3. Машина игрока (при Game Over, кроме полного тотала, остаётся стоять на месте, а камера улетает вперёд)
  const isTotalWreckGameOver =
    state.gameState === STATE.GAMEOVER &&
    state.gameMode !== 'circuit' &&
    state.visualDamage >= MAX_HARDCORE_COLLISIONS;
  const isDetachedGameOverCar = state.gameState === STATE.GAMEOVER && !isTotalWreckGameOver;

  if (!isDetachedGameOverCar) {
    renderPlayerCar(ctx);
  } else if (!state.playerCarPassedByCamera) {
    const parkedCamZ = getShortestTrackDz(state.position, state.stoppedPlayerZ, trackLength);
    if (parkedCamZ + PLAYER_LEN_Z * 0.5 <= MIN_CAR_CAM_Z) {
      state.playerCarPassedByCamera = true;
    } else {
      _foregroundCars.push({ isParkedPlayer: true, carCamZ: parkedCamZ });
    }
  }

  // 4. Машины на переднем плане
  if (_foregroundCars.length > 0) {
    _foregroundCars.sort((a, b) => b.carCamZ - a.carCamZ);
    for (let i = 0; i < _foregroundCars.length; i++) {
      const item = _foregroundCars[i];
      if (item.isParkedPlayer) {
        renderPlayerCar(ctx, item.carCamZ);
      } else {
        renderTrafficCar(ctx, item.car);
      }
    }
  }

  // 5. Ближние арки (перекладины и опоры, оказавшиеся ближе машины игрока)
  if (_foregroundArchBeams.length > 0) {
    _foregroundArchBeams.sort((a, b) => b.camZ - a.camZ);
    for (let b = 0; b < _foregroundArchBeams.length; b++) {
      const beam = _foregroundArchBeams[b];
      if (beam.drawPillars) {
        renderOverheadArchPillarsClipped(ctx, beam.scale, beam.x, beam.y, beam.clip, beam.isStartFinish);
      }
      renderOverheadArchBeam(ctx, beam.scale, beam.x, beam.y, beam.clip, beam.isStartFinish);
    }
  }

  // 6. Частицы
  renderParticles(ctx);

  ctx.restore();

  // 7. Горизонтальный HUD поверх сцены
  renderHUD(ctx);
}