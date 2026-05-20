import * as vscode from "vscode";
import { ClangdService } from "../clangd/ClangdService";
import { CalcDocsState } from "../core/state";

export type BitfieldInfo = {
  name: string;
  value: number;
  bitOffset: number;
  bitWidth: number;
};

export class RegisterDecoder {
  constructor(private readonly clangdService: ClangdService) {}

  public async tryDecodeHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    state: CalcDocsState
  ): Promise<vscode.MarkdownString | null> {
    const lineText = document.lineAt(position.line).text;
    const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
    if (!wordRange) return null;

    const hoveredWord = document.getText(wordRange);
    
    // Pattern: SomeRegister->SomeField = 0xValue or SomeRegister.SomeField = 0xValue
    const assignmentRegex = new RegExp(`([A-Za-z_]\\w*(?:->|\\.)${hoveredWord})\\s*=\\s*(0x[0-9a-fA-F]+|[0-9]+)`);
    const match = lineText.match(assignmentRegex);

    let valueToDecode: number | null = null;
    let displayName = hoveredWord;

    if (match) {
      displayName = match[1];
      valueToDecode = parseInt(match[2]);
    } else {
      const knownValue = state.symbolValues.get(hoveredWord);
      if (typeof knownValue === "number") {
        valueToDecode = knownValue;
      }
    }

    if (valueToDecode === null) return null;

    const definition = await this.clangdService.getDefinition(document.uri, position);
    if (!definition) return null;

    const bitfields = await this.getBitfieldsFromDefinition(definition);
    if (bitfields.length === 0) return null;

    const decoded = this.decodeValue(valueToDecode, bitfields);
    
    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown(`**${displayName}**\n\n`);
    markdown.appendMarkdown(this.formatBitfields(decoded));
    
    return markdown;
  }

  private async getBitfieldsFromDefinition(
    location: vscode.Location
  ): Promise<BitfieldInfo[]> {
    try {
      const doc = await vscode.workspace.openTextDocument(location.uri);
      const text = doc.getText();
      const lines = text.split("\n");
      
      const fieldLine = lines[location.range.start.line];
      
      const bitfields: BitfieldInfo[] = [];
      let currentOffset = 0;
      const bitfieldRegex = /\b([A-Za-z_]\w*)\s*:\s*(\d+)\s*;/g;

      let start = location.range.start.line;
      let end = location.range.start.line;
      
      if (fieldLine.includes("{")) {
          let braceDepth = 0;
          for (let i = start; i < lines.length; i++) {
              if (lines[i].includes("{")) braceDepth++;
              if (lines[i].includes("}")) {
                  braceDepth--;
                  if (braceDepth === 0) {
                      end = i;
                      break;
                  }
              }
          }
      } else {
          for (let i = start; i >= Math.max(0, start - 100); i--) {
              if (lines[i].includes("{")) {
                  start = i;
                  break;
              }
          }
          for (let i = start; i < Math.min(lines.length, start + 100); i++) {
              if (lines[i].includes("}")) {
                  end = i;
                  break;
              }
          }
      }

      for (let i = start; i <= end; i++) {
        let m;
        while ((m = bitfieldRegex.exec(lines[i])) !== null) {
          const name = m[1];
          const width = parseInt(m[2]);
          bitfields.push({
            name,
            value: 0,
            bitOffset: currentOffset,
            bitWidth: width
          });
          currentOffset += width;
        }
      }
      
      return bitfields;
    } catch (e) {
      return [];
    }
  }

  public decodeValue(value: number, bitfields: BitfieldInfo[]): BitfieldInfo[] {
    return bitfields.map(bf => {
      const mask = (1 << bf.bitWidth) - 1;
      const bfValue = (value >> bf.bitOffset) & mask;
      return { ...bf, value: bfValue };
    });
  }

  public formatBitfields(bitfields: BitfieldInfo[]): string {
    return bitfields
      .map(bf => `- **${bf.name}** = ${bf.value}`)
      .join("\n");
  }
}
