export type NumberLiteralNode = {
  kind: "number";
  value: number;
  raw: string;
};

export type StringLiteralNode = {
  kind: "string";
  value: string;
  raw: string;
};

export type IdentifierNode = {
  kind: "identifier";
  name: string;
  unit?: string;
};

export type UnaryExpressionNode = {
  kind: "unary";
  operator: "+" | "-";
  argument: ExpressionNode;
};

export type BinaryExpressionNode = {
  kind: "binary";
  operator: "+" | "-" | "*" | "/";
  left: ExpressionNode;
  right: ExpressionNode;
};

export type CallExpressionNode = {
  kind: "call";
  callee: string;
  args: ExpressionNode[];
};

export type ExpressionNode =
  | NumberLiteralNode
  | StringLiteralNode
  | IdentifierNode
  | UnaryExpressionNode
  | BinaryExpressionNode
  | CallExpressionNode;

type Token =
  | { kind: "number"; value: string; position: number }
  | { kind: "identifier"; value: string; position: number }
  | { kind: "string"; value: string; raw: string; position: number }
  | { kind: "operator"; value: "+" | "-" | "*" | "/"; position: number }
  | { kind: "lparen"; position: number }
  | { kind: "rparen"; position: number }
  | { kind: "comma"; position: number }
  | { kind: "eof"; position: number };

export class ExpressionSyntaxError extends Error {
  constructor(
    public readonly position: number,
    message: string
  ) {
    super(message);
    this.name = "ExpressionSyntaxError";
  }
}

const NUMBER_RX = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;
const IDENTIFIER_RX = /^[A-Za-z_][A-Za-z0-9_.]*/;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    const char = source[cursor];

    if (/\s/.test(char)) {
      cursor += 1;
      continue;
    }

    if (char === "(") {
      tokens.push({ kind: "lparen", position: cursor });
      cursor += 1;
      continue;
    }

    if (char === ")") {
      tokens.push({ kind: "rparen", position: cursor });
      cursor += 1;
      continue;
    }

    if (char === ",") {
      tokens.push({ kind: "comma", position: cursor });
      cursor += 1;
      continue;
    }

    if (char === "+" || char === "-" || char === "*" || char === "/") {
      tokens.push({
        kind: "operator",
        value: char,
        position: cursor,
      });
      cursor += 1;
      continue;
    }

    if (char === "'" || char === "\"") {
      const quote = char;
      const start = cursor;
      cursor += 1;
      let value = "";

      while (cursor < source.length) {
        const current = source[cursor];
        if (current === "\\") {
          const escaped = source[cursor + 1];
          if (!escaped) {
            throw new ExpressionSyntaxError(start, "unterminated escape sequence");
          }

          value += escaped;
          cursor += 2;
          continue;
        }

        if (current === quote) {
          cursor += 1;
          tokens.push({
            kind: "string",
            value,
            raw: source.slice(start, cursor),
            position: start,
          });
          break;
        }

        value += current;
        cursor += 1;
      }

      if (cursor > source.length || source[cursor - 1] !== quote) {
        throw new ExpressionSyntaxError(start, "unterminated string literal");
      }

      continue;
    }

    const numericMatch = source.slice(cursor).match(NUMBER_RX);
    if (numericMatch) {
      tokens.push({
        kind: "number",
        value: numericMatch[0],
        position: cursor,
      });
      cursor += numericMatch[0].length;
      continue;
    }

    const identifierMatch = source.slice(cursor).match(IDENTIFIER_RX);
    if (identifierMatch) {
      tokens.push({
        kind: "identifier",
        value: identifierMatch[0],
        position: cursor,
      });
      cursor += identifierMatch[0].length;
      continue;
    }

    throw new ExpressionSyntaxError(
      cursor,
      `unexpected token '${source[cursor]}'`
    );
  }

  tokens.push({
    kind: "eof",
    position: source.length,
  });

  return tokens;
}

class ExpressionParser {
  private cursor = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): ExpressionNode {
    const expression = this.parseAddSub();
    this.expect("eof", "unexpected token after end of expression");
    return expression;
  }

  private parseAddSub(): ExpressionNode {
    let left = this.parseMulDiv();

    while (
      this.match("operator", "+") ||
      this.match("operator", "-")
    ) {
      const operator = this.previous();
      const right = this.parseMulDiv();

      if (operator.kind !== "operator") {
        throw new ExpressionSyntaxError(
          operator.position,
          "internal parser state error"
        );
      }

      left = {
        kind: "binary",
        operator: operator.value,
        left,
        right,
      };
    }

    return left;
  }

  private parseMulDiv(): ExpressionNode {
    let left = this.parseUnary();

    while (
      this.match("operator", "*") ||
      this.match("operator", "/")
    ) {
      const operator = this.previous();
      const right = this.parseUnary();

      if (operator.kind !== "operator") {
        throw new ExpressionSyntaxError(
          operator.position,
          "internal parser state error"
        );
      }

      left = {
        kind: "binary",
        operator: operator.value,
        left,
        right,
      };
    }

    return left;
  }

  private parseUnary(): ExpressionNode {
    if (this.match("operator", "+")) {
      return {
        kind: "unary",
        operator: "+",
        argument: this.parseUnary(),
      };
    }

    if (this.match("operator", "-")) {
      return {
        kind: "unary",
        operator: "-",
        argument: this.parseUnary(),
      };
    }

    return this.parsePrimary();
  }

  private parsePrimary(): ExpressionNode {
    if (this.match("number")) {
      const numberToken = this.previous();
      if (numberToken.kind !== "number") {
        throw new ExpressionSyntaxError(
          numberToken.position,
          "internal parser state error"
        );
      }

      const value = Number(numberToken.value);
      if (!Number.isFinite(value)) {
        throw new ExpressionSyntaxError(
          numberToken.position,
          `invalid numeric literal '${numberToken.value}'`
        );
      }

      return {
        kind: "number",
        value,
        raw: numberToken.value,
      };
    }

    if (this.match("string")) {
      const stringToken = this.previous();
      if (stringToken.kind !== "string") {
        throw new ExpressionSyntaxError(
          stringToken.position,
          "internal parser state error"
        );
      }

      return {
        kind: "string",
        value: stringToken.value,
        raw: stringToken.raw,
      };
    }

    if (this.match("identifier")) {
      const identifierToken = this.previous();
      if (identifierToken.kind !== "identifier") {
        throw new ExpressionSyntaxError(
          identifierToken.position,
          "internal parser state error"
        );
      }

      if (!this.match("lparen")) {
        return {
          kind: "identifier",
          name: identifierToken.value,
        };
      }

      const args: ExpressionNode[] = [];
      if (!this.check("rparen")) {
        do {
          args.push(this.parseAddSub());
        } while (this.match("comma"));
      }

      this.expect("rparen", "expected ')' after function arguments");

      return {
        kind: "call",
        callee: identifierToken.value,
        args,
      };
    }

    if (this.match("lparen")) {
      const nested = this.parseAddSub();
      this.expect("rparen", "expected ')' after parenthesized expression");
      return nested;
    }

    const token = this.peek();
    throw new ExpressionSyntaxError(
      token.position,
      "expected number, string, identifier or '('"
    );
  }

  private check(kind: Token["kind"], operator?: string): boolean {
    const token = this.peek();
    if (token.kind !== kind) {
      return false;
    }

    if (operator == null) {
      return true;
    }

    if (token.kind !== "operator") {
      return false;
    }

    return token.value === operator;
  }

  private match(kind: Token["kind"], operator?: string): boolean {
    if (!this.check(kind, operator)) {
      return false;
    }

    this.cursor += 1;
    return true;
  }

  private expect(kind: Token["kind"], message: string): void {
    if (!this.match(kind)) {
      const token = this.peek();
      throw new ExpressionSyntaxError(token.position, message);
    }
  }

  private peek(): Token {
    return this.tokens[this.cursor];
  }

  private previous(): Token {
    return this.tokens[this.cursor - 1];
  }
}

export function parseExpression(source: string): ExpressionNode {
  const tokens = tokenize(source);
  const parser = new ExpressionParser(tokens);
  return parser.parse();
}

function expressionPrecedence(expression: ExpressionNode): number {
  if (expression.kind === "binary") {
    return expression.operator === "+" || expression.operator === "-" ? 1 : 2;
  }

  if (expression.kind === "unary") {
    return 3;
  }

  return 4;
}

function needsRightParentheses(
  parent: BinaryExpressionNode,
  child: ExpressionNode
): boolean {
  if (child.kind !== "binary") {
    return expressionPrecedence(child) < expressionPrecedence(parent);
  }

  const parentPrec = expressionPrecedence(parent);
  const childPrec = expressionPrecedence(child);
  if (childPrec < parentPrec) {
    return true;
  }

  if (childPrec > parentPrec) {
    return false;
  }

  return parent.operator === "-" || parent.operator === "/";
}

export function printExpression(expression: ExpressionNode): string {
  switch (expression.kind) {
    case "number":
      return Number.isInteger(expression.value)
        ? String(expression.value)
        : String(expression.value);
    case "string":
      return JSON.stringify(expression.value);
    case "identifier":
      return expression.unit ? `${expression.name}[${expression.unit}]` : expression.name;
    case "unary": {
      const argument = printExpression(expression.argument);
      if (
        expression.argument.kind === "binary" ||
        expression.argument.kind === "unary"
      ) {
        return `${expression.operator}(${argument})`;
      }

      return `${expression.operator}${argument}`;
    }
    case "binary": {
      const leftNeedsParens =
        expressionPrecedence(expression.left) < expressionPrecedence(expression);
      const rightNeedsParens = needsRightParentheses(expression, expression.right);

      const left = printExpression(expression.left);
      const right = printExpression(expression.right);
      const leftSide = leftNeedsParens ? `(${left})` : left;
      const rightSide = rightNeedsParens ? `(${right})` : right;
      return `${leftSide} ${expression.operator} ${rightSide}`;
    }
    case "call": {
      const args = expression.args.map((arg) => printExpression(arg)).join(", ");
      return `${expression.callee}(${args})`;
    }
  }
}

export function collectIdentifiers(expression: ExpressionNode): Set<string> {
  const identifiers = new Set<string>();

  const walk = (node: ExpressionNode): void => {
    switch (node.kind) {
      case "identifier":
        identifiers.add(node.name);
        return;
      case "number":
      case "string":
        return;
      case "unary":
        walk(node.argument);
        return;
      case "binary":
        walk(node.left);
        walk(node.right);
        return;
      case "call":
        for (const arg of node.args) {
          walk(arg);
        }
        return;
    }
  };

  walk(expression);
  return identifiers;
}

export function mapExpression(
  expression: ExpressionNode,
  mapper: (node: ExpressionNode) => ExpressionNode
): ExpressionNode {
  const visit = (node: ExpressionNode): ExpressionNode => {
    let mapped: ExpressionNode;

    switch (node.kind) {
      case "number":
      case "string":
      case "identifier":
        mapped = node;
        break;
      case "unary":
        mapped = {
          ...node,
          argument: visit(node.argument),
        };
        break;
      case "binary":
        mapped = {
          ...node,
          left: visit(node.left),
          right: visit(node.right),
        };
        break;
      case "call":
        mapped = {
          ...node,
          args: node.args.map((arg) => visit(arg)),
        };
        break;
    }

    return mapper(mapped);
  };

  return visit(expression);
}
