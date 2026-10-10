const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

const EXTENSION_ID = "ShadowNine.eta-language-support";

async function retry(label, operation, accept, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  let lastError;
  async function poll() {
    if (Date.now() >= deadline) {
      throw new Error(
        `${label} did not become ready. Last value: ${JSON.stringify(lastValue)}`,
        { cause: lastError },
      );
    }
    try {
      lastValue = await operation();
      if (accept(lastValue)) return lastValue;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    return poll();
  }
  return poll();
}

function completionItems(result) {
  if (!result) return [];
  return Array.isArray(result) ? result : result.items;
}

async function verifyProductionProviders(extension) {
  const templatePath = path.join(
    extension.extensionPath,
    "tests",
    "vscode",
    "fixtures",
    "workspace",
    "profile.eta",
  );
  const document = await vscode.workspace.openTextDocument(templatePath);
  await vscode.window.showTextDocument(document);

  const source = document.getText();
  const propertyStart = source.indexOf("name");
  assert.notEqual(propertyStart, -1, "profile fixture must contain it.user.name");
  const completionPosition = document.positionAt(propertyStart);
  const propertyPosition = document.positionAt(propertyStart + 1);

  const completions = await retry(
    "Eta completion provider",
    () =>
      vscode.commands.executeCommand(
        "vscode.executeCompletionItemProvider",
        document.uri,
        completionPosition,
      ),
    (value) => completionItems(value).some((item) => item.label === "name"),
  );
  assert.ok(
    completionItems(completions).some((item) => item.label === "name"),
    "it.user completion should include name",
  );

  const hovers = await retry(
    "Eta hover provider",
    () =>
      vscode.commands.executeCommand(
        "vscode.executeHoverProvider",
        document.uri,
        propertyPosition,
      ),
    (value) => Array.isArray(value) && value.length > 0,
  );
  const hoverText = hovers
    .flatMap((hover) => hover.contents)
    .map((content) => (typeof content === "string" ? content : content.value))
    .join("\n");
  assert.match(hoverText, /name:\s*string/);

  const definitions = await retry(
    "Eta definition provider",
    () =>
      vscode.commands.executeCommand(
        "vscode.executeDefinitionProvider",
        document.uri,
        propertyPosition,
      ),
    (value) => Array.isArray(value) && value.length > 0,
  );
  const definitionUri = definitions[0].targetUri ?? definitions[0].uri;
  assert.equal(path.basename(definitionUri.fsPath), "index.ts");
}

async function verifySnippetExpansion(extension) {
  const snippets = JSON.parse(
    fs.readFileSync(path.join(extension.extensionPath, "snippets", "eta.json"), "utf8"),
  );

  async function expand(name) {
    const document = await vscode.workspace.openTextDocument({
      language: "eta",
      content: "",
    });
    const editor = await vscode.window.showTextDocument(document);
    const inserted = await editor.insertSnippet(
      new vscode.SnippetString(snippets[name].body),
    );
    assert.equal(inserted, true);
    return document.getText().replaceAll("\r\n", "\n");
  }

  assert.equal(
    await expand("Block async"),
    '<% await blockAsync("blockname", async () => { %>\n    <%= await someData() %>\n<% }) %>',
  );
  assert.equal(
    await expand("For-i++ loop"),
    "<% for (let i = 0; i < it.items.length; i++) { %>\n    content\n<% } %>",
  );
  assert.equal(await expand("Output (escaped)"), "<%= it.variable %>");
}

async function verifyUntitledProviders() {
  const document = await vscode.workspace.openTextDocument({
    language: "eta",
    content: '<%= "scratch".toUpperCase() %>',
  });
  await vscode.window.showTextDocument(document);
  const position = document.positionAt(document.getText().indexOf("toUpperCase") + 1);
  const hovers = await retry(
    "Untitled Eta hover provider",
    () => vscode.commands.executeCommand("vscode.executeHoverProvider", document.uri, position),
    (value) => Array.isArray(value) && value.some((hover) =>
      hover.contents.some((content) => String(content.value ?? content).includes("toUpperCase"))),
  );
  assert.ok(hovers.length > 0);
}

async function run() {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} must load from extensionDevelopmentPath`);
  await extension.activate();
  assert.equal(extension.isActive, true);

  await verifyProductionProviders(extension);
  await verifyUntitledProviders();
  await verifySnippetExpansion(extension);
  console.log("Eta native QA passed: production providers, untitled hover, and snippets.");
}

module.exports = { run };
