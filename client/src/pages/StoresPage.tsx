import { useMemo, useState, type FormEvent } from 'react';
import '../operations-surfaces.css';
import { toast } from 'sonner';
import { Plus, Search, Store as StoreIcon } from 'lucide-react';
import type { ManualStore } from '@shared/types';
import { useWorkbench } from '../workbench-context';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { EmptyState, FormField, Modal, PageHeading, Panel, StatusPill } from '../components/workbench';

export default function StoresPage() {
  const { workspace, session } = useWorkbench();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<ManualStore | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const canManage = session.actor.role === 'manager' || session.actor.role === 'admin';
  const authorizedTeams = workspace.teams.filter((team) => workspace.scope.teamIds.includes(team.id));
  const canChooseTeam = session.actor.role === 'admin' && authorizedTeams.length > 1;
  const defaultTeamId = authorizedTeams.find((team) => team.id === session.actor.teamId)?.id ?? authorizedTeams[0]?.id ?? session.actor.teamId;
  const stores = useMemo(() => workspace.manualStores.filter((store) => {
    const text = `${store.name} ${store.externalShopId} ${store.note ?? ''}`.toLowerCase();
    return !query.trim() || text.includes(query.trim().toLowerCase());
  }).sort((a, b) => a.name.localeCompare(b.name)), [workspace.manualStores, query]);

  return <div className="page-stack ops-page ops-page--stores">
    <PageHeading title="店铺资料" actions={canManage && <Button onClick={() => setCreateOpen(true)}><Plus size={15} />新增店铺资料</Button>} />
    <Panel title="店铺列表" description="维护店铺名称、平台 ID 和备注。">
      <div className="toolbar"><label className="search-field"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索店铺名称或 ID" aria-label="搜索店铺资料" /></label><span className="toolbar-spacer" /><span className="table-result-count">{stores.length} 家</span></div>
      {stores.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>店铺</th>{authorizedTeams.length > 1 && <th>所属团队</th>}<th>平台 / 店铺 ID</th><th>状态</th><th>备注</th>{canManage && <th className="text-right">操作</th>}</tr></thead><tbody>{stores.map((store) => <tr key={store.id}>
        <td><span className="table-primary">{store.name}</span></td>
        {authorizedTeams.length > 1 && <td>{workspace.teams.find((team) => team.id === store.teamId)?.name ?? '—'}</td>}
        <td>抖音<span className="table-secondary">{store.externalShopId}</span></td>
        <td><StatusPill value={store.active ? 'active' : 'inactive'} label={store.active ? '使用中' : '已停用'} tone={store.active ? 'green' : 'neutral'} /></td>
        <td>{store.note || '—'}</td>
        {canManage && <td className="table-action-cell"><Button variant="outline" size="sm" className="small-button" onClick={() => setEditing(store)}>编辑</Button></td>}
      </tr>)}</tbody></table></div> : <EmptyState title={query ? '没有匹配店铺' : '还没有店铺资料'} description={query ? '调整搜索词。' : '登记店铺名称和平台 ID。'} icon={<StoreIcon size={21} />} action={canManage && !query && <Button size="sm" onClick={() => setCreateOpen(true)}><Plus size={14} />新增店铺资料</Button>} />}
    </Panel>
    <ManualStoreDialog open={createOpen} onOpenChange={setCreateOpen} teams={canChooseTeam ? authorizedTeams : []} defaultTeamId={defaultTeamId} />
    {editing && <ManualStoreDialog store={editing} open onOpenChange={(open) => { if (!open) setEditing(null); }} teams={[]} defaultTeamId={defaultTeamId} />}
  </div>;
}

function ManualStoreDialog({ store, open, onOpenChange, teams, defaultTeamId }: { store?: ManualStore; open: boolean; onOpenChange: (open: boolean) => void; teams: Array<{ id: string; name: string }>; defaultTeamId: string }) {
  const { run, running, refresh } = useWorkbench();
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    const form = new FormData(event.currentTarget);
    try {
      if (store) {
        await run({ type: 'store.update', storeId: store.id, expectedVersion: store.version, name: String(form.get('name') ?? ''), note: String(form.get('note') ?? '') || null, active: form.get('active') === 'on' });
        toast.success('店铺资料已更新');
      } else {
        await run({ type: 'store.create', teamId: String(form.get('teamId') ?? '') || defaultTeamId, platform: 'douyin', externalShopId: String(form.get('externalShopId') ?? ''), name: String(form.get('name') ?? ''), note: String(form.get('note') ?? '') || null });
        toast.success('店铺资料已登记');
      }
      await refresh(); onOpenChange(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败'); }
  }
  return <Modal open={open} onOpenChange={onOpenChange} title={store ? '编辑店铺资料' : '新增店铺资料'}>
    <form className="modal-form" onSubmit={submit}>
      <div className="form-grid">
        <FormField label="平台"><Input value="抖音" readOnly /></FormField>
        <FormField label="店铺名称" required><Input name="name" required defaultValue={store?.name ?? ''} /></FormField>
        {!store && <FormField label="店铺 ID" required><Input name="externalShopId" required /></FormField>}
        {!store && teams.length > 1 && <FormField label="所属团队" required><select className="native-select" name="teamId" defaultValue={defaultTeamId} required>{teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></FormField>}
        <FormField label="业务备注" className="span-2"><Textarea name="note" rows={3} defaultValue={store?.note ?? ''} placeholder="例如：日常经营负责人或内部识别说明" /></FormField>
      </div>
      {store && <label className="check-row"><input type="checkbox" name="active" defaultChecked={store.active} />允许用于后续业务记录</label>}
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="modal-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={running}>{running ? '保存中…' : store ? '保存资料' : '登记店铺'}</Button></div>
    </form>
  </Modal>;
}
