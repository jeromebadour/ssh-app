// Invented data for the direction pictures. No real box, host, path or person appears here: hosts are in the
// documentation ranges (203.0.113.0/24, 198.51.100.0/24), names are made up for a small invoicing business.

export type BoxState = 'connected' | 'reconnecting' | 'idle';

export interface Box {
  name: string;
  host: string;
  hue: string; // the box's own colour, from a set that never clashes with the meaning colours
  state: BoxState;
  detail?: string;
  places: { name: string; open?: boolean }[];
}

export const groups: { name: string; boxes: Box[] }[] = [
  {
    name: 'Ledger',
    boxes: [
      { name: 'relay-fra', host: '203.0.113.24', hue: 'var(--box-1)', state: 'connected', places: [{ name: 'deploy', open: true }, { name: 'logs', open: true }, { name: 'staging' }] },
      { name: 'build-sg', host: '203.0.113.71', hue: 'var(--box-2)', state: 'connected', places: [{ name: 'ci-cache', open: true }, { name: 'images' }] },
      { name: 'vault-ams', host: '198.51.100.9', hue: 'var(--box-3)', state: 'reconnecting', detail: 'retry in 7 s', places: [{ name: 'backups', open: true }] },
    ],
  },
  {
    name: 'Studio',
    boxes: [
      { name: 'edge-nyc', host: '198.51.100.140', hue: 'var(--box-4)', state: 'idle', places: [{ name: 'web' }, { name: 'mail' }] },
      { name: 'lab-mini', host: '203.0.113.200', hue: 'var(--box-5)', state: 'idle', places: [] },
    ],
  },
];

export interface TabGroup {
  box: string;
  hue: string;
  state: BoxState;
  tabs: { place: string; active?: boolean; signal?: 'output' | 'done' | 'waiting' | 'running' }[];
}

export const tabGroups: TabGroup[] = [
  { box: 'relay-fra', hue: 'var(--box-1)', state: 'connected', tabs: [{ place: 'deploy', active: true, signal: 'running' }, { place: 'logs', signal: 'output' }] },
  { box: 'build-sg', hue: 'var(--box-2)', state: 'connected', tabs: [{ place: 'ci-cache', signal: 'done' }] },
  { box: 'vault-ams', hue: 'var(--box-3)', state: 'reconnecting', tabs: [{ place: 'backups' }] },
];

export interface FileRow {
  name: string;
  kind: 'up' | 'folder' | 'archive' | 'log' | 'text' | 'script';
  size?: string;
  bytes?: string;
  modified?: string;
  fresh?: boolean;
  selected?: boolean;
}

export const files: FileRow[] = [
  { name: '..', kind: 'up' },
  { name: 'releases', kind: 'folder', modified: '2026-11-15 18:02' },
  { name: 'rollback', kind: 'folder', modified: '2026-11-09 11:47' },
  { name: 'deploy-4f2c1a9.log', kind: 'log', size: '214 KB', modified: '2026-11-15 19:41', fresh: true },
  { name: 'ledger-4f2c1a9.tar.gz', kind: 'archive', size: '48.6 MB', modified: '2026-11-15 19:38', selected: true },
  { name: 'ledger-4e91b07.tar.gz', kind: 'archive', size: '48.1 MB', modified: '2026-11-12 09:15' },
  { name: 'migrate-041.sql', kind: 'text', size: '6.2 KB', modified: '2026-11-15 19:12' },
  { name: 'restore-check.sh', kind: 'script', size: '1.8 KB', modified: '2026-11-03 22:30' },
  { name: 'notes-2026-11-15.md', kind: 'text', size: '3.4 KB', modified: '2026-11-15 17:55' },
];

export const pins = ['/srv/staging', '/srv/ledger/app', '/var/log/ledger'];
export const recent = ['/srv/staging/releases', '/etc/nginx/sites-enabled', '/root', '/srv/ledger/app/scripts'];

// The terminal: command blocks. `out` lines carry a style class for the colours a real box would send.
export interface Block {
  cmd: string;
  out: [cls: string, text: string][];
  took?: string;
  running?: string;
}

export const prompt = { user: 'root', box: 'relay-fra', path: '/srv/staging' };

export const blocks: Block[] = [
  {
    cmd: 'docker compose -p ledger ps --format "table {{.Name}}\\t{{.Status}}"',
    out: [
      ['dim', 'NAME              STATUS'],
      ['', 'ledger-app-1      Up 3 days (healthy)'],
      ['', 'ledger-db-1       Up 3 days (healthy)'],
      ['', 'ledger-worker-1   Up 3 days'],
    ],
    took: '0.3 s',
  },
  {
    cmd: 'df -h /srv',
    out: [
      ['dim', 'Filesystem      Size  Used Avail Use% Mounted on'],
      ['', '/dev/vda1        96G   35G   62G  37% /'],
    ],
    took: '0.0 s',
  },
  {
    cmd: 'git -C /srv/ledger/app log -1 --oneline',
    out: [['', '4f2c1a9 Settle invoices in one pass (#212)']],
    took: '0.1 s',
  },
  {
    cmd: 'sha256sum ledger-4f2c1a9.tar.gz',
    out: [['', '9b03e7d1c4a8f62e05bd7a91e3c0f4d8a26b1e97c5d3f08a4be2c61d9f7a0b35  ledger-4f2c1a9.tar.gz']],
    took: '0.4 s',
  },
  {
    cmd: '/srv/ledger/app/scripts/deploy.sh 4f2c1a9 2>&1 | tee deploy-4f2c1a9.log',
    out: [
      ['dim', '[19:39:58] check   on main, CI green on 4f2c1a9'],
      ['dim', '[19:40:02] build   image ledger:4f2c1a9'],
      ['', ' => [build 4/9] RUN npm ci --ignore-scripts                          21.4s'],
      ['', ' => [build 6/9] RUN npm run build                                    38.9s'],
      ['', ' => exporting layers                                                  2.2s'],
      ['ok', '[19:41:07] migrate 041_invoice_batches.sql applied (1 of 1)'],
      ['dim', '[19:41:09] swap    ledger-app-2 started, waiting for health'],
      ['', '          health 1/10  503 starting'],
      ['', '          health 2/10  503 starting'],
      ['ok', '          health 3/10  200 ok'],
      ['dim', '[19:41:38] swap    routing to ledger-app-2'],
      ['dim', '[19:41:39] check   public site answers 200 in 212 ms'],
      ['dim', '[19:41:40] tools   collector, backup, restore test: timers installed'],
      ['', '          stopping ledger-app-1 (30 s grace)'],
    ],
    running: '1:42',
  },
];
