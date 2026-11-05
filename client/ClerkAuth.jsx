import React, { useEffect, useState } from 'react';
import { ClerkProvider, SignIn, SignUp, UserButton, useAuth, useClerk } from '@clerk/react';
import { Brand, InlineError, Spinner } from './components.jsx';
import { api, setTokenProvider } from './api.js';
import App from './App.jsx';

function AuthLayout({ children }) {
  return <main className="auth-shell"><section className="auth-story"><Brand light /><div className="auth-story-content"><span className="auth-kicker">A SMALL CODE. A BIG CONNECTION.</span><h1>Good things<br />start with<br />a <span>little square.</span></h1><p>Your links, beautifully connected.<br />Create, organize, and keep them growing.</p></div><div className="auth-story-footer">Your own account. Your own workspace.</div></section><section className="auth-form-side"><div className="auth-mobile-brand"><Brand /></div><div className="auth-form-box clerk-auth-box">{children}</div></section></main>;
}

function ClerkWorkspace() {
  const { isLoaded, isSignedIn, userId, getToken } = useAuth();
  const { signOut } = useClerk();
  const [ready, setReady] = useState(false);
  const [signup, setSignup] = useState(() => window.location.hash.startsWith('#/sign-up'));
  useEffect(() => {
    const update = () => setSignup(window.location.hash.startsWith('#/sign-up'));
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  useEffect(() => {
    setTokenProvider(getToken); setReady(true);
    return () => setTokenProvider(null);
  }, [getToken]);
  if (!isLoaded || !ready) return <div className="boot-screen"><Brand /><Spinner text="Connecting securely…" /></div>;
  const logout = () => signOut({ redirectUrl: '/' });
  if (!isSignedIn) {
    return <AuthLayout>{signup ? <SignUp routing="hash" signInUrl="/#/sign-in" fallbackRedirectUrl="/" /> : <SignIn routing="hash" signUpUrl="/#/sign-up" fallbackRedirectUrl="/" />}</AuthLayout>;
  }
  return <App key={userId} onSignOut={logout} accountControl={<UserButton />} renderAuth={(session, reload) => <LinkWorkspace session={session} reload={reload} logout={logout} />} />;
}

function LinkWorkspace({ session, reload, logout }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function link(event) {
    event.preventDefault(); setBusy(true); setError('');
    try { await api('/auth/link', { method: 'POST', body: { password } }); setPassword(''); await reload(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <AuthLayout><h2>{session.linkRequired ? 'Connect your existing workspace.' : 'Open your workspace.'}</h2><p>{session.linkRequired ? 'Enter your previous yourQR password once to keep your saved codes and files. Future sign-ins will use Clerk.' : 'Your session could not open the workspace. Try again or sign out to reconnect.'}</p><InlineError>{error}</InlineError>{session.linkRequired ? <form onSubmit={link}><div className="field"><label htmlFor="link-password">Previous yourQR password</label><input id="link-password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required maxLength={256} /></div><button className="button primary" disabled={busy}>{busy ? 'Connecting…' : 'Connect workspace'}</button></form> : <button className="button primary" onClick={reload}>Try again</button>}<button type="button" className="text-button auth-switch" onClick={logout}>Sign out</button></AuthLayout>;
}

export default function AuthenticationRoot() {
  const [config, setConfig] = useState(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    api('/auth/config').then(value => { if (active) setConfig(value); }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [attempt]);
  if (!config) return <div className="boot-screen"><Brand />{error ? <><InlineError>{error}</InlineError><button className="button primary" onClick={() => { setError(''); setAttempt(value => value + 1); }}>Try again</button></> : <Spinner text="Opening your workspace…" />}</div>;
  if (config.provider !== 'clerk') return <App />;
  return <ClerkProvider publishableKey={config.publishableKey} appearance={{ variables: { colorPrimary: '#1765ed', borderRadius: '14px', fontFamily: 'Inter, system-ui, sans-serif' }, elements: { card: 'clerk-glass-card' } }}><ClerkWorkspace /></ClerkProvider>;
}
