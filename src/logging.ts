export interface LoggerLike {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export const noopLogger: LoggerLike = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined
};

export function redactSecrets(value: string): string {
  return value
    .replace(/(--apikey\s+)(\S+)/gi, '$1***')
    .replace(/(CX_APIKEY\s*=\s*)(\S+)/gi, '$1***')
    .replace(/(Authorization:\s*Bearer\s+)(\S+)/gi, '$1***')
    .replace(/(x-checkmarx-bridge-token:\s*)(\S+)/gi, '$1***')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '***');
}