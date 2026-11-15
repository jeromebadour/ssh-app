// Berth's main window in use, as if it were finished, in its chosen direction (A, Chart). Built from the components the
// screens will be made of; drawn with invented data. A lab page: it exists to be pictured and chosen from.
//   ?scene=dialog    the "close a tab with a running command" dialog is open
//   ?scene=paths     the path bar's pinned and recent folders are open
//   ?scene=boxes     the Boxes menu is open
import { render } from 'preact';
import { blocks, files, groups, logCmd, logLines, pins, prompt, recent, tabGroups, type Box, type FileRow } from './data';
import { Glyph } from './glyphs';
import { Mark } from './marks';

const q = new URLSearchParams(location.search);
const scene = q.get('scene') ?? '';
// In the logs picture the logs tab is the one in front.
if (scene === 'logs') for (const g of tabGroups) for (const t of g.tabs) t.active = g.box === 'relay-fra' && t.place === 'logs';

const stateWords: Record<Box['state'], string> = { connected: 'connected', reconnecting: 'reconnecting', idle: 'not open' };

// The Boxes menu: your saved boxes, one line each, like a sessions menu. A box with places shows an arrow; its
// places open beside it on hover. Typing while the menu is open filters it (no field until you type).
function BoxMenu() {
  const all = groups.flatMap((g) => g.boxes);
  return (
    <div class="box-menu" role="menu" aria-label="Boxes">
      {all.map((b) => (
        <div class={`bm-row st-${b.state}`} key={b.name} role="menuitem" style={{ '--hue': b.hue }}>
          <span class="box-dot" />
          <span class="bm-name">{b.name}</span>
          {b.state !== 'idle' && <span class={`conn conn-${b.state}`} title={b.state} />}
          {b.places.length > 0 && <Glyph name="chevron" class="bm-more" />}
        </div>
      ))}
      <div class="bm-foot"><button class="bm-add"><Glyph name="plus" />Add box</button></div>
    </div>
  );
}

function TabBar() {
  return (
    <header class="tabbar">
      <div class="brand">
        <Mark />
        <span class="wordmark">Berth</span>
      </div>
      <button class={`boxes-btn ${scene === 'boxes' ? 'open' : ''}`} aria-haspopup="menu" aria-expanded={scene === 'boxes'}>
        <Glyph name="boxes" />Boxes<Glyph name="chevron" class="caret" />
      </button>
      <div class="tab-groups">
        {tabGroups.map((g) => (
          <div class={`tab-group st-${g.state}`} key={g.box} style={{ '--hue': g.hue }}>
            {g.tabs.map((t) => (
              <span class={`tab ${t.active ? 'active' : ''}`} key={t.place}>
                <span class={`conn conn-${g.state}`} title={stateWords[g.state]} />
                <span class="tab-box">{g.box}</span>
                <span class="tab-place">{t.place}</span>
                <span class="tab-end">
                  {t.signal === 'running' && <span class="sig sig-running">1:42</span>}
                  {t.signal === 'output' && <span class="sig sig-output" title="new output" />}
                  {t.signal === 'done' && <Glyph name="check" class="sig sig-done" label="command finished" />}
                  <Glyph name="close" class="tab-x" label="Close tab" />
                </span>
              </span>
            ))}
          </div>
        ))}
        <button class="new-tab" aria-label="Open a box"><Glyph name="plus" /></button>
      </div>
      <div class="bar-tools">
        <button class="tool" aria-label="Reopen last session"><Glyph name="reopen" /></button>
        <button class="tool" aria-label="Settings"><Glyph name="settings" /></button>
      </div>
    </header>
  );
}

function FileIcon(props: { row: FileRow }) {
  const k = props.row.kind;
  return <Glyph name={k === 'up' ? 'up' : k} class={`ft ft-${k}`} />;
}

function PathMenu() {
  return (
    <div class="path-menu" role="menu">
      <div class="pm-head"><Glyph name="pin" />Pinned on relay-fra</div>
      {pins.map((p, i) => (
        <div class={`pm-row ${i === 0 ? 'here' : ''}`} key={p} role="menuitem">
          <Glyph name="pin" class="pm-pin on" />
          <span class="pm-path">{p}</span>
          {i === 0 && <span class="pm-note">here</span>}
        </div>
      ))}
      <div class="pm-head">Recent in this tab<span class="pm-aside">not saved</span></div>
      {recent.map((p) => (
        <div class="pm-row" key={p} role="menuitem">
          <Glyph name="pin" class="pm-pin" />
          <span class="pm-path">{p}</span>
        </div>
      ))}
    </div>
  );
}

function FilePanel() {
  return (
    <section class="files" aria-label="Files on relay-fra">
      <div class="pathbar">
        <div class={`crumbs ${scene === 'paths' ? 'open' : ''}`}>
          <Glyph name="home" class="crumb-home" />
          <span class="crumb">srv</span>
          <Glyph name="chevron" class="crumb-sep" />
          <span class="crumb last">staging</span>
          <Glyph name="pin" class="crumb-pin on" label="Pinned" />
        </div>
        <span class="follow on" title="Following the terminal"><Glyph name="follow" /></span>
        {scene === 'paths' && <PathMenu />}
      </div>
      <div class="file-tools">
        <button class="ft-btn act-input"><Glyph name="upload" />Upload</button>
        <button class="ft-btn act-main"><Glyph name="download" />Download</button>
        <button class="ft-btn"><Glyph name="newFolder" />New folder</button>
        <button class="ft-btn icon-only" aria-label="Refresh"><Glyph name="refresh" /></button>
        <span class="chip"><Glyph name="hidden" />Hidden</span>
      </div>
      <div class="file-head">
        <span class="fh-name">Name</span>
        <span class="fh-size">Size</span>
        <span class="fh-date sorted">Modified</span>
      </div>
      <div class="file-rows">
        {files.map((f) => (
          <div class={`file ${f.selected ? 'selected' : ''} ${f.fresh ? 'fresh' : ''} k-${f.kind}`} key={f.name}>
            <FileIcon row={f} />
            <span class="f-name"><span class="f-text">{f.name}</span>{f.target && <span class="f-target">{f.target}</span>}{f.fresh && <span class="f-new">new</span>}</span>
            <span class="f-size">{f.size ?? ''}</span>
            <span class="f-date">{f.modified ?? ''}</span>
          </div>
        ))}
      </div>
      <div class="transfers">
        <div class="xfer done">
          <Glyph name="upload" class="x-dir act-input" />
          <div class="x-main">
            <div class="x-line"><span class="x-name">ledger-4f2c1a9.tar.gz</span><span class="x-size">48.6 MB</span></div>
            <div class="x-bar"><span style={{ width: '100%' }} /></div>
            <div class="x-line small"><span class="x-ok"><Glyph name="check" />sha-256 match</span><span class="x-md5">md5 3e7f…a91c</span><button class="x-copy" aria-label="Copy md5"><Glyph name="copy" /></button></div>
          </div>
        </div>
        <div class="xfer">
          <Glyph name="download" class="x-dir act-main" />
          <div class="x-main">
            <div class="x-line"><span class="x-name">deploy-4f2c1a9.log</span><span class="x-size">137 of 214 KB</span></div>
            <div class="x-bar"><span style={{ width: '64%' }} /></div>
            <div class="x-line small"><span>3.1 MB/s</span><span>under a second left</span><button class="x-stop" aria-label="Cancel"><Glyph name="stop" /></button></div>
          </div>
        </div>
      </div>
      <div class="file-foot">
        <span>{files.length - 1} items, 1 selected, 48.6 MB</span>
        <span class="free">61.2 GB free</span>
      </div>
    </section>
  );
}

function Prompt() {
  return (
    <span class="prompt">
      <span class="p-user">{prompt.user}@</span>
      <span class="p-box">{prompt.box}</span>
      <span class="p-path">:{prompt.path}</span>
      <span class="p-sigil"># </span>
    </span>
  );
}

// Word colouring, as offered: a small fixed set of rules, in the app's muted meaning colours, on top of whatever
// colours the box itself sends. Times and tags go quiet; failures and refusals take the problem colour; success
// and 2xx answers the checked colour; addresses the input colour. Nothing else is touched.
const RULES: [RegExp, string][] = [
  [/^\d{4}-\d{2}-\d{2}T[\d:.]+Z/, 'w-time'],
  [/\[[a-z]+\]/, 'w-tag'],
  [/\b(?:refused|failure|failed|error|timeout|disconnected|denied)\b|\b[45]\d\d(?= \d+ms)|\b(?:451|503)\b/i, 'w-bad'],
  [/\b(?:ok|verified|done|connected)\b|\b2\d\d(?= \d+ms)/i, 'w-good'],
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/, 'w-addr'],
];

function paint(line: string) {
  const parts: preact.JSX.Element[] = [];
  let rest = line;
  let key = 0;
  while (rest.length) {
    let best: { at: number; len: number; cls: string } | null = null;
    for (const [re, cls] of RULES) {
      const m = re.exec(rest);
      if (m && (best === null || m.index < best.at)) best = { at: m.index, len: m[0].length, cls };
    }
    if (!best) {
      parts.push(<span key={key++}>{rest}</span>);
      break;
    }
    if (best.at > 0) parts.push(<span key={key++}>{rest.slice(0, best.at)}</span>);
    parts.push(<span key={key++} class={best.cls}>{rest.slice(best.at, best.at + best.len)}</span>);
    rest = rest.slice(best.at + best.len);
  }
  return parts;
}

function Terminal() {
  if (scene === 'logs') {
    return (
      <section class="term" aria-label="Terminal on relay-fra">
        <div class="term-frame">
          <div class="scrolled-out">older output scrolled out</div>
          <div class="block running">
            <div class="gutter"><span class="g-mark" /><span class="g-time">6:10</span></div>
            <div class="block-body">
              <div class="line cmd"><Prompt />{logCmd}</div>
              {logLines.map((l, i) => <div class="line" key={i}>{paint(l)}</div>)}
            </div>
          </div>
        </div>
      </section>
    );
  }
  return (
    <section class="term" aria-label="Terminal on relay-fra">
      <div class="term-frame">
        <div class="scrolled-out">older output scrolled out</div>
        {blocks.map((b, i) => (
          <div class={`block ${b.running ? 'running' : ''}`} key={i}>
            <div class="gutter">
              <span class="g-mark" />
              <span class="g-time">{b.running ?? b.took}</span>
            </div>
            <div class="block-body">
              <div class="line cmd"><Prompt />{b.cmd}</div>
              {b.out.map(([cls, text], j) => (
                <div class={`line ${cls}`} key={j}>{text}</div>
              ))}
              {b.running && <div class="line"><span class="cursor" /></div>}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function StatusBar() {
  return (
    <footer class="status">
      <span class="s-conn"><span class="conn conn-connected" />relay-fra, deploy</span>
      <span class="s-rtt">round trip 248 ms</span>
      <span class="s-key"><Glyph name="key" />key made by Berth, ed25519</span>
      <span class="s-last"><Glyph name="check" class="act-checked" />Uploaded ledger-4f2c1a9.tar.gz, sha-256 match, 4.2 s</span>
      <span class="s-size">132 x 38</span>
    </footer>
  );
}

function CloseDialog() {
  return (
    <div class="scrim">
      <div class="dialog act-remove" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
        <h1 id="dlg-title">Close deploy on relay-fra?</h1>
        <p class="dlg-lead">A command is still running in this tab. Closing it ends the command on the box.</p>
        <div class="dlg-cmd">
          <span class="dlg-cmd-text">deploy.sh 4f2c1a9 2&gt;&amp;1 | tee deploy-4f2c1a9.log</span>
          <span class="dlg-cmd-time">running 1:42</span>
        </div>
        <div class="dlg-actions">
          <button class="btn keep" autofocus>Keep it open</button>
          <button class="btn danger"><Glyph name="close" />Close tab</button>
        </div>
      </div>
    </div>
  );
}

function Window() {
  return (
    <div class="window">
      <TabBar />
      {scene === 'boxes' && <BoxMenu />}
      <div class="body">
        <FilePanel />
        <Terminal />
      </div>
      <StatusBar />
      {scene === 'dialog' && <CloseDialog />}
    </div>
  );
}

render(<Window />, document.getElementById('app')!);
document.documentElement.classList.add('drawn');
