import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import { Activity, Archive, ArrowDownToLine, ArrowUpFromLine, Camera, Check, ChevronDown, CircleHelp, Compass, ExternalLink, FileImage, FileVideo, Filter, FolderOpen, HardDrive, MapPin, Menu, MoreHorizontal, Plane, Plus, Search, Settings, ShieldCheck, Trash2, Upload, X } from 'lucide-react';
import { Flight, MediaRecord, listFlights, listMedia, newId, removeFlight, removeMedia, replaceAll, saveFlight, saveMedia } from '@/lib/local-db';
import './index.css';

type PageProps = { flights: Flight[]; media: MediaRecord[]; ready: boolean; refresh: () => Promise<void>; onUpload: (files: FileList | File[], flightId?: string) => Promise<void> };
const navItems = [
  { href: '/', label: 'Overview', icon: Activity },
  { href: '/flights', label: 'Flights', icon: Plane },
  { href: '/library', label: 'Media library', icon: FolderOpen },
  { href: '/map', label: 'Capture map', icon: MapPin },
  { href: '/settings', label: 'Settings & backup', icon: Settings },
];
const prettyDate = (date?: string) => date ? new Date(date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'Date not recorded';
const prettyTime = (date?: string) => date ? new Date(date).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Time not recorded';
const bytes = (size: number) => size <= 0 ? '0 B' : size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`;
const flightName = (flights: Flight[], id?: string) => flights.find(f => f.id === id)?.name || 'Unassigned';

async function readExif(file: File): Promise<{ capturedAt?: string; latitude?: number; longitude?: number; altitudeMeters?: number }> {
  if (!file.type.includes('jpeg')) return {};
  try {
    const bytes = new Uint8Array(await file.slice(0, 2 * 1024 * 1024).arrayBuffer());
    const view = new DataView(bytes.buffer);
    let cursor = 2;
    while (cursor + 4 < bytes.length) {
      if (bytes[cursor] !== 0xff) { cursor++; continue; }
      const marker = bytes[cursor + 1];
      if (marker === 0xda || marker === 0xd9) break;
      const length = view.getUint16(cursor + 2);
      const start = cursor + 4;
      if (marker === 0xe1 && bytes[start] === 0x45 && bytes[start + 1] === 0x78 && bytes[start + 2] === 0x69 && bytes[start + 3] === 0x66) {
        const tiff = start + 6;
        const little = bytes[tiff] === 0x49;
        const u16 = (at: number) => view.getUint16(at, little);
        const u32 = (at: number) => view.getUint32(at, little);
        const firstIfd = tiff + u32(tiff + 4);
        const find = (ifd: number, wanted: number) => {
          const count = u16(ifd);
          for (let i = 0; i < count; i++) {
            const entry = ifd + 2 + i * 12;
            if (u16(entry) === wanted) return entry;
          }
          return 0;
        };
        const exifEntry = find(firstIfd, 0x8769);
        const gpsEntry = find(firstIfd, 0x8825);
        let capturedAt: string | undefined;
        if (exifEntry) {
          const exifIfd = tiff + u32(exifEntry + 8);
          const dateEntry = find(exifIfd, 0x9003);
          if (dateEntry) {
            const at = tiff + u32(dateEntry + 8);
            const text = String.fromCharCode(...bytes.slice(at, at + u32(dateEntry + 4))).replace(/\0.*$/, '');
            const match = text.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
            if (match) capturedAt = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])).toISOString();
          }
        }
        const ascii = (entry: number) => {
          const count = u32(entry + 4);
          const at = count <= 4 ? entry + 8 : tiff + u32(entry + 8);
          return String.fromCharCode(...bytes.slice(at, at + count)).replace(/\0.*$/, '');
        };
        const rationalTriplet = (entry: number) => {
          if (!entry) return undefined;
          const at = tiff + u32(entry + 8);
          const values = [0, 1, 2].map(i => {
            const numerator = u32(at + i * 8);
            const denominator = u32(at + i * 8 + 4);
            return denominator ? numerator / denominator : 0;
          });
          return values[0] + values[1] / 60 + values[2] / 3600;
        };
        let latitude: number | undefined; let longitude: number | undefined; let altitudeMeters: number | undefined;
        if (gpsEntry) {
          const gpsIfd = tiff + u32(gpsEntry + 8);
          const latRefEntry = find(gpsIfd, 1); const latEntry = find(gpsIfd, 2);
          const lonRefEntry = find(gpsIfd, 3); const lonEntry = find(gpsIfd, 4);
          latitude = rationalTriplet(latEntry); longitude = rationalTriplet(lonEntry);
          if (latitude != null && latRefEntry && ascii(latRefEntry) === 'S') latitude *= -1;
          if (longitude != null && lonRefEntry && ascii(lonRefEntry) === 'W') longitude *= -1;
          const altRef = find(gpsIfd, 5); const altEntry = find(gpsIfd, 6);
          if (altEntry) {
            const at = tiff + u32(altEntry + 8);
            const divisor = u32(at + 4);
            altitudeMeters = divisor ? u32(at) / divisor * (altRef && bytes[altRef + 8] === 1 ? -1 : 1) : undefined;
          }
        }
        return { capturedAt, latitude, longitude, altitudeMeters };
      }
      cursor += length + 2;
    }
  } catch { /* Unsupported or malformed metadata remains editable by hand. */ }
  return {};
}

function AppShell() {
  const [flights, setFlights] = useState<Flight[]>([]);
  const [media, setMedia] = useState<MediaRecord[]>([]);
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState('');
  const [location] = useLocation();
  const [mobileNav, setMobileNav] = useState(false);
  const refresh = async () => {
    try {
      const [f, m] = await Promise.all([listFlights(), listMedia()]);
      setFlights(f.sort((a, b) => b.flightDate.localeCompare(a.flightDate)));
      setMedia(m.sort((a, b) => (b.capturedAt || '').localeCompare(a.capturedAt || '')));
      setStorageError('');
    } catch (error) { setStorageError(error instanceof Error ? error.message : 'Local database unavailable.'); }
    finally { setReady(true); }
  };
  useEffect(() => { void refresh(); }, []);
  const onUpload = async (files: FileList | File[], flightId?: string) => {
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) continue;
      const exif = await readExif(file);
      await saveMedia({ id: newId(), flightId, filename: file.name, mimeType: file.type || 'application/octet-stream', sizeBytes: file.size, capturedAt: exif.capturedAt || (file.lastModified ? new Date(file.lastModified).toISOString() : undefined), latitude: exif.latitude, longitude: exif.longitude, altitudeMeters: exif.altitudeMeters, notes: '', blob: file });
    }
    await refresh();
  };
  const title = navItems.find(item => item.href === location)?.label || 'Overview';
  const shared = { flights, media, ready, refresh, onUpload };
  return <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`}>
        <div className="brand-lockup">
          <div className="brand-icon"><Compass size={19}/></div>
          <div><div className="brand-name">FIELDNOTE<span> / AIR</span></div><div className="brand-caption">FLIGHT RECORDS</div></div>
          <button className="icon-button mobile-close" aria-label="Close navigation" onClick={() => setMobileNav(false)} data-testid="button-close-navigation"><X size={18}/></button>
        </div>
        <div className="workspace-label">WORKSPACE</div>
        <nav aria-label="Main navigation" className="nav-list">{navItems.map(({ href, label, icon: Icon }) =>
          <Link href={href} key={href} className={`nav-item ${location === href ? 'nav-active' : ''}`} data-testid={`link-nav-${label.toLowerCase().replaceAll(' ', '-')}`} onClick={() => setMobileNav(false)}>
            <Icon size={17}/><span>{label}</span>{href === '/library' && media.length > 0 && <span className="nav-count">{media.length}</span>}
          </Link>)}</nav>
        <div className="sidebar-spacer"/>
        <div className="privacy-card">
          <div className="privacy-icon"><ShieldCheck size={17}/></div>
          <div><strong>Your files stay here</strong><p>Flight notes and media are stored in this browser only.</p></div>
          <span className="local-indicator"><i/>LOCAL</span>
        </div>
        <div className="sidebar-footer"><span className="status-dot"/><span>Local storage ready</span><span className="version">v1.0</span></div>
      </aside>
      {mobileNav && <button aria-label="Close navigation overlay" className="nav-overlay" onClick={() => setMobileNav(false)} data-testid="button-navigation-overlay"/>}
      <main className="main-area">
        <header className="topbar">
          <button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMobileNav(true)} data-testid="button-open-navigation"><Menu size={19}/></button>
          <div className="breadcrumb"><span>FIELDNOTE / AIR</span><span className="crumb-slash">/</span><strong>{title}</strong></div>
          <div className="topbar-right"><span className="topbar-storage"><span className="status-dot"/>On this device</span><Link href="/settings" className="topbar-icon" aria-label="Settings" data-testid="link-settings-top"><Settings size={17}/></Link></div>
        </header>
        {storageError && <div className="storage-alert" role="alert"><CircleHelp size={18}/><span>{storageError} You can retry by reloading the page.</span><button onClick={() => void refresh()} data-testid="button-retry-storage">Retry</button></div>}
        {!ready ? <div className="page-wrap"><div className="skeleton-head"/><div className="skeleton-row"/><div className="skeleton-panel"/></div> :
          <Switch>
            <Route path="/" component={() => <Overview {...shared}/>}/>
            <Route path="/flights" component={() => <FlightsPage {...shared}/>}/>
            <Route path="/library" component={() => <LibraryPage {...shared}/>}/>
            <Route path="/map" component={() => <MapPage {...shared}/>}/>
            <Route path="/settings" component={() => <SettingsPage {...shared}/>}/>
            <Route><NotFoundPage/></Route>
          </Switch>}
      </main>
    </div>;
}
function App() { return <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><AppShell/></WouterRouter>; }

function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="page-heading fade-up"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action && <div className="heading-action">{action}</div>}</div>;
}
function Stat({ label, value, detail, icon: Icon }: { label: string; value: string | number; detail: string; icon: typeof Camera }) {
  return <div className="stat-card"><div className="stat-top"><span>{label}</span><span className="stat-icon"><Icon size={16}/></span></div><div className="stat-value">{value}</div><div className="stat-detail">{detail}</div></div>;
}
function Overview({ flights, media, ready, onUpload }: PageProps) {
  const latest = media.slice(0, 4);
  const totalBytes = media.reduce((sum, m) => sum + m.sizeBytes, 0);
  return <div className="page-wrap">
    <PageHeading eyebrow="FIELD OVERVIEW · LOCAL NOTEBOOK" title="Good work starts with a clear record." description="A private, practical place for inspection flights and the media they produce." action={<Link className="button button-primary" href="/flights" data-testid="button-new-flight"><Plus size={16}/>New flight</Link>}/>
    <section className="welcome-strip"><div className="welcome-mark"><Plane size={23}/><span>01</span></div><div><div className="welcome-kicker">READY FOR YOUR NEXT FIELD DAY</div><h2>Keep the flight. Keep the context.</h2><p>Log an authorized inspection, bring in captures from your device, and keep the record in your hands.</p></div><Link href="/library" className="welcome-link" data-testid="link-import-media">Add media <ArrowDownToLine size={15}/></Link></section>
    <section className="stats-grid" aria-label="Saved data summary">
      <Stat label="FLIGHTS LOGGED" value={flights.length} detail={flights.length ? `${flights.length === 1 ? 'One record' : 'Across your notebook'}` : 'No flight records yet'} icon={Plane}/>
      <Stat label="CAPTURES SAVED" value={media.length} detail={media.length ? `${media.filter(m => m.mimeType.startsWith('video/')).length} video${media.filter(m => m.mimeType.startsWith('video/')).length === 1 ? '' : 's'} · ${media.filter(m => m.mimeType.startsWith('image/')).length} images` : 'Photos and video live here'} icon={Camera}/>
      <Stat label="DEVICE STORAGE" value={bytes(totalBytes)} detail="Original files in this browser" icon={HardDrive}/>
    </section>
    <div className="overview-grid">
      <section className="panel recent-panel"><div className="panel-heading"><div><div className="eyebrow">LATEST ACTIVITY</div><h2>Recent captures</h2></div><Link href="/library" className="text-link" data-testid="link-all-captures">View library <span>→</span></Link></div>
        {latest.length ? <div className="recent-list">{latest.map((item, index) => <MediaRow key={item.id} item={item} flights={flights} index={index}/>)}</div> : <EmptyState icon={Camera} title="Your library is waiting" description="Import photos or video from your device. They stay in this browser." action={<label className="button button-primary file-chooser"><Upload size={15}/>Import media<input type="file" multiple accept="image/*,video/*" onChange={e => e.currentTarget.files && void onUpload(e.currentTarget.files)} data-testid="input-overview-upload"/></label>}/>}</section>
      <section className="panel flights-panel"><div className="panel-heading"><div><div className="eyebrow">FIELD LOG</div><h2>Recent flights</h2></div><Link href="/flights" className="text-link" data-testid="link-all-flights">All flights <span>→</span></Link></div>
        {flights.length ? <div className="flight-mini-list">{flights.slice(0, 4).map(f => <Link href="/flights" key={f.id} className="flight-mini" data-testid={`row-recent-flight-${f.id}`}><span className="flight-mini-symbol"><Plane size={15}/></span><span className="flight-mini-main"><strong>{f.name}</strong><small>{f.droneModel || 'Drone not specified'}</small></span><span className="flight-mini-date mono">{prettyDate(f.flightDate)}</span></Link>)}</div> : <EmptyState icon={Archive} title="No flights recorded" description="Start with the date, aircraft, and a short field note." action={<Link href="/flights" className="text-link" data-testid="link-create-first-flight">Create first flight →</Link>}/>}
      </section>
    </div>
    <div className="quiet-note"><ShieldCheck size={15}/><span>Private by default</span><p>Your records are stored locally. Nothing is uploaded to a flight-log server.</p><Link href="/settings" data-testid="link-storage-details">Storage details</Link></div>
  </div>;
}
function EmptyState({ icon: Icon, title, description, action }: { icon: typeof Camera; title: string; description: string; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon"><Icon size={20}/></span><h3>{title}</h3><p>{description}</p>{action && <div className="empty-action">{action}</div>}</div>;
}
function MediaRow({ item, flights, index }: { item: MediaRecord; flights: Flight[]; index: number }) {
  return <div className="media-row" data-testid={`row-media-${item.id}`}><span className={`media-type ${item.mimeType.startsWith('video/') ? 'video' : ''}`}>{item.mimeType.startsWith('video/') ? <FileVideo size={16}/> : <FileImage size={16}/>}</span><div className="media-row-main"><strong>{item.filename}</strong><small>{prettyTime(item.capturedAt)} <span>·</span> {flightName(flights, item.flightId)}</small></div><span className="media-size mono">{bytes(item.sizeBytes)}</span><span className="row-index mono">{String(index + 1).padStart(2, '0')}</span></div>;
}

function FlightsPage({ flights, media, ready, refresh }: PageProps) {
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Flight | null | 'new'>(null);
  const [error, setError] = useState('');
  const filtered = flights.filter(f => `${f.name} ${f.droneModel} ${f.notes} ${f.flightDate}`.toLowerCase().includes(query.toLowerCase()));
  const commit = async (data: Omit<Flight, 'id' | 'createdAt'>, id?: string) => {
    try { await saveFlight({ ...data, id: id || newId(), createdAt: id ? flights.find(f => f.id === id)?.createdAt || new Date().toISOString() : new Date().toISOString() }); await refresh(); setEditing(null); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save flight.'); }
  };
  const del = async (flight: Flight) => {
    if (!window.confirm(`Delete “${flight.name}”? Its media will remain saved but become unassigned.`)) return;
    await removeFlight(flight.id);
    await Promise.all(media.filter(m => m.flightId === flight.id).map(m => saveMedia({ ...m, flightId: undefined })));
    await refresh();
  };
  return <div className="page-wrap">
    <PageHeading eyebrow={`FIELD LOG · ${flights.length} RECORDS`} title="Flights" description="Keep the operational context that makes each capture useful." action={<button className="button button-primary" onClick={() => setEditing('new')} data-testid="button-add-flight"><Plus size={16}/>Log a flight</button>}/>
    <div className="toolbar"><label className="search-box"><Search size={16}/><input aria-label="Search flights" placeholder="Search by name, aircraft, or notes" value={query} onChange={e => setQuery(e.target.value)} data-testid="input-search-flights"/></label><span className="toolbar-count mono">{filtered.length} / {flights.length} FLIGHTS</span></div>
    {error && <div className="inline-error" role="alert">{error}</div>}
    {filtered.length ? <div className="panel table-panel"><div className="table-head"><span>FLIGHT / AIRCRAFT</span><span>DATE</span><span>DURATION</span><span>CAPTURES</span><span>ACTIONS</span></div>{filtered.map((flight, index) => <div className="flight-row" key={flight.id} data-testid={`row-flight-${flight.id}`}><span className="flight-title-cell"><span className="flight-row-number mono">{String(index + 1).padStart(2, '0')}</span><span className="flight-row-icon"><Plane size={16}/></span><span><strong>{flight.name}</strong><small>{flight.droneModel || 'Aircraft not specified'}</small></span></span><span className="table-date">{prettyDate(flight.flightDate)}</span><span className="table-duration mono">{flight.durationMinutes ? `${flight.durationMinutes} min` : '—'}</span><span className="table-captures">{media.filter(m => m.flightId === flight.id).length} files</span><span className="row-actions"><button aria-label={`Edit ${flight.name}`} className="icon-button" onClick={() => setEditing(flight)} data-testid={`button-edit-flight-${flight.id}`}><MoreHorizontal size={18}/></button><button aria-label={`Delete ${flight.name}`} className="icon-button danger-icon" onClick={() => void del(flight)} data-testid={`button-delete-flight-${flight.id}`}><Trash2 size={15}/></button></span></div>)}</div> :
      <EmptyState icon={query ? Search : Plane} title={query ? 'No flights match that search' : 'A clean log starts here'} description={query ? 'Try a different term or clear the search.' : 'Record authorized field work with the aircraft, date, duration, and notes you need.'} action={!query && <button className="button button-primary" onClick={() => setEditing('new')} data-testid="button-empty-add-flight"><Plus size={15}/>Log a flight</button>}/>}
    {editing && <FlightDialog flight={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSave={commit}/>}
  </div>;
}
function FlightDialog({ flight, onClose, onSave }: { flight?: Flight; onClose: () => void; onSave: (value: Omit<Flight, 'id' | 'createdAt'>, id?: string) => Promise<void> }) {
  const [name, setName] = useState(flight?.name || '');
  const [droneModel, setDrone] = useState(flight?.droneModel || '');
  const [flightDate, setDate] = useState(flight?.flightDate || new Date().toISOString().slice(0, 10));
  const [duration, setDuration] = useState(flight?.durationMinutes?.toString() || '');
  const [notes, setNotes] = useState(flight?.notes || '');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => { e.preventDefault(); if (!name.trim()) return; setBusy(true); await onSave({ name: name.trim(), droneModel: droneModel.trim(), flightDate, durationMinutes: duration ? Number(duration) : undefined, notes: notes.trim() }, flight?.id); setBusy(false); };
  return <div className="modal-scrim" role="presentation" onMouseDown={e => e.target === e.currentTarget && onClose()}><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="flight-dialog-title"><div className="modal-heading"><div><div className="eyebrow">{flight ? 'UPDATE FIELD RECORD' : 'NEW FIELD RECORD'}</div><h2 id="flight-dialog-title">{flight ? 'Edit flight' : 'Log a flight'}</h2></div><button className="icon-button" aria-label="Close" onClick={onClose} data-testid="button-close-flight-dialog"><X size={18}/></button></div><form onSubmit={e => void submit(e)} className="form-grid"><label className="field span-two"><span>Flight name <b>*</b></span><input required autoFocus maxLength={100} value={name} onChange={e => setName(e.target.value)} placeholder="North roof inspection" data-testid="input-flight-name"/></label><label className="field span-two"><span>Aircraft / drone model</span><input value={droneModel} onChange={e => setDrone(e.target.value)} placeholder="e.g. DJI Mavic 3 Enterprise" data-testid="input-flight-drone"/></label><label className="field"><span>Flight date <b>*</b></span><input required type="date" value={flightDate} onChange={e => setDate(e.target.value)} data-testid="input-flight-date"/></label><label className="field"><span>Duration · minutes</span><input type="number" min="1" max="1440" value={duration} onChange={e => setDuration(e.target.value)} placeholder="Optional" data-testid="input-flight-duration"/></label><label className="field span-two"><span>Field notes</span><textarea rows={3} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Inspection scope, conditions, or follow-up…" data-testid="input-flight-notes"/></label><div className="modal-actions"><button type="button" className="button button-quiet" onClick={onClose} data-testid="button-cancel-flight">Cancel</button><button type="submit" className="button button-primary" disabled={busy} data-testid="button-save-flight">{busy ? 'Saving…' : flight ? 'Save changes' : 'Save flight'}</button></div></form></section></div>;
}

function LibraryPage({ flights, media, refresh, onUpload }: PageProps) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [flightFilter, setFlightFilter] = useState('all');
  const [selected, setSelected] = useState<MediaRecord | null>(null);
  const [uploadFlight, setUploadFlight] = useState('');
  const [error, setError] = useState('');
  const filtered = media.filter(m => (kind === 'all' || (kind === 'image' ? m.mimeType.startsWith('image/') : m.mimeType.startsWith('video/'))) && (flightFilter === 'all' || m.flightId === flightFilter) && `${m.filename} ${m.notes}`.toLowerCase().includes(query.toLowerCase()));
  const handleUpload = async (files: FileList | null) => { if (!files?.length) return; try { await onUpload(files, uploadFlight || undefined); setError(''); } catch (e) { setError(e instanceof Error ? e.message : 'Could not save these files. Check browser storage space.'); } };
  const updateRecord = async (next: MediaRecord) => { await saveMedia(next); await refresh(); setSelected(next); };
  const deleteRecord = async (item: MediaRecord) => { if (!window.confirm(`Delete ${item.filename} from this browser?`)) return; await removeMedia(item.id); setSelected(null); await refresh(); };
  return <div className="page-wrap">
    <PageHeading eyebrow={`LOCAL FILE CABINET · ${media.length} SAVED`} title="Media library" description="Browse original files, connect them to a flight, and keep capture details close." action={<label className="button button-primary file-chooser"><Upload size={16}/>Import media<input type="file" multiple accept="image/*,video/*" onChange={e => void handleUpload(e.currentTarget.files)} data-testid="input-library-upload"/></label>}/>
    <div className="import-hint"><span className="hint-mark"><ArrowDownToLine size={16}/></span><span><strong>Bring files in from your device</strong><small>Choose exports from DJI Fly, an SD card, or any local folder. Original media is not uploaded.</small></span><label className="field-inline"><span>Associate with flight</span><select aria-label="Associate imported media with flight" value={uploadFlight} onChange={e => setUploadFlight(e.target.value)} data-testid="select-upload-flight"><option value="">Leave unassigned</option>{flights.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label></div>
    <div className="toolbar library-toolbar"><label className="search-box"><Search size={16}/><input aria-label="Search media" placeholder="Search file names and notes" value={query} onChange={e => setQuery(e.target.value)} data-testid="input-search-media"/></label><label className="filter-select"><Filter size={15}/><select aria-label="Filter media type" value={kind} onChange={e => setKind(e.target.value)} data-testid="select-media-type"><option value="all">All media</option><option value="image">Photos</option><option value="video">Videos</option></select></label><label className="filter-select"><select aria-label="Filter by flight" value={flightFilter} onChange={e => setFlightFilter(e.target.value)} data-testid="select-media-flight"><option value="all">All flights</option>{flights.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select><ChevronDown size={14}/></label><span className="toolbar-count mono">{filtered.length} FILES</span></div>
    {error && <div className="inline-error" role="alert">{error}</div>}
    {filtered.length ? <div className="media-grid">{filtered.map((item, i) => <MediaCard item={item} flights={flights} index={i} onOpen={() => setSelected(item)} key={item.id}/>)}</div> :
      <EmptyState icon={media.length ? Search : Camera} title={media.length ? 'No media in this view' : 'No captures saved yet'} description={media.length ? 'Adjust the search or filters to see other files.' : 'Import local photos or video. Files and details remain on this device.'} action={!media.length && <label className="button button-primary file-chooser"><Upload size={15}/>Choose files<input type="file" multiple accept="image/*,video/*" onChange={e => void handleUpload(e.currentTarget.files)} data-testid="input-empty-library-upload"/></label>}/>}
    {selected && <MediaDialog item={selected} flights={flights} onClose={() => setSelected(null)} onSave={updateRecord} onDelete={() => void deleteRecord(selected)}/>}
  </div>;
}
function MediaCard({ item, flights, index, onOpen }: { item: MediaRecord; flights: Flight[]; index: number; onOpen: () => void }) {
  const [url, setUrl] = useState('');
  useEffect(() => { const object = URL.createObjectURL(item.blob); setUrl(object); return () => URL.revokeObjectURL(object); }, [item.blob]);
  return <button className="media-card" onClick={onOpen} data-testid={`card-media-${item.id}`} aria-label={`Preview ${item.filename}`}><span className="media-preview">{url && item.mimeType.startsWith('image/') ? <img src={url} alt={item.filename}/> : <span className="preview-fallback">{item.mimeType.startsWith('video/') ? <FileVideo size={24}/> : <FileImage size={24}/>}<small>{item.mimeType.startsWith('video/') ? 'VIDEO FILE' : 'IMAGE FILE'}</small></span>}{item.mimeType.startsWith('video/') && <span className="video-tag">VIDEO</span>}<span className="card-sequence mono">{String(index + 1).padStart(2, '0')}</span></span><span className="media-card-info"><strong title={item.filename}>{item.filename}</strong><span>{flightName(flights, item.flightId)}<i/> {prettyDate(item.capturedAt)}</span><small className="mono">{bytes(item.sizeBytes)} · {item.mimeType.split('/')[1]?.toUpperCase()}</small></span></button>;
}
function MediaDialog({ item, flights, onClose, onSave, onDelete }: { item: MediaRecord; flights: Flight[]; onClose: () => void; onSave: (item: MediaRecord) => Promise<void>; onDelete: () => void }) {
  const [notes, setNotes] = useState(item.notes);
  const [flightId, setFlightId] = useState(item.flightId || '');
  const [capturedAt, setCapturedAt] = useState(item.capturedAt?.slice(0, 16) || '');
  const [latitude, setLatitude] = useState(item.latitude?.toString() || '');
  const [longitude, setLongitude] = useState(item.longitude?.toString() || '');
  const [altitude, setAltitude] = useState(item.altitudeMeters?.toString() || '');
  const [objectUrl, setObjectUrl] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => { const u = URL.createObjectURL(item.blob); setObjectUrl(u); return () => URL.revokeObjectURL(u); }, [item.blob]);
  const commit = async (e: FormEvent) => { e.preventDefault(); await onSave({ ...item, flightId: flightId || undefined, notes, capturedAt: capturedAt ? new Date(capturedAt).toISOString() : undefined, latitude: latitude ? Number(latitude) : undefined, longitude: longitude ? Number(longitude) : undefined, altitudeMeters: altitude ? Number(altitude) : undefined }); setSaved(true); setTimeout(() => setSaved(false), 1800); };
  return <div className="modal-scrim" role="presentation" onMouseDown={e => e.target === e.currentTarget && onClose()}><section className="modal-card media-modal" role="dialog" aria-modal="true" aria-labelledby="media-dialog-title"><div className="modal-heading"><div><div className="eyebrow">CAPTURE DETAILS</div><h2 id="media-dialog-title">{item.filename}</h2></div><button className="icon-button" aria-label="Close preview" onClick={onClose} data-testid="button-close-media-dialog"><X size={18}/></button></div><div className="media-dialog-layout"><div className="large-preview">{item.mimeType.startsWith('image/') ? <img src={objectUrl} alt={item.filename}/> : item.mimeType.startsWith('video/') ? <video src={objectUrl} controls/> : <FileImage size={35}/>}</div><form className="media-metadata" onSubmit={e => void commit(e)}><div className="file-detail mono">{bytes(item.sizeBytes)} <span>·</span> {item.mimeType}</div><label className="field"><span>Flight association</span><select value={flightId} onChange={e => setFlightId(e.target.value)} data-testid="select-edit-media-flight"><option value="">Unassigned</option>{flights.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label><label className="field"><span>Capture date & time</span><input type="datetime-local" value={capturedAt} onChange={e => setCapturedAt(e.target.value)} data-testid="input-media-captured-at"/></label><div className="coordinate-fields"><label className="field"><span>Latitude</span><input type="number" step="any" min="-90" max="90" value={latitude} onChange={e => setLatitude(e.target.value)} placeholder="Optional" data-testid="input-media-latitude"/></label><label className="field"><span>Longitude</span><input type="number" step="any" min="-180" max="180" value={longitude} onChange={e => setLongitude(e.target.value)} placeholder="Optional" data-testid="input-media-longitude"/></label></div><label className="field"><span>Altitude · meters</span><input type="number" step="any" value={altitude} onChange={e => setAltitude(e.target.value)} placeholder="Optional" data-testid="input-media-altitude"/></label><label className="field"><span>Notes</span><textarea rows={3} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Capture context…" data-testid="input-media-notes"/></label><div className="metadata-actions"><button type="button" className="button button-quiet danger-text" onClick={onDelete} data-testid={`button-delete-media-${item.id}`}><Trash2 size={14}/>Delete</button><button className="button button-primary" type="submit" data-testid="button-save-media">{saved ? <><Check size={15}/>Saved</> : 'Save details'}</button></div><p className="metadata-footnote">GPS and capture time can be entered manually when they are not available in the file.</p></form></div></section></div>;
}

type NearbyPlace = { name?: string; type?: string; lat: number; lon: number; distance?: number };
function MapPage({ media }: PageProps) {
  const geoMedia = media.filter(m => Number.isFinite(m.latitude) && Number.isFinite(m.longitude));
  const [active, setActive] = useState<MediaRecord | null>(geoMedia[0] || null);
  const [places, setPlaces] = useState<NearbyPlace[]>([]);
  const [lookupState, setLookupState] = useState<'idle'|'loading'|'done'|'error'>('idle');
  const center = active && active.latitude != null && active.longitude != null ? { lat: active.latitude, lon: active.longitude } : geoMedia[0] ? { lat: geoMedia[0].latitude!, lon: geoMedia[0].longitude! } : { lat: 0, lon: 0 };
  const externalMapLinks = active && active.latitude != null && active.longitude != null ? getExternalMapLinks(active.latitude, active.longitude) : null;
  const zoom = 14;
  const centerXY = tileXY(center.lat, center.lon, zoom);
  const tile0x = Math.floor(centerXY.x); const tile0y = Math.floor(centerXY.y);
  const pointPosition = (lat: number, lon: number) => {
    const point = tileXY(lat, lon, zoom);
    return { left: `${(point.x - tile0x) * 256 + 256}px`, top: `${(point.y - tile0y) * 256 + 256}px` };
  };
  const lookup = async () => {
    if (!geoMedia.length) return;
    const last = Number(localStorage.getItem('fieldnote-overpass-last') || 0);
    if (Date.now() - last < 15000) { setLookupState('error'); return; }
    setLookupState('loading'); setPlaces([]);
    try {
      localStorage.setItem('fieldnote-overpass-last', String(Date.now()));
      const query = `[out:json][timeout:15];(node(around:700,${center.lat},${center.lon})[shop];node(around:700,${center.lat},${center.lon})[office];node(around:700,${center.lat},${center.lon})[amenity~"restaurant|cafe|fuel|bank|pharmacy"];way(around:700,${center.lat},${center.lon})[shop];way(around:700,${center.lat},${center.lon})[office];way(around:700,${center.lat},${center.lon})[amenity~"restaurant|cafe|fuel|bank|pharmacy"];);out center tags 30;`;
      const response = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: `data=${encodeURIComponent(query)}` });
      if (!response.ok) throw new Error('Nearby context service did not respond.');
      const json = await response.json();
      const rows = (json.elements || []).map((e: { lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string,string> }) => ({ name: e.tags?.name || e.tags?.shop || e.tags?.office || e.tags?.amenity || 'Public business', type: e.tags?.shop || e.tags?.office || e.tags?.amenity || 'place', lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon })).filter((p: NearbyPlace) => Number.isFinite(p.lat) && Number.isFinite(p.lon)).map((p: NearbyPlace) => ({ ...p, distance: Math.round(distanceMeters(center.lat, center.lon, p.lat, p.lon)) })).sort((a: NearbyPlace, b: NearbyPlace) => (a.distance || 0) - (b.distance || 0));
      setPlaces(rows.slice(0, 20)); setLookupState('done');
    } catch { setLookupState('error'); }
  };
  return <div className="page-wrap map-page">
    <PageHeading eyebrow={`GEOTAGGED CAPTURES · ${geoMedia.length} · OPEN MAP DATA`} title="Capture map" description="See where your own geotagged captures were made. Nearby public businesses are optional context."/>
    <div className="map-controls"><div className="map-record-count"><span className="map-pin-icon"><MapPin size={17}/></span><span><strong>{geoMedia.length} geotagged {geoMedia.length === 1 ? 'capture' : 'captures'}</strong><small>Only your saved media coordinates appear as markers</small></span></div><button className="button button-outline" onClick={() => void lookup()} disabled={!geoMedia.length || lookupState === 'loading'} data-testid="button-nearby-businesses">{lookupState === 'loading' ? 'Looking nearby…' : <><Search size={15}/>Find nearby public businesses</>}</button></div>
    <div className="map-layout"><section className="map-canvas" aria-label="OpenStreetMap map showing geotagged captures">{geoMedia.length > 0 && <><div className="map-grid">{[-1,0,1].flatMap(dx => [-1,0,1].map(dy => <img key={`${dx}-${dy}`} alt="" draggable="false" src={`https://tile.openstreetmap.org/${zoom}/${tile0x + dx}/${tile0y + dy}.png`} style={{ left: `${(dx + 1) * 256}px`, top: `${(dy + 1) * 256}px`}}/>))}</div><div className="map-marker-layer">{geoMedia.map((m, i) => <button key={m.id} className={`capture-pin ${active?.id === m.id ? 'pin-active' : ''}`} style={pointPosition(m.latitude!, m.longitude!)} title={m.filename} aria-label={`Select capture ${m.filename}`} onClick={() => setActive(m)} data-testid={`map-marker-${m.id}`}><span>{i + 1}</span></button>)}{places.map((p,i) => <span key={`${p.lat}-${p.lon}-${i}`} className="business-marker" style={pointPosition(p.lat,p.lon)} title={p.name}>B</span>)}</div><div className="map-attribution">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a></div><div className="map-coordinates mono">{center.lat.toFixed(5)}° {center.lon.toFixed(5)}°</div></>}{!geoMedia.length && <div className="map-no-data"><MapPin size={28}/><strong>No coordinates recorded</strong><span>Media you geotag will appear on the map. Nothing is shown until your files have location data.</span></div>}</section>
      <aside className="map-aside"><div className="map-aside-header"><div className="eyebrow">FIELD CONTEXT</div><h2>{active ? 'Selected capture' : 'Your map is ready'}</h2></div>{active ? <div className="selected-capture"><div className="selected-marker"><MapPin size={16}/></div><strong>{active.filename}</strong><span>{prettyTime(active.capturedAt)}</span><div className="coords-card"><span>LAT / LON</span><strong className="mono">{active.latitude?.toFixed(5)}, {active.longitude?.toFixed(5)}</strong></div>{externalMapLinks && <div className="external-map-tools"><span className="external-map-label">STREET & BUSINESS DETAILS</span><div className="external-map-links"><a className="map-provider-link" href={externalMapLinks.google} target="_blank" rel="noopener noreferrer" aria-label="Open selected capture in Google Maps" data-testid="link-open-google-maps">Google Maps <ExternalLink size={12}/></a><a className="map-provider-link" href={externalMapLinks.apple} target="_blank" rel="noopener noreferrer" aria-label="Open selected capture in Apple Maps" data-testid="link-open-apple-maps">Apple Maps <ExternalLink size={12}/></a></div><p>Opens the selected location in a new tab. The map provider you choose receives its coordinates.</p></div>}</div> : <div className="map-empty"><MapPin size={22}/><p>Add GPS coordinates to a media item to see it here.</p></div>}
        <div className="map-divider"/><div className="nearby-title"><span>NEARBY PUBLIC BUSINESSES</span><span className="mono">{places.length ? places.length : '—'}</span></div>{lookupState === 'idle' && <p className="nearby-copy">Look up public business listings around a selected capture. No private individuals or property-owner information is queried.</p>}{lookupState === 'loading' && <div className="nearby-state"><span className="mini-loader"/>Checking public map data…</div>}{lookupState === 'error' && <div className="nearby-error" role="status">Lookup unavailable or temporarily rate-limited. Please wait a moment and try again.</div>}{lookupState === 'done' && (places.length ? <div className="place-list">{places.map((p,i) => <div className="place-row" key={`${p.lat}-${p.lon}-${i}`}><span className="place-symbol">B</span><span><strong>{p.name}</strong><small>{p.type}</small></span><span className="place-distance mono">{p.distance} m</span></div>)}</div> : <p className="nearby-copy">No public business listings found in this area. Try a capture with another coordinate.</p>)}<div className="map-source-note"><ShieldCheck size={14}/><span>Map tiles and optional business listings use OpenStreetMap. Google or Apple receives a capture coordinate only when you choose its link. No resident or property-owner information is requested.</span></div></aside></div>
    {geoMedia.length > 1 && <div className="map-capture-strip">{geoMedia.map((m,i) => <button key={m.id} className={`map-capture-chip ${active?.id === m.id ? 'chip-active' : ''}`} onClick={() => setActive(m)} data-testid={`button-select-map-capture-${m.id}`}><span className="mono">{String(i + 1).padStart(2,'0')}</span>{m.filename}</button>)}</div>}
  </div>;
}
function tileXY(lat: number, lon: number, zoom: number) {
  const n = 2 ** zoom; const x = (lon + 180) / 360 * n;
  const rad = lat * Math.PI / 180; const y = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n;
  return { x, y };
}
function getExternalMapLinks(lat: number, lon: number) {
  const point = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
  const google = new URL('https://www.google.com/maps/search/');
  google.searchParams.set('api', '1');
  google.searchParams.set('query', `businesses near ${point}`);
  const apple = new URL('https://maps.apple.com/');
  apple.searchParams.set('ll', point);
  apple.searchParams.set('q', `Businesses near ${point}`);
  return { google: google.toString(), apple: apple.toString() };
}
function distanceMeters(a: number, b: number, c: number, d: number) {
  const r = 6371000; const rad = (n: number) => n * Math.PI / 180; const x = rad(c-a), y = rad(d-b);
  return 2*r*Math.asin(Math.sqrt(Math.sin(x/2)**2+Math.cos(rad(a))*Math.cos(rad(c))*Math.sin(y/2)**2));
}

function SettingsPage({ flights, media, refresh }: PageProps) {
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const total = media.reduce((sum, m) => sum + m.sizeBytes, 0);
  const toBase64 = (blob: Blob) => new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] || ''); reader.onerror = () => reject(new Error('Could not package a media file.')); reader.readAsDataURL(blob); });
  const exportBackup = async () => {
    try {
      setError(''); setMessage('Preparing a complete archive…');
      const allMedia = await Promise.all(media.map(async m => ({ ...m, blob: undefined, base64: await toBase64(m.blob) })));
      const payload = { format: 'fieldnote-air-backup', version: 1, exportedAt: new Date().toISOString(), flights, media: allMedia };
      const file = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      const url = URL.createObjectURL(file); const a = document.createElement('a'); a.href = url; a.download = `fieldnote-air-backup-${new Date().toISOString().slice(0,10)}.json`; a.click(); URL.revokeObjectURL(url);
      setMessage(`Backup exported with ${flights.length} flight${flights.length === 1 ? '' : 's'} and ${media.length} media file${media.length === 1 ? '' : 's'}.`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Export failed.'); setMessage(''); }
  };
  const importBackup = async (file?: File) => {
    if (!file) return;
    try {
      setError(''); setMessage('Reading backup…');
      const data = JSON.parse(await file.text());
      if (data.format !== 'fieldnote-air-backup' || data.version !== 1 || !Array.isArray(data.flights) || !Array.isArray(data.media)) throw new Error('This does not appear to be a supported Fieldnote Air backup.');
      if (!window.confirm(`Replace this browser's ${flights.length} flight records and ${media.length} media files with ${data.flights.length} flights and ${data.media.length} files from the backup?`)) { setMessage('Restore cancelled.'); return; }
      const restoredMedia: MediaRecord[] = data.media.map((m: MediaRecord & { base64: string }) => {
        const binary = atob(m.base64 || ''); const bytesArr = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytesArr[i] = binary.charCodeAt(i);
        const { base64: _base64, ...record } = m as MediaRecord & { base64: string };
        return { ...record, blob: new Blob([bytesArr], { type: m.mimeType }) };
      });
      await replaceAll(data.flights, restoredMedia); await refresh(); setMessage(`Restored ${data.flights.length} flights and ${restoredMedia.length} media files.`); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Restore failed. Existing data has not been replaced.'); setMessage(''); }
  };
  return <div className="page-wrap">
    <PageHeading eyebrow="DEVICE CONTROLS · PRIVACY BY DESIGN" title="Settings & backup" description="Your notebook belongs to this browser profile. Make a portable backup before changing devices."/>
    <div className="settings-summary"><span className="settings-shield"><ShieldCheck size={20}/></span><div><strong>Stored on this device</strong><p>No account, server sync, or upload is involved. Browser storage can be cleared by device maintenance or private browsing.</p></div><span className="local-tag"><i/> LOCAL ONLY</span></div>
    <div className="settings-grid"><section className="panel settings-panel"><div className="settings-section-top"><div className="settings-icon"><Archive size={18}/></div><div><div className="eyebrow">PORTABLE ARCHIVE</div><h2>Backup your notebook</h2></div></div><p>Export a single file containing your flight records, media metadata, and original media binaries. Keep it somewhere safe; it may be large.</p><div className="backup-facts"><div><span>FLIGHT RECORDS</span><strong>{flights.length}</strong></div><div><span>MEDIA FILES</span><strong>{media.length}</strong></div><div><span>MEDIA SIZE</span><strong>{bytes(total)}</strong></div></div><button className="button button-primary full-button" onClick={() => void exportBackup()} data-testid="button-export-backup"><ArrowDownToLine size={16}/>Export complete backup</button><div className="backup-divider"/><label className="button button-outline full-button file-chooser"><ArrowUpFromLine size={16}/>Restore from backup<input type="file" accept="application/json,.json" onChange={e => void importBackup(e.currentTarget.files?.[0])} data-testid="input-import-backup"/></label><small className="settings-fineprint">Restore replaces all records in this browser. Export first if you want to keep them.</small>{message && <div className="success-message" role="status" data-testid="status-backup">{message}</div>}{error && <div className="inline-error" role="alert" data-testid="status-backup-error">{error}</div>}</section>
      <section className="panel settings-panel limits-panel"><div className="settings-section-top"><div className="settings-icon"><HardDrive size={18}/></div><div><div className="eyebrow">HONEST LIMITS</div><h2>Know where your data lives</h2></div></div><div className="limit-row"><span className="limit-bullet">01</span><div><strong>Browser storage varies</strong><p>Available space depends on your browser and device. Large video files may exceed local limits.</p></div></div><div className="limit-row"><span className="limit-bullet">02</span><div><strong>This browser is the notebook</strong><p>Data is not shared across devices or browser profiles. Clearing site data can remove it.</p></div></div><div className="limit-row"><span className="limit-bullet">03</span><div><strong>Backups include original media</strong><p>Export files may be large and contain embedded location metadata. Store and share them thoughtfully.</p></div></div><div className="limit-row"><span className="limit-bullet">04</span><div><strong>External map lookups</strong><p>OpenStreetMap tiles load over the network. Nearby business lookup sends capture coordinates to the public Overpass service only when requested.</p></div></div></section></div>
    <section className="panel dji-panel"><div className="dji-mark"><Plane size={18}/></div><div className="dji-copy"><div className="eyebrow">DJI FLY & SD CARD WORKFLOWS</div><h2>Bring in files you already exported.</h2><p>Choose media or exported files from DJI Fly or an SD card using your device's file picker. Direct connection varies by aircraft and device and is not implemented here. We do not claim live aircraft connection or universal DJI compatibility.</p></div><div className="dji-aside"><span>LOCAL IMPORT</span><strong>File picker</strong><small>No direct drone link</small></div></section>
    <div className="settings-footer"><span>FIELDNOTE / AIR</span><span>Built for authorized inspection work. Not for identifying or profiling people.</span></div>
  </div>;
}
function NotFoundPage() {
  return <div className="page-wrap"><PageHeading eyebrow="404 · FIELDNOTE / AIR" title="This page is off the flight plan." description="The page may have moved, or the address may be incomplete." action={<Link href="/" className="button button-primary" data-testid="link-return-overview">Back to overview</Link>}/></div>;
}
export default App;
