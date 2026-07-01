import * as vscode from "vscode";
import { ClangdClient } from "./ClangdClient";
import { VsCodeClangdBackend } from "./VsCodeClangdBackend";
import { ClangdService, type IClangdBackend } from "./ClangdService";
import type { ColoredOutput } from "../utils/output";

type CompatibleClangdExtension = {
    id: string;
    displayName: string;
    extension: vscode.Extension<any>;
};

function isCompatibleClangdExtension(
    extension: vscode.Extension<any>
): boolean {

    const pkg = extension.packageJSON;

    if (!pkg) {
        return false;
    }

    const searchableText = [
        pkg.name,
        pkg.displayName,
        pkg.description,
        pkg.publisher,
    ]
        .filter((v): v is string => typeof v === "string")
        .join(" ")
        .toLowerCase();

    // deve essere chiaramente una distribuzione clangd
    if (!searchableText.includes("clangd")) {
        return false;
    }

    // deve contribuire al supporto C/C++
    const languages = pkg.contributes?.languages;

    if (!Array.isArray(languages)) {
        return false;
    }

    return languages.some((lang: any) =>
        lang.id === "c" ||
        lang.id === "cpp"
    );
}

async function findCompatibleClangdExtension(): Promise<CompatibleClangdExtension | undefined> {

    for (const extension of vscode.extensions.all) {

        if (!isCompatibleClangdExtension(extension)) {
            continue;
        }

        if (!extension.isActive) {
            try {
                await extension.activate();
            } catch {
                continue;
            }
        }

        return {
            id: extension.id,
            displayName: extension.packageJSON.displayName ?? extension.id,
            extension,
        };
    }

    return undefined;
}

function createFallbackBackend(): IClangdBackend {
  return {
    isAvailable: () => false,
    getStatus: () => ({ available: false, hasCompileCommands: false, indexing: false }),
    getHover: async () => null,
    getDefinition: async () => null,
    getDocumentSymbols: async () => [],
    getAst: async () => null,
  };
}

async function createClangdBackend(
  context: vscode.ExtensionContext,
  output?: ColoredOutput,
  useClangd = true
): Promise<IClangdBackend> {
  try {
    if (!useClangd) {
      output?.info("[clangd] disabled by configuration");
      return createFallbackBackend();
    }

    const compatibleExtension = await findCompatibleClangdExtension();

    if (compatibleExtension) {

        output?.info(
            `[clangd] using ${compatibleExtension.displayName} (${compatibleExtension.id})`
        );

        const backend = new VsCodeClangdBackend();

        await backend.initialize();

        return backend;
    }

    output?.info("[clangd] no compatible VSCode clangd extension found");

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    const client = new ClangdClient(workspaceRoot, output);
    const status = await client.initialize(context, true);
    if (status.available) {
      output?.info("[clangd] using external clangd backend");
      return client;
    }

    output?.warn("[clangd] clangd unavailable, fallback mode");
    return createFallbackBackend();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    output?.warn(`[clangd] initialization failed: ${message}`);
    return createFallbackBackend();
  }
}

export async function createClangdService(
  context: vscode.ExtensionContext,
  output?: ColoredOutput,
  useClangd = true
): Promise<ClangdService> {
  const backend = await createClangdBackend(context, output, useClangd);
  return new ClangdService(backend);
}

export async function reconfigureClangdService(
  service: ClangdService,
  context: vscode.ExtensionContext,
  output?: ColoredOutput,
  useClangd = true
): Promise<void> {
  const backend = await createClangdBackend(context, output, useClangd);
  await service.setBackend(backend);
}
