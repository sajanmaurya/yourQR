import React, { useEffect, useState } from 'react';
import { CreditCard, CheckCircle2, ShieldCheck, RefreshCw } from 'lucide-react';
import { api } from './api.js';
import { InlineError, Spinner } from './components.jsx';

let sdkPromise;
function loadCashfreeSdk() {
  if (window.Cashfree) return Promise.resolve(window.Cashfree);
  if (!sdkPromise) sdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://sdk.cashfree.com/js/v3/cashfree.js';
    script.async = true;
    script.onload = () => window.Cashfree ? resolve(window.Cashfree) : reject(new Error('Cashfree checkout did not load.'));
    script.onerror = () => reject(new Error('Unable to load Cashfree checkout. Check the network.'));
    document.head.appendChild(script);
  }).catch(error => { sdkPromise = null; throw error; });
  return sdkPromise;
}
function rupees(value) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(Number(value));
}
function interval(plan) {
  const every = plan.interval;
  const unit = (plan.intervalType || 'MONTH').toLowerCase();
  return every === 1 ? unit : `${every} ${unit}s`;
}
export default function Billing({ notify }) {
  const [details, setDetails] = useState(null);
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  async function refresh() {
    setError('');
    try { setDetails(await api('/billing')); } catch (err) { setError(err.message); }
  }
  useEffect(() => { refresh(); }, []);

  async function checkout() {
    setBusy('checkout'); setError('');
    try {
      if (!/^[6-9]\d{9}$/.test(phone)) throw new Error('Enter a valid 10-digit Indian mobile number.');
      const Cashfree = await loadCashfreeSdk();
      const { sessionId, environment } = await api('/billing/checkout', { method: 'POST', body: { phone } });
      const result = await Cashfree({ mode: environment }).subscriptionsCheckout({
        subsSessionId: sessionId, redirectTarget: '_self',
      });
      if (result?.error) throw new Error(result.error.message || 'Checkout could not be opened.');
    } catch (err) { setError(err.message); } finally { setBusy(''); }
  }
  async function sync() {
    setBusy('sync'); setError('');
    try {
      await api('/billing/sync', { method: 'POST' });
      await refresh();
      notify('Subscription status refreshed directly from Cashfree.');
    } catch (err) { setError(err.message); } finally { setBusy(''); }
  }
  async function cancel() {
    if (!window.confirm('Cancel the Cashfree mandate? This may end Pro access immediately.')) return;
    setBusy('cancel'); setError('');
    try {
      await api('/billing/cancel', { method: 'POST' });
      await refresh();
      notify('Cancellation request sent to Cashfree.');
    } catch (err) { setError(err.message); } finally { setBusy(''); }
  }
  const subscription = details?.subscription;
  const active = subscription?.tier === 'Pro';
  return <div className="billing-page">
    <div className="page-heading"><div><span className="eyebrow">ACCOUNT & SUBSCRIPTIONS</span><h1>Billing<span className="heading-dot">.</span></h1><p>Choose your plan. Your payment details stay with Cashfree.</p></div></div>
    <InlineError>{error}</InlineError>
    {!details ? <div className="panel billing-card"><Spinner text="Loading billing status…" /></div> : <>
      <div className="billing-grid">
        <section className="panel billing-card"><span className="billing-symbol"><CheckCircle2 size={22} /></span><h2>Free</h2><p>Get started with your QR workspace.</p><strong>{details.enabled && details.freeLimit ? `${details.freeLimit} saved QR codes` : 'Current access stays free'}</strong><small>No payment required.</small></section>
        <section className="panel billing-card billing-pro"><span className="billing-symbol"><CreditCard size={22} /></span><h2>Pro</h2>
          <strong>{details.enabled ? `${rupees(details.plan.amountRupees)} / ${interval(details.plan)}` : 'Coming soon'}</strong>
          <p>Unlimited QR codes, editable destinations and existing saved links retained.</p>
          {details.enabled && !active && <>
            <label className="billing-phone">Indian mobile number for Cashfree authorisation<input type="tel" inputMode="numeric" value={phone} placeholder="10-digit mobile number" maxLength={10} onChange={event => setPhone(event.target.value.replace(/\D/g, ''))}/></label>
          </>}
          <button type="button" className="button primary billing-action" disabled={!details.enabled || active || Boolean(busy)} onClick={checkout}>{busy === 'checkout' ? 'Opening Cashfree…' : active ? 'Pro is active' : details.enabled ? 'Subscribe with Cashfree' : 'Payment setup pending'}</button>
          <small>Cashfree handles UPI AutoPay, eligible cards and mandates. Activation requires server-side verification.</small>
        </section>
      </div>
      <section className="panel billing-status"><div><h2>Subscription status</h2><p>{subscription?.status || 'NONE'} · {subscription?.tier || 'Free'}</p>{details.environment === 'sandbox' && <small>Cashfree sandbox testing mode. No live charges.</small>}</div>
        {details.enabled && <div className="button-row"><button className="button secondary" disabled={Boolean(busy)} onClick={sync}><RefreshCw size={16}/>Verify status</button>{subscription?.subscriptionId && !['CANCELLED','COMPLETED','EXPIRED'].includes(subscription.status) && <button className="button secondary" disabled={Boolean(busy)} onClick={cancel}>Cancel mandate</button>}</div>}
      </section>
      <p className="billing-footer-note"><ShieldCheck size={16}/>Subscriptions are never activated by browser redirects alone. Check your merchant's pricing, mandate fees and cancellation policy before using real money.</p>
    </>}
  </div>;
}
