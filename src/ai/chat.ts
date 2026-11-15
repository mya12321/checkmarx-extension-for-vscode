import * as vscode from 'vscode';

export async function openPromptInChat(prompt: string, openChat: boolean): Promise<void> {
  await vscode.env.clipboard.writeText(prompt);

  if (!openChat) {
    void vscode.window.showInformationMessage('Checkmarx AI fix prompt copied to the clipboard.');
    return;
  }

  const attempts: Array<() => Thenable<unknown>> = [
    () => vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt, isPartialQuery: false }),
    () => vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt }),
    () => vscode.commands.executeCommand('workbench.action.chat.open', prompt)
  ];

  for (const attempt of attempts) {
    try {
      await attempt();
      void vscode.window.showInformationMessage('Checkmarx AI fix prompt opened in chat and copied to the clipboard.');
      return;
    } catch {
      // Try the next supported command shape.
    }
  }

  void vscode.window.showInformationMessage(
    'The AI fix prompt was copied to the clipboard. Open your AI chat and paste it to start the fix.'
  );
}