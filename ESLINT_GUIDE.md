# ESLint Setup for Obsidian Plugin Submission

This project is configured to run ESLint checks that match the Obsidian plugin registry requirements.

## Running ESLint

```bash
bun run lint
```

## Common Issues and Fixes

### 1. Async method without await
**Error**: `Async method 'X' has no 'await' expression`

This means a function is marked as `async` but doesn't have any `await` expressions.

**Fix options:**
- Remove `async` keyword and add `return Promise.resolve()` at the end
- Add an `await` to an async operation inside the function
- Keep `async` if it's intentional (function returns Promise)

Example:
```typescript
// ❌ Wrong
async handler() {
  reply({...});
}

// ✅ Correct - Option 1: Remove async
handler() {
  reply({...});
  return Promise.resolve();
}

// ✅ Correct - Option 2: Keep async if needed
async handler() {
  await someAsyncOperation();
  reply({...});
}
```

### 2. Forbidden non-null assertion
**Error**: `Forbidden non-null assertion`

This is the `!` operator used to tell TypeScript that a value is not null.

**Fix**: Handle null cases properly instead of asserting
```typescript
// ❌ Wrong
const value = obj.prop!;

// ✅ Correct
const value = obj.prop;
if (value) {
  // use value
}
```

## IDE Integration

Many editors support ESLint integration:
- **VS Code**: Install the ESLint extension
- **WebStorm/IntelliJ**: Built-in ESLint support in Settings > Languages & Frameworks > JavaScript > Code Quality Tools > ESLint

## Pre-commit Hook (Optional)

To run lint checks before committing:
```bash
cat > .git/hooks/pre-commit << 'HOOK'
#!/bin/sh
bun run lint || exit 1
HOOK
chmod +x .git/hooks/pre-commit
```

## Obsidian Plugin Registry Requirements

The following rules are checked by the Obsidian review bot:
- No unused variables
- Proper async/await usage
- Sentence case for UI text  
- No "settings" word in settings headings
- Proper error handling in try-catch blocks
- Return statements in guard clauses (error conditions)

All these are configured in `.eslintrc`.
