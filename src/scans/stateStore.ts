import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { hashContent } from '../paths';
import type { PersistedState } from '../types';

export interface StateStoreLike {
  load(): Promise<PersistedState | undefined>;
  save(state: PersistedState): Promise<void>;
}

export class FileStateStore implements StateStoreLike {
  private readonly stateFile: string;

  constructor(
    private readonly storageRoot: string,
    workspaceRoot: string
  ) {
    this.stateFile = path.join(storageRoot, `state-${hashContent(workspaceRoot).slice(0, 16)}.json`);
  }

  async load(): Promise<PersistedState | undefined> {
    try {
      const content = await readFile(this.stateFile, 'utf8');
      const parsed = JSON.parse(content) as PersistedState;
      if (parsed.version !== 1 || !parsed.sources) {
        return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  async save(state: PersistedState): Promise<void> {
    await mkdir(this.storageRoot, { recursive: true });
    const temporary = `${this.stateFile}.tmp-${process.pid}`;
    await writeFile(temporary, JSON.stringify(state), 'utf8');
    try {
      await rename(temporary, this.stateFile);
    } catch (error) {
      try {
        await rm(this.stateFile, { force: true });
        await rename(temporary, this.stateFile);
      } catch {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    }
  }
}

export interface BridgeInfo {
  url: string;
  token: string;
  pid: number;
  version: string;
  workspace: string;
  startedAt: string;
}

export async function writeBridgeInfo(storageRoot: string, info: BridgeInfo): Promise<string> {
  await mkdir(storageRoot, { recursive: true });
  const file = bridgeInfoPath(storageRoot, info.workspace);
  await writeFile(file, JSON.stringify(info, null, 2), { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') {
    await chmod(file, 0o600).catch(() => undefined);
  }
  return file;
}

export async function removeBridgeInfo(storageRoot: string, workspace: string): Promise<void> {
  await rm(bridgeInfoPath(storageRoot, workspace), { force: true });
}

export function bridgeInfoPath(storageRoot: string, workspace: string): string {
  return path.join(storageRoot, `mcp-bridge-${hashContent(workspace).slice(0, 16)}.json`);
}