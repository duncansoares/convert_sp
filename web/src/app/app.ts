import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Subscription, interval } from 'rxjs';
import { switchMap, takeWhile } from 'rxjs/operators';
import { ApiService } from './core/api.service';
import type {
  ConnectionProfile,
  Destination,
  DirectoryListing,
  JobResult,
  JobStatus,
  OutputInspection,
  ProcedureSummary,
  ProfileInput,
} from './core/models';

type Step = 'profiles' | 'connection' | 'procedures' | 'options' | 'progress' | 'result';

type ColumnKey = 'procedure' | 'verb' | 'tables' | 'destination' | 'method' | 'params';

const COLUMN_STORAGE_KEY = 'convert-sp:column-widths';

const DEFAULT_COLUMN_WIDTHS: Record<ColumnKey, number> = {
  procedure: 230,
  verb: 62,
  tables: 330,
  destination: 180,
  method: 185,
  params: 60,
};

const MIN_COLUMN_WIDTHS: Record<ColumnKey, number> = {
  procedure: 150,
  verb: 48,
  tables: 120,
  destination: 110,
  method: 110,
  params: 44,
};

const MAX_COLUMN_WIDTH = 720;

function loadColumnWidths(): Record<ColumnKey, number> {
  const widths = { ...DEFAULT_COLUMN_WIDTHS };
  try {
    const raw = localStorage.getItem(COLUMN_STORAGE_KEY);
    if (!raw) {
      return widths;
    }
    const stored = JSON.parse(raw) as Partial<Record<ColumnKey, number>>;
    for (const key of Object.keys(DEFAULT_COLUMN_WIDTHS) as ColumnKey[]) {
      const value = stored[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        widths[key] = Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTHS[key], Math.round(value)));
      }
    }
  } catch {
    // Malformed or unavailable storage: fall back to the defaults.
  }
  return widths;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [ReactiveFormsModule],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  private readonly api = inject(ApiService);
  private readonly fb = inject(FormBuilder);

  readonly step = signal<Step>('profiles');
  readonly profiles = signal<ConnectionProfile[]>([]);
  readonly profileId = signal<string | null>(null);
  readonly database = signal('');
  readonly procedures = signal<ProcedureSummary[]>([]);
  readonly selected = signal<ReadonlySet<string>>(new Set());
  readonly filter = signal('');
  readonly verbFilter = signal<'all' | 'get' | 'post' | 'delete'>('all');
  readonly showSkipped = signal(false);
  readonly colWidths = signal<Record<ColumnKey, number>>(loadColumnWidths());
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  readonly logs = signal<string[]>([]);
  readonly job = signal<JobStatus | null>(null);
  readonly inspection = signal<OutputInspection | null>(null);
  readonly overwrite = signal<'safe' | 'force'>('safe');
  readonly browserOpen = signal(false);
  readonly browser = signal<DirectoryListing | null>(null);
  readonly databases = signal<string[]>([]);

  readonly form = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(80)]],
    server: ['localhost', [Validators.required]],
    port: [1433, [Validators.required, Validators.min(1), Validators.max(65535)]],
    instanceName: [''],
    database: ['', [Validators.required]],
    user: ['sa', [Validators.required]],
    password: [''],
    encrypt: [true],
    trustServerCertificate: [true],
    outputDir: ['', [Validators.required]],
    projectName: ['', [Validators.required]],
  });

  readonly stats = computed(() => {
    const all = this.procedures();
    const generated = all.filter((item) => item.destination.kind !== 'skipped');
    const skipped = all.length - generated.length;
    const multi = all.filter((item) => item.destination.kind === 'multitable').length;
    return { total: all.length, generated: generated.length, skipped, multi };
  });

  readonly visible = computed(() => {
    const term = this.filter().trim().toLowerCase();
    const verb = this.verbFilter();
    const skippedVisible = this.showSkipped();
    return this.procedures().filter((item) => {
      if (!skippedVisible && item.destination.kind === 'skipped') {
        return false;
      }
      if (verb !== 'all' && item.verb !== verb) {
        return false;
      }
      if (!term) {
        return true;
      }
      return (
        `${item.schema}.${item.name}`.toLowerCase().includes(term) ||
        item.tables.join(' ').toLowerCase().includes(term) ||
        item.methodName.toLowerCase().includes(term)
      );
    });
  });

  readonly selectedCount = computed(() => this.selected().size);

  readonly selectedSummary = computed(() => {
    const keys = this.selected();
    return this.procedures().filter((item) => keys.has(item.key));
  });

  private poll?: Subscription;

  constructor() {
    this.reloadProfiles();
  }

  // ---- profiles ---------------------------------------------------------

  reloadProfiles(): void {
    this.api.profiles().subscribe({
      next: (result) => this.profiles.set(result.profiles),
      error: (error: unknown) => this.fail(error),
    });
  }

  useProfile(profile: ConnectionProfile): void {
    this.profileId.set(profile.id);
    this.database.set(profile.database);
    this.fillForm(profile);
    this.loadProcedures(false);
  }

  editProfile(profile: ConnectionProfile): void {
    this.profileId.set(profile.id);
    this.fillForm(profile);
    this.step.set('connection');
  }

  deleteProfile(profile: ConnectionProfile): void {
    if (!window.confirm(`Delete profile "${profile.name}"?`)) {
      return;
    }
    this.api.deleteProfile(profile.id).subscribe({
      next: () => {
        if (this.profileId() === profile.id) {
          this.profileId.set(null);
        }
        this.reloadProfiles();
      },
      error: (error: unknown) => this.fail(error),
    });
  }

  newConnection(): void {
    this.profileId.set(null);
    this.form.reset({
      name: '',
      server: 'localhost',
      port: 1433,
      instanceName: '',
      database: '',
      user: 'sa',
      password: '',
      encrypt: true,
      trustServerCertificate: true,
      outputDir: '',
      projectName: '',
    });
    this.databases.set([]);
    this.step.set('connection');
  }

  private fillForm(profile: ConnectionProfile): void {
    this.form.reset({
      name: profile.name,
      server: profile.server,
      port: profile.port,
      instanceName: profile.instanceName ?? '',
      database: profile.database,
      user: profile.user,
      password: '',
      encrypt: profile.encrypt,
      trustServerCertificate: profile.trustServerCertificate,
      outputDir: profile.outputDir,
      projectName: profile.projectName,
    });
    this.inspection.set(null);
    if (profile.outputDir) {
      this.inspectOutput();
    }
  }

  // ---- connection -------------------------------------------------------

  testConnection(): void {
    const value = this.form.getRawValue();
    this.busy.set(true);
    this.error.set(null);
    this.notice.set(null);
    const request =
      !value.password && this.profileId()
        ? this.api.testProfile(this.profileId() as string)
        : this.api.testConnection({
            server: value.server,
            port: Number(value.port),
            instanceName: value.instanceName || null,
            database: value.database || 'master',
            user: value.user,
            password: value.password,
            encrypt: value.encrypt,
            trustServerCertificate: value.trustServerCertificate,
          });
    request.subscribe({
      next: (result) => {
        this.busy.set(false);
        this.notice.set(`Connected: ${result.version}`);
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.fail(error);
      },
    });
  }

  discoverDatabases(): void {
    const value = this.form.getRawValue();
    this.busy.set(true);
    this.error.set(null);
    this.api
      .databases({
        server: value.server,
        port: Number(value.port),
        instanceName: value.instanceName || null,
        user: value.user,
        password: value.password || '',
        encrypt: value.encrypt,
        trustServerCertificate: value.trustServerCertificate,
      })
      .subscribe({
        next: (result) => {
          this.busy.set(false);
          this.databases.set(result.databases);
          if (!value.database && result.databases.length > 0) {
            this.form.patchValue({ database: result.databases[0] });
          }
        },
        error: (error: unknown) => {
          this.busy.set(false);
          this.fail(error);
        },
      });
  }

  saveProfile(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.error.set('Fill in the required connection fields.');
      return;
    }
    const value = this.form.getRawValue();
    const projectName = value.projectName || `${value.database.toLowerCase()}-api`;
    if (!value.projectName) {
      this.form.patchValue({ projectName });
    }
    const input: ProfileInput = {
      name: value.name,
      server: value.server,
      port: Number(value.port),
      instanceName: value.instanceName || null,
      database: value.database,
      user: value.user,
      encrypt: value.encrypt,
      trustServerCertificate: value.trustServerCertificate,
      outputDir: value.outputDir,
      projectName,
      ...(value.password ? { password: value.password } : {}),
    };
    this.busy.set(true);
    this.error.set(null);
    this.api.saveProfile(input, this.profileId() ?? undefined).subscribe({
      next: (profile) => {
        this.busy.set(false);
        this.profileId.set(profile.id);
        this.database.set(profile.database);
        this.form.patchValue({ password: '' });
        this.reloadProfiles();
        this.loadProcedures(true);
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.fail(error);
      },
    });
  }

  // ---- procedures -------------------------------------------------------

  loadProcedures(refresh: boolean): void {
    const id = this.profileId();
    if (!id) {
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.api.procedures(id, refresh).subscribe({
      next: (result) => {
        this.busy.set(false);
        this.procedures.set(result.procedures);
        this.database.set(result.database);
        const generated = result.procedures
          .filter((item) => item.destination.kind !== 'skipped')
          .map((item) => item.key);
        this.selected.set(new Set(generated));
        this.step.set('procedures');
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.fail(error);
      },
    });
  }

  isSelected(key: string): boolean {
    return this.selected().has(key);
  }

  toggle(key: string): void {
    const next = new Set(this.selected());
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    this.selected.set(next);
  }

  toggleAll(checked: boolean): void {
    if (!checked) {
      this.selected.set(new Set());
      return;
    }
    this.selected.set(
      new Set(
        this.visible()
          .filter((item) => item.destination.kind !== 'skipped')
          .map((item) => item.key),
      ),
    );
  }

  allVisibleSelected(): boolean {
    const rows = this.visible().filter((item) => item.destination.kind !== 'skipped');
    if (rows.length === 0) {
      return false;
    }
    const keys = this.selected();
    return rows.every((row) => keys.has(row.key));
  }

  destinationLabel(destination: Destination): string {
    if (destination.kind === 'repository') {
      return destination.className;
    }
    if (destination.kind === 'multitable') {
      return destination.className;
    }
    return destination.reason;
  }

  destinationKind(destination: Destination): string {
    return destination.kind;
  }

  // ---- options ----------------------------------------------------------

  goToOptions(): void {
    if (this.selectedCount() === 0) {
      this.error.set('Select at least one procedure.');
      return;
    }
    this.error.set(null);
    this.step.set('options');
    this.inspectOutput();
  }

  inspectOutput(): void {
    const value = this.form.controls.outputDir.value;
    if (!value) {
      return;
    }
    this.api.inspectOutput(value).subscribe({
      next: (result) => this.inspection.set(result),
      error: () => this.inspection.set(null),
    });
  }

  openBrowser(): void {
    this.browserOpen.set(true);
    this.api
      .listDirectories(this.form.controls.outputDir.value || undefined)
      .subscribe({ next: (listing) => this.browser.set(listing) });
  }

  navigate(path: string): void {
    this.api.listDirectories(path).subscribe({ next: (listing) => this.browser.set(listing) });
  }

  chooseDirectory(path: string): void {
    this.form.patchValue({ outputDir: path });
    this.browserOpen.set(false);
    this.inspectOutput();
  }

  closeBrowser(): void {
    this.browserOpen.set(false);
  }

  // ---- generation -------------------------------------------------------

  generate(): void {
    const id = this.profileId();
    if (!id) {
      return;
    }
    const value = this.form.getRawValue();
    this.error.set(null);
    this.notice.set(null);
    this.logs.set([]);
    this.job.set(null);
    this.step.set('progress');
    this.api
      .generate({
        profileId: id,
        selectedKeys: [...this.selected()],
        outputDir: value.outputDir,
        projectName: value.projectName,
        overwrite: this.overwrite(),
      })
      .subscribe({
        next: ({ jobId }) => this.watchJob(jobId),
        error: (error: unknown) => {
          this.fail(error);
          this.step.set('options');
        },
      });
  }

  private watchJob(jobId: string): void {
    this.poll?.unsubscribe();
    this.poll = interval(700)
      .pipe(
        switchMap(() => this.api.job(jobId)),
        takeWhile((job) => job.state === 'running', true),
      )
      .subscribe({
        next: (job) => {
          this.job.set(job);
          this.logs.set(job.logs);
          if (job.state === 'done' && job.result) {
            this.step.set('result');
          }
          if (job.state === 'error') {
            this.error.set(job.error ?? 'Generation failed');
          }
        },
        error: (error: unknown) => this.fail(error),
      });
  }

  backToProcedures(): void {
    this.step.set('procedures');
  }

  startOver(): void {
    this.poll?.unsubscribe();
    this.job.set(null);
    this.logs.set([]);
    this.step.set('profiles');
  }

  openReport(): void {
    const job = this.job();
    if (job) {
      window.open(this.api.reportUrl(job.id), '_blank');
    }
  }

  result(): JobResult | null {
    return this.job()?.result ?? null;
  }

  counts(result: JobResult): Array<{ key: string; value: number }> {
    return Object.entries(result.counts).map(([key, value]) => ({ key, value }));
  }

  // ---- helpers ----------------------------------------------------------

  startColumnResize(event: PointerEvent, key: ColumnKey): void {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = this.colWidths()[key];
    const min = MIN_COLUMN_WIDTHS[key];
    document.body.classList.add('col-resizing');

    const move = (moveEvent: PointerEvent): void => {
      const width = Math.max(
        min,
        Math.min(MAX_COLUMN_WIDTH, startWidth + (moveEvent.clientX - startX)),
      );
      this.colWidths.update((widths) => ({ ...widths, [key]: Math.round(width) }));
    };
    const stop = (): void => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', stop);
      document.body.classList.remove('col-resizing');
      try {
        localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(this.colWidths()));
      } catch {
        // Storage is optional; the widths still apply for this session.
      }
    };

    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', stop);
  }

  resetColumns(): void {
    this.colWidths.set({ ...DEFAULT_COLUMN_WIDTHS });
    try {
      localStorage.removeItem(COLUMN_STORAGE_KEY);
    } catch {
      // Ignore storage failures.
    }
  }

  columnsAreDefault(): boolean {
    const widths = this.colWidths();
    return (Object.keys(DEFAULT_COLUMN_WIDTHS) as ColumnKey[]).every(
      (key) => widths[key] === DEFAULT_COLUMN_WIDTHS[key],
    );
  }

  private fail(error: unknown): void {
    if (error instanceof HttpErrorResponse) {
      this.error.set(error.error?.message ?? error.message);
      return;
    }
    this.error.set(error instanceof Error ? error.message : String(error));
  }
}
