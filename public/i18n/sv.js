// i18n/sv.js
// Swedish catalog - the source of truth. Every key here must also exist in every
// other locale catalog (test/i18n.test.js enforces this). See docs/i18n.md.

registerCatalog('sv', {
  meta: {
    numberLocale: 'sv-SE',
  },

  common: {
    yes: 'Ja',
    no: 'Nej',
    notFound: 'Saknas',
    unknown: 'Okänd',
    language: 'Språk',
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
    unknown: 'Okänt fel.',
    timeout: 'Timeout – servern svarade inte inom {seconds} sekunder.',
    requestTimeout: 'Förfrågan tog för lång tid (över {seconds} sekunder) och avbröts.',
    requestAborted: 'Begäran avbröts.',
    upstreamHttp: 'Servern svarade {status} {statusText}.',
    upstreamUnreachable: 'Kunde inte ansluta till servern – {reason}.',
    upstreamUnreachableReasons: {
      ENOTFOUND: 'värdnamnet kunde inte slås upp',
      EAI_AGAIN: 'DNS-uppslagningen gick inte att slutföra',
      ECONNREFUSED: 'anslutningen avvisades',
      ECONNRESET: 'anslutningen bröts av servern',
      EHOSTUNREACH: 'värden gick inte att nå',
      ETIMEDOUT: 'anslutningsförsöket tog för lång tid',
      CERT_HAS_EXPIRED: 'serverns TLS-certifikat har gått ut',
      UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'serverns TLS-certifikat kunde inte verifieras',
      UNKNOWN: 'okänt nätverksfel',
    },
    invalidManifest: 'Svaret ser inte ut som en giltig M3U8-fil (saknar #EXTM3U).',
    invalidMpd: 'Svaret ser inte ut som ett giltigt MPD-manifest (DASH).',
    hlsNoVariants: 'Master-playlist utan några #EXT-X-STREAM-INF-varianter.',
    hlsNoVariantUrl: 'Kunde inte hitta någon variant-URL i master-playlistan.',
    hlsVariantNotMedia: 'Variant-URL:en pekade inte på en media-playlist.',
    dashTimelineTooLarge: 'SegmentTimeline för representation "{representationId}" har {entries} &lt;S&gt;-poster (tak: {maxEntries}).',
    dashNoRepresentation: 'MPD:ns första Period innehåller ingen Representation att analysera.',
    manifestTooLarge: 'Svaret är större än {limitMb} MB - det är inte ett rimligt manifest och hämtas inte.',
    binaryMissing: 'Hittar inte "{binary}" i PATH. Är ffmpeg installerat?',
    ffprobeFailed: 'ffprobe kunde inte analysera strömmen.',
    ffmpegFailed: 'ffmpeg kunde inte spela in strömmen.',
    loudnessMeasurementFailed: 'ffmpeg kunde inte mäta ljudnivån på det inspelade provet.',
    fileAudioMeasurementFailed: 'ffmpeg kunde inte mäta ljudet i filen.',
    spectrogramTimeout: 'Spektrogrammet blev inte klart i tid.',
    spectrogramFailed: 'ffmpeg kunde inte rendera ett spektrogram.',
    validation: {
      missingUrl: 'Parametern "url" saknas.',
      invalidUrl: '"{value}" är inte en giltig URL.',
      unsupportedProtocol: 'Endast http- och https-URL:er stöds.',
    },
    hostBlocked: '"{hostname}" pekar mot ett internt/privat nätverk och kan inte analyseras.',
    upload: {
      stalled: 'Uppladdningen stannade av i mer än {seconds} sekunder.',
      tooLarge: 'Filen är större än {limitMb} MB och analyseras inte.',
      empty: 'Ingen fil togs emot. Skicka filens innehåll som förfråganskropp.',
    },
    notAudioFile: {
      unreadable: 'Filen kunde inte läsas som ljud eller media. Är det verkligen en ljudfil?',
      noTrack: 'Filen innehåller inget ljudspår.',
    },
    busy: 'Servern kör redan så många analyser den tar samtidigt. Försök igen om en liten stund.',
    requestTooLarge: 'Förfrågan är för stor.',
    malformedJson: 'Förfrågans JSON gick inte att tolka.',
    internal: 'Okänt serverfel.',
    notFound: 'Okänd API-route: {path}',
    warnings: {
      unparsableProbeJson: 'ffprobe svarade inte med tolkbar JSON (slutkod {code}). {stderr}',
      unparsableFramesJson: 'Metadataramarna kunde inte läsas (slutkod {code}). {stderr}',
    },
  },

  // ---------------------------------------------------------------------
  // app.js - HLS/DASH/Icecast snapshot analysis. Section headings here are reused for
  // the "Copy analysis" text's uppercase headings via .toUpperCase() in app.js, so
  // there is one heading string per section, not two.
  // ---------------------------------------------------------------------

  dash: {
    addressingLabels: {
      timeline: 'SegmentTimeline',
      'template-number': 'SegmentTemplate ($Number$)',
      'segment-list': 'SegmentList',
      'base-url': 'Enkel fil (BaseURL/SegmentBase)',
      none: 'Ingen segmentadressering hittades',
      unknown: 'Okänd',
    },
    noLatencyReasons: {
      vod: 'VOD (static MPD) - ingen live-fördröjning att beräkna.',
      'no-availability-start-time': 'availabilityStartTime saknas eller kunde inte tolkas.',
    },
  },

  connection: {
    heading: 'Anslutning',
    status: 'Status',
    requestedUrl: 'Begärd URL',
    finalUrl: 'Slutlig URL',
    redirectedSuffix: 'omdirigerad',
    contentType: 'Content-Type',
    server: 'Server',
    cacheControl: 'Cache-Control',
    expires: 'Expires',
    cors: 'CORS',
    corsPresent: 'Ja ({allowOrigin})',
    corsMissing: 'Nej - CORS-headers saknas. En webbläsarbaserad spelare kan inte hämta strömmen direkt från CDN:en utan en proxy som den här backend:en.',
    corsMissingShort: 'Nej - saknas',
    extraHeadersHeading: 'x- / akamai- / icy-headers',
    extraHeadersMissing: 'Inga x-, akamai- eller icy-headers.',
    headerTableName: 'Header',
    headerTableValue: 'Värde',
  },

  variants: {
    heading: 'Varianter',
    singleVariantNote: 'Endast en variant tillgänglig. URL:en pekar direkt på media-playlistan.',
    singleVariantNoteCopy: 'Endast en variant tillgänglig (vanligt för radio) - URL:en pekar direkt på media-playlistan.',
    clickHint: 'Klicka på en rad för att analysera just den varianten.',
    rowTitle: 'Klicka för att analysera den här varianten',
    bandwidthHeader: 'Bandbredd (kbit/s)',
    averageHeader: 'Snitt (kbit/s)',
    codecsHeader: 'Codecs',
    resolutionHeader: 'Upplösning',
    urlHeader: 'URL',
    unknownCodec: 'okänd codec',
    noVideo: 'ingen video',
    copyLine: '- {bandwidth} kbit/s (snitt {average}), {codecs}, {resolution}, {url}',
  },

  audio: {
    heading: 'Ljudspåret',
    codec: 'Codec',
    sampleRate: 'Samplingsfrekvens',
    channels: 'Kanaler',
    bitrate: 'Bitrate',
    bitrateUnknown: 'okänd (se uppmätt bitrate nedan)',
    container: 'Container',
    unavailable: 'Kunde inte hämtas (se varningar ovan).',
    unavailableCopy: 'Kunde inte hämtas (se varningar).',
  },

  segments: {
    heading: 'Segment och buffert',
    version: 'Version',
    targetDuration: 'Target duration',
    mediaSequence: 'Media sequence',
    type: 'Typ',
    live: 'Live',
    vod: 'VOD',
    segmentCount: 'Antal segment i fönstret',
    windowLength: 'Fönsterlängd',
    avgLength: 'Snittlängd/segment',
    encryption: 'Kryptering',
    off: 'Av',
    format: 'Segmentformat',
    fmp4: 'Fragmenterad MP4 (fMP4)',
    mpegts: 'Ej fragmenterat (MPEG-TS)',
  },

  continuity: {
    heading: 'Kontinuitet och startpunkt',
    discontinuitySeqLabel: 'EXT-X-DISCONTINUITY-SEQUENCE',
    discontinuitySeqNotFound: 'Hittades inte (standard: 0)',
    discontinuitiesLabel: 'Discontinuities',
    discontinuitiesNone: 'Inga i det aktuella fönstret.',
    discontinuitiesCount: '{count} st - vid sekvensnummer {positions}.',
    startLabel: 'EXT-X-START',
    startNotFound: 'Hittades inte.',
    startBehind: 'Spelaren startar {offset} sekunder bakom livekanten.',
    startAfterWindow: 'Spelaren startar {offset} sekunder efter fönstrets början.',
  },

  lowLatency: {
    heading: 'Low-Latency HLS',
    notPresent: 'Inga LL-HLS-taggar hittades i manifestet.',
    contradiction: 'Motsägelse: CDN-headern <code>{header}: {value}</code> antyder LL-HLS-stöd, men inga LL-HLS-taggar hittades i manifestet.',
    contradictionCopy: 'Motsägelse: headern {header}: {value} antyder LL-HLS-stöd, men inga LL-HLS-taggar hittades.',
    canBlockReload: 'CAN-BLOCK-RELOAD',
    holdBack: 'HOLD-BACK',
    partHoldBack: 'PART-HOLD-BACK',
    canSkipUntil: 'CAN-SKIP-UNTIL',
    canSkipDateranges: 'CAN-SKIP-DATERANGES',
    partTarget: 'PART-TARGET',
    partsIntro: 'Delsegment (EXT-X-PART) i senaste färdiga segmentet:',
    nextPartsIntro: 'Delsegment för nästa, ännu ej färdiga segment:',
    partsIndexHeader: '#',
    partsDurationHeader: 'Längd',
    partsIndependentHeader: 'Oberoende (INDEPENDENT)',
    partsUriHeader: 'URI',
    preloadHint: 'PRELOAD-HINT',
    renditionReportIntro: 'RENDITION-REPORT (status för andra renditions):',
    renditionHeader: 'Rendition',
    renditionLastMsnHeader: 'Senaste media-sequence',
    renditionLastPartHeader: 'Senaste part',
    partsCopyLine: 'Delsegment i senaste segmentet: {countOrNotFound}',
    nextPartsCopyLine: 'Delsegment för nästa segment: {count}',
    renditionCopyEntry: '{uri} (msn {lastMsn}, part {lastPart})',
  },

  latency: {
    heading: 'Latens',
    unavailable: 'Latens kan inte beräknas (ingen PROGRAM-DATE-TIME-tidsstämpel i manifestet).',
    method: 'Beräkningsmetod',
    methodMeasured: 'Uppmätt direkt',
    methodCalculated: 'Beräknad från segmentsumma',
    oldestTs: 'Äldsta segmentets tidsstämpel',
    newestTs: 'Nyaste segmentets tidsstämpel',
    delayFromOldest: 'Fördröjning (från äldsta)',
    delayFromNewest: 'Fördröjning (från nyaste, live-kant)',
    taggedSegments: { one: '{count} taggat segment', other: '{count} taggade segment' },
  },

  bitrate: {
    heading: 'Uppmätt bitrate',
    average: 'Snitt (uppmätt)',
    declared: 'Deklarerad bandbredd',
    declaredUnknown: 'okänd (ingen deklarerad bandbredd)',
    declaredUnknownCopy: 'okänd',
    timestampHeader: 'Tidsstämpel',
    bytesHeader: 'Bytes',
    bitrateHeader: 'Bitrate (kbit/s)',
    failed: 'misslyckades',
    samplesIntro: 'Uppmätta segmentprov (tidsstämpel, storlek, bitrate):',
    samplesIntroDash: 'Uppmätta segmentprov (storlek, bitrate):',
  },

  id3: {
    heading: 'Nu spelas (ID3)',
    loading: 'Hämtar…',
    noneFound: 'Ingen ID3-metadata hittades i den här strömmen (inspelning: {duration}, uppmätt {bitrate} kbit/s).',
    noneFoundCopy: 'Ingen ID3-metadata hittades (inspelning: {duration}, uppmätt {bitrate} kbit/s).',
    timeInSegmentHeader: 'Tid i segment',
    tagsHeader: 'Taggar',
    fetchFailed: 'Kunde inte hämtas: {message}',
    notFetched: 'Hämtades inte (analysen avbröts eller väntar fortfarande).',
    noUrl: 'Ingen URL att spela in ett prov från.',
  },

  networkPath: {
    heading: 'Nätverksväg',
    headerTableName: 'Header',
    headerTableValue: 'Värde',
    noHeaders: 'Inga headrar som matchar routing-mönstren (x-cache*, x-served*, x-edge*, via, x-amz-cf*, cf-*, x-akamai*) hittades.',
    noMatchingHeadersCopy: 'Inga matchande routing-headrar hittades.',
    geoHint: 'Möjlig geografisk ledtråd',
    geoHintFound: '{raw} (gissning baserad på ett vanligt nodnamnsmönster, inte bekräftad)',
    geoHintFoundCopy: '{raw} (ogranskad gissning)',
    dnsLookup: 'DNS-uppslagning',
    dnsLookupFailed: 'Kunde inte slås upp: {error}',
    dnsLookupFailedCopy: 'kunde inte slås upp ({error})',
    dnsNoAddresses: 'Inga adresser hittades',
    dnsNoAddressesCopy: 'inga adresser',
    ipGeo: 'Geografisk uppskattning (IP-databas)',
    ipGeoCopy: 'Geografisk uppskattning (IP-databas, ogranskad)',
    ipGeoNotFound: 'Hittades inte',
    ipGeoUnknown: 'okänd',
    dnsLabel: 'DNS-uppslagning ({hostname})',
  },

  manifest: {
    headingHls: 'Råmanifest',
    headingDash: 'Råmanifest (MPD)',
    master: 'Master',
    media: 'Media',
    mpd: 'MPD',
    truncatedNote: 'Visar de första {shown} raderna av {total}. Öppna URL:en ovan för att se hela manifestet.',
  },

  dashRepr: {
    heading: 'Representationer',
    analyzed: 'Analyserad: <span class="mono">{id}</span> (första ljudrepresentationen i period {period}). Till skillnad från HLS-varianter går DASH-rader inte att klicka för omanalys - hela MPD:n är redan hämtad.',
    analyzedCopy: 'Analyserad: {id} (period {period} av {periodCount})',
    multiPeriodNote: 'MPD:n har {periodCount} perioder. Endast period {period} (id "{periodId}") analyseras - övriga perioders data blandas inte in.',
    xlinkNote: 'Den analyserade perioden refererar en extern (xlink) period. Den hämtas inte och ingår inte i analysen.',
    typeHeader: 'Typ (språk)',
    idHeader: 'ID',
    bandwidthHeader: 'Bandbredd (kbit/s)',
    codecsHeader: 'Codecs',
    resolutionHeader: 'Upplösning / samplerate',
    unknownCodec: 'okänd codec',
    copyLine: '- [{type}] {id}{chosenSuffix}: {bandwidth} kbit/s, {codecs}, {size}',
    chosenSuffix: ' (vald)',
  },

  dashSegments: {
    presentationType: 'Presentationstyp',
    live: 'Live (dynamic)',
    vod: 'VOD (static)',
    addressing: 'Segmentadressering',
    length: 'Segmentlängd',
    count: 'Antal segment',
    estimated: ' (uppskattat)',
    window: 'Fönster / DVR-djup',
    minBufferTime: 'minBufferTime',
    minimumUpdatePeriod: 'minimumUpdatePeriod',
    mediaPresentationDuration: 'mediaPresentationDuration',
    encryption: 'Kryptering',
    off: 'Av',
    format: 'Segmentformat',
    fmp4: 'Fragmenterad MP4 (fMP4)',
    noInit: 'Inget separat init-segment',
    initSegment: 'Init-segment',
  },

  dashLatency: {
    unavailable: 'Latens kan inte beräknas för den här strömmen.',
    method: 'Beräkningsmetod',
    methodDeclared: 'Deklarerad i manifestet',
    methodEstimated: 'Uppskattad från segmentlängd',
    availabilityStartTime: 'availabilityStartTime',
    epochAnchored: ' (epoch-förankrad)',
    epochAnchoredCopy: 'epoch-förankrad',
    publishTime: 'publishTime',
    manifestAge: 'Manifestets ålder',
    manifestAgeUnavailable: 'Ej tillgänglig (publishTime är epoch-förankrad - simulerad live)',
    manifestAgeUnavailableCopy: 'ej tillgänglig (epoch)',
    suggestedDelay: 'suggestedPresentationDelay',
    estimatedDelay: 'Uppskattad live-fördröjning',
    estimatedSuffix: ' (grov)',
    minimumUpdatePeriod: 'minimumUpdatePeriod',
    timeShiftBufferDepth: 'timeShiftBufferDepth',
  },

  icecastStation: {
    heading: 'Station',
    unavailable: 'Ingen stationsmetadata kunde hämtas (se varningar ovan).',
    metadataPending: 'Metadata är påslaget (var {metaInt} byte) men inget titelblock hann skickas innan provet var klart.',
    metadataOff: 'Strömmen skickar ingen låttitel i ljudflödet (icy-metaint saknas). Vanligt - inte ett fel.',
    metadataOffCopy: '(strömmen skickar ingen låttitel)',
    metadataPendingCopy: '(inget titelblock hann skickas)',
    name: 'Namn',
    nowPlaying: 'Nu spelas',
    genre: 'Genre',
    description: 'Beskrivning',
    homepage: 'Hemsida',
    declaredBitrate: 'Deklarerad bitrate',
    declaredSampleRate: 'Deklarerad samplingsfrekvens',
    serverSoftware: 'Serverprogramvara',
    publiclyListed: 'Publikt listad',
    publiclyListedYes: 'Ja (icy-pub: 1)',
    inStreamMetadata: 'In-stream-metadata',
    inStreamMetadataYes: 'Ja, var {metaInt} byte',
    inStreamMetadataYesCopy: 'Ja (var {metaInt} byte)',
    rawMetaBlock: 'Rått metadatablock:',
  },

  icecastSample: {
    heading: 'Ljudprov',
    recording: 'Spelar in…',
    notFetched: 'Hämtades inte (analysen avbröts eller väntar fortfarande).',
    id3Intro: 'ID3-ramar i flödet (ovanligt för Icecast):',
    timeInSampleHeader: 'Tid i prov',
    tagsHeader: 'Taggar',
    average: 'Uppmätt bitrate',
    recordedLength: 'Inspelad längd',
    connectBurst: 'Serverbuffert vid anslutning',
    sampleSize: 'Provets storlek',
    container: 'Container',
    burstNone: 'ingen märkbar (strömmen levererades i realtid)',
    burstNoneCopy: 'ingen märkbar (realtid)',
    burstAtLeast: 'minst {seconds}',
    burstApprox: '≈ {seconds}',
    burstAtLeastSuffix: ' (hela provet dränerades ur bufferten)',
  },

  controls: {
    logButtonHint: 'Följ strömmen över tid i stället för att ta en ögonblicksbild',
    copyBtn: 'Kopiera analys',
    copyBtnTitle: 'Kopiera all analysdata (utom råmanifestet) som text, t.ex. för att klistra in i en AI-tjänst',
    copied: 'Kopierat!',
    copyFailed: 'Kunde inte kopiera',
    enterUrlFirst: 'Ange en URL först.',
  },

  warnings: {
    heading: 'Varningar (delvis resultat)',
    prefix: 'OBS: {message}',
  },

  error: {
    heading: 'Fel',
    httpStatus: 'HTTP-status',
    responseBody: 'Svarskropp (utdrag)',
    likelyCause: 'Trolig orsak',
    likelyCauseGeoblock: 'Geoblockering (403 med tomt svar)',
    whatCameBack: 'Vad som kom tillbaka',
    installation: 'Installation',
    stderr: 'Felutdata',
    url: 'URL',
    serverUnreachable: 'Kunde inte nå servern: {message}',
  },

  flow: {
    analyzing: 'Analyserar…',
    fetchingNowPlaying: 'Hämtar nu spelas…',
    recordingSample: 'Spelar in ljudprov…',
    analyzedFrom: 'Master: <span class="mono">{master}</span> → Analyserar: <span class="mono">{target}</span>',
    streamAnalysisHls: 'Strömanalys (HLS): {url}',
    streamAnalysisDash: 'Strömanalys (DASH): {url}',
    streamAnalysisIcecast: 'Strömanalys (Icecast/radio): {url}',
    variantFromMaster: '(Variant vald från master: {master})',
    generated: 'Genererad: {timestamp}',
  },

  nav: {
    urlLabel: 'Ström-URL',
    urlPlaceholder: 'Ström-URL – HLS, DASH eller Icecast/radio',
    analyzeBtn: 'Analysera',
    logBtn: 'Logga',
    logBtnTitle: 'Följ strömmen över tid i stället för att ta en ögonblicksbild',
    fileRowPrefix: 'eller analysera en ljud- eller videofil (bara ljudet analyseras):',
    filePick: 'Välj ljud- eller videofil…',
  },

  faq: {
    summary: 'Om verktyget',
    intro: `Audio analyzer hämtar och analyserar en ljudström: anslutning och CORS, ljudkodek,
      segment och buffert, latens, uppmätt bitrate, "nu spelas" och det råa manifestet.
      Välj <strong>Analysera</strong> för en nulägesbild med alla metadata eller <strong>Logga</strong> för att
      i stället följa strömmens ljudnivå över tid.
      Hämtningarna görs på servern (CDN:er skickar sällan CORS-headers) och ljudet
      inspekteras med <code>ffprobe</code>/<code>ffmpeg</code>. HLS (<code>.m3u8</code>),
      MPEG-DASH (<code>.mpd</code>) och Icecast/SHOUTcast/RSAS.`,
    hlsSummary: 'Hur hittar jag HLS-adressen (<code>.m3u8</code>)?',
    hlsBody: `Öppna sidan som spelar upp strömmen, öppna webbläsarens utvecklarverktyg (F12)
        → fliken Nätverk, filtrera på <code>m3u8</code>. Starta uppspelningen och URL:en
        som dyker upp (ofta <code>master.m3u8</code>, <code>playlist.m3u8</code> eller
        <code>chunklist.m3u8</code>) är den du klistrar in här. Ibland ligger den också
        direkt i sidkällan eller i en &lt;video&gt;/&lt;source&gt;-tagg.`,
    dashSummary: 'Hur hittar jag DASH-adressen (<code>.mpd</code>)?',
    dashBody: `Samma sätt som för HLS: utvecklarverktyg → Nätverk, filtrera på <code>mpd</code>
        eller <code>dash</code>. URL:en slutar på <code>.mpd</code> (ofta
        <code>manifest.mpd</code> eller <code>Manifest.mpd</code>). DASH är vanligare
        för TV/video än för renodlade ljudströmmar.`,
    icecastSummary: 'Hur hittar jag Icecast-/radioadressen?',
    icecastBody1: `Radioströmmar är oftast en direkt URL till en "mount" — t.ex.
        <code>.../stream</code>, <code>.../live</code>, <code>.../128</code> eller något
        som slutar på <code>.mp3</code>/<code>.aac</code>. Hitta den genom att:`,
    icecastBody2: `(1) ladda ner stationens spellista (<code>.pls</code>- eller <code>.m3u</code>-fil,
        ofta bakom en "lyssna i extern spelare"-länk) och öppna den i en textredigerare,
        den innehåller den råa URL:en.`,
    icecastBody3: `(2) utvecklarverktyg → Nätverk, filtrera på <code>media</code> eller <code>mp3</code>
        medan strömmen spelar; eller (3) titta i stationens egen lista över direktlänkar.`,
    fileSummary: 'Vad får jag ut av att analysera en fil?',
    fileBody1: `Ladda upp en färdig ljudfil så mäts hela den: all metadata (codec, bitdjup,
        samplingsfrekvens, taggar, omslagsbild, kapitel), ljudnivå (LUFS) och true peak
        som en kurva över hela filen, dynamik (LRA, crest factor, klippning), stereobild
        och fas, samt ett spektrogram – där en spikrak kant högt upp avslöjar en fil som
        gjorts från en lossy källa (t.ex. en MP3 omkodad till FLAC). En videofil (t.ex. mp4,
        mov, mkv) går lika bra att ladda upp – det är bara ljudspåret som analyseras.`,
    fileBody2: 'Filen laddas upp till verktygets server, analyseras med ffmpeg och sparas inte.',
    loggingSummary: 'Hur fungerar loggningen?',
    loggingBody1: `Loggningen spelar in 15 sekunder av ljudet, mäter ljudnivå (LUFS, True Peak)
        och tystnad i det provet, och startar sedan genast nästa 15-sekundersinspelning.
        Mätningen sker alltså löpande, inte bara som enstaka stickprov med jämna mellanrum.
        En tystnad som sträcker sig över gränsen mellan två inspelningar fångas i sin helhet,
        med korrekt start och sluttid.`,
    loggingBody2: `Loggen lever bara i den här webbläsarfliken. Stänger du fliken utan att
        exportera (JSON eller CSV) försvinner den. Loggningen går inte pausa, utan enbart stoppa.
        Klickar du Logga igen börjar en helt ny logg från noll.`,
    loggingBody3: `Går verktygets egen server ner mitt i en loggning (skiljt från att själva
        ljudströmmen har problem) så stoppar loggningen automatiskt efter två misslyckade försök
        i rad.`,
    whyFailsSummary: 'Varför misslyckas analysen ibland?',
    whyFailsBody: `Vanliga orsaker: geoblockering (svar 403, ofta med tom kropp), DRM-skyddad DASH
        (skyddet visas men ffprobe kan inte avkoda ljudet), en URL som pekar på en
        spelarsida i stället för på själva manifestet, eller en äldre SHOUTcast v1-server
        som svarar med raden <code>ICY 200 OK</code> i stället för vanlig HTTP.`,
  },

  // ---------------------------------------------------------------------
  // log.js - the stream log (follow a stream over time instead of a single
  // snapshot). Namespaced separately from app.js's sections above, even where a
  // few phrases (e.g. "Fel", "Anteckning") could in principle be shared, so the
  // two files' catalogs stay easy to review independently.
  // ---------------------------------------------------------------------

  log: {
    gapLabels: {
      silence: 'Tystnad',
      outage: 'Strömmen nere',
    },
    eventLabels: {
      'metadata-change': 'Metadataförändring',
      'format-change': 'Formatändring',
      clipping: 'Klippning',
      'loudness-drift': 'Nivåavvikelse',
      note: 'Anteckning',
      silence: 'Tystnad',
      outage: 'Strömmen nere',
    },
    entryErrors: {
      busy: 'Servern upptagen.',
      noConnection: 'Kunde inte nå servern.',
      unknown: 'Okänt fel',
    },
    events: {
      heading: 'Händelser',
      filterLabel: 'Visa:',
      filterAll: 'Alla',
      filterNone: 'Inga',
      noneMatchFilter: 'Inga händelser matchar de valda filtren.',
      driftText: '{lufs} LUFS (mål {target} ±{tolerance} LU)',
      formatChangeText: '{prevCodec} {prevRate} Hz {prevChannels} kanal(er) → {codec} {rate} Hz {channels} kanal(er)',
      clippingText: 'True peak {value} dBTP',
    },
    summary: {
      heading: 'Sammanfattning',
      loggedSince: 'Loggat sedan',
      stoppedSuffix: ' (stoppad)',
      measurements: 'Mätningar',
      measurementsValue: '{count} st, {percent} % lyckade',
      busySkipped: '{count} p.g.a. serverbelastning',
      noConnectionSkipped: '{count} p.g.a. att servern inte kunde nås',
      skippedSuffix: ' ({notes} hoppade över)',
      meanLufs: 'Medel-LUFS',
      meanBitrate: 'Medelbitrate',
      longestSilence: 'Längsta tystnad',
      longestOutage: 'Längsta avbrott',
      countTotal: ' ({count} st totalt)',
      noSilence: 'ingen',
      noOutages: 'inga',
      clippingLabel: 'Mätningar över {dbtp} dBTP',
    },
    silenceList: {
      heading: 'Tystnad och avbrott',
      typeHeader: 'Typ',
      startHeader: 'Start',
      endHeader: 'Slut',
      durationHeader: 'Längd',
      ongoing: 'pågår',
    },
    table: {
      heading: 'Mätningar',
      showingNote: 'Senaste {shown} av {total}. Exporten innehåller alla.',
      timeHeader: 'Tid',
      lufsHeader: 'LUFS',
      truePeakHeader: 'True peak',
      silenceHeader: 'Tystnad (s)',
      bitrateHeader: 'kbit/s',
      nowPlayingHeader: 'Nu spelas',
      statusHeader: 'Status ström',
      ok: 'OK',
      okLevelNotMeasured: 'OK (nivå ej mätt)',
    },
    chart: {
      heading: 'Ljudnivå',
      legendLufs: 'Integrerad ljudnivå (LUFS)',
      legendTruePeak: 'True peak (dBTP)',
    },
    warningBanner: {
      message: 'Du har loggat i över {hours} timmar ({count} mätningar). Överväg att exportera och rensa — allt ligger i den här fliken.',
      dismiss: 'Stäng',
    },
    controls: {
      stop: 'Stoppa loggning',
      silenceFromLabel: 'Logga tystnad från',
      driftToggle: 'Logga nivåavvikelse',
      driftTargetLabel: 'mål',
      noteBtn: 'Anteckning',
      notePrompt: 'Anteckning:',
      exportJson: 'Exportera JSON',
      exportCsv: 'Exportera CSV',
      clear: 'Rensa',
      confirmClear: 'Loggen är inte exporterad. Rensa ändå?',
      driftHelp:
        'Flaggar varje mätning som ligger utanför ett mål du sätter, så att du ser om kanalen driver i ljudnivå över tid. ' +
        'Målet anges i <strong>LUFS</strong> — den absoluta ljudnivån. Toleransen anges i <strong>LU</strong> (Loudness Units), ' +
        'som är samma skala men används för <em>skillnader</em>: 1 LU = 1 dB. Mål −16 LUFS ±2 LU betyder alltså att allt mellan ' +
        '−18 och −14 LUFS räknas som normalt. Riktvärden: −23 LUFS för broadcast enligt EBU R128, −14 till −16 LUFS för ' +
        'streamingtjänster. Av som standard, eftersom de flesta strömmar ligger utanför ett godtyckligt mål större delen av tiden.',
    },
    flow: {
      checkingStream: 'Kontrollerar strömmen…',
      analysisFailed: 'Analysen misslyckades.',
      serverRespondedWith: 'Servern svarade {status}.',
      backendUnreachable:
        'Servern svarar inte längre - loggningen stoppades automatiskt. ' +
        'Kontrollera att servern körs, och starta loggningen igen när den är uppe.',
    },
    csv: {
      tid: 'tid',
      stromOk: 'strom_ok',
      status: 'status',
      lufsI: 'lufs_i',
      truePeakDbtp: 'true_peak_dbtp',
      tystnadSek: 'tystnad_sek',
      fonsterSek: 'fonster_sek',
      bitrateKbps: 'bitrate_kbps',
      codec: 'codec',
      samplingsfrekvens: 'samplingsfrekvens',
      kanaler: 'kanaler',
      nuSpelas: 'nu_spelas',
      anmarkning: 'anmarkning',
    },
    export: {
      filenamePrefix: 'stromlogg',
    },
  },

  // ---------------------------------------------------------------------
  // file.js - the uploaded-file analysis view. Reuses a few app.js keys directly
  // (controls.copyBtn/copied/copyFailed, flow.generated, error.serverUnreachable)
  // where the wording is exactly the same, instead of duplicating them here.
  // ---------------------------------------------------------------------

  file: {
    controls: {
      copyBtnTitle: 'Kopiera all filanalys som text',
    },
    tagLabels: {
      title: 'Titel',
      artist: 'Artist',
      album: 'Album',
      album_artist: 'Albumartist',
      date: 'År',
      track: 'Spår',
      genre: 'Genre',
      composer: 'Kompositör',
      comment: 'Kommentar',
      publisher: 'Utgivare',
      copyright: 'Copyright',
      language: 'Språk',
    },
    overview: {
      heading: 'Filen',
      tagHeader: 'Tagg',
      valueHeader: 'Värde',
      noTags: 'Inga taggar (artist/titel/album …) i filen.',
      replayGainLabel: 'ReplayGain-taggar',
      replayGainNote: ' (satta av ett tidigare verktyg, inte av oss):',
      chaptersLabel: 'Kapitel',
      chapterFromHeader: 'Från',
      chapterToHeader: 'Till',
      chapterTitleHeader: 'Titel',
      tagsHeading: 'Taggar',
      filenameLabel: 'Filnamn',
      containerLabel: 'Container',
      lengthLabel: 'Längd',
      taggedLengthLabel: 'Längd enligt tagg (TLEN)',
      tlenMismatch: 'skiljer sig från filens uppmätta längd ({duration})',
      fileSizeLabel: 'Filstorlek',
      bitrateLabel: 'Bitrate (snitt)',
      sampleFormatLabel: 'Sampleformat',
      bitDepthLabel: 'Bitdjup',
      encoderLabel: 'Encoder',
      coverArtLabel: 'Omslagsbild',
      bitDepthNotApplicable: 'gäller inte ({fmt} – flyttal)',
      bitDepthValue: '{declared} bitar',
      bitDepthMismatch: '{declared} bitar deklarerat, {used} faktiskt använda',
      coverArtNone: 'nej',
      coverArtPresent: 'ja',
      unknownFormat: 'okänt format',
      truncationNote: 'Filen är längre än {minutes} minuter – analysen nedan gäller de första {duration}.',
    },
    phase: {
      heading: 'Fas- och monopartier',
      silenceExcludedNote: ' (tystnad borträknad):',
      outOfPhaseKind: 'Ur fas (motverkar sig i mono)',
      monoKind: 'Mono (kanalerna identiska)',
      typeHeader: 'Typ',
      fromHeader: 'Från',
      toHeader: 'Till',
      durationHeader: 'Längd',
      toEnd: 'till slutet',
      outOfPhaseShort: 'Ur fas',
      monoShort: 'Mono',
      copyToEnd: 'slutet',
    },
    stereoVerdict: {
      dualMono: 'identiska kanaler (dubbelmono – ingen stereobild)',
      verySmall: 'mycket smal stereobild, nästan mono',
      normal: 'normal stereobild, mono-kompatibel',
      wide: 'bred stereobild',
      veryWide: 'mycket bred / dekorrelerad – kontrollera i mono',
      canceling: 'kanalerna motverkar varandra – energi går förlorad vid mono-summering',
    },
    stereo: {
      label: 'Stereokorrelation',
      notMeasured: '– (kunde inte mätas)',
      tooQuiet: '– (för lite ljud för att mäta)',
      windowNote: ' (uppmätt över de första {duration})',
    },
    loudness: {
      heading: 'Ljudnivå och dynamik',
      couldNotMeasure: 'Kunde inte mätas.',
      chartHeading: 'Ljudnivå',
      integratedLabel: 'Integrerad nivå',
      lraLabel: 'Loudness range (LRA)',
      lraRangeSuffix: ' ({low} … {high} LUFS)',
      truePeakLabel: 'True peak',
      truePeakSilentValue: '−∞ dBTP (helt digitalt tyst)',
      samplePeakLabel: 'Sample peak',
      samplePeakSilentValue: '−∞ dBFS',
      plrLabel: 'PLR (peak − nivå)',
      crestFactorLabel: 'Crest factor',
      dcOffsetLabel: 'DC-offset',
      rmsLabel: 'RMS-nivå',
      noiseFloorLabel: 'Brusgolv',
      clippingCountLabel: 'Samplingar i digitalt max',
    },
    spectrogram: {
      heading: 'Spektrogram',
      windowNote: 'Visar de första {duration}.',
      imgAlt: 'Spektrogram av filen',
      noImage: 'Ingen bild kunde skapas.',
    },
    chart: {
      legendShortTerm: 'Short-term ljudnivå (LUFS)',
      legendTruePeak: 'True peak (dBTP)',
      legendIntegrated: 'Integrerad nivå',
    },
    copyText: {
      title: 'Filanalys: {name}',
      unnamedFile: '(namnlös)',
      partialResultsHeading: 'DELVIS RESULTAT',
    },
    flow: {
      analyzing: 'Analyserar {name} …',
      analysisFailed: 'Analysen misslyckades.',
    },
  },

  // Glossary with short explanations (max 3 sentences) for headings and value names in
  // the UI, shown as a native tooltip via the title attribute - see withHint() in
  // shared.js. Covers both the HLS and DASH sections. Formerly public/terms.js.
  terms: {
    // Section headings (h2)
    anslutning:
      'Visar om hämtningen av manifestet lyckades och vilka HTTP-headrar CDN:en svarade med, inklusive om CORS (Cross-Origin Resource Sharing) tillåts. Saknas CORS kan en vanlig webbläsare inte hämta strömmen direkt utan en proxy',
    varianter:
      'En HLS-master-playlist kan lista flera varianter av samma ström i olika kvaliteter, så spelaren kan välja den som passar lyssnarens uppkoppling.',
    ljud: 'Teknisk information om själva ljudkodningen, hämtad genom att köra verktyget ffprobe mot strömmen.',
    segment:
      'HLS delar upp strömmen i korta segment som spelaren laddar ner ett i taget. Den här sektionen visar hur segmenten är uppbyggda och hur stort "fönster" av dem som är tillgängligt just nu.',
    latens:
      'Jämför tidsstämpeln i segmenten med systemklockan för att uppskatta hur långt efter den faktiska sändningen strömmen ligger. Kräver att manifestet innehåller PROGRAM-DATE-TIME-taggar.',
    bitrate:
      'Den faktiska datamängden per sekund, uppmätt genom att hämta storleken på de senaste segmenten och jämföra med deras spellängd och jämförs sedan med den bandbredd manifestet deklarerar.',
    id3:
      'Vissa ljudströmmar bäddar in metadata (t.ex. låttitel och artist) direkt i ljudsegmenten, med samma ID3-teknik som mp3-filer använder. Verktyget spelar in några sekunder av strömmen och letar efter sådan metadata, men många strömmar saknar den helt.',
    manifest:
      'Den råa, otolkade texten i .m3u8-filen som hämtades från servern som beskriver vilka segment eller varianter som finns.',
    natverksvag:
      'Visar vilken CDN-nod eller edge-server som svarade, utläst ur headrar som matchar vanliga routing-konventioner (x-cache, x-served, via, cf-*, x-amz-cf-* m.fl.), samt en DNS-uppslagning av värdnamnet.',

    // Connection (dt)
    status: 'HTTP-statuskoden servern svarade med. 200 betyder OK; 4xx/5xx betyder ett fel hos klienten respektive servern.',
    'begard-url': 'Den URL som skrevs in i fältet ovan och skickades för analys.',
    'slutlig-url':
      'URL:en efter att eventuella omdirigeringar (HTTP 3xx) följts. Skiljer sig från den begärda URL:en om servern skickade om anropet.',
    'content-type':
      'Vilken typ av innehåll svaret säger sig vara. En giltig HLS-manifest har oftast application/x-mpegURL eller application/vnd.apple.mpegurl.',
    server: 'Vilken webbserver-programvara som svarade, om den avslöjar det.',
    'cache-control':
      'Styr hur länge webbläsare och mellanliggande cachar får spara svaret. Live-manifest har ofta "no-cache" eftersom innehållet ändras hela tiden.',
    expires:
      'Tidpunkten servern anger att svaret blir för gammalt att använda - ett äldre alternativ till Cache-Control som vissa CDN:er fortfarande skickar.',
    cors:
      'Cross-Origin Resource Sharing - headern som avgör om en webbsida på en annan domän får läsa svaret. Saknas den måste en proxy hämta strömmen istället för webbläsaren.',
    'geo-hint':
      'Många CDN-noder namnges med en flygplatskod (t.ex. ARN för Stockholm Arlanda) följt av siffror. Det här är en ogranskad gissning baserad på det mönstret i nodnamnet',
    'dns-lookup':
      'Vilka IP-adresser värdnamnet pekar mot just nu, uppslaget av verktygets egen backend. CDN:er använder ofta DNS-baserad lastbalansering, så resultatet kan variera mellan anrop och är inte nödvändigtvis samma nod som faktiskt svarade på anropet.',
    'ip-geo':
      'Stad/land för varje IP, från en lokal offline-databas. Ett grovt komplement till hintan ovan',
    'extra-headers':
      'HTTP-headrar i svaret vars namn börjar med "x-" (en gammal konvention för icke-standardiserade headrar), innehåller "akamai", eller börjar med "icy-". Ofta de mest talande för vad som hänt hos CDN:et eller strömservern.',

    // Variants (th)
    'variant-bandbredd':
      'Toppbandbredden (kbit/s) variantens kodning kan kräva, enligt manifestet. Är ett riktvärde, inte samma sak som den faktiska uppmätta bitraten.',
    'variant-snitt':
      'Genomsnittlig bandbredd (kbit/s) för varianten över tid, om manifestet anger det och är oftast mer realistisk än toppvärdet.',
    codecs: 'Anger exakt vilka kodekar som används, i standardiserat format. "mp4a.40.2" betyder till exempel AAC-LC-ljud.',
    upplosning: 'Videoupplösningen i bredd × höjd bildpunkter. Tom för renodlade ljudströmmar som radio.',
    'variant-url': 'Länken till just den här variantens egna media-playlist.',

    // Audio track (dt)
    codec: 'Vilken ljudkodek segmenten är kodade med, t.ex. AAC. Profilen inom parentes (t.ex. LC) beskriver en specifik variant av kodeken.',
    samplingsfrekvens: 'Hur många gånger per sekund ljudet mättes vid inspelningen,. Anges i Hertz.',
    kanaler: '1 är mono, 2 är stereo och fler kanaler vid surroundljud.',
    'audio-bitrate': 'Hur mycket data ljudet kodas med per sekund.',
    container: 'Filformatet segmenten är paketerade i, t.ex. MPEG-TS (.ts) eller fragmenterad MP4 (fMP4).',

    // Segments and buffer (dt)
    version: 'HLS-protokollversionen manifestet är skrivet för, vilket avgör vilka taggar och funktioner som får användas.',
    targetduration:
      'Den längsta tillåtna segmentlängden i sekunder. Spelare använder värdet för att veta hur ofta de bör hämta ett nytt manifest.',
    mediasequence:
      'Ett löpnummer som talar om vilket segment i den totala strömmen som är först i den aktuella listan. Ökar när äldre segment plockas bort från fönstret.',
    typ: 'Live betyder att manifestet uppdateras kontinuerligt utan slut; VOD betyder en avslutad, färdig ström.',
    'antal-segment': 'Hur många segment som just nu listas i manifestets "fönster", det vill säga det synliga utsnittet av den pågående strömmen.',
    fonsterlangd:
      'Den sammanlagda spellängden i sekunder för alla segment i fönstret och därmed ungefär så mycket spelaren kan buffra utan att hämta ett nytt manifest.',
    snittlangd: 'Genomsnittlig längd per segment, beräknad från fönstrets totala längd delat på antal segment.',
    krypterat: 'Om segmenten är krypterade enligt EXT-X-KEY-taggen. Spelaren behöver rätt nyckel för att kunna spela upp strömmen.',
    fmp4: 'Om segmenten är i fragmenterat MP4-format istället för det äldre MPEG-TS, angivet av EXT-X-MAP-taggen.',
    discontinuities:
      'Antal EXT-X-DISCONTINUITY-hopp i fönstret. Vilket innebär punkter där kodning, tidsbas eller format byts (t.ex. vid reklamavbrott). Varje sådan tvingar spelaren att tömma och bygga upp sin buffert på nytt, vilket kan höras som en kort paus.',

    // Low-Latency HLS (h3 + dt)
    llhls:
      'LL-HLS (Low-Latency HLS) är en uppsättning tillägg till HLS-standarden som sänker fördröjningen genom att dela upp segment i mindre "parts" som spelaren kan hämta innan hela segmentet är klart. Kräver stöd hos både paketerare, CDN och spelare för att fungera.',
    'll-can-block-reload':
      'Om servern stödjer "blockerande" manifestförfrågningar. Spelaren kan be servern vänta med svaret tills ett nytt segment eller delsegment finns, istället för att polla. En grundförutsättning för LL-HLS.',
    'll-hold-back':
      'Rekommenderad distans (sekunder) från livekanten som manifestet ber vanliga spelare hålla, från EXT-X-SERVER-CONTROL. Ett lågt värde betyder att strömmen är byggd för låg latens.',
    'll-part-hold-back':
      'Samma sak som HOLD-BACK, men specifikt för spelare som stödjer LL-HLS och kan buffra i delsegment ("parts"). Normalt ett lägre värde eftersom de kan ligga närmare livekanten.',
    'll-can-skip-until':
      'Hur långt tillbaka en spelare får be om en förkortad manifestuppdatering (EXT-X-SKIP) istället för hela listan, för att spara bandbredd vid täta uppdateringar.',
    'll-can-skip-dateranges':
      'Om servern även stödjer att hoppa över EXT-X-DATERANGE-taggar i en förkortad manifestuppdatering (EXT-X-SKIP).',
    'll-part-target':
      'Målspellängden för de små delsegment ("parts") som LL-HLS delar upp varje vanligt segment i, från EXT-X-PART-INF. Delsegment gör att spelaren kan börja spela innan ett helt vanligt segment hunnit bli klart.',
    'll-preload-hint':
      'EXT-X-PRELOAD-HINT annonserar ett kommande delsegment eller initieringssegment som spelaren kan börja begära redan innan det är färdigproducerat, via en blockerande förfrågan.',

    // Continuity and start point (h3 + dt)
    kontinuitet:
      'Visar var i strömmen kodning eller tidsbas faktiskt byts (discontinuities), och var en spelare rekommenderas börja spela upp. Två separata saker som lätt blandas ihop med latens och buffertfönster.',
    'discontinuity-sequence':
      'Startvärdet för discontinuity-räknaren i det här manifestet (EXT-X-DISCONTINUITY-SEQUENCE). Används av spelare för att hålla koll på kontinuitetshopp korrekt även när de bytt mellan olika varianter.',
    'ext-x-start':
      'Anger var i strömmen en spelare rekommenderas börja uppspelningen (TIME-OFFSET), inte var den faktiskt kan börja. Positivt värde räknas från fönstrets början, negativt värde bakåt från livekanten.',

    // Latency (dt)
    'latens-metod':
      '"Uppmätt direkt" betyder att flera segment har egna tidsstämplar och siffran är tillförlitlig. "Beräknad från segmentsumma" betyder att bara ett segment i fönstret hade en tidsstämpel (vanligt i äldre HLS) och resten är extrapolerat genom att addera segmentens längder, vilket gör siffran mer osäker.',
    'aldsta-ts': 'Tidsstämpeln för det äldsta segmentet i det synliga fönstret, enligt dess PROGRAM-DATE-TIME-tagg.',
    'nyaste-ts': 'Tidsstämpeln för det senaste segmentet i det synliga fönstret',
    'fordrojning-aldsta': 'Hur många sekunder som gått mellan det äldsta segmentets tidsstämpel och nu. Ungefär hela buffertfönstrets ålder.',
    'fordrojning-nyaste':
      'Hur många sekunder som gått sedan det senaste tillgängliga segmentet spelades in. Ger ett mått på den faktiska fördröjningen en lyssnare upplever.',

    // Measured bitrate (dt/th)
    'snitt-uppmatt':
      'Genomsnittlig bitrate (kbit/s), beräknad från de faktiska filstorlekarna på de senast hämtade segmenten delat på deras spellängd.',
    'deklarerad-bandbredd': 'Den bandbredd manifestet uppger för den valda varianten, till jämförelse med vad som faktiskt mättes upp.',
    tidsstampel: 'Tidpunkten segmentet spelades in, enligt dess PROGRAM-DATE-TIME-tagg.',
    bytes: 'Segmentets faktiska filstorlek i bytes, hämtad via ett HEAD-anrop mot segment-URL:en.',
    'bitrate-kolumn': 'Segmentets storlek omräknat till kbit/s baserat på dess spellängd.',

    // Now playing (th)
    'tid-i-segment': 'Var i den inspelade sekvensen, i sekunder från start, som ID3-taggen hittades.',
    taggar: 'Den faktiska metadatan som hittades, t.ex. låttitel eller artist, i sitt rådataformat.',

    // --- DASH ---
    mpd:
      'Media Presentation Description - det XML-manifest som är DASH:s motsvarighet till HLS master-playlisten. Ett enda dokument beskriver hela strömmen: alla kvaliteter, hur segmenten adresseras och (för live) tidslinjen.',
    representation:
      'En enskild kvalitetsnivå av en ström i DASH (motsvarar en HLS-variant). Verktyget analyserar den första ljudrepresentationen i den första perioden, samma "först, inte bäst"-val som HLS-sidan gör.',
    adaptationset:
      'En grupp representationer av samma typ och språk (t.ex. "allt engelskt ljud") som en spelare kan växla fritt mellan. Typen (audio/video/text) läses från contentType, mimeType eller codec-strängen.',
    presentationtype:
      'static betyder en färdig VOD-resurs; dynamic betyder en live-ström vars manifest uppdateras löpande. Motsvarar HLS live/VOD-skillnaden.',
    segmenttemplate:
      'Hur segment-URL:erna byggs. SegmentTemplate med $Number$ räknar upp ett löpnummer; SegmentTimeline listar varje segments längd explicit (med r = antal upprepningar); SegmentList räknar upp färdiga URL:er. Verktyget genererar de senaste URL:erna och HEAD-hämtar dem för att mäta bitrate.',
    mediapresentationduration:
      'Strömmens totala längd för en static (VOD) MPD, uttryckt som ISO 8601-varaktighet (t.ex. PT10M30S). Saknas för dynamic live-strömmar.',
    minbuffertime:
      'Den minsta mängd media (i sekunder) en spelare bör ha buffrat innan uppspelning för att klara nätverksvariationer, enligt manifestet. Grov DASH-motsvarighet till HLS target duration som buffertriktvärde.',
    minimumupdateperiod:
      'Hur ofta (sekunder) en spelare måste hämta om MPD:n för en dynamic ström för att upptäcka nya segment. Ett lågt värde antyder att strömmen är byggd för låg latens.',
    timeshiftbufferdepth:
      'Hur långt bakåt i tiden (sekunder) en live-ström kan spolas, DASH:ens DVR-fönster. Motsvarar ungefär hur många segment HLS håller i sitt fönster.',
    suggestedpresentationdelay:
      'Den fördröjning från livekanten (sekunder) som manifestet rekommenderar att spelare håller. Direkt jämförbar med HLS HOLD-BACK.',
    'dash-est-delay':
      'En grov uppskattning av hur långt efter livekanten en spelare hamnar: suggestedPresentationDelay om det anges, annars cirka tre segmentlängders buffert.',
    availabilitystarttime:
      'Nollpunkten (väggklockan) som segmentens tidslinje räknas från i en dynamic MPD. Simulerade testströmmar sätter ofta denna till 1970 (epoch) med flit.',
    publishtime: 'Tidpunkten den aktuella versionen av MPD:n publicerades. Skillnaden mot nu ("Manifestets ålder") visar hur färskt manifestet är.',
    'manifest-age':
      'Hur länge sedan MPD:n senast publicerades (nu minus publishTime). Bör vara mindre än minimumUpdatePeriod för en välfungerande live-ström. Visas inte när publishTime är epoch-förankrad.',
    contentprotection:
      'DRM/kryptering deklarerad i manifestet, visad som schemeIdUri (t.ex. Widevine, PlayReady, ClearKey). Verktyget visar bara att skyddet finns, så ljudanalysen kan misslyckas för skyddade strömmar.',
    'init-segment':
      'Ett separat initieringssegment (fMP4) som innehåller spårets uppsättningsdata och måste hämtas före de vanliga mediesegmenten. Anges av initialization-attributet i MPD:n.',

    // --- Icecast / SHOUTcast / RSAS ---
    icecast:
      'Icecast, SHOUTcast och RSAS (Rocket Streaming Audio Server) är samma sorts strömserver: en enda oändlig ljudanslutning utan manifest eller segment. De delar protokoll. Stationsinfo skickas i icy-*-headrar och låttiteln i ett litet metadatablock invävt i ljudflödet.',
    'station-name': 'Stationens namn enligt icy-name-headern servern skickar. Sätts av den som konfigurerar strömmen.',
    'station-genre': 'Genren stationen anger om sig själv i icy-genre-headern. Fritext, ingen fast lista.',
    'station-description': 'Stationens egen beskrivning ur icy-description (Icecast). SHOUTcast skickar sällan den.',
    'station-homepage': 'Länken stationen anger till sin webbplats i icy-url-headern.',
    'now-playing-icy':
      'Titeln på det som spelas just nu, läst ur StreamTitle i ett metadatablock som servern väver in i ljudflödet med jämna mellanrum. Verktyget läser de första sekunderna och plockar ut första blocket. En del stationer har metadata avstängt.',
    'server-software':
      'Vilken strömserver som svarade, ur Server-headern t.ex. "Icecast 2.4.4" eller "RocketStreamingAudioServer/1.x". SHOUTcast och RSAS talar samma icy-protokoll som Icecast.',
    'icy-public':
      'Om stationen bett om att listas i publika kataloger (YP-directories), enligt icy-pub. Påverkar inte om du kan lyssna, bara om den syns i kataloger.',
    'icy-metaint':
      'Antal bytes ljud mellan varje inbäddat metadatablock (icy-metaint). Skickas bara när klienten ber om metadata. Saknas det helt skickar strömmen ingen låttitel, vilket är  vanligt och inget fel.',
    'declared-bitrate-icy': 'Bitraten servern uppger i icy-br-headern, i kbit/s. Jämför med den uppmätta bitraten i Ljudprov nedan.',
    'declared-samplerate-icy': 'Samplingsfrekvensen servern uppger i icy-sr-headern, i Hz. Alla servrar skickar inte den.',
    'icecast-sample':
      'Verktyget spelar in några sekunder av strömmen och mäter den faktiska datamängden per sekund. Letar även efter ID3-ramar (ovanligt för Icecast) där låttiteln normalt kommer via icy-metadata istället.',
    'inspelad-langd':
      'Hur många sekunder som faktiskt spelades in för mätningen. Kan bli kortare än begärt om strömmen hackade eller anslutningen bröts.',
    'connect-burst':
      'När en lyssnare ansluter skickar Icecast/SHOUTcast/RSAS direkt en klump redan buffrat ljud så uppspelningen kan starta snabbt, och strypar sedan till realtid. Verktyget spelar in strömmen så fort servern skickar och jämför inspelad speltid med väggklockstid. Mellanskillnaden är bufferten, dvs. ungefär hur långt efter sändningen en ny lyssnare börjar. Grov nedre gräns: anslutningstid, nätverksfart och eventuella reläservrar spär på osäkerheten, och "minst" betyder att hela provet rymdes i bufferten så den egentligen är större.',

    // Loudness (EBU R128) and silence
    loudness:
      'Hur högt strömmen faktiskt låter, mätt enligt EBU R128. Mätningen görs på samma inspelade ljudprov som bitraten, och letar samtidigt efter tystnad i ljudet.',
    'integrated-lufs':
      'Medelljudnivån över hela provet (LUFS). Riktvärden: -23 LUFS för broadcast/TV enligt EBU R128, och -14 till -16 LUFS för streamingtjänster som Spotify och YouTube.',
    'true-peak':
      'Den högsta signaltoppen, mätt även mellan samplingspunkterna (dBTP) så att toppar som uppstår först vid uppspelning räknas med. Över -1 dBTP riskerar ljudet att klippa och låta distat i vissa spelare. "-∞" betyder att provet var helt digitalt tyst',
    'tystnad-start': 'När tystnaden började, räknat från början av ljudprovet.',
    'tystnad-slut':
      'När tystnaden slutade, räknat från början av ljudprovet.',
    'tystnad-langd':
      'Hur länge tystnaden varade. Korta pauser mellan låtar är normalt; längre tystnad kan betyda att sändningen tappat sin källa, även när strömmen i sig fortfarande fungerar.',

    // Stream log
    'tystnad-avbrott':
      'Tystnad och avbrott är två olika fel och listas därför var för sig. "Tystnad" betyder att strömmen svarade och ljudet gick att spela in, men var tyst. "Strömmen nere" betyder att anropet misslyckades helt: ingen ljuddata kom fram. Tystnad kortare än den inställda gränsen visas ingenstans - varken här, i sammanfattningen, i grafen eller bland händelserna.',
    'status-strom':
      'Om hämtningen av ljudet lyckades. Misslyckas hämtningen räknas det som ett avbrott, utom när felet beror på verktygets egen server: att den var upptagen, eller att den inte gick att nå alls. Båda visas separat och räknas inte som att strömmen var nere, eftersom de inte säger något om strömmen.',
    'tystnad-typ':
      'Tystnad = strömmen fungerade men lät ingenting. Strömmen nere = anropet misslyckades, t.ex. att servern inte svarade eller svarade med ett fel.',
    'medel-lufs':
      'Medelvärdet av ljudnivån i varje enskild mätning. Det är inte samma sak som en integrerad ljudnivå för hela sändningen. EBU R128 viktar och gallrar över hela materialet, vilket inte går att räkna fram i efterhand ur medelvärden. Använd det som en trend, inte som ett exakt mått.',

    // Uploaded file analysis
    'fil-oversikt':
      'Allt filen själv säger om sig: containerformat, längd, bitrate, sampleformat, bitdjup, encoder-sträng och inbäddade taggar. Läst med ffprobe utan att avkoda ljudet.',
    'fil-container':
      'Filformatet som paketerar ljudet, t.ex. WAV, FLAC, MP3, MP4/M4A eller Ogg. Samma ljudkodek kan ligga i flera olika containrar.',
    'fil-langd': 'Filens totala speltid, läst ur containern. Filer längre än 130 minuter analyseras bara till den gränsen.',
    tlen:
      'ID3-taggen TLEN anger låtens längd i millisekunder. Den skrevs av programmet som taggade filen och stämmer inte alltid med filens verkliga längd, t.ex. om filen har klippts eller kodats om efter att taggen sattes. Övriga interna eller binära taggar (Windows Media-id:n m.m.) visas inte alls.',
    sampleformat:
      'Hur varje sampling lagras internt, t.ex. s16 (16-bitars heltal), s32 (32-bitars heltal) eller fltp (32-bitars flyttal). Säger inte alltid hur många bitar som faktiskt används, se Bitdjup.',
    bitdjup:
      'Hur många bitars upplösning ljudet har. "Deklarerat" är vad filen anger; "faktiskt använda" är hur många bitar datan verkligen rör sig i. Är de olika är filen uppsamplad eller utfylld med nollor, t.ex. en 16-bitars inspelning sparad som 24-bitars. Gäller bara heltals-PCM (WAV, FLAC, AIFF): en MP3 eller AAC har inget bitdjup alls utan avkodas till flyttal, och då visas ingen siffra.',
    encoder:
      'Programmet och ofta versionen som skapade filen, ur en tagg som "LAME3.100" eller "libFLAC 1.4.2". Kan avslöja hur filen har bearbetats.',
    replaygain:
      'ReplayGain/R128-taggar anger hur mycket en spelare bör dämpa eller höja filen för jämn uppspelningsnivå. De sätts av rippnings- eller taggningsverktyg, inte av det här verktyget, och ändrar inte själva ljudet.',
    omslagsbild: 'Om en bild (skivomslag) ligger inbäddad i filen, och i så fall dess pixelmått och format.',
    kapitel: 'Kapitelmärken i filen, vanliga i ljudböcker och poddar. Visar start, slut och titel för varje kapitel.',
    lra:
      'Loudness Range (LU) – skillnaden mellan de tystare och de starkare partierna över hela filen, enligt EBU R128. Högt värde = dynamiskt (t.ex. klassiskt, 10–20+ LU); lågt värde = hårt komprimerat (ofta 3–6 LU för modern pop). Mäts inte på strömmar eftersom 15 sekunder är för kort.',
    'sample-peak':
      'Den högsta enskilda samplingen (dBFS), utan hänsyn till vad som händer mellan samplingarna. True peak ligger alltid lika högt eller högre; skillnaden är de toppar som uppstår först vid uppspelning.',
    plr:
      'Peak-to-Loudness Ratio: true peak minus integrerad nivå (LU). Stort värde = mycket dynamik kvar (punchig master); nära 0 = allt tryckt mot taket ("loudness war"). Runt 8–15 LU är typiskt för en ocomprimerad master, under 5 för en hårt begränsad.',
    'dc-offset':
      'En konstant förskjutning av ljudsignalen från noll. Bör vara i princip 0. Ett tydligt DC-offset betyder ett fel i inspelnings- eller digitaliseringskedjan och äter dessutom av rubriken.',
    'rms-niva': 'Den genomsnittliga energinivån i ljudet (dB), ungefär hur starkt det låter i snitt – till skillnad från topparna.',
    'crest-factor':
      'Förhållandet mellan toppnivå och RMS-nivå. ≈ 1,41 för en ren sinuston, större för dynamiskt material (trummor, orkester), och krymper mot 1 ju hårdare materialet är komprimerat/limiterat.',
    brusgolv: 'Den lägsta nivån i ljudet (dB) – i praktiken bruset eller tystnaden mellan ljuden. Lågt värde = tyst inspelning, högt = hörbart brus/brum.',
    klippning:
      'Antal samplingar som ligger exakt på det digitala maxvärdet. Ett fåtal är normalt; många i rad betyder att signalen har klippts (kan låta distat) eller körts hårt genom en limiter.',
    stereokorrelation:
      'Samma mätning som korrelationsmätaren på ett mixerbord: hur lika vänster och höger kanal är, −1 till +1. +1 = identiska (mono); +0,5 till +1 är den mono-säkra zonen; runt 0 = mycket bred/dekorrelerad; under 0 = kanalerna motverkar varandra och tappar energi vid mono-summering (mobil, Bluetooth, klubb, mono-sändning). Räknas ur mid/side-nivåerna så tystnad inte påverkar värdet, och mäts på de första 10 minuterna av längre filer.',
    dubbelmono: 'En "stereofil" där båda kanalerna är exakt samma signal – ingen stereobild alls, och halva datamängden är bortkastad. Korrelationen ligger då låst på +1.',
    fas:
      'Partier där kanalerna antingen motverkar varandra ("ur fas") eller är helt identiska ("mono"), med start och sluttid. Tystnad har räknats bort, så det som listas är verkliga partier med ljud. "Ur fas" är det som är värt att åtgärda: signalen tunnas ut eller försvinner när ljudet summeras till mono. "Mono" mitt i en i övrigt bred mix kan vara avsiktligt (mono-intro, centrerad sång) eller ett spår som råkat renderas som dubbelmono.',
    spektrogram:
      'En bild av vilka frekvenser (lodrätt) som finns vid varje tidpunkt (vågrätt), starkare färg = mer energi. En skarp, spikrak vågrät kant högt upp är signaturen för lossy-kodning: MP3/AAC kapar tvärt, runt 16 kHz vid 128 kbit/s och runt 19–20 kHz vid 320 kbit/s. Ser du en sådan kant i en FLAC eller WAV är filen troligen gjord från en lossy källa – men bedöm det på bilden, en dov mastring eller gammalt material rullar av mjukt och betyder inget sådant.',
  },
});
