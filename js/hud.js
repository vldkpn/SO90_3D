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

let minimapCacheCanvas = null;

/**
 * Интерполяция позиции и направления на миникарте по мировой координате Z
 */
function getInterpolatedMapPose(worldZ) {
  const seg = findSegment(worldZ);
  if (!seg || state.trackLength <= 0) return null;
  const segments = state.segments;
  const nextSeg = segments[(seg.index + 1) % segments.length];
  const wrappedZ = ((worldZ % state.trackLength) + state.trackLength) % state.trackLength;
  const t = MathUtil.percentRemaining(wrappedZ, SEGMENT_LENGTH);
  const mapX = MathUtil.lerp(seg.mapX, nextSeg.mapX, t);
  const mapY = MathUtil.lerp(seg.mapY, nextSeg.mapY, t);
  const dAngle = Math.atan2(
    Math.sin(nextSeg.mapHeading - seg.mapHeading),
    Math.cos(nextSeg.mapHeading - seg.mapHeading)
  );
  const mapHeading = seg.mapHeading + dAngle * t;
  return { mapX, mapY, mapHeading };
}

/**
 * Однократная отрисовка статической подложки и контура кольцевой трассы в offscreen-канвас
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

  // Отступ 1px по периметру предотвращает обрезку внешней половины обводки (lineWidth 1.5) границами offscreen-канваса
  mctx.fillStyle = 'rgba(13, 2, 33, 0.80)';
  mctx.strokeStyle = 'rgba(57, 255, 20, 0.55)';
  mctx.lineWidth = 1.5;
  mctx.beginPath();
  mctx.roundRect(1, 1, boxSize - 2, boxSize - 2, 11);
  mctx.fill();
  mctx.stroke();

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

  mctx.lineWidth = isCompact ? 2.8 : 3.2;
  mctx.lineJoin = 'round';
  mctx.lineCap = 'round';
  for (let i = 0; i < segments.length; i++) {
    const s1 = segments[i];
    const s2 = segments[(i + 1) % segments.length];
    const isSharpTurn = Math.abs(s1.curve) > 5.8;
    mctx.strokeStyle = isSharpTurn ? '#ffbe0b' : '#00f0ff';
    mctx.beginPath();
    mctx.moveTo(offsetX + s1.mapX * mapSize, offsetY + s1.mapY * mapSize);
    mctx.lineTo(offsetX + s2.mapX * mapSize, offsetY + s2.mapY * mapSize);
    mctx.stroke();
  }

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
  mctx.font = '800 9px sans-serif';
  mctx.textAlign = 'center';
  mctx.textBaseline = 'alphabetic';
  mctx.fillText(`ТРЕК #${state.circuitSeedId}`, boxSize * 0.5, boxSize - 6);
}

/**
 * Отрисовка миникарты и маркеров гонщиков в кольцевом режиме
 */
function renderCircuitMinimap(ctx) {
  if (state.gameMode !== 'circuit' || !state.segments.length) return;

  const LOGICAL_WIDTH = state.logicalWidth;
  const isCompact = state.cachedIsTouch || LOGICAL_WIDTH <= 780;
  const boxSize = isCompact ? 126 : 152;
  const boxX = LOGICAL_WIDTH - boxSize - 14;
  // Увеличенный вертикальный отступ на ПК (54px) исключает наложение кнопки звука поверх миникарты при сжатии окна
  const boxY = isCompact ? 14 : 54;
  const pad = isCompact ? 16 : 20;
  const mapSize = boxSize - pad * 2;
  const offsetX = boxX + pad;
  const offsetY = boxY + pad - 3;

  const cacheKey = `${state.circuitSeedId}_${boxSize}_${isCompact ? 1 : 0}`;
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
 * Компактный счётчик кадров (FPS) в левом нижнем углу экрана
 */
function renderFpsCounter(ctx) {
  if (!state.settings.showFps) return;

  const fps = Math.max(0, state.fpsValue || 0);
  const fpsColor = fps >= 50 ? '#39ff14' : (fps >= 30 ? '#ffbe0b' : '#ff2a85');
  const boxX = 14;
  const boxY = LOGICAL_HEIGHT - 36;
  const boxW = 78;
  const boxH = 22;

  ctx.save();
  ctx.fillStyle = 'rgba(13, 2, 33, 0.72)';
  ctx.strokeStyle = 'rgba(184, 163, 224, 0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(boxX, boxY, boxW, boxH, 6);
  ctx.fill();
  ctx.stroke();

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
  const isCompact = state.cachedIsTouch || LOGICAL_WIDTH <= 780;

  if (state.gameMode === 'circuit') {
    const leftBoxW = isCompact ? 184 : 215;
    ctx.fillStyle = 'rgba(13, 2, 33, 0.78)';
    ctx.strokeStyle = 'rgba(57, 255, 20, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(14, 14, leftBoxW, 76, 10);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#39ff14';
    ctx.font = '800 11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('ПОЗИЦИЯ', 24, 33);

    const totalRacers = state.rivals.length + 1;
    ctx.fillStyle = state.playerRank === 1 ? '#ffbe0b' : '#ffffff';
    ctx.font = '900 23px sans-serif';
    ctx.fillText(`${state.playerRank} / ${totalRacers}`, 24, 58);

    const displayLap = Math.min(state.circuitTotalLaps, Math.max(1, state.circuitCurrentLap));
    ctx.fillStyle = '#00f0ff';
    ctx.font = '800 12px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`КРУГ ${displayLap}/${state.circuitTotalLaps}`, 14 + leftBoxW - 10, 56);

    ctx.fillStyle = '#ffd6e7';
    ctx.font = '700 11.5px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`ДИСТАНЦИЯ: ${(state.distanceMeters / 1000).toFixed(2)} км`, 24, 78);

    let nextLeftPanelY = 98;

    if (state.isSlipstreaming) {
      ctx.fillStyle = 'rgba(57, 255, 20, 0.90)';
      ctx.beginPath();
      ctx.roundRect(14, nextLeftPanelY, leftBoxW, 24, 8);
      ctx.fill();
      ctx.fillStyle = '#0b1c08';
      ctx.font = '900 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('⚡ СЛИПСТРИМ +5% ⚡', 14 + leftBoxW * 0.5, nextLeftPanelY + 16);
      ctx.textAlign = 'left';
      nextLeftPanelY += 30;
    }

    if (state.difficulty === 'hardcore') {
      ctx.fillStyle = 'rgba(13, 2, 33, 0.78)';
      ctx.strokeStyle = 'rgba(255, 190, 11, 0.55)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(14, nextLeftPanelY, leftBoxW, 38, 10);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = state.isOverheated ? '#ff2a85' : '#00f0ff';
      ctx.font = '800 10.5px sans-serif';
      ctx.fillText(
        state.isOverheated ? 'ПЕРЕГРЕВ ДВИГАТЕЛЯ!' : `ТЕМП. МОТОРА: ${Math.round(state.engineHeat)}%`,
        24,
        nextLeftPanelY + 16
      );

      const barInnerW = leftBoxW - 22;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.fillRect(24, nextLeftPanelY + 23, barInnerW, 7);

      const heatColor = state.isOverheated
        ? '#ff2a85'
        : (state.engineHeat > 75 ? '#ffbe0b' : '#00f0ff');
      ctx.fillStyle = heatColor;
      ctx.fillRect(24, nextLeftPanelY + 23, barInnerW * (state.engineHeat / 100), 7);
    }

    const centerW = isCompact ? 164 : 184;
    ctx.fillStyle = 'rgba(13, 2, 33, 0.80)';
    ctx.strokeStyle = state.raceFinishCountdown > 0 ? '#ffbe0b' : '#39ff14';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(LOGICAL_WIDTH * 0.5 - centerW * 0.5, 14, centerW, 72, 12);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = state.raceFinishCountdown > 0 ? '#ffbe0b' : '#39ff14';
    ctx.font = '800 10.5px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(
      state.raceFinishCountdown > 0 ? `ДО ФИНИША: ${state.raceFinishCountdown.toFixed(1)}с` : 'ВРЕМЯ ЗАЕЗДА',
      LOGICAL_WIDTH * 0.5,
      30
    );

    ctx.fillStyle = '#ffffff';
    ctx.font = isCompact ? '900 22px sans-serif' : '900 24px sans-serif';
    ctx.fillText(formatRaceTime(state.raceElapsedTime), LOGICAL_WIDTH * 0.5, 56);

    ctx.fillStyle = '#ffbe0b';
    ctx.font = '700 10px sans-serif';
    const bestLapStr = state.bestLapTime !== null ? formatRaceTime(state.bestLapTime) : '--:--.--';
    ctx.fillText(`ЛУЧШИЙ: ${bestLapStr}`, LOGICAL_WIDTH * 0.5, 76);

    if (state.raceCountdownTimer > 0) {
      const countNum = Math.max(1, Math.ceil((state.raceCountdownTimer / GAME_CONFIG.circuit.countdownSec) * 3));
      ctx.fillStyle = 'rgba(13, 2, 33, 0.84)';
      ctx.strokeStyle = '#ffbe0b';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.roundRect(LOGICAL_WIDTH * 0.5 - 70, 108, 140, 62, 14);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = countNum === 1 ? '#39ff14' : '#ffbe0b';
      ctx.font = '900 38px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${countNum}`, LOGICAL_WIDTH * 0.5, 151);
    }

    renderCircuitMinimap(ctx);
  } else {
    ctx.fillStyle = 'rgba(13, 2, 33, 0.72)';
    ctx.strokeStyle = 'rgba(0, 240, 255, 0.45)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(14, 14, 215, 76, 10);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#00f0ff';
    ctx.font = '800 11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('СЧЁТ', 26, 33);

    ctx.fillStyle = '#ffffff';
    ctx.font = '900 24px sans-serif';
    ctx.fillText(Math.floor(state.score).toLocaleString('ru-RU'), 26, 58);

    ctx.fillStyle = '#ffd6e7';
    ctx.font = '700 12px sans-serif';
    ctx.fillText(`ДИСТАНЦИЯ: ${(state.distanceMeters / 1000).toFixed(2)} км`, 26, 78);

    const showOncomingBadge = isOncomingBonusActive();
    if (showOncomingBadge) {
      ctx.fillStyle = 'rgba(255, 190, 11, 0.92)';
      ctx.beginPath();
      ctx.roundRect(14, 98, 162, 26, 8);
      ctx.fill();
      ctx.fillStyle = '#140326';
      ctx.font = '900 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('★ 2X ВСТРЕЧКА ★', 95, 115);
      ctx.textAlign = 'left';
    }

    if (state.difficulty === 'hardcore') {
      const panelY = showOncomingBadge ? 132 : 98;
      ctx.fillStyle = 'rgba(13, 2, 33, 0.78)';
      ctx.strokeStyle = 'rgba(255, 190, 11, 0.55)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(14, panelY, 215, 66, 10);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#ffbe0b';
      ctx.font = '800 11px sans-serif';
      ctx.fillText(`ПРОЧНОСТЬ: ${state.collisionsLeft}/${MAX_HARDCORE_COLLISIONS}`, 26, panelY + 18);

      for (let i = 0; i < MAX_HARDCORE_COLLISIONS; i++) {
        ctx.fillStyle = i < state.collisionsLeft ? '#39ff14' : 'rgba(255, 255, 255, 0.14)';
        ctx.fillRect(26 + i * 38, panelY + 24, 33, 8);
      }

      ctx.fillStyle = state.isOverheated ? '#ff2a85' : '#00f0ff';
      ctx.fillText(
        state.isOverheated ? 'ПЕРЕГРЕВ ДВИГАТЕЛЯ!' : `ТЕМП. МОТОРА: ${Math.round(state.engineHeat)}%`,
        26,
        panelY + 47
      );

      ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.fillRect(26, panelY + 52, 188, 7);

      const heatColor = state.isOverheated
        ? '#ff2a85'
        : (state.engineHeat > 75 ? '#ffbe0b' : '#00f0ff');
      ctx.fillStyle = heatColor;
      ctx.fillRect(26, panelY + 52, 188 * (state.engineHeat / 100), 7);
    }

    const isLowTime = state.timeLeft <= 10.0;
    const hasPenaltyFlash = state.timePenaltyFlash > 0;
    ctx.fillStyle = hasPenaltyFlash
      ? 'rgba(170, 12, 58, 0.92)'
      : (isLowTime ? 'rgba(120, 8, 45, 0.85)' : 'rgba(13, 2, 33, 0.78)');
    ctx.strokeStyle = hasPenaltyFlash
      ? '#ff4d8d'
      : (isLowTime ? '#ff2a85' : '#ffbe0b');
    ctx.lineWidth = hasPenaltyFlash ? 2.5 : 2;
    ctx.beginPath();
    ctx.roundRect(LOGICAL_WIDTH * 0.5 - 78, 14, 156, 68, 12);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = hasPenaltyFlash ? '#ffffff' : (isLowTime ? '#ffd6e7' : '#ffbe0b');
    ctx.font = '800 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('ВРЕМЯ', LOGICAL_WIDTH * 0.5, 32);

    ctx.fillStyle = (hasPenaltyFlash || (isLowTime && Math.floor(state.animClockMs / 200) % 2 === 0)) ? '#ffbe0b' : '#ffffff';
    ctx.font = '900 32px sans-serif';
    ctx.fillText(state.timeLeft.toFixed(1), LOGICAL_WIDTH * 0.5, 67);

    if (hasPenaltyFlash) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, state.timePenaltyFlash * 1.4);
      ctx.fillStyle = '#ff2a85';
      ctx.beginPath();
      ctx.roundRect(LOGICAL_WIDTH * 0.5 - 46, 86, 92, 22, 6);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = '900 13px sans-serif';
      ctx.fillText(`-${Math.round(COLLISION_TIME_PENALTY)} СЕК`, LOGICAL_WIDTH * 0.5, 101);
      ctx.restore();
    }
  }

  // Правый нижний угол: цифровой спидометр
  const input = state.input;
  const isReversing = state.speed < -2 || (input.down && !input.up && state.speed <= 2);
  const kmh = Math.round((Math.abs(state.speed) / MAX_SPEED) * BASE_MAX_KMH);
  const damageMaxKmh = getCurrentMaxAllowedKmh();
  const barFillRatio = isReversing
    ? MathUtil.clamp(Math.abs(state.speed) / MAX_REVERSE_SPEED, 0, 1)
    : MathUtil.clamp(state.speed / MAX_SPEED, 0, 1);

  ctx.fillStyle = 'rgba(13, 2, 33, 0.82)';
  ctx.strokeStyle = isReversing ? 'rgba(255, 255, 255, 0.75)' : 'rgba(255, 42, 133, 0.55)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(LOGICAL_WIDTH - 196, LOGICAL_HEIGHT - 94, 182, 80, 12);
  ctx.fill();
  ctx.stroke();

  if (isReversing) {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.roundRect(LOGICAL_WIDTH - 182, LOGICAL_HEIGHT - 76, 28, 30, 6);
    ctx.fill();

    ctx.fillStyle = '#0d0221';
    ctx.font = '900 19px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('R', LOGICAL_WIDTH - 168, LOGICAL_HEIGHT - 54);
  } else if (damageMaxKmh < BASE_MAX_KMH) {
    ctx.fillStyle = 'rgba(255, 42, 95, 0.25)';
    ctx.strokeStyle = 'rgba(255, 77, 120, 0.75)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(LOGICAL_WIDTH - 184, LOGICAL_HEIGHT - 83, 62, 18, 5);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#ff6b93';
    ctx.font = '800 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`MAX ${damageMaxKmh}`, LOGICAL_WIDTH - 153, LOGICAL_HEIGHT - 71);

    if (state.gameMode !== 'circuit' && state.visualDamage >= 3) {
      const blinkEngine = Math.floor(state.animClockMs / 240) % 2 === 0;
      ctx.fillStyle = blinkEngine ? 'rgba(255, 123, 0, 0.90)' : 'rgba(255, 42, 95, 0.45)';
      ctx.beginPath();
      ctx.roundRect(LOGICAL_WIDTH - 184, LOGICAL_HEIGHT - 61, 62, 16, 4);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = '900 9px sans-serif';
      ctx.fillText('⚠ МОТОР', LOGICAL_WIDTH - 153, LOGICAL_HEIGHT - 50);
    }
  }

  ctx.fillStyle = '#ffffff';
  ctx.font = '900 34px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(`${kmh}`, LOGICAL_WIDTH - 68, LOGICAL_HEIGHT - 46);

  ctx.fillStyle = isReversing ? '#ffffff' : '#00f0ff';
  ctx.font = '800 13px sans-serif';
  ctx.fillText('КМ/Ч', LOGICAL_WIDTH - 24, LOGICAL_HEIGHT - 46);

  const barX = LOGICAL_WIDTH - 182;
  const barY = LOGICAL_HEIGHT - 32;
  const barW = 154;
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

    const speedGrad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
    speedGrad.addColorStop(0, '#00f0ff');
    speedGrad.addColorStop(0.65, '#ffbe0b');
    speedGrad.addColorStop(1, '#ff2a85');
    ctx.fillStyle = speedGrad;
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
    ctx.font = isCompact ? '900 18px sans-serif' : '900 22px sans-serif';
    ctx.textAlign = 'center';

    const measuredW = Math.min(maxBannerW, ctx.measureText(state.bannerText).width);
    const pillW = measuredW + 28;
    const pillH = isCompact ? 30 : 34;
    ctx.fillStyle = 'rgba(13, 2, 33, 0.78)';
    ctx.beginPath();
    ctx.roundRect(LOGICAL_WIDTH * 0.5 - pillW * 0.5, bannerY - pillH * 0.68, pillW, pillH, 9);
    ctx.fill();

    ctx.fillStyle = '#140326';
    ctx.fillText(state.bannerText, LOGICAL_WIDTH * 0.5 + 2, bannerY + 2, maxBannerW);
    ctx.fillStyle = state.bannerColor;
    ctx.fillText(state.bannerText, LOGICAL_WIDTH * 0.5, bannerY, maxBannerW);
  }

  ctx.restore();
}