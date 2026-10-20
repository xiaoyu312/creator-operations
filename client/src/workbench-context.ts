import { createContext, useContext } from 'react';
import type { DomainCommand } from '../../shared/commands.ts';
import type { LocalRoleSelection, SessionResponse } from '../../shared/http.ts';
import type { WorkspaceSnapshot } from '../../shared/types.ts';

export interface WorkbenchContextValue {
  session: SessionResponse;
  workspace: WorkspaceSnapshot;
  running: boolean;
  run: (command: DomainCommand) => Promise<unknown>;
  changeDemoProfile: (principalId: string) => Promise<void>;
  changeLocalRole: (selection: LocalRoleSelection) => Promise<void>;
  refresh: () => Promise<void>;
}

// A leaf module avoids the app -> page -> app cycle during React Fast Refresh.
export const WorkbenchContext = createContext<WorkbenchContextValue | null>(null);

export function useWorkbench(): WorkbenchContextValue {
  const value = useContext(WorkbenchContext);
  if (!value) throw new Error('useWorkbench must be used inside the workbench runtime');
  return value;
}
