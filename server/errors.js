// errors.js
// Every failure this app reports on purpose. Each class carries enough detail for
// index.js to pick an HTTP status and for the frontend to render something the user
// can act on, without either of them having to guess from a message string.
//
// `message` is English and developer-facing only (server logs, curl/non-browser API
// consumers) - it is never what the user sees. What the user sees comes from
// `i18nKey`/`params`, resolved against the active locale's catalog client-side (see
// errorText() in public/shared.js and the errors.* namespace in public/i18n/*.js).
// A class that has nothing sentence-shaped to say (just codes/numbers) doesn't need
// this at all - see server/dash.js's header comment for that principle.

import { MAX_MANIFEST_BYTES, TIMEOUT_MS } from './config.js';

export class AppError extends Error {
  constructor(code, message, details = {}, i18n = {}) {
    super(message);
    this.code = code;
    this.details = details;
    this.i18nKey = i18n.i18nKey || null;
    this.params = i18n.params || {};
  }
}

export class TimeoutError extends AppError {
  constructor(url) {
    super('TIMEOUT', `Timed out - server did not respond within ${TIMEOUT_MS / 1000}s.`, { url }, {
      i18nKey: 'errors.timeout',
      params: { seconds: TIMEOUT_MS / 1000 },
    });
  }
}

export class UpstreamHttpError extends AppError {
  constructor(url, status, statusText, bodySnippet) {
    const geoblockGuess = status === 403 && (!bodySnippet || bodySnippet.trim() === '');
    super('UPSTREAM_HTTP_ERROR', `Upstream server responded ${status} ${statusText}.`, {
      url,
      status,
      statusText,
      bodySnippet,
      geoblockGuess,
    }, {
      i18nKey: 'errors.upstreamHttp',
      params: { status, statusText },
    });
  }
}

// DNS/TCP/TLS failures reach us as TypeError('fetch failed', { cause }), which used
// to fall through as a bare INTERNAL_ERROR 500 - reporting the upstream being
// unreachable as a fault of ours, with no clue what went wrong. The `causeCode`
// param is looked up against errors.upstreamUnreachableReasons in the client
// catalog (see errorText() in shared.js) - the reason phrase itself lives there,
// not here, same as every other user-facing sentence in this file.
export class UpstreamUnreachableError extends AppError {
  constructor(url, cause) {
    const causeCode = cause?.code || null;
    super('UPSTREAM_UNREACHABLE', `Could not connect upstream (${causeCode || cause?.message || 'unknown network error'}).`, {
      url,
      cause: causeCode,
    }, {
      i18nKey: 'errors.upstreamUnreachable',
      params: { causeCode: causeCode || 'UNKNOWN' },
    });
  }
}

// preview is the raw response text shown to help debug an unexpected answer, kept
// out of i18n params since it's arbitrary upstream content, not a sentence. `override`
// lets a caller replace the generic "doesn't look valid" message with a more specific
// one (e.g. "no variants found") without a second error class - see hls.js/dash.js.
export class InvalidManifestError extends AppError {
  constructor(url, preview, override = {}) {
    super(
      'INVALID_MANIFEST',
      override.message || 'Response does not look like a valid M3U8 file (missing #EXTM3U).',
      { url, preview: override.message ? null : preview },
      { i18nKey: override.i18nKey || 'errors.invalidManifest', params: override.params || {} }
    );
  }
}

export class InvalidMpdError extends AppError {
  constructor(url, preview, override = {}) {
    super(
      'INVALID_MPD',
      override.message || 'Response does not look like a valid MPD manifest (DASH).',
      { url, preview: override.message ? null : preview },
      { i18nKey: override.i18nKey || 'errors.invalidMpd', params: override.params || {} }
    );
  }
}

export class ManifestTooLargeError extends AppError {
  constructor(url, limitBytes = MAX_MANIFEST_BYTES) {
    const limitMb = Math.round(limitBytes / 1024 / 1024);
    super(
      'MANIFEST_TOO_LARGE',
      `Response is larger than ${limitMb} MB - not a reasonable manifest, not fetched.`,
      { url, limitBytes },
      { i18nKey: 'errors.manifestTooLarge', params: { limitMb } }
    );
  }
}

export class RequestAbortedError extends AppError {
  constructor(message = 'Request was aborted.') {
    super('REQUEST_ABORTED', message, {}, { i18nKey: 'errors.requestAborted', params: {} });
  }
}

export class BinaryMissingError extends AppError {
  constructor(binary) {
    const mac = `brew install ffmpeg`;
    const linux = `sudo apt install ffmpeg   (or: sudo dnf install ffmpeg)`;
    super('BINARY_MISSING', `Cannot find "${binary}" in PATH. Is ffmpeg installed?`, {
      binary,
      installHelp: { macOS: mac, linux },
    }, {
      i18nKey: 'errors.binaryMissing',
      params: { binary },
    });
  }
}

export class FfprobeError extends AppError {
  constructor(stderr) {
    super('FFPROBE_FAILED', 'ffprobe could not analyze the stream.', { stderr: stderr?.slice(0, 2000) }, {
      i18nKey: 'errors.ffprobeFailed',
      params: {},
    });
  }
}

// The message is overridable because ffmpeg is asked to do several different jobs -
// record a sample, measure loudness, render a spectrogram - and one generic sentence
// is not an honest explanation of all of them. i18nKey follows the same override.
export class FfmpegError extends AppError {
  constructor(stderr, message = 'ffmpeg could not record the stream.', override = {}) {
    super('FFMPEG_FAILED', message, { stderr: stderr?.slice(0, 2000) }, {
      i18nKey: override.i18nKey || 'errors.ffmpegFailed',
      params: override.params || {},
    });
  }
}

export class ValidationError extends AppError {
  constructor(message, i18n = {}) {
    super('VALIDATION_ERROR', message, {}, i18n);
  }
}

// An upload the server declines before analysing it: too large, or the body never
// arrived. Separate from VALIDATION_ERROR so it can map to 413.
export class UploadRejectedError extends AppError {
  constructor(message, details = {}, i18n = {}) {
    super('UPLOAD_REJECTED', message, details, i18n);
  }
}

// ffprobe could not find an audio stream in the upload (or could not read it as
// media at all) - "this isn't an audio file", not a fault in our tooling.
export class NotAudioFileError extends AppError {
  constructor(message, i18n = {}) {
    super('NOT_AUDIO_FILE', message, {}, i18n);
  }
}

export class HostBlockedError extends AppError {
  constructor(hostname) {
    super('HOST_BLOCKED', `"${hostname}" points to an internal/private network and cannot be analyzed.`, {
      hostname,
    }, {
      i18nKey: 'errors.hostBlocked',
      params: { hostname },
    });
  }
}
