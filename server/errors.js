// errors.js
// Every failure this app reports on purpose. Each class carries enough detail for
// index.js to pick an HTTP status and for the frontend to render something the user
// can act on, without either of them having to guess from a message string.

import { MAX_MANIFEST_BYTES, TIMEOUT_MS } from './config.js';

export class AppError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export class TimeoutError extends AppError {
  constructor(url) {
    super('TIMEOUT', `Timeout - servern svarade inte inom ${TIMEOUT_MS / 1000} sekunder.`, { url });
  }
}

export class UpstreamHttpError extends AppError {
  constructor(url, status, statusText, bodySnippet) {
    const geoblockGuess = status === 403 && (!bodySnippet || bodySnippet.trim() === '');
    super('UPSTREAM_HTTP_ERROR', `Servern svarade ${status} ${statusText}.`, {
      url,
      status,
      statusText,
      bodySnippet,
      geoblockGuess,
    });
  }
}

// DNS/TCP/TLS failures reach us as TypeError('fetch failed', { cause }), which used
// to fall through as a bare INTERNAL_ERROR 500 - reporting the upstream being
// unreachable as a fault of ours, with no clue what went wrong.
export class UpstreamUnreachableError extends AppError {
  constructor(url, cause) {
    const reasons = {
      ENOTFOUND: 'värdnamnet kunde inte slås upp',
      EAI_AGAIN: 'DNS-uppslagningen gick inte att slutföra',
      ECONNREFUSED: 'anslutningen avvisades',
      ECONNRESET: 'anslutningen bröts av servern',
      EHOSTUNREACH: 'värden gick inte att nå',
      ETIMEDOUT: 'anslutningsförsöket tog för lång tid',
      CERT_HAS_EXPIRED: 'serverns TLS-certifikat har gått ut',
      UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'serverns TLS-certifikat kunde inte verifieras',
    };
    const reason = reasons[cause?.code] || cause?.message || 'okänt nätverksfel';
    super('UPSTREAM_UNREACHABLE', `Kunde inte ansluta till servern - ${reason}.`, {
      url,
      cause: cause?.code || null,
    });
  }
}

export class InvalidManifestError extends AppError {
  constructor(url, preview) {
    super('INVALID_MANIFEST', 'Svaret ser inte ut som en giltig M3U8-fil (saknar #EXTM3U).', {
      url,
      preview,
    });
  }
}

export class InvalidMpdError extends AppError {
  constructor(url, preview) {
    super('INVALID_MPD', 'Svaret ser inte ut som ett giltigt MPD-manifest (DASH).', {
      url,
      preview,
    });
  }
}

export class ManifestTooLargeError extends AppError {
  constructor(url, limitBytes = MAX_MANIFEST_BYTES) {
    super(
      'MANIFEST_TOO_LARGE',
      `Svaret är större än ${Math.round(limitBytes / 1024 / 1024)} MB - det är inte ett rimligt manifest och hämtas inte.`,
      { url, limitBytes }
    );
  }
}

export class RequestAbortedError extends AppError {
  constructor(message = 'Begäran avbröts.') {
    super('REQUEST_ABORTED', message, {});
  }
}

export class BinaryMissingError extends AppError {
  constructor(binary) {
    const mac = `brew install ffmpeg`;
    const linux = `sudo apt install ffmpeg   (eller: sudo dnf install ffmpeg)`;
    super('BINARY_MISSING', `Hittar inte "${binary}" i PATH. Är ffmpeg installerat?`, {
      binary,
      installHelp: { macOS: mac, linux },
    });
  }
}

export class FfprobeError extends AppError {
  constructor(stderr) {
    super('FFPROBE_FAILED', 'ffprobe kunde inte analysera strömmen.', { stderr: stderr?.slice(0, 2000) });
  }
}

export class FfmpegError extends AppError {
  constructor(stderr) {
    super('FFMPEG_FAILED', 'ffmpeg kunde inte spela in strömmen.', { stderr: stderr?.slice(0, 2000) });
  }
}

export class ValidationError extends AppError {
  constructor(message) {
    super('VALIDATION_ERROR', message, {});
  }
}

export class HostBlockedError extends AppError {
  constructor(hostname) {
    super('HOST_BLOCKED', `"${hostname}" pekar mot ett internt/privat nätverk och kan inte analyseras.`, {
      hostname,
    });
  }
}
