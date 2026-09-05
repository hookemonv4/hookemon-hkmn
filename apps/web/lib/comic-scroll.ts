export type ComicFrame = {
  clipIndex: number;
  localProgress: number;
};

export function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function resolveComicFrame(progress: number, clipCount: number): ComicFrame {
  const count = Math.max(1, Math.floor(clipCount));
  const clamped = clampUnit(progress);

  if (clamped === 1) {
    return { clipIndex: count - 1, localProgress: 1 };
  }

  const scaled = clamped * count;
  const clipIndex = Math.min(count - 1, Math.floor(scaled));
  return { clipIndex, localProgress: scaled - clipIndex };
}

export function resolveComicTime(localProgress: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const safeEnd = Math.max(0, duration - 0.04);
  return clampUnit(localProgress) * safeEnd;
}
