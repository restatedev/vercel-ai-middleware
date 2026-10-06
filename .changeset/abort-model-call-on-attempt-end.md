---
'@restatedev/vercel-ai-middleware': patch
---

`durableCalls` now aborts the model request when its invocation attempt ends, so a retry after a lost connection no longer runs alongside the old attempt's request.
