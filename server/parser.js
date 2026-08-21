// parser.js
// Tolkar M3U8-text (HLS-manifest) till JavaScript-objekt.
// Ingen extern parser-bibliotek används - HLS-formatet är radbaserat
// och enkelt nog att tolka med enkla regex och tillståndsvariabler.

/**
 * Löser en (eventuellt relativ) URI mot manifestets egen URL.
 * HLS-manifest innehåller ofta relativa segment-URI:er
 * ("segment_123.ts") som måste slås ihop med manifestets bas-URL
 * för att bli klickbara/hämtningsbara.
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
 * Tolkar en attributlista av typen KEY=VALUE,KEY2="VALUE 2",KEY3=1920x1080
 * som förekommer efter t.ex. #EXT-X-STREAM-INF:. Måste hantera citerade
 * strängar där kommatecken INTE ska tolkas som separator (t.ex. CODECS).
 */
function parseAttributeList(str) {
  const attrs = {};
  if (!str) return attrs;

  // Matchar KEY=VÄRDE där värdet antingen är citerat ("...") eller ociterat
  // fram till nästa komma. Detta undviker att splitta CODECS="mp4a.40.2,avc1.4d401f"
  // på fel ställe.
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
 * Delar upp en enda #EXT-X-KEY: eller #EXT-X-MAP: -tagg-rad i sina attribut
 * och löser eventuell URI mot bas-URL:en.
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
 * Tolkar en master-playlist (den som listar #EXT-X-STREAM-INF-varianter).
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
      // Nästa icke-tomma, icke-kommentar-rad är variantens URI.
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

      i = j; // hoppa förbi URI-raden vi redan konsumerat
      continue;
    }
  }

  return { type: 'master', version, variants, audioRenditions };
}

/**
 * Tolkar en media-playlist (den som listar faktiska segment via #EXTINF).
 */
function parseMediaPlaylist(lines, baseUrl) {
  let version = null;
  let targetDuration = null;
  let mediaSequence = null;
  let playlistType = null;
  let endlist = false;
  let key = null; // senaste aktiva krypteringsnyckel (METHOD != NONE)
  let map = null; // #EXT-X-MAP (fMP4-initieringssegment)
  let serverControl = null; // #EXT-X-SERVER-CONTROL (rekommenderad livekant-distans m.m.)
  let partTargetDuration = null; // #EXT-X-PART-INF:PART-TARGET (LL-HLS del-segmentlängd)
  let preloadHint = null; // #EXT-X-PRELOAD-HINT (kommande del-segment som redan annonseras)
  const renditionReports = []; // #EXT-X-RENDITION-REPORT (status för andra renditions)
  let discontinuitySequence = null; // #EXT-X-DISCONTINUITY-SEQUENCE (startvärde för discontinuity-räknaren)
  let startInfo = null; // #EXT-X-START (TIME-OFFSET för var spelaren ska börja)

  const segments = [];

  // "Pending"-värden: HLS-taggar gäller för nästa segment-URI-rad,
  // så vi samlar dem tills vi stöter på raden som inte börjar med '#'.
  let pendingDuration = null;
  let pendingTitle = '';
  let pendingProgramDateTime = null;
  let pendingDiscontinuity = false;
  let pendingParts = []; // #EXT-X-PART (LL-HLS del-segment) för nästa segment

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
      // Måste testas FÖRE '#EXT-X-DISCONTINUITY' nedan - annars matchar
      // den generiska prefix-koll felaktigt även den här längre taggen.
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
      // Detta är segmentets URI - fäll ihop alla "pending"-värden till ett segment.
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

  // EXT-X-PART-taggar för det segment som ännu inte hunnit bli klart (inget
  // EXTINF/URI-rad än) - typiskt de allra sista raderna i en LL-HLS-playlist.
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
 * Huvudfunktion: avgör om texten är en master- eller media-playlist
 * och delegerar till rätt tolkare. Radio-strömmar saknar ofta en separat
 * master-playlist - URL:en pekar då direkt på media-playlistan, vilket
 * är fullt normalt och inte ett fel.
 */
export function parseM3U8(text, baseUrl) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim());

  const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF:'));
  const isMedia = lines.some((l) => l.startsWith('#EXTINF:'));

  if (isMaster) return parseMasterPlaylist(lines, baseUrl);
  if (isMedia) return parseMediaPlaylist(lines, baseUrl);

  // Varken variant-taggar eller segment-taggar hittades.
  return { type: 'unknown', version: null };
}

/**
 * Skriver om alla URI:er i en manifesttext så att de pekar tillbaka på
 * vår egen proxy (/api/proxy?url=...). Används av /api/proxy för att
 * hls.js ska kunna spela upp strömmen trots CORS-blockering hos CDN:en -
 * varje segment- och nyckel-URI måste gå via samma proxy som manifestet.
 */
export function rewriteManifestForProxy(text, baseUrl, proxyPath = '/api/proxy') {
  const toProxyUrl = (uri) => {
    const absolute = resolveUrl(baseUrl, uri);
    return `${proxyPath}?url=${encodeURIComponent(absolute)}`;
  };

  const lines = text.split(/\r?\n/).map((rawLine) => {
    const line = rawLine.trim();

    // Taggar som bär en URI="..." -attribut (kryptering, fMP4-init, alternativa ljudspår).
    if (
      line.startsWith('#EXT-X-KEY:') ||
      line.startsWith('#EXT-X-MAP:') ||
      line.startsWith('#EXT-X-MEDIA:')
    ) {
      return line.replace(/URI="([^"]*)"/, (_match, uri) => `URI="${toProxyUrl(uri)}"`);
    }

    // Vanliga segment-/variant-URI-rader (allt som inte är kommentar eller tomt).
    if (line !== '' && !line.startsWith('#')) {
      return toProxyUrl(line);
    }

    return rawLine;
  });

  return lines.join('\n');
}

export { resolveUrl, parseAttributeList };
