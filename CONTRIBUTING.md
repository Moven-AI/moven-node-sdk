# Contributing to Moven AI SDK (`@moven/sdk`)

Thank you for your interest in contributing to `@moven/sdk`! Moven AI is an open-source synchronous circuit breaker designed to keep AI agents safe and cost-effective.

---

## 🛠️ Local Development Setup

### 1. Clone the repository

```bash
git clone https://github.com/Moven-AI/moven-sdk.git
cd moven-sdk
```

### 2. Install dependencies

```bash
npm install
```

### 3. Build TypeScript bundle

```bash
npm run build
```

### 4. Run test suite

```bash
npm test
```

---

## 🧱 Adding a New Provider Adapter

All provider adapters live in `src/adapters/`. To add a new adapter:

1. Create `src/adapters/<provider-name>.ts`.
2. Wrap tool functions with `state.recordToolCall()` and `MovenHeuristicsEngine.evaluate(state)`.
3. Export your function in `src/index.ts`.
4. Add documentation and code snippet example to `README.md`.

---

## 📜 Pull Request Process

1. Fork the repo and create a new feature branch (`git checkout -b feature/my-new-adapter`).
2. Ensure `npm test` passes.
3. Submit a Pull Request with a clear description of the new adapter or fix.

Thank you for helping make AI agents safer for everyone! ⭐
