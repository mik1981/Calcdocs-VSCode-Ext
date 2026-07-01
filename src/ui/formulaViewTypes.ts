/**
 * formulaViewTypes.ts
 *
 * View mode constants and group types for the Formula Explorer tree view.
 */

import * as vscode from "vscode";

// ---------------------------------------------------------------------------
// View mode
// ---------------------------------------------------------------------------

export enum FormulaViewMode {
  Flat = "flat",
  DependencyGroups = "dependencyGroups",
  PhysicsClusters = "physicsClusters",
}

// ---------------------------------------------------------------------------
// Sort order
// ---------------------------------------------------------------------------

export enum FormulaSortOrder {
  Alphabetical = "alphabetical",
  Source = "source",
}

// ---------------------------------------------------------------------------
// Tree item configuration
// ---------------------------------------------------------------------------

export const GROUP_HEADER_LABEL_PREFIX = "";
export const GROUP_HEADER_COLLAPSIBLE = vscode.TreeItemCollapsibleState.Collapsed;
export const FORMULA_ITEM_COLLAPSIBLE = vscode.TreeItemCollapsibleState.None;

// ---------------------------------------------------------------------------
// Context keys for view/title menu visibility
// ---------------------------------------------------------------------------

export const CONTEXT_VIEW_MODE = "calcdocs.viewMode";
export const CONTEXT_HAS_GROUPS = "calcdocs.hasGroups";
export const CONTEXT_HAS_PHYSICS = "calcdocs.hasPhysics";