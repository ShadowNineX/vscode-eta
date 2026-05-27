import { CompletionItemKind } from "vscode-languageserver/node";

export function tsKindToLSP(kind: string): CompletionItemKind {
  switch (kind) {
    case "function":
    case "local function":
      return CompletionItemKind.Function;
    case "method":
      return CompletionItemKind.Method;
    case "property":
    case "accessor":
    case "member":
      return CompletionItemKind.Property;
    case "class":
      return CompletionItemKind.Class;
    case "interface":
      return CompletionItemKind.Interface;
    case "module":
      return CompletionItemKind.Module;
    case "variable":
    case "local var":
      return CompletionItemKind.Variable;
    case "const":
      return CompletionItemKind.Constant;
    case "keyword":
      return CompletionItemKind.Keyword;
    case "type":
      return CompletionItemKind.TypeParameter;
    default:
      return CompletionItemKind.Text;
  }
}
