---
name: Bug Report
about: Something isn't working correctly
title: "[Bug] "
labels: bug
---

**What happened?**
A clear description of the bug.

**Reproduction**
The `.at` file and command that triggers the bug:

```
topology example : [pipeline] {
  // minimal reproduction
}
```

```bash
agentopology validate example.at
```

**Expected behavior**
What should have happened.

**Actual behavior**
What actually happened (include error output).

**Environment**
- Node.js version:
- agentopology version:
- OS:
