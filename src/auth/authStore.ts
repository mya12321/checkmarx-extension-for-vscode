import * as vscode from 'vscode';
import { CONFIG_SECTION, updateSetting, type SettingsLike } from '../config';
import type { AuthConfig } from '../types';

export const API_KEY_SECRET = 'checkmarxLocal.apiKey';

export interface AuthStoreLike {
  get(): Promise<AuthConfig | undefined>;
  isSignedIn(): Promise<boolean>;
}

interface Region {
  label: string;
  description: string;
  baseUri: string;
  baseAuthUri: string;
}

const REGIONS: Region[] = [
  {
    label: 'Checkmarx One US',
    description: 'ast.checkmarx.net',
    baseUri: 'https://ast.checkmarx.net',
    baseAuthUri: 'https://iam.checkmarx.net'
  },
  {
    label: 'Checkmarx One EU',
    description: 'eu.ast.checkmarx.net',
    baseUri: 'https://eu.ast.checkmarx.net',
    baseAuthUri: 'https://eu.iam.checkmarx.net'
  },
  {
    label: 'Custom / On-premises',
    description: 'Enter your own Checkmarx One and IAM URLs',
    baseUri: '',
    baseAuthUri: ''
  }
];

export class AuthStore implements AuthStoreLike {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly settings: SettingsLike
  ) {}

  async get(): Promise<AuthConfig | undefined> {
    const storedKey = (await this.context.secrets.get(API_KEY_SECRET))?.trim();
    const environmentKey = process.env.CX_APIKEY?.trim();
    const apiKey = storedKey || environmentKey;
    if (!apiKey) {
      return undefined;
    }
    const snapshot = this.settings.load();
    return {
      apiKey,
      baseUri: snapshot.baseUri || process.env.CX_BASE_URI?.trim() || '',
      baseAuthUri: snapshot.baseAuthUri || process.env.CX_BASE_AUTH_URI?.trim() || undefined,
      tenant: snapshot.tenant || process.env.CX_TENANT?.trim() || undefined
    };
  }

  async isSignedIn(): Promise<boolean> {
    return Boolean((await this.context.secrets.get(API_KEY_SECRET))?.trim() || process.env.CX_APIKEY?.trim());
  }

  async login(validate: (auth: AuthConfig) => Promise<void>): Promise<boolean> {
    const snapshot = this.settings.load();
    const regionPick = await vscode.window.showQuickPick(
      REGIONS.map((region) => ({
        label: region.label,
        description: region.description,
        region
      })),
      {
        title: 'Checkmarx: Sign In',
        placeHolder: 'Select your Checkmarx One region',
        ignoreFocusOut: true
      }
    );
    if (!regionPick) {
      return false;
    }

    const region = regionPick.region;
    let baseUri = region.baseUri || snapshot.baseUri;
    let baseAuthUri = region.baseAuthUri || snapshot.baseAuthUri;

    if (region.baseUri === '') {
      const enteredBase = await vscode.window.showInputBox({
        title: 'Checkmarx One base URI',
        prompt: 'For example https://ast.checkmarx.net or your on-premises host',
        value: baseUri,
        ignoreFocusOut: true,
        validateInput: (value) => (isHttpUrl(value) ? undefined : 'Enter a valid http(s) URL')
      });
      if (!enteredBase) {
        return false;
      }
      baseUri = enteredBase.trim().replace(/\/+$/, '');
    }

    const enteredAuth = await vscode.window.showInputBox({
      title: 'Checkmarx IAM base URI (optional)',
      prompt: 'Leave empty to let the CLI derive it from the base URI',
      value: baseAuthUri,
      ignoreFocusOut: true,
      validateInput: (value) => (!value || isHttpUrl(value) ? undefined : 'Enter a valid http(s) URL, or leave empty')
    });
    if (enteredAuth === undefined) {
      return false;
    }
    baseAuthUri = enteredAuth.trim().replace(/\/+$/, '');

    const tenant = await vscode.window.showInputBox({
      title: 'Checkmarx tenant',
      prompt: 'Your Checkmarx One tenant name',
      value: snapshot.tenant,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : 'Tenant is required')
    });
    if (tenant === undefined) {
      return false;
    }

    const apiKey = await vscode.window.showInputBox({
      title: 'Checkmarx API key',
      prompt: 'The key is stored in VS Code SecretStorage and passed to the CLI through an environment variable',
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : 'API key is required')
    });
    if (apiKey === undefined) {
      return false;
    }

    const auth: AuthConfig = {
      apiKey: apiKey.trim(),
      baseUri: baseUri.trim(),
      baseAuthUri: baseAuthUri || undefined,
      tenant: tenant.trim()
    };

    const shouldSave = await this.validateWithRetry(auth, validate);
    if (!shouldSave) {
      return false;
    }

    await this.save(auth);
    return true;
  }

  async save(auth: AuthConfig): Promise<void> {
    await updateSetting('baseUri', auth.baseUri);
    await updateSetting('baseAuthUri', auth.baseAuthUri ?? '');
    await updateSetting('tenant', auth.tenant ?? '');
    await this.context.secrets.store(API_KEY_SECRET, auth.apiKey);
  }

  async logout(): Promise<void> {
    await this.context.secrets.delete(API_KEY_SECRET);
  }

  private async validateWithRetry(auth: AuthConfig, validate: (auth: AuthConfig) => Promise<void>): Promise<boolean> {
    for (;;) {
      const choice = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Checkmarx: validating API key…',
          cancellable: false
        },
        async () => {
          try {
            await validate(auth);
            return 'ok' as const;
          } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) } as const;
          }
        }
      );

      if (choice === 'ok') {
        void vscode.window.showInformationMessage(`Signed in to Checkmarx tenant "${auth.tenant}".`);
        return true;
      }

      const action = await vscode.window.showErrorMessage(
        `Checkmarx authentication failed: ${choice.error}`,
        { modal: false },
        'Retry',
        'Save anyway',
        'Cancel'
      );
      if (action === 'Retry') {
        continue;
      }
      if (action === 'Save anyway') {
        void vscode.window.showWarningMessage(
          'Checkmarx credentials were saved without validation. Cloud scans will fail until the key and URLs are valid; local ASCA scans do not require the API key.'
        );
        return true;
      }
      return false;
    }
  }
}

function isHttpUrl(value: string): boolean {
  if (!value.trim()) {
    return false;
  }
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export function authConfigurationLink(): string {
  return `command:workbench.action.openSettings?${encodeURIComponent(`@ext:checkmarx-local.checkmarx-local ${CONFIG_SECTION}`)}`;
}