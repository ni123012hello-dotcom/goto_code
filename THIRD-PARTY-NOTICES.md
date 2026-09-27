# Third-party notices

This project contains code and algorithms ported from **opencode**  
(<https://github.com/anomalyco/opencode>), which is distributed under the MIT  
License. The following files contain derived work and carry an attribution  
header pointing back here:

| File                           | Ported from                                   |
| ------------------------------ | --------------------------------------------- |
| `server/src/agent/tokens.ts`   | `packages/core/src/util/token.ts`             |
| `server/src/agent/overflow.ts` | `packages/opencode/src/session/overflow.ts`   |
| `server/src/agent/compact.ts`  | `packages/opencode/src/session/compaction.ts` |

Changes were made: the upstream code is written against the Effect runtime and  
the `@opencode-ai/core` schemas; here it has been rewritten as plain TypeScript  
against this project's own session model.

---

## Model data

`server/vendor/models.dev.json` is a **verbatim copy** of  
<https://models.dev/api.json>, refreshed with `pnpm -C server models:sync`. It is  
data rather than code: the context window, output cap and input cap that goto uses  
as a starting point for a model the user has not configured. It is deliberately the  
lowest-confidence source in the ladder — user-declared values and anything the  
endpoint itself reports both win over it. `server/vendor/models.dev.meta.json`  
records which revision was taken and when, so the UI can show how stale it is.

Models.dev is a community-contributed database of AI model specifications,  
distributed under the MIT License (<https://github.com/anomalyco/models.dev>).

---

## MIT License

Both upstreams above ship under the same MIT terms, so this one block covers them:

Copyright (c) 2025 opencode  
Copyright (c) 2025 models.dev

Permission is hereby granted, free of charge, to any person obtaining a copy  
of this software and associated documentation files (the "Software"), to deal  
in the Software without restriction, including without limitation the rights  
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell  
copies of the Software, and to permit persons to whom the Software is  
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all  
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR  
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,  
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE  
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER  
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,  
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE  
SOFTWARE.
