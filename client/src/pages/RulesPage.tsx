import { BookOpenCheck } from 'lucide-react';
import '../operations-surfaces.css';
import { useWorkbench } from '../workbench-context';
import { PageHeading, Panel } from '../components/workbench';

export default function RulesPage() {
  const { workspace } = useWorkbench();
  const ruleNotes = workspace.businessRuleNotes;

  return <div className="page-stack ops-page ops-page--rules">
    <PageHeading title="业务规则" description="查看订单归属和处理时限。" />
    <div className="rule-card-grid">{ruleNotes.map((note) => <Panel key={note.id} title={note.title} description={note.id === 'paid_at_owner' ? '订单归属规则。' : '处理时限。'}><div className="rule-card-content"><BookOpenCheck size={18} /><div><p>{note.id === 'paid_at_owner' ? note.body.replace('人工更正须保留原因和审计。', '人工更正须说明原因并保留记录。') : note.body}</p></div></div></Panel>)}</div>
  </div>;
}
