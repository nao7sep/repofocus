export interface NativeVisibilityCommandExecutorOptions {
  readonly execute: (command: string) => Promise<void>;
}

/**
 * The single path for VS Code's native visibility and selection-mode commands,
 * which flip state RepoFocus cannot read back. Only the mapping coordinator's
 * drain issues them, so they run one at a time, each awaited to its end: VS Code
 * cannot cancel a command, and a deadline here would leave one running beside
 * the next.
 */
export class NativeVisibilityCommandExecutor {
  private disposed = false;

  constructor(private readonly options: NativeVisibilityCommandExecutorOptions) {}

  async execute(command: string): Promise<void> {
    if (this.disposed) throw new Error('Native visibility command executor is disposed.');
    await this.options.execute(command);
  }

  dispose(): void {
    this.disposed = true;
  }
}
