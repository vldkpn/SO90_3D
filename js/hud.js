import {
  GAME_CONFIG,
  STATE,
  LOGICAL_HEIGHT,
  SEGMENT_LENGTH,
  BASE_MAX_KMH,
  MAX_SPEED,
  MAX_REVERSE_SPEED,
  COLLISION_TIME_PENALTY,
  MAX_HARDCORE_COLLISIONS
} from './config.js';
import { MathUtil, formatRaceTime } from './utils.js';
import {
  state,
  findSegment,
  getPlayerWorldZ,
  getCurrentMaxAllowedKmh,
  isOncomingBonusActive
} from './state.js';
import { getLang, getNumberLocale, t } from './i18n.js';

// Единый стек шрифтов, синхронизированный с css/styles.css
const UI_FONT = "'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif";
// Порог подсветки крутого поворота на миникарте (синхронизирован с js/track.js)
const SHARP_CURVE_THRESHOLD = 5.8;

let minimapCacheCanvas = null;

// Переиспользуемый объект позы на миникарте (0 аллокаций за кадр)
const _mapPose = { mapX: 0, mapY: 0, mapHeading: 0 };

// Кэш линейного градиента шкалы скорости (пересоздаётся только при смене ширины экрана)
let cachedSpeedGrad = null;
let cachedSpeedGradX = -1;
let cachedSpeedGradW = -1;

// Кэш привязки счётчика FPS к реальным CSS-габаритам кнопки звука на ПК
let desktopMuteBtnEl = null;
let cachedFpsLayoutKey = '';
let cachedDesktopFpsRightPad = 10;
let cachedDesktopFpsY = 30;

/**
 * Общий хелпер отрисовки скруглённой HUD-карточки с заливкой и рамкой
 */
function drawHudCard(ctx, x, y, w, h, radius, fillColor, strokeColor = null, lineWidth = 1.5) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  if (fillColor) {
    ctx.fillStyle = fillColor;
    ctx.fill();
  }
  if (strokeColor) {
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
}

/**
 * Общий хелпер шкалы температуры и перегрева двигателя (для режима «Нормально»)
 */
function drawEngineHeatMeter(ctx, x, textY, barY, width) {
  ctx.fillStyle = state.isOverheated ? '#ff2a85' : '#00f0ff';
  ctx.font = `800 10.5px ${UI_FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText(
    state.isOverheated ? t('hudOverheat') : t('hudEngineTemp', { pct: Math.round(state.engineHeat) }),
    x,
    textY
  );

  ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.fillRect(x, barY, width, 7);

  const heatColor = state.isOverheated
    ? '#ff2a85'
    : (state.engineHeat > 75 ? '#ffbe0b' : '#00f0ff');
  ctx.fillStyle = heatColor;
  ctx.fillRect(x, barY, width * MathUtil.clamp(state.engineHeat / 100, 0, 1), 7);
}

/**
 * Векторная иконка Check Engine (ISO 7000 / MIL), как на приборной панели реального автомобиля
 */
function drawCheckEngineIcon(ctx, cx, cy, scale, isLit) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);

  const strokeColor = isLit ? '#ffaa00' : 'rgba(255, 130, 0, 0.42)';
  const fillColor = isLit ? 'rgba(255, 158, 0, 0.26)' : 'rgba(255, 110, 0, 0.08)';

  ctx.strokeStyle = strokeColor;
  ctx.fillStyle = fillColor;
  ctx.lineWidth = 1.55;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // Основной силуэт блока двигателя с поддоном и задним фланцем
  ctx.beginPath();
  ctx.moveTo(-7.8, -3.0);
  ctx.lineTo(-5.8, -4.0);
  ctx.lineTo(3.6, -4.0);
  ctx.lineTo(5.2, -2.0);
  ctx.lineTo(7.4, -2.0);
  ctx.lineTo(7.4, -0.4);
  ctx.lineTo(9.2, -0.4);
  ctx.lineTo(9.2, -2.4);
  ctx.lineTo(11.0, -2.4);
  ctx.lineTo(11.0, 5.2);
  ctx.lineTo(9.2, 5.2);
  ctx.lineTo(9.2, 3.2);
  ctx.lineTo(7.4, 3.2);
  ctx.lineTo(7.4, 5.2);
  ctx.lineTo(-2.8, 5.2);
  ctx.lineTo(-5.2, 3.2);
  ctx.lineTo(-7.8, 3.2);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Верхняя крышка (клапанная крышка / горловина) и передняя планка вентилятора слева
  ctx.beginPath();
  ctx.moveTo(-4.6, -6.2);
  ctx.lineTo(2.4, -6.2);
  ctx.moveTo(-1.1, -6.2);
  ctx.lineTo(-1.1, -4.0);

  ctx.moveTo(-10.6, -2.6);
  ctx.lineTo(-10.6, 3.8);
  ctx.moveTo(-10.6, 0.6);
  ctx.lineTo(-7.8, 0.6);
  ctx.stroke();

  ctx.restore();
}

/**
 * Интерполяция позиции и направления на миникарте по мировой координате Z
 */
function getInterpolatedMapPose(worldZ) {
  const seg = findSegment(worldZ);
  if (!seg || state.trackLength <= 0) return null;
  const segments = state.segments;
  const nextSeg = segments[(seg.index + 1) % segments.length];
  const t = MathUtil.percentRemaining(worldZ, SEGMENT_LENGTH);

  _mapPose.mapX = MathUtil.lerp(seg.mapX, nextSeg.mapX, t);
  _mapPose.mapY = MathUtil.lerp(seg.mapY, nextSeg.mapY, t);
  const dAngle = Math.atan2(
    Math.sin(nextSeg.mapHeading - seg.mapHeading),
    Math.cos(nextSeg.mapHeading - seg.mapHeading)
  );
  _mapPose.mapHeading = seg.mapHeading + dAngle * t;
  return _mapPose;
}

/**
 * Однократная отрисовка статической подложки и плавного контура кольцевой трассы в offscreen-канвас
 */
function buildCircuitMinimapCache(boxSize, isCompact) {
  if (!minimapCacheCanvas) {
    minimapCacheCanvas = document.createElement('canvas');
  }
  minimapCacheCanvas.width = boxSize;
  minimapCacheCanvas.height = boxSize;
  const mctx = minimapCacheCanvas.getContext('2d');
  if (!mctx) return;

  const segments = state.segments;
  const pad = isCompact ? 16 : 20;
  const mapSize = boxSize - pad * 2;
  const offsetX = pad;
  const offsetY = pad - 3;

  mctx.clearRect(0, 0, boxSize, boxSize);

  // Отступ 1px по периметру предотвращает обрезку внешней половины обводки границами offscreen-канваса
  drawHudCard(mctx, 1, 1, boxSize - 2, boxSize - 2, 11, 'rgba(13, 2, 33, 0.80)', 'rgba(57, 255, 20, 0.55)', 1.5);

  // Неоновая подложка контура трассы
  mctx.strokeStyle = 'rgba(255, 42, 133, 0.45)';
  mctx.lineWidth = isCompact ? 6 : 7;
  mctx.lineJoin = 'round';
  mctx.lineCap = 'round';
  mctx.beginPath();
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const px = offsetX + s.mapX * mapSize;
    const py = offsetY + s.mapY * mapSize;
    if (i === 0) mctx.moveTo(px, py);
    else mctx.lineTo(px, py);
  }
  mctx.closePath();
  mctx.stroke();

  // Базовая линия трека одним замкнутым проходом (без узелков на стыках отдельных сегментов)
  mctx.strokeStyle = '#00f0ff';
  mctx.lineWidth = isCompact ? 2.8 : 3.2;
  mctx.stroke();

  // Объединённые непрерывные дуги крутых поворотов поверх базовой линии
  mctx.strokeStyle = '#ffbe0b';
  mctx.beginPath();
  let inSharpArc = false;
  for (let i = 0; i < segments.length; i++) {
    const s1 = segments[i];
    if (Math.abs(s1.curve) > SHARP_CURVE_THRESHOLD) {
      const s2 = segments[(i + 1) % segments.length];
      if (!inSharpArc) {
        mctx.moveTo(offsetX + s1.mapX * mapSize, offsetY + s1.mapY * mapSize);
        inSharpArc = true;
      }
      mctx.lineTo(offsetX + s2.mapX * mapSize, offsetY + s2.mapY * mapSize);
    } else {
      inSharpArc = false;
    }
  }
  mctx.stroke();

  // Маркер линии старта / финиша
  const startSeg = segments[0];
  const sx = offsetX + startSeg.mapX * mapSize;
  const sy = offsetY + startSeg.mapY * mapSize;
  mctx.fillStyle = '#39ff14';
  mctx.beginPath();
  mctx.arc(sx, sy, 4.0, 0, Math.PI * 2);
  mctx.fill();
  mctx.strokeStyle = '#ffffff';
  mctx.lineWidth = 1.2;
  mctx.stroke();

  mctx.fillStyle = '#a992d1';
  mctx.font = `800 9px ${UI_FONT}`;
  mctx.textAlign = 'center';
  mctx.textBaseline = 'alphabetic';
  mctx.fillText(t('hudTrackNum', { seed: state.circuitSeedId }), boxSize * 0.5, boxSize - 6);
}

/**
 * Отрисовка миникарты и маркеров гонщиков в кольцевом режиме (левый нижний угол)
 */
function renderCircuitMinimap(ctx) {
  if (state.gameMode !== 'circuit' || !state.segments.length) return;

  const LOGICAL_WIDTH = state.logicalWidth;
  const isCompact = state.cachedIsTouch || LOGICAL_WIDTH <= 780;
  const boxSize = isCompact ? 126 : 152;
  const boxX = 14;
  const boxY = LOGICAL_HEIGHT - boxSize - 14;
  const pad = isCompact ? 16 : 20;
  const mapSize = boxSize - pad * 2;
  const offsetX = boxX + pad;
  const offsetY = boxY + pad - 3;

  const cacheKey = `${state.circuitSeedId}_${boxSize}_${getLang()}`;
  if (!minimapCacheCanvas || state.minimapCacheKey !== cacheKey) {
    buildCircuitMinimapCache(boxSize, isCompact);
    state.minimapCacheKey = cacheKey;
  }

  ctx.save();
  if (minimapCacheCanvas) {
    ctx.drawImage(minimapCacheCanvas, boxX, boxY);
  }

  for (let i = 0; i < state.rivals.length; i++) {
    const r = state.rivals[i];
    const rPose = getInterpolatedMapPose(r.z);
    if (!rPose) continue;
    const rx = offsetX + rPose.mapX * mapSize;
    const ry = offsetY + rPose.mapY * mapSize;
    ctx.fillStyle = r.primary;
    ctx.beginPath();
    ctx.arc(rx, ry, 3.0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#090218';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  const pPose = getInterpolatedMapPose(getPlayerWorldZ());
  if (pPose) {
    const px = offsetX + pPose.mapX * mapSize;
    const py = offsetY + pPose.mapY * mapSize;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(pPose.mapHeading);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#ff2a85';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(6.0, 0);
    ctx.lineTo(-4.2, -4.2);
    ctx.lineTo(-2.4, 0);
    ctx.lineTo(-4.2, 4.2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  ctx.restore();
}

/**
 * Компактный счётчик кадров (FPS) в правом верхнем углу экрана (вплотную под кнопкой звука на ПК)
 */
function renderFpsCounter(ctx) {
  if (!state.settings.showFps) return;

  const fps = Math.max(0, state.fpsValue || 0);
  const fpsColor = fps >= 50 ? '#39ff14' : (fps >= 30 ? '#ffbe0b' : '#ff2a85');
  const boxW = 78;
  const boxH = 22;

  let boxX = state.logicalWidth - boxW - 14;
  let boxY = 14;

  if (!state.cachedIsTouch) {
    if (!desktopMuteBtnEl && typeof document !== 'undefined') {
      desktopMuteBtnEl = document.getElementById('desktop-mute-btn');
    }
    const btnW = desktopMuteBtnEl ? desktopMuteBtnEl.offsetWidth : 0;
    const btnH = desktopMuteBtnEl ? desktopMuteBtnEl.offsetHeight : 0;
    const layoutKey = `${window.innerWidth}_${window.innerHeight}_${state.logicalWidth}_${btnW}_${btnH}`;
    if (layoutKey !== cachedFpsLayoutKey) {
      cachedFpsLayoutKey = layoutKey;
      const canvasEl = ctx.canvas;
      const cssW = (canvasEl && canvasEl.clientWidth) || state.logicalWidth;
      const cssH = (canvasEl && canvasEl.clientHeight) || LOGICAL_HEIGHT;
      const scaleX = state.logicalWidth / Math.max(1, cssW);
      const scaleY = LOGICAL_HEIGHT / Math.max(1, cssH);

      if (desktopMuteBtnEl && btnH > 0) {
        const btnBottomCss = desktopMuteBtnEl.offsetTop + btnH;
        const btnRightCss = Math.max(0, cssW - (desktopMuteBtnEl.offsetLeft + desktopMuteBtnEl.offsetWidth));
        cachedDesktopFpsY = Math.round((btnBottomCss + 6) * scaleY);
        cachedDesktopFpsRightPad = Math.round(btnRightCss * scaleX);
      } else {
        cachedDesktopFpsY = Math.round(44 * scaleY);
        cachedDesktopFpsRightPad = Math.round(10 * scaleX);
      }
    }
    boxX = state.logicalWidth - boxW - cachedDesktopFpsRightPad;
    boxY = cachedDesktopFpsY;
  }

  ctx.save();
  drawHudCard(ctx, boxX, boxY, boxW, boxH, 6, 'rgba(13, 2, 33, 0.72)', 'rgba(184, 163, 224, 0.35)', 1);

  ctx.font = '800 11px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#b8a3e0';
  ctx.fillText('FPS', boxX + 8, boxY + boxH * 0.5 + 0.5);

  ctx.textAlign = 'right';
  ctx.fillStyle = fpsColor;
  ctx.fillText(`${fps}`, boxX + boxW - 8, boxY + boxH * 0.5 + 0.5);
  ctx.restore();
}

/**
 * Основная отрисовка HUD поверх игровой сцены
 */
export function renderHUD(ctx) {
  renderFpsCounter(ctx);
  if (state.gameState !== STATE.PLAYING) return;

  const LOGICAL_WIDTH = state.logicalWidth;
  ctx.save();
  ctx.textBaseline = 'alphabetic';
  // Табличная ширина цифр устраняет горизонтальное дрожание таймеров и спидометра
  if ('fontVariantNumeric' in ctx) {
    ctx.fontVariantNumeric = 'tabular-nums';
  }
  const isCompact = state.cachedIsTouch || LOGICAL_WIDTH <= 780;

  if (state.gameMode === 'circuit') {
    const leftBoxW = isCompact ? 184 : 215;
    drawHudCard(ctx, 14, 14, leftBoxW, 76, 10, 'rgba(13, 2, 33, 0.78)', 'rgba(57, 255, 20, 0.55)', 1.5);

    ctx.fillStyle = '#39ff14';
    ctx.font = `800 11px ${UI_FONT}`;
    ctx.textAlign = 'left';
    ctx.fillText(t('hudPosition'), 24, 33);

    const totalRacers = state.rivals.length + 1;
    ctx.fillStyle = state.playerRank === 1 ? '#ffbe0b' : '#ffffff';
    ctx.font = `900 23px ${UI_FONT}`;
    ctx.fillText(`${state.playerRank} / ${totalRacers}`, 24, 58);

    const displayLap = Math.min(state.circuitTotalLaps, Math.max(1, state.circuitCurrentLap));
    ctx.fillStyle = '#00f0ff';
    ctx.font = `800 12px ${UI_FONT}`;
    ctx.textAlign = 'right';
    ctx.fillText(t('hudLap', { cur: displayLap, total: state.circuitTotalLaps }), 14 + leftBoxW - 10, 56);

    ctx.fillStyle = '#ffd6e7';
    ctx.font = `700 11.5px ${UI_FONT}`;
    ctx.textAlign = 'left';
    ctx.fillText(t('hudDistance', { km: (state.distanceMeters / 1000).toFixed(2) }), 24, 78);

    let nextLeftPanelY = 98;

    if (state.isSlipstreaming) {
      drawHudCard(ctx, 14, nextLeftPanelY, leftBoxW, 24, 8, 'rgba(57, 255, 20, 0.90)');
      ctx.fillStyle = '#0b1c08';
      ctx.font = `900 11px ${UI_FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(t('hudSlipstream'), 14 + leftBoxW * 0.5, nextLeftPanelY + 16);
      ctx.textAlign = 'left';
      nextLeftPanelY += 30;
    }

    if (state.difficulty === 'hardcore') {
      drawHudCard(ctx, 14, nextLeftPanelY, leftBoxW, 38, 10, 'rgba(13, 2, 33, 0.78)', 'rgba(255, 190, 11, 0.55)', 1.5);
      drawEngineHeatMeter(ctx, 24, nextLeftPanelY + 16, nextLeftPanelY + 23, leftBoxW - 20);
    }

    const centerW = isCompact ? 164 : 184;
    drawHudCard(
      ctx,
      LOGICAL_WIDTH * 0.5 - centerW * 0.5,
      14,
      centerW,
      72,
      12,
      'rgba(13, 2, 33, 0.80)',
      state.raceFinishCountdown > 0 ? '#ffbe0b' : '#39ff14',
      2
    );

    ctx.fillStyle = state.raceFinishCountdown > 0 ? '#ffbe0b' : '#39ff14';
    ctx.font = `800 10.5px ${UI_FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(
      state.raceFinishCountdown > 0
        ? t('hudFinishIn', { sec: state.raceFinishCountdown.toFixed(1) })
        : t('hudRaceTime'),
      LOGICAL_WIDTH * 0.5,
      30
    );

    ctx.fillStyle = '#ffffff';
    ctx.font = isCompact ? `900 22px ${UI_FONT}` : `900 24px ${UI_FONT}`;
    ctx.fillText(formatRaceTime(state.raceElapsedTime), LOGICAL_WIDTH * 0.5, 56);

    ctx.fillStyle = '#ffbe0b';
    ctx.font = `700 10px ${UI_FONT}`;
    const bestLapStr = state.bestLapTime !== null ? formatRaceTime(state.bestLapTime) : '--:--.--';
    ctx.fillText(t('hudBestLap', { time: bestLapStr }), LOGICAL_WIDTH * 0.5, 76);

    if (state.raceCountdownTimer > 0) {
      const countNum = Math.max(1, Math.ceil((state.raceCountdownTimer / GAME_CONFIG.circuit.countdownSec) * 3));
      drawHudCard(ctx, LOGICAL_WIDTH * 0.5 - 70, 108, 140, 62, 14, 'rgba(13, 2, 33, 0.84)', '#ffbe0b', 2.5);

      ctx.fillStyle = countNum === 1 ? '#39ff14' : '#ffbe0b';
      ctx.font = `900 38px ${UI_FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(`${countNum}`, LOGICAL_WIDTH * 0.5, 151);
    }

    renderCircuitMinimap(ctx);
  } else {
    const leftPanelW = 215;
    const innerPad = 12;
    const innerW = leftPanelW - innerPad * 2;

    drawHudCard(ctx, 14, 14, leftPanelW, 76, 10, 'rgba(13, 2, 33, 0.72)', 'rgba(0, 240, 255, 0.45)', 1.5);

    ctx.fillStyle = '#00f0ff';
    ctx.font = `800 11px ${UI_FONT}`;
    ctx.textAlign = 'left';
    ctx.fillText(t('hudScore'), 14 + innerPad, 33);

    ctx.fillStyle = '#ffffff';
    ctx.font = `900 24px ${UI_FONT}`;
    ctx.fillText(Math.floor(state.score).toLocaleString(getNumberLocale()), 14 + innerPad, 58);

    ctx.fillStyle = '#ffd6e7';
    ctx.font = `700 12px ${UI_FONT}`;
    ctx.fillText(t('hudDistance', { km: (state.distanceMeters / 1000).toFixed(2) }), 14 + innerPad, 78);

    const showOncomingBadge = isOncomingBonusActive();
    if (showOncomingBadge) {
      drawHudCard(ctx, 14, 98, 162, 26, 8, 'rgba(255, 190, 11, 0.92)');
      ctx.fillStyle = '#140326';
      ctx.font = `900 12px ${UI_FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(t('hudOncoming2x'), 95, 115);
      ctx.textAlign = 'left';
    }

    if (state.difficulty === 'hardcore') {
      const panelY = showOncomingBadge ? 132 : 98;
      drawHudCard(ctx, 14, panelY, leftPanelW, 66, 10, 'rgba(13, 2, 33, 0.78)', 'rgba(255, 190, 11, 0.55)', 1.5);

      ctx.fillStyle = '#ffbe0b';
      ctx.font = `800 11px ${UI_FONT}`;
      ctx.fillText(
        t('hudDurability', { cur: state.collisionsLeft, max: MAX_HARDCORE_COLLISIONS }),
        14 + innerPad,
        panelY + 18
      );

      // Динамический расчёт ячеек прочности по ширине панели (не вылезает при изменении MAX_HARDCORE_COLLISIONS)
      const cellGap = 5;
      const cellW = (innerW - cellGap * Math.max(0, MAX_HARDCORE_COLLISIONS - 1)) / Math.max(1, MAX_HARDCORE_COLLISIONS);
      for (let i = 0; i < MAX_HARDCORE_COLLISIONS; i++) {
        ctx.fillStyle = i < state.collisionsLeft ? '#39ff14' : 'rgba(255, 255, 255, 0.14)';
        ctx.fillRect(14 + innerPad + i * (cellW + cellGap), panelY + 24, cellW, 8);
      }

      drawEngineHeatMeter(ctx, 14 + innerPad, panelY + 47, panelY + 52, innerW);
    }

    const isLowTime = state.timeLeft <= 10.0;
    const hasPenaltyFlash = state.timePenaltyFlash > 0;
    drawHudCard(
      ctx,
      LOGICAL_WIDTH * 0.5 - 78,
      14,
      156,
      68,
      12,
      hasPenaltyFlash
        ? 'rgba(170, 12, 58, 0.92)'
        : (isLowTime ? 'rgba(120, 8, 45, 0.85)' : 'rgba(13, 2, 33, 0.78)'),
      hasPenaltyFlash ? '#ff4d8d' : (isLowTime ? '#ff2a85' : '#ffbe0b'),
      hasPenaltyFlash ? 2.5 : 2
    );

    ctx.fillStyle = hasPenaltyFlash ? '#ffffff' : (isLowTime ? '#ffd6e7' : '#ffbe0b');
    ctx.font = `800 11px ${UI_FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(t('hudTime'), LOGICAL_WIDTH * 0.5, 32);

    ctx.fillStyle = (hasPenaltyFlash || (isLowTime && Math.floor(state.animClockMs / 200) % 2 === 0)) ? '#ffbe0b' : '#ffffff';
    ctx.font = `900 32px ${UI_FONT}`;
    ctx.fillText(state.timeLeft.toFixed(1), LOGICAL_WIDTH * 0.5, 67);

    if (hasPenaltyFlash) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, state.timePenaltyFlash * 1.4);
      drawHudCard(ctx, LOGICAL_WIDTH * 0.5 - 46, 86, 92, 22, 6, '#ff2a85');
      ctx.fillStyle = '#ffffff';
      ctx.font = `900 13px ${UI_FONT}`;
      ctx.fillText(t('hudPenaltySec', { sec: Math.round(COLLISION_TIME_PENALTY) }), LOGICAL_WIDTH * 0.5, 101);
      ctx.restore();
    }
  }

  // Правый нижний угол: расширенный цифровой спидометр (исключает наложение 3-значной скорости на плашки)
  const input = state.input;
  const isReversing =
    state.raceCountdownTimer <= 0 &&
    (state.speed < -2 || (input.down && !input.up && state.speed <= 2));
  const kmh = Math.round((Math.abs(state.speed) / MAX_SPEED) * BASE_MAX_KMH);
  const damageMaxKmh = getCurrentMaxAllowedKmh();
  const barFillRatio = isReversing
    ? MathUtil.clamp(Math.abs(state.speed) / MAX_REVERSE_SPEED, 0, 1)
    : MathUtil.clamp(state.speed / MAX_SPEED, 0, 1);

  const speedoW = 194;
  const speedoH = 80;
  const speedoX = LOGICAL_WIDTH - speedoW - 14;
  const speedoY = LOGICAL_HEIGHT - speedoH - 14;

  drawHudCard(
    ctx,
    speedoX,
    speedoY,
    speedoW,
    speedoH,
    12,
    'rgba(13, 2, 33, 0.82)',
    isReversing ? 'rgba(255, 255, 255, 0.75)' : 'rgba(255, 42, 133, 0.55)',
    1.5
  );

  const badgeX = speedoX + 12;
  const badgeW = 58;

  if (isReversing) {
    drawHudCard(ctx, badgeX, speedoY + 16, 28, 30, 6, '#ffffff');
    ctx.fillStyle = '#0d0221';
    ctx.font = `900 19px ${UI_FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('R', badgeX + 14, speedoY + 38);
  } else if (damageMaxKmh < BASE_MAX_KMH) {
    drawHudCard(
      ctx,
      badgeX,
      speedoY + 10,
      badgeW,
      17,
      5,
      'rgba(255, 42, 95, 0.25)',
      'rgba(255, 77, 120, 0.75)',
      1
    );

    ctx.fillStyle = '#ff6b93';
    ctx.font = `800 10px ${UI_FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(`MAX ${damageMaxKmh}`, badgeX + badgeW * 0.5, speedoY + 22);

    // Приборный значок Check Engine вместо текстовой плашки «МОТОР»
    if (state.gameMode !== 'circuit' && state.visualDamage >= 3) {
      const blinkEngine = Math.floor(state.animClockMs / 260) % 2 === 0;
      const lampY = speedoY + 30;
      const lampH = 22;
      drawHudCard(
        ctx,
        badgeX,
        lampY,
        badgeW,
        lampH,
        5,
        blinkEngine ? 'rgba(255, 145, 0, 0.20)' : 'rgba(255, 110, 0, 0.06)',
        blinkEngine ? 'rgba(255, 174, 0, 0.85)' : 'rgba(255, 130, 0, 0.30)',
        1
      );
      drawCheckEngineIcon(ctx, badgeX + badgeW * 0.5, lampY + lampH * 0.5 + 0.5, 1.12, blinkEngine);
    }
  }

  ctx.fillStyle = '#ffffff';
  ctx.font = `900 34px ${UI_FONT}`;
  ctx.textAlign = 'right';
  ctx.fillText(`${kmh}`, LOGICAL_WIDTH - 64, LOGICAL_HEIGHT - 46);

  ctx.fillStyle = isReversing ? '#ffffff' : '#00f0ff';
  ctx.font = `800 13px ${UI_FONT}`;
  ctx.fillText(t('hudKmh'), LOGICAL_WIDTH - 22, LOGICAL_HEIGHT - 46);

  const barX = speedoX + 13;
  const barY = LOGICAL_HEIGHT - 32;
  const barW = speedoW - 26;
  const barH = 11;

  ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
  ctx.fillRect(barX, barY, barW, barH);

  if (isReversing) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(barX, barY, barW * barFillRatio, barH);
  } else {
    const allowedRatio = MathUtil.clamp(damageMaxKmh / BASE_MAX_KMH, 0, 1);
    if (allowedRatio < 1) {
      const restrictedX = barX + barW * allowedRatio;
      const restrictedW = barW * (1 - allowedRatio);

      ctx.fillStyle = 'rgba(255, 34, 88, 0.45)';
      ctx.fillRect(restrictedX, barY, restrictedW, barH);

      ctx.save();
      ctx.beginPath();
      ctx.rect(restrictedX, barY, restrictedW, barH);
      ctx.clip();

      ctx.strokeStyle = 'rgba(255, 92, 130, 0.85)';
      ctx.lineWidth = 1.6;
      for (let sx = restrictedX - barH; sx < restrictedX + restrictedW + barH; sx += 6) {
        ctx.beginPath();
        ctx.moveTo(sx, barY + barH);
        ctx.lineTo(sx + barH, barY);
        ctx.stroke();
      }
      ctx.restore();
    }

    if (!cachedSpeedGrad || cachedSpeedGradX !== barX || cachedSpeedGradW !== barW) {
      const grad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
      grad.addColorStop(0, '#00f0ff');
      grad.addColorStop(0.65, '#ffbe0b');
      grad.addColorStop(1, '#ff2a85');
      cachedSpeedGrad = grad;
      cachedSpeedGradX = barX;
      cachedSpeedGradW = barW;
    }
    ctx.fillStyle = cachedSpeedGrad;
    ctx.fillRect(barX, barY, barW * barFillRatio, barH);

    if (allowedRatio < 1) {
      const limitLineX = barX + barW * allowedRatio;
      ctx.fillStyle = '#ff2a55';
      ctx.fillRect(limitLineX - 1.5, barY - 2, 3, barH + 4);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(limitLineX - 0.5, barY - 1, 1, barH + 2);
    }
  }

  if (state.bannerTimer > 0 && state.bannerText) {
    const alpha = Math.min(1, state.bannerTimer * 2);
    const maxBannerW = LOGICAL_WIDTH - 48;
    const bannerY = 224;
    ctx.globalAlpha = alpha;
    ctx.font = isCompact ? `900 18px ${UI_FONT}` : `900 22px ${UI_FONT}`;
    ctx.textAlign = 'center';

    const measuredW = Math.min(maxBannerW, ctx.measureText(state.bannerText).width);
    const pillW = measuredW + 28;
    const pillH = isCompact ? 30 : 34;
    drawHudCard(ctx, LOGICAL_WIDTH * 0.5 - pillW * 0.5, bannerY - pillH * 0.68, pillW, pillH, 9, 'rgba(13, 2, 33, 0.78)');

    ctx.fillStyle = '#140326';
    ctx.fillText(state.bannerText, LOGICAL_WIDTH * 0.5 + 2, bannerY + 2, maxBannerW);
    ctx.fillStyle = state.bannerColor;
    ctx.fillText(state.bannerText, LOGICAL_WIDTH * 0.5, bannerY, maxBannerW);
  }

  ctx.restore();
}