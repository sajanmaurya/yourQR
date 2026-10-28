import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { X, AlertCircle, Check, QrCode, ChevronDown, LoaderCircle, ExternalLink, ArrowUpRight } from 'lucide-react';

export function Brand({ light = false }) {
  return <span className={`brand ${light ? 'brand-light' : ''}`}><span className="brand-mark" aria-hidden="true"><i /><i /><i /><b /></span><span>yourQR<span className="brand-dot">.</span></span></span>;
}

export function Spinner({ text = 'Loading…' }) { return <span className="spinner-label"><LoaderCircle className="spin" size={18} />{text}</span>; }

export function InlineError({ children }) { return children ? <div className="inline-error" role="alert"><AlertCircle size={17} /><span>{children}</span></div> : null; }

export function Modal({ title, subtitle, children, onClose, className = '', footer, labelledBy = 'modal-title' }) {
  const panel = useRef(null);
  const initialFocus = useRef(document.activeElement);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const timer = setTimeout(() => panel.current?.querySelector('input:not([disabled]),select:not([disabled]),textarea:not([disabled]),button:not([disabled])')?.focus(), 20);
    const key = event => {
      if (event.key === 'Escape') closeRef.current?.();
      if (event.key !== 'Tab') return;
      const elements = [...(panel.current?.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]') || [])].filter(element => element.offsetParent !== null);
      const first = elements[0], last = elements.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { clearTimeout(timer); document.body.style.overflow = previous; document.removeEventListener('keydown', key); initialFocus.current?.focus?.(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose?.(); }}>
    <section ref={panel} role="dialog" aria-modal="true" aria-labelledby={labelledBy} className={`modal ${className}`}>
      <header className="modal-header"><div><h2 id={labelledBy}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button type="button" className="icon-button close-button" aria-label="Close dialog" onClick={onClose}><X size={21} /></button></header>
      {children}{footer && <footer className="modal-footer">{footer}</footer>}
    </section>
  </div>;
}

export function QrImage({ qr, className = '', size = 160 }) {
  const [image, setImage] = useState('');
  useEffect(() => {
    let cancelled = false;
    const value = qr.encodedValue || (qr.type === 'dynamic' ? qr.shortUrl : qr.destination);
    if (!value) return;
    QRCode.toDataURL(value, { errorCorrectionLevel: 'H', width: size * 2, margin: 4, color: { dark: qr.fgColor || '#163d35', light: qr.bgColor || '#ffffff' } })
      .then(url => { if (!cancelled) setImage(url); }).catch(() => { if (!cancelled) setImage(''); });
    return () => { cancelled = true; };
  }, [qr.encodedValue, qr.shortUrl, qr.destination, qr.type, qr.fgColor, qr.bgColor, size]);
  return <div className={`qr-image ${className}`} style={{ background: qr.bgColor || '#fff' }}>
    {image ? <img src={image} width={size} height={size} alt={`QR code for ${qr.name}`} /> : <QrCode size={size * .5} aria-hidden="true" />}
    {image && qr.logoDataUrl && <span className="qr-logo" style={{ background: qr.bgColor || '#fff' }}><img src={qr.logoDataUrl} alt="" /></span>}
  </div>;
}

export function Select({ children, className = '', ...props }) {
  return <span className={`select-wrap ${className}`}><select {...props}>{children}</select><ChevronDown size={15} aria-hidden="true" /></span>;
}

export function Badge({ qr }) {
  return <span className={`badge ${qr.type === 'dynamic' ? 'badge-dynamic' : 'badge-static'}`}>{qr.type === 'dynamic' ? <><span className={`status-dot ${qr.active ? '' : 'paused'}`} />{qr.active ? 'Dynamic' : 'Paused'}</> : 'Static'}</span>;
}

export function Toast({ message, onClose }) {
  useEffect(() => { if (!message) return; const timer = setTimeout(onClose, 4200); return () => clearTimeout(timer); }, [message, onClose]);
  if (!message) return null;
  return <div className={`toast ${message.error ? 'toast-error' : ''}`} role={message.error ? 'alert' : 'status'}>{message.error ? <AlertCircle size={19} /> : <Check size={19} />}<span>{message.text}</span><button className="icon-button" aria-label="Dismiss notification" onClick={onClose}><X size={16} /></button></div>;
}

export function ExternalAnchor({ href, children, className = '', arrow = false, ...props }) {
  return <a href={href} target="_blank" rel="noopener noreferrer" className={className} {...props}>{children}{arrow ? <ArrowUpRight size={15} /> : <ExternalLink size={14} />}</a>;
}

export function EmptyChart() {
  return <div className="empty-chart"><span className="empty-chart-bars" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /></span><h3>A little quiet, for now</h3><p>Visits to your dynamic links will appear here.</p></div>;
}
