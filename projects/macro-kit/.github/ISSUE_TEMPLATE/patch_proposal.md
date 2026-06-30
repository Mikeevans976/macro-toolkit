---
name: Patch Proposal
about: Propose a code change for review and application by the lead developer
title: "[PATCH] <short description of change>"
labels: patch-proposal
assignees: ''
---

## Summary
<!-- One or two sentences describing what this change does and why -->


## Files Changed
<!-- List each file affected -->
- `path/to/file.py` — description of change
- `path/to/file.tsx` — description of change

## Patch
<!-- Paste the output of `git diff` below. Generate it with:
     git diff > proposal.patch
     then paste the contents here -->

```diff

```

## How to Apply
```bash
# Save the patch block above to a file, then:
git apply proposal.patch

# To reverse if needed:
git apply --reverse proposal.patch
```

## Testing Notes
<!-- What should the reviewer check after applying? -->
- [ ] Backend: `cd backend && pytest tests/test_analytics.py -v`
- [ ] Frontend: `cd frontend && npm run build`
- [ ] Manual check: <!-- describe what to look at in the UI -->

## Context / Motivation
<!-- Why is this change needed? Link to any relevant discussion -->
