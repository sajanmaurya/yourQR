import React from 'react';
import { RefreshCw, AlertCircle } from 'lucide-react';
import { Brand } from './components.jsx';

export default class AppErrorBoundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error) { console.error('Qori view failed:', error); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <main className="recovery-screen"><Brand/><section role="alert"><span className="recovery-icon"><AlertCircle size={28}/></span><h1>This view couldn’t load.</h1><p>Reload to reopen your workspace. If this happens again, note the action you took just before it.</p><button type="button" className="button primary" onClick={() => window.location.reload()}><RefreshCw size={17}/>Reload workspace</button></section></main>;
  }
}
