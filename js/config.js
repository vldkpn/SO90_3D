/**
 * ============================================================================
 * ГЛАВНЫЕ НАСТРОЙКИ И КОНСТАНТЫ ИГРЫ (SUNSET OVERDRIVE '90 — 3D EDITION)
 * ============================================================================
 */
export const GAME_CONFIG = {
  screen: {
    aspectRatio: 16 / 9,
    mobileAspectRatio: 4 / 3,
    logicalHeight: 540,
    fieldOfView: 100,
    cameraHeight: 1150,
    drawDistance: 300,
    fogDensity: 1.6,
    starCount: 65,
    maxFrameDeltaSec: 0.05
  },

  road: {
    width: 2000,
    segmentLength: 200,
    rumbleLength: 5,
    checkpointInterval: 450
  },

  physics: {
    baseMaxKmh: 320,
    speedPenaltyPerHitKmh: 20,
    minAllowedMaxKmh: 120,
    maxReverseKmh: 20,

    accelTimeToMaxSec: 5.2,
    reverseAccelRatio: 0.095,
    brakeHighSpeedRatio: 0.44,
    brakeLowSpeedRatio: 0.58,
    coastDecelDivisor: 10.5,
    offRoadDecelDivisor: 2.2,
    offRoadSpeedLimitRatio: 0.34,

    centrifugalForce: 0.34,
    steerSensitivity: 2.05,
    reverseSteerSensitivity: 0.42,
    maxLateralX: 2.35
  },

  gameplay: {
    defaultTrackMode: 'oneway',
    defaultDifficulty: 'arcade',

    initialTimeSec: 45.0,
    maxTimeSec: 99.0,
    checkpointBaseBonusSec: 24,
    checkpointMinBonusSec: 14,
    checkpointScoreBonus: 500,
    // Базовые очки за 1 реальный метр пути (сохраняет исходный темп набора счёта)
    scorePerMeter: 5.85,
    oncomingScoreMultiplier: 2.0,

    collisionTimePenaltySec: 5.0,
    maxHardcoreCollisions: 5,
    headOnInstantWreckKmh: 100,
    obstacleInstantWreckKmh: 210,

    engineHeatRate: 21,
    engineCoolRate: 15,
    engineOverheatCoolRate: 19,
    engineOverheatRecoverPct: 35,
    overheatSpeedCapRatio: 0.54
  },

  traffic: {
    initialCount: 34,
    maxCount: 68,
    // Пересчитано под реальный масштаб метров (220 / 5.85 ≈ 38 м) для сохранения темпа уплотнения потока
    metersPerExtraCar: 38,
    // Дистанция выхода трафика на максимальную прогрессию скорости (5000 / 5.85 ≈ 860 м)
    progressionDistanceMeters: 860,
    carTypes: [
      { type: 'coupe', w: 0.18, h: 1.00, lenZ: 255, primary: '#00e5ff', secondary: '#0077b6', speedMult: 1.02 },
      { type: 'sport', w: 0.19, h: 0.94, lenZ: 265, primary: '#ffbe0b', secondary: '#fb5607', speedMult: 1.18 },
      { type: 'van',   w: 0.21, h: 1.28, lenZ: 295, primary: '#9b5de5', secondary: '#5a189a', speedMult: 0.80 },
      { type: 'sedan', w: 0.18, h: 1.04, lenZ: 260, primary: '#39ff14', secondary: '#1b7a0a', speedMult: 0.94 }
    ]
  },

  circuit: {
    totalLaps: 3,
    rivalsCount: 7,
    minSegments: 520,
    maxSegments: 660,
    countdownSec: 2.7,
    finishGraceSec: 15.0,
    impactSlowdownRatio: 0.85,
    rearBumpSlowdownRatio: 0.78,
    obstacleSlowdownRatio: 0.45,
    guardrailCurveThreshold: 4.5,
    botMistakeChance: 0.28,
    botBumpChance: 0.35,
    slipstreamBoostRatio: 1.05,
    rivals: [
      { name: 'VIPER',   num: '02', primary: '#00f0ff', secondary: '#005f73', w: 0.185, h: 0.96, lenZ: 265, skill: 0.97 },
      { name: 'BLAZE',   num: '03', primary: '#ffbe0b', secondary: '#fb5607', w: 0.185, h: 0.96, lenZ: 265, skill: 0.95 },
      { name: 'PHANTOM', num: '04', primary: '#9b5de5', secondary: '#3c096c', w: 0.185, h: 0.96, lenZ: 265, skill: 0.93 },
      { name: 'NITRO',   num: '05', primary: '#39ff14', secondary: '#134e07', w: 0.185, h: 0.96, lenZ: 265, skill: 0.91 },
      { name: 'COBRA',   num: '06', primary: '#ff5400', secondary: '#6a040f', w: 0.185, h: 0.96, lenZ: 265, skill: 0.89 },
      { name: 'PULSE',   num: '07', primary: '#f72585', secondary: '#560bad', w: 0.185, h: 0.96, lenZ: 265, skill: 0.87 },
      { name: 'DRIFT',   num: '08', primary: '#4cc9f0', secondary: '#3a0ca3', w: 0.185, h: 0.96, lenZ: 265, skill: 0.85 }
    ]
  },

  playerVisuals: {
    hitboxWidthNorm: 0.185,
    rearTireBottomOffsetPx: 25,
    carCenterBottomOffsetPx: 54,
    maxSkidMarks: 640,
    tireSmokeMinKmh: 50
  },

  settings: {
    particlesEnabled: true,
    lightStyle: 'hard',
    soundEnabled: true
  },

  storage: {
    bestScoreKey: 'sunset_overdrive_best',
    bestLapSpeedKey: 'sunset_overdrive_best_lap_kmh',
    settingsKey: 'sunset_overdrive_settings'
  }
};

export const STATE = {
  TITLE: 0,
  PLAYING: 1,
  GAMEOVER: 2
};

// Производные константы экрана и проекции
export const LOGICAL_HEIGHT = GAME_CONFIG.screen.logicalHeight;
export const REFERENCE_ASPECT_RATIO = 16 / 9;
export const PROJ_HALF_WIDTH = LOGICAL_HEIGHT * REFERENCE_ASPECT_RATIO * 0.5;

export const ROAD_WIDTH = GAME_CONFIG.road.width;
export const SEGMENT_LENGTH = GAME_CONFIG.road.segmentLength;
export const RUMBLE_LENGTH = GAME_CONFIG.road.rumbleLength;
export const BASE_FOV = GAME_CONFIG.screen.fieldOfView;
export const CAMERA_HEIGHT = GAME_CONFIG.screen.cameraHeight;
export const CAMERA_DEPTH = 1 / Math.tan((BASE_FOV / 2) * Math.PI / 180);
export const DRAW_DISTANCE = GAME_CONFIG.screen.drawDistance;
export const FOG_DENSITY = GAME_CONFIG.screen.fogDensity;
export const CHECKPOINT_INTERVAL = GAME_CONFIG.road.checkpointInterval;

// Продольные размеры и дистанции по оси Z
export const PLAYER_LEN_Z = SEGMENT_LENGTH * 1.325;
export const PLAYER_CENTER_OFFSET_Z = SEGMENT_LENGTH * 0.325;
export const SAFE_BUMPER_GAP_Z = SEGMENT_LENGTH * 1.5;
export const TRAFFIC_SCAN_DIST_Z = SEGMENT_LENGTH * 9.75;
export const HEADLIGHT_BEAM_DIST_Z = SEGMENT_LENGTH * 21.0;
export const ONCOMING_DETECT_DIST_Z = SEGMENT_LENGTH * 21.0;
export const ONCOMING_HORN_DIST_Z = SEGMENT_LENGTH * 17.0;

// Физика автомобиля и точный перевод мировых единиц в метры
export const BASE_MAX_KMH = GAME_CONFIG.physics.baseMaxKmh;
export const SPEED_PENALTY_PER_COLLISION_KMH = GAME_CONFIG.physics.speedPenaltyPerHitKmh;
export const MIN_ALLOWED_MAX_KMH = GAME_CONFIG.physics.minAllowedMaxKmh;
export const WORLD_SPEED_SCALE = (SEGMENT_LENGTH * 65) / 320;
// 1 м/с = 3.6 км/ч => мировых единиц в 1 метре ровно WORLD_SPEED_SCALE * 3.6 (146.25)
export const WORLD_UNITS_PER_METER = WORLD_SPEED_SCALE * 3.6;
export const MAX_SPEED = BASE_MAX_KMH * WORLD_SPEED_SCALE;
export const MAX_REVERSE_KMH = GAME_CONFIG.physics.maxReverseKmh;
export const MAX_REVERSE_SPEED = MAX_SPEED * (MAX_REVERSE_KMH / BASE_MAX_KMH);
export const ACCEL = MAX_SPEED / GAME_CONFIG.physics.accelTimeToMaxSec;
export const REVERSE_ACCEL = MAX_SPEED * GAME_CONFIG.physics.reverseAccelRatio;
export const BRAKE_HIGH_SPEED = -MAX_SPEED * GAME_CONFIG.physics.brakeHighSpeedRatio;
export const BRAKE_LOW_SPEED = -MAX_SPEED * GAME_CONFIG.physics.brakeLowSpeedRatio;
export const DECEL = -MAX_SPEED / GAME_CONFIG.physics.coastDecelDivisor;
export const OFF_ROAD_DECEL = -MAX_SPEED / GAME_CONFIG.physics.offRoadDecelDivisor;
export const OFF_ROAD_LIMIT = MAX_SPEED * GAME_CONFIG.physics.offRoadSpeedLimitRatio;
export const CENTRIFUGAL_FORCE = GAME_CONFIG.physics.centrifugalForce;
export const STEER_SENSITIVITY = GAME_CONFIG.physics.steerSensitivity;
export const REVERSE_STEER_SENSITIVITY = GAME_CONFIG.physics.reverseSteerSensitivity;
export const PLAYER_MAX_LATERAL_X = GAME_CONFIG.physics.maxLateralX;
export const OFF_ROAD_THRESHOLD_X = 1.14;

// Правила заезда и трафик
export const COLLISION_TIME_PENALTY = GAME_CONFIG.gameplay.collisionTimePenaltySec;
export const SCORE_PER_METER = GAME_CONFIG.gameplay.scorePerMeter;
export const MAX_SKID_MARKS = GAME_CONFIG.playerVisuals.maxSkidMarks;
export const INITIAL_TRAFFIC_COUNT = GAME_CONFIG.traffic.initialCount;
export const MAX_TRAFFIC_COUNT = GAME_CONFIG.traffic.maxCount;
export const METERS_PER_EXTRA_CAR = GAME_CONFIG.traffic.metersPerExtraCar;
export const TRAFFIC_PROGRESSION_METERS = GAME_CONFIG.traffic.progressionDistanceMeters;
export const MAX_HARDCORE_COLLISIONS = GAME_CONFIG.gameplay.maxHardcoreCollisions;
export const PLAYER_WIDTH_NORM = GAME_CONFIG.playerVisuals.hitboxWidthNorm;
export const CAR_TYPES = GAME_CONFIG.traffic.carTypes;

// Проекция базы игрока и задних шин
export const PLAYER_CENTER_SCREEN_Y = LOGICAL_HEIGHT - GAME_CONFIG.playerVisuals.carCenterBottomOffsetPx;
export const PLAYER_Z =
  (CAMERA_HEIGHT * CAMERA_DEPTH) /
  ((PLAYER_CENTER_SCREEN_Y - LOGICAL_HEIGHT * 0.5) / (LOGICAL_HEIGHT * 0.5));

export const REAR_TIRE_SCREEN_Y = LOGICAL_HEIGHT - GAME_CONFIG.playerVisuals.rearTireBottomOffsetPx;
export const REAR_TIRE_CAM_Z =
  (CAMERA_HEIGHT * CAMERA_DEPTH) /
  ((REAR_TIRE_SCREEN_Y - LOGICAL_HEIGHT * 0.5) / (LOGICAL_HEIGHT * 0.5));
export const REAR_TIRE_SCALE = CAMERA_DEPTH / REAR_TIRE_CAM_Z;
export const REAR_TIRE_ROAD_HALF_PX = REAR_TIRE_SCALE * ROAD_WIDTH * PROJ_HALF_WIDTH;
export const WHEEL_TRACK_OFFSET = PLAYER_WIDTH_NORM * 0.375;
export const WHEEL_SKID_HALF_W = 11.5 / REAR_TIRE_ROAD_HALF_PX;