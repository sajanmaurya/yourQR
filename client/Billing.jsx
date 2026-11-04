import React, { useEffect, useState } from 'react';
import { CreditCard, CheckCircle2, Clock3, ExternalLink, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { api } from './api.js';
import { InlineError, Spinner } from './components.jsx';

const currency = paise => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(paise / 100);
function intervalLabel(plan) {
  if (!plan) return '';
  const interval = Number(plan.interval || 1);
  return interval === 1 ? plan.period : `${interval} ${plan.period}s`;
}
function statusLabel(status) {
  return ({
    none: 'No paid subscription', created: 'Payment awaiting approval', authenticated: 'Payment authorization pending',
    active: 'Active', pending: 'Payment retry pending', halted: 'Payment action required',
    paused: 'Paused', cancelled: 'Cancelled', completed: 'Completed', expired: 'Expired',
  })[status] || status;
}

export default function Billing({ notify }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  async function load() {
    setError('');
    try { setData(await api('/billing')); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);
  async function beginCheckout() {
    setBusy('checkout'); setError('');
    try {
      const result = await api('/billing/checkout', { method: 'POST' });
      window.location.assign(result.checkoutUrl);
    } catch (err) { setError(err.message); setBusy(''); }
  }
  async function syncStatus() {
    setBusy('sync'); setError('');
    try {
      await api('/billing/sync', { method: 'POST' });
      await load();
      notify('Subscription status checked with Razorpay.');
    } catch (err) { setError(err.message); } finally { setBusy(''); }
  }
  async function cancel() {
    if (!window.confirm('Stop future Pro renewals? Your current paid billing period remains yours.')) return;
    setBusy('cancel'); setError('');
    try {
      await api('/billing/cancel', { method: 'POST' });
      await load();
      notify('Subscription cancellation requested.');
    } catch (err) { setError(err.message); } finally { setBusy(''); }
  }
  const subscription = data?.subscription || { tier: 'Free', status: 'none' };
  const isPro = subscription.tier === 'Pro';
  return <div className="billing-page">
    <div className="page-heading"><div><span className="eyebrow">YOUR PLAN</span><h1>Billing<span className="heading-dot">.</span></h1><p>Manage your plan and subscription securely.</p></div></div>
    <InlineError>{error}</InlineError>
    {!data ? <div className="panel billing-loading"><Spinner text="Checking billing details…" /></div> : <>
      <div className="billing-cards">
        <section className="panel billing-plan-card">
          <div className="billing-card-heading"><span className="billing-icon"><CheckCircle2 size={20} /></span><span className="billing-tier">Free</span></div>
          <h2>Start creating, free.</h2>
          <p>{data.enabled ? `Up to ${data.freeLimit} saved QR codes. Your existing codes will keep working even if you change plans.` : 'Your current workspace features remain available without payment.'}</p>
          <span className="billing-caption">Current access: {isPro ? 'Pro' : 'Free'}</span>
        </section>
        <section className="panel billing-plan-card billing-pro-card">
          <div className="billing-card-heading"><span className="billing-icon"><CreditCard size={20} /></span><span className="billing-tier">Pro</span></div>
          <h2>{data.enabled && data.plan ? currency(data.plan.amountPaise) : 'Coming soon'}</h2>
          <p>{data.enabled ? `Charged every ${intervalLabel(data.plan)}. Automatically renews until cancelled or the selected billing term ends.` : 'Secure Razorpay recurring payments will become available after merchant setup and pricing are approved.'}</p>
          <div className="billing-perk"><CheckCircle2 size={16} />Unlimited saved QR codes</div>
          <div className="billing-perk"><ShieldCheck size={16} />Existing QR links stay unchanged</div>
          {data.enabled && !isPro && subscription.status === 'created' && subscription.checkoutUrl ? <>
            <a className="button primary billing-pay-link" href={subscription.checkoutUrl} rel="noopener noreferrer">Continue secure checkout <ExternalLink size={16} /></a>
          </> : <button className="button primary billing-pay-link" type="button" disabled={!data.enabled || isPro || Boolean(busy)} onClick={beginCheckout}>
            {busy === 'checkout' ? <Spinner text="Preparing checkout…" /> : isPro ? 'Your Pro plan is active' : data.enabled ? 'Upgrade securely with Razorpay' : 'Payments not enabled'}
          </button>}
        </section>
      </div>
      <section className="panel billing-status">
        <div><h2>Subscription status</h2><p>{statusLabel(subscription.status)} {isPro ? '· Pro access is active' : '· Free access'}</p>
          {subscription.renewsAt && <p className="billing-caption">Current billing period ends: {new Date(subscription.renewsAt).toLocaleDateString()}</p>}
          {subscription.cancelScheduled && <p className="billing-caption">Cancellation is scheduled at your cycle end.</p>}
        </div>
        {data.enabled && <div className="button-row">
          <button type="button" className="button secondary" disabled={Boolean(busy)} onClick={syncStatus}><RefreshCw size={16} />Refresh status</button>
          {['active', 'authenticated', 'created'].includes(subscription.status) && !subscription.cancelScheduled && <button type="button" className="button secondary" disabled={Boolean(busy)} onClick={cancel}><XCircle size={16} />Cancel subscription</button>}
        </div>}
      </section>
      <p className="billing-note"><Clock3 size={16} />Payment is processed on Razorpay's secure site, not inside YourQR. After paying, return here and select Refresh status. Never share your Razorpay OTP or payment credentials with YourQR support.</p>
    </>}
  </div>;
}
