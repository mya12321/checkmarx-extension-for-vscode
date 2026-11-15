import * as vscode from 'vscode';
import { redactSecrets, type LoggerLike } from './logging';

export class Logger implements LoggerLike, vscode.Disposable {
  private readonly channel: vscode.OutputChannel;

  constructor(name = 'Checkmarx Local') {
    this.channel = vscode.window.createOutputChannel(name);
  }

  info(message: string): void {
    this.channel.appendLine(`[${timestamp()}] ${redactSecrets(message)}`);
  }

  warn(message: string): void {
    this.channel.appendLine(`[${timestamp()}] WARN ${redactSecrets(message)}`);
  }

  error(message: string): void {
    this.channel.appendLine(`[${timestamp()}] ERROR ${redactSecrets(message)}`);
  }

  debug(message: string): void {
    this.channel.appendLine(`[${timestamp()}] DEBUG ${redactSecrets(message)}`);
  }

  show(preserveFocus = true): void {
    this.channel.show(preserveFocus);
  }

  dispose(): void {
    this.channel.dispose();
  }
}

function timestamp(): string {
  return new Date().toISOString();
}