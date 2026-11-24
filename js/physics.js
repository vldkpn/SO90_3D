import {
  GAME_CONFIG,
  STATE,
  ROAD_WIDTH,
  SEGMENT_LENGTH,
  BASE_FOV,
  PLAYER_Z,
  PLAYER_CENTER_OFFSET_Z,
  PLAYER_LEN_Z,
  PLAYER_WIDTH_NORM,
  REAR_TIRE_CAM_Z,
  BASE_MAX_KMH,
  MAX_SPEED,
  MAX_REVERSE_SPEED,
  ACCEL,
  REVERSE_ACCEL,
  BRAKE_HIGH_SPEED,
  BRAKE_LOW_SPEED,
  DECEL,
  OFF_ROAD_DECEL,
  OFF_ROAD_LIMIT,
  CENTRIFUGAL_FORCE,
  STEER_SENSITIVITY,
  REVERSE_STEER_SENSITIVITY,
  PLAYER_MAX_LATERAL_X,
  OFF_ROAD_THRESHOLD_X,
  COLLISION_TIME_PENALTY,
  MAX_HARDCORE_COLLISIONS
} from './config.js';
import { MathUtil, formatRaceTime, getShortestTrackDz } from './utils.js';
import { audio } from './audio.js';
import {
  state,
  findSegment,
  getPlayerWorldZ,
  getCurrentMaxAllowedKmh,
  showBanner,
  spawnParticles
} from './state.js';
import { recordSkidMarks } from './track.js';
import { maintainTrafficDensity, updateTrafficOnly } from './traffic.js';

function updateParticles(dt) {
  const particles = state.particles;
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) {
      particles.splice(i, 1);
      continue;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += p.gravity * dt;
    if (p.expandRate !== 0) {
      p.size = Math.max(1, p.size + p.expandRate * dt);
    }
  }
}

function triggerGameOver(reasonTitle) {
  if (typeof state.onGameOver === 'function') {
    state.onGameOver(reasonTitle);
  }
}

function applyCollisionTimePenalty(seconds = COLLISION_TIME_PENALTY) {
  state.timeLeft = Math.max(0, state.timeLeft - seconds);
  state.timePenaltyFlash = 0.95;
  if (state.timeLeft <= 0) {
    state.timeLeft = 0;
    triggerGameOver('ВРЕМЯ ВЫШЛО!');
    return true;
  }
  return false;
}

function registerCollision(damagePoints = 1, fatalReason = 'МАШИНА РАЗБИТА!', hitContext = {}) {
  if (state.gameMode === 'circuit') {
    return false;
  }

  const dmg = Math.max(1, damagePoints);
  const penaltySec = Math.round(COLLISION_TIME_PENALTY);

  const side = hitContext.side || 'center';
  const zone = hitContext.zone || 'front';
  const sideDelta = Math.max(1, Math.min(2, dmg));

  if (side === 'left') {
    state.leftDamage = Math.min(3, state.leftDamage + sideDelta);
  } else if (side === 'right') {
    state.rightDamage = Math.min(3, state.rightDamage + sideDelta);
  } else {
    if (state.leftDamage <= state.rightDamage) {
      state.leftDamage = Math.min(3, state.leftDamage + 1);
    } else {
      state.rightDamage = Math.min(3, state.rightDamage + 1);
    }
    if (dmg >= 2) {
      state.leftDamage = Math.min(3, state.leftDamage + 1);
      state.rightDamage = Math.min(3, state.rightDamage + 1);
    }
  }

  if (zone === 'rear') {
    state.rearDamage = Math.min(3, state.rearDamage + sideDelta);
  } else if (zone === 'front') {
    state.frontDamage = Math.min(3, state.frontDamage + sideDelta);
    if (dmg >= 2) {
      state.rearDamage = Math.min(3, state.rearDamage + 1);
    }
  } else {
    state.rearDamage = Math.min(3, state.rearDamage + 1);
  }

  state.collisionCount += dmg;
  const cappedKmh = getCurrentMaxAllowedKmh();
  const cappedSpeed = MAX_SPEED * (cappedKmh / BASE_MAX_KMH);
  if (state.speed > cappedSpeed) {
    state.speed = cappedSpeed;
  }

  if (state.difficulty !== 'hardcore') {
    state.visualDamage = Math.min(4, Math.max(state.visualDamage, Math.ceil(state.collisionCount * 0.85)));
    if (applyCollisionTimePenalty(COLLISION_TIME_PENALTY)) return true;
    const engineWarn = state.visualDamage >= 3 ? ' • ДВИГАТЕЛЬ ПОВРЕЖДЁН!' : '';
    showBanner(
      `УДАР! -${penaltySec} СЕК • МАКС: ${cappedKmh} КМ/Ч${engineWarn}`,
      '#ff2a85',
      1.9
    );
    return false;
  }

  state.collisionsLeft = Math.max(0, state.collisionsLeft - dmg);
  state.visualDamage = MAX_HARDCORE_COLLISIONS - state.collisionsLeft;
  if (state.collisionsLeft <= 0) {
    state.leftDamage = 3;
    state.rightDamage = 3;
    state.rearDamage = 3;
    state.frontDamage = 3;
    state.timeLeft = Math.max(0, state.timeLeft - COLLISION_TIME_PENALTY);
    triggerGameOver(fatalReason);
    return true;
  }

  if (applyCollisionTimePenalty(COLLISION_TIME_PENALTY)) return true;
  showBanner(
    `УДАР! -${penaltySec} СЕК • МАКС: ${cappedKmh} • ПРОЧН.: ${state.collisionsLeft}/${MAX_HARDCORE_COLLISIONS}`,
    '#ff2a85',
    1.9
  );
  return false;
}

export function computeCircuitRank() {
  let rank = 1;
  for (let i = 0; i < state.rivals.length; i++) {
    if (state.rivals[i].progressZ > state.playerProgressZ) {
      rank++;
    }
  }
  state.playerRank = rank;
}

function updateCameraDynamics(dt, currentSeg) {
  const forwardRatio = MathUtil.clamp(state.speed / MAX_SPEED, 0, 1.05);

  const targetFov = (BASE_FOV - 4) + forwardRatio * 16;
  state.currentFov = MathUtil.lerp(state.currentFov, targetFov, Math.min(1, dt * 5.5));
  state.activeCameraDepth = 1 / Math.tan((state.currentFov / 2) * Math.PI / 180);

  const roadSlope = currentSeg
    ? (currentSeg.p2.world.y - currentSeg.p1.world.y) / SEGMENT_LENGTH
    : 0;
  const targetPitch = MathUtil.clamp(roadSlope * 185, -46, 46);
  state.cameraPitch = MathUtil.lerp(state.cameraPitch, targetPitch, Math.min(1, dt * 6.5));

  const targetLagX = state.gameState === STATE.PLAYING ? state.steerVisual * 0.085 : 0;
  state.cameraLagX = MathUtil.lerp(state.cameraLagX, targetLagX, Math.min(1, dt * 8.0));

  const targetRoll = (state.gameState === STATE.PLAYING && currentSeg)
    ? MathUtil.clamp(-currentSeg.curve * forwardRatio * 0.0042, -0.022, 0.022)
    : 0;
  state.cameraRoll = MathUtil.lerp(state.cameraRoll, targetRoll, Math.min(1, dt * 6.0));
}

export function updateSimulation(dt) {
  if (state.gameState === STATE.PLAYING && state.isPaused) {
    audio.update(0, false, false, false);
    return;
  }

  state.animClockMs += dt * 1000;

  if (state.bannerTimer > 0) state.bannerTimer = Math.max(0, state.bannerTimer - dt);
  if (state.spriteHitCooldown > 0) state.spriteHitCooldown = Math.max(0, state.spriteHitCooldown - dt);
  if (state.guardrailSoundCooldown > 0) state.guardrailSoundCooldown = Math.max(0, state.guardrailSoundCooldown - dt);
  if (state.offRoadWarnCooldown > 0) state.offRoadWarnCooldown = Math.max(0, state.offRoadWarnCooldown - dt);
  if (state.heatWarnCooldown > 0) state.heatWarnCooldown = Math.max(0, state.heatWarnCooldown - dt);
  if (state.impactShake > 0) state.impactShake = Math.max(0, state.impactShake - dt * 3.8);
  if (state.timePenaltyFlash > 0) state.timePenaltyFlash = Math.max(0, state.timePenaltyFlash - dt * 1.4);

  updateParticles(dt);

  const anchors = state.playerScreenAnchors;
  const input = state.input;
  const segments = state.segments;
  const trackLength = state.trackLength;

  // Демонстрационный автопилот на стартовом экране (или сцена аварии при поломке)
  if (state.gameState !== STATE.PLAYING) {
    if (state.gameState === STATE.GAMEOVER && state.gameMode !== 'circuit' && state.visualDamage >= MAX_HARDCORE_COLLISIONS) {
      if (Math.random() < 0.78) {
        spawnParticles(
          anchors.centerX + (Math.random() - 0.5) * anchors.carW * 0.35,
          anchors.hoodY,
          2,
          Math.random() < 0.7 ? 'rgba(32, 30, 40, 0.85)' : 'rgba(95, 90, 108, 0.75)',
          70,
          115,
          [7, 16],
          [0.6, 1.3],
          -25,
          12
        );
      }
      if (Math.random() < 0.28) {
        spawnParticles(
          anchors.centerX + (Math.random() - 0.5) * anchors.carW * 0.30,
          anchors.centerY,
          2,
          '#ffbe0b',
          135,
          95,
          [2, 4],
          [0.2, 0.45]
        );
      }
      updateTrafficOnly(dt, true);
      updateCameraDynamics(dt, findSegment(state.position + PLAYER_Z + PLAYER_CENTER_OFFSET_Z));
      audio.update(0, false, false, false);
      return;
    }

    state.position = (state.position + MAX_SPEED * 0.26 * dt) % trackLength;
    const demoSeg = findSegment(state.position + PLAYER_Z + PLAYER_CENTER_OFFSET_Z);
    if (demoSeg) {
      state.skyOffset = (state.skyOffset + demoSeg.curve * 0.0018) % 1;
      state.hillOffset = (state.hillOffset + demoSeg.curve * 0.0045) % 1;
      state.cityOffset = (state.cityOffset + demoSeg.curve * 0.0085) % 1;
    }
    maintainTrafficDensity();
    updateTrafficOnly(dt, false);
    updateCameraDynamics(dt, demoSeg);
    audio.update(0, false, false, false);
    return;
  }

  // Предстартовый отсчет на решетке в кольцевом заезде
  if (state.gameMode === 'circuit' && state.raceCountdownTimer > 0) {
    state.raceCountdownTimer = Math.max(0, state.raceCountdownTimer - dt);
    const digit = Math.ceil((state.raceCountdownTimer / GAME_CONFIG.circuit.countdownSec) * 3);
    if (digit > 0 && digit !== state.lastCountdownDigit) {
      state.lastCountdownDigit = digit;
      audio.playTone(440, 0.10, 'square', 0.12);
    }
    if (state.raceCountdownTimer === 0) {
      audio.playTone(880, 0.24, 'square', 0.16);
      showBanner('СТАРТ! ВПЕРЁД!', '#39ff14', 1.4);
    }
    updateCameraDynamics(dt, findSegment(state.position + PLAYER_Z + PLAYER_CENTER_OFFSET_Z));
    audio.update(input.up ? 0.55 : 0.08, false, false, true, true);
    return;
  }

  // 1. Таймер обратного отсчета или секундомер круга
  if (state.gameMode === 'circuit') {
    state.raceElapsedTime += dt;
    if (state.raceFinishCountdown > 0) {
      state.raceFinishCountdown = Math.max(0, state.raceFinishCountdown - dt);
      if (state.raceFinishCountdown === 0) {
        computeCircuitRank();
        triggerGameOver(`ГОНКА ЗАВЕРШЕНА • ${state.playerRank}-Е МЕСТО`);
        return;
      }
    }
  } else {
    state.timeLeft -= dt;
    if (state.timeLeft <= 0) {
      state.timeLeft = 0;
      triggerGameOver('ВРЕМЯ ВЫШЛО!');
      return;
    }
  }

  const currentSeg = findSegment(state.position + PLAYER_Z + PLAYER_CENTER_OFFSET_Z);
  const forwardSpeedRatio = Math.max(0, state.speed) / MAX_SPEED;
  const absSpeedRatio = Math.abs(state.speed) / MAX_SPEED;
  const isOffRoad = Math.abs(state.playerX) > OFF_ROAD_THRESHOLD_X;
  const playerWorldZBeforeMove = getPlayerWorldZ();

  // Проверка слипстрима за соперником
  state.isSlipstreaming = false;
  if (state.gameMode === 'circuit' && !isOffRoad && state.speed > MAX_SPEED * 0.55) {
    for (let i = 0; i < state.rivals.length; i++) {
      const r = state.rivals[i];
      const dz = getShortestTrackDz(playerWorldZBeforeMove, r.z, trackLength);
      if (dz > SEGMENT_LENGTH * 0.85 && dz < SEGMENT_LENGTH * 4.75 && Math.abs(state.playerX - r.x / ROAD_WIDTH) < 0.25) {
        state.isSlipstreaming = true;
        break;
      }
    }
  }

  const damageMaxKmh = getCurrentMaxAllowedKmh();
  const slipstreamMult = state.isSlipstreaming ? GAME_CONFIG.circuit.slipstreamBoostRatio : 1.0;
  const damageMaxSpeed = MAX_SPEED * (damageMaxKmh / BASE_MAX_KMH) * slipstreamMult;

  const damageRatio = state.gameMode !== 'circuit'
    ? MathUtil.clamp(state.visualDamage / MAX_HARDCORE_COLLISIONS, 0, 1)
    : 0;

  if (state.gameMode !== 'circuit' && state.visualDamage > 0) {
    const showDamageSmoke = state.difficulty === 'hardcore' || state.visualDamage >= 3;
    if (showDamageSmoke) {
      const smokeChance = [0, 0.14, 0.26, 0.44, 0.66, 0.85][Math.min(5, state.visualDamage)];
      if (Math.random() < smokeChance) {
        const isHeavy = state.visualDamage >= 3;
        const smokeColor = isHeavy
          ? (Math.random() < 0.68 ? 'rgba(34, 31, 44, 0.80)' : 'rgba(92, 88, 106, 0.70)')
          : 'rgba(180, 180, 196, 0.52)';
        spawnParticles(
          anchors.centerX + (Math.random() - 0.5) * anchors.carW * 0.28,
          anchors.hoodY,
          state.visualDamage >= 4 ? 2 : 1,
          smokeColor,
          55 + absSpeedRatio * 40,
          75 + (1 - absSpeedRatio) * 40,
          [4 + state.visualDamage, 9 + state.visualDamage * 1.5],
          [0.45, 0.95],
          -20,
          8
        );
      }
    }
  }

  // Троение и прострелы сильно повреждённого двигателя
  if (state.gameMode !== 'circuit' && state.visualDamage >= 3 && state.speed > MAX_SPEED * 0.14) {
    const heavyEngineDmg = MathUtil.clamp((state.visualDamage - 2) / 3, 0, 1);
    if (state.engineMisfireTimer > 0) {
      state.engineMisfireTimer = Math.max(0, state.engineMisfireTimer - dt);
    } else {
      state.engineMisfireCooldown -= dt;
      if (state.engineMisfireCooldown <= 0) {
        state.engineMisfireTimer = 0.09 + Math.random() * 0.09;
        state.engineMisfireCooldown = MathUtil.lerp(1.45, 0.32, heavyEngineDmg) * (0.65 + Math.random() * 0.7);
        if (state.visualDamage >= 4 && input.up && !input.down && Math.random() < 0.55) {
          audio.playBackfire();
          const pipeX = Math.random() < 0.5 ? anchors.exhaustLeftX : anchors.exhaustRightX;
          spawnParticles(pipeX, anchors.exhaustY, 3, '#ff7b00', 65, 45, [3, 6], [0.14, 0.28], 20);
        }
      }
    }
  } else {
    state.engineMisfireTimer = 0;
  }
  const isEngineMisfiring = state.engineMisfireTimer > 0;

  // 2. Система перегрева двигателя в режиме «Нормально»
  if (state.difficulty === 'hardcore') {
    const throttleLoadRatio = damageMaxSpeed > 0 ? Math.max(0, state.speed) / damageMaxSpeed : 0;
    if (input.up && !input.down && throttleLoadRatio > 0.90 && !state.isOverheated) {
      state.engineHeat = Math.min(100, state.engineHeat + dt * GAME_CONFIG.gameplay.engineHeatRate);
      if (state.engineHeat >= 92 && state.heatWarnCooldown <= 0) {
        state.heatWarnCooldown = 2.0;
        showBanner('ВНИМАНИЕ! ПЕРЕГРЕВ МОТОРА!', '#ffbe0b', 1.3);
      }
      if (state.engineHeat >= 100) {
        state.isOverheated = true;
        audio.playOverheat();
        showBanner('ПЕРЕГРЕВ! МОЩНОСТЬ СНИЖЕНА!', '#ff2a85', 2.4);
      }
    } else {
      const coolRate = state.isOverheated
        ? GAME_CONFIG.gameplay.engineOverheatCoolRate
        : GAME_CONFIG.gameplay.engineCoolRate;
      state.engineHeat = Math.max(0, state.engineHeat - dt * coolRate);
      if (state.isOverheated && state.engineHeat <= GAME_CONFIG.gameplay.engineOverheatRecoverPct) {
        state.isOverheated = false;
        showBanner('МОТОР ОСТЫЛ — ПОЛНАЯ МОЩНОСТЬ!', '#00f0ff', 1.6);
      }
    }
  }

  const effectiveMaxSpeed = state.isOverheated
    ? Math.min(damageMaxSpeed, MAX_SPEED * GAME_CONFIG.gameplay.overheatSpeedCapRatio)
    : damageMaxSpeed;

  // 3. Разгон, торможение, задний ход и накат
  if (input.up && input.down) {
    if (state.speed > 0) {
      const brakeDecel = MathUtil.lerp(BRAKE_LOW_SPEED, BRAKE_HIGH_SPEED, forwardSpeedRatio);
      state.speed = Math.max(0, state.speed + brakeDecel * dt);
    } else if (state.speed < 0) {
      state.speed = Math.min(0, state.speed + MAX_SPEED * 0.45 * dt);
    }
  } else if (input.up) {
    if (state.speed < 0) {
      state.speed = Math.min(0, state.speed + MAX_SPEED * 0.45 * dt);
    } else {
      const misfireMult = isEngineMisfiring ? 0.22 : 1.0;
      const accelMult = (state.isOverheated ? 0.55 : (state.isSlipstreaming ? 1.06 : 1.0)) * misfireMult;
      state.speed += ACCEL * accelMult * dt;
      if (isEngineMisfiring && state.speed > MAX_SPEED * 0.35) {
        state.speed -= ACCEL * 0.34 * dt;
      }
    }
  } else if (input.down) {
    if (state.speed > 0) {
      const brakeDecel = MathUtil.lerp(BRAKE_LOW_SPEED, BRAKE_HIGH_SPEED, forwardSpeedRatio);
      state.speed = Math.max(0, state.speed + brakeDecel * dt);
    } else {
      state.speed -= REVERSE_ACCEL * dt;
    }
  } else {
    if (state.speed > 0) {
      state.speed = Math.max(0, state.speed + DECEL * dt);
    } else if (state.speed < 0) {
      state.speed = Math.min(0, state.speed - DECEL * 1.15 * dt);
    }
  }

  if (isOffRoad) {
    const isCornerCut =
      state.gameMode === 'circuit' &&
      currentSeg &&
      Math.abs(currentSeg.curve) > 3.5 &&
      Math.abs(state.playerX) > 1.48 &&
      Math.sign(state.playerX) === Math.sign(currentSeg.curve);
    const isDeepCornerCut = state.gameMode === 'circuit' && Math.abs(state.playerX) > 1.38;
    const activeOffRoadLimit = isCornerCut
      ? OFF_ROAD_LIMIT * 0.36
      : (isDeepCornerCut ? OFF_ROAD_LIMIT * 0.62 : OFF_ROAD_LIMIT);

    if ((isCornerCut || isDeepCornerCut) && state.speed > activeOffRoadLimit * 1.1 && state.offRoadWarnCooldown <= 0) {
      state.offRoadWarnCooldown = 1.6;
      showBanner(isCornerCut ? 'СРЕЗКА ПОВОРОТА! СБРОС СКОРОСТИ!' : 'ВОЗВРАТ НА ТРАССУ!', '#ffbe0b', 1.2);
    }
    if (state.speed > activeOffRoadLimit) {
      state.speed += OFF_ROAD_DECEL * (isCornerCut ? 1.85 : (isDeepCornerCut ? 1.35 : 1.0)) * dt;
    }
    if (Math.abs(state.speed) > 40 && Math.random() < 0.65) {
      spawnParticles(
        anchors.rearCenterX + (Math.random() - 0.5) * anchors.carW * 0.75,
        anchors.rearGroundY - 4,
        2,
        '#c98a5b',
        130,
        75,
        [3, 7],
        [0.25, 0.5]
      );
    }
  }

  state.speed = MathUtil.clamp(state.speed, -MAX_REVERSE_SPEED, effectiveMaxSpeed);

  // Руление
  let steerDir = 0;
  if (input.left) steerDir -= 1;
  if (input.right) steerDir += 1;

  if (state.speed > 0) {
    const turnRate = STEER_SENSITIVITY * Math.min(1, forwardSpeedRatio * 1.45);
    state.playerX += steerDir * turnRate * dt;
  } else if (state.speed < 0) {
    const reverseManoeuvreRatio = Math.min(1, Math.abs(state.speed) / MAX_REVERSE_SPEED);
    const reverseTurnRate = REVERSE_STEER_SENSITIVITY * reverseManoeuvreRatio;
    state.playerX += steerDir * reverseTurnRate * dt;
  }

  if (state.gameMode !== 'circuit' && state.visualDamage >= 2 && state.speed > MAX_SPEED * 0.16) {
    const alignmentPull = (state.rightDamage - state.leftDamage) * 0.052;
    if (Math.abs(alignmentPull) > 0.01) {
      state.playerX += alignmentPull * forwardSpeedRatio * dt;
    }
  }

  if (currentSeg && state.speed > 0) {
    let effectiveCentrifugal = CENTRIFUGAL_FORCE;
    if (state.gameMode === 'circuit') {
      effectiveCentrifugal = state.difficulty === 'hardcore' ? 0.64 : 0.54;
    }
    const steerGripResistance = steerDir === 0 ? 1.0 : 0.92;
    state.playerX -= steerGripResistance * forwardSpeedRatio * forwardSpeedRatio * currentSeg.curve * effectiveCentrifugal * dt;
  }

  if (Math.abs(state.playerVX) > 0.001) {
    state.playerX += state.playerVX * dt;
    const gripDamping = Math.pow(0.035, dt);
    state.playerVX *= gripDamping;
    if (Math.abs(state.playerVX) < 0.01) state.playerVX = 0;
  }

  // Физика защитных отбойников на крутых поворотах
  if (state.gameMode === 'circuit' && state.difficulty === 'arcade' && currentSeg) {
    const railInnerEdge = 1.15;
    const visualHalfCarW = 0.12;
    const carHalfScreenW = anchors.carW * 0.50;
    if (currentSeg.guardrailLeft && state.playerX - visualHalfCarW < -railInnerEdge) {
      state.playerX = -railInnerEdge + visualHalfCarW;
      if (state.playerVX < 0) state.playerVX = Math.abs(state.playerVX) * 0.35;
      state.speed *= Math.pow(0.84, dt * 6);
      state.impactShake = Math.max(state.impactShake, 0.22);
      if (Math.abs(state.speed) > 35) {
        spawnParticles(anchors.rearCenterX - carHalfScreenW, anchors.rearCenterY, 2, '#ffbe0b', 110, 70, [2, 4], [0.15, 0.32]);
        if (state.guardrailSoundCooldown <= 0) {
          state.guardrailSoundCooldown = 0.14;
          audio.playGuardrailScrape();
        }
      }
    } else if (currentSeg.guardrailRight && state.playerX + visualHalfCarW > railInnerEdge) {
      state.playerX = railInnerEdge - visualHalfCarW;
      if (state.playerVX > 0) state.playerVX = -Math.abs(state.playerVX) * 0.35;
      state.speed *= Math.pow(0.84, dt * 6);
      state.impactShake = Math.max(state.impactShake, 0.22);
      if (Math.abs(state.speed) > 35) {
        spawnParticles(anchors.rearCenterX + carHalfScreenW, anchors.rearCenterY, 2, '#ffbe0b', 110, 70, [2, 4], [0.15, 0.32]);
        if (state.guardrailSoundCooldown <= 0) {
          state.guardrailSoundCooldown = 0.14;
          audio.playGuardrailScrape();
        }
      }
    }
  }

  state.playerX = MathUtil.clamp(state.playerX, -PLAYER_MAX_LATERAL_X, PLAYER_MAX_LATERAL_X);

  const steerVisualScale = state.speed < 0 ? 0.4 : 1.0;
  const targetSteerVisual = Math.abs(state.speed) > 15 ? steerDir * steerVisualScale : 0;
  state.steerVisual = MathUtil.lerp(state.steerVisual, targetSteerVisual, Math.min(1, dt * 11));

  // 4. Перемещение по трассе, следы торможения и дым из-под колес
  const deltaZ = state.speed * dt;
  state.position = (((state.position + deltaZ) % trackLength) + trackLength) % trackLength;

  const prevNetForwardZ = state.netForwardZ;
  state.netForwardZ += deltaZ;

  const rearTireWorldZ = (((state.position + REAR_TIRE_CAM_Z) % trackLength) + trackLength) % trackLength;
  const isHardBrakingOnRoad = !isOffRoad && input.down && state.speed > MAX_SPEED * 0.035;
  const isLateralSkiddingOnRoad = !isOffRoad && Math.abs(state.playerVX) > 0.35 && state.speed > MAX_SPEED * 0.12;

  if (isHardBrakingOnRoad || isLateralSkiddingOnRoad) {
    const skidAlpha = MathUtil.clamp(0.46 + forwardSpeedRatio * 0.42, 0.46, 0.88);
    recordSkidMarks(rearTireWorldZ, state.playerX, skidAlpha, Math.max(24, deltaZ));

    const currentForwardKmh = (Math.max(0, state.speed) / MAX_SPEED) * BASE_MAX_KMH;
    const minSmokeKmh = GAME_CONFIG.playerVisuals.tireSmokeMinKmh;
    if (currentForwardKmh >= minSmokeKmh) {
      const smokeRatio = MathUtil.clamp(
        (currentForwardKmh - minSmokeKmh) / Math.max(1, BASE_MAX_KMH - minSmokeKmh),
        0,
        1
      );

      const exactPuffs = 0.35 + smokeRatio * 3.15;
      const basePuffs = Math.floor(exactPuffs);
      const extraPuffChance = exactPuffs - basePuffs;

      const baseAlpha = (0.24 + smokeRatio * 0.34).toFixed(2);
      const midAlpha = (0.20 + smokeRatio * 0.28).toFixed(2);
      const smokePalette = [
        `rgba(238, 240, 248, ${baseAlpha})`,
        `rgba(212, 216, 230, ${midAlpha})`
      ];

      const minSize = 4 + smokeRatio * 4;
      const maxSize = 7 + smokeRatio * 12;
      const minLife = 0.24 + smokeRatio * 0.14;
      const maxLife = 0.42 + smokeRatio * 0.34;
      const vxSpread = 45 + smokeRatio * 85;
      const vyBase = 32 + smokeRatio * 60;
      const expandRate = 8 + smokeRatio * 10;

      for (let sideIdx = 0; sideIdx < 2; sideIdx++) {
        const puffsForWheel = basePuffs + (Math.random() < extraPuffChance ? 1 : 0);
        if (puffsForWheel <= 0) continue;

        const wx = sideIdx === 0 ? anchors.leftWheelX : anchors.rightWheelX;
        const wy = sideIdx === 0 ? anchors.leftWheelY : anchors.rightWheelY;
        const outwardBias = sideIdx === 0 ? -18 : 18;
        const chosenColor = smokePalette[(sideIdx + Math.floor(Math.random() * 2)) % smokePalette.length];

        spawnParticles(
          wx + outwardBias * (0.25 + smokeRatio * 0.25),
          wy,
          puffsForWheel,
          chosenColor,
          vxSpread,
          vyBase,
          [minSize, maxSize],
          [minLife, maxLife],
          -28,
          expandRate
        );
      }
    }
  } else {
    state.prevSkidSample = null;
  }

  const oldPlayerSeg = currentSeg;
  const newPlayerSeg = findSegment(state.position + PLAYER_Z + PLAYER_CENTER_OFFSET_Z);
  if (currentSeg && state.speed !== 0) {
    const signedSpeedRatio = state.speed / MAX_SPEED;
    const curveScroll = currentSeg.curve * signedSpeedRatio * dt;
    state.skyOffset = (state.skyOffset + curveScroll * 0.08) % 1;
    state.hillOffset = (state.hillOffset + curveScroll * 0.22) % 1;
    state.cityOffset = (state.cityOffset + curveScroll * 0.44) % 1;
  }

  const currentKmh = Math.round((Math.abs(state.speed) / MAX_SPEED) * BASE_MAX_KMH);
  if (state.speed > 0 && currentKmh > state.maxKmhReached) state.maxKmhReached = currentKmh;

  if (state.gameMode === 'circuit') {
    state.playerProgressZ += deltaZ;
    if (deltaZ > 0) {
      state.distanceMeters += deltaZ / 25;
    }

    if (state.playerProgressZ >= state.circuitCurrentLap * trackLength) {
      const lapDuration = state.raceElapsedTime - state.currentLapStartTime;
      const lapDistKm = trackLength / 25000;
      const lapAvgKmh = lapDuration > 0 ? (lapDistKm / (lapDuration / 3600)) : 0;
      if (state.bestLapTime === null || lapDuration < state.bestLapTime) {
        state.bestLapTime = lapDuration;
        state.bestLapAvgKmh = lapAvgKmh;
      }
      state.currentLapStartTime = state.raceElapsedTime;
      state.circuitCurrentLap++;

      if (state.circuitCurrentLap > state.circuitTotalLaps) {
        computeCircuitRank();
        if (state.playerRank <= 3) {
          audio.playVictory();
        } else {
          audio.playCheckpoint();
        }
        triggerGameOver(`ФИНИШ • ${state.playerRank}-Е МЕСТО!`);
        return;
      } else {
        audio.playCheckpoint();
        if (state.circuitCurrentLap === state.circuitTotalLaps) {
          showBanner(`ФИНАЛЬНЫЙ КРУГ! (${state.circuitCurrentLap}/${state.circuitTotalLaps})`, '#ffbe0b', 2.2);
        } else {
          showBanner(`КРУГ ${state.circuitCurrentLap} / ${state.circuitTotalLaps} • ${formatRaceTime(lapDuration)}`, '#39ff14', 2.0);
        }
      }
    }
  } else {
    if (state.netForwardZ > state.maxNetForwardZ) {
      const newForwardDelta = state.netForwardZ - state.maxNetForwardZ;
      state.maxNetForwardZ = state.netForwardZ;
      const metersDelta = newForwardDelta / 25;
      state.distanceMeters += metersDelta;

      const isOncomingLane = state.gameMode === 'oncoming' && state.playerX < -0.14 && forwardSpeedRatio > 0.45;
      const scoreMultiplier = isOncomingLane ? GAME_CONFIG.gameplay.oncomingScoreMultiplier : 1.0;
      state.score += metersDelta * (1 + forwardSpeedRatio * 2.5) * scoreMultiplier;
    }

    if (deltaZ > 0 && oldPlayerSeg && newPlayerSeg && oldPlayerSeg !== newPlayerSeg) {
      const totalSegs = segments.length;
      let stepIdx = (oldPlayerSeg.index + 1) % totalSegs;
      let safety = 0;
      let traversedZ = prevNetForwardZ;
      while (safety < 15) {
        traversedZ += SEGMENT_LENGTH;
        if (segments[stepIdx].isCheckpoint) {
          const lapIdx = Math.floor(Math.max(0, traversedZ - SEGMENT_LENGTH * 0.5) / trackLength);
          const checkpointUid = lapIdx * totalSegs + stepIdx;
          if (!state.passedCheckpointUids.has(checkpointUid)) {
            state.passedCheckpointUids.add(checkpointUid);
            state.checkpointsPassed++;
            const bonusTime = Math.max(
              GAME_CONFIG.gameplay.checkpointMinBonusSec,
              GAME_CONFIG.gameplay.checkpointBaseBonusSec - Math.floor(state.checkpointsPassed * 0.8)
            );
            state.timeLeft = Math.min(GAME_CONFIG.gameplay.maxTimeSec, state.timeLeft + bonusTime);
            state.score += GAME_CONFIG.gameplay.checkpointScoreBonus * state.checkpointsPassed;
            audio.playCheckpoint();
            showBanner(`ЧЕКПОИНТ! +${bonusTime} СЕК`, '#00f0ff', 2.1);
          }
        }
        if (stepIdx === newPlayerSeg.index) break;
        stepIdx = (stepIdx + 1) % totalSegs;
        safety++;
      }
    }
  }

  // 5. Обновление трафика / соперников
  maintainTrafficDensity();
  updateTrafficOnly(dt, true);
  if (state.gameMode === 'circuit') {
    computeCircuitRank();
  }

  // 6. Коллизии с машинами
  const playerWorldZ = getPlayerWorldZ();
  if (newPlayerSeg) {
    const scanSpan = Math.max(3, Math.ceil((Math.abs(state.speed) * dt + MAX_SPEED * dt) / SEGMENT_LENGTH) + 2);
    const checkedCars = new Set();
    for (let offset = -scanSpan; offset <= scanSpan; offset++) {
      const segIdx = (newPlayerSeg.index + offset + segments.length) % segments.length;
      const seg = segments[segIdx];
      for (let i = 0; i < seg.cars.length; i++) {
        const car = seg.cars[i];
        if (checkedCars.has(car)) continue;
        checkedCars.add(car);

        const baseBlockDistZ = ((PLAYER_LEN_Z + (car.lenZ || SEGMENT_LENGTH * 1.3)) * 0.5) * 0.88;
        const dz = getShortestTrackDz(playerWorldZ, car.z, trackLength);
        const relSpeedZ = Math.abs(state.speed - car.speed * car.dir);
        const dynamicHalfZ = baseBlockDistZ + relSpeedZ * dt * 0.55;

        if (dz > -dynamicHalfZ && dz < dynamicHalfZ) {
          const carNormX = car.x / ROAD_WIDTH;
          if (MathUtil.overlap(state.playerX, PLAYER_WIDTH_NORM, carNormX, car.w, 0.90)) {
            const dx = state.playerX - carNormX;
            const combinedHalfW = (PLAYER_WIDTH_NORM + car.w) * 0.5;
            const overlapRatio = Math.abs(dx) / Math.max(0.01, combinedHalfW);
            const pushSign = dx >= 0 ? 1 : -1;

            if (car.isRival) {
              if (dz > 28) {
                const penetration = Math.max(0, baseBlockDistZ - dz);
                state.position = (((state.position - penetration) % trackLength) + trackLength) % trackLength;
                state.playerProgressZ -= penetration;
              } else if (dz < -28 && state.speed < 0) {
                const penetration = Math.max(0, baseBlockDistZ + dz);
                state.position = (((state.position + penetration) % trackLength) + trackLength) % trackLength;
                state.playerProgressZ += penetration;
                state.speed = 0;
              } else {
                const minSepX = combinedHalfW * 0.92;
                state.playerX = MathUtil.clamp(carNormX + pushSign * minSepX, -PLAYER_MAX_LATERAL_X, PLAYER_MAX_LATERAL_X);
              }

              if (car.hitCooldown <= 0) {
                car.hitCooldown = 0.35;
                state.impactShake = 0.65;
                audio.playCrash(0.65);

                if (dz > 28) {
                  car.speed = Math.min(MAX_SPEED * 0.995, Math.max(car.speed, state.speed * 0.96));
                  state.speed = Math.min(state.speed * GAME_CONFIG.circuit.rearBumpSlowdownRatio, car.speed * 0.96);
                  state.playerVX += dx * 1.15;
                } else if (dz >= -28) {
                  state.speed *= GAME_CONFIG.circuit.impactSlowdownRatio;
                  state.playerVX += pushSign * 1.05;
                  car.vx -= pushSign * 0.85;
                }

                spawnParticles(
                  anchors.centerX - dx * anchors.carW * 1.3,
                  anchors.centerY,
                  10,
                  '#ffbe0b',
                  190,
                  120,
                  [2, 4.5],
                  [0.2, 0.45]
                );
              }
              continue;
            }

            const impactSpeedKmh = Math.round((Math.abs(state.speed) / MAX_SPEED) * BASE_MAX_KMH);
            const isFrontalHit = overlapRatio < 0.65;
            const isHeadOn = car.dir === -1 && dz > 12 && isFrontalHit;
            const isRearEnd = overlapRatio < 0.72 && dz > 28;
            const isBackingHit = overlapRatio < 0.72 && dz < -28 && state.speed < 0;
            const hitSide = dx > 0.03 ? 'left' : (dx < -0.03 ? 'right' : 'center');
            const hitZone = isBackingHit ? 'rear' : ((isHeadOn || isRearEnd) ? 'front' : 'side');

            if (dz > 28 || isHeadOn) {
              const penetration = Math.max(0, baseBlockDistZ - dz);
              state.position = (((state.position - penetration) % trackLength) + trackLength) % trackLength;
              state.netForwardZ -= penetration;
              const carForwardVel = Math.max(0, car.speed * car.dir);
              if (state.speed > carForwardVel) {
                if (isHeadOn) {
                  state.speed = 0;
                } else if (car.dir === -1) {
                  state.speed *= 0.65;
                  const minSepX = combinedHalfW * 0.94;
                  state.playerX = MathUtil.clamp(carNormX + pushSign * minSepX, -PLAYER_MAX_LATERAL_X, PLAYER_MAX_LATERAL_X);
                } else {
                  state.speed = carForwardVel;
                }
              }
            } else if (dz < -28 && state.speed < 0) {
              const penetration = Math.max(0, baseBlockDistZ + dz);
              state.position = (((state.position + penetration) % trackLength) + trackLength) % trackLength;
              state.netForwardZ += penetration;
              state.speed = 0;
            } else {
              const minSepX = combinedHalfW * 0.92;
              state.playerX = MathUtil.clamp(carNormX + pushSign * minSepX, -PLAYER_MAX_LATERAL_X, PLAYER_MAX_LATERAL_X);
            }

            if (car.hitCooldown <= 0) {
              car.hitCooldown = 1.5;
              state.impactShake = 1.0;

              if (isHeadOn) {
                audio.playCrash(1.35);
                car.speed = 0;
                car.braking = true;
                car.damagedByPlayer = true;
                car.targetX = car.x;
                state.speed = 0;
                state.playerVX += pushSign * (0.85 + overlapRatio * 0.95);
              } else if (isRearEnd) {
                audio.playCrash(1.0);
                car.braking = true;
                car.damagedByPlayer = true;
                car.brakeForce = MAX_SPEED * 0.65;
                car.targetX = car.x;
                if (car.dir === 1) {
                  state.speed = Math.min(state.speed, Math.max(0, car.speed * 0.75));
                }
                state.playerVX += (dx >= 0 ? 1 : -1) * Math.max(0.95, Math.abs(dx) * 1.9);
              } else if (isBackingHit) {
                audio.playCrash(0.65);
                car.braking = true;
                car.damagedByPlayer = true;
                car.brakeForce = MAX_SPEED * 0.65;
                car.targetX = car.x;
                state.speed = 0;
                state.playerVX += dx * 1.2;
              } else {
                audio.playCrash(0.75);
                car.braking = true;
                car.damagedByPlayer = true;
                car.brakeForce = MAX_SPEED * 0.65;
                state.speed *= 0.80;
                state.playerVX += pushSign * 1.45;
                car.x = MathUtil.clamp(car.x - pushSign * 120, -ROAD_WIDTH * 0.82, ROAD_WIDTH * 0.82);
                car.targetX = car.x;
              }

              spawnParticles(
                anchors.centerX - dx * anchors.carW * 1.3,
                anchors.centerY,
                14,
                '#ffbe0b',
                220,
                140,
                [2, 5],
                [0.25, 0.55]
              );

              const hitContext = { side: hitSide, zone: hitZone };
              const isOncomingCar = car.dir === -1;
              if (isOncomingCar) {
                if (!isHeadOn) {
                  if (registerCollision(1, 'МАШИНА РАЗБИТА!', hitContext)) return;
                } else {
                  const instantWreckKmh = GAME_CONFIG.gameplay.headOnInstantWreckKmh;
                  const oncomingDmg = impactSpeedKmh >= instantWreckKmh
                    ? MAX_HARDCORE_COLLISIONS
                    : Math.max(1, Math.floor(impactSpeedKmh / 20));
                  const fatalMsg = impactSpeedKmh >= instantWreckKmh
                    ? `ЛОБОВОЙ УДАР НА ${impactSpeedKmh} КМ/Ч!`
                    : 'МАШИНА РАЗБИТА!';
                  if (registerCollision(oncomingDmg, fatalMsg, hitContext)) return;
                }
              } else {
                if (registerCollision(1, 'МАШИНА РАЗБИТА!', hitContext)) return;
              }
            }
          }
        }
      }
    }
  }

  // 7. Коллизии с придорожными объектами
  if (newPlayerSeg && state.spriteHitCooldown <= 0) {
    const totalSegs = segments.length;
    const segIndicesToCheck = [];
    const visitedSegs = new Set();

    if (oldPlayerSeg && deltaZ > 0) {
      let idx = oldPlayerSeg.index;
      let safety = 0;
      while (safety < 15) {
        if (!visitedSegs.has(idx)) {
          visitedSegs.add(idx);
          segIndicesToCheck.push(idx);
        }
        if (idx === newPlayerSeg.index) break;
        idx = (idx + 1) % totalSegs;
        safety++;
      }
    } else {
      visitedSegs.add(newPlayerSeg.index);
      segIndicesToCheck.push(newPlayerSeg.index);
    }

    const lookAheadIdx = (newPlayerSeg.index + 1) % totalSegs;
    if (!visitedSegs.has(lookAheadIdx)) {
      segIndicesToCheck.push(lookAheadIdx);
    }

    let hitResolved = false;
    for (let s = 0; s < segIndicesToCheck.length && !hitResolved; s++) {
      const seg = segments[segIndicesToCheck[s]];
      for (let i = 0; i < seg.sprites.length; i++) {
        const sp = seg.sprites[i];
        let hitTargets = [{ offset: sp.offset, width: 0.08 }];
        if (sp.type === 'billboard') {
          hitTargets = [{ offset: sp.offset, width: 0.24 }];
        } else if (sp.type === 'start_arch' || sp.type === 'checkpoint_arch') {
          hitTargets = [
            { offset: -1.21, width: 0.11 },
            { offset:  1.21, width: 0.11 }
          ];
        } else if (sp.type === 'chevron_left' || sp.type === 'chevron_right') {
          hitTargets = [{ offset: sp.offset, width: 0.12 }];
        } else if (sp.type === 'palm') {
          hitTargets = [{ offset: sp.offset, width: 0.08 }];
        } else if (sp.type === 'lamp') {
          hitTargets = [{ offset: sp.offset, width: 0.06 }];
        }

        let collidedTarget = null;
        for (let t = 0; t < hitTargets.length; t++) {
          if (MathUtil.overlap(state.playerX, PLAYER_WIDTH_NORM, hitTargets[t].offset, hitTargets[t].width, 0.90)) {
            collidedTarget = hitTargets[t];
            break;
          }
        }

        if (collidedTarget) {
          hitResolved = true;
          state.spriteHitCooldown = 0.45;
          state.impactShake = 0.95;
          audio.playCrash(1.0);

          const pushSign = state.playerX >= collidedTarget.offset ? 1 : -1;
          const minSep = (PLAYER_WIDTH_NORM + collidedTarget.width) * 0.52;
          state.playerX = MathUtil.clamp(collidedTarget.offset + pushSign * minSep, -PLAYER_MAX_LATERAL_X, PLAYER_MAX_LATERAL_X);
          state.playerVX = pushSign * 1.1;

          spawnParticles(anchors.centerX, anchors.centerY, 14, '#ffbe0b', 220, 140, [2, 5], [0.25, 0.55]);

          if (state.gameMode === 'circuit') {
            state.speed *= GAME_CONFIG.circuit.obstacleSlowdownRatio;
          } else {
            const impactKmh = Math.round((Math.abs(state.speed) / MAX_SPEED) * BASE_MAX_KMH);
            const instantObstacleKmh = GAME_CONFIG.gameplay.obstacleInstantWreckKmh;
            state.speed *= 0.28;
            const obstacleDmg = impactKmh >= instantObstacleKmh
              ? MAX_HARDCORE_COLLISIONS
              : Math.max(
                  1,
                  Math.min(
                    MAX_HARDCORE_COLLISIONS - 1,
                    Math.round((impactKmh / instantObstacleKmh) * (MAX_HARDCORE_COLLISIONS - 1))
                  )
                );
            const fatalReason = impactKmh >= instantObstacleKmh
              ? `РАЗБИЛСЯ О ПРЕПЯТСТВИЕ НА ${impactKmh} КМ/Ч!`
              : 'МАШИНА РАЗБИТА!';
            const obstacleHitContext = {
              side: pushSign > 0 ? 'left' : 'right',
              zone: 'front'
            };
            if (registerCollision(obstacleDmg, fatalReason, obstacleHitContext)) return;
          }
          break;
        }
      }
    }
  }

  // 8. Камера и звук
  updateCameraDynamics(dt, newPlayerSeg);
  audio.update(
    Math.abs(state.speed) / MAX_SPEED,
    input.down && state.speed > MAX_SPEED * 0.035,
    isOffRoad,
    true,
    false,
    damageRatio,
    isEngineMisfiring
  );
}