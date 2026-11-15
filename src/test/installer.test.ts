import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import AdmZip from 'adm-zip';
import { c as createTar } from 'tar';
import { downloadFile } from '../cli/download';
import { extractCliArchive, findExtractedBinary } from '../cli/installer';

async function withProxyDisabled<T>(run: () => Promise<T>): Promise<T> {
  const saved = {
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    http_proxy: process.env.http_proxy,
    https_proxy: process.env.https_proxy,
    NO_PROXY: process.env.NO_PROXY,
    no_proxy: process.env.no_proxy
  };
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.http_proxy;
  delete process.env.https_proxy;
  process.env.NO_PROXY = '127.0.0.1,localhost';
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('downloadFile follows redirects and reports progress', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cx-download-'));
  const target = join(root, 'archive.tgz');
  const payload = Buffer.from('checkmarx-cli-test-payload');
  let server: Server | undefined;

  try {
    server = createServer((request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, { Location: '/file' });
        response.end();
        return;
      }
      response.writeHead(200, { 'Content-Length': payload.length, 'Content-Type': 'application/octet-stream' });
      response.end(payload);
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/redirect`;

    const progress: number[] = [];
    await withProxyDisabled(() =>
      downloadFile(url, target, {
        onProgress: (received) => progress.push(received)
      })
    );

    assert.deepEqual(await readFile(target), payload);
    assert.ok(progress.length > 0);
    assert.equal(progress.at(-1), payload.length);
  } finally {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('downloadFile can be aborted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cx-download-abort-'));
  const target = join(root, 'archive.tgz');
  let server: Server | undefined;

  try {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Length': 1024 * 1024 });
      response.write(Buffer.alloc(1024));
      // Keep the connection open so the abort path is exercised.
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const controller = new AbortController();

    const download = withProxyDisabled(() =>
      downloadFile(`http://127.0.0.1:${address.port}/file`, target, { signal: controller.signal })
    );
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(download, /abort/i);
  } finally {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('extracts and locates the CLI binary from tar.gz and zip archives', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cx-extract-'));
  try {
    const source = join(root, 'source');
    await mkdir(source, { recursive: true });
    const fakeCli = join(source, 'cx');
    await writeFile(fakeCli, '#!/bin/sh\necho 9.9.9\n', { mode: 0o755 });

    const tarPath = join(root, 'cli.tar.gz');
    await createTar({ file: tarPath, cwd: source, gzip: true }, ['cx']);
    const tarOut = join(root, 'tar-out');
    await mkdir(tarOut);
    await extractCliArchive(tarPath, 'tar.gz', tarOut);
    const tarBinary = await findExtractedBinary(tarOut);
    assert.equal(tarBinary, join(tarOut, 'cx'));

    const zip = new AdmZip();
    zip.addFile('nested/cx.exe', Buffer.from('fake windows cli'));
    const zipPath = join(root, 'cli.zip');
    zip.writeZip(zipPath);
    const zipOut = join(root, 'zip-out');
    await mkdir(zipOut);
    await extractCliArchive(zipPath, 'zip', zipOut);
    const zipBinary = await findExtractedBinary(zipOut);
    assert.ok(zipBinary?.endsWith('cx.exe'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});