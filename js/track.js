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

/**
 * Запись следов торможения для игрока (sampleOwner = null) или соперника
 */
export function recordSkidMarks(currZ, currX, alpha, fallbackBackDist = 0, sampleOwner = null) {
  const prev = sampleOwner ? sampleOwner.prevSkidSample : state.prevSkidSample;
  const setPrev = (val) => {
    if (sampleOwner) sampleOwner.prevSkidSample = val;
    else state.prevSkidSample = val;
  };

  if (!prev) {
    if (fallbackBackDist > 1) {
      const startZ = (((currZ - fallbackBackDist) % state.trackLength) + state.trackLength) % state.trackLength;
      setPrev({ z: startZ, x: currX });
    } else {
      setPrev({ z: currZ, x: currX });
      return;
    }
  }

  const activePrev = sampleOwner ? sampleOwner.prevSkidSample : state.prevSkidSample;
  const dz = getShortestTrackDz(activePrev.z, currZ, state.trackLength);
  if (dz <= 0.5 || dz > SEGMENT_LENGTH * 6) {
    setPrev({ z: currZ, x: currX });
    return;
  }

  let rem = dz;
  let curPos = activePrev.z;
  let safety = 0;

  while (rem > 0.05 && safety < 16) {
    safety++;
    const seg = findSegment(curPos);
    if (!seg) break;

    const segStart = seg.index * SEGMENT_LENGTH;
    const offsetInSeg = (((curPos - segStart) % SEGMENT_LENGTH) + SEGMENT_LENGTH) % SEGMENT_LENGTH;
    const distToSegEnd = SEGMENT_LENGTH - offsetInSeg;
    const step = Math.min(rem, distToSegEnd);

    const t1 = offsetInSeg / SEGMENT_LENGTH;
    const t2 = (offsetInSeg + step) / SEGMENT_LENGTH;
    const frac1 = (dz - rem) / dz;
    const frac2 = (dz - rem + step) / dz;

    const x1 = MathUtil.lerp(activePrev.x, currX, frac1);
    const x2 = MathUtil.lerp(activePrev.x, currX, frac2);

    const mark = { seg, t1, x1, t2, x2, alpha };
    seg.skidMarks.push(mark);
    state.skidMarksList.push(mark);

    if (state.skidMarksList.length > MAX_SKID_MARKS) {
      const oldest = state.skidMarksList.shift();
      if (oldest && oldest.seg) {
        const idx = oldest.seg.skidMarks.indexOf(oldest);
        if (idx !== -1) oldest.seg.skidMarks.splice(idx, 1);
      }
    }

    curPos = (curPos + step) % state.trackLength;
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
    p1: { world: { y: lastY(), z: n * SEGMENT_LENGTH }, camera: {}, screen: {} },
    p2: { world: { y: y, z: (n + 1) * SEGMENT_LENGTH }, camera: {}, screen: {} },
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
    color: isDark
      ? {
          road: '#252a42',
          grass: '#100624',
          rumble: '#ff2a85',
          edge: '#ffffff',
          lane: '#ffffff'
        }
      : {
          road: '#2f3552',
          grass: '#160930',
          rumble: '#ffffff',
          edge: '#b8f2ff',
          lane: null
        }
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
  addRoad(20, 60, 20, 0, -lastY() / SEGMENT_LENGTH);

  const segments = state.segments;
  if (segments.length > 0) {
    segments[segments.length - 1].p2.world.y = segments[0].p1.world.y;
  }

  state.trackLength = segments.length * SEGMENT_LENGTH;

  // Равномерная расстановка чекпоинтов кратно полной длине трассы
  const cpCount = Math.max(1, Math.round(segments.length / CHECKPOINT_INTERVAL));
  const exactStep = Math.floor(segments.length / cpCount);
  for (let c = 1; c <= cpCount; c++) {
    const cpIdx = (c * exactStep) % segments.length;
    segments[cpIdx].isCheckpoint = true;
    addSprite(cpIdx, 'checkpoint_arch', 0);
  }

  const totalSegs = segments.length;
  for (let n = 0; n < totalSegs; n++) {
    // Исключаем постановку пальм, фонарей и билбордов вплотную к опорам чекпоинт-арки
    const prevSeg = segments[(n - 1 + totalSegs) % totalSegs];
    const nextSeg = segments[(n + 1) % totalSegs];
    if (segments[n].isCheckpoint || prevSeg.isCheckpoint || nextSeg.isCheckpoint) {
      continue;
    }

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

function evalCatmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x: 0.5 * (
      (2 * p1.x) +
      (-p0.x + p2.x) * t +
      (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
      (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3
    ),
    y: 0.5 * (
      (2 * p1.y) +
      (-p0.y + p2.y) * t +
      (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
      (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3
    )
  };
}

function resampleClosedLoop(points, numSegments) {
  const count = points.length;
  const cumLen = new Array(count + 1);
  cumLen[0] = 0;
  let totalArc = 0;
  for (let i = 0; i < count; i++) {
    const curr = points[i];
    const next = points[(i + 1) % count];
    totalArc += Math.hypot(next.x - curr.x, next.y - curr.y);
    cumLen[i + 1] = totalArc;
  }

  const uniformPts = new Array(numSegments);
  let rawIdx = 0;
  for (let i = 0; i < numSegments; i++) {
    const targetS = (i / numSegments) * totalArc;
    while (rawIdx < count - 1 && cumLen[rawIdx + 1] < targetS) {
      rawIdx++;
    }
    const segStartS = cumLen[rawIdx];
    const segEndS = cumLen[rawIdx + 1];
    const frac = segEndS > segStartS ? (targetS - segStartS) / (segEndS - segStartS) : 0;
    const a = points[rawIdx];
    const b = points[(rawIdx + 1) % count];
    uniformPts[i] = {
      x: MathUtil.lerp(a.x, b.x, frac),
      y: MathUtil.lerp(a.y, b.y, frac)
    };
  }
  return uniformPts;
}

function computeClosedLoopTurnAngles(pts) {
  const n = pts.length;
  const headings = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    headings[i] = Math.atan2(b.y - a.y, b.x - a.x);
  }
  const dThetas = new Array(n);
  let maxAbsTurn = 0;
  for (let i = 0; i < n; i++) {
    const dt = Math.atan2(
      Math.sin(headings[(i + 1) % n] - headings[i]),
      Math.cos(headings[(i + 1) % n] - headings[i])
    );
    dThetas[i] = dt;
    const absDt = Math.abs(dt);
    if (absDt > maxAbsTurn) maxAbsTurn = absDt;
  }
  return { headings, dThetas, maxAbsTurn };
}

/**
 * Рандомная генерация замкнутого кольцевого трека
 */
export function buildCircuitTrack() {
  state.segments = [];
  state.minimapCacheKey = '';
  state.circuitSeedId = 1000 + Math.floor(Math.random() * 9000);

  const numCtrl = 12;
  const aspectStretch = 1.24 + Math.random() * 0.34;

  const weights = [];
  let weightSum = 0;
  for (let k = 0; k < numCtrl; k++) {
    const isStartZone = k === 0 || k === 1 || k === numCtrl - 1;
    const w = isStartZone ? 1.15 : (0.84 + Math.random() * 0.38);
    weights.push(w);
    weightSum += w;
  }

  const angles = [];
  let accAngle = 0;
  for (let k = 0; k < numCtrl; k++) {
    angles.push(accAngle);
    accAngle += (weights[k] / weightSum) * Math.PI * 2;
  }

  const radii = new Array(numCtrl).fill(1.0);
  let idx = 2;
  while (idx <= numCtrl - 3) {
    const featureRoll = Math.random();
    if (featureRoll < 0.44 && idx <= numCtrl - 5) {
      radii[idx] = 1.28 + Math.random() * 0.14;
      radii[idx + 1] = 0.56 + Math.random() * 0.10;
      radii[idx + 2] = 1.26 + Math.random() * 0.14;
      idx += 3;
    } else if (featureRoll < 0.76 && idx <= numCtrl - 6) {
      radii[idx] = 1.24 + Math.random() * 0.12;
      radii[idx + 1] = 0.62 + Math.random() * 0.10;
      radii[idx + 2] = 1.22 + Math.random() * 0.12;
      radii[idx + 3] = 0.60 + Math.random() * 0.10;
      idx += 4;
    } else {
      radii[idx] = Math.random() < 0.5 ? (0.58 + Math.random() * 0.12) : (1.26 + Math.random() * 0.14);
      idx += 1;
    }
  }

  const ctrlPoints = [];
  for (let k = 0; k < numCtrl; k++) {
    const phi = angles[k];
    ctrlPoints.push({
      x: Math.cos(phi) * radii[k] * aspectStretch,
      y: Math.sin(phi) * radii[k]
    });
  }

  const startStraightX = aspectStretch * 1.05;
  ctrlPoints[0].x = startStraightX;
  ctrlPoints[0].y = 0;
  ctrlPoints[1].x = startStraightX;
  ctrlPoints[1].y = Math.sin(angles[1]) * 1.05;
  ctrlPoints[numCtrl - 1].x = startStraightX;
  ctrlPoints[numCtrl - 1].y = Math.sin(angles[numCtrl - 1]) * 1.05;

  const samplesPerSpan = 220;
  const rawPoints = [];
  for (let i = 0; i < numCtrl; i++) {
    const pt0 = ctrlPoints[(i - 1 + numCtrl) % numCtrl];
    const pt1 = ctrlPoints[i];
    const pt2 = ctrlPoints[(i + 1) % numCtrl];
    const pt3 = ctrlPoints[(i + 2) % numCtrl];
    for (let s = 0; s < samplesPerSpan; s++) {
      rawPoints.push(evalCatmullRom(pt0, pt1, pt2, pt3, s / samplesPerSpan));
    }
  }

  const minSegs = GAME_CONFIG.circuit.minSegments;
  const maxSegs = GAME_CONFIG.circuit.maxSegments;
  const numSegments = minSegs + Math.floor(Math.random() * (maxSegs - minSegs + 1));
  let loopPts = resampleClosedLoop(rawPoints, numSegments);

  const maxAllowedTurnRad = 12.0 / SEGMENT_LENGTH;
  let turnData = computeClosedLoopTurnAngles(loopPts);
  let smoothPasses = 0;
  while (turnData.maxAbsTurn > maxAllowedTurnRad && smoothPasses < 45) {
    smoothPasses++;
    const smoothed = new Array(numSegments);
    for (let i = 0; i < numSegments; i++) {
      const prev = loopPts[(i - 1 + numSegments) % numSegments];
      const curr = loopPts[i];
      const next = loopPts[(i + 1) % numSegments];
      smoothed[i] = {
        x: prev.x * 0.25 + curr.x * 0.5 + next.x * 0.25,
        y: prev.y * 0.25 + curr.y * 0.5 + next.y * 0.25
      };
    }
    loopPts = resampleClosedLoop(smoothed, numSegments);
    turnData = computeClosedLoopTurnAngles(loopPts);
  }

  const finalCurves = new Array(numSegments);
  for (let i = 0; i < numSegments; i++) {
    finalCurves[i] = MathUtil.clamp(turnData.dThetas[i] * SEGMENT_LENGTH, -12.0, 12.0);
  }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < numSegments; i++) {
    if (loopPts[i].x < minX) minX = loopPts[i].x;
    if (loopPts[i].x > maxX) maxX = loopPts[i].x;
    if (loopPts[i].y < minY) minY = loopPts[i].y;
    if (loopPts[i].y > maxY) maxY = loopPts[i].y;
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

    const curveVal = finalCurves[i];
    addSegment(curveVal, worldY);

    const seg = state.segments[i];
    const currPt = loopPts[i];
    seg.mapX = (currPt.x - minX + padX) / maxSpan;
    seg.mapY = (currPt.y - minY + padY) / maxSpan;
    seg.mapHeading = turnData.headings[i];

    if (Math.abs(curveVal) > 5.8) {
      const isAlt = Math.floor(i / 2) % 2 === 0;
      seg.color.rumble = isAlt ? '#ffbe0b' : '#ff2a85';
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
    const nearStartFinish = n === 0 || n === 1 || n === segments.length - 1;

    if (!nearStartFinish && Math.abs(seg.curve) > 5.6 && n % 5 === 0) {
      const hasRail = seg.guardrailLeft || seg.guardrailRight;
      const signOffset = hasRail ? 1.38 : 1.30;
      const outerSide = seg.curve > 0 ? -signOffset : signOffset;
      addSprite(n, seg.curve > 0 ? 'chevron_right' : 'chevron_left', outerSide);
    }

    // Фаза фонарей (n % 20 === 7) разведена с шевронами (n % 5 === 0), чтобы исключить клиппинг в поворотах
    if (!nearStartFinish && n % 20 === 7) {
      addSprite(n, 'lamp', -1.34);
      addSprite(n, 'lamp', 1.34);
    }

    // Фаза билбордов (n % 65 === 23) также не пересекается ни с шевронами, ни с фонарями
    if (n > 18 && n < segments.length - 18 && n % 65 === 23) {
      const side = (Math.floor(n / 65) % 2 === 0) ? -1.68 : 1.68;
      addSprite(n, 'billboard', side);
    }
  }
}