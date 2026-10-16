export function parseM3U(source) {
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  const channels = [];
  let metadata = null;
  let epgUrl = '';

  const attributes = (line) => {
    const result = {};
    const rx = /([\w-]+)="([^"]*)"/g;
    for (const match of line.matchAll(rx)) result[match[1]] = match[2];
    return result;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTM3U')) {
      epgUrl = attributes(line)['url-tvg'] || '';
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      const comma = line.indexOf(',');
      metadata = {
        ...attributes(comma < 0 ? line : line.slice(0, comma)),
        name: comma < 0 ? 'Без названия' : line.slice(comma + 1).trim(),
      };
      continue;
    }
    if (line.startsWith('#')) continue;
    if (!metadata) continue;
    try {
      const url = new URL(line);
      if (!['http:', 'https:'].includes(url.protocol)) { metadata = null; continue; }
      channels.push({
        key: `${channels.length}:${line}`,
        name: metadata.name,
        url: line,
        logo: metadata['tvg-logo'] || '',
        tvgId: metadata['tvg-id'] || '',
        group: metadata['group-title'] || 'Без группы',
        timeshift: Number(metadata.timeshift) || 0,
      });
    } catch { /* некорректный URL пропускаем */ }
    metadata = null;
  }
  return { epgUrl, channels };
}
