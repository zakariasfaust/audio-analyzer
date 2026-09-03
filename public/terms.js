// terms.js
// Glossary with short explanations (max 3 sentences) for headings and
// value names in the UI. Shown as a native tooltip via the title attribute,
// see withHint() in app.js. Loaded as its own script before app.js.
// Covers both the HLS and DASH sections.

const STREAM_TERMS = {
  // Section headings (h2)
  anslutning:
    'Visar om hämtningen av manifestet lyckades och vilka HTTP-headrar CDN:en svarade med, inklusive om CORS (Cross-Origin Resource Sharing) tillåts. Saknas CORS kan en vanlig webbläsare inte hämta strömmen direkt utan en proxy som den här backend:en.',
  varianter:
    'En HLS-master-playlist kan lista flera varianter av samma ström i olika kvaliteter, så spelaren kan välja den som passar tittarens uppkoppling. Radio har oftast bara en variant eftersom ljud kräver mycket mindre bandbredd än video.',
  ljud: 'Teknisk information om själva ljudkodningen, hämtad genom att köra verktyget ffprobe mot strömmen.',
  segment:
    'HLS delar upp strömmen i korta segment som spelaren laddar ner ett i taget. Den här sektionen visar hur segmenten är uppbyggda och hur stort "fönster" av dem som är tillgängligt just nu.',
  latens:
    'Jämför tidsstämpeln i segmenten med systemklockan för att uppskatta hur långt efter den faktiska sändningen strömmen ligger. Kräver att manifestet innehåller PROGRAM-DATE-TIME-taggar.',
  bitrate:
    'Den faktiska datamängden per sekund, uppmätt genom att hämta storleken på de senaste segmenten och jämföra med deras spellängd - jämförs med den bandbredd manifestet deklarerar.',
  id3:
    'Vissa radioströmmar bäddar in metadata (t.ex. låttitel och artist) direkt i ljudsegmenten, med samma ID3-teknik som mp3-filer använder. Verktyget spelar in några sekunder av strömmen och letar efter sådan metadata - många strömmar saknar den helt.',
  manifest:
    'Den råa, otolkade texten i .m3u8-filen som hämtades från servern - beskriver vilka segment eller varianter som finns.',
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
    'Många CDN-noder namnges med en flygplatskod (t.ex. ARN för Stockholm Arlanda) följt av siffror. Det här är en ogranskad gissning baserad på det mönstret i nodnamnet - inte en bekräftad plats.',
  'dns-lookup':
    'Vilka IP-adresser värdnamnet pekar mot just nu, uppslaget av verktygets egen backend. CDN:er använder ofta DNS-baserad lastbalansering, så resultatet kan variera mellan anrop och är inte nödvändigtvis samma nod som faktiskt svarade på anropet i Anslutning-kortet.',
  'ip-geo':
    'Stad/land för varje IP, från en lokal offline-databas. Ett grovt komplement till hintan ovan - kan vara fel eller inaktuellt, särskilt för CDN-adresser.',
  'extra-headers':
    'HTTP-headrar i svaret vars namn börjar med "x-" (en gammal konvention för icke-standardiserade headrar), innehåller "akamai", eller börjar med "icy-" (stationsinfo från Icecast/SHOUTcast/RSAS). Ofta de mest talande för vad som hänt hos CDN:et eller strömservern.',

  // Variants (th)
  'variant-bandbredd':
    'Toppbandbredden (kbit/s) variantens kodning kan kräva, enligt manifestet - ett riktvärde, inte samma sak som den faktiska uppmätta bitraten.',
  'variant-snitt':
    'Genomsnittlig bandbredd (kbit/s) för varianten över tid, om manifestet anger det - oftast mer realistisk än toppvärdet.',
  codecs: 'Anger exakt vilka kodekar som används, i standardiserat format. "mp4a.40.2" betyder till exempel AAC-LC-ljud.',
  upplosning: 'Videoupplösningen i bredd × höjd bildpunkter. Tom för renodlade ljudströmmar som radio.',
  'variant-url': 'Länken till just den här variantens egna media-playlist.',

  // Audio track (dt)
  codec: 'Vilken ljudkodek segmenten är kodade med, t.ex. AAC. Profilen inom parentes (t.ex. LC) beskriver en specifik variant av kodeken.',
  samplingsfrekvens: 'Hur många gånger per sekund ljudet mättes vid inspelningen, i Hertz. 48 000 och 44 100 Hz är vanligast.',
  kanaler: 'Antal ljudkanaler - 1 är mono, 2 är stereo. Fler kanaler förekommer vid surroundljud.',
  'audio-bitrate': 'Hur mycket data ljudet kodas med per sekund - högre bitrate ger normalt bättre kvalitet men kräver mer bandbredd.',
  container: 'Filformatet segmenten är paketerade i, t.ex. MPEG-TS (.ts) eller fragmenterad MP4 (fMP4).',

  // Segments and buffer (dt)
  version: 'HLS-protokollversionen manifestet är skrivet för, vilket avgör vilka taggar och funktioner som får användas.',
  targetduration:
    'Den längsta tillåtna segmentlängden i sekunder. Spelare använder värdet för att veta hur ofta de bör hämta ett nytt manifest.',
  mediasequence:
    'Ett löpnummer som talar om vilket segment i den totala strömmen som är först i den aktuella listan. Ökar när äldre segment plockas bort från fönstret.',
  typ: 'Live betyder att manifestet uppdateras kontinuerligt utan slut; VOD betyder en avslutad, färdig ström.',
  'antal-segment': 'Hur många segment som just nu listas i manifestets "fönster" - det synliga utsnittet av den pågående strömmen.',
  fonsterlangd:
    'Den sammanlagda spellängden i sekunder för alla segment i fönstret - ungefär så mycket spelaren kan buffra utan att hämta ett nytt manifest.',
  snittlangd: 'Genomsnittlig längd per segment, beräknad från fönstrets totala längd delat på antal segment.',
  krypterat: 'Om segmenten är krypterade enligt EXT-X-KEY-taggen. Spelaren behöver rätt nyckel för att kunna spela upp strömmen.',
  fmp4: 'Om segmenten är i fragmenterat MP4-format istället för det äldre MPEG-TS, angivet av EXT-X-MAP-taggen.',
  discontinuities:
    'Antal EXT-X-DISCONTINUITY-hopp i fönstret - punkter där kodning, tidsbas eller format byts (t.ex. vid reklamavbrott). Varje sådan tvingar spelaren att tömma och bygga upp sin buffert på nytt, vilket kan höras som en kort paus.',

  // Low-Latency HLS (h3 + dt)
  llhls:
    'LL-HLS (Low-Latency HLS) är en uppsättning tillägg till HLS-standarden som sänker fördröjningen genom att dela upp segment i mindre "parts" som spelaren kan hämta innan hela segmentet är klart. Kräver stöd hos både paketerare, CDN och spelare för att fungera.',
  'll-can-block-reload':
    'Om servern stödjer "blockerande" manifestförfrågningar - spelaren kan be servern vänta med svaret tills ett nytt segment eller delsegment finns, istället för att polla. En grundförutsättning för LL-HLS.',
  'll-hold-back':
    'Rekommenderad distans (sekunder) från livekanten som manifestet ber vanliga spelare hålla, från EXT-X-SERVER-CONTROL. Ett lågt värde betyder att strömmen är byggd för låg latens.',
  'll-part-hold-back':
    'Samma sak som HOLD-BACK, men specifikt för spelare som stödjer LL-HLS och kan buffra i delsegment ("parts") - normalt ett lägre värde eftersom de kan ligga närmare livekanten.',
  'll-can-skip-until':
    'Hur långt tillbaka (sekunder) en spelare får be om en förkortad manifestuppdatering (EXT-X-SKIP) istället för hela listan, för att spara bandbredd vid täta uppdateringar.',
  'll-can-skip-dateranges':
    'Om servern även stödjer att hoppa över EXT-X-DATERANGE-taggar i en förkortad manifestuppdatering (EXT-X-SKIP).',
  'll-part-target':
    'Målspellängden för de små delsegment ("parts") som LL-HLS delar upp varje vanligt segment i, från EXT-X-PART-INF. Delsegment gör att spelaren kan börja spela innan ett helt vanligt segment hunnit bli klart.',
  'll-preload-hint':
    'EXT-X-PRELOAD-HINT annonserar ett kommande delsegment eller initieringssegment som spelaren kan börja begära redan innan det är färdigproducerat, via en blockerande förfrågan.',

  // Continuity and start point (h3 + dt)
  kontinuitet:
    'Visar var i strömmen kodning eller tidsbas faktiskt byts (discontinuities), och var en spelare rekommenderas börja spela upp - två separata saker som lätt blandas ihop med latens och buffertfönster.',
  'discontinuity-sequence':
    'Startvärdet för discontinuity-räknaren i det här manifestet (EXT-X-DISCONTINUITY-SEQUENCE). Används av spelare för att hålla koll på kontinuitetshopp korrekt även när de bytt mellan olika varianter.',
  'ext-x-start':
    'Anger var i strömmen en spelare rekommenderas börja uppspelningen (TIME-OFFSET), inte var den faktiskt kan börja. Positivt värde räknas från fönstrets början, negativt värde bakåt från livekanten.',

  // Latency (dt)
  'latens-metod':
    '"Uppmätt direkt" betyder att flera segment har egna tidsstämplar och siffran är tillförlitlig. "Beräknad från segmentsumma" betyder att bara ett segment i fönstret hade en tidsstämpel (vanligt i äldre HLS) - resten är extrapolerat genom att addera segmentens längder, vilket gör siffran mer osäker.',
  'aldsta-ts': 'Tidsstämpeln för det äldsta segmentet i det synliga fönstret, enligt dess PROGRAM-DATE-TIME-tagg.',
  'nyaste-ts': 'Tidsstämpeln för det senaste segmentet i det synliga fönstret - ligger närmast liveläget.',
  'fordrojning-aldsta': 'Hur många sekunder som gått mellan det äldsta segmentets tidsstämpel och nu. Ungefär hela buffertfönstrets ålder.',
  'fordrojning-nyaste':
    'Hur många sekunder som gått sedan det senaste tillgängliga segmentet spelades in - ett mått på den faktiska fördröjningen en lyssnare upplever.',

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
    'Hur långt bakåt i tiden (sekunder) en live-ström kan spolas - DASH:ens DVR-fönster. Motsvarar ungefär hur många segment HLS håller i sitt fönster.',
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
    'DRM/kryptering deklarerad i manifestet, visad som schemeIdUri (t.ex. Widevine, PlayReady, ClearKey). Verktyget visar bara att skyddet finns - det kan inte dekryptera, så ljudanalysen kan misslyckas för skyddade strömmar.',
  'init-segment':
    'Ett separat initieringssegment (fMP4) som innehåller spårets uppsättningsdata och måste hämtas före de vanliga mediesegmenten. Anges av initialization-attributet i MPD:n.',

  // --- Icecast / SHOUTcast / RSAS ---
  icecast:
    'Icecast, SHOUTcast och RSAS (Rocket Streaming Audio Server) är samma sorts strömserver: en enda oändlig ljudanslutning utan manifest eller segment. De delar protokoll - stationsinfo skickas i icy-*-headrar och låttiteln i ett litet metadatablock invävt i ljudflödet.',
  'station-name': 'Stationens namn enligt icy-name-headern servern skickar. Sätts av den som konfigurerar strömmen.',
  'station-genre': 'Genren stationen anger om sig själv i icy-genre-headern. Fritext, ingen fast lista.',
  'station-description': 'Stationens egen beskrivning ur icy-description (Icecast). SHOUTcast skickar sällan den.',
  'station-homepage': 'Länken stationen anger till sin webbplats i icy-url-headern.',
  'now-playing-icy':
    'Titeln på det som spelas just nu, läst ur StreamTitle i ett metadatablock som servern väver in i ljudflödet med jämna mellanrum. Verktyget läser de första sekunderna och plockar ut första blocket - en del stationer har metadata avstängt.',
  'server-software':
    'Vilken strömserver som svarade, ur Server-headern - t.ex. "Icecast 2.4.4" eller "RocketStreamingAudioServer/1.x". SHOUTcast och RSAS talar samma icy-protokoll som Icecast.',
  'icy-public':
    'Om stationen bett om att listas i publika kataloger (YP-directories), enligt icy-pub. Påverkar inte om du kan lyssna, bara om den syns i kataloger.',
  'icy-metaint':
    'Antal bytes ljud mellan varje inbäddat metadatablock (icy-metaint). Skickas bara när klienten ber om metadata. Saknas det helt skickar strömmen ingen låttitel - vanligt och inget fel.',
  'declared-bitrate-icy': 'Bitraten servern uppger i icy-br-headern, i kbit/s. Jämför med den uppmätta bitraten i Ljudprov nedan.',
  'declared-samplerate-icy': 'Samplingsfrekvensen servern uppger i icy-sr-headern, i Hz. Alla servrar skickar inte den.',
  'icecast-sample':
    'Verktyget spelar in några sekunder av strömmen och mäter den faktiska datamängden per sekund. Letar även efter ID3-ramar - ovanligt för Icecast, där låttiteln normalt kommer via icy-metadata istället.',
  'inspelad-langd':
    'Hur många sekunder som faktiskt spelades in för mätningen - kan bli kortare än begärt om strömmen hackade eller anslutningen bröts.',
};
