import {
  STATE,
  LOGICAL_HEIGHT,
  PROJ_HALF_WIDTH,
  ROAD_WIDTH,
  SEGMENT_LENGTH,
  CAMERA_HEIGHT,
  DRAW_DISTANCE,
  PLAYER_Z,
  PLAYER_CENTER_OFFSET_Z,
  PLAYER_LEN_Z,
  PLAYER_WIDTH_NORM,
  MAX_SPEED,
  OFF_ROAD_THRESHOLD_X,
  MAX_HARDCORE_COLLISIONS
} from './config.js';
import { MathUtil, getShortestTrackDz } from './utils.js';
import { state } from './state.js';
import {
  MIN_CAR_CAM_Z,
  HALO_STOPS,
  sampleRoadAtZ,
  beginHorizonClip,
  fillQuad,
  fillRoundedQuad,
  drawLightHalo
} from './renderWorld.js';

// Продольные и колёсные пропорции 3D-кузовов по архетипам автомобилей
const CAR_BODY_PROFILES = Object.freeze({
  coupe: Object.freeze({ tCR: 0.18, tRR: 0.30, tRF: 0.64, tCF: 0.76, roofHalfFrac: 0.315, tAxleNear: 0.22, tAxleFar: 0.82, dtWheel: 0.086, wheelRFrac: 0.215 }),
  sport: Object.freeze({ tCR: 0.16, tRR: 0.28, tRF: 0.62, tCF: 0.75, roofHalfFrac: 0.300, tAxleNear: 0.22, tAxleFar: 0.82, dtWheel: 0.088, wheelRFrac: 0.215 }),
  sedan: Object.freeze({ tCR: 0.16, tRR: 0.26, tRF: 0.67, tCF: 0.78, roofHalfFrac: 0.330, tAxleNear: 0.21, tAxleFar: 0.82, dtWheel: 0.084, wheelRFrac: 0.210 }),
  van:   Object.freeze({ tCR: 0.07, tRR: 0.13, tRF: 0.82, tCF: 0.91, roofHalfFrac: 0.360, tAxleNear: 0.21, tAxleFar: 0.81, dtWheel: 0.078, wheelRFrac: 0.175 })
});

// Константы вертикального и поперечного сечения кузова
const BODY_MID = 0.40;
const BODY_SHOULDER = 0.59;
const GLASS_BOT = 0.63;
const GLASS_TOP = 0.92;
const ROOF_TOP = 0.98;

const BODY_W_BOT = 0.466;
const BODY_W_BUMPER_TOP = 0.468;
const BODY_W_MID = 0.470;
const BODY_W_TOP = 0.468;
const TIRE_OUTER_FRAC = 0.460;

// Пороги дистанционного LOD по экранной ширине ближнего торца кузова (px)
const CAR_SILHOUETTE_LOD_W = 8.5;
const CAR_GLASS_GRADIENT_LOD_W = 22.0;

// Конфигурации стоек бокового остекления без аллокации массивов на кадр
const PILLARS_VAN = Object.freeze([0.36, 0.68]);
const PILLARS_SEDAN = Object.freeze([0.50]);

// Лучи трещин заднего стекла при повреждениях игрока
const REAR_GLASS_CRACK_RAYS = Object.freeze([
  Object.freeze([-0.14, -0.22]),
  Object.freeze([0.16, -0.18]),
  Object.freeze([-0.18, 0.14]),
  Object.freeze([0.14, 0.16]),
  Object.freeze([0.02, -0.25]),
  Object.freeze([-0.05, 0.18])
]);

// Слои полутени для мягкого режима освещения (без тяжёлого ctx.filter)
const SOFT_SHADOW_LAYERS = Object.freeze([
  Object.freeze({ wPad: 0.095, rExt: 0.085, fExt: 0.090, round: 0.17, color: 'rgba(7, 2, 18, 0.05)' }),
  Object.freeze({ wPad: 0.058, rExt: 0.055, fExt: 0.058, round: 0.15, color: 'rgba(7, 2, 18, 0.07)' }),
  Object.freeze({ wPad: 0.028, rExt: 0.028, fExt: 0.030, round: 0.13, color: 'rgba(7, 2, 18, 0.10)' }),
  Object.freeze({ wPad: 0.004, rExt: 0.008, fExt: 0.008, round: 0.11, color: 'rgba(7, 2, 18, 0.14)' }),
  Object.freeze({ wPad: -0.022, rExt: -0.018, fExt: -0.018, round: 0.09, color: 'rgba(7, 2, 18, 0.20)' })
]);

const SOFT_SHADOW_FAR_LAYERS = Object.freeze([
  Object.freeze({ wPad: 0.055, rExt: 0.045, fExt: 0.050, round: 0.14, color: 'rgba(7, 2, 18, 0.14)' }),
  Object.freeze({ wPad: -0.005, rExt: 0.000, fExt: 0.000, round: 0.10, color: 'rgba(7, 2, 18, 0.28)' })
]);

function createSectionSlot() {
  return { t: 0, cx: 0, cy: 0, w: 0, h: 0 };
}

function createPointSlot() {
  return { x: 0, y: 0, t: 0 };
}

// Переиспользуемые буферы проекции, сечений кузова, колёс и параметров вызова (0 аллокаций в кадре)
const _nearSample = { camZ: 0, scale: 0, roadCenterX: 0, roadY: 0, clipY: LOGICAL_HEIGHT };
const _farSample = { camZ: 0, scale: 0, roadCenterX: 0, roadY: 0, clipY: LOGICAL_HEIGHT };

const _carCtx = {
  nearFrac: 0,
  visibleSpanFrac: 1,
  nearScale: 1,
  farScale: 1,
  cxNear: 0,
  cyNear: 0,
  wNear: 0,
  hNear: 0,
  cxFar: 0,
  cyFar: 0,
  wFar: 0,
  hFar: 0,
  isVan: false,
  bodyClearance: 0.22,
  bumperTop: 0.35,
  tCR: 0,
  tRR: 0,
  tRF: 0,
  tCF: 0,
  roofHalfFrac: 0.3,
  innerGlassRoofFrac: 0.24,
  tAxleNear: 0.22,
  tAxleFar: 0.82,
  dtWheel: 0.086,
  wheelRFrac: 0.215,
  tireInnerFrac: 0.32,
  showRearPanel: true,
  lateralDeltaX: 0,
  hiddenFlankSign: -1,
  visibleFlankSign: 1,
  flankVisibility: 0,
  visibleFlankSpanPx: 0,
  showVisibleFlank: false,
  flankLowerColor: '',
  flankUpperColor: '',
  roofColor: '',
  deckColor: '',
  pillarFrameColor: '',
  s0: createSectionSlot(),
  saNearAxle: createSectionSlot(),
  sCabinRear: createSectionSlot(),
  sRoofRear: createSectionSlot(),
  sRoofFront: createSectionSlot(),
  sCabinFront: createSectionSlot(),
  s1: createSectionSlot()
};

const _secW0 = createSectionSlot();
const _secW1 = createSectionSlot();
const _secW2 = createSectionSlot();
const _secTmpA = createSectionSlot();
const _secTmpB = createSectionSlot();

const _wheelMetrics = {
  sa: _secW0,
  wheelR: 0,
  ox: 0,
  oy: 0,
  ix: 0,
  iy: 0,
  uxOut: 0,
  uxIn: 0,
  uy: 0
};

const _pt1 = createPointSlot();
const _pt2 = createPointSlot();
const _pt3 = createPointSlot();
const _pt4 = createPointSlot();

const _trafficCarOpts = {
  isPlayer: false,
  isParkedDetach: false,
  isRival: false,
  type: 'sport',
  dir: 1,
  w: 0.185,
  h: 0.96,
  lenZ: PLAYER_LEN_Z,
  primary: '#00e5ff',
  secondary: '#0077b6',
  worldX: 0,
  centerZ: 0,
  camZ: 0,
  distRatio: 0,
  yaw: 0,
  screenShiftX: 0,
  verticalOffset: 0,
  useFallback: false,
  braking: false,
  reversing: false,
  damagedByPlayer: false,
  highBeamFlashing: false,
  turnSignal: 0,
  signalElapsed: 0,
  name: '',
  num: '',
  plate: '',
  isTotalWreck: false,
  leftLightBroken: false,
  rightLightBroken: false,
  leftLightFlicker: false,
  rightLightFlicker: false,
  visualDamageLevel: 0,
  leftDamageLevel: 0,
  rightDamageLevel: 0,
  rearDamageLevel: 0,
  spoilerDamageSide: 0,
  showExhaustFlame: false,
  isSlipstreamingFlame: false,
  showBackfireFlame: false
};

const _playerCarOpts = { ..._trafficCarOpts, isPlayer: true };

/**
 * Резервный расчёт экранной проекции дороги для автомобиля игрока на случай края буфера сегментов
 */
function fillFallbackRoadSample(targetCamZ, out) {
  const safeZ = Math.max(MIN_CAR_CAM_Z, targetCamZ);
  const effectiveCamX = (state.playerX - state.cameraLagX) * ROAD_WIDTH;
  const scale = state.activeCameraDepth / safeZ;
  out.camZ = safeZ;
  out.scale = scale;
  out.roadCenterX = (state.logicalWidth * 0.5) + scale * (-effectiveCamX) * PROJ_HALF_WIDTH;
  out.roadY = (LOGICAL_HEIGHT * 0.5) + state.cameraPitch - scale * (-CAMERA_HEIGHT) * (LOGICAL_HEIGHT * 0.5);
  out.clipY = LOGICAL_HEIGHT;
  return out;
}

/**
 * Перспективно-корректная интерполяция (1/z) поперечного сечения автомобиля вдоль его продольной оси [0..1]
 */
function evalCarSection(C, t, out) {
  const u = MathUtil.clamp((t - C.nearFrac) / C.visibleSpanFrac, 0, 1);
  const denom = Math.max(1e-6, (1 - u) * C.farScale + u * C.nearScale);
  const uProj = (u * C.nearScale) / denom;
  out.t = t;
  out.cx = MathUtil.lerp(C.cxNear, C.cxFar, uProj);
  out.cy = MathUtil.lerp(C.cyNear, C.cyFar, uProj);
  out.w = MathUtil.lerp(C.wNear, C.wFar, uProj);
  out.h = MathUtil.lerp(C.hNear, C.hFar, uProj);
  return out;
}

/**
 * Вычисляет точку на наклонной боковой грани кабины (для окон и средних стоек) без создания объектов
 */
function evalCabinPoint(C, sideSign, u, v, outPt) {
  const tRearU = MathUtil.lerp(C.tCR, C.tRR, u);
  const tFrontU = MathUtil.lerp(C.tCF, C.tRF, u);
  const spanU = Math.max(0.001, tFrontU - tRearU);
  const vClamped = Math.max(v, (C.nearFrac - tRearU) / spanU);
  const t = MathUtil.lerp(tRearU, tFrontU, MathUtil.clamp(vClamped, 0, 1));
  const s = evalCarSection(C, t, _secTmpA);
  const hFrac = MathUtil.lerp(BODY_SHOULDER, ROOF_TOP, u);
  const wFrac = MathUtil.lerp(BODY_W_TOP, C.roofHalfFrac, u);
  outPt.x = s.cx + sideSign * s.w * wFrac;
  outPt.y = s.cy - s.h * hFrac;
  outPt.t = t;
  return outPt;
}

/**
 * Расчёт 3D-геометрии колеса на оси tAxle в перспективе кузова (заполняет переиспользуемый _wheelMetrics)
 */
function computeWheelMetrics(C, sideSign, tAxle) {
  if (tAxle < C.nearFrac) return null;

  const sa = evalCarSection(C, tAxle, _secW0);
  const wheelR = Math.min(sa.h * 0.28, Math.max(0.5, sa.h * C.wheelRFrac));
  const t1 = Math.max(C.nearFrac, tAxle - C.dtWheel);
  const t2 = Math.min(1.0, tAxle + C.dtWheel);
  const spanT = Math.max(0.01, t2 - t1);
  const sBack = evalCarSection(C, t1, _secW1);
  const sFront = evalCarSection(C, t2, _secW2);
  const halfScale = C.dtWheel / spanT;

  const ox = sa.cx + sideSign * sa.w * TIRE_OUTER_FRAC;
  const oy = sa.cy - wheelR;
  const ix = sa.cx + sideSign * sa.w * C.tireInnerFrac;

  _wheelMetrics.wheelR = wheelR;
  _wheelMetrics.ox = ox;
  _wheelMetrics.oy = oy;
  _wheelMetrics.ix = ix;
  _wheelMetrics.iy = oy;
  _wheelMetrics.uxOut = ((sFront.cx + sideSign * sFront.w * TIRE_OUTER_FRAC) - (sBack.cx + sideSign * sBack.w * TIRE_OUTER_FRAC)) * halfScale;
  _wheelMetrics.uxIn = ((sFront.cx + sideSign * sFront.w * C.tireInnerFrac) - (sBack.cx + sideSign * sBack.w * C.tireInnerFrac)) * halfScale;
  _wheelMetrics.uy = (sFront.cy - sBack.cy) * halfScale;

  return _wheelMetrics;
}

/**
 * Отрисовка контактной тени под днищем автомобиля (с быстрым плоским режимом для дальнего LOD)
 */
function renderCarShadow(ctx, C, isSilhouetteLod) {
  const s0 = C.s0;
  const s1 = C.s1;
  const shadowHalfW = 0.505;
  const invSpan = 1 / Math.max(0.25, C.visibleSpanFrac);
  const shadowAxisDx = (s1.cx - s0.cx) * invSpan;
  const shadowAxisDy = Math.min(-Math.max(1.2, s1.h * 0.18), (s1.cy - s0.cy) * invSpan);
  const rearExtFactor = C.showRearPanel ? 1 : 0;
  const baseRearExt = rearExtFactor * 0.10;
  const baseFrontExt = 0.12;

  const shRearBaseW = s0.w * (C.showRearPanel ? 1.02 : 1.0);
  const shFrontBaseW = s1.w * 1.01;

  if (!isSilhouetteLod && state.settings.lightStyle === 'soft') {
    const layers = C.wNear >= 18 ? SOFT_SHADOW_LAYERS : SOFT_SHADOW_FAR_LAYERS;
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
    return;
  }

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

/**
 * Отрисовка 3D-цилиндра протектора колеса под днищем
 */
function renderWheelTread(ctx, C, sideSign, tAxle) {
  const m = computeWheelMetrics(C, sideSign, tAxle);
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

  const treadW = Math.abs(botOutX - botInX);
  const minTreadW = Math.min(0.9, m.sa.w * 0.16);
  if (treadW < minTreadW) {
    const halfPad = (minTreadW - treadW) * 0.5 * sideSign;
    botOutX += halfPad;
    botInX -= halfPad;
    topOutX += halfPad;
    topInX -= halfPad;
  }

  if (C.wNear >= 14 && Math.abs(m.uxIn) > 0.65) {
    ctx.save();
    ctx.transform(m.uxIn, m.uy, 0, -m.wheelR, m.ix, m.iy);
    ctx.fillStyle = '#07050e';
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  const treadColor = C.wNear < 26 ? '#171326' : '#0b0816';
  fillQuad(ctx, topInX, topInY, topOutX, topOutY, botOutX, botOutY, botInX, botInY, treadColor);

  if (C.wNear >= 14 && Math.abs(m.uxOut) > 0.65) {
    ctx.save();
    ctx.transform(m.uxOut, m.uy, 0, -m.wheelR, m.ox, m.oy);
    ctx.fillStyle = '#100c1c';
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

/**
 * Отрисовка перспективных колёсных арок, боковин шин и дисков на видимом борту кузова
 */
function renderSideWheelsAndArches(ctx, C, opts, sideSign) {
  if (C.wNear < CAR_SILHOUETTE_LOD_W || !C.showVisibleFlank) return;

  const archR = 1.18;
  const ySill = (C.bodyClearance / C.wheelRFrac) - 1;
  const startAng = Math.asin(MathUtil.clamp(ySill / archR, -0.35, 0.72));
  const maxFlankRx = C.visibleFlankSpanPx * 0.24;
  const archRimColor = C.wNear > 14 ? MathUtil.shadeHex(opts.primary, 1.12) : '';

  for (let a = 0; a < 2; a++) {
    const tAxle = a === 0 ? C.tAxleFar : C.tAxleNear;
    const m = computeWheelMetrics(C, sideSign, tAxle);
    if (!m) continue;

    const absUx = Math.abs(m.uxOut);
    const uxSign = m.uxOut < 0 ? -1 : (m.uxOut > 0 ? 1 : (C.lateralDeltaX >= 0 ? 1 : -1));
    const minVisibleRx = Math.min(maxFlankRx, m.wheelR * 0.38);
    const effUxMag = Math.max(absUx, minVisibleRx);
    if (effUxMag < 0.35) continue;
    const effUx = uxSign * effUxMag;

    ctx.save();
    ctx.transform(effUx, m.uy, 0, -m.wheelR, m.ox, m.oy);

    ctx.fillStyle = '#05030a';
    ctx.beginPath();
    ctx.arc(0, 0, archR, startAng, Math.PI - startAng, false);
    ctx.closePath();
    ctx.fill();

    const prevWheelAlpha = ctx.globalAlpha;

    const archRimAlpha = MathUtil.clamp((C.wNear - 14) / 14, 0, 1) * MathUtil.clamp((effUxMag - 0.9) / 1.2, 0, 1);
    if (archRimAlpha > 0.01) {
      ctx.globalAlpha = prevWheelAlpha * archRimAlpha;
      ctx.strokeStyle = archRimColor;
      ctx.lineWidth = 0.065;
      ctx.beginPath();
      ctx.arc(0, 0, archR + 0.03, startAng + 0.14, Math.PI - startAng - 0.14, false);
      ctx.stroke();
      ctx.globalAlpha = prevWheelAlpha;
    }

    ctx.fillStyle = '#141022';
    ctx.beginPath();
    ctx.arc(0, 0, 1.0, 0, Math.PI * 2);
    ctx.fill();

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
}

/**
 * Отрисовка нижней боковины кузова, торцов бамперов и боковых царапин
 */
function renderLowerFlank(ctx, C, opts, sideSign, isSilhouetteLod) {
  if (!C.showVisibleFlank) return;

  const s0 = C.s0;
  const s1 = C.s1;

  fillQuad(
    ctx,
    s0.cx + sideSign * s0.w * BODY_W_BOT, s0.cy - s0.h * C.bodyClearance,
    s1.cx + sideSign * s1.w * BODY_W_BOT, s1.cy - s1.h * C.bodyClearance,
    s1.cx + sideSign * s1.w * BODY_W_MID, s1.cy - s1.h * BODY_MID,
    s0.cx + sideSign * s0.w * BODY_W_MID, s0.cy - s0.h * BODY_MID,
    C.flankLowerColor
  );
  fillQuad(
    ctx,
    s0.cx + sideSign * s0.w * BODY_W_MID, s0.cy - s0.h * BODY_MID,
    s1.cx + sideSign * s1.w * BODY_W_MID, s1.cy - s1.h * BODY_MID,
    s1.cx + sideSign * s1.w * BODY_W_TOP, s1.cy - s1.h * BODY_SHOULDER,
    s0.cx + sideSign * s0.w * BODY_W_TOP, s0.cy - s0.h * BODY_SHOULDER,
    C.flankUpperColor
  );

  if (isSilhouetteLod) return;

  if (C.wNear >= 14) {
    ctx.strokeStyle = MathUtil.shadeHex(opts.secondary, 1.18);
    ctx.lineWidth = MathUtil.clamp(C.wNear * 0.009, 0.9, 3.5);
    ctx.beginPath();
    ctx.moveTo(s0.cx + sideSign * s0.w * BODY_W_BOT, s0.cy - s0.h * C.bodyClearance);
    ctx.lineTo(s1.cx + sideSign * s1.w * BODY_W_BOT, s1.cy - s1.h * C.bodyClearance);
    ctx.stroke();
  }

  const rearWrapEndT = Math.min(0.11, Math.max(0.04, C.tAxleNear - C.dtWheel * 1.04));
  const sRearBumper = evalCarSection(C, Math.max(rearWrapEndT, C.nearFrac), _secTmpA);
  if (sRearBumper.t > s0.t + 0.004) {
    fillQuad(
      ctx,
      s0.cx + sideSign * s0.w * BODY_W_BOT, s0.cy - s0.h * C.bodyClearance,
      sRearBumper.cx + sideSign * sRearBumper.w * BODY_W_BOT, sRearBumper.cy - sRearBumper.h * C.bodyClearance,
      sRearBumper.cx + sideSign * sRearBumper.w * BODY_W_BUMPER_TOP, sRearBumper.cy - sRearBumper.h * C.bumperTop,
      s0.cx + sideSign * s0.w * BODY_W_BUMPER_TOP, s0.cy - s0.h * C.bumperTop,
      '#151124'
    );
  }

  const frontWrapStartT = Math.max(0.89, Math.min(0.96, C.tAxleFar + C.dtWheel * 1.04));
  const sFrontBumper = evalCarSection(C, Math.max(frontWrapStartT, C.nearFrac), _secTmpB);
  if (s1.t > sFrontBumper.t + 0.004) {
    const farBumperTop = opts.dir === -1 ? (C.bodyClearance + 0.13) : (C.bodyClearance + 0.12);
    fillQuad(
      ctx,
      sFrontBumper.cx + sideSign * sFrontBumper.w * BODY_W_BOT, sFrontBumper.cy - sFrontBumper.h * C.bodyClearance,
      s1.cx + sideSign * s1.w * BODY_W_BOT, s1.cy - s1.h * C.bodyClearance,
      s1.cx + sideSign * s1.w * BODY_W_BUMPER_TOP, s1.cy - s1.h * farBumperTop,
      sFrontBumper.cx + sideSign * sFrontBumper.w * BODY_W_BUMPER_TOP, sFrontBumper.cy - sFrontBumper.h * farBumperTop,
      '#151124'
    );
  }

  if (opts.isPlayer && C.wNear >= 24 && C.flankVisibility > 0.14) {
    const sideDmg = sideSign < 0 ? opts.leftDamageLevel : opts.rightDamageLevel;
    if (sideDmg >= 1) {
      const sScrapeA = evalCarSection(C, Math.max(C.nearFrac, 0.30), _secTmpA);
      const sScrapeB = evalCarSection(C, Math.max(C.nearFrac, sideDmg >= 2 ? 0.72 : 0.56), _secTmpB);
      if (sScrapeB.t > sScrapeA.t + 0.03) {
        ctx.strokeStyle = 'rgba(220, 228, 242, 0.42)';
        ctx.lineWidth = MathUtil.clamp(C.wNear * 0.012, 1.0, 4.0);
        ctx.beginPath();
        ctx.moveTo(sScrapeA.cx + sideSign * sScrapeA.w * BODY_W_MID, sScrapeA.cy - sScrapeA.h * 0.44);
        ctx.lineTo(sScrapeB.cx + sideSign * sScrapeB.w * BODY_W_MID, sScrapeB.cy - sScrapeB.h * 0.46);
        ctx.stroke();
        if (sideDmg >= 2) {
          ctx.strokeStyle = 'rgba(28, 4, 16, 0.55)';
          ctx.lineWidth = MathUtil.clamp(C.wNear * 0.010, 1.0, 3.5);
          ctx.beginPath();
          ctx.moveTo(sScrapeA.cx + sideSign * sScrapeA.w * BODY_W_BUMPER_TOP, sScrapeA.cy - sScrapeA.h * 0.40);
          ctx.lineTo(sScrapeB.cx + sideSign * sScrapeB.w * BODY_W_BUMPER_TOP, sScrapeB.cy - sScrapeB.h * 0.42);
          ctx.stroke();
        }
      }
    }
  }

  ctx.strokeStyle = MathUtil.shadeHex(opts.primary, 1.15);
  ctx.lineWidth = MathUtil.clamp(C.wNear * 0.011, 1.0, 4.0);
  ctx.beginPath();
  ctx.moveTo(s0.cx + sideSign * s0.w * BODY_W_TOP, s0.cy - s0.h * BODY_SHOULDER);
  ctx.lineTo(s1.cx + sideSign * s1.w * BODY_W_TOP, s1.cy - s1.h * BODY_SHOULDER);
  ctx.stroke();
}

/**
 * Отрисовка боковины кабины и бокового остекления (с отключением линейных градиентов на средних/дальних дистанциях)
 */
function renderCabinFlankAndWindow(ctx, C, opts, sideSign, isSilhouetteLod) {
  if (C.nearFrac >= C.tCF) return;

  const sCR = C.sCabinRear;
  const sCF = C.sCabinFront;
  const sRF = C.sRoofFront;
  const sRR = C.sRoofRear;

  const cAx = sCR.cx + sideSign * sCR.w * BODY_W_TOP;
  const cAy = sCR.cy - sCR.h * BODY_SHOULDER;
  const cBx = sCF.cx + sideSign * sCF.w * BODY_W_TOP;
  const cBy = sCF.cy - sCF.h * BODY_SHOULDER;
  const cCx = sRF.cx + sideSign * sRF.w * C.roofHalfFrac;
  const cCy = sRF.cy - sRF.h * ROOF_TOP;
  const cDx = sRR.cx + sideSign * sRR.w * C.roofHalfFrac;
  const cDy = sRR.cy - sRR.h * ROOF_TOP;

  const cross = (cBx - cAx) * (cDy - cAy) - (cBy - cAy) * (cDx - cAx);
  if (sideSign * cross >= -0.5) return;

  fillQuad(ctx, cAx, cAy, cBx, cBy, cCx, cCy, cDx, cDy, C.flankUpperColor);

  if (isSilhouetteLod) return;

  const uBot = 0.16;
  const uTop = 0.84;
  const vRear = C.isVan ? 0.09 : 0.16;
  const vFront = C.isVan ? 0.91 : 0.83;

  evalCabinPoint(C, sideSign, uBot, vRear, _pt1);
  evalCabinPoint(C, sideSign, uBot, vFront, _pt2);
  evalCabinPoint(C, sideSign, uTop, vFront, _pt3);
  evalCabinPoint(C, sideSign, uTop, vRear, _pt4);

  if (_pt2.t <= _pt1.t + 0.025 || _pt3.t <= _pt4.t + 0.025) return;

  let sideGlassFill;
  if (C.wNear >= CAR_GLASS_GRADIENT_LOD_W) {
    const glassTopY = Math.min(_pt4.y, _pt3.y);
    const glassBotY = Math.max(_pt1.y, _pt2.y);
    const glassGrad = ctx.createLinearGradient(0, glassTopY, 0, glassBotY);
    if (opts.dir === -1) {
      glassGrad.addColorStop(0.0, '#48cae4');
      glassGrad.addColorStop(0.45, '#1b4965');
      glassGrad.addColorStop(1.0, '#0b132b');
    } else {
      glassGrad.addColorStop(0.0, '#2c7da0');
      glassGrad.addColorStop(0.45, '#162647');
      glassGrad.addColorStop(1.0, '#091124');
    }
    sideGlassFill = glassGrad;
  } else {
    // На средних дистанциях плоский тон неотличим от градиента, но убирает десятки аллокаций CanvasGradient
    sideGlassFill = opts.dir === -1 ? '#1b4965' : '#162647';
  }

  fillQuad(ctx, _pt1.x, _pt1.y, _pt2.x, _pt2.y, _pt3.x, _pt3.y, _pt4.x, _pt4.y, sideGlassFill);

  if (C.wNear >= 14) {
    evalCabinPoint(C, sideSign, uBot, MathUtil.lerp(vRear, vFront, 0.24), _pt1);
    evalCabinPoint(C, sideSign, uBot, MathUtil.lerp(vRear, vFront, 0.44), _pt2);
    evalCabinPoint(C, sideSign, uTop, MathUtil.lerp(vRear, vFront, 0.55), _pt3);
    evalCabinPoint(C, sideSign, uTop, MathUtil.lerp(vRear, vFront, 0.35), _pt4);
    if (_pt2.t > _pt1.t + 0.008 && _pt3.t > _pt4.t + 0.008) {
      fillQuad(ctx, _pt1.x, _pt1.y, _pt2.x, _pt2.y, _pt3.x, _pt3.y, _pt4.x, _pt4.y, 'rgba(210, 244, 255, 0.36)');
    }
  }

  if (C.wNear >= 14 && opts.type !== 'coupe') {
    const pillarFracs = C.isVan ? PILLARS_VAN : PILLARS_SEDAN;
    const halfPillarV = C.isVan ? 0.028 : 0.034;
    const uPillarBot = uBot - 0.015;
    const uPillarTop = uTop + 0.015;
    for (let p = 0; p < pillarFracs.length; p++) {
      const vCenter = MathUtil.lerp(vRear, vFront, pillarFracs[p]);
      evalCabinPoint(C, sideSign, uPillarBot, vCenter - halfPillarV, _pt1);
      evalCabinPoint(C, sideSign, uPillarBot, vCenter + halfPillarV, _pt2);
      evalCabinPoint(C, sideSign, uPillarTop, vCenter + halfPillarV, _pt3);
      evalCabinPoint(C, sideSign, uPillarTop, vCenter - halfPillarV, _pt4);
      if (_pt2.t > _pt1.t + 0.004 && _pt3.t > _pt4.t + 0.004) {
        fillQuad(ctx, _pt1.x, _pt1.y, _pt2.x, _pt2.y, _pt3.x, _pt3.y, _pt4.x, _pt4.y, C.flankUpperColor);
      }
    }
  }
}

/**
 * Отрисовка ближнего (заднего для попутных / лобового для встречных) стекла и ближней палубы (багажник/капот)
 */
function renderNearGlassAndDeck(ctx, C, opts, isSilhouetteLod) {
  const s0 = C.s0;
  const sCR = C.sCabinRear;
  const sRR = C.sRoofRear;

  if (C.nearFrac < C.tRR) {
    fillQuad(
      ctx,
      sCR.cx - sCR.w * BODY_W_TOP, sCR.cy - sCR.h * BODY_SHOULDER,
      sCR.cx + sCR.w * BODY_W_TOP, sCR.cy - sCR.h * BODY_SHOULDER,
      sRR.cx + sRR.w * C.roofHalfFrac, sRR.cy - sRR.h * ROOF_TOP,
      sRR.cx - sRR.w * C.roofHalfFrac, sRR.cy - sRR.h * ROOF_TOP,
      C.pillarFrameColor
    );

    const glassBotY = sCR.cy - sCR.h * GLASS_BOT;
    const glassTopY = sRR.cy - sRR.h * GLASS_TOP;

    let nearGlassFill;
    if (!isSilhouetteLod && C.wNear >= CAR_GLASS_GRADIENT_LOD_W) {
      const nearGlassGrad = ctx.createLinearGradient(0, glassTopY, 0, glassBotY);
      if (opts.dir === -1) {
        nearGlassGrad.addColorStop(0.0, '#90e0ef');
        nearGlassGrad.addColorStop(0.55, '#0096c7');
        nearGlassGrad.addColorStop(1.0, '#14213d');
      } else {
        nearGlassGrad.addColorStop(0.0, '#4cc9f0');
        nearGlassGrad.addColorStop(0.45, '#1d4e89');
        nearGlassGrad.addColorStop(1.0, '#102542');
      }
      nearGlassFill = nearGlassGrad;
    } else {
      nearGlassFill = opts.dir === -1 ? '#0077b6' : '#1d4e89';
    }

    fillQuad(
      ctx,
      sCR.cx - sCR.w * 0.375, glassBotY,
      sCR.cx + sCR.w * 0.375, glassBotY,
      sRR.cx + sRR.w * C.innerGlassRoofFrac, glassTopY,
      sRR.cx - sRR.w * C.innerGlassRoofFrac, glassTopY,
      nearGlassFill
    );

    if (C.wNear > 18) {
      const glShift = MathUtil.clamp(opts.yaw * 0.35, -0.14, 0.14);
      fillQuad(
        ctx,
        sCR.cx + sCR.w * (-0.11 + glShift), sCR.cy - sCR.h * (GLASS_BOT + 0.015),
        sCR.cx + sCR.w * (0.07 + glShift), sCR.cy - sCR.h * (GLASS_BOT + 0.015),
        sRR.cx + sRR.w * (0.03 + glShift), sRR.cy - sRR.h * (GLASS_TOP - 0.015),
        sRR.cx + sRR.w * (-0.09 + glShift), sRR.cy - sRR.h * (GLASS_TOP - 0.015),
        opts.dir === -1 ? 'rgba(255, 255, 255, 0.42)' : 'rgba(255, 224, 178, 0.34)'
      );
    }

    if (opts.isPlayer && opts.visualDamageLevel >= 1 && C.wNear > 22) {
      const crackLeft = opts.spoilerDamageSide !== 0
        ? opts.spoilerDamageSide < 0
        : (opts.leftDamageLevel >= opts.rightDamageLevel);
      const impactX = crackLeft ? (sCR.cx - sCR.w * 0.18) : (sCR.cx + sCR.w * 0.18);
      const impactY = MathUtil.lerp(glassBotY, glassTopY, 0.42);

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(sCR.cx - sCR.w * 0.375, glassBotY);
      ctx.lineTo(sCR.cx + sCR.w * 0.375, glassBotY);
      ctx.lineTo(sRR.cx + sRR.w * C.innerGlassRoofFrac, glassTopY);
      ctx.lineTo(sRR.cx - sRR.w * C.innerGlassRoofFrac, glassTopY);
      ctx.closePath();
      ctx.clip();

      ctx.strokeStyle = 'rgba(220, 245, 255, 0.78)';
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      const rayCount = Math.min(REAR_GLASS_CRACK_RAYS.length, 2 + opts.visualDamageLevel);
      for (let r = 0; r < rayCount; r++) {
        const ray = REAR_GLASS_CRACK_RAYS[r];
        ctx.moveTo(impactX, impactY);
        ctx.lineTo(impactX + ray[0] * sCR.w, impactY + ray[1] * sCR.h);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  if (C.nearFrac < C.tCR) {
    fillQuad(
      ctx,
      s0.cx - s0.w * BODY_W_TOP, s0.cy - s0.h * BODY_SHOULDER,
      s0.cx + s0.w * BODY_W_TOP, s0.cy - s0.h * BODY_SHOULDER,
      sCR.cx + sCR.w * BODY_W_TOP, sCR.cy - sCR.h * BODY_SHOULDER,
      sCR.cx - sCR.w * BODY_W_TOP, sCR.cy - sCR.h * BODY_SHOULDER,
      C.deckColor
    );

    if (opts.isPlayer && opts.visualDamageLevel >= 1 && C.wNear > 24) {
      const deckY0 = s0.cy - s0.h * BODY_SHOULDER;
      const deckY1 = sCR.cy - sCR.h * BODY_SHOULDER;

      if (opts.visualDamageLevel >= 3) {
        const sootGrad = ctx.createLinearGradient(0, deckY1, 0, deckY0);
        sootGrad.addColorStop(0.0, 'rgba(12, 8, 20, 0.55)');
        sootGrad.addColorStop(1.0, 'rgba(12, 8, 20, 0.14)');
        fillQuad(ctx, s0.cx - s0.w * 0.28, deckY0, s0.cx + s0.w * 0.28, deckY0, sCR.cx + sCR.w * 0.26, deckY1, sCR.cx - sCR.w * 0.26, deckY1, sootGrad);
      }

      const deckMidY = MathUtil.lerp(deckY0, deckY1, 0.52);

      if (opts.visualDamageLevel >= 2 || opts.rearDamageLevel >= 1) {
        const dentSide = opts.spoilerDamageSide !== 0
          ? opts.spoilerDamageSide
          : (opts.leftDamageLevel >= opts.rightDamageLevel ? -1 : 1);
        const dInX0 = s0.cx + dentSide * s0.w * 0.04;
        const dOutX0 = s0.cx + dentSide * s0.w * 0.24;
        const dMidX = MathUtil.lerp(s0.cx, sCR.cx, 0.55) + dentSide * sCR.w * 0.16;
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
      if (opts.leftDamageLevel >= 1 || opts.visualDamageLevel >= 1) {
        ctx.moveTo(s0.cx - s0.w * 0.36, deckY0);
        ctx.lineTo(sCR.cx - sCR.w * 0.28, MathUtil.lerp(deckY0, deckY1, 0.65));
      }
      if (opts.rightDamageLevel >= 1 || opts.visualDamageLevel >= 2) {
        ctx.moveTo(s0.cx + s0.w * 0.36, deckY0);
        ctx.lineTo(sCR.cx + sCR.w * 0.28, MathUtil.lerp(deckY0, deckY1, 0.65));
      }
      ctx.stroke();
    }
  }
}

/**
 * Отрисовка торцевой шайбы антикрыла спорткара
 */
function drawWingEndplate(ctx, w0, wingH, primary, rearXPos, rearTopYPos, frontXPos, frontTopYPos, scaleSide) {
  if (w0 < 16) return;
  const plateAbove = wingH * 0.22 * scaleSide;
  const plateBelow = wingH * 0.34 * scaleSide;
  fillQuad(
    ctx,
    rearXPos, rearTopYPos - plateAbove,
    frontXPos, frontTopYPos - plateAbove * 0.85,
    frontXPos, frontTopYPos + plateBelow * 0.85,
    rearXPos, rearTopYPos + plateBelow,
    '#140326'
  );
  ctx.strokeStyle = primary;
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(rearXPos, rearTopYPos - plateAbove + 1);
  ctx.lineTo(frontXPos, frontTopYPos - plateAbove * 0.85 + 1);
  ctx.stroke();
}

/**
 * Отрисовка заднего антикрыла игрока и соперников (включая состояния погнутого и оторванного спойлера)
 */
function renderCarSpoiler(ctx, C, opts, trunkLipY) {
  const s0 = C.s0;
  const w0 = s0.w;
  const sWingFront = evalCarSection(C, 0.11, _secTmpA);
  const wingH = Math.max(2.2, s0.h * 0.16);
  const strutW = Math.max(1.4, w0 * 0.042);
  const trunkRearY = trunkLipY;
  const trunkFrontY = sWingFront.cy - sWingFront.h * BODY_SHOULDER;
  const lipThickness = Math.max(1.5, s0.h * 0.045);

  if (opts.isPlayer && (opts.visualDamageLevel >= 4 || opts.isTotalWreck)) {
    const breakLeft = opts.spoilerDamageSide !== 0
      ? opts.spoilerDamageSide < 0
      : (opts.leftDamageLevel >= opts.rightDamageLevel);
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
    drawWingEndplate(ctx, w0, wingH, opts.primary, xOuterRear, intactTopY, xOuterFront, intactFrontTopY, 1);

    const hangPivotX = s0.cx + bSign * w0 * 0.13;
    const hangPivotY = trunkRearY - wingH * 0.22;
    const hangTipX = s0.cx + bSign * w0 * 0.47;
    const hangTipY = trunkRearY + wingH * 0.92;
    const chordX = -bSign * w0 * 0.045;
    const chordY = -wingH * 0.46;

    fillQuad(ctx, hangPivotX, hangPivotY, hangTipX, hangTipY, hangTipX, hangTipY + lipThickness * 1.15, hangPivotX, hangPivotY + lipThickness * 1.15, '#140326');
    fillQuad(ctx, hangPivotX, hangPivotY, hangTipX, hangTipY, hangTipX + chordX, hangTipY + chordY, hangPivotX + chordX, hangPivotY + chordY, '#e2e8f0');
    drawWingEndplate(ctx, w0, wingH, opts.primary, hangTipX, hangTipY, hangTipX + chordX, hangTipY + chordY, 0.85);
    return;
  }

  if (opts.isPlayer && opts.visualDamageLevel >= 2) {
    const bendLeft = opts.spoilerDamageSide !== 0
      ? opts.spoilerDamageSide < 0
      : (opts.leftDamageLevel >= opts.rightDamageLevel);
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
    drawWingEndplate(ctx, w0, wingH, opts.primary, s0.cx - w0 * 0.43, leftRearY, sWingFront.cx - sWingFront.w * 0.41, leftFrontY, 1);
    drawWingEndplate(ctx, w0, wingH, opts.primary, s0.cx + w0 * 0.43, rightRearY, sWingFront.cx + sWingFront.w * 0.41, rightFrontY, 1);
    return;
  }

  const wingTopY = trunkRearY - wingH;
  const wingFrontTopY = trunkFrontY - wingH * 0.85;

  ctx.fillStyle = '#140326';
  ctx.fillRect(s0.cx - w0 * 0.32, wingTopY, strutW, wingH);
  ctx.fillRect(s0.cx + w0 * 0.32 - strutW, wingTopY, strutW, wingH);

  fillQuad(ctx, s0.cx - w0 * 0.43, wingTopY, s0.cx + w0 * 0.43, wingTopY, sWingFront.cx + sWingFront.w * 0.41, wingFrontTopY, sWingFront.cx - sWingFront.w * 0.41, wingFrontTopY, '#ffffff');
  ctx.fillStyle = '#140326';
  ctx.fillRect(s0.cx - w0 * 0.43, wingTopY, w0 * 0.86, lipThickness);

  drawWingEndplate(ctx, w0, wingH, opts.primary, s0.cx - w0 * 0.43, wingTopY, sWingFront.cx - sWingFront.w * 0.41, wingFrontTopY, 1);
  drawWingEndplate(ctx, w0, wingH, opts.primary, s0.cx + w0 * 0.43, wingTopY, sWingFront.cx + sWingFront.w * 0.41, wingFrontTopY, 1);
}

function drawBrokenTaillight(ctx, lx, ly, lightW, lightH, wNear, isLeft) {
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
}

function drawIntegratedTurnLensBase(ctx, w0, lensX, lensY, lensW, lensH, isLit) {
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
}

/**
 * Отрисовка ближней торцевой панели (корма для попутных, передок для встречных):
 * бампер, выхлоп, фары/стоп-сигналы, поворотники, номерные знаки, антикрыло, ореолы света и бейдж соперника.
 */
function renderCarNearPanel(ctx, C, opts, isSilhouetteLod) {
  const s0 = C.s0;
  const w0 = s0.w;
  const rearTopY = s0.cy - s0.h;
  const trunkLipY = s0.cy - s0.h * BODY_SHOULDER;

  fillQuad(
    ctx,
    s0.cx - w0 * BODY_W_BOT, s0.cy - s0.h * C.bodyClearance,
    s0.cx + w0 * BODY_W_BOT, s0.cy - s0.h * C.bodyClearance,
    s0.cx + w0 * BODY_W_MID, s0.cy - s0.h * BODY_MID,
    s0.cx - w0 * BODY_W_MID, s0.cy - s0.h * BODY_MID,
    opts.secondary
  );
  fillQuad(
    ctx,
    s0.cx - w0 * BODY_W_MID, s0.cy - s0.h * BODY_MID,
    s0.cx + w0 * BODY_W_MID, s0.cy - s0.h * BODY_MID,
    s0.cx + w0 * BODY_W_TOP, trunkLipY,
    s0.cx - w0 * BODY_W_TOP, trunkLipY,
    opts.primary
  );

  if (w0 >= 14) {
    ctx.strokeStyle = MathUtil.shadeHex(opts.primary, 1.18);
    ctx.lineWidth = MathUtil.clamp(s0.h * 0.016, 1.0, 3.5);
    ctx.beginPath();
    ctx.moveTo(s0.cx - w0 * BODY_W_TOP, trunkLipY);
    ctx.lineTo(s0.cx + w0 * BODY_W_TOP, trunkLipY);
    ctx.stroke();
  }

  // Визуализация вмятин и потертостей задней панели автомобиля игрока
  if (opts.isPlayer && (opts.visualDamageLevel >= 1 || opts.rearDamageLevel >= 1) && C.wNear >= 20) {
    const seamSide = opts.spoilerDamageSide !== 0
      ? opts.spoilerDamageSide
      : (opts.leftDamageLevel >= opts.rightDamageLevel ? -1 : 1);
    const seamGapL = seamSide < 0 ? Math.max(1.6, s0.h * (0.022 + Math.min(3, opts.visualDamageLevel) * 0.008)) : Math.max(0.8, s0.h * 0.012);
    const seamGapR = seamSide > 0 ? Math.max(1.6, s0.h * (0.022 + Math.min(3, opts.visualDamageLevel) * 0.008)) : Math.max(0.8, s0.h * 0.012);
    fillQuad(
      ctx,
      s0.cx - w0 * 0.34, trunkLipY,
      s0.cx + w0 * 0.34, trunkLipY,
      s0.cx + w0 * 0.33, trunkLipY + seamGapR,
      s0.cx - w0 * 0.33, trunkLipY + seamGapL,
      'rgba(10, 2, 16, 0.72)'
    );

    if (opts.visualDamageLevel >= 2 || opts.rearDamageLevel >= 1) {
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

    if (opts.visualDamageLevel >= 3) {
      fillQuad(
        ctx,
        s0.cx - w0 * 0.22, s0.cy - s0.h * 0.57,
        s0.cx + w0 * 0.22, s0.cy - s0.h * 0.57,
        s0.cx + w0 * 0.18, s0.cy - s0.h * 0.36,
        s0.cx - w0 * 0.18, s0.cy - s0.h * 0.36,
        'rgba(12, 6, 18, 0.28)'
      );
    }

    for (let sideIdx = 0; sideIdx < 2; sideIdx++) {
      const sideSign = sideIdx === 0 ? -1 : 1;
      const sideDmg = sideSign < 0 ? opts.leftDamageLevel : opts.rightDamageLevel;
      if (sideDmg < 1) continue;
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
    }
  }

  let leftBumperDrop = 0;
  let rightBumperDrop = 0;
  if (opts.isPlayer && (opts.visualDamageLevel >= 2 || opts.rearDamageLevel >= 1)) {
    const bumperSagLeft = opts.spoilerDamageSide !== 0
      ? opts.spoilerDamageSide < 0
      : (opts.leftDamageLevel >= opts.rightDamageLevel);
    const dropAmt = Math.min(
      s0.h * 0.085,
      s0.h * (0.025 + Math.max(opts.rearDamageLevel, opts.visualDamageLevel - 1) * 0.016)
    );
    if (opts.isTotalWreck || (opts.leftDamageLevel >= 2 && opts.rightDamageLevel >= 2)) {
      leftBumperDrop = dropAmt * 0.85;
      rightBumperDrop = dropAmt * 0.65;
    } else if (bumperSagLeft) {
      leftBumperDrop = dropAmt;
    } else {
      rightBumperDrop = dropAmt;
    }
  }

  if (!isSilhouetteLod) {
    fillQuad(
      ctx,
      s0.cx - w0 * BODY_W_BOT, s0.cy - s0.h * C.bodyClearance + leftBumperDrop,
      s0.cx + w0 * BODY_W_BOT, s0.cy - s0.h * C.bodyClearance + rightBumperDrop,
      s0.cx + w0 * BODY_W_BUMPER_TOP, s0.cy - s0.h * C.bumperTop + rightBumperDrop,
      s0.cx - w0 * BODY_W_BUMPER_TOP, s0.cy - s0.h * C.bumperTop + leftBumperDrop,
      '#151124'
    );
  }

  if (opts.isPlayer && (opts.visualDamageLevel >= 1 || opts.rearDamageLevel >= 1) && C.wNear >= 20) {
    for (let sideIdx = 0; sideIdx < 2; sideIdx++) {
      const sideSign = sideIdx === 0 ? -1 : 1;
      const hasScuff = (sideSign < 0 ? opts.leftDamageLevel : opts.rightDamageLevel) >= 1 || opts.rearDamageLevel >= 2;
      if (!hasScuff) continue;

      const dropFracA = sideSign < 0 ? 0.04 : 0.96;
      const dropFracB = sideSign < 0 ? 0.15 : 0.85;
      const dropA = MathUtil.lerp(leftBumperDrop, rightBumperDrop, dropFracA);
      const dropB = MathUtil.lerp(leftBumperDrop, rightBumperDrop, dropFracB);
      const xOuter = s0.cx + sideSign * w0 * 0.445;
      const xInner = s0.cx + sideSign * w0 * 0.335;

      ctx.strokeStyle = 'rgba(176, 184, 206, 0.36)';
      ctx.lineWidth = MathUtil.clamp(s0.h * 0.018, 1.0, 3.0);
      ctx.beginPath();
      ctx.moveTo(xOuter, s0.cy - s0.h * (C.bodyClearance + 0.095) + dropA);
      ctx.lineTo(xInner, s0.cy - s0.h * (C.bodyClearance + 0.075) + dropB);
      ctx.moveTo(xOuter - sideSign * w0 * 0.015, s0.cy - s0.h * (C.bodyClearance + 0.060) + dropA);
      ctx.lineTo(xInner + sideSign * w0 * 0.02, s0.cy - s0.h * (C.bodyClearance + 0.045) + dropB);
      ctx.stroke();
    }
  }

  // Патрубки выхлопа и пламя форсажа / прострелов у машины игрока
  if (opts.isPlayer) {
    const flameY = s0.cy - s0.h * (C.bodyClearance + 0.03);
    const leftPipeX = s0.cx - w0 * 0.26;
    const rightPipeX = s0.cx + w0 * 0.26;

    if (C.wNear >= 20) {
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

    if (opts.showExhaustFlame || opts.showBackfireFlame) {
      const pulse = 0.5 + 0.5 * Math.sin(state.animClockMs * 0.08);

      if (state.settings.lightStyle === 'soft') {
        if (opts.showBackfireFlame) {
          const bfR = 7.0 + pulse * 5.2;
          drawLightHalo(ctx, leftPipeX, flameY, bfR, '#ff7b00', bfR * 2.15, HALO_STOPS.backfire);
          drawLightHalo(ctx, rightPipeX, flameY, bfR * 0.8, '#ff7b00', bfR * 1.75, HALO_STOPS.backfire);
        } else {
          const flameR = (opts.isSlipstreamingFlame ? 6.5 : 4.6) + pulse * 4.2;
          const flameColor = opts.isSlipstreamingFlame ? '#39ff14' : '#00f0ff';
          const flameStops = opts.isSlipstreamingFlame ? HALO_STOPS.flameSlipstream : HALO_STOPS.flameNormal;
          drawLightHalo(ctx, leftPipeX, flameY, flameR, flameColor, flameR * 2.1, flameStops);
          drawLightHalo(ctx, rightPipeX, flameY, flameR, flameColor, flameR * 2.1, flameStops);
        }
      } else if (opts.showBackfireFlame) {
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
        const flameR = (opts.isSlipstreamingFlame ? 6.5 : 4.5) + pulse * 4.2;
        ctx.fillStyle = opts.isSlipstreamingFlame ? '#39ff14' : '#00f0ff';
        ctx.beginPath();
        ctx.arc(leftPipeX, flameY, flameR, 0, Math.PI * 2);
        ctx.arc(rightPipeX, flameY, flameR, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  const isStreetTraffic = !opts.isPlayer && !opts.isRival;
  const opticFrameStyle = !isStreetTraffic
    ? 'none'
    : (opts.type === 'van' ? 'full' : (opts.type === 'sedan' ? 'thin' : 'none'));

  const turnW = w0 * 0.062;
  const lightW = isStreetTraffic ? w0 * 0.152 : w0 * 0.155;
  const lightH = s0.h * 0.12;
  const leftLightY = s0.cy - s0.h * 0.535;
  const rightLightY = leftLightY;

  const leftTurnX = s0.cx - w0 * 0.450;
  const rightTurnX = s0.cx + w0 * 0.450 - turnW;
  const leftLightX = isStreetTraffic ? (leftTurnX + turnW) : (s0.cx - w0 * 0.395);
  const rightLightX = isStreetTraffic ? (rightTurnX - lightW) : (s0.cx + w0 * 0.395 - lightW);

  const leftTailLit = !opts.leftLightBroken && !opts.leftLightFlicker;
  const rightTailLit = !opts.rightLightBroken && !opts.rightLightFlicker;
  let leftTurnLit = false;
  let rightTurnLit = false;

  // --- Проход А: непрозрачная геометрия оптики, номеров и спойлера (до световых ореолов) ---
  if (isStreetTraffic && opticFrameStyle !== 'none' && w0 > 8) {
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

  if (opts.dir === -1) {
    if (!isSilhouetteLod) {
      const grilleW = isStreetTraffic ? w0 * 0.37 : w0 * 0.42;
      ctx.fillStyle = '#0d091a';
      ctx.fillRect(s0.cx - grilleW * 0.5, leftLightY + lightH * 0.1, grilleW, lightH * 0.85);
    }

    ctx.fillStyle = opts.damagedByPlayer ? '#241f33' : (opts.highBeamFlashing ? '#e0ffff' : '#ffffff');
    ctx.fillRect(leftLightX, leftLightY, lightW, lightH);
    ctx.fillRect(rightLightX, rightLightY, lightW, lightH);
  } else {
    if (opts.leftLightBroken) {
      drawBrokenTaillight(ctx, leftLightX, leftLightY, lightW, lightH, C.wNear, true);
    } else {
      ctx.fillStyle = leftTailLit && opts.braking ? '#ff4d6d' : (leftTailLit ? '#9e0b28' : '#3d0815');
      ctx.fillRect(leftLightX, leftLightY, lightW, lightH);
    }

    if (opts.rightLightBroken) {
      drawBrokenTaillight(ctx, rightLightX, rightLightY, lightW, lightH, C.wNear, false);
    } else {
      ctx.fillStyle = rightTailLit && opts.braking ? '#ff4d6d' : (rightTailLit ? '#9e0b28' : '#3d0815');
      ctx.fillRect(rightLightX, rightLightY, lightW, lightH);
    }
  }

  const revW = w0 * 0.085;
  const revH = lightH * 0.82;
  const leftRevX = s0.cx - w0 * 0.225;
  const rightRevX = s0.cx + w0 * 0.225 - revW;
  const leftRevY = leftLightY + (lightH - revH) * 0.5;
  const rightRevY = rightLightY + (lightH - revH) * 0.5;

  if (opts.isPlayer) {
    ctx.fillStyle = opts.reversing ? '#ffffff' : (opts.isTotalWreck ? '#262030' : '#3a2d47');
    ctx.fillRect(leftRevX, leftRevY, revW, revH);
    ctx.fillRect(rightRevX, rightRevY, revW, revH);

    const plateW = w0 * 0.19;
    const plateH = s0.h * 0.12;
    const plateY = s0.cy - s0.h * (C.bumperTop - 0.006) + (leftBumperDrop + rightBumperDrop) * 0.45;
    const plateTilt = (opts.rearDamageLevel >= 1 || opts.visualDamageLevel >= 2)
      ? MathUtil.clamp((opts.rightDamageLevel - opts.leftDamageLevel) * 0.08 + opts.rearDamageLevel * 0.05, -0.24, 0.24)
      : 0;

    ctx.save();
    ctx.translate(s0.cx, plateY + plateH * 0.5);
    if (plateTilt !== 0) ctx.rotate(plateTilt);
    ctx.fillStyle = opts.isTotalWreck ? '#1f1b2b' : (opts.visualDamageLevel >= 3 ? '#d8d2e2' : '#ffffff');
    ctx.fillRect(-plateW * 0.5, -plateH * 0.5, plateW, plateH);
    ctx.fillStyle = opts.isTotalWreck ? '#5c5373' : '#140326';
    ctx.font = `900 ${Math.max(8, Math.round(plateH * 0.80))}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('01', 0, plateH * 0.04);
    ctx.restore();
  } else if (isStreetTraffic) {
    const hazardMode = opts.damagedByPlayer;
    const hazardOn = hazardMode && (Math.floor(state.animClockMs / 260) % 2 === 0);
    const signalBlinkOn = !hazardMode && opts.turnSignal !== 0 && (Math.floor(opts.signalElapsed / 0.18) % 2 === 0);

    leftTurnLit = hazardMode ? hazardOn : (opts.turnSignal === -1 && signalBlinkOn);
    rightTurnLit = hazardMode ? hazardOn : (opts.turnSignal === 1 && signalBlinkOn);

    drawIntegratedTurnLensBase(ctx, w0, leftTurnX, leftLightY, turnW, lightH, leftTurnLit);
    drawIntegratedTurnLensBase(ctx, w0, rightTurnX, rightLightY, turnW, lightH, rightTurnLit);

    if (opticFrameStyle !== 'none' && w0 > 10) {
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

    // Задний номерной знак гражданского трафика (плавный LOD от силуэта к тексту)
    if (opts.dir === 1 && w0 >= 5.0) {
      const plateW = w0 * 0.24;
      const plateH = s0.h * 0.118;
      const plateX = s0.cx - plateW * 0.5;
      const plateY = s0.cy - s0.h * 0.525;
      const plateVisAlpha = MathUtil.clamp((w0 - 5.0) / 5.5, 0, 1);
      const prevAlpha = ctx.globalAlpha;

      const framePad = Math.min(1.6, w0 * 0.0075);
      const plateFrameAlpha = plateVisAlpha * MathUtil.clamp((w0 - 7.5) / 10.5, 0, 1);
      if (plateFrameAlpha > 0.01 && framePad > 0.04) {
        ctx.globalAlpha = prevAlpha * plateFrameAlpha;
        ctx.fillStyle = '#130921';
        ctx.fillRect(plateX - framePad, plateY - framePad, plateW + framePad * 2, plateH + framePad * 2);
      }

      ctx.globalAlpha = prevAlpha * plateVisAlpha;
      ctx.fillStyle = opts.damagedByPlayer ? '#8e889c' : '#f4f1ea';
      ctx.fillRect(plateX, plateY, plateW, plateH);

      const stripAlpha = plateVisAlpha * MathUtil.clamp((plateH - 1.0) / 1.8, 0, 1);
      if (stripAlpha > 0.01) {
        ctx.globalAlpha = prevAlpha * stripAlpha;
        ctx.fillStyle = opts.damagedByPlayer ? '#495066' : '#2563eb';
        ctx.fillRect(plateX, plateY, plateW, plateH * 0.22);
      }

      const textAlpha = MathUtil.clamp((plateH - 2.8) / 2.2, 0, 1);
      const smudgeAlpha = plateVisAlpha * MathUtil.clamp((plateW - 4.0) / 5.0, 0, 1) * (1 - textAlpha);
      if (smudgeAlpha > 0.01) {
        ctx.globalAlpha = prevAlpha * smudgeAlpha * 0.65;
        ctx.fillStyle = '#140326';
        ctx.fillRect(plateX + plateW * 0.18, plateY + plateH * 0.54, plateW * 0.64, plateH * 0.22);
      }

      if (textAlpha > 0.01) {
        const plateText = opts.plate || '90X';
        ctx.globalAlpha = prevAlpha * textAlpha;
        ctx.fillStyle = opts.damagedByPlayer ? '#2a2438' : '#140326';
        ctx.font = `900 ${Math.max(4, plateH * 0.66)}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(plateText, s0.cx, plateY + plateH * 0.62, plateW * 0.86);
      }

      ctx.globalAlpha = prevAlpha;
    }
  }

  if (isStreetTraffic && opts.type === 'sport' && opts.dir === 1 && w0 > 16) {
    const lipH = s0.h * 0.055;
    ctx.fillStyle = MathUtil.shadeHex(opts.secondary, 0.85);
    ctx.fillRect(s0.cx - w0 * 0.43, trunkLipY - lipH, w0 * 0.86, lipH);
  }

  if ((opts.isPlayer || opts.isRival) && w0 >= 5.5) {
    renderCarSpoiler(ctx, C, opts, trunkLipY);
  }

  // --- Проход Б: световые ореолы через кэшированные offscreen-спрайты ---
  if (opts.dir === -1) {
    const headlightHaloFade = MathUtil.clamp((w0 - 3.5) / 14, 0, 1);
    if (headlightHaloFade > 0.01 && !opts.damagedByPlayer) {
      const beamRadius = opts.highBeamFlashing ? lightW * 2.55 : lightW * 1.25;
      const hardBeamColor = opts.highBeamFlashing ? 'rgba(210, 252, 255, 0.55)' : 'rgba(220, 250, 255, 0.22)';
      const softBeamRadius = opts.highBeamFlashing ? lightW * 3.45 : lightW * 2.1;
      const softBeamStops = opts.highBeamFlashing ? HALO_STOPS.oncomingHighBeam : HALO_STOPS.oncomingLowBeam;

      drawLightHalo(ctx, leftLightX + lightW * 0.5, leftLightY + lightH * 0.5, beamRadius, hardBeamColor, softBeamRadius, softBeamStops, headlightHaloFade);
      drawLightHalo(ctx, rightLightX + lightW * 0.5, rightLightY + lightH * 0.5, beamRadius, hardBeamColor, softBeamRadius, softBeamStops, headlightHaloFade);

      const coneFade = MathUtil.clamp((w0 - 10) / 18, 0, 1);
      if (opts.highBeamFlashing && coneFade > 0.01) {
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
          const prevAlpha = ctx.globalAlpha;
          ctx.globalAlpha = prevAlpha * coneFade;
          fillQuad(ctx, leftLightX + lightW * 0.1, coneTopY, leftLightX + lightW * 0.9, coneTopY, leftLightX + lightW + w0 * 0.10, coneBotY, leftLightX - w0 * 0.14, coneBotY, 'rgba(210, 252, 255, 0.24)');
          fillQuad(ctx, rightLightX + lightW * 0.1, coneTopY, rightLightX + lightW * 0.9, coneTopY, rightLightX + lightW + w0 * 0.14, coneBotY, rightLightX - w0 * 0.10, coneBotY, 'rgba(210, 252, 255, 0.24)');
          ctx.globalAlpha = prevAlpha;
        }
      }
    }
  } else {
    const brakeHaloFade = MathUtil.clamp((w0 - 4.0) / 14, 0, 1);
    if (opts.braking && brakeHaloFade > 0.01 && (leftTailLit || rightTailLit)) {
      const hardBrakeR = lightW * (opts.isPlayer ? 1.15 : 1.05);
      const hardBrakeColor = opts.isPlayer ? 'rgba(255, 42, 95, 0.38)' : 'rgba(255, 42, 95, 0.36)';
      const softBrakeR = lightW * (opts.isPlayer ? 2.15 : 1.9);
      if (leftTailLit) {
        drawLightHalo(ctx, leftLightX + lightW * 0.5, leftLightY + lightH * 0.5, hardBrakeR, hardBrakeColor, softBrakeR, HALO_STOPS.brakeLight, brakeHaloFade);
      }
      if (rightTailLit) {
        drawLightHalo(ctx, rightLightX + lightW * 0.5, rightLightY + lightH * 0.5, hardBrakeR, hardBrakeColor, softBrakeR, HALO_STOPS.brakeLight, brakeHaloFade);
      }
    }
  }

  if (opts.isPlayer && opts.reversing) {
    drawLightHalo(ctx, leftRevX + revW * 0.5, leftRevY + revH * 0.5, revW * 1.5, 'rgba(220, 250, 255, 0.50)', revW * 2.6, HALO_STOPS.reverseLight);
    drawLightHalo(ctx, rightRevX + revW * 0.5, rightRevY + revH * 0.5, revW * 1.5, 'rgba(220, 250, 255, 0.50)', revW * 2.6, HALO_STOPS.reverseLight);
  } else if (isStreetTraffic && (leftTurnLit || rightTurnLit)) {
    const signalHaloFade = MathUtil.clamp((w0 - 3.5) / 10, 0, 1);
    if (signalHaloFade > 0.01) {
      const hardR = Math.max(turnW * 1.45, w0 * 0.095);
      const softR = Math.max(turnW * 3.2, w0 * 0.22);
      if (leftTurnLit) {
        drawLightHalo(ctx, leftTurnX + turnW * 0.5, leftLightY + lightH * 0.5, hardR, 'rgba(255, 190, 11, 0.52)', softR, HALO_STOPS.turnSignal, signalHaloFade);
        ctx.fillStyle = '#fff9db';
        ctx.fillRect(leftTurnX + turnW * 0.18, leftLightY + lightH * 0.18, turnW * 0.64, lightH * 0.64);
      }
      if (rightTurnLit) {
        drawLightHalo(ctx, rightTurnX + turnW * 0.5, rightLightY + lightH * 0.5, hardR, 'rgba(255, 190, 11, 0.52)', softR, HALO_STOPS.turnSignal, signalHaloFade);
        ctx.fillStyle = '#fff9db';
        ctx.fillRect(rightTurnX + turnW * 0.18, rightLightY + lightH * 0.18, turnW * 0.64, lightH * 0.64);
      }
    }
  }

  // Позывной соперника над крышей с плавным проявлением по дистанции
  if (!opts.isPlayer && opts.isRival && w0 > 26) {
    const labelAlpha = MathUtil.clamp((w0 - 26) / 18, 0, 1);
    const roofTopY = Math.min(rearTopY, C.sRoofRear.cy - C.sRoofRear.h * ROOF_TOP);
    const labelY = roofTopY - 10;
    const prevAlpha = ctx.globalAlpha;

    ctx.globalAlpha = prevAlpha * labelAlpha;
    ctx.font = '800 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2.6;
    ctx.strokeStyle = 'rgba(9, 2, 22, 0.85)';
    ctx.strokeText(`#${opts.num} ${opts.name}`, s0.cx, labelY);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(`#${opts.num} ${opts.name}`, s0.cx, labelY);
    ctx.globalAlpha = prevAlpha;
  }
}

/**
 * Полная перспективная 3D-отрисовка автомобиля без вложенных замыканий, с ранним отсечением за холмами и LOD
 */
export function render3DCar(ctx, opts) {
  const LOGICAL_WIDTH = state.logicalWidth;
  const trackLength = state.trackLength;
  const lenZ = opts.lenZ || PLAYER_LEN_Z;
  const halfLen = lenZ * 0.5;
  if (opts.camZ + halfLen <= MIN_CAR_CAM_Z) return;

  // Плавное проявление трафика из дымки у самого края дальности прорисовки
  const isActivePlayer = opts.isPlayer && !opts.isParkedDetach;
  const distRatio = opts.distRatio || 0;
  const horizonFade = (!isActivePlayer && distRatio > 0.86)
    ? MathUtil.clamp((1 - distRatio) / 0.14, 0, 1)
    : 1;
  if (horizonFade <= 0.01) return;

  const effectiveNearOffset = Math.min(halfLen, Math.max(-halfLen, opts.camZ - MIN_CAR_CAM_Z));
  const clippedRear = halfLen - effectiveNearOffset;
  const nearFrac = clippedRear / lenZ;
  const visibleSpanFrac = Math.max(0.02, 1 - nearFrac);

  const zNear = (((opts.centerZ - effectiveNearOffset) % trackLength) + trackLength) % trackLength;
  const zFar = (((opts.centerZ + halfLen) % trackLength) + trackLength) % trackLength;

  const near = sampleRoadAtZ(zNear, _nearSample) || (opts.useFallback ? fillFallbackRoadSample(opts.camZ - effectiveNearOffset, _nearSample) : null);
  const far = sampleRoadAtZ(zFar, _farSample) || (opts.useFallback ? fillFallbackRoadSample(opts.camZ + halfLen, _farSample) : null);
  if (!near || !far || near.scale <= 0 || far.scale <= 0) return;

  const yawSlope = Math.tan(opts.yaw || 0);
  const nearWorldX = opts.worldX - effectiveNearOffset * yawSlope;
  const farWorldX = opts.worldX + halfLen * yawSlope;

  const cxNear = near.roadCenterX + near.scale * nearWorldX * PROJ_HALF_WIDTH + (opts.screenShiftX || 0);
  const cyNear = near.roadY + (opts.verticalOffset || 0);
  const wNear = opts.w * near.scale * ROAD_WIDTH * PROJ_HALF_WIDTH;
  const hNear = wNear * 0.58 * opts.h;

  const cxFar = far.roadCenterX + far.scale * farWorldX * PROJ_HALF_WIDTH + (opts.screenShiftX || 0);
  const cyFar = far.roadY + (opts.verticalOffset || 0);
  const wFar = opts.w * far.scale * ROAD_WIDTH * PROJ_HALF_WIDTH;
  const hFar = wFar * 0.58 * opts.h;

  if (
    wNear < 2.2 ||
    Math.max(cxNear + wNear, cxFar + wFar) < -48 ||
    Math.min(cxNear - wNear, cxFar - wFar) > LOGICAL_WIDTH + 48
  ) {
    return;
  }

  const labelPadTop = (!opts.isPlayer && opts.isRival && wNear > 26) ? 18 : 0;
  const approxTopY = Math.min(cyNear - hNear * 1.18, cyFar - hFar * 1.18) - labelPadTop;
  const approxBotY = Math.max(cyNear + hNear * 0.38, cyFar + hFar * 0.25);

  if (approxTopY > LOGICAL_HEIGHT + 48) return;

  // Ранний выход для машин, полностью скрытых за гребнем холма, и условный ctx.clip() только на перегибе
  const clipY = near.clipY;
  const hasClip = !isActivePlayer && clipY !== null && clipY !== undefined;
  if (hasClip && approxTopY >= clipY - 0.3) return;

  const needsClip = hasClip && approxBotY > clipY + 0.5;
  if (needsClip) beginHorizonClip(ctx, clipY);

  const baseAlpha = ctx.globalAlpha;
  if (horizonFade < 0.999) {
    ctx.globalAlpha = baseAlpha * horizonFade;
  }

  // Заполняем общий контекст сечений автомобиля без создания объектов
  const C = _carCtx;
  const type = opts.type || 'sport';
  const isVan = type === 'van';
  const profile = CAR_BODY_PROFILES[type] || CAR_BODY_PROFILES.coupe;

  C.nearFrac = nearFrac;
  C.visibleSpanFrac = visibleSpanFrac;
  C.nearScale = near.scale;
  C.farScale = far.scale;
  C.cxNear = cxNear;
  C.cyNear = cyNear;
  C.wNear = wNear;
  C.hNear = hNear;
  C.cxFar = cxFar;
  C.cyFar = cyFar;
  C.wFar = wFar;
  C.hFar = hFar;
  C.isVan = isVan;
  C.bodyClearance = isVan ? 0.20 : 0.22;
  C.bumperTop = opts.dir === -1 ? (C.bodyClearance + 0.12) : (C.bodyClearance + 0.13);

  if (opts.dir === -1) {
    C.tCR = 1 - profile.tCF;
    C.tRR = 1 - profile.tRF;
    C.tRF = 1 - profile.tRR;
    C.tCF = 1 - profile.tCR;
    C.tAxleNear = 1 - profile.tAxleFar;
    C.tAxleFar = 1 - profile.tAxleNear;
  } else {
    C.tCR = profile.tCR;
    C.tRR = profile.tRR;
    C.tRF = profile.tRF;
    C.tCF = profile.tCF;
    C.tAxleNear = profile.tAxleNear;
    C.tAxleFar = profile.tAxleFar;
  }

  C.roofHalfFrac = profile.roofHalfFrac;
  C.innerGlassRoofFrac = profile.roofHalfFrac * 0.80;
  C.dtWheel = profile.dtWheel;
  C.wheelRFrac = profile.wheelRFrac;
  const tireWidthFrac = (opts.isPlayer || opts.isRival)
    ? 0.148
    : (isVan ? 0.128 : (type === 'sport' ? 0.140 : 0.130));
  C.tireInnerFrac = TIRE_OUTER_FRAC - tireWidthFrac;
  C.showRearPanel = nearFrac < 0.03;

  evalCarSection(C, Math.max(0.0, nearFrac), C.s0);
  evalCarSection(C, Math.max(C.tAxleNear, nearFrac), C.saNearAxle);
  evalCarSection(C, Math.max(C.tCR, nearFrac), C.sCabinRear);
  evalCarSection(C, Math.max(C.tRR, nearFrac), C.sRoofRear);
  evalCarSection(C, Math.max(C.tRF, nearFrac), C.sRoofFront);
  evalCarSection(C, Math.max(C.tCF, nearFrac), C.sCabinFront);
  evalCarSection(C, 1.0, C.s1);

  if (isActivePlayer) {
    const a = state.playerScreenAnchors;
    a.rearCenterX = C.s0.cx;
    a.rearCenterY = C.s0.cy - C.s0.h * 0.36;
    a.rearGroundY = C.s0.cy;
    a.centerX = (C.s0.cx + C.s1.cx) * 0.5;
    a.centerY = (C.s0.cy + C.s1.cy) * 0.5 - C.s0.h * 0.36;
    a.hoodY = C.s0.cy - C.s0.h * BODY_SHOULDER;
    a.carW = C.s0.w;
    a.carH = C.s0.h;
    a.leftWheelX = C.saNearAxle.cx - C.saNearAxle.w * 0.38;
    a.leftWheelY = C.saNearAxle.cy - 2;
    a.rightWheelX = C.saNearAxle.cx + C.saNearAxle.w * 0.38;
    a.rightWheelY = C.saNearAxle.cy - 2;
    a.exhaustLeftX = C.s0.cx - C.s0.w * 0.26;
    a.exhaustRightX = C.s0.cx + C.s0.w * 0.26;
    a.exhaustY = C.s0.cy - C.s0.h * (C.bodyClearance + 0.03);
  }

  C.lateralDeltaX = C.s1.cx - C.s0.cx;
  C.hiddenFlankSign = C.lateralDeltaX >= 0 ? -1 : 1;
  C.visibleFlankSign = -C.hiddenFlankSign;
  C.flankVisibility = MathUtil.clamp(Math.abs(C.lateralDeltaX) / Math.max(1, wNear * 0.42), 0, 1);

  const edge0X = C.s0.cx + C.visibleFlankSign * C.s0.w * BODY_W_TOP;
  const edge1X = C.s1.cx + C.visibleFlankSign * C.s1.w * BODY_W_TOP;
  C.visibleFlankSpanPx = C.visibleFlankSign * (edge1X - edge0X);
  C.showVisibleFlank = C.visibleFlankSpanPx > 0.35;

  C.flankLowerColor = MathUtil.shadeHex(opts.secondary, 0.88);
  C.flankUpperColor = MathUtil.shadeHex(opts.primary, 0.88);
  C.roofColor = MathUtil.shadeHex(opts.primary, 1.18);
  C.deckColor = MathUtil.shadeHex(opts.primary, 1.04);
  C.pillarFrameColor = MathUtil.shadeHex(opts.primary, 0.94);

  const isSilhouetteLod = !opts.isPlayer && wNear < CAR_SILHOUETTE_LOD_W;

  // 1. Контактная тень под днищем
  renderCarShadow(ctx, C, isSilhouetteLod);

  // 2. Протекторы всех 4 колёс под днищем (пропускаются на дальнем силуэтном LOD < 8.5 px)
  if (!isSilhouetteLod) {
    renderWheelTread(ctx, C, C.hiddenFlankSign, C.tAxleFar);
    renderWheelTread(ctx, C, C.visibleFlankSign, C.tAxleFar);
    renderWheelTread(ctx, C, C.hiddenFlankSign, C.tAxleNear);
    renderWheelTread(ctx, C, C.visibleFlankSign, C.tAxleNear);
  }

  // 3. Дальние верхние плоскости: капот (или багажник встречки) и дальнее стекло
  const sCF = C.sCabinFront;
  const sRF = C.sRoofFront;
  const sRR = C.sRoofRear;
  const s1 = C.s1;

  fillQuad(
    ctx,
    sCF.cx - sCF.w * BODY_W_TOP, sCF.cy - sCF.h * BODY_SHOULDER,
    sCF.cx + sCF.w * BODY_W_TOP, sCF.cy - sCF.h * BODY_SHOULDER,
    s1.cx + s1.w * BODY_W_TOP, s1.cy - s1.h * BODY_SHOULDER,
    s1.cx - s1.w * BODY_W_TOP, s1.cy - s1.h * BODY_SHOULDER,
    C.deckColor
  );

  if (nearFrac < C.tCF) {
    fillQuad(
      ctx,
      sRF.cx - sRF.w * C.roofHalfFrac, sRF.cy - sRF.h * ROOF_TOP,
      sRF.cx + sRF.w * C.roofHalfFrac, sRF.cy - sRF.h * ROOF_TOP,
      sCF.cx + sCF.w * BODY_W_TOP, sCF.cy - sCF.h * BODY_SHOULDER,
      sCF.cx - sCF.w * BODY_W_TOP, sCF.cy - sCF.h * BODY_SHOULDER,
      C.pillarFrameColor
    );
    if (!isSilhouetteLod) {
      fillQuad(
        ctx,
        sRF.cx - sRF.w * C.innerGlassRoofFrac, sRF.cy - sRF.h * GLASS_TOP,
        sRF.cx + sRF.w * C.innerGlassRoofFrac, sRF.cy - sRF.h * GLASS_TOP,
        sCF.cx + sCF.w * 0.375, sCF.cy - sCF.h * GLASS_BOT,
        sCF.cx - sCF.w * 0.375, sCF.cy - sCF.h * GLASS_BOT,
        opts.dir === -1 ? '#1d3557' : '#48cae4'
      );
    }
  }

  // 4. Видимая нижняя боковина и её перспективные колёсные арки с дисками
  renderLowerFlank(ctx, C, opts, C.visibleFlankSign, isSilhouetteLod);
  if (!isSilhouetteLod) {
    renderSideWheelsAndArches(ctx, C, opts, C.visibleFlankSign);
  }

  // 5. Крыша
  if (nearFrac < C.tRF) {
    fillQuad(
      ctx,
      sRR.cx - sRR.w * C.roofHalfFrac, sRR.cy - sRR.h * ROOF_TOP,
      sRR.cx + sRR.w * C.roofHalfFrac, sRR.cy - sRR.h * ROOF_TOP,
      sRF.cx + sRF.w * C.roofHalfFrac, sRF.cy - sRF.h * ROOF_TOP,
      sRF.cx - sRF.w * C.roofHalfFrac, sRF.cy - sRF.h * ROOF_TOP,
      C.roofColor
    );
  }

  // 6. Видимые боковины кабины и боковые стёкла
  renderCabinFlankAndWindow(ctx, C, opts, C.hiddenFlankSign, isSilhouetteLod);
  renderCabinFlankAndWindow(ctx, C, opts, C.visibleFlankSign, isSilhouetteLod);

  // 7–8. Ближнее стекло и ближняя палуба
  renderNearGlassAndDeck(ctx, C, opts, isSilhouetteLod);

  // 9. Ближняя торцевая панель (корма / передок, оптика, номера, антикрыло, ореолы)
  if (C.showRearPanel) {
    renderCarNearPanel(ctx, C, opts, isSilhouetteLod);
  }

  ctx.globalAlpha = baseAlpha;
  if (needsClip) ctx.restore();
}

/**
 * Обёртка отрисовки автомобиля гражданского трафика или ИИ-соперника (0 аллокаций объекта параметров)
 */
export function renderTrafficCar(ctx, car, precomputedCamZ = null) {
  const carCamZ = precomputedCamZ !== null
    ? precomputedCamZ
    : getShortestTrackDz(state.position, car.z, state.trackLength);
  const isHighBeamFlashing =
    car.dir === -1 &&
    car.highBeamFlashTimer > 0 &&
    !car.damagedByPlayer &&
    Math.floor(state.animClockMs / 95) % 2 === 0;

  const o = _trafficCarOpts;
  o.isRival = Boolean(car.isRival);
  o.type = car.type || 'sport';
  o.dir = car.dir;
  o.w = car.w;
  o.h = car.h;
  o.lenZ = car.lenZ || Math.round(SEGMENT_LENGTH * 1.3);
  o.primary = car.primary;
  o.secondary = car.secondary;
  o.worldX = car.x;
  o.centerZ = car.z;
  o.camZ = carCamZ;
  o.distRatio = carCamZ / (DRAW_DISTANCE * SEGMENT_LENGTH);
  o.yaw = car.yaw || 0;
  o.braking = Boolean(car.braking || car.speed < 25);
  o.damagedByPlayer = Boolean(car.damagedByPlayer);
  o.highBeamFlashing = isHighBeamFlashing;
  o.turnSignal = car.turnSignal || 0;
  o.signalElapsed = car.signalElapsed || 0;
  o.name = car.name || '';
  o.num = car.num || '';
  o.plate = car.plate || '';

  render3DCar(ctx, o);
}

/**
 * Обёртка отрисовки автомобиля игрока (активного на трассе или остановленного при завершении заезда)
 */
export function renderPlayerCar(ctx, parkedCamZ = null) {
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

  const o = _playerCarOpts;
  o.isParkedDetach = isParkedDetach;
  o.w = PLAYER_WIDTH_NORM;
  o.h = 0.96;
  o.lenZ = PLAYER_LEN_Z;
  o.primary = '#ff2a6d';
  o.secondary = '#6b052c';
  o.worldX = (isParkedDetach ? state.stoppedPlayerX : state.playerX) * ROAD_WIDTH;
  o.centerZ = isParkedDetach ? state.stoppedPlayerZ : (state.position + PLAYER_Z + PLAYER_CENTER_OFFSET_Z);
  o.camZ = isParkedDetach ? parkedCamZ : (PLAYER_Z + PLAYER_CENTER_OFFSET_Z);
  o.distRatio = 0;
  o.yaw = playerYaw;
  o.screenShiftX = crashShakeX;
  o.verticalOffset = baseBounce + offRoadBounce + damageWobble + crashShakeY;
  o.useFallback = !isParkedDetach;
  o.braking = isBraking;
  o.reversing = isReversing;
  o.isTotalWreck = isTotalWreck;
  o.leftLightBroken = leftLightBroken;
  o.rightLightBroken = rightLightBroken;
  o.leftLightFlicker = leftLightFlicker;
  o.rightLightFlicker = rightLightFlicker;
  o.visualDamageLevel = activeVisualDamage;
  o.leftDamageLevel = hasDamageSystem ? state.leftDamage : 0;
  o.rightDamageLevel = hasDamageSystem ? state.rightDamage : 0;
  o.rearDamageLevel = hasDamageSystem ? state.rearDamage : 0;
  o.spoilerDamageSide = hasDamageSystem ? state.spoilerDamageSide : 0;
  o.showExhaustFlame = showExhaustFlame;
  o.isSlipstreamingFlame = state.isSlipstreaming;
  o.showBackfireFlame = showBackfireFlame;

  render3DCar(ctx, o);
}