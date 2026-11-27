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
  BASE_MAX_KMH,
  WORLD_UNITS_PER_METER,
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
  SCORE_PER_METER,
  MAX_HARDCORE_COLLISIONS
} from './config.js';
import { MathUtil, formatRaceTime, getShortestTrackDz } from './utils.js';
import { audio } from './audio.js';
import {
  state,
  findSegment,
  getPlayerWorldZ,
  getCurrentMaxAllowedKmh,
  isOncomingBonusActive,
  showBanner,
  spawnParticles
} from './state.js';
import { recordSkidMarks } from './track.js';
import { maintainTrafficDensity, updateTrafficOnly } from './traffic.js';
import { t, formatPlaceText } from './i18n.js';

// Смещение опор арок синхронизировано с модулями рендера (ARCH_TOWER_OFFSET_NORM)
const ARCH_PILLAR_HITBOX_OFFSET = 1.28;

// Константная таблица ширин хитбоксов придорожных спрайтов (без аллокаций на кадр)
const SPRITE_HITBOX_WIDTHS = Object.freeze({
  billboard: 0.24,
  chevron_left: 0.12,
  chevron_right: 0.12,
  palm: 0.08,
  lamp: 0.06
});

const ARCH_HIT_TARGETS = Object.freeze([
  Object.freeze({ offset: -ARCH_PILLAR_HITBOX_OFFSET, width: 0.11 }),
  Object.freeze({ offset:  ARCH_PILLAR_HITBOX_OFFSET, width: 0.11 })
]);

// Предрасчитанные таблицы вероятности дыма повреждений и палитры дыма шин (0 строковых аллокаций в кадре)
const DAMAGE_SMOKE_CHANCE = Object.freeze([0, 0.14, 0.26, 0.44, 0.66, 0.85]);
const SMOKE_ALPHA_STEPS = 32;
const TIRE_SMOKE_LIGHT_COLORS = Object.freeze(
  Array.from({ length: SMOKE_ALPHA_STEPS + 1 }, (_, i) => {
    const r = i / SMOKE_ALPHA_STEPS;
    return `rgba(238, 240, 248, ${(0.24 + r * 0.34).toFixed(2)})`;
  })
);
const TIRE_SMOKE_MID_COLORS = Object.freeze(
  Array.from({ length: SMOKE_ALPHA_STEPS + 1 }, (_, i) => {
    const r = i / SMOKE_ALPHA_STEPS;
    return `rgba(212, 216, 230, ${(0.20 + r * 0.28).toFixed(2)})`;
  })
);

// Постоянные диапазоны параметров частиц и переиспользуемые кортежи (исключают создание массивов [a, b] на каждый спавн)
const RANGE_WRECK_SMOKE_SIZE = Object.freeze([7, 16]);
const RANGE_WRECK_SMOKE_LIFE = Object.freeze([0.6, 1.3]);
const RANGE_WRECK_SPARK_SIZE = Object.freeze([2, 4]);
const RANGE_WRECK_SPARK_LIFE = Object.freeze([0.2, 0.45]);
const RANGE_DAMAGE_SMOKE_LIFE = Object.freeze([0.45, 0.95]);
const RANGE_BACKFIRE_SIZE = Object.freeze([3, 6]);
const RANGE_BACKFIRE_LIFE = Object.freeze([0.14, 0.28]);
const RANGE_OFFROAD_DUST_SIZE = Object.freeze([3, 7]);
const RANGE_OFFROAD_DUST_LIFE = Object.freeze([0.25, 0.5]);
const RANGE_RAIL_SPARK_SIZE = Object.freeze([2, 4]);
const RANGE_RAIL_SPARK_LIFE = Object.freeze([0.15, 0.32]);
const RANGE_RIVAL_SPARK_SIZE = Object.freeze([2, 4.5]);
const RANGE_RIVAL_SPARK_LIFE = Object.freeze([0.2, 0.45]);
const RANGE_CRASH_SPARK_SIZE = Object.freeze([2, 5]);
const RANGE_CRASH_SPARK_LIFE = Object.freeze([0.25, 0.55]);

const _dynSizeRange = [0, 0];
const _dynLifeRange = [0, 0];
const _hitContext = { side: 'center', zone: 'front' };

// Коэффициенты экспоненциального затухания (заменяют вызовы Math.pow в горячем цикле)
const PLAYER_VX_DECAY_RATE = -Math.log(0.035);
const GUARDRAIL_SPEED_DECAY_RATE = -6 * Math.log(0.84);

const _checkedCars = new Set();
const _visitedSegs = new Set();
const _segIndicesToCheck = [];

/**
 * Частотно-независимый коэффициент экспоненциального сглаживания.
 * Гарантирует одинаковую плавность камеры и руля на экранах 60/90/120 Гц и при плавающем dt на мобильных.
 */
function expSmoothing(rate, dt) {
  return 1 - Math.exp(-rate * dt);
}

/**
 * Непрерывная интерполяция кривизны дороги внутри сегмента по мировому Z.
 * Убирает ступенчатые скачки центробежной силы, параллакса и крена камеры на стыках сегментов.
 */
function sampleTrackCurve(worldZ) {
  const segments = state.segments;
  const len = segments.length;
  if (!len || !Number.isFinite(worldZ)) return 0;

  const wrappedZ = MathUtil.wrap(worldZ, state.trackLength);
  const exactIdx = wrappedZ / SEGMENT_LENGTH;
  const idx0 = Math.floor(exactIdx) % len;
  const idx1 = (idx0 + 1) % len;
  const t = exactIdx - Math.floor(exactIdx);

  return MathUtil.lerp(segments[idx0].curve, segments[idx1].curve, t);
}

/**
 * Непрерывная интерполяция продольного уклона рельефа (slope) по мировому Z.
 * Предотвращает вертикальное подрагивание наклона камеры (cameraPitch) на холмах при скорости > 100 км/ч.
 */
function sampleTrackSlope(worldZ) {
  const segments = state.segments;
  const len = segments.length;
  if (!len || !Number.isFinite(worldZ)) return 0;

  const wrappedZ = MathUtil.wrap(worldZ, state.trackLength);
  const exactIdx = wrappedZ / SEGMENT_LENGTH;
  const idx0 = Math.floor(exactIdx) % len;
  const idx1 = (idx0 + 1) % len;
  const t = exactIdx - Math.floor(exactIdx);

  const s0 = segments[idx0];
  const s1 = segments[idx1];
  const slope0 = s0.slope !== undefined ? s0.slope : (s0.p2.world.y - s0.p1.world.y) / SEGMENT_LENGTH;
  const slope1 = s1.slope !== undefined ? s1.slope : (s1.p2.world.y - s1.p1.world.y) / SEGMENT_LENGTH;

  return MathUtil.lerp(slope0, slope1, t);
}

/**
 * Добавляет уникальный индекс сегмента в список кандидатов для проверки столкновений со спрайтами
 */
function addCandidateSpriteSeg(idx, totalSegs) {
  const wrapped = ((idx % totalSegs) + totalSegs) % totalSegs;
  if (!_visitedSegs.has(wrapped)) {
    _visitedSegs.add(wrapped);
    _segIndicesToCheck.push(wrapped);
  }
}

/**
 * Однопроходное обновление и уплотнение массива частиц за O(N) без splice()
 */
function updateParticles(dt) {
  const particles = state.particles;
  let writeIdx = 0;
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) continue;

    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += p.gravity * dt;
    if (p.expandRate !== 0) {
      p.size = Math.max(1, p.size + p.expandRate * dt);
    }
    particles[writeIdx++] = p;
  }
  particles.length = writeIdx;
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
    triggerGameOver(t('goTimeUp'));
    return true;
  }
  return false;
}

/**
 * Синхронный продольный сдвиг позиции игрока при перемещении и разрешении коллизий
 */
function shiftPlayerZ(delta, trackLength) {
  state.position = (((state.position + delta) % trackLength) + trackLength) % trackLength;
  state.netForwardZ += delta;
  if (state.gameMode === 'circuit') {
    state.playerProgressZ += delta;
  }
}

function registerCollision(damagePoints = 1, fatalReason = null, hitContext = _hitContext) {
  if (state.gameMode === 'circuit') {
    return false;
  }

  const resolvedFatal = fatalReason || t('goCarWrecked');
  // В режиме «Легко» ограничиваем штраф за один удар, отвязывая его от смертельного урона хардкора
  const rawDmg = Math.max(1, damagePoints);
  const dmg = state.difficulty === 'hardcore' ? rawDmg : Math.min(2, rawDmg);
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

  // Однократная фиксация стороны повреждения спойлера
  if (state.spoilerDamageSide === 0) {
    const nextVisDmg = state.difficulty !== 'hardcore'
      ? Math.min(4, Math.max(state.visualDamage, Math.ceil(state.collisionCount * 0.85)))
      : MAX_HARDCORE_COLLISIONS - Math.max(0, state.collisionsLeft - dmg);
    if (nextVisDmg >= 2) {
      if (side === 'left') {
        state.spoilerDamageSide = -1;
      } else if (side === 'right') {
        state.spoilerDamageSide = 1;
      } else if (state.leftDamage !== state.rightDamage) {
        state.spoilerDamageSide = state.leftDamage > state.rightDamage ? -1 : 1;
      } else {
        state.spoilerDamageSide = Math.random() < 0.5 ? -1 : 1;
      }
    }
  }

  if (state.difficulty !== 'hardcore') {
    state.visualDamage = Math.min(4, Math.max(state.visualDamage, Math.ceil(state.collisionCount * 0.85)));
    if (applyCollisionTimePenalty(COLLISION_TIME_PENALTY)) return true;
    const engineWarn = state.visualDamage >= 3 ? t('bannerEngineDamagedSuffix') : '';
    showBanner(
      t('bannerHitArcade', { sec: penaltySec, kmh: cappedKmh, engineWarn }),
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
    triggerGameOver(resolvedFatal);
    return true;
  }

  if (applyCollisionTimePenalty(COLLISION_TIME_PENALTY)) return true;
  showBanner(
    t('bannerHitHardcore', {
      sec: penaltySec,
      kmh: cappedKmh,
      left: state.collisionsLeft,
      max: MAX_HARDCORE_COLLISIONS
    }),
    '#ff2a85',
    1.9
  );
  return false;
}

export function computeCircuitRank() {
  let rank = 1;
  for (let i = 0; i < state.rivals.length; i++) {
    const r = state.rivals[i];
    // Уже финишировавший соперник безусловно выше игрока, даже если сбросил темп после черты
    if (r.finished || r.progressZ > state.playerProgressZ) {
      rank++;
    }
  }
  state.playerRank = rank;
}

/**
 * Плавная кинематика 3D-камеры (FOV, наклон на рельефе, поперечное запаздывание и крен в виражах).
 * Использует непрерывную интерполяцию рельефа/кривизны и экспоненциальный фильтр без dt-зависимых рывков.
 */
function updateCameraDynamics(dt) {
  const forwardRatio = MathUtil.clamp(state.speed / MAX_SPEED, 0, 1.05);

  const targetFov = (BASE_FOV - 4) + forwardRatio * 16;
  if (Math.abs(targetFov - state.currentFov) < 1e-4) {
    state.currentFov = targetFov;
  } else {
    state.currentFov = MathUtil.lerp(state.currentFov, targetFov, expSmoothing(5.5, dt));
  }
  state.activeCameraDepth = 1 / Math.tan((state.currentFov * 0.5) * Math.PI / 180);

  // Смешиваем уклон непосредственно под камерой и в точке машины игрока для бесшовного прохождения перегибов холмов
  const camZ = state.position;
  const lookZ = state.position + PLAYER_Z + PLAYER_CENTER_OFFSET_Z;
  const blendedSlope = state.segments.length > 0
    ? sampleTrackSlope(camZ) * 0.45 + sampleTrackSlope(lookZ) * 0.55
    : 0;
  const targetPitch = MathUtil.clamp(blendedSlope * 185, -42, 24);
  state.cameraPitch = MathUtil.lerp(state.cameraPitch, targetPitch, expSmoothing(6.5, dt));

  const targetLagX = state.gameState === STATE.PLAYING ? state.steerVisual * 0.085 : 0;
  state.cameraLagX = MathUtil.lerp(state.cameraLagX, targetLagX, expSmoothing(8.0, dt));

  const smoothCurve = (state.gameState === STATE.PLAYING && state.segments.length > 0)
    ? sampleTrackCurve(lookZ)
    : 0;
  const targetRoll = MathUtil.clamp(-smoothCurve * forwardRatio * 0.0042, -0.022, 0.022);
  state.cameraRoll = MathUtil.lerp(state.cameraRoll, targetRoll, expSmoothing(6.0, dt));
  if (Math.abs(state.cameraRoll) < 1e-6 && Math.abs(targetRoll) < 1e-6) {
    state.cameraRoll = 0;
  }
}

export function updateSimulation(dt) {
  if (state.gameState === STATE.PLAYING && state.isPaused) {
    audio.update(0, false, false, false);
    return;
  }

  // Нормированный коэффициент частоты кадров (1.0 при 60 FPS) для независимости частиц от Гц экрана
  const step60 = dt * 60;
  state.animClockMs += dt * 1000;

  state.bannerTimer = Math.max(0, state.bannerTimer - dt);
  state.spriteHitCooldown = Math.max(0, state.spriteHitCooldown - dt);
  state.guardrailSoundCooldown = Math.max(0, state.guardrailSoundCooldown - dt);
  state.offRoadWarnCooldown = Math.max(0, state.offRoadWarnCooldown - dt);
  state.heatWarnCooldown = Math.max(0, state.heatWarnCooldown - dt);
  state.impactShake = Math.max(0, state.impactShake - dt * 3.8);
  state.timePenaltyFlash = Math.max(0, state.timePenaltyFlash - dt * 1.4);

  updateParticles(dt);

  const anchors = state.playerScreenAnchors;
  const input = state.input;
  const segments = state.segments;
  const trackLength = state.trackLength;

  // Демонстрационный автопилот на стартовом экране (или сцена аварии при поломке)
  if (state.gameState !== STATE.PLAYING) {
    if (state.gameState === STATE.GAMEOVER && state.gameMode !== 'circuit' && state.visualDamage >= MAX_HARDCORE_COLLISIONS) {
      if (Math.random() < 0.78 * step60) {
        spawnParticles(
          anchors.centerX + (Math.random() - 0.5) * anchors.carW * 0.35,
          anchors.hoodY,
          2,
          Math.random() < 0.7 ? 'rgba(32, 30, 40, 0.85)' : 'rgba(95, 90, 108, 0.75)',
          70,
          115,
          RANGE_WRECK_SMOKE_SIZE,
          RANGE_WRECK_SMOKE_LIFE,
          -25,
          12
        );
      }
      if (Math.random() < 0.28 * step60) {
        spawnParticles(
          anchors.centerX + (Math.random() - 0.5) * anchors.carW * 0.30,
          anchors.centerY,
          2,
          '#ffbe0b',
          135,
          95,
          RANGE_WRECK_SPARK_SIZE,
          RANGE_WRECK_SPARK_LIFE
        );
      }
      // Разбитая машина реально стоит на полосе, поэтому трафик реагирует на неё
      updateTrafficOnly(dt, true);
      updateCameraDynamics(dt);
      audio.update(0, false, false, false);
      return;
    }

    const demoSpeedRatio = 0.26;
    state.position = trackLength > 0 ? (state.position + MAX_SPEED * demoSpeedRatio * dt) % trackLength : 0;
    if (state.gameState === STATE.GAMEOVER) {
      // Камера плавно возвращается к центру трассы, пока машина игрока остаётся стоять на месте
      state.playerX = MathUtil.lerp(state.playerX, 0, expSmoothing(1.4, dt));
    }
    if (segments.length > 0) {
      const demoCurve = sampleTrackCurve(state.position + PLAYER_Z + PLAYER_CENTER_OFFSET_Z);
      const demoCurveScroll = demoCurve * demoSpeedRatio * dt;
      state.skyOffset = MathUtil.wrap(state.skyOffset + demoCurveScroll * 0.08, 2);
      state.hillOffset = MathUtil.wrap(state.hillOffset + demoCurveScroll * 0.22, 1);
      state.cityOffset = MathUtil.wrap(state.cityOffset + demoCurveScroll * 0.44, 1);
    }
    maintainTrafficDensity();
    updateTrafficOnly(dt, false);
    updateCameraDynamics(dt);
    audio.update(0, false, false, false);
    return;
  }

  // Предстартовый отсчёт на решётке в кольцевом заезде
  if (state.gameMode === 'circuit' && state.raceCountdownTimer > 0) {
    state.raceCountdownTimer = Math.max(0, state.raceCountdownTimer - dt);
    const digit = Math.ceil((state.raceCountdownTimer / GAME_CONFIG.circuit.countdownSec) * 3);
    if (digit > 0 && digit !== state.lastCountdownDigit) {
      state.lastCountdownDigit = digit;
      audio.playTone(440, 0.10, 'square', 0.12);
    }
    if (state.raceCountdownTimer === 0) {
      audio.playStartBeep();
      showBanner(t('bannerRaceStart'), '#39ff14', 1.4);
    }
    updateCameraDynamics(dt);
    audio.update(input.up ? 0.55 : 0.08, false, false, true, true);
    return;
  }

  // 1. Таймер обратного отсчёта или секундомер круга
  if (state.gameMode === 'circuit') {
    state.raceElapsedTime += dt;
    if (state.raceFinishCountdown > 0) {
      state.raceFinishCountdown = Math.max(0, state.raceFinishCountdown - dt);
      if (state.raceFinishCountdown === 0) {
        computeCircuitRank();
        triggerGameOver(t('goRaceOverPlace', { place: formatPlaceText(state.playerRank) }));
        return;
      }
    }
  } else {
    state.timeLeft -= dt;
    if (state.timeLeft <= 0) {
      state.timeLeft = 0;
      triggerGameOver(t('goTimeUp'));
      return;
    }
  }

  const playerFocusZBeforeMove = state.position + PLAYER_Z + PLAYER_CENTER_OFFSET_Z;
  const currentSeg = findSegment(playerFocusZBeforeMove);
  const smoothCurrentCurve = sampleTrackCurve(playerFocusZBeforeMove);
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
      const smokeChance = DAMAGE_SMOKE_CHANCE[Math.min(5, state.visualDamage)];
      if (Math.random() < smokeChance * step60) {
        const isHeavy = state.visualDamage >= 3;
        const smokeColor = isHeavy
          ? (Math.random() < 0.68 ? 'rgba(34, 31, 44, 0.80)' : 'rgba(92, 88, 106, 0.70)')
          : 'rgba(180, 180, 196, 0.52)';
        _dynSizeRange[0] = 4 + state.visualDamage;
        _dynSizeRange[1] = 9 + state.visualDamage * 1.5;
        spawnParticles(
          anchors.centerX + (Math.random() - 0.5) * anchors.carW * 0.28,
          anchors.hoodY,
          state.visualDamage >= 4 ? 2 : 1,
          smokeColor,
          55 + absSpeedRatio * 40,
          75 + (1 - absSpeedRatio) * 40,
          _dynSizeRange,
          RANGE_DAMAGE_SMOKE_LIFE,
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
          spawnParticles(pipeX, anchors.exhaustY, 3, '#ff7b00', 65, 45, RANGE_BACKFIRE_SIZE, RANGE_BACKFIRE_LIFE, 20);
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
    const heatThreshold = state.gameMode === 'circuit' ? 0.93 : 0.90;
    const heatRate = state.gameMode === 'circuit'
      ? GAME_CONFIG.gameplay.engineHeatRate * 0.60
      : GAME_CONFIG.gameplay.engineHeatRate;

    if (input.up && !input.down && throttleLoadRatio > heatThreshold && !state.isOverheated) {
      state.engineHeat = Math.min(100, state.engineHeat + dt * heatRate);
      if (state.engineHeat >= 92 && state.heatWarnCooldown <= 0) {
        state.heatWarnCooldown = 2.0;
        showBanner(t('bannerHeatWarn'), '#ffbe0b', 1.3);
      }
      if (state.engineHeat >= 100) {
        state.isOverheated = true;
        audio.playOverheat();
        showBanner(t('bannerOverheated'), '#ff2a85', 2.4);
      }
    } else {
      const coolRate = state.isOverheated
        ? GAME_CONFIG.gameplay.engineOverheatCoolRate
        : GAME_CONFIG.gameplay.engineCoolRate;
      state.engineHeat = Math.max(0, state.engineHeat - dt * coolRate);
      if (state.isOverheated && state.engineHeat <= GAME_CONFIG.gameplay.engineOverheatRecoverPct) {
        state.isOverheated = false;
        showBanner(t('bannerEngineCooled'), '#00f0ff', 1.6);
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
    } else if (state.speed <= effectiveMaxSpeed) {
      const misfireMult = isEngineMisfiring ? 0.22 : 1.0;
      const accelMult = (state.isOverheated ? 0.55 : (state.isSlipstreaming ? 1.06 : 1.0)) * misfireMult;
      state.speed = Math.min(effectiveMaxSpeed, state.speed + ACCEL * accelMult * dt);
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

  // Плавный инерционный сброс скорости при превышении лимита (перегрев или выход из слипстрима)
  if (state.speed > effectiveMaxSpeed) {
    const excessDecel = state.isOverheated ? MAX_SPEED * 0.42 : MAX_SPEED * 0.18;
    state.speed = Math.max(effectiveMaxSpeed, state.speed - excessDecel * dt);
  }

  if (isOffRoad) {
    const isCornerCut =
      state.gameMode === 'circuit' &&
      Math.abs(smoothCurrentCurve) > 3.5 &&
      Math.abs(state.playerX) > 1.48 &&
      Math.sign(state.playerX) === Math.sign(smoothCurrentCurve);
    const isDeepCornerCut = state.gameMode === 'circuit' && Math.abs(state.playerX) > 1.38;
    const activeOffRoadLimit = isCornerCut
      ? OFF_ROAD_LIMIT * 0.36
      : (isDeepCornerCut ? OFF_ROAD_LIMIT * 0.62 : OFF_ROAD_LIMIT);

    if ((isCornerCut || isDeepCornerCut) && state.speed > activeOffRoadLimit * 1.1 && state.offRoadWarnCooldown <= 0) {
      state.offRoadWarnCooldown = 1.6;
      showBanner(isCornerCut ? t('bannerCornerCut') : t('bannerReturnToTrack'), '#ffbe0b', 1.2);
    }
    if (state.speed > activeOffRoadLimit) {
      state.speed = Math.max(
        activeOffRoadLimit,
        state.speed + OFF_ROAD_DECEL * (isCornerCut ? 1.85 : (isDeepCornerCut ? 1.35 : 1.0)) * dt
      );
    }
    if (Math.abs(state.speed) > 40 && Math.random() < 0.65 * step60) {
      spawnParticles(
        anchors.rearCenterX + (Math.random() - 0.5) * anchors.carW * 0.75,
        anchors.rearGroundY - 4,
        2,
        '#c98a5b',
        130,
        75,
        RANGE_OFFROAD_DUST_SIZE,
        RANGE_OFFROAD_DUST_LIFE
      );
    }
  }

  const absoluteMaxForwardSpeed = MAX_SPEED * GAME_CONFIG.circuit.slipstreamBoostRatio;
  state.speed = MathUtil.clamp(state.speed, -MAX_REVERSE_SPEED, absoluteMaxForwardSpeed);

  // Руление и поперечные силы
  const prevPlayerX = state.playerX;
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

  // Центробежный снос вычисляется по интерполированной кривизне в средней точке шага движения
  const deltaZ = state.speed * dt;
  const midStepCurve = segments.length > 0
    ? sampleTrackCurve(playerFocusZBeforeMove + deltaZ * 0.5)
    : 0;

  if (state.speed > 0 && segments.length > 0) {
    let effectiveCentrifugal = CENTRIFUGAL_FORCE;
    if (state.gameMode === 'circuit') {
      effectiveCentrifugal = state.difficulty === 'hardcore' ? 0.64 : 0.54;
    }
    const steerGripResistance = steerDir === 0 ? 1.0 : 0.92;
    state.playerX -= steerGripResistance * forwardSpeedRatio * forwardSpeedRatio * midStepCurve * effectiveCentrifugal * dt;
  }

  if (Math.abs(state.playerVX) > 0.001) {
    state.playerX += state.playerVX * dt;
    state.playerVX *= Math.exp(-PLAYER_VX_DECAY_RATE * dt);
    if (Math.abs(state.playerVX) < 0.01) state.playerVX = 0;
  }

  // 4. Продольное перемещение по трассе (выполняем до проверки отбойника, чтобы учитывать новый сегмент)
  const prevNetForwardZ = state.netForwardZ;
  const prevProgressZ = state.playerProgressZ;
  const oldPlayerSeg = currentSeg;

  shiftPlayerZ(deltaZ, trackLength);

  const activeRailSeg = findSegment(state.position + PLAYER_Z + PLAYER_CENTER_OFFSET_Z) || currentSeg;

  // Двусторонняя физика защитных отбойников без 1-кадрового рывка камеры на скошенных заходах
  if (state.gameMode === 'circuit' && state.difficulty === 'arcade' && activeRailSeg) {
    const railInnerEdge = 1.15;
    const railOuterEdge = 1.21;
    const visualHalfCarW = PLAYER_WIDTH_NORM * 0.5;
    const innerLimit = railInnerEdge - visualHalfCarW;
    const outerLimit = railOuterEdge + visualHalfCarW * 0.7;
    const rampCaptureLimit = railOuterEdge + visualHalfCarW * 0.45;
    const carHalfScreenW = anchors.carW * 0.50;

    for (let side = -1; side <= 1; side += 2) {
      const hasRail = side < 0 ? activeRailSeg.guardrailLeft : activeRailSeg.guardrailRight;
      if (!hasRail) continue;

      const prevSideX = side * prevPlayerX;
      const currSideX = side * state.playerX;
      let hitRail = false;

      if (prevSideX <= innerLimit + 0.02) {
        // Штатное удержание внутри полотна без проникновения сквозь внутреннюю грань барьера
        if (currSideX > innerLimit) {
          state.playerX = side * innerLimit;
          hitRail = true;
        }
      } else if (prevSideX <= rampCaptureLimit) {
        // Плавный сгон со скошенного начала барьера внутрь полосы без мгновенного скачка камеры
        const maxSlideStep = 2.4 * dt;
        const targetSideX = Math.max(innerLimit, prevSideX - maxSlideStep);
        if (currSideX > targetSideX) {
          state.playerX = side * targetSideX;
          hitRail = true;
        }
      } else {
        // Игрок оказался глубоко за пределами трассы до начала барьера: держим внешнюю грань без телепортации внутрь
        if (currSideX < outerLimit) {
          state.playerX = side * outerLimit;
          if (side * state.playerVX < 0) {
            state.playerVX = side * Math.abs(state.playerVX) * 0.30;
          }
          hitRail = true;
        }
      }

      if (hitRail) {
        if (prevSideX <= rampCaptureLimit && side * state.playerVX > 0) {
          state.playerVX = -side * Math.abs(state.playerVX) * 0.35;
        }
        state.speed *= Math.exp(-GUARDRAIL_SPEED_DECAY_RATE * dt);
        const scrapeIntensity = MathUtil.clamp(Math.abs(state.speed) / (MAX_SPEED * 0.5), 0, 1);
        state.impactShake = Math.max(state.impactShake, 0.16 * scrapeIntensity);
        if (Math.abs(state.speed) > 35) {
          if (Math.random() < Math.min(1, 0.9 * step60)) {
            spawnParticles(
              anchors.rearCenterX + side * carHalfScreenW,
              anchors.rearCenterY,
              2,
              '#ffbe0b',
              110,
              70,
              RANGE_RAIL_SPARK_SIZE,
              RANGE_RAIL_SPARK_LIFE
            );
          }
          if (state.guardrailSoundCooldown <= 0) {
            state.guardrailSoundCooldown = 0.14;
            audio.playGuardrailScrape();
          }
        }
      }
    }
  }

  state.playerX = MathUtil.clamp(state.playerX, -PLAYER_MAX_LATERAL_X, PLAYER_MAX_LATERAL_X);

  const steerVisualScale = state.speed < 0 ? 0.4 : 1.0;
  const targetSteerVisual = Math.abs(state.speed) > 15 ? steerDir * steerVisualScale : 0;
  state.steerVisual = MathUtil.lerp(state.steerVisual, targetSteerVisual, expSmoothing(11.0, dt));

  // Следы торможения и дым из-под задних шин 3D-модели
  const rearAxleCamZ = PLAYER_Z + PLAYER_CENTER_OFFSET_Z - PLAYER_LEN_Z * 0.38;
  const rearTireWorldZ = (((state.position + rearAxleCamZ) % trackLength) + trackLength) % trackLength;
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

      // Частотно-независимая генерация дыма с предрасчитанной палитрой цветов (0 аллокаций строк и массивов)
      const exactPuffs = (0.35 + smokeRatio * 3.15) * step60;
      const basePuffs = Math.floor(exactPuffs);
      const extraPuffChance = exactPuffs - basePuffs;

      const paletteIdx = Math.round(smokeRatio * SMOKE_ALPHA_STEPS);
      const lightSmokeColor = TIRE_SMOKE_LIGHT_COLORS[paletteIdx];
      const midSmokeColor = TIRE_SMOKE_MID_COLORS[paletteIdx];

      _dynSizeRange[0] = 4 + smokeRatio * 4;
      _dynSizeRange[1] = 7 + smokeRatio * 12;
      _dynLifeRange[0] = 0.24 + smokeRatio * 0.14;
      _dynLifeRange[1] = 0.42 + smokeRatio * 0.34;
      const vxSpread = 45 + smokeRatio * 85;
      const vyBase = 32 + smokeRatio * 60;
      const expandRate = 8 + smokeRatio * 10;

      for (let sideIdx = 0; sideIdx < 2; sideIdx++) {
        const puffsForWheel = basePuffs + (Math.random() < extraPuffChance ? 1 : 0);
        if (puffsForWheel <= 0) continue;

        const wx = sideIdx === 0 ? anchors.leftWheelX : anchors.rightWheelX;
        const wy = sideIdx === 0 ? anchors.leftWheelY : anchors.rightWheelY;
        const outwardBias = sideIdx === 0 ? -18 : 18;
        const chosenColor = ((sideIdx + (Math.random() < 0.5 ? 0 : 1)) & 1) === 0 ? lightSmokeColor : midSmokeColor;

        spawnParticles(
          wx + outwardBias * (0.25 + smokeRatio * 0.25),
          wy,
          puffsForWheel,
          chosenColor,
          vxSpread,
          vyBase,
          _dynSizeRange,
          _dynLifeRange,
          -28,
          expandRate
        );
      }
    }
  } else {
    state.prevSkidSample = null;
  }

  if (segments.length > 0 && state.speed !== 0) {
    const signedSpeedRatio = state.speed / MAX_SPEED;
    const curveScroll = midStepCurve * signedSpeedRatio * dt;
    // Период 2 для skyOffset обеспечивает бесшовный цикл и для солнца (период 1), и для звёзд (0.5x -> период 2)
    state.skyOffset = MathUtil.wrap(state.skyOffset + curveScroll * 0.08, 2);
    state.hillOffset = MathUtil.wrap(state.hillOffset + curveScroll * 0.22, 1);
    state.cityOffset = MathUtil.wrap(state.cityOffset + curveScroll * 0.44, 1);
  }

  const currentKmh = Math.round((Math.abs(state.speed) / MAX_SPEED) * BASE_MAX_KMH);
  if (state.speed > 0 && currentKmh > state.maxKmhReached) state.maxKmhReached = currentKmh;

  // 5. Обновление трафика / соперников
  maintainTrafficDensity();
  updateTrafficOnly(dt, true);

  // 6. Непрерывные (swept) коллизии с машинами (отскок пропорционален скорости контакта)
  let playerWorldZ = getPlayerWorldZ();
  const collisionCenterSeg = findSegment(playerWorldZ);
  if (collisionCenterSeg) {
    const scanSpan = Math.max(3, Math.ceil((Math.abs(state.speed) * dt + MAX_SPEED * dt) / SEGMENT_LENGTH) + 2);
    _checkedCars.clear();
    for (let offset = -scanSpan; offset <= scanSpan; offset++) {
      const segIdx = (collisionCenterSeg.index + offset + segments.length) % segments.length;
      const seg = segments[segIdx];
      for (let i = 0; i < seg.cars.length; i++) {
        const car = seg.cars[i];
        if (_checkedCars.has(car)) continue;
        _checkedCars.add(car);

        const baseBlockDistZ = ((PLAYER_LEN_Z + (car.lenZ || SEGMENT_LENGTH * 1.3)) * 0.5) * 0.88;
        const dz = getShortestTrackDz(playerWorldZ, car.z, trackLength);
        const relVelZ = state.speed - car.speed * car.dir;
        const prevDz = dz + relVelZ * dt;
        const minDz = Math.min(prevDz, dz);
        const maxDz = Math.max(prevDz, dz);

        if (maxDz > -baseBlockDistZ && minDz < baseBlockDistZ) {
          const carNormX = car.x / ROAD_WIDTH;
          if (MathUtil.overlap(state.playerX, PLAYER_WIDTH_NORM, carNormX, car.w, 0.90)) {
            const dx = state.playerX - carNormX;
            const combinedHalfW = (PLAYER_WIDTH_NORM + car.w) * 0.5;
            const overlapRatio = Math.abs(dx) / Math.max(0.01, combinedHalfW);
            const pushSign = dx >= 0 ? 1 : -1;
            const wasAhead = prevDz > 12;

            // Масштабирование отскока, тряски и искр пропорционально реальной скорости удара
            const absRelVelZ = Math.abs(relVelZ);
            const longBounceScale = MathUtil.clamp(absRelVelZ / (MAX_SPEED * 0.55), 0, 1.25);
            const sideBounceScale = MathUtil.clamp(
              Math.max(Math.abs(state.speed), absRelVelZ) / (MAX_SPEED * 0.55),
              0,
              1.15
            );

            if (car.isRival) {
              const isRivalRearBump =
                overlapRatio < 0.72 &&
                (prevDz >= baseBlockDistZ * 0.78 || (dz > baseBlockDistZ * 0.55 && state.speed > car.speed));
              const isRivalBackingHit =
                overlapRatio < 0.72 &&
                (prevDz <= -baseBlockDistZ * 0.78 || dz < -baseBlockDistZ * 0.55) &&
                state.speed < 0;

              if (isRivalRearBump) {
                const penetration = Math.min(baseBlockDistZ * 2.2, Math.max(0, baseBlockDistZ - dz));
                shiftPlayerZ(-penetration, trackLength);
                playerWorldZ = getPlayerWorldZ();
              } else if (isRivalBackingHit) {
                const penetration = Math.min(baseBlockDistZ * 2.2, Math.max(0, baseBlockDistZ + dz));
                shiftPlayerZ(penetration, trackLength);
                playerWorldZ = getPlayerWorldZ();
                state.speed = 0;
              } else {
                const minSepX = combinedHalfW * 0.92;
                state.playerX = MathUtil.clamp(carNormX + pushSign * minSepX, -PLAYER_MAX_LATERAL_X, PLAYER_MAX_LATERAL_X);
              }

              if (car.hitCooldown <= 0) {
                const activeScale = (isRivalRearBump || isRivalBackingHit) ? longBounceScale : sideBounceScale;
                car.hitCooldown = 0.35;
                state.impactShake = Math.max(state.impactShake, 0.65 * MathUtil.clamp(activeScale, 0.12, 1.0));
                audio.playCrash(MathUtil.clamp(0.65 * Math.max(0.28, activeScale), 0.18, 0.85));

                if (isRivalRearBump) {
                  car.speed = Math.min(MAX_SPEED * 0.995, Math.max(car.speed, state.speed * 0.96));
                  state.speed = Math.min(state.speed * GAME_CONFIG.circuit.rearBumpSlowdownRatio, car.speed * 0.96);
                  state.playerVX += dx * 1.15 * longBounceScale;
                } else if (!isRivalBackingHit) {
                  state.speed *= GAME_CONFIG.circuit.impactSlowdownRatio;
                  state.playerVX += pushSign * 1.05 * sideBounceScale;
                  car.vx -= pushSign * 0.85 * sideBounceScale;
                }

                const sparkCount = Math.round(10 * MathUtil.clamp(activeScale, 0, 1));
                if (sparkCount > 0) {
                  spawnParticles(
                    anchors.centerX - dx * anchors.carW * 1.3,
                    anchors.centerY,
                    sparkCount,
                    '#ffbe0b',
                    190,
                    120,
                    RANGE_RIVAL_SPARK_SIZE,
                    RANGE_RIVAL_SPARK_LIFE
                  );
                }
              }
              continue;
            }

            const impactSpeedKmh = Math.round((Math.abs(state.speed) / MAX_SPEED) * BASE_MAX_KMH);
            const isFrontalHit = overlapRatio < 0.65;
            const isHeadOn = car.dir === -1 && (dz > 12 || wasAhead) && isFrontalHit;
            const isRearEnd =
              car.dir === 1 &&
              overlapRatio < 0.72 &&
              (prevDz >= baseBlockDistZ * 0.78 || (dz > baseBlockDistZ * 0.55 && state.speed > car.speed));
            const isBackingHit =
              overlapRatio < 0.72 &&
              (prevDz <= -baseBlockDistZ * 0.78 || dz < -baseBlockDistZ * 0.55) &&
              state.speed < 0;
            const hitSide = dx > 0.03 ? 'left' : (dx < -0.03 ? 'right' : 'center');
            const hitZone = isBackingHit ? 'rear' : ((isHeadOn || isRearEnd) ? 'front' : 'side');

            if (isHeadOn || isRearEnd) {
              const penetration = Math.min(baseBlockDistZ * 2.2, Math.max(0, baseBlockDistZ - dz));
              shiftPlayerZ(-penetration, trackLength);
              playerWorldZ = getPlayerWorldZ();
              const carForwardVel = Math.max(0, car.speed * car.dir);
              if (state.speed > carForwardVel) {
                state.speed = isHeadOn ? 0 : carForwardVel;
              }
            } else if (isBackingHit) {
              const penetration = Math.min(baseBlockDistZ * 2.2, Math.max(0, baseBlockDistZ + dz));
              shiftPlayerZ(penetration, trackLength);
              playerWorldZ = getPlayerWorldZ();
              state.speed = 0;
            } else {
              const minSepX = combinedHalfW * 0.92;
              state.playerX = MathUtil.clamp(carNormX + pushSign * minSepX, -PLAYER_MAX_LATERAL_X, PLAYER_MAX_LATERAL_X);
              if (car.dir === -1 && state.speed > 0) {
                state.speed *= 0.72;
              }
            }

            if (car.hitCooldown <= 0) {
              const activeScale = (isHeadOn || isRearEnd || isBackingHit) ? longBounceScale : sideBounceScale;
              car.hitCooldown = 1.5;
              state.impactShake = Math.max(state.impactShake, MathUtil.clamp(activeScale, 0.14, 1.0));

              if (isHeadOn) {
                audio.playCrash(MathUtil.clamp(1.35 * Math.max(0.3, longBounceScale), 0.35, 1.35));
                car.speed = 0;
                car.braking = true;
                car.damagedByPlayer = true;
                car.targetX = car.x;
                state.speed = 0;
                state.playerVX += pushSign * (0.85 + overlapRatio * 0.95) * longBounceScale;
              } else if (isRearEnd) {
                audio.playCrash(MathUtil.clamp(1.0 * Math.max(0.25, longBounceScale), 0.25, 1.05));
                car.braking = true;
                car.damagedByPlayer = true;
                car.brakeForce = MAX_SPEED * 0.65;
                car.targetX = car.x;
                if (car.dir === 1) {
                  state.speed = Math.min(state.speed, Math.max(0, car.speed * 0.75));
                }
                state.playerVX += pushSign * Math.max(0.95, Math.abs(dx) * 1.9) * longBounceScale;
              } else if (isBackingHit) {
                audio.playCrash(MathUtil.clamp(0.65 * Math.max(0.25, longBounceScale), 0.18, 0.75));
                car.braking = true;
                car.damagedByPlayer = true;
                car.brakeForce = MAX_SPEED * 0.65;
                car.targetX = car.x;
                state.speed = 0;
                state.playerVX += dx * 1.2 * longBounceScale;
              } else {
                audio.playCrash(MathUtil.clamp(0.75 * Math.max(0.25, sideBounceScale), 0.20, 0.85));
                car.braking = true;
                car.damagedByPlayer = true;
                car.brakeForce = MAX_SPEED * 0.65;
                state.speed *= 0.80;
                state.playerVX += pushSign * 1.45 * sideBounceScale;
                car.x = MathUtil.clamp(car.x - pushSign * 120 * sideBounceScale, -ROAD_WIDTH * 0.82, ROAD_WIDTH * 0.82);
                car.targetX = car.x;
              }

              const sparkCount = Math.round(14 * MathUtil.clamp(activeScale, 0, 1));
              if (sparkCount > 0) {
                spawnParticles(
                  anchors.centerX - dx * anchors.carW * 1.3,
                  anchors.centerY,
                  sparkCount,
                  '#ffbe0b',
                  220,
                  140,
                  RANGE_CRASH_SPARK_SIZE,
                  RANGE_CRASH_SPARK_LIFE
                );
              }

              _hitContext.side = hitSide;
              _hitContext.zone = hitZone;
              const isOncomingCar = car.dir === -1;
              if (isOncomingCar) {
                if (!isHeadOn) {
                  if (registerCollision(1, t('goCarWrecked'), _hitContext)) return;
                } else {
                  const instantWreckKmh = GAME_CONFIG.gameplay.headOnInstantWreckKmh;
                  const oncomingDmg = impactSpeedKmh >= instantWreckKmh
                    ? MAX_HARDCORE_COLLISIONS
                    : Math.max(1, Math.floor(impactSpeedKmh / 20));
                  const fatalMsg = impactSpeedKmh >= instantWreckKmh
                    ? t('goHeadOnWreck', { kmh: impactSpeedKmh })
                    : t('goCarWrecked');
                  if (registerCollision(oncomingDmg, fatalMsg, _hitContext)) return;
                }
              } else {
                if (registerCollision(1, t('goCarWrecked'), _hitContext)) return;
              }
            }
          }
        }
      }
    }
  }

  // 7. Фиксация дистанции, очков, кругов и чекпоинтов по итоговой (пост-коллизионной) позиции кадра
  const newPlayerSeg = findSegment(playerWorldZ);
  const netFrameDz = state.netForwardZ - prevNetForwardZ;

  if (state.gameMode === 'circuit') {
    if (state.netForwardZ > state.maxNetForwardZ) {
      const newForwardDelta = state.netForwardZ - state.maxNetForwardZ;
      state.maxNetForwardZ = state.netForwardZ;
      state.distanceMeters += newForwardDelta / WORLD_UNITS_PER_METER;
    }

    // Засекаем фактическое начало 1-го круга в момент пересечения линии старта (без лишних 13м решётки)
    if (prevProgressZ < 0 && state.playerProgressZ >= 0) {
      state.currentLapStartTime = state.raceElapsedTime;
    }

    if (state.playerProgressZ >= state.circuitCurrentLap * trackLength) {
      const lapDuration = state.raceElapsedTime - state.currentLapStartTime;
      const lapDistKm = trackLength / (WORLD_UNITS_PER_METER * 1000);
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
        triggerGameOver(t('goFinishPlace', { place: formatPlaceText(state.playerRank) }));
        return;
      } else {
        audio.playCheckpoint();
        if (state.circuitCurrentLap === state.circuitTotalLaps) {
          showBanner(
            t('bannerFinalLap', { lap: state.circuitCurrentLap, total: state.circuitTotalLaps }),
            '#ffbe0b',
            2.2
          );
        } else {
          showBanner(
            t('bannerLapTime', {
              lap: state.circuitCurrentLap,
              total: state.circuitTotalLaps,
              time: formatRaceTime(lapDuration)
            }),
            '#39ff14',
            2.0
          );
        }
      }
    }

    computeCircuitRank();
  } else {
    if (state.netForwardZ > state.maxNetForwardZ) {
      const newForwardDelta = state.netForwardZ - state.maxNetForwardZ;
      state.maxNetForwardZ = state.netForwardZ;
      const metersDelta = newForwardDelta / WORLD_UNITS_PER_METER;
      state.distanceMeters += metersDelta;

      const scoreMultiplier = isOncomingBonusActive() ? GAME_CONFIG.gameplay.oncomingScoreMultiplier : 1.0;
      state.score += metersDelta * SCORE_PER_METER * (1 + forwardSpeedRatio * 2.5) * scoreMultiplier;
    }

    if (netFrameDz > 0 && oldPlayerSeg && newPlayerSeg && oldPlayerSeg !== newPlayerSeg) {
      const totalSegs = segments.length;
      let stepIdx = (oldPlayerSeg.index + 1) % totalSegs;
      let safety = 0;
      let traversedZ = prevNetForwardZ;
      while (safety < 15) {
        traversedZ += SEGMENT_LENGTH;
        if (segments[stepIdx].isCheckpoint) {
          const lapIdx = Math.max(0, Math.round((traversedZ - stepIdx * SEGMENT_LENGTH) / trackLength));
          const isStartLineReverseExploit = stepIdx === 0 && lapIdx < 1;
          const checkpointUid = lapIdx * totalSegs + stepIdx;
          if (!isStartLineReverseExploit && !state.passedCheckpointUids.has(checkpointUid)) {
            state.passedCheckpointUids.add(checkpointUid);
            state.checkpointsPassed++;
            const bonusTime = Math.max(
              GAME_CONFIG.gameplay.checkpointMinBonusSec,
              GAME_CONFIG.gameplay.checkpointBaseBonusSec - Math.floor(state.checkpointsPassed * 0.8)
            );
            state.timeLeft = Math.min(GAME_CONFIG.gameplay.maxTimeSec, state.timeLeft + bonusTime);
            state.score += GAME_CONFIG.gameplay.checkpointScoreBonus * state.checkpointsPassed;
            audio.playCheckpoint();
            showBanner(t('bannerCheckpoint', { sec: bonusTime }), '#00f0ff', 2.1);
          }
        }
        if (stepIdx === newPlayerSeg.index) break;
        stepIdx = (stepIdx + 1) % totalSegs;
        safety++;
      }
    }
  }

  // 8. Коллизии с придорожными объектами (быстрое отсечение на асфальте + swept-проверка по Z)
  if (newPlayerSeg && state.spriteHitCooldown <= 0 && Math.abs(state.playerX) > 1.05) {
    const totalSegs = segments.length;
    _segIndicesToCheck.length = 0;
    _visitedSegs.clear();

    if (oldPlayerSeg && netFrameDz !== 0) {
      const dirStep = netFrameDz > 0 ? 1 : -1;
      let idx = oldPlayerSeg.index;
      let safety = 0;
      while (safety < 15) {
        addCandidateSpriteSeg(idx, totalSegs);
        if (idx === newPlayerSeg.index) break;
        idx = (idx + dirStep + totalSegs) % totalSegs;
        safety++;
      }
    } else {
      addCandidateSpriteSeg(newPlayerSeg.index, totalSegs);
    }

    addCandidateSpriteSeg(newPlayerSeg.index - 1, totalSegs);
    addCandidateSpriteSeg(newPlayerSeg.index + 1, totalSegs);

    const spriteHalfZ = PLAYER_LEN_Z * 0.45;
    let hitResolved = false;

    for (let s = 0; s < _segIndicesToCheck.length && !hitResolved; s++) {
      const seg = segments[_segIndicesToCheck[s]];
      if (!seg.sprites.length) continue;

      const dzCurr = getShortestTrackDz(playerWorldZ, seg.p1.world.z, trackLength);
      const dzPrev = dzCurr + netFrameDz;
      const minSpriteDz = Math.min(dzCurr, dzPrev);
      const maxSpriteDz = Math.max(dzCurr, dzPrev);
      if (maxSpriteDz <= -spriteHalfZ || minSpriteDz >= spriteHalfZ) continue;

      for (let i = 0; i < seg.sprites.length; i++) {
        const sp = seg.sprites[i];
        let collidedOffset = null;
        let collidedWidth = 0;

        if (sp.type === 'start_arch' || sp.type === 'checkpoint_arch') {
          for (let k = 0; k < ARCH_HIT_TARGETS.length; k++) {
            const target = ARCH_HIT_TARGETS[k];
            if (MathUtil.overlap(state.playerX, PLAYER_WIDTH_NORM, target.offset, target.width, 0.90)) {
              collidedOffset = target.offset;
              collidedWidth = target.width;
              break;
            }
          }
        } else {
          const hitW = SPRITE_HITBOX_WIDTHS[sp.type] || 0.08;
          if (MathUtil.overlap(state.playerX, PLAYER_WIDTH_NORM, sp.offset, hitW, 0.90)) {
            collidedOffset = sp.offset;
            collidedWidth = hitW;
          }
        }

        if (collidedOffset !== null) {
          hitResolved = true;
          const obsBounce = MathUtil.clamp(Math.abs(state.speed) / (MAX_SPEED * 0.55), 0, 1.15);
          state.spriteHitCooldown = 0.45;
          state.impactShake = Math.max(state.impactShake, 0.95 * MathUtil.clamp(obsBounce, 0.14, 1.0));
          audio.playCrash(MathUtil.clamp(1.0 * Math.max(0.25, obsBounce), 0.20, 1.05));

          const pushSign = state.playerX >= collidedOffset ? 1 : -1;
          const minSep = (PLAYER_WIDTH_NORM + collidedWidth) * 0.52;
          state.playerX = MathUtil.clamp(collidedOffset + pushSign * minSep, -PLAYER_MAX_LATERAL_X, PLAYER_MAX_LATERAL_X);
          state.playerVX = pushSign * 1.1 * obsBounce;

          const sparkCount = Math.round(14 * MathUtil.clamp(obsBounce, 0, 1));
          if (sparkCount > 0) {
            spawnParticles(
              anchors.centerX,
              anchors.centerY,
              sparkCount,
              '#ffbe0b',
              220,
              140,
              RANGE_CRASH_SPARK_SIZE,
              RANGE_CRASH_SPARK_LIFE
            );
          }

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
              ? t('goObstacleWreck', { kmh: impactKmh })
              : t('goCarWrecked');
            _hitContext.side = pushSign > 0 ? 'left' : 'right';
            _hitContext.zone = netFrameDz < 0 ? 'rear' : 'front';
            if (registerCollision(obstacleDmg, fatalReason, _hitContext)) return;
          }
          break;
        }
      }
    }
  }

  // 9. Камера и звук
  updateCameraDynamics(dt);
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