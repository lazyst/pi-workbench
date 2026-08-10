// ============================================================================
// OperationManager — lightweight Git operation queue with concurrency control
// ============================================================================
// Ported concept from VS Code extensions/git/src/operation.ts.
// Each cwd has its own OperationManager instance.

export const enum OperationKind {
  Stage = 'stage',
  Unstage = 'unstage',
  Commit = 'commit',
  Clean = 'clean',
  Checkout = 'checkout',
  Branch = 'branch',
  DeleteBranch = 'deleteBranch',
  RenameBranch = 'renameBranch',
  Remote = 'remote',
  Fetch = 'fetch',
  Pull = 'pull',
  Push = 'push',
  Sync = 'sync',
  Status = 'status',
  Log = 'log',
  Diff = 'diff',
  Revert = 'revert',
}

export interface Operation {
  readonly kind: OperationKind;
  /** Whether this operation blocks other commands (commit/push/pull/checkout). */
  readonly blocking: boolean;
  /** Whether this operation is read-only (status/log/diff). */
  readonly readOnly: boolean;
  /** Whether this operation involves a remote (fetch/pull/push/sync). */
  readonly remote: boolean;
  /** Whether to show a progress indicator. */
  readonly showProgress: boolean;
}

export const Operations: Record<OperationKind, Omit<Operation, 'kind'>> = {
  [OperationKind.Stage]:       { blocking: false, readOnly: false, remote: false, showProgress: true },
  [OperationKind.Unstage]:     { blocking: false, readOnly: false, remote: false, showProgress: true },
  [OperationKind.Commit]:      { blocking: true,  readOnly: false, remote: false, showProgress: true },
  [OperationKind.Clean]:       { blocking: false, readOnly: false, remote: false, showProgress: true },
  [OperationKind.Checkout]:    { blocking: true,  readOnly: false, remote: false, showProgress: true },
  [OperationKind.Branch]:      { blocking: false, readOnly: false, remote: false, showProgress: true },
  [OperationKind.DeleteBranch]:{ blocking: false, readOnly: false, remote: false, showProgress: true },
  [OperationKind.RenameBranch]:{ blocking: false, readOnly: false, remote: false, showProgress: true },
  [OperationKind.Remote]:       { blocking: false, readOnly: false, remote: true,  showProgress: true },
  [OperationKind.Fetch]:       { blocking: false, readOnly: false, remote: true,  showProgress: true },
  [OperationKind.Pull]:        { blocking: true,  readOnly: false, remote: true,  showProgress: true },
  [OperationKind.Push]:        { blocking: true,  readOnly: false, remote: true,  showProgress: true },
  [OperationKind.Sync]:        { blocking: true,  readOnly: false, remote: true,  showProgress: true },
  [OperationKind.Status]:      { blocking: false, readOnly: true,  remote: false, showProgress: false },
  [OperationKind.Log]:         { blocking: false, readOnly: true,  remote: false, showProgress: false },
  [OperationKind.Diff]:        { blocking: false, readOnly: true,  remote: false, showProgress: false },
  [OperationKind.Revert]:      { blocking: false, readOnly: false, remote: false, showProgress: true },
};

export class OperationManager {
  private readonly _operations = new Set<Operation>();
  private readonly _listeners = new Set<(ops: Operation[]) => void>();

  /** Start an operation. Returns the operation object. */
  start(kind: OperationKind): Operation {
    const meta = Operations[kind];
    const op: Operation = { kind, ...meta };
    this._operations.add(op);
    this._notify();
    return op;
  }

  /** End an operation. */
  end(op: Operation): void {
    this._operations.delete(op);
    this._notify();
  }

  /** True if no non-readOnly operations are running. */
  isIdle(): boolean {
    for (const op of this._operations) {
      if (!op.readOnly) return false;
    }
    return true;
  }

  /** True if any blocking operation is running — UI should disable commands. */
  shouldDisableCommands(): boolean {
    for (const op of this._operations) {
      if (op.blocking) return true;
    }
    return false;
  }

  /** True if any operation of the given kind is running. */
  isRunning(kind: OperationKind): boolean {
    for (const op of this._operations) {
      if (op.kind === kind) return true;
    }
    return false;
  }

  /** True if any operation with showProgress is running. */
  shouldShowProgress(): boolean {
    for (const op of this._operations) {
      if (op.showProgress) return true;
    }
    return false;
  }

  /** Get all currently running operations. */
  getOperations(): Operation[] {
    return Array.from(this._operations);
  }

  /** Subscribe to operation state changes. Returns unsubscribe function. */
  onChange(cb: (ops: Operation[]) => void): () => void {
    this._listeners.add(cb);
    return () => { this._listeners.delete(cb); };
  }

  private _notify(): void {
    const ops = this.getOperations();
    for (const cb of this._listeners) {
      try { cb(ops); } catch { /* ignore listener errors */ }
    }
  }
}

/** Map of cwd → OperationManager */
const managers = new Map<string, OperationManager>();

/** Get or create an OperationManager for the given cwd. */
export function getOperationManager(cwd: string): OperationManager {
  let m = managers.get(cwd);
  if (!m) {
    m = new OperationManager();
    managers.set(cwd, m);
  }
  return m;
}

/** Remove an OperationManager for a cwd (e.g. when a repo is closed). */
export function removeOperationManager(cwd: string): void {
  managers.delete(cwd);
}