import React, { useRef, useState } from 'react';
import { Search, QrCode, Link2, FileText, Image, Smartphone, Type, MessageCircle, Play, Camera, Users, Send, ContactRound, MapPin, Wifi, Music2, Mail, CalendarCheck, Phone, Presentation, Route, ArrowUpRight, ShieldCheck, FileUp, ExternalLink, Globe2 } from 'lucide-react';
import { CONTENT_TYPES, contentType } from '../shared/content-types.js';
import { Select, Spinner } from './components.jsx';
import { api, formatBytes } from './api.js';
const Icons = { Search, QrCode, Link2, FileText, Image, Smartphone, Type, MessageCircle, Play, Camera, Users, Send, ContactRound, MapPin, Wifi, Music2, Mail, CalendarCheck, Phone, Presentation, Route, ArrowUpRight, ShieldCheck, FileUp, ExternalLink, Globe2 };

export function TypeChooser({ onChoose }) {
  const [search, setSearch] = useState('');
  const types = CONTENT_TYPES.filter(type => `${type.name} ${type.description}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="type-chooser"><div className="type-chooser-intro"><div><span className="eyebrow">19 WAYS TO CONNECT</span><h3>What would you like to share?</h3><p>Start with your content. Make the code your own.</p></div><div className="search-input"><Icons.Search size={17}/><input aria-label="Search QR types" placeholder="Find a type…" value={search} onChange={event => setSearch(event.target.value)}/></div></div><div className="content-type-grid">{types.map(type => { const Icon = Icons[type.icon] || Icons.QrCode; return <button type="button" data-testid={`content-type-${type.id}`} key={type.id} className={`content-type-card ${type.id === 'pdf' ? 'pdf-spotlight' : ''}`} onClick={() => onChoose(type)}><span className="content-type-icon"><Icon size={24}/></span><span><strong>{type.name}{type.id === 'pdf' && <small className="type-featured">UPLOAD & SHARE</small>}</strong><small>{type.description}</small></span><Icons.ArrowUpRight size={17}/></button>; })}</div>{!types.length && <p className="types-no-results">No matching types. Try PDF, Wi-Fi, or contact.</p>}<p className="type-chooser-note"><Icons.ShieldCheck size={16}/>Your files and links stay on your own server. No QR subscription required.</p></div>;
}

export function ContentFields({ draft, qr, update, onUploading, setError }) {
  const meta = contentType(draft.contentType);
  const inputRef = useRef(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const payload = draft.payload || {};
  const set = (key, value) => update('payload', { ...payload, [key]: value });
  const fixed = Boolean(qr?.type === 'static');
  async function upload(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > meta.maxMB * 1024 * 1024) { setError(`${meta.name} files must be no larger than ${meta.maxMB} MB.`); return; }
    setUploadBusy(true); onUploading(true); setError('');
    try {
      let result;
      if (meta.id === 'pdf') {
        try {
          const request = await api('/assets/r2/init', { method: 'POST', body: { kind: 'pdf', size: file.size, name: file.name } });
          const transfer = await fetch(request.uploadUrl, {
            method: 'PUT', credentials: 'omit',
            headers: { 'Content-Type': request.contentType }, body: file,
          });
          if (!transfer.ok) throw new Error('Cloudflare upload failed. Check that the R2 bucket allows PUT from this yourQR domain.');
          result = await api('/assets/r2/complete', { method: 'POST', body: { id: request.id } });
        } catch (error) {
          if (error.status !== 503) throw error;
          if (file.size > 4000000) throw new Error('Large PDF uploads need Cloudflare R2. Ask the yourQR owner to configure R2.');
          // Allow the legacy small-PDF workflow until R2 is activated.
        }
      }
      if (!result) {
        const response = await fetch(`/api/assets?type=${meta.id}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }, body: file });
        result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Upload failed. Please try again.');
      }
      update('asset', result.asset);
      update('assetId', result.asset.id);
      if (!draft.name.trim()) update('name', file.name.replace(/\.[^.]+$/, '').slice(0, 100));
    } catch (error) { setError(error.message); }
    finally { setUploadBusy(false); onUploading(false); }
  }
  if (meta?.file) return <div className="file-content-fields"><div className="field"><label htmlFor="qr-file">{qr ? `Replace ${meta.name} file` : `${meta.name} file`}<span className="required">*</span></label><input ref={inputRef} id="qr-file" type="file" className="visually-hidden" accept={meta.accept} aria-label={`Upload ${meta.name} file`} onChange={upload} disabled={uploadBusy}/><button type="button" className={`file-upload-zone ${draft.asset ? 'has-file' : ''}`} onClick={() => inputRef.current?.click()} disabled={uploadBusy}><span className="file-upload-icon">{uploadBusy ? <Spinner text=""/> : <Icons.FileUp size={28}/>}</span><strong>{uploadBusy ? 'Uploading your file…' : draft.asset?.name || `Choose a ${meta.name} file`}</strong><span>{draft.asset ? `${formatBytes(draft.asset.size)} · Click to replace` : `Stored on your server · Up to ${meta.maxMB} MB`}</span></button>{draft.asset && <a className="text-button file-preview-link" href={`/api/assets/${draft.asset.id}/content`} target="_blank" rel="noopener noreferrer"><Icons.ExternalLink size={14}/>Open uploaded file</a>}<small>{meta.id === 'pdf' ? 'People scan your QR to open this PDF. Upload a replacement here and save; your printed QR stays the same.' : meta.id === 'pptx' ? 'People scan to download the presentation. PPTX opens in a compatible presentation app.' : meta.id === 'audio' ? 'MP3, WAV, or Ogg. Scanning opens the recording in the browser or its media player.' : 'PNG, JPEG, or WebP. Scanning opens the image; uploads are stored as PNG.'}</small></div><div className="file-sharing-note"><Icons.Globe2 size={18}/><p>Anyone with an active code’s link can access the file. Pause the code to stop serving it. A reachable server is required.</p></div></div>;
  if (draft.contentType === 'url' || draft.contentType === 'text') return <div className="field"><label htmlFor="qr-destination">{draft.contentType === 'text' ? 'Your text' : 'Destination URL'}<span className="required">*</span>{draft.type === 'dynamic' && <span className="label-hint">Editable anytime</span>}</label>{draft.contentType === 'text' ? <textarea id="qr-destination" value={draft.destination} onChange={event => update('destination', event.target.value)} placeholder="A message worth sharing…" rows={4} maxLength={1000} disabled={fixed}/> : <div className="input-icon"><Icons.Globe2 size={17}/><input id="qr-destination" type="url" value={draft.destination} onChange={event => update('destination', event.target.value)} placeholder="https://your-website.com" maxLength={2048} disabled={fixed}/></div>}<small>{fixed ? 'Static content is embedded permanently. Create a new code to change it.' : draft.type === 'dynamic' ? 'Change this destination later without reprinting your code.' : 'Embedded directly in the QR. Its content is permanent.'}</small></div>;
  return <div className="structured-fields">{meta?.fields.map(([key, label, type]) => {
    const id = `content-${key}`, optional = label.includes('(optional)') || key === 'hidden' || (key === 'password' && payload.security === 'nopass');
    if (type === 'checkbox') return <label className="checkbox-field" key={key}><input id={id} type="checkbox" checked={Boolean(payload[key])} onChange={event => set(key, event.target.checked)} disabled={fixed}/>{label}</label>;
    return <div className="field" key={key}><label htmlFor={id}>{label}{!optional && <span className="required">*</span>}</label>{type === 'security' ? <Select id={id} value={payload[key] || 'WPA'} onChange={event => set(key, event.target.value)} disabled={fixed}><option value="WPA">WPA / WPA2 / WPA3 personal</option><option value="WEP">WEP</option><option value="nopass">Open network (no password)</option></Select> : type === 'textarea' ? <textarea id={id} rows={3} value={payload[key] || ''} onChange={event => set(key, event.target.value)} maxLength={600} disabled={fixed}/> : <input id={id} type={type} autoComplete="off" spellCheck={false} value={payload[key] || ''} onChange={event => set(key, event.target.value)} required={!optional} maxLength={type === 'url' ? 2048 : 300} disabled={fixed || (key === 'password' && payload.security === 'nopass')}/>}</div>;
  })}{fixed && <p className="structured-note">These details are permanently embedded in the saved QR. Create a new code to change them.</p>}{['app', 'smart'].includes(meta?.id) && <p className="structured-note">Routing uses the scanning browser’s device signal. Unknown devices use the default URL. Destinations stay editable.</p>}{meta?.id === 'booking' && <p className="structured-note">Link to your existing appointment or booking page. Scheduling is handled by that service.</p>}{meta?.id === 'wifi' && <p className="structured-note">The Wi-Fi password is embedded in the QR image. Share this code only with people who should join your network.</p>}</div>;
}
