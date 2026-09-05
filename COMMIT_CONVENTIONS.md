# 🎨 Commit Style Guide for BedrockTools

Welcome to the **BedrockTools** commit style guide! To keep our git history clean, readable, and visually appealing, all commits across the repository must follow this structure and emoji convention.

---

## 📐 Commit Message Structure

Every commit message should follow this format:

```text
<emoji> <type>(<optional_scope>): <short description in lowercase>

[optional body explaining the reasoning behind the change]

[optional footer: breaking changes, issues closed]
```

### 🔹 Golden Rules:
1. **Header Line:** Keep it under **50-72 characters**.
2. **Use Imperative Mood:** e.g., *"add feature"* or *"fix bug"* (avoid *"added"* or *"adds"*).
3. **No Ending Period** in the subject line.
4. **Blank Lines:** Separate header, body, and footer with blank lines.
5. **Mandatory Emoji:** Always place the emoji at the very beginning of the commit title, followed by a space.

---

## 🎭 Emoji & Commit Type Catalog

Use this table to choose the appropriate emoji and type based on your changes:

| Emoji | Type | Description | Example |
| :---: | :--- | :--- | :--- |
| ✨ | `feat` | New feature or functionality | `✨ feat(editor): add bedrock block palette` |
| 🐛 | `fix` | Bug fix | `🐛 fix(parser): resolve NBT parsing error on load` |
| 📝 | `docs` | Documentation updates | `📝 docs(readme): update API setup guide` |
| 🎨 | `style` | Formatting, whitespace, UI tweaks (no logic change) | `🎨 style(theme): apply dark mode palette to sidebar` |
| ♻️ | `refactor` | Code refactoring (neither fixes a bug nor adds a feature) | `♻️ refactor(world): simplify chunk generation logic` |
| ⚡️ | `perf` | Performance improvement | `⚡️ perf(render): optimize block mesh rendering` |
| ✅ | `test` | Adding or updating tests | `✅ test(schematic): add unit tests for export` |
| 🧹 | `chore` | Maintenance, dependencies, config updates | `🧹 chore(deps): upgrade three.js to latest version` |
| 👷 | `ci` | CI/CD build system or workflow changes | `👷 ci(github): add automated test pipeline` |
| 🔒️ | `security` | Security fix or enhancement | `🔒️ security(auth): enforce JWT token expiration` |
| 🌐 | `i18n` | Internationalization / localization | `🌐 i18n(es): add Spanish translations for tools` |
| 🚚 | `rename` | Move or rename files/directories | `🚚 rename(components): move Toolbar to /components/ui` |
| 💥 | `breaking` | Breaking changes / backward compatibility loss | `💥 feat(api)!: update export structure for bedrock v1.20` |
| ⏪️ | `revert` | Revert a previous commit | `⏪️ revert: rollback commit a8f12c3 due to crash` |

---

## 🌟 Examples of Beautiful BedrockTools Commits

### 1. Simple Feature Commit
```text
✨ feat(viewer): add 3D preview for bedrock models
```

### 2. Bug Fix Commit with Detailed Body
```text
🐛 fix(exporter): prevent crash when exporting empty structures

Added a validation check prior to serialization to ensure empty bounding boxes
do not trigger a null pointer exception during world file export.

Closes #84
```

### 3. Styling & Refactoring Commit
```text
🎨 style(ui): improve layout responsiveness on mobile viewports
```

---
