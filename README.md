# Audio Analyzer

Ett litet lokalt verktyg för att analysera ljudströmmar (just nu HLS/`.m3u8`)
och ljudfiler - särskilt tänkt för radioströmmar bakom CDN:er som Akamai.
Klistra in en manifest-URL och få en samlad nulägesbild: anslutning/CORS,
varianter, ljudkodek, segment och buffert, latens, uppmätt bitrate,
"nu spelas"-ID3 och råmanifestet.

## Varför en backend?

De flesta CDN:er (t.ex. Akamai) skickar inte CORS-headers på sina manifest,
så `fetch()` direkt från webbläsaren blockeras. Verktyget behöver också
`ffprobe`/`ffmpeg`, som är binärer och inte kan köras i webbläsaren. Därför
finns en Node/Express-backend som proxar HTTP-anropen och kör ffprobe/ffmpeg
som barnprocesser. Frontend är ren HTML/CSS/JS utan bygge eller ramverk.

## Förutsättningar

- Node.js 18 eller senare
- `ffmpeg` (inkl. `ffprobe`) installerat och tillgängligt i PATH
  - macOS: `brew install ffmpeg`
  - Linux: `sudo apt install ffmpeg` (eller `sudo dnf install ffmpeg`)
  - Windows: `winget install Gyan.FFmpeg`

Saknas ffmpeg/ffprobe startar servern ändå, men ljud-/buffert-/
inspelningsanalysen misslyckas (manifestanalysen fungerar som vanligt).

## Installation och körning

```bash
npm install
npm start
```

Servern binder uttryckligen till `127.0.0.1` (inte `0.0.0.0`) och lyssnar på
port `8877` som standard (override med `PORT=xxxx npm start`). Öppna
`http://127.0.0.1:8877/` i webbläsaren, klistra in en `.m3u8`-URL och klicka
Analysera.

## Testa

Inga automatiserade tester finns. Manuell verifiering:
1. `npm start`, öppna sidan, klicka Analysera på den förifyllda exempel-URL:en.
2. Testa ett felfall genom att klistra in en URL som ger 404 eller pekar på
   en sida som inte är en M3U8 - felet ska visas läsbart, sidan ska aldrig
   bli tom.

## Att känna till

- **Nulägesbild, inte live** - varje klick på Analysera gör ett nytt anrop.
  Sidan pollar inte och uppdaterar sig inte automatiskt.
- **"Endast en variant"** - många radioströmmar saknar en separat
  master-playlist; URL:en pekar då direkt på media-playlistan. Det flaggas
  i gränssnittet istället för att visa en tom varianttabell.
- **ID3/"Nu spelas" är bäst-ansträngning** - kräver att strömmen faktiskt
  bär timed metadata i segmenten. Många strömmar gör inte det, och då visas
  "Ingen ID3-metadata hittades" - det är förväntat, inte ett fel.
- **Timeout** på alla externa HTTP-anrop och ffprobe-körningar är 10 sekunder
  (`TIMEOUT_MS` i `server/analyzer.js`).

## Licens

[MIT](LICENSE)
