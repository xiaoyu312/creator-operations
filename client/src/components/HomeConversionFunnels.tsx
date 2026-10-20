import type { Role } from '@shared/types';
import { HelpTip } from './workbench';
import { formatHomeFunnelCount, formatHomeFunnelRate, homeFunnelBarWidths, homeFunnelHasActivity, showHomeCreatorFunnel, type HomeFunnelRate, type HomeFunnelStage, type HomeFunnels } from '../lib/home-funnel';
import './home-conversion.css';

export function HomeConversionFunnels({ funnels, periodLabel, role }: { funnels: HomeFunnels; periodLabel: string; role: Role }) {
  const showCreators = showHomeCreatorFunnel(role, funnels.creators.stages);
  const showSamples = homeFunnelHasActivity(funnels.samples.stages) || showCreators;
  const bothIdle = !homeFunnelHasActivity(funnels.creators.stages) && !homeFunnelHasActivity(funnels.samples.stages);
  return <section className="home-section home-conversion" aria-labelledby="home-conversion-title">
    <div className="home-section-head">
      <h2 className="home-section-title" id="home-conversion-title">转化怎么样</h2>
    </div>
    {bothIdle ? <div className="home-conversion-idle">
      <p>当前范围没有达人或寄样转化记录。</p>
      <span>新增达人或提交寄样后，这里会显示各阶段数量和转化率。</span>
    </div> : <div className="home-conversion-grid">
      {showCreators && <FunnelCard
        title={funnels.creators.title}
        periodLabel={periodLabel}
        help="从当前在管的达人看这一周期。出单只数交付之后又有已支付订单的人，和上面的出单达人不是同一批。"
        overall={funnels.creators.overall}
        overallLabel={funnels.creators.overallLabel}
        overallNote={funnels.creators.overallNote}
        stages={funnels.creators.stages}
        rates={funnels.creators.rates}
      />}
      {showSamples && homeFunnelHasActivity(funnels.samples.stages) && <FunnelCard
        title={funnels.samples.title}
        periodLabel={periodLabel}
        help="这一周期的寄样申请里，发出去多少、这些达人交付了多少、带来多少已支付订单。出单不是申样的子集时，总转化率留空。"
        overall={funnels.samples.overall}
        overallLabel={funnels.samples.overallLabel}
        overallNote={funnels.samples.overallNote}
        stages={funnels.samples.stages}
        rates={funnels.samples.rates}
      />}
    </div>}
  </section>;
}

function FunnelCard({ title, periodLabel, help, overall, overallLabel, overallNote, stages, rates }: {
  title: string;
  periodLabel: string;
  help: string;
  overall: number | null;
  overallLabel: string;
  overallNote: string | null;
  stages: HomeFunnelStage[];
  rates: HomeFunnelRate[];
}) {
  const titleId = `home-conversion-${title}`;
  const widths = homeFunnelBarWidths(stages);
  const idle = !homeFunnelHasActivity(stages);
  let row = 1;
  const placed = stages.map((stage, index) => {
    const stageRow = row;
    row += 1;
    const rate = rates[index];
    const rateRow = rate ? row : null;
    if (rate) row += 1;
    return { stage, index, stageRow, rate, rateRow, width: widths[index] ?? 0 };
  });
  const overallText = formatHomeFunnelRate(overall);
  return <article className="home-card home-conversion-card" aria-labelledby={titleId}>
    <div className="home-card-head">
      <h3 id={titleId}>{title}<HelpTip text={help} label={title} /></h3>
      <p className="home-conversion-period">{periodLabel}</p>
    </div>
    {idle ? <div className="home-conversion-idle">
      <p>当前范围没有可统计的「{title}」记录。</p>
      <span>有记录后，这里会显示各阶段数量和转化率。</span>
    </div> : <div className="home-conversion-chart" style={{ gridTemplateRows: `repeat(${row - 1}, auto)` }}>
      <div className="home-conversion-overall" style={{ gridRow: `1 / span ${row - 1}` }}>
        <span className="home-conversion-brace" aria-hidden="true" />
        <span className="home-conversion-overall-kicker">总转化率</span>
        <strong aria-label={`总转化率 ${overallLabel} ${overallText}`}>{overallText}</strong>
        <small>{overallLabel}</small>
      </div>
      {placed.map(({ stage, index, stageRow, rate, rateRow, width }) => (
        <FunnelRows key={stage.key} stage={stage} stageRow={stageRow} rate={rate} rateRow={rateRow} tone={barTone(index, stages.length)} width={width} />
      ))}
      {overallNote ? <p className="home-conversion-overall-note">{overallNote}</p> : null}
    </div>}
  </article>;
}

function FunnelRows({ stage, stageRow, rate, rateRow, tone, width }: {
  stage: HomeFunnelStage;
  stageRow: number;
  rate: HomeFunnelRate | undefined;
  rateRow: number | null;
  tone: { background: string; color: string };
  width: number;
}) {
  const zero = stage.count === null || stage.count === 0;
  const labelOutside = zero || width < 28;
  const copy = <span className="home-conversion-bar-copy">
    <span className="home-conversion-bar-line"><strong>{formatHomeFunnelCount(stage.count)}</strong><span>{stage.label}</span></span>
    {stage.hint ? <small>{stage.hint}</small> : null}
  </span>;
  return <>
    <div className="home-conversion-stage" style={{ gridRow: stageRow }}>
      <div className={`home-conversion-bar-row${labelOutside ? ' is-empty' : ''}`}>
        <div
          className={`home-conversion-bar${zero ? ' is-empty' : ''}`}
          style={zero ? undefined : { width: `${Math.max(width, 4)}%`, background: tone.background, color: tone.color }}
        >
          {labelOutside ? null : copy}
        </div>
        {labelOutside ? copy : null}
      </div>
    </div>
    {rate && rateRow ? <p className="home-conversion-rate" style={{ gridRow: rateRow }}>
      <span>{rate.label}</span>
      <strong>{formatHomeFunnelRate(rate.value)}</strong>
    </p> : null}
  </>;
}

function barTone(index: number, total: number) {
  const mix = total <= 1 ? 72 : Math.round(46 + (40 * index) / (total - 1));
  return {
    background: `color-mix(in srgb, var(--reference-primary) ${mix}%, white)`,
    color: mix >= 70 ? '#ffffff' : '#1c2740',
  };
}
