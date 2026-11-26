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
 * Однократная генерация тайла гор в offscreen-канвасе
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

  const drawSingleHeadlight = (sideSign) => {
    const leftPts = [];
    const rightPts = [];

    for (let i = 0; i < slices.length; i++) {
      const sl = slices[i];
      const rayCenterRelCamX = bumperRelCamX + sl.dZ * yawSlope + sideSign * lampLateralWorld;
      const halfWWorld = lampStartHalfW + sl.dZ * 0.082;

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
    grad.addColorStop(0.0, 'rgba(205, 248, 255, 0.25)');
    grad.addColorStop(0.32, 'rgba(175, 240, 255, 0.12)');
    grad.addColorStop(0.72, 'rgba(140, 225, 255, 0.035)');
    grad.addColorStop(1.0, 'rgba(140, 225, 255, 0.0)');

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(leftPts[0].x, leftPts[0].y);
    for (let i = 1; i < leftPts.length; i++) ctx.lineTo(leftPts[i].x, leftPts[i].y);
    for (let i = rightPts.length - 1; i >= 0; i--) ctx.lineTo(rightPts[i].x, rightPts[i].y);
    ctx.closePath();
    ctx.fill();
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
  ctx.lineWidth = Math.max(1.4, L.lineW * 1.15);
  ctx.strokeRect(beamLeftX, L.topY, beamWidth, L.bannerH);

  const beaconR = Math.max(2, L.towerW * 0.34);
  const beaconY = L.topY - beaconR * 0.85;
  ctx.fillStyle = L.secondaryColor;
  ctx.beginPath();
  ctx.arc(L.leftTowerCenterX, beaconY, beaconR, 0, Math.PI * 2);
  ctx.arc(L.rightTowerCenterX, beaconY, beaconR, 0, Math.PI * 2);
  ctx.fill();

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
    const lampR = Math.max(2, unit * 0.032);
    ctx.fillStyle = '#00f0ff';
    ctx.beginPath();
    ctx.arc(lampX, lampY, lampR, 0, Math.PI * 2);
    ctx.fill();

    if (lampR > 3.5) {
      ctx.fillStyle = 'rgba(0, 240, 255, 0.22)';
      ctx.beginPath();
      ctx.arc(lampX, lampY, lampR * 2.6, 0, Math.PI * 2);
      ctx.fill();
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

  const sec = (t) => {
    const u = MathUtil.clamp((t - nearFrac) / visibleSpanFrac, 0, 1);
    return {
      cx: MathUtil.lerp(cxNear, cxFar, u),
      cy: MathUtil.lerp(cyNear, cyFar, u),
      w: MathUtil.lerp(wNear, wFar, u),
      h: MathUtil.lerp(hNear, hFar, u)
    };
  };

  const isVan = type === 'van';
  let tCR = 0.22;
  let tRR = 0.33;
  let tRF = 0.68;
  let tCF = 0.82;
  let roofHalfFrac = 0.32;
  if (isVan) {
    tCR = 0.08;
    tRR = 0.14;
    tRF = 0.86;
    tCF = 0.94;
    roofHalfFrac = 0.36;
  } else if (type === 'sport') {
    tCR = 0.18;
    tRR = 0.30;
    tRF = 0.66;
    tCF = 0.80;
    roofHalfFrac = 0.30;
  } else if (type === 'sedan') {
    tCR = 0.19;
    tRR = 0.29;
    tRF = 0.73;
    tCF = 0.85;
    roofHalfFrac = 0.33;
  } else if (type === 'coupe') {
    tCR = 0.24;
    tRR = 0.35;
    tRF = 0.68;
    tCF = 0.82;
    roofHalfFrac = 0.315;
  }

  // Зеркалируем продольные пропорции кузова для встречных машин (капот и лобовое обращены к камере)
  if (dir === -1) {
    const origCR = tCR;
    const origRR = tRR;
    const origRF = tRF;
    const origCF = tCF;
    tCR = 1 - origCF;
    tRR = 1 - origRF;
    tRF = 1 - origRR;
    tCF = 1 - origCR;
  }

  // Торец кузова рисуется только пока машина не срезана ближней плоскостью камеры
  const showRearPanel = nearFrac < 0.03;

  const s0 = sec(Math.max(0.0, nearFrac));
  const sCabinRear = sec(Math.max(tCR, nearFrac));
  const sRoofRear = sec(Math.max(tRR, nearFrac));
  const sRoofFront = sec(Math.max(tRF, nearFrac));
  const sCabinFront = sec(Math.max(tCF, nearFrac));
  const s1 = sec(1.0);

  if (isPlayer) {
    const a = state.playerScreenAnchors;
    a.rearCenterX = s0.cx;
    a.rearCenterY = s0.cy - s0.h * 0.30;
    a.rearGroundY = s0.cy;
    a.centerX = (s0.cx + s1.cx) * 0.5;
    a.centerY = (s0.cy + s1.cy) * 0.5 - s0.h * 0.30;
    a.hoodY = s0.cy - s0.h * 0.58;
    a.carW = s0.w;
    a.carH = s0.h;
    a.leftWheelX = s0.cx - s0.w * 0.38;
    a.leftWheelY = s0.cy - s0.h * 0.04;
    a.rightWheelX = s0.cx + s0.w * 0.38;
    a.rightWheelY = s0.cy - s0.h * 0.04;
    a.exhaustLeftX = s0.cx - s0.w * 0.26;
    a.exhaustRightX = s0.cx + s0.w * 0.26;
    a.exhaustY = s0.cy - s0.h * 0.18;
  }

  // 1. Тени на асфальте
  fillQuad(ctx, s0.cx - s0.w * 0.55, s0.cy + 1, s0.cx + s0.w * 0.55, s0.cy + 1, s1.cx + s1.w * 0.55, s1.cy + 1, s1.cx - s1.w * 0.55, s1.cy + 1, isPlayer ? 'rgba(0, 0, 0, 0.52)' : 'rgba(0, 0, 0, 0.50)');

  if (showRearPanel && hNear > 6) {
    const sunX = getSunX();
    const sunShift = MathUtil.clamp((s0.cx - sunX) * 0.04, -s0.w * 0.25, s0.w * 0.25);
    const sunsetShadowLen = hNear * 0.72;
    fillQuad(ctx, s0.cx - s0.w * 0.52, s0.cy + 1, s0.cx + s0.w * 0.52, s0.cy + 1, s0.cx + s0.w * 0.58 + sunShift, s0.cy + sunsetShadowLen, s0.cx - s0.w * 0.58 + sunShift, s0.cy + sunsetShadowLen, 'rgba(7, 2, 18, 0.36)');
  }

  const lateralDeltaX = s1.cx - s0.cx;
  const flankOrder = lateralDeltaX >= 0 ? [-1, 1] : [1, -1];
  const axleTs = [0.20, 0.80];

  const flankLowerColor = MathUtil.shadeHex(secondary, 0.76);
  const flankUpperColor = MathUtil.shadeHex(primary, 0.86);
  const roofColor = MathUtil.shadeHex(primary, 1.18);
  const deckColor = MathUtil.shadeHex(primary, 1.04);
  const pillarFrameColor = MathUtil.shadeHex(primary, 0.94);
  const innerGlassRoofFrac = roofHalfFrac * 0.80;

  // Вспомогательная отрисовка боковых колёс и дисков для одной стороны кузова
  const drawSideWheels = (sideSign, drawRims = true) => {
    if (wNear < 10) return;
    for (let a = 0; a < axleTs.length; a++) {
      if (axleTs[a] < nearFrac) continue;
      const sa = sec(axleTs[a]);
      const wheelR = Math.max(2, sa.h * 0.21);
      const wheelThick = Math.max(1.6, sa.w * 0.056);
      const wx = sa.cx + sideSign * sa.w * 0.475;
      const wy = sa.cy - wheelR * 0.90;

      // Тёмная колёсная арка для выразительного контраста на борту
      if (drawRims && wheelR >= 3.2) {
        ctx.fillStyle = '#05030a';
        ctx.beginPath();
        ctx.ellipse(wx - sideSign * wheelThick * 0.12, wy - wheelR * 0.08, wheelThick * 1.18, wheelR * 1.12, 0, Math.PI, Math.PI * 2);
        ctx.fill();
      }

      ctx.fillStyle = '#090712';
      ctx.beginPath();
      ctx.ellipse(wx, wy, wheelThick, wheelR, 0, 0, Math.PI * 2);
      ctx.fill();

      if (drawRims && wheelR >= 3.5) {
        ctx.fillStyle = '#9aa5b1';
        ctx.beginPath();
        ctx.ellipse(wx + sideSign * wheelThick * 0.16, wy, wheelThick * 0.46, wheelR * 0.48, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  };

  // Вспомогательная отрисовка нижней части боковины (двери и крылья)
  const drawLowerFlank = (sideSign) => {
    fillQuad(ctx, s0.cx + sideSign * s0.w * 0.49, s0.cy - s0.h * 0.15, s1.cx + sideSign * s1.w * 0.49, s1.cy - s1.h * 0.15, s1.cx + sideSign * s1.w * 0.48, s1.cy - s1.h * 0.36, s0.cx + sideSign * s0.w * 0.48, s0.cy - s0.h * 0.36, flankLowerColor);
    fillQuad(ctx, s0.cx + sideSign * s0.w * 0.48, s0.cy - s0.h * 0.36, s1.cx + sideSign * s1.w * 0.48, s1.cy - s1.h * 0.36, s1.cx + sideSign * s1.w * 0.45, s1.cy - s1.h * 0.56, s0.cx + sideSign * s0.w * 0.45, s0.cy - s0.h * 0.56, flankUpperColor);

    ctx.strokeStyle = MathUtil.shadeHex(primary, 1.24);
    ctx.lineWidth = Math.max(1.1, wNear * 0.015);
    ctx.beginPath();
    ctx.moveTo(s0.cx + sideSign * s0.w * 0.45, s0.cy - s0.h * 0.56);
    ctx.lineTo(s1.cx + sideSign * s1.w * 0.45, s1.cy - s1.h * 0.56);
    ctx.stroke();
  };

  // Вспомогательная отрисовка верхней боковины кабины и боковых стёкол (поверх капота и дальнего стекла)
  const drawCabinFlankAndWindow = (sideSign) => {
    if (nearFrac >= tCF) return;

    const cAx = sCabinRear.cx + sideSign * sCabinRear.w * 0.45;
    const cAy = sCabinRear.cy - sCabinRear.h * 0.56;
    const cBx = sCabinFront.cx + sideSign * sCabinFront.w * 0.45;
    const cBy = sCabinFront.cy - sCabinFront.h * 0.56;
    const cCx = sRoofFront.cx + sideSign * sRoofFront.w * roofHalfFrac;
    const cCy = sRoofFront.cy - sRoofFront.h * 0.96;
    const cDx = sRoofRear.cx + sideSign * sRoofRear.w * roofHalfFrac;
    const cDy = sRoofRear.cy - sRoofRear.h * 0.96;

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
      const hFrac = MathUtil.lerp(0.56, 0.96, u);
      const wFrac = MathUtil.lerp(0.45, roofHalfFrac, u);
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

      if (wNear >= 15) {
        ctx.strokeStyle = 'rgba(8, 5, 18, 0.85)';
        ctx.lineWidth = Math.max(1.0, wNear * 0.010);
        ctx.beginPath();
        ctx.moveTo(pBL.x, pBL.y);
        ctx.lineTo(pBR.x, pBR.y);
        ctx.lineTo(pTR.x, pTR.y);
        ctx.lineTo(pTL.x, pTL.y);
        ctx.closePath();
        ctx.stroke();
      }
    }
  };

  // 2. Дальняя сторона кузова и её колёса
  drawSideWheels(flankOrder[0], false);
  drawLowerFlank(flankOrder[0]);

  // 3. Дальние верхние плоскости: капот (или багажник встречки) и дальнее стекло
  fillQuad(ctx, sCabinFront.cx - sCabinFront.w * 0.45, sCabinFront.cy - sCabinFront.h * 0.56, sCabinFront.cx + sCabinFront.w * 0.45, sCabinFront.cy - sCabinFront.h * 0.56, s1.cx + s1.w * 0.45, s1.cy - s1.h * 0.56, s1.cx - s1.w * 0.45, s1.cy - s1.h * 0.56, deckColor);

  if (nearFrac < tCF) {
    fillQuad(ctx, sRoofFront.cx - sRoofFront.w * roofHalfFrac, sRoofFront.cy - sRoofFront.h * 0.96, sRoofFront.cx + sRoofFront.w * roofHalfFrac, sRoofFront.cy - sRoofFront.h * 0.96, sCabinFront.cx + sCabinFront.w * 0.45, sCabinFront.cy - sCabinFront.h * 0.56, sCabinFront.cx - sCabinFront.w * 0.45, sCabinFront.cy - sCabinFront.h * 0.56, pillarFrameColor);
    fillQuad(ctx, sRoofFront.cx - sRoofFront.w * innerGlassRoofFrac, sRoofFront.cy - sRoofFront.h * 0.905, sRoofFront.cx + sRoofFront.w * innerGlassRoofFrac, sRoofFront.cy - sRoofFront.h * 0.905, sCabinFront.cx + sCabinFront.w * 0.365, sCabinFront.cy - sCabinFront.h * 0.605, sCabinFront.cx - sCabinFront.w * 0.365, sCabinFront.cy - sCabinFront.h * 0.605, dir === -1 ? '#1d3557' : '#48cae4');
  }

  // 4. Ближняя нижняя боковина и её видимые колёса с дисками
  drawLowerFlank(flankOrder[1]);
  drawSideWheels(flankOrder[1], true);

  // 5. Крыша
  if (nearFrac < tRF) {
    fillQuad(ctx, sRoofRear.cx - sRoofRear.w * roofHalfFrac, sRoofRear.cy - sRoofRear.h * 0.96, sRoofRear.cx + sRoofRear.w * roofHalfFrac, sRoofRear.cy - sRoofRear.h * 0.96, sRoofFront.cx + sRoofFront.w * roofHalfFrac, sRoofFront.cy - sRoofFront.h * 0.96, sRoofFront.cx - sRoofFront.w * roofHalfFrac, sRoofFront.cy - sRoofFront.h * 0.96, roofColor);
  }

  // 6. Видимые боковины кабины и боковые стёкла (рисуются поверх капота, дальнего стекла и крыши)
  for (let f = 0; f < 2; f++) {
    drawCabinFlankAndWindow(flankOrder[f]);
  }

  // 7. Ближнее стекло (заднее для попутных, лобовое для встречных)
  if (nearFrac < tRR) {
    fillQuad(ctx, sCabinRear.cx - sCabinRear.w * 0.45, sCabinRear.cy - sCabinRear.h * 0.56, sCabinRear.cx + sCabinRear.w * 0.45, sCabinRear.cy - sCabinRear.h * 0.56, sRoofRear.cx + sRoofRear.w * roofHalfFrac, sRoofRear.cy - sRoofRear.h * 0.96, sRoofRear.cx - sRoofRear.w * roofHalfFrac, sRoofRear.cy - sRoofRear.h * 0.96, pillarFrameColor);

    const glassBotY = sCabinRear.cy - sCabinRear.h * 0.605;
    const glassTopY = sRoofRear.cy - sRoofRear.h * 0.905;
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

    fillQuad(ctx, sCabinRear.cx - sCabinRear.w * 0.365, glassBotY, sCabinRear.cx + sCabinRear.w * 0.365, glassBotY, sRoofRear.cx + sRoofRear.w * innerGlassRoofFrac, glassTopY, sRoofRear.cx - sRoofRear.w * innerGlassRoofFrac, glassTopY, nearGlassGrad);

    if (wNear > 18) {
      const glShift = MathUtil.clamp(yaw * 0.35, -0.14, 0.14);
      fillQuad(ctx, sCabinRear.cx + sCabinRear.w * (-0.11 + glShift), sCabinRear.cy - sCabinRear.h * 0.62, sCabinRear.cx + sCabinRear.w * (0.07 + glShift), sCabinRear.cy - sCabinRear.h * 0.62, sRoofRear.cx + sRoofRear.w * (0.03 + glShift), sRoofRear.cy - sRoofRear.h * 0.89, sRoofRear.cx + sRoofRear.w * (-0.09 + glShift), sRoofRear.cy - sRoofRear.h * 0.89, dir === -1 ? 'rgba(255, 255, 255, 0.42)' : 'rgba(255, 224, 178, 0.34)');
    }

    if (isPlayer && visualDamageLevel >= 1 && wNear > 22) {
      const crackLeft = leftDamageLevel >= rightDamageLevel;
      const impactX = crackLeft ? (sCabinRear.cx - sCabinRear.w * 0.18) : (sCabinRear.cx + sCabinRear.w * 0.18);
      const impactY = MathUtil.lerp(glassBotY, glassTopY, 0.42);

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(sCabinRear.cx - sCabinRear.w * 0.365, glassBotY);
      ctx.lineTo(sCabinRear.cx + sCabinRear.w * 0.365, glassBotY);
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
    fillQuad(ctx, s0.cx - s0.w * 0.45, s0.cy - s0.h * 0.56, s0.cx + s0.w * 0.45, s0.cy - s0.h * 0.56, sCabinRear.cx + sCabinRear.w * 0.45, sCabinRear.cy - sCabinRear.h * 0.56, sCabinRear.cx - sCabinRear.w * 0.45, sCabinRear.cy - sCabinRear.h * 0.56, primary);

    if (isPlayer && visualDamageLevel >= 1 && wNear > 24) {
      if (visualDamageLevel >= 3) {
        const sootGrad = ctx.createLinearGradient(0, sCabinRear.cy - sCabinRear.h * 0.56, 0, s0.cy - s0.h * 0.56);
        sootGrad.addColorStop(0.0, 'rgba(12, 8, 20, 0.55)');
        sootGrad.addColorStop(1.0, 'rgba(12, 8, 20, 0.12)');
        fillQuad(ctx, s0.cx - s0.w * 0.30, s0.cy - s0.h * 0.56, s0.cx + s0.w * 0.30, s0.cy - s0.h * 0.56, sCabinRear.cx + sCabinRear.w * 0.28, sCabinRear.cy - sCabinRear.h * 0.56, sCabinRear.cx - sCabinRear.w * 0.28, sCabinRear.cy - sCabinRear.h * 0.56, sootGrad);
      }

      ctx.strokeStyle = MathUtil.shadeHex(primary, 0.42);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      if (leftDamageLevel >= 1 || visualDamageLevel >= 1) {
        ctx.moveTo(s0.cx - s0.w * 0.36, s0.cy - s0.h * 0.56);
        ctx.lineTo(sCabinRear.cx - sCabinRear.w * 0.14, sCabinRear.cy - sCabinRear.h * 0.56);
      }
      if (rightDamageLevel >= 1 || visualDamageLevel >= 2) {
        ctx.moveTo(s0.cx + s0.w * 0.36, s0.cy - s0.h * 0.56);
        ctx.lineTo(sCabinRear.cx + sCabinRear.w * 0.16, sCabinRear.cy - sCabinRear.h * 0.56);
      }
      if (rearDamageLevel >= 1) {
        ctx.moveTo(s0.cx - s0.w * 0.12, s0.cy - s0.h * 0.56);
        ctx.lineTo(s0.cx + s0.w * 0.08, MathUtil.lerp(s0.cy - s0.h * 0.56, sCabinRear.cy - sCabinRear.h * 0.56, 0.55));
      }
      ctx.stroke();
    }
  }

  // 9. Ближняя торцевая панель (корма для попутных, передок для встречных)
  if (showRearPanel) {
    const nearWheelW = s0.w * 0.17;
    const nearWheelH = s0.h * 0.20;
    ctx.fillStyle = '#090712';
    ctx.fillRect(s0.cx - s0.w * 0.46, s0.cy - nearWheelH, nearWheelW, nearWheelH);
    ctx.fillRect(s0.cx + s0.w * 0.46 - nearWheelW, s0.cy - nearWheelH, nearWheelW, nearWheelH);

    const rearX = s0.cx - s0.w * 0.50;
    const rearTopY = s0.cy - s0.h;

    fillQuad(ctx, s0.cx - s0.w * 0.49, s0.cy - s0.h * 0.16, s0.cx + s0.w * 0.49, s0.cy - s0.h * 0.16, s0.cx + s0.w * 0.49, s0.cy - s0.h * 0.36, s0.cx - s0.w * 0.49, s0.cy - s0.h * 0.36, secondary);
    fillQuad(ctx, s0.cx - s0.w * 0.49, s0.cy - s0.h * 0.36, s0.cx + s0.w * 0.49, s0.cy - s0.h * 0.36, s0.cx + s0.w * 0.45, s0.cy - s0.h * 0.56, s0.cx - s0.w * 0.45, s0.cy - s0.h * 0.56, primary);

    if (isPlayer && (visualDamageLevel >= 2 || rearDamageLevel >= 2)) {
      ctx.fillStyle = '#090512';
      ctx.fillRect(s0.cx - s0.w * 0.47, s0.cy - s0.h * 0.31, s0.w * 0.94, s0.h * 0.14);

      const hangLeft = leftDamageLevel >= rightDamageLevel;
      const effectiveDmg = Math.max(visualDamageLevel, rearDamageLevel + 1);
      const dropAmt = Math.min(s0.h * 0.15, (effectiveDmg - 1) * s0.h * 0.036);
      const leftBumperDrop = hangLeft ? dropAmt : 0;
      const rightBumperDrop = hangLeft ? 0 : dropAmt;

      fillQuad(ctx, s0.cx - s0.w * 0.51, s0.cy - s0.h * 0.32 + leftBumperDrop, s0.cx + s0.w * 0.51, s0.cy - s0.h * 0.32 + rightBumperDrop, s0.cx + s0.w * 0.51, s0.cy - s0.h * 0.15 + rightBumperDrop, s0.cx - s0.w * 0.51, s0.cy - s0.h * 0.15 + leftBumperDrop, '#1b172b');
    } else {
      ctx.fillStyle = '#1b172b';
      ctx.fillRect(s0.cx - s0.w * 0.51, s0.cy - s0.h * 0.32, s0.w * 1.02, s0.h * 0.17);
    }

    if (isPlayer && (showExhaustFlame || showBackfireFlame)) {
      const pulse = 0.5 + 0.5 * Math.sin(state.animClockMs * 0.08);
      const flameY = s0.cy - s0.h * 0.18;
      if (showBackfireFlame) {
        const bfR = 6.5 + pulse * 5.0;
        ctx.fillStyle = '#ff7b00';
        ctx.beginPath();
        ctx.arc(s0.cx - s0.w * 0.26, flameY, bfR, 0, Math.PI * 2);
        ctx.arc(s0.cx + s0.w * 0.26, flameY, bfR * 0.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff3b0';
        ctx.beginPath();
        ctx.arc(s0.cx - s0.w * 0.26, flameY, bfR * 0.45, 0, Math.PI * 2);
        ctx.fill();
      } else {
        const flameR = (isSlipstreamingFlame ? 6.5 : 4.5) + pulse * 4.2;
        ctx.fillStyle = isSlipstreamingFlame ? '#39ff14' : '#00f0ff';
        ctx.beginPath();
        ctx.arc(s0.cx - s0.w * 0.26, flameY, flameR, 0, Math.PI * 2);
        ctx.arc(s0.cx + s0.w * 0.26, flameY, flameR, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (!isPlayer && !isRival && type === 'sport' && dir === 1 && s0.w > 16) {
      const lipH = Math.max(1.8, s0.h * 0.055);
      ctx.fillStyle = MathUtil.shadeHex(secondary, 0.85);
      ctx.fillRect(s0.cx - s0.w * 0.44, s0.cy - s0.h * 0.56 - lipH, s0.w * 0.88, lipH);
    }

    if (isPlayer || isRival) {
      const sWingFront = sec(0.11);
      const wingH = Math.max(3, s0.h * 0.16);
      const strutW = Math.max(1.8, s0.w * 0.042);
      const trunkRearY = s0.cy - s0.h * 0.56;
      const trunkFrontY = sWingFront.cy - sWingFront.h * 0.56;
      const lipThickness = Math.max(2.0, s0.h * 0.045);

      const drawWingEndplate = (rearXPos, rearTopYPos, frontXPos, frontTopYPos, scaleSide = 1) => {
        if (s0.w < 16) return;
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
        const breakLeft = leftDamageLevel >= rightDamageLevel;
        const bSign = breakLeft ? -1 : 1;
        const iSign = -bSign;

        const stubX = s0.cx + bSign * s0.w * 0.30;
        const stubTopY = trunkRearY - wingH * 0.38;
        ctx.strokeStyle = '#140326';
        ctx.lineWidth = strutW;
        ctx.beginPath();
        ctx.moveTo(stubX, trunkRearY);
        ctx.lineTo(stubX + bSign * strutW * 0.7, stubTopY);
        ctx.stroke();
        ctx.fillStyle = '#cbd5e1';
        ctx.fillRect(stubX + bSign * strutW * 0.7 - strutW * 0.5, stubTopY - 1, strutW, 2);

        const intactStrutX = s0.cx + iSign * s0.w * 0.30;
        const intactTopY = trunkRearY - wingH;
        const intactFrontTopY = trunkFrontY - wingH * 0.85;
        ctx.fillStyle = '#140326';
        ctx.fillRect(intactStrutX - strutW * 0.5, intactTopY, strutW, wingH);

        const innerFrac = -bSign * 0.03;
        const outerFrac = iSign * 0.44;
        const xInnerRear = s0.cx + s0.w * innerFrac;
        const xOuterRear = s0.cx + s0.w * outerFrac;
        const xInnerFront = sWingFront.cx + sWingFront.w * (innerFrac * 0.95);
        const xOuterFront = sWingFront.cx + sWingFront.w * (outerFrac * 0.95);
        const xMidBreak = (xInnerRear + xInnerFront) * 0.5 - bSign * s0.w * 0.035;
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

        const hangPivotX = s0.cx + bSign * s0.w * 0.13;
        const hangPivotY = trunkRearY - wingH * 0.22;
        const hangTipX = s0.cx + bSign * s0.w * 0.48;
        const hangTipY = trunkRearY + wingH * 0.92;
        const chordX = -bSign * s0.w * 0.045;
        const chordY = -wingH * 0.46;

        fillQuad(ctx, hangPivotX, hangPivotY, hangTipX, hangTipY, hangTipX, hangTipY + lipThickness * 1.15, hangPivotX, hangPivotY + lipThickness * 1.15, '#140326');
        fillQuad(ctx, hangPivotX, hangPivotY, hangTipX, hangTipY, hangTipX + chordX, hangTipY + chordY, hangPivotX + chordX, hangPivotY + chordY, '#e2e8f0');
        drawWingEndplate(hangTipX, hangTipY, hangTipX + chordX, hangTipY + chordY, 0.85);
      } else if (isPlayer && visualDamageLevel >= 2) {
        const bendLeft = leftDamageLevel >= rightDamageLevel;
        const leftDrop = bendLeft ? wingH * 0.40 : 0;
        const rightDrop = bendLeft ? 0 : wingH * 0.40;

        const leftRearY = trunkRearY - wingH + leftDrop;
        const rightRearY = trunkRearY - wingH + rightDrop;
        const leftFrontY = trunkFrontY - wingH * 0.85 + leftDrop * 0.85;
        const rightFrontY = trunkFrontY - wingH * 0.85 + rightDrop * 0.85;

        const leftStrutTopX = s0.cx - s0.w * (bendLeft ? 0.33 : 0.31);
        const rightStrutTopX = s0.cx + s0.w * (bendLeft ? 0.31 : 0.33);

        ctx.strokeStyle = '#140326';
        ctx.lineWidth = strutW;
        ctx.beginPath();
        ctx.moveTo(s0.cx - s0.w * 0.30, trunkRearY);
        ctx.lineTo(leftStrutTopX, leftRearY + 1);
        ctx.moveTo(s0.cx + s0.w * 0.30, trunkRearY);
        ctx.lineTo(rightStrutTopX, rightRearY + 1);
        ctx.stroke();

        fillQuad(ctx, s0.cx - s0.w * 0.44, leftRearY, s0.cx + s0.w * 0.44, rightRearY, sWingFront.cx + sWingFront.w * 0.42, rightFrontY, sWingFront.cx - sWingFront.w * 0.42, leftFrontY, '#ffffff');
        fillQuad(ctx, s0.cx - s0.w * 0.44, leftRearY, s0.cx + s0.w * 0.44, rightRearY, s0.cx + s0.w * 0.44, rightRearY + lipThickness, s0.cx - s0.w * 0.44, leftRearY + lipThickness, '#140326');
        drawWingEndplate(s0.cx - s0.w * 0.44, leftRearY, sWingFront.cx - sWingFront.w * 0.42, leftFrontY, 1);
        drawWingEndplate(s0.cx + s0.w * 0.44, rightRearY, sWingFront.cx + sWingFront.w * 0.42, rightFrontY, 1);
      } else {
        const wingTopY = trunkRearY - wingH;
        const wingFrontTopY = trunkFrontY - wingH * 0.85;

        ctx.fillStyle = '#140326';
        ctx.fillRect(s0.cx - s0.w * 0.32, wingTopY, strutW, wingH);
        ctx.fillRect(s0.cx + s0.w * 0.32 - strutW, wingTopY, strutW, wingH);

        fillQuad(ctx, s0.cx - s0.w * 0.44, wingTopY, s0.cx + s0.w * 0.44, wingTopY, sWingFront.cx + sWingFront.w * 0.42, wingFrontTopY, sWingFront.cx - sWingFront.w * 0.42, wingFrontTopY, '#ffffff');
        ctx.fillStyle = '#140326';
        ctx.fillRect(s0.cx - s0.w * 0.44, wingTopY, s0.w * 0.88, lipThickness);

        drawWingEndplate(s0.cx - s0.w * 0.44, wingTopY, sWingFront.cx - sWingFront.w * 0.42, wingFrontTopY, 1);
        drawWingEndplate(s0.cx + s0.w * 0.44, wingTopY, sWingFront.cx + sWingFront.w * 0.42, wingFrontTopY, 1);
      }
    }

    const lightW = s0.w * 0.18;
    const lightH = s0.h * 0.13;
    const leftLightY = s0.cy - s0.h * 0.50;
    const rightLightY = s0.cy - s0.h * 0.50;

    if (dir === -1) {
      ctx.fillStyle = '#0d091a';
      ctx.fillRect(s0.cx - s0.w * 0.22, leftLightY + lightH * 0.1, s0.w * 0.44, lightH * 0.85);

      ctx.fillStyle = damagedByPlayer ? '#241f33' : (highBeamFlashing ? '#e0ffff' : '#ffffff');
      ctx.fillRect(rearX + s0.w * 0.08, leftLightY, lightW, lightH);
      ctx.fillRect(rearX + s0.w * 0.74, rightLightY, lightW, lightH);

      if (s0.w > 18 && !damagedByPlayer) {
        const beamRadius = highBeamFlashing ? lightW * 2.35 : lightW * 1.15;
        ctx.fillStyle = highBeamFlashing ? 'rgba(210, 252, 255, 0.55)' : 'rgba(220, 250, 255, 0.22)';
        ctx.beginPath();
        ctx.arc(rearX + s0.w * 0.17, leftLightY + lightH * 0.5, beamRadius, 0, Math.PI * 2);
        ctx.arc(rearX + s0.w * 0.83, rightLightY + lightH * 0.5, beamRadius, 0, Math.PI * 2);
        ctx.fill();

        if (highBeamFlashing && s0.w > 28) {
          fillQuad(ctx, rearX + s0.w * 0.10, leftLightY + lightH, rearX + s0.w * 0.24, leftLightY + lightH, rearX + s0.w * 0.34, s0.cy + s0.h * 0.35, rearX - s0.w * 0.06, s0.cy + s0.h * 0.35, 'rgba(210, 252, 255, 0.24)');
          fillQuad(ctx, rearX + s0.w * 0.76, rightLightY + lightH, rearX + s0.w * 0.90, rightLightY + lightH, rearX + s0.w * 1.06, s0.cy + s0.h * 0.35, rearX + s0.w * 0.66, s0.cy + s0.h * 0.35, 'rgba(210, 252, 255, 0.24)');
        }
      }
    } else {
      const leftLit = !leftLightBroken && !leftLightFlicker;
      const rightLit = !rightLightBroken && !rightLightFlicker;

      ctx.fillStyle = leftLightBroken ? '#1f040d' : (leftLit && braking ? '#ff4d6d' : (leftLit ? '#9e0b28' : '#3d0815'));
      ctx.fillRect(rearX + s0.w * 0.08, leftLightY, lightW, lightH);

      ctx.fillStyle = rightLightBroken ? '#1f040d' : (rightLit && braking ? '#ff4d6d' : (rightLit ? '#9e0b28' : '#3d0815'));
      ctx.fillRect(rearX + s0.w * 0.74, rightLightY, lightW, lightH);

      if (braking && s0.w > 18 && (leftLit || rightLit)) {
        ctx.fillStyle = isPlayer ? 'rgba(255, 42, 95, 0.38)' : 'rgba(255, 42, 95, 0.36)';
        ctx.beginPath();
        if (leftLit) ctx.arc(rearX + s0.w * 0.17, leftLightY + lightH * 0.5, lightW * (isPlayer ? 1.05 : 0.98), 0, Math.PI * 2);
        if (rightLit) ctx.arc(rearX + s0.w * 0.83, rightLightY + lightH * 0.5, lightW * (isPlayer ? 1.05 : 0.98), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (isPlayer) {
      const revW = s0.w * 0.09;
      const revH = lightH * 0.82;
      const leftRevY = leftLightY + (lightH - revH) * 0.5;
      const rightRevY = rightLightY + (lightH - revH) * 0.5;
      ctx.fillStyle = reversing ? '#ffffff' : (isTotalWreck ? '#262030' : '#3a2d47');
      ctx.fillRect(rearX + s0.w * 0.28, leftRevY, revW, revH);
      ctx.fillRect(rearX + s0.w * 0.63, rightRevY, revW, revH);

      if (reversing) {
        ctx.fillStyle = 'rgba(220, 250, 255, 0.50)';
        ctx.beginPath();
        ctx.arc(rearX + s0.w * 0.325, leftRevY + revH * 0.5, revW * 1.5, 0, Math.PI * 2);
        ctx.arc(rearX + s0.w * 0.675, rightRevY + revH * 0.5, revW * 1.5, 0, Math.PI * 2);
        ctx.fill();
      }

      const plateW = s0.w * 0.20;
      const plateH = s0.h * 0.15;
      const plateY = s0.cy - s0.h * 0.31;
      const plateTilt = (rearDamageLevel >= 1 || visualDamageLevel >= 2)
        ? MathUtil.clamp((rightDamageLevel - leftDamageLevel) * 0.08 + rearDamageLevel * 0.05, -0.24, 0.24)
        : 0;

      ctx.save();
      ctx.translate(s0.cx, plateY + plateH * 0.5);
      if (plateTilt !== 0) ctx.rotate(plateTilt);
      ctx.fillStyle = isTotalWreck ? '#1f1b2b' : '#ffffff';
      ctx.fillRect(-plateW * 0.5, -plateH * 0.5, plateW, plateH);
      ctx.fillStyle = isTotalWreck ? '#5c5373' : '#140326';
      ctx.font = `900 ${Math.max(8, Math.round(plateH * 0.78))}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('01', 0, plateH * 0.04);
      ctx.restore();

      if (visualDamageLevel >= 1 || rearDamageLevel >= 1) {
        ctx.strokeStyle = '#240412';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        if (leftDamageLevel >= 1 || visualDamageLevel >= 1) {
          ctx.moveTo(rearX + s0.w * 0.12, s0.cy - s0.h * 0.54);
          ctx.lineTo(rearX + s0.w * 0.28, s0.cy - s0.h * 0.42);
        }
        if (rightDamageLevel >= 1 || visualDamageLevel >= 2) {
          ctx.moveTo(rearX + s0.w * 0.88, s0.cy - s0.h * 0.54);
          ctx.lineTo(rearX + s0.w * 0.70, s0.cy - s0.h * 0.41);
        }
        if (rearDamageLevel >= 1 || visualDamageLevel >= 3) {
          ctx.moveTo(s0.cx - s0.w * 0.14, s0.cy - s0.h * 0.52);
          ctx.lineTo(s0.cx + s0.w * 0.12, s0.cy - s0.h * 0.39);
        }
        if (rearDamageLevel >= 2) {
          ctx.moveTo(s0.cx - s0.w * 0.24, s0.cy - s0.h * 0.20);
          ctx.lineTo(s0.cx + s0.w * 0.20, s0.cy - s0.h * 0.30);
        }
        ctx.stroke();
      }
    } else {
      if (isRival && s0.w > 36) {
        const tagW = Math.max(46, s0.w * 0.68);
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

      if (!isRival && !damagedByPlayer && turnSignal !== 0) {
        const blinkOn = Math.floor(signalElapsed / 0.18) % 2 === 0;
        const indW = Math.max(2.2, lightW * 0.62);
        const indH = Math.max(1.8, lightH * 1.05);
        const indX = turnSignal === -1 ? (rearX + s0.w * 0.02) : (rearX + s0.w * 0.98 - indW);

        ctx.fillStyle = blinkOn ? '#ffbe0b' : '#4a2b00';
        ctx.fillRect(indX, leftLightY - indH * 0.04, indW, indH);

        if (blinkOn && s0.w > 12) {
          ctx.fillStyle = 'rgba(255, 190, 11, 0.55)';
          ctx.beginPath();
          ctx.arc(indX + indW * 0.5, leftLightY + indH * 0.5, indW * 1.35, 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = '#fff8d6';
          ctx.fillRect(indX + indW * 0.2, leftLightY + indH * 0.2, indW * 0.6, indH * 0.6);
        }
      }

      if (damagedByPlayer && Math.floor(state.animClockMs / 260) % 2 === 0) {
        ctx.fillStyle = '#ffbe0b';
        ctx.fillRect(rearX + s0.w * 0.03, leftLightY, lightW * 0.55, lightH);
        ctx.fillRect(rearX + s0.w * 0.87, rightLightY, lightW * 0.55, lightH);
      }
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

function renderPlayerCar(ctx) {
  const absSpeedRatio = Math.abs(state.speed) / MAX_SPEED;
  const isOffRoad = Math.abs(state.playerX) > OFF_ROAD_THRESHOLD_X;
  const activeVisualDamage = state.gameMode !== 'circuit' ? state.visualDamage : 0;

  const baseBounce = (!state.isPaused && Math.abs(state.speed) > 15)
    ? Math.sin(state.animClockMs * 0.045) * (0.5 + absSpeedRatio * 1.4)
    : 0;
  const offRoadBounce = (!state.isPaused && isOffRoad && Math.abs(state.speed) > 15)
    ? Math.sin(state.animClockMs * 0.16) * 2.0 * Math.min(1, absSpeedRatio * 2.5)
    : 0;
  const damageWobble = (!state.isPaused && activeVisualDamage >= 3 && Math.abs(state.speed) > 25)
    ? Math.sin(state.animClockMs * 0.11) * (0.55 + (activeVisualDamage - 2) * 0.45) * Math.min(1, absSpeedRatio * 1.8)
    : 0;
  const crashShakeX = (!state.isPaused && state.impactShake > 0)
    ? Math.sin(state.animClockMs * 0.19) * 6.5 * state.impactShake
    : 0;
  const crashShakeY = (!state.isPaused && state.impactShake > 0)
    ? Math.cos(state.animClockMs * 0.23) * 4.5 * state.impactShake
    : 0;

  const playerYaw = MathUtil.clamp(state.steerVisual * 0.22 + state.playerVX * 0.14, -0.34, 0.34);
  const isTotalWreck = state.gameMode !== 'circuit' && state.visualDamage >= MAX_HARDCORE_COLLISIONS;
  const hasDamageSystem = state.gameMode !== 'circuit';
  const flickerPhase = Math.floor(state.animClockMs / 95);
  const input = state.input;

  const isReversing = !isTotalWreck && state.gameState === STATE.PLAYING && (state.speed < -2 || (input.down && !input.up && state.speed <= 2));
  const isBraking = !isTotalWreck && !isReversing && ((input.down && state.speed > 2) || (input.up && input.down) || Math.abs(state.speed) < 15);
  const leftLightBroken = isTotalWreck || (hasDamageSystem && (state.leftDamage >= 3 || state.visualDamage >= 4));
  const rightLightBroken = isTotalWreck || (hasDamageSystem && (state.rightDamage >= 3 || state.visualDamage >= 4));
  const leftLightFlicker = !leftLightBroken && hasDamageSystem && state.leftDamage >= 2 && (flickerPhase % 3 === 0);
  const rightLightFlicker = !rightLightBroken && hasDamageSystem && state.rightDamage >= 2 && (flickerPhase % 4 === 1);
  const showExhaustFlame = !state.isPaused && !isTotalWreck && input.up && !input.down && state.speed / MAX_SPEED > 0.72 && !state.isOverheated && state.engineMisfireTimer <= 0;
  const showBackfireFlame = !state.isPaused && !isTotalWreck && activeVisualDamage >= 4 && state.engineMisfireTimer > 0 && input.up;

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
    worldX: state.playerX * ROAD_WIDTH,
    centerZ: state.position + PLAYER_Z + PLAYER_CENTER_OFFSET_Z,
    camZ: PLAYER_Z + PLAYER_CENTER_OFFSET_Z,
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
    showExhaustFlame: showExhaustFlame,
    isSlipstreamingFlame: state.isSlipstreaming,
    showBackfireFlame: showBackfireFlame
  });
}

function renderParticles(ctx) {
  const particles = state.particles;
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    const alpha = MathUtil.clamp(p.life / p.maxLife, 0, 1);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
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

  // 3. Машина игрока
  renderPlayerCar(ctx);

  // 4. Машины на переднем плане
  if (foregroundCars.length > 0) {
    foregroundCars.sort((a, b) => b.carCamZ - a.carCamZ);
    for (let i = 0; i < foregroundCars.length; i++) {
      renderTrafficCar(ctx, foregroundCars[i].car);
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