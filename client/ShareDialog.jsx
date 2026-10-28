import React, { useRef, useState } from 'react';
import { Check, Copy, Download, ExternalLink, Globe2, QrCode } from 'lucide-react';
import { Modal, QrImage, InlineError } from './components.jsx';
import { copyText } from './api.js';
import { addressScope } from '../shared/network.js';

export default function ShareDialog({ qr, onClose, onDownload }) {
  const input = useRef(null);
  const [copied, setCopied] = useState(false);
  const [manualCopy, setManualCopy] = useState(false);
  const link = qr.shortUrl || qr.encodedValue;
  const scope = addressScope(link);
  return <Modal title="Share or test your link" subtitle={qr.name} onClose={onClose} className="share-modal" footer={<button type="button" className="button secondary" onClick={onClose}>Done</button>}><div className="modal-content share-content"><QrImage qr={qr} size={160}/><div className="field"><label htmlFor="share-link">Permanent QR link</label><div className="share-link-row"><input id="share-link" ref={input} type="text" readOnly value={link} onFocus={event => event.target.select()}/><button type="button" className="button secondary" onClick={async () => { const ok = await copyText(link); setCopied(ok); setManualCopy(!ok); if (!ok) { input.current?.focus(); input.current?.select(); } }}>{copied ? <Check size={16}/> : <Copy size={16}/>} {copied ? 'Copied' : 'Copy link'}</button></div>{manualCopy && <small role="status">The link is selected. Use your browser’s Copy option or press Ctrl+C.</small>}</div>{qr.active ? <div className="share-primary-actions"><a className="button primary" href={link} target="_blank" rel="noopener noreferrer"><ExternalLink size={16}/>Open link</a>{qr.contentType === 'pdf' && <a className="button secondary" href={`${qr.destination}?download=1`} target="_blank" rel="noopener noreferrer"><Download size={16}/>Download PDF</a>}</div> : <InlineError>This link is paused. Resume it from your QR code’s menu to make it available.</InlineError>}<div className="share-network-note"><Globe2 size={18}/><p>{scope === 'lan' ? 'Use this link on devices connected to the same Wi-Fi or hotspot. Keep this computer awake and yourQR running.' : scope === 'device' ? 'This link works on this computer. Configure Wi-Fi sharing before using the QR on your phone.' : 'Keep yourQR server and its public address available for the lifetime of this QR.'}</p></div><div className="share-downloads"><span><QrCode size={16}/>Download QR image</span><button type="button" className="button secondary small" onClick={() => onDownload(qr,'png')}>PNG</button><button type="button" className="button secondary small" onClick={() => onDownload(qr,'svg')}>SVG</button></div><p className="share-analytics-note">Opening a dynamic link counts as a redirect visit in analytics.</p></div></Modal>;
}
