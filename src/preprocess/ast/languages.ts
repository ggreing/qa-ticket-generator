/**
 * Per-language symbol rules for PRE-06 (tree-sitter node types of the vendored grammars, see
 * grammars/manifest.json). A "symbol" is a function, method or class-like declaration.
 */
import type { Node } from 'web-tree-sitter';
import { AST_LANGUAGE_EXTENSIONS, type AstLanguage } from '../../core/languages';

export type { AstLanguage } from '../../core/languages';
/**
 * File → grammar mapping is shared with the GitHub reader (CTX-03 fetches head contents for the
 * same extensions), so it lives in `src/core/languages.ts`.
 */
export { astLanguageForPath } from '../../core/languages';

export const SUPPORTED_AST_LANGUAGES = Object.keys(AST_LANGUAGE_EXTENSIONS) as readonly AstLanguage[];

export function isAstLanguage(value: string): value is AstLanguage {
  return (SUPPORTED_AST_LANGUAGES as readonly string[]).includes(value);
}

export interface SymbolMatch {
  /** Node whose rows define the extracted range (may be a wrapper: export, decorators, `const x =`). */
  span: Node;
  /** Node that owns the `body` field (used to find the signature end). */
  inner: Node;
  name?: string;
  kind: 'function' | 'class';
  anonymous: boolean;
}

interface LanguageRules {
  functions: ReadonlySet<string>;
  classes: ReadonlySet<string>;
  /** Function values that are only named when bound (`const f = () => {}`), else anonymous. */
  functionValues: ReadonlySet<string>;
}

const JS_RULES: LanguageRules = {
  functions: new Set(['function_declaration', 'generator_function_declaration', 'method_definition']),
  classes: new Set([
    'class_declaration',
    'abstract_class_declaration',
    'interface_declaration',
    'enum_declaration',
  ]),
  functionValues: new Set([
    'arrow_function',
    'function_expression',
    'function',
    'generator_function',
    'class',
  ]),
};

const RULES: Record<AstLanguage, LanguageRules> = {
  typescript: JS_RULES,
  tsx: JS_RULES,
  javascript: JS_RULES,
  python: {
    functions: new Set(['function_definition']),
    classes: new Set(['class_definition']),
    functionValues: new Set(),
  },
  java: {
    functions: new Set(['method_declaration', 'constructor_declaration', 'compact_constructor_declaration']),
    classes: new Set([
      'class_declaration',
      'interface_declaration',
      'enum_declaration',
      'record_declaration',
      'annotation_type_declaration',
    ]),
    functionValues: new Set(['lambda_expression']),
  },
  go: {
    functions: new Set(['function_declaration', 'method_declaration']),
    classes: new Set(['type_spec']),
    functionValues: new Set(['func_literal']),
  },
};

function fieldText(node: Node, field: string): string | undefined {
  return node.childForFieldName(field)?.text;
}

/** Wraps export / decorator statements so the extracted text includes them. */
function outerSpan(node: Node, lang: AstLanguage): Node {
  const parent = node.parent;
  if (!parent) return node;
  if (parent.type === 'export_statement') return parent;
  if (lang === 'python' && parent.type === 'decorated_definition') return parent;
  if (lang === 'go' && node.type === 'type_spec' && parent.type === 'type_declaration') {
    return parent.namedChildren.filter((c) => c?.type === 'type_spec').length === 1 ? parent : node;
  }
  return node;
}

function goReceiverType(node: Node): string | undefined {
  const receiver = fieldText(node, 'receiver');
  if (!receiver) return undefined;
  const m = /([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*\)\s*$/.exec(receiver);
  return m?.[1];
}

/** Names of enclosing class-like declarations, outermost first (`Outer.Inner`). */
function containerPrefix(node: Node, rules: LanguageRules): string[] {
  const names: string[] = [];
  for (let p = node.parent; p; p = p.parent) {
    if (rules.classes.has(p.type)) {
      const n = fieldText(p, 'name');
      if (n) names.unshift(n);
    }
  }
  return names;
}

function qualify(node: Node, rules: LanguageRules, name: string): string {
  return [...containerPrefix(node, rules), name].join('.');
}

/** Classifies `node` as a symbol of `lang`, or returns null. */
export function matchSymbol(node: Node, lang: AstLanguage): SymbolMatch | null {
  const rules = RULES[lang];
  const type = node.type;
  if (rules.functions.has(type) || rules.classes.has(type)) {
    const kind = rules.functions.has(type) ? 'function' : 'class';
    let name = fieldText(node, 'name');
    if (lang === 'go' && type === 'method_declaration' && name) {
      const recv = goReceiverType(node);
      if (recv) name = `${recv}.${name}`;
    } else if (name) {
      name = qualify(node, rules, name);
    }
    return { span: outerSpan(node, lang), inner: node, name, kind, anonymous: false };
  }
  if (!rules.functionValues.has(type)) return null;
  const kind = type === 'class' ? 'class' : 'function';
  const parent = node.parent;
  const own = fieldText(node, 'name');
  if (parent) {
    if (parent.type === 'variable_declarator' && parent.childForFieldName('value')?.id === node.id) {
      const name = fieldText(parent, 'name');
      const decl = parent.parent ?? parent;
      if (name)
        return {
          span: outerSpan(decl, lang),
          inner: node,
          name: qualify(node, rules, name),
          kind,
          anonymous: false,
        };
    }
    if (parent.type === 'public_field_definition' || parent.type === 'field_definition') {
      const name = fieldText(parent, 'name') ?? fieldText(parent, 'property');
      if (name)
        return { span: parent, inner: node, name: qualify(node, rules, name), kind, anonymous: false };
    }
    if (parent.type === 'pair') {
      const name = fieldText(parent, 'key');
      if (name) return { span: parent, inner: node, name, kind, anonymous: false };
    }
    if (parent.type === 'assignment_expression' && parent.childForFieldName('right')?.id === node.id) {
      const name = fieldText(parent, 'left');
      const span = parent.parent?.type === 'expression_statement' ? parent.parent : parent;
      if (name) return { span, inner: node, name, kind, anonymous: false };
    }
    if (parent.type === 'export_statement') {
      return { span: parent, inner: node, name: own ?? 'default', kind, anonymous: false };
    }
  }
  if (own) return { span: node, inner: node, name: own, kind, anonymous: false };
  return { span: node, inner: node, kind, anonymous: true };
}
