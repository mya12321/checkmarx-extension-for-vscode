import { normalizeSlashes } from '../paths';

export interface CloudScanArgOptions {
  root: string;
  projectName: string;
  applicationName?: string;
  branch: string;
  scanTypes: string[];
  fileFilter?: string;
  /** Strip every `.git` directory from the uploaded source zip. */
  excludeGitFolder?: boolean;
  /**
   * Ant-style exclusions (`!path`) passed through `--file-filter-ext`. The
   * extension computes these from every `.gitignore` in the tree, because the
   * CLI's own `--use-gitignore` only reads the root file and matches basenames.
   */
  fileFilterExt?: string[];
  extraArgs?: string[];
}

/**
 * Build `cx scan create` arguments.
 *
 * Global authentication values are passed through environment variables, never
 * through argv, so API keys cannot leak into process listings or logs.
 */
export function cloudScanCreateArgs(options: CloudScanArgOptions): string[] {
  const args = [
    'scan',
    'create',
    '-s',
    options.root,
    '--project-name',
    options.projectName,
    ...(options.applicationName ? ['--application-name', options.applicationName] : []),
    '--branch',
    options.branch,
    '--scan-types',
    options.scanTypes.join(','),
    '--async',
    '--scan-info-format',
    'json'
  ];

  if (options.excludeGitFolder) {
    args.push('--exclude-git-folder');
  }

  for (const pattern of options.fileFilterExt ?? []) {
    args.push('--file-filter-ext', pattern);
  }

  if (options.fileFilter) {
    args.push('--file-filter', normalizeSlashes(options.fileFilter));
  }

  if (options.extraArgs?.length) {
    args.push(...options.extraArgs);
  }

  return args;
}

export function cloudScanShowArgs(scanId: string, extraArgs?: string[]): string[] {
  return ['scan', 'show', '--scan-id', scanId, '--format', 'json', ...(extraArgs ?? [])];
}

export function cloudResultsArgs(scanId: string, outputPath: string, outputName: string, extraArgs?: string[]): string[] {
  return [
    'results',
    'show',
    '--scan-id',
    scanId,
    '--report-format',
    'json',
    '--output-path',
    outputPath,
    '--output-name',
    outputName,
    ...(extraArgs ?? [])
  ];
}

export function cloudCancelArgs(scanId: string, extraArgs?: string[]): string[] {
  return ['scan', 'cancel', '--scan-id', scanId, ...(extraArgs ?? [])];
}

/**
 * Build `cx scan asca` arguments.
 *
 * Note: `--agent` is intentionally not set for local scans. The CLI's default
 * invocation performs the local scan without an IDE-agent entitlement check;
 * setting an IDE agent unconditionally would make the CLI require the
 * Checkmarx One Assist / Developer Assist entitlement even though the scan runs
 * entirely on this machine. Cloud scans still identify themselves as VS Code.
 */
export function ascaScanArgs(file: string, extraArgs?: string[]): string[] {
  return ['scan', 'asca', '-s', file, ...(extraArgs ?? [])];
}

export function authValidateArgs(extraArgs?: string[]): string[] {
  return ['auth', 'validate', ...(extraArgs ?? [])];
}

export function versionArgs(): string[] {
  return ['version'];
}