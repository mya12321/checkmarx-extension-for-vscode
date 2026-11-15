import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function probeVersion(cliPath: string): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(cliPath, ['version'], {
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });
    const match = `${stdout}\n${stderr}`.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
    return match?.[1];
  } catch {
    return undefined;
  }
}