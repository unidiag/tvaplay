
export function getCurrentProgramme(programmes, channelKey, now) {
  const programme = programmes[channelKey];

  if (!programme) return null;

  if (now < programme.start || now >= programme.stop) {
    return null;
  }

  return programme;
}

export function getProgrammeProgress(programme, now) {
  if (!programme) return 0;

  const duration = programme.stop - programme.start;

  if (duration <= 0) return 0;

  return Math.min(
    100,
    Math.max(
      0,
      ((now - programme.start) / duration) * 100
    )
  );
}

export function formatEPGTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatMinutes(milliseconds) {
  return Math.max(0, Math.floor(milliseconds / 60_000));
}
