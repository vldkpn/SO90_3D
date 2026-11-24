import {
  GAME_CONFIG,
  STATE,
  ROAD_WIDTH,
  SEGMENT_LENGTH,
  DRAW_DISTANCE,
  PROJ_HALF_WIDTH,
  PLAYER_LEN_Z,
  PLAYER_WIDTH_NORM,
  SAFE_BUMPER_GAP_Z,
  TRAFFIC_SCAN_DIST_Z,
  ONCOMING_DETECT_DIST_Z,
  ONCOMING_HORN_DIST_Z,
  MAX_SPEED,
  ACCEL,
  OFF_ROAD_LIMIT,
  OFF_ROAD_THRESHOLD_X,
  INITIAL_TRAFFIC_COUNT,
  MAX_TRAFFIC_COUNT,
  METERS_PER_EXTRA_CAR,
  CAR_TYPES
} from './config.js';
import { MathUtil, getShortestTrackDz } from './utils.js';
import { audio } from './audio.js';
import {
  state,
  findSegment,
  getPlayerWorldZ,
  showBanner,
  spawnParticles
} from './state.js';
import { recordSkidMarks } from './track.js';

export function getLaneConfigs() {
  if (state.gameMode === 'oncoming') {
    return [
      { laneX: -0.66, dir: -1 },
      { laneX: -0.23, dir: -1 },
      { laneX:  0.23, dir:  1 },
      { laneX:  0.66, dir:  1 }
    ];
  }
  return [
    { laneX: -0.64, dir: 1 },
    { laneX:  0.00, dir: 1 },
    { laneX:  0.64, dir: 1 }
  ];
}

function pickBalancedLane(lanes) {
  const counts = new Array(lanes.length).fill(0);
  for (let i = 0; i < state.cars.length; i++) {
    const idx = state.cars[i].laneIndex;
    if (idx >= 0 && idx < counts.length) {
      counts[idx]++;
    }
  }
  let minCount = Infinity;
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] < minCount) minCount = counts[i];
  }
  const candidates = [];
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] <= minCount + 1) candidates.push(i);
  }
  return MathUtil.randomChoice(candidates);
}

export function spawnSingleCar(targetZ, avoidPlayerZone = false, preferredLaneIdx = null) {
  const segments = state.segments;
  if (!segments.length) return false;

  const lanes = getLaneConfigs();
  const laneIndex = preferredLaneIdx !== null ? preferredLaneIdx : pickBalancedLane(lanes);
  const lane = lanes[laneIndex];
  const archetype = MathUtil.randomChoice(CAR_TYPES);

  const wrappedZ = ((targetZ % state.trackLength) + state.trackLength) % state.trackLength;
  if (avoidPlayerZone) {
    const dzFromPlayer = getShortestTrackDz(state.position, wrappedZ, state.trackLength);
    if (dzFromPlayer > -90 * SEGMENT_LENGTH && dzFromPlayer < (DRAW_DISTANCE + 8) * SEGMENT_LENGTH) {
      return false;
    }
  }

  const seg = findSegment(wrappedZ);
  if (!seg) return false;

  let sameDirTotal = 0;
  for (let i = 0; i < lanes.length; i++) {
    if (lanes[i].dir === lane.dir) sameDirTotal++;
  }
  const sameDirOccupiedNearby = new Set();

  for (let offset = -12; offset <= 12; offset++) {
    const checkIdx = (seg.index + offset + segments.length) % segments.length;
    const neighborSeg = segments[checkIdx];
    for (let i = 0; i < neighborSeg.cars.length; i++) {
      const other = neighborSeg.cars[i];
      const sameLane =
        other.laneIndex === laneIndex ||
        Math.abs((other.x / ROAD_WIDTH) - lane.laneX) < 0.28 ||
        Math.abs((other.targetX / ROAD_WIDTH) - lane.laneX) < 0.28;
      if (sameLane) {
        return false;
      }
      if (Math.abs(offset) <= 5 && other.dir === lane.dir) {
        sameDirOccupiedNearby.add(other.laneIndex);
      }
    }
  }

  if (sameDirOccupiedNearby.size >= Math.max(1, sameDirTotal - 1)) {
    return false;
  }

  const progressionBoost = Math.min(0.14, (state.distanceMeters / 5000) * 0.14);
  const baseSpeed = lane.dir === 1
    ? MAX_SPEED * (0.28 + Math.random() * (0.30 + progressionBoost)) * archetype.speedMult
    : MAX_SPEED * (0.32 + Math.random() * (0.24 + progressionBoost));

  const car = {
    isRival: false,
    x: lane.laneX * ROAD_WIDTH,
    targetX: lane.laneX * ROAD_WIDTH,
    latVel: 0,
    yaw: 0,
    prevLaneIndex: laneIndex,
    laneIndex: laneIndex,
    laneCooldown: 0.4 + Math.random() * 0.9,
    laneChangeTimer: 0,
    turnSignal: 0,
    signalPreDelay: 0,
    signalHoldAfter: 0,
    signalElapsed: 0,
    highBeamFlashTimer: 0,
    hornCooldown: 0,
    z: wrappedZ,
    dir: lane.dir,
    speed: baseSpeed,
    baseSpeed: baseSpeed,
    brakeForce: MAX_SPEED * 0.65,
    braking: false,
    brakeHoldTimer: 0,
    damagedByPlayer: false,
    hitCooldown: 0,
    w: archetype.w,
    h: archetype.h,
    lenZ: archetype.lenZ || Math.round(SEGMENT_LENGTH * 1.3),
    type: archetype.type,
    primary: archetype.primary,
    secondary: archetype.secondary,
    segment: seg
  };

  seg.cars.push(car);
  state.cars.push(car);
  return true;
}

function removeCarAt(index) {
  const car = state.cars[index];
  const segIdx = car.segment.cars.indexOf(car);
  if (segIdx !== -1) car.segment.cars.splice(segIdx, 1);
  state.cars.splice(index, 1);
}

export function resetTraffic(count) {
  state.cars = [];
  state.rivals = [];
  for (let i = 0; i < state.segments.length; i++) {
    state.segments[i].cars = [];
  }
  const lanes = getLaneConfigs();
  let attempts = 0;
  while (state.cars.length < count && attempts < count * 18) {
    attempts++;
    const laneIdx = state.cars.length % lanes.length;
    const z = state.position + (45 + Math.random() * 410) * SEGMENT_LENGTH;
    spawnSingleCar(z, false, laneIdx);
  }
}

export function resetCircuitRivals() {
  state.cars = [];
  state.rivals = [];
  for (let i = 0; i < state.segments.length; i++) {
    state.segments[i].cars = [];
  }

  const rivalDefs = GAME_CONFIG.circuit.rivals;
  const count = Math.min(GAME_CONFIG.circuit.rivalsCount || rivalDefs.length, rivalDefs.length);

  for (let i = 0; i < count; i++) {
    const def = rivalDefs[i];
    const gridCol = i % 2 === 0 ? -0.38 : 0.38;
    const backFromStartLine = (1.8 + i * 1.1) * SEGMENT_LENGTH;
    const startProgressZ = -backFromStartLine;
    const wrappedZ = (((state.trackLength + startProgressZ) % state.trackLength) + state.trackLength) % state.trackLength;
    const seg = findSegment(wrappedZ);

    const rival = {
      isRival: true,
      name: def.name,
      num: def.num,
      skill: def.skill,
      finished: false,
      x: gridCol * ROAD_WIDTH,
      targetX: gridCol * ROAD_WIDTH,
      latVel: 0,
      yaw: 0,
      vx: 0,
      z: wrappedZ,
      progressZ: startProgressZ,
      dir: 1,
      speed: 0,
      baseSpeed: MAX_SPEED * def.skill,
      braking: false,
      prevSkidSample: null,
      hitCooldown: 0,
      aiDecisionTimer: Math.random() * 0.3,
      lineBias: (Math.random() - 0.5) * 0.24,
      mistakeCooldown: 2.0 + Math.random() * 3.5,
      mistakeTimer: 0,
      mistakeType: 'none',
      mistakeSeverity: 0,
      bumpCooldown: 1.0 + Math.random() * 2.0,
      w: def.w,
      h: def.h,
      lenZ: def.lenZ || Math.round(SEGMENT_LENGTH * 1.325),
      type: 'sport',
      primary: def.primary,
      secondary: def.secondary,
      segment: seg
    };

    if (seg) seg.cars.push(rival);
    state.cars.push(rival);
    state.rivals.push(rival);
  }
}

export function maintainTrafficDensity() {
  if (state.gameMode === 'circuit') return;

  const behindLimit = 85 * SEGMENT_LENGTH;
  const aheadLimit = (DRAW_DISTANCE + 170) * SEGMENT_LENGTH;

  for (let i = state.cars.length - 1; i >= 0; i--) {
    const car = state.cars[i];
    const dzFromPlayer = getShortestTrackDz(state.position, car.z, state.trackLength);
    if (dzFromPlayer < -behindLimit || dzFromPlayer > aheadLimit) {
      removeCarAt(i);
    }
  }

  const targetCount = Math.min(
    MAX_TRAFFIC_COUNT,
    INITIAL_TRAFFIC_COUNT + Math.floor(state.distanceMeters / METERS_PER_EXTRA_CAR)
  );

  let tries = 0;
  while (state.cars.length < targetCount && tries < 10) {
    tries++;
    const spawnZ = state.position + (DRAW_DISTANCE + 14 + Math.random() * 145) * SEGMENT_LENGTH;
    spawnSingleCar(spawnZ, true);
  }
}

function canChangeToLane(car, targetLaneIdx, lanes, playerWorldZ) {
  const targetLane = lanes[targetLaneIdx];
  if (!targetLane || targetLane.dir !== car.dir) return false;

  const targetX = targetLane.laneX * ROAD_WIDTH;
  const laneHalfMargin = ROAD_WIDTH * 0.26;
  const mergeDuration = 0.72;

  for (let j = 0; j < state.cars.length; j++) {
    const other = state.cars[j];
    if (other === car) continue;

    const inTargetNow = Math.abs(other.x - targetX) < laneHalfMargin;
    const movingIntoTarget = Math.abs(other.targetX - targetX) < laneHalfMargin;
    if (!inTargetNow && !movingIntoTarget) continue;

    const relDz = getShortestTrackDz(car.z, other.z, state.trackLength) * car.dir;

    if (relDz > -SEGMENT_LENGTH * 1.8 && relDz < SEGMENT_LENGTH * 2.3) {
      return false;
    }

    const otherForwardVel = other.dir === car.dir ? other.speed : -other.speed;
    const futureRelDz = relDz - (car.speed - otherForwardVel) * mergeDuration;
    const minDz = Math.min(relDz, futureRelDz);
    const maxDz = Math.max(relDz, futureRelDz);
    if (maxDz > -SEGMENT_LENGTH * 1.55 && minDz < SEGMENT_LENGTH * 1.95) {
      return false;
    }
  }

  const playerRelDz = getShortestTrackDz(car.z, playerWorldZ, state.trackLength) * car.dir;
  const playerForwardVel = car.dir === 1 ? Math.max(0, state.speed) : -Math.max(0, state.speed);
  const futurePlayerRelDz = playerRelDz - (car.speed - playerForwardVel) * 0.85;
  const minPlayerDz = Math.min(playerRelDz, futurePlayerRelDz);
  const maxPlayerDz = Math.max(playerRelDz, futurePlayerRelDz);
  if (
    Math.abs(state.playerX - targetLane.laneX) < 0.34 &&
    maxPlayerDz > -SEGMENT_LENGTH * 3.4 &&
    minPlayerDz < SEGMENT_LENGTH * 2.7
  ) {
    return false;
  }

  if (Math.abs(state.playerX - targetLane.laneX) < 0.38) {
    if (car.dir === 1 && playerRelDz < 0) {
      const closingSpeed = Math.max(0, state.speed) - car.speed;
      if (closingSpeed > 0 && Math.abs(playerRelDz) / closingSpeed < 1.35) {
        return false;
      }
    } else if (car.dir === -1 && playerRelDz > 0) {
      const closingSpeed = Math.max(0, state.speed) + car.speed;
      if (closingSpeed > 0 && playerRelDz / closingSpeed < 1.35) {
        return false;
      }
    }
  }

  return true;
}

function hasImmediateSideConflict(car, nextX, playerWorldZ) {
  const longitudinalBox = SEGMENT_LENGTH * 1.35;
  for (let j = 0; j < state.cars.length; j++) {
    const other = state.cars[j];
    if (other === car) continue;
    const dz = Math.abs(getShortestTrackDz(car.z, other.z, state.trackLength));
    if (dz < longitudinalBox) {
      const minLat = (car.w + other.w) * 0.52 * ROAD_WIDTH;
      if (Math.abs(nextX - other.x) < minLat) {
        return true;
      }
    }
  }

  const playerDz = Math.abs(getShortestTrackDz(car.z, playerWorldZ, state.trackLength));
  if (playerDz < longitudinalBox) {
    const minPlayerLat = (car.w + PLAYER_WIDTH_NORM) * 0.54 * ROAD_WIDTH;
    if (Math.abs(nextX - state.playerX * ROAD_WIDTH) < minPlayerLat) {
      return true;
    }
  }
  return false;
}

export function moveCarToSegment(car) {
  const oldSeg = car.segment;
  const newSeg = findSegment(car.z);
  if (newSeg && newSeg !== oldSeg) {
    if (oldSeg) {
      const idx = oldSeg.cars.indexOf(car);
      if (idx !== -1) oldSeg.cars.splice(idx, 1);
    }
    newSeg.cars.push(car);
    car.segment = newSeg;
  }
}

export function updateCircuitRivals(dt, isDemo = false) {
  const rivals = state.rivals;
  const segments = state.segments;
  const trackLength = state.trackLength;
  const playerWorldZ = getPlayerWorldZ();
  const isHardcoreCircuit = state.difficulty === 'hardcore';
  const diffSpeedMult = isDemo ? 0.76 : (isHardcoreCircuit ? 1.015 : 0.975);
  const mistakeChance = isHardcoreCircuit
    ? GAME_CONFIG.circuit.botMistakeChance * 0.75
    : GAME_CONFIG.circuit.botMistakeChance;

  for (let i = 0; i < rivals.length; i++) {
    const r = rivals[i];
    if (r.hitCooldown > 0) r.hitCooldown = Math.max(0, r.hitCooldown - dt);
    if (r.mistakeCooldown > 0) r.mistakeCooldown = Math.max(0, r.mistakeCooldown - dt);
    if (r.bumpCooldown > 0) r.bumpCooldown = Math.max(0, r.bumpCooldown - dt);

    let maxAheadCurve = 0;
    let signedAheadCurve = 0;
    if (r.segment) {
      for (let look = 1; look <= 24; look++) {
        const s = segments[(r.segment.index + look) % segments.length];
        const absC = Math.abs(s.curve);
        if (absC > maxAheadCurve) {
          maxAheadCurve = absC;
          signedAheadCurve = s.curve;
        }
      }
    }

    if (r.mistakeTimer > 0) {
      r.mistakeTimer = Math.max(0, r.mistakeTimer - dt);
      if (r.mistakeTimer === 0) {
        r.mistakeType = 'none';
        r.mistakeSeverity = 0;
      }
    } else if (maxAheadCurve > 4.6 && r.mistakeCooldown <= 0 && r.speed > MAX_SPEED * 0.62) {
      r.mistakeCooldown = 3.2 + Math.random() * 4.5;
      if (Math.random() < mistakeChance) {
        const roll = Math.random();
        if (roll < 0.45) {
          r.mistakeType = 'late_brake';
          r.mistakeSeverity = 0.65 + Math.random() * 0.35;
          r.mistakeTimer = 0.85 + Math.random() * 0.55;
        } else if (roll < 0.78) {
          r.mistakeType = 'wide_entry';
          r.mistakeSeverity = 0.60 + Math.random() * 0.40;
          r.mistakeTimer = 0.90 + Math.random() * 0.50;
        } else {
          r.mistakeType = 'early_apex';
          r.mistakeSeverity = 0.55 + Math.random() * 0.35;
          r.mistakeTimer = 0.75 + Math.random() * 0.45;
        }
      }
    }

    let paceBoost = r.finished ? 0.86 : 1.0;
    if (!isDemo && !r.finished) {
      const gapToPlayer = r.progressZ - state.playerProgressZ;
      if (gapToPlayer > 34 * SEGMENT_LENGTH) {
        paceBoost = isHardcoreCircuit ? 0.98 : 0.95;
      } else if (gapToPlayer < -24 * SEGMENT_LENGTH) {
        paceBoost = isHardcoreCircuit ? 1.03 : 1.01;
      }
    }

    const cornerBrakeSensitivity = isHardcoreCircuit ? 0.028 : 0.036;
    let cornerFactor = MathUtil.clamp(1.0 - Math.max(0, maxAheadCurve - 2.2) * cornerBrakeSensitivity, 0.54, 1.0);
    if (r.mistakeType === 'late_brake') {
      cornerFactor = Math.min(1.0, cornerFactor + 0.24 * r.mistakeSeverity);
    } else if (r.mistakeType === 'early_apex') {
      cornerFactor *= 0.88;
    }

    const rawTargetSpeed = MAX_SPEED * r.skill * diffSpeedMult * paceBoost * cornerFactor;
    const targetSpeed = Math.min(MAX_SPEED * 0.995, rawTargetSpeed);

    if (r.speed > targetSpeed + 80) {
      r.braking = true;
      r.speed = Math.max(targetSpeed, r.speed - MAX_SPEED * 0.72 * dt);
    } else {
      r.braking = false;
      r.speed = Math.min(targetSpeed, r.speed + ACCEL * (0.96 + r.skill * 0.08) * dt);
    }

    r.aiDecisionTimer -= dt;
    if (r.aiDecisionTimer <= 0) {
      r.aiDecisionTimer = 0.14 + Math.random() * 0.12;

      let desiredNormX = MathUtil.clamp(-signedAheadCurve * 0.068 + r.lineBias * 0.35, -0.70, 0.70);

      if (r.mistakeType === 'wide_entry' || r.mistakeType === 'late_brake') {
        const outsideDir = signedAheadCurve >= 0 ? -1 : 1;
        desiredNormX = MathUtil.clamp(outsideDir * (0.76 + 0.24 * r.mistakeSeverity), -0.96, 0.96);
      } else if (r.mistakeType === 'early_apex') {
        const insideDir = signedAheadCurve >= 0 ? 1 : -1;
        desiredNormX = MathUtil.clamp(insideDir * (0.82 + 0.22 * r.mistakeSeverity), -0.98, 0.98);
      }

      let blockerNormX = null;
      let closestBlockDist = SEGMENT_LENGTH * 6.4;

      for (let j = 0; j < rivals.length; j++) {
        if (i === j) continue;
        const other = rivals[j];
        const dz = getShortestTrackDz(r.z, other.z, trackLength);
        if (dz > 45 && dz < closestBlockDist) {
          const latDiff = Math.abs((r.x - other.x) / ROAD_WIDTH);
          if (latDiff < (r.w + other.w) * 0.68) {
            closestBlockDist = dz;
            blockerNormX = other.x / ROAD_WIDTH;
          }
        }
      }

      if (!isDemo) {
        const pDz = getShortestTrackDz(r.z, playerWorldZ, trackLength);
        if (pDz > 45 && pDz < closestBlockDist) {
          const latDiff = Math.abs((r.x / ROAD_WIDTH) - state.playerX);
          if (latDiff < (r.w + PLAYER_WIDTH_NORM) * 0.72) {
            closestBlockDist = pDz;
            blockerNormX = state.playerX;
          }
        }
      }

      if (blockerNormX !== null && r.mistakeType === 'none') {
        desiredNormX = blockerNormX > 0
          ? Math.max(-0.78, blockerNormX - 0.54)
          : Math.min(0.78, blockerNormX + 0.54);
      }

      r.targetX = desiredNormX * ROAD_WIDTH;
    }

    const steerDiff = r.targetX - r.x;
    const maxLatSpeed = ROAD_WIDTH * (r.mistakeType === 'late_brake' ? 0.74 : 1.04);
    const desiredLatVel = MathUtil.clamp(steerDiff * 3.4, -maxLatSpeed, maxLatSpeed);
    const steerResponsiveness = Math.min(1, dt * 7.8);
    r.latVel = MathUtil.lerp(r.latVel || 0, desiredLatVel, steerResponsiveness);
    r.x += r.latVel * dt;

    if (r.segment && r.mistakeType === 'late_brake') {
      const rSpeedRatio = r.speed / MAX_SPEED;
      r.x -= rSpeedRatio * rSpeedRatio * r.segment.curve * 0.32 * ROAD_WIDTH * dt;
    }

    if (Math.abs(r.vx) > 0.01) {
      r.x += r.vx * ROAD_WIDTH * dt;
      r.vx *= Math.pow(0.04, dt);
      if (Math.abs(r.vx) < 0.01) r.vx = 0;
    }

    const normRX = r.x / ROAD_WIDTH;
    if (state.gameMode === 'circuit' && state.difficulty === 'arcade' && r.segment) {
      const railEdge = 1.055;
      if (r.segment.guardrailLeft && normRX < -railEdge) {
        r.x = -railEdge * ROAD_WIDTH;
        r.latVel = Math.max(0, r.latVel);
        r.vx = Math.max(0.18, Math.abs(r.vx) * 0.5);
        r.speed *= 0.92;
      } else if (r.segment.guardrailRight && normRX > railEdge) {
        r.x = railEdge * ROAD_WIDTH;
        r.latVel = Math.min(0, r.latVel);
        r.vx = -Math.max(0.18, Math.abs(r.vx) * 0.5);
        r.speed *= 0.92;
      }
    }

    if (Math.abs(r.x / ROAD_WIDTH) > OFF_ROAD_THRESHOLD_X) {
      r.speed = Math.max(OFF_ROAD_LIMIT, r.speed - MAX_SPEED * 0.45 * dt);
    }

    r.x = MathUtil.clamp(r.x, -ROAD_WIDTH * 1.18, ROAD_WIDTH * 1.18);

    const forwardRefSpeed = Math.max(420, r.speed);
    const steerYaw = Math.atan2(r.latVel + r.vx * ROAD_WIDTH * 0.32, forwardRefSpeed) * 1.50;
    const cornerYaw = r.segment
      ? MathUtil.clamp(r.segment.curve * 0.019 * (r.speed / MAX_SPEED), -0.11, 0.11)
      : 0;
    const driftYaw = (r.mistakeType === 'late_brake' || r.mistakeType === 'wide_entry') && r.segment
      ? Math.sign(r.segment.curve) * 0.095 * r.mistakeSeverity
      : 0;
    const targetYaw = r.speed > 20
      ? MathUtil.clamp(steerYaw + cornerYaw + driftYaw, -0.36, 0.36)
      : 0;
    r.yaw = MathUtil.lerp(r.yaw || 0, targetYaw, Math.min(1, dt * 10.5));

    const dzMove = r.speed * dt;
    r.progressZ += dzMove;
    r.z = (((r.z + dzMove) % trackLength) + trackLength) % trackLength;
    moveCarToSegment(r);

    const rivalNormX = r.x / ROAD_WIDTH;
    if (
      !isDemo &&
      Math.abs(rivalNormX) <= OFF_ROAD_THRESHOLD_X &&
      r.speed > MAX_SPEED * 0.35 &&
      (r.braking || r.mistakeType === 'late_brake')
    ) {
      const rearZ = (((r.z - (r.lenZ || PLAYER_LEN_Z) * 0.42) % trackLength) + trackLength) % trackLength;
      recordSkidMarks(rearZ, rivalNormX, 0.44, Math.max(18, dzMove), r);
    } else {
      r.prevSkidSample = null;
    }

    if (!isDemo && !r.finished && r.progressZ >= state.circuitTotalLaps * trackLength) {
      r.finished = true;
      state.rivalsFinishedCount++;
      if (state.rivalsFinishedCount === 1) {
        state.raceFinishCountdown = GAME_CONFIG.circuit.finishGraceSec;
        showBanner(
          `${r.name} ФИНИШИРОВАЛ ПЕРВЫМ! У ВАС ${Math.round(state.raceFinishCountdown)} СЕК!`,
          '#ffbe0b',
          2.4
        );
      }
    }
  }

  // Взаимодействие между ботами
  const minGapZ = SEGMENT_LENGTH * 1.125;
  for (let i = 0; i < rivals.length; i++) {
    const a = rivals[i];
    for (let j = i + 1; j < rivals.length; j++) {
      const b = rivals[j];
      const dz = getShortestTrackDz(a.z, b.z, trackLength);
      if (Math.abs(dz) >= minGapZ) continue;
      const minLat = (a.w + b.w) * 0.54 * ROAD_WIDTH;
      const dx = a.x - b.x;
      if (Math.abs(dx) >= minLat) continue;

      if (
        !isDemo &&
        a.bumpCooldown <= 0 &&
        b.bumpCooldown <= 0 &&
        Math.random() < GAME_CONFIG.circuit.botBumpChance
      ) {
        a.bumpCooldown = 3.5 + Math.random() * 3.0;
        b.bumpCooldown = 3.5 + Math.random() * 3.0;

        const pushSign = dx >= 0 ? 1 : -1;
        a.vx += pushSign * 0.75;
        b.vx -= pushSign * 0.75;

        if (Math.abs(dz) >= SEGMENT_LENGTH * 0.675) {
          const leader = dz < 0 ? a : b;
          const trailer = dz < 0 ? b : a;
          trailer.speed *= 0.76;
          trailer.braking = true;
          leader.speed = Math.min(MAX_SPEED * 0.995, leader.speed * 1.02);
        } else {
          a.speed *= 0.86;
          b.speed *= 0.86;
        }

        const dzFromPlayer = getShortestTrackDz(playerWorldZ, a.z, trackLength);
        if (dzFromPlayer > 0 && dzFromPlayer < DRAW_DISTANCE * SEGMENT_LENGTH * 0.65 && a.segment) {
          const screenScale = a.segment.p1.screen.scale || 0;
          const screenX = a.segment.p1.screen.x + screenScale * a.x * PROJ_HALF_WIDTH;
          const screenY = a.segment.p1.screen.y - 12;
          if (screenScale > 0 && screenX > 0 && screenX < state.logicalWidth) {
            spawnParticles(screenX, screenY, 9, '#ffbe0b', 160, 100, [2, 4], [0.2, 0.4]);
            if (dzFromPlayer < 26 * SEGMENT_LENGTH) {
              audio.playCrash(0.42);
            }
          }
        }
      }

      if (Math.abs(dz) < SEGMENT_LENGTH * 0.75) {
        const push = (dx >= 0 ? 1 : -1) * (minLat - Math.abs(dx)) * 0.54;
        a.x = MathUtil.clamp(a.x + push, -ROAD_WIDTH * 1.12, ROAD_WIDTH * 1.12);
        b.x = MathUtil.clamp(b.x - push, -ROAD_WIDTH * 1.12, ROAD_WIDTH * 1.12);
      } else {
        const leader = dz < 0 ? a : b;
        const trailer = dz < 0 ? b : a;
        trailer.speed = Math.min(trailer.speed, leader.speed * 0.94);
      }
    }
  }
}

export function updateTrafficOnly(dt, checkPlayerObstacle = false) {
  if (state.gameMode === 'circuit') {
    updateCircuitRivals(dt, !checkPlayerObstacle);
    return;
  }

  const cars = state.cars;
  const trackLength = state.trackLength;
  const playerWorldZ = getPlayerWorldZ();
  const lanes = getLaneConfigs();

  for (let i = 0; i < cars.length; i++) {
    const car = cars[i];
    if (car.hitCooldown > 0) car.hitCooldown = Math.max(0, car.hitCooldown - dt);
    if (car.brakeHoldTimer > 0) car.brakeHoldTimer = Math.max(0, car.brakeHoldTimer - dt);
    if (car.highBeamFlashTimer > 0) car.highBeamFlashTimer = Math.max(0, car.highBeamFlashTimer - dt);
    if (car.hornCooldown > 0) car.hornCooldown = Math.max(0, car.hornCooldown - dt);

    if (car.damagedByPlayer) {
      car.turnSignal = 0;
      car.signalPreDelay = 0;
      car.signalHoldAfter = 0;
      car.laneChangeTimer = 0;
      car.highBeamFlashTimer = 0;
      car.targetX = car.x;
      car.latVel = MathUtil.lerp(car.latVel || 0, 0, Math.min(1, dt * 8));
      car.yaw = MathUtil.lerp(car.yaw || 0, 0, Math.min(1, dt * 6));
      car.braking = true;
      if (car.speed > 0) {
        car.speed = Math.max(0, car.speed - car.brakeForce * dt);
        if (car.speed > 0) {
          car.z = (car.z + car.dir * car.speed * dt + trackLength) % trackLength;
          moveCarToSegment(car);
        }
      }
      continue;
    }

    if (car.laneCooldown > 0) {
      car.laneCooldown = Math.max(0, car.laneCooldown - dt);
    }

    if (car.turnSignal !== 0) {
      car.signalElapsed += dt;
    } else {
      car.signalElapsed = 0;
    }

    const isChangingLane = Math.abs(car.x - car.targetX) > 2.5;

    if (isChangingLane) {
      car.laneChangeTimer += dt;
      if (car.laneChangeTimer > 2.1) {
        const fallbackLane = lanes[car.prevLaneIndex] || lanes[car.laneIndex];
        if (fallbackLane) {
          car.laneIndex = car.prevLaneIndex;
          car.targetX = fallbackLane.laneX * ROAD_WIDTH;
        }
        car.signalPreDelay = 0;
        car.signalHoldAfter = 0;
        car.turnSignal = 0;
        car.laneChangeTimer = 0;
        car.laneCooldown = 0.6;
      }
    } else {
      car.laneChangeTimer = 0;
    }

    if (car.signalPreDelay > 0 && isChangingLane) {
      car.signalPreDelay = Math.max(0, car.signalPreDelay - dt);
      car.latVel = MathUtil.lerp(car.latVel || 0, 0, Math.min(1, dt * 10));
      if (hasImmediateSideConflict(car, (car.x + car.targetX) * 0.5, playerWorldZ)) {
        const fallbackLane = lanes[car.prevLaneIndex];
        if (fallbackLane) {
          car.laneIndex = car.prevLaneIndex;
          car.targetX = fallbackLane.laneX * ROAD_WIDTH;
        }
        car.signalPreDelay = 0;
        car.turnSignal = 0;
        car.laneChangeTimer = 0;
        car.laneCooldown = 0.45;
      }
    } else if (isChangingLane) {
      const diff = car.targetX - car.x;
      const maxLaneChangeSpeed = ROAD_WIDTH * 0.74;
      const desiredLatVel = MathUtil.clamp(diff * 3.1, -maxLaneChangeSpeed, maxLaneChangeSpeed);
      car.latVel = MathUtil.lerp(car.latVel || 0, desiredLatVel, Math.min(1, dt * 6.5));
      const candidateX = car.x + car.latVel * dt;

      const prevLane = lanes[car.prevLaneIndex];
      const totalSpan = prevLane ? Math.abs(car.targetX - prevLane.laneX * ROAD_WIDTH) : ROAD_WIDTH * 0.5;
      const movedSpan = prevLane ? Math.abs(car.x - prevLane.laneX * ROAD_WIDTH) : totalSpan;
      const progressRatio = totalSpan > 1 ? (movedSpan / totalSpan) : 1;

      if (progressRatio < 0.85 && hasImmediateSideConflict(car, candidateX, playerWorldZ)) {
        if (prevLane) {
          car.laneIndex = car.prevLaneIndex;
          car.targetX = prevLane.laneX * ROAD_WIDTH;
        }
        car.turnSignal = 0;
        car.laneChangeTimer = 0;
        car.laneCooldown = 0.5;
      } else {
        car.x = candidateX;
        if (Math.abs(car.x - car.targetX) <= 3.0 && Math.abs(car.latVel) < 42) {
          car.x = car.targetX;
          car.latVel = 0;
          car.prevLaneIndex = car.laneIndex;
          car.laneChangeTimer = 0;
          car.signalHoldAfter = 0.24;
        }
      }
    } else {
      car.x = MathUtil.lerp(car.x, car.targetX, Math.min(1, dt * 14));
      if (Math.abs(car.x - car.targetX) < 0.5) car.x = car.targetX;
      car.latVel = MathUtil.lerp(car.latVel || 0, 0, Math.min(1, dt * 12));
      if (car.signalHoldAfter > 0) {
        car.signalHoldAfter = Math.max(0, car.signalHoldAfter - dt);
        if (car.signalHoldAfter <= 0) {
          car.turnSignal = 0;
        }
      } else {
        car.turnSignal = 0;
      }
    }

    const forwardRefSpeed = Math.max(380, car.speed);
    const laneChangeYaw = Math.atan2(car.latVel || 0, forwardRefSpeed) * car.dir * 1.48;
    const roadCurveYaw = car.segment
      ? MathUtil.clamp(car.segment.curve * 0.015 * (car.speed / MAX_SPEED), -0.09, 0.09) * car.dir
      : 0;
    const targetYaw = car.speed > 15
      ? MathUtil.clamp(laneChangeYaw + roadCurveYaw, -0.34, 0.34)
      : 0;
    car.yaw = MathUtil.lerp(car.yaw || 0, targetYaw, Math.min(1, dt * 10.5));

    let closestGap = Infinity;
    let obstacleSpeed = 0;
    let blockedByOncomingPlayer = false;

    for (let j = 0; j < cars.length; j++) {
      const other = cars[j];
      if (other === car) continue;
      const forwardDist = getShortestTrackDz(car.z, other.z, trackLength) * car.dir;
      if (forwardDist > 10 && forwardDist < TRAFFIC_SCAN_DIST_Z) {
        const minLatNorm = (car.w + other.w) * 0.60;
        const dCurrCurr = Math.abs((car.x - other.x) / ROAD_WIDTH);
        const dTargCurr = Math.abs((car.targetX - other.x) / ROAD_WIDTH);
        const dCurrTarg = Math.abs((car.x - other.targetX) / ROAD_WIDTH);
        const dTargTarg = Math.abs((car.targetX - other.targetX) / ROAD_WIDTH);
        const effectiveLat = Math.min(dCurrCurr, dTargCurr, dCurrTarg, dTargTarg);

        if (effectiveLat < minLatNorm && forwardDist < closestGap) {
          closestGap = forwardDist;
          obstacleSpeed = other.dir === car.dir ? other.speed : 0;
        }
      }
    }

    if (checkPlayerObstacle) {
      const playerForwardDist = getShortestTrackDz(car.z, playerWorldZ, trackLength) * car.dir;
      const oncomingDetectRange = car.dir === -1 ? ONCOMING_DETECT_DIST_Z : TRAFFIC_SCAN_DIST_Z;
      if (playerForwardDist > 10 && playerForwardDist < oncomingDetectRange) {
        const minPlayerLat = (car.w + PLAYER_WIDTH_NORM) * 0.65;
        const latCurr = Math.abs((car.x / ROAD_WIDTH) - state.playerX);
        const latTarg = Math.abs((car.targetX / ROAD_WIDTH) - state.playerX);
        if (Math.min(latCurr, latTarg) < minPlayerLat) {
          if (playerForwardDist < TRAFFIC_SCAN_DIST_Z && playerForwardDist < closestGap) {
            closestGap = playerForwardDist;
            obstacleSpeed = car.dir === 1 ? Math.max(0, state.speed) : 0;
            if (car.dir === -1) {
              blockedByOncomingPlayer = true;
            }
          }
          if (car.dir === -1 && state.gameState === STATE.PLAYING) {
            car.highBeamFlashTimer = Math.max(car.highBeamFlashTimer, 0.45);
            if (car.hornCooldown <= 0 && playerForwardDist < ONCOMING_HORN_DIST_Z) {
              car.hornCooldown = 2.6 + Math.random() * 1.2;
              audio.playOncomingHorn(car.type);
            }
          }
        }
      }
    }

    const caughtSlowTraffic =
      closestGap < TRAFFIC_SCAN_DIST_Z &&
      car.baseSpeed > obstacleSpeed * 1.03;

    if (caughtSlowTraffic && !blockedByOncomingPlayer && car.laneCooldown <= 0 && !isChangingLane) {
      const neighborIndices = [car.laneIndex - 1, car.laneIndex + 1];
      let startedLaneChange = false;

      for (let k = 0; k < neighborIndices.length; k++) {
        const candIdx = neighborIndices[k];
        if (canChangeToLane(car, candIdx, lanes, playerWorldZ)) {
          const newTargetX = lanes[candIdx].laneX * ROAD_WIDTH;
          car.prevLaneIndex = car.laneIndex;
          car.laneIndex = candIdx;
          car.targetX = newTargetX;
          car.turnSignal = Math.sign(newTargetX - car.x);
          car.signalPreDelay = 0.20;
          car.signalElapsed = 0;
          car.laneChangeTimer = 0;
          car.laneCooldown = 1.1 + Math.random() * 0.7;
          startedLaneChange = true;
          break;
        }
      }

      if (!startedLaneChange) {
        car.laneCooldown = 0.32 + Math.random() * 0.30;
      }
    }

    if (closestGap < TRAFFIC_SCAN_DIST_Z) {
      const clearGap = closestGap - SAFE_BUMPER_GAP_Z;
      if (clearGap <= 0) {
        car.braking = true;
        car.brakeHoldTimer = 0.22;
        car.speed = Math.min(car.speed, obstacleSpeed);
        if (obstacleSpeed <= 5) car.speed = 0;
      } else {
        const desiredSpeed = obstacleSpeed + clearGap * 1.45;
        if (car.speed > desiredSpeed + 45) {
          car.braking = true;
          car.brakeHoldTimer = 0.22;
          const decelRate = MAX_SPEED * (clearGap < 340 ? 1.25 : 0.75);
          car.speed = Math.max(obstacleSpeed, car.speed - decelRate * dt);
          if (obstacleSpeed <= 5 && clearGap < 45) {
            car.speed = Math.max(0, car.speed - MAX_SPEED * 1.4 * dt);
          }
        } else if (car.speed > desiredSpeed && car.brakeHoldTimer > 0) {
          car.braking = true;
          const decelRate = MAX_SPEED * 0.45;
          car.speed = Math.max(obstacleSpeed, car.speed - decelRate * dt);
        } else {
          if (car.brakeHoldTimer <= 0) {
            car.braking = false;
          }
          car.speed = Math.min(car.baseSpeed, desiredSpeed, car.speed + MAX_SPEED * 0.34 * dt);
        }
      }
    } else {
      if (car.brakeHoldTimer <= 0) {
        car.braking = false;
      }
      if (car.speed < car.baseSpeed) {
        car.speed = Math.min(car.baseSpeed, car.speed + MAX_SPEED * 0.34 * dt);
      }
    }

    if (car.speed > 0) {
      car.z = (car.z + car.dir * car.speed * dt + trackLength) % trackLength;
      moveCarToSegment(car);
    }
  }

  // Пост-проход непересечения между машинами трафика
  const minLongitudinalGap = SEGMENT_LENGTH * 1.425;
  for (let i = 0; i < cars.length; i++) {
    const a = cars[i];
    const aChanging = Math.abs(a.x - a.targetX) > 3;
    for (let j = i + 1; j < cars.length; j++) {
      const b = cars[j];
      const bChanging = Math.abs(b.x - b.targetX) > 3;
      const dz = getShortestTrackDz(a.z, b.z, trackLength);
      const absDz = Math.abs(dz);
      if (absDz >= minLongitudinalGap) continue;

      const minLat = (a.w + b.w) * 0.54 * ROAD_WIDTH;
      const dx = a.x - b.x;
      const absDx = Math.abs(dx);
      if (absDx >= minLat) continue;

      const latOverlap = minLat - absDx;
      const longOverlap = minLongitudinalGap - absDz;

      if (!aChanging && !bChanging && absDz < SEGMENT_LENGTH * 0.9 && latOverlap <= longOverlap * 0.7) {
        const pushSign = dx >= 0 ? 1 : -1;
        const halfPush = latOverlap * 0.52;
        if (!a.damagedByPlayer) {
          a.x = MathUtil.clamp(a.x + pushSign * halfPush, -ROAD_WIDTH * 0.82, ROAD_WIDTH * 0.82);
        }
        if (!b.damagedByPlayer) {
          b.x = MathUtil.clamp(b.x - pushSign * halfPush, -ROAD_WIDTH * 0.82, ROAD_WIDTH * 0.82);
        }
      } else if (a.dir === b.dir) {
        const aIsAhead = dz * a.dir < 0;
        const leader = aIsAhead ? a : b;
        const trailer = aIsAhead ? b : a;
        if (!trailer.damagedByPlayer) {
          trailer.z = (leader.z - leader.dir * minLongitudinalGap + trackLength) % trackLength;
          trailer.speed = Math.min(trailer.speed, leader.speed);
          trailer.braking = true;
          moveCarToSegment(trailer);
        }
      } else if (a.damagedByPlayer || b.damagedByPlayer) {
        const activeCar = a.damagedByPlayer ? b : a;
        const wreckedCar = a.damagedByPlayer ? a : b;
        const pushSign = activeCar.x >= wreckedCar.x ? 1 : -1;
        activeCar.x = MathUtil.clamp(
          activeCar.x + pushSign * latOverlap * 0.65,
          -ROAD_WIDTH * 0.88,
          ROAD_WIDTH * 0.88
        );
      }
    }
  }
}