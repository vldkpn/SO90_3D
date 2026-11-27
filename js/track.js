import {
  GAME_CONFIG,
  LOGICAL_HEIGHT,
  SEGMENT_LENGTH,
  RUMBLE_LENGTH,
  CHECKPOINT_INTERVAL,
  MAX_SKID_MARKS
} from './config.js';
import { MathUtil, getShortestTrackDz } from './utils.js';
import { state, findSegment } from './state.js';

// Предельно допустимая кривизна кольцевой трассы (острые, но физически проходимые повороты)
const MAX_CIRCUIT_CURVE = 7.6;
const SHARP_CURVE_THRESHOLD = 5.8;

// Переиспользуемые неизменяемые палитры сегментов (убирают 1660 аллокаций объектов при построении трассы)
const PALETTE_DARK = Object.freeze({
  road: '#252a42',
  grass: '#100624',
  rumble: '#ff2a85',
  edge: '#ffffff',
  lane: '#ffffff'
});

const PALETTE_LIGHT = Object.freeze({
  road: '#2f3552',
  grass: '#160930',
  rumble: '#ffffff',
  edge: '#b8f2ff',
  lane: null
});

const PALETTE_DARK_SHARP_YELLOW = Object.freeze({ ...PALETTE_DARK, rumble: '#ffbe0b' });
const PALETTE_LIGHT_SHARP_YELLOW = Object.freeze({ ...PALETTE_LIGHT, rumble: '#ffbe0b' });
const PALETTE_LIGHT_SHARP_PINK = Object.freeze({ ...PALETTE_LIGHT, rumble: '#ff2a85' });

// Кольцевой индекс перезаписи следов торможения за O(1) вместо Array.shift()
let skidWriteIdx = 0;

/**
 * Запись следов торможения для игрока (sampleOwner = null) или соперника
 */
export function recordSkidMarks(currZ, currX, alpha, fallbackBackDist = 0, sampleOwner = null) {
  const trackLength = state.trackLength;
  const totalSegs = state.segments.length;
  if (trackLength <= 0 || totalSegs === 0) return;

  if (state.skidMarksList.length === 0) {
    skidWriteIdx = 0;
  }

  let prev = sampleOwner ? sampleOwner.prevSkidSample : state.prevSkidSample;
  const setPrev = (val) => {
    if (sampleOwner) sampleOwner.prevSkidSample = val;
    else state.prevSkidSample = val;
  };

  if (!prev) {
    if (fallbackBackDist > 1) {
      const startZ = (((currZ - fallbackBackDist) % trackLength) + trackLength) % trackLength;
      prev = { z: startZ, x: currX };
      setPrev(prev);
    } else {
      setPrev({ z: currZ, x: currX });
      return;
    }
  }

  const dz = getShortestTrackDz(prev.z, currZ, trackLength);
  if (dz <= 0.5 || dz > SEGMENT_LENGTH * 6) {
    setPrev({ z: currZ, x: currX });
    return;
  }

  let rem = dz;
  let curPos = prev.z;
  let safety = 0;

  while (rem > 0.05 && safety < 16) {
    safety++;
    const seg = findSegment(curPos);
    if (!seg) break;

    const segStart = seg.index * SEGMENT_LENGTH;
    const offsetInSeg = (((curPos - segStart) % SEGMENT_LENGTH) + SEGMENT_LENGTH) % SEGMENT_LENGTH;
    const distToSegEnd = SEGMENT_LENGTH - offsetInSeg;
    const reachesSegEnd = rem >= distToSegEnd - 1e-4;
    const step = reachesSegEnd ? distToSegEnd : rem;

    // Пропускаем вырожденные микро-шаги на границах сегментов из-за погрешности float
    if (step >= 0.05) {
      const t1 = offsetInSeg / SEGMENT_LENGTH;
      const t2 = Math.min(1, (offsetInSeg + step) / SEGMENT_LENGTH);
      const frac1 = (dz - rem) / dz;
      const frac2 = Math.min(1, (dz - rem + step) / dz);

      const x1 = MathUtil.lerp(prev.x, currX, frac1);
      const x2 = MathUtil.lerp(prev.x, currX, frac2);

      const mark = { seg, t1, x1, t2, x2, alpha };
      seg.skidMarks.push(mark);

      if (state.skidMarksList.length < MAX_SKID_MARKS) {
        state.skidMarksList.push(mark);
      } else {
        const oldest = state.skidMarksList[skidWriteIdx];
        if (oldest && oldest.seg) {
          const idx = oldest.seg.skidMarks.indexOf(oldest);
          if (idx !== -1) oldest.seg.skidMarks.splice(idx, 1);
        }
        state.skidMarksList[skidWriteIdx] = mark;
        skidWriteIdx = (skidWriteIdx + 1) % MAX_SKID_MARKS;
      }
    }

    // При достижении границы переходим точно на начало следующего сегмента без накопления float-погрешности
    if (reachesSegEnd) {
      curPos = ((seg.index + 1) % totalSegs) * SEGMENT_LENGTH;
    } else {
      curPos = (curPos + step) % trackLength;
    }
    rem -= step;
  }

  setPrev({ z: currZ, x: currX });
}

function lastY() {
  return state.segments.length === 0
    ? 0
    : state.segments[state.segments.length - 1].p2.world.y;
}

function addSegment(curve, y) {
  const n = state.segments.length;
  const isDark = Math.floor(n / RUMBLE_LENGTH) % 2 === 1;
  state.segments.push({
    index: n,
    p1: { world: { x: 0, y: lastY(), z: n * SEGMENT_LENGTH }, camera: {}, screen: {} },
    p2: { world: { x: 0, y: y, z: (n + 1) * SEGMENT_LENGTH }, camera: {}, screen: {} },
    curve: curve,
    sprites: [],
    cars: [],
    skidMarks: [],
    isCheckpoint: false,
    isStartFinish: false,
    guardrailLeft: false,
    guardrailRight: false,
    mapX: 0.5,
    mapY: 0.5,
    mapHeading: 0,
    clip: LOGICAL_HEIGHT,
    projectedFrame: -1,
    color: isDark ? PALETTE_DARK : PALETTE_LIGHT
  });
}

function addRoad(enter, hold, leave, curve, yDelta) {
  const startY = lastY();
  const endY = startY + yDelta * SEGMENT_LENGTH;
  const total = enter + hold + leave;
  for (let n = 0; n < enter; n++) {
    addSegment(
      MathUtil.easeIn(0, curve, n / enter),
      MathUtil.easeInOut(startY, endY, (n + 1) / total)
    );
  }
  for (let n = 0; n < hold; n++) {
    addSegment(
      curve,
      MathUtil.easeInOut(startY, endY, (enter + n + 1) / total)
    );
  }
  for (let n = 0; n < leave; n++) {
    addSegment(
      MathUtil.easeInOut(curve, 0, n / leave),
      MathUtil.easeInOut(startY, endY, (enter + hold + n + 1) / total)
    );
  }
}

function addSprite(segIndex, type, offset) {
  if (segIndex < 0 || segIndex >= state.segments.length) return;
  state.segments[segIndex].sprites.push({ type, offset });
}

export function applySharpTurnGuardrails(curveThreshold) {
  const segments = state.segments;
  if (!segments.length) return;
  const total = segments.length;

  for (let i = 0; i < total; i++) {
    segments[i].guardrailLeft = false;
    segments[i].guardrailRight = false;
  }

  if (state.gameMode !== 'circuit' || state.difficulty !== 'arcade') return;

  for (let n = 0; n < total; n++) {
    const seg = segments[n];
    if (Math.abs(seg.curve) >= curveThreshold) {
      const isRightTurn = seg.curve > 0;
      for (let pad = -2; pad <= 2; pad++) {
        const idx = (n + pad + total) % total;
        if (isRightTurn) {
          segments[idx].guardrailLeft = true;
        } else {
          segments[idx].guardrailRight = true;
        }
      }
    }
  }
}

/**
 * Классическая бесконечная шоссейная петля для режимов свободного заезда
 */
export function buildTrack() {
  state.segments = [];
  skidWriteIdx = 0;

  addRoad(15, 65, 15, 0, 0);
  addRoad(40, 85, 40, 2.1, 8);
  addRoad(25, 50, 25, 0, -6);
  addRoad(35, 85, 35, -3.2, 5);
  addRoad(35, 55, 35, 1.3, 10);
  addRoad(35, 55, 35, -1.5, -12);
  addRoad(30, 50, 30, 0, 8);
  addRoad(35, 75, 35, 3.0, -5);
  addRoad(35, 75, 35, -3.1, -5);
  addRoad(50, 110, 50, 2.5, 9);
  const remainingY = -lastY() / SEGMENT_LENGTH;
  addRoad(45, 95, 45, -1.9, remainingY);
  addRoad(20, 60, 20, 0, 0);

  const segments = state.segments;
  const totalSegs = segments.length;
  if (totalSegs > 0) {
    segments[totalSegs - 1].p2.world.y = segments[0].p1.world.y;
  }

  state.trackLength = totalSegs * SEGMENT_LENGTH;

  // Равномерная расстановка чекпоинтов с гарантированным совпадением последнего с сегментом 0
  const cpCount = Math.max(1, Math.round(totalSegs / CHECKPOINT_INTERVAL));
  for (let c = 1; c <= cpCount; c++) {
    const cpIdx = Math.round((c * totalSegs) / cpCount) % totalSegs;
    segments[cpIdx].isCheckpoint = true;
    addSprite(cpIdx, 'checkpoint_arch', 0);
  }

  for (let n = 0; n < totalSegs; n++) {
    // Расширенная чистая зона (±3 сегмента) вокруг арок исключает клиппинг пальм и фонарей с опорами
    let nearCheckpoint = false;
    for (let pad = -3; pad <= 3; pad++) {
      if (segments[(n + pad + totalSegs) % totalSegs].isCheckpoint) {
        nearCheckpoint = true;
        break;
      }
    }
    if (nearCheckpoint) continue;

    if (n % 7 === 0) {
      addSprite(n, 'palm', -1.42 - Math.random() * 0.45);
      addSprite(n, 'palm', 1.42 + Math.random() * 0.45);
    }

    if (n % 18 === 4) {
      addSprite(n, 'lamp', -1.24);
      addSprite(n, 'lamp', 1.24);
    }

    if (n % 55 === 20) {
      const side = (Math.floor(n / 55) % 2 === 0) ? -1.62 : 1.62;
      addSprite(n, 'billboard', side);
    }
  }
}

function evalCatmullRomAxis(v0, v1, v2, v3, t, t2, t3) {
  return 0.5 * (
    (2 * v1) +
    (-v0 + v2) * t +
    (2 * v0 - 5 * v1 + 4 * v2 - v3) * t2 +
    (-v0 + 3 * v1 - 3 * v2 + v3) * t3
  );
}

/**
 * Равномерная передискретизация замкнутого контура в типизированные буферы (без аллокации объектов)
 */
function resampleClosedLoopFlat(srcX, srcY, srcCount, dstX, dstY, numSegments, cumLenBuf) {
  cumLenBuf[0] = 0;
  let totalArc = 0;
  for (let i = 0; i < srcCount; i++) {
    const nextIdx = (i + 1) % srcCount;
    totalArc += Math.hypot(srcX[nextIdx] - srcX[i], srcY[nextIdx] - srcY[i]);
    cumLenBuf[i + 1] = totalArc;
  }

  let rawIdx = 0;
  for (let i = 0; i < numSegments; i++) {
    const targetS = (i / numSegments) * totalArc;
    while (rawIdx < srcCount - 1 && cumLenBuf[rawIdx + 1] < targetS) {
      rawIdx++;
    }
    const segStartS = cumLenBuf[rawIdx];
    const segEndS = cumLenBuf[rawIdx + 1];
    const frac = segEndS > segStartS ? (targetS - segStartS) / (segEndS - segStartS) : 0;
    const nextIdx = (rawIdx + 1) % srcCount;
    dstX[i] = MathUtil.lerp(srcX[rawIdx], srcX[nextIdx], frac);
    dstY[i] = MathUtil.lerp(srcY[rawIdx], srcY[nextIdx], frac);
  }
}

function computeClosedLoopTurnAnglesFlat(ptsX, ptsY, n, headingsOut, dThetasOut) {
  for (let i = 0; i < n; i++) {
    const nextIdx = (i + 1) % n;
    headingsOut[i] = Math.atan2(ptsY[nextIdx] - ptsY[i], ptsX[nextIdx] - ptsX[i]);
  }

  let maxAbsTurn = 0;
  for (let i = 0; i < n; i++) {
    const nextHeading = headingsOut[(i + 1) % n];
    const diff = nextHeading - headingsOut[i];
    const dt = Math.atan2(Math.sin(diff), Math.cos(diff));
    dThetasOut[i] = dt;
    const absDt = Math.abs(dt);
    if (absDt > maxAbsTurn) maxAbsTurn = absDt;
  }
  return maxAbsTurn;
}

/**
 * Рандомная генерация замкнутого кольцевого трека
 */
export function buildCircuitTrack() {
  state.segments = [];
  state.minimapCacheKey = '';
  skidWriteIdx = 0;
  state.circuitSeedId = 1000 + Math.floor(Math.random() * 9000);

  const numCtrl = 12;
  const aspectStretch = 1.24 + Math.random() * 0.34;

  const weights = new Float64Array(numCtrl);
  let weightSum = 0;
  for (let k = 0; k < numCtrl; k++) {
    const isStartZone = k === 0 || k === 1 || k === numCtrl - 1;
    const w = isStartZone ? 1.15 : (0.84 + Math.random() * 0.38);
    weights[k] = w;
    weightSum += w;
  }

  const angles = new Float64Array(numCtrl);
  let accAngle = 0;
  for (let k = 0; k < numCtrl; k++) {
    angles[k] = accAngle;
    accAngle += (weights[k] / weightSum) * Math.PI * 2;
  }

  const radii = new Float64Array(numCtrl);
  radii.fill(1.0);
  let idx = 2;
  while (idx <= numCtrl - 3) {
    const featureRoll = Math.random();
    if (featureRoll < 0.44 && idx <= numCtrl - 5) {
      radii[idx] = 1.18 + Math.random() * 0.10;
      radii[idx + 1] = 0.68 + Math.random() * 0.10;
      radii[idx + 2] = 1.16 + Math.random() * 0.10;
      idx += 3;
    } else if (featureRoll < 0.76 && idx <= numCtrl - 6) {
      radii[idx] = 1.16 + Math.random() * 0.10;
      radii[idx + 1] = 0.72 + Math.random() * 0.10;
      radii[idx + 2] = 1.14 + Math.random() * 0.10;
      radii[idx + 3] = 0.70 + Math.random() * 0.10;
      idx += 4;
    } else {
      radii[idx] = Math.random() < 0.5 ? (0.70 + Math.random() * 0.10) : (1.18 + Math.random() * 0.10);
      idx += 1;
    }
  }

  const ctrlX = new Float64Array(numCtrl);
  const ctrlY = new Float64Array(numCtrl);
  for (let k = 0; k < numCtrl; k++) {
    const phi = angles[k];
    ctrlX[k] = Math.cos(phi) * radii[k] * aspectStretch;
    ctrlY[k] = Math.sin(phi) * radii[k];
  }

  const startStraightX = aspectStretch * 1.05;
  ctrlX[0] = startStraightX;
  ctrlY[0] = 0;
  ctrlX[1] = startStraightX;
  ctrlY[1] = Math.sin(angles[1]) * 1.05;
  ctrlX[numCtrl - 1] = startStraightX;
  ctrlY[numCtrl - 1] = Math.sin(angles[numCtrl - 1]) * 1.05;

  const samplesPerSpan = 220;
  const rawCount = numCtrl * samplesPerSpan;
  const rawX = new Float64Array(rawCount);
  const rawY = new Float64Array(rawCount);

  let rawWrite = 0;
  for (let i = 0; i < numCtrl; i++) {
    const i0 = (i - 1 + numCtrl) % numCtrl;
    const i1 = i;
    const i2 = (i + 1) % numCtrl;
    const i3 = (i + 2) % numCtrl;
    for (let s = 0; s < samplesPerSpan; s++) {
      const t = s / samplesPerSpan;
      const t2 = t * t;
      const t3 = t2 * t;
      rawX[rawWrite] = evalCatmullRomAxis(ctrlX[i0], ctrlX[i1], ctrlX[i2], ctrlX[i3], t, t2, t3);
      rawY[rawWrite] = evalCatmullRomAxis(ctrlY[i0], ctrlY[i1], ctrlY[i2], ctrlY[i3], t, t2, t3);
      rawWrite++;
    }
  }

  // Квантуем длину круга кратно полному циклу поребриков и пунктира (2 * RUMBLE_LENGTH = 10) для бесшовного стыка
  const patternCycle = RUMBLE_LENGTH * 2;
  const minSegs = Math.ceil(GAME_CONFIG.circuit.minSegments / patternCycle) * patternCycle;
  const maxSegs = Math.floor(GAME_CONFIG.circuit.maxSegments / patternCycle) * patternCycle;
  const cycleSteps = Math.max(0, Math.floor((maxSegs - minSegs) / patternCycle));
  const numSegments = minSegs + Math.floor(Math.random() * (cycleSteps + 1)) * patternCycle;

  const loopX = new Float64Array(numSegments);
  const loopY = new Float64Array(numSegments);
  const smoothX = new Float64Array(numSegments);
  const smoothY = new Float64Array(numSegments);
  const rawCumLen = new Float64Array(rawCount + 1);
  const loopCumLen = new Float64Array(numSegments + 1);
  const headings = new Float64Array(numSegments);
  const dThetas = new Float64Array(numSegments);

  resampleClosedLoopFlat(rawX, rawY, rawCount, loopX, loopY, numSegments, rawCumLen);
  // Ограничиваем максимальную кривизну для честной физики и точного соответствия 3D-дороги контуру миникарты
  const maxAllowedTurnRad = MAX_CIRCUIT_CURVE / SEGMENT_LENGTH;
  let maxAbsTurn = computeClosedLoopTurnAnglesFlat(loopX, loopY, numSegments, headings, dThetas);
  let smoothPasses = 0;

  // Равномерное 7-точечное сглаживание [1, 3, 6, 8, 6, 3, 1]/28 сходится в 4 раза быстрее
  // и гарантированно доводит углы контура до maxAllowedTurnRad без клиппинга и изломов у старта
  while (maxAbsTurn > maxAllowedTurnRad && smoothPasses < 140) {
    smoothPasses++;
    for (let i = 0; i < numSegments; i++) {
      const m3 = (i - 3 + numSegments) % numSegments;
      const m2 = (i - 2 + numSegments) % numSegments;
      const m1 = (i - 1 + numSegments) % numSegments;
      const p1 = (i + 1) % numSegments;
      const p2 = (i + 2) % numSegments;
      const p3 = (i + 3) % numSegments;

      smoothX[i] = (
        loopX[m3] + 3 * loopX[m2] + 6 * loopX[m1] +
        8 * loopX[i] +
        6 * loopX[p1] + 3 * loopX[p2] + loopX[p3]
      ) / 28;
      smoothY[i] = (
        loopY[m3] + 3 * loopY[m2] + 6 * loopY[m1] +
        8 * loopY[i] +
        6 * loopY[p1] + 3 * loopY[p2] + loopY[p3]
      ) / 28;
    }
    resampleClosedLoopFlat(smoothX, smoothY, numSegments, loopX, loopY, numSegments, loopCumLen);
    maxAbsTurn = computeClosedLoopTurnAnglesFlat(loopX, loopY, numSegments, headings, dThetas);
  }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < numSegments; i++) {
    const px = loopX[i];
    const py = loopY[i];
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  const spanX = Math.max(0.001, maxX - minX);
  const spanY = Math.max(0.001, maxY - minY);
  const maxSpan = Math.max(spanX, spanY);
  const padX = (maxSpan - spanX) * 0.5;
  const padY = (maxSpan - spanY) * 0.5;

  const hillPhase1 = Math.random() * Math.PI * 2;
  const hillPhase2 = Math.random() * Math.PI * 2;
  const hillAmp1 = (6 + Math.random() * 8) * SEGMENT_LENGTH;
  const hillAmp2 = (3 + Math.random() * 5) * SEGMENT_LENGTH;

  for (let i = 0; i < numSegments; i++) {
    const tNext = ((i + 1) % numSegments) / numSegments;
    const edgeDist = Math.min(tNext, 1 - tNext);
    const hillEnvelope = Math.min(1, Math.pow(edgeDist / 0.08, 2));
    const worldY = (
      hillAmp1 * Math.sin(2 * Math.PI * tNext + hillPhase1) +
      hillAmp2 * Math.sin(4 * Math.PI * tNext + hillPhase2)
    ) * hillEnvelope;

    const curveVal = MathUtil.clamp(dThetas[i] * SEGMENT_LENGTH, -MAX_CIRCUIT_CURVE, MAX_CIRCUIT_CURVE);
    addSegment(curveVal, worldY);

    const seg = state.segments[i];
    seg.mapX = (loopX[i] - minX + padX) / maxSpan;
    seg.mapY = (loopY[i] - minY + padY) / maxSpan;
    seg.mapHeading = headings[i];

    if (Math.abs(curveVal) > SHARP_CURVE_THRESHOLD) {
      const isAlt = Math.floor(i / 2) % 2 === 0;
      const isDark = seg.color === PALETTE_DARK;
      if (isDark) {
        seg.color = isAlt ? PALETTE_DARK_SHARP_YELLOW : PALETTE_DARK;
      } else {
        seg.color = isAlt ? PALETTE_LIGHT_SHARP_YELLOW : PALETTE_LIGHT_SHARP_PINK;
      }
    }
  }

  const segments = state.segments;
  if (segments.length > 0) {
    segments[segments.length - 1].p2.world.y = segments[0].p1.world.y;
  }

  state.trackLength = segments.length * SEGMENT_LENGTH;
  applySharpTurnGuardrails(GAME_CONFIG.circuit.guardrailCurveThreshold);

  segments[0].isStartFinish = true;
  addSprite(0, 'start_arch', 0);

  for (let n = 0; n < segments.length; n++) {
    const seg = segments[n];
    // Свободная от декораций зона ±3 сегмента вокруг стартовой арки исключает наложение фонарей на опоры
    const nearStartFinish = n <= 3 || n >= segments.length - 3;

    if (!nearStartFinish && Math.abs(seg.curve) > 5.6 && n % 5 === 0) {
      const hasRail = seg.guardrailLeft || seg.guardrailRight;
      const signOffset = hasRail ? 1.38 : 1.30;
      const outerSide = seg.curve > 0 ? -signOffset : signOffset;
      addSprite(n, seg.curve > 0 ? 'chevron_right' : 'chevron_left', outerSide);
    }

    if (!nearStartFinish && n % 20 === 7) {
      addSprite(n, 'lamp', -1.34);
      addSprite(n, 'lamp', 1.34);
    }

    if (n > 18 && n < segments.length - 18 && n % 65 === 23) {
      const side = (Math.floor(n / 65) % 2 === 0) ? -1.68 : 1.68;
      addSprite(n, 'billboard', side);
    }
  }
}