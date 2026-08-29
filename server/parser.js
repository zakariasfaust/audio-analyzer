// parser.js
// Parses M3U8 text (HLS manifest) into JavaScript objects.
// No external parser library is used - the HLS format is line-based
// and simple enough to parse with plain regex and state variables.

/**
 * Resolves a (possibly relative) URI against the manifest's own URL.
 * HLS manifests often contain relative segment URIs
 * ("segment_123.ts") that must be joined with the manifest's base URL
 * to become clickable/fetchable.
 */
function resolveUrl(baseUrl, uri) {
  if (!uri) return uri;
  try {
    return new URL(uri.trim(), baseUrl).toString();
  } catch {
    return uri.trim();
  }
}

/**
 * Parses an attribute list of the form KEY=VALUE,KEY2="VALUE 2",KEY3=1920x1080
 * as found after e.g. #EXT-X-STREAM-INF:. Must handle quoted
 * strings where commas should NOT be interpreted as a separator (e.g. CODECS).
 */
function parseAttributeList(str) {
  const attrs = {};
  if (!str) return attrs;

  // Matches KEY=VALUE where the value is either quoted ("...") or unquoted
  // up to the next comma. This avoids splitting CODECS="mp4a.40.2,avc1.4d401f"
  // in the wrong place.
  const re = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g;
  let match;
  while ((match = re.exec(str)) !== null) {
    const key = match[1];
    const value = match[2] !== undefined ? match[2] : match[3];
    attrs[key] = value;
  }
  return attrs;
}

/**
 * Splits a single #EXT-X-KEY: or #EXT-X-MAP: tag line into its attributes
 * and resolves any URI against the base URL.
 */
function parseUriTag(line, baseUrl) {
  const colonIndex = line.indexOf(':');
  const attrs = parseAttributeList(colonIndex >= 0 ? line.slice(colonIndex + 1) : '');
  return {
    method: attrs.METHOD || null,
    uri: attrs.URI ? resolveUrl(baseUrl, attrs.URI) : null,
    keyFormat: attrs.KEYFORMAT || null,
    ivPresent: Boolean(attrs.IV),
    raw: attrs,
  };
}

/**
 * Parses a master playlist (the one listing #EXT-X-STREAM-INF variants).
 */
function parseMasterPlaylist(lines, baseUrl) {
  const variants = [];
  const audioRenditions = [];
  let version = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('#EXT-X-VERSION:')) {
      version = Number(line.slice('#EXT-X-VERSION:'.length)) || null;
      continue;
    }

    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseAttributeList(line.slice('#EXT-X-MEDIA:'.length));
      if ((attrs.TYPE || '').toUpperCase() === 'AUDIO') {
        audioRenditions.push({
          groupId: attrs['GROUP-ID'] || null,
          name: attrs.NAME || null,
          language: attrs.LANGUAGE || null,
          isDefault: (attrs.DEFAULT || '').toUpperCase() === 'YES',
          autoselect: (attrs.AUTOSELECT || '').toUpperCase() === 'YES',
          uri: attrs.URI ? resolveUrl(baseUrl, attrs.URI) : null,
        });
      }
      continue;
    }

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = parseAttributeList(line.slice('#EXT-X-STREAM-INF:'.length));
      // The next non-empty, non-comment line is the variant's URI.
      let j = i + 1;
      while (j < lines.length && (lines[j] === '' || lines[j].startsWith('#'))) j++;
      const uriLine = j < lines.length ? lines[j] : null;

      variants.push({
        bandwidth: attrs.BANDWIDTH ? Number(attrs.BANDWIDTH) : null,
        averageBandwidth: attrs['AVERAGE-BANDWIDTH'] ? Number(attrs['AVERAGE-BANDWIDTH']) : null,
        codecs: attrs.CODECS || null,
        resolution: attrs.RESOLUTION || null,
        frameRate: attrs['FRAME-RATE'] ? Number(attrs['FRAME-RATE']) : null,
        audioGroup: attrs.AUDIO || null,
        url: uriLine ? resolveUrl(baseUrl, uriLine) : null,
      });

      i = j; // skip past the URI line we've already consumed
      continue;
    }
  }

  return { type: 'master', version, variants, audioRenditions };
}

/**
 * Parses a media playlist (the one listing actual segments via #EXTINF).
 */
function parseMediaPlaylist(lines, baseUrl) {
  let version = null;
  let targetDuration = null;
  let mediaSequence = null;
  let playlistType = null;
  let endlist = false;
  let key = null; // most recent active encryption key (METHOD != NONE)
  let map = null; // #EXT-X-MAP (fMP4 initialization segment)
  let serverControl = null; // #EXT-X-SERVER-CONTROL (recommended live-edge distance etc.)
  let partTargetDuration = null; // #EXT-X-PART-INF:PART-TARGET (LL-HLS partial segment duration)
  let preloadHint = null; // #EXT-X-PRELOAD-HINT (upcoming partial segment already being advertised)
  const renditionReports = []; // #EXT-X-RENDITION-REPORT (status of other renditions)
  let discontinuitySequence = null; // #EXT-X-DISCONTINUITY-SEQUENCE (starting value for the discontinuity counter)
  let startInfo = null; // #EXT-X-START (TIME-OFFSET for where the player should start)

  const segments = [];

  // "Pending" values: HLS tags apply to the next segment URI line,
  // so we collect them until we hit the line that doesn't start with '#'.
  let pendingDuration = null;
  let pendingTitle = '';
  let pendingProgramDateTime = null;
  let pendingDiscontinuity = false;
  let pendingParts = []; // #EXT-X-PART (LL-HLS partial segment) for the next segment

  for (const line of lines) {
    if (line.startsWith('#EXT-X-VERSION:')) {
      version = Number(line.slice('#EXT-X-VERSION:'.length)) || null;
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number(line.slice('#EXT-X-TARGETDURATION:'.length)) || null;
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length)) || null;
    } else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
      playlistType = line.slice('#EXT-X-PLAYLIST-TYPE:'.length).trim();
    } else if (line.startsWith('#EXT-X-ENDLIST')) {
      endlist = true;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const parsedKey = parseUriTag(line, baseUrl);
      key = (parsedKey.method && parsedKey.method !== 'NONE') ? parsedKey : null;
    } else if (line.startsWith('#EXT-X-MAP:')) {
      map = parseUriTag(line, baseUrl);
    } else if (line.startsWith('#EXT-X-SERVER-CONTROL:')) {
      const attrs = parseAttributeList(line.slice('#EXT-X-SERVER-CONTROL:'.length));
      serverControl = {
        canBlockReload: (attrs['CAN-BLOCK-RELOAD'] || '').toUpperCase() === 'YES',
        holdBack: attrs['HOLD-BACK'] ? Number(attrs['HOLD-BACK']) : null,
        partHoldBack: attrs['PART-HOLD-BACK'] ? Number(attrs['PART-HOLD-BACK']) : null,
        canSkipUntil: attrs['CAN-SKIP-UNTIL'] ? Number(attrs['CAN-SKIP-UNTIL']) : null,
        canSkipDateranges: (attrs['CAN-SKIP-DATERANGES'] || '').toUpperCase() === 'YES',
      };
    } else if (line.startsWith('#EXT-X-PART-INF:')) {
      const attrs = parseAttributeList(line.slice('#EXT-X-PART-INF:'.length));
      partTargetDuration = attrs['PART-TARGET'] ? Number(attrs['PART-TARGET']) : null;
    } else if (line.startsWith('#EXT-X-PART:')) {
      const attrs = parseAttributeList(line.slice('#EXT-X-PART:'.length));
      pendingParts.push({
        uri: attrs.URI ? resolveUrl(baseUrl, attrs.URI) : null,
        duration: attrs.DURATION ? Number(attrs.DURATION) : null,
        independent: (attrs.INDEPENDENT || '').toUpperCase() === 'YES',
        gap: (attrs.GAP || '').toUpperCase() === 'YES',
      });
    } else if (line.startsWith('#EXT-X-PRELOAD-HINT:')) {
      const attrs = parseAttributeList(line.slice('#EXT-X-PRELOAD-HINT:'.length));
      preloadHint = {
        type: attrs.TYPE || null,
        uri: attrs.URI ? resolveUrl(baseUrl, attrs.URI) : null,
        byterangeStart: attrs['BYTERANGE-START'] ? Number(attrs['BYTERANGE-START']) : null,
        byterangeLength: attrs['BYTERANGE-LENGTH'] ? Number(attrs['BYTERANGE-LENGTH']) : null,
      };
    } else if (line.startsWith('#EXT-X-RENDITION-REPORT:')) {
      const attrs = parseAttributeList(line.slice('#EXT-X-RENDITION-REPORT:'.length));
      renditionReports.push({
        uri: attrs.URI ? resolveUrl(baseUrl, attrs.URI) : null,
        lastMsn: attrs['LAST-MSN'] ? Number(attrs['LAST-MSN']) : null,
        lastPart: attrs['LAST-PART'] ? Number(attrs['LAST-PART']) : null,
      });
    } else if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) {
      // Must be tested BEFORE '#EXT-X-DISCONTINUITY' below - otherwise
      // the generic prefix check would incorrectly match this longer tag too.
      discontinuitySequence = Number(line.slice('#EXT-X-DISCONTINUITY-SEQUENCE:'.length));
      if (Number.isNaN(discontinuitySequence)) discontinuitySequence = null;
    } else if (line.startsWith('#EXT-X-START:')) {
      const attrs = parseAttributeList(line.slice('#EXT-X-START:'.length));
      startInfo = {
        timeOffset: attrs['TIME-OFFSET'] !== undefined ? Number(attrs['TIME-OFFSET']) : null,
        precise: (attrs.PRECISE || '').toUpperCase() === 'YES',
      };
    } else if (line.startsWith('#EXT-X-DISCONTINUITY')) {
      pendingDiscontinuity = true;
    } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      pendingProgramDateTime = line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length).trim();
    } else if (line.startsWith('#EXTINF:')) {
      const m = /^#EXTINF:([\d.]+)(?:,(.*))?$/.exec(line);
      if (m) {
        pendingDuration = Number(m[1]);
        pendingTitle = m[2] || '';
      }
    } else if (!line.startsWith('#') && line !== '') {
      // This is the segment's URI - collapse all "pending" values into one segment.
      segments.push({
        uri: resolveUrl(baseUrl, line),
        duration: pendingDuration,
        title: pendingTitle,
        programDateTime: pendingProgramDateTime,
        discontinuity: pendingDiscontinuity,
        parts: pendingParts,
      });
      pendingDuration = null;
      pendingTitle = '';
      pendingProgramDateTime = null;
      pendingDiscontinuity = false;
      pendingParts = [];
    }
  }

  // EXT-X-PART tags for the segment that hasn't finished yet (no
  // EXTINF/URI line yet) - typically the very last lines in an LL-HLS playlist.
  const trailingParts = pendingParts;

  return {
    type: 'media',
    version,
    targetDuration,
    mediaSequence,
    playlistType,
    endlist,
    key,
    map,
    serverControl,
    partTargetDuration,
    preloadHint,
    renditionReports,
    trailingParts,
    discontinuitySequence,
    startInfo,
    segments,
  };
}

/**
 * Main function: determines whether the text is a master or media playlist
 * and delegates to the right parser. Radio streams often lack a separate
 * master playlist - the URL then points directly at the media playlist, which
 * is completely normal and not an error.
 */
export function parseM3U8(text, baseUrl) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim());

  const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF:'));
  const isMedia = lines.some((l) => l.startsWith('#EXTINF:'));

  if (isMaster) return parseMasterPlaylist(lines, baseUrl);
  if (isMedia) return parseMediaPlaylist(lines, baseUrl);

  // Neither variant tags nor segment tags were found.
  return { type: 'unknown', version: null };
}

export { resolveUrl, parseAttributeList };
