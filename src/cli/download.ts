import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';

export interface DownloadOptions {
  signal?: AbortSignal;
  onProgress?: (receivedBytes: number, totalBytes: number | undefined) => void;
  userAgent?: string;
}

const MAX_REDIRECTS = 8;

export async function downloadFile(url: string, destination: string, options: DownloadOptions = {}): Promise<void> {
  let currentUrl = url;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await requestOnce(currentUrl, options);
    const status = response.statusCode ?? 0;

    if (status >= 300 && status < 400 && response.headers.location) {
      response.resume();
      currentUrl = new URL(response.headers.location, currentUrl).toString();
      continue;
    }

    if (status !== 200) {
      response.resume();
      throw new Error(`Download failed with HTTP ${status} for ${currentUrl}`);
    }

    const total = Number(response.headers['content-length']) || undefined;
    let received = 0;
    const output = createWriteStream(destination, { flags: 'w' });

    await new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        response.destroy(new Error('Download aborted'));
        output.destroy();
        void rm(destination, { force: true });
        reject(new Error('Download aborted'));
      };

      if (options.signal?.aborted) {
        abort();
        return;
      }
      options.signal?.addEventListener('abort', abort, { once: true });

      response.on('data', (chunk: Buffer) => {
        received += chunk.length;
        options.onProgress?.(received, total);
      });
      response.on('error', (error) => {
        options.signal?.removeEventListener('abort', abort);
        output.destroy();
        reject(error);
      });
      output.on('error', (error) => {
        options.signal?.removeEventListener('abort', abort);
        response.destroy();
        reject(error);
      });
      output.on('finish', () => {
        options.signal?.removeEventListener('abort', abort);
        resolve();
      });
      response.pipe(output);
    });
    return;
  }

  throw new Error(`Too many redirects while downloading ${url}`);
}

function requestOnce(url: string, options: DownloadOptions): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'http:' ? http : https;
    const headers: Record<string, string> = {
      'User-Agent': options.userAgent ?? 'checkmarx-local-vscode',
      Accept: 'application/octet-stream,*/*'
    };
    const agent = proxyAgentFor(parsed);

    const request = transport.get(
      parsed,
      {
        headers,
        agent,
        timeout: 120_000
      },
      (response) => resolve(response)
    );
    request.on('timeout', () => {
      request.destroy(new Error(`Timed out downloading ${url}`));
    });
    request.on('error', reject);

    if (options.signal) {
      if (options.signal.aborted) {
        request.destroy(new Error('Download aborted'));
        return;
      }
      options.signal.addEventListener('abort', () => request.destroy(new Error('Download aborted')), { once: true });
    }
  });
}

function proxyAgentFor(url: URL): http.Agent | undefined {
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (!proxy || isNoProxy(url.hostname)) {
    return undefined;
  }
  try {
    return new HttpsProxyAgent(proxy);
  } catch {
    return undefined;
  }
}

function isNoProxy(hostname: string): boolean {
  const noProxy = process.env.NO_PROXY ?? process.env.no_proxy;
  if (!noProxy) {
    return false;
  }
  return noProxy
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .some((pattern) => {
      if (pattern === '*') {
        return true;
      }
      const normalized = pattern.replace(/^\./, '');
      return hostname.toLowerCase() === normalized || hostname.toLowerCase().endsWith(`.${normalized}`);
    });
}