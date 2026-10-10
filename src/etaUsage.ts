import * as ts from "typescript";

type ResolveExpression = (expression: ts.Expression) => ts.Expression;
const MAX_STATIC_VARIANTS = 16;

export function isConstDeclaration(declaration: ts.VariableDeclaration): boolean {
  return ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0;
}

/** Package identities supported by Eta's Node, browser and Deno entry points. */
export function isEtaModuleSpecifier(value: string): boolean {
  return /^(?:eta(?:\/core)?|npm:eta(?:@[^/]+)?(?:\/core)?|jsr:@bgub\/eta(?:@[^/]+)?(?:\/core)?)$/.test(value);
}

export function getMemberName(expression: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) &&
      ts.isStringLiteralLike(expression.argumentExpression)) {
    return expression.argumentExpression.text;
  }
  return undefined;
}

function combine(left: string[], right: string[]): string[] | undefined {
  if (left.length * right.length > MAX_STATIC_VARIANTS) return undefined;
  return [...new Set(left.flatMap((prefix) => right.map((suffix) => prefix + suffix)))];
}

function staticConditionalValues(expression: ts.ConditionalExpression, checker: ts.TypeChecker, resolve: ResolveExpression, depth: number): string[] | undefined {
  const left = getStaticStringValues(expression.whenTrue, checker, resolve, depth + 1);
  const right = getStaticStringValues(expression.whenFalse, checker, resolve, depth + 1);
  if (!left || !right) return undefined;
  const values = [...new Set([...left, ...right])];
  return values.length <= MAX_STATIC_VARIANTS ? values : undefined;
}

function staticTemplateValues(expression: ts.TemplateExpression, checker: ts.TypeChecker, resolve: ResolveExpression, depth: number): string[] | undefined {
  let values = [expression.head.text];
  for (const span of expression.templateSpans) {
    const substitutions = getStaticStringValues(span.expression, checker, resolve, depth + 1);
    const expanded = substitutions && combine(values, substitutions);
    if (!expanded) return undefined;
    values = expanded.map((value) => value + span.literal.text);
  }
  return values;
}

function staticLiteralTypeValues(expression: ts.Expression, checker: ts.TypeChecker): string[] | undefined {
  const type = checker.getTypeAtLocation(expression);
  const types = type.isUnion() ? type.types : [type];
  if (types.length > MAX_STATIC_VARIANTS || !types.every((member) => member.isStringLiteral())) return undefined;
  return [...new Set(types.map((member) => (member as ts.StringLiteralType).value))];
}

/** Evaluate finite names without running project code or guessing string values. */
export function getStaticStringValues(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  resolve: ResolveExpression,
  depth = 0,
): string[] | undefined {
  if (depth > 12) return undefined;
  const resolved = resolve(expression);
  if (resolved !== expression) {
    return getStaticStringValues(resolved, checker, resolve, depth + 1);
  }
  if (ts.isStringLiteralLike(expression)) return [expression.text];
  if (ts.isConditionalExpression(expression)) return staticConditionalValues(expression, checker, resolve, depth);
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = getStaticStringValues(expression.left, checker, resolve, depth + 1);
    const right = getStaticStringValues(expression.right, checker, resolve, depth + 1);
    return left && right ? combine(left, right) : undefined;
  }
  if (ts.isTemplateExpression(expression)) return staticTemplateValues(expression, checker, resolve, depth);
  return staticLiteralTypeValues(expression, checker);
}

export interface EtaCallPattern {
  method: ts.Expression;
  methodName?: string;
  receiver?: ts.Expression;
  /** Actual `this` supplied to call/apply/bind. */
  boundReceiver?: ts.Expression;
  args: readonly ts.Expression[];
}

interface EtaCallContext { checker: ts.TypeChecker; resolve: ResolveExpression; }

function wrapperExpression(method: ts.Expression, context: EtaCallContext): ts.Expression | undefined {
  if (!ts.isIdentifier(method)) return undefined;
  const symbol = context.checker.getSymbolAtLocation(method);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return undefined;
  return isConstDeclaration(declaration) ? declaration.initializer : undefined;
}

function boundCall(method: ts.Expression, args: readonly ts.Expression[]): { method: ts.Expression; args: readonly ts.Expression[]; receiver: ts.Expression } | undefined {
  if (!ts.isCallExpression(method) || getMemberName(method.expression) !== "bind" ||
      !(ts.isPropertyAccessExpression(method.expression) || ts.isElementAccessExpression(method.expression))) return undefined;
  const receiver = method.arguments[0];
  return receiver ? { method: method.expression.expression, args: [...method.arguments.slice(1), ...args], receiver } : undefined;
}

function forwardedAdapterArgs(name: string | undefined, args: readonly ts.Expression[], context: EtaCallContext): readonly ts.Expression[] | undefined {
  if (name === "call") return args.slice(1);
  if (name !== "apply" || !args[1]) return undefined;
  const forwarded = context.resolve(args[1]);
  if (!ts.isArrayLiteralExpression(forwarded) || forwarded.elements.some((item) => ts.isSpreadElement(item) || ts.isOmittedExpression(item))) return undefined;
  return forwarded.elements as readonly ts.Expression[];
}

function destructuredPattern(method: ts.Identifier, args: readonly ts.Expression[], boundReceiver: ts.Expression | undefined, context: EtaCallContext): EtaCallPattern | undefined {
  const symbol = context.checker.getSymbolAtLocation(method);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (declaration && ts.isBindingElement(declaration) && !declaration.dotDotDotToken &&
      ts.isObjectBindingPattern(declaration.parent) && ts.isVariableDeclaration(declaration.parent.parent) &&
      declaration.parent.parent.initializer && isConstDeclaration(declaration.parent.parent)) {
    const name = declaration.propertyName ?? declaration.name;
    const methodName = ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
    return { method, methodName, receiver: declaration.parent.parent.initializer, boundReceiver, args };
  }
  const original = symbol?.flags && symbol.flags & ts.SymbolFlags.Alias ? context.checker.getAliasedSymbol(symbol) : symbol;
  return { method, methodName: original?.name ?? method.text, boundReceiver, args };
}

function unwrapEtaCall(method: ts.Expression, args: readonly ts.Expression[], context: EtaCallContext, depth = 0, boundReceiver?: ts.Expression): EtaCallPattern | undefined {
  if (depth > 12) return undefined;
  if (ts.isParenthesizedExpression(method) || ts.isAsExpression(method) || ts.isNonNullExpression(method) || ts.isSatisfiesExpression(method)) {
    return unwrapEtaCall(method.expression, args, context, depth + 1, boundReceiver);
  }
  const wrapped = wrapperExpression(method, context);
  if (wrapped) return unwrapEtaCall(wrapped, args, context, depth + 1, boundReceiver);
  const bound = boundCall(method, args);
  if (bound) return unwrapEtaCall(bound.method, bound.args, context, depth + 1, bound.receiver);
  if (ts.isPropertyAccessExpression(method) || ts.isElementAccessExpression(method)) {
    const name = getMemberName(method);
    if (name === "call" || name === "apply") {
      const forwarded = args[0] && forwardedAdapterArgs(name, args, context);
      return forwarded ? unwrapEtaCall(method.expression, forwarded, context, depth + 1, args[0]) : undefined;
    }
    return { method, methodName: name, receiver: method.expression, boundReceiver, args };
  }
  return ts.isIdentifier(method) ? destructuredPattern(method, args, boundReceiver, context) : undefined;
}

/** Unwrap ordinary JavaScript method adapters while retaining original AST args. */
export function getEtaCallPattern(call: ts.CallExpression, checker: ts.TypeChecker, resolve: ResolveExpression): EtaCallPattern | undefined {
  return unwrapEtaCall(call.expression, call.arguments, { checker, resolve });
}

export interface SimpleFactoryResult {
  expression: ts.Expression;
  configExpression?: ts.Expression;
  sourceFile: ts.SourceFile;
}

function factoryDeclarationForCall(
  expression: ts.CallExpression,
  checker: ts.TypeChecker,
  resolve: ResolveExpression,
): ts.FunctionLikeDeclaration | undefined {
  const resolved = resolve(expression.expression);
  let factory: ts.Node | undefined = resolved;
  if (!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory)) {
    let symbol = checker.getSymbolAtLocation(expression.expression);
    if (symbol?.flags && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    factory = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  }
  return factory && (ts.isFunctionDeclaration(factory) || ts.isFunctionExpression(factory) || ts.isArrowFunction(factory))
    ? factory
    : undefined;
}

function substituteFactoryExpression(
  expression: ts.Expression,
  bindings: ReadonlyMap<ts.Symbol, ts.Expression>,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): ts.Expression {
  if (!ts.isIdentifier(expression)) return expression;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return expression;
  seen.add(symbol);
  const bound = bindings.get(symbol);
  if (bound) return substituteFactoryExpression(bound, bindings, checker, seen);
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (declaration && ts.isVariableDeclaration(declaration) && isConstDeclaration(declaration) && declaration.initializer) {
    return substituteFactoryExpression(declaration.initializer, bindings, checker, seen);
  }
  return expression;
}

function substituteFactoryResult(
  expression: ts.Expression,
  bindings: ReadonlyMap<ts.Symbol, ts.Expression>,
  checker: ts.TypeChecker,
): ts.Expression {
  if (ts.isIdentifier(expression)) {
    const substituted = substituteFactoryExpression(expression, bindings, checker);
    return substituted === expression
      ? expression
      : substituteFactoryResult(substituted, bindings, checker);
  }
  if (ts.isObjectLiteralExpression(expression)) {
    return ts.factory.updateObjectLiteralExpression(expression, expression.properties.map((property) => {
      if (ts.isShorthandPropertyAssignment(property)) {
        const valueSymbol = checker.getShorthandAssignmentValueSymbol(property);
        if (!valueSymbol) return property;
        const bound = bindings.get(valueSymbol);
        const declaration = valueSymbol.valueDeclaration ?? valueSymbol.declarations?.[0];
        const value = bound ?? (
          declaration && ts.isVariableDeclaration(declaration) &&
          isConstDeclaration(declaration) && declaration.initializer
            ? declaration.initializer
            : undefined
        );
        if (!value) return property;
        return ts.factory.createPropertyAssignment(
          property.name,
          substituteFactoryResult(value, bindings, checker),
        );
      }
      if (!ts.isPropertyAssignment(property)) return property;
      return ts.factory.updatePropertyAssignment(
        property,
        property.name,
        substituteFactoryResult(property.initializer, bindings, checker),
      );
    }));
  }
  if (ts.isNewExpression(expression)) {
    return ts.factory.updateNewExpression(expression, expression.expression, expression.typeArguments,
      expression.arguments?.map((argument) => substituteFactoryResult(argument, bindings, checker)));
  }
  if (ts.isCallExpression(expression)) {
    return ts.factory.updateCallExpression(expression, expression.expression, expression.typeArguments,
      expression.arguments.map((argument) => substituteFactoryResult(argument, bindings, checker)));
  }
  return expression;
}

function canEvaluateFactory(factory: ts.FunctionLikeDeclaration, expression: ts.CallExpression): boolean {
  return !factory.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) &&
    !((ts.isFunctionDeclaration(factory) || ts.isFunctionExpression(factory)) && factory.asteriskToken) &&
    !factory.parameters.some((parameter) => parameter.dotDotDotToken) &&
    expression.arguments.length <= factory.parameters.length;
}

function factoryBindings(factory: ts.FunctionLikeDeclaration, expression: ts.CallExpression, checker: ts.TypeChecker): Map<ts.Symbol, ts.Expression> | undefined {
  const bindings = new Map<ts.Symbol, ts.Expression>();
  for (let index = 0; index < factory.parameters.length; index++) {
    const parameter = factory.parameters[index];
    if (!ts.isIdentifier(parameter.name)) return undefined;
    const value = expression.arguments[index] ?? parameter.initializer;
    const symbol = checker.getSymbolAtLocation(parameter.name);
    if (!value || !symbol) return undefined;
    bindings.set(symbol, value);
  }
  return bindings;
}

function factoryResult(factory: ts.FunctionLikeDeclaration): ts.Expression | undefined {
  if (!factory.body) return undefined;
  if (!ts.isBlock(factory.body)) return factory.body;
  let result: ts.Expression | undefined;
  for (const statement of factory.body.statements) {
    if (ts.isVariableStatement(statement)) {
      const valid = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
        statement.declarationList.declarations.every((item) => ts.isIdentifier(item.name) && item.initializer);
      if (valid) continue;
      return undefined;
    }
    if (!ts.isReturnStatement(statement) || !statement.expression || result) return undefined;
    result = statement.expression;
  }
  return result;
}

function isRecursiveFactoryResult(result: ts.Expression, expression: ts.CallExpression, factory: ts.FunctionLikeDeclaration, checker: ts.TypeChecker): boolean {
  if (!ts.isCallExpression(result) || !ts.isIdentifier(result.expression)) return false;
  const target = checker.getSymbolAtLocation(result.expression);
  const caller = checker.getSymbolAtLocation(expression.expression);
  const own = factory.name && checker.getSymbolAtLocation(factory.name);
  return Boolean(target && (target === caller || target === own));
}

/** A bounded, synchronous factory with const locals and one explicit result. */
export function getSimpleFactoryResult(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  resolve: ResolveExpression,
): SimpleFactoryResult | undefined {
  if (!ts.isCallExpression(expression)) return undefined;
  const factory = factoryDeclarationForCall(expression, checker, resolve);
  if (!factory?.body) return undefined;
  if (!canEvaluateFactory(factory, expression)) return undefined;
  const bindings = factoryBindings(factory, expression, checker);
  const result = factoryResult(factory);
  if (!bindings || !result || isRecursiveFactoryResult(result, expression, factory, checker)) return undefined;
  const substituted = substituteFactoryResult(result, bindings, checker);
  return {
    expression: substituted,
    configExpression: ts.isNewExpression(substituted) ? substituted.arguments?.[0] : undefined,
    sourceFile: factory.getSourceFile(),
  };
}
