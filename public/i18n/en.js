// i18n/en.js
// English catalog. Must mirror i18n/sv.js key-for-key - test/i18n.test.js enforces
// this. See docs/i18n.md.

registerCatalog('en', {
  meta: {
    numberLocale: 'en-GB',
  },

  common: {
    yes: 'Yes',
    no: 'No',
    notFound: 'Not found',
    unknown: 'Unknown',
    language: 'Language',
  },

  units: {
    second: 's',
    minute: 'min',
    hour: 'h',
  },

  // Server-thrown errors: the server sends a stable i18nKey + params (see
  // server/errors.js), never a finished sentence - errorText() (shared.js) resolves
  // it against this namespace. errors.unknown is the last-resort fallback when an
  // error has neither a recognised i18nKey nor a usable message.
  errors: {
    unknown: 'Unknown error.',
    timeout: 'Timed out - the server did not respond within {seconds} seconds.',
    requestTimeout: 'The request took too long (over {seconds} seconds) and was aborted.',
    requestAborted: 'Request was aborted.',
    upstreamHttp: 'The server responded {status} {statusText}.',
    upstreamUnreachable: 'Could not connect to the server – {reason}.',
    upstreamUnreachableReasons: {
      ENOTFOUND: "the hostname couldn't be resolved",
      EAI_AGAIN: 'the DNS lookup could not be completed',
      ECONNREFUSED: 'the connection was refused',
      ECONNRESET: 'the connection was reset by the server',
      EHOSTUNREACH: "the host couldn't be reached",
      ETIMEDOUT: 'the connection attempt took too long',
      CERT_HAS_EXPIRED: "the server's TLS certificate has expired",
      UNABLE_TO_VERIFY_LEAF_SIGNATURE: "the server's TLS certificate could not be verified",
      UNKNOWN: 'unknown network error',
    },
    invalidManifest: "The response doesn't look like a valid M3U8 file (missing #EXTM3U).",
    invalidMpd: "The response doesn't look like a valid MPD manifest (DASH).",
    hlsNoVariants: 'Master playlist has no #EXT-X-STREAM-INF variants.',
    hlsNoVariantUrl: 'Could not find a variant URL in the master playlist.',
    hlsVariantNotMedia: "The variant URL didn't point to a media playlist.",
    dashTimelineTooLarge: 'SegmentTimeline for representation "{representationId}" has {entries} &lt;S&gt; entries (cap: {maxEntries}).',
    dashNoRepresentation: "The MPD's first Period contains no Representation to analyze.",
    manifestTooLarge: 'The response is larger than {limitMb} MB - not a reasonable manifest, so it was not fetched.',
    binaryMissing: 'Cannot find "{binary}" in PATH. Is ffmpeg installed?',
    ffprobeFailed: 'ffprobe could not analyze the stream.',
    ffmpegFailed: 'ffmpeg could not record the stream.',
    loudnessMeasurementFailed: 'ffmpeg could not measure the loudness of the recorded sample.',
    fileAudioMeasurementFailed: 'ffmpeg could not measure the audio in the file.',
    spectrogramTimeout: 'The spectrogram did not finish in time.',
    spectrogramFailed: 'ffmpeg could not render a spectrogram.',
    validation: {
      missingUrl: 'Parameter "url" is missing.',
      invalidUrl: '"{value}" is not a valid URL.',
      unsupportedProtocol: 'Only http and https URLs are supported.',
    },
    hostBlocked: '"{hostname}" points to an internal/private network and cannot be analyzed.',
    upload: {
      stalled: 'The upload stalled for more than {seconds} seconds.',
      tooLarge: 'The file is larger than {limitMb} MB and will not be analyzed.',
      empty: 'No file was received. Send the file contents as the request body.',
    },
    notAudioFile: {
      unreadable: 'The file could not be read as audio or media. Is it really an audio file?',
      noTrack: 'The file contains no audio track.',
    },
    busy: 'The server is already running as many concurrent analyses as it allows. Try again shortly.',
    requestTooLarge: 'The request is too large.',
    malformedJson: "The request's JSON could not be parsed.",
    internal: 'Unknown server error.',
    notFound: 'Unknown API route: {path}',
    warnings: {
      unparsableProbeJson: 'ffprobe did not return parsable JSON (exit code {code}). {stderr}',
      unparsableFramesJson: 'Metadata frames could not be read (exit code {code}). {stderr}',
    },
  },

  // ---------------------------------------------------------------------
  // app.js - HLS/DASH/Icecast snapshot analysis.
  // ---------------------------------------------------------------------

  dash: {
    addressingLabels: {
      timeline: 'SegmentTimeline',
      'template-number': 'SegmentTemplate ($Number$)',
      'segment-list': 'SegmentList',
      'base-url': 'Single file (BaseURL/SegmentBase)',
      none: 'No segment addressing found',
      unknown: 'Unknown',
    },
    noLatencyReasons: {
      vod: 'VOD (static MPD) - no live delay to calculate.',
      'no-availability-start-time': 'availabilityStartTime is missing or could not be parsed.',
    },
  },

  connection: {
    heading: 'Connection',
    status: 'Status',
    requestedUrl: 'Requested URL',
    finalUrl: 'Final URL',
    redirectedSuffix: 'redirected',
    contentType: 'Content-Type',
    server: 'Server',
    cacheControl: 'Cache-Control',
    expires: 'Expires',
    cors: 'CORS',
    corsPresent: 'Yes ({allowOrigin})',
    corsMissing: "No - CORS headers are missing. A browser-based player can't fetch the stream directly from the CDN without a proxy like this backend.",
    corsMissingShort: 'No - missing',
    extraHeadersHeading: 'x- / akamai- / icy- headers',
    extraHeadersMissing: 'No x-, akamai- or icy- headers.',
    headerTableName: 'Header',
    headerTableValue: 'Value',
  },

  variants: {
    heading: 'Variants',
    singleVariantNote: 'Only one variant is available. The URL points directly to the media playlist.',
    singleVariantNoteCopy: 'Only one variant is available (common for radio) - the URL points directly to the media playlist.',
    clickHint: 'Click a row to analyze that specific variant.',
    rowTitle: 'Click to analyze this variant',
    bandwidthHeader: 'Bandwidth (kbit/s)',
    averageHeader: 'Average (kbit/s)',
    codecsHeader: 'Codecs',
    resolutionHeader: 'Resolution',
    urlHeader: 'URL',
    unknownCodec: 'unknown codec',
    noVideo: 'no video',
    copyLine: '- {bandwidth} kbit/s (average {average}), {codecs}, {resolution}, {url}',
  },

  audio: {
    heading: 'Audio track',
    codec: 'Codec',
    sampleRate: 'Sample rate',
    channels: 'Channels',
    bitrate: 'Bitrate',
    bitrateUnknown: 'unknown (see measured bitrate below)',
    container: 'Container',
    unavailable: 'Could not be fetched (see warnings above).',
    unavailableCopy: 'Could not be fetched (see warnings).',
  },

  segments: {
    heading: 'Segments and buffer',
    version: 'Version',
    targetDuration: 'Target duration',
    mediaSequence: 'Media sequence',
    type: 'Type',
    live: 'Live',
    vod: 'VOD',
    segmentCount: 'Segments in window',
    windowLength: 'Window length',
    avgLength: 'Average length/segment',
    encryption: 'Encryption',
    off: 'Off',
    format: 'Segment format',
    fmp4: 'Fragmented MP4 (fMP4)',
    mpegts: 'Not fragmented (MPEG-TS)',
  },

  continuity: {
    heading: 'Continuity and start point',
    discontinuitySeqLabel: 'EXT-X-DISCONTINUITY-SEQUENCE',
    discontinuitySeqNotFound: 'Not found (default: 0)',
    discontinuitiesLabel: 'Discontinuities',
    discontinuitiesNone: 'None in the current window.',
    discontinuitiesCount: '{count} - at sequence number(s) {positions}.',
    startLabel: 'EXT-X-START',
    startNotFound: 'Not found.',
    startBehind: 'The player starts {offset} seconds behind the live edge.',
    startAfterWindow: 'The player starts {offset} seconds after the start of the window.',
  },

  lowLatency: {
    heading: 'Low-Latency HLS',
    notPresent: 'No LL-HLS tags found in the manifest.',
    contradiction: 'Contradiction: the CDN header <code>{header}: {value}</code> suggests LL-HLS support, but no LL-HLS tags were found in the manifest.',
    contradictionCopy: 'Contradiction: the header {header}: {value} suggests LL-HLS support, but no LL-HLS tags were found.',
    canBlockReload: 'CAN-BLOCK-RELOAD',
    holdBack: 'HOLD-BACK',
    partHoldBack: 'PART-HOLD-BACK',
    canSkipUntil: 'CAN-SKIP-UNTIL',
    canSkipDateranges: 'CAN-SKIP-DATERANGES',
    partTarget: 'PART-TARGET',
    partsIntro: 'Parts (EXT-X-PART) in the most recently finished segment:',
    nextPartsIntro: 'Parts for the next, not-yet-finished segment:',
    partsIndexHeader: '#',
    partsDurationHeader: 'Duration',
    partsIndependentHeader: 'Independent (INDEPENDENT)',
    partsUriHeader: 'URI',
    preloadHint: 'PRELOAD-HINT',
    renditionReportIntro: 'RENDITION-REPORT (status of other renditions):',
    renditionHeader: 'Rendition',
    renditionLastMsnHeader: 'Latest media sequence',
    renditionLastPartHeader: 'Latest part',
    partsCopyLine: 'Parts in the most recent segment: {countOrNotFound}',
    nextPartsCopyLine: 'Parts for the next segment: {count}',
    renditionCopyEntry: '{uri} (msn {lastMsn}, part {lastPart})',
  },

  latency: {
    heading: 'Latency',
    unavailable: 'Latency cannot be calculated (no PROGRAM-DATE-TIME timestamp in the manifest).',
    method: 'Calculation method',
    methodMeasured: 'Measured directly',
    methodCalculated: 'Calculated from segment sum',
    oldestTs: 'Oldest segment timestamp',
    newestTs: 'Newest segment timestamp',
    delayFromOldest: 'Delay (from oldest)',
    delayFromNewest: 'Delay (from newest, live edge)',
    taggedSegments: { one: '{count} tagged segment', other: '{count} tagged segments' },
  },

  bitrate: {
    heading: 'Measured bitrate',
    average: 'Average (measured)',
    declared: 'Declared bandwidth',
    declaredUnknown: 'unknown (no declared bandwidth)',
    declaredUnknownCopy: 'unknown',
    timestampHeader: 'Timestamp',
    bytesHeader: 'Bytes',
    bitrateHeader: 'Bitrate (kbit/s)',
    failed: 'failed',
    samplesIntro: 'Measured segment samples (timestamp, size, bitrate):',
    samplesIntroDash: 'Measured segment samples (size, bitrate):',
  },

  id3: {
    heading: 'Now playing (ID3)',
    loading: 'Fetching…',
    noneFound: 'No ID3 metadata found in this stream (recording: {duration}, measured {bitrate} kbit/s).',
    noneFoundCopy: 'No ID3 metadata found (recording: {duration}, measured {bitrate} kbit/s).',
    timeInSegmentHeader: 'Time in segment',
    tagsHeader: 'Tags',
    fetchFailed: 'Could not be fetched: {message}',
    notFetched: 'Not fetched (the analysis was cancelled or is still pending).',
    noUrl: 'No URL to record a sample from.',
  },

  networkPath: {
    heading: 'Network path',
    headerTableName: 'Header',
    headerTableValue: 'Value',
    noHeaders: 'No headers matching the routing patterns (x-cache*, x-served*, x-edge*, via, x-amz-cf*, cf-*, x-akamai*) were found.',
    noMatchingHeadersCopy: 'No matching routing headers found.',
    geoHint: 'Possible geographic hint',
    geoHintFound: '{raw} (a guess based on a common node-naming pattern, not confirmed)',
    geoHintFoundCopy: '{raw} (unverified guess)',
    dnsLookup: 'DNS lookup',
    dnsLookupFailed: 'Could not resolve: {error}',
    dnsLookupFailedCopy: 'could not resolve ({error})',
    dnsNoAddresses: 'No addresses found',
    dnsNoAddressesCopy: 'no addresses',
    ipGeo: 'Geographic estimate (IP database)',
    ipGeoCopy: 'Geographic estimate (IP database, unverified)',
    ipGeoNotFound: 'Not found',
    ipGeoUnknown: 'unknown',
    dnsLabel: 'DNS lookup ({hostname})',
  },

  manifest: {
    headingHls: 'Raw manifest',
    headingDash: 'Raw manifest (MPD)',
    master: 'Master',
    media: 'Media',
    mpd: 'MPD',
    truncatedNote: 'Showing the first {shown} of {total} lines. Open the URL above to see the full manifest.',
  },

  dashRepr: {
    heading: 'Representations',
    analyzed: 'Analyzed: <span class="mono">{id}</span> (the first audio representation in period {period}). Unlike HLS variants, DASH rows can\'t be clicked to re-analyze - the whole MPD is already fetched.',
    analyzedCopy: 'Analyzed: {id} (period {period} of {periodCount})',
    multiPeriodNote: 'The MPD has {periodCount} periods. Only period {period} (id "{periodId}") is analyzed - other periods\' data isn\'t mixed in.',
    xlinkNote: "The analyzed period references an external (xlink) period. It isn't fetched and isn't included in the analysis.",
    typeHeader: 'Type (language)',
    idHeader: 'ID',
    bandwidthHeader: 'Bandwidth (kbit/s)',
    codecsHeader: 'Codecs',
    resolutionHeader: 'Resolution / sample rate',
    unknownCodec: 'unknown codec',
    copyLine: '- [{type}] {id}{chosenSuffix}: {bandwidth} kbit/s, {codecs}, {size}',
    chosenSuffix: ' (chosen)',
  },

  dashSegments: {
    presentationType: 'Presentation type',
    live: 'Live (dynamic)',
    vod: 'VOD (static)',
    addressing: 'Segment addressing',
    length: 'Segment length',
    count: 'Segment count',
    estimated: ' (estimated)',
    window: 'Window / DVR depth',
    minBufferTime: 'minBufferTime',
    minimumUpdatePeriod: 'minimumUpdatePeriod',
    mediaPresentationDuration: 'mediaPresentationDuration',
    encryption: 'Encryption',
    off: 'Off',
    format: 'Segment format',
    fmp4: 'Fragmented MP4 (fMP4)',
    noInit: 'No separate init segment',
    initSegment: 'Init segment',
  },

  dashLatency: {
    unavailable: 'Latency cannot be calculated for this stream.',
    method: 'Calculation method',
    methodDeclared: 'Declared in the manifest',
    methodEstimated: 'Estimated from segment length',
    availabilityStartTime: 'availabilityStartTime',
    epochAnchored: ' (epoch-anchored)',
    epochAnchoredCopy: 'epoch-anchored',
    publishTime: 'publishTime',
    manifestAge: 'Manifest age',
    manifestAgeUnavailable: 'Not available (publishTime is epoch-anchored - simulated live)',
    manifestAgeUnavailableCopy: 'not available (epoch)',
    suggestedDelay: 'suggestedPresentationDelay',
    estimatedDelay: 'Estimated live delay',
    estimatedSuffix: ' (rough)',
    minimumUpdatePeriod: 'minimumUpdatePeriod',
    timeShiftBufferDepth: 'timeShiftBufferDepth',
  },

  icecastStation: {
    heading: 'Station',
    unavailable: 'No station metadata could be fetched (see warnings above).',
    metadataPending: 'Metadata is enabled (every {metaInt} bytes) but no title block had been sent by the time the sample finished.',
    metadataOff: 'The stream sends no track title in the audio (icy-metaint is missing). Common - not an error.',
    metadataOffCopy: '(the stream sends no track title)',
    metadataPendingCopy: '(no title block had been sent)',
    name: 'Name',
    nowPlaying: 'Now playing',
    genre: 'Genre',
    description: 'Description',
    homepage: 'Homepage',
    declaredBitrate: 'Declared bitrate',
    declaredSampleRate: 'Declared sample rate',
    serverSoftware: 'Server software',
    publiclyListed: 'Publicly listed',
    publiclyListedYes: 'Yes (icy-pub: 1)',
    inStreamMetadata: 'In-stream metadata',
    inStreamMetadataYes: 'Yes, every {metaInt} bytes',
    inStreamMetadataYesCopy: 'Yes (every {metaInt} bytes)',
    rawMetaBlock: 'Raw metadata block:',
  },

  icecastSample: {
    heading: 'Audio sample',
    recording: 'Recording…',
    notFetched: 'Not fetched (the analysis was cancelled or is still pending).',
    id3Intro: 'ID3 frames in the stream (unusual for Icecast):',
    timeInSampleHeader: 'Time in sample',
    tagsHeader: 'Tags',
    average: 'Measured bitrate',
    recordedLength: 'Recorded length',
    connectBurst: 'Server buffer on connect',
    sampleSize: 'Sample size',
    container: 'Container',
    burstNone: 'none noticeable (the stream was delivered in real time)',
    burstNoneCopy: 'none noticeable (real time)',
    burstAtLeast: 'at least {seconds}',
    burstApprox: '≈ {seconds}',
    burstAtLeastSuffix: ' (the whole sample drained out of the buffer)',
  },

  controls: {
    logButtonHint: 'Follow the stream over time instead of taking a snapshot',
    copyBtn: 'Copy analysis',
    copyBtnTitle: 'Copy all analysis data (except the raw manifest) as text, e.g. to paste into an AI service',
    copied: 'Copied!',
    copyFailed: 'Could not copy',
    enterUrlFirst: 'Enter a URL first.',
  },

  warnings: {
    heading: 'Warnings (partial result)',
    prefix: 'Note: {message}',
  },

  error: {
    heading: 'Error',
    httpStatus: 'HTTP status',
    responseBody: 'Response body (excerpt)',
    likelyCause: 'Likely cause',
    likelyCauseGeoblock: 'Geoblocking (403 with an empty response)',
    whatCameBack: 'What came back',
    installation: 'Installation',
    stderr: 'Error output',
    url: 'URL',
    serverUnreachable: 'Could not reach the server: {message}',
  },

  flow: {
    analyzing: 'Analyzing…',
    fetchingNowPlaying: 'Fetching now playing…',
    recordingSample: 'Recording audio sample…',
    analyzedFrom: 'Master: <span class="mono">{master}</span> → Analyzing: <span class="mono">{target}</span>',
    streamAnalysisHls: 'Stream analysis (HLS): {url}',
    streamAnalysisDash: 'Stream analysis (DASH): {url}',
    streamAnalysisIcecast: 'Stream analysis (Icecast/radio): {url}',
    variantFromMaster: '(Variant chosen from master: {master})',
    generated: 'Generated: {timestamp}',
  },

  nav: {
    urlLabel: 'Stream URL',
    urlPlaceholder: 'Stream URL – HLS, DASH or Icecast/radio',
    analyzeBtn: 'Analyze',
    logBtn: 'Log',
    logBtnTitle: 'Follow the stream over time instead of taking a snapshot',
    fileRowPrefix: 'or analyze an audio file:',
    filePick: 'Choose audio file…',
  },

  faq: {
    summary: 'About this tool',
    intro: `Audio analyzer fetches and analyzes an audio stream: connection and CORS, audio codec,
      segments and buffer, latency, measured bitrate, "now playing" and the raw manifest.
      Choose <strong>Analyze</strong> for a snapshot with all metadata, or <strong>Log</strong> to
      follow the stream's loudness over time instead.
      Fetches happen on the server (CDNs rarely send CORS headers), and the audio is
      inspected with <code>ffprobe</code>/<code>ffmpeg</code>. HLS (<code>.m3u8</code>),
      MPEG-DASH (<code>.mpd</code>) and Icecast/SHOUTcast/RSAS.`,
    hlsSummary: 'How do I find the HLS address (<code>.m3u8</code>)?',
    hlsBody: `Open the page that plays the stream, open the browser's developer tools (F12)
        → the Network tab, filter on <code>m3u8</code>. Start playback and the URL
        that shows up (often <code>master.m3u8</code>, <code>playlist.m3u8</code> or
        <code>chunklist.m3u8</code>) is the one to paste here. Sometimes it's also
        directly in the page source or in a &lt;video&gt;/&lt;source&gt; tag.`,
    dashSummary: 'How do I find the DASH address (<code>.mpd</code>)?',
    dashBody: `Same way as for HLS: developer tools → Network, filter on <code>mpd</code>
        or <code>dash</code>. The URL ends in <code>.mpd</code> (often
        <code>manifest.mpd</code> or <code>Manifest.mpd</code>). DASH is more common
        for TV/video than for pure audio streams.`,
    icecastSummary: 'How do I find the Icecast/radio address?',
    icecastBody1: `Radio streams are usually a direct URL to a "mount" — e.g.
        <code>.../stream</code>, <code>.../live</code>, <code>.../128</code> or something
        ending in <code>.mp3</code>/<code>.aac</code>. Find it by:`,
    icecastBody2: `(1) downloading the station's playlist (a <code>.pls</code> or <code>.m3u</code> file,
        often behind a "listen in external player" link) and opening it in a text editor -
        it contains the raw URL.`,
    icecastBody3: `(2) developer tools → Network, filter on <code>media</code> or <code>mp3</code>
        while the stream plays; or (3) check the station's own list of direct links.`,
    fileSummary: 'What do I get from analyzing a file?',
    fileBody1: `Upload a finished audio file and the whole thing gets measured: all metadata (codec,
        bit depth, sample rate, tags, cover art, chapters), loudness (LUFS) and true peak
        as a curve across the whole file, dynamics (LRA, crest factor, clipping), stereo
        image and phase, and a spectrogram – where a razor-sharp edge high up reveals a
        file made from a lossy source (e.g. an MP3 re-encoded to FLAC).`,
    fileBody2: "The file is uploaded to the tool's server, analyzed with ffmpeg and not saved.",
    loggingSummary: 'How does logging work?',
    loggingBody1: `Logging records 15 seconds of audio, measures loudness (LUFS, True Peak)
        and silence in that sample, then immediately starts the next 15-second recording.
        So the measurement is continuous, not just periodic spot checks.
        Silence that spans the boundary between two recordings is captured in full,
        with the correct start and end time.`,
    loggingBody2: `The log only lives in this browser tab. Close the tab without exporting
        (JSON or CSV) and it's gone. Logging can't be paused, only stopped.
        Clicking Log again starts a completely new log from zero.`,
    loggingBody3: `If the tool's own server goes down mid-log (as distinct from the audio
        stream itself having a problem), logging stops automatically after two failed
        attempts in a row.`,
    whyFailsSummary: 'Why does analysis sometimes fail?',
    whyFailsBody: `Common causes: geoblocking (a 403 response, often with an empty body), DRM-protected
        DASH (the protection shows up, but ffprobe can't decode the audio), a URL that
        points to a player page instead of the manifest itself, or an older SHOUTcast v1
        server that responds with the line <code>ICY 200 OK</code> instead of plain HTTP.`,
  },

  // ---------------------------------------------------------------------
  // log.js - the stream log.
  // ---------------------------------------------------------------------

  log: {
    gapLabels: {
      silence: 'Silence',
      outage: 'Stream down',
    },
    eventLabels: {
      'metadata-change': 'Metadata change',
      'format-change': 'Format change',
      clipping: 'Clipping',
      'loudness-drift': 'Loudness drift',
      note: 'Note',
      silence: 'Silence',
      outage: 'Stream down',
    },
    entryErrors: {
      busy: 'Server busy.',
      noConnection: 'Could not reach the server.',
      unknown: 'Unknown error',
    },
    events: {
      heading: 'Events',
      filterLabel: 'Show:',
      filterAll: 'All',
      filterNone: 'None',
      noneMatchFilter: 'No events match the selected filters.',
      driftText: '{lufs} LUFS (target {target} ±{tolerance} LU)',
      formatChangeText: '{prevCodec} {prevRate} Hz {prevChannels} channel(s) → {codec} {rate} Hz {channels} channel(s)',
      clippingText: 'True peak {value} dBTP',
    },
    summary: {
      heading: 'Summary',
      loggedSince: 'Logging since',
      stoppedSuffix: ' (stopped)',
      measurements: 'Measurements',
      measurementsValue: '{count} total, {percent}% successful',
      busySkipped: '{count} due to server load',
      noConnectionSkipped: '{count} because the server could not be reached',
      skippedSuffix: ' ({notes} skipped)',
      meanLufs: 'Mean LUFS',
      meanBitrate: 'Mean bitrate',
      longestSilence: 'Longest silence',
      longestOutage: 'Longest outage',
      countTotal: ' ({count} total)',
      noSilence: 'none',
      noOutages: 'none',
      clippingLabel: 'Measurements above {dbtp} dBTP',
    },
    silenceList: {
      heading: 'Silence and outages',
      typeHeader: 'Type',
      startHeader: 'Start',
      endHeader: 'End',
      durationHeader: 'Duration',
      ongoing: 'ongoing',
    },
    table: {
      heading: 'Measurements',
      showingNote: 'Showing the last {shown} of {total}. The export includes all of them.',
      timeHeader: 'Time',
      lufsHeader: 'LUFS',
      truePeakHeader: 'True peak',
      silenceHeader: 'Silence (s)',
      bitrateHeader: 'kbit/s',
      nowPlayingHeader: 'Now playing',
      statusHeader: 'Stream status',
      ok: 'OK',
      okLevelNotMeasured: 'OK (level not measured)',
    },
    chart: {
      heading: 'Loudness',
      legendLufs: 'Integrated loudness (LUFS)',
      legendTruePeak: 'True peak (dBTP)',
    },
    warningBanner: {
      message: "You've been logging for over {hours} hours ({count} measurements). Consider exporting and clearing - it all lives in this browser tab.",
      dismiss: 'Dismiss',
    },
    controls: {
      stop: 'Stop logging',
      silenceFromLabel: 'Log silence from',
      driftToggle: 'Log loudness drift',
      driftTargetLabel: 'target',
      noteBtn: 'Note',
      notePrompt: 'Note:',
      exportJson: 'Export JSON',
      exportCsv: 'Export CSV',
      clear: 'Clear',
      confirmClear: 'The log has not been exported. Clear anyway?',
      driftHelp:
        'Flags every measurement outside a target you set, so you can see whether the channel is drifting in loudness over time. ' +
        'The target is given in <strong>LUFS</strong> - the absolute loudness. The tolerance is given in <strong>LU</strong> (Loudness Units), ' +
        'which is the same scale but used for <em>differences</em>: 1 LU = 1 dB. A target of −16 LUFS ±2 LU means everything between ' +
        '−18 and −14 LUFS counts as normal. Guideline values: −23 LUFS for broadcast per EBU R128, −14 to −16 LUFS for ' +
        'streaming services. Off by default, since most streams sit outside an arbitrary target most of the time.',
    },
    flow: {
      checkingStream: 'Checking the stream…',
      analysisFailed: 'Analysis failed.',
      serverRespondedWith: 'The server responded {status}.',
      backendUnreachable:
        'The server is no longer responding - logging stopped automatically. ' +
        'Check that the server is running, and start logging again once it is back up.',
    },
    csv: {
      tid: 'time',
      stromOk: 'stream_ok',
      status: 'status',
      lufsI: 'lufs_i',
      truePeakDbtp: 'true_peak_dbtp',
      tystnadSek: 'silence_sec',
      fonsterSek: 'window_sec',
      bitrateKbps: 'bitrate_kbps',
      codec: 'codec',
      samplingsfrekvens: 'sample_rate',
      kanaler: 'channels',
      nuSpelas: 'now_playing',
      anmarkning: 'note',
    },
    export: {
      filenamePrefix: 'streamlog',
    },
  },

  // ---------------------------------------------------------------------
  // file.js - the uploaded-file analysis view.
  // ---------------------------------------------------------------------

  file: {
    controls: {
      copyBtnTitle: 'Copy the entire file analysis as text',
    },
    tagLabels: {
      title: 'Title',
      artist: 'Artist',
      album: 'Album',
      album_artist: 'Album artist',
      date: 'Year',
      track: 'Track',
      genre: 'Genre',
      composer: 'Composer',
      comment: 'Comment',
      publisher: 'Publisher',
      copyright: 'Copyright',
      language: 'Language',
    },
    overview: {
      heading: 'File',
      tagHeader: 'Tag',
      valueHeader: 'Value',
      noTags: 'No tags (artist/title/album …) in the file.',
      replayGainLabel: 'ReplayGain tags',
      replayGainNote: ' (set by an earlier tool, not by us):',
      chaptersLabel: 'Chapters',
      chapterFromHeader: 'From',
      chapterToHeader: 'To',
      chapterTitleHeader: 'Title',
      tagsHeading: 'Tags',
      filenameLabel: 'Filename',
      containerLabel: 'Container',
      lengthLabel: 'Length',
      taggedLengthLabel: 'Length per tag (TLEN)',
      tlenMismatch: "differs from the file's measured length ({duration})",
      fileSizeLabel: 'File size',
      bitrateLabel: 'Bitrate (average)',
      sampleFormatLabel: 'Sample format',
      bitDepthLabel: 'Bit depth',
      encoderLabel: 'Encoder',
      coverArtLabel: 'Cover art',
      bitDepthNotApplicable: 'not applicable ({fmt} – float)',
      bitDepthValue: '{declared} bits',
      bitDepthMismatch: '{declared} bits declared, {used} actually used',
      coverArtNone: 'no',
      coverArtPresent: 'yes',
      unknownFormat: 'unknown format',
      truncationNote: 'The file is longer than {minutes} minutes – the analysis below covers the first {duration}.',
    },
    phase: {
      heading: 'Phase and mono passages',
      silenceExcludedNote: ' (silence excluded):',
      outOfPhaseKind: 'Out of phase (cancels in mono)',
      monoKind: 'Mono (channels identical)',
      typeHeader: 'Type',
      fromHeader: 'From',
      toHeader: 'To',
      durationHeader: 'Duration',
      toEnd: 'to the end',
      outOfPhaseShort: 'Out of phase',
      monoShort: 'Mono',
      copyToEnd: 'end',
    },
    stereoVerdict: {
      dualMono: 'identical channels (dual mono – no stereo image)',
      verySmall: 'very narrow stereo image, nearly mono',
      normal: 'normal stereo image, mono-compatible',
      wide: 'wide stereo image',
      veryWide: 'very wide / decorrelated – check in mono',
      canceling: 'the channels work against each other – energy is lost when summed to mono',
    },
    stereo: {
      label: 'Stereo correlation',
      notMeasured: '– (could not be measured)',
      tooQuiet: '– (too quiet to measure)',
      windowNote: ' (measured over the first {duration})',
    },
    loudness: {
      heading: 'Loudness and dynamics',
      couldNotMeasure: 'Could not be measured.',
      chartHeading: 'Loudness',
      integratedLabel: 'Integrated level',
      lraLabel: 'Loudness range (LRA)',
      lraRangeSuffix: ' ({low} … {high} LUFS)',
      truePeakLabel: 'True peak',
      truePeakSilentValue: '−∞ dBTP (completely digitally silent)',
      samplePeakLabel: 'Sample peak',
      samplePeakSilentValue: '−∞ dBFS',
      plrLabel: 'PLR (peak − level)',
      crestFactorLabel: 'Crest factor',
      dcOffsetLabel: 'DC offset',
      rmsLabel: 'RMS level',
      noiseFloorLabel: 'Noise floor',
      clippingCountLabel: 'Samples at digital max',
    },
    spectrogram: {
      heading: 'Spectrogram',
      windowNote: 'Showing the first {duration}.',
      imgAlt: 'Spectrogram of the file',
      noImage: 'No image could be created.',
    },
    chart: {
      legendShortTerm: 'Short-term loudness (LUFS)',
      legendTruePeak: 'True peak (dBTP)',
      legendIntegrated: 'Integrated level',
    },
    copyText: {
      title: 'File analysis: {name}',
      unnamedFile: '(unnamed)',
      partialResultsHeading: 'PARTIAL RESULTS',
    },
    flow: {
      analyzing: 'Analyzing {name} …',
      analysisFailed: 'Analysis failed.',
    },
  },

  terms: {
    // Section headings (h2)
    anslutning:
      "Shows whether fetching the manifest succeeded and which HTTP headers the CDN responded with, including whether CORS (Cross-Origin Resource Sharing) is allowed. Without CORS, a regular browser can't fetch the stream directly without a proxy",
    varianter:
      'An HLS master playlist can list several variants of the same stream at different qualities, so the player can pick the one that fits the listener\'s connection.',
    ljud: "Technical information about the audio encoding itself, obtained by running the ffprobe tool against the stream.",
    segment:
      'HLS splits the stream into short segments that the player downloads one at a time. This section shows how the segments are structured and how large a "window" of them is currently available.',
    latens:
      'Compares the timestamp in the segments with the system clock to estimate how far behind the actual broadcast the stream is. Requires the manifest to contain PROGRAM-DATE-TIME tags.',
    bitrate:
      "The actual data rate per second, measured by fetching the size of the most recent segments and comparing it with their playback length, then compared against the bandwidth the manifest declares.",
    id3:
      "Some audio streams embed metadata (e.g. track title and artist) directly in the audio segments, using the same ID3 technique as mp3 files. The tool records a few seconds of the stream and looks for such metadata, but many streams lack it entirely.",
    manifest:
      'The raw, unparsed text of the .m3u8 file fetched from the server, describing which segments or variants exist.',
    natverksvag:
      "Shows which CDN node or edge server responded, read from headers that match common routing conventions (x-cache, x-served, via, cf-*, x-amz-cf-* etc.), plus a DNS lookup of the hostname.",

    // Connection (dt)
    status: 'The HTTP status code the server responded with. 200 means OK; 4xx/5xx means an error on the client or server side, respectively.',
    'begard-url': 'The URL entered in the field above and submitted for analysis.',
    'slutlig-url':
      'The URL after following any redirects (HTTP 3xx). Differs from the requested URL if the server redirected the request.',
    'content-type':
      'What type of content the response claims to be. A valid HLS manifest usually has application/x-mpegURL or application/vnd.apple.mpegurl.',
    server: 'Which web server software responded, if it reveals that.',
    'cache-control':
      'Controls how long browsers and intermediate caches may store the response. Live manifests often have "no-cache" since the content keeps changing.',
    expires:
      'The point in time the server says the response becomes too old to use - an older alternative to Cache-Control that some CDNs still send.',
    cors:
      "Cross-Origin Resource Sharing - the header that decides whether a web page on another domain is allowed to read the response. Without it, a proxy has to fetch the stream instead of the browser.",
    'geo-hint':
      'Many CDN nodes are named with an airport code (e.g. ARN for Stockholm Arlanda) followed by numbers. This is an unverified guess based on that pattern in the node name',
    'dns-lookup':
      "Which IP addresses the hostname currently resolves to, looked up by the tool's own backend. CDNs often use DNS-based load balancing, so the result can vary between calls and isn't necessarily the same node that actually answered the request.",
    'ip-geo':
      'City/country for each IP, from a local offline database. A rough complement to the hint above',
    'extra-headers':
      'HTTP headers in the response whose name starts with "x-" (an old convention for non-standard headers), contains "akamai", or starts with "icy-". Often the most telling ones for what happened at the CDN or stream server.',

    // Variants (th)
    'variant-bandbredd':
      "The peak bandwidth (kbit/s) the variant's encoding may require, per the manifest. A guideline value, not the same as the actually measured bitrate.",
    'variant-snitt':
      'Average bandwidth (kbit/s) for the variant over time, if the manifest states it, and usually more realistic than the peak value.',
    codecs: 'States exactly which codecs are used, in standardized form. "mp4a.40.2", for example, means AAC-LC audio.',
    upplosning: 'The video resolution in width × height pixels. Empty for pure audio streams like radio.',
    'variant-url': "The link to this particular variant's own media playlist.",

    // Audio track (dt)
    codec: "Which audio codec the segments are encoded with, e.g. AAC. The profile in parentheses (e.g. LC) describes a specific variant of the codec.",
    samplingsfrekvens: 'How many times per second the audio was sampled at recording. Given in Hertz.',
    kanaler: '1 is mono, 2 is stereo, and more channels for surround sound.',
    'audio-bitrate': 'How much data the audio is encoded with per second.',
    container: 'The file format the segments are packaged in, e.g. MPEG-TS (.ts) or fragmented MP4 (fMP4).',

    // Segments and buffer (dt)
    version: 'The HLS protocol version the manifest is written for, which determines which tags and features may be used.',
    targetduration:
      'The longest allowed segment length in seconds. Players use this value to know how often they should fetch a new manifest.',
    mediasequence:
      'A running number stating which segment in the overall stream is first in the current list. Increases as older segments are dropped from the window.',
    typ: 'Live means the manifest updates continuously with no end; VOD means a finished, complete stream.',
    'antal-segment': 'How many segments are currently listed in the manifest\'s "window", i.e. the visible slice of the ongoing stream.',
    fonsterlangd:
      "The combined playback length in seconds of all segments in the window, and therefore roughly how much the player can buffer without fetching a new manifest.",
    snittlangd: 'Average length per segment, calculated from the window\'s total length divided by the number of segments.',
    krypterat: 'Whether the segments are encrypted per the EXT-X-KEY tag. The player needs the right key to play the stream.',
    fmp4: 'Whether the segments are in fragmented MP4 format instead of the older MPEG-TS, indicated by the EXT-X-MAP tag.',
    discontinuities:
      "Number of EXT-X-DISCONTINUITY jumps in the window. These are points where the encoding, timebase or format changes (e.g. at an ad break). Each one forces the player to flush and rebuild its buffer, which can be heard as a brief pause.",

    // Low-Latency HLS (h3 + dt)
    llhls:
      'LL-HLS (Low-Latency HLS) is a set of extensions to the HLS standard that reduces delay by splitting segments into smaller "parts" the player can fetch before the whole segment is done. Requires support from the packager, CDN and player alike.',
    'll-can-block-reload':
      "Whether the server supports \"blocking\" manifest requests. The player can ask the server to hold the response until a new segment or part exists, instead of polling. A basic prerequisite for LL-HLS.",
    'll-hold-back':
      'Recommended distance (seconds) from the live edge that the manifest asks regular players to keep, from EXT-X-SERVER-CONTROL. A low value means the stream is built for low latency.',
    'll-part-hold-back':
      'Same as HOLD-BACK, but specifically for players that support LL-HLS and can buffer in parts. Normally a lower value since they can stay closer to the live edge.',
    'll-can-skip-until':
      'How far back a player may request a shortened manifest update (EXT-X-SKIP) instead of the full list, to save bandwidth on frequent updates.',
    'll-can-skip-dateranges':
      'Whether the server also supports skipping EXT-X-DATERANGE tags in a shortened manifest update (EXT-X-SKIP).',
    'll-part-target':
      'The target playback length for the small parts that LL-HLS splits each regular segment into, from EXT-X-PART-INF. Parts let the player start playing before a whole regular segment is finished.',
    'll-preload-hint':
      'EXT-X-PRELOAD-HINT announces an upcoming part or initialization segment that the player can start requesting before it has finished being produced, via a blocking request.',

    // Continuity and start point (h3 + dt)
    kontinuitet:
      'Shows where in the stream the encoding or timebase actually changes (discontinuities), and where a player is recommended to start playback. Two separate things that are easily conflated with latency and the buffer window.',
    'discontinuity-sequence':
      'The starting value of the discontinuity counter in this manifest (EXT-X-DISCONTINUITY-SEQUENCE). Used by players to track continuity jumps correctly even after switching between variants.',
    'ext-x-start':
      "States where in the stream a player is recommended to start playback (TIME-OFFSET), not where it can actually start. A positive value is counted from the start of the window, a negative value back from the live edge.",

    // Latency (dt)
    'latens-metod':
      '"Measured directly" means several segments have their own timestamps and the figure is reliable. "Calculated from segment sum" means only one segment in the window had a timestamp (common in older HLS) and the rest is extrapolated by adding up segment lengths, which makes the figure less certain.',
    'aldsta-ts': 'The timestamp of the oldest segment in the visible window, per its PROGRAM-DATE-TIME tag.',
    'nyaste-ts': 'The timestamp of the most recent segment in the visible window',
    'fordrojning-aldsta': "How many seconds have passed between the oldest segment's timestamp and now. Roughly the age of the whole buffer window.",
    'fordrojning-nyaste':
      'How many seconds have passed since the latest available segment was recorded. Gives a measure of the actual delay a listener experiences.',

    // Measured bitrate (dt/th)
    'snitt-uppmatt':
      'Average bitrate (kbit/s), calculated from the actual file sizes of the most recently fetched segments divided by their playback length.',
    'deklarerad-bandbredd': 'The bandwidth the manifest states for the selected variant, for comparison with what was actually measured.',
    tidsstampel: 'The time the segment was recorded, per its PROGRAM-DATE-TIME tag.',
    bytes: "The segment's actual file size in bytes, obtained via a HEAD request against the segment URL.",
    'bitrate-kolumn': "The segment's size converted to kbit/s based on its playback length.",

    // Now playing (th)
    'tid-i-segment': 'Where in the recorded sequence, in seconds from the start, the ID3 tag was found.',
    taggar: 'The actual metadata found, e.g. track title or artist, in its raw form.',

    // --- DASH ---
    mpd:
      "Media Presentation Description - the XML manifest that is DASH's counterpart to the HLS master playlist. A single document describes the whole stream: all qualities, how segments are addressed, and (for live) the timeline.",
    representation:
      'A single quality level of a stream in DASH (equivalent to an HLS variant). The tool analyzes the first audio representation in the first period, the same "first, not best" choice the HLS side makes.',
    adaptationset:
      'A group of representations of the same type and language (e.g. "all English audio") that a player can freely switch between. The type (audio/video/text) is read from contentType, mimeType or the codec string.',
    presentationtype:
      'static means a finished VOD resource; dynamic means a live stream whose manifest updates continuously. Corresponds to the HLS live/VOD distinction.',
    segmenttemplate:
      'How the segment URLs are built. SegmentTemplate with $Number$ counts up a running number; SegmentTimeline lists each segment\'s length explicitly (with r = repeat count); SegmentList enumerates finished URLs. The tool generates the most recent URLs and HEAD-fetches them to measure bitrate.',
    mediapresentationduration:
      "The stream's total length for a static (VOD) MPD, expressed as an ISO 8601 duration (e.g. PT10M30S). Absent for dynamic live streams.",
    minbuffertime:
      "The minimum amount of media (in seconds) a player should have buffered before playback to handle network variation, per the manifest. Roughly DASH's counterpart to HLS target duration as a buffer guideline.",
    minimumupdateperiod:
      'How often (seconds) a player must re-fetch the MPD for a dynamic stream to discover new segments. A low value suggests the stream is built for low latency.',
    timeshiftbufferdepth:
      "How far back in time (seconds) a live stream can be rewound, DASH's DVR window. Roughly corresponds to how many segments HLS keeps in its window.",
    suggestedpresentationdelay:
      'The delay from the live edge (seconds) that the manifest recommends players keep. Directly comparable to HLS HOLD-BACK.',
    'dash-est-delay':
      'A rough estimate of how far behind the live edge a player ends up: suggestedPresentationDelay if specified, otherwise roughly three segment lengths of buffer.',
    availabilitystarttime:
      "The zero point (wall clock) the segments' timeline is counted from in a dynamic MPD. Simulated test streams often deliberately set this to 1970 (epoch).",
    publishtime: 'The time the current version of the MPD was published. The difference from now ("Manifest age") shows how fresh the manifest is.',
    'manifest-age':
      'How long ago the MPD was last published (now minus publishTime). Should be less than minimumUpdatePeriod for a well-behaved live stream. Not shown when publishTime is epoch-anchored.',
    contentprotection:
      'DRM/encryption declared in the manifest, shown as schemeIdUri (e.g. Widevine, PlayReady, ClearKey). The tool only shows that protection exists, so audio analysis may fail for protected streams.',
    'init-segment':
      "A separate initialization segment (fMP4) that contains the track's setup data and must be fetched before the regular media segments. Specified by the initialization attribute in the MPD.",

    // --- Icecast / SHOUTcast / RSAS ---
    icecast:
      'Icecast, SHOUTcast and RSAS (Rocket Streaming Audio Server) are the same kind of stream server: a single endless audio connection with no manifest or segments. They share a protocol. Station info is sent in icy-* headers and the track title in a small metadata block woven into the audio stream.',
    'station-name': "The station's name per the icy-name header the server sends. Set by whoever configures the stream.",
    'station-genre': "The genre the station states about itself in the icy-genre header. Free text, no fixed list.",
    'station-description': "The station's own description from icy-description (Icecast). SHOUTcast rarely sends it.",
    'station-homepage': "The link the station states for its website in the icy-url header.",
    'now-playing-icy':
      'The title of what is currently playing, read from StreamTitle in a metadata block the server weaves into the audio stream at regular intervals. The tool reads the first few seconds and extracts the first block. Some stations have metadata turned off.',
    'server-software':
      'Which stream server responded, from the Server header, e.g. "Icecast 2.4.4" or "RocketStreamingAudioServer/1.x". SHOUTcast and RSAS speak the same icy protocol as Icecast.',
    'icy-public':
      'Whether the station has asked to be listed in public directories (YP directories), per icy-pub. Does not affect whether you can listen, only whether it shows up in directories.',
    'icy-metaint':
      'Number of bytes of audio between each embedded metadata block (icy-metaint). Only sent when the client asks for metadata. If entirely absent, the stream sends no track title, which is common and not an error.',
    'declared-bitrate-icy': 'The bitrate the server states in the icy-br header, in kbit/s. Compare with the measured bitrate in Audio sample below.',
    'declared-samplerate-icy': 'The sample rate the server states in the icy-sr header, in Hz. Not all servers send it.',
    'icecast-sample':
      "The tool records a few seconds of the stream and measures the actual data rate per second. It also looks for ID3 frames (unusual for Icecast), where the track title normally comes via icy-metadata instead.",
    'inspelad-langd':
      'How many seconds were actually recorded for the measurement. Can be shorter than requested if the stream stuttered or the connection dropped.',
    'connect-burst':
      "When a listener connects, Icecast/SHOUTcast/RSAS immediately sends a chunk of already-buffered audio so playback can start quickly, then throttles to real time. The tool records the stream as fast as the server sends it and compares recorded playback time with wall-clock time. The difference is the buffer, i.e. roughly how far behind the broadcast a new listener starts. A rough lower bound: connection time, network speed and any relay servers add uncertainty, and \"at least\" means the whole sample fit inside the buffer, so it's actually larger.",

    // Loudness (EBU R128) and silence
    loudness:
      "How loud the stream actually is, measured per EBU R128. The measurement is done on the same recorded audio sample as the bitrate, and looks for silence in the audio at the same time.",
    'integrated-lufs':
      'The average loudness over the whole sample (LUFS). Guideline values: -23 LUFS for broadcast/TV per EBU R128, and -14 to -16 LUFS for streaming services like Spotify and YouTube.',
    'true-peak':
      'The highest signal peak, measured even between sample points (dBTP) so that peaks that only appear during playback are counted. Above -1 dBTP the audio risks clipping and sounding distorted in some players. "-∞" means the sample was completely digitally silent',
    'tystnad-start': 'When the silence began, counted from the start of the audio sample.',
    'tystnad-slut':
      'When the silence ended, counted from the start of the audio sample.',
    'tystnad-langd':
      'How long the silence lasted. Short gaps between tracks are normal; longer silence can mean the broadcast has lost its source, even when the stream itself is still working.',

    // Stream log
    'tystnad-avbrott':
      'Silence and outages are two different failures and are therefore listed separately. "Silence" means the stream responded and the audio could be recorded, but was silent. "Stream down" means the request failed entirely: no audio data arrived. Silence shorter than the configured threshold is shown nowhere - not here, not in the summary, not in the graph, and not among the events.',
    'status-strom':
      "Whether fetching the audio succeeded. A failed fetch counts as an outage, except when the failure is caused by the tool's own server: being busy, or being unreachable at all. Both are shown separately and don't count as the stream being down, since they say nothing about the stream.",
    'tystnad-typ':
      'Silence = the stream worked but produced no sound. Stream down = the request failed, e.g. the server didn\'t respond or responded with an error.',
    'medel-lufs':
      "The average of the loudness in each individual measurement. This isn't the same as an integrated loudness for the whole broadcast. EBU R128 weights and gates across the entire material, which can't be reconstructed after the fact from averages. Use it as a trend, not an exact measurement.",

    // Uploaded file analysis
    'fil-oversikt':
      'Everything the file itself states about itself: container format, length, bitrate, sample format, bit depth, encoder string and embedded tags. Read with ffprobe without decoding the audio.',
    'fil-container':
      'The file format packaging the audio, e.g. WAV, FLAC, MP3, MP4/M4A or Ogg. The same audio codec can live inside several different containers.',
    'fil-langd': "The file's total playback length, read from the container. Files longer than 130 minutes are only analyzed up to that limit.",
    tlen:
      "The ID3 tag TLEN states the track's length in milliseconds. It was written by the program that tagged the file and doesn't always match the file's actual length, e.g. if the file was trimmed or re-encoded after the tag was set. Other internal or binary tags (Windows Media IDs etc.) aren't shown at all.",
    sampleformat:
      'How each sample is stored internally, e.g. s16 (16-bit integer), s32 (32-bit integer) or fltp (32-bit float). Doesn\'t always say how many bits are actually used - see Bit depth.',
    bitdjup:
      'How many bits of resolution the audio has. "Declared" is what the file states; "actually used" is how many bits the data really moves within. If they differ, the file has been upsampled or padded with zeros, e.g. a 16-bit recording saved as 24-bit. Only applies to integer PCM (WAV, FLAC, AIFF): an MP3 or AAC has no bit depth at all - it decodes to floating point, in which case no figure is shown.',
    encoder:
      'The program, and often the version, that created the file, from a tag like "LAME3.100" or "libFLAC 1.4.2". Can reveal how the file has been processed.',
    replaygain:
      "ReplayGain/R128 tags state how much a player should attenuate or boost the file for an even playback level. They're set by ripping or tagging tools, not by this tool, and don't change the audio itself.",
    omslagsbild: 'Whether an image (album art) is embedded in the file, and if so its pixel dimensions and format.',
    kapitel: 'Chapter markers in the file, common in audiobooks and podcasts. Shows the start, end and title of each chapter.',
    lra:
      'Loudness Range (LU) – the difference between the quieter and louder passages across the whole file, per EBU R128. A high value means dynamic (e.g. classical, 10–20+ LU); a low value means heavily compressed (often 3–6 LU for modern pop). Not measured on streams since 15 seconds is too short.',
    'sample-peak':
      'The highest single sample (dBFS), without regard to what happens between samples. True peak is always equal to or higher; the difference is the peaks that only appear during playback.',
    plr:
      'Peak-to-Loudness Ratio: true peak minus integrated level (LU). A large value means a lot of dynamics left (a punchy master); near 0 means everything pushed against the ceiling (a "loudness war" master). Around 8–15 LU is typical for an uncompressed master, under 5 for a heavily limited one.',
    'dc-offset':
      'A constant offset of the audio signal from zero. Should be essentially 0. A clear DC offset means a fault in the recording or digitization chain, and also eats into headroom.',
    'rms-niva': 'The average energy level of the audio (dB), roughly how loud it is on average - as opposed to the peaks.',
    'crest-factor':
      'The ratio between peak level and RMS level. ≈ 1.41 for a pure sine tone, larger for dynamic material (drums, orchestra), shrinking toward 1 the harder the material is compressed/limited.',
    brusgolv: 'The lowest level in the audio (dB) – in practice the noise or silence between sounds. A low value means a quiet recording, a high value means audible noise/hum.',
    klippning:
      'Number of samples sitting exactly at the digital maximum. A handful is normal; many in a row means the signal has clipped (may sound distorted) or been run hard through a limiter.',
    stereokorrelation:
      "The same measurement as the correlation meter on a mixing desk: how alike the left and right channels are, −1 to +1. +1 = identical (mono); +0.5 to +1 is the mono-safe zone; around 0 = very wide/decorrelated; below 0 = the channels work against each other and lose energy when summed to mono (mobile, Bluetooth, club, mono broadcast). Calculated from the mid/side levels so silence doesn't affect the value, and measured on the first 10 minutes of longer files.",
    dubbelmono: 'A "stereo" file where both channels are exactly the same signal – no stereo image at all, and half the data is wasted. The correlation is then locked at +1.',
    fas:
      'Passages where the channels either work against each other ("out of phase") or are completely identical ("mono"), with start and end time. Silence has been excluded, so what\'s listed are genuine passages with sound. "Out of phase" is the one worth fixing: the signal thins out or disappears when the audio is summed to mono. "Mono" in the middle of an otherwise wide mix can be intentional (mono intro, centered vocal) or a track that happened to render as dual mono.',
    spektrogram:
      'An image of which frequencies (vertical) are present at each point in time (horizontal), with a stronger color meaning more energy. A sharp, razor-straight horizontal edge high up is the signature of lossy encoding: MP3/AAC cuts off abruptly, around 16 kHz at 128 kbit/s and around 19–20 kHz at 320 kbit/s. If you see such an edge in a FLAC or WAV, the file was probably made from a lossy source - but judge it from the picture: a dull mastering or old material rolls off gently and doesn\'t mean the same thing.',
  },
});
