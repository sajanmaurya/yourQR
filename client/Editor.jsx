import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, CircleHelp, Download, FileImage, Globe2, ImagePlus, Link2, Palette, RefreshCw, ShieldCheck, Type, Upload, X, Zap } from 'lucide-react';
import { api, downloadCode } from './api.js';
import { CONTENT_TYPES, contentType } from '../shared/content-types.js';
import { ContentFields, TypeChooser } from './ContentFields.jsx';
import { InlineError, Modal, Select, Spinner } from './components.jsx';

const presets = [
  { name: 'Forest', fgColor: '#183f35', bgColor: '#ffffff' },
  { name: 'Ink', fgColor: '#202c3d', bgColor: '#ffffff' },
  { name: 'Indigo', fgColor: '#493a8a', bgColor: '#faf9ff' },
  { name: 'Terracotta', fgColor: '#813f2e', bgColor: '#fffaf2' },
];
function luminance(color) {
  if (!/^#[a-f0-9]{6}$/i.test(color)) return 0;
  return color.slice(1).match(/../g).map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
}

export default function Editor({ qr, folders, initialFolder, publicBaseUrl, onClose, onSaved, notify }) {
  const linkBaseUrl = qr?.shortUrl ? qr.shortUrl.slice(0, qr.shortUrl.lastIndexOf('/r/')) : publicBaseUrl;
  const [draft, setDraft] = useState(qr ? { ...qr, folderId: qr.folderId || '', slug: qr.slug || '' } : {
    name: '', type: 'dynamic', contentType: 'url', destination: '', slug: '', folderId: initialFolder || '', fgColor: '#183f35', bgColor: '#ffffff', logoDataUrl: null,
  });
  const [tab, setTab] = useState('content');
  const [choosingType, setChoosingType] = useState(!qr);
  const [uploading, setUploading] = useState(false);
  const meta = contentType(draft.contentType);
  const chooseType = selected => { setDraft(previous => ({ ...previous, contentType: selected.id, type: selected.mode || previous.type, destination: '', payload: {}, assetId: null, asset: null })); setChoosingType(false); setTab('content'); setError(''); };
  const [preview, setPreview] = useState(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const fileInput = useRef(null);
  const form = useRef(null);
  const update = (key, value) => { setDraft(previous => ({ ...previous, [key]: value })); setError(''); };
  const dark = luminance(draft.fgColor), light = luminance(draft.bgColor);
  const contrast = (light + .05) / (dark + .05);
  const validColors = /^#[a-f0-9]{6}$/i.test(draft.fgColor) && /^#[a-f0-9]{6}$/i.test(draft.bgColor) && contrast >= 4.5;

  useEffect(() => {
    let cancelled = false;
    const hasContent = ['url', 'text'].includes(draft.contentType) ? draft.destination?.trim() : meta?.file ? draft.assetId : Object.keys(draft.payload || {}).length;
    if (!hasContent || !validColors) { setPreview(null); setPreviewError(''); setPreviewBusy(false); return; }
    setPreviewBusy(true);
    const timer = setTimeout(async () => {
      try {
        const result = await api('/preview', { method: 'POST', body: { ...draft, name: draft.name.trim() || 'Preview', folderId: draft.folderId || null, slug: draft.slug || undefined } });
        if (!cancelled) { setPreview(result); setPreviewError(''); }
      } catch (err) { if (!cancelled) { setPreview(null); setPreviewError(err.message); } }
      finally { if (!cancelled) setPreviewBusy(false); }
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [draft.destination, draft.type, draft.contentType, draft.slug, draft.fgColor, draft.bgColor, draft.logoDataUrl, draft.payload, draft.assetId, validColors]);

  async function uploadLogo(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = '';
    if (!['image/png', 'image/jpeg'].includes(file.type)) { setError('Choose a PNG or JPEG image for your logo.'); return; }
    if (file.size > 200 * 1024) { setError('Your logo must be smaller than 200 KB.'); return; }
    const reader = new FileReader();
    reader.onload = () => update('logoDataUrl', reader.result);
    reader.onerror = () => setError('This image could not be read. Try another file.');
    reader.readAsDataURL(file);
  }

  async function save(event) {
    event.preventDefault();
    if (!draft.name.trim()) { setTab('content'); setError('Give your QR code a name.'); return; }
    if (['url', 'text'].includes(draft.contentType) && !draft.destination.trim()) { setTab('content'); setError('Add a destination or some text first.'); return; }
    if (draft.contentType === 'url') {
      try { const url = new URL(draft.destination); if (!['https:', 'http:'].includes(url.protocol)) throw new Error(); }
      catch { setTab('content'); setError('Enter a complete website address starting with https:// or http://.'); return; }
    }
    if (!validColors) { setTab('design'); setError('Use a dark foreground and a light background with at least 4.5:1 contrast.'); return; }
    setSaving(true); setError('');
    try {
      const body = { ...draft, name: draft.name.trim(), destination: draft.destination, folderId: draft.folderId || null, slug: draft.slug || undefined };
      const result = await api(qr ? `/qrs/${qr.id}` : '/qrs', { method: qr ? 'PATCH' : 'POST', body });
      onSaved(result.qr);
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }

  async function download(format) {
    try { await downloadCode(qr.id, format); notify(`${format.toUpperCase()} download ready.`); }
    catch (err) { notify(err.message, true); }
  }

  if (choosingType) return <Modal title="Create a QR code" subtitle="Choose a content type to get started." onClose={onClose} className="type-chooser-modal"><TypeChooser onChoose={chooseType}/></Modal>;

  const src = preview?.svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(preview.svg)}` : '';
  return <Modal title={qr ? 'Edit QR code' : 'Create a QR code'} subtitle={qr ? 'Refine the details. Keep your code working.' : meta?.file ? `Upload your ${meta.name} and create its permanent QR link.` : 'Turn a link into your next connection.'} onClose={saving || uploading ? undefined : onClose} className="editor-modal" footer={<><p className="footer-note"><ShieldCheck size={15} />Saved in your private workspace</p><div className="button-row"><button type="button" className="button secondary" onClick={onClose} disabled={saving || uploading}>Cancel</button><button type="submit" form="qr-editor" className="button primary" disabled={saving || uploading || (meta?.file && !draft.assetId)}>{saving ? <Spinner text="Saving…" /> : <>{qr ? 'Save changes' : 'Create QR code'}<ArrowRight size={17} /></>}</button></div></>}>
    <form ref={form} id="qr-editor" className="editor-body" onSubmit={save}>
      <div className="editor-form">
        <div className="editor-tabs" role="tablist" aria-label="QR code editor"><button type="button" role="tab" aria-selected={tab === 'content'} className={tab === 'content' ? 'selected' : ''} onClick={() => setTab('content')}><Link2 size={17} />Content</button><button type="button" role="tab" aria-selected={tab === 'design'} className={tab === 'design' ? 'selected' : ''} onClick={() => setTab('design')}><Palette size={17} />Design</button></div>
        <InlineError>{error}</InlineError>{!qr && <button type="button" className="text-button change-content-type" onClick={() => setChoosingType(true)} disabled={uploading}>← All QR types</button>}
        {tab === 'content' ? <div className="editor-section" role="tabpanel" aria-label="Content">
          <div className="field">{meta?.mode ? <div className="fixed-mode-note"><ShieldCheck size={17}/><span><strong>{meta.mode === 'dynamic' ? 'Dynamic code' : 'Static code'}</strong>{meta.mode === 'dynamic' ? 'Replace your content. Keep the same QR.' : 'Content is embedded directly in your QR.'}</span></div> : <><label>Code type</label><div className="type-picker">
            <button type="button" className={`type-option ${draft.type === 'dynamic' ? 'selected' : ''}`} disabled={!!qr || !!meta?.mode || uploading} onClick={() => update('type', 'dynamic')}><span className="type-icon"><RefreshCw size={19} /></span><strong>Dynamic</strong><small>Edit links. Track visits.</small>{draft.type === 'dynamic' && <Check className="type-check" size={15} />}</button>
            <button type="button" className={`type-option ${draft.type === 'static' ? 'selected' : ''}`} disabled={!!qr || !!meta?.mode || uploading} onClick={() => update('type', 'static')}><span className="type-icon"><Zap size={19} /></span><strong>Static</strong><small>Direct. No server needed.</small>{draft.type === 'static' && <Check className="type-check" size={15} />}</button>
          </div></>}</div>
          {meta?.file && <ContentFields draft={draft} qr={qr} update={update} onUploading={setUploading} setError={setError}/>}
          <div className="field"><label htmlFor="qr-name">QR code name <span className="required">*</span></label><input id="qr-name" name="name" value={draft.name} onChange={event => update('name', event.target.value)} placeholder="e.g. My portfolio" maxLength={100} autoComplete="off" /><small>Just for you. Make it easy to find later.</small></div>
          <div className="field"><label htmlFor="qr-content-type">Content</label><Select id="qr-content-type" value={draft.contentType} disabled={!!qr || uploading} onChange={event => chooseType(contentType(event.target.value))}>{CONTENT_TYPES.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></div>
          {!meta?.file && <ContentFields draft={draft} qr={qr} update={update} onUploading={setUploading} setError={setError}/>}
          {draft.type === 'dynamic' && <div className="field"><label htmlFor="qr-slug">Short link <span className="label-hint">{qr ? 'Permanent' : 'Optional'}</span></label><div className="slug-input"><span>{linkBaseUrl.replace(/^https?:\/\//, '')}/r/</span><input id="qr-slug" value={draft.slug} onChange={event => update('slug', event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} placeholder="auto-generated" disabled={!!qr} minLength={draft.slug ? 3 : undefined} maxLength={48} /></div><small>{qr ? 'The short link stays fixed, so existing prints keep working.' : 'Leave blank for a unique link. 3–48 letters, numbers, or hyphens.'}</small></div>}
          <div className="field"><label htmlFor="qr-folder">Folder <span className="label-hint">Optional</span></label><Select id="qr-folder" value={draft.folderId} onChange={event => update('folderId', event.target.value)}><option value="">Unfiled</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</Select></div>
          <button type="button" className="text-button next-design" onClick={() => setTab('design')}>Make it your own<ArrowRight size={16} /></button>
        </div> : <div className="editor-section" role="tabpanel" aria-label="Design">
          <div className="section-intro"><h3>A little more you.</h3><p>Give your code a color and a familiar face.</p></div>
          <div className="field"><label>Color palette</label><div className="palette-presets">{presets.map(preset => <button type="button" key={preset.name} className={`palette-preset ${draft.fgColor === preset.fgColor && draft.bgColor === preset.bgColor ? 'selected' : ''}`} onClick={() => setDraft(previous => ({ ...previous, fgColor: preset.fgColor, bgColor: preset.bgColor }))}><span style={{ background: preset.bgColor }}><i style={{ background: preset.fgColor }} />{draft.fgColor === preset.fgColor && draft.bgColor === preset.bgColor && <Check size={14} style={{ color: preset.fgColor }} />}</span>{preset.name}</button>)}</div></div>
          <div className="color-row">{[['fgColor', 'Foreground'], ['bgColor', 'Background']].map(([key, title]) => <div className="field" key={key}><label htmlFor={`${key}-text`}>{title}</label><div className="color-input"><input aria-label={`${title} color picker`} type="color" value={/^#[a-f0-9]{6}$/i.test(draft[key]) ? draft[key] : '#ffffff'} onChange={event => update(key, event.target.value)} /><input id={`${key}-text`} value={draft[key]} onChange={event => update(key, event.target.value)} maxLength={7} spellCheck={false} /></div></div>)}</div>
          <div className={`contrast-note ${!validColors ? 'warning' : ''}`}><ShieldCheck size={16} /><span>{validColors ? `${contrast.toFixed(1)}:1 contrast · Easy on every scanner` : 'Choose a darker foreground and lighter background (4.5:1 minimum).'}</span></div>
          <div className="field logo-field"><label>Center logo <span className="label-hint">Optional</span></label><input className="visually-hidden" type="file" accept="image/png,image/jpeg" onChange={uploadLogo} ref={fileInput} aria-label="Upload logo image" />
            {draft.logoDataUrl ? <div className="uploaded-logo"><img src={draft.logoDataUrl} alt="Uploaded center logo" /><div><strong>Your logo is ready</strong><small>Centered with a little breathing room.</small></div><button type="button" className="icon-button" aria-label="Remove logo" onClick={() => update('logoDataUrl', null)}><X size={18} /></button></div> : <button type="button" className="upload-box" onClick={() => fileInput.current?.click()}><span className="upload-icon"><ImagePlus size={23} /></span><strong>Click to upload a logo</strong><span>PNG or JPEG, up to 200 KB</span></button>}
            <small>High error correction and a small logo keep your code scannable. Always test a printed sample.</small>
          </div>
        </div>}
      </div>
      <aside className="preview-panel"><div className="preview-heading"><span className="eyebrow">LIVE PREVIEW</span><span className="live-dot" /></div><div className="preview-stage"><div className={`preview-paper ${previewBusy ? 'preview-loading' : ''}`} style={{ background: draft.bgColor }}>
          {src ? <img src={src} width="258" height="258" alt="Live QR code preview" /> : <div className="preview-placeholder"><span className="preview-corners"><i /><i /><i /><i /><QrPattern /></span><p>{previewError ? 'Check your content' : 'Your code, coming to life'}</p><small>{previewError || (meta?.file ? `Upload a ${meta.name} file to see your preview.` : 'Add your content to see your preview.')}</small></div>}
          {previewBusy && <span className="preview-spinner"><Spinner text="" /></span>}
        </div></div><h3 className="preview-name">{draft.name.trim() || 'Your next connection'}</h3><span className="preview-content-kind">{meta?.name}</span><p className="preview-type">{draft.type === 'dynamic' ? <><RefreshCw size={14} />Dynamic QR code</> : <><Zap size={14} />Static QR code</>}</p>
        {!qr && <p className="preview-save-note">Preview only. Save your code before scanning or downloading.</p>}
        <div className="preview-tip"><CircleHelp size={18} /><p>{draft.type === 'dynamic' ? <>Your code points to a permanent short link. <strong>Your destination can change.</strong></> : <>Your content lives inside the code. <strong>It works without Qori once downloaded.</strong></>}</p></div>
        {draft.type === 'dynamic' && /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(linkBaseUrl) && <p className="local-preview-note"><Globe2 size={15} />Local links work on this computer. Use a public address before printing for others.</p>}
        {qr && <div className="editor-downloads"><span>Download saved design</span><div><button type="button" className="button secondary small" onClick={() => download('png')}><Download size={15} />PNG</button><button type="button" className="button secondary small" onClick={() => download('svg')}><Download size={15} />SVG</button></div><small>Save changes first to include your latest design.</small></div>}
      </aside>
    </form>
  </Modal>;
}

function QrPattern() { return <svg width="62" height="62" viewBox="0 0 62 62" fill="none" aria-hidden="true"><path d="M7 7h17v17H7zM38 7h17v17H38zM7 38h17v17H7z" stroke="currentColor" strokeWidth="5"/><path d="M31 4v16m0 10h10v10h14M31 50v8m10-11v11m8-8h10M4 31h20" stroke="currentColor" strokeWidth="5"/><path d="M13 13h5v5h-5zM44 13h5v5h-5zM13 44h5v5h-5z" fill="currentColor"/></svg>; }
