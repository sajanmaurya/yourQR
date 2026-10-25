import React, { useEffect, useState } from 'react';
import { Activity, ArrowDownLeft, ArrowUpRight, BarChart3, CalendarDays, ChevronRight, Globe2, Link2, Monitor, MousePointer2, RefreshCw, Smartphone, Users } from 'lucide-react';
import { api, dateLabel, formatNumber } from './api.js';
import { EmptyChart, InlineError, Select, Spinner } from './components.jsx';

export default function Analytics({ qrs, initialQrId = '', refreshKey = 0, onCreate }) {
  const [qrId, setQrId] = useState(initialQrId);
  const [days, setDays] = useState('30');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => { setQrId(initialQrId); }, [initialQrId]);
  useEffect(() => {
    let cancelled = false; setLoading(true); setError('');
    api(`/analytics?days=${days}${qrId ? `&qrId=${encodeURIComponent(qrId)}` : ''}`).then(result => { if (!cancelled) setData(result); }).catch(err => { if (!cancelled) setError(err.message); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [qrId, days, refreshKey, retry]);
  const dynamic = qrs.filter(qr => qr.type === 'dynamic');
  return <>
    <div className="page-heading"><div><span className="eyebrow">A LITTLE INSIGHT</span><h1>Every scan tells a story<span className="heading-dot">.</span></h1><p>See where your connections are taking you.</p></div><button type="button" className="button secondary" onClick={() => setRetry(value => value + 1)} disabled={loading}><RefreshCw size={16} className={loading ? 'spin' : ''} />Refresh</button></div>
    <div className="analytics-toolbar"><div className="period-label"><CalendarDays size={17} />Overview</div><div className="button-row"><Select aria-label="Filter analytics by QR code" value={qrId} onChange={event => setQrId(event.target.value)}><option value="">All dynamic codes</option>{dynamic.map(qr => <option key={qr.id} value={qr.id}>{qr.name}</option>)}</Select><Select aria-label="Analytics date range" value={days} onChange={event => setDays(event.target.value)}><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option></Select></div></div>
    <InlineError>{error}</InlineError>
    {!data && loading ? <div className="page-loading"><Spinner text="Gathering your insights…" /></div> : data && <>
      <div className="stats-grid analytics-stats"><Stat title="Redirect visits" value={data.totalScans} note={`In the last ${days} days`} icon={MousePointer2} /><Stat title="Daily-unique visits" value={data.uniqueVisitors} note="Approximate · summed by day" icon={Users} /><Stat title="Dynamic codes" value={data.dynamicCount ?? dynamic.length} note="Links you can keep evolving" icon={RefreshCw} /><Stat title="Static codes" value={data.staticCount ?? qrs.filter(qr => qr.type === 'static').length} note="Direct content · no tracking" icon={Link2} /></div>
      <section className="panel chart-panel"><div className="panel-heading"><div><h2>Scans over time</h2><p>Visits to your dynamic redirect links</p></div><span className="chart-legend"><i />Redirect visits</span></div>{data.series?.some(point => point.scans > 0) ? <ScanChart series={data.series} /> : <EmptyChart />}</section>
      <div className="analytics-two-col"><section className="panel"><div className="panel-heading"><div><h2>Devices</h2><p>A glimpse at how people arrive</p></div><Monitor size={19} className="muted" /></div><Breakdown rows={data.devices || []} icon="device" total={data.totalScans} empty="Device types will appear after your first visit." /></section><section className="panel"><div className="panel-heading"><div><h2>Referrers</h2><p>Where your visitors come from</p></div><Globe2 size={19} className="muted" /></div><Breakdown rows={data.referrers || []} total={data.totalScans} empty="Referring sites will appear when available." /></section></div>
      <section className="panel activity-panel"><div className="panel-heading"><div><h2>Recent activity</h2><p>The latest visits across your workspace</p></div><Activity size={19} className="muted" /></div>{data.recent?.length ? <div className="table-scroll"><table className="activity-table"><thead><tr><th>QR code</th><th>Device</th><th>Referrer</th><th>Time</th></tr></thead><tbody>{data.recent.map((visit, index) => <tr key={visit.id || `${visit.scannedAt}-${index}`}><td><span className="table-code-icon"><ArrowDownLeft size={16} /></span>{visit.qrName || 'QR code'}</td><td>{visit.device}</td><td>{visit.referrer || 'Direct / unknown'}</td><td className="muted">{dateLabel(visit.scannedAt)} · {new Date(visit.scannedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</td></tr>)}</tbody></table></div> : <div className="empty-inline"><span className="empty-mini-icon"><Activity size={23} /></span><h3>Your next visit will land here</h3><p>Share a dynamic QR code, then check back.</p>{!dynamic.length && <button className="text-button" onClick={onCreate}>Create your first dynamic code<ArrowUpRight size={15} /></button>}</div>}</section>
      <p className="analytics-disclaimer"><ShieldNote />Analytics count requests to dynamic short links, including repeat visits and possible bots. Daily-unique visits use a privacy-preserving identifier that resets each day. Static QR scans cannot be measured here. Dates are grouped in UTC.</p>
    </>}
  </>;
}

export function Stat({ title, value, note, icon: Icon }) { return <section className="stat-card"><div className="stat-top"><span>{title}</span><span className="stat-icon"><Icon size={18} /></span></div><strong>{formatNumber(value || 0)}</strong><small>{note}</small></section>; }
function ShieldNote() { return <span className="note-dot" aria-hidden="true">i</span>; }

function Breakdown({ rows, total, empty, icon }) {
  if (!rows.length) return <div className="breakdown-empty"><span className="empty-mini-icon">{icon === 'device' ? <Monitor size={22} /> : <Globe2 size={22} />}</span><p>{empty}</p></div>;
  return <div className="breakdown-list">{rows.map(row => { const percentage = total ? Math.round(row.count / total * 100) : 0; return <div className="breakdown-row" key={row.name}><div><span>{icon === 'device' && (/mobile|tablet/i.test(row.name) ? <Smartphone size={15} /> : <Monitor size={15} />)}{row.name || 'Direct / unknown'}</span><strong>{formatNumber(row.count)}<small>{percentage}%</small></strong></div><span className="breakdown-track"><i style={{ width: `${percentage}%` }} /></span></div>; })}</div>;
}

function ScanChart({ series }) {
  const width = 960, height = 240, padX = 46, padY = 22;
  const max = Math.max(1, ...series.map(point => point.scans));
  const roundedMax = Math.max(4, Math.ceil(max / 4) * 4);
  const points = series.map((point, index) => [padX + index / Math.max(1, series.length - 1) * (width - padX - 15), height - padY - point.scans / roundedMax * (height - padY * 2)]);
  const path = points.map(([x, y], index) => `${index ? 'L' : 'M'}${x},${y}`).join(' ');
  const labelIndices = [...new Set([0, Math.floor((series.length - 1) / 4), Math.floor((series.length - 1) / 2), Math.floor((series.length - 1) * .75), series.length - 1])];
  return <div className="scan-chart"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Scan chart: ${series.reduce((sum, point) => sum + point.scans, 0)} visits over ${series.length} days`}>
    <defs><linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#2c886b" stopOpacity=".2" /><stop offset="100%" stopColor="#2c886b" stopOpacity=".015" /></linearGradient></defs>
    {[0, 1, 2, 3, 4].map(index => { const y = height - padY - index / 4 * (height - padY * 2); return <g key={index}><line x1={padX} y1={y} x2={width - 15} y2={y} stroke="#e8ece8" strokeDasharray="4 5" /><text x="27" y={y + 4} textAnchor="end" fill="#839087" fontSize="11">{roundedMax * index / 4}</text></g>; })}
    <path d={`${path} L${points.at(-1)[0]},${height - padY} L${padX},${height - padY} Z`} fill="url(#chartFill)" /><path d={path} stroke="#2c886b" fill="none" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
    {points.map(([x, y], index) => <circle key={index} cx={x} cy={y} r={series[index].scans ? 3 : 1.5} fill="#2c886b"><title>{dateLabel(series[index].date)}: {series[index].scans} visits</title></circle>)}
  </svg><div className="chart-dates">{labelIndices.map(index => <span key={index}>{dateLabel(series[index].date)}</span>)}</div></div>;
}
