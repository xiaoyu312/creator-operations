import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Settings2 } from 'lucide-react';
import type { LocalRoleSelection } from '@shared/http';
import type { LocalWorkbookActor } from '@shared/workbook';
import { useWorkbench } from '../workbench-context';
import { canPreviewLocalRole } from '../lib/workbook-context';
import { Button } from './ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from './ui/sheet';

type LocalRole = LocalWorkbookActor['role'];

const roleLabels: Record<LocalRole, string> = {
  local_manager: '管理岗',
  local_bd: '商务',
  local_shipping: '发货',
  local_links: '链接',
};

export default function LocalRoleSwitcher() {
  const { session, changeLocalRole, running } = useWorkbench();
  const profile = session.localWorkbook ?? (session.businessWorkspace?.storage === 'local' ? session.workbook : undefined);
  const [open, setOpen] = useState(false);
  const [targetRole, setTargetRole] = useState<LocalRole>(profile?.role ?? 'local_manager');
  const [targetOwner, setTargetOwner] = useState(profile?.businessOwnerName ?? '');
  const [error, setError] = useState('');
  const businessOwners = useMemo(() => [...new Set([
    ...(profile?.availableBusinessOwners ?? []),
    ...(profile?.businessOwnerName ? [profile.businessOwnerName] : []),
  ])].sort((left, right) => left.localeCompare(right)), [profile?.availableBusinessOwners, profile?.businessOwnerName]);

  useEffect(() => {
    setTargetRole(profile?.role ?? 'local_manager');
    setTargetOwner(profile?.businessOwnerName ?? '');
    setError('');
  }, [profile?.role, profile?.businessOwnerName]);

  if (!canPreviewLocalRole(session) || !profile) return null;

  const currentLabel = roleLabels[profile.role] ?? '本地岗位';
  const hasChanges = targetRole !== profile.role || (targetRole === 'local_bd' && targetOwner !== (profile.businessOwnerName ?? ''));
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    if (targetRole === 'local_bd' && !targetOwner.trim()) { setError('请选择商务。'); return; }
    const selection: LocalRoleSelection = {
      role: targetRole,
      ...(targetRole === 'local_bd' ? { businessOwnerName: targetOwner.trim() } : {}),
    };
    try {
      await changeLocalRole(selection);
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '切换失败，请重试。');
    }
  }

  return <Sheet open={open} onOpenChange={setOpen}>
    <SheetTrigger asChild><Button variant="outline" size="sm" className="local-role-preview-trigger" aria-label={`切换角色，当前${currentLabel}`}><Settings2 size={14} /><span>{currentLabel}</span></Button></SheetTrigger>
    <SheetContent side="right" className="local-role-preview-sheet">
      <div className="local-role-preview-heading"><SheetTitle>切换角色</SheetTitle><SheetDescription>选择要查看的角色。</SheetDescription></div>
      <form className="local-role-preview-form" onSubmit={submit}>
        <label><span>角色</span><select className="native-select" value={targetRole} onChange={(event) => {
          const nextRole = event.target.value as LocalRole;
          setTargetRole(nextRole);
          if (nextRole === 'local_bd' && !targetOwner && businessOwners[0]) setTargetOwner(businessOwners[0]);
        }}><option value="local_manager">管理岗</option><option value="local_bd">商务</option><option value="local_shipping">发货</option><option value="local_links">链接</option></select></label>
        {targetRole === 'local_bd' && <label><span>商务成员</span><select className="native-select" value={targetOwner} onChange={(event) => setTargetOwner(event.target.value)} required><option value="">选择商务</option>{businessOwners.map((owner) => <option value={owner} key={owner}>{owner}</option>)}</select></label>}
        {error && <p className="field-error" role="alert">{error}</p>}
        <div className="modal-actions"><Button type="submit" disabled={running || !hasChanges || (targetRole === 'local_bd' && !targetOwner.trim())}>{running ? '切换中…' : '切换角色'}</Button></div>
      </form>
    </SheetContent>
  </Sheet>;
}
