# Eta Language Support

VS Code extension for the **[Eta](https://eta.js.org/)** templating language — syntax highlighting, IntelliSense, hover docs, and diagnostics for `.eta` files.

## Features

- 🎨 **Syntax highlighting** — all tag types, embedded JS, HTML, strings, comments
- 💡 **IntelliSense** — completions for `layout`, `include`, `block`, `capture`, `output`, and more
- 📖 **Hover docs** — hover over any Eta function or tag to see what it does
- 🔍 **Diagnostics** — mismatched tags, unclosed tags, and empty tags flagged in real time
- ✂️ **Snippets** — shortcuts for every common pattern (`=`, `~`, `if`, `for`, `layout`, `block`, ...)
- ⚙️ **Language config** — bracket matching, auto-close, folding, and comment toggling

## Syntax Quick Reference

```eta
<%= it.name %>                        <%-- output (escaped) --%>
<%~ it.html %>                        <%-- output (raw) --%>
<% const x = 1 %>                     <%-- execute JS --%>
<% /* comment */ %>                   <%-- comment --%>

<% layout("./base") %>               <%-- set parent layout --%>
<%~ it.body %>                        <%-- render child content (in layout) --%>
<% block("title", () => { %>...<% }) %>   <%-- define block --%>
<%~ block("title") %>                 <%-- render block --%>

<%~ include("./partial") %>           <%-- include partial --%>
<%~ await includeAsync("./partial") %> <%-- async partial --%>

<% output("html") %>                  <%-- append to output --%>
<% const x = capture(() => { %>...<% }) %>  <%-- capture output --%>

<%_ code %>   <%-- trim all whitespace before --%>
<%- code %>   <%-- trim one newline before --%>
<% code _%>   <%-- trim all whitespace after --%>
<% code -%>   <%-- trim one newline after --%>
```

## Documentation

[eta.js.org](https://eta.js.org/) · [Template Syntax](https://eta.js.org/docs/4.x.x/syntax/template-syntax) · [Layouts & Blocks](https://eta.js.org/docs/4.x.x/syntax/layouts-and-blocks) · [Helpers](https://eta.js.org/docs/4.x.x/syntax/helpers) · [Custom Tags](https://eta.js.org/docs/4.x.x/syntax/custom-tags)

## License

MIT
