// Minimal vscode mock for vitest unit tests
import * as fsp from "fs/promises";

class ConfigurationValue {
  private data: Record<string, unknown>;

  constructor(data: Record<string, unknown> = {}) {
    this.data = data;
  }

  get<T>(key: string, defaultValue?: T): T {
    const val = this.data[key];
    return val !== undefined ? (val as T) : (defaultValue as T);
  }

  has(key: string): boolean {
    return key in this.data;
  }

  inspect<T>(key: string) {
    return { key, globalValue: this.data[key] as T | undefined };
  }

  update(_key: string, _value: unknown, _target?: unknown): Promise<void> {
    return Promise.resolve();
  }
}

const DEFAULT_CALCDOCS_CONFIG: Record<string, unknown> = {
  enabled: true,
  scanInterval: 0,
  ignoredDirs: [],
  enableCppProviders: true,
  useClangd: true,
  cppCacheMaxEntries: 24,
  thousandsSeparator: "none",
  internalDebugMode: "silent",
  resourceStatusMode: "always",
  resourceCpuThreshold: 70,
  "ui.invasiveness": "standard",
  "cpp.codeLens.enabled": true,
  "cpp.codeLens.maxItemsPerViewport": 40,
  "cpp.codeLens.maxItemsPerFile": 40,
  "cpp.codeLens.showAmbiguity": true,
  "cpp.codeLens.showCastOverflow": true,
  "cpp.codeLens.showMismatch": true,
  "cpp.codeLens.showOpenFormula": true,
  "cpp.codeLens.showResolvedValue": true,
  "cpp.codeLens.showExpandedPreview": true,
  "cpp.hover.enabled": true,
  "cpp.hover.maxConditionalDefinitions": 8,
  "cpp.hover.maxInDocumentDefinitions": 6,
  "cpp.hover.showConditionalDefinitions": true,
  "cpp.hover.showInDocumentDefinitions": true,
  "cpp.hover.showCastOverflow": true,
  "cpp.hover.showInheritedAmbiguity": true,
  "cpp.hover.showFormulaSection": true,
  "cpp.hover.showKnownValue": true,
  "inline.codeLens.enabled": true,
  "inline.codeLens.maxItemsPerViewport": 30,
  "inline.codeLens.maxItemsPerFile": 30,
  "inline.hover.enabled": true,
  "inline.hover.showDimension": true,
  "inline.hover.showWarnings": true,
  "inline.hover.showErrors": true,
  "inline.ghost.enabled": true,
  "inline.diagnostics.level": "warnings",
  "formulaHeader.outputPath": "macro_generate.h",
  "formulaHeader.includeResolvedValues": true,
};

const configStore: Record<string, Record<string, unknown>> = {
  calcdocs: { ...DEFAULT_CALCDOCS_CONFIG },
};

export const workspace = {
  getConfiguration(section?: string): ConfigurationValue {
    const data = section ? (configStore[section] ?? {}) : configStore;
    return new ConfigurationValue(data as Record<string, unknown>);
  },
  workspaceFolders: undefined as unknown[] | undefined,
  onDidChangeConfiguration: (_handler: unknown) => ({ dispose: () => {} }),
  onDidChangeTextDocument: (_handler: unknown) => ({ dispose: () => {} }),
  onDidSaveTextDocument: (_handler: unknown) => ({ dispose: () => {} }),
  onDidOpenTextDocument: (_handler: unknown) => ({ dispose: () => {} }),
  onDidChangeWorkspaceFolders: (_handler: unknown) => ({ dispose: () => {} }),
  textDocuments: [] as unknown[],
  createFileSystemWatcher: (_pattern: unknown) => ({
    onDidCreate: () => ({ dispose: () => {} }),
    onDidChange: () => ({ dispose: () => {} }),
    onDidDelete: () => ({ dispose: () => {} }),
    dispose: () => {},
  }),
  asRelativePath: (pathOrUri: unknown) => String(pathOrUri),
  findFiles: async () => [],
  openTextDocument: async (uriOrPath: unknown) => {
    const uri =
      uriOrPath instanceof Uri
        ? uriOrPath
        : typeof uriOrPath === "string"
          ? Uri.file(uriOrPath)
          : Uri.file(String((uriOrPath as { fsPath?: string })?.fsPath ?? ""));
    const text = await fsp.readFile(uri.fsPath, "utf8");
    const lines = text.split(/\r?\n/);
    return {
      uri,
      languageId: /\.(h|hh|hpp|hxx)$/i.test(uri.fsPath) ? "cpp" : "c",
      lineCount: lines.length,
      lineAt: (line: number) => ({ text: lines[line] ?? "" }),
      getText: () => text,
      positionAt: (offset: number) => {
        const safeOffset = Math.max(0, Math.min(offset, text.length));
        let line = 0;
        let lineStart = 0;
        for (let i = 0; i < safeOffset; i += 1) {
          if (text.charCodeAt(i) === 10) {
            line += 1;
            lineStart = i + 1;
          }
        }
        return new Position(line, safeOffset - lineStart);
      },
    };
  },
};

export const window = {
  activeTextEditor: undefined,
  visibleTextEditors: [] as unknown[],
  showInformationMessage: async (_msg: string, ..._args: unknown[]) => undefined,
  showWarningMessage: async (_msg: string, ..._args: unknown[]) => undefined,
  showErrorMessage: async (_msg: string, ..._args: unknown[]) => undefined,
  showInputBox: async (_opts?: unknown) => undefined,
  showQuickPick: async (_items: unknown, _opts?: unknown) => undefined,
  createOutputChannel: (name: string) => ({
    name,
    appendLine: (_line: string) => {},
    append: (_text: string) => {},
    show: (_preserveFocus?: boolean) => {},
    hide: () => {},
    dispose: () => {},
    clear: () => {},
    replace: (_value: string) => {},
  }),
  createStatusBarItem: (_alignment?: unknown, _priority?: number) => ({
    text: "",
    tooltip: "",
    color: undefined,
    command: undefined,
    show: () => {},
    hide: () => {},
    dispose: () => {},
  }),
  createTextEditorDecorationType: (_opts?: unknown) => ({
    key: "mock-decoration",
    dispose: () => {},
  }),
  createTreeView: (_viewId: string, _opts?: unknown) => ({
    onDidChangeSelection: () => ({ dispose: () => {} }),
    onDidChangeVisibility: () => ({ dispose: () => {} }),
    onDidCollapseElement: () => ({ dispose: () => {} }),
    onDidExpandElement: () => ({ dispose: () => {} }),
    dispose: () => {},
  }),
  onDidChangeActiveTextEditor: (_handler: unknown) => ({ dispose: () => {} }),
  onDidChangeVisibleTextEditors: (_handler: unknown) => ({ dispose: () => {} }),
  onDidChangeTextEditorVisibleRanges: (_handler: unknown) => ({ dispose: () => {} }),
  onDidChangeWindowState: (_handler: unknown) => ({ dispose: () => {} }),
};

export const languages = {
  createDiagnosticCollection: (_name?: string) => ({
    name: _name ?? "mock",
    set: (_uri: unknown, _diags: unknown[]) => {},
    delete: (_uri: unknown) => {},
    clear: () => {},
    forEach: (_cb: unknown) => {},
    get: (_uri: unknown) => [],
    has: (_uri: unknown) => false,
    dispose: () => {},
  }),
  registerHoverProvider: (_selector: unknown, _provider: unknown) => ({ dispose: () => {} }),
  registerDefinitionProvider: (_selector: unknown, _provider: unknown) => ({ dispose: () => {} }),
  registerCodeLensProvider: (_selector: unknown, _provider: unknown) => ({ dispose: () => {} }),
  registerFoldingRangeProvider: (_selector: unknown, _provider: unknown) => ({ dispose: () => {} }),
  registerCodeActionsProvider: (_selector: unknown, _provider: unknown, _meta?: unknown) => ({ dispose: () => {} }),
  getDiagnostics: (_uri?: unknown) => [],
  onDidChangeDiagnostics: (_handler: unknown) => ({ dispose: () => {} }),
};

export const commands = {
  registerCommand: (_command: string, _callback: (...args: unknown[]) => unknown) => ({ dispose: () => {} }),
  executeCommand: async (_command: string, ..._args: unknown[]) => undefined,
};

export const extensions = {
  getExtension: (_id: string) => undefined,
};

export class Uri {
  readonly scheme: string;
  readonly fsPath: string;
  readonly path: string;

  private constructor(scheme: string, fsPath: string) {
    this.scheme = scheme;
    this.fsPath = fsPath;
    this.path = fsPath.replace(/\\/g, "/");
  }

  static file(filePath: string): Uri {
    return new Uri("file", filePath);
  }

  static parse(value: string): Uri {
    if (value.startsWith("file://")) {
      return new Uri("file", decodeURIComponent(value.slice(7)));
    }
    return new Uri("file", value);
  }

  static joinPath(base: Uri, ...pathSegments: string[]): Uri {
    const joined = [base.fsPath, ...pathSegments].join("/").replace(/\/+/g, "/");
    return new Uri(base.scheme, joined);
  }

  toString(): string {
    return `${this.scheme}://${this.path}`;
  }

  with(change: { scheme?: string; fsPath?: string }): Uri {
    return new Uri(change.scheme ?? this.scheme, change.fsPath ?? this.fsPath);
  }
}

export class Range {
  readonly start: Position;
  readonly end: Position;

  constructor(
    startOrLine: Position | number,
    startCharOrEnd: Position | number,
    endLine?: number,
    endChar?: number
  ) {
    if (startOrLine instanceof Position && startCharOrEnd instanceof Position) {
      this.start = startOrLine;
      this.end = startCharOrEnd;
    } else {
      this.start = new Position(startOrLine as number, startCharOrEnd as number);
      this.end = new Position(endLine ?? 0, endChar ?? 0);
    }
  }

  contains(positionOrRange: Position | Range): boolean {
    const pos = positionOrRange instanceof Position ? positionOrRange : positionOrRange.start;
    return !pos.isBefore(this.start) && !pos.isAfter(this.end);
  }

  intersection(other: Range): Range | undefined {
    const start = this.start.isAfter(other.start) ? this.start : other.start;
    const end = this.end.isBefore(other.end) ? this.end : other.end;
    if (start.isAfter(end)) return undefined;
    return new Range(start, end);
  }
}

export class Position {
  readonly line: number;
  readonly character: number;

  constructor(line: number, character: number) {
    this.line = line;
    this.character = character;
  }

  isBefore(other: Position): boolean {
    return this.line < other.line || (this.line === other.line && this.character < other.character);
  }

  isAfter(other: Position): boolean {
    return this.line > other.line || (this.line === other.line && this.character > other.character);
  }

  isBeforeOrEqual(other: Position): boolean {
    return !this.isAfter(other);
  }

  isAfterOrEqual(other: Position): boolean {
    return !this.isBefore(other);
  }

  isEqual(other: Position): boolean {
    return this.line === other.line && this.character === other.character;
  }

  translate(lineDelta?: number, characterDelta?: number): Position {
    return new Position(
      this.line + (lineDelta ?? 0),
      this.character + (characterDelta ?? 0)
    );
  }

  with(line?: number, character?: number): Position {
    return new Position(line ?? this.line, character ?? this.character);
  }
}

export class Selection extends Range {
  readonly anchor: Position;
  readonly active: Position;

  constructor(
    anchorOrLine: Position | number,
    activeOrChar: Position | number,
    activeLine?: number,
    activeChar?: number
  ) {
    if (anchorOrLine instanceof Position && activeOrChar instanceof Position) {
      super(anchorOrLine, activeOrChar);
      this.anchor = anchorOrLine;
      this.active = activeOrChar;
    } else {
      const anchor = new Position(anchorOrLine as number, activeOrChar as number);
      const active = new Position(activeLine ?? 0, activeChar ?? 0);
      super(anchor, active);
      this.anchor = anchor;
      this.active = active;
    }
  }

  get isReversed(): boolean {
    return this.anchor.isAfter(this.active);
  }
}

export class Diagnostic {
  range: Range;
  message: string;
  severity: DiagnosticSeverity;
  source?: string;
  code?: string | number | { value: string | number; target: Uri };
  relatedInformation?: DiagnosticRelatedInformation[];
  tags?: DiagnosticTag[];

  constructor(range: Range, message: string, severity: DiagnosticSeverity = DiagnosticSeverity.Error) {
    this.range = range;
    this.message = message;
    this.severity = severity;
  }
}

export class DiagnosticRelatedInformation {
  constructor(public location: Location, public message: string) {}
}

export class Location {
  constructor(public uri: Uri, public range: Range) {}
}

export class MarkdownString {
  value: string;
  isTrusted?: boolean;
  supportHtml?: boolean;

  constructor(value = "") {
    this.value = value;
  }

  appendMarkdown(text: string): this {
    this.value += text;
    return this;
  }

  appendText(text: string): this {
    this.value += text;
    return this;
  }

  appendCodeblock(code: string, language?: string): this {
    this.value += `\n\`\`\`${language ?? ""}\n${code}\n\`\`\`\n`;
    return this;
  }
}

export class Hover {
  contents: MarkdownString[];
  range?: Range;

  constructor(contents: MarkdownString | MarkdownString[] | string, range?: Range) {
    if (Array.isArray(contents)) {
      this.contents = contents;
    } else if (typeof contents === "string") {
      this.contents = [new MarkdownString(contents)];
    } else {
      this.contents = [contents];
    }
    this.range = range;
  }
}

export class CodeLens {
  range: Range;
  command?: { title: string; command: string; arguments?: unknown[] };
  isResolved: boolean;

  constructor(range: Range, command?: { title: string; command: string; arguments?: unknown[] }) {
    this.range = range;
    this.command = command;
    this.isResolved = command !== undefined;
  }
}

export class TreeItem {
  label: string;
  collapsibleState?: TreeItemCollapsibleState;
  description?: string;
  tooltip?: string;
  iconPath?: ThemeIcon | Uri | { light: Uri; dark: Uri };
  command?: { command: string; title: string; arguments?: unknown[] };
  contextValue?: string;

  constructor(label: string, collapsibleState?: TreeItemCollapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export class ThemeIcon {
  constructor(public readonly id: string, public readonly color?: ThemeColor) {}
}

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export class EventEmitter<T = void> {
  private listeners: Array<(e: T) => unknown> = [];

  get event(): (listener: (e: T) => unknown) => { dispose: () => void } {
    return (listener) => {
      this.listeners.push(listener);
      return {
        dispose: () => {
          const idx = this.listeners.indexOf(listener);
          if (idx >= 0) this.listeners.splice(idx, 1);
        },
      };
    };
  }

  fire(e?: T): void {
    for (const listener of this.listeners.slice()) {
      listener(e as T);
    }
  }

  dispose(): void {
    this.listeners = [];
  }
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export enum DiagnosticTag {
  Unnecessary = 1,
  Deprecated = 2,
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export enum SymbolKind {
  File = 0,
  Module = 1,
  Namespace = 2,
  Package = 3,
  Class = 4,
  Method = 5,
  Property = 6,
  Field = 7,
  Constructor = 8,
  Enum = 9,
  Interface = 10,
  Function = 11,
  Variable = 12,
  Constant = 13,
  String = 14,
  Number = 15,
  Boolean = 16,
  Array = 17,
  Object = 18,
  Key = 19,
  Null = 20,
  EnumMember = 21,
  Struct = 22,
  Event = 23,
  Operator = 24,
  TypeParameter = 25,
}

export enum FoldingRangeKind {
  Comment = 1,
  Imports = 2,
  Region = 3,
}

export enum CodeActionKind {
  Empty = "",
  QuickFix = "quickfix",
  Refactor = "refactor",
  RefactorExtract = "refactor.extract",
  RefactorInline = "refactor.inline",
  RefactorRewrite = "refactor.rewrite",
  Source = "source",
  SourceOrganizeImports = "source.organizeImports",
  SourceFixAll = "source.fixAll",
}

export enum OverviewRulerLane {
  Left = 1,
  Center = 2,
  Right = 4,
  Full = 7,
}

export enum DecorationRangeBehavior {
  OpenOpen = 0,
  ClosedClosed = 1,
  OpenClosed = 2,
  ClosedOpen = 3,
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
  Three = 3,
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}

export class FoldingRange {
  constructor(
    public start: number,
    public end: number,
    public kind?: FoldingRangeKind
  ) {}
}

export class DocumentSymbol {
  children: DocumentSymbol[] = [];

  constructor(
    public name: string,
    public detail: string,
    public kind: SymbolKind,
    public range: Range,
    public selectionRange: Range
  ) {}
}

export class WorkspaceEdit {
  private _edits: Array<{ uri: Uri; range: Range; newText: string }> = [];

  replace(uri: Uri, range: Range, newText: string): void {
    this._edits.push({ uri, range, newText });
  }

  insert(uri: Uri, position: Position, newText: string): void {
    const range = new Range(position, position);
    this._edits.push({ uri, range, newText });
  }

  delete(uri: Uri, range: Range): void {
    this._edits.push({ uri, range, newText: "" });
  }

  has(uri: Uri): boolean {
    return this._edits.some((e) => e.uri.fsPath === uri.fsPath);
  }

  entries(): Array<[Uri, Array<{ range: Range; newText: string }>]> {
    const map = new Map<string, { uri: Uri; changes: Array<{ range: Range; newText: string }> }>();
    for (const edit of this._edits) {
      const key = edit.uri.fsPath;
      if (!map.has(key)) map.set(key, { uri: edit.uri, changes: [] });
      map.get(key)!.changes.push({ range: edit.range, newText: edit.newText });
    }
    return Array.from(map.values()).map((e) => [e.uri, e.changes]);
  }
}

export const env = {
  language: "en",
  machineId: "mock-machine-id",
  sessionId: "mock-session-id",
  uriScheme: "vscode",
  clipboard: {
    readText: async () => "",
    writeText: async (_text: string) => {},
  },
};

export const l10n = {
  t(key: string, ..._args: unknown[]): string {
    return key;
  },
  uri: undefined,
  bundle: undefined,
};

export class CancellationTokenSource {
  token = {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => {} }),
  };
  cancel(): void {
    this.token.isCancellationRequested = true;
  }
  dispose(): void {}
}

export class RelativePattern {
  constructor(public base: unknown, public pattern: string) {}
}

export default {
  workspace,
  window,
  languages,
  commands,
  extensions,
  Uri,
  Range,
  Position,
  Selection,
  Diagnostic,
  DiagnosticRelatedInformation,
  Location,
  MarkdownString,
  Hover,
  CodeLens,
  TreeItem,
  ThemeIcon,
  ThemeColor,
  EventEmitter,
  DiagnosticSeverity,
  DiagnosticTag,
  StatusBarAlignment,
  TreeItemCollapsibleState,
  SymbolKind,
  FoldingRangeKind,
  CodeActionKind,
  OverviewRulerLane,
  DecorationRangeBehavior,
  ConfigurationTarget,
  ViewColumn,
  ProgressLocation,
  FoldingRange,
  DocumentSymbol,
  WorkspaceEdit,
  env,
  l10n,
  CancellationTokenSource,
  RelativePattern,
};
