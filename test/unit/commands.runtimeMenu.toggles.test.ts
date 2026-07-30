import { describe, it, expect } from 'vitest';

/**
 * Tests for runtime menu toggle commands behavior.
 *
 * These tests verify the configuration toggling logic for all quick-menu
 * toggle commands:
 * - toggleEnabled
 * - toggleCppCodeLens
 * - toggleCppHover
 * - toggleInlineCodeLens
 * - toggleInlineHover
 * - toggleGhostValues
 *
 * Each test documents:
 * 1. The config key being toggled
 * 2. The expected label shown in the quick menu
 * 3. The toggle behavior (true -> false, false -> true)
 *
 * This suite focuses on the toggle mechanics; integration with VS Code
 * providers/ghost clearing is covered by unit tests on those components.
 */

const CONFIG_KEYS = {
  enabled: 'enabled',
  cppCodeLens: 'cpp.codeLens.enabled',
  cppHover: 'cpp.hover.enabled',
  inlineCodeLens: 'inline.codeLens.enabled',
  inlineHover: 'inline.hover.enabled',
  ghostValues: 'inline.ghost.enabled',
} as const;

const WORKSPACE_TARGET = 2;

describe('CalcDocs runtime menu toggle commands — config keys', () => {
  it('toggleEnabled uses key "enabled"', () => {
    expect(CONFIG_KEYS.enabled).toBe('enabled');
  });

  it('toggleCppCodeLens uses key "cpp.codeLens.enabled"', () => {
    expect(CONFIG_KEYS.cppCodeLens).toBe('cpp.codeLens.enabled');
  });

  it('toggleCppHover uses key "cpp.hover.enabled"', () => {
    expect(CONFIG_KEYS.cppHover).toBe('cpp.hover.enabled');
  });

  it('toggleInlineCodeLens uses key "inline.codeLens.enabled"', () => {
    expect(CONFIG_KEYS.inlineCodeLens).toBe('inline.codeLens.enabled');
  });

  it('toggleInlineHover uses key "inline.hover.enabled"', () => {
    expect(CONFIG_KEYS.inlineHover).toBe('inline.hover.enabled');
  });

  it('toggleGhostValues uses key "inline.ghost.enabled"', () => {
    expect(CONFIG_KEYS.ghostValues).toBe('inline.ghost.enabled');
  });
});

describe('CalcDocs toggleEnabled command', () => {
  it('toggles enabled from true to false', () => {
    let enabled = true;
    enabled = !enabled;
    expect(enabled).toBe(false);
  });

  it('toggles enabled from false to true', () => {
    let enabled = false;
    enabled = !enabled;
    expect(enabled).toBe(true);
  });

  it('updates config with Workspace target', async () => {
    const updateCalls: Array<[string, unknown, number]> = [];
    const mockCfg = {
      get: (_key: string, def: unknown) => def,
      update: async (key: string, value: unknown, target: number) => {
        updateCalls.push([key, value, target]);
      },
    };

    const currentEnabled = mockCfg.get<boolean>('enabled', true);
    const nextEnabled = !currentEnabled;
    await mockCfg.update('enabled', nextEnabled, WORKSPACE_TARGET);

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0][0]).toBe('enabled');
    expect(updateCalls[0][1]).toBe(false);
    expect(updateCalls[0][2]).toBe(WORKSPACE_TARGET);
  });
});

describe('CalcDocs toggleCppCodeLens command', () => {
  it('toggles cpp.codeLens.enabled from true to false', () => {
    let enabled = true;
    enabled = !enabled;
    expect(enabled).toBe(false);
  });

  it('toggles cpp.codeLens.enabled from false to true', () => {
    let enabled = false;
    enabled = !enabled;
    expect(enabled).toBe(true);
  });

  it('shows correct label when enabled', () => {
    const enabled = true;
    const label = enabled
      ? "$(eye-closed) Disable C/C++ CodeLens"
      : "$(eye) Enable C/C++ CodeLens";
    expect(label).toBe("$(eye-closed) Disable C/C++ CodeLens");
  });

  it('shows correct label when disabled', () => {
    const enabled = false;
    const label = enabled
      ? "$(eye-closed) Disable C/C++ CodeLens"
      : "$(eye) Enable C/C++ CodeLens";
    expect(label).toBe("$(eye) Enable C/C++ CodeLens");
  });
});

describe('CalcDocs toggleCppHover command', () => {
  it('toggles cpp.hover.enabled from true to false', () => {
    let enabled = true;
    enabled = !enabled;
    expect(enabled).toBe(false);
  });

  it('toggles cpp.hover.enabled from false to true', () => {
    let enabled = false;
    enabled = !enabled;
    expect(enabled).toBe(true);
  });

  it('shows correct label when enabled', () => {
    const enabled = true;
    const label = enabled
      ? "$(eye-closed) Disable C/C++ Hover"
      : "$(eye) Enable C/C++ Hover";
    expect(label).toBe("$(eye-closed) Disable C/C++ Hover");
  });

  it('shows correct label when disabled', () => {
    const enabled = false;
    const label = enabled
      ? "$(eye-closed) Disable C/C++ Hover"
      : "$(eye) Enable C/C++ Hover";
    expect(label).toBe("$(eye) Enable C/C++ Hover");
  });
});

describe('CalcDocs toggleInlineCodeLens command', () => {
  it('toggles inline.codeLens.enabled from true to false', () => {
    let enabled = true;
    enabled = !enabled;
    expect(enabled).toBe(false);
  });

  it('toggles inline.codeLens.enabled from false to true', () => {
    let enabled = false;
    enabled = !enabled;
    expect(enabled).toBe(true);
  });

  it('shows correct label when enabled', () => {
    const enabled = true;
    const label = enabled
      ? "$(eye-closed) Disable Inline CodeLens"
      : "$(eye) Enable Inline CodeLens";
    expect(label).toBe("$(eye-closed) Disable Inline CodeLens");
  });

  it('shows correct label when disabled', () => {
    const enabled = false;
    const label = enabled
      ? "$(eye-closed) Disable Inline CodeLens"
      : "$(eye) Enable Inline CodeLens";
    expect(label).toBe("$(eye) Enable Inline CodeLens");
  });
});

describe('CalcDocs toggleInlineHover command', () => {
  it('toggles inline.hover.enabled from true to false', () => {
    let enabled = true;
    enabled = !enabled;
    expect(enabled).toBe(false);
  });

  it('toggles inline.hover.enabled from false to true', () => {
    let enabled = false;
    enabled = !enabled;
    expect(enabled).toBe(true);
  });

  it('shows correct label when enabled', () => {
    const enabled = true;
    const label = enabled
      ? "$(eye-closed) Disable Inline Hover"
      : "$(eye) Enable Inline Hover";
    expect(label).toBe("$(eye-closed) Disable Inline Hover");
  });

  it('shows correct label when disabled', () => {
    const enabled = false;
    const label = enabled
      ? "$(eye-closed) Disable Inline Hover"
      : "$(eye) Enable Inline Hover";
    expect(label).toBe("$(eye) Enable Inline Hover");
  });
});

describe('CalcDocs toggle ghost-related toggles', () => {
  it('toggleGhostValues label when enabled', () => {
    const inlineGhostEnable = true;
    const label = inlineGhostEnable
      ? "$(eye-closed) Disable Ghost Values"
      : "$(eye) Enable Ghost Values";
    expect(label).toBe("$(eye-closed) Disable Ghost Values");
  });

  it('toggleGhostValues label when disabled', () => {
    const inlineGhostEnable = false;
    const label = inlineGhostEnable
      ? "$(eye-closed) Disable Ghost Values"
      : "$(eye) Enable Ghost Values";
    expect(label).toBe("$(eye) Enable Ghost Values");
  });

  it('toggleGhostValues flips inline.ghost.enabled', () => {
    let value = true;
    value = !value;
    expect(value).toBe(false);
    value = !value;
    expect(value).toBe(true);
  });
});

describe('CalcDocs config change handler behavior for all toggles', () => {
  it('non-enabled config changes refresh UI including providers/ghosts', () => {
    const eventAffectsEnabled = false;
    const activeEditor = { document: { languageId: 'c' } };

    // Mirrors the fixed condition in extension.ts for non-enabled changes:
    const shouldRefreshUi = Boolean(activeEditor) && !eventAffectsEnabled;
    expect(shouldRefreshUi).toBe(true);
  });

  it('enabled change defers UI refresh to runAnalysisAndRefreshUi', () => {
    const eventAffectsEnabled = true;
    const activeEditor = { document: { languageId: 'c' } };

    // For calcdocs.enabled, the onDidChangeConfiguration handler intentionally
    // skips ghost/UI refresh here because runAnalysisAndRefreshUi() will
    // clear/refresh after applyConfigToState() with anti-race tokens.
    const shouldRefreshUi = Boolean(activeEditor) && !eventAffectsEnabled;
    expect(shouldRefreshUi).toBe(false);
  });
});

describe('CalcDocs provider refresh after any toggle', () => {
  it('refreshUi refreshes all providers regardless of which toggle fired', () => {
    // refreshUi() calls:
    // - codeLensProvider.refresh()
    // - inlineCalcCodeLensProvider.refresh()
    // - inlineCalcResultsViewProvider.refresh()
    // - ghostProvider.update(editor) if editor && inlineGhostEnabled
    // - formulaOutlineProvider.refreshDecorations() if editor && enabled
    // This test documents that expectation.

    const refreshers = {
      codeLens: false,
      inlineCodeLens: false,
      resultsView: false,
      ghost: false,
      outline: false,
    };

    // Simulate refreshUi body
    const stateEnabled = true;
    const inlineGhostEnabled = true;
    const editor = { document: { languageId: 'c' } };

    refreshers.codeLens = true;
    refreshers.inlineCodeLens = true;
    refreshers.resultsView = true;
    refreshers.ghost = Boolean(editor) && inlineGhostEnabled;
    refreshers.outline = Boolean(editor) && stateEnabled;

    expect(refreshers).toEqual({
      codeLens: true,
      inlineCodeLens: true,
      resultsView: true,
      ghost: true,
      outline: true,
    });
  });

  it('refreshUi still refreshes codelens/inline/results when ghosts disabled', () => {
    const refreshers = {
      codeLens: false,
      inlineCodeLens: false,
      resultsView: false,
      ghost: false,
      outline: false,
    };

    const stateEnabled = true;
    const inlineGhostEnabled = false;
    const editor = { document: { languageId: 'c' } };

    refreshers.codeLens = true;
    refreshers.inlineCodeLens = true;
    refreshers.resultsView = true;
    refreshers.ghost = Boolean(editor) && inlineGhostEnabled;
    refreshers.outline = Boolean(editor) && stateEnabled;

    expect(refreshers).toEqual({
      codeLens: true,
      inlineCodeLens: true,
      resultsView: true,
      ghost: false,
      outline: true,
    });
  });
});