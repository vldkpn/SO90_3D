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

// Кэш повторяемых слоёв фона (горы и город) для снижения нагрузки на CPU
const MOUNTAIN_TILE_W = 480;
const MOUNTAIN_TILE_H = 104;
const CITY_TILE_W = 640;
const CITY_TILE_H = 104;

let mountainTileCanvas = null;
let cityTileCanvas = null;

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
  p.screen.x = (width / 2) + (p.screen.scale * p.camera.x * PROJ_HALF_WIDTH);
  p.screen.y = (height / 2) + pitchOffset - (p.screen.scale * p.camera.y * height / 2);
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
  if (camZ <= state.activeCameraDepth * 0.35) return null;

  const safeCamZ = Math.max(state.activeCameraDepth * 0.65, camZ);
  const scale = state.activeCameraDepth / safeCamZ;
  return {
    camZ: camZ,
    scale: scale,
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
  const by1 = y1 + 0.65;
  const by2 = y2 + 0.65;
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

// Слои полутени для мягкого режима освещения (без нагрузки от ctx.filter)
const SOFT_SHADOW_LAYERS = [
  { wPad: 0.120, rPad: 0.060, fPad: 0.045, round: 0.34, color: 'rgba(7, 2, 18, 0.05)' },
  { wPad: 0.075, rPad: 0.038, fPad: 0.030, round: 0.30, color: 'rgba(7, 2, 18, 0.07)' },
  { wPad: 0.038, rPad: 0.020, fPad: 0.016, round: 0.26, color: 'rgba(7, 2, 18, 0.10)' },
  { wPad: 0.008, rPad: 0.006, fPad: 0.006, round: 0.22, color: 'rgba(7, 2, 18, 0.14)' },
  { wPad: -0.025, rPad: -0.014, fPad: -0.008, round: 0.18, color: 'rgba(7, 2, 18, 0.20)' }
];

const SOFT_SHADOW_FAR_LAYERS = [
  { wPad: 0.065, rPad: 0.032, fPad: 0.025, round: 0.28, color: 'rgba(7, 2, 18, 0.14)' },
  { wPad: -0.010, rPad: 0.000, fPad: 0.000, round: 0.20, color: 'rgba(7, 2, 18, 0.28)' }
];

const particleColorCache = new Map();

/**
 * Разбор цвета частицы (#hex или rgba) для плавных мягких градиентов
 */
function parseParticleColor(color) {
  const cached = particleColorCache.get(color);
  if (cached) return cached;

  let parsed = { r: 220, g: 220, b: 230, a: 0.7, isLuminous: false };
  if (typeof color === 'string') {
    if (color.startsWith('#') && color.length === 7) {
      const num = parseInt(color.slice(1), 16);
      if (!Number.isNaN(num)) {
        const lower = color.toLowerCase();
        parsed = {
          r: (num >> 16) & 255,
          g: (num >> 8) & 255,
          b: num & 255,
          a: 1.0,
          isLuminous: lower === '#ffbe0b' || lower === '#ff7b00'
        };
      }
    } else if (color.startsWith('rgba(') || color.startsWith('rgb(')) {
      const m = color.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/);
      if (m) {
        parsed = {
          r: Math.round(Number(m[1])),
          g: Math.round(Number(m[2])),
          b: Math.round(Number(m[3])),
          a: m[4] !== undefined ? Number(m[4]) : 1.0,
          isLuminous: false
        };
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

  ctx.fillStyle = seg.color.grass;
  ctx.fillRect(-40, y2, LOGICAL_WIDTH + 80, Math.max(1, y1 - y2 + 1.2));

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
    ? [-0.66, -0.23, 0.23, 0.66]
    : (state.gameMode === 'circuit' ? [-0.45, 0.45] : [-0.64, 0, 0.64]);
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

  const edgeW1 = Math.max(1.5, w1 * 0.026);
  const edgeW2 = Math.max(1.4, w2 * 0.026);
  renderPolygon(ctx, x1 - w1, y1, x1 - w1 + edgeW1, y1, x2 - w2 + edgeW2, y2, x2 - w2, y2, seg.color.edge);
  renderPolygon(ctx, x1 + w1 - edgeW1, y1, x1 + w1, y1, x2 + w2, y2, x2 + w2 - edgeW2, y2, seg.color.edge);

  if (state.gameMode === 'oncoming') {
    const divW1 = Math.max(1.6, w1 * 0.021);
    const divW2 = Math.max(1.5, w2 * 0.021);
    const divGap1 = Math.max(2.6, w1 * 0.035);
    const divGap2 = Math.max(2.3, w2 * 0.035);
    renderPolygon(ctx, x1 - divGap1 - divW1, y1, x1 - divGap1 + divW1, y1, x2 - divGap2 + divW2, y2, x2 - divGap2 - divW2, y2, '#ffbe0b');
    renderPolygon(ctx, x1 + divGap1 - divW1, y1, x1 + divGap1 + divW1, y1, x2 + divGap2 + divW2, y2, x2 + divGap2 - divW2, y2, '#ffbe0b');

    if (seg.color.lane) {
      const lw1 = Math.max(1.8, w1 * 0.024);
      const lw2 = Math.max(1.6, w2 * 0.024);
      for (const laneNorm of [-0.45, 0.45]) {
        const lx1 = x1 + w1 * laneNorm;
        const lx2 = x2 + w2 * laneNorm;
        renderPolygon(ctx, lx1 - lw1, y1, lx1 + lw1, y1, lx2 + lw2, y2, lx2 - lw2, y2, seg.color.lane);
      }
    }
  } else if (seg.color.lane) {
    const lw1 = Math.max(1.9, w1 * 0.026);
    const lw2 = Math.max(1.7, w2 * 0.026);
    const lanesNorm = state.gameMode === 'circuit' ? [0] : [-0.33, 0.33];
    for (const laneNorm of lanesNorm) {
      const lx1 = x1 + w1 * laneNorm;
      const lx2 = x2 + w2 * laneNorm;
      renderPolygon(ctx, lx1 - lw1, y1, lx1 + lw1, y1, lx2 + lw2, y2, lx2 - lw2, y2, seg.color.lane);
    }
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

      const hw1 = Math.max(1.3, sw1 * WHEEL_SKID_HALF_W);
      const hw2 = Math.max(1.1, sw2 * WHEEL_SKID_HALF_W);
      const trackColor = `rgba(7, 5, 14, ${sm.alpha.toFixed(2)})`;

      for (const wheelSide of [-WHEEL_TRACK_OFFSET, WHEEL_TRACK_OFFSET]) {
        const cx1 = sx1 + sw1 * (sm.x1 + wheelSide);
        const cx2 = sx2 + sw2 * (sm.x2 + wheelSide);
        renderPolygon(ctx, cx1 - hw1, sy1, cx1 + hw1, sy1, cx2 + hw2, sy2, cx2 - hw2, sy2, trackColor);
      }
    }
  }

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

  // Дымка горизонта накладывается поверх всех элементов полотна, включая разметку и чекпоинты
  if (fogAlpha > 0.01) {
    ctx.fillStyle = `rgba(26, 9, 52, ${fogAlpha.toFixed(3)})`;
    ctx.fillRect(-40, y2, LOGICAL_WIDTH + 80, Math.max(1, y1 - y2 + 1.2));
  }
}

function renderRoadHeadlights(ctx) {
  const LOGICAL_WIDTH = state.logicalWidth;
  const isTotalWreck = state.gameMode !== 'circuit' && state.visualDamage >= MAX_HARDCORE_COLLISIONS;
  if (isTotalWreck || (state.gameState !== STATE.PLAYING && state.gameState !== STATE.TITLE)) return;

  const hasDamageSystem = state.gameMode !== 'circuit';
  const flickerPhase = Math.floor(state.animClockMs / 95);
  const rightBroken = isTotalWreck || (hasDamageSystem && (state.frontDamage >= 3 || state.rightDamage >= 3 || state.visualDamage >= 4));
  const leftBroken = isTotalWreck || (hasDamageSystem && (state.leftDamage >= 3 || state.visualDamage >= 5));
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
      scale: scale,
      roadCenterX: (LOGICAL_WIDTH * 0.5) + scale * (-effectiveCamX) * PROJ_HALF_WIDTH,
      roadY: (LOGICAL_HEIGHT * 0.5) + state.cameraPitch - scale * (-CAMERA_HEIGHT) * (LOGICAL_HEIGHT * 0.5)
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
    if (i > 0 && s.roadY >= minYSoFar - 0.2) break;
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
      // Многослойное размытие боковых краёв конуса света без потери 60 FPS
      drawBeamPolygon(sideSign, 1.55, 1.65, 0.055, 0.028, 0.008);
      drawBeamPolygon(sideSign, 1.25, 1.28, 0.068, 0.036, 0.010);
      drawBeamPolygon(sideSign, 0.96, 0.94, 0.080, 0.042, 0.011);
      drawBeamPolygon(sideSign, 0.65, 0.56, 0.085, 0.038, 0.007);

      // Мягкое световое пятно на асфальте непосредственно перед фарой
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

  const sides = [];
  if (seg.guardrailLeft) sides.push(-1);
  if (seg.guardrailRight) sides.push(1);

  const isReflectorSeg = seg.index % 2 === 0;
  const railTopColor = isReflectorSeg ? '#ffe066' : '#f8fafc';
  const railColor = isReflectorSeg ? '#ffbe0b' : '#cbd5e1';
  const railLowerColor = isReflectorSeg ? '#ff2a85' : '#64748b';

  for (let s = 0; s < sides.length; s++) {
    const dir = sides[s];
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
  }

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
    lineW: Math.max(1.2, towerW * 0.14)
  };
}

function renderOverheadArchPillars(ctx, destX, destY, roadHalfPx, isStartFinish) {
  const L = computeArchLayout(destX, destY, roadHalfPx, isStartFinish);
  if (L.archH < 5) return;

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
  // Используем истинную проекционную полуширину дороги без повторного умножения на activeCameraDepth
  const roadHalfPx = scale * ROAD_WIDTH * PROJ_HALF_WIDTH;
  const horizontalBound = roadHalfPx * 1.55;
  if (roadHalfPx < 1.2 || destX + horizontalBound < -40 || destX - horizontalBound > LOGICAL_WIDTH + 40) {
    return;
  }

  const L = computeArchLayout(destX, destY, roadHalfPx, isStartFinish);
  if (L.archH < 5) return;

  ctx.save();
  if (clipY !== null && clipY !== undefined) {
    ctx.beginPath();
    ctx.rect(-40, 0, LOGICAL_WIDTH + 80, clipY);
    ctx.clip();
  }

  const beamOverhang = L.towerW * 0.16;
  const beamLeftX = L.leftOuterX - beamOverhang;
  const beamWidth = (L.rightOuterX + beamOverhang) - beamLeftX;

  const soffitH = Math.max(2, L.bannerH * 0.16);
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

  ctx.strokeStyle = L.accentColor;
  const rawBeaconR = L.towerW * 0.34;
  const beaconR = Math.max(1.5, rawBeaconR);
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
    const haloBaseR = Math.max(1.2, rawBeaconR);
    drawLightHalo(ctx, L.leftTowerCenterX, beaconY, haloBaseR, L.secondaryColor, haloBaseR * 3.2, beaconSoftStops, beaconHaloFade);
    drawLightHalo(ctx, L.rightTowerCenterX, beaconY, haloBaseR, L.secondaryColor, haloBaseR * 3.2, beaconSoftStops, beaconHaloFade);
  }

  if (L.bannerH >= 10) {
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
  // Истинная полуширина дороги на экране без лишнего множителя activeCameraDepth
  const roadHalfPx = scale * ROAD_WIDTH * PROJ_HALF_WIDTH;
  const unit = roadHalfPx * SPRITE_SCALE_RATIO;
  const isFullArch = sprite.type === 'start_arch' || sprite.type === 'checkpoint_arch';
  const horizontalBound = isFullArch ? roadHalfPx * 1.55 : unit * 1.25;

  if (roadHalfPx < 1.2 || destX + horizontalBound < -40 || destX - horizontalBound > LOGICAL_WIDTH + 40) {
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
    const trunkW = Math.max(2, unit * 0.055);
    const trunkH = unit * 0.85;
    const topX = destX + (sprite.offset < 0 ? -unit * 0.06 : unit * 0.06);
    const topY = destY - trunkH;

    const shadowLen = unit * 0.34;
    ctx.strokeStyle = 'rgba(6, 2, 16, 0.42)';
    ctx.lineWidth = Math.max(2, trunkW * 1.2);
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
    const poleW = Math.max(2, unit * 0.028);
    const poleH = unit * 0.78;
    const armDir = sprite.offset < 0 ? 1 : -1;
    const armLen = unit * 0.18 * armDir;

    const shadowLen = unit * 0.28;
    ctx.strokeStyle = 'rgba(6, 2, 16, 0.40)';
    ctx.lineWidth = Math.max(1.5, poleW * 1.1);
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
    const lampR = Math.max(1.4, rawLampR);
    ctx.fillStyle = '#00f0ff';
    ctx.beginPath();
    ctx.arc(lampX, lampY, lampR, 0, Math.PI * 2);
    ctx.fill();

    // Ореол фонаря плавно проявляется ещё на дальней дистанции без резкого «включения» вблизи игрока
    const lampHaloFade = MathUtil.clamp((rawLampR - 0.45) / 2.6, 0, 1);
    if (lampHaloFade > 0.01) {
      const haloBaseR = Math.max(1.1, rawLampR);
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
    ctx.lineWidth = Math.max(1.5, unit * 0.015);
    ctx.strokeRect(bx, by, boardW, boardH);

    if (boardH > 12) {
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
    ctx.lineWidth = Math.max(1.2, unit * 0.012);
    ctx.strokeRect(sx, sy, signW, signH);

    const dir = sprite.type === 'chevron_right' ? 1 : -1;
    ctx.strokeStyle = '#ff2a85';
    ctx.lineWidth = Math.max(2, signH * 0.16);
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
  const minVisibleCamZ = state.activeCameraDepth * 0.75;
  if (camZ + halfLen <= minVisibleCamZ) return;

  const effectiveNearOffset = Math.min(halfLen, Math.max(-halfLen, camZ - minVisibleCamZ));
  const clippedRear = halfLen - effectiveNearOffset;
  const nearFrac = clippedRear / lenZ;
  const visibleSpanFrac = Math.max(0.02, 1 - nearFrac);

  const zNear = (((centerZ - effectiveNearOffset) % trackLength) + trackLength) % trackLength;
  const zFar = (((centerZ + halfLen) % trackLength) + trackLength) % trackLength;

  const fallbackSample = (targetCamZ) => {
    const safeZ = Math.max(minVisibleCamZ, targetCamZ);
    const effectiveCamX = (state.playerX - state.cameraLagX) * ROAD_WIDTH;
    const scale = state.activeCameraDepth / safeZ;
    return {
      scale: scale,
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

  if (wNear < 2.2 || Math.max(cxNear + wNear, cxFar + wFar) < -40 || Math.min(cxNear - wNear, cxFar - wFar) > LOGICAL_WIDTH + 40) {
    return;
  }

  const clipY = near.clipY !== null && near.clipY !== undefined ? near.clipY : LOGICAL_HEIGHT;

  ctx.save();
  if (!isPlayer) {
    ctx.beginPath();
    ctx.rect(-40, 0, LOGICAL_WIDTH + 80, clipY);
    ctx.clip();
  }

  // Перспективно-корректная интерполяция (1/z) вдоль длины автомобиля,
  // устраняющая визуальное смещение арок и кабины назад к ближнему бамперу
  const sec = (t) => {
    const u = MathUtil.clamp((t - nearFrac) / visibleSpanFrac, 0, 1);
    const denom = Math.max(1e-6, (1 - u) * far.scale + u * near.scale);
    const uProj = (u * near.scale) / denom;
    return {
      t: t,
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

  let tCR = 0.18;
  let tRR = 0.30;
  let tRF = 0.64;
  let tCF = 0.76;
  let roofHalfFrac = 0.315;
  let tAxleNear = 0.22;
  let tAxleFar = 0.82;
  let dtWheel = 0.086;
  let wheelRFrac = 0.215;

  if (isVan) {
    tCR = 0.07;
    tRR = 0.13;
    tRF = 0.82;
    tCF = 0.91;
    roofHalfFrac = 0.36;
    tAxleNear = 0.21;
    tAxleFar = 0.81;
    dtWheel = 0.078;
    wheelRFrac = 0.175;
  } else if (type === 'sport') {
    tCR = 0.16;
    tRR = 0.28;
    tRF = 0.62;
    tCF = 0.75;
    roofHalfFrac = 0.30;
    tAxleNear = 0.22;
    tAxleFar = 0.82;
    dtWheel = 0.088;
    wheelRFrac = 0.215;
  } else if (type === 'sedan') {
    tCR = 0.16;
    tRR = 0.26;
    tRF = 0.67;
    tCF = 0.78;
    roofHalfFrac = 0.33;
    tAxleNear = 0.21;
    tAxleFar = 0.82;
    dtWheel = 0.084;
    wheelRFrac = 0.210;
  }

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

  // Торец кузова рисуется только пока машина не срезана ближней плоскостью камеры
  const showRearPanel = nearFrac < 0.03;

  const s0 = sec(Math.max(0.0, nearFrac));
  const saNearAxle = sec(Math.max(tAxleNear, nearFrac));
  const sCabinRear = sec(Math.max(tCR, nearFrac));
  const sRoofRear = sec(Math.max(tRR, nearFrac));
  const sRoofFront = sec(Math.max(tRF, nearFrac));
  const sCabinFront = sec(Math.max(tCF, nearFrac));
  const s1 = sec(1.0);

  if (isPlayer) {
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

  // 1. Контактная тень под днищем (утоплена чуть внутрь по ширине, чтобы был чётко виден просвет под порогами)
  const shadowHalfW = 0.450;
  const rearExtFactor = showRearPanel ? 1 : 0;
  const rearExtY = rearExtFactor * Math.max(1.5, s0.h * 0.06);
  const frontExtY = Math.max(0.8, s1.h * 0.04);
  const rearShiftX = rearExtFactor * MathUtil.clamp((s0.cx - s1.cx) * 0.08, -s0.w * 0.08, s0.w * 0.08);
  const frontShiftX = MathUtil.clamp((s1.cx - s0.cx) * 0.04, -s1.w * 0.06, s1.w * 0.06);

  const shRearCx = s0.cx + rearShiftX;
  const shRearY = s0.cy + rearExtY;
  const shRearBaseW = s0.w * (showRearPanel ? 1.01 : 1.0);
  const shFrontCx = s1.cx + frontShiftX;
  const shFrontY = s1.cy - frontExtY;
  const shFrontBaseW = s1.w * 0.99;

  if (state.settings.lightStyle === 'soft') {
    const layers = wNear >= 14 ? SOFT_SHADOW_LAYERS : SOFT_SHADOW_FAR_LAYERS;
    for (let l = 0; l < layers.length; l++) {
      const layer = layers[l];
      const hwNear = shRearBaseW * (shadowHalfW + layer.wPad);
      const hwFar = shFrontBaseW * (shadowHalfW + layer.wPad);
      const yNear = shRearY + rearExtFactor * s0.h * layer.rPad;
      const yFar = shFrontY - s1.h * layer.fPad;
      fillRoundedQuad(
        ctx,
        shRearCx - hwNear, yNear,
        shRearCx + hwNear, yNear,
        shFrontCx + hwFar, yFar,
        shFrontCx - hwFar, yFar,
        layer.round,
        layer.color
      );
    }
  } else {
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
  const axleOrder = [tAxleFar, tAxleNear];

  // Ровный профиль сечения кузова без выпуклых выступов посередине
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

  // Back-face culling для боковин кузова: отвёрнутый от камеры борт не рисуется и не вылезает из-за кормы
  const isFlankVisible = (sideSign) => {
    const edge0X = s0.cx + sideSign * s0.w * BODY_W_TOP;
    const edge1X = s1.cx + sideSign * s1.w * BODY_W_TOP;
    return sideSign * (edge1X - edge0X) > 0.35;
  };

  // Расчёт точной 3D-геометрии колеса на оси tAxle в перспективе кузова
  const tireOuterFrac = 0.460;
  const tireWidthFrac = isVan ? 0.140 : 0.155;
  const tireInnerFrac = tireOuterFrac - tireWidthFrac;

  const computeWheelMetrics = (sideSign, tAxle) => {
    if (tAxle < nearFrac) return null;
    const sa = sec(tAxle);
    const wheelR = Math.max(1.8, sa.h * wheelRFrac);
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

  // Отрисовка 3D-цилиндра протектора колеса в позиции его реальной оси (под днищем и за бампером)
  const drawWheelTread = (sideSign, tAxle) => {
    if (wNear < 4) return;
    const m = computeWheelMetrics(sideSign, tAxle);
    if (!m) return;

    const H = Math.hypot(m.uy, m.wheelR);
    const cosExt = m.uy / Math.max(1e-4, H);

    const topOutX = m.ox - m.uxOut * cosExt;
    const topOutY = m.oy - H;
    const botOutX = m.ox + m.uxOut * cosExt;
    const botOutY = m.oy + H;
    const topInX = m.ix - m.uxIn * cosExt;
    const topInY = m.iy - H;
    const botInX = m.ix + m.uxIn * cosExt;
    const botInY = m.iy + H;

    if (wNear >= 12 && Math.abs(m.uxIn) > 0.6) {
      ctx.save();
      ctx.transform(m.uxIn, m.uy, 0, -m.wheelR, m.ix, m.iy);
      ctx.fillStyle = '#07050e';
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    fillQuad(ctx, topInX, topInY, topOutX, topOutY, botOutX, botOutY, botInX, botInY, '#090712');

    if (wNear >= 12 && Math.abs(m.uxOut) > 0.6) {
      ctx.save();
      ctx.transform(m.uxOut, m.uy, 0, -m.wheelR, m.ox, m.oy);
      ctx.fillStyle = '#0e0b19';
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  };

  // Отрисовка перспективных колёсных арок (строго выше линии порога), боковин шин и дисков на видимом борту
  const drawSideWheelsAndArches = (sideSign) => {
    if (wNear < 9 || !isFlankVisible(sideSign)) return;

    const archR = 1.18;
    const ySill = (BODY_CLEARANCE / wheelRFrac) - 1;
    const startAng = Math.asin(MathUtil.clamp(ySill / archR, -0.35, 0.72));

    for (let a = 0; a < axleOrder.length; a++) {
      const m = computeWheelMetrics(sideSign, axleOrder[a]);
      if (!m || Math.abs(m.uxOut) < 0.7) continue;

      ctx.save();
      ctx.transform(m.uxOut, m.uy, 0, -m.wheelR, m.ox, m.oy);

      // Полукруглый вырез колёсной арки начинается строго от кромки порога, не закрывая дорожный просвет
      ctx.fillStyle = '#05030a';
      ctx.beginPath();
      ctx.arc(0, 0, archR, startAng, Math.PI - startAng, false);
      ctx.closePath();
      ctx.fill();

      if (wNear >= 20 && Math.abs(m.uxOut) >= 1.8) {
        ctx.strokeStyle = MathUtil.shadeHex(primary, 1.12);
        ctx.lineWidth = 0.065;
        ctx.beginPath();
        ctx.arc(0, 0, archR + 0.03, startAng + 0.14, Math.PI - startAng - 0.14, false);
        ctx.stroke();
      }

      // Боковина шины в перспективе
      ctx.fillStyle = '#141022';
      ctx.beginPath();
      ctx.arc(0, 0, 1.0, 0, Math.PI * 2);
      ctx.fill();

      // Диск и ступица
      if (Math.abs(m.uxOut) >= 1.3 && m.wheelR >= 3.2) {
        ctx.fillStyle = '#9aa5b1';
        ctx.beginPath();
        ctx.arc(0, 0, 0.56, 0, Math.PI * 2);
        ctx.fill();

        if (Math.abs(m.uxOut) >= 2.2 && m.wheelR >= 5.0) {
          ctx.fillStyle = '#334155';
          ctx.beginPath();
          ctx.arc(0, 0, 0.22, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      ctx.restore();
    }
  };

  // Вспомогательная отрисовка цельной ровной боковины кузова (поднятой на BODY_CLEARANCE над асфальтом)
  const drawLowerFlank = (sideSign) => {
    if (!isFlankVisible(sideSign)) return;

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

    // Чёткая кромка порога, подчёркивающая дорожный просвет между кузовом и асфальтом
    if (wNear >= 14) {
      ctx.strokeStyle = MathUtil.shadeHex(secondary, 1.18);
      ctx.lineWidth = Math.max(0.9, wNear * 0.009);
      ctx.beginPath();
      ctx.moveTo(s0.cx + sideSign * s0.w * BODY_W_BOT, s0.cy - s0.h * BODY_CLEARANCE);
      ctx.lineTo(s1.cx + sideSign * s1.w * BODY_W_BOT, s1.cy - s1.h * BODY_CLEARANCE);
      ctx.stroke();
    }

    // Боковые загибы ближнего и дальнего бамперов доходят строго до края колёсных арок
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

    // Продольные потёртости краски на повреждённом борту игрока
    if (isPlayer && wNear >= 24 && flankVisibility > 0.14) {
      const sideDmg = sideSign < 0 ? leftDamageLevel : rightDamageLevel;
      if (sideDmg >= 1) {
        const sScrapeA = sec(Math.max(nearFrac, 0.30));
        const sScrapeB = sec(Math.max(nearFrac, sideDmg >= 2 ? 0.72 : 0.56));
        if (sScrapeB.t > sScrapeA.t + 0.03) {
          ctx.strokeStyle = 'rgba(220, 228, 242, 0.42)';
          ctx.lineWidth = Math.max(1.0, wNear * 0.012);
          ctx.beginPath();
          ctx.moveTo(sScrapeA.cx + sideSign * sScrapeA.w * BODY_W_MID, sScrapeA.cy - sScrapeA.h * 0.44);
          ctx.lineTo(sScrapeB.cx + sideSign * sScrapeB.w * BODY_W_MID, sScrapeB.cy - sScrapeB.h * 0.46);
          ctx.stroke();
          if (sideDmg >= 2) {
            ctx.strokeStyle = 'rgba(28, 4, 16, 0.55)';
            ctx.lineWidth = Math.max(1.0, wNear * 0.010);
            ctx.beginPath();
            ctx.moveTo(sScrapeA.cx + sideSign * sScrapeA.w * BODY_W_BUMPER_TOP, sScrapeA.cy - sScrapeA.h * 0.40);
            ctx.lineTo(sScrapeB.cx + sideSign * sScrapeB.w * BODY_W_BUMPER_TOP, sScrapeB.cy - sScrapeB.h * 0.42);
            ctx.stroke();
          }
        }
      }
    }

    ctx.strokeStyle = MathUtil.shadeHex(primary, 1.15);
    ctx.lineWidth = Math.max(1.0, wNear * 0.011);
    ctx.beginPath();
    ctx.moveTo(s0.cx + sideSign * s0.w * BODY_W_TOP, s0.cy - s0.h * BODY_SHOULDER);
    ctx.lineTo(s1.cx + sideSign * s1.w * BODY_W_TOP, s1.cy - s1.h * BODY_SHOULDER);
    ctx.stroke();
  };

  // Вспомогательная отрисовка верхней боковины кабины и боковых стёкол (поверх капота и дальнего стекла)
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
      return { x: s.cx + sideSign * s.w * wFrac, y: s.cy - s.h * hFrac, t: t };
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

  // 2. Протекторы всех 4 колёс под днищем (строго на своих осях tAxleFar и tAxleNear, до отрисовки борта и кормы)
  for (let a = 0; a < axleOrder.length; a++) {
    drawWheelTread(flankOrder[0], axleOrder[a]);
    drawWheelTread(flankOrder[1], axleOrder[a]);
  }
  drawLowerFlank(flankOrder[0]);

  // 3. Дальние верхние плоскости: капот (или багажник встречки) и дальнее стекло
  fillQuad(ctx, sCabinFront.cx - sCabinFront.w * BODY_W_TOP, sCabinFront.cy - sCabinFront.h * BODY_SHOULDER, sCabinFront.cx + sCabinFront.w * BODY_W_TOP, sCabinFront.cy - sCabinFront.h * BODY_SHOULDER, s1.cx + s1.w * BODY_W_TOP, s1.cy - s1.h * BODY_SHOULDER, s1.cx - s1.w * BODY_W_TOP, s1.cy - s1.h * BODY_SHOULDER, deckColor);

  if (nearFrac < tCF) {
    fillQuad(ctx, sRoofFront.cx - sRoofFront.w * roofHalfFrac, sRoofFront.cy - sRoofFront.h * ROOF_TOP, sRoofFront.cx + sRoofFront.w * roofHalfFrac, sRoofFront.cy - sRoofFront.h * ROOF_TOP, sCabinFront.cx + sCabinFront.w * BODY_W_TOP, sCabinFront.cy - sCabinFront.h * BODY_SHOULDER, sCabinFront.cx - sCabinFront.w * BODY_W_TOP, sCabinFront.cy - sCabinFront.h * BODY_SHOULDER, pillarFrameColor);
    fillQuad(ctx, sRoofFront.cx - sRoofFront.w * innerGlassRoofFrac, sRoofFront.cy - sRoofFront.h * GLASS_TOP, sRoofFront.cx + sRoofFront.w * innerGlassRoofFrac, sRoofFront.cy - sRoofFront.h * GLASS_TOP, sCabinFront.cx + sCabinFront.w * 0.375, sCabinFront.cy - sCabinFront.h * GLASS_BOT, sCabinFront.cx - sCabinFront.w * 0.375, sCabinFront.cy - sCabinFront.h * GLASS_BOT, dir === -1 ? '#1d3557' : '#48cae4');
  }

  // 4. Ближняя нижняя боковина и её перспективные колёсные арки с дисками
  drawLowerFlank(flankOrder[1]);
  drawSideWheelsAndArches(flankOrder[1]);

  // 5. Крыша
  if (nearFrac < tRF) {
    fillQuad(ctx, sRoofRear.cx - sRoofRear.w * roofHalfFrac, sRoofRear.cy - sRoofRear.h * ROOF_TOP, sRoofRear.cx + sRoofRear.w * roofHalfFrac, sRoofRear.cy - sRoofRear.h * ROOF_TOP, sRoofFront.cx + sRoofFront.w * roofHalfFrac, sRoofFront.cy - sRoofFront.h * ROOF_TOP, sRoofFront.cx - sRoofFront.w * roofHalfFrac, sRoofFront.cy - sRoofFront.h * ROOF_TOP, roofColor);
  }

  // 6. Видимые боковины кабины и боковые стёкла (рисуются поверх капота, дальнего стекла и крыши)
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

    // Повреждения крышки багажника игрока: замятые грани металла, потёртости лака и копоть
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

      // Грани замятого металла на повреждённой стороне крышки багажника
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

      // Лёгкие царапины до грунта по кромкам крыльев
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

  // 9. Ближняя торцевая панель (корма для попутных, передок для встречных) — нависает над утопленными под кузовом колёсами
  if (showRearPanel) {
    const w0 = s0.w;
    const rearTopY = s0.cy - s0.h;
    const trunkLipY = s0.cy - s0.h * BODY_SHOULDER;

    // Вертикальная корма строго повторяет единое сечение кузова (w0) и поднята над дорогой на BODY_CLEARANCE
    fillQuad(ctx, s0.cx - w0 * BODY_W_BOT, s0.cy - s0.h * BODY_CLEARANCE, s0.cx + w0 * BODY_W_BOT, s0.cy - s0.h * BODY_CLEARANCE, s0.cx + w0 * BODY_W_MID, s0.cy - s0.h * BODY_MID, s0.cx - w0 * BODY_W_MID, s0.cy - s0.h * BODY_MID, secondary);
    fillQuad(ctx, s0.cx - w0 * BODY_W_MID, s0.cy - s0.h * BODY_MID, s0.cx + w0 * BODY_W_MID, s0.cy - s0.h * BODY_MID, s0.cx + w0 * BODY_W_TOP, trunkLipY, s0.cx - w0 * BODY_W_TOP, trunkLipY, primary);

    // Тонкий световой акцент на верхней кромке багажника/капота
    if (w0 >= 14) {
      ctx.strokeStyle = MathUtil.shadeHex(primary, 1.18);
      ctx.lineWidth = Math.max(1.0, s0.h * 0.016);
      ctx.beginPath();
      ctx.moveTo(s0.cx - w0 * BODY_W_TOP, trunkLipY);
      ctx.lineTo(s0.cx + w0 * BODY_W_TOP, trunkLipY);
      ctx.stroke();
    }

    // Повреждения металлической кормы игрока (рисуются строго ПОД оптикой, бампером и огнями выхлопа)
    if (isPlayer && (visualDamageLevel >= 1 || rearDamageLevel >= 1) && wNear >= 20) {
      // Щель перекошенной крышки багажника вдоль верхней кромки
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

      // Гранёная вмятина на центральной панели между задними фонарями
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
        ctx.lineWidth = Math.max(1.0, s0.h * 0.016);
        ctx.beginPath();
        ctx.moveTo(dPeakX, dPeakY);
        ctx.lineTo(seamSide < 0 ? dLeftX : dRightX, dTopY);
        ctx.stroke();
      }

      // Копоть на центральной части кормы при сильном повреждении мотора
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

      // Потёртости краски до грунта на наружных углах крыльев (вне зоны фонарей)
      const drawQuarterScuff = (sideSign) => {
        const xOuter = s0.cx + sideSign * w0 * 0.456;
        const xInner = s0.cx + sideSign * w0 * 0.410;
        ctx.strokeStyle = 'rgba(218, 226, 240, 0.46)';
        ctx.lineWidth = Math.max(1.0, s0.h * 0.018);
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

    // Расчёт провисания заднего бампера при повреждениях игрока
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

    // Бампер строго в габарите кузова и с чистым просветом над дорогой
    fillQuad(
      ctx,
      s0.cx - w0 * BODY_W_BOT, s0.cy - s0.h * BODY_CLEARANCE + leftBumperDrop,
      s0.cx + w0 * BODY_W_BOT, s0.cy - s0.h * BODY_CLEARANCE + rightBumperDrop,
      s0.cx + w0 * BODY_W_BUMPER_TOP, s0.cy - s0.h * BUMPER_TOP + rightBumperDrop,
      s0.cx - w0 * BODY_W_BUMPER_TOP, s0.cy - s0.h * BUMPER_TOP + leftBumperDrop,
      '#151124'
    );

    // Потёртости на углах пластикового бампера (вне зоны номера и строго ПОД огнями выхлопа)
    if (isPlayer && (visualDamageLevel >= 1 || rearDamageLevel >= 1) && wNear >= 20) {
      const drawBumperScuff = (sideSign) => {
        const dropFracA = sideSign < 0 ? 0.04 : 0.96;
        const dropFracB = sideSign < 0 ? 0.15 : 0.85;
        const dropA = MathUtil.lerp(leftBumperDrop, rightBumperDrop, dropFracA);
        const dropB = MathUtil.lerp(leftBumperDrop, rightBumperDrop, dropFracB);
        const xOuter = s0.cx + sideSign * w0 * 0.445;
        const xInner = s0.cx + sideSign * w0 * 0.335;

        ctx.strokeStyle = 'rgba(176, 184, 206, 0.36)';
        ctx.lineWidth = Math.max(1.0, s0.h * 0.018);
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

    // Выхлопные патрубки и пламя (рисуются ПОСЛЕ бампера и его потёртостей — ничего не перекрывает огонь)
    if (isPlayer) {
      const flameY = s0.cy - s0.h * (BODY_CLEARANCE + 0.03);
      const leftPipeX = s0.cx - w0 * 0.26;
      const rightPipeX = s0.cx + w0 * 0.26;

      if (wNear >= 20) {
        const pipeRx = Math.max(2.0, w0 * 0.028);
        const pipeRy = Math.max(1.6, s0.h * 0.026);
        ctx.fillStyle = '#090612';
        ctx.strokeStyle = '#475569';
        ctx.lineWidth = Math.max(1.0, w0 * 0.008);
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

    // Оптика и номерной знак рисуются ПОСЛЕ повреждений кузова/бампера и ДО антикрыла
    const lightW = w0 * 0.155;
    const lightH = s0.h * 0.12;
    const leftLightX = s0.cx - w0 * 0.395;
    const rightLightX = s0.cx + w0 * 0.395 - lightW;
    const leftLightY = s0.cy - s0.h * 0.535;
    const rightLightY = s0.cy - s0.h * 0.535;

    if (dir === -1) {
      ctx.fillStyle = '#0d091a';
      ctx.fillRect(s0.cx - w0 * 0.21, leftLightY + lightH * 0.1, w0 * 0.42, lightH * 0.85);

      ctx.fillStyle = damagedByPlayer ? '#241f33' : (highBeamFlashing ? '#e0ffff' : '#ffffff');
      ctx.fillRect(leftLightX, leftLightY, lightW, lightH);
      ctx.fillRect(rightLightX, rightLightY, lightW, lightH);

      // Плавное проявление ореолов встречных фар начиная с дальней дистанции (w0 > 3.5)
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
      const leftLit = !leftLightBroken && !leftLightFlicker;
      const rightLit = !rightLightBroken && !rightLightFlicker;

      // Разбитый фонарь игрока: тёмный корпус с осколком красного стекла и отблеском отражателя внутри рамки
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
        ctx.fillStyle = leftLit && braking ? '#ff4d6d' : (leftLit ? '#9e0b28' : '#3d0815');
        ctx.fillRect(leftLightX, leftLightY, lightW, lightH);
      }

      if (rightLightBroken) {
        drawBrokenTaillight(rightLightX, rightLightY, false);
      } else {
        ctx.fillStyle = rightLit && braking ? '#ff4d6d' : (rightLit ? '#9e0b28' : '#3d0815');
        ctx.fillRect(rightLightX, rightLightY, lightW, lightH);
      }

      // Плавное проявление ореолов стоп-сигналов начиная с дальней дистанции (w0 > 4)
      const brakeHaloFade = MathUtil.clamp((w0 - 4.0) / 14, 0, 1);
      if (braking && brakeHaloFade > 0.01 && (leftLit || rightLit)) {
        const hardBrakeR = lightW * (isPlayer ? 1.15 : 1.05);
        const hardBrakeColor = isPlayer ? 'rgba(255, 42, 95, 0.38)' : 'rgba(255, 42, 95, 0.36)';
        const softBrakeR = lightW * (isPlayer ? 2.15 : 1.9);
        const softBrakeStops = [
          [0.0, 'rgba(255, 195, 210, 0.82)'],
          [0.34, 'rgba(255, 42, 95, 0.50)'],
          [1.0, 'rgba(255, 20, 75, 0.0)']
        ];
        if (leftLit) {
          drawLightHalo(ctx, leftLightX + lightW * 0.5, leftLightY + lightH * 0.5, hardBrakeR, hardBrakeColor, softBrakeR, softBrakeStops, brakeHaloFade);
        }
        if (rightLit) {
          drawLightHalo(ctx, rightLightX + lightW * 0.5, rightLightY + lightH * 0.5, hardBrakeR, hardBrakeColor, softBrakeR, softBrakeStops, brakeHaloFade);
        }
      }
    }

    if (isPlayer) {
      const revW = w0 * 0.085;
      const revH = lightH * 0.82;
      const leftRevX = s0.cx - w0 * 0.225;
      const rightRevX = s0.cx + w0 * 0.225 - revW;
      const leftRevY = leftLightY + (lightH - revH) * 0.5;
      const rightRevY = rightLightY + (lightH - revH) * 0.5;
      ctx.fillStyle = reversing ? '#ffffff' : (isTotalWreck ? '#262030' : '#3a2d47');
      ctx.fillRect(leftRevX, leftRevY, revW, revH);
      ctx.fillRect(rightRevX, rightRevY, revW, revH);

      if (reversing) {
        const revSoftStops = [
          [0.0, 'rgba(255, 255, 255, 0.90)'],
          [0.35, 'rgba(200, 245, 255, 0.48)'],
          [1.0, 'rgba(180, 240, 255, 0.0)']
        ];
        drawLightHalo(ctx, leftRevX + revW * 0.5, leftRevY + revH * 0.5, revW * 1.5, 'rgba(220, 250, 255, 0.50)', revW * 2.6, revSoftStops);
        drawLightHalo(ctx, rightRevX + revW * 0.5, rightRevY + revH * 0.5, revW * 1.5, 'rgba(220, 250, 255, 0.50)', revW * 2.6, revSoftStops);
      }

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
    } else {
      // Отрисовка фонаря поворотника/аварийки строго внутри габарита кормы (w0)
      const drawAmberSignalGlow = (lampX, lampY, lampW, lampH, blinkOn) => {
        ctx.fillStyle = blinkOn ? '#ffbe0b' : '#4a2b00';
        ctx.fillRect(lampX, lampY, lampW, lampH);

        const signalHaloFade = MathUtil.clamp((w0 - 3.5) / 10, 0, 1);
        if (blinkOn && signalHaloFade > 0.01) {
          const gx = lampX + lampW * 0.5;
          const gy = lampY + lampH * 0.5;
          const hardR = Math.max(lampW * 1.45, w0 * 0.095);
          const softR = Math.max(lampW * 3.2, w0 * 0.22);

          drawLightHalo(ctx, gx, gy, hardR, 'rgba(255, 190, 11, 0.52)', softR, [
            [0.0, 'rgba(255, 250, 215, 0.95)'],
            [0.26, 'rgba(255, 195, 20, 0.62)'],
            [0.58, 'rgba(255, 115, 0, 0.24)'],
            [1.0, 'rgba(255, 90, 0, 0.0)']
          ], signalHaloFade);

          ctx.fillStyle = '#fff9db';
          ctx.fillRect(lampX + lampW * 0.18, lampY + lampH * 0.18, lampW * 0.64, lampH * 0.64);
        }
      };

      const signalOuterX = w0 * 0.448;
      if (!isRival && !damagedByPlayer && turnSignal !== 0) {
        const blinkOn = Math.floor(signalElapsed / 0.18) % 2 === 0;
        const indW = Math.max(2.0, w0 * 0.056);
        const indH = Math.max(1.8, lightH * 1.02);
        const indX = turnSignal === -1 ? (s0.cx - signalOuterX) : (s0.cx + signalOuterX - indW);
        drawAmberSignalGlow(indX, leftLightY - indH * 0.02, indW, indH, blinkOn);
      }

      if (damagedByPlayer) {
        const hazardOn = Math.floor(state.animClockMs / 260) % 2 === 0;
        const hazW = Math.max(2.0, w0 * 0.055);
        const hazH = Math.max(1.8, lightH * 1.00);
        const hazY = leftLightY;
        drawAmberSignalGlow(s0.cx - signalOuterX, hazY, hazW, hazH, hazardOn);
        drawAmberSignalGlow(s0.cx + signalOuterX - hazW, hazY, hazW, hazH, hazardOn);
      }
    }

    // Лип-спойлер гражданских спорткаров строго в ширине кормы
    if (!isPlayer && !isRival && type === 'sport' && dir === 1 && w0 > 16) {
      const lipH = Math.max(1.8, s0.h * 0.055);
      ctx.fillStyle = MathUtil.shadeHex(secondary, 0.85);
      ctx.fillRect(s0.cx - w0 * 0.43, trunkLipY - lipH, w0 * 0.86, lipH);
    }

    // Антикрыло игрока и соперников рисуется поверх оптики кормы (сломанная половина естественно нависает над фарой)
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
        ctx.lineWidth = strutW;
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
        ctx.lineWidth = strutW;
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

    // Бейдж соперника рисуется последним поверх всего кузова
    if (!isPlayer && isRival && w0 > 36) {
      const tagW = Math.max(46, w0 * 0.68);
      const tagH = 15;
      const tagX = s0.cx - tagW * 0.5;
      const tagY = rearTopY - 22;
      ctx.fillStyle = 'rgba(13, 2, 33, 0.82)';
      ctx.strokeStyle = primary;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(tagX, tagY, tagW, tagH, 4);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.font = '800 9.5px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`#${num} ${name}`, s0.cx, tagY + tagH * 0.52);
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
    num: car.num || ''
  });
}

function renderPlayerCar(ctx, parkedCamZ = null) {
  const isParkedDetach = parkedCamZ !== null;
  const absSpeedRatio = Math.abs(state.speed) / MAX_SPEED;
  const isOffRoad = Math.abs(state.playerX) > OFF_ROAD_THRESHOLD_X;
  const activeVisualDamage = state.gameMode !== 'circuit' ? state.visualDamage : 0;

  const baseBounce = (!isParkedDetach && !state.isPaused && Math.abs(state.speed) > 15)
    ? Math.sin(state.animClockMs * 0.045) * (0.5 + absSpeedRatio * 1.4)
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

  const isReversing = !isParkedDetach && !isTotalWreck && state.gameState === STATE.PLAYING && (state.speed < -2 || (input.down && !input.up && state.speed <= 2));
  const isBraking = isParkedDetach
    ? !isTotalWreck
    : (!isTotalWreck && !isReversing && ((input.down && state.speed > 2) || (input.up && input.down) || Math.abs(state.speed) < 15));
  const leftLightBroken = isTotalWreck || (hasDamageSystem && (state.leftDamage >= 3 || state.visualDamage >= 4));
  const rightLightBroken = isTotalWreck || (hasDamageSystem && (state.rightDamage >= 3 || state.visualDamage >= 4));
  const leftLightFlicker = !leftLightBroken && hasDamageSystem && state.leftDamage >= 2 && (flickerPhase % 3 === 0);
  const rightLightFlicker = !rightLightBroken && hasDamageSystem && state.rightDamage >= 2 && (flickerPhase % 4 === 1);
  const showExhaustFlame = !isParkedDetach && !state.isPaused && !isTotalWreck && input.up && !input.down && state.speed / MAX_SPEED > 0.72 && !state.isOverheated && state.engineMisfireTimer <= 0;
  const showBackfireFlame = !isParkedDetach && !state.isPaused && !isTotalWreck && activeVisualDamage >= 4 && state.engineMisfireTimer > 0 && input.up;

  render3DCar(ctx, {
    isPlayer: true,
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
    useFallback: true,
    braking: isBraking,
    reversing: isReversing,
    isTotalWreck: isTotalWreck,
    leftLightBroken: leftLightBroken,
    rightLightBroken: rightLightBroken,
    leftLightFlicker: leftLightFlicker,
    rightLightFlicker: rightLightFlicker,
    visualDamageLevel: activeVisualDamage,
    leftDamageLevel: hasDamageSystem ? state.leftDamage : 0,
    rightDamageLevel: hasDamageSystem ? state.rightDamage : 0,
    rearDamageLevel: hasDamageSystem ? state.rearDamage : 0,
    spoilerDamageSide: hasDamageSystem ? state.spoilerDamageSide : 0,
    showExhaustFlame: showExhaustFlame,
    isSlipstreamingFlame: state.isSlipstreaming,
    showBackfireFlame: showBackfireFlame
  });
}

function renderParticles(ctx) {
  if (!state.settings.particlesEnabled) return;
  const particles = state.particles;
  const isSoftLight = state.settings.lightStyle === 'soft';

  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    const alpha = MathUtil.clamp(p.life / p.maxLife, 0, 1);
    if (alpha <= 0.01) continue;

    ctx.save();
    if (isSoftLight) {
      const c = parseParticleColor(p.color);
      if (c.isLuminous) {
        // Мягкие светящиеся искры и прострелы выхлопа
        const r = Math.max(2.5, p.size * 2.1);
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = alpha;
        const grad = ctx.createRadialGradient(p.x, p.y, r * 0.06, p.x, p.y, r);
        grad.addColorStop(0.0, 'rgba(255, 253, 232, 0.96)');
        grad.addColorStop(0.32, `rgba(${c.r}, ${c.g}, ${c.b}, 0.72)`);
        grad.addColorStop(0.70, `rgba(${c.r}, ${Math.round(c.g * 0.55)}, 0, 0.22)`);
        grad.addColorStop(1.0, `rgba(${c.r}, ${Math.round(c.g * 0.4)}, 0, 0.0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Мягкие размытые клубы дыма от шин/мотора и облачка пыли на обочине
        const r = Math.max(2.5, p.size * (p.expandRate > 0 ? 1.5 : 1.3));
        const baseA = c.a * alpha;
        const grad = ctx.createRadialGradient(p.x, p.y, r * 0.08, p.x, p.y, r);
        grad.addColorStop(0.0, `rgba(${c.r}, ${c.g}, ${c.b}, ${(baseA * 0.92).toFixed(3)})`);
        grad.addColorStop(0.45, `rgba(${c.r}, ${c.g}, ${c.b}, ${(baseA * 0.46).toFixed(3)})`);
        grad.addColorStop(1.0, `rgba(${c.r}, ${c.g}, ${c.b}, 0.0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

export function renderFrame(ctx) {
  state.frameCounter++;
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
  let maxY = Math.max(LOGICAL_HEIGHT, LOGICAL_HEIGHT + state.cameraPitch);
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

    // Отмечаем все спроецированные сегменты впереди камеры (включая скрытые за холмами),
    // чтобы машины плавно выезжали из-за перегиба с обрезкой по seg.clip
    if (seg.p2.camera.z > state.activeCameraDepth * 0.35) {
      seg.projectedFrame = state.frameCounter;
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

  const foregroundCars = [];
  const foregroundArchBeams = [];
  const renderedCars = new Set();
  const foregroundThresholdZ = PLAYER_Z + PLAYER_CENTER_OFFSET_Z;

  // 2. Обратный проход: отбойники, спрайты, машины и арки
  for (let n = DRAW_DISTANCE - 1; n >= -1; n--) {
    const segIndex = (baseSegment.index + n + segments.length) % segments.length;
    const seg = segments[segIndex];
    const segArchBeams = [];

    if (n >= 0 && seg.p1.camera.z > state.activeCameraDepth) {
      if (state.gameMode === 'circuit') {
        renderGuardrail(ctx, seg);
      }

      for (let i = 0; i < seg.sprites.length; i++) {
        const sp = seg.sprites[i];
        const spriteScale = seg.p1.screen.scale;
        const spriteX = seg.p1.screen.x + (spriteScale * sp.offset * ROAD_WIDTH * PROJ_HALF_WIDTH);
        const spriteY = seg.p1.screen.y;
        const isArch = sp.type === 'start_arch' || sp.type === 'checkpoint_arch';

        if (isArch && seg.p1.camera.z < foregroundThresholdZ) {
          // Если арка уже между камерой и машиной игрока, откладываем и опоры, и перекладину на передний план
          segArchBeams.push({
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
          segArchBeams.push({
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

    if (seg.cars.length > 0) {
      const segCars = seg.cars.length > 1
        ? seg.cars.slice().sort((a, b) => getShortestTrackDz(state.position, b.z, trackLength) - getShortestTrackDz(state.position, a.z, trackLength))
        : seg.cars;

      for (let i = 0; i < segCars.length; i++) {
        const car = segCars[i];
        if (renderedCars.has(car)) continue;
        renderedCars.add(car);

        const carCamZ = getShortestTrackDz(state.position, car.z, trackLength);
        const halfCarLen = (car.lenZ || SEGMENT_LENGTH * 1.3) * 0.5;
        if (carCamZ + halfCarLen <= state.activeCameraDepth * 0.75) continue;

        if (carCamZ < foregroundThresholdZ) {
          foregroundCars.push({ car, carCamZ });
        } else {
          renderTrafficCar(ctx, car);
        }
      }
    }

    for (let b = 0; b < segArchBeams.length; b++) {
      const beam = segArchBeams[b];
      if (beam.drawPillars || beam.camZ < foregroundThresholdZ + 220) {
        foregroundArchBeams.push(beam);
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
    if (parkedCamZ + PLAYER_LEN_Z * 0.5 <= state.activeCameraDepth * 0.75) {
      state.playerCarPassedByCamera = true;
    } else {
      foregroundCars.push({ isParkedPlayer: true, carCamZ: parkedCamZ });
    }
  }

  // 4. Машины на переднем плане
  if (foregroundCars.length > 0) {
    foregroundCars.sort((a, b) => b.carCamZ - a.carCamZ);
    for (let i = 0; i < foregroundCars.length; i++) {
      const item = foregroundCars[i];
      if (item.isParkedPlayer) {
        renderPlayerCar(ctx, item.carCamZ);
      } else {
        renderTrafficCar(ctx, item.car);
      }
    }
  }

  // 5. Ближние арки (перекладины и опоры, оказавшиеся ближе машины игрока)
  if (foregroundArchBeams.length > 0) {
    foregroundArchBeams.sort((a, b) => b.camZ - a.camZ);
    for (let b = 0; b < foregroundArchBeams.length; b++) {
      const beam = foregroundArchBeams[b];
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